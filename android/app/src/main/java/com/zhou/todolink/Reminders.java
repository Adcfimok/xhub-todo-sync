package com.zhou.todolink;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 提醒的「系统侧」实现：通知渠道 + 精确闹钟。
 *
 * 为什么需要闹钟：WebView 里的 setInterval 在息屏 / 后台会被冻结，
 * 只靠 JS 定时器，锁屏后提醒要等用户再次打开 App 才补发。
 * 这里把未来最近的几条提醒交给 AlarmManager，到点由 AlarmReceiver 发通知。
 *
 * 只保留最近 3 条：PendingIntent 用固定 requestCode(0..2)，
 * 重复调度会覆盖同一条，不会越积越多，取消时也只需撤这 3 个。
 */
final class Reminders {

    static final String CHANNEL_ID = "xhub_reminder";
    static final String ALARM_CHANNEL_ID = "xhub_alarm";
    static final int MAX_ALARMS = 3;

    private Reminders() {}

    /** Android 8+ 必须先建渠道；闹钟用独立渠道，音量与震动不受「待办提醒」静音影响 */
    static void ensureChannels(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        NotificationChannel normal = new NotificationChannel(CHANNEL_ID, "待办提醒", NotificationManager.IMPORTANCE_HIGH);
        normal.setDescription("待办与番茄钟提醒");
        normal.enableVibration(true);
        normal.setVibrationPattern(new long[]{0, 180, 90, 180});
        nm.createNotificationChannel(normal);

        NotificationChannel alarm = new NotificationChannel(ALARM_CHANNEL_ID, "强提醒（闹钟）", NotificationManager.IMPORTANCE_HIGH);
        alarm.setDescription("到点强提醒：响铃 + 震动，息屏也会响");
        alarm.enableVibration(true);
        alarm.setVibrationPattern(new long[]{0, 320, 160, 320, 160, 420});
        alarm.setBypassDnd(true);
        nm.createNotificationChannel(alarm);
    }

    /** json: [{at: 毫秒, title, body, tag}]，按时间升序，最多取前 3 条 */
    static void schedule(Context ctx, String json) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        cancel(ctx);

        long now = System.currentTimeMillis();
        int slot = 0;
        try {
            JSONArray arr = new JSONArray(json == null ? "[]" : json);
            for (int i = 0; i < arr.length() && slot < MAX_ALARMS; i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                long at = o.optLong("at", 0);
                if (at <= now + 1000) continue;
                String title = o.optString("title", "提醒");
                String body = o.optString("body", "");
                String tag = o.optString("tag", "alarm");
                PendingIntent pi = pending(ctx, slot, title, body, tag, PendingIntent.FLAG_UPDATE_CURRENT);
                try {
                    if (Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms()) {
                        // 用户没给「精确闹钟」权限时退化为省电模式允许的近似闹钟，宁可晚几分钟也不能不响
                        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                    } else if (Build.VERSION.SDK_INT >= 23) {
                        am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                    } else {
                        am.setExact(AlarmManager.RTC_WAKEUP, at, pi);
                    }
                } catch (SecurityException se) {
                    am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                }
                slot++;
            }
        } catch (Throwable ignore) {
            // 解析失败就不排闹钟，JS 侧还有前台提醒兜底
        }
    }

    static void cancel(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        for (int slot = 0; slot < MAX_ALARMS; slot++) {
            PendingIntent pi = pending(ctx, slot, "", "", "", PendingIntent.FLAG_UPDATE_CURRENT);
            if (pi != null) {
                am.cancel(pi);
                pi.cancel();
            }
        }
    }

    private static PendingIntent pending(Context ctx, int slot, String title, String body, String tag, int extraFlags) {
        Intent intent = new Intent(ctx, AlarmReceiver.class);
        intent.setAction("com.zhou.todolink.ALARM_" + slot);
        intent.putExtra("title", title);
        intent.putExtra("body", body);
        intent.putExtra("tag", tag);
        int flags = PendingIntent.FLAG_IMMUTABLE | extraFlags;
        return PendingIntent.getBroadcast(ctx, slot, intent, flags);
    }

    /** 统一的发通知入口：Bridge.notify 与 AlarmReceiver 共用 */
    static void notify(Context ctx, String title, String body, String tag, boolean alarm) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getActivity(ctx, 0, open, flags);

        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            b = new Notification.Builder(ctx, alarm ? ALARM_CHANNEL_ID : CHANNEL_ID);
        } else {
            b = new Notification.Builder(ctx);
        }
        b.setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(title == null ? "提醒" : title)
                .setContentText(body == null ? "" : body)
                .setStyle(new Notification.BigTextStyle().bigText(body == null ? "" : body))
                .setAutoCancel(true)
                .setContentIntent(pi)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setWhen(System.currentTimeMillis())
                .setShowWhen(true);

        if (Build.VERSION.SDK_INT >= 26) {
            b.setChannelId(alarm ? ALARM_CHANNEL_ID : CHANNEL_ID);
        } else {
            b.setPriority(Notification.PRIORITY_HIGH);
            b.setDefaults(Notification.DEFAULT_ALL);
            if (alarm) b.setVibrate(new long[]{0, 320, 160, 320});
        }
        if (alarm) {
            b.setCategory(Notification.CATEGORY_ALARM);
        }

        int id = tag == null || tag.isEmpty() ? (int) (System.currentTimeMillis() & 0x7fffffff) : tag.hashCode();
        nm.notify(id, b.build());
    }
}
