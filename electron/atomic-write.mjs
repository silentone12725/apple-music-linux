import { writeFileSync, renameSync, unlinkSync, openSync, fsyncSync, closeSync } from 'fs';
import { writeFile, rename, unlink, open } from 'fs/promises';

let _n = 0;

// Windows refuses to rename over a file another rename or a reader has open for an instant
// (EPERM/EBUSY/EACCES); the same call succeeds a few ms later.
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRIES = 40;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function renameRetrySync(from, to) {
    for (let i = 0; ; i++) {
        try { return renameSync(from, to); } catch (e) { if (!BUSY.has(e.code) || i >= RETRIES) throw e; sleepSync(5); }
    }
}
async function renameRetry(from, to) {
    for (let i = 0; ; i++) {
        try { return await rename(from, to); } catch (e) { if (!BUSY.has(e.code) || i >= RETRIES) throw e; await new Promise((r) => setTimeout(r, 5)); }
    }
}
const tmpName = (p) => `${p}.${process.pid}.${++_n}.tmp`;

// Replace `path` with `data` so a crash or concurrent reader sees the old file or the new
// one, never a truncated mix. A torn prefs/credentials file otherwise parses as corrupt and
// the loaders silently fall back to empty, discarding everything saved in it.
export function writeFileAtomicSync(path, data, mode = 0o600) {
    const tmp = tmpName(path);
    try {
        writeFileSync(tmp, data, { mode });
        const fd = openSync(tmp, 'r+'); // Windows refuses to fsync a read-only handle (EPERM)
        try { fsyncSync(fd); } finally { closeSync(fd); }
        renameRetrySync(tmp, path);
    } catch (e) {
        try { unlinkSync(tmp); } catch {}
        throw e;
    }
}

export async function writeFileAtomic(path, data, mode = 0o600) {
    const tmp = tmpName(path);
    try {
        await writeFile(tmp, data, { mode });
        const fh = await open(tmp, 'r+');
        try { await fh.sync(); } finally { await fh.close(); }
        await renameRetry(tmp, path);
    } catch (e) {
        await unlink(tmp).catch(() => {});
        throw e;
    }
}
