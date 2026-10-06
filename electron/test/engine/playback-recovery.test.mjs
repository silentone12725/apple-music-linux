import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const src = readFileSync(new URL('../../src/engine-playback.js', import.meta.url), 'utf8');
function recovery() {
    const timers = [], requests = [];
    const context = {
        ENGINE: 'https://127.0.0.1:20025', _sessionId: 'first', _currentAssetId: 'track',
        _vlcMode: true, _vlcRetryCount: 0, _durationSec: 200, _vlcPosMs: 70000,
        _vlcSeekOffsetMs: 0, _vlcLoading: false, _allowCDNTransition: false,
        polls: 0, advances: 0, Event, AbortSignal, console,
        stopVLCPoll() {}, startVLCPoll() { context.polls++; },
        _amlNextRef: async () => { context.advances++; },
        setTimeout(fn) { timers.push(fn); },
        fetch: async (url, options) => { requests.push({url, body: JSON.parse(options.body)}); return {ok:true}; },
    };
    vm.createContext(context);
    vm.runInContext(src.slice(src.indexOf('function _vlcRetryFrom('), src.indexOf('function _vlcHandleStateChange(')), context);
    return { context, timers, requests, audio: {dispatchEvent() {}} };
}
test('premature mid-track EOF reloads the source at its last position instead of seeking a stopped player', async () => {
    const r = recovery();
    r.context._vlcHandleEnded(70000, r.audio);
    assert.equal(r.context.advances, 0);
    await r.timers.shift()();
    assert.equal(r.requests[0].url, 'https://127.0.0.1:20025/api/v1/vlc/load');
    assert.equal(r.requests[0].body.startMs, 70000);
    assert.equal(r.context.polls, 1);
});
test('a pending recovery cannot reload the next song after a skip', async () => {
    const r = recovery();
    r.context._vlcHandleEnded(70000, r.audio);
    r.context._sessionId = 'next';
    await r.timers.shift()();
    assert.equal(r.requests.length, 0);
    assert.equal(r.context.polls, 0);
});
test('normal track end advances rather than reloading', () => {
    const r = recovery();
    r.context._vlcHandleEnded(199000, r.audio);
    assert.equal(r.context.advances, 1);
    assert.equal(r.timers.length, 0);
});
test('normal EOF in the last fragment advances once without replaying the tail', () => {
    for (const remainingMs of [3500, 5000, 7500, 10000]) {
        const r = recovery();
        r.context._vlcHandleEnded(200000 - remainingMs, r.audio);
        assert.equal(r.context.advances, 1, `normal EOF with ${remainingMs}ms remaining`);
        assert.equal(r.timers.length, 0);
    }
});
test('a true VLC error near the end still recovers rather than skipping the tail', async () => {
    const r = recovery();
    r.context._vlcHandleEnded(195000, r.audio, 'error');
    assert.equal(r.context.advances, 0);
    await r.timers[0]();
    assert.equal(r.requests[0].body.startMs, 195000);
});
test('an EOF outside the final window still recovers and does not snap the UI to the end', () => {
    const r = recovery();
    r.context._vlcPosMs = 189000;
    r.context._vlcHandleEnded(189000, r.audio);
    assert.equal(r.context.advances, 0);
    assert.equal(r.timers.length, 1);
    assert.equal(r.context._vlcPosMs, 189000);
});
test('short tracks have a proportionally smaller natural end window', () => {
    const r = recovery();
    r.context._durationSec = 20;
    r.context._vlcHandleEnded(15000, r.audio);
    assert.equal(r.context.advances, 0);
    assert.equal(r.timers.length, 1);
});
test('a failed reload resumes status polling rather than leaving playback controls frozen', async () => {
    const r = recovery();
    r.context.fetch = async () => { throw new Error('temporary offline'); };
    r.context._vlcHandleEnded(70000, r.audio);
    await r.timers.shift()();
    assert.equal(r.context.polls, 1);
});

