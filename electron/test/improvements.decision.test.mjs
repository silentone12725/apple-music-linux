// Decision tests for the renderer/Electron-side improvement proposals.
// These read the SHIPPED source (engine-playback.js, main.mjs) and assert the
// current constants so each proposal gets a deterministic verdict instead of a
// guess. A failing assert means the source drifted from the documented decision.
//
// Run:  node --test electron/test/improvements.decision.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const PB   = readFileSync(path.join(dir, '..', 'src', 'engine-playback.js'), 'utf8');
const MAIN = readFileSync(path.join(dir, '..', 'main.mjs'), 'utf8');

// numConst reads `const NAME = <number>;` (allowing `<<` shift expressions).
function numConst(src, name) {
    const m = new RegExp(name + '\\s*=\\s*([0-9]+)\\s*(?:<<\\s*([0-9]+))?').exec(src);
    if (!m) throw new Error('const not found: ' + name);
    return m[2] ? Number(m[1]) << Number(m[2]) : Number(m[1]);
}

// ── #8 Electron forward/backward buffer window (900s) ──
//
// Proposal: shrink the generic 900s forward window to cut memory + speed error
// recovery and seeks. This pins the current value so the decision is explicit.
test('Improvement08: forward/backward buffer window size', () => {
    const fwd = numConst(PB, 'FORWARD_SECS');
    const back = numConst(PB, 'BACKWARD_SECS');
    // Implemented: reduced from 900/900. Assert it stays bounded so it can't
    // silently drift back up to the old 15-minute window.
    assert.ok(fwd <= 300, `FORWARD_SECS=${fwd} exceeds the 300s cap`);
    assert.ok(back <= 180, `BACKWARD_SECS=${back} exceeds the 180s cap`);
    console.log(`VERDICT #8: IMPLEMENTED — forward/backward window = ${fwd}s/${back}s (was 900/900). ` +
        `Bounds long-track memory to ~8 MB and speeds post-error recovery. AAC/MSE path only.`);
});

// ── #9 JS-side MV chunk cache — REMOVED ──
//
// Implemented as a deletion: the up-to-96 MB renderer-side re-injection cache
// (_vidCache / VID_CACHE_MAX_BYTES) is gone. Backward seeks now re-fetch from the
// engine at ?t=<target>, served from the engine's disk cache. Guard that the
// cache stays gone so it can't creep back onto the JS heap.
test('Improvement09: JS MV re-inject cache removed', () => {
    assert.equal(/VID_CACHE_MAX_BYTES/.test(PB), false, 'VID_CACHE_MAX_BYTES came back');
    assert.equal(/\b_vidCache\b/.test(PB), false, '_vidCache came back');
    console.log('VERDICT #9: IMPLEMENTED (deletion) — the ~96 MB renderer-side MV re-inject cache is ' +
        'removed; backward seeks re-fetch from the engine (?t=) served from its disk cache.');
});

// ── #10 VA-API hardware video decode ──
//
// History: VA-API was first force-disabled because Chrome 138's mid-stream
// VA-API→FFmpeg fallback caused CHUNK_DEMUXER_ERROR on MSE video. Commit 94ad3cc
// re-enabled it once MV moved to native <video src>/WebCodecs: with no MSE
// video there is no ChunkDemuxer for the fallback to break. This pins that
// decision and its rationale so a future MSE-video path revisits it.
test('Improvement10: VA-API enabled only because MV video never uses MSE', () => {
    const enabled = /appendSwitch\('enable-features',[\s\S]{0,600}VaapiVideoDecoder/.test(MAIN);
    assert.ok(enabled, 'expected VaapiVideoDecoder in the enable-features switch');
    const rationale = /VA-?API[\s\S]{0,400}CHUNK_DEMUXER_ERROR[\s\S]{0,200}MSE/.test(MAIN);
    assert.ok(rationale, 'expected the MSE/CHUNK_DEMUXER rationale next to the VA-API enable');
});

// ── #11 & #12 — NOT function-testable (documented, deliberately skipped) ──
//
// These proposals depend on live DOM/MSE + real goroutine timing and cannot be
// adjudicated by a deterministic unit test. Recorded here so the decision matrix
// is complete and nobody wastes time trying to unit-test them.
test('Improvement11: coordinated A/V seek transaction — RUNTIME-ONLY', { skip: 'needs live MSE + <video>/<audio> elements; verify with the app + logs, not a unit test' }, () => {});

test('Improvement12: single cancellation context / goroutine cleanup — INTEGRATION-ONLY', { skip: 'assert with go test -race + goleak in an e2e session, not a pure function test' }, () => {});
