(function injectAppleMusicStyles() {
    // Only inject once
    if (document.getElementById('wails-custom-style')) return;

    // Check if we are on Apple Music
    if (!window.location.hostname.includes('apple.com')) return;

    // 1. Inject Styles
    const style = document.createElement('style');
    style.id = 'wails-custom-style';
    style.innerHTML = `
        /* Hide the Open in App buttons & Banners */
        .native-cta__button, 
        .commerce-button.signin, 
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
