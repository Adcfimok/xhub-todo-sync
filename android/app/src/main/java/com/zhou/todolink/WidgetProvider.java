package com.zhou.todolink;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.widget.RemoteViews;

/**
 * 桌面小组件：展示待办摘要与今日课表。
 *
 * 数据流：WebView 里的 JS 把摘要写进 SharedPreferences（走 Bridge.setWidgetData），
 * 再触发全量刷新。小组件本身不直接碰 IndexedDB，避免跨进程读不到。
 */
public class WidgetProvider extends AppWidgetProvider {

    static final String PREFS = "xhub_widget";
    static final String KEY_TODO = "todo";
    static final String KEY_TIMETABLE = "timetable";
    static final String ACTION_UPDATE = "com.zhou.todolink.UPDATE_WIDGET";

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) update(ctx, mgr, id);
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        super.onReceive(ctx, intent);
        if (ACTION_UPDATE.equals(intent.getAction())) updateAll(ctx);
    }

    @Override
    public void onAppWidgetOptionsChanged(Context ctx, AppWidgetManager mgr, int id, Bundle options) {
        update(ctx, mgr, id);
    }

    static void updateAll(Context ctx) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, WidgetProvider.class));
        for (int id : ids) update(ctx, mgr, id);
    }

    static void update(Context ctx, AppWidgetManager mgr, int id) {
        SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String todo = sp.getString(KEY_TODO, "待办已清空");
        String tt = sp.getString(KEY_TIMETABLE, "今天没有课");

        RemoteViews rv = new RemoteViews(ctx.getPackageName(), R.layout.widget);
        rv.setTextViewText(R.id.widget_todo, todo);
        rv.setTextViewText(R.id.widget_timetable, tt);

        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (android.os.Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getActivity(ctx, 0, open, flags);
        rv.setOnClickPendingIntent(R.id.widget_root, pi);

        mgr.updateAppWidget(id, rv);
    }
}
