// Fixture suite for the issue-state engine (.github/scripts/issue-state.mjs). Every row of the plan's release-gate table
// that concerns the engine has a case here.
//   node --test electron/test/github/issue-state.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeIssueState, MARKER } from '../../../.github/scripts/issue-state.mjs';
import { issue, fix, open, abandoned, ref, repoRelease } from './helpers.mjs';

const run = (i, links, repository = repoRelease()) => computeIssueState({ issue: issue(i), links, repository });
const has = (r, label) => r.ownedLabels.includes(label);

test('a fix merged on nightly and in the release resolves the issue and closes it', () => {
    const r = run({}, [fix(1)]);
    assert.ok(has(r, 'fixed-in-release'));
    assert.ok(!has(r, 'fixed-in-nightly'), 'resolution labels are exclusive');
    assert.equal(r.shouldClose, true);
});

test('merged on nightly but not yet in the release: fixed-in-nightly, stays open', () => {
    const r = run({}, [fix(1, { includedInLatestRelease: 'no' })]);
    assert.deepEqual(r.ownedLabels, ['fixed-in-nightly']);
    assert.equal(r.shouldClose, false);
});

test('no fixes at all: needs-triage, or needs-info when diagnostics are missing', () => {
    assert.deepEqual(run({}, []).ownedLabels, ['needs-triage']);
    assert.deepEqual(run({ diagnosticsStatus: 'missing' }, []).ownedLabels, ['needs-info']);
    assert.deepEqual(run({ diagnosticsStatus: 'waived' }, []).ownedLabels, ['needs-triage']);
});

test('all linked PRs abandoned returns the issue to triage', () => {
    assert.deepEqual(run({}, [abandoned(1), abandoned(2)]).ownedLabels, ['needs-triage']);
});

test('an abandoned PR plus a successful replacement: the replacement resolves', () => {
    const r = run({}, [abandoned(1), fix(2)]);
    assert.ok(has(r, 'fixed-in-release'));
    assert.equal(r.shouldClose, true);
});

test('all fixes reverted never produces a fixed state (no vacuous truth)', () => {
    const r = run({}, [fix(1, { revertedInNightly: 'yes', revertedInLatestRelease: 'yes' })]);
    assert.deepEqual(r.ownedLabels, ['needs-triage']);
    assert.equal(r.shouldClose, false);
});

test('multiple PRs, one still open: in-progress and nothing resolves', () => {
    const r = run({}, [fix(1), open(2)]);
    assert.deepEqual(r.ownedLabels, ['in-progress']);
    assert.equal(r.shouldClose, false);
});

test('an open fix PR wins over missing diagnostics, which are only noted', () => {
    const r = run({ diagnosticsStatus: 'missing' }, [open(2)]);
    assert.deepEqual(r.ownedLabels, ['in-progress']);
    assert.match(r.notes.join('\n'), /diagnostics are missing/);
});

test('a fix PR opening on a needs-info issue moves it to in-progress; closing it unmerged goes back', () => {
    assert.deepEqual(run({ labels: ['needs-info'], diagnosticsStatus: 'missing' }, [open(3)]).ownedLabels, ['in-progress']);
    assert.deepEqual(run({ diagnosticsStatus: 'missing' }, [abandoned(3)]).ownedLabels, ['needs-info']);
    assert.deepEqual(run({ diagnosticsStatus: 'valid' }, [abandoned(3)]).ownedLabels, ['needs-triage']);
});

test('blocked: in-progress is never set, blocked is never touched', () => {
    const r = run({ labels: ['blocked', 'in-progress'] }, [open(2)]);
    assert.ok(!has(r, 'in-progress'));
    assert.ok(!r.ownedLabels.includes('blocked'));
});

test('a fix reverted on nightly but effective in the release resolves the release, not nightly', () => {
    const r = run({}, [fix(1, { revertedInNightly: 'yes' })]);
    assert.ok(has(r, 'fixed-in-release'));
    assert.ok(!has(r, 'fixed-in-nightly'));
    assert.ok(has(r, 'needs-triage'), 'nightly is not resolved, so the issue keeps a state label');
    assert.equal(r.shouldClose, false, 'a regression on nightly is not closed over');
});

