package com.zhou.todolink;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.PowerManager;

/**
 * 系统闹钟到点：发强提醒通知，并把下一条提醒补排进系统。
 *
 * 为什么要在这里补排：AlarmManager 的闹钟是一次性的，响过就消失。
 * 如果只在 WebView 里排闹钟，App 被杀掉后「响完这一条就再也没有下一条」。
 * 到点后直接从 SharedPreferences 的计划里取下一条续上，才能做到 App 没打开也持续提醒。
 *
 * goAsync() + 短时 WakeLock：onReceive 返回后进程随时可能被回收，
 * 补排 / 落盘这些动作必须在这个窗口内跑完，否则会丢闹钟。
 */
public class AlarmReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        final Context ctx = context.getApplicationContext();
        final String title = intent.getStringExtra("title");
        final String body = intent.getStringExtra("body");
        final String tag = intent.getStringExtra("tag");
        final long at = intent.getLongExtra("at", 0);

        final PendingResult pr = goAsync();
        PowerManager.WakeLock lock = null;
        try {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                lock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "xhub:alarm");
                lock.acquire(10000);
            }
        } catch (Throwable ignore) {
            // 拿不到 WakeLock 也要继续：短任务通常能在进程被回收前跑完
        }

        try {
            Reminders.notify(ctx, title == null ? "提醒" : title, body == null ? "" : body, tag, true);
            vibrate(ctx);
            // 记账 + 摘除 + 补排下一条
            Reminders.onFired(ctx, tag, at);
        } catch (Throwable ignore) {
            // 任何异常都不该让广播崩掉，否则系统可能判定 App 异常
        } finally {
            if (lock != null) {
                try {
                    if (lock.isHeld()) lock.release();
                } catch (Throwable ignore) {
                }
            }
            if (pr != null) {
                try {
                    pr.finish();
                } catch (Throwable ignore) {
                }
            }
        }
    }

    /** 顺带震动一次：部分机型把渠道震动交给系统后会静音，这里补一层 */
    private static void vibrate(Context ctx) {
        try {
            android.os.Vibrator v = (android.os.Vibrator) ctx.getSystemService(Context.VIBRATOR_SERVICE);
            if (v == null || !v.hasVibrator()) return;
            if (android.os.Build.VERSION.SDK_INT >= 26) {
                v.vibrate(android.os.VibrationEffect.createWaveform(new long[]{0, 320, 160, 320}, -1));
            } else {
                v.vibrate(new long[]{0, 320, 160, 320}, -1);
            }
        } catch (Throwable ignore) {
            // 没有振动器就只发通知
        }
    }
}
