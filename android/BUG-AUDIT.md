# 安卓端代码审查报告

审查对象：`android/app/src/main/java/com/zhou/todolink/`（9 个类，约 3600 行）
审查维度：逻辑错误、边界条件、异常处理缺失、内存 / 资源泄漏
结论：两轮共确认并修复 **26 处缺陷**（第一轮 20 处，第二轮 6 处）；另有 4 项因需改前端契约 / 无真机验证而保留，其中 1 项为第二轮新发现的 P1。

---

## 一、验证方式

| 环节 | 结果 |
|---|---|
| `aapt2 → javac → d8 → zipalign → apksigner` 全链路 | 三轮改动后各跑一次，均通过；最终产出 `todo-link-3.7.1.apk` |
| dex 内容抽查（新增错误文案已进入 `classes.dex`） | 通过 |
| JS 回归测试 `node --test tests/*.test.mjs` | 153 项全绿（改动前基线同为 153 项） |
| 真机 / 模拟器冒烟 | **未做**（本机无 adb 与设备），涉及传感器、通知、SAF 的路径建议装机复测 |

两轮改动均为「补齐判断 / 调整顺序 / 加界限 / 串行化复合写」，没有改动任何对外方法签名、JSON 字段语义或 JS 桥接口（`Bridge.notify` 的签名未变，仅改了内部 id 派生），前端无需同步修改。

---

## 二、已修复缺陷

### A. 逻辑错误

#### A1 提醒去重方向反了，改时间后新提醒永远不响
- 位置：`Reminders.java:449` `parse()`
- 现象：把待办的提醒时间改晚之后，第二天不响；旧时间到了反而会响。
- 根因：`raw` 先按 `at` **升序**排序，去重时 `for (Item it : raw)` 取的是**第一条**，也就是 `at` 最小（最旧）的那条。注释写的是「同一个 tag 只保留最近的一条」，代码实际保留的是最旧的一条——新时间被当成重复项丢掉了。
- 修复：改为**倒序**遍历取 `at` 最大的一条，再按 `at` 升序重排、超 `MAX_PLAN` 截断（截断规则与原来一致，仍保留最早的 60 条）。
- 理由：`tag` 是「一个待办一个键」，同键多条只可能出现在「改时间后旧条目还没被覆盖」的窗口里，此时必须让新值胜出。对唯一 tag 的常规路径，输出与改动前完全一致。

#### A2 旧闹钟的迟到广播会删掉刚改好的新提醒
- 位置：`Reminders.java:494` `drop()`
- 现象：改完提醒时间后，该待办此后再也不响。
- 根因：`drop` 在「tag + at 精确匹配失败」时退化为**只按 tag 摘除**。用户改时间后计划里是新 `at`，而系统里已经派发出去的旧闹钟带的是旧 `at`，两者不匹配 → 回退分支把**新条目**删掉了。
- 修复：回退分支增加约束 `it.at <= at`（只摘「不比这次触发更晚」的同 tag 条目），并取最后一个匹配项。
- 理由：语义上「这条闹钟对应的是不晚于该时刻的那次安排」。新时间晚于触发时刻，说明它是一次更新的安排，不该被旧广播清算。

#### A3 没有 `at` 字段的旧闹钟会误删无关提醒
- 位置：`Reminders.java:133` `onFired()`
- 现象：从 2.x 升级上来的设备，偶发丢失一条与本条无关的提醒。
- 根因：旧版本排的 `PendingIntent` 里没有 `at` extra，`getLongExtra("at", 0)` 得到 0；`onFired` 照常 `drop(plan, tag, 0)`，精确匹配必然失败 → 走 A2 的回退分支按 tag 摘一条。
- 修复：`at <= 0` 时只更新时间水位（`lastAt/lastFire/lastDelay`），不写事件表、不动计划表、不重排。
- 理由：拿不到 `at` 就无法对账，任何删除都是猜测。通知已经发出，剩余计划保持原样最安全；等 JS 下次下发全量计划时自然对齐。

