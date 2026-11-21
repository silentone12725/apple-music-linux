// Tests for .github/scripts/release-trust.mjs.
//   node --test electron/test/github/release-trust.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagsImmutable } from '../../../.github/scripts/release-trust.mjs';
import { tagRuleset } from './fake-github.mjs';

const SHA = 'a'.repeat(40);
const base = { tag: 'v1.6.0', resolvedSha: SHA, manifest: { tags: { 'v1.6.0': SHA } }, rulesets: [tagRuleset()] };
const t = (over) => tagsImmutable({ ...base, ...over });

test('manifest entry at the resolved SHA plus an active, bypass-free tag ruleset is verified', () => {
    assert.equal(t({}), 'verified');
    assert.equal(t({ resolvedSha: SHA.toUpperCase() }), 'verified');
});

test('rulesets that cannot be read are unknown, never verified', () => {
    assert.equal(t({ rulesets: null }), 'unknown');
    assert.equal(t({ rulesets: undefined }), 'unknown');
});

test('no manifest entry, or another SHA, is unverified', () => {
    assert.equal(t({ manifest: { tags: {} } }), 'unverified');
    assert.equal(t({ manifest: {} }), 'unverified');
    assert.equal(t({ manifest: { tags: { 'v1.6.0': 'b'.repeat(40) } } }), 'unverified');
    assert.equal(t({ resolvedSha: null }), 'unverified');
});

test('an inactive, branch-targeted, non-covering or bypassable ruleset is unverified', () => {
    assert.equal(t({ rulesets: [] }), 'unverified');
    assert.equal(t({ rulesets: [tagRuleset({ enforcement: 'evaluate' })] }), 'unverified');
    assert.equal(t({ rulesets: [tagRuleset({ enforcement: 'disabled' })] }), 'unverified');
    assert.equal(t({ rulesets: [tagRuleset({ target: 'branch' })] }), 'unverified');
    assert.equal(t({ rulesets: [tagRuleset({ conditions: { ref_name: { include: ['refs/tags/x*'], exclude: [] } } })] }), 'unverified');
    assert.equal(t({ rulesets: [tagRuleset({ conditions: { ref_name: { include: ['refs/tags/v*'], exclude: ['refs/tags/v1.6.0'] } } })] }), 'unverified');
    assert.equal(t({ rulesets: [tagRuleset({ bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }] })] }), 'unverified');
});

test('every required rule must be present, possibly across several rulesets', () => {
    assert.equal(t({ rulesets: [tagRuleset({ rules: [{ type: 'update' }, { type: 'deletion' }] })] }), 'unverified');
    const a = tagRuleset({ id: 1, rules: [{ type: 'update' }, { type: 'deletion' }] });
    const b = tagRuleset({ id: 2, rules: [{ type: 'non_fast_forward' }] });
    assert.equal(t({ rulesets: [a, b] }), 'verified');
});

test('patterns are checked against the actual tag, not just the literal v*', () => {
    assert.equal(t({ tag: 'v1.6.0', rulesets: [tagRuleset({ conditions: { ref_name: { include: ['~ALL'], exclude: [] } } })] }), 'verified');
    assert.equal(t({ rulesets: [tagRuleset({ conditions: { ref_name: { include: ['refs/tags/v1.*'], exclude: [] } } })] }), 'verified');
    assert.equal(t({ rulesets: [tagRuleset({ conditions: { ref_name: { include: ['refs/tags/v2.*'], exclude: [] } } })] }), 'unverified');
    assert.equal(t({ rulesets: [tagRuleset({ conditions: { ref_name: { include: ['refs/heads/v*'], exclude: [] } } })] }), 'unverified');
});
