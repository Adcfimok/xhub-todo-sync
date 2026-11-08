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
import android.database.Cursor;
import android.provider.OpenableColumns;
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
    private static final int REQ_PICK_FILE = 1003;
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
    /** 文件选择是异步的：拿到结果时要知道回给页面哪一次请求 */
    String pickReqId = null;

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

    /** 通知渠道：Android 8+ 必须先建渠道，否则通知会被静默丢弃（两个渠道见 Reminders） */
    private void ensureNotificationChannel() {
        Reminders.ensureChannels(this);
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
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_PICK_FILE) return;
        final String reqId = pickReqId;
        pickReqId = null;
        JSONObject o = new JSONObject();
        try {
            o.put("id", reqId == null ? "" : reqId);
            if (resultCode != RESULT_OK || data == null || data.getData() == null) {
                o.put("ok", false);
                o.put("error", "已取消");
            } else {
                Uri uri = data.getData();
                try {
                    getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                } catch (Throwable ignore) {
                    /* 部分来源不支持长期授权，本次仍可读 */
                }
                String name = null;
                long size = 0;
                Cursor c = null;
                try {
                    c = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null);
                    if (c != null && c.moveToFirst()) {
                        int ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                        int si = c.getColumnIndex(OpenableColumns.SIZE);
                        if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni);
                        if (si >= 0 && !c.isNull(si)) size = c.getLong(si);
                    }
                } finally {
                    if (c != null) c.close();
                }
                if (size <= 0) {
                    android.content.res.AssetFileDescriptor fd = null;
                    try {
                        fd = getContentResolver().openAssetFileDescriptor(uri, "r");
                        if (fd != null) size = fd.getLength();
                    } catch (Throwable ignore) {
                    } finally {
                        if (fd != null) {
                            try {
                                fd.close();
                            } catch (Throwable ignore) {
                            }
                        }
                    }
                }
                if (name == null || name.isEmpty()) name = "未命名文件";
                o.put("ok", true);
                o.put("uri", uri.toString());
                o.put("name", name);
                o.put("size", size);
                o.put("mime", String.valueOf(getContentResolver().getType(uri)));
            }
        } catch (Throwable e) {
            try {
                o.put("ok", false);
                o.put("error", "读取文件信息失败：" + e.getMessage());
            } catch (Throwable ignore) {
            }
        }
        bridge.emit("pick", o);
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
        void emit(String fn, JSONObject payload) {
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
                    Reminders.notify(ctx, title, body, "notify-" + (System.currentTimeMillis() & 0xffff), false);
                } catch (Throwable e) {
                    Toast.makeText(ctx, "通知发送失败：" + e.getMessage(), Toast.LENGTH_SHORT).show();
                }
            });
        }

        /** 把最近几条提醒交给系统闹钟：息屏 / 后台也能响 */
        @JavascriptInterface
        public void setAlarms(final String json) {
            try {
                Reminders.schedule(ctx, json);
            } catch (Throwable ignore) {
                // 调度失败不致命，前台提醒仍然有效
            }
        }

        @JavascriptInterface
        public void cancelAlarms() {
            try {
                Reminders.cancel(ctx);
            } catch (Throwable ignore) {
            }
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
        /** 打开系统文件选择器（SAF）。不申请存储权限，只拿用户点选的那一个文件 */
        @JavascriptInterface
        public void pickFile(final String reqId) {
            final MainActivity act = (MainActivity) ctx;
            act.runOnUiThread(() -> {
                try {
                    act.pickReqId = reqId;
                    Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("*/*");
                    i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false);
                    act.startActivityForResult(i, REQ_PICK_FILE);
                } catch (Throwable e) {
                    emit("pick", payload(reqId, "ok", false, "error", "打不开文件选择器：" + e.getMessage()));
                }
            });
        }

        /** 手机 → 电脑：分块加密上传，进度通过 transfer 事件回传 */
        @JavascriptInterface
        public void startUpload(final String reqId, final String uri, final String name, final long size,
                                final String mime, final String host, final String token,
                                final String resumeId, final String sha) {
            FileTransfer.startUpload(ctx, reqId, Uri.parse(uri), name, size, mime, host, token, resumeId, sha,
                    o -> emit("transfer", o));
        }

        /** 电脑 → 手机：按块拉取并解密落盘 */
        @JavascriptInterface
        public void startDownload(final String reqId, final String fileId, final String name, final long size,
                                  final String sha, final String host, final String token) {
            FileTransfer.startDownload(ctx, reqId, fileId, name, size, sha, host, token,
                    o -> emit("transfer", o));
        }

        @JavascriptInterface
        public void cancelTransfer(final String reqId) {
            FileTransfer.cancel(reqId);
        }

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

        /** 后台保活：启动前台服务，保证后台能收通知与同步 */
        @JavascriptInterface
        public void startKeepAlive() {
            try {
                KeepAliveService.start(ctx);
            } catch (Throwable ignore) {
            }
        }

        @JavascriptInterface
        public void stopKeepAlive() {
            try {
                KeepAliveService.stop(ctx);
            } catch (Throwable ignore) {
            }
        }

        /** 桌面小组件：把待办摘要与今日课表写进 SharedPreferences 并刷新 */
        @JavascriptInterface
        public void setWidgetData(final String todo, final String timetable) {
            try {
                android.content.SharedPreferences sp = ctx.getSharedPreferences("xhub_widget", android.content.Context.MODE_PRIVATE);
                sp.edit().putString("todo", todo == null ? "" : todo).putString("timetable", timetable == null ? "" : timetable).apply();
                WidgetProvider.updateAll(ctx);
            } catch (Throwable ignore) {
            }
        }
    }
}
