package com.zhou.todolink;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * 提醒的「系统侧」实现：通知渠道 + 精确闹钟 + 提醒计划持久化。
 *
 * 为什么需要原生这一层：WebView 里的 setInterval 在息屏 / 切后台 / 进程被杀后会冻结，
 * 只靠 JS 定时器，锁屏后提醒要等用户再次打开 App 才补发——这就是「延迟」的来源。
 *
 * 为什么要把整份计划存下来：AlarmManager 里的闹钟是「一次性」的，响过就没了。
 * 老实现每次只把最近的 3 条丢给系统，并且 AlarmReceiver 响完不补排，
 * 于是第 4 条之后的提醒、以及 3 条都响过之后的提醒，再也不会响——这就是「收不到」的来源。
 * 现在把完整计划写进 SharedPreferences，到点后由 AlarmReceiver 摘掉已响的那条、
 * 再把下一条排进系统；开机 / 应用更新后由 RestartReceiver 重新排。
 */
final class Reminders {

    static final String CHANNEL_ID = "xhub_reminder";
    static final String ALARM_CHANNEL_ID = "xhub_alarm";

    /** 同时挂在系统里的闹钟条数。到点后自动补下一条，所以不必把全部计划都排进去 */
    static final int MAX_ALARMS = 8;
    /** 计划里最多保留多少条（够覆盖半年的提醒，SharedPreferences 也不至于膨胀） */
    static final int MAX_PLAN = 60;
    /** 过期多久以内还算「可补发」；超过就直接丢弃 */
    private static final long KEEP_PAST = 12L * 3600 * 1000;
    /** 最远排多久：再远的提醒等用户下次打开 App 时自然会重新下发 */
    private static final long MAX_AHEAD = 180L * 86400000L;

    private static final String PREF = "xhub_reminders";
    private static final String K_PLAN = "plan";
    private static final String K_EVENT = "event";
    private static final String K_LAST_AT = "last_at";
    private static final String K_LAST_FIRE = "last_fire";
    private static final String K_LAST_DELAY = "last_delay";
    /** 事件表上限：只需要覆盖「App 没开时响过的那几条」，取最近 80 条足够 */
    private static final int MAX_EVENT = 80;

    private Reminders() {}

    /** 计划里的一条提醒 */
    private static final class Item {
        long at;
        String title = "提醒";
        String body = "";
        String tag = "alarm";
    }

    private static SharedPreferences sp(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(PREF, Context.MODE_PRIVATE);
    }

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

    // ------------------------------------------------------------ 计划维护

    /** 本进程是否已经排过闹钟：进程刚起来时必须无条件排一次（可能被强停/清理过） */
    private static boolean armedThisProcess = false;

    /**
     * 接收 JS 下发的完整提醒计划（不只是最近几条）。
     * json: [{at: 毫秒, title, body, tag}]，tag 是去重键（todo-<id> / pomo / selftest）。
     */
    static synchronized void setPlan(Context ctx, String json) {
        List<Item> items = parse(json);
        SharedPreferences p = sp(ctx);
        // 自检提醒（testIn）只存在于原生计划里，JS 的计划里没有它。
        // 不做接力的话：用户点「通知自检」后，只要期间发生任何一次 scheduleAlarms
        // （改一条待办、切后台再回来），这条自检就被整份计划替换掉了，
        // 用户等了一分钟没等到，只会认为「通知坏了」。
        long now = System.currentTimeMillis();
        Set<String> has = new HashSet<>();
        for (Item it : items) has.add(it.tag);
        for (Item old : parse(p.getString(K_PLAN, "[]"))) {
            if (old.at > now && "selftest".equals(old.tag) && !has.contains(old.tag)) items.add(old);
        }
        Collections.sort(items, BY_AT);
        if (items.size() > MAX_PLAN) items = new ArrayList<>(items.subList(0, MAX_PLAN));

        String text = toJson(items);
        if (armedThisProcess && text.equals(p.getString(K_PLAN, null))) {
            // 计划没变就别重排：编辑待办时 onChange 会反复触发，
            // 每次都「全撤再全排」会在到点那一瞬间把正在派发的闹钟撤掉
            return;
        }
        p.edit().putString(K_PLAN, text).commit();
        armAll(ctx, items);
        armedThisProcess = true;
    }

