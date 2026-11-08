package com.zhou.todolink;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.pdf.PdfRenderer;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 课表 PDF 的本地预处理：只做「把 PDF 变成 AI 能读的输入」，不解析课程、不联网。
 *
 * 为什么需要它：Android 没有公开的 PDF 文本提取 API（PdfRenderer 只会画位图），
 * 而课表 PDF 有两种截然不同的形态：
 *   1. 电子版（教务/Word 导出）：有文本层，抽出来给文本模型最省 token、最准；
 *   2. 扫描件或纯图片版：没有文本层，只能渲染成图片交给带视觉的模型。
 * 这里两条都提供，由页面按文本质量自动选择；质量不够就退到图片，不把乱码喂给模型。
 *
 * 渲染结果写到应用私有缓存，由 AssetServer 以 /__pdfpage/ 同源提供，
 * 页面再 fetch 成 data URL 发给模型 —— 不经过任何第三方图床，PDF 也不出本机。
 */
final class PdfIngest {

    private static final String PAGE_DIR = "pdfpages";
    /** 单份 PDF 最多渲染几页：课表通常 1-2 页，多页课表 4 页足够，避免请求体过大 */
    static final int MAX_PAGES = 4;
    /** 解码上限，防止超大文件把内存撑爆 */
    private static final long MAX_BYTES = 24L * 1024 * 1024;
    /** 渲染宽度上限（px）；A4 在 scale=2 下约 1190px，够看清 8pt 小字 */
    private static final int MAX_WIDTH = 1600;

    private PdfIngest() {}

    static File pageDir(Context ctx) {
        return new File(ctx.getCacheDir(), PAGE_DIR);
    }

    /** 打开 PDF 拿页数；顺带判断是不是加密文档（PdfRenderer 会抛 SecurityException） */
    static String infoJson(Context ctx, String uri) {
        JSONObject o = new JSONObject();
        ParcelFileDescriptor pfd = null;
        PdfRenderer r = null;
        try {
            pfd = open(ctx, uri);
            r = new PdfRenderer(pfd);
            int pages = r.getPageCount();
            o.put("ok", true);
            o.put("pages", pages);
            if (pages > 0) {
                PdfRenderer.Page p = r.openPage(0);
                o.put("width", p.getWidth());
                o.put("height", p.getHeight());
                p.close();
            }
            o.put("maxPages", MAX_PAGES);
        } catch (SecurityException e) {
            putError(o, "PDF 有密码保护，请先解除密码再导入");
        } catch (Throwable e) {
            putError(o, "打不开这个 PDF：" + msg(e));
        } finally {
            close(r, pfd);
        }
        return o.toString();
    }

    /**
     * 文本层抽取（尽力而为）。返回 {ok, text, chars, cjk, quality, pages}。
     * quality 是 0~1 的启发值：中文/字母/数字/常用标点占可打印字符的比例。
     * 页面用它决定走文本模型还是视觉模型，低于阈值直接不采用。
     */
    static String textJson(Context ctx, String uri) {
        JSONObject o = new JSONObject();
        try {
            byte[] raw = readAll(ctx, uri);
            if (raw == null) {
                putError(o, "读取 PDF 失败");
                return o.toString();
            }
            if (!isPdf(raw)) {
                putError(o, "这不是 PDF 文件（缺少 %PDF 头）");
                return o.toString();
            }
            PdfText t = new PdfText(raw);
            String text = t.extract();
            int cjk = countCjk(text);
            int printable = countPrintable(text);
            double q = printable == 0 ? 0 : (double) printable / Math.max(1, text.length());
            o.put("ok", true);
            o.put("text", text);
            o.put("chars", text.length());
            o.put("cjk", cjk);
            o.put("quality", Math.round(q * 1000) / 1000.0);
            o.put("pages", t.pageCount);
        } catch (Throwable e) {
            putError(o, "解析 PDF 文本失败：" + msg(e));
        }
        return o.toString();
    }

