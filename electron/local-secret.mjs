// Encryption for a secret on systems with no OS keyring (Linux without a secret service). Electron's
// safeStorage then writes plaintext or uses a key that ships in the app, so the secret is sealed here
// instead: AES-256-GCM under a key made from a random per-install file (mode 0600, kept apart from the
// data) and this machine's id. A copy of the config folder on another computer, a backup or a synced
// folder therefore holds nothing readable. It does not stop a process running as this user, which can
// read both the key file and the data: only a keyring or a passphrase can.
import crypto from 'crypto';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'fs';

const PREFIX = 'v1:';

function machineId(readId = (p) => readFileSync(p, 'utf8')) {
    for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try { const id = readId(p).trim(); if (id) return id; } catch { /* next */ }
    }
    return '';
}

// The install secret is created once. wx: two processes starting together cannot each write their own.
function installSecret(keyFile) {
    if (!existsSync(keyFile)) {
        try { writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    try { chmodSync(keyFile, 0o600); } catch { /* not ours to change */ }
    const secret = readFileSync(keyFile, 'utf8').trim();
    if (secret.length < 32) throw new Error('local secret key file is damaged');
    return secret;
}

function deriveKey(keyFile, id) {
    return crypto.scryptSync(installSecret(keyFile) + '\0' + id, 'adam-local-secret-v1', 32);
}

/** Seals text; the result is a printable string safe to keep in JSON. */
export function sealLocal(text, { keyFile, id = machineId() }) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', deriveKey(keyFile, id), iv);
    const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
    return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

/** Opens what sealLocal made; null when it is not one of ours, was altered, or came from another machine. */
export function openLocal(blob, { keyFile, id = machineId() }) {
    if (typeof blob !== 'string' || !blob.startsWith(PREFIX)) return null;
    try {
        const raw = Buffer.from(blob.slice(PREFIX.length), 'base64');
        if (raw.length < 12 + 16) return null;
        const d = crypto.createDecipheriv('aes-256-gcm', deriveKey(keyFile, id), raw.subarray(0, 12));
        d.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    } catch { return null; }
}

export { machineId };
