// Tests for the reconciler (.github/scripts/reconcile.mjs) against an in-memory GitHub and a scripted git.
//   node --test electron/test/github/reconcile.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, lifecycleFacts } from '../../../.github/scripts/reconcile.mjs';
import { MARKER } from '../../../.github/scripts/issue-state.mjs';
import {
    fakeGitHub, fakeGit, release, tagRuleset, manifest, mkIssue, mkPull, formBody, BOT, HUMAN, SHA,
} from './fake-github.mjs';

const world = (over = {}) => fakeGitHub({
    issues: [mkIssue()], pulls: [mkPull()], releases: [release()], rulesets: [tagRuleset()], ...over,
});
const go = (w, git = fakeGit(), extra = {}) => reconcile({ client: w.client, git, manifest, ...extra });

test('a fix in a verified release closes the issue, labels it and writes one tracking comment', async () => {
    const w = world();
    const r = await go(w);
    assert.equal(r.aborted, false);
    assert.deepEqual(r.errors, []);
    const i = w.find(50);
    assert.equal(i.state, 'closed');
    assert.deepEqual(w.names(i).sort(), ['closed-by-tracking', 'fixed-in-release']);
    assert.equal(w.s.comments[50].length, 1);
    assert.ok(w.s.comments[50][0].body.startsWith(MARKER));
});

test('reruns are no-ops: after one run a second run makes no mutation at all', async () => {
    const w = world();
    await go(w);
    w.s.calls.length = 0;
    const again = await go(w);
    assert.deepEqual(again.actions, []);
    assert.equal(w.mutating().length, 0);
});

test('incomplete collection mutates nothing', async () => {
    for (const failing of ['/pulls', '/releases', '/issues?']) {
        const w = world();
        w.s.fail.add(failing);
        const r = await go(w);
        assert.equal(r.aborted, true, failing);
        assert.equal(w.mutating().length, 0, failing);
        assert.equal(w.find(50).state, 'open');
    }
});

test('an unreadable issue timeline degrades to unknown: no close, no invented marker, the rest of the run continues', async () => {
    const w = world({ issues: [mkIssue({ labels: [{ name: 'fixed-in-release' }] })] });
    w.s.fail.add('/issues/50/timeline');
    const r = await go(w);
    assert.equal(r.aborted, false);
    assert.equal(w.find(50).state, 'open');
    assert.ok(!w.names(w.find(50)).includes('reopened-needs-review'));
    assert.match(r.summary.join('\n'), /timeline could not be read/);
});

test('dry run plans actions and applies none', async () => {
    const w = world();
    const r = await go(w, fakeGit(), { dryRun: true });
    assert.ok(r.actions.length > 0);
    assert.equal(w.mutating().length, 0);
    assert.equal(w.find(50).state, 'open');
});

test('fixed on nightly but not in the release: labelled, commented, left open', async () => {
    const w = world();
    await go(w, fakeGit({ fixInRelease: false }));
    const i = w.find(50);
    assert.equal(i.state, 'open');
    assert.deepEqual(w.names(i), ['fixed-in-nightly']);
});

test('release tags that are not verified immutable never close an issue', async () => {
    for (const mutate of [
        (w) => { w.s.rulesets = []; },
        (w) => { w.s.rulesets = [tagRuleset({ enforcement: 'evaluate' })]; },
        (w) => { w.s.rulesets = [tagRuleset({ bypass_actors: [{ actor_type: 'RepositoryRole' }] })]; },
        (w) => { w.s.rulesets = [tagRuleset({ rules: [{ type: 'update' }] })]; },
    ]) {
        const w = world();
        mutate(w);
        await go(w);
        assert.equal(w.find(50).state, 'open');
        assert.ok(!w.names(w.find(50)).includes('fixed-in-release'));
    }
    const w = world();
    await reconcile({ client: w.client, git: fakeGit(), manifest: { tags: {} } });
    assert.equal(w.find(50).state, 'open', 'no manifest entry');
    const w2 = world();
    await reconcile({ client: w2.client, git: fakeGit(), manifest: { tags: { 'v1.6.0': 'x'.repeat(40) } } });
    assert.equal(w2.find(50).state, 'open', 'manifest SHA differs from the tag');
});

