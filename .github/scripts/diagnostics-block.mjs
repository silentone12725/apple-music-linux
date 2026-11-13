// The "Adam diagnostics v1" block: a small, key: value summary that Adam's reporter produces. This module only checks
// that a block is COMPLETE. A valid block is a completeness check, never a safety check: a user can edit it and put anything
// in a value, so nothing here, and nothing that calls it, may treat a valid block as safe to publish.

export const BLOCK_MARKER = 'Adam diagnostics v1';
export const BLOCK_MAX_BYTES = 8 * 1024;
export const RECOGNIZED_KEYS = [
    'version', 'channel', 'commit', 'os', 'arch', 'kernel', 'desktop', 'session', 'install',
    'electron', 'chromium', 'gpu', 'ffmpeg', 'engine', 'lossless', 'spatial',
];
const MIN_RECOGNIZED = 5;

export function isValidDiagnosticsBlock(text) {
    const s = String(text ?? '');
    if (Buffer.byteLength(s) > BLOCK_MAX_BYTES) return false;
    const lines = s.split(/\r?\n/).map((l) => l.trim());
    const start = lines.findIndex((l) => l === BLOCK_MARKER);
    if (start < 0) return false;
    const body = lines.slice(start + 1);
    const kv = new Map();
    for (const l of body) {
        const m = /^([A-Za-z][A-Za-z0-9_-]*):\s*(\S.*)$/.exec(l);
        if (m) kv.set(m[1].toLowerCase(), m[2]);
    }
    if (kv.get('formatversion') !== '1') return false;
    return RECOGNIZED_KEYS.filter((k) => kv.has(k)).length >= MIN_RECOGNIZED;
}

// issue: { body: parsed form fields from triage.mjs, authorId }, comments: [{ authorId, authorType, body }]
// -> 'valid' | 'waived' | 'missing'
export function diagnosticsStatus({ fields, authorId, comments = [] }) {
    if (isValidDiagnosticsBlock(fields?.diagnostics)) return 'valid';
    for (const c of comments) {
        if (c.authorId === authorId && c.authorType !== 'Bot' && isValidDiagnosticsBlock(c.body)) return 'valid';
    }
    if (fields?.waiver) return 'waived';
    return 'missing';
}
