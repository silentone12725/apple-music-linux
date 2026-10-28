// Windows blur settings (acrylic.mjs): validation, which Windows is supported, and the page overlay script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    ACRYLIC_DEFAULTS, ACRYLIC_MATERIALS, ACRYLIC_CSS, ACRYLIC_TITLEBAR_HEIGHT,
    normalizeAcrylic, acrylicOverlayScript, windowsVersion, acrylicBackend,
} from '../acrylic.mjs';

test('defaults: dark theme, the compositor backdrop with no tint or luminosity layer', () => {
    assert.deepEqual(ACRYLIC_DEFAULTS, {
        material: 'gaussian', theme: 'dark', tintColor: '#000000', tintOpacity: 0, lumOpacity: 0,
        blurRadius: 0.6792668, saturation: 1.25, noise: 0.025,
    });
    for (const nothing of [undefined, null, 'gaussian', 7]) assert.deepEqual(normalizeAcrylic(nothing), ACRYLIC_DEFAULTS);
});

test('a material saved by the DWM-acrylic version migrates to gaussian, keeping the rest', () => {
    for (const old of ['acrylic', 'mica', 'tabbed', 'auto', 'none']) {
        const got = normalizeAcrylic({ material: old, theme: 'light', tintColor: '#ff0000', tintOpacity: 0.3 });
        assert.equal(got.material, 'gaussian', old);
        assert.deepEqual([got.theme, got.tintColor, got.tintOpacity], ['light', '#ff0000', 0.3]);
    }
    assert.deepEqual([...ACRYLIC_MATERIALS], ['gaussian']);
});

test('every field is validated and clamped to its range', () => {
    assert.equal(normalizeAcrylic({ theme: 'sepia' }).theme, 'dark');
    for (const theme of ['system', 'light', 'dark']) assert.equal(normalizeAcrylic({ theme }).theme, theme);
    const hi = normalizeAcrylic({ tintOpacity: 5, lumOpacity: 5, blurRadius: 5, saturation: 9, noise: 5 });
    assert.deepEqual([hi.tintOpacity, hi.lumOpacity, hi.blurRadius, hi.saturation, hi.noise], [1, 1, 1, 2, 0.1]);
    const lo = normalizeAcrylic({ tintOpacity: -1, lumOpacity: -1, blurRadius: -1, saturation: -1, noise: -1 });
    assert.deepEqual([lo.tintOpacity, lo.lumOpacity, lo.blurRadius, lo.saturation, lo.noise], [0, 0, 0, 0, 0]);
    assert.equal(normalizeAcrylic({ blurRadius: 0 }).blurRadius, 0, 'zero blur is a real value, not unset');
    for (const bad of ['0.5', NaN, Infinity, null, {}]) {
        const got = normalizeAcrylic({ tintOpacity: bad, blurRadius: bad, saturation: bad, noise: bad });
        assert.deepEqual([got.tintOpacity, got.blurRadius, got.saturation, got.noise],
            [ACRYLIC_DEFAULTS.tintOpacity, ACRYLIC_DEFAULTS.blurRadius, ACRYLIC_DEFAULTS.saturation, ACRYLIC_DEFAULTS.noise]);
    }
});

test('tint colour must be #rrggbb; it is lower-cased', () => {
    assert.equal(normalizeAcrylic({ tintColor: '#AABBCC' }).tintColor, '#aabbcc');
    for (const bad of ['red', '#fff', '#12345g', 'rgb(1,2,3)', '#aabbcc;}</style>', 123])
        assert.equal(normalizeAcrylic({ tintColor: bad }).tintColor, '#000000');
});

test('windowsVersion accepts Windows 10 and Windows 11 only', () => {
    assert.equal(windowsVersion('10.0.26200', 'win32'), 'win11');
    assert.equal(windowsVersion('10.0.22000', 'win32'), 'win11');
    assert.equal(windowsVersion('10.0.21996', 'win32'), 'win10');
    assert.equal(windowsVersion('10.0.19045', 'win32'), 'win10');
    for (const old of ['6.3.9600', '6.1.7601', '5.1.2600', '', undefined]) assert.equal(windowsVersion(old, 'win32'), null);
    assert.equal(windowsVersion('10.0.26200', 'linux'), null);
    assert.equal(windowsVersion('10.0.26200', 'darwin'), null);
});