    /** 渲染某一页为 JPEG，返回同源 URL；页面已存在则直接复用 */
    static String renderJson(Context ctx, String uri, int page, double scale) {
        JSONObject o = new JSONObject();
        ParcelFileDescriptor pfd = null;
        PdfRenderer r = null;
        try {
            pfd = open(ctx, uri);
            r = new PdfRenderer(pfd);
            int total = r.getPageCount();
            if (page < 0 || page >= total) {
                putError(o, "页码超出范围（共 " + total + " 页）");
                return o.toString();
            }
            File dir = pageDir(ctx);
            if (!dir.exists()) dir.mkdirs();
            String name = fileName(uri, page, scale);
            File f = new File(dir, name);
            int w = 0;
            int h = 0;
            if (!f.isFile() || f.length() <= 0) {
                PdfRenderer.Page p = r.openPage(page);
                try {
                    double s = scale <= 0 ? 2 : Math.min(3, Math.max(1, scale));
                    w = Math.max(1, (int) Math.round(p.getWidth() * s));
                    h = Math.max(1, (int) Math.round(p.getHeight() * s));
                    if (w > MAX_WIDTH) {
                        double k = (double) MAX_WIDTH / w;
                        w = MAX_WIDTH;
                        h = Math.max(1, (int) Math.round(h * k));
                    }
                    Bitmap bm = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
                    try {
                        // PDF 页面本身是透明的，先铺白底，避免 JPEG 把透明压成黑块
                        android.graphics.Canvas cv = new android.graphics.Canvas(bm);
                        cv.drawColor(Color.WHITE);
                        p.render(bm, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                        ByteArrayOutputStream bos = new ByteArrayOutputStream(256 * 1024);
                        bm.compress(Bitmap.CompressFormat.JPEG, 84, bos);
                        FileOutputStream fos = new FileOutputStream(f);
                        try {
                            fos.write(bos.toByteArray());
                        } finally {
                            fos.close();
                        }
                    } finally {
                        bm.recycle();
                    }
                } finally {
                    p.close();
                }
            }
            o.put("ok", true);
            o.put("page", page);
            o.put("total", total);
            o.put("url", "/__pdfpage/" + name);
            if (w > 0) {
                o.put("width", w);
                o.put("height", h);
            }
        } catch (SecurityException e) {
            putError(o, "PDF 有密码保护，请先解除密码再导入");
        } catch (OutOfMemoryError e) {
            putError(o, "PDF 页面太大，手机内存不够渲染，请换页数更少的文件");
        } catch (Throwable e) {
            putError(o, "渲染 PDF 页面失败：" + msg(e));
        } finally {
            close(r, pfd);
        }
        return o.toString();
    }

    /** 由 AssetServer 调：严格文件名校验，只从私有缓存读 */
    static byte[] readPage(File dir, String name) {
        if (name == null || !name.matches("[a-f0-9]{16}_p[0-9]{1,2}\\.jpg")) return null;
        File f = new File(dir, name);
        if (!f.isFile() || f.length() <= 0 || f.length() > 4 * 1024 * 1024) return null;
        InputStream in = null;
        try {
            in = new java.io.FileInputStream(f);
            ByteArrayOutputStream bos = new ByteArrayOutputStream((int) f.length());
            byte[] buf = new byte[8192];
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

    /** 导入结束或换文件时清理，别让缓存无限长 */
    static void clear(Context ctx) {
        try {
            File dir = pageDir(ctx);
            File[] fs = dir.listFiles();
            if (fs == null) return;
            for (File f : fs) {
                try { f.delete(); } catch (Throwable ignore) {}
            }
        } catch (Throwable ignore) {
        }
    }

    // ------------------------------------------------------------ 文件读取

    private static ParcelFileDescriptor open(Context ctx, String uri) throws Exception {
        if (uri == null || uri.trim().isEmpty()) throw new IllegalArgumentException("没有文件");
        return ctx.getContentResolver().openFileDescriptor(Uri.parse(uri), "r");
    }

    private static byte[] readAll(Context ctx, String uri) throws Exception {
        InputStream in = null;
        try {
            in = ctx.getContentResolver().openInputStream(Uri.parse(uri));
            if (in == null) return null;
            ByteArrayOutputStream bos = new ByteArrayOutputStream(512 * 1024);
            byte[] buf = new byte[16384];
            long total = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                total += n;
                if (total > MAX_BYTES) throw new IllegalStateException("文件超过 24MB，请拆分后再导入");
                bos.write(buf, 0, n);
            }
            return bos.toByteArray();
        } finally {
            if (in != null) {
                try { in.close(); } catch (Throwable ignore) {}
            }
        }
    }

    private static boolean isPdf(byte[] b) {
        if (b == null || b.length < 5) return false;
        // 规范允许文件头前有少量垃圾字节，前 1KB 内出现 %PDF- 即可
        int lim = Math.min(1024, b.length - 4);
        for (int i = 0; i <= lim; i++) {
            if (b[i] == '%' && b[i + 1] == 'P' && b[i + 2] == 'D' && b[i + 3] == 'F' && b[i + 4] == '-') return true;
        }
        return false;
    }

    private static String fileName(String uri, int page, double scale) {
        try {
            MessageDigest md = MessageDigest.getInstance("MD5");
            byte[] d = md.digest((uri + "|" + Math.round((scale <= 0 ? 2 : scale) * 100)).getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 8; i++) sb.append(String.format("%02x", d[i] & 0xff));
            return sb + "_p" + page + ".jpg";
        } catch (Throwable e) {
            return String.format("%016x", (uri + "#" + page).hashCode()) + "_p" + page + ".jpg";
        }
    }

    private static void close(PdfRenderer r, ParcelFileDescriptor pfd) {
        if (r != null) {
            try { r.close(); } catch (Throwable ignore) {}
        }
        if (pfd != null) {
            try { pfd.close(); } catch (Throwable ignore) {}
        }
    }

    private static void putError(JSONObject o, String m) {
        try {
            o.put("ok", false);
            o.put("error", m);
        } catch (Throwable ignore) {
        }
    }

    private static String msg(Throwable e) {
        String m = e == null ? "" : e.getMessage();
        return m == null || m.isEmpty() ? (e == null ? "未知错误" : e.getClass().getSimpleName()) : m;
    }

    private static int countCjk(String s) {
        int n = 0;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c >= 0x4e00 && c <= 0x9fff) n++;
        }
        return n;
    }

