import { mkdirSync, lstatSync, chmodSync, realpathSync } from 'fs';
import path from 'path';

// Create `dir` (and its parents) so that only this user can enter it, and close a looser
// directory an earlier version left behind. The directories it is used for hold the session,
// preferences and logs, which must not depend on the umask or on the parent's mode.
export function ensurePrivateDir(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform === 'win32') return;
    try {
        const st = lstatSync(dir);
        // Only a real directory of ours: never follow a symlink, never touch someone else's.
        if (st.isDirectory() && st.uid === process.getuid() && (st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
    } catch { /* the caller's next write reports a real problem */ }
}

// Whether `file` really lies inside `root` once symlinks are resolved. A path another process
// hands us is served only after this, so a bad value cannot reach files outside the cache.
export function isWithin(root, file) {
    try {
        const rel = path.relative(realpathSync(root), realpathSync(file));
        return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
    } catch { return false; }
}