#### A4 下载其实成功了，界面却报失败
- 位置：`FileTransfer.java:211` `startDownload()`
- 现象：文件已经出现在「下载/x-hub」，进度条却显示失败，用户重复下载。
- 根因：`publish()`（落盘）成功后还要 `POST /files/pull/finish`。这一步只是通知电脑端收尾，但它和落盘在同一个 `try` 里，网络抖动抛异常后直接落到 `catch (Exception)`，发出 `state=error`。
- 修复：把 `pull/finish` 单独包一层 `try/catch`，失败时在 `done` 载荷里附 `warn` 字段，仍然发 `done`。
- 理由：落盘成功是既成事实，不能因为善后失败就改判。`warn` 是新增可选字段，现有前端不读也不受影响。

### B. 边界条件

#### B1 `isPdf` 数组越界
- 位置：`PdfIngest.java:271`
- 根因：`int lim = Math.min(1024, b.length - 4)` 配合 `i <= lim`，最后一个偏移会读 `b[b.length]`。5~1028 字节的文件必抛 `ArrayIndexOutOfBoundsException`。
- 修复：上界改为 `b.length - 5`。
- 理由：探测窗口需要完整容纳 `%PDF-` 五个字节，末位起始偏移是 `length-5`。
- 影响：小文件（截断的 PDF、伪装成 PDF 的文本）从「解析失败」变成「不是 PDF 文件」的明确提示。

#### B2 极窄超长页面渲染直接 OOM
- 位置：`PdfIngest.java:155` `renderJson()`
- 根因：只限制了宽度 `MAX_WIDTH=1600`。扫描长图这类页面宽度轻松达标、高度没有上界，`Bitmap.createBitmap(w, h, ARGB_8888)` 一次就是上百 MB。
- 修复：新增 `MAX_PIXELS = 4e6`，宽度裁剪后再按总像素等比缩放。
- 理由：A4 在 `scale=2` 下约 1190×1684≈2.0MP，`scale=3` 裁到宽 1600 后约 3.6MP，都在 4MP 以内——正常课表的输出尺寸**一分不变**，只在病态比例下才生效。

#### B3 传输响应体无上限，可被撑爆内存
- 位置：`FileTransfer.java:592` `readBytes()` / `:399` `getBytes()`
- 根因：`ByteArrayOutputStream` 无上限地累积。一个返回 200 的代理拦截页或错误页就能把堆打满。
- 修复：`readBytes(is, limit)` 增加上限——单块（二进制）`CHUNK + 64KB`，JSON 响应 `4MB`；超限抛带说明的 `IOException`。
- 理由：协议上单块响应就是一块密文（2MB + 16B tag），4MB 已足够容纳任何正常 JSON 回包。

#### B4 3xx 被当成成功，重定向页 HTML 喂给上层
- 位置：`MainActivity.java:654`
- 根因：只判了 `code >= 400`。`HttpURLConnection` 只在同协议内自动跟随重定向，`http→https` 这类跨协议跳转不会跟随，于是 3xx 的响应体（通常是跳转提示 HTML）被当正文分块回传，上层解析失败且毫无线索。
- 修复：`300 <= code < 400` 单独判为错误，消息里带上 `Location`。
- 理由：把「看起来成功但内容是垃圾」变成「明确告诉你该改哪个地址」。正常 API 不会返回 3xx。

#### B5 并发选文件导致前一个 Promise 永挂
- 位置：`MainActivity.java:883` `openPicker()`
- 根因：`pickReqId` 是单值字段。用户（或脚本）连续发起两次 `pickFile`，第二次覆盖第一次的 id，第一次的回调永远等不到 → 页面一直转圈。
- 修复：已有请求在途时，对新请求立即回 `{ok:false,error:"已经有一个文件选择正在进行"}`；`startActivityForResult` 抛异常时把 `pickReqId` 复位。
- 理由：系统选择器本身不支持并行，明确拒绝比静默覆盖可诊断。复位则是防止失败后下一次选择结果串到已废弃的 id 上。

