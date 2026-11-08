# 安卓端 3.4.0（versionCode 28）

内置 WakeUp 课程表「导入教务系统课表」的完整学校列表与教务网址：3570 条记录、3091 条带链接，选学校即可自动填网址。

## 新增

- **学校列表内置**：从用户提供的 `WakeUp课程表_6.5.2` 中读出 `assets/school_info_android_new.txt`，完整解密后原样内置到 `lib/schools.js`（`[名称, 网址, 教务类型, 导入方式, 拼音首字母]`，3570 条）。数据未增删、未编造。
- **学校选择器**：我的 → 课表 → 导入 → 教务系统一键导入 → 「从学校列表选择（3091 所带网址）」。支持按名称 / 拼音首字母搜索、每次渲染 60 条 +「加载更多」翻完整个列表；选中后自动填教务网址，并显示该校的教务类型与导入方式。网址仍可手改，也仍允许完全不使用列表。
- **可复现的解密脚本** `_tools/extract-wakeup-schools.mjs`，`--check` 会重新解密源 APK 并与内置数据逐条核对（当前结果：3570 条逐条一致）。
- **源数据脏值防御**：9 条把多个备选网址用换行拼在一起 → 只取第一行；约 50 条非标准网址中，裸域名 / 内网 IP 可用，「是」「校外http://…」这类无效值不塞进地址栏，改为提示手填。原始数据保持原样。

## 数据是怎么读出来的（可核验）

```
assets/school_info_android_new.txt（171,180 字符，整体反转过）
 → 反转 → Base64.decode → 128,384 字节 AES 密文
 → AES/CBC/PKCS5Padding（key = IV = "wakeup-yzune1215"）
 → gzip 数据的 Base64 → Base64.decode → GZIP 解压 → JSON
```

依据 `classes6.dex` 里 `SchoolListActivity$initSchoolList$1` 的调用链（`AssetManager.open → 反转 → utils/o000O0Oo.OooO0OO → OooO0O0 → Gson.fromJson`）以及 `utils/o000O0Oo` 中 `AES/CBC/PKCS5Padding` / `GZIPInputStream` 的实际字节码。
GitHub 上的旧开源仓库只有 2018 年苏大单校版本，`CourseAdapter` 返回 404，**没有从网络抄名单**。完整证据见 `docs/16-WakeUp学校列表内置.md`。

## 数据事实与边界

- 3570 条 = 3091 条带教务网址的具体学校 + 479 条「正方教务 / URP 系统」等通用导入方式（网址为空，仍保留在数据文件里，选择器不列出）。
- 130 种教务 `type`、2 种 `importType`（`wakeup` 2268 / `ziyan` 1302）；3 组同名条目（不同校区/研究生）按来源保留。
- 这是 **WakeUp课程表 6.5.2 的离线快照**（`versionTimeLine=1763017986`），网址会变更、失效或仅校内可访问，不保证可登录；请按需手改。
- `type` 只作为展示信息，本 App 的解析器仍按「JSON / HTML 表格」工作，不按这 130 种类型分别对接。
- 数据只在本机，不上传、不参与 PC 同步；同步协议仍是 `PROTO 2`，`versionCode 28` 可覆盖安装，本地数据保留，签名证书不变。

## 验证

```
node --experimental-default-type=module --test android/tests/*.test.mjs  # 93 项（新增 schools 6 项）
node _tools/extract-wakeup-schools.mjs --check   # 3570 条逐条一致
node _tools/school-list-check.mjs                # 17 项端到端
node _tools/home-check.mjs                      # 100 项
node _tools/tab-gesture-check.mjs               # 21 项（含教务入口）
node _tools/ai-history-check.mjs                # 34 项
```

## 产物

- `todo-link-3.4.0.apk`，368,759 字节，versionCode 28 / versionName 3.4.0
- SHA-256 `5c681795f3a12e008d96303c5c8cf4190ec596e727555b579aa142a99aa07291`
