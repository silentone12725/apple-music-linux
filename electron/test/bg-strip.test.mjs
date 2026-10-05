// The background continuity strip (a solid band along the bottom of the window) must not be
// shown in Blur or Accented Blur, where the wallpaper / artwork is meant to show through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(path.join(root, 'src/vision-glass.js'), 'utf8');

// The declaration block that follows a selector list containing `needle`.
const blockFor = (needle) => {
    const i = css.indexOf(needle);
    assert.ok(i >= 0, `no rule mentions ${needle}`);
    return css.slice(css.indexOf('{', i), css.indexOf('}', i) + 1);
};

for (const sel of ['body[data-aml-mode="blur"] #aml-bg-strip',
                   'body[data-aml-mode="art-blur"] #aml-bg-strip',
                   'body[data-aml-art-blur] #aml-bg-strip']) {
    test(`the bg strip is hidden for ${sel}`, () => {
        assert.match(blockFor(sel), /display:\s*none\s*!important/);
    });
}

test('the bg strip is still shown in the other modes', () => {
    // Only the three hiding selectors above may target it with display:none.
    const hits = css.match(/[^{}]*#aml-bg-strip[^{}]*\{[^}]*display:\s*none[^}]*\}/g) || [];
    assert.equal(hits.length, 1, 'one rule (a list of three selectors) hides the strip');
    assert.ok(!/data-aml-mode="(accent|custom)"[^{]*#aml-bg-strip/.test(css));
});

test('vision-bundle.js carries the rule', () => {
    assert.match(readFileSync(path.join(root, 'vision-bundle.js'), 'utf8'), /data-aml-art-blur\] #aml-bg-strip/);
});
