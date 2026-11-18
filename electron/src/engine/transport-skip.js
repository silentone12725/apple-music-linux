// The previous/next transport controls, found by element instead of by their localised labels.
//
// Apple's player bar marks each skip control data-testid="playback-control-item-skip" with a `previous` or
// `next` class; its label is only a visually hidden, translated <span>, and the button has no aria-label.
// The MusicKit component (the music-video player) is <amp-playback-controls-skip direction="back|forward">.

export const SKIP_SELECTOR = '[data-testid="playback-control-item-skip"], amp-playback-controls-skip';

// 'previous' | 'next' | null for an element matched by SKIP_SELECTOR.
export function skipDirection(el) {
    if (el?.localName === 'amp-playback-controls-skip') {
        const direction = el.getAttribute('direction');
        return direction === 'back' ? 'previous' : direction === 'forward' ? 'next' : null;
    }
    if (el?.classList?.contains('previous')) return 'previous';
    if (el?.classList?.contains('next')) return 'next';
    return null;
}

// What a click on a button inside the music-video footer does, from its element, never from its label.
// cls: the button's lower-cased class name; closest: (selector) => ancestor element or null.
// Returns { action: 'play' | 'skip' | 'fullscreen', delta?: seconds } or null for a control left to Apple.
export function footerAction(cls, closest) {
    const direction = closest('amp-playback-controls-skip')?.getAttribute('direction') ?? /button--(back|forward)/.exec(cls)?.[1] ?? null;
    if (closest('amp-playback-controls-play') || cls.includes('play') || cls.includes('pause')) return { action: 'play' };
    if (direction || cls.includes('skip')) return { action: 'skip', delta: direction === 'back' ? -10 : 10 };
    if (closest('amp-playback-controls-full-screen') || cls.includes('full-screen') || cls.includes('fullscreen')) return { action: 'fullscreen' };
    return null;
}
