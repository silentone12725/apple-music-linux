import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const src = readFileSync(new URL('../../src/engine-playback.js', import.meta.url), 'utf8');
const start = src.indexOf('async function _setupMSEPath(');
const body = src.slice(start, src.indexOf('\n}\n', start) + 2);
function setup() {
    let ms;
    const revoked = [], buffers = [];
    const context = vm.createContext({
        ENGINE: 'https://engine', _sessionId: 'old', _durationSec: 100,
        URL: { createObjectURL: () => 'blob:old', revokeObjectURL: u => revoked.push(u) },
        MediaSource: class extends EventTarget {
            constructor() { super(); ms = this; }
            addSourceBuffer() { buffers.push('created'); throw new Error('stale source opened'); }
        },
        _nativeSrcSet() {}, HTMLMediaElement: { prototype: { load() {} } },
    });
    vm.runInContext(body, context);
    const ctrl = new AbortController();
    const pending = context._setupMSEPath({}, {}, {}, ctrl, 0);
    return { ctrl, pending, get ms() { return ms; }, revoked, buffers };
}
test('an AAC source opened just before a skip never installs stale buffers or overrides', async () => {
    const s = setup();
    s.ms.dispatchEvent(new Event('sourceopen'));
    s.ctrl.abort();
    await s.pending;
    assert.deepEqual(s.buffers, []);
    assert.deepEqual(s.revoked, ['blob:old']);
});
test('skipping before sourceopen releases the object URL as well', async () => {
    const s = setup();
    s.ctrl.abort();
    await assert.rejects(s.pending, /aborted/);
    assert.deepEqual(s.revoked, ['blob:old']);
});
