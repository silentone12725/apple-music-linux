// Apple Account sheet: sign-in for lossless (FairPlay) and the 6-digit
// verification code, in one modal sheet styled after macOS's own Apple Account
// sheets. It is a modal <dialog>, so it stacks above the Settings dialog (also
// modal, in the browser's top layer) instead of hiding behind it.
import { CODE_LENGTH, spreadDigits, promptAction } from './verification-code.js';

const ACCENT = '#fc3c44'; // Adam's control accent (Settings UI rule)

const STYLE = `
#adam-account{width:380px;max-width:calc(100vw - 32px);box-sizing:border-box;padding:0;border:0;border-radius:12px;
  background:rgba(43,43,45,.97);color:rgba(255,255,255,.88);overflow:hidden;
  box-shadow:0 0 0 .5px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.08) inset,0 22px 70px rgba(0,0,0,.55);
  font:13px/1.38 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",system-ui,sans-serif;
  -webkit-font-smoothing:antialiased}
#adam-account[open]{animation:adamSheetIn .2s ease-out}
#adam-account::backdrop{background:rgba(0,0,0,.32)}
#adam-account .body{padding:22px 22px 18px;display:flex;flex-direction:column;align-items:center;text-align:center}
#adam-account .app-icon{width:56px;height:56px;margin-bottom:12px;filter:drop-shadow(0 2px 6px rgba(0,0,0,.35))}
#adam-account h1{margin:0;font:600 15px/1.3 -apple-system,BlinkMacSystemFont,"SF Pro Display",system-ui,sans-serif;color:#fff}
#adam-account .sub{margin:4px 0 16px;max-width:300px;font-size:12px;color:rgba(235,235,245,.6)}
#adam-account .group{align-self:stretch;border-radius:7px;background:rgba(0,0,0,.22);
  box-shadow:0 0 0 .5px rgba(255,255,255,.14) inset;text-align:left;overflow:hidden}
#adam-account .group input{display:block;width:100%;box-sizing:border-box;height:30px;padding:0 10px;border:0;margin:0;
  background:transparent;color:#fff;font:13px -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;outline:none}
#adam-account .group .pw{position:relative;border-top:.5px solid rgba(255,255,255,.12)}
#adam-account .group .pw input{padding-right:34px}
#adam-account .group button.eye{position:absolute;top:3px;right:4px;min-width:0;width:24px;height:24px;padding:0;border-radius:5px;
  background:transparent;box-shadow:none;color:rgba(235,235,245,.45)}
#adam-account .group button.eye:hover{color:rgba(235,235,245,.8)}
#adam-account .group button.eye[aria-pressed="true"]{color:${ACCENT}}
#adam-account .group button.eye svg{width:16px;height:16px}
#adam-account .group input::placeholder{color:rgba(235,235,245,.3)}
#adam-account .group input:disabled{color:rgba(255,255,255,.45)}
#adam-account .note{align-self:stretch;margin:8px 2px 0;font-size:11px;color:rgba(235,235,245,.38);text-align:left}
#adam-account .msg{align-self:stretch;min-height:16px;margin:8px 0 0;font-size:12px;color:rgba(235,235,245,.6)}
#adam-account .msg.err{color:#ff6961}
#adam-account .msg button.link{min-width:0;height:auto;padding:0;background:none;box-shadow:none;color:#ff9a94;text-decoration:underline;cursor:pointer;font:inherit}
#adam-account .remember{display:flex;align-items:center;gap:6px;align-self:flex-start;margin:10px 2px 0;font-size:12px;color:rgba(235,235,245,.6)}
#adam-account .remember input{accent-color:#fc3c44;margin:0}
#adam-account .digits{display:flex;gap:7px;align-items:center;justify-content:center;margin:2px 0 0}
#adam-account .digits .sep{width:8px;height:1px;background:rgba(255,255,255,.25);margin:0 2px}
#adam-account .digits input{width:38px;height:46px;box-sizing:border-box;padding:0;border:0;border-radius:7px;text-align:center;
  background:rgba(0,0,0,.22);box-shadow:0 0 0 .5px rgba(255,255,255,.14) inset;color:#fff;caret-color:${ACCENT};
  font:500 22px/1 -apple-system,BlinkMacSystemFont,"SF Pro Rounded","SF Pro Display",system-ui,sans-serif;
  font-variant-numeric:tabular-nums;outline:none}
#adam-account .digits input:disabled{opacity:.55}
#adam-account.shake .digits{animation:adamShake .4s}
#adam-account .code-links{margin:10px 0 0;display:flex;align-items:center;gap:6px;font-size:12px;color:rgba(235,235,245,.5)}
#adam-account .code-links button.link-sm{min-width:0;height:auto;padding:0;background:none;box-shadow:none;color:rgba(235,235,245,.55);text-decoration:underline;cursor:pointer;font:inherit}
#adam-account .code-links button.link-sm:hover{color:rgba(235,235,245,.8)}
#adam-account .choice-list{align-self:stretch;display:flex;flex-direction:column;gap:6px;margin:4px 0 0}
#adam-account .choice-list button{width:100%;justify-content:flex-start;text-align:left;padding:0 12px;height:36px;border-radius:8px;font-size:13px}
#adam-account .phone-opts{align-self:stretch;display:flex;flex-direction:column;align-items:flex-start;gap:6px;margin:8px 0 0;padding:8px 10px;background:rgba(255,255,255,.06);border-radius:8px}
#adam-account .phone-opts button:not(.link-sm){width:100%;justify-content:flex-start;text-align:left;padding:0 10px;height:34px;border-radius:7px;font-size:13px}
#adam-account .phone-opts .link-sm{align-self:center;margin-top:2px}
#adam-account .bar{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px 14px;
  border-top:.5px solid rgba(255,255,255,.08);background:rgba(255,255,255,.02)}
#adam-account button{min-width:76px;height:24px;padding:0 12px;border:0;border-radius:6px;cursor:default;
  display:inline-flex;align-items:center;justify-content:center;gap:6px;
  font:13px -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;color:#fff;
  background:rgba(255,255,255,.14);box-shadow:0 .5px 0 rgba(255,255,255,.08) inset,0 1px 1.5px rgba(0,0,0,.25)}
#adam-account button.primary{background:${ACCENT};box-shadow:0 .5px 0 rgba(255,255,255,.25) inset,0 1px 1.5px rgba(0,0,0,.3)}
#adam-account button:disabled{opacity:.45}
#adam-account button{outline:none}
#adam-account .spin{width:11px;height:11px;border-radius:50%;border:1.5px solid rgba(255,255,255,.35);border-top-color:#fff;
  animation:adamSpin .8s linear infinite}
@keyframes adamSheetIn{from{opacity:0;transform:translateY(-8px) scale(.98)}}
@keyframes adamShake{0%,100%{transform:none}20%,60%{transform:translateX(-7px)}40%,80%{transform:translateX(7px)}}
@keyframes adamSpin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){#adam-account[open],#adam-account.shake .digits,#adam-account .spin{animation:none}}
`;

