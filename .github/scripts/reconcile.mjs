// Reconciliation: collect GitHub and git state, validate it, compute every issue's desired state with the pure engine, and
// only then apply the differences. Every run reconciles all issues, so a dropped or repeated run changes nothing.
//
//   If collection is incomplete (a page failed, a 403/429, missing permission) NOTHING is mutated: missing data is never
//   read as "does not exist". Mutations are diff-only and idempotent; the tracking comment is a projection that is rebuilt
//   from GitHub state, never a source of truth.
import { pathToFileURL } from 'node:url';
import { appendFileSync, readFileSync } from 'node:fs';
import { computeIssueState, MARKER, OWNED_LABELS, SUPPORTED_BASES } from './issue-state.mjs';
import { parseReferences, parseRevertedPrs } from './parse-refs.mjs';
import { parseIssueForm } from './triage.mjs';
import { diagnosticsStatus } from './diagnostics-block.mjs';
import { tagsImmutable } from './release-trust.mjs';

const isBot = (a) => a?.type === 'Bot' || /\[bot\]$/.test(a?.login ?? '');
const LIFECYCLE_LABELS = ['closed-by-tracking', 'fixed-in-release', 'reopened-needs-review'];
const MERGE_FIELDS = { squash_merge_commit_title: 'PR_TITLE', squash_merge_commit_message: 'BLANK', merge_commit_title: 'PR_TITLE', merge_commit_message: 'BLANK' };

// Lifecycle facts from an issue timeline (chronological events). `events === null` means it could not be read completely.
export function lifecycleFacts(events, state) {
    if (!events) return { unreviewedReopen: 'unknown', lastClosedByBot: 'unknown', nativeClose: false };
    let lastClose = -1, lastBotClose = -1, nativeClose = false;
    events.forEach((e, i) => {
        if (e.event !== 'closed') return;
        lastClose = i;
        if (isBot(e.actor)) lastBotClose = i;
        else if (e.commit_id) nativeClose = true;
    });
    let lastClosedByBot = 'no';
    if (state === 'closed') lastClosedByBot = lastClose < 0 ? 'unknown' : lastClose === lastBotClose ? 'yes' : 'no';
    let unreviewedReopen = 'no';
    if (lastBotClose >= 0) {
        let lastReopen = -1;
        events.forEach((e, i) => { if (i > lastBotClose && e.event === 'reopened' && !isBot(e.actor)) lastReopen = i; });
        if (lastReopen >= 0) {
            const cleared = events.some((e, i) => i > lastReopen && e.event === 'unlabeled' && e.label?.name === 'reopened-needs-review' && !isBot(e.actor));
            unreviewedReopen = cleared ? 'no' : 'yes';
        }
    }
    return { unreviewedReopen, lastClosedByBot, nativeClose };
}