    /** 清空计划（用户关掉提醒开关时） */
    static synchronized void clearPlan(Context ctx) {
        sp(ctx).edit().putString(K_PLAN, "[]").commit();
        cancelAll(ctx);
    }

    /**
     * 闹钟到点后调用：记录事件 → 从计划里摘掉这条 → 补排下一条。
     * 这是「App 没打开也能持续收到提醒」的关键：补排发生在广播里，不依赖 WebView。
     */
    static synchronized void onFired(Context ctx, String tag, long at) {
        long now = System.currentTimeMillis();
        SharedPreferences p = sp(ctx);
        // at <= 0 说明这条闹钟是旧版本 APK 排下的（当时的 Intent 里没带 at）。
        // 这种事件对不上任何计划条目，写进事件表只会污染 JS 的对账；通知已经发出去了，
        // 这里只更新时间水位，绝不去动计划表 —— 否则会按 tag 误删一条无关的提醒。
        if (at > 0) addEvent(ctx, tag, at, now, false);
        p.edit()
                .putLong(K_LAST_AT, at)
                .putLong(K_LAST_FIRE, now)
                .putLong(K_LAST_DELAY, at <= 0 ? 0 : now - at)
                .commit();
        if (at <= 0) return;

        List<Item> items = drop(parse(p.getString(K_PLAN, "[]")), tag, at);
        p.edit().putString(K_PLAN, toJson(items)).commit();
        armAll(ctx, items);
    }

    /**
     * 开机 / 应用更新后重新排闹钟。
     * 系统重启会清掉所有 AlarmManager 条目，不重排的话用户从此收不到任何提醒。
     */
    static synchronized void rearmAfterRestart(Context ctx) {
        SharedPreferences p = sp(ctx);
        long now = System.currentTimeMillis();
        List<Item> keep = new ArrayList<>();
        for (Item it : parse(p.getString(K_PLAN, "[]"))) {
            if (it.at > now) {
                keep.add(it);
            } else if (now - it.at <= KEEP_PAST) {
                // 关机期间错过的：记成「迟到事件」，下次打开 App 由 JS 决定是否补发
                addEvent(ctx, it.tag, it.at, it.at, true);
            }
        }
        p.edit().putString(K_PLAN, toJson(keep)).commit();
        armAll(ctx, keep);
    }

    /** 取走「App 没开时响过 / 错过」的事件（取走即清空），供 JS 对账去重 */
    static synchronized String takeEvents(Context ctx) {
        SharedPreferences p = sp(ctx);
        String s = p.getString(K_EVENT, "[]");
        if (s == null || s.isEmpty()) s = "[]";
        p.edit().putString(K_EVENT, "[]").commit();
        return s;
    }

    /** 自检：安排一条 N 秒后的提醒，走的是和真实提醒完全相同的通路 */
    static synchronized void testIn(Context ctx, int seconds) {
        int sec = Math.max(1, Math.min(300, seconds));
        // 直接按 tag 滤掉旧的自检条目。原来用 drop(plan, "selftest", 0)，
        // 但 drop 的回退分支要求 it.at <= at（0），永远不成立 ——
        // 连点两次自检会留下两条，旧的那条 at 已过，会被立刻补排并在 1 秒后误响一次。
        List<Item> items = new ArrayList<>();
        for (Item old : parse(sp(ctx).getString(K_PLAN, "[]"))) {
            if (!"selftest".equals(old.tag)) items.add(old);
        }
        Item it = new Item();
        it.at = System.currentTimeMillis() + sec * 1000L;
        it.tag = "selftest";
        it.title = "通知自检";
        it.body = "预定 " + sec + " 秒后提醒；现在能收到，说明到点提醒通路正常";
        items.add(it);
        Collections.sort(items, BY_AT);
        sp(ctx).edit().putString(K_PLAN, toJson(items)).commit();
        armAll(ctx, items);
    }

    // ------------------------------------------------------------ 排闹钟

