// Keeps the issue forms, the triage parser, the triage map, the labels file and ci.yml in step. The YAML is parsed for real
// (js-yaml, a dev-only dependency), not read with regular expressions.
//   node --test electron/test/github/forms.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import yaml from 'js-yaml';
import { parseIssueForm, scopeLabels, HEADINGS } from '../../../.github/scripts/triage.mjs';
import { isValidDiagnosticsBlock, diagnosticsStatus, RECOGNIZED_KEYS } from '../../../.github/scripts/diagnostics-block.mjs';
import { OWNED_LABELS } from '../../../.github/scripts/issue-state.mjs';
import { formBody, DIAG } from './fake-github.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');
const json = (p) => JSON.parse(read(p));
const form = yaml.load(read('.github/ISSUE_TEMPLATE/bug_report.yml'));
const inputs = form.body.filter((b) => b.type !== 'markdown');

test('bug_report.yml: every id is unique and uses only the characters GitHub allows', () => {
    const ids = inputs.map((b) => b.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]+$/, id);
});

test('bug_report.yml: auto-labels exist, and the form fields the parser reads are all present', () => {
    const labels = new Set(json('.github/labels.json').labels.map((l) => l.name));
    for (const l of form.labels) assert.ok(labels.has(l), l);
    const byLabel = new Map(inputs.map((b) => [b.attributes.label, b]));
    for (const heading of Object.keys(HEADINGS)) assert.ok(byLabel.has(heading), `form has no field labelled "${heading}"`);
    for (const b of inputs) assert.ok(HEADINGS[b.attributes.label], `parser does not know the heading "${b.attributes.label}"`);
});

test('triage-map.json covers every dropdown option exactly, and maps only to real labels', () => {
    const map = json('.github/triage-map.json');
    const labels = new Set(json('.github/labels.json').labels.map((l) => l.name));
    for (const field of ['component', 'platform']) {
        const options = inputs.find((b) => b.id === field).attributes.options;
        assert.deepEqual(Object.keys(map[field]).sort(), [...options].sort(), field);
        for (const v of Object.values(map[field])) if (v) assert.ok(labels.has(v), v);
    }
});

test('the diagnostics field renders as text and the waiver is a checkbox the parser understands', () => {
    assert.equal(inputs.find((b) => b.id === 'diagnostics').attributes.render, 'text');
    const waiver = inputs.find((b) => b.id === 'diag_waiver');
    assert.equal(waiver.type, 'checkboxes');
    assert.match(waiver.attributes.options[0].label, /^I could not collect diagnostics/);
});

test('parseIssueForm reads a rendered form and scopeLabels maps it', () => {
    const f = parseIssueForm(formBody());
    assert.equal(f.component, 'Lossless (ALAC)');
    assert.equal(f.platform, 'Linux');
    assert.equal(f.waiver, false);
    const map = json('.github/triage-map.json');
    assert.deepEqual(scopeLabels(f, map), { labels: ['comp:lossless', 'os:linux'], unknown: [] });
    assert.deepEqual(scopeLabels({ component: 'Other', platform: 'Other' }, map).labels, []);
    assert.deepEqual(scopeLabels({ component: 'Brand new' }, map).unknown, ['component: Brand new']);
});

test('parseIssueForm: empty answers, Windows line endings, ticked waiver', () => {
    const f = parseIssueForm('### Diagnostics summary\r\n\r\n_No response_\r\n\r\n### Diagnostics availability\r\n\r\n- [x] I could not collect diagnostics (explain in the description)\r\n');
    assert.equal(f.diagnostics, '');
    assert.equal(f.waiver, true);
    assert.equal(parseIssueForm(null).waiver, false);
    assert.equal(parseIssueForm('### Diagnostics availability\n\n- [ ] I could not collect diagnostics (explain)').waiver, false);
});

test('a valid diagnostics block is complete, not safe; incomplete ones are not valid', () => {
    assert.equal(isValidDiagnosticsBlock(DIAG), true);
    assert.equal(isValidDiagnosticsBlock('Adam diagnostics v1'), false, 'marker alone');
    assert.equal(isValidDiagnosticsBlock(DIAG.replace('formatVersion: 1', 'formatVersion: 2')), false);
    assert.equal(isValidDiagnosticsBlock(DIAG.split('\n').slice(0, 4).join('\n')), false, 'too few keys');
    assert.equal(isValidDiagnosticsBlock(DIAG + '\n' + 'x'.repeat(9000)), false, 'over the size cap');
    assert.equal(isValidDiagnosticsBlock(DIAG.replace('Adam diagnostics v1', 'diagnostics')), false);
    assert.ok(RECOGNIZED_KEYS.length >= 10);
});

