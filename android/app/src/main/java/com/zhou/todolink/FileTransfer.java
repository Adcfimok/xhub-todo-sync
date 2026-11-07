package com.zhou.todolink;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * 手机 ⇄ 电脑 的文件传输执行器。
 *
 * 为什么放在原生：WebView 拿不到 SAF 的 content:// 流，二进制走 base64 又会把内存打爆。
 * 这里负责「读文件 / 分块 / 加密 / 重试 / 落盘」，页面只发指令、收进度。
 *
 * 加密与 PC 端 service/files.js 完全对齐：
 *   key    = HKDF-SHA256(token, salt=transferId, info="xhub-file-v1", 32B)
 *   nonce  = sha256(transferId)[0..4] || uint64BE(chunkIndex)
 *   aad    = "xhub-file-v1|" + transferId + "|" + index + "|" + totalSize
 *   AES-256-GCM，每块尾部 16B tag
 */
final class FileTransfer {

    static final int CHUNK = 2 * 1024 * 1024;
    private static final int MAX_ATTEMPTS = 5;
    private static final ExecutorService POOL = Executors.newCachedThreadPool();
    /** reqId → 已取消。只增不减会漏内存，任务结束时统一 remove */
    private static final Map<String, Boolean> CANCEL = new ConcurrentHashMap<>();

    interface Sink {
        void emit(JSONObject payload);
    }

    private FileTransfer() {}

    static void cancel(String reqId) {
        if (reqId != null) CANCEL.put(reqId, true);
    }

    // ---------------------------------------------------------------- 上传

    static void startUpload(final Context ctx, final String reqId, final Uri uri, final String name,
                            final long size, final String mime, final String host, final String token,
                            final String resumeId, final String sha0, final Sink sink) {
        POOL.execute(() -> {
            String fileId = resumeId == null ? "" : resumeId;
            try {
                if (size <= 0) throw new IOException("空文件不能发送");
                String sha = sha0 == null ? "" : sha0;
                if (sha.length() != 64) {
                    emit(sink, base(reqId, name, size, "hashing", 0));
                    sha = hashUri(ctx, uri, reqId, name, size, sink);
                }
                checkpoint(reqId);

                if (fileId.isEmpty()) {
                    JSONObject body = new JSONObject();
                    body.put("name", name);
                    body.put("size", size);
                    body.put("mime", mime == null ? "" : mime);
                    JSONObject off = postJson(host, "/api/v1/files/offer", token, body.toString());
                    fileId = off.optString("id", "");
                    if (fileId.isEmpty()) throw new IOException("服务端没有返回任务 id");
                }
                if (!fileId.isEmpty()) {
                    JSONObject ev = base(reqId, name, size, "offered", 0);
                    ev.put("fileId", fileId);
                    ev.put("sha256", sha);
                    sink.emit(ev);
                }

                long received = 0;
                try {
                    JSONObject st = getJson(host, "/api/v1/files/status?id=" + fileId, token);
                    received = st.optLong("received", 0);
                } catch (HttpError e) {
                    if (e.status == 404) {
                        // 旧任务已被清理：重新开一个，别让用户卡在「续传中」
                        JSONObject body = new JSONObject();
                        body.put("name", name);
                        body.put("size", size);
                        body.put("mime", mime == null ? "" : mime);
                        JSONObject off = postJson(host, "/api/v1/files/offer", token, body.toString());
                        fileId = off.optString("id", "");
                        received = 0;
                    } else {
                        throw e;
                    }
                }
                int totalChunks = (int) Math.ceil((double) size / CHUNK);
                int start = (int) Math.min(totalChunks, received / CHUNK);
                long sent = (long) start * CHUNK;

                InputStream in = ctx.getContentResolver().openInputStream(uri);
                if (in == null) throw new IOException("无法读取所选文件");
                try {
                    skipFully(in, sent);
                    for (int i = start; i < totalChunks; i++) {
                        checkpoint(reqId);
                        int len = (int) Math.min(CHUNK, size - (long) i * CHUNK);
                        byte[] plain = readFully(in, len);
                        byte[] sealed = seal(keyFor(token, fileId), nonceFor(fileId, i), aadFor(fileId, i, size), plain);
                        postChunk(host, token, fileId, i, sealed, reqId);
                        sent += len;
                        JSONObject ev = base(reqId, name, size, "uploading", sent);
                        ev.put("fileId", fileId);
                        ev.put("pct", (int) Math.min(100, sent * 100 / size));
                        sink.emit(ev);
                    }
                } finally {
                    closeQuietly(in);
                }

                JSONObject fin = new JSONObject();
                fin.put("id", fileId);
                fin.put("sha256", sha);
                postJson(host, "/api/v1/files/finish", token, fin.toString());

                JSONObject done = base(reqId, name, size, "done", size);
                done.put("fileId", fileId);
                done.put("sha256", sha);
                done.put("pct", 100);
                sink.emit(done);
            } catch (Cancelled e) {
                abortQuietly(host, token, fileId);
                sink.emit(base(reqId, name, size, "canceled", 0));
            } catch (Exception e) {
                JSONObject err = base(reqId, name, size, "error", 0);
                put(err, "fileId", fileId);
                put(err, "message", msgOf(e));
                if (e instanceof HttpError) put(err, "code", ((HttpError) e).status);
                sink.emit(err);
            } finally {
                CANCEL.remove(reqId);
            }
        });
    }