test('a fix merged then reverted on nightly is never fixed-in-nightly even though it is an ancestor', () => {
    const r = run({}, [fix(1, { includedInLatestRelease: 'no', revertedInNightly: 'yes' })]);
    assert.ok(!has(r, 'fixed-in-nightly'));
});

test('unknown never counts as no: it blocks that branch only', () => {
    const r = run({}, [fix(1, { includedInLatestRelease: 'unknown' })]);
    assert.deepEqual(r.ownedLabels, ['fixed-in-nightly']);
    assert.equal(r.shouldClose, false);
    const r2 = run({}, [fix(1, { includedInNightly: 'unknown' })]);
    assert.ok(has(r2, 'fixed-in-release'), 'unknown on nightly does not block the release evaluation');
    assert.equal(r2.shouldClose, true);
    const r3 = run({}, [fix(1, { revertedInLatestRelease: 'unknown' })]);
    assert.ok(!has(r3, 'fixed-in-release'));
    assert.equal(r3.shouldClose, false);
});

test('anything that is not a clear yes or no is unknown, not a boolean', () => {
    const r = run({}, [fix(1, { includedInLatestRelease: true, includedInNightly: 'yes' })]);
    assert.ok(!has(r, 'fixed-in-release'));
});

test('an open fix PR on an unsupported base branch has no effect', () => {
    const r = run({}, [open(9, { base: 'feature/x' })]);
    assert.deepEqual(r.ownedLabels, ['needs-triage']);
    assert.match(r.notes.join('\n'), /not tracked/);
});

test('a fix merged straight to main resolves by containment, not by base name', () => {
    const r = run({}, [fix(1, { base: 'main' })]);
    assert.ok(has(r, 'fixed-in-release'));
});

test('references never change state', () => {
    const r = run({}, [ref(4)]);
    assert.deepEqual(r.ownedLabels, ['needs-triage']);
});

test('untrusted release tags: no fixed-in-release and no close, with a note', () => {
    for (const tagsImmutable of ['unverified', 'unknown']) {
        const r = run({}, [fix(1)], repoRelease({ tagsImmutable }));
        assert.ok(!has(r, 'fixed-in-release'));
        assert.equal(r.shouldClose, false);
        assert.match(r.notes.join('\n'), /not verified immutable/);
    }
});

test('no reference release at all: nothing is fixed-in-release', () => {
    const r = run({}, [fix(1, { includedInNightly: 'yes' })], {});
    assert.ok(!has(r, 'fixed-in-release'));
    assert.deepEqual(r.ownedLabels, ['fixed-in-nightly']);
});

test('keep-open blocks the close but not the label', () => {
    const r = run({ labels: ['keep-open', 'fixed-in-release'] }, [fix(1)]);
    assert.ok(has(r, 'fixed-in-release'));
    assert.equal(r.shouldClose, false);
    assert.ok(!has(r, 'reopened-needs-review'), 'fixed-in-release alone is never reopen evidence');
});

test('keep-open removed afterwards: the tracker closes normally, no marker', () => {
    const r = run({ labels: ['fixed-in-release'] }, [fix(1)]);
    assert.equal(r.shouldClose, true);
    assert.ok(!has(r, 'reopened-needs-review'));
});

test('shouldClose is never true on a closed issue', () => {
    assert.equal(run({ state: 'closed', labels: ['fixed-in-release'] }, [fix(1)]).shouldClose, false);
});

test('a manually closed issue gets no state labels and no inferred fix', () => {
    const r = run({ state: 'closed', labels: ['in-progress', 'needs-info'] }, []);
    assert.deepEqual(r.ownedLabels, []);
    const r2 = run({ state: 'closed', labels: ['fixed-in-release'] }, []);
    assert.deepEqual(r2.ownedLabels, [], 'stale fixed-in-release is removed without evidence');
});

