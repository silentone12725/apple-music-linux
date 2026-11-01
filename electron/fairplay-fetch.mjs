import path from 'node:path';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, copyFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

// Windows counterpart of scripts/fetch-fairplay-libs.sh: downloads Apple's Android FairPlay libraries from the
// sources pinned in fairplay-libs.lock, refusing any file whose SHA-256 does not match, then installs our stubs.

const MAX_BYTES = 64 * 1024 * 1024; // the largest library is ~14 MiB
const STUBS = ['libandroid.so', 'libOpenSLES.so', 'libdl.so'];

export function parseLock(text) {
    const sources = [];
    const entries = [];
    for (const line of String(text).split(/\r?\n/)) {
        const src = /^source\s+(https:\/\/\S+)\s*$/.exec(line);
        if (src) { sources.push(src[1].replace(/\/+$/, '')); continue; }
        const lib = /^([0-9a-f]{64})\s+([A-Za-z0-9._+-]+\.so)\s*$/.exec(line);
        if (lib) entries.push({ sha256: lib[1], name: lib[2] });
    }
    return { sources, entries };
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function download(fetchImpl, url) {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('file too large');
    return buf;
}

// Resolves { ok, fetched, failed }. Files already matching their checksum are not downloaded again.
export async function fetchFairPlayLibs({ lockPath, stubsDir, dest, fetchImpl = fetch, log = () => {} }) {
    if (!existsSync(lockPath)) return { ok: false, fetched: 0, failed: ['fairplay-libs.lock'] };
    const { sources, entries } = parseLock(readFileSync(lockPath, 'utf8'));
    if (!sources.length || !entries.length) return { ok: false, fetched: 0, failed: ['fairplay-libs.lock'] };
    mkdirSync(dest, { recursive: true });
    const failed = [];
    let fetched = 0;
    for (const { sha256: want, name } of entries) {
        const target = path.join(dest, name);
        try { if (existsSync(target) && sha256(readFileSync(target)) === want) continue; } catch { /* refetch */ }
        let ok = false;
        for (const src of sources) {
            try {
                const buf = await download(fetchImpl, `${src}/${name}`);
                if (sha256(buf) !== want) throw new Error('checksum mismatch');
                const part = path.join(dest, `.${name}.part`);
                writeFileSync(part, buf);
                renameSync(part, target);
                ok = true;
                break;
            } catch (e) {
                log(`${name} from ${src} failed: ${e.message}`);
                try { rmSync(path.join(dest, `.${name}.part`), { force: true }); } catch { /* nothing to remove */ }
            }
        }
        if (ok) fetched++; else failed.push(name);
    }
    for (const stub of STUBS) {
        const from = path.join(stubsDir, stub);
        if (existsSync(from)) copyFileSync(from, path.join(dest, stub));
        else if (!existsSync(path.join(dest, stub))) failed.push(stub);
    }
    return { ok: failed.length === 0, fetched, failed };
}
