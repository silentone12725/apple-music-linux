import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, DEFAULTS, createMemoryMaintenance, readConfigFromEnv, toMb } from '../memory-maintenance.mjs';

const base = {
    enabled: true, onApplePage: true, baselineMb: 700, rendererMb: 1600,
    playing: false, sincePlayingMs: Infinity, focused: false, hiddenOrMinimized: true,
    inactiveForMs: 5 * 60_000, sinceLastReloadMs: Infinity,
};

test('reloads when memory is high and the hidden window has been idle', () => {
    assert.deepEqual(decide(base), { reload: true, reason: 'idle and memory high' });
});

test('each safety condition on its own prevents a reload', () => {
    const cases = {
        'disabled': { enabled: false },
        'not on the Apple Music page': { onApplePage: false },
        'baseline not measured yet': { baselineMb: null },
        'memory below threshold': { rendererMb: 1100 },
        'playing': { playing: true },
        'played recently': { sincePlayingMs: 5_000 },
        'window focused': { focused: true },
        'not idle long enough': { inactiveForMs: 30_000 },
        'reloaded recently': { sinceLastReloadMs: 60_000 },
    };
    for (const [reason, patch] of Object.entries(cases)) {
        assert.deepEqual(decide({ ...base, ...patch }), { reload: false, reason }, reason);
    }
});

test('a visible but unfocused window needs the longer idle time', () => {
    const visible = { ...base, hiddenOrMinimized: false };
    assert.equal(decide({ ...visible, inactiveForMs: 5 * 60_000 }).reload, false);
    assert.equal(decide({ ...visible, inactiveForMs: DEFAULTS.idleVisibleMs }).reload, true);
});

test('the threshold is both an absolute floor and growth over the baseline', () => {
    // A small baseline still needs the floor; a large baseline needs its growth on top.
    assert.equal(decide({ ...base, baselineMb: 300, rendererMb: 1100 }).reload, false);
    assert.equal(decide({ ...base, baselineMb: 300, rendererMb: 1200 }).reload, true);
    assert.equal(decide({ ...base, baselineMb: 900, rendererMb: 1400 }).reload, false);
    assert.equal(decide({ ...base, baselineMb: 900, rendererMb: 1500 }).reload, true);
});

test('environment overrides are read in the right units and bad values fall back', () => {
    assert.equal(readConfigFromEnv({ ADAM_MEM_QUIET_S: '7' }).quietAfterPlayMs, 7000);
    const cfg = readConfigFromEnv({ ADAM_MEM_FLOOR_MB: '800', ADAM_MEM_IDLE_S: '5', ADAM_MEM_CHECK_S: 'abc', ADAM_MEM_GROWTH_MB: '-3' });
    assert.equal(cfg.floorMb, 800);
    assert.equal(cfg.idleHiddenMs, 5000);
    assert.equal(cfg.checkMs, DEFAULTS.checkMs);
    assert.equal(cfg.growthMb, DEFAULTS.growthMb);
    assert.equal(Math.round(toMb(1048576)), 1024);
});

function harness(over = {}) {
    let t = 1_000_000;
    const calls = [];
    const win = { focused: false, visible: false, minimized: false, destroyed: false,
        isFocused() { return this.focused; }, isVisible() { return this.visible; },
        isMinimized() { return this.minimized; }, isDestroyed() { return this.destroyed; } };
    const state = { mb: 700, playing: false, sincePlaying: Infinity, apple: true, dialog: false, enabled: true };
    const timers = [];
    const m = createMemoryMaintenance({
        getWin: () => win, rendererMb: () => state.mb, isPlaying: () => state.playing, msSincePlaying: () => state.sincePlaying,
        onApplePage: () => state.apple, dialogOpen: async () => state.dialog,
        isEnabled: async () => state.enabled,
        markReload: async () => { calls.push('mark'); },
        flushRenderer: async () => { calls.push('flush'); },
        reload: () => { calls.push('reload'); },
        now: () => t, log: (l) => calls.push('log:' + l.split('(')[0].trim()),
        setTimeout: (fn, ms) => { const h = { fn, ms, unref() {} }; timers.push(h); return h; },
        setInterval: (fn, ms) => ({ fn, ms, unref() {} }),
        ...over,
    }, { ...DEFAULTS, ...over.cfg });
    return { m, win, state, calls, timers, advance: (ms) => { t += ms; },
        settle() { timers.at(-1).fn(); } };
}

test('measures the baseline once the page has settled, then reloads in the right order', async () => {
    const h = harness();
    h.m.pageLoaded();
    assert.equal(h.m.baselineMb, null);
    h.settle();
    assert.equal(h.m.baselineMb, 700);
    h.state.mb = 1700; h.m.setActive(false); h.advance(3 * 60_000);
    const d = await h.m.check();
    assert.equal(d.reload, true);
    // The resume marker and the renderer flush must land before the reload starts.
    assert.deepEqual(h.calls.filter(c => !c.startsWith('log:')), ['mark', 'flush', 'reload']);
    assert.equal(h.m.isReloading, true);
});

test('does not reload during playback, with a dialog open, or while the user is active', async () => {
    const h = harness();
    h.m.pageLoaded(); h.settle(); h.state.mb = 1700; h.m.setActive(false); h.advance(3 * 60_000);
    h.state.playing = true;
    assert.equal((await h.m.check()).reason, 'playing');
    h.state.playing = false; h.state.sincePlaying = 10_000;
    assert.equal((await h.m.check()).reason, 'played recently');
    h.state.sincePlaying = Infinity; h.state.dialog = true;
    assert.equal((await h.m.check()).reason, 'dialog open');
    h.state.dialog = false; h.m.setActive(true); h.advance(10_000);
    assert.equal((await h.m.check()).reload, false);
    assert.deepEqual(h.calls.filter(c => c === 'reload'), []);
});

test('waits out a failed dialog check and does not reload twice in a row', async () => {
    const h = harness();
    h.m.pageLoaded(); h.settle(); h.state.mb = 1700; h.m.setActive(false); h.advance(3 * 60_000);
    assert.equal((await h.m.check()).reload, true);
    h.state.mb = 700;                                  // the reload frees the memory
    h.m.pageLoaded(); h.settle(); h.state.mb = 1800; h.advance(60_000);
    assert.equal((await h.m.check()).reason, 'reloaded recently');
});

test('a destroyed window or missing metrics is a quiet no-op', async () => {
    const h = harness();
    h.m.pageLoaded(); h.settle(); h.win.destroyed = true;
    assert.equal((await h.m.check()).reason, 'no window or metrics');
    const h2 = harness({ rendererMb: () => null });
    assert.equal((await h2.m.check()).reason, 'no window or metrics');
});
