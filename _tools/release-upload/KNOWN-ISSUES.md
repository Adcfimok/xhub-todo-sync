# 已知例外与历史版本定案

> 登记「一致性校验口径之外、经核实并不构成发布不一致」的历史事实，供后续巡检直接引用。
> 每条都写明依据来源与复核命令，不含推测性结论。
> **处置结论：登记备案，保持原样。** 不重打标签、不重建 Release、不改动任何产物或既有验收结论。

## 1. 早期三个安卓标签的源码快照与标签版本不对应

### 事实

| 标签 | 标签所指提交 | 该提交源码 `AndroidManifest.xml` | APK 二进制实测（`aapt dump badging`） | Release 资产 |
| --- | --- | --- | --- | --- |
| `android-v2.7.0` | `376694d` | `versionCode=12 / versionName=2.8.0` | `versionCode='11' versionName='2.7.0'` | `todo-link-2.7.0.apk` |
| `android-v2.8.0` | `376694d` | `versionCode=12 / versionName=2.8.0` | `versionCode='12' versionName='2.8.0'` | `todo-link-2.8.0.apk` |
| `android-v2.9.0` | `3709496` | `versionCode=12 / versionName=2.8.0` | `versionCode='13' versionName='2.9.0'` | `todo-link-2.9.0.apk` |

三个 APK **自身声明的版本号与文件名、标签版本完全一致**；不一致的只是标签所指提交里的源码快照。

### 依据来源（均为本次复核实测）

- 远端标签与 SHA：`git ls-remote --tags origin`
- 标签提交的源码：`git show <sha>:android/app/src/main/AndroidManifest.xml`
- APK 二进制版本：`_toolchain/android-14/aapt.exe dump badging android/todo-link-<v>.apk`
- Release 对象、资产名、资产大小与 SHA-256：`release-results/verify-latest.json` —— `.github/workflows/publish-releases.yml` 的 API 模式校验结果，`mode: "api"`、`checkedAt: 2026-11-07T17:34:11Z`、`20/20 ok, drift 0, warn 0`，三个条目均为 `status: ok`、`issues: []`
- 发布顺序：`git log --format='%h %ci %s' -- android/app/src/main/AndroidManifest.xml`、`git show --stat 3709496`、`git show 3441651 -- android/app/src/main/AndroidManifest.xml android/build.sh`
- 口径定义：`docs/08-发布与版本同步流程.md` 第 6 节「一致性口径」

### 定性：按仓库既定口径不构成 drift

`docs/08` 第 6 节要求同时满足三条——产物在仓库且提交在 `origin/main`；标签指向的提交 == 最后修改该产物的提交；Release 有同名资产且大小、SHA-256 一致。三条对这三个版本**全部成立**，`verify.mjs` 判定通过是正确的。源码版本号不在该口径内，因此属于口径之外的观察，不是发布不一致。

成因（均有提交可查）：

- `376694d`（2026-11-05 23:57:10 +0800）是仓库初始提交，把 2.7.0 / 2.8.0 两个历史 APK 一次性归档导入，源码只保留当时的最终态 2.8.0（code 12）。两个标签因此天然指向同一提交，源码无法区分版本。这与 `docs/08` 第 7 节记录的 `version-archive` 归档式发布是同一批历史产物。
- `3709496`（2026-11-06 09:59:37 +0800）是 2.9.0 的发布提交，`git show --stat` 显示只新增 `notes/android-apk-2.9.0.md`、`versions.json`、`todo-link-2.9.0.apk` 三个文件，**无任何源码改动**。把源码升到 2.9.0（code 12→13、2.8.0→2.9.0）的是 35 秒后的 `3441651`（10:00:12 +0800）。标签按设计钉在「包含该产物的提交」上，即 `3709496`，并没有指错提交。
- 自 2.9.1（`3aaea31`）起，源码版本改动与产物落在同一提交，逐版对齐至 3.0.0（`7126140`，code 24）；6 个扩展标签所指提交的 `manifest.json` 版本也全部与标签一致。当前 `HEAD` 为 3.0.0 / 24。

### 为什么不修复

1. 按既定口径它本就不是不一致；为它新增「源码版本 == 标签版本」校验会凭空产生 3 条 drift，破坏现有 20/20 通过与 Actions 绿灯，等于擅自改变验收口径。
2. 2.7.0 与 2.8.0 共用初始提交，仓库里不存在「源码声明 2.7.0 的提交」可供标签指向，重打标签在技术上无解。
3. 把 `android-v2.9.0` 改指 `3441651` 会使其 ≠ 产物最后修改提交 `3709496`，反而触发 `tag-mismatch` drift（`verify.mjs` 的 `compareArtifactRelease` 与 offline 分支）。
4. `docs/08` 第 5 节明确「不要在原版本号上覆盖同名资产——已下载的人拿到的是旧文件，校验和会对不上」；第 7 节为不打断旧下载链接而保留历史发布。删除/重建标签与 Release 会让既有链接与资产失效。
5. 本机实测未安装 `gh`，`GITHUB_TOKEN` / `GH_TOKEN` 均未设置，无法执行 `docs/08` 第 5 节所述「手工删除标签与 Release 后重跑工作流」；该步骤只能在 GitHub 网页或有令牌的环境完成。
6. 本任务约束：不改动 `docs` 中已有验收结论、不改动任何 `.apk` 二进制与 `android/todolink.jks`、不删除仓库文件。

### 处置结论

**登记备案、保持原样，不再列为「待人工决策」。** 前几次巡检因未实测 APK 内部版本号、也未对照 API 模式校验结果，把这项观察标为遗留待决；本次补齐证据链后重新定性为「口径之外的历史事实，不构成不一致」。

若将来确需强行对齐，只能由人工在 GitHub 网页删除上述三个标签及其 Release 后重建，并需接受：2.7.0 / 2.8.0 仍无对应源码提交、旧下载链接失效、一致性口径须同步调整、已下载用户资产校验和变化。本文件不代为执行，也不建议执行。

## 2. 离线校验不覆盖 Release 资产 —— 已由云端 API 模式闭环

- `verify.mjs --offline` 只比对远端标签是否存在、标签提交是否等于产物最后修改提交、该提交是否已推送、说明文件是否齐备，**不读取 Release 对象，也不比对资产字节与 SHA-256**。
- 该维度由 `publish-releases.yml` 的「校验代码与 Release 是否一致」步骤以 API 模式完成，结果回写在 `release-results/verify-latest.json`：`mode: "api"`、20/20 ok、每个条目都带 `release.url`、资产名、`assetUrl`、本地 `sha256` 与 `tagCommit`。`verify-releases.yml` 每天 09:00 还会再巡检一次。
- **结论：资产层面的校验已闭环并通过，本地离线巡检的边界属于设计分工，不是缺口**，无需本地补做或额外改动。
