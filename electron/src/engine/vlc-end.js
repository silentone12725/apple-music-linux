// What to do when VLC reports the end of a lossless track.
//
// A genuine failure (a read that broke, a stream that never started) is worth one reload at the last position. A track
// whose data simply ends before the length MusicKit reported is not: the reload would hit the same end again, and since
// libvlc restarts on a fragment boundary it replays up to ~15 s of the tail each time. The engine tells the two apart:
// `sourceEof` is true when the source delivered all its bytes and ended cleanly, so an end with it set is the real end.
export const VLC_MAX_RETRIES = 2;

export function classifyVlcEnd({ posMs, trackEndMs, reason, retryCount, sourceEof, sourceFailed = false }) {
    // The stream failed before delivering anything.
    if (posMs < 2000 && trackEndMs > 5000 && retryCount < VLC_MAX_RETRIES) {
        return { action: 'retry', fromMs: 0, delayMs: 1500 };
    }
    // A byte EOF alone does not prove successful decoding. Only tolerate a
    // decoder error at the tail, with no source failure and a known duration.
    // Cap the 3 s tolerance at 10% for short tracks.
    const decoderTailEnded = reason === 'error' && sourceEof === true && !sourceFailed &&
        posMs > 2000 && trackEndMs > 0 && posMs >= trackEndMs - Math.min(3000, trackEndMs * 0.1);
    if (decoderTailEnded) return { action: 'advance', shortOfReported: false };
    if ((sourceFailed || reason === 'error') && retryCount < VLC_MAX_RETRIES) {
        return { action: 'retry', fromMs: Math.max(0, posMs), delayMs: 500 };
    }
    // A decoded natural end can precede the reported length by one final fragment, padding and the last poll interval.
    // Keep error recovery stricter, and cap the natural window at 10% so short tracks do not lose a large part to an
    // early end.
    const endWindowMs = reason === 'error' ? 3000 : Math.min(10000, trackEndMs * 0.1);
    const shortOfEnd = posMs > 2000 && trackEndMs > 5000 && posMs < trackEndMs - endWindowMs;
    // A clean end of the data is the real end however far it is from the reported length. An error is never taken as one.
    const dataEnded = sourceEof === true && reason !== 'error';
    if (shortOfEnd && !dataEnded && retryCount < VLC_MAX_RETRIES) {
        return { action: 'retry', fromMs: posMs, delayMs: 500 };
    }
    // Exhausted load/read failures stay on this track. Advancing here can
    // consume the entire queue while no audio source is playable.
    if (sourceFailed || reason === 'error' || (shortOfEnd && !dataEnded) ||
        (posMs < 2000 && trackEndMs > 5000)) return { action: 'stop' };
    return { action: 'advance', shortOfReported: shortOfEnd && dataEnded };
}
