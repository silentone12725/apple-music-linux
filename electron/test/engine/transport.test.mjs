import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTransportController, createNavigationQueue, withNavigationDeadline } from '../../src/engine/transport.js';
const deferred = () => { let resolve, reject; const promise = new Promise((r,j)=>{resolve=r;reject=j;}); return {promise,resolve,reject}; };
const flush = async () => { for(let i=0;i<10;i++) await Promise.resolve(); };

test('pause then play awaits the pause response instead of sending unordered HTTP commands', async () => {
    const pause = deferred(), calls = [];
    const t = createTransportController({scope:()=> 'song',send:async paused=>{calls.push(paused);if(paused)await pause.promise;}});
    const first=t.request(true);await flush();const last=t.request(false);await flush();
    assert.deepEqual(calls,[true]);assert.equal(t.desired,false);assert.equal(t.pending,true);
    pause.resolve();await Promise.all([first,last]);assert.deepEqual(calls,[true,false]);assert.equal(t.pending,false);
});
test('internal duplicate resumes cannot flood the native player', async () => {
    let calls=0;const t=createTransportController({scope:()=> 'song',send:async()=>{calls++;}});
    await Promise.all(Array.from({length:20},()=>t.request(false)));assert.equal(calls,1);
});
test('queued transport commands are discarded when a different track replaces their scope', async () => {
    let song='first';const pause=deferred(),calls=[];
    const t=createTransportController({scope:()=>song,send:async p=>{calls.push(p);await pause.promise;}});
    const first=t.request(true);await flush();const second=t.request(false);song='next';t.reset(false);pause.resolve();await Promise.all([first,second]);assert.deepEqual(calls,[true]);
});
test('restarting the same track also invalidates old pending commands', async () => {
    const pause=deferred(),calls=[];const t=createTransportController({scope:()=> 'same',send:async p=>{calls.push(p);await pause.promise;}});
    const first=t.request(true);await flush();const second=t.request(false);t.reset(false);pause.resolve();await Promise.all([first,second]);assert.deepEqual(calls,[true]);
});
test('rapid next then previous retains both requests and computes from the requested cursor', async () => {
    const next=deferred(),calls=[];
    const q=createNavigationQueue(async(ci,ii)=>{calls.push([ci,ii]);if(ii===1)await next.promise;});
    const first=q.goto(0,1);await flush();const cursor=q.cursor;const last=q.goto(cursor.ci,cursor.ii-1);await flush();assert.deepEqual(calls,[[0,1]]);
    next.resolve();await Promise.all([first,last]);assert.deepEqual(calls,[[0,1],[0,0]]);assert.equal(q.cursor,null);
});
test('a rejected navigation does not disable subsequent input', async () => {
    const calls=[];const q=createNavigationQueue(async(ci,ii)=>{calls.push(ii);if(ii===1)throw Error('rejected');});
    const first=q.goto(0,1);const last=q.goto(0,0);await assert.rejects(first,/rejected/);await last;assert.deepEqual(calls,[1,0]);
});
test('a MusicKit promise that never settles has a bounded deadline',async()=> {
    await assert.rejects(withNavigationDeadline(new Promise(()=>{}),10),/timed out/);
});