test('closed by the tracker: closed-by-tracking is kept or repaired from the last closed event', () => {
    assert.ok(has(run({ state: 'closed', lastClosedByBot: 'yes' }, [fix(1)]), 'closed-by-tracking'));
    assert.ok(has(run({ state: 'closed', lastClosedByBot: 'unknown', labels: ['closed-by-tracking'] }, [fix(1)]), 'closed-by-tracking'));
    assert.ok(!has(run({ state: 'closed', lastClosedByBot: 'no', labels: ['closed-by-tracking'] }, [fix(1)]), 'closed-by-tracking'));
});

test('a human reopen after a tracker close adds the review marker and consumes closed-by-tracking', () => {
    const r = run({ labels: ['closed-by-tracking', 'fixed-in-release'], unreviewedReopen: 'yes' }, [fix(1)]);
    assert.ok(has(r, 'reopened-needs-review'));
    assert.ok(!has(r, 'closed-by-tracking'));
    assert.ok(!has(r, 'fixed-in-release'));
    assert.ok(!has(r, 'fixed-in-nightly'));
    assert.equal(r.shouldClose, false);
});

test('the review marker forces needs-triage whatever the diagnostics or open PRs say', () => {
    for (const diagnosticsStatus of ['valid', 'missing', 'waived']) {
        const r = run({ labels: ['reopened-needs-review'], diagnosticsStatus }, [open(5)]);
        assert.deepEqual(r.ownedLabels, ['needs-triage', 'reopened-needs-review'], diagnosticsStatus);
    }
    const noPr = run({ labels: ['reopened-needs-review'], diagnosticsStatus: 'missing' }, []);
    assert.deepEqual(noPr.ownedLabels, ['needs-triage', 'reopened-needs-review']);
    assert.match(run({ labels: ['reopened-needs-review'] }, [open(5)]).trackingComment, /#5 \| fix \| open/);
});

test('the engine never removes the review marker, and a cleared one does not block a later close', () => {
    assert.ok(has(run({ labels: ['reopened-needs-review'] }, [fix(1)]), 'reopened-needs-review'));
    // maintainer cleared it: the marker is gone, unreviewedReopen is no, tracker closes again
    const r = run({ labels: ['fixed-in-release'], unreviewedReopen: 'no' }, [fix(1)]);
    assert.equal(r.shouldClose, true);
});

test('unknown reopen history blocks the close but does not invent a marker', () => {
    const r = run({ labels: ['fixed-in-release'], unreviewedReopen: 'unknown' }, [fix(1)]);
    assert.equal(r.shouldClose, false);
    assert.ok(!has(r, 'reopened-needs-review'));
    assert.match(r.notes.join('\n'), /reopen history is unknown/);
});

test('an open issue keeps closed-by-tracking only while the reopen history is unknown', () => {
    assert.ok(has(run({ labels: ['closed-by-tracking'], unreviewedReopen: 'unknown' }, []), 'closed-by-tracking'));
    assert.ok(!has(run({ labels: ['closed-by-tracking'], unreviewedReopen: 'no' }, []), 'closed-by-tracking'));
});

test('the output is deterministic and the comment is sorted and free of timestamps and titles', () => {
    const links = [fix(7), fix(3), ref(5)];
    const a = run({}, links);
    const b = run({}, [...links].reverse());
    assert.deepEqual(a, b);
    assert.ok(a.trackingComment.startsWith(MARKER));
    assert.ok(a.trackingComment.indexOf('#3') < a.trackingComment.indexOf('#5'));
    assert.ok(a.trackingComment.indexOf('#5') < a.trackingComment.indexOf('#7'));
    assert.doesNotMatch(a.trackingComment, /\d{4}-\d{2}-\d{2}/);
});

test('the engine only ever returns labels from its own universe', () => {
    const r = run({ labels: ['bug', 'P1', 'blocked', 'keep-open', 'comp:playback'] }, [fix(1)]);
    for (const l of r.ownedLabels) assert.match(l, /^(needs-triage|needs-info|in-progress|fixed-in-nightly|fixed-in-release|closed-by-tracking|reopened-needs-review)$/);
});
