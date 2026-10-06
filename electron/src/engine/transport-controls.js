// MusicKit's CDN playbackActions can omit PLAY/NEXT/PREVIOUS while libvlc has
// a valid independent session. Use the existing transport slots, with controls
// whose availability follows that session rather than an empty MediaSource.
export function installTransportControls({ root = document, state, command }) {
    const original = new Map();
    const playIcon = '<svg viewBox="0 0 32 28" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M10 4v20l16-10z"/></svg>';
    const pauseIcon = '<svg viewBox="0 0 32 28" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M10 4h4v20h-4zm8 0h4v20h-4z"/></svg>';
    function button(host, action, icon, label) {
        let b = host.querySelector('[data-aml-transport]');
        if (!b) {
            b = root.createElement('button');
            b.dataset.amlTransport = action;
            b.dataset.testid = `aml-transport-${action}`;
            b.style.cssText = 'display:flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;background:transparent;color:inherit;cursor:pointer';
            b.onclick = event => {
                event.preventDefault(); event.stopImmediatePropagation();
                const s = state();
                if (s.active) command(action === 'play' ? (s.paused ? 'play' : 'pause') : action);
            };
            host.appendChild(b);
        }
        if (b.innerHTML !== icon) b.innerHTML = icon;
        if (b.getAttribute('aria-label') !== label) b.setAttribute('aria-label', label);
        return b;
    }
    function restore() {
        for (const [node, display] of original) node.style.display = display;
        original.clear();
        root.querySelectorAll('[data-aml-transport]').forEach(b=>b.remove());
    }
    function sync() {
        const s = state();
        for (const node of original.keys()) if (!node.isConnected) original.delete(node);
        if (!s.active) { restore(); return; }
        for (const host of root.querySelectorAll('amp-playback-controls-play, amp-playback-controls-item-skip')) {
            for (const native of host.querySelectorAll('button:not([data-aml-transport])')) {
                if (!original.has(native)) original.set(native, native.style.display);
                if (native.style.display !== 'none') native.style.display = 'none';
            }
            if (host.tagName === 'AMP-PLAYBACK-CONTROLS-PLAY') {
                button(host, 'play', s.paused ? playIcon : pauseIcon, s.paused ? 'Play' : 'Pause');
            } else {
                const previous = host.getAttribute('direction') === 'previous';
                const action = previous ? 'previous' : 'next';
                const icon = `<svg viewBox="0 0 32 28" width="24" height="24" aria-hidden="true"><g fill="currentColor"${previous ? ' transform="translate(32 0) scale(-1 1)"' : ''}><path d="M5 5v18l11-9zm11 0v18l11-9zM27 5h2v18h-2z"/></g></svg>`;
                const b = button(host, action, icon, previous ? 'Previous track' : 'Next track');
                const disabled = previous ? !s.canPrevious : !s.canNext;
                if (b.disabled !== disabled) b.disabled = disabled;
                b.style.opacity = disabled ? '0.35' : '';
            }
        }
    }
    // React only to a replaced transport subtree, not every attribute we write.
    const observer = new MutationObserver(records => {
        if (records.some(r => [...r.addedNodes, ...r.removedNodes].some(n =>
            n.nodeType === 1 && (n.matches?.('amp-playback-controls-play, amp-playback-controls-item-skip, button') ||
                n.querySelector?.('amp-playback-controls-play, amp-playback-controls-item-skip'))))) sync();
    });
    observer.observe(root.documentElement, {childList:true,subtree:true});
    sync();
    return {sync,dispose(){observer.disconnect();restore();}};
}