test('Windows 10 and 11 both use the composition backdrop; nothing else does', () => {
    for (const build of ['10.0.26200', '10.0.22621', '10.0.22000', '10.0.19045', '10.0.17134']) {
        const b = acrylicBackend(build, 'win32');
        assert.deepEqual([b.kind, [...b.materials]], ['composition', ['gaussian']], build);
    }
    assert.equal(acrylicBackend('6.1.7601', 'win32'), null);
    assert.equal(acrylicBackend('10.0.26200', 'linux'), null);
});

test('the drag strip is the title-bar height and a Chromium drag region', () => {
    assert.equal(ACRYLIC_TITLEBAR_HEIGHT, 32);
    assert.match(ACRYLIC_CSS, new RegExp(`#_adamAcrylicDrag \\{[^}]*height: ${ACRYLIC_TITLEBAR_HEIGHT}px[^}]*-webkit-app-region: drag`));
});

function fakeDom() {
    const byId = new Map(), bodyOrder = [], appended = [], props = {}, attrs = {};
    const document = {
        body: { prepend(el) { bodyOrder.unshift(el); byId.set(el.id, el); }, appendChild(el) { appended.push(el); byId.set(el.id, el); } },
        documentElement: {
            style: { setProperty: (k, v) => { props[k] = v; } },
            setAttribute: (k, v) => { attrs[k] = v; },
            appendChild(el) { byId.set(el.id, el); },
        },
        getElementById: (id) => byId.get(id) || null,
        createElement: (tag) => ({ tag, id: '', textContent: '' }),
    };
    return { document, props, attrs, bodyOrder, byId, appended };
}
const run = (dom, settings, opts) => new Function('document', `return ${acrylicOverlayScript(settings, opts)}`)(dom.document);

test('the overlay script creates the style, both layers (luminosity below the tint), the noise and the drag strip', () => {
    const dom = fakeDom();
    run(dom, { tintColor: '#102030', tintOpacity: 0.5, lumOpacity: 0.25 });
    assert.deepEqual(dom.bodyOrder.map(e => e.id), ['_adamAcrylicLum', '_adamAcrylicTint']);
    assert.deepEqual(dom.appended.map(e => e.id).sort(), ['_adamAcrylicDrag', '_adamAcrylicNoise']);
    assert.match(dom.byId.get('_adamAcrylicStyle').textContent, /#_adamAcrylicLum/);
    assert.equal(dom.props['--adam-acrylic-tint'], 'rgba(16,32,48,0.5)');
    assert.equal(dom.props['--adam-acrylic-lum-opacity'], '0.25');
    const noise = Number(dom.props['--adam-acrylic-noise']);
    assert.ok(noise > 0 && noise <= ACRYLIC_DEFAULTS.noise, `noise ${noise} follows the blur and never exceeds the setting`);
    assert.equal(dom.attrs['data-adam-acrylic-material'], 'gaussian');
});

test('with no blur the grain fades out with it', () => {
    const dom = fakeDom();
    run(dom, { blurRadius: 0, noise: 0.1 });
    assert.equal(Number(dom.props['--adam-acrylic-noise']), 0);
});

test('a window with its own drag area (the mini player) gets the layers but no drag strip', () => {
    const dom = fakeDom();
    run(dom, {}, { drag: false });
    assert.equal(dom.byId.has('_adamAcrylicDrag'), false);
    assert.equal(dom.byId.has('_adamAcrylicLum'), true);
});

test('running the overlay script again updates in place instead of adding layers', () => {
    const dom = fakeDom();
    run(dom, {});
    run(dom, { tintOpacity: 1, tintColor: '#ffffff' });
    assert.equal(dom.bodyOrder.length, 2);
    for (const id of ['_adamAcrylicDrag', '_adamAcrylicNoise']) assert.equal(dom.appended.filter(e => e.id === id).length, 1, id);
    assert.equal(dom.props['--adam-acrylic-tint'], 'rgba(255,255,255,1)');
});

test('the overlay script cannot be steered by hostile settings', () => {
    const dom = fakeDom();
    run(dom, { tintColor: "#000000');alert(1);//", material: "x'});alert(1);//", tintOpacity: '1);alert(1)', blurRadius: '1);alert(1)' });
    assert.equal(dom.props['--adam-acrylic-tint'], 'rgba(0,0,0,0)');
    assert.equal(dom.attrs['data-adam-acrylic-material'], 'gaussian');
});

test('without a body the script does nothing', () => {
    const dom = fakeDom();
    dom.document.body = null;
    run(dom, {});
    assert.equal(dom.byId.size, 0);
});