### C. 异常处理缺失

#### C1 渲染进程被回收 → 整个 App 闪退
- 位置：`MainActivity.java:149` 新增 `onRenderProcessGone`
- 根因：`WebViewClient` 未重写该回调。系统因内存压力杀掉渲染进程时，默认行为是把宿主进程一起杀掉。
- 修复：重写并返回 `true`——摘除、销毁 WebView，Toast 说明原因后 `finish()`。
- 理由：这是 WebView 外壳应用最常见的「莫名其妙闪退」。返回 `true` 表示已自行处理，用户看到的是提示而不是崩溃。该回调 API 26+ 才有，低版本永不触发，无副作用。

#### C2 前台服务起不来 → 5 秒后必崩
- 位置：`KeepAliveService.java:54`
- 根因：`startForeground()` 失败被 `catch` 吞掉后仍然 `return START_STICKY`，服务以普通服务形式留在后台。系统会在 `startForegroundService()` 5 秒后判定「没有调用 startForeground」并杀进程（日志 `did not then call Service.startForeground()`）。
- 修复：失败即 `stopSelf()` 并返回 `START_NOT_STICKY`。
- 理由：保活是「锦上添花」的能力，起不来就该干净退出，不能拿一次崩溃换一个假的后台常驻。

#### C3 停机竞态打死 accept 线程并泄漏 socket
- 位置：`AssetServer.java:137`
- 根因：`stop()` 里 `pool.shutdownNow()` 之后，accept 循环可能恰好拿到一个新连接，`pool.submit()` 抛 `RejectedExecutionException`（RuntimeException），而循环只 catch `IOException`。异常逃出 `run()`，accept 线程死亡，`Socket` 无人关闭。
- 修复：捕获 `RuntimeException` 并记录；用 `finally` 关闭尚未移交的连接（提交成功则置空，交由 `handle` 关闭）。
- 理由：停机瞬间的竞态窗口，不接住就是「偶发一个连接卡住 + 线程静默消失」。

#### C4 PDF 首页 Page 句柄泄漏
- 位置：`PdfIngest.java:72` `infoJson()`
- 根因：`p.close()` 直接跟在两次 `o.put(...)` 之后，`getWidth()/getHeight()` 抛异常时不会执行。`PdfRenderer` 只要有未关闭的 Page 就关不掉，底层文件描述符一起泄漏。
- 修复：`p.close()` 移入 `finally`。
- 理由：`PdfRenderer` 是「一次性」资源，泄漏会累积到进程重启。

### D. 内存 / 资源泄漏

#### D1 WebView 未脱离 View 树就 destroy
- 位置：`MainActivity.java:487` `onDestroy()`
- 根因：`webView.destroy()` 时它仍是 `rootLayout` 的子 View。这种状态下 WebView 持有的 Activity / 渲染进程引用不会释放，Activity 无法回收。
- 修复：`loadUrl("about:blank")` → `rootLayout.removeView(webView)` → `destroy()`，每步独立 try。
- 理由：这是标准销毁顺序，也是这类外壳应用最主要的泄漏来源。

#### D2 `PermissionRequest` 被覆盖后永久悬挂
- 位置：`MainActivity.java:170`
- 根因：`pendingPermission` 单值。第二次 `onPermissionRequest` 覆盖第一次，被覆盖的那个既没 `grant` 也没 `deny`，WebView 一直认为页面还在等授权，JS 侧 `getUserMedia` 永不 resolve。
- 修复：处理新请求前，先 `deny()` 掉旧的。
- 理由：权限请求必须「每个都有答复」，拒绝旧的比让它悬着更符合契约。

