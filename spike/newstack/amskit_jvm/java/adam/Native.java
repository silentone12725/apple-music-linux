package adam;

import java.io.File;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.Enumeration;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

public final class Native {
    static native long find(String sym);
    static native int reg(Class<?> target, String name, String sig, long fn);

    static String mangle(String s) {
        StringBuilder b = new StringBuilder();
        for (char ch : s.toCharArray()) {
            if (ch == '/' || ch == '.') b.append('_');
            else if (ch == '_') b.append("_1");
            else if (ch == ';') b.append("_2");
            else if (ch == '[') b.append("_3");
            else if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9')) b.append(ch);
            else b.append(String.format("_0%04x", (int) ch));
        }
        return b.toString();
    }

    static String desc(Class<?> c) {
        if (c.isPrimitive()) {
            if (c == int.class) return "I"; if (c == long.class) return "J"; if (c == boolean.class) return "Z";
            if (c == byte.class) return "B"; if (c == short.class) return "S"; if (c == char.class) return "C";
            if (c == float.class) return "F"; if (c == double.class) return "D"; return "V";
        }
        if (c.isArray()) return "[" + desc(c.getComponentType());
        return "L" + c.getName().replace('.', '/') + ";";
    }

    public static int registerAll(String jar, String prefix) throws Exception {
        int ok = 0, miss = 0;
        try (ZipFile z = new ZipFile(new File(jar))) {
            for (Enumeration<? extends ZipEntry> e = z.entries(); e.hasMoreElements();) {
                String n = e.nextElement().getName();
                if (!n.endsWith(".class") || !n.startsWith(prefix)) continue;
                String cn = n.substring(0, n.length() - 6).replace('/', '.');
                Class<?> c;
                try { c = Class.forName(cn, false, Native.class.getClassLoader()); } catch (Throwable t) { continue; }
                Method[] ms;
                try { ms = c.getDeclaredMethods(); } catch (Throwable t) { continue; }
                for (Method m : ms) {
                    if (!Modifier.isNative(m.getModifiers())) continue;
                    StringBuilder sig = new StringBuilder("(");
                    for (Class<?> p : m.getParameterTypes()) sig.append(desc(p));
                    sig.append(")").append(desc(m.getReturnType()));
                    String base = "Java_" + mangle(cn.replace('.', '/')) + "_" + mangle(m.getName());
                    String args = sig.substring(1, sig.indexOf(")"));
                    long fn = find(base + "__" + mangle(args));
                    if (fn == 0) fn = find(base);
                    if (fn == 0) { miss++; continue; }
                    if (reg(c, m.getName(), sig.toString(), fn) == 0) ok++; else miss++;
                }
            }
        }
        System.err.println("registerAll: ok=" + ok + " miss=" + miss);
        return ok;
    }
}
