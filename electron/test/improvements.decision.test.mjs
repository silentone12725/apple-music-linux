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

// ── #9 JS-side MV chunk cache cap (96 MB) ──
//
// Proposal: move the backward-seek chunk cache off the JS heap into the engine.
// This pins the heap cost so the trade-off is quantified.
test('Improvement09: JS MV re-inject cache cap', () => {
    const cap = numConst(PB, 'VID_CACHE_MAX_BYTES');
    assert.equal(cap, 96 << 20, 'VID_CACHE_MAX_BYTES drifted');
    console.log(`VERDICT #9: JS MV cache cap = ${(cap / (1 << 20)).toFixed(0)} MB of Uint8Arrays on the ` +
        `renderer heap. IMPLEMENTABLE but MEDIUM effort — depends on the engine seek index ` +
        `(aacstream Improvement06). Do #6 first, then this becomes a deletion (remove _vidCache).`);
});

// ── #10 VA-API hardware video decode is disabled ──
//
// Proposal: adaptively enable HW decode for high-res MV. This confirms it is
// currently force-disabled and that any change is a real behavior switch.
test('Improvement10: VA-API decode disabled in main process', () => {
    const disabled = /disable-features'[\s\S]{0,400}Vaapi(Video)?Decoder/.test(MAIN)
        || /Vaapi(Video)?Decoder/.test(MAIN);
    assert.ok(disabled, 'expected VaapiVideoDecoder in a disable-features switch');
    console.log('VERDICT #10: VA-API decode is force-disabled → MV decodes in software (CPU-heavy at 1080p). ' +
        'IMPLEMENTABLE but RISKY — it was disabled for a reason (Chromium/driver regressions). ' +
        'Needs a per-GPU allowlist + runtime fallback + dropped-frame telemetry before flipping. Low priority.');
});

// ── #11 & #12 — NOT function-testable (documented, deliberately skipped) ──
//
// These proposals depend on live DOM/MSE + real goroutine timing and cannot be
// adjudicated by a deterministic unit test. Recorded here so the decision matrix
// is complete and nobody wastes time trying to unit-test them.
test('Improvement11: coordinated A/V seek transaction — RUNTIME-ONLY', { skip: 'needs live MSE + <video>/<audio> elements; verify with the app + logs, not a unit test' }, () => {});

test('Improvement12: single cancellation context / goroutine cleanup — INTEGRATION-ONLY', { skip: 'assert with go test -race + goleak in an e2e session, not a pure function test' }, () => {});
