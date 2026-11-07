package com.zhou.todolink;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 单 Activity + WebView 外壳。
 *
 * 页面与数据都在 assets/www 里，通过本机回环的 AssetServer 提供，
 * 这样 origin 是 http://127.0.0.1:<port>（安全上下文），相机、IndexedDB、fetch 全部可用。
 *
 * 原生桥只暴露「WebView 自己做不到」的少数能力：出站 HTTP（绕开 CORS）、
 * 系统通知、剪贴板、打开外部浏览器。
 */
public class MainActivity extends Activity {

    private static final int REQ_CAMERA = 1001;
    private static final int REQ_NOTIFY = 1002;
    private static final String CHANNEL_ID = "xhub_reminder";

    private static final String PREFS = "xhub";
    private static final String KEY_ORIGIN_PORT = "origin_port";

    private WebView webView;
    private AssetServer server;
    private Bridge bridge;
    private PermissionRequest pendingPermission;
    /** 本次启动的本地端口与上次不同 = 数据分区变了，旧本地数据不会自动出现 */
    private boolean originSwitched = false;
    private int originPort = 0;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        try {
            server = new AssetServer(getAssets());
            server.start();
        } catch (Exception e) {
            Toast.makeText(this, "本地资源服务启动失败：" + e.getMessage(), Toast.LENGTH_LONG).show();
            finish();
            return;
        }

        // 端口 = 页面 origin 的一部分；端口变了，IndexedDB 就指向另一个空分区
        originPort = server.port();
        SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
        int prevPort = sp.getInt(KEY_ORIGIN_PORT, -1);
        originSwitched = prevPort > 0 && prevPort != originPort;
        if (prevPort != originPort) {
            sp.edit().putInt(KEY_ORIGIN_PORT, originPort).apply();
        }

