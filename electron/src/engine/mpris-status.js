/**
 * Reconcile an MPRIS status from authoritative VLC playback observations.
 *
 * MusicKit can emit "playing" while VLC is still opening, at position zero.
 * When that event is skipped, MusicKit doesn't always emit a second state
 * change after VLC starts decoding. This guard lets the regular VLC poll
 * recover a stale "Stopped" / "Paused" MPRIS status without inventing playback
 * while an initial load, transport seek, or explicit pause is in progress.
 */
export function reconcileVlcMprisStatus({
    state,
    positionMs,
    reportedStatus,
    paused,
    loading,
    seeking,
}) {
    if (loading || seeking || !Number.isFinite(positionMs) || positionMs <= 0) {
        return null;
    }
    if (state === 'playing' && !paused && reportedStatus !== 'Playing') {
        return 'Playing';
    }
    if (state === 'paused' && paused && reportedStatus === 'Playing') {
        return 'Paused';
    }
    return null;
}
