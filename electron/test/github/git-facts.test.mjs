// Tests for .github/scripts/git-facts.mjs against real temporary repositories.
//   node --test electron/test/github/git-facts.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, symlinkSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGit } from '../../../.github/scripts/git-facts.mjs';

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_SYSTEM = '/dev/null';

function repo() {
    const dir = mkdtempSync(path.join(tmpdir(), 'adam-gf-'));
    const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' }).trim();
    g('init', '-q', '-b', 'main');
    const api = {
        dir, g,
        write: (name, content, mode) => {
            mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
            writeFileSync(path.join(dir, name), content);
            if (mode) chmodSync(path.join(dir, name), mode);
        },
        commit: (msg) => { g('add', '-A'); g('commit', '-q', '--allow-empty', '-m', msg); return g('rev-parse', 'HEAD'); },
        done: () => rmSync(dir, { recursive: true, force: true }),
    };
    api.write('base.txt', 'base\n');
    api.base = api.commit('base');
    return api;
}

test('ancestry is tri-state: yes, no on a complete history, unknown for a missing object', () => {
    const r = repo();
    try {
        r.write('a.txt', 'a\n'); const a = r.commit('a');
        r.g('checkout', '-q', '-b', 'side', r.base); r.write('s.txt', 's\n'); const s = r.commit('s');
        const git = createGit(r.dir);
        assert.equal(git.ancestor(r.base, a), 'yes');
        assert.equal(git.ancestor(a, s), 'no');
        assert.equal(git.ancestor('f'.repeat(40), a), 'unknown');
        assert.equal(git.ancestor('not-a-sha', a), 'unknown');
    } finally { r.done(); }
});

test('a git revert is a verified exact inverse', () => {
    const r = repo();
    try {
        r.write('src.js', 'one\n'); const x = r.commit('fix');
        r.g('revert', '--no-edit', x); const rev = r.g('rev-parse', 'HEAD');
        assert.equal(createGit(r.dir).verifyInverse(rev, x), true);
    } finally { r.done(); }
});

test('a revert whose message claims more than its content is unverified', () => {
    const r = repo();
    try {
        r.write('src.js', 'one\n'); r.write('other.js', 'x\n'); const x = r.commit('fix');
        r.g('revert', '--no-edit', x); r.write('extra.js', 'sneaky\n'); r.g('add', '-A'); r.g('commit', '-q', '--amend', '--no-edit');
        const rev = r.g('rev-parse', 'HEAD');
        assert.equal(createGit(r.dir).verifyInverse(rev, x), false, 'extra path');
    } finally { r.done(); }
});

test('whitespace that survives patch-id normalization still fails the byte-exact check', () => {
    const r = repo();
    try {
        r.write('a.py', 'if x:\n    y = 1\n'); const x0 = r.commit('base py');
        r.write('a.py', 'if x:\n    y = 2\n'); const x = r.commit('fix');
        // "revert" by restoring the old line but with a tab, which patch-id would normalize away
        r.write('a.py', 'if x:\n\ty = 1\n'); const rev = r.commit('Revert "fix"\n\nThis reverts commit ' + x + '.');
        assert.equal(createGit(r.dir).verifyInverse(rev, x), false);
        assert.notEqual(x0, x);
    } finally { r.done(); }
});

test('a revert on top of intervening edits to the same path is unverified', () => {
    const r = repo();
    try {
        r.write('f.txt', 'v1\n'); r.commit('v1');
        r.write('f.txt', 'v2\n'); const x = r.commit('fix');
        r.write('f.txt', 'v3\n'); r.commit('later edit');
        r.write('f.txt', 'v1\n'); const rev = r.commit('Revert fix\n\nThis reverts commit ' + x + '.');
        assert.equal(createGit(r.dir).verifyInverse(rev, x), false);
    } finally { r.done(); }
});

test('binary files, mode-only changes, symlinks, deletes and adds are all object-level', () => {
    const r = repo();
    try {
        const git = createGit(r.dir);
        // binary change
        r.write('b.bin', Buffer.from([0, 1, 2, 255, 0, 7])); const b0 = r.commit('add bin');
        r.write('b.bin', Buffer.from([0, 9, 9, 255, 0, 7])); const bx = r.commit('change bin');
        r.g('revert', '--no-edit', bx);
        assert.equal(git.verifyInverse(r.g('rev-parse', 'HEAD'), bx), true, 'binary');
        // mode-only change
        r.write('run.sh', '#!/bin/sh\n', 0o644); r.commit('add script');
        chmodSync(path.join(r.dir, 'run.sh'), 0o755); const mx = r.commit('chmod +x');
        r.g('revert', '--no-edit', mx);
        assert.equal(git.verifyInverse(r.g('rev-parse', 'HEAD'), mx), true, 'mode');
        // symlink
        symlinkSync('base.txt', path.join(r.dir, 'link')); const sx = r.commit('add link');
        r.g('revert', '--no-edit', sx);
        assert.equal(git.verifyInverse(r.g('rev-parse', 'HEAD'), sx), true, 'symlink');
        // delete then restore
        unlinkSync(path.join(r.dir, 'base.txt')); const dx = r.commit('delete base');
        r.g('revert', '--no-edit', dx);
        assert.equal(git.verifyInverse(r.g('rev-parse', 'HEAD'), dx), true, 'delete/restore');
        // add then delete
        r.write('new.txt', 'n\n'); const ax = r.commit('add new');
        r.g('revert', '--no-edit', ax);
        assert.equal(git.verifyInverse(r.g('rev-parse', 'HEAD'), ax), true, 'add/delete');
        assert.notEqual(b0, bx);
    } finally { r.done(); }
});

