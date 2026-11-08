package com.zhou.todolink;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 手机端「速达 → 手机应用」的原生能力：
 *   1. 枚举本机有启动入口的已安装应用（Android 11+ 需在 Manifest 里声明 queries）；
 *   2. 把**系统真实图标**导出成 PNG 缓存到应用私有目录，由 AssetServer 以 /__appicon/ 提供；
 *   3. 按包名拉起对应的应用。
 *
 * 这里刻意不把图标做成 base64 塞进 JS 桥返回值：几百个应用会把 @JavascriptInterface
 * 的返回字符串撑到 Binder 上限，而且每次渲染都要重复传输。改成「原生写文件 + 本地 HTTP 取图」，
 * WebView 用同源 <img> 加载，天然带缓存，也不会把用户安装列表泄露到任何网络请求里。
 */
final class AppCatalog {

    private static final String ICON_DIR = "appicons";
    private static final int ICON_SIZE = 96;

    private AppCatalog() {}

    static File iconDir(Context ctx) {
        return new File(ctx.getCacheDir(), ICON_DIR);
    }

    /**
     * 已安装且有 LAUNCHER 入口的应用列表。
     * 返回 [{pkg, label, icon}]，icon 是同源相对路径 /__appicon/&lt;hash&gt;.png。
     * 顺带把每个应用的图标 PNG 生成好（已存在则跳过），前端拿到 URL 即可直接显示。
     */
    static String installedAppsJson(Context ctx) {
        JSONArray out = new JSONArray();
        try {
            PackageManager pm = ctx.getPackageManager();
            Intent main = new Intent(Intent.ACTION_MAIN, null);
            main.addCategory(Intent.CATEGORY_LAUNCHER);
            List<ResolveInfo> ris = pm.queryIntentActivities(main, 0);

            // 同一个包可能有多个 launcher Activity，按包名去重
            Map<String, String> found = new LinkedHashMap<>();
            for (ResolveInfo ri : ris) {
                if (ri == null || ri.activityInfo == null) continue;
                String pkg = ri.activityInfo.packageName;
                if (pkg == null || pkg.isEmpty() || pkg.equals(ctx.getPackageName())) continue;
                if (found.containsKey(pkg)) continue;
                CharSequence label = ri.loadLabel(pm);
                String name = label == null || label.length() == 0 ? pkg : label.toString();
                found.put(pkg, name);
            }

            List<Map.Entry<String, String>> entries = new ArrayList<>(found.entrySet());
            Collections.sort(entries, new Comparator<Map.Entry<String, String>>() {
                @Override
                public int compare(Map.Entry<String, String> a, Map.Entry<String, String> b) {
                    return a.getValue().compareToIgnoreCase(b.getValue());
                }
            });

            File dir = iconDir(ctx);
            if (!dir.exists()) dir.mkdirs();
            for (Map.Entry<String, String> e : entries) {
                String pkg = e.getKey();
                String file = iconFileName(pkg);
                ensureIcon(pm, pkg, new File(dir, file));
                JSONObject o = new JSONObject();
                o.put("pkg", pkg);
                o.put("label", e.getValue());
                o.put("icon", "/__appicon/" + file);
                out.put(o);
            }
        } catch (Throwable ignore) {
            // 读不到就返回已收集到的部分，不让页面崩
        }
        return out.toString();
    }

    /** 给单个包名补一次图标文件，返回 URL；已添加的应用在图标缓存被清理后靠它自愈 */
    static String ensureIconUrl(Context ctx, String pkg) {
        if (pkg == null || pkg.isEmpty()) return "";
        try {
            File dir = iconDir(ctx);
            if (!dir.exists()) dir.mkdirs();
            String file = iconFileName(pkg);
            ensureIcon(ctx.getPackageManager(), pkg, new File(dir, file));
            return "/__appicon/" + file;
        } catch (Throwable e) {
            return "";
        }
    }

    /** 由 AssetServer 调：严格校验文件名，只从私有缓存目录读，杜绝目录穿越 */
    static byte[] readIcon(File dir, String name) {
        if (name == null || !name.matches("[a-f0-9]{16}\\.png")) return null;
        File f = new File(dir, name);
        if (!f.isFile() || f.length() <= 0 || f.length() > 512 * 1024) return null;
        InputStream in = null;
        try {
            java.io.FileInputStream fis = new java.io.FileInputStream(f);
            in = fis;
            ByteArrayOutputStream bos = new ByteArrayOutputStream((int) f.length());
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return bos.toByteArray();
        } catch (Throwable e) {
            return null;
        } finally {
            if (in != null) {
                try { in.close(); } catch (Throwable ignore) {}
            }
        }
    }

    static boolean launch(Context ctx, String pkg) {
        if (pkg == null || pkg.isEmpty()) return false;
        try {
            Intent i = ctx.getPackageManager().getLaunchIntentForPackage(pkg);
            if (i == null) return false;
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            return true;
        } catch (Throwable e) {
            return false;
        }
    }

    /** 包名做 MD5 前 8 字节当文件名：纯 hex，天然避免特殊字符与路径穿越 */
    private static String iconFileName(String pkg) {
        try {
            MessageDigest md = MessageDigest.getInstance("MD5");
            byte[] b = md.digest(pkg.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 8; i++) sb.append(String.format("%02x", b[i] & 0xff));
            return sb + ".png";
        } catch (Throwable e) {
            return String.format("%016x", (long) pkg.hashCode()) + ".png";
        }
    }

    /**
     * Drawable → 96×96 ARGB_8888 Bitmap → PNG。
     * AdaptiveIconDrawable（Android 8+）在 setBounds + draw(Canvas) 下也能正确合成，
     * 所以自适应图标同样能拿到与桌面一致的真实外观，而不是统一占位图。
     */
    private static void ensureIcon(PackageManager pm, String pkg, File target) {
        if (target.exists() && target.length() > 0) return;
        Bitmap bm = null;
        FileOutputStream fos = null;
        try {
            Drawable d = pm.getApplicationIcon(pkg);
            if (d == null) return;
            bm = Bitmap.createBitmap(ICON_SIZE, ICON_SIZE, Bitmap.Config.ARGB_8888);
            Canvas c = new Canvas(bm);
            d.setBounds(0, 0, ICON_SIZE, ICON_SIZE);
            d.draw(c);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            bm.compress(Bitmap.CompressFormat.PNG, 100, bos);
            fos = new FileOutputStream(target);
            fos.write(bos.toByteArray());
        } catch (Throwable ignore) {
            // 个别应用取不到图标：前端会用 appIconFor 再试一次，仍失败才显示文字兜底
        } finally {
            if (fos != null) {
                try { fos.close(); } catch (Throwable ignore) {}
            }
            if (bm != null) bm.recycle();
        }
    }
}
