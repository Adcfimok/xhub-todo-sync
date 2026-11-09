package com.zhou.todolink;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

/**
 * 后台保活前台服务。
 *
 * WebView 在息屏 / 切后台后会被系统冻结，只靠 JS 定时器收不到通知、同步也会停。
 * 挂一个低优先级前台服务，让进程优先级从「缓存进程」提到「前台服务进程」，
 * 配合 AlarmManager（见 Reminders）才能在后台按时弹通知。
 *
 * 通知不可滑动关闭（ongoing），但优先级 LOW、不响铃不震动，基本无感。
 */
public class KeepAliveService extends Service {

    private static final String CHANNEL_ID = "xhub_keepalive";
    private static final int NOTIF_ID = 9001;

    public static void start(Context ctx) {
        Intent i = new Intent(ctx, KeepAliveService.class);
        if (Build.VERSION.SDK_INT >= 26) {
            ctx.startForegroundService(i);
        } else {
            ctx.startService(i);
        }
    }

    public static void stop(Context ctx) {
        try {
            ctx.stopService(new Intent(ctx, KeepAliveService.class));
        } catch (Throwable ignore) {
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        ensureChannel();
        try {
            startForeground(NOTIF_ID, buildNotification());
        } catch (Throwable e) {
            // 前台服务没起来就必须立刻停掉自己：startForegroundService() 之后
            // 5 秒内没有真正 startForeground()，系统会直接判定 App 异常并杀掉进程
            // （日志里是 "did not then call Service.startForeground()"）。
            // 退化成普通服务继续挂着只会换来一次崩溃，不如干净退出。
            try {
                stopSelf();
            } catch (Throwable ignore) {
            }
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "后台运行", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("保持后台连接，及时接收待办提醒与同步");
        ch.setShowBadge(false);
        ch.enableVibration(false);
        ch.setSound(null, null);
        nm.createNotificationChannel(ch);
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, flags);

        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        b.setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("x-hub 后台运行中")
                .setContentText("保持连接以接收提醒与同步")
                .setContentIntent(pi)
                .setOngoing(true);
        if (Build.VERSION.SDK_INT >= 26) {
            b.setChannelId(CHANNEL_ID);
        } else {
            b.setPriority(Notification.PRIORITY_LOW);
        }
        return b.build();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
