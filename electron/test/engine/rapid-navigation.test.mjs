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
