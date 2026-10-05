// Playback mode handoff rules. A track plays through one of three paths and each
// owns a different player: music video (its own pipeline), AAC (MSE on the page's
// audio element) and ALAC (libvlc in the engine). Releasing an engine session
// does not stop libvlc, so leaving the ALAC path has to stop it explicitly or the
// previous track keeps playing under the new one.

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