#### D3 销毁后仍向 WebView 注入 JS
- 位置：`MainActivity.java:516` / `emit()`
- 根因：`emit` 无生命周期判断。`onDestroy` 之后仍在排队的回调（HTTP 分块、传输进度）会继续 `evaluateJavascript` 到已销毁的 WebView。
- 修复：`Bridge` 增加 `volatile boolean closed`，`shutdown()` 置位；`emit` 入口与 `post` 落地前各判一次。
- 理由：`post` 是异步的，两次判断分别挡住「已关闭」和「排队期间关闭」。`volatile` 保证跨线程可见性。

#### D4 `abort` 在写请求体期间是空操作
- 位置：`MainActivity.java:635`
- 根因：`live.put(reqId, c)` 写在「写完 body」之后。大 prompt 写入可能耗时几十秒，这期间用户点「停止」，`httpAbort` 在 `live` 里找不到连接，disconnect 不执行，线程带着连接跑完整条请求。
- 修复：`live.put` 前移到建连之后、写 body 之前。
- 理由：`HttpURLConnection.disconnect()` 在未 connect 状态下调用是安全的；登记越早，可中断窗口越完整。

#### D5 PDF 流解压内存失控
- 位置：`PdfIngest.java:375` / `:716`
- 根因：两处叠加。① `streams()` 把**所有** stream 解压后全部持有在 `List` 里，只做了「单条 ≤12MB」的限制，没有总量限制；② `inflateWith` 初始容量按 `data.length * 3` 预留，8MB 的流一上来就申请 24MB。
- 修复：① 增加 64MB 总量预算，超预算的流跳过（**跳过而不是 break**——内嵌大图常排在文本流前面，break 会让整份 PDF 丢文本）；② 初始容量改为 `min(max(256, len), 64KB)`，靠 `ByteArrayOutputStream` 自己倍增。
- 理由：正常课表 PDF 全部流加起来只有几百 KB，预算不会误伤；真正被挡掉的是内嵌大图。跳过的语义也保证文本提取质量不退化。

#### D6 MediaStore 残留不可见的半成品行
- 位置：`FileTransfer.java:486` `publish()`
- 根因：`IS_PENDING=1` 插入后，若 `copy()` 失败就直接抛异常，那条行留在媒体库里：`IS_PENDING=1` 的记录在「下载」中不可见，系统也不会自动清理，日积月累就是一堆 0 字节垃圾。
- 修复：`catch` 里 `r.delete(item, null, null)` 后再抛出。
- 理由：要么完成、要么不留下痕迹，不留中间态。

#### D7 图标文件被并发读到半成品
- 位置：`AppCatalog.java:184`
- 根因：`ensureIcon` 直接写目标文件，而 `AssetServer` 会并发地按同一文件名读它（`/__appicon/<hash>.png`）。读到写了一半的 PNG，前端就是破图，且会被 WebView 缓存住。
- 修复：写「带线程 id 的临时文件」→ `renameTo` 原子改名；rename 失败时退化为直接写；`finally` 清理临时文件。
- 理由：临时文件名带线程 id，避免两次并发导出互相覆盖同一个 `.tmp`；`.tmp` 后缀不匹配 `readIcon` 的白名单正则（`[a-f0-9]{16}\.png`），永远不会被对外提供。

---

## 三、第二轮修复（第一轮遗留项中的 5 项）

### E1 到点重排会撤掉「同一时刻」的另一条提醒 → 重复播报
- 位置：`Reminders.java:214-266` `armAll()`
- 现象：两条待办设在同一时刻（比如都 18:00 截止）时，提醒会响两遍——第二遍晚约 1 秒。
- 根因：`armAll` 无条件先 `cancelAll()` 再全量重排。A 到点的广播里重排时，B 的闹钟被撤销又在 `now+1000` 重新排进去；而 B 的广播此刻多半已经在派发队列里，撤销拦不住它 → B 响两次。顺带每次到点都会把另外 7 个闹钟拆了重建。
- 修复：用 `SLOT_KEY[槽位] = tag|at` 记录系统里实际排了什么，改成**差量**——只撤「计划里已经消失」的槽位，只补「还没排上」的条目，没变化的槽位一概不碰。
- 理由：闹钟身份是槽位（requestCode），只要槽位内容没变就没必要动它。进程刚启动时 `SLOT_KEY` 不可信，仍走一次全撤重排（原有行为），不影响开机的自愈能力。
- 附带：`arm()` 改为返回是否真的排进系统，排失败不记账，下次重排会再试——避免「记成已排但系统里没有」导致该提醒永久失踪。

