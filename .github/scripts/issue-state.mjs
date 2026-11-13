// The issue-state engine. Pure and deterministic: no I/O, no wall clock. The same normalized input always yields the same
// output. All GitHub API and git work happens outside it; the collector hands it normalized facts.
//
// Governing principle: an issue may be auto-closed only with positive, branch-appropriate evidence that every active fix
// is present in a qualifying published release, no relevant revert is detected, and no human lifecycle override suppresses
// closure. Incomplete or ambiguous evidence ("unknown") never produces a fixed state or a closure.

export const MARKER = '<!-- adam-tracking:v1 -->';

// Labels the tracker owns. The workflow diffs `ownedLabels` against the issue within this universe only.
export const OWNED_LABELS = [
    'needs-triage', 'needs-info', 'in-progress', 'fixed-in-nightly', 'fixed-in-release',
    'closed-by-tracking', 'reopened-needs-review',
];

export const SUPPORTED_BASES = ['main', 'nightly'];

const YES = 'yes', NO = 'no', UNK = 'unknown';
const tri = (v) => (v === YES || v === NO ? v : UNK); // anything that is not a clear yes/no is unknown, never "no"

// Status of one merged fix on one branch.
//   effective: present and not reverted      reverted: present, effectively reverted (history only)
//   absent:    merged but not on this branch  unknown:  evidence missing or ambiguous
export function branchStatus(link, branch) {
    const inc = tri(branch === 'nightly' ? link.includedInNightly : link.includedInLatestRelease);
    const rev = tri(branch === 'nightly' ? link.revertedInNightly : link.revertedInLatestRelease);
    if (inc === NO) return 'absent';
    if (inc === UNK) return 'unknown';
    if (rev === YES) return 'reverted';
    if (rev === UNK) return 'unknown';
    return 'effective';
}

function isEligible(link) {
    return SUPPORTED_BASES.includes(link.base);
}

function summarize(fixes, branch) {
    const out = { effective: [], reverted: [], absent: [], unknown: [] };
    for (const l of fixes) out[branchStatus(l, branch)].push(l.prNumber);
    return out;
}

function table(links, repository) {
    const rows = [...links].sort((a, b) => a.prNumber - b.prNumber || (a.relation < b.relation ? -1 : 1)).map((l) => {
        const merged = l.state === 'merged' && l.relation === 'fix' && isEligible(l);
        const nightly = merged ? branchStatus(l, 'nightly') : '-';
        const release = merged ? branchStatus(l, 'release') : '-';
        return `| #${l.prNumber} | ${l.relation} | ${l.state} | ${l.base ?? '-'} | ${nightly} | ${release} |`;
    });
    const ref = repository?.latestMainlineRelease;
    return [
        '| PR | Link | State | Base | Nightly | Release |',
        '|---|---|---|---|---|---|',
        ...rows,
        '',
        ref?.tag ? `Reference release: \`${ref.tag}\`` : 'Reference release: none',
    ].join('\n');
}

