# x-hub 架构与扩展机制分析

> 分析对象：`x-hub-master`（源码，v0.9.7，385 文件）+ `x-hub-0.9.1-win-x64-portable`（实机安装，含 15 个已装扩展）+ `todo-countdown-ext 1.1.0`（既有第三方扩展）。
> 本文只记录**能被源码或实机数据佐证**的结论，凡属推断均在文中标注「推断」。

---

## 1. 结论摘要

| 结论 | 依据 |
|---|---|
| 桌面端是 Tauri v2 + Vue 3 + TypeScript + Rust，UI 跑在 WebView2 里 | `package.json`、`src-tauri/tauri.conf.json`、`src/index/index.vue` |
| 业务数据落在单个 SQLite 文件 `data/app.db`，用户配置在 `data/app.json` | 实机 `data/` 目录 |
| 扩展 = 一个目录 + `manifest.json` + 若干静态 HTML，**无编译、无 npm 依赖** | `src-tauri/src/extension.rs`、`skills/x-hub-extension/references/manifest.md` |
| 扩展运行在**跨源 iframe** 中，只能通过宿主注入的 `window.xhub` 桥访问数据 | `useExtensionFrame.ts` 注释：扩展 origin 与 `asset.localhost` 不同源 |
| 扩展可带 **Node 后端进程**（service 运行时），支持监听局域网地址 | `src-tauri/src/service.rs` |
| 待办表已内置 `version` 乐观锁，注释明写「为局域网同步预留冲突检测基础」 | `models.rs` / `app.db` 建表语句 |
| 工作台是 12 列 CSS Grid，卡片内容区是 `container-type: size` 的查询容器 | `src/index/index.vue` `.dash-grid` / `.dash-cell` |

**对本次任务最关键的三个判断**：

1. **局域网服务是平台一等公民**，不需要旁路（不需要外部 exe、不需要改宿主）。`manifest.backend.host = "0.0.0.0"` + `network` 权限即可，宿主还会自动加 Windows 防火墙入站规则（TCP，仅专用网络配置）。
2. **扩展前端不承担服务器角色**。前端在 iframe 里，随页面开关而生死；真正的常驻能力必须放在 service 后端。因此同步中枢放在 Node 侧，前端只做「宿主数据 ↔ 中枢」的搬运工。
3. **宿主待办没有 `updated_at` 之外的版本语义**（`updated_at` 是字符串时间戳，精度到毫秒的 `strftime`），不足以做多端冲突判定，必须由扩展自建一套带 HLC 的影子元数据。

---

## 2. 进程与运行时模型

```
┌───────────────────────────────────────────────────────────────┐
│ x-hub.exe (Tauri / Rust 主进程)                                │
│  ├─ 窗口管理、托盘、全局快捷键、通知、防火墙                     │
│  ├─ SQLite (data/app.db)  ← 所有内置模块的数据源                │
│  ├─ 扩展注册表（扫描 data/extensions/*/manifest.json）          │
│  └─ service 子进程管理（每个 service 扩展一个 Node 进程）        │
├───────────────────────────────────────────────────────────────┤
│ WebView2 (UI)                                                 │
│  └─ 主窗 Vue 应用                                              │
│      ├─ 内置模块卡片（ClockCard / TodoCard / …）                │
│      └─ <iframe src="xhub-ext://…">  ← 每个扩展形态一个        │
│            └─ 宿主注入 window.xhub 桥                          │
└───────────────────────────────────────────────────────────────┘
```

- 主窗通过 Tauri command 与 Rust 通信，扩展通过 iframe 内的 `window.xhub` → `postMessage` → 宿主转 `xhub_call` 命令。
- `titlebar-h: 48px`；侧栏 220px（折叠 56px）；主区高度 = 窗口高 − 48。

### 2.1 service 后端的生命周期（`service.rs`）

