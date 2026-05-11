(function injectAppleMusicStyles() {
    // Only inject once
    if (document.getElementById('wails-custom-style')) return;

    // Check if we are on Apple Music
    if (!window.location.hostname.includes('apple.com')) return;

    // 1. Inject Styles
    const style = document.createElement('style');
    style.id = 'wails-custom-style';
    style.innerHTML = `
        /* Hide the Open in App buttons & Banners (NOT the Sign In button) */
        .native-cta__button, 
        .web-navigation__auth,
        cwc-upsell-banner,
        .locale-switcher-banner { 
            display: none !important; 
        }
    `;

    const inject = () => {
        document.head.appendChild(style);
    };

    if (document.head) {
        inject();
    } else {
        document.addEventListener('DOMContentLoaded', inject);
    }
})();

// ─── Credential Interception ───────────────────────────────────────────────
// Poll document.cookie every 2s for the media-user-token.
// Once found, securely store it via the Go keyring binding and stop polling.
(function startCredentialPoller() {
    // Only run on the Apple Music origin
    if (!window.location.hostname.includes('apple.com')) return;

    // Avoid starting multiple pollers if the preload script is re-injected
    if (window.__wailsCredentialPollerActive) return;
    window.__wailsCredentialPollerActive = true;

    console.log('[Apple Music Linux] Credential poller started.');

    const intervalId = setInterval(async () => {
        // Parse document.cookie for media-user-token
        const match = document.cookie
            .split('; ')
            .find(row => row.startsWith('media-user-token='));

        if (!match) return;

        const token = decodeURIComponent(match.split('=')[1]);
        if (!token) return;

        console.log('[Apple Music Linux] media-user-token detected! Storing securely...');
        clearInterval(intervalId);
        window.__wailsCredentialPollerActive = false;

        try {
            // window.go.main.App is injected by Wails when
            // BindingsAllowedOrigins includes music.apple.com
            await window.go.main.App.StoreCredentials(token);
            console.log('[Apple Music Linux] Token stored successfully in OS keyring.');
        } catch (err) {
            console.error('[Apple Music Linux] Failed to store token:', err);
        }
    }, 2000);
})();