// App-style icon: a red rounded square with a beamed note, in the Apple Music icon idiom.
const APP_ICON = `<svg class="app-icon" viewBox="0 0 56 56" aria-hidden="true">
<defs><linearGradient id="adamIconBg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fb5c74"/><stop offset="1" stop-color="#fa233b"/></linearGradient></defs>
<rect width="56" height="56" rx="12.5" fill="url(#adamIconBg)"/>
<path fill="#fff" d="M37.6 13.2v20.6c0 2.9-2.1 5-5 5.4-2.4.3-4.3-1-4.3-3.1 0-1.9 1.4-3.3 3.6-3.8l2.4-.5c.8-.2 1.2-.7 1.2-1.5V20.4l-12 2.5v14.6c0 2.9-2.1 5-5 5.4-2.4.3-4.3-1-4.3-3.1 0-1.9 1.4-3.3 3.6-3.8l2.4-.5c.8-.2 1.2-.7 1.2-1.5V18.2c0-1 .6-1.6 1.6-1.8l13.1-2.8c.9-.2 1.5.4 1.5 1.3z"/>
</svg>`;

// SF Symbols-style eye / eye.slash for the show-password button.
const EYE = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2.2"/></svg>`;
const EYE_SLASH = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2.2"/><path d="M2.5 2.5l11 11"/></svg>`;
const REVEAL_MS = 8000; // the password hides itself again after this long

