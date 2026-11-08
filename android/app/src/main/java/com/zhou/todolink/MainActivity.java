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
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;
import org.json.JSONTokener;

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

    /** 教务导入：在同一个 Activity 里叠一层独立 WebView，登录态与外部站点完全隔离于主页面 */
    FrameLayout rootLayout;
    LinearLayout eduOverlay;
    WebView eduView;
    TextView eduAddr;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        try {
            server = new AssetServer(getAssets(), AppCatalog.iconDir(this), PdfIngest.pageDir(this));
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

        // 根布局用 FrameLayout：教务导入时可以在上面叠一层独立 WebView，
        // 不需要新建 Activity，也不用把抓取到的页面源码跨 Activity 传回来。
        rootLayout = new FrameLayout(this);
        rootLayout.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(rootLayout);
        webView.loadUrl(server.baseUrl() + "index.html");

        ensureNotificationChannel();
        requestNotifyPermissionIfNeeded();
    }

    /** 教务网址补全协议；用户显式写了 http:// 时按用户的来（不少学校教务只开 http） */
    private static String normalizeEduUrl(String raw) {
        String u = raw == null ? "" : raw.trim();
        if (u.isEmpty()) return "";
        if (!u.contains("://")) u = "https://" + u;
        return u;
    }

    /**
     * 教务系统一键导入（流程参考 WakeUp 课程表）：
     * 叠一层独立浏览器 → 用户在教务页自己登录 → 点到课表界面 → 点「导入当前页」。
     * 这层 WebView 只用来浏览，账号密码不经过 Java、不写入本 App 的任何存储。
     */
    @SuppressLint("SetJavaScriptEnabled")
    void openEduImport(String url) {
        final String target = normalizeEduUrl(url);
        if (target.isEmpty()) return;
        if (eduOverlay != null) {
            eduView.loadUrl(target);
            return;
        }
        LinearLayout overlay = new LinearLayout(this);
        overlay.setOrientation(LinearLayout.VERTICAL);
        overlay.setBackgroundColor(0xFF12131B);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(12, 10, 12, 10);
        bar.setBackgroundColor(0xFF1C1D28);
        eduAddr = new TextView(this);
        eduAddr.setTextColor(0xFFA3A9B8);
        eduAddr.setTextSize(12);
        eduAddr.setSingleLine(true);
        eduAddr.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
        eduAddr.setText(target);
        bar.addView(eduAddr, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        Button back = smallButton("‹", v -> {
            if (eduView != null && eduView.canGoBack()) eduView.goBack();
        });
        Button capture = smallButton("导入当前页", v -> captureEduPage());
        Button close = smallButton("×", v -> closeEduImport());
        bar.addView(back);
        bar.addView(capture);
        bar.addView(close);
        overlay.addView(bar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        eduView = new WebView(this);
        WebSettings es = eduView.getSettings();
        es.setJavaScriptEnabled(true);
        es.setDomStorageEnabled(true);
        es.setDatabaseEnabled(true);
        es.setAllowFileAccess(false);
        es.setAllowContentAccess(false);
        es.setUseWideViewPort(true);
        es.setLoadWithOverviewMode(true);
        es.setSupportZoom(true);
        es.setBuiltInZoomControls(true);
        es.setDisplayZoomControls(false);
        // 老教务常是 http 页面里嵌 http 资源；只允许它，不抬高主页面的混合内容策略
        es.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            cm.setAcceptThirdPartyCookies(eduView, true);
        }
        eduView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView v, String u) {
                if (eduAddr != null) eduAddr.setText(u);
            }
        });
        eduView.setWebChromeClient(new WebChromeClient());
        overlay.addView(eduView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        eduOverlay = overlay;
        rootLayout.addView(eduOverlay, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        eduView.loadUrl(target);
    }

    private Button smallButton(String text, View.OnClickListener fn) {
        Button b = new Button(this);
        b.setText(text);
        b.setTextSize(12);
        b.setAllCaps(false);
        b.setTextColor(0xFFECEEF4);
        b.setPadding(10, 4, 10, 4);
        b.setOnClickListener(fn);
        return b;
    }

    /** 抓当前页 HTML（连同同域 iframe），去掉密码框的值，分块回传给主页面解析 */
    void captureEduPage() {
        if (eduView == null) return;
        final String js = "(function(){"
                + "function grab(d){try{"
                + "var ps=d.querySelectorAll('input[type=password]');"
                + "for(var i=0;i<ps.length;i++){ps[i].setAttribute('value','');}"
                + "return d.documentElement?d.documentElement.outerHTML:'';}catch(e){return ''}}"
                + "var h=grab(document);"
                + "var fs=document.querySelectorAll('iframe,frame');"
                + "for(var j=0;j<fs.length;j++){try{var d=fs[j].contentDocument;"
                + "if(d&&d.body){h+='\\n<!--FRAME-->'+grab(d);}}catch(e){}}"
                + "return JSON.stringify({url:location.href,title:document.title,"
                + "html:h.substring(0,600000)});"
                + "})()";
        try {
            eduView.evaluateJavascript(js, value -> {
                try {
                    Object v = value == null ? null : new JSONTokener(value).nextValue();
                    if (!(v instanceof String)) {
                        bridge.emitEduError("没有读到页面内容");
                        return;
                    }
                    JSONObject o = new JSONObject((String) v);
                    bridge.emitEdu(o.optString("url", ""), o.optString("title", ""), o.optString("html", ""));
                } catch (Throwable e) {
                    bridge.emitEduError("页面解析失败：" + e.getMessage());
                }
            });
        } catch (Throwable e) {
            bridge.emitEduError("无法读取当前页：" + e.getMessage());
        }
    }

    void closeEduImport() {
        if (eduOverlay == null) return;
        // 用户点「×」或返回键退出时，通知前端取消等待，别留一个悬挂的 Promise
        if (bridge != null) bridge.emitEduError("已取消");
        rootLayout.removeView(eduOverlay);
        if (eduView != null) {
            try {
                eduView.loadUrl("about:blank");
                eduView.destroy();
            } catch (Throwable ignore) {
            }
        }
        eduView = null;
        eduAddr = null;
        eduOverlay = null;
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
        // 教务浏览器在最上层：返回键先回退网页，退到头了再关掉这层，不退出 App
        if (eduOverlay != null) {
            if (eduView != null && eduView.canGoBack()) eduView.goBack();
            else closeEduImport();
            return;
        }
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
        closeEduImport();
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
            openPicker(reqId, "*/*");
        }

        /** 同上，但按 MIME 过滤：课表 PDF 只列 PDF，避免用户在相册里翻半天 */
        @JavascriptInterface
        public void pickFileTyped(final String reqId, final String mime) {
            openPicker(reqId, mime == null || mime.trim().isEmpty() ? "*/*" : mime.trim());
        }

        private void openPicker(final String reqId, final String mime) {
            final MainActivity act = (MainActivity) ctx;
            act.runOnUiThread(() -> {
                try {
                    act.pickReqId = reqId;
                    Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType(mime);
                    i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false);
                    act.startActivityForResult(i, REQ_PICK_FILE);
                } catch (Throwable e) {
                    emit("pick", payload(reqId, "ok", false, "error", "打不开文件选择器：" + e.getMessage()));
                }
            });
        }

        // ---------------------------------------------------------- 课表 PDF（本地预处理）

        /** PDF 元信息：页数、是否可渲染、是否加密。不联网、不解析课程 */
        @JavascriptInterface
        public String pdfInfo(String uri) {
            return PdfIngest.infoJson(ctx, uri);
        }

        /** PDF 文本层抽取（尽力而为）；页面按 quality 决定用文本还是走视觉 */
        @JavascriptInterface
        public String pdfText(String uri) {
            return PdfIngest.textJson(ctx, uri);
        }

        /** 渲染某一页为 JPEG，返回 /__pdfpage/<hash>_p<n>.jpg 同源地址 */
        @JavascriptInterface
        public String pdfRender(String uri, int page, double scale) {
            return PdfIngest.renderJson(ctx, uri, page, scale);
        }

        /** 导入结束/取消时清缓存，避免长期占空间 */
        @JavascriptInterface
        public void pdfClear() {
            PdfIngest.clear(ctx);
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

        // ------------------------------------------------------------ 教务系统一键导入

        /** 抓取结果分块回传：课表页 HTML 可能几百 KB，一次塞进 evaluateJavascript 不稳妥 */
        void emitEdu(String url, String title, String html) {
            final String body = html == null ? "" : html;
            final int CH = 24000;
            int n = (body.length() + CH - 1) / CH;
            if (n == 0) n = 1;
            for (int i = 0; i < n; i++) {
                int from = i * CH;
                int to = Math.min(body.length(), from + CH);
                String part = from < body.length() ? body.substring(from, to) : "";
                emit("edu", payload("", "i", i, "n", n, "text", part,
                        "url", url == null ? "" : url, "title", title == null ? "" : title));
            }
        }

        void emitEduError(String msg) {
            emit("edu", payload("", "i", 0, "n", 1, "text", "", "error", msg == null ? "导入失败" : msg));
        }

        /** 打开内置教务浏览器（独立 WebView，登录态与主页面隔离） */
        @JavascriptInterface
        public void openEduImport(String url) {
            ((Activity) ctx).runOnUiThread(() -> ((MainActivity) ctx).openEduImport(url));
        }

        @JavascriptInterface
        public void closeEduImport() {
            ((Activity) ctx).runOnUiThread(() -> ((MainActivity) ctx).closeEduImport());
        }

        @JavascriptInterface
        public void eduGoBack() {
            ((Activity) ctx).runOnUiThread(() -> {
                WebView v = ((MainActivity) ctx).eduView;
                if (v != null && v.canGoBack()) v.goBack();
            });
        }

        // ------------------------------------------------------------ 速达 · 手机应用（与 PC 端完全独立）

        /** 返回本机已安装应用的 [{pkg,label,icon}] JSON；图标是系统真实图标缓存后的同源 URL */
        @JavascriptInterface
        public String installedApps() {
            try {
                return AppCatalog.installedAppsJson(ctx);
            } catch (Throwable e) {
                return "[]";
            }
        }

        /** 兜底：图标缓存被清理时按包名重新导出一次，返回 URL */
        @JavascriptInterface
        public String appIconFor(String pkg) {
            try {
                return AppCatalog.ensureIconUrl(ctx, pkg);
            } catch (Throwable e) {
                return "";
            }
        }

        /** 点图标拉起应用；返回是否成功，前端据此提示「应用可能已卸载」 */
        @JavascriptInterface
        public boolean launchApp(String pkg) {
            try {
                return AppCatalog.launch(ctx, pkg);
            } catch (Throwable e) {
                return false;
            }
        }
    }
}