export function computeIssueState({ issue, links = [], repository = {} }) {
    const labels = new Set(issue.labels ?? []);
    const notes = [];
    const open = issue.state === 'open';
    const diagnostics = issue.diagnosticsStatus ?? 'missing';
    const unreviewed = tri(issue.unreviewedReopen);
    const lastClosedByBot = tri(issue.lastClosedByBot);

    const eligible = links.filter(isEligible);
    for (const l of links) if (!isEligible(l)) notes.push(`#${l.prNumber} targets \`${l.base}\`, which is not tracked`);
    const fixes = eligible.filter((l) => l.relation === 'fix');
    const openFixes = fixes.filter((l) => l.state === 'open');
    const mergedFixes = fixes.filter((l) => l.state === 'merged');

    const nightly = summarize(mergedFixes, 'nightly');
    const release = summarize(mergedFixes, 'release');
    const ref = repository.latestMainlineRelease;
    const releaseKnown = Boolean(ref && ref.tag);
    const trusted = releaseKnown && ref.tagsImmutable === 'verified';

    const resolvedNightly = openFixes.length === 0 && nightly.effective.length > 0
        && nightly.absent.length === 0 && nightly.unknown.length === 0;
    let resolvedRelease = releaseKnown && openFixes.length === 0 && release.effective.length > 0
        && release.absent.length === 0 && release.unknown.length === 0;
    if (resolvedRelease && !trusted) {
        resolvedRelease = false;
        notes.push('release tags are not verified immutable, so release evidence is not trusted');
    }
    if (mergedFixes.length && !releaseKnown) notes.push('no qualifying mainline release is known');
    if (nightly.unknown.length) notes.push(`evidence on nightly is unknown for ${list(nightly.unknown)}`);
    if (releaseKnown && release.unknown.length) notes.push(`evidence in the release is unknown for ${list(release.unknown)}`);
    if (nightly.reverted.length) notes.push(`${list(nightly.reverted)} reverted on nightly`);
    if (releaseKnown && release.reverted.length) notes.push(`${list(release.reverted)} reverted in the release`);

    // A human reopened an issue the tracker had closed and nobody has reviewed it yet (or review is still pending).
    const hasReview = labels.has('reopened-needs-review') || unreviewed === YES;
    const blocked = labels.has('blocked');

    // State label: one at a time. reopened-needs-review > in-progress > needs-info > needs-triage.
    let state = null;
    if (open) {
        if (hasReview) state = 'needs-triage';
        else if (openFixes.length > 0) state = blocked ? null : 'in-progress';
        else if (!resolvedNightly) state = diagnostics === 'missing' ? 'needs-info' : 'needs-triage';
    }
    if (diagnostics === 'missing' && openFixes.length > 0 && !hasReview) notes.push('diagnostics are missing');

    // Resolution label: exclusive, evidence only, never while a review marker is present.
    let resolution = null;
    if (!hasReview) {
        if (resolvedRelease) resolution = 'fixed-in-release';
        else if (resolvedNightly) resolution = 'fixed-in-nightly';
    }

    // Closing: positive evidence on both branches, and every lifecycle gate open.
    const nightlyRegressed = nightly.reverted.length > 0;
    const shouldClose = open && resolution === 'fixed-in-release' && !hasReview && unreviewed === NO
        && !labels.has('keep-open') && !nightlyRegressed;
    if (open && resolution === 'fixed-in-release' && !shouldClose) {
        if (unreviewed === UNK) notes.push('reopen history is unknown, so the issue is not closed');
        else if (nightlyRegressed) notes.push('a fix was reverted on nightly, so the issue is not closed');
    }

    // Lifecycle markers.
    let closedBy = false;
    if (!open) closedBy = lastClosedByBot === YES || (labels.has('closed-by-tracking') && lastClosedByBot !== NO);
    else closedBy = labels.has('closed-by-tracking') && !hasReview && unreviewed === UNK;

    const owned = new Set();
    if (state) owned.add(state);
    if (resolution) owned.add(resolution);
    if (closedBy) owned.add('closed-by-tracking');
    if (hasReview) owned.add('reopened-needs-review');

    const parts = [
        MARKER,
        '**Adam issue tracker** (maintained automatically; edits are overwritten)',
        '',
        `State: ${[state, resolution].filter(Boolean).join(', ') || 'none'}`,
        '',
        table(links, repository),
    ];
    if (notes.length) parts.push('', 'Notes:', ...notes.map((n) => `- ${n}`));

    return {
        ownedLabels: OWNED_LABELS.filter((l) => owned.has(l)),
        shouldClose,
        labelsAfterClose: ['closed-by-tracking'],
        trackingComment: parts.join('\n'),
        notes,
    };
}

function list(numbers) {
    return numbers.map((n) => `#${n}`).join(', ');
}
