// Pure helpers for the Apple Account sheet (account-sheet.js): verification-code
// entry and how the sheet reacts to engine DRM snapshots. When Apple's FairPlay
// sign-in needs the 6-digit code, the engine raises a "two_factor" challenge
// (SSE snapshot) and blocks until the code is posted to /api/v1/drm/challenge.

export const CODE_LENGTH = 6;

/** Keep only digits, at most CODE_LENGTH of them (paste, autofill, typing). */
export function normalizeCode(text) {
    return String(text ?? '').replace(/\D/g, '').slice(0, CODE_LENGTH);
}

/** Digits to spread across the fields when `text` is typed or pasted into field `index`. */
export function spreadDigits(current, index, text) {
    const digits = normalizeCode(text);
    const next = current.slice();
    for (let i = 0; i < digits.length && index + i < CODE_LENGTH; i++) next[index + i] = digits[i];
    const focus = Math.min(index + digits.length, CODE_LENGTH - 1);
    return { digits: next, focus };
}

/**
 * What the account sheet should do with an engine DRM snapshot.
 *   'code'   show the code entry (Apple asked for the verification code)
 *   'retry'  Apple asked again after a submit: the code was wrong
 *   'close'  FairPlay is ready, sign-in finished
 *   'failed' sign-in failed
 *   'expired' sign-in failed while the code was still being asked for (Apple or the
 *            engine gave up waiting): back to the sign-in form, the code can no longer be sent
 * Snapshots keep a pending challenge until sign-in moves on, so challenges are
 * told apart by ID, and a challenge the user cancelled is not reopened.
 */
export function promptAction(snap, { open, view = null, submittedId = null, dismissedId = null }) {
    const st = snap?.state ?? {};
    if (st.fairplay === 'ready' || snap?.capabilities?.cbcs === true || st.authentication === 'logged_in') {
        return open ? 'close' : 'none';
    }
    const ch = snap?.challenge;
    if (ch?.type === 'two_factor') {
        if (!open) return ch.id != null && ch.id === dismissedId ? 'none' : 'code';
        if (view !== 'code') return 'code';
        if (submittedId != null && ch.id !== submittedId) return 'retry';
        return 'none';
    }
    if (st.authentication === 'failed' && open) return view === 'code' ? 'expired' : 'failed';
    return 'none';
}