    /**
     * 槽位 → 当前排在系统里的条目键（tag|at），null 表示该槽空闲。
     *
     * 为什么需要它：老实现每次排闹钟先 cancelAll 再全量重排。只要有任意一条提醒到点，
     * AlarmReceiver 就会重排一次，于是「同一时刻的另一条提醒」被撤销后又在 now+1000 重新排进去；
     * 那条提醒的广播此刻多半已经在派发队列里，撤不掉 —— 结果是它响两遍（晚 1 秒再来一次）。
     * 现在改成差量：只撤计划里已经消失的槽、只补还没排上的条目，没变化的槽位一概不碰。
     */
    private static final String[] SLOT_KEY = new String[MAX_ALARMS];
    /** 进程刚起来时系统里可能还留着上个进程排的闹钟，此时 SLOT_KEY 不可信，必须先全撤一次 */
    private static boolean slotsValid = false;

    private static String keyOf(Item it) {
        return it.tag + "|" + it.at;
    }

    private static synchronized void armAll(Context ctx, List<Item> items) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        long now = System.currentTimeMillis();

        // 候选：最近的 MAX_ALARMS 条；刚过点的（12h 内）允许补一次
        List<Item> want = new ArrayList<>();
        for (Item it : items) {
            if (want.size() >= MAX_ALARMS) break;
            if (it.at > now || now - it.at <= KEEP_PAST) want.add(it);
        }

        if (!slotsValid) {
            cancelAll(ctx);   // 不知道系统里还留着什么，全撤（老行为，进程启动时只走一次）
            slotsValid = true;
        }

        // 1) 撤掉计划里已经没有的槽位
        Set<String> wantKeys = new HashSet<>();
        for (Item it : want) wantKeys.add(keyOf(it));
        for (int slot = 0; slot < MAX_ALARMS; slot++) {
            if (SLOT_KEY[slot] == null || wantKeys.contains(SLOT_KEY[slot])) continue;
            cancelSlot(ctx, am, slot);
            SLOT_KEY[slot] = null;
        }