    // ---------------------------------------------------------------- 下载

    static void startDownload(final Context ctx, final String reqId, final String fileId, final String name,
                              final long size, final String sha, final String host, final String token,
                              final Sink sink) {
        POOL.execute(() -> {
            File part = new File(partDir(ctx), fileId + ".part");
            try {
                int totalChunks = (int) Math.ceil((double) size / CHUNK);
                long have = part.length();
                int start = (int) Math.min(totalChunks, have / CHUNK);
                RandomAccessFile out = new RandomAccessFile(part, "rw");
                long sent;
                try {
                    out.setLength((long) start * CHUNK);
                    out.seek((long) start * CHUNK);
                    sent = (long) start * CHUNK;
                    for (int i = start; i < totalChunks; i++) {
                        checkpoint(reqId);
                        byte[] sealed = getBytes(host, "/api/v1/files/pull?id=" + fileId + "&i=" + i, token);
                        byte[] plain = open(keyFor(token, fileId), nonceFor(fileId, i), aadFor(fileId, i, size), sealed);
                        if (plain == null) throw new IOException("第 " + i + " 块解密失败（数据被改动？）");
                        out.write(plain);
                        sent += plain.length;
                        JSONObject ev = base(reqId, name, size, "downloading", sent);
                        ev.put("fileId", fileId);
                        ev.put("pct", (int) Math.min(100, sent * 100 / size));
                        sink.emit(ev);
                    }
                } finally {
                    closeQuietly(out);
                }
                checkpoint(reqId);

                String got = hashFile(part);
                if (sha != null && sha.length() == 64 && !sha.equalsIgnoreCase(got)) {
                    part.delete();
                    throw new IOException("校验失败，文件可能在传输中被改动");
                }
                String savedTo = publish(ctx, part, name, mimeOf(name));
                JSONObject fin = new JSONObject();
                fin.put("id", fileId);
                fin.put("sha256", got);
                postJson(host, "/api/v1/files/pull/finish", token, fin.toString());

                JSONObject done = base(reqId, name, size, "done", size);
                done.put("fileId", fileId);
                done.put("pct", 100);
                done.put("savedTo", savedTo);
                done.put("sha256", got);
                sink.emit(done);
            } catch (Cancelled e) {
                sink.emit(base(reqId, name, size, "canceled", 0));
            } catch (Exception e) {
                JSONObject err = base(reqId, name, size, "error", 0);
                put(err, "fileId", fileId);
                put(err, "message", msgOf(e));
                sink.emit(err);
            } finally {
                CANCEL.remove(reqId);
            }
        });
    }

    // ---------------------------------------------------------------- 哈希 / 加解密

