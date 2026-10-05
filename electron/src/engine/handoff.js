// Playback mode handoff rules. A track plays through one of three paths and each
// owns a different player: music video (its own pipeline), AAC (MSE on the page's
// audio element) and ALAC (libvlc in the engine). Releasing an engine session
// does not stop libvlc, so leaving the ALAC path has to stop it explicitly or the
// previous track keeps playing under the new one. libvlc liveness is tracked by the
// caller (not derived at reset time) so a track change that is superseded before it
// reaches the stop cannot lose the obligation to stop it.

/** @returns {'mv'|'aac'|'alac'} the path an engine session plays through. */
export function playbackMode(sess) {
    if (sess?.capabilities?.video) return 'mv';
    return sess?.codec === 'aac' ? 'aac' : 'alac';
}

/** libvlc must be stopped when the previous track used it and the next does not.
 *  ALAC to ALAC is excluded: the next vlc/load replaces the media without a gap. */
export function needsVlcStop(prevMode, nextMode) {
    return prevMode === 'alac' && nextMode !== 'alac';
}

/**
 * Stop libvlc when leaving the lossless path and wait for the engine to confirm.
 * The engine's stop is synchronous (the HTTP reply comes after libvlc stopped), so
 * awaiting it orders "old track silent" before "new track starts". Never rejects:
 * a failed or timed-out stop is reported through `ok` and the caller carries on.
 * @param {{live: boolean, nextMode: string, stop: () => Promise<unknown>, timeoutMs?: number}} o
 * @returns {Promise<{stopped: boolean, ok: boolean}>}
 */
export async function leaveLossless({ live, nextMode, stop, timeoutMs = 2000 }) {
    if (!needsVlcStop(live ? 'alac' : null, nextMode)) return { stopped: false, ok: true };
    let timer;
    const timeout = new Promise(res => { timer = setTimeout(() => res(false), timeoutMs); });
    try {
        const ok = await Promise.race([Promise.resolve().then(stop).then(() => true), timeout]);
        return { stopped: true, ok };
    } catch (_) {
        return { stopped: true, ok: false };
    } finally {
        clearTimeout(timer);
    }
}