test('revertState: fix, revert, revert-of-revert, another revert', () => {
    const r = repo();
    try {
        r.write('src.js', 'fixed\n'); const x = r.commit('fix');
        const git = createGit(r.dir);
        const head = () => r.g('rev-parse', 'HEAD');
        assert.equal(git.revertState([x], head()), 'no', 'no reverts');
        r.g('revert', '--no-edit', x);
        assert.equal(git.revertState([x], head()), 'yes', 'reverted');
        r.g('revert', '--no-edit', 'HEAD');
        assert.equal(git.revertState([x], head()), 'no', 'revert of the revert restores the fix');
        r.g('revert', '--no-edit', 'HEAD');
        assert.equal(git.revertState([x], head()), 'yes', 'another revert cancels it again');
    } finally { r.done(); }
});

test('revertState: a conflict-resolved or misleading revert makes the fix unknown, never restored or cancelled', () => {
    const r = repo();
    try {
        r.write('src.js', 'fixed\n'); const x = r.commit('fix');
        r.write('src.js', 'something else entirely\n');
        r.commit('Revert "fix"\n\nThis reverts commit ' + x + '.');
        const git = createGit(r.dir);
        assert.equal(git.revertState([x], r.g('rev-parse', 'HEAD')), 'unknown');
    } finally { r.done(); }
});

test('revertState: a revert-of-revert that does not exactly invert the first leaves the fix unknown', () => {
    const r = repo();
    try {
        r.write('src.js', 'fixed\n'); const x = r.commit('fix');
        r.g('revert', '--no-edit', x); const r1 = r.g('rev-parse', 'HEAD');
        r.write('src.js', 'fixed but different\n');
        r.commit('Revert "Revert fix"\n\nThis reverts commit ' + r1 + '.');
        const git = createGit(r.dir);
        assert.equal(git.revertState([x], r.g('rev-parse', 'HEAD')), 'unknown');
    } finally { r.done(); }
});

test('revertState: a PR-level revert edge ("Reverts #N") is verified the same way', () => {
    const r = repo();
    try {
        r.write('src.js', 'fixed\n'); const x = r.commit('fix (PR 10 merge)');
        r.g('revert', '--no-edit', x); const rev = r.g('rev-parse', 'HEAD');
        r.g('commit', '-q', '--amend', '-m', 'Revert PR 10'); const rev2 = r.g('rev-parse', 'HEAD');
        assert.notEqual(rev, rev2);
        const git = createGit(r.dir);
        assert.equal(git.revertState([x], rev2, { prReverts: [{ from: rev2, to: x }] }), 'yes');
        assert.equal(git.revertState([x], rev2), 'no', 'without the PR edge a message-less revert is not a candidate');
    } finally { r.done(); }
});

test('revertState: a multi-commit unit with only one commit reverted is unknown', () => {
    const r = repo();
    try {
        r.write('a.js', 'a\n'); const c1 = r.commit('part 1');
        r.write('b.js', 'b\n'); const c2 = r.commit('part 2');
        r.g('revert', '--no-edit', c2);
        const git = createGit(r.dir);
        assert.equal(git.revertState([c1, c2], r.g('rev-parse', 'HEAD')), 'unknown');
    } finally { r.done(); }
});

test('inclusion: original ancestor, cherry-pick -x equivalent, absent, and unknown', () => {
    const r = repo();
    try {
        r.g('checkout', '-q', '-b', 'nightly'); r.write('fix.js', 'fix\n'); const f = r.commit('fix on nightly');
        r.g('checkout', '-q', 'main'); r.write('rel.js', 'r\n'); const rel = r.commit('release only');
        const git = createGit(r.dir);
        assert.deepEqual(git.inclusion(f, f), { included: 'yes', via: 'original', fixCommits: [f] });
        assert.equal(git.inclusion(f, rel, { mainlineConsistent: true }).included, 'no');
        assert.equal(git.inclusion(f, rel).included, 'unknown', 'absence is only trusted on a consistent mainline');
        r.g('cherry-pick', '-x', f); const picked = r.g('rev-parse', 'HEAD');
        assert.deepEqual(git.inclusion(f, picked), { included: 'yes', via: 'equivalent', fixCommits: [picked] });
        assert.equal(git.inclusion('e'.repeat(40), picked).included, 'unknown');
    } finally { r.done(); }
});

test('a shallow history never yields a trusted "no"', () => {
    const r = repo();
    try {
        r.write('a.txt', 'a\n'); r.commit('a');
        r.write('b.txt', 'b\n'); r.commit('b');
        const clone = mkdtempSync(path.join(tmpdir(), 'adam-gf-clone-'));
        try {
            execFileSync('git', ['clone', '-q', '--depth', '1', 'file://' + r.dir, clone]);
            const git = createGit(clone);
            const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: clone, encoding: 'utf8' }).trim();
            assert.equal(git.shallow(), true);
            assert.equal(git.ancestor(head, head), 'yes');
            assert.equal(git.revertState([head], head), 'unknown');
        } finally { rmSync(clone, { recursive: true, force: true }); }
    } finally { r.done(); }
});