test('diagnosticsStatus: body, author comment, other user, bot, waiver', () => {
    const ok = { id: 1, type: 'User' };
    assert.equal(diagnosticsStatus({ fields: { diagnostics: DIAG }, authorId: 9 }), 'valid');
    assert.equal(diagnosticsStatus({ fields: {}, authorId: 9, comments: [{ authorId: 9, authorType: 'User', body: DIAG }] }), 'valid');
    assert.equal(diagnosticsStatus({ fields: {}, authorId: 9, comments: [{ authorId: 5, authorType: 'User', body: DIAG }] }), 'missing');
    assert.equal(diagnosticsStatus({ fields: {}, authorId: 9, comments: [{ authorId: 9, authorType: 'Bot', body: DIAG }] }), 'missing');
    assert.equal(diagnosticsStatus({ fields: { waiver: true }, authorId: 9 }), 'waived');
    assert.equal(diagnosticsStatus({ fields: { waiver: true, diagnostics: DIAG }, authorId: 9 }), 'valid');
    assert.ok(ok);
});

test('labels.json: unique names, known groups, valid colours, the engine universe exists, ownership is single-writer', () => {
    const { labels } = json('.github/labels.json');
    assert.equal(new Set(labels.map((l) => l.name)).size, labels.length);
    for (const l of labels) {
        assert.match(l.color, /^[0-9a-fA-F]{6}$/, l.name);
        assert.ok(l.description.length <= 100, l.name);
        assert.ok(['classification', 'state', 'resolution', 'lifecycle', 'priority', 'scope'].includes(l.group), l.name);
    }
    const byName = new Map(labels.map((l) => [l.name, l]));
    for (const name of OWNED_LABELS) assert.ok(byName.has(name), name);
    for (const name of ['needs-triage', 'needs-info', 'in-progress', 'fixed-in-nightly', 'fixed-in-release', 'closed-by-tracking']) assert.equal(byName.get(name).owner, 'tracking', name);
    assert.equal(byName.get('reopened-needs-review').owner, 'tracking-adds-maintainers-remove');
    for (const name of ['blocked', 'keep-open', 'P0', 'bug']) assert.equal(byName.get(name).owner, 'maintainers', name);
    for (const l of labels.filter((x) => x.group === 'scope')) assert.equal(l.owner, 'triage', l.name);
});

test('ci.yml keeps the pull_request activity types the tracker relies on (edited is not a default type)', () => {
    const ci = yaml.load(read('.github/workflows/ci.yml'));
    const types = (ci.on ?? ci[true]).pull_request.types;
    for (const t of ['opened', 'synchronize', 'reopened', 'ready_for_review', 'edited']) assert.ok(types.includes(t), t);
    assert.equal(ci.name, 'CI', 'tracking.yml listens for the workflow named CI');
});

test('workflows: no pull_request_target, every action pinned to a full SHA, least-privilege permissions', () => {
    for (const f of ['tracking.yml', 'triage.yml', 'closing-keywords.yml']) {
        const text = read(`.github/workflows/${f}`);
        assert.ok(!/pull_request_target/.test(text.replace(/#.*$/gm, '')), `${f} must not use pull_request_target`);
        for (const m of text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) assert.match(m[1], /@[0-9a-f]{40}$/, `${f}: ${m[1]} is not pinned to a commit SHA`);
        const wf = yaml.load(text);
        assert.ok(wf.permissions || Object.values(wf.jobs).every((j) => j.permissions), `${f} declares permissions`);
    }
    const tracking = yaml.load(read('.github/workflows/tracking.yml'));
    const triggers = Object.keys(tracking.on ?? tracking[true]);
    for (const t of ['schedule', 'push', 'release', 'issues', 'issue_comment', 'workflow_run', 'workflow_dispatch']) assert.ok(triggers.includes(t), t);
    assert.equal(tracking.concurrency['cancel-in-progress'], false);
    assert.deepEqual(tracking.permissions, { issues: 'write', 'pull-requests': 'read', contents: 'read' });
    assert.ok(existsSync(path.join(root, '.github/release-tags.json')));
});
