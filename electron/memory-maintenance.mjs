// Idle memory maintenance for the Apple Music page.
//
// Apple's web player keeps the detached DOM of every page you leave (tiles, artwork, SVG icons)
// reachable from its component scopes, so the renderer grows by roughly 300 MB per pass over the
// sidebar and never gives it back; a reload releases all of it (measured: 1.7 GB -> 0.27 GB).
// The page is Apple's, so the fix is to reload it, but only when nobody can notice:
//   - the window is hidden or minimized (or has been unfocused for a long time),
//   - nothing is playing,
//   - no dialog (settings, sign-in, Apple's own) is open,
//   - the renderer is far above what it used after loading.
// The Resume chip then waits for the user instead of disappearing after 20 s.

const MB = 1024 * 1024;

export const DEFAULTS = {
    floorMb: 1200,            // never reload below this renderer size
    growthMb: 600,            // ...and only when this far above the size right after loading
    idleHiddenMs: 2 * 60_000,   // hidden/minimized for this long
    idleVisibleMs: 15 * 60_000, // visible but unfocused for this long
    minIntervalMs: 10 * 60_000, // between two reloads
    quietAfterPlayMs: 60_000,   // playback must have been off this long (a pause between tracks is not idle)
    settleMs: 45_000,         // after a load, measure the baseline this much later
    checkMs: 60_000,
};

// Pure decision. Returns { reload: boolean, reason: string }.
export function decide(s, cfg = DEFAULTS) {
    if (!s.enabled) return { reload: false, reason: 'disabled' };
    if (!s.onApplePage) return { reload: false, reason: 'not on the Apple Music page' };
    if (s.baselineMb == null) return { reload: false, reason: 'baseline not measured yet' };
    if (s.rendererMb < Math.max(cfg.floorMb, s.baselineMb + cfg.growthMb)) return { reload: false, reason: 'memory below threshold' };
    if (s.playing) return { reload: false, reason: 'playing' };
    if ((s.sincePlayingMs ?? Infinity) < cfg.quietAfterPlayMs) return { reload: false, reason: 'played recently' };
    if (s.focused) return { reload: false, reason: 'window focused' };
    const need = s.hiddenOrMinimized ? cfg.idleHiddenMs : cfg.idleVisibleMs;
    if (s.inactiveForMs < need) return { reload: false, reason: 'not idle long enough' };
    if (s.sinceLastReloadMs < cfg.minIntervalMs) return { reload: false, reason: 'reloaded recently' };
    return { reload: true, reason: 'idle and memory high' };
}

export function readConfigFromEnv(env = process.env) {
    const num = (k, scale, d) => { const v = Number(env[k]); return Number.isFinite(v) && v > 0 ? v * scale : d; };
    return {
        floorMb: num('ADAM_MEM_FLOOR_MB', 1, DEFAULTS.floorMb),
        growthMb: num('ADAM_MEM_GROWTH_MB', 1, DEFAULTS.growthMb),
        idleHiddenMs: num('ADAM_MEM_IDLE_S', 1000, DEFAULTS.idleHiddenMs),
        idleVisibleMs: num('ADAM_MEM_IDLE_VISIBLE_S', 1000, DEFAULTS.idleVisibleMs),
        minIntervalMs: num('ADAM_MEM_MIN_INTERVAL_S', 1000, DEFAULTS.minIntervalMs),
        quietAfterPlayMs: num('ADAM_MEM_QUIET_S', 1000, DEFAULTS.quietAfterPlayMs),
        settleMs: num('ADAM_MEM_SETTLE_S', 1000, DEFAULTS.settleMs),
        checkMs: num('ADAM_MEM_CHECK_S', 1000, DEFAULTS.checkMs),
    };
}

/**
 * Wires the decision to a window. Everything electron-specific comes in through `deps` so the
 * timing and the sequence of steps can be tested without electron.
 *
 * deps: getWin() -> window|null, rendererMb() -> number|null (working set of the page's process),
 *       isPlaying() -> boolean, msSincePlaying() -> ms since playback last stopped (Infinity if never), onApplePage() -> boolean, dialogOpen() -> Promise<boolean>,
 *       isEnabled() -> Promise<boolean>, markReload() -> Promise<void>, flushRenderer() -> Promise<void>,
 *       reload() -> void, now, setTimeout, setInterval, log
 */
export function createMemoryMaintenance(deps, cfg = DEFAULTS) {
    const now = deps.now ?? Date.now;
    const log = deps.log ?? (() => {});
    const setT = deps.setTimeout ?? setTimeout;
    const setI = deps.setInterval ?? setInterval;
    let baselineMb = null;
    let baselineTimer = null;
    let inactiveSince = now();   // the window starts unfocused until a focus event says otherwise
    let lastReloadAt = -Infinity;
    let busy = false;
    let timer = null;
    let reloading = false;

    function windowState() {
        const win = deps.getWin();
        if (!win || win.isDestroyed?.()) return null;
        return { focused: win.isFocused(), hiddenOrMinimized: !win.isVisible() || win.isMinimized() };
    }

    // Call on focus / show / restore (active) and blur / hide / minimize (inactive).
    function setActive(active) { inactiveSince = active ? null : (inactiveSince ?? now()); }

    // Call after every load of the page: measure the size it settles at.
    function pageLoaded() {
        baselineMb = null;
        reloading = false;
        clearTimeout(baselineTimer);
        baselineTimer = setT(() => { baselineMb = deps.rendererMb(); }, cfg.settleMs);
        baselineTimer.unref?.();
    }

    async function check() {
        if (busy || reloading) return { reload: false, reason: 'busy' };
        busy = true;
        try {
            const w = windowState();
            const mb = deps.rendererMb();
            if (!w || mb == null) return { reload: false, reason: 'no window or metrics' };
            const state = {
                enabled: await deps.isEnabled(),
                onApplePage: deps.onApplePage(),
                baselineMb, rendererMb: mb,
                playing: deps.isPlaying(),
                sincePlayingMs: deps.msSincePlaying?.() ?? Infinity,
                focused: w.focused, hiddenOrMinimized: w.hiddenOrMinimized,
                inactiveForMs: inactiveSince == null ? 0 : now() - inactiveSince,
                sinceLastReloadMs: now() - lastReloadAt,
            };
            const d = decide(state, cfg);
            if (!d.reload) return d;
            // Last look: a dialog may have opened since the window lost focus (a sign-in waiting for a code).
            if (await deps.dialogOpen()) return { reload: false, reason: 'dialog open' };
            reloading = true;
            lastReloadAt = now();
            log(`Memory maintenance: reloading the page (renderer ${Math.round(mb)} MB, ${Math.round(baselineMb)} MB after load, idle ${Math.round(state.inactiveForMs / 1000)} s)`);
            await deps.markReload();
            await deps.flushRenderer();
            deps.reload();
            return d;
        } finally { busy = false; }
    }

    function start() {
        if (timer) return;
        timer = setI(() => { check().catch(e => log(`Memory maintenance failed: ${e?.message ?? e}`)); }, cfg.checkMs);
        timer.unref?.();
    }
    function stop() { clearInterval(timer); timer = null; clearTimeout(baselineTimer); }

    return { start, stop, check, setActive, pageLoaded, get isReloading() { return reloading; }, get baselineMb() { return baselineMb; } };
}

export const toMb = (kb) => kb * 1024 / MB;