    private static int countPrintable(String s) {
        int n = 0;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '\n' || c == '\t' || c == ' ') { n++; continue; }
            if (c >= 0x4e00 && c <= 0x9fff) { n++; continue; }
            if (c >= 0x3000 && c <= 0x303f) { n++; continue; }
            if (c >= 0xff00 && c <= 0xffef) { n++; continue; }
            if (c >= 0x20 && c < 0x7f) n++;
        }
        return n;
    }

    // ------------------------------------------------------------ PDF 文本抽取

    /**
     * 极简 PDF 文本抽取：扫描所有 stream → FlateDecode 解压 →
     * 收集 ToUnicode CMap（bfchar/bfrange）→ 从内容流里按 Tj/TJ 取字符串。
     *
     * 局限（页面有质量门禁兜底）：不处理对象流（ObjStm）里的字体定义、
     * 不区分字体资源作用域（多个 Identity-H 字体共用一张合并映射表），
     * 因此少数 PDF 会出现串字或乱码。遇到这种情况 quality 会偏低，
     * 页面自动改用「渲染成图片 + 视觉模型」，不会把乱码当成课表。
     */
    static final class PdfText {
        private final byte[] buf;
        private final Map<Integer, String> cid = new HashMap<>();
        int pageCount = 0;

        PdfText(byte[] b) {
            this.buf = b;
        }

        String extract() {
            List<byte[]> streams = streams();
            // 先建 ToUnicode 映射：内容流里只有 CID，没有它中文全是方块
            for (byte[] s : streams) {
                String t = latin(s, Math.min(s.length, 4000));
                if (t.contains("beginbfchar") || t.contains("beginbfrange")) parseCMap(t);
            }
            StringBuilder out = new StringBuilder();
            for (byte[] s : streams) {
                String t = latin(s, Math.min(s.length, 4000));
                if (!looksLikeContent(t)) continue;
                pageCount++;
                if (out.length() > 0) out.append('\n');
                out.append(textOfStream(s));
            }
            return tidy(out.toString());
        }

        /** 扫 stream...endstream；只保留体积合理的流，防止把图片流也解压一遍 */
        private List<byte[]> streams() {
            List<byte[]> list = new ArrayList<>();
            int i = 0;
            while (true) {
                int s = indexOf(buf, "stream", i);
                if (s < 0) break;
                int start = s + 6;
                if (start < buf.length && buf[start] == '\r') start++;
                if (start < buf.length && buf[start] == '\n') start++;
                int e = indexOf(buf, "endstream", start);
                if (e < 0) break;
                int end = e;
                // 去掉 endstream 前的 EOL
                while (end > start && (buf[end - 1] == '\n' || buf[end - 1] == '\r')) end--;
                int len = end - start;
                i = e + 9;
                if (len <= 0 || len > 8 * 1024 * 1024) continue;
                byte[] slice = new byte[len];
                System.arraycopy(buf, start, slice, 0, len);
                byte[] plain = inflate(slice);
                if (plain != null && plain.length > 0) list.add(plain);
                else if (len > 64) list.add(slice);
            }
            return list;
        }

        private void parseCMap(String t) {
            // beginbfchar ... endbfchar：<src> <dst>
            int i = 0;
            while ((i = t.indexOf("beginbfchar", i)) >= 0) {
                int end = t.indexOf("endbfchar", i);
                if (end < 0) break;
                String body = t.substring(i + 11, end);
                int p = 0;
                while (true) {
                    int a = body.indexOf('<', p);
                    if (a < 0) break;
                    int b = body.indexOf('>', a);
                    if (b < 0) break;
                    int c = body.indexOf('<', b);
                    if (c < 0) break;
                    int d = body.indexOf('>', c);
                    if (d < 0) break;
                    Integer src = hexInt(body, a + 1, b);
                    String dst = utf16(body.substring(c + 1, d));
                    if (src != null && dst != null && !dst.isEmpty()) cid.put(src, dst);
                    p = d + 1;
                }
                i = end + 9;
            }
            // beginbfrange ... endbfrange：<lo> <hi> <dstStart> 或 <lo> <hi> [<d1> <d2> ...]
            i = 0;
            while ((i = t.indexOf("beginbfrange", i)) >= 0) {
                int end = t.indexOf("endbfrange", i);
                if (end < 0) break;
                String body = t.substring(i + 12, end);
                int p = 0;
                while (true) {
                    int a = body.indexOf('<', p);
                    if (a < 0) break;
                    int b = body.indexOf('>', a);
                    if (b < 0) break;
                    int c = body.indexOf('<', b);
                    if (c < 0) break;
                    int d = body.indexOf('>', c);
                    if (d < 0) break;
                    Integer lo = hexInt(body, a + 1, b);
                    Integer hi = hexInt(body, c + 1, d);
                    if (lo == null || hi == null || hi < lo || hi - lo > 4096) { p = d + 1; continue; }
                    // hi 之后跳过空白，判断是数组 [<d1> <d2> ...] 还是递增基址 <dst>
                    int k = d + 1;
                    while (k < body.length() && Character.isWhitespace(body.charAt(k))) k++;
                    if (k < body.length() && body.charAt(k) == '[') {
                        int close = body.indexOf(']', k);
                        if (close > 0) {
                            String list = body.substring(k + 1, close);
                            int q = 0;
                            int code = lo;
                            while (true) {
                                int x = list.indexOf('<', q);
                                if (x < 0) break;
                                int y = list.indexOf('>', x);
                                if (y < 0) break;
                                String dst = utf16(list.substring(x + 1, y));
                                if (dst != null && !dst.isEmpty()) cid.put(code, dst);
                                code++;
                                q = y + 1;
                            }
                            p = close + 1;
                            continue;
                        }
                    } else if (k < body.length() && body.charAt(k) == '<') {
                        int e = body.indexOf('>', k);
                        String base = e < 0 ? null : utf16(body.substring(k + 1, e));
                        if (base != null && !base.isEmpty()) {
                            int lastCp = base.codePointAt(base.length() - 1);
                            String head = base.substring(0, base.length() - Character.charCount(lastCp));
                            for (int code = lo; code <= hi; code++) {
                                int cp = lastCp + (code - lo);
                                cid.put(code, head + new String(Character.toChars(cp)));
                            }
                            p = e + 1;
                            continue;
                        }
                    }
                    p = d + 1;
                }
                i = end + 12;
            }
        }

        private boolean looksLikeContent(String t) {
            return (t.contains("Tj") || t.contains("TJ")) && (t.contains("BT") || t.contains("Tm") || t.contains("Td"));
        }

        /** 从内容流里抽字符串；遇到换行类操作符补 \n，尽量保留原始行结构 */
        private String textOfStream(byte[] s) {
            StringBuilder out = new StringBuilder();
            int i = 0;
            while (i < s.length) {
                int c = s[i] & 0xff;
                if (c == '(') {
                    int[] end = new int[]{i + 1};
                    String lit = literal(s, end);
                    i = end[0];
                    appendText(out, lit);
                } else if (c == '<' && i + 1 < s.length && (s[i + 1] & 0xff) != '<') {
                    int close = indexOf(s, ">", i + 1);
                    if (close < 0) break;
                    String hex;
                    try {
                        hex = new String(s, i + 1, close - i - 1, "ISO-8859-1");
                    } catch (Throwable e) {
                        hex = latin(s, close + 1);
                    }
                    i = close + 1;
                    appendText(out, fromHex(hex));
                } else if (c == '\n' || c == '\r') {
                    if (out.length() > 0 && out.charAt(out.length() - 1) != '\n') out.append('\n');
                    i++;
                } else {
                    i++;
                }
            }
            return out.toString();
        }

        private void appendText(StringBuilder out, String piece) {
            if (piece == null || piece.isEmpty()) return;
            String t = decodeString(piece);
            if (t == null || t.isEmpty()) return;
            out.append(t);
        }

        /**
         * 字符串解码优先级：
         *   1. 每个 2 字节码在 ToUnicode 表里能查到 → 按 CID 映射；
         *   2. 整串像 UTF-16BE（含 CJK 且码位合理）→ 直接解；
         *   3. 退回单字节 Latin-1。
         */
        private String decodeString(String raw) {
            if (raw.isEmpty()) return "";
            int n = raw.length();
            boolean even = n % 2 == 0;
            if (even && !cid.isEmpty()) {
                int codes = n / 2;
                int hit = 0;
                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < n; i += 2) {
                    int code = ((raw.charAt(i) & 0xff) << 8) | (raw.charAt(i + 1) & 0xff);
                    String u = cid.get(code);
                    if (u != null) {
                        sb.append(u);
                        hit++;
                    } else {
                        sb.append('\u0000');
                    }
                }
                if (codes > 0 && (double) hit / codes >= 0.6) {
                    // 未命中的码位丢掉，避免输出一串 \u0000
                    return sb.toString().replace("\u0000", "");
                }
            }
            if (even && n >= 4 && looksUtf16(raw)) {
                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < n; i += 2) {
                    char ch = (char) (((raw.charAt(i) & 0xff) << 8) | (raw.charAt(i + 1) & 0xff));
                    if (ch != 0) sb.append(ch);
                }
                String s = sb.toString();
                if (countCjk(s) * 4 >= s.length()) return s;
            }
            StringBuilder sb = new StringBuilder(n);
            for (int i = 0; i < n; i++) {
                char ch = raw.charAt(i);
                if (ch >= 0x20 || ch == '\t') sb.append(ch);
            }
            return sb.toString();
        }

        private boolean looksUtf16(String raw) {
            int cjk = 0;
            int good = 0;
            for (int i = 0; i + 1 < raw.length(); i += 2) {
                char ch = (char) (((raw.charAt(i) & 0xff) << 8) | (raw.charAt(i + 1) & 0xff));
                if (ch == 0) continue;
                if (ch >= 0x4e00 && ch <= 0x9fff) { cjk++; good++; }
                else if (ch >= 0x20 && ch < 0x7f) good++;
                else if (ch >= 0x3000 && ch <= 0x303f) good++;
                else if (ch >= 0xff00 && ch <= 0xffef) good++;
            }
            int total = raw.length() / 2;
            return total > 0 && good >= total * 0.8 && cjk > 0;
        }

        private String literal(byte[] s, int[] pos) {
            StringBuilder sb = new StringBuilder();
            int depth = 1;
            int i = pos[0];
            while (i < s.length) {
                char c = (char) (s[i] & 0xff);
                i++;
                if (c == '\\') {
                    if (i >= s.length) break;
                    char n = (char) (s[i] & 0xff);
                    i++;
                    if (n == 'n') sb.append('\n');
                    else if (n == 'r') sb.append('\r');
                    else if (n == 't') sb.append('\t');
                    else if (n == 'b') sb.append('\b');
                    else if (n == 'f') sb.append('\f');
                    else if (n >= '0' && n <= '7') {
                        int v = n - '0';
                        for (int k = 0; k < 2 && i < s.length; k++) {
                            char d = (char) (s[i] & 0xff);
                            if (d < '0' || d > '7') break;
                            v = v * 8 + (d - '0');
                            i++;
                        }
                        sb.append((char) (v & 0xff));
                    } else if (n == '\n' || n == '\r') {
                        // 续行：忽略
                    } else sb.append(n);
                } else if (c == '(') {
                    depth++;
                    sb.append(c);
                } else if (c == ')') {
                    depth--;
                    if (depth == 0) break;
                    sb.append(c);
                } else {
                    sb.append(c);
                }
            }
            pos[0] = i;
            return sb.toString();
        }

        private String fromHex(String hex) {
            StringBuilder sb = new StringBuilder();
            int hi = -1;
            for (int i = 0; i < hex.length(); i++) {
                int v = Character.digit(hex.charAt(i), 16);
                if (v < 0) continue;
                if (hi < 0) hi = v;
                else {
                    sb.append((char) ((hi << 4) | v));
                    hi = -1;
                }
            }
            if (hi >= 0) sb.append((char) (hi << 4));
            return sb.toString();
        }

        private static Integer hexInt(String s, int from, int to) {
            int v = 0;
            int n = 0;
            for (int i = from; i < to; i++) {
                int d = Character.digit(s.charAt(i), 16);
                if (d < 0) continue;
                v = (v << 4) | d;
                n++;
            }
            return n == 0 ? null : Integer.valueOf(v);
        }

        private static String utf16(String hex) {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i + 3 < hex.length(); i += 4) {
                int v = 0;
                boolean ok = true;
                for (int k = 0; k < 4; k++) {
                    int d = Character.digit(hex.charAt(i + k), 16);
                    if (d < 0) { ok = false; break; }
                    v = (v << 4) | d;
                }
                if (!ok) continue;
                sb.append((char) v);
            }
            return sb.toString();
        }

        private static String tidy(String s) {
            StringBuilder out = new StringBuilder(s.length());
            int blank = 0;
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                if (c == '\r') continue;
                if (c == '\n') {
                    blank++;
                    if (blank > 1) continue;
                } else if (c != ' ' && c != '\t') blank = 0;
                out.append(c == '\t' ? ' ' : c);
            }
            return out.toString();
        }
    }

    // ------------------------------------------------------------ 解压 / 字节工具

    /** FlateDecode：先用 zlib 头解，失败再按 raw deflate 解；都不是就返回 null */
    private static byte[] inflate(byte[] data) {
        if (data.length < 2) return null;
        byte[] a = inflateWith(data, false);
        if (a != null) return a;
        return inflateWith(data, true);
    }

    private static byte[] inflateWith(byte[] data, boolean raw) {
        java.util.zip.Inflater inf = new java.util.zip.Inflater(raw);
        try {
            inf.setInput(data);
            ByteArrayOutputStream bos = new ByteArrayOutputStream(Math.max(256, data.length * 3));
            byte[] buf = new byte[16384];
            int guard = 0;
            while (!inf.finished() && guard++ < 4096) {
                int n = inf.inflate(buf);
                if (n <= 0) {
                    if (inf.needsInput() || inf.needsDictionary()) break;
                    break;
                }
                bos.write(buf, 0, n);
                if (bos.size() > 12 * 1024 * 1024) break;
            }
            return bos.size() == 0 ? null : bos.toByteArray();
        } catch (Throwable e) {
            return null;
        } finally {
            try { inf.end(); } catch (Throwable ignore) {}
        }
    }

    private static int indexOf(byte[] b, String s, int from) {
        byte[] p = s.getBytes();
        int lim = b.length - p.length;
        for (int i = Math.max(0, from); i <= lim; i++) {
            boolean ok = true;
            for (int k = 0; k < p.length; k++) {
                if (b[i + k] != p[k]) { ok = false; break; }
            }
            if (ok) return i;
        }
        return -1;
    }

    private static String latin(byte[] b, int len) {
        StringBuilder sb = new StringBuilder(Math.min(len, b.length));
        for (int i = 0; i < len && i < b.length; i++) sb.append((char) (b[i] & 0xff));
        return sb.toString();
    }
}
