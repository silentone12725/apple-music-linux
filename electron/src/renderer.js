/**
 * Terminal overlay renderer — injected into world 0 via webContents.executeJavaScript.
 * First launch: user types Apple ID:password in the terminal to authenticate.
 * Subsequent launches: wrapper auto-starts using the stored session DB.
 */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

// Guard against re-injection (e.g. multiple dom-ready fires).
// Use a wrapping block rather than throw so no garbage output is produced.
if (!window.__amlTermMounted) {
window.__amlTermMounted = true;

// ── Styles ──────────────────────────────────────────────────────────────────
// Match pear-desktop's transparent-player approach:
// low-opacity dark background + strong blur lets the page content bleed
// through as frosted glass — same technique, same numbers (~blur(20px), ~50% bg).
const sheet = new CSSStyleSheet();
sheet.replaceSync(`
  #aml-term-overlay {
    position: fixed;
    top: 0; right: 0; bottom: 0;
    width: 480px;
    z-index: 2147483647;
    display: flex;
    flex-direction: column;

    background: rgba(255, 255, 255, 0.96);
    border-left: 1.5px solid rgba(0,0,0,0.08);
    box-shadow: -1px 0 0 rgba(0,0,0,0.04), -24px 0 64px rgba(0,0,0,0.35);
    transform: translateX(100%);
    transition: transform 0.24s cubic-bezier(0.4,0,0.2,1);
  }
  #aml-term-overlay.open { transform: translateX(0); }

  #aml-term-titlebar {
    height: 36px; display: flex; align-items: center;
    justify-content: space-between;
    padding: 0 20px;   /* extra left padding aligns with terminal text indent */
    flex-shrink: 0;
    background: rgba(245, 245, 247, 0.98);
    border-bottom: 1px solid rgba(0,0,0,0.08);
    font: 600 11px -apple-system, BlinkMacSystemFont, sans-serif;
    letter-spacing: 0.05em; color: rgba(0,0,0,0.45);
    user-select: none; text-transform: uppercase;
  }
  #aml-term-close {
    cursor: pointer; color: rgba(0,0,0,0.3); font-size: 13px;
    line-height: 1; padding: 6px; border-radius: 4px;
    transition: color 0.15s, background 0.15s;
  }
  #aml-term-close:hover { color: #fc3c44; background: rgba(252,60,68,0.10); }

  /* Consistent 20px horizontal padding so xterm text lines up with titlebar */
  #aml-term-body {
    flex: 1;
    padding: 10px 20px;
    overflow: hidden;
    min-height: 0;
  }
  #aml-term-overlay .xterm { height: 100%; }
  #aml-term-overlay .xterm-viewport { background: transparent !important; }
  #aml-term-overlay .xterm-screen  { background: transparent !important; }
`);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

// ── DOM ──────────────────────────────────────────────────────────────────────
const overlay = document.createElement('div');
overlay.id = 'aml-term-overlay';

const titlebar = document.createElement('div');
titlebar.id = 'aml-term-titlebar';
titlebar.textContent = 'Wrapper Terminal';
const closeBtn = document.createElement('span');
closeBtn.id = 'aml-term-close';
closeBtn.textContent = '✕';
closeBtn.addEventListener('click', () => setOpen(false));
titlebar.appendChild(closeBtn);

const body = document.createElement('div');
body.id = 'aml-term-body';
overlay.appendChild(titlebar);
overlay.appendChild(body);
document.body.appendChild(overlay);

// ── xterm.js ─────────────────────────────────────────────────────────────────
const term = new Terminal({
    convertEol: true,
    fontSize: 12,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    theme: {
        background: 'rgba(0,0,0,0)',
        foreground: '#1c1c1e', cursor: '#fc3c44',
        cursorAccent: '#ffffff',
        selectionBackground: 'rgba(252,60,68,0.25)',
    },
    cursorBlink: true,
    allowTransparency: true,
    scrollback: 2000,
});

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);

let open = false;
let ready = false;   // term.open() called
let mode = 'idle';   // 'idle' | 'login' | 'running'
let loginBuf = '';
let dataDisposable = null;  // single onData disposable — prevents duplicate listeners

// ── Display helpers ──────────────────────────────────────────────────────────
// White background — use dark colours for text.
const DIM    = '\x1b[38;5;145m'; // medium grey for decorative elements
const RESET  = '\x1b[0m';
const WHITE  = '\x1b[38;5;234m'; // near-black — primary text on white bg
const GREEN  = '\x1b[32m';       // dark green — readable on white
const RED    = '\x1b[31m';       // dark red
const GREY   = '\x1b[38;5;240m'; // mid-grey — secondary text