test('draft, prerelease and unpublished releases do not qualify', async () => {
    for (const over of [{ draft: true }, { prerelease: true }, { published_at: null }]) {
        const w = world({ releases: [release(over)] });
        await go(w);
        assert.equal(w.find(50).state, 'open', JSON.stringify(over));
    }
});

test('an open fix PR makes the issue in-progress, and abandoning it returns it to triage', async () => {
    const w = world({ pulls: [mkPull({ state: 'open', merged_at: null, merge_commit_sha: null })] });
    await go(w);
    assert.deepEqual(w.names(w.find(50)), ['in-progress']);
    w.s.pulls[0].state = 'closed';
    await go(w);
    assert.deepEqual(w.names(w.find(50)), ['needs-triage']);
});

test('references that are PRs or do not exist are ignored; no tracking comment without links', async () => {
    const w = world({
        issues: [mkIssue(), mkIssue({ number: 51, labels: [], body: formBody() })],
        pulls: [mkPull({ body: 'Fixes #1, #999' })],
    });
    const r = await go(w);
    assert.match(r.summary.join('\n'), /#999.*not an issue/);
    assert.equal(w.s.comments[50]?.length ?? 0, 0);
    assert.equal(w.s.comments[51]?.length ?? 0, 0);
    assert.deepEqual(w.names(w.find(50)), ['needs-triage']);
});

test('missing diagnostics gives needs-info, and a valid block from the author clears it', async () => {
    const w = world({ issues: [mkIssue({ body: formBody('') })], pulls: [] });
    await go(w);
    assert.deepEqual(w.names(w.find(50)), ['needs-info']);
    const comment = ['Adam diagnostics v1', 'formatVersion: 1', 'version: 1', 'channel: n', 'os: x', 'arch: y', 'install: z'].join('\n');
    w.s.comments[50] = [{ id: 1, body: comment, user: { id: 9, type: 'User' } }];
    await go(w);
    assert.deepEqual(w.names(w.find(50)), ['needs-triage']);
    w.s.comments[50] = [{ id: 1, body: comment, user: { id: 123, type: 'User' } }];
    await go(w);
    assert.deepEqual(w.names(w.find(50)), ['needs-info'], 'a block from someone else does not count');
});

test('tracker close, then a human reopen: the marker is added and the issue is never closed again', async () => {
    const w = world();
    await go(w);
    const i = w.find(50);
    assert.equal(i.state, 'closed');
    i.state = 'open'; // a human reopens it
    w.s.timelines[50].push({ event: 'reopened', actor: HUMAN });
    await go(w);
    assert.ok(w.names(i).includes('reopened-needs-review'));
    assert.ok(!w.names(i).includes('closed-by-tracking'));
    assert.ok(!w.names(i).includes('fixed-in-release'));
    assert.equal(i.state, 'open');
    await go(w);
    assert.equal(i.state, 'open', 'a later scheduled run does not undo the marker or close again');
    assert.ok(w.names(i).includes('reopened-needs-review'));
});

test('tracker close -> reopen -> maintainer clears the marker -> tracker closes again', async () => {
    const w = world();
    await go(w);
    const i = w.find(50);
    i.state = 'open';
    w.s.timelines[50].push({ event: 'reopened', actor: HUMAN });
    await go(w);
    i.labels = i.labels.filter((l) => l.name !== 'reopened-needs-review');
    w.s.timelines[50].push({ event: 'unlabeled', label: { name: 'reopened-needs-review' }, actor: HUMAN });
    await go(w);
    assert.equal(i.state, 'closed');
    assert.ok(w.names(i).includes('closed-by-tracking'));
});

test('deleting the tracking comment does not change the lifecycle', async () => {
    const w = world();
    await go(w);
    const i = w.find(50);
    delete w.s.comments[50];
    i.state = 'open';
    w.s.timelines[50].push({ event: 'reopened', actor: HUMAN });
    await go(w);
    assert.ok(w.names(i).includes('reopened-needs-review'));
    assert.equal(w.s.comments[50].length, 1, 'and the comment is rebuilt from GitHub state');
});

test('keep-open with fixed-in-release stays open and stable across runs; removing keep-open then closes it', async () => {
    const w = world({ issues: [mkIssue({ labels: [{ name: 'keep-open' }] })] });
    await go(w); await go(w);
    const i = w.find(50);
    assert.equal(i.state, 'open');
    assert.deepEqual(w.names(i).sort(), ['fixed-in-release', 'keep-open']);
    i.labels = i.labels.filter((l) => l.name !== 'keep-open');
    await go(w);
    assert.equal(i.state, 'closed');
    assert.ok(!w.names(i).includes('reopened-needs-review'));
});

test('a failed close is retried next run without a marker or closed-by-tracking', async () => {
    const w = world();
    w.s.fail.add('PATCH /issues/50');
    const r = await go(w);
    assert.equal(w.find(50).state, 'open');
    assert.ok(r.errors.length > 0);
    assert.ok(w.names(w.find(50)).includes('fixed-in-release'));
    assert.ok(!w.names(w.find(50)).includes('closed-by-tracking'));
    w.s.fail.clear();
    await go(w);
    assert.equal(w.find(50).state, 'closed');
});

test('a missing closed-by-tracking label is repaired when the last close was the bot', async () => {
    const w = world();
    await go(w);
    const i = w.find(50);
    i.labels = i.labels.filter((l) => l.name !== 'closed-by-tracking');
    await go(w);
    assert.ok(w.names(i).includes('closed-by-tracking'));
});

test('a manual close is respected and never reopened; no fix is inferred from it', async () => {
    const w = world({ issues: [mkIssue({ state: 'closed', labels: [{ name: 'in-progress' }] })], pulls: [] });
    w.s.timelines[50] = [{ event: 'closed', actor: HUMAN }];
    await go(w);
    assert.equal(w.find(50).state, 'closed');
    assert.deepEqual(w.names(w.find(50)), []);
});

test('a native close (by a commit) raises a warning in the job summary', async () => {
    const w = world({ issues: [mkIssue({ state: 'closed', labels: [{ name: 'fixed-in-release' }] })] });
    w.s.timelines[50] = [{ event: 'closed', actor: HUMAN, commit_id: 'abc' }];
    const r = await go(w);
    assert.match(r.summary.join('\n'), /native auto-close observed/);
});

test('merge-commit settings drift and invisible settings are reported, never silently OK', async () => {
    const w = world({ settings: { squash_merge_commit_title: 'COMMIT_OR_PR_TITLE' } });
    const r = await go(w);
    assert.match(r.summary.join('\n'), /squash_merge_commit_title/);
    assert.match(r.summary.join('\n'), /not visible to this token/);
});

test('unknown git evidence blocks resolution', async () => {
    const w = world();
    const git = fakeGit();
    git.inclusion = () => ({ included: 'unknown', via: null, fixCommits: [] });
    await go(w, git);
    assert.equal(w.find(50).state, 'open');
    assert.deepEqual(w.names(w.find(50)), ['needs-triage']);
});

test('a reverted fix never resolves', async () => {
    const w = world();
    await go(w, fakeGit({ reverted: 'yes' }));
    assert.equal(w.find(50).state, 'open');
    assert.deepEqual(w.names(w.find(50)), ['needs-triage']);
});

test('lifecycleFacts: bot close, human reopen, review, and an unreadable timeline', () => {
    const closeBot = { event: 'closed', actor: BOT };
    const reopen = { event: 'reopened', actor: HUMAN };
    const clear = { event: 'unlabeled', label: { name: 'reopened-needs-review' }, actor: HUMAN };
    assert.equal(lifecycleFacts([closeBot, reopen], 'open').unreviewedReopen, 'yes');
    assert.equal(lifecycleFacts([closeBot, reopen, clear], 'open').unreviewedReopen, 'no');
    assert.equal(lifecycleFacts([closeBot, reopen, clear, closeBot], 'closed').lastClosedByBot, 'yes');
    assert.equal(lifecycleFacts([{ event: 'closed', actor: HUMAN }], 'closed').lastClosedByBot, 'no');
    assert.equal(lifecycleFacts([reopen], 'open').unreviewedReopen, 'no', 'a reopen of an issue the tracker never closed');
    assert.deepEqual(lifecycleFacts(null, 'open'), { unreviewedReopen: 'unknown', lastClosedByBot: 'unknown', nativeClose: false });
    assert.equal(SHA.fix.length, 40);
});
