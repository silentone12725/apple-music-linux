import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/vision-glass.js', import.meta.url), 'utf8');
const bundle = readFileSync(new URL('../vision-bundle.js', import.meta.url), 'utf8');

test('footer keeps its box (player-bar clearance) and only its content is hidden', () => {
  assert.ok(!/(^|\n)\s*footer\s*,[^{]*\{\s*display:\s*none/.test(src), 'footer element must not be display:none');
  assert.match(src, /footer\s*\{\s*background:\s*transparent\s*!important/);
  assert.match(src, /footer\s*>\s*\*[^{]*\{\s*display:\s*none\s*!important/);
});

test('no background strip or forced scroll padding remains', () => {
  assert.ok(!src.includes('aml-bg-strip'));
  assert.ok(!/scrollable-page"\]\s*\{\s*padding-bottom/.test(src));
});

test('vision-bundle.js matches the source', () => {
  assert.equal(bundle, src);
});