| 环节 | 行为 |
|---|---|
| 启动时机 | 懒启动：首次 `read_extension_entry` 打开该扩展时拉起 |
| 端口 | `alloc_port(host, fixed)`：`port: 0` 时由 OS 挑空闲端口；`PORT` 环境变量注入子进程 |
| 监听地址 | `XHUB_LISTEN_HOST` 环境变量注入；`backend.host` 缺省 `127.0.0.1` |
| 对外监听门控 | 非回环地址必须 `permissions` 含 `network` **且**用户已授权，否则 `PERMISSION_DENIED` 拒绝启动 |
| 探活 | `probe_ready`：`0.0.0.0`/`::` 探 `127.0.0.1`，具体地址探该地址，10s 超时，后台线程执行 |
| 防火墙 | 成功后 `ensure_firewall_rule`：入站、允许、**TCP**、指定 `LocalPorts`、指定 `ApplicationName`、**仅 PRIVATE 配置**；规则名按 extId，先删后加幂等 |
| 日志 | `<数据根>/logs/service/<extId>.log`，单份 1MB，每次启动写分隔行 |
| 前端访问 | `window.xhub.service.request()` → 宿主反代 `/svc/<extId>/*`，统一解 CORS |
| 停止 | 卸载 / 退出时 `stop_service`，同步删防火墙规则 |

> **关键推论（影响协议设计）**：防火墙只放行 **TCP 单端口**，不做 UDP。因此「UDP 广播自动发现」在 Windows 上默认收不到包，设备发现必须走 HTTP 探测或用户显式录入地址。

---

## 3. 数据层

### 3.1 待办表（实机 `app.db` 建表语句节选）

```sql
CREATE TABLE todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER,            -- 毫秒时间戳，可空
  remind_at INTEGER,
  remind_fired INTEGER NOT NULL DEFAULT 0,
  parent_id INTEGER REFERENCES todos(id) ON DELETE CASCADE,
  sort_order INTEGER,
  version INTEGER NOT NULL DEFAULT 0,   -- 乐观锁：每次写回 +1
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  completed_at TEXT,
  description TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  repeat_mode TEXT NOT NULL DEFAULT 'once',
  …
);
```

要点：

1. **主键是自增整数**——只在单机内唯一，跨设备不能直接当全局 id。
2. `created_at` / `updated_at` 是**本地时间的文本**（`YYYY-MM-DD HH:MM:SS.SSS`），不带时区，不适合直接做跨端比较。
3. `version` 是乐观锁计数器，桥 API 的 `expectedVersion` 用它做冲突检测（reject `VERSION_CONFLICT`）。
4. `parent_id` 有 `ON DELETE CASCADE`——删父会静默删子，同步层必须自己下传子条目的墓碑。

### 3.2 桥 API 暴露的待办写操作

`data.todos.create / update / toggle / delete / schedule / setDescription / setPinned / setRepeat / setTags / completeRecurring`，均支持 `expectedVersion`。

> 注意 `update` 是**全量覆盖**：省字段会被写成空值。远端下发的部分更新必须先 `get` 合并再提交。

---

## 4. 扩展系统

### 4.1 装载

- 安装目录：`%APPDATA%\x-hub\extensions\<id>\`；便携版是 `<exe 同级>\data\extensions\<id>\`。市场安装即解压，**源码是明文**。
- 开发期可「我的扩展」直挂源码目录，添加即加载，改码约 1.5s 自动重载（仅前端，后端进程不重启）。
- `manifest.id` 是反向域名，`com.x-hub.*` 为平台保留；`version` 必须 `x.y.z` 三段纯数字。

### 4.2 四种形态

| 形态 | 容器 | 边距责任 |
|---|---|---|
| `module` | 工作台网格一格，宿主套 `.card` 玻璃外壳 | 扩展自己写 `body{padding:12px}` |
| `view` | 主工作区整页 | 宿主零边距，扩展写 `0 20px 20px 0` |
| `window` | 独立浮窗，与 view 共用入口 | 同上 |
| `drawer` | 右滑面板 | 同上 |

### 4.3 权限

`data:read` / `data:write` / `fs` / `clipboard` / `network` / `open-url` / `notify` / `events` / `shared-storage` / `titlebar` / `system`(保留)。

- 没声明就调用 → `PERMISSION_DENIED`。
- `network` **只**门控 service 后端对外监听，不对应任何桥 API（`net.fetch` 仍属 planned）。

### 4.4 主题注入

宿主把主题写给 iframe 的 `<html>`：

- 属性：`data-xhub-theme="light|dark"`、`data-xhub-wallpaper="1"`、`data-xhub-wallpaper-clear="1"`、`data-xhub-immersive="1"`、`data-xhub-variant="<id>"`
- 变量：`--xhub-accent`、`--xhub-brand`、`--xhub-brand-soft`、`--xhub-bg-page`、`--xhub-page-bg`、`--xhub-bg-card`、`--xhub-surface`、`--xhub-text-1..3`、`--xhub-border`、`--xhub-red/green/yellow/blue/orange`、`--xhub-radius-lg`

**铁律**：页面底用 `--xhub-page-bg`（有壁纸时 = `transparent`），不要用 `--xhub-bg-page`（不透明渐变，会盖住壁纸，且不能当 color 用）。

### 4.5 service 扩展的数据落盘

- 后端自有数据只能写扩展目录内的 **`.data/`**（点开头，打包与热重载跳过）。
- 跨形态键值走桥 `config.*` / `storage.*`，不要自己读配置文件。

---

## 5. 工作台模块卡的渲染管线

这是「卡片适配样式」的物理基础，逐层还原：

```
.dash-grid                     12 列 / gap 16px / padding 0 20px 20px 0 / 行高下限 36px
  └ .dash-cell                 container-type: size  ← 卡片内 cq 单位的锚点
      └ .extension-view.card   宿主玻璃外壳：--frost-surface + 1px 白描边 + radius 12px + 阴影
          ├ header.ev-header   可选；padding 12px 12px 0；标题 13px/600，图标 14px 品牌色
          └ iframe.ev-frame    flex:1; min-height:0; background:transparent
              └ 扩展 <body>    padding:12px; container-type:size; overflow:hidden
