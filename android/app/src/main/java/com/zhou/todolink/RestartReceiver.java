package com.zhou.todolink;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 开机 / 应用更新后重新排提醒。
 *
 * 为什么必须有：系统重启会把 AlarmManager 里所有闹钟清空（这是系统的硬性行为，
 * 不是 App 能保留的）。没有这个接收器，用户重启一次手机，
 * 之后所有提醒就彻底不再响——表现就是「App 没打开时完全收不到通知」。
 *
 * 同时处理 TIME_SET：用户手动改系统时间后，卡片里显示的「还有多久」会变，
 * 重新排一次让闹钟与新时间对齐。
 */
public class RestartReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (action == null) return;

        boolean rearm = Intent.ACTION_BOOT_COMPLETED.equals(action)
                // 部分国产 ROM 重启广播用的是厂商自定义 action
                || "android.intent.action.QUICKBOOT_POWERON".equals(action)
                || "com.htc.intent.action.QUICKBOOT_POWERON".equals(action)
                // 覆盖安装 / 升级后闹钟同样会被清理
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                // 手动改时间 / 换时区
                || Intent.ACTION_TIME_CHANGED.equals(action)
                || Intent.ACTION_TIMEZONE_CHANGED.equals(action);
        if (!rearm) return;

        final Context ctx = context.getApplicationContext();

        // 重排要读计划、写 SharedPreferences、再下发最多 8 个闹钟，全是同步 IO。
        // 开机那一刻主线程本来就拥挤，在广播里直接做容易被判 ANR；
        // goAsync() 把这段挪到工作线程，跑完再 finish，系统会保证进程活到那时。
        final PendingResult pr = goAsync();
        new Thread(() -> {
            try {
                Reminders.ensureChannels(ctx);
                Reminders.rearmAfterRestart(ctx);
            } catch (Throwable ignore) {
                // 重排失败不该让进程崩掉；用户下次打开 App 时 setPlan 会再排一次
            } finally {
                if (pr != null) {
                    try {
                        pr.finish();
                    } catch (Throwable ignore) {
                    }
                }
            }
        }, "xhub-rearm").start();
    }
}
