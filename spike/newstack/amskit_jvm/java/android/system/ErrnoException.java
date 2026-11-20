package android.system;

public final class ErrnoException extends Exception {
    public final int errno;
    public ErrnoException(String functionName, int errno) { super(functionName + " failed: errno " + errno); this.errno = errno; }
    public ErrnoException(String functionName, int errno, Throwable cause) { super(functionName + " failed: errno " + errno, cause); this.errno = errno; }
}
