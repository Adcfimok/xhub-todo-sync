# 待办同步扩展 · x-hub v2.2.0

左栏新增「安卓客户端」下载卡片，把手机端 APK 的 GitHub 下载入口放进扩展里，不用再翻仓库。

## 本版内容

- **新增安卓端下载卡片**：位于左栏「设备」面板下方，常驻显示，不折叠、不需要展开。
  整行是一颗按钮，点击经宿主 `openExternal` 在应用内浏览器打开 APK 直链；
  右侧「复制链接」把直链写进剪贴板，方便粘贴到手机浏览器或聊天窗口；「版本说明」跳 Release 页。
- **补 `open-url` 权限**：manifest 的 `permissions` 增加 `open-url`。这一步不能省——
  宿主扩展 iframe 的 sandbox 是 `allow-scripts allow-same-origin allow-downloads`，
  没有 `allow-popups`，`target="_blank"` 与 `window.open()` 会被静默拦截（点了没反应）。
- **样式沿用现有卡片**：复用 `--well / --line / --accent` 变量与设备卡的 9px 圆角、1px 边框、
  相同内边距，浅色/深色主题下都与相邻面板对齐（实测宽度差 ≤1px）。

## 下载卡片的行为

| 操作 | 结果 |
| --- | --- |
| 点击卡片主体 | 打开 `todo-link-2.9.0.apk` 直链（GitHub Releases） |
| 点「复制链接」 | 复制 APK 直链，按钮短暂显示「已复制」 |
| 点「版本说明」 | 打开该版本的 Release 页面 |

卡片上的版本号与文件大小是页面内常量（`view/app.js` 的 `ANDROID_DL`），发新版时与
`_tools/release-upload/versions.json` 的 `android-apk` 条目一起改。

## 安装

1. 下载 `com.zhou.todo-relay-2.2.0.zip`，解压到任意目录（`service/` 必须完整）。
2. x-hub → 扩展中心 → 我的扩展 → 添加扩展，指向解压后的目录（含 `manifest.json`）。
3. 打开扩展页，左栏底部应出现「安卓客户端」卡片；点击应唤起床载浏览器打开下载页。

## 从 2.1.0 升级

覆盖解压到原目录即可，`.data/` 里的配对记录与设备令牌不受影响（压缩包本身不含 `.data`）。
新增的 `open-url` 权限首次调用时宿主可能要求确认，确认后生效。

## 环境要求

- x-hub 桌面版 0.9.4+（常驻后台能力、`openExternal` 桥）
- 扩展后端为 Node 18+，监听 `47821`
- 下载卡片需要能访问 GitHub

## 已知限制

- `data.*` 由电脑端「待办同步」页面代答，页面关闭时扩展会显示「电脑端页面未打开」。
- 公共 Wi-Fi 下不建议开启：协议为局域网明文 HTTP，仅靠令牌准入。
- 下载链接写死在页面里，不联网查询最新版本；发版后需同步更新常量。

## 校验

```bash
# 解压后
node service/index.js                 # 应打印监听 47821
curl http://127.0.0.1:47821/healthz    # {"ok":true}
```

界面回归：`node _tools/extension-download-check.mjs --shots`
（校验卡片位置、文案、跳转、复制、与相邻面板等宽，浅色/深色各跑一遍）。

资产 SHA-256 见本页附件信息，或 `node _tools/release-upload/verify.mjs` 输出。
