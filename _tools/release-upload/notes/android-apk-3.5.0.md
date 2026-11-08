# 安卓端 3.5.0（versionCode 29）

速达拆成「手机应用」与「电脑同步」两个完全独立的个体；手机应用支持从本机已安装应用添加、显示系统真实图标、点按直接拉起。

## 一、两个个体彻底分离

| | 手机应用 | 电脑同步 |
| --- | --- | --- |
| 数据 | `S.meta.phoneApps`（IndexedDB meta） | `records` 的 `resources` 集合 |
| 同步 | **不参与** PROTO 2（同步只推 records 脏记录） | 仍与 PC 同步，协议不变 |
| 功能 | 从本机应用添加 / 启动 / 移除 | 网页可打开编辑；`app/file` 只读、不可打开、不可编辑 |
| 新建 | 只能挑本机已安装应用 | 只能新建网页入口 |

**取消原有 PC 端程序方案**：手机端不再新建 `app/file`、不再提供打开入口、不再把 PC 程序混进主功能区；历史同步过来的 PC 程序只在独立分区里只读展示并标注「电脑端」。两个分区不共享筛选状态、不共享数据、不互相转换；添加/移除手机应用走 `saveMeta()`，不 `emit()` 也不触发同步，PC 端永远看不到这台手机装了什么。

## 二、手机应用区

- **小图标网格**：`repeat(auto-fill, minmax(64px, 1fr))` 自动换行；`width/max-width:100%`、`overflow:hidden`、tile `min-width:0`、`.res-scroll overflow-x:hidden` 保证不超出页面边界。360px 视口放 12 个应用实测 3 行、0 越界。
- **添加应用**：「＋ 添加应用」打开本机已安装应用列表（有 LAUNCHER 入口），可搜索名称/包名，每次渲染 60 条 + 加载更多；最多 200 个。
- **真实图标**：`PackageManager.getApplicationIcon()` → 96×96 PNG 缓存到应用私有目录 → 本地同源 HTTP `/__appicon/<hash>.png` → `<img>` 加载。**不使用统一占位图标**；自适应图标（Android 8+）同样按系统外观绘制。缓存被清理时自动重取，仍失败才显示该应用自己的名字并提示重新添加。
- **点击启动**：`getLaunchIntentForPackage()` 拉起；应用已卸载时提示移除（不自动清理）。
- **移除**：先确认「不会卸载应用，也不影响电脑端」。

## 三、关键代码模块

| 文件 | 职责 |
| --- | --- |
| `AppCatalog.java`（新增） | 枚举已安装应用、导出系统真实图标、按包名启动 |
| `AssetServer.java` | 新增 `/__appicon/` 同源路由（白名单文件名、防目录穿越） |
| `MainActivity.java` | Bridge 新增 `installedApps()` / `appIconFor()` / `launchApp()` |
| `AndroidManifest.xml` | `<queries>` 增加 `MAIN + LAUNCHER`（Android 11+ 包可见性，不申请 QUERY_ALL_PACKAGES） |
| `lib/native.js` | 前端桥封装 |
| `lib/appShortcuts.js`（新增） | 手机应用独立数据模型纯函数 |
| `pages/resources.js` | 两个独立分区、添加应用选择器、图标网格、PC 程序只读、新建收窄 |
| `app.css` | `.res-tabs` / `.app-grid` / `.app-tile` / `.app-pick-row` / `.res-readonly` |

完整方案与边界见 `docs/17-速达手机应用独立方案.md`。

## 四、兼容性与边界

- 同步协议仍是 `PROTO 2`，五个集合与 PC 端代码**未改动**；`versionCode 29` 可直接覆盖安装，本地数据保留，签名证书不变。
- 手机应用列表只在本机：卸载 App 会随之消失；应用被卸载后图标仍在，点击会提示移除，不会自动清理。
- 只能添加有启动入口的应用；最多 200 个。图标缓存被系统清理会自动重取。
- 个别应用实在取不到图标时显示应用名文字而非统一占位图。

## 五、验证

```
node --experimental-default-type=module --test android/tests/*.test.mjs  # 98 项（新增 app-shortcuts 5）
node _tools/app-shortcuts-check.mjs    # 28 项：两区隔离/真实图标/启动/换行不越界/PC 只读/新建收窄
node _tools/home-check.mjs             # 100 项
node _tools/nav-v5-check.mjs / navbar-check.mjs / tab-gesture-check.mjs
node _tools/ai-history-check.mjs / school-list-check.mjs
```

## 六、产物

- `todo-link-3.5.0.apk`，377,027 字节，versionCode 29 / versionName 3.5.0
- SHA-256 `ffc11bd0e8086091ca4ab2a48f7dee1144048b88a37a73d040c04c766ac27655`
