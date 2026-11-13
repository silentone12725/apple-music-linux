// Applies scope labels (component and platform) from the bug report form. The only labels this touches are the ones with
// owner "triage" in .github/labels.json; state and resolution labels belong to the tracker.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseIssueForm, scopeLabels } from './triage.mjs';

export function planScopeLabels({ body, labels, map, scope }) {
    const fields = parseIssueForm(body);
    if (!fields.component && !fields.platform) return { add: [], remove: [] }; // not a bug report form
    const { labels: wanted } = scopeLabels(fields, map);
    const current = labels.filter((l) => scope.includes(l));
    return { add: wanted.filter((l) => !current.includes(l)), remove: current.filter((l) => !wanted.includes(l)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const { createClient } = await import('./github-client.mjs');
    const client = createClient({ repo: process.env.GITHUB_REPOSITORY });
    const n = Number(process.env.ISSUE_NUMBER);
    if (!Number.isInteger(n) || n <= 0) { console.error('ISSUE_NUMBER is required'); process.exit(2); }
    const issue = client.get(`/issues/${n}`);
    if (!issue.ok) { console.error(`cannot read issue #${n}: ${issue.error}`); process.exit(1); }
    const map = JSON.parse(readFileSync('.github/triage-map.json', 'utf8'));
    const scope = JSON.parse(readFileSync('.github/labels.json', 'utf8')).labels.filter((l) => l.group === 'scope').map((l) => l.name);
    const { add, remove } = planScopeLabels({ body: issue.data.body, labels: issue.data.labels.map((l) => l.name), map, scope });
    let failed = false;
    if (add.length) failed ||= !client.post(`/issues/${n}/labels`, { labels: add }).ok;
    for (const l of remove) failed ||= !client.delete(`/issues/${n}/labels/${encodeURIComponent(l)}`).ok;
    console.log(`#${n}: add [${add}] remove [${remove}]`);
    process.exit(failed ? 1 : 0);
}