export async function reconcile({ client, git, refs = { main: 'origin/main', nightly: 'origin/nightly' }, manifest = { tags: {} }, dryRun = false, log = () => {} }) {
    const repo = client.repo;
    const errors = [];
    const summary = [];
    const take = (path) => {
        const r = client.paginate(path);
        if (!r.complete) errors.push(r.error);
        return r.items;
    };

    // 1. Collect.
    const items = take('/issues?state=all');
    const pulls = take('/pulls?state=all');
    const releases = take('/releases');
    let rulesets = null;
    const rl = client.paginate('/rulesets');
    if (rl.complete) {
        const details = rl.items.map((r) => client.get(`/rulesets/${r.id}`));
        rulesets = details.every((d) => d.ok) ? details.map((d) => d.data) : null;
    }
    const settings = client.get('');
    if (errors.length) {
        log(`collection incomplete, nothing will be changed: ${errors.join('; ')}`);
        return { aborted: true, errors, actions: [], summary: [`Collection incomplete, no changes were made: ${errors.join('; ')}`] };
    }

    // 2. Repository-level facts.
    const issues = new Map(items.filter((i) => !i.pull_request).map((i) => [i.number, i]));
    const prByNumber = new Map(pulls.map((p) => [p.number, p]));
    const mainSha = git.resolve(refs.main);
    const nightlySha = git.resolve(refs.nightly);
    const mainlineConsistent = Boolean(mainSha && nightlySha && git.ancestor(mainSha, nightlySha) === 'yes');
    if (git.shallow()) summary.push('The git history is shallow, so ancestry evidence is unknown (use fetch-depth: 0).');

    const qualifying = releases.filter((r) => !r.draft && !r.prerelease && r.published_at)
        .map((r) => ({ tag: r.tag_name, sha: git.resolve(`refs/tags/${r.tag_name}`) }));
    for (const r of qualifying.filter((x) => !x.sha)) summary.push(`Release tag ${r.tag} does not resolve to a commit and is ignored.`);
    const mainline = qualifying.filter((r) => r.sha && mainSha && git.ancestor(r.sha, mainSha) === 'yes');
    const reference = mainline.find((c) => mainline.every((o) => o === c || git.ancestor(o.sha, c.sha) === 'yes')) ?? null;
    if (mainline.length > 1 && !reference) summary.push('Mainline releases are not totally ordered; no reference release.');
    const releaseInfo = reference
        ? { tag: reference.tag, sha: reference.sha, tagsImmutable: tagsImmutable({ tag: reference.tag, resolvedSha: reference.sha, manifest, rulesets }) }
        : null;
    if (releaseInfo && releaseInfo.tagsImmutable !== 'verified') summary.push(`Release ${releaseInfo.tag}: tag immutability is ${releaseInfo.tagsImmutable}; release evidence is not trusted.`);

    // merge-message settings drift
    if (settings.ok) {
        const drift = Object.entries(MERGE_FIELDS).filter(([k, v]) => settings.data?.[k] !== undefined && settings.data[k] !== v);
        const hidden = Object.keys(MERGE_FIELDS).filter((k) => settings.data?.[k] === undefined);
        if (drift.length) summary.push(`Merge-commit settings differ from the plan: ${drift.map(([k]) => k).join(', ')}.`);
        if (hidden.length) summary.push('Merge-commit settings are not visible to this token (unverifiable).');
    } else summary.push('Repository settings could not be read (unverifiable).');

    // PR-level reverts: "Reverts #N" in a merged PR's body.
    const prReverts = [];
    for (const p of pulls) {
        if (!p.merged_at || !p.merge_commit_sha) continue;
        for (const n of parseRevertedPrs(p.body, repo)) {
            const target = prByNumber.get(n);
            if (target?.merged_at && target.merge_commit_sha) prReverts.push({ from: p.merge_commit_sha, to: target.merge_commit_sha });
        }
    }

    const factCache = new Map();
    const branchFacts = (mergeSha, candidate) => {
        if (!mergeSha || !candidate) return { included: 'unknown', reverted: 'unknown' };
        const key = `${mergeSha}|${candidate}`;
        if (!factCache.has(key)) {
            const inc = git.inclusion(mergeSha, candidate, { mainlineConsistent });
            let reverted = 'unknown';
            if (inc.included === 'no') reverted = 'no';
            else if (inc.included === 'yes') reverted = git.revertState(inc.fixCommits, candidate, { prReverts });
            factCache.set(key, { included: inc.included, reverted, via: inc.via, fixCommits: inc.fixCommits });
        }
        return factCache.get(key);
    };

    // 3. Links per issue, from PR bodies (data only; fork PR text is never executed).
    const linksByIssue = new Map();
    for (const p of pulls) {
        const prState = p.state === 'open' ? 'open' : p.merged_at ? 'merged' : 'closed';
        for (const r of parseReferences(p.body, repo)) {
            if (!issues.has(r.number)) { if (r.number !== p.number) summary.push(`#${p.number} references #${r.number}, which is not an issue in this repository; ignored.`); continue; }
            const link = { relation: r.kind, prNumber: p.number, state: prState, base: p.base?.ref, mergeSha: p.merge_commit_sha ?? null };
            if (r.kind === 'fix' && prState === 'merged' && SUPPORTED_BASES.includes(link.base)) {
                const n = branchFacts(p.merge_commit_sha, nightlySha);
                const rel = releaseInfo ? branchFacts(p.merge_commit_sha, releaseInfo.sha) : { included: 'unknown', reverted: 'unknown' };
                Object.assign(link, {
                    includedInNightly: n.included, revertedInNightly: n.reverted,
                    includedInLatestRelease: rel.included, revertedInLatestRelease: rel.reverted,
                });
            }
            if (!linksByIssue.has(r.number)) linksByIssue.set(r.number, []);
            linksByIssue.get(r.number).push(link);
        }
    }

    // 4. Per-issue inputs, compute, and plan the differences.
    const plan = [];
    for (const issue of [...issues.values()].sort((a, b) => a.number - b.number)) {
        const labels = issue.labels.map((l) => (typeof l === 'string' ? l : l.name));
        const links = linksByIssue.get(issue.number) ?? [];
        const hasMergedFix = links.some((l) => l.relation === 'fix' && l.state === 'merged');
        const needsTimeline = hasMergedFix || labels.some((l) => LIFECYCLE_LABELS.includes(l));
        let events = [];
        if (needsTimeline) {
            const t = client.paginate(`/issues/${issue.number}/timeline`);
            if (!t.complete) { events = null; summary.push(`#${issue.number}: timeline could not be read completely; closure blocked.`); }
            else events = t.items;
        }
        const life = lifecycleFacts(events, issue.state);
        if (life.nativeClose) summary.push(`#${issue.number}: native auto-close observed (closed by a commit or merge); check the repository setting "Auto-close issues with merged linked pull requests".`);

        const fields = parseIssueForm(issue.body);
        let comments = [];
        let diag = diagnosticsStatus({ fields, authorId: issue.user?.id, comments });
        if (diag === 'missing' && issue.state === 'open') {
            const c = client.paginate(`/issues/${issue.number}/comments`);
            if (!c.complete) { errors.push(c.error); break; }
            comments = c.items.map((x) => ({ authorId: x.user?.id, authorType: x.user?.type, body: x.body }));
            diag = diagnosticsStatus({ fields, authorId: issue.user?.id, comments });
        }

        const out = computeIssueState({
            issue: { number: issue.number, state: issue.state, labels, diagnosticsStatus: diag, unreviewedReopen: life.unreviewedReopen, lastClosedByBot: life.lastClosedByBot },
            links,
            repository: { latestMainlineRelease: releaseInfo },
        });
        for (const n of out.notes) summary.push(`#${issue.number}: ${n}`);

        const current = new Set(labels.filter((l) => OWNED_LABELS.includes(l)));
        const desired = new Set(out.ownedLabels);
        const add = [...desired].filter((l) => !current.has(l));
        const remove = [...current].filter((l) => !desired.has(l));
        plan.push({ number: issue.number, add, remove, comment: out.trackingComment, wantComment: links.length > 0, close: out.shouldClose, afterClose: out.labelsAfterClose });
    }
    if (errors.length) {
        return { aborted: true, errors, actions: [], summary: [...summary, `Collection incomplete, no changes were made: ${errors.join('; ')}`] };
    }

    // 5. Apply (only now).
    const actions = [];
    const failures = [];
    const doIt = (desc, fn) => {
        actions.push(desc);
        if (dryRun) return true;
        const r = fn();
        if (!r.ok) failures.push(`${desc}: ${r.error || r.status}`);
        return r.ok;
    };
    for (const p of plan) {
        if (p.add.length) doIt(`#${p.number}: add ${p.add.join(', ')}`, () => client.post(`/issues/${p.number}/labels`, { labels: p.add }));
        for (const l of p.remove) doIt(`#${p.number}: remove ${l}`, () => client.delete(`/issues/${p.number}/labels/${encodeURIComponent(l)}`));
        if (p.wantComment) {
            const c = client.paginate(`/issues/${p.number}/comments`);
            if (!c.complete) { failures.push(`#${p.number}: comments unreadable`); continue; }
            const mine = c.items.find((x) => x.body?.includes(MARKER) && isBot(x.user));
            if (!mine) doIt(`#${p.number}: create tracking comment`, () => client.post(`/issues/${p.number}/comments`, { body: p.comment }));
            else if (mine.body !== p.comment) doIt(`#${p.number}: update tracking comment`, () => client.patch(`/issues/comments/${mine.id}`, { body: p.comment }));
        }
        if (p.close) {
            const closed = doIt(`#${p.number}: close (fixed in release)`, () => client.patch(`/issues/${p.number}`, { state: 'closed', state_reason: 'completed' }));
            if (closed) doIt(`#${p.number}: add ${p.afterClose.join(', ')}`, () => client.post(`/issues/${p.number}/labels`, { labels: p.afterClose }));
        }
    }
    return { aborted: false, errors: failures, actions, summary };
}

// CLI: node .github/scripts/reconcile.mjs [--dry-run]. GH_TOKEN and GITHUB_REPOSITORY come from the workflow.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const { createClient } = await import('./github-client.mjs');
    const { createGit } = await import('./git-facts.mjs');
    const repo = process.env.GITHUB_REPOSITORY;
    if (!repo || !process.env.GH_TOKEN) { console.error('GITHUB_REPOSITORY and GH_TOKEN are required'); process.exit(2); }
    let manifest = { tags: {} };
    try { manifest = JSON.parse(readFileSync('.github/release-tags.json', 'utf8')); } catch { /* no manifest: no release is trusted */ }
    const result = await reconcile({ client: createClient({ repo }), git: createGit(process.cwd()), manifest, dryRun: process.argv.includes('--dry-run'), log: console.log });
    const lines = ['## Adam issue tracker', '', `Actions: ${result.actions.length}${result.aborted ? ' (aborted)' : ''}`, ...result.actions.map((a) => `- ${a}`), '', ...result.summary.map((s) => `- ${s}`), ...result.errors.map((e) => `- ERROR ${e}`)];
    console.log(lines.join('\n'));
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
    process.exit(result.aborted || result.errors.length ? 1 : 0);
}
