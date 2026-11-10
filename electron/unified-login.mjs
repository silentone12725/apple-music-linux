// Reuse an explicitly submitted Apple web password once, after MusicKit confirms
// web authorization. Like the NAS bridge, this never persists credentials.
const ORIGINS = new Set(['https://idmsa.apple.com', 'https://appleid.apple.com', 'https://account.apple.com']);

export function isAppleLoginOrigin(url) {
    try { return ORIGINS.has(new URL(url).origin); } catch { return false; }
}

// Executed only in an owned Apple authentication frame. Observe submitted form
// values rather than depending on Apple's transport (which can use SRP).
export function captureSubmittedAppleLogin() {
    return new Promise(resolve => {
        let email = '';
        const cleanup = () => {
            clearTimeout(timer);
            document.removeEventListener('submit', submit, true);
            document.removeEventListener('keydown', key, true);
            document.removeEventListener('click', click, true);
        };
        const submit = () => {
            email = document.querySelector('input[type=email],input[name=accountName],#account_name_text_field')?.value?.trim() || email;
            const password = document.querySelector('input[type=password]')?.value || '';
            if (!email || !password) return;
            cleanup();
            resolve({ email, password });
            email = '';
        };
        const key = e => { if (e.isTrusted && e.key === 'Enter') submit(); };
        const click = e => { if (e.isTrusted && e.target.closest?.('button,[role=button],input[type=submit]')) submit(); };
        const timer = setTimeout(() => { cleanup(); email = ''; resolve(null); }, 5 * 60_000);
        document.addEventListener('submit', submit, true);
        document.addEventListener('keydown', key, true);
        document.addEventListener('click', click, true);
    });
}

export function submittedAppleCredentials(details) {
    try {
        const url = new URL(details.url);
        if (!ORIGINS.has(url.origin) || url.pathname !== '/appleauth/auth/signin' || details.method !== 'POST') return null;
        const chunks = details.uploadData;
        if (!Array.isArray(chunks) || !chunks.length || chunks.some(c => !c.bytes || c.file)) return null;
        if (chunks.reduce((n, c) => n + c.bytes.length, 0) > 16384) return null;
        const body = JSON.parse(Buffer.concat(chunks.map(c => c.bytes)).toString('utf8'));
        if (typeof body.accountName !== 'string' || typeof body.password !== 'string') return null;
        const email = body.accountName.trim(), password = body.password;
        return email && email.length <= 320 && password && password.length <= 1024 ? { email, password } : null;
    } catch { return null; }
}

export class UnifiedLogin {
    constructor({ request, now = Date.now }) {
        this.request = request;
        this.now = now;
        this.pending = null;
        this.timer = null;
        this.running = false;
        this.revision = 0;
    }
    clear() {
        this.revision++;
        if (this.pending) this.pending.email = this.pending.password = '';
        this.pending = null;
        clearTimeout(this.timer);
        this.timer = null;
    }
    capture(details) {
        const creds = submittedAppleCredentials(details);
        return this.captureCredentials(creds);
    }
    captureCredentials(creds) {
        if (this.running || typeof creds?.email !== 'string' || typeof creds.password !== 'string' ||
            !creds.email.trim() || creds.email.length > 320 || !creds.password || creds.password.length > 1024) return false;
        this.clear();
        this.pending = { ...creds, expires: this.now() + 5 * 60_000 };
        this.timer = setTimeout(() => this.clear(), 5 * 60_000);
        this.timer.unref?.();
        return true;
    }
    async complete() {
        if (this.running || !this.pending) return 'no-credentials';
        const creds = this.pending;
        this.pending = null;
        clearTimeout(this.timer);
        this.timer = null;
        this.running = true;
        const revision = this.revision;
        try {
            if (this.now() >= creds.expires) return 'expired';
            const status = await this.request('GET', '/api/v1/drm/status');
            if (revision !== this.revision) return 'cancelled';
            if (status?.status !== 200 || !status.json) return 'no-engine';
            const state = status.json.state ?? {};
            if (state.fairplay === 'ready' || state.session === 'valid' ||
                ['logging_in', 'challenging', 'logged_in'].includes(state.authentication)) return 'has-session';
            const res = await this.request('POST', '/api/v1/drm/authenticate', { email: creds.email, password: creds.password });
            return [200, 202].includes(res?.status) ? 'submitted' : 'manual-required';
        } finally {
            creds.email = creds.password = '';
            this.running = false;
        }
    }
}