function showLoginUI() {
    term.clear();
    term.writeln(`${GREY}  wrapper-rootless  -  Apple ID login${RESET}`);
    term.writeln(`${DIM}  ${'-'.repeat(36)}${RESET}`);
    term.writeln('');
    term.writeln(`${WHITE}  No stored session found.${RESET}`);
    term.writeln(`${GREY}  Log in to enable FairPlay lossless decryption.${RESET}`);
    term.writeln('');
    term.writeln(`${WHITE}  Enter your Apple ID and password,${RESET}`);
    term.writeln(`${WHITE}  separated by a colon, then press Enter.${RESET}`);
    term.writeln('');
    term.writeln(`${GREY}  Format   user@icloud.com:MyPassword${RESET}`);
    term.writeln(`${GREY}  Email is shown  ·  password is hidden${RESET}`);
    term.writeln('');
    term.write(`${GREEN}  login ${RESET}`);
}

function showRunningUI(withLogin) {
    term.clear();
    if (withLogin) {
        term.writeln(`${WHITE}  Connecting to Apple servers…${RESET}`);
        term.writeln('');
    }
    term.writeln(`${GREY}  ./wrapper-rootless -H 127.0.0.1${withLogin ? ' -L ***' : ''}${RESET}`);
    term.writeln('');
}

// ── Input handler ─────────────────────────────────────────────────────────────
function attachInput() {
    if (dataDisposable) dataDisposable.dispose();  // prevent duplicates

    dataDisposable = term.onData((data) => {
        if (mode === 'login') {
            if (data === '\r' || data === '\n') {
                const login = loginBuf.trim();
                loginBuf = '';
                term.writeln('');

                if (!login.includes(':')) {
                    term.writeln(`${RED}  Invalid — use email:password${RESET}`);
                    term.writeln('');
                    term.write(`${GREEN}  login${RESET}  `);
                    return;
                }

                mode = 'running';
                showRunningUI(true);
                window.amlBridge.ptyLogin(login);
            } else if (data === '\x7f' || data === '\b') {
                if (loginBuf.length > 0) {
                    loginBuf = loginBuf.slice(0, -1);
                    term.write('\b \b');
                }
            } else if (data >= ' ') {
                const isPassword = loginBuf.includes(':');
                loginBuf += data;
                term.write(isPassword ? `${DIM}•${RESET}` : data);
            }
        } else if (mode === 'running') {
            window.amlBridge.ptyInput(data);
        }
    });
}

// ── Open / close ──────────────────────────────────────────────────────────────
function initTerminal(hasSession) {
    if (!ready) {
        ready = true;
        term.open(body);
        fitAddon.fit();
        attachInput();
    }

    if (hasSession) {
        mode = 'running';
        showRunningUI(false);
        window.amlBridge.ptyStart();
    } else {
        mode = 'login';
        showLoginUI();
    }
}

function resetToLogin() {
    loginBuf = '';
    mode = 'login';
    if (ready) {
        showLoginUI();
    }
}

function setOpen(next) {
    open = next;
    if (open) {
        overlay.classList.add('open');
        if (!ready) {
            window.amlBridge.hasSession().then((has) => initTerminal(has));
        }
        fitAddon.fit();
        window.amlBridge.ptyResize(term.cols, term.rows);
        term.focus();
    } else {
        overlay.classList.remove('open');
    }
}

window.addEventListener('resize', () => {
    if (open) { fitAddon.fit(); window.amlBridge.ptyResize(term.cols, term.rows); }
});

window.amlBridge.onPtyData((data) => term.write(data));
window.amlBridge.onToggle(() => setOpen(!open));
window.amlBridge.onLoggedOut(() => { resetToLogin(); setOpen(true); });

// ── Persist terminal state on wrapper exit ────────────────────────────────────
// Instead of tearing down xterm, leave it mounted and append a restart prompt.
// The user can read the exit output, then press the restart button.
window.amlBridge.onPtyExit((code) => {
    if (!ready) return;
    mode = 'idle';
    term.writeln('');
    term.writeln(`${RED}  Wrapper exited (code ${code}).${RESET}`);
    term.writeln(`${GREY}  Press Restart in the Wrapper menu to relaunch.${RESET}`);
    term.writeln('');
});

// ── Health status in titlebar ─────────────────────────────────────────────────
const STATUS_ICON = { running: '🟢', starting: '🟡', offline: '🔴' };
window.amlBridge.onHealthChange((status) => {
    titlebar.firstChild.textContent =
        `${STATUS_ICON[status] ?? '⚪'} Wrapper Terminal`;
});

// Show terminal automatically on first launch (no session).
window.amlBridge.hasSession().then((has) => {
    if (!has) setOpen(true);
});

} // end if (!window.__amlTermMounted)