function trackFallback() {
    const timers = [];
    const context = {
        mk: {playbackState: 1, nowPlayingItem: {id: 'track-a'}},
        PS: {loading:1, playing:2}, trackFallbackTimer:null,
        _currentAssetId: null, _amlGotoTargetId:null, changes:0,
        console: {warn() {}}, clearTimeout() {},
        setTimeout(fn) {timers.push(fn);},
        _onNowPlayingChange: async () => {context.changes++;},
    };
    vm.createContext(context);
    const start = src.indexOf('        // MusicKit can enter loading/playing');
    const end = src.indexOf('        // Sync MPRIS status.', start);
    vm.runInContext(src.slice(start, end), context);
    return {context,timers};
}
test('a settled loading item starts when MusicKit omits its track-change event', () => {
    const t = trackFallback();
    t.timers[0]();
    assert.equal(t.context.changes, 1);
});
test('a normal track-change event takes precedence over the delayed fallback', () => {
    const t = trackFallback();
    t.context._currentAssetId = 'track-a';
    t.timers[0]();
    assert.equal(t.context.changes, 0);
});
test('fallback ignores an old item while a different queue target is pending', () => {
    const t = trackFallback();
    t.context._amlGotoTargetId = 'track-b';
    t.timers[0]();
    assert.equal(t.context.changes, 0);
});

test('old status replies after a skip cannot clear the new poll or update its position', async () => {
    const requests = [], positions = [];
    const context = {
        ENGINE:'https://127.0.0.1:20025', _sessionId:'old', AbortSignal,
        _vlcTransport:{revision:0,pending:false},
        console:{log(){}}, clearInterval(){},
        _vlcSyncVolume(){}, _vlcHandleLength(){},
        _vlcUpdatePosition(pos){positions.push(pos);}, _vlcHandleStateChange(){},
        fetch:() => new Promise(resolve=>requests.push(resolve)),
    };
    vm.createContext(context);
    const varsStart = src.indexOf('let _vlcPollGeneration');
    const varsEnd = src.indexOf('\n', src.indexOf('let _vlcFetching', varsStart));
    const stopStart = src.indexOf('function stopVLCPoll()');
    const stopEnd = src.indexOf('\n}',stopStart)+2;
    const tickStart = src.indexOf('async function _vlcPollTick(');
    const tickEnd = src.indexOf('function startVLCPoll(',tickStart);
    vm.runInContext(src.slice(varsStart,varsEnd)+'\n'+src.slice(stopStart,stopEnd)+'\n'+src.slice(tickStart,tickEnd),context);
    const oldPoll = vm.runInContext('_vlcPollTick({}, "old")',context);
    vm.runInContext('stopVLCPoll(); _sessionId="new"; _vlcFetching=false;',context);
    const newPoll = vm.runInContext('_vlcPollTick({}, "new")',context);
    requests[0]({ok:true,json:async()=>({posMs:10,state:'playing'})});
    await oldPoll;
    assert.equal(vm.runInContext('_vlcFetching',context),true);
    assert.deepEqual(positions,[]);
    requests[1]({ok:true,json:async()=>({posMs:20,state:'playing'})});
    await newPoll;
    assert.equal(vm.runInContext('_vlcFetching',context),false);
    assert.deepEqual(positions,[20]);
});

test('restart clears the previous seek target instead of reloading its old position', () => {
    const requests=[];
    const context={_vlcSeekRevision:0,_vlcSeekTimer:1,_vlcSeekFrozen:false,
        _vlcSeekOffsetMs:0,_seekBurstLog:20,_vlcSeekTargetMs:20000,_vlcPostSeek:true,
        _vlcPosMs:20000,_vlcTickCount:0,_sessionId:'same',_currentAssetId:'track',
        clearTimeout(){},console:{log(){},warn(){}},window:{},
        fetch:(...args)=>{requests.push(args);return Promise.resolve({ok:true});},Event};
    vm.createContext(context);
    const a=src.indexOf('function _resetVLCSeekState()');const b=src.indexOf('let _vlcPollGeneration',a);
    const c=src.indexOf('function _vlcUpdatePosition(');const d=src.indexOf('function _vlcRetryFrom(',c);
    vm.runInContext(src.slice(a,b)+'\n'+src.slice(c,d),context);
    context._resetVLCSeekState();context._vlcUpdatePosition(250,'playing',{dispatchEvent(){}});
    assert.equal(requests.length,0);assert.equal(context._vlcPosMs,250);assert.equal(context._vlcSeekRevision,1);
});
