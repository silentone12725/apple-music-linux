// Shared builders for the tracking tests.
export const repoRelease = (over = {}) => ({ latestMainlineRelease: { tag: 'v1.6.0', sha: 'r'.repeat(40), tagsImmutable: 'verified', ...over } });

export const issue = (over = {}) => ({
    number: 50, state: 'open', labels: [], authorId: 1, diagnosticsStatus: 'valid',
    unreviewedReopen: 'no', lastClosedByBot: 'no', ...over,
});

// A merged fix PR, present and unreverted on both branches unless overridden.
export const fix = (prNumber, over = {}) => ({
    relation: 'fix', prNumber, state: 'merged', base: 'nightly', mergeSha: String(prNumber).padStart(40, 'a'),
    includedInNightly: 'yes', revertedInNightly: 'no', includedInLatestRelease: 'yes', revertedInLatestRelease: 'no', ...over,
});

export const open = (prNumber, over = {}) => ({ relation: 'fix', prNumber, state: 'open', base: 'nightly', ...over });
export const abandoned = (prNumber) => ({ relation: 'fix', prNumber, state: 'closed', base: 'nightly' });
export const ref = (prNumber) => ({ relation: 'ref', prNumber, state: 'open', base: 'nightly' });
