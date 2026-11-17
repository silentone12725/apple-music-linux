import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../../src/engine-playback.js', import.meta.url), 'utf8');
const body = name => { const i = source.indexOf(`    async function ${name}(`); return source.slice(i, source.indexOf('\n    }', i) + 6); };
function setup() {
    const targets = [];
    const context = vm.createContext({
        mk: { repeatMode: 0 }, _adamInGotoTransition: false, _sessionContainerIdx: 0, _sessionItemIdx: 0,
        _adamPendingCI: 0, _adamPendingII: 1, _adamQueuedGoto: null,
        _sessionContainers: [{ items: ['a','b','c','d','e','f','g'] }],
        _adamGoto: async (ci, ii) => { targets.push([ci, ii]); context._adamQueuedGoto = [ci, ii]; },
    });
    vm.runInContext(body('_adamNext') + '\n' + body('_adamPrev'), context);
    return { context, targets };
}
test('rapid Next counts from the pending destination instead of reopening the same track', async () => {
    const { context, targets } = setup();
    for (let i=0;i<4;i++) await context._adamNext(true);
    assert.deepEqual(targets, [[0,2],[0,3],[0,4],[0,5]]);
});
test('Previous can reverse a queued Next before the old item notification settles', async () => {
    const { context, targets } = setup();
    await context._adamNext(true);
    await context._adamPrev();
    assert.deepEqual(targets, [[0,2],[0,1]]);
});

test('an ended event from the outgoing track cannot advance an active navigation twice', async () => {
    const { context, targets } = setup();
    context._adamInGotoTransition = true;
    await context._adamNext();
    assert.deepEqual(targets, []);
});

test('external Play cancels the old target filter and discards queued skips', async () => {
    const { context, targets } = setup();
    Object.assign(context, {
        _adamNavRevision: 4, trackEventRevision: 8,
        _adamGotoTarget: 33, _adamGotoTargetId: 'old-station-track',
        _adamInGotoTransition: true, _adamTransitioning: true, _adamNavInternal: true,
        _adamQueuedGoto: [0, 34], _adamAdvancing: true,
        _adamAdvancingTimer: 123, clearTimeout() {}, queueMicrotask,
    });
    for (const name of ['_clearAdvancing', '_cancelNavigation']) {
        const i = source.indexOf(`    function ${name}(`);
        vm.runInContext(source.slice(i, source.indexOf('\n    }', i) + 6), context);
    }
    context._cancelNavigation();
    await new Promise(r => setImmediate(r));
    assert.equal(context._adamGotoTarget, null, 'the new station must not be filtered against the previous target');
    assert.equal(context._adamGotoTargetId, null);
    assert.equal(context._adamNavRevision, 5, 'invalidate suspended old navigation commands');
    assert.equal(context.trackEventRevision, 9, 'invalidate suspended old item handlers');
    assert.equal(context._adamPendingCI, -1);
    assert.equal(context._adamPendingII, -1);
    assert.equal(context._adamAdvancing, false);
    assert.equal(context._adamAdvancingTimer, null);
    assert.equal(context._adamNavInternal, false);
    assert.equal(context._adamTransitioning, false);
    assert.equal(context._adamInGotoTransition, false);
    assert.deepEqual(targets, [], 'a queued old skip must not run against the replacement queue');
});

test('a suspended queue rebuild cannot issue an old Play after external navigation replaces it', async () => {
    let finishQueue;
    const calls = [];
    const context = vm.createContext({
        _adamAdvancing: false, _adamNavRevision: 0, _adamQueuedGoto: null,
        _sessionContainers: [{ items: ['old-track'] }],
        _sessionFlatIdx: () => 0, _sessionFlatIds: () => ['old-track'],
        _extractItemId: item => item?.id, _isVideoId: () => false,
        performance, console, stopVLCPoll() {}, getMKAudio: () => null,
        _nativeSrcSet: null, setTimeout: () => 1,
        mk: {
            queue: { items: [] },
            setQueue: () => new Promise(resolve => { finishQueue = resolve; }),
            play: () => { calls.push('old-play'); return Promise.resolve(); },
        },
    });
    vm.runInContext(body('_adamGoto'), context);
    const pending = context._adamGoto(0, 0);
    context._adamNavRevision++;
    finishQueue();
    await pending;
    assert.deepEqual(calls, [], 'an old setQueue completion must not start the replacement queue');
});


test('navigation does not advertise a track before its decoder is ready', async () => {
    let finishChange;
    const metadata = [];
    const context = vm.createContext({
        _adamAdvancing: false, _adamNavRevision: 0, _adamQueuedGoto: null,
        _sessionContainers: [{ items: ['unplayable-track'] }],
        _sessionFlatIdx: () => 0, _extractItemId: item => item?.id, _isVideoId: () => false,
        performance, console, stopVLCPoll() {}, getMKAudio: () => null,
        _nativeSrcSet: null, setTimeout: () => 1,
        sendMprisMetadata: item => metadata.push(item.id),
        mk: { queue: { items: [{ id: 'unplayable-track' }] },
            changeToMediaAtIndex: () => new Promise(resolve => { finishChange = resolve; }) },
    });
    vm.runInContext(body('_adamGoto'), context);
    const pending = context._adamGoto(0, 0);
    assert.deepEqual(metadata, [], 'an unconfirmed navigation target is not the playing track');
    context._adamNavRevision++;
    finishChange();
    await pending;
});
