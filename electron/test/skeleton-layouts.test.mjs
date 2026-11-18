import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The skeleton builders live inside vision-glass.js's navigation IIFE; run just their source.
const src = readFileSync(new URL('../src/vision-glass.js', import.meta.url), 'utf8');
const from = src.indexOf('const kindOf = (path) =>');
const mid = src.indexOf("const bar = (w, h, extra = '')", from);
const to = src.indexOf('document.documentElement.appendChild(skel);', mid);
assert.ok(from > 0 && mid > from && to > mid, 'skeleton source markers moved: update this test');
const { kindOf, buildSkel } = new Function(`${src.slice(from, to)}\nreturn { kindOf, buildSkel };`)();

const KINDS = ['search', 'artists', 'videos', 'detail', 'rows', 'grid', 'new', 'shelves'];

test('every page kind builds a skeleton at every window size, never throwing', () => {
    for (const kind of KINDS) {
        for (let h = 300; h <= 2600; h += 25) {
            for (const w of [500, 926, 1400, 2200]) {
                for (const g of [25, 40]) {
                    let out;
                    assert.doesNotThrow(() => { out = buildSkel(kind, w, h, g); }, `${kind} ${w}x${h} gutter ${g}`);
                    assert.ok(out.length > 50, `${kind} ${w}x${h} gutter ${g} is empty`);
                }
            }
        }
    }
});

test('the New page gets its own layout, also in a window taller than 1000px', () => {
    const tall = buildSkel('new', 926, 1032), shelves = buildSkel('shelves', 926, 1032);
    assert.notEqual(tall, shelves);
    assert.match(tall, /width:90px;height:30px/, 'starts with the New page title bar');
    assert.match(shelves, /width:120px;height:30px/);
});

test('page paths map to their layout in every storefront', () => {
    const cases = { '/us/new': 'new', '/it/new': 'new', '/jp/new/': 'new', '/it/home': 'shelves', '/it/search': 'search', '/it/library/artists': 'artists',
        '/it/library/songs': 'rows', '/it/library/albums': 'grid', '/it/album/abbey-road/1441164426': 'detail' };
    for (const [path, kind] of Object.entries(cases)) assert.equal(kindOf(path), kind, path);
});

test('the New skeleton follows the live page: cards, then columns of four songs, then square tiles', () => {
    // 749px wide window content = 669px inner, the width the real page was measured at.
    const out = buildSkel('new', 749, 1032);
    const card = out.indexOf('height:190px'), song = out.indexOf('height:55px'), tile = out.indexOf('height:156px');
    assert.ok(card > 0, 'hero artwork is 190px tall at a 332px card (0.572 of the width)');
    assert.ok(song > card, 'the songs come after the cards');
    assert.ok(tile > song, 'the square tiles come after the songs, not before');
    const songRows = out.split('height:55px').length - 1;
    assert.ok(songRows >= 8 && songRows % 4 === 0, `songs are columns of four rows (got ${songRows})`);
    assert.match(out, /width:332px/, 'cards and song columns share the 332px width');
});

test('the New skeleton scales its blocks with the window', () => {
    const narrow = buildSkel('new', 500, 900), wide = buildSkel('new', 1400, 900);
    assert.match(narrow, /width:209px/, 'a card is 0.4965 of the content width (420px)');
    assert.match(wide, /width:655px/);
    assert.notEqual(narrow, wide);
});

test('the skeleton follows the page gutter: 25px in a narrow window, 40px from 1000px up', () => {
    const narrow = buildSkel('new', 632, 1032, 25), wide = buildSkel('new', 632, 1032, 40);
    assert.match(narrow, /margin-right:-25px/);
    assert.doesNotMatch(narrow, /margin-right:-40px/);
    assert.match(narrow, /width:298px/, 'below 1000px a card is a fixed 298px');
    assert.match(narrow, /height:171px/, 'with 171px artwork');
    assert.match(narrow, /width:270px/, 'songs are 270px columns');
    assert.match(narrow, /width:144px/, 'and tiles 144px');
    assert.match(narrow, /gap:10px/, 'with a 10px gap');
    assert.match(wide, /margin-right:-40px/);
    assert.match(wide, /width:274px/, 'and 0.4965 of 552px with a 40px gutter');
    assert.match(buildSkel('shelves', 926, 900), /margin-right:-40px/, 'the default is the wide-window gutter');
});
