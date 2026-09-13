// Unit tests for the extracted mp4parse module. Because it is now a real ES
// module (not spliced out of the monolith by regex), we import and test it
// directly.
//
// Run: node --test electron/test/engine/mp4parse.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mp4ParseBoxes } from '../../src/engine/mp4parse.js';

// Build one MP4 box: [size:4 BE][type:4][payload...], size = 8 + payload.length.
function box(type, payload) {
    const size = 8 + payload.length;
    const b = new Uint8Array(size);
    b[0] = (size >>> 24) & 0xff; b[1] = (size >>> 16) & 0xff; b[2] = (size >>> 8) & 0xff; b[3] = size & 0xff;
    for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
    b.set(payload, 8);
    return b;
}
function concat(...arrs) {
    const total = arrs.reduce((n, a) => n + a.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
}

test('mp4ParseBoxes: top-level boxes, ftyp majorBrand, container recursion, mdhd timescale', () => {
    // mdhd v0: payload starts at box byte 8 → version at [8], timescale at [16..19].
    // payload index = box index - 8, so version=payload[0], timescale=payload[8..11].
    const mdhdPayload = new Uint8Array(24); // 8 (hdr) + 24 = 32-byte box, length >= 24
    mdhdPayload[0] = 0; // version 0
    // timescale 44100 = 0x0000AC44 at box[16..19] → payload[8..11]
    mdhdPayload[8] = 0x00; mdhdPayload[9] = 0x00; mdhdPayload[10] = 0xac; mdhdPayload[11] = 0x44;
    const mdhd = box('mdhd', mdhdPayload);            // 32 bytes
    const moov = box('moov', mdhd);                   // 8 + 32 = 40 bytes, container
    const ftyp = box('ftyp', new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0])); // "isom" + 4 pad → 16 bytes

    const boxes = mp4ParseBoxes(concat(ftyp, moov));
    assert.equal(boxes.length, 2, 'two top-level boxes');

    assert.equal(boxes[0].type, 'ftyp');
    assert.equal(boxes[0].size, 16);
    assert.equal(boxes[0].offset, 0);
    assert.equal(boxes[0].majorBrand, 'isom');

    assert.equal(boxes[1].type, 'moov');
    assert.equal(boxes[1].size, 40);
    assert.equal(boxes[1].offset, 16);
    assert.ok(Array.isArray(boxes[1].children), 'moov recursed into children');
    assert.equal(boxes[1].children.length, 1);
    assert.equal(boxes[1].children[0].type, 'mdhd');
    assert.equal(boxes[1].children[0].timescale, 44100);
});

test('mp4ParseBoxes: tfdt v1 64-bit baseMediaDecodeTime', () => {
    // tfdt v1: box[8]=version(1), box[12..19]=64-bit time → payload[0]=1, payload[4..11]=time.
    const p = new Uint8Array(12); // 20-byte box
    p[0] = 1; // version 1
    // baseMediaDecodeTime = 1*2^32 + 2 : hi=0x00000001 at box[12..15]=payload[4..7], lo=0x00000002 at box[16..19]=payload[8..11]
    p[7] = 0x01; // payload[7] = box[15]
    p[11] = 0x02; // payload[11] = box[19]
    const boxes = mp4ParseBoxes(box('tfdt', p));
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].type, 'tfdt');
    assert.equal(boxes[0].baseMediaDecodeTime, 2 ** 32 + 2);
});

test('mp4ParseBoxes: stops on malformed size < 8', () => {
    const bad = new Uint8Array([0, 0, 0, 4, 0x61, 0x62, 0x63, 0x64]); // size=4 (<8)
    assert.equal(mp4ParseBoxes(bad).length, 0);
});