### E2 计划读改写存在跨线程竞态
- 位置：`Reminders.java` `setPlan / clearPlan / onFired / rearmAfterRestart / testIn / takeEvents`
- 根因：这些方法会被三个线程调用（WebView 桥线程、广播主线程、开机广播线程），而它们都是「读 K_PLAN → 改 → 写回 → 重排」的复合操作，交错执行会丢更新（典型：编辑待办的同时一条提醒到点，其中一次写入被覆盖）。
- 修复：全部加 `synchronized`（类级锁，均为毫秒级临界区，无嵌套外部锁）。
- 理由：复合读改写必须原子化；`armAll` 里还有 `SLOT_KEY` 这个共享数组，同样需要串行保护。

### E3 自检提醒会被一次普通重排清掉
- 位置：`Reminders.java:104` `setPlan()`
- 根因：自检条目（`selftest`）只存在于原生计划里，JS 的计划里没有。`setPlan` 是整份替换，用户点「通知自检」后只要期间改一条待办或切后台再回来，这条自检就被覆盖 —— 用户等一分钟没等到，只会认为「通知坏了」。
- 修复：整份替换时，把存储里 `at > now` 且 JS 计划中没有的 `selftest` 条目接回来。
- 理由：只接力 `selftest` 这一个原生私有 tag，不碰 JS 的任何条目；自检响过之后会被 `onFired` 摘掉，不会被重复接回。

### E4 前台通知在通知栏里越堆越多
- 位置：`MainActivity.java:660` `Bridge.notify()`
- 根因：通知 id 由 `"notify-" + (System.currentTimeMillis() & 0xffff)` 派生，每弹一次就是一个新 id，同一条待办的提醒会累积成十几条。
- 修复：改用标题派生稳定键 `"notify-" + title.hashCode()`。
- 理由：同一条待办再次提醒时变成「替换」而不是「新增」。标题里已带待办名，天然一一对应。

### E5 渲染缓存键不含文件内容指纹
- 位置：`PdfIngest.java:140` / `fileName()`
- 根因：缓存键是 `uri + scale`。SAF 的 `content://` URI 在「同一路径覆盖成新文件」时不变，于是新 PDF 会复用上一份的渲染图，导入出错课表还看不出来。
- 修复：键里加入 `pfd.getStatSize()`；同时把 `scale` 先夹到 `[1,3]` 再参与哈希。
- 理由：夹 scale 是因为 `scale=5` 和 `scale=3` 的渲染结果相同，按原始值哈希会存两份且永远对不上。
- 副作用：旧缓存文件残留在 `cacheDir`，首次导入后由 JS 的 `pdfClear()` 清理，属可回收目录。

### E6 开机广播里同步做磁盘 IO
- 位置：`RestartReceiver.java:36`
- 根因：`rearmAfterRestart` 在 `onReceive` 主线程里做 2 次 `SharedPreferences.commit()` + 最多 8 次 `setExact`。开机瞬间主线程本就拥挤，StrictMode 会直接报「主线程磁盘写」。
- 修复：`goAsync()` + 工作线程执行，完成后 `finish()`。
- 理由：`goAsync` 是广播里做异步工作的标准姿势，系统会保证进程活到 `finish()` 为止。保留 `commit()`（不改 `apply`）——重排前必须确认计划已落盘，否则进程被回收会丢计划。

---

## 四、仍未修复

