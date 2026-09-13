// Deep MP4 box walker + field extractors.
//
// First module extracted from the engine-playback monolith. Pure: no shared
// state, no browser globals — a plain function of its byte input, so it is
// directly unit-testable (see test/engine/mp4parse.test.mjs). esbuild inlines it
// back into engine-bundle.js at build time, so runtime behavior is unchanged.

function extractMetaFields(type, boxData, box) {
    if (type === 'ftyp' && boxData.length >= 12)
        box.majorBrand = String.fromCharCode(boxData[8], boxData[9], boxData[10], boxData[11]);
    if (type === 'hdlr' && boxData.length >= 20)
        box.handler = String.fromCharCode(boxData[16], boxData[17], boxData[18], boxData[19]);
    if ((type === 'mp4a' || type === 'enca') && boxData.length >= 28) {
        box.sampleRate = (boxData[24] << 8 | boxData[25]);
        box.channels = (boxData[16] << 8 | boxData[17]);
        box.isEncrypted = (type === 'enca');
    }
    if (type === 'schm' && boxData.length >= 16)
        box.schemeType = String.fromCharCode(boxData[8], boxData[9], boxData[10], boxData[11]);
    if (type === 'mdat')
        box.hex32 = Array.from(boxData.slice(8, Math.min(40, boxData.length)))
            .map(b => b.toString(16).padStart(2, '0')).join(' ');
}

function extractTimingFields(type, boxData, box) {
    if (type === 'mdhd' && boxData.length >= 24) {
        const ver = boxData[8];
        box.timescale = ver === 1
            ? (boxData[20] << 24 | boxData[21] << 16 | boxData[22] << 8 | boxData[23]) >>> 0
            : (boxData[16] << 24 | boxData[17] << 16 | boxData[18] << 8 | boxData[19]) >>> 0;
    }
    if (type === 'tfhd' && boxData.length >= 16) {
        box.trackID = (boxData[8] << 24 | boxData[9] << 16 | boxData[10] << 8 | boxData[11]) >>> 0;
        box.flags = (boxData[9] << 16 | boxData[10] << 8 | boxData[11]);
    }
    if (type === 'trun' && boxData.length >= 16)
        box.sampleCount = (boxData[8] << 24 | boxData[9] << 16 | boxData[10] << 8 | boxData[11]) >>> 0;
    if (type === 'tfdt' && boxData.length >= 12) {
        const ver = boxData[8];
        box.baseMediaDecodeTime = ver === 1
            ? ((boxData[12] * 2 ** 24 + boxData[13] * 2 ** 16 + boxData[14] * 256 + boxData[15]) * 2 ** 32
                + (boxData[16] * 2 ** 24 + boxData[17] * 2 ** 16 + boxData[18] * 256 + boxData[19]))
            : (boxData[12] << 24 | boxData[13] << 16 | boxData[14] << 8 | boxData[15]) >>> 0;
    }
    if (type === 'senc' && boxData.length >= 12) {
        box.sampleCount = (boxData[12] << 24 | boxData[13] << 16 | boxData[14] << 8 | boxData[15]) >>> 0;
        box.ENCRYPTED = true;
    }
}

// mp4ParseBoxes — deep MP4 box walker; returns an array of box descriptors.
export function mp4ParseBoxes(data, maxDepth) {
    if (maxDepth === undefined) maxDepth = 4;
    const result = [];
    let off = 0;
    while (off + 8 <= data.length) {
        const size = (data[off] << 24 | data[off + 1] << 16 | data[off + 2] << 8 | data[off + 3]) >>> 0;
        const type = String.fromCharCode(data[off + 4], data[off + 5], data[off + 6], data[off + 7]);
        if (size < 8) break;
        const boxData = data.slice(off, off + Math.min(size, data.length - off));
        const box = { type, size, offset: off };
        const containers = ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'mvex',
            'moof', 'traf', 'udta', 'meta', 'ilst', 'edts'];
        if (containers.includes(type) && maxDepth > 0) {
            const headerSize = (type === 'stsd') ? 16 : (type === 'meta') ? 12 : 8;
            box.children = mp4ParseBoxes(data.slice(off + headerSize, off + boxData.length), maxDepth - 1);
        }
        extractMetaFields(type, boxData, box);
        extractTimingFields(type, boxData, box);
        result.push(box);
        off += size;
        if (off >= data.length) break;
    }
    return result;
}