```

几何公式（窗口宽 `W`、侧栏 `S`、行数 `R`、可用高 `H`）：

- 单格宽 `cw = (W − S − 20 − 11×16) / 12`
- 占 `w` 列卡片宽 `Wc = w×cw + (w−1)×16`
- 行高 `rh = max(36, (H − 20 − (R−1)×16) / R)`
- 占 `h` 行卡片高 `Hc = h×rh + (h−1)×16`

实机标定（W=1236、S=220、折叠 S=56）：

| 占位 | 卡宽 |
|---|---|
| 1 列 | ~68px |
| 2 列 | ~153px |
| 3 列 | ~221px |
| 4 列 | ~289px |
| 6 列 | ~426px |

高度：`h=2` 最小 88px（36×2+16）；`h=3` = 140px。扣掉表头 30px 与 body 上下 24px，**最矮的内容区约 34px**——这就是「卡片必须能活到 88px 高」的由来。

---

## 6. 对本次开发的硬约束

| 约束 | 后果 | 应对 |
|---|---|---|
| 防火墙只放行 TCP 单端口 | UDP 发现不可用 | 配对用「地址 + 6 位码」，可选 HTTP 探测扫描 |
| 扩展前端跨源 | 不能直接 fetch 外部地址（CORS） | 前端一律走 `service.request` 反代 |
| service 后端无 `window.xhub` | 后端读不到宿主待办 | 前端做桥接器，把宿主待办推进中枢 |
| 后端进程按 extId 复用 | 改后端代码需重启后端 | 交付说明写明「重启后端」入口 |
| 宿主待办 id 为自增整数 | 不能跨端当主键 | 中枢用 `id`（字符串）+ `hostId` 映射 |
| `updated_at` 无时区、不可靠 | 不能拿它判先后 | 自建 HLC 元数据表 |
| 模块卡可能只有 88px 高 | 内容溢出即事故 | `container-type:size` + `cqh` + `clamp` + `overflow:hidden` |
| 移动端 WebView 也是 WebView2 同级内核 | 可用现代 CSS（container query、`:has` 需谨慎） | 目标 Chrome 90+，避免 `color-mix` |

---

## 7. 未确认项（如实记录）

1. 实机装的是 **0.9.1**，源码是 **0.9.7**。`backend.host` 的局域网监听能力在 0.8.x 的发布说明里已出现（RELEASE_NOTES 第 542 行），早于 0.9.1，因此判断可用；但 0.9.4+ 的 `titlebar` 能力本方案不使用，不受版本差影响。
2. 扩展 iframe 的 CSP 未在源码中逐条核对，方案不依赖内联脚本之外的能力（同目录外链 JS 是模板允许的写法）。
3. Android 端为独立实现，不复用 x-hub 的 Rust 代码，只复用其**设计令牌与卡片布局规则**。