        webView = new WebView(this);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }

        webView.setBackgroundColor(0xFF12131B);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        bridge = new Bridge(this, webView, originPort, originSwitched);
        webView.addJavascriptInterface(bridge, "Android");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // 页面里只有本机资源，出现外部跳转一律拦下（不做出站浏览；外链走 openUrl）
                String url = request.getUrl().toString();
                return !url.startsWith("http://127.0.0.1:");
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    boolean wantsVideo = false;
                    for (String r : request.getResources()) {
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) wantsVideo = true;
                    }
                    if (!wantsVideo) {
                        request.deny();
                        return;
                    }
                    if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                    } else {
                        pendingPermission = request;
                        requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA);
                    }
                });
            }
        });

        setContentView(webView);
        webView.loadUrl(server.baseUrl() + "index.html");

        ensureNotificationChannel();
        requestNotifyPermissionIfNeeded();
    }

    /** 通知渠道：Android 8+ 必须先建渠道，否则通知会被静默丢弃 */
    private void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "待办提醒", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("待办临期与番茄钟提醒");
        ch.enableVibration(true);
        nm.createNotificationChannel(ch);
    }

    /** Android 13+ 通知需要运行时权限（用字面量，compileSdk 32 没有该常量） */
    private void requestNotifyPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED) return;
        requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, REQ_NOTIFY);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_CAMERA && pendingPermission != null) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                pendingPermission.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
            } else {
                pendingPermission.deny();
                Toast.makeText(this, "没有相机权限，请手动输入地址配对", Toast.LENGTH_SHORT).show();
            }
            pendingPermission = null;
        }
    }

    @Override
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        // 先让页面处理（关面板 / 回待办页），它返回 false 才退出
        webView.evaluateJavascript(
                "(function(){try{return window.__handleBack?window.__handleBack():false}catch(e){return false}})()",
                value -> {
                    if (!"true".equals(value)) {
                        finish();
                    }
                });
    }

    @Override
    protected void onDestroy() {
        if (bridge != null) bridge.shutdown();
        if (server != null) server.stop();
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    /** 暴露给页面的少量原生能力，保持最小面 */
    static final class Bridge {
        private final Context ctx;
        private final WebView webView;
        private final int originPort;
        private final boolean originSwitched;
        private final ExecutorService pool = Executors.newCachedThreadPool();
        private final Map<String, HttpURLConnection> live = new ConcurrentHashMap<>();

        Bridge(Context ctx, WebView webView, int originPort, boolean originSwitched) {
            this.ctx = ctx;
            this.webView = webView;
            this.originPort = originPort;
            this.originSwitched = originSwitched;
        }

        /** 本次启动的本地端口（页面 origin 的一部分） */
        @JavascriptInterface
        public int originPort() {
            return originPort;
        }

        /**
         * 端口与上次不同 → 页面已经在一个新的空存储分区里。
         * 页面据此提示用户「旧本地数据不会自动出现」，而不是让它静默丢失。
         */
        @JavascriptInterface
        public boolean originChanged() {
            return originSwitched;
        }

        void shutdown() {
            for (HttpURLConnection c : live.values()) {
                try {
                    c.disconnect();
                } catch (Throwable ignore) {
                }
            }
            live.clear();
            pool.shutdownNow();
        }

        /**
         * 回调页面。收敛成「单入口 + 一个 JSON 字符串」：
         * 所有参数先序列化成 JSON，再由 JSONObject.quote 包成 JS 字面量，
         * 页面侧统一 JSON.parse 后分发。
         * 不再把多段用户数据直接拼进 JS 源码——那是最容易被构造出越界语法的写法。
         */
        private void emit(String fn, JSONObject payload) {
            final String json = payload == null ? "{}" : payload.toString();
            final String js = "try{window.__nativeEmit(" + q(fn) + "," + q(json) + ")}catch(e){}";
            webView.post(() -> {
                try {
                    webView.evaluateJavascript(js, null);
                } catch (Throwable ignore) {
                }
            });
        }

        private static String q(String s) {
            if (s == null) return "null";
            try {
                return JSONObject.quote(s);
            } catch (Throwable e) {
                return "\"\"";
            }
        }

        /**
         * 回调载荷：一次构造完，内部吞掉 JSONException（受检异常不方便在调用点逐处处理）。
         * 用法：payload(reqId, "code", 500, "body", text)
         */
        private static JSONObject payload(String id, Object... kv) {
            JSONObject o = new JSONObject();
            try {
                o.put("id", id == null ? "" : id);
                for (int i = 0; i + 1 < kv.length; i += 2) {
                    o.put(String.valueOf(kv[i]), kv[i + 1]);
                }
            } catch (Throwable ignore) {
            }
            return o;
        }

        private static String readAll(InputStream is) {
            if (is == null) return "";
            try {
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                byte[] buf = new byte[2048];
                int n;
                while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
                return new String(bos.toByteArray(), "UTF-8");
            } catch (Throwable e) {
                return "";
            }
        }

        /**
         * 出站 HTTP（流式）。
         *
         * 为什么不用页面里的 fetch：供应商 API 基本不给浏览器放开 CORS，
         * WebView 从 http://127.0.0.1 发出去会被预检拦掉。原生请求没有这个限制，
         * 也让「AI 脱离电脑」成为可能。
         *
         * 读到多少块就回调多少块：window.__httpChunk(reqId, text)，
         * 结束 window.__httpDone(reqId)，出错 window.__httpError(reqId, code, body)。
         */
        @JavascriptInterface
        public void httpStream(final String reqId, final String method, final String url,
                               final String headersJson, final String body) {
            pool.execute(() -> {
                HttpURLConnection c = null;
                try {
                    c = (HttpURLConnection) new URL(url).openConnection();
                    c.setRequestMethod(method == null || method.isEmpty() ? "POST" : method);
                    c.setConnectTimeout(20000);
                    c.setReadTimeout(180000);
                    c.setRequestProperty("Accept", "text/event-stream, application/json");

                    if (headersJson != null && !headersJson.isEmpty()) {
                        JSONObject h = new JSONObject(headersJson);
                        for (Iterator<String> it = h.keys(); it.hasNext(); ) {
                            String k = it.next();
                            c.setRequestProperty(k, h.getString(k));
                        }
                    }
                    if (body != null && !body.isEmpty()) {
                        c.setDoOutput(true);
                        c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                        c.getOutputStream().write(body.getBytes("UTF-8"));
                    }

                    live.put(reqId, c);
                    int code = c.getResponseCode();
                    if (code >= 400) {
                        String text = readAll(c.getErrorStream());
                        emit("error", payload(reqId, "code", code, "body", text));
                        return;
                    }

                    InputStream is = c.getInputStream();
                    if (is == null) {
                        emit("error", payload(reqId, "code", code, "body", "空响应"));
                        return;
                    }
                    BufferedReader r = new BufferedReader(new InputStreamReader(is, "UTF-8"));
                    char[] buf = new char[1200];
                    int n;
                    while ((n = r.read(buf)) > 0) {
                        emit("chunk", payload(reqId, "text", new String(buf, 0, n)));
                    }
                    emit("done", payload(reqId));
                } catch (Throwable e) {
                    String msg = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
                    emit("error", payload(reqId, "code", 0, "body", msg));
                } finally {
                    live.remove(reqId);
                    if (c != null) {
                        try {
                            c.disconnect();
                        } catch (Throwable ignore) {
                        }
                    }
                }
            });
        }

        /** 中止某个在途请求（关闭连接，读循环会抛异常退出） */
        @JavascriptInterface
        public void httpAbort(String reqId) {
            HttpURLConnection c = live.remove(reqId);
            if (c != null) {
                try {
                    c.disconnect();
                } catch (Throwable ignore) {
                }
            }
        }

        /** 系统通知：待办临期、番茄钟结束 */
        @JavascriptInterface
        public void notify(final String title, final String body) {
            ((Activity) ctx).runOnUiThread(() -> {
                try {
                    NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
                    if (nm == null) return;

                    Intent open = new Intent(ctx, MainActivity.class);
                    open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                    int flags = PendingIntent.FLAG_UPDATE_CURRENT;
                    if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
                    PendingIntent pi = PendingIntent.getActivity(ctx, 0, open, flags);

                    Notification.Builder b;
                    if (Build.VERSION.SDK_INT >= 26) {
                        b = new Notification.Builder(ctx, CHANNEL_ID);
                    } else {
                        b = new Notification.Builder(ctx);
                    }
                    b.setSmallIcon(R.mipmap.ic_launcher)
                            .setContentTitle(title == null ? "提醒" : title)
                            .setContentText(body == null ? "" : body)
                            .setStyle(new Notification.BigTextStyle().bigText(body == null ? "" : body))
                            .setAutoCancel(true)
                            .setContentIntent(pi);

                    if (Build.VERSION.SDK_INT >= 26) {
                        b.setChannelId(CHANNEL_ID);
                    } else {
                        b.setPriority(Notification.PRIORITY_HIGH);
                    }
                    nm.notify((int) (System.currentTimeMillis() & 0x7fffffff), b.build());
                } catch (Throwable e) {
                    Toast.makeText(ctx, "通知发送失败：" + e.getMessage(), Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public String readClipboard() {
            try {
                ClipboardManager cm = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm == null || !cm.hasPrimaryClip()) return "";
                ClipData clip = cm.getPrimaryClip();
                if (clip == null || clip.getItemCount() == 0) return "";
                CharSequence t = clip.getItemAt(0).coerceToText(ctx);
                return t == null ? "" : t.toString();
            } catch (Throwable e) {
                return "";
            }
        }

        @JavascriptInterface
        public void writeClipboard(String text) {
            try {
                ClipboardManager cm = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm == null) return;
                cm.setPrimaryClip(ClipData.newPlainText("x-hub", text == null ? "" : text));
            } catch (Throwable ignore) {
            }
        }

        @JavascriptInterface
        public String deviceName() {
            String model = Build.MODEL == null ? "Android" : Build.MODEL.trim();
            String brand = Build.BRAND == null ? "" : Build.BRAND.trim();
            if (brand.length() > 0 && !model.toLowerCase().startsWith(brand.toLowerCase())) {
                model = brand + " " + model;
            }
            return model;
        }

        @JavascriptInterface
        public String appVersion() {
            // 读真实包信息，不再硬编码：以前写死 "2.7.0"，APK 升到 2.9.0 后仍然上报 2.7.0
            try {
                return ctx.getPackageManager()
                        .getPackageInfo(ctx.getPackageName(), 0).versionName;
            } catch (Throwable e) {
                return "";
            }
        }

        @JavascriptInterface
        public void toast(String msg) {
            if (msg == null) return;
            ((Activity) ctx).runOnUiThread(() -> Toast.makeText(ctx, msg, Toast.LENGTH_SHORT).show());
        }

        @JavascriptInterface
        public void vibrate(int ms) {
            Vibrator v = (Vibrator) ctx.getSystemService(Context.VIBRATOR_SERVICE);
            if (v == null || !v.hasVibrator()) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                v.vibrate(VibrationEffect.createOneShot(Math.max(10, ms), VibrationEffect.DEFAULT_AMPLITUDE));
            } else {
                v.vibrate(Math.max(10, ms));
            }
        }

        /**
         * 用系统浏览器打开外链。
         *
         * WebView 里 window.open / target=_blank 都出不去（只允许本机资源），
         * 而「获取 API Key」这类指引页必须交给系统浏览器 —— 与桌面端 openExternal 同义。
         */
        @JavascriptInterface
        public void openUrl(final String url) {
            if (url == null || url.isEmpty()) return;
            ((Activity) ctx).runOnUiThread(() -> {
                try {
                    Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    ctx.startActivity(i);
                } catch (Throwable e) {
                    Toast.makeText(ctx, "无法打开浏览器，请手动复制链接", Toast.LENGTH_SHORT).show();
                }
            });
        }
    }
}
