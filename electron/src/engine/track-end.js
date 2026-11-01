// The audio that will actually play decides where a track ends, not the length MusicKit reported. A track whose data is
// shorter must not be followed by a pause waiting for the missing seconds, and one whose data is longer must not be cut
// off, faded out early or stopped at the reported length. The engine already reports the stream's own length; these
// cover what it cannot know ahead of time.
export const LENGTH_TOLERANCE_S = 1;

// The length to plan fades and the next-track prefetch against. Once the browser knows the real end of the buffered
// stream (its MediaSource has ended) that is the element's own duration; until then the reported one is the best guess.
export function actualDurationSec({ elementDurationSec, streamComplete, reportedSec }) {
    if (streamComplete && Number.isFinite(elementDurationSec) && elementDurationSec > 0) return elementDurationSec;
    return reportedSec;
}

// True when a measured length differs from the one in use by more than rounding and padding.
export function lengthDiffers(measuredSec, currentSec) {
    return Number.isFinite(measuredSec) && measuredSec > 0 && Math.abs(measuredSec - currentSec) > LENGTH_TOLERANCE_S;
}

// Playback has run past the length in use, so the audio is longer than reported: the length grows to the position
// instead of the track being treated as finished (or cut) at the old length.
export function lengthAfterOverrun(positionSec, currentSec) {
    if (!(currentSec > 0)) return currentSec;
    return positionSec > currentSec + LENGTH_TOLERANCE_S ? positionSec : currentSec;
}
