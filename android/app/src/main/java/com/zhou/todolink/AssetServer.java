package com.zhou.todolink;

import android.content.res.AssetManager;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 极简本地资源服务。
 *
 * 存在的唯一理由是 origin：file:// 不是可靠的安全上下文，getUserMedia、IndexedDB 配额、
 * fetch 行为都会打折扣；而 http://127.0.0.1 属于「potentially trustworthy origin」，
 * 与浏览器里的 localhost 等价，WebView 能拿到完整能力，且不需要任何第三方依赖。
 */
final class AssetServer implements Runnable {

    private static final String TAG = "AssetServer";
    private static final String ROOT = "www";
    private static final Map<String, String> MIME = new HashMap<>();

    static {
        MIME.put("html", "text/html; charset=utf-8");
        MIME.put("js", "text/javascript; charset=utf-8");
        MIME.put("css", "text/css; charset=utf-8");
        MIME.put("json", "application/json; charset=utf-8");
        MIME.put("svg", "image/svg+xml");
        MIME.put("png", "image/png");
        MIME.put("jpg", "image/jpeg");
        MIME.put("webp", "image/webp");
        MIME.put("woff2", "font/woff2");
        MIME.put("ico", "image/x-icon");
    }

    /**
     * 固定端口候选。
     *
     * 为什么不能用 ServerSocket(0)：页面 origin 是 http://127.0.0.1:<port>，
     * 而 IndexedDB / localStorage 是**按 origin 隔离**的。系统分配的临时端口每次冷启动
     * 都可能不同，换个端口就等于打开一个全新的空存储 —— 表现就是「升级后数据全没了」。
     * 固定在同一个端口上，origin 才稳定，数据才留得住。
     */
    private static final int[] PREFERRED_PORTS = {47830, 47831, 47832, 47833};

    private final AssetManager assets;
    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private ServerSocket server;
    private Thread thread;
    private volatile boolean running;

    AssetServer(AssetManager assets) {
        this.assets = assets;
    }

    int start() throws IOException {
        // 优先固定端口；实在全被占用才退回系统分配（此时 origin 会变，页面会提示）
        for (int port : PREFERRED_PORTS) {
            try {
                server = bind(port);
                break;
            } catch (IOException ignored) {
                // 试下一个
            }
        }
        if (server == null) {
            Log.w(TAG, "固定端口全部占用，回退临时端口；本次的本地数据分区会变");
            server = bind(0);
        }

        running = true;
        thread = new Thread(this, "asset-server");
        thread.setDaemon(true);
        thread.start();
        return server.getLocalPort();
    }

    /** setReuseAddress 必须在 bind 之前：否则刚被杀掉的进程留下的 TIME_WAIT 会让端口「看起来被占」 */
    private static ServerSocket bind(int port) throws IOException {
        ServerSocket s = new ServerSocket();
        s.setReuseAddress(true);
        s.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 16);
        return s;
    }

    String baseUrl() {
        return "http://127.0.0.1:" + port() + "/";
    }

    /** 实际监听端口（= 页面 origin 的端口部分） */
    int port() {
        return server == null ? 0 : server.getLocalPort();
    }

    void stop() {
        running = false;
        try {
            if (server != null) server.close();
        } catch (IOException ignored) {
        }
        pool.shutdownNow();
    }

    /**
     * 连接处理改成线程池。
     * 原来是串行 accept + handle：页面加载时并发拉 index.html、多个 js/css，
     * 任何一个慢连接都会把后来的请求一起堵住，WebView 侧表现为「白屏很久」。
     */
    @Override
    public void run() {
        while (running) {
            try {
                final Socket s = server.accept();
                pool.submit(() -> handle(s));
            } catch (IOException e) {
                if (running) Log.w(TAG, "accept failed: " + e.getMessage());
            }
        }
    }

    private void handle(Socket socket) {
        try {
            socket.setSoTimeout(4000);
            String reqLine = readLine(socket.getInputStream());
            if (reqLine == null) return;

            // 只处理 GET；请求头全部读过就丢（没有 body）
            String last;
            int guard = 0;
            do {
                last = readLine(socket.getInputStream());
                guard++;
            } while (last != null && !last.isEmpty() && guard < 64);

            String path = "/";
            String[] parts = reqLine.split(" ");
            if (parts.length >= 2) path = parts[1];
            int q = path.indexOf('?');
            if (q >= 0) path = path.substring(0, q);
            if (path.equals("/")) path = "/index.html";

            // 目录穿越防护：只允许字母数字、点、横线、下划线与斜杠
            if (!path.matches("^/[A-Za-z0-9._/-]*$") || path.contains("..")) {
                write(socket.getOutputStream(), 400, "text/plain; charset=utf-8", "bad path".getBytes("UTF-8"));
                return;
            }

            String assetPath = ROOT + path;
            byte[] body = readAsset(assetPath);
            if (body == null) {
                write(socket.getOutputStream(), 404, "text/plain; charset=utf-8", "not found".getBytes("UTF-8"));
                return;
            }
            String ext = assetPath.substring(assetPath.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
            String mime = MIME.containsKey(ext) ? MIME.get(ext) : "application/octet-stream";
            write(socket.getOutputStream(), 200, mime, body);
        } catch (Exception e) {
            Log.w(TAG, "handle failed: " + e.getMessage());
        } finally {
            try {
                socket.close();
            } catch (IOException ignored) {
            }
        }
    }

    private byte[] readAsset(String path) {
        InputStream in = null;
        try {
            in = assets.open(path);
            ByteArrayOutputStream out = new ByteArrayOutputStream(Math.max(1024, in.available()));
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        } catch (IOException e) {
            return null;
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (IOException ignored) {
                }
            }
        }
    }

    private void write(OutputStream out, int code, String mime, byte[] body) throws IOException {
        String head = "HTTP/1.1 " + code + " " + (code == 200 ? "OK" : "Error") + "\r\n"
                + "Content-Type: " + mime + "\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: close\r\n\r\n";
        out.write(head.getBytes("UTF-8"));
        out.write(body);
        out.flush();
    }

    private String readLine(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') sb.append((char) c);
            if (sb.length() > 8192) break;
        }
        if (c == -1 && sb.length() == 0) return null;
        return sb.toString();
    }
}
