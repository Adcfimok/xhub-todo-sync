import java.lang.reflect.Method;

public class CryptoProbe {
    static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x & 0xff));
        return sb.toString();
    }
    public static void main(String[] a) throws Exception {
        Class<?> c = Class.forName("com.zhou.todolink.FileTransfer");
        Method keyFor = c.getDeclaredMethod("keyFor", String.class, String.class);
        Method nonceFor = c.getDeclaredMethod("nonceFor", String.class, int.class);
        Method aadFor = c.getDeclaredMethod("aadFor", String.class, int.class, long.class);
        Method seal = c.getDeclaredMethod("seal", byte[].class, byte[].class, byte[].class, byte[].class);
        Method open = c.getDeclaredMethod("open", byte[].class, byte[].class, byte[].class, byte[].class);
        keyFor.setAccessible(true); nonceFor.setAccessible(true); aadFor.setAccessible(true);
        seal.setAccessible(true); open.setAccessible(true);

        String token = a[0], id = a[1];
        byte[] plain = new byte[1024];
        for (int i = 0; i < plain.length; i++) plain[i] = (byte) (i * 7 + 3);
        byte[] key = (byte[]) keyFor.invoke(null, token, id);
        byte[] nonce = (byte[]) nonceFor.invoke(null, id, 1);
        byte[] aad = (byte[]) aadFor.invoke(null, id, 1, 3000000L);
        byte[] sealed = (byte[]) seal.invoke(null, key, nonce, aad, plain);
        byte[] back = (byte[]) open.invoke(null, key, nonce, aad, sealed);
        System.out.println(hex(key));
        System.out.println(hex(nonce));
        System.out.println(hex(aad));
        System.out.println(hex(sealed));
        System.out.println(java.util.Arrays.equals(plain, back));
    }
}