    private static String hashUri(Context ctx, Uri uri, String reqId, String name, long size, Sink sink) throws Exception {
        InputStream in = ctx.getContentResolver().openInputStream(uri);
        if (in == null) throw new IOException("无法读取所选文件");
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        byte[] buf = new byte[256 * 1024];
        long done = 0;
        long last = 0;
        try {
            int n;
            while ((n = in.read(buf)) > 0) {
                checkpoint(reqId);
                md.update(buf, 0, n);
                done += n;
                if (System.currentTimeMillis() - last > 200) {
                    last = System.currentTimeMillis();
                    JSONObject ev = base(reqId, name, size, "hashing", done);
                    ev.put("pct", size > 0 ? (int) (done * 100 / size) : 0);
                    sink.emit(ev);
                }
            }
        } finally {
            closeQuietly(in);
        }
        StringBuilder sb = new StringBuilder();
        for (byte b : md.digest()) sb.append(String.format("%02x", b & 0xff));
        return sb.toString();
    }

    private static String hashFile(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        InputStream in = new FileInputStream(f);
        try {
            byte[] buf = new byte[256 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
        } finally {
            closeQuietly(in);
        }
        StringBuilder sb = new StringBuilder();
        for (byte b : md.digest()) sb.append(String.format("%02x", b & 0xff));
        return sb.toString();
    }

    private static byte[] keyFor(String token, String id) throws Exception {
        // RFC 5869：salt 做 HMAC 的 key，IKM 做消息；写反会得到另一把钥匙
        byte[] prk = hmac(utf8(id), utf8(token));
        return hkdfExpand(prk, utf8("xhub-file-v1"), 32);
    }

    private static byte[] hkdfExpand(byte[] prk, byte[] info, int len) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] t = new byte[0];
        int i = 1;
        while (out.size() < len) {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(prk, "HmacSHA256"));
            mac.update(t);
            mac.update(info);
            mac.update((byte) i);
            t = mac.doFinal();
            out.write(t);
            i++;
        }
        return Arrays.copyOf(out.toByteArray(), len);
    }

    private static byte[] hmac(byte[] key, byte[] data) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        return mac.doFinal(data);
    }

    private static byte[] nonceFor(String id, int index) throws Exception {
        byte[] h = MessageDigest.getInstance("SHA-256").digest(utf8(id));
        byte[] nonce = new byte[12];
        System.arraycopy(h, 0, nonce, 0, 4);
        long v = index & 0xffffffffL;
        for (int i = 0; i < 8; i++) nonce[11 - i] = (byte) ((v >>> (8 * i)) & 0xff);
        return nonce;
    }

    private static byte[] aadFor(String id, int index, long size) {
        return utf8("xhub-file-v1|" + id + "|" + index + "|" + size);
    }

    private static byte[] seal(byte[] key, byte[] nonce, byte[] aad, byte[] plain) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce));
        c.updateAAD(aad);
        return c.doFinal(plain);
    }

    /** 解密失败返回 null（GCM 认证不过就是 null，不抛异常给上层区分） */
    private static byte[] open(byte[] key, byte[] nonce, byte[] aad, byte[] sealed) {
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce));
            c.updateAAD(aad);
            return c.doFinal(sealed);
        } catch (Exception e) {
            return null;
        }
    }

    // ---------------------------------------------------------------- HTTP

    private static HttpURLConnection openConn(String host, String path, String token, String method) throws IOException {
        URL u = new URL("http://" + host + path);
        HttpURLConnection c = (HttpURLConnection) u.openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(15000);
        c.setReadTimeout(120000);
        c.setRequestProperty("Authorization", "Bearer " + token);
        c.setRequestProperty("Accept", "application/json, application/octet-stream");
        return c;
    }

    private static JSONObject postJson(String host, String path, String token, String body) throws Exception {
        HttpURLConnection c = null;
        try {
            c = openConn(host, path, token, "POST");
            byte[] b = utf8(body);
            c.setDoOutput(true);
            c.setFixedLengthStreamingMode(b.length);
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            OutputStream os = c.getOutputStream();
            os.write(b);
            os.close();
            int code = c.getResponseCode();
            String text = readAll(code >= 400 ? c.getErrorStream() : c.getInputStream());
            if (code >= 400) throw new HttpError(code, text);
            return new JSONObject(text);
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static JSONObject getJson(String host, String path, String token) throws Exception {
        HttpURLConnection c = null;
        try {
            c = openConn(host, path, token, "GET");
            int code = c.getResponseCode();
            String text = readAll(code >= 400 ? c.getErrorStream() : c.getInputStream());
            if (code >= 400) throw new HttpError(code, text);
            return new JSONObject(text);
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static byte[] getBytes(String host, String path, String token) throws Exception {
        HttpURLConnection c = null;
        try {
            c = openConn(host, path, token, "GET");
            int code = c.getResponseCode();
            InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
            byte[] all = readBytes(is);
            if (code >= 400) throw new HttpError(code, new String(all, "UTF-8"));
            return all;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static void postChunk(String host, String token, String id, int index, byte[] body, String reqId) throws Exception {
        Exception last = null;
        for (int attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            checkpoint(reqId);
            HttpURLConnection c = null;
            try {
                c = openConn(host, "/api/v1/files/chunk?id=" + id + "&i=" + index, token, "POST");
                c.setDoOutput(true);
                c.setFixedLengthStreamingMode(body.length);
                c.setRequestProperty("Content-Type", "application/octet-stream");
                OutputStream os = c.getOutputStream();
                os.write(body);
                os.close();
                int code = c.getResponseCode();
                String text = readAll(code >= 400 ? c.getErrorStream() : c.getInputStream());
                if (code >= 200 && code < 300) return;
                HttpError e = new HttpError(code, text);
                // 5xx / 429 值得再试；4xx 是语义错误，重试只会更慢
                if (code < 500 && code != 429) throw e;
                last = e;
            } catch (HttpError e) {
                throw e;
            } catch (IOException e) {
                last = e;
            } finally {
                if (c != null) c.disconnect();
            }
            Thread.sleep(300L * (1L << attempt));
        }
        if (last instanceof Exception) throw (Exception) last;
        throw new IOException("上传失败");
    }

    private static void abortQuietly(String host, String token, String id) {
        if (id == null || id.isEmpty()) return;
        try {
            JSONObject b = new JSONObject();
            b.put("id", id);
            postJson(host, "/api/v1/files/abort", token, b.toString());
        } catch (Exception ignore) {
        }
    }

    // ---------------------------------------------------------------- 落盘

    private static File partDir(Context ctx) {
        File d = new File(ctx.getCacheDir(), "transfers");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    /** 下载完成后对外发布：Q+ 写入系统「下载/x-hub」，旧版本退到应用外部目录 */
    private static String publish(Context ctx, File part, String name, String mime) throws Exception {
        if (Build.VERSION.SDK_INT >= 29) {
            ContentResolver r = ctx.getContentResolver();
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/x-hub");
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri item = r.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (item == null) throw new IOException("无法写入系统下载目录");
            InputStream in = new FileInputStream(part);
            OutputStream out = r.openOutputStream(item);
            try {
                copy(in, out);
            } finally {
                closeQuietly(in);
                closeQuietly(out);
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            r.update(item, done, null, null);
            part.delete();
            return "下载/x-hub/" + name;
        }
        File dir = ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null) dir = ctx.getFilesDir();
        File dst = unique(dir, name);
        InputStream in = new FileInputStream(part);
        OutputStream out = new FileOutputStream(dst);
        try {
            copy(in, out);
        } finally {
            closeQuietly(in);
            closeQuietly(out);
        }
        part.delete();
        return dst.getAbsolutePath();
    }

    private static File unique(File dir, String name) {
        File f = new File(dir, name);
        if (!f.exists()) return f;
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; i < 1000; i++) {
            File c = new File(dir, base + "-" + i + ext);
            if (!c.exists()) return c;
        }
        return new File(dir, base + "-" + System.currentTimeMillis() + ext);
    }

    private static String mimeOf(String name) {
        String n = name == null ? "" : name.toLowerCase();
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".gif")) return "image/gif";
        if (n.endsWith(".webp")) return "image/webp";
        if (n.endsWith(".pdf")) return "application/pdf";
        if (n.endsWith(".mp4")) return "video/mp4";
        if (n.endsWith(".mp3")) return "audio/mpeg";
        if (n.endsWith(".zip")) return "application/zip";
        if (n.endsWith(".txt") || n.endsWith(".md")) return "text/plain";
        return "application/octet-stream";
    }

    // ---------------------------------------------------------------- 小工具

    private static JSONObject base(String reqId, String name, long size, String state, long sent) {
        JSONObject o = new JSONObject();
        try {
            o.put("id", reqId);
            o.put("name", name == null ? "" : name);
            o.put("size", size);
            o.put("state", state);
            o.put("sent", sent);
            o.put("total", size);
        } catch (Exception ignore) {
        }
        return o;
    }

    private static void put(JSONObject o, String k, Object v) {
        try {
            o.put(k, v);
        } catch (Exception ignore) {
        }
    }

    private static void emit(Sink sink, JSONObject o) {
        if (sink != null) sink.emit(o);
    }

    private static void checkpoint(String reqId) throws Cancelled {
        if (CANCEL.containsKey(reqId)) throw new Cancelled();
    }

    private static byte[] readFully(InputStream in, int len) throws IOException {
        byte[] out = new byte[len];
        int off = 0;
        while (off < len) {
            int n = in.read(out, off, len - off);
            if (n < 0) throw new IOException("文件读取提前结束（可能已被移动或删除）");
            off += n;
        }
        return out;
    }

    private static void skipFully(InputStream in, long n) throws IOException {
        long left = n;
        byte[] buf = new byte[64 * 1024];
        while (left > 0) {
            int got = in.read(buf, 0, (int) Math.min(buf.length, left));
            if (got < 0) throw new IOException("续传定位失败：文件比记录的短");
            left -= got;
        }
    }

    private static String readAll(InputStream is) throws IOException {
        return new String(readBytes(is), "UTF-8");
    }

    private static byte[] readBytes(InputStream is) throws IOException {
        if (is == null) return new byte[0];
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[16 * 1024];
        int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        return bos.toByteArray();
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buf = new byte[128 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        out.flush();
    }

    private static byte[] utf8(String s) {
        try {
            return s.getBytes("UTF-8");
        } catch (Exception e) {
            return s.getBytes();
        }
    }

    private static void closeQuietly(java.io.Closeable c) {
        if (c == null) return;
        try {
            c.close();
        } catch (Exception ignore) {
        }
    }

    private static String msgOf(Throwable e) {
        String m = e.getMessage();
        if (m == null || m.isEmpty()) m = e.getClass().getSimpleName();
        return m.length() > 300 ? m.substring(0, 300) : m;
    }

    static final class HttpError extends IOException {
        final int status;

        HttpError(int status, String body) {
            super(parse(status, body));
            this.status = status;
        }

        private static String parse(int status, String body) {
            try {
                JSONObject o = new JSONObject(body);
                String c = o.optString("code", "");
                String msg = o.optString("message", "");
                if ("HASH_MISMATCH".equals(c)) return "文件校验不通过，请重试";
                if ("QUOTA_FULL".equals(c)) return "电脑收件箱已满，请先在电脑上清理";
                if ("NO_SPACE".equals(c)) return "电脑磁盘空间不足";
                if ("TOO_LARGE".equals(c)) return "超过 512MB 单文件上限";
                if ("OFFSET".equals(c)) return "断点位置不一致，请重新发送";
                if ("FILE_FORBIDDEN".equals(c)) return "电脑端已关闭这台设备的文件权限";
                if (msg != null && !msg.isEmpty() && !msg.equals(c)) return msg;
                return c.isEmpty() ? "HTTP " + status : c;
            } catch (Exception e) {
                return "HTTP " + status;
            }
        }
    }

    static final class Cancelled extends IOException {
        Cancelled() {
            super("已取消");
        }
    }
}
