# 安卓端 3.7.0（versionCode 31）

修掉两个实测问题：**提醒到点晚**、**App 没打开就完全收不到**。根因不在通知本身，而在「闹钟怎么排、谁来续排」这条链路上。

## 一、根因（按影响排序）

| # | 根因 | 表现 |
| --- | --- | --- |
| 1 | `AlarmManager` 的闹钟是**一次性**的，响过就消失；老代码响完不补排，且每次只排最近 3 条 | 第 4 条起的提醒永不触发；3 条响完后再无任何提醒 |
| 2 | 待排提醒只活在 WebView 的 IndexedDB 里，原生没有持久化 | 进程被杀 / 手机重启后计划凭空消失，无从重排 |
| 3 | 清单里没有 `RECEIVE_BOOT_COMPLETED`，也没有开机接收器 | 重启一次手机，此后所有提醒静默失效 |
| 4 | 声明了 `SCHEDULE_EXACT_ALARM` 却从不检查、不引导授权，静默退回 `setAndAllowWhileIdle` | Doze 里最晚可拖十几分钟，就是「延迟」 |
| 5 | `POST_NOTIFICATIONS` 的授权结果被忽略（`onRequestPermissionsResult` 只处理相机） | Android 13+ 首次启动被拒后，页面一切正常但一条都弹不出来 |
| 6 | 前台只靠 30 秒轮询 + 15 分钟逾期宽限 | 到点最多晚 30 秒；App 关得久一点就直接跳过 |
| 7 | 原生发的通知与页面 `notifiedMap` 各记各的 | 后台响过之后再打开 App，同一条又弹一次 |

## 二、改法

### 1）提醒计划下沉到原生并持久化

`Reminders` 改为：JS 下发**完整**计划（上限 60 条），原生存进 `SharedPreferences`（键 `plan`），再从中取最近 8 条挂进 `AlarmManager`（槽位 0..7）。
计划内容未变时直接跳过重排，避免编辑待办时反复「全撤全排」把正在派发的闹钟撤掉。

### 2）到点后自动续排（关键改动）

`AlarmReceiver` 收 `goAsync()` + 10 秒 `PARTIAL_WAKE_LOCK`，在同一个广播里完成：发通知 → 震动 → 记事件 → 从计划里摘掉这条 → **把下一条补排进系统**。
补排发生在广播里，不依赖 WebView，所以 App 没运行、进程被回收也照样续得上。

### 3）重启 / 更新后重排

新增 `RestartReceiver`，监听 `BOOT_COMPLETED`、`QUICKBOOT_POWERON`（国产 ROM）、`MY_PACKAGE_REPLACED`、`TIME_SET`、`TIMEZONE_CHANGED`，从持久化计划里重新排。
关机期间错过的（12 小时内）记成 `late` 事件，留给页面决定是否补发。

### 4）权限从「声明」变成「可查、可引导」

- 设置页新增 **通知自检**：通知权限 / 精确闹钟 / 提醒渠道 / 已排条数四行状态，异常项直接给「去开启 / 去允许 / 去设置」。
- 「去开启」优先走运行时申请（`requestNotifyPermission`），否则跳系统通知设置。
- 精确闹钟走 `ACTION_REQUEST_SCHEDULE_EXACT_ALARM`；仍拿不到时退化为近似闹钟而不是不响。
- 拒绝通知权限时会有明确 Toast，不再静默失败。

### 5）前后台时序对齐

- `lib/plan.js`（新增）承接所有纯计算：该下发哪些、此刻该响哪些、下次几点响、原生日志怎么对账。
- `alerts.js` 按「下一条到点时刻」精确 `setTimeout`（上限 60 秒兜底），前台延迟从最多 30 秒降到百毫秒级；30 秒轮询保留为兜底。
- `visibilitychange`：切走前把计划钉进系统，回来后先对账再补扫再重排。
- 关掉「待办临期提醒」开关时 `cancelAlarms()`，此前关不掉。

