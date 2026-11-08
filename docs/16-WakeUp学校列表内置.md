# 16 · 读取并内置 WakeUp 课程表的教务学校列表（3.4.0）

> 目标：读取 `WakeUp课程表_6.5.2` 内「导入课表 → 导入教务系统课表」的**所有学校与对应链接**，
> 原样复制进安卓端。本文记录证据链、解密方法、数据事实与边界，全部可复现。

## 1. 结论

从该 APK 的 `assets/school_info_android_new.txt` 中解出 **3570 条**记录，
其中 **3091 条带教务网址**、479 条是「正方教务 / URP 系统」等通用导入方式（网址为空）。
涉及 **130 种教务类型**（`type`）、2 种导入方式（`importType`: `wakeup` / `ziyan`）。
全部 3570 条已原样内置到 `android/app/src/main/assets/www/lib/schools.js`，
并在「我的 → 课表 → 导入 → 教务系统一键导入」里提供可搜索的选择器，选中即自动填教务网址。

## 2. 证据链（都在用户提供的目录内）

| 证据 | 内容 |
| --- | --- |
| `assets/empty.html` | 原文：「没有收录贵校的教务网址哦。请在上方输入网址后点「确定」…点到课表的界面再点右下角导入呀」——确认是「选学校 → 内置浏览器登录 → 课表页抓取」流程 |
| `assets/school_info_android_new.txt` | 174,033 字节 / 2,853 行 / 每行 60 个 base64 字符，去换行后 171,180 字符；首字符 `=` 说明整体被反转过 |
| `classes6.dex` → `SchoolListActivity$initSchoolList$1` | 字节码调用链：`AssetManager.open` → `InputStreamReader` → `BufferedReader` → 文本反转 → `utils/o000O0Oo.OooO0OO` → `utils/o000O0Oo.OooO0O0` → `Gson.fromJson`；字符串常量含 `school_info_android_new.txt`、`assets loadSchoolList finish` |
| `classes6.dex` → `utils/o000O0Oo` | 4 个 `String(String)` 方法：`OooO00o` = GZIP 压缩+Base64；`OooO0O0` = Base64 解码+GZIP 解压；`OooO0OO` = Base64 解码 + `AES/CBC/PKCS5Padding` 解密；`OooO0Oo` = AES 加密+Base64 |
| `classes6.dex` / `classes2.dex` / `classes4.dex` | 字符串常量 `vVkiD!@9vaXB0INQ`（`RC4HelperNew` 用于网络加密，不是这份 assets 的密钥）；AES 密钥 `wakeup-yzune1215` 由密钥候选验证命中 |
| `classes5/6.dex` → `SchoolListBean` / `SchoolInfo` / `SchoolListActivity` | 字段常量 `school_name`、`url`、`type`、`import_type`、`tableId`、`realImportType` |

包名确认为 `com.suda.yzune.wakeupschedule`。GitHub 上的 `YZune/WakeupSchedule` 是 2018 年只支持苏州大学的旧仓库，不含这份列表；`YZune/CourseAdapter` 当前返回 404，因此**没有从网络抄名单**，全部数据来自本地 APK。

## 3. 解密链（可复现）

```
assets/school_info_android_new.txt
  → 去掉换行、整体反转（Kotlin reversed）
  → Base64.decode                              → 128,384 字节 AES 密文（16 的整数倍）
  → AES/CBC/PKCS5Padding 解密
       key = IV = "wakeup-yzune1215"（16 字节，同一份字节同时给 SecretKeySpec 与 IvParameterSpec）
  → 结果是 gzip 数据的 Base64（以 "H4sI" 开头）
  → Base64.decode → GZIP 解压
  → JSON：{ data: [...], release, versionStatus, versionTimeLine: 1763017986 }
```

密钥定位方式：从所有 `classes*.dex` 提取 16/24/32 字节 ASCII 字符串候选（约 215 万条），
用「AES-CBC 解密第一块后应为 `H4sI…`（gzip 的 base64）」作强特征逐一验证，
唯一稳定命中 `wakeup-yzune1215`（IV = key）。这不是猜测，是对解密结果的结构验证。

复现命令：

```
node _tools/extract-wakeup-schools.mjs                    # 打印解密统计
node _tools/extract-wakeup-schools.mjs --check           # 与 lib/schools.js 逐条核对
node _tools/extract-wakeup-schools.mjs --out /tmp/x.json # 导出明文
```

`--check` 会重新解密源 APK 并把 3570 条与内置数据逐条比对，当前输出「逐条一致：是」。

## 4. 内置数据与字段

`lib/schools.js` 导出：

- `SCHOOLS`：`[名称, 网址, 教务类型 type, 导入方式 importType, 拼音首字母 sortKey][]`，3570 条，368,160 字节；
- `SCHOOL_FIELDS`：字段顺序说明；
- `SCHOOL_SOURCE`：来源应用、源文件、`versionTimeLine`、总数、带网址数。

抽样（与解密原文一致）：

| 名称 | 网址 | type |
| --- | --- | --- |
| 安康学院 | `http://jwxt.aku.edu.cn/jwglxt/xtgl/login_slogin.html` | `zf` |
| 北京大学 | `http://elective.pku.edu.cn` | `pku` |
| 安徽中医药大学 | `http://jxzx.ahtcm.edu.cn:90/eams/login.action` | `shuwei_json` |
| 正方教务（通用方式，无网址） | 空 | `zf` |

## 5. UI 集成（`pages/timetable.js`）

- 教务导入弹窗新增「从学校列表选择（3091 所带网址）」入口，弹窗底部标明数据来源与条数。
- 选择器：按名称包含 / 拼音首字母前缀过滤；**一次只渲染 60 条**，「加载更多」可翻完整个列表（3570 条全铺会卡）；每条显示校名、`type` 与教务网址。
- 选中后自动填入教务网址，并提示「教务类型 / 导入方式」；网址输入框仍可手动改，也仍允许完全不使用列表。
- 源数据里的两类脏值做了防御，但没有改写原始数据：
  - **9 条**把多个备选网址用换行拼在一起 → 只取第一行并 `trim`；
  - **50 条**不是标准 `http(s)` 开头（裸域名、内网 IP 可用；「是」「校外http://…校内http://…」不可用）→ 做格式校验，无效值不塞进地址栏，改为提示手填。
- 无网址的 479 条通用导入方式仍保留在数据文件里，但选择器只列带网址的具体学校。

## 6. 边界与免责（如实说明）

- 这是 **WakeUp课程表 6.5.2 的离线快照**（`versionTimeLine=1763017986`），学校网址会变更、失效，也可能只在校内可访问；本 App 只用它做「选学校自动填网址」，不保证可登录，用户随时可手改。
- 数据来自第三方应用，未做增删、未编造任何学校或网址；`--check` 可随时核对是否仍与源文件一致。
- `type` 是 WakeUp 自己的教务适配器标识（130 种），本 App 的解析器只区分「JSON / HTML 表格」，**不会**按这 130 种类型分别对接；它只是展示信息与提示。
- 仍有 3 组同名条目（不同校区/研究生），按来源原样保留。
- 学校列表只在本机解析，不上传、不参与 PC 同步。

## 7. 验收

```
node --experimental-default-type=module --test android/tests/*.test.mjs  # 93 项（新增 schools 6 项）
node _tools/extract-wakeup-schools.mjs --check    # 3570 条逐条一致
node _tools/school-list-check.mjs                 # 17 项：入口/搜索/翻页/自动填网址/脏值防御
```
