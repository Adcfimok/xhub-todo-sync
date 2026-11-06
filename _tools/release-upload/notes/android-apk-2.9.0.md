# 待办同步 · 安卓端 v2.9.0

底部悬浮导航栏整体上移，落到单手拇指自然够得着的区域；横屏/矮屏自动收回贴边，避免挤占正文。

## 基本信息

| 项目 | 值 |
| --- | --- |
| 包名 | `com.zhou.todolink` |
| versionCode | 13 |
| versionName | 2.9.0 |
| minSdk | 24（Android 7.0） |
| 签名证书 SHA-256 | `0be758ebaf99867489bd830e7516392a7bbdd99a3ac46e9bbd97fdd5ba0620ab` |

## 本版变更

- **底部导航栏上移**：胶囊下沿到可用区底边的距离由固定 22px 改为 `clamp(44px, 7vh, 64px)`，屏幕越高抬得越多，落在拇指自然停留的下缘 1/8 区域。
- **四个耦合数值收拢为 CSS 变量**：`--dock-h`（胶囊高度）、`--dock-lift`（下沿抬升量）、`--dock-clear`（内容呼吸区），列表留白、toast 提示条、AI 输入胶囊三处跟随，杜绝「抬了底栏、内容还被压住」。
- **横屏/矮屏自适应**：`@media (max-height: 480px)` 下 lift 收到 10px、clear 收到 20px，避免横向场景挤掉正文。
- **刘海屏/手势导航适配**：所有底部偏移叠加 `env(safe-area-inset-bottom)`，安全区与手势条天然避让。
- **修复版本号未随构建生效**：此前 `AndroidManifest.xml` 硬编码 versionCode/versionName 覆盖了构建参数，本版清单与 `build.sh` 统一为 13 / 2.9.0。

## 升级说明

与 2.8.0 同一签名证书（SHA-256 `0be758eb…`），**可直接覆盖安装，本地数据与登录态保留**（数据保留机制见 `docs/06`）。

## 安装

1. 下载 `todo-link-2.9.0.apk`，允许「安装未知来源应用」。
2. 打开「我的 → 同步与设置」→ 扫码（推荐）或手输主地址 + 6 位配对码。
3. 配对成功后首页出现五类计数卡片。

## 验收记录

- 底栏几何校验：`_tools/navbar-check.mjs` 在 5 种视口（360×740 / 390×844 / 412×915 / 430×932 / 740×360）下全部通过，胶囊间距、列表留白、toast、AI 输入胶囊均无重叠、无遮挡。
- 横屏滚动到底验证：末块内容与胶囊上沿留 30px 余量，可完整露出。
- 版本号复检：`aapt dump badging` 返回 versionCode 13 / versionName 2.9.0，签名 SHA-256 与 2.8.0 一致。

## 校验

```bash
apksigner verify --print-certs todo-link-2.9.0.apk   # 证书应为 0be758eb…
aapt dump badging todo-link-2.9.0.apk | head -2      # versionCode 13 / 2.9.0
```

资产 SHA-256 见本页附件信息，或 `node _tools/release-upload/verify.mjs` 输出。