function el(doc, tag, props = {}, ...children) {
    const n = doc.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === 'class') n.className = v;
        else if (k in n) n[k] = v;
        else n.setAttribute(k, v);
    }
    n.append(...children);
    return n;
}

/**
 * Create the sheet. `signIn(email, password, remember)` resolves to { ok, error };
 * `submitCode(code)` resolves to true when the engine accepted the code;
 * `onDone()` runs after sign-in finishes; `onCancel()` runs when the user cancels a
 * sign-in the engine is already running (waiting for Apple or for the code), so it can
 * be stopped. `savedEmail()` gives the account signed in before (pre-fills the form); `openUrl(url)`
 * opens a help link. Feed DRM snapshots to `onSnapshot`. `fetchSnapshot()` (optional) reads the current
 * snapshot; while the sheet is open it is polled, so an outcome whose event was missed (a dropped
 * event stream) still ends the "Signing In…" wait.
 */
export function createAccountSheet({ signIn, submitCode, onDone = () => {}, onCancel = () => {}, fetchSnapshot = null, pollMs = 4000, savedEmail = async () => '', openUrl = () => {}, doc = globalThis.document }) {
    let dlg = null, view = null, busy = false, poll = null, remember = null;
    let challengeId = null, submittedId = null, dismissedId = null;
    let inputs = [], msg = null, primary = null;
    let hidePassword = () => {};

    function ensureDialog() {
        if (dlg) return dlg;
        if (!doc.getElementById('adam-account-style')) {
            doc.head.appendChild(el(doc, 'style', { id: 'adam-account-style', textContent: STYLE }));
        }
        dlg = el(doc, 'dialog', { id: 'adam-account', 'aria-labelledby': 'adam-account-title' });
        dlg.addEventListener('cancel', (e) => { e.preventDefault(); cancel(); }); // Esc
        doc.body.appendChild(dlg);
        return dlg;
    }

    function setMessage(text, isError = false, failure = null) {
        if (!msg) return;
        msg.textContent = text;
        msg.className = isError ? 'msg err' : 'msg';
        if (failure?.url) {
            // Where the problem is fixed (reset a password, accept terms): one click away.
            const host = new URL(failure.url).host;
            const link = el(doc, 'button', { type: 'button', class: 'link' }, `Open ${host}`);
            link.addEventListener('click', () => openUrl(failure.url));
            msg.append(' ', link);
        }
    }

    function setBusy(on, label) {
        busy = on;
        for (const i of inputs) i.disabled = on;
        if (!primary) return;
        primary.disabled = on || !ready();
        primary.replaceChildren(...(on ? [el(doc, 'span', { class: 'spin' }), label] : [primary.dataset.label]));
    }

    function ready() {
        if (view === 'signin') return inputs[0]?.value.trim() && inputs[1]?.value;
        if (view === 'choice') return true;
        return inputs.map(i => i.value).join('').length === CODE_LENGTH;
    }

    function render(header, content, buttons) {
        ensureDialog();
        const body = el(doc, 'div', { class: 'body' });
        body.insertAdjacentHTML('beforeend', APP_ICON);
        body.append(...header, ...content);
        dlg.replaceChildren(body, el(doc, 'div', { class: 'bar' }, ...buttons));
        if (!dlg.open) dlg.showModal();
    }

    function button(label, { isPrimary = false, onClick }) {
        const b = el(doc, 'button', { type: 'button', class: isPrimary ? 'primary' : '' }, label);
        b.dataset.label = label;
        b.addEventListener('click', onClick);
        return b;
    }

    function showSignIn(error = '', { email: knownEmail = '', failure = null } = {}) {
        view = 'signin';
        busy = false;
        const email = el(doc, 'input', { type: 'email', placeholder: 'Email or Phone Number', autocomplete: 'username', spellcheck: false, value: knownEmail });
        const pass = el(doc, 'input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
        inputs = [email, pass];
        const eye = el(doc, 'button', { type: 'button', class: 'eye', 'aria-label': 'Show password', 'aria-pressed': 'false' });
        let revealTimer = null;
        const reveal = (on) => {
            clearTimeout(revealTimer);
            pass.type = on ? 'text' : 'password';
            eye.setAttribute('aria-pressed', String(on));
            eye.setAttribute('aria-label', on ? 'Hide password' : 'Show password');
            eye.innerHTML = on ? EYE_SLASH : EYE;
            if (on) revealTimer = setTimeout(() => reveal(false), REVEAL_MS);
        };
        reveal(false);
        eye.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus (and the caret) in the field
        eye.addEventListener('click', () => reveal(pass.type === 'password'));
        hidePassword = () => reveal(false);
        msg = el(doc, 'div', { class: 'msg', 'aria-live': 'polite' });
        remember = el(doc, 'input', { type: 'checkbox', id: 'adam-account-remember' });
        const rememberRow = el(doc, 'label', { class: 'remember', htmlFor: 'adam-account-remember' }, remember, ' Remember password on this computer');
        primary = button('Sign In', { isPrimary: true, onClick: submitSignIn });
        render(
            [el(doc, 'h1', { id: 'adam-account-title' }, knownEmail ? 'Sign-In Required' : 'Sign in with your Apple Account'),
             el(doc, 'div', { class: 'sub' }, knownEmail
                 ? `Enter the password for your Apple Account ${knownEmail}.`
                 : "Lossless and Hi-Res Lossless use Apple’s FairPlay, which needs its own sign-in.")],
            [el(doc, 'div', { class: 'group' }, email, el(doc, 'div', { class: 'pw' }, pass, eye)),
             rememberRow,
             el(doc, 'div', { class: 'note' }, 'Your password is sent only to Apple. Unless you tick the box, it is not kept on this computer.'),
             msg],
            [button('Cancel', { onClick: cancel }), primary],
        );
        for (const i of inputs) {
            i.addEventListener('input', () => { primary.disabled = busy || !ready(); setMessage(''); });
            i.addEventListener('keydown', (e) => { if (e.key === 'Enter' && ready()) submitSignIn(); });
        }
        primary.disabled = !ready();
        if (error) setMessage(error, true, failure);
        (knownEmail ? pass : email).focus();
    }

    async function submitSignIn() {
        if (busy || !ready()) return;
        hidePassword();
        setMessage('');
        setBusy(true, 'Signing In…');
        let res;
        try { res = await signIn(inputs[0].value.trim(), inputs[1].value, !!remember?.checked); }
        catch (e) { res = { ok: false, error: e?.message }; }
        if (view !== 'signin') return; // moved on to the code meanwhile
        if (!res?.ok) { setBusy(false); setMessage(res?.error || 'Could not sign in. Try again.', true); }
        // ok: stay busy until the engine asks for the code or reports FairPlay ready
        else startPoll();
    }

    function showCode() {
        view = 'code';
        busy = false;
        const fields = el(doc, 'div', { class: 'digits' });
        inputs = [];
        for (let i = 0; i < CODE_LENGTH; i++) {
            if (i === CODE_LENGTH / 2) fields.appendChild(el(doc, 'span', { class: 'sep', 'aria-hidden': 'true' }));
            const inp = el(doc, 'input', {
                type: 'text', inputMode: 'numeric', maxLength: CODE_LENGTH,
                autocomplete: i === 0 ? 'one-time-code' : 'off', 'aria-label': `Digit ${i + 1} of ${CODE_LENGTH}`,
            });
            inp.addEventListener('input', () => fill(i, inp.value));
            inp.addEventListener('paste', (e) => { e.preventDefault(); fill(i, e.clipboardData?.getData('text') ?? ''); });
            inp.addEventListener('keydown', (e) => {
                if (e.key === 'Backspace' && !inp.value && i > 0) { inputs[i - 1].value = ''; inputs[i - 1].focus(); e.preventDefault(); }
                else if (e.key === 'ArrowLeft' && i > 0) { inputs[i - 1].focus(); e.preventDefault(); }
                else if (e.key === 'ArrowRight' && i < CODE_LENGTH - 1) { inputs[i + 1].focus(); e.preventDefault(); }
                else if (e.key === 'Enter') submitCodeNow();
            });
            inputs.push(inp);
            fields.appendChild(inp);
        }
        msg = el(doc, 'div', { class: 'msg', 'aria-live': 'polite' });
        const resendBtn = el(doc, 'button', { type: 'button', class: 'link-sm' }, 'Resend code');
        resendBtn.addEventListener('click', () => submitSpecialCode('__resend__', 'Resending…'));
        const cantBtn = el(doc, 'button', { type: 'button', class: 'link-sm' }, "Can’t get to your devices?");
        const codeLinks = el(doc, 'div', { class: 'code-links' }, resendBtn, '·', cantBtn);
        let phoneOptsEl = null;
        function closePhoneOpts() { phoneOptsEl?.remove(); phoneOptsEl = null; }
        cantBtn.addEventListener('click', () => {
            if (phoneOptsEl) { closePhoneOpts(); return; }
            if (busy) return;
            phoneOptsEl = el(doc, 'div', { class: 'phone-opts' });
            const smsBtn = button('Text me a verification code', {
                onClick: () => { closePhoneOpts(); submitSpecialCode('__cant_devices__', 'Sending SMS…'); },
            });
            const cancelLink = el(doc, 'button', { type: 'button', class: 'link-sm' }, 'Cancel');
            cancelLink.addEventListener('click', closePhoneOpts);
            phoneOptsEl.append(smsBtn, cancelLink);
            codeLinks.after(phoneOptsEl);
        });
        primary = button('Continue', { isPrimary: true, onClick: submitCodeNow });
        render(
            [el(doc, 'h1', { id: 'adam-account-title' }, 'Enter Verification Code'),
             el(doc, 'div', { class: 'sub' }, 'A verification code was sent to your other devices. Enter it to continue.')],
            [fields, msg, codeLinks,
             el(doc, 'div', { class: 'note' }, 'No code? Apple shows it on your other devices signed in to this Apple Account, and a code can also be read in Settings > your name > Sign-In & Security on an iPhone or iPad.')],
            [button('Cancel', { onClick: cancel }), primary],
        );
        primary.disabled = true;
        inputs[0].focus();
    }

    function fill(index, text) {
        const { digits, focus } = spreadDigits(inputs.map(i => i.value), index, text);
        digits.forEach((d, i) => { inputs[i].value = d || ''; });
        inputs[focus].focus();
        primary.disabled = busy || !ready();
        if (ready()) submitCodeNow();
    }

    async function submitCodeNow() {
        if (busy || !ready()) return;
        setMessage('');
        setBusy(true, 'Verifying…');
        // Mark the challenge answered before the request: Apple's re-ask can arrive
        // over SSE before the POST resolves.
        submittedId = challengeId;
        let ok = false;
        try { ok = await submitCode(inputs.map(i => i.value).join('')); } catch { ok = false; }
        if (view !== 'code' || ok) return;
        submittedId = null;
        setBusy(false);
        setMessage('Could not send the code. Try again.', true);
    }

    async function submitSpecialCode(value, busyLabel = 'Sending…') {
        if (busy) return;
        setMessage('');
        setBusy(true, busyLabel);
        // Do not set submittedId: special codes are not verification codes.
        // A new challenge after resend/cant_devices is not a "wrong code" response.
        let ok = false;
        try { ok = await submitCode(value); } catch { ok = false; }
        if (view !== 'code') return; // navigated away (e.g. choice dialog opened)
        if (!ok) { setBusy(false); setMessage('Could not send. Try again.', true); }
        // ok: stay busy — SSE will deliver the new challenge and onSnapshot will refresh
    }

    function showChoice(buttonsStr, title = 'Recovery Options') {
        view = 'choice';
        busy = false;
        inputs = [];
        const btnLabels = (buttonsStr || '').split('\n').filter(Boolean);
        const list = el(doc, 'div', { class: 'choice-list' });
        btnLabels.forEach((label, idx) => {
            const b = button(label, {
                onClick: async () => {
                    if (busy) return;
                    setBusy(true, 'Sending…');
                    submittedId = challengeId;
                    try { await submitCode(String(idx)); } catch { /* ignore */ }
                    // engine will continue the sign-in flow; onSnapshot will drive next view
                },
            });
            list.appendChild(b);
        });
        msg = el(doc, 'div', { class: 'msg', 'aria-live': 'polite' });
        primary = null;
        render(
            [el(doc, 'h1', { id: 'adam-account-title' }, title),
             el(doc, 'div', { class: 'sub' }, 'Choose how to receive your verification code.')],
            [list, msg],
            [button('Cancel Sign-In', { onClick: cancel })],
        );
    }

    function wrongCode() {
        submittedId = null;
        setBusy(false);
        for (const i of inputs) i.value = '';
        primary.disabled = true;
        inputs[0]?.focus();
        setMessage('Incorrect code. Enter the new code sent to your devices.', true);
        dlg.classList.remove('shake'); void dlg.offsetWidth; dlg.classList.add('shake');
    }

    function stopPoll() { clearInterval(poll); poll = null; }
    function startPoll() {
        if (!fetchSnapshot || poll) return;
        poll = setInterval(async () => {
            if (view === null) return stopPoll();
            try { const s = await fetchSnapshot(); if (s && view !== null) onSnapshot(s); } catch { /* engine unreachable: keep waiting */ }
        }, pollMs);
    }

    function close() {
        stopPoll();
        hidePassword();
        if (dlg?.open) dlg.close();
        view = null; busy = false; submittedId = null; inputs = []; msg = null; primary = null;
    }

    function cancel() {
        const running = view === 'code' || view === 'choice' || (view === 'signin' && busy);
        if (view === 'code' || view === 'choice') dismissedId = challengeId;
        close();
        if (running) onCancel();
    }

    function onSnapshot(snap) {
        const action = promptAction(snap, { open: view !== null, view, submittedId, dismissedId, challengeId });
        if (snap?.challenge?.type === 'two_factor' || snap?.challenge?.type === 'dialog_choice') {
            challengeId = snap.challenge.id ?? null;
        }
        switch (action) {
            case 'code': showCode(); break;
            case 'choice': {
                const ch = snap?.challenge;
                showChoice(ch?.metadata?.buttons ?? '', ch?.title || 'Recovery Options');
                break;
            }
            case 'retry': wrongCode(); break;
            case 'close': close(); onDone(); break;
            case 'expired':
                showSignIn(snap?.failure?.message || snap?.message || 'The sign-in ended before the code was accepted. Sign in again.', { failure: snap?.failure });
                break;
            case 'failed':
                if (!busy) break; // a stale failure from an earlier attempt, nothing submitted now
                if (view === 'signin') { setBusy(false); setMessage(snap?.failure?.message || snap?.message || 'Could not sign in. Check your Apple Account and password.', true, snap?.failure); }
                else showSignIn(snap?.failure?.message || snap?.message || 'Sign-in failed. Try again.', { failure: snap?.failure });
                break;
        }
    }

    async function openSignIn() {
        let email = '';
        try { email = (await savedEmail()) || ''; } catch { /* no saved account: plain form */ }
        showSignIn('', { email });
    }

    return { openSignIn, onSnapshot, close, isOpen: () => view !== null };
}
