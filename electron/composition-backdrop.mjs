import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { app, nativeTheme } from 'electron';
import { ACRYLIC_TITLEBAR_HEIGHT } from './acrylic.mjs';

const require = createRequire(import.meta.url);
let setBackdrop;
let setCaptionDrag;
let removeBackdrop;

function init() {
    if (setBackdrop) return;
    const koffi = require('koffi');
    const dll = app.isPackaged
        ? path.join(process.resourcesPath, 'composition-backdrop.dll')
        : path.join(path.dirname(fileURLToPath(import.meta.url)), 'native', 'composition-backdrop.dll');
    const lib = koffi.load(dll);
    setBackdrop = lib.func('int __stdcall AdamCompositionSetBackdrop(uintptr_t hwnd, float blurRadius, float saturation, uint32_t tintRgb, float tintOpacity, uint32_t luminosityRgb, float luminosityOpacity)');
    setCaptionDrag = lib.func('int __stdcall AdamCompositionSetCaptionDrag(uintptr_t hwnd, int height, int rightExclusion)');
    removeBackdrop = lib.func('void __stdcall AdamCompositionRemoveBackdrop(uintptr_t hwnd)');
}

function hwndOf(win) {
    return Number(win.getNativeWindowHandle().readBigUInt64LE(0));
}

export function setNativeCaptionDrag(win) {
    init();
    const status = setCaptionDrag(hwndOf(win), ACRYLIC_TITLEBAR_HEIGHT, 0);
    if (status !== 0) throw new Error(`Windows caption drag setup failed: ${status}`);
}

export function setCompositionBackdrop(win, settings) {
    init();
    const radius = 30 * Math.pow(settings.blurRadius, 1.25);
    const light = settings.theme === 'light' || (settings.theme === 'system' && !nativeTheme.shouldUseDarkColors);
    const status = setBackdrop(hwndOf(win), radius, settings.saturation,
        parseInt(settings.tintColor.slice(1), 16), settings.tintOpacity,
        light ? 0xf3f3f3 : 0x202020, settings.lumOpacity);
    if (status !== 0) throw new Error(`Composition backdrop failed: ${status}`);
    return radius <= 0 ? 0 : 1 - Math.exp(-radius / 4);
}

export function removeCompositionBackdrop(win) {
    if (!win || win.isDestroyed()) return;
    try { init(); removeBackdrop(hwndOf(win)); } catch (error) { console.warn('[Adam] compositor cleanup:', error.message); }
}