| # | 位置 | 问题 | 为什么不改 |
|---|---|---|---|
| 1 | `alerts.js:139` + `Reminders.notify`（**新发现，P1**） | 前台提醒会出**两条**通知：JS 的 `fireTodo` 走 `Bridge.notify`（id=标题哈希），原生闹钟同时走 `AlarmReceiver`→`Reminders.notify`（id=`todo-<id>` 哈希），两条 id 不同、互不覆盖 | 修法明确：① `alerts.js` 的 `notify(title, body)` 增加第三个参数 `'todo-'+r.id`，`finishPomodoro` 传 `'pomo'`；② `native.js` 转发第三参；③ `Bridge.notify` 用传入的 tag 优先。三处共约 6 行，但**属于前台通知策略变更，无真机无法验证去重效果**，需你确认后我再改 |
| 2 | `Bridge.installedApps / pdfText / pdfRender` | `@JavascriptInterface` 同步调用会占住 WebView 的 JS 线程：枚举上百应用逐个渲染图标、解析 20MB PDF 时页面卡顿数百毫秒到 1 秒 | 需把 `native.js` + `pages/resources.js` + `pages/timetable.js` + `lib/pdfImport.js` 四处调用链改成异步，改动面大且无设备做冒烟测试；先以「加异步变体、缺失时回退同步」的方式排期更稳 |
| 3 | `AssetServer.write()` | 静态资源 `Cache-Control: no-store`，每次启动重新传输并解析约 700KB JS | 要加 `ETag`/`If-None-Match` 并改请求头解析；写错直接白屏，而本地无法运行 `AssetServer`（依赖 Android `AssetManager`）做验证 |
| 4 | `MainActivity` | `singleTask` 没有 `onNewIntent` | 点通知回前台时页面本来就会走 `visibilitychange → reconcile()`，用户无感；补 `onNewIntent` 必须同时有前端处理函数才有意义，否则是空实现 |

---

## 五、改动文件

```
android/app/src/main/java/com/zhou/todolink/MainActivity.java     +83 -?   B4 B5 C1 D1 D2 D3 D4 E4
android/app/src/main/java/com/zhou/todolink/Reminders.java        +99 -?   A1 A2 A3 E1 E2 E3
android/app/src/main/java/com/zhou/todolink/FileTransfer.java     +65 -?   A4 B3 D6
android/app/src/main/java/com/zhou/todolink/PdfIngest.java        +55 -?   B1 B2 C4 D5 E5
android/app/src/main/java/com/zhou/todolink/AssetServer.java      +19 -?   C3
android/app/src/main/java/com/zhou/todolink/AppCatalog.java       +39 -?   D7
android/app/src/main/java/com/zhou/todolink/KeepAliveService.java +10 -?   C2
android/app/src/main/java/com/zhou/todolink/RestartReceiver.java  +22 -?   E6
```

产物：`android/todo-link-3.7.1.apk`（versionName 3.7.1 / versionCode 32；含锁屏提醒修复与全部 26 处缺陷修复，签名证书与 3.7.0 一致，可直接覆盖安装）


---

## 六、锁屏后收不到通知（用户实测反馈，P0）

### 现象与链路

点「设置 → 提醒 → 通知自检 → 10 秒后测试提醒」，按下电源键锁屏，到点没有任何通知。

链路：`testIn()` 把 `selftest` 写进原生计划并排进 AlarmManager → 锁屏触发 WebView `visibilitychange(hidden)` → `alerts.js#scheduleAlarms()`。

### 根因

```js
// 修复前
if (!plan.length) { cancelAlarms(); return }   // ← 这一行
```

`cancelAlarms()` 走的是 `Reminders.clearPlan()`：**把 K_PLAN 置为 "[]" 并撤销全部 8 个槽位**。

而 `planItems()` 只收「`at > now` 的待办」，用户做通知自检时通常**没有任何待办**，所以 `plan` 恒为空 → 锁屏瞬间把刚排好的自检闹钟撤掉。自检条目只存在于原生计划里，JS 这份空计划一撤，它就再也回不来了 —— 到点自然什么都不响。

