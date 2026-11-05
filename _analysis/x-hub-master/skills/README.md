# skills

给 AI 编码助手（Claude Code / DSH / Codex 等）用的 **skill** —— 一段写给助手看的说明书，装着本项目的领域知识，让助手不用每次重新猜。

## 目录

| skill | 用途 |
|---|---|
| `x-hub-extension/` | 让助手**生成一个 x-hub 扩展**。以分步对话的方式陪用户走完「需求 → 运行时/形态/权限决策 → 生成 → 校验 → 交付」，规范细节按需从 `references/` 取用 |
| `x-hub-extension/xhub.d.ts` | `window.xhub` 桥 API 的完整 **TypeScript 类型声明**——给编辑器用的（方法补全、参数提示、每个方法需要什么权限都写在注释里）。扩展本身**不需要 import 它** |

### `x-hub-extension/` 内部结构

```
x-hub-extension/
├── SKILL.md              # 入口：术语铁律 + 文件导航 + 分步引导流程 + 交付要求（小而全）
├── xhub.d.ts             # 桥 API 类型声明（全仓唯一一份），保证整个 bundle 可独立复制
├── references/           # 按主题拆分的规范细节，助手按阶段按需读取
│   ├── manifest.md       # manifest.json 全字段表 + 三种示例
│   ├── bridge-api.md     # window.xhub 能力清单、权限对照、数据模型
│   ├── theming.md        # --xhub-* 变量、壁纸态、双声明 fallback
│   ├── surfaces.md       # 四种形态 + module 多形态（variant）三通道
│   ├── service.md        # service 后端写法与铁律
│   ├── convert-html.md   # 把已有页面改造成扩展的四步
│   ├── debug-deploy.md   # 本机源码目录直挂调试、自检清单、打包与上架
│   └── pitfalls.md       # 21 条实机踩坑
└── templates/            # 可直接复制改字段的起手式骨架
    ├── manifest.web.json / manifest.service.json
    ├── entry.view.html / entry.module.html
    └── service.index.js
```

**拆分原则**：`SKILL.md` 只放「助手每次都需要、且不读就会做错」的东西（流程 + 铁律 + 导航）；字段表、变量表、示例代码这些**只在特定阶段需要**的内容下沉到 `references/`，避免每次都把整本规范灌进上下文。

**`xhub.d.ts` 只有一份**：`skills/x-hub-extension/xhub.d.ts`（随 bundle 分发）——它同时就是**单一真相源**，改桥 API 只改它。（仓库根曾另有一份 `skills/xhub.d.ts`，约定成「源」、bundle 内当「副本」，但实际没人读、也没人同步，已漂成 9/14 的旧快照，v0.6.6 的 `openExternal` 都没有；已删除。`src-tauri/build.rs` 只扫 `skills/x-hub-extension/`，那份从来没进过二进制。）

## 拿 `xhub.d.ts` 换编辑器补全

把 `xhub.d.ts` 复制到你的扩展项目里，与源码放在同一个项目即可（VS Code 会识别全局 `window.xhub`）。纯 JS 项目在项目根放一份 `jsconfig.json`：

```json
{ "compilerOptions": { "checkJs": false }, "include": ["xhub.d.ts", "**/*.js", "**/*.html"] }
```

它同时也是**权限的权威清单**：每个方法上方标着 `@done`（已实现，可直接用）或 `@planned`（契约已定义、宿主尚未实现，别依赖），以及"需 `data:read`"这种权限要求。判断某个 API 是否真能用，运行期以 `await window.xhub.runtime.info()` 的 `capabilities` 为准。

skill 是**自包含**的：不需要额外的脚手架仓库或工具，手写 `manifest.json` + 入口 HTML 就能开发，在扩展中心「**我的扩展**」里挂上源码目录即可真机调试（加进来就加载，改动自动重载）。整个 `x-hub-extension/` 目录可直接复制，不需要再单独挑文件。

## 怎么用

把 skill 目录整体复制到你的**用户级 skill 目录**，助手下次就能识别：

| 助手 | 放置位置（示例） |
|---|---|
| Claude Code | `~/.claude/skills/x-hub-extension/` |
| DSH | `~/.agents/skills/x-hub-extension/` |
| Codex 等 | 各自约定的 skills 根目录 |

格式要求：`<skills 根>/x-hub-extension/SKILL.md`，`SKILL.md` 头部是 YAML front matter（`name` + `description`，助手靠 `description` 判断何时启用），正文是具体说明；`references/`、`templates/` 作为随附资源由助手按需读取。

放好之后，直接说「**用 x-hub-extension 给我做一个 XX 扩展**」即可；也可以说「把这个网页改造成 x-hub 扩展」。助手会先跟你确认几个关键选项（数据从哪来、要不要后端、以什么形态呈现），确认后再生成代码——**这是设计如此**，避免方向错了白做一遍。

## 维护原则：skill 必须自带事实

这份 skill 会被复制到**只有装好的 x-hub 应用、没有宿主源码、也没有扩展源码仓库（`x-hub-extensions`）**的机器上使用。所以：

- **不要写「见宿主源码 `src-tauri/src/xxx.rs`」或「见预检实现 `src-tauri/src/precheck.rs`」这类指路**——读者打不开那些文件，路标等于没有。
- 维护者改 skill 时**应当**去核对宿主源码与扩展仓库（那是维护者独有的优势），但核对的结果要**落成 skill 里的明文**（字段表、格式硬规则、关卡清单），而不是留下一个源码路径。
- 判断标准：**一条规则如果外部开发者不知道就会踩坑，它就必须写进 skill**。已经这样内联的有——`com.x-hub.*` 是平台保留命名空间、`version` 必须 `x.y.z` 三段纯数字、`id` 的字符集规则、权限会被**静态扫描对账**（用到没声明 = 发布 error）、发布关卡的完整清单。这几条都只存在于源码里，外部用户撞上时无从自查。
- 反过来，**运行期能自己问出来的事不要硬编码**：桥 API 是否可用让扩展查 `runtime.info().capabilities` 比查文档表更可靠。
- skill 里提到的脚手架命令（`npm run new/validate/preview/deploy/pack`）属于**内部开发环境专属**，每处提到都要同时给出「没有脚手架时的替代路径」，否则外部读者会卡在那里。

## 会不会过时

skill 里的 manifest 字段、桥 API 能力清单、主题变量都**对应客户端的实际实现**，会随客户端升级同步修订。万一你发现 skill 与实现不符：

- **能力是否存在** → 以 `await window.xhub.runtime.info()` 返回的 `capabilities` 为准（宿主注册的真实能力表）；
- **参数签名** → 以 `xhub.d.ts` 为准；
- 两者与 skill 冲突时，把冲突反馈到本仓库 issue。
