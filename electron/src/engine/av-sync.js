// Keeping a music video's picture in step with its sound.
//
// Audio is the master clock here, so the correction goes on the video. Seeking the audio element to chase the video
// is audible, and it feeds itself: the seek leaves the audio stalled for a moment, the picture moves on, the drift is
// over the threshold again and the next seek follows. Logs of that showed a seek about every half second for ten
// seconds, heard as crackle. A small drift is closed by running the video slightly slower or faster instead, and only a
// large one is snapped, rarely.
export const AV_DEADBAND_S    = 0.04;  // inside this, in sync
export const AV_MAX_RATE_DELTA = 0.06; // at most 6% faster or slower, which is not noticeable
export const AV_RATE_GAIN     = 0.25;  // rate change per second of drift
export const AV_SNAP_DRIFT_S  = 1.5;   // beyond this a rate change takes too long: seek the audio
export const AV_SNAP_COOLDOWN_MS = 3000;

// driftSec is audio time minus video time: negative means the audio is behind. Returns what to do about it:
//   { action: 'none',  rate: 1 }      in sync
//   { action: 'rate',  rate }         set the video's playbackRate
//   { action: 'snap',  rate: 1 }      seek the audio to the video
export function avSyncAction({ driftSec, sinceSnapMs }) {
    const d = Math.abs(driftSec);
    if (!Number.isFinite(driftSec) || d < AV_DEADBAND_S) return { action: 'none', rate: 1 };
    if (d > AV_SNAP_DRIFT_S && sinceSnapMs > AV_SNAP_COOLDOWN_MS) return { action: 'snap', rate: 1 };
    const delta = Math.max(-AV_MAX_RATE_DELTA, Math.min(AV_MAX_RATE_DELTA, driftSec * AV_RATE_GAIN));
    return { action: 'rate', rate: 1 + delta };
}