        // 2) 只补还没排上的条目；已在排的槽位原样不动（避免撤掉正在派发的那一条）
        Set<String> haveKeys = new HashSet<>();
        for (String k : SLOT_KEY) if (k != null) haveKeys.add(k);
        for (Item it : want) {
            String k = keyOf(it);
            if (!haveKeys.add(k)) continue;
            int free = -1;
            for (int slot = 0; slot < MAX_ALARMS; slot++) {
                if (SLOT_KEY[slot] == null) {
                    free = slot;
                    break;
                }
            }
            if (free < 0) break;
            long at = it.at > now ? it.at : now + 1000;   // 刚到点的补一次，别等下次打开 App
            // 排失败就不记账：下次 armAll 会再试。记了账又没排上等于这条提醒永久失踪
            if (arm(am, at, pending(ctx, free, it, PendingIntent.FLAG_UPDATE_CURRENT))) {
                SLOT_KEY[free] = k;
            }
        }
    }

    /** @return 是否真的排进了系统（失败时调用方不应把它记成「已排」） */
    private static boolean arm(AlarmManager am, long at, PendingIntent pi) {
        boolean exact = exactAllowed(am);
        try {
            if (exact) {
                // 精确闹钟：息屏 + Doze 下也在这一秒响。老实现没申请该权限时会静默退化成
                // setAndAllowWhileIdle（Doze 里最晚能拖十几分钟），这正是「延迟」的主因之一
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            } else {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            }
            return true;
        } catch (SecurityException se) {
            // 权限被收回 / 厂商限制：退化为近似闹钟，宁可晚几分钟也不能不响
            try {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                return true;
            } catch (Throwable ignore) {
                return false;
            }
        } catch (Throwable ignore) {
            return false;
        }
    }

    private static void cancelSlot(Context ctx, AlarmManager am, int slot) {
        try {
            PendingIntent pi = pending(ctx, slot, null, PendingIntent.FLAG_UPDATE_CURRENT);
            am.cancel(pi);
            pi.cancel();
        } catch (Throwable ignore) {
        }
    }

    private static synchronized void cancelAll(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am != null) {
            for (int slot = 0; slot < MAX_ALARMS; slot++) cancelSlot(ctx, am, slot);
        }
        for (int i = 0; i < MAX_ALARMS; i++) SLOT_KEY[i] = null;
        slotsValid = false;
    }

    private static PendingIntent pending(Context ctx, int slot, Item it, int extraFlags) {
        Intent intent = new Intent(ctx, AlarmReceiver.class);
        intent.setAction("com.zhou.todolink.ALARM_" + slot);
        if (it != null) {
            intent.putExtra("title", it.title);
            intent.putExtra("body", it.body);
            intent.putExtra("tag", it.tag);
            // 带上计划时刻：到点后用它算「延迟多少毫秒」，也用来对账去重
            intent.putExtra("at", it.at);
        }
        int flags = PendingIntent.FLAG_IMMUTABLE | extraFlags;
        return PendingIntent.getBroadcast(ctx, slot, intent, flags);
    }

    // ------------------------------------------------------------ 权限 / 状态

    private static boolean exactAllowed(AlarmManager am) {
        if (Build.VERSION.SDK_INT < 31) return true;
        try {
            return am.canScheduleExactAlarms();
        } catch (Throwable e) {
            return false;
        }
    }

    /** App 现在能不能真正弹出通知（Android 13+ 的通知权限 + 系统总开关） */
    static boolean notificationsOn(Context ctx) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return false;
        try {
            if (Build.VERSION.SDK_INT >= 24 && !nm.areNotificationsEnabled()) return false;
        } catch (Throwable ignore) {
        }
        if (Build.VERSION.SDK_INT >= 33) {
            return ctx.checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED;
        }
        return true;
    }

    private static boolean channelOn(Context ctx, String id) {
        if (Build.VERSION.SDK_INT < 26) return true;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return false;
        try {
            NotificationChannel ch = nm.getNotificationChannel(id);
            return ch != null && ch.getImportance() != NotificationManager.IMPORTANCE_NONE;
        } catch (Throwable e) {
            return true;
        }
    }

    /** 一次性把体检结果交给 JS：设置页的「通知自检」直接展示这些字段 */
    static String state(Context ctx) {
        JSONObject o = new JSONObject();
        try {
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            List<Item> items = parse(sp(ctx).getString(K_PLAN, "[]"));
            SharedPreferences p = sp(ctx);
            o.put("ok", true);
            o.put("exact", am != null && exactAllowed(am));
            o.put("notify", notificationsOn(ctx));
            o.put("channel", channelOn(ctx, ALARM_CHANNEL_ID));
            o.put("plan", items.size());
            o.put("armed", Math.min(items.size(), MAX_ALARMS));
            long next = 0;
            long now = System.currentTimeMillis();
            for (Item it : items) {
                if (it.at > now) {
                    next = it.at;
                    break;
                }
            }
            o.put("next", next);
            o.put("lastAt", p.getLong(K_LAST_AT, 0));
            o.put("lastFire", p.getLong(K_LAST_FIRE, 0));
            o.put("lastDelay", p.getLong(K_LAST_DELAY, 0));
        } catch (Throwable ignore) {
        }
        return o.toString();
    }

    /** 跳「闹钟与提醒」特殊权限页（Android 12+ 才有） */
    static void openExactSettings(Context ctx) {
        if (Build.VERSION.SDK_INT < 31) return;
        try {
            Intent i = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:" + ctx.getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
        } catch (Throwable e) {
            openAppDetail(ctx);
        }
    }

    /** 跳本 App 的通知设置页（渠道被关 / 总开关被关时用） */
    static void openNotifySettings(Context ctx) {
        try {
            Intent i;
            if (Build.VERSION.SDK_INT >= 26) {
                i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                i.putExtra(Settings.EXTRA_APP_PACKAGE, ctx.getPackageName());
            } else {
                i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + ctx.getPackageName()));
            }
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
        } catch (Throwable e) {
            openAppDetail(ctx);
        }
    }

    private static void openAppDetail(Context ctx) {
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + ctx.getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
        } catch (Throwable ignore) {
        }
    }

    // ------------------------------------------------------------ 通知

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
        try {
            nm.notify(id, b.build());
        } catch (Throwable e) {
            // Android 13+ 没给通知权限、或渠道被系统判定非法时会抛 SecurityException。
            // 原来这里完全静默，出问题时既看不到现象也查不到原因，只能靠用户猜。
            Log.w("Reminders", "notify failed (id=" + id + ", alarm=" + alarm + "): " + e);
        }
    }

    // ------------------------------------------------------------ 计划读写

    private static final Comparator<Item> BY_AT = new Comparator<Item>() {
        @Override
        public int compare(Item a, Item b) {
            return a.at < b.at ? -1 : (a.at > b.at ? 1 : 0);
        }
    };

    private static List<Item> parse(String json) {
        List<Item> out = new ArrayList<>();
        long now = System.currentTimeMillis();
        HashSet<String> seen = new HashSet<>();
        List<Item> raw = new ArrayList<>();
        try {
            JSONArray arr = new JSONArray(json == null || json.isEmpty() ? "[]" : json);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                long at = o.optLong("at", 0);
                if (at <= 0) continue;
                if (at < now - KEEP_PAST) continue;   // 太旧的直接丢
                if (at > now + MAX_AHEAD) continue;   // 太远的下次再排
                Item it = new Item();
                it.at = at;
                String t = o.optString("title", "");
                it.title = t == null || t.isEmpty() ? "提醒" : t;
                it.body = o.optString("body", "");
                String tag = o.optString("tag", "");
                it.tag = tag == null || tag.isEmpty() ? "alarm" : tag;
                raw.add(it);
            }
        } catch (Throwable ignore) {
            return out;
        }
        Collections.sort(raw, BY_AT);
        // 同一个 tag 只保留「最新」的一条（at 最大的那条）：改时间后旧的必须作废。
        // 原来是从小到大取第一条，实际保留的是旧时间、丢掉新时间，和注释的意图正好相反 ——
        // 表现就是「把提醒改到明天，第二天却没响」。
        for (int i = raw.size() - 1; i >= 0; i--) {
            Item it = raw.get(i);
            if (!seen.add(it.tag)) continue;
            out.add(it);
        }
        Collections.sort(out, BY_AT);
        if (out.size() > MAX_PLAN) out = new ArrayList<>(out.subList(0, MAX_PLAN));
        return out;
    }

    private static String toJson(List<Item> items) {
        JSONArray a = new JSONArray();
        for (Item it : items) {
            JSONObject o = new JSONObject();
            try {
                o.put("at", it.at);
                o.put("title", it.title);
                o.put("body", it.body);
                o.put("tag", it.tag);
            } catch (Throwable ignore) {
                continue;
            }
            a.put(o);
        }
        return a.toString();
    }

    /** 摘掉一条：优先按 tag+at 精确匹配；给了 at 但没匹配上时，退回按 tag 摘最早的一条 */
    private static List<Item> drop(List<Item> items, String tag, long at) {
        String t = tag == null ? "" : tag;
        int hit = -1;
        for (int i = 0; i < items.size(); i++) {
            Item it = items.get(i);
            if (t.equals(it.tag) && it.at == at) {
                hit = i;
                break;
            }
        }
        if (hit < 0) {
            // 精确匹配不上时，只允许摘「不比这次触发更晚」的同 tag 条目。
            // 用户刚把提醒改到更晚后，旧闹钟的广播可能还在路上：这时 at 是旧值、
            // 计划里是新值。无脑按 tag 摘会把刚改好的新提醒删掉 ——
            // 表现同样是「改完时间就再也不响」。
            for (int i = 0; i < items.size(); i++) {
                Item it = items.get(i);
                if (t.equals(it.tag) && it.at <= at) hit = i;
            }
        }
        List<Item> out = new ArrayList<>(items.size());
        for (int i = 0; i < items.size(); i++) {
            if (i != hit) out.add(items.get(i));
        }
        return out;
    }

    private static void addEvent(Context ctx, String tag, long at, long fireAt, boolean late) {
        SharedPreferences p = sp(ctx);
        try {
            JSONArray arr = new JSONArray(p.getString(K_EVENT, "[]"));
            JSONObject o = new JSONObject();
            o.put("tag", tag == null ? "" : tag);
            o.put("at", at);
            o.put("ts", fireAt);
            o.put("late", late);       // true = 错过了（没真的响过），由 JS 决定是否补发
            arr.put(o);
            while (arr.length() > MAX_EVENT) {
                JSONArray next = new JSONArray();
                for (int i = 1; i < arr.length(); i++) next.put(arr.opt(i));
                arr = next;
            }
            p.edit().putString(K_EVENT, arr.toString()).commit();
        } catch (Throwable ignore) {
        }
    }
}
