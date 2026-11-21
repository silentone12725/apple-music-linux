// Tests for the PR-body reference parser (.github/scripts/parse-refs.mjs).
//   node --test electron/test/github/parse-refs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReferences, parseRevertedPrs, parseRevertedCommits } from '../../../.github/scripts/parse-refs.mjs';

const REPO = 'silentone12725/apple-music-linux';
const links = (body) => parseReferences(body, REPO).map((r) => `${r.kind}:${r.number}`);

const FIX_WORDS = ['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved'];
const casings = (w) => [w, w.toUpperCase(), w[0].toUpperCase() + w.slice(1)];

test('each of the nine fix keywords links, in every casing, with and without a colon', () => {
    for (const w of FIX_WORDS) {
        for (const c of casings(w)) {
            assert.deepEqual(links(`${c} #12`), ['fix:12'], `${c} #12`);
            assert.deepEqual(links(`${c}: #12`), ['fix:12'], `${c}: #12`);
        }
    }
});

test('reference keywords link as references only', () => {
    for (const w of ['ref', 'refs', 'see', 'related to', 'Related to', 'REFS:']) {
        assert.deepEqual(links(`${w} #7`), ['ref:7'], w);
    }
});

test('near misses do not match', () => {
    for (const body of ['prefix #1', 'fixing #1', 'closer #1', 'unfixed #1', 'suffixes #1', 'fix#1', 'refactor #1', 'fixes the thing, see #']) {
        assert.deepEqual(links(body), [], body);
    }
});

test('lists of numbers after one keyword', () => {
    assert.deepEqual(links('Fixes #1, #2 and #3'), ['fix:1', 'fix:2', 'fix:3']);
    assert.deepEqual(links('Closes #4 & #5'), ['fix:4', 'fix:5']);
    assert.deepEqual(links('Fixes #1 and also #9'), ['fix:1'], 'a later number without its own keyword is not linked');
});

test('a fix wins over a reference to the same number; results are sorted and unique', () => {
    assert.deepEqual(links('Refs #5\nFixes #5\nFixes #2\nFixes #2'), ['fix:2', 'fix:5']);
});

test('cross-repository references are accepted only for this repository', () => {
    assert.deepEqual(links(`Fixes ${REPO}#8`), ['fix:8']);
    assert.deepEqual(links(`Fixes ${REPO.toUpperCase()}#8`), ['fix:8']);
    assert.deepEqual(links('Fixes someone/else#8'), []);
    assert.deepEqual(links('Fixes someone/else#8, #9'), ['fix:9']);
});

test('the empty template placeholder and bare numbers are ignored', () => {
    assert.deepEqual(links('Fixes #\n\nSome text mentioning 123 and #77 in passing'), []);
    assert.deepEqual(links('Fixes #0'), []);
});

test('code, quotes and comments are not prose', () => {
    assert.deepEqual(links('```\nFixes #1\n```\nreal text'), []);
    assert.deepEqual(links('~~~md\nFixes #1\n~~~'), []);
    assert.deepEqual(links('use `Fixes #1` in the body'), []);
    assert.deepEqual(links('> Fixes #1 (quoted)\nFixes #2'), ['fix:2']);
    assert.deepEqual(links('<!-- Fixes #1 -->\nFixes #2'), ['fix:2']);
    assert.deepEqual(links('<!--\nFixes #1\n-->\nSee #3'), ['ref:3']);
});

test('an unclosed fence swallows the rest, and an unclosed comment too', () => {
    assert.deepEqual(links('Fixes #1\n```\nFixes #2'), ['fix:1']);
    assert.deepEqual(links('Fixes #1\n<!-- Fixes #2'), ['fix:1']);
});

test('reclassification follows the body: Refs becomes Fixes, and a removed reference disappears', () => {
    assert.deepEqual(links('Refs #50'), ['ref:50']);
    assert.deepEqual(links('Fixes #50'), ['fix:50']);
    assert.deepEqual(links('No links here'), []);
});

test('empty and non-string bodies', () => {
    assert.deepEqual(links(''), []);
    assert.deepEqual(links(null), []);
    assert.deepEqual(links(undefined), []);
});

test('Reverts #N is a PR number list; commit messages name commits', () => {
    assert.deepEqual(parseRevertedPrs('Reverts #120', REPO), [120]);
    assert.deepEqual(parseRevertedPrs('reverts: #3, #4', REPO), [3, 4]);
    assert.deepEqual(parseRevertedPrs('Reverts someone/else#9', REPO), []);
    assert.deepEqual(parseRevertedPrs('```\nReverts #1\n```', REPO), []);
    assert.deepEqual(parseRevertedCommits('Revert "x"\n\nThis reverts commit 0123abc, and This reverts commit ' + 'f'.repeat(40)), ['0123abc', 'f'.repeat(40)]);
    assert.deepEqual(parseRevertedCommits('nothing here'), []);
});

test('the parser is linear on pathological input', () => {
    const t = Date.now();
    links('Fixes ' + '#1, '.repeat(20000) + 'x');
    links('fix '.repeat(50000));
    links('> ' + 'a'.repeat(200000));
    assert.ok(Date.now() - t < 2000, 'took ' + (Date.now() - t) + ' ms');
});
