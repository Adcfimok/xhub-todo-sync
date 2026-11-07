package com.zhou.todolink;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 系统闹钟到点：发强提醒通知。
 *
 * 只做一件事——把 PendingIntent 里带的标题/正文交给 Reminders 发通知。
 * 之所以不在 JS 里做，是因为息屏后 WebView 的定时器会被冻结，
 * 只有 BroadcastReceiver 能被系统在到点时唤醒。
 */
public class AlarmReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String title = intent.getStringExtra("title");
        String body = intent.getStringExtra("body");
        String tag = intent.getStringExtra("tag");
        Reminders.notify(context, title == null ? "提醒" : title, body == null ? "" : body, tag, true);

        // 顺带震动一次：部分机型把渠道震动交给系统后会静音，这里补一层
        try {
            android.os.Vibrator v = (android.os.Vibrator) context.getSystemService(Context.VIBRATOR_SERVICE);
            if (v != null) {
                if (android.os.Build.VERSION.SDK_INT >= 26) {
                    v.vibrate(android.os.VibrationEffect.createWaveform(new long[]{0, 320, 160, 320}, -1));
                } else {
                    v.vibrate(new long[]{0, 320, 160, 320}, -1);
                }
            }
        } catch (Throwable ignore) {
            // 没有振动器就只发通知
        }
    }
}
