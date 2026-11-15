// Tests for scripts/check-closing-keywords.sh and scripts/record-release-tag.sh, run in temporary repositories.
//   node --test electron/test/github/scripts.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_SYSTEM = '/dev/null';
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function temp() {
    const dir = mkdtempSync(path.join(tmpdir(), 'adam-sh-'));
    const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' }).trim();
    g('init', '-q', '-b', 'main');
    mkdirSync(path.join(dir, 'scripts')); mkdirSync(path.join(dir, '.github')); mkdirSync(path.join(dir, 'bin'));
    for (const s of ['check-closing-keywords.sh', 'record-release-tag.sh']) copyFileSync(path.join(repoRoot, 'scripts', s), path.join(dir, 'scripts', s));
    writeFileSync(path.join(dir, '.github/release-tags.json'), JSON.stringify({ tags: {} }));
    // a fake gh: prints $FAKE_RELEASE for `gh release view`, fails when it is unset
    writeFileSync(path.join(dir, 'bin/gh'), '#!/bin/sh\nif [ -n "$FAKE_RELEASE" ]; then printf %s "$FAKE_RELEASE"; else exit 1; fi\n');
    chmodSync(path.join(dir, 'bin/gh'), 0o755);
    const commit = (msg, file = 'f.txt') => { writeFileSync(path.join(dir, file), msg + Math.random()); g('add', '-A'); g('commit', '-q', '-m', msg); return g('rev-parse', 'HEAD'); };
    const sh = (script, args, env = {}) => spawnSync('bash', [path.join(dir, 'scripts', script), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, ...env } });
    return { dir, g, commit, sh, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('closing keywords: native keywords in commits and titles are rejected, near misses and Refs pass', () => {
    const t = temp();
    try {
        const base = t.commit('base');
        const ok = t.commit('Refs #12: tidy the cache\n\nFixing the prefix #3 is not a keyword');
        assert.equal(t.sh('check-closing-keywords.sh', ['--range', `${base}..${ok}`]).status, 0);
        for (const m of ['Fixes #1', 'fix: #2', 'Closed #3', 'resolves someone/else#4', 'RESOLVED: #5', 'body\n\nCloses #6']) {
            const c = t.commit(m);
            const r = t.sh('check-closing-keywords.sh', ['--range', `${c}~1..${c}`]);
            assert.equal(r.status, 1, m);
            assert.match(r.stdout + r.stderr, /native closing keyword/);
        }
        assert.equal(t.sh('check-closing-keywords.sh', ['--title', 'Fixes #9 in the engine']).status, 1);
        assert.equal(t.sh('check-closing-keywords.sh', ['--title', 'Refs #9 in the engine']).status, 0);
        assert.equal(t.sh('check-closing-keywords.sh', ['--title', 'prefix #9 and fixing #3']).status, 0);
    } finally { t.done(); }
});

test('closing keywords: a commit-msg hook file ignores git comment lines', () => {
    const t = temp();
    try {
        writeFileSync(path.join(t.dir, 'msg'), 'Refs #1\n# Fixes #2 (this is a git comment)\n');
        assert.equal(t.sh('check-closing-keywords.sh', ['--message-file', 'msg']).status, 0);
        writeFileSync(path.join(t.dir, 'msg'), 'Fixes #1\n');
        assert.equal(t.sh('check-closing-keywords.sh', ['--message-file', 'msg']).status, 1);
        assert.equal(t.sh('check-closing-keywords.sh', []).status, 2);
    } finally { t.done(); }
});

const PUBLISHED = JSON.stringify({ tagName: 'v1.6.0', isDraft: false, isPrerelease: false, publishedAt: '2026-11-01T00:00:00Z' });
const record = (t, env = {}, tag = 'v1.6.0') => t.sh('record-release-tag.sh', [tag, '--repo', 'o/r', '--main-ref', 'main'], { FAKE_RELEASE: PUBLISHED, ...env });

function tagged() {
    const t = temp();
    t.commit('base');
    t.commit('release work');
    t.g('tag', 'v1.6.0');
    return t;
}

test('record-release-tag: a published release on main prints the manifest line', () => {
    const t = tagged();
    try {
        const sha = t.g('rev-parse', 'v1.6.0^{commit}');
        const r = record(t);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stdout.trim(), `"v1.6.0": "${sha}"`);
        assert.match(r.stderr, /Auto-close issues with merged linked pull requests/);
    } finally { t.done(); }
});

test('record-release-tag: refuses a missing tag, a bad name, a missing/draft/prerelease/mismatched release', () => {
    const t = tagged();
    try {
        assert.equal(record(t, {}, 'v9.9.9').status, 1);
        assert.equal(record(t, {}, 'not-a-tag').status, 2);
        assert.equal(record(t, { FAKE_RELEASE: '' }).status, 1, 'no such release');
        for (const over of [{ isDraft: true }, { isPrerelease: true }, { publishedAt: null }, { tagName: 'v1.5.0' }]) {
            const r = record(t, { FAKE_RELEASE: JSON.stringify({ ...JSON.parse(PUBLISHED), ...over }) });
            assert.equal(r.status, 1, JSON.stringify(over));
            assert.equal(r.stdout, '', 'prints nothing on refusal');
        }
    } finally { t.done(); }
});

test('record-release-tag: refuses a commit that is not on main, an ambiguous ref, and a conflicting or incomparable manifest entry', () => {
    const t = tagged();
    try {
        const sha = t.g('rev-parse', 'v1.6.0^{commit}');
        // not an ancestor of main
        t.g('checkout', '-q', '-b', 'side'); t.commit('side only'); t.g('tag', 'v1.7.0');
        t.g('checkout', '-q', 'main');
        const off = record(t, { FAKE_RELEASE: JSON.stringify({ ...JSON.parse(PUBLISHED), tagName: 'v1.7.0' }) }, 'v1.7.0');
        assert.equal(off.status, 1); assert.match(off.stderr, /not an ancestor of main/);
        // ambiguous: a branch with the tag's name
        t.g('branch', 'v1.6.0', 'main');
        const amb = record(t);
        assert.equal(amb.status, 1); assert.match(amb.stderr, /ambiguous/);
        t.g('branch', '-D', 'v1.6.0');
        // conflicting manifest entry
        writeFileSync(path.join(t.dir, '.github/release-tags.json'), JSON.stringify({ tags: { 'v1.6.0': 'b'.repeat(40) } }));
        const conflict = record(t);
        assert.equal(conflict.status, 1); assert.match(conflict.stderr, /already records/);
        // same entry: already recorded
        writeFileSync(path.join(t.dir, '.github/release-tags.json'), JSON.stringify({ tags: { 'v1.6.0': sha } }));
        const same = record(t);
        assert.equal(same.status, 0); assert.match(same.stdout, /already recorded/);
        // incomparable with another entry
        t.g('checkout', '-q', '-b', 'old-line', 'main~1'); const diverged = t.commit('diverged from before the release'); t.g('checkout', '-q', 'main');
        writeFileSync(path.join(t.dir, '.github/release-tags.json'), JSON.stringify({ tags: { 'v1.0.0': diverged } }));
        const incomparable = record(t);
        assert.equal(incomparable.status, 1); assert.match(incomparable.stderr, /not comparable/);
    } finally { t.done(); }
});
