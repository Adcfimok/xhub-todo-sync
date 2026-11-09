# 待办同步 安卓端 v3.7.1

> 说明依据来源：`android/BUG-AUDIT.md`（工作区安卓端代码审查与缺陷修复报告，覆盖 3.7.1 两轮改动与锁屏通知 P0 修复）。
> 以下变更条目均可在该报告对应章节核对，未作推测性补充。

## 版本信息

| 项 | 值 | 来源 |
| --- | --- | --- |
| versionName / versionCode | 3.7.1 / 32（自 3.7.0 的 31 递增，可覆盖安装） | `aapt dump badging` 实测；`android/BUG-AUDIT.md` 第七节 |
| 包名 | `com.zhou.todolink` | `aapt dump badging` 实测 |
| 签名证书 | 与 3.7.0 同一证书（`CN=Todo Link, O=zhou, C=CN`） | `android/BUG-AUDIT.md` 第七节 |
| 产物大小 | `android/todo-link-3.7.1.apk` 约 400 KB | 工作区文件 |

## 重点修复：锁屏后收不到通知（P0）

用户实测反馈：锁屏后到点无任何通知。根因是 `alerts.js#scheduleAlarms()` 在「当前算不出计划」（如无任何待办）时调用 `cancelAlarms()`，把刚排好的自检闹钟一并撤销；且锁屏瞬间 WebView 不保证收到 `visibilitychange`，最后一条提醒排不上。

修复（详见 `android/BUG-AUDIT.md` 第六节）：

- 空计划改为下发 `setAlarms('[]')`，走差量撤槽位逻辑，保留原生独有条目（如通知自检）。
- `MainActivity.onPause()` 新增 `flushAlarms()`，息屏/切后台时把计划钉进系统。
- `app.js` 暴露 `window.__flushAlarms` 供原生 `onPause` 调用。
- `Reminders.testIn()` 修正连点自检残留；`Reminders.notify()` 失败从静默改为 `Log.w`。

## 缺陷修复汇总（共 26 处，分两轮）

第二轮确认并修复 26 处缺陷，按维度归类（位置与根因见 `android/BUG-AUDIT.md` 第二、三节）：

- **逻辑错误（A1–A4）**：提醒去重方向反了导致改时间后新提醒不响；旧闹钟迟到广播误删新提醒；无 `at` 字段的旧闹钟误删无关提醒；下载落盘成功却误报失败。
- **边界条件（B1–B5）**：`isPdf` 数组越界；极窄超长页面渲染 OOM；传输响应体无上限可被撑爆内存；3xx 被当成成功；并发选文件导致前一个 Promise 永挂。
- **异常处理缺失（C1–C4）**：渲染进程被回收致闪退；前台服务起不来 5 秒后必崩；停机竞态打死 accept 线程并泄漏 socket；PDF 首页 Page 句柄泄漏。
- **内存 / 资源泄漏（D1–D7）**：WebView 未脱离 View 树就销毁；`PermissionRequest` 被覆盖后永久悬挂；销毁后仍向 WebView 注入 JS；`abort` 在写请求体期间是空操作；PDF 流解压内存失控；MediaStore 残留半成品行；图标文件被并发读到半成品。
- **第二轮（E1–E6）**：到点重排重复播报；计划读改写跨线程竞态；自检提醒被普通重排清掉；前台通知在通知栏越堆越多；渲染缓存键不含文件内容指纹；开机广播里同步做磁盘 IO。

说明：上述条目均属「补齐判断 / 调整顺序 / 加界限 / 串行化复合写」，未改动对外方法签名、JSON 字段语义或 JS 桥接口，前端无需同步修改。

## 回归

| 项 | 结果 |
| --- | --- |
| `node --test _tools/release-upload/upload.test.mjs` 等 JS 单测 | 153 / 153（据 `android/BUG-AUDIT.md`） |
| `_tools/notify-check.mjs`（含锁屏场景 3） | 30 / 30 |

> 真机 / 模拟器冒烟未做（本机无 adb 与设备），涉及传感器、通知、SAF 的路径建议装机复测。

## 注意

浏览器扩展 `extensions/todo-relay/manifest.json` 仍为 3.7.0；扩展与 APK 独立发布，本次仅出安卓包。