同一行还牵连更广：任何「这一刻算不出计划」的时机（数据未就绪、只有原生独有条目）都会把系统里的闹钟全撤。

**「此刻没有计划」不等于「用户关掉了提醒」**，这是语义混淆。

### 修复

1. **`alerts.js#scheduleAlarms()`**：空计划改为 `setAlarms('[]')`，走 `setPlan` 的差量逻辑 —— 多余槽位照撤，原生独有条目（自检）保留。真正的「取消全部」只保留在用户关掉提醒开关那一条分支（`notifyTodo === '0'`）。
2. **`MainActivity.onPause()`**：新增 `flushAlarms()`，息屏/切后台时把计划钉进系统。WebView 在按电源键息屏时不保证收到 `visibilitychange`（窗口对 WindowManager 仍可见），而 `onChange` 的 2.5 秒防抖在页面冻结后不会再执行 —— 最后改的那条提醒就永远排不上。
3. **`app.js`**：暴露 `window.__flushAlarms = scheduleAlarms`，供原生 `onPause` 调用。
4. **`Reminders.testIn()`**：连点两次自检会留下两条（`drop(..., "selftest", 0)` 的回退条件 `it.at <= 0` 永远不成立），旧的 at 已过会被立刻补排、1 秒后误响一次。改为按 tag 直接滤掉旧条目。
5. **`Reminders.notify()`**：通知失败从「完全静默」改为 `Log.w`，避免再次出现「现象在、原因查不到」。

### 验证

`_tools/notify-check.mjs` 新增场景 3，并在**老实现上跑过确认会红**：

```
修复前： ✗ 空计划不再调用 cancelAlarms — cancelAlarms        （29/30）
修复后： ✓ 空计划不再调用 cancelAlarms — (无调用)             （30/30）
        ✓ 空计划改为下发 setAlarms([])，由原生按差量撤槽位 — [[]]
        ✓ 原生 onPause 的 flush 钩子已挂上
```

### 装机复测步骤

1. 设置 → 提醒 → 通知自检，前三行应为绿。
2. 点「10 秒后测试提醒」，**立刻按电源键锁屏**。
3. 到点应弹通知 + 震动；解锁回设置页，「上次提醒」应显示 `延迟 晚 N 毫秒`。
4. 若 `延迟` 只有几百毫秒却仍无声音，问题在系统通知设置（渠道被静音 / 勿扰），自检第一、三行会标红。

---

## 七、3.7.1 打包

| 项 | 值 |
|---|---|
| 产物 | `android/todo-link-3.7.1.apk`（400 KB） |
| versionName / versionCode | 3.7.1 / 32（自 3.7.0 的 31 递增，可覆盖安装） |
| 签名 | `CN=Todo Link, O=zhou, C=CN`，SHA-256 `0be758eb…0620ab`，与 3.7.0 同一证书 |
| 版本号来源 | `build.sh` 的 `VER_NAME`/`VER_CODE` + `AndroidManifest.xml`；运行时由 `Bridge.appVersion()` 读 `PackageInfo.versionName`，前端无需改动 |

### 产物抽检

```
assets/              48 个文件，APK 总条目 62
alerts.js 空计划分支  已下发 setAlarms('[]')，无 cancelAlarms()
config.xml / app.js   window.__flushAlarms 已挂载
classes.dex           含 __flushAlarms、onRenderProcessGone、响应体超限文案、selftest
```

### 回归

| 项 | 结果 |
|---|---|
| `node --test tests/*.test.mjs` | 153 / 153 |
| `_tools/notify-check.mjs` | 30 / 30（含锁屏场景 3） |

> 未改动的版本号：浏览器扩展 `extensions/todo-relay/manifest.json` 仍为 3.7.0。扩展与 APK 独立发布，本次仅出安卓包，如需同步升版请说明。
