import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCode, spreadDigits, promptAction, CODE_LENGTH } from '../../src/engine/verification-code.js';

const twoFactor = (id, extra = {}) => ({ state: { authentication: 'challenging' }, challenge: { type: 'two_factor', id }, ...extra });

test('normalizeCode keeps up to six digits from typing, paste or autofill', () => {
    assert.equal(normalizeCode('123 456'), '123456');
    assert.equal(normalizeCode('Your code is 987-654.'), '987654');
    assert.equal(normalizeCode('1234567890'), '123456');
    assert.equal(normalizeCode(null), '');
    assert.equal(CODE_LENGTH, 6);
});

test('spreadDigits fills from the field typed into and moves focus on', () => {
    const empty = Array(6).fill('');
    assert.deepEqual(spreadDigits(empty, 0, '123456'), { digits: ['1', '2', '3', '4', '5', '6'], focus: 5 });
    assert.deepEqual(spreadDigits(empty, 2, '7'), { digits: ['', '', '7', '', '', ''], focus: 3 });
    assert.deepEqual(spreadDigits(empty, 4, '9876'), { digits: ['', '', '', '', '9', '8'], focus: 5 }, 'extra digits beyond the last field are dropped');
    assert.deepEqual(spreadDigits(empty, 1, 'ab'), { digits: empty, focus: 1 }, 'letters are ignored');
});

test('promptAction shows code entry for a two-factor challenge and closes once FairPlay is ready', () => {
    assert.equal(promptAction(twoFactor(1), { open: false }), 'code');
    assert.equal(promptAction(twoFactor(1), { open: true, view: 'signin' }), 'code', 'the sign-in sheet moves on to the code');
    assert.equal(promptAction({ state: { authentication: 'challenging' }, challenge: { type: 'credentials' } }, { open: false }), 'none');
    assert.equal(promptAction({ state: { fairplay: 'ready' } }, { open: true }), 'close');
    assert.equal(promptAction({ capabilities: { cbcs: true }, state: {} }, { open: true }), 'close');
    assert.equal(promptAction({ state: { authentication: 'failed' } }, { open: true }), 'failed');
    assert.equal(promptAction({ state: { session: 'valid' } }, { open: false }), 'none', 'a web session alone opens nothing');
});

test('promptAction tells a re-ask (wrong code) from the same challenge repeated', () => {
    const code = { open: true, view: 'code' };
    assert.equal(promptAction(twoFactor(1), { ...code, submittedId: 1 }), 'none', 'same challenge carried in a later snapshot');
    assert.equal(promptAction(twoFactor(2), { ...code, submittedId: 1 }), 'retry', 'Apple asked again: the code was wrong');
    assert.equal(promptAction(twoFactor(2), code), 'none', 'nothing submitted yet');
});

test('promptAction does not reopen a challenge the user cancelled', () => {
    assert.equal(promptAction(twoFactor(3), { open: false, dismissedId: 3 }), 'none');
    assert.equal(promptAction(twoFactor(4), { open: false, dismissedId: 3 }), 'code', 'a new challenge opens again');
});

test('promptAction: a sign-in that fails while the code is being asked for goes back to the form', async () => {
    const { promptAction } = await import('../../src/engine/verification-code.js');
    const failed = { state: { authentication: 'failed' }, message: 'timed out' };
    assert.equal(promptAction(failed, { open: true, view: 'code' }), 'expired');
    assert.equal(promptAction(failed, { open: true, view: 'signin' }), 'failed');
    assert.equal(promptAction(failed, { open: false, view: null }), 'none');
});
