// Tests for the scope-label planner in .github/scripts/triage-run.mjs.
//   node --test electron/test/github/triage-run.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { planScopeLabels } from '../../../.github/scripts/triage-run.mjs';
import { formBody } from './fake-github.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const map = JSON.parse(readFileSync(path.join(root, '.github/triage-map.json'), 'utf8'));
const scope = JSON.parse(readFileSync(path.join(root, '.github/labels.json'), 'utf8')).labels.filter((l) => l.group === 'scope').map((l) => l.name);
const plan = (body, labels = []) => planScopeLabels({ body, labels, map, scope });

test('adds the component and platform labels from the form', () => {
    assert.deepEqual(plan(formBody()), { add: ['comp:lossless', 'os:linux'], remove: [] });
});

test('removes stale scope labels after an edit, and leaves other labels alone', () => {
    const r = plan(formBody(), ['comp:video', 'os:linux', 'bug', 'P1', 'in-progress']);
    assert.deepEqual(r, { add: ['comp:lossless'], remove: ['comp:video'] });
});

test('does nothing for issues that are not bug report forms', () => {
    assert.deepEqual(plan('Just some free text', ['comp:video']), { add: [], remove: [] });
    assert.deepEqual(plan(null, ['os:windows']), { add: [], remove: [] });
});

test('Other maps to no label, and an unknown option adds nothing', () => {
    assert.deepEqual(plan('### Component\n\nOther\n\n### Platform\n\nOther\n'), { add: [], remove: [] });
    assert.deepEqual(plan('### Component\n\nBrand new thing\n'), { add: [], remove: [] });
});