### 6）去重与补发

原生每次响过都往 `event` 里记一条 `{tag, at, ts, late}`；页面启动 / 回前台时 `takeAlarmEvents()` 取走并清空：

- `late=false` → 写进 `notifiedMap`，页面不再弹第二次；
- `late=true` → 放进 `missed` 集合，允许突破 15 分钟宽限、在 12 小时内补发一次，文案带「补发 ·」。

## 三、改动的文件

| 文件 | 作用 |
| --- | --- |
| `Reminders.java`（重写） | 计划持久化、槽位排闹钟、到点续排、权限查询、事件表、自检状态 |
| `AlarmReceiver.java`（重写） | `goAsync` + WakeLock，发通知后立刻补排下一条 |
| `RestartReceiver.java`（新增） | 开机 / 覆盖安装 / 改时间后重排 |
| `AndroidManifest.xml` | 新增 `RECEIVE_BOOT_COMPLETED`、`WAKE_LOCK` 与重启接收器 |
| `MainActivity.java` | 桥新增 `takeAlarmEvents / alarmState / testAlarm / open*Settings / requestNotifyPermission`；处理通知权限结果并回传页面 |
| `lib/plan.js`（新增） | 计划、到点判定、下次时刻、日志对账（纯函数，可单测） |
| `lib/alerts.js` | 接 `plan.js`、精确 tick、对账、补发、关开关撤闹钟 |
| `lib/native.js` | 新桥封装；`notifyperm` 事件订阅 |
| `pages/settings.js` | 通知自检卡片 + 10 秒测试 |
| `app.css` | `.self-check / .check-row / .check-dot` 等样式 |

## 四、验证

### 自动化

- 单测 153 项全通过（新增 `alerts-plan` 25 项：计划筛选、排序、上限、去重、逾期与补发窗口、日志对账）。
- 新增端到端 `node _tools/notify-check.mjs` 26 项：全量下发、tag 正确、对账后不重复弹、补发标注、自检四行与三个补救按钮、关开关撤闹钟、无 JS 报错。
- 既有回归全绿：home 100、tab-gesture 22、navbar、school-list 17、app-shortcuts 28。

### 真机（含延迟测量）

1. **延迟**：设置 → 提醒 → 通知自检 → 点「10 秒后测试提醒」→ 立刻锁屏。到点应弹通知；回到设置页看这一行「上次提醒 · 延迟 晚 N 毫秒」，这就是实测值（正常在 1 秒内）。`exact` 为否时同一测法通常会看到几十秒到十几分钟。
2. **App 未运行**：建 3 条待办，提醒时间分别设在 2/3/5 分钟后；从多任务里划掉 App（或直接重启手机）→ 三条应逐个弹出，且第 4 条起也会继续（多建几条一起验）。
3. **重启**：建一条 10 分钟后的提醒 → 重启手机（不打开 App）→ 到点仍应弹出。
4. **不重复**：让一条提醒在 App 关闭时响过 → 再打开 App，不应再弹第二次。
5. **关闭开关**：关掉「待办临期提醒」→ 之后不再有任何通知；再打开 → 恢复。
6. 国产 ROM 若仍被拦：系统设置里给「自启动」「后台运行（无限制）」权限，并在最近任务里锁定本 App。

## 五、边界

- 只保留 60 条计划、同时挂 8 个闹钟：足以覆盖日常使用；极端密集的提醒（同一分钟内多条）在 Doze 下受系统配额限制，会顺延到下一个唤醒窗口。
- 关机超过 12 小时的提醒不再补发，避免一次性涌出大量过期提醒。
- 计划来自页面：App 长期不打开时，用户在电脑端改的提醒要等下次打开 App 才会重排（原有同步模型如此）。

## 六、产物

- APK：`todo-link-3.7.0.apk`，409,936 字节，SHA-256 `786e2b9909673b747de595effd47bbacc6929eaf3a046dccad21225d2ea6f962`
