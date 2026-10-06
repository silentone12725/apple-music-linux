// The packages bundle a prebuilt minimal FFmpeg (third_party/ffmpeg). Its binary does the engine's
// music-video and export work; its libraries are the ones VLC's libavcodec plugin loads. Neither may
// depend on the host's FFmpeg, whose version differs between distros.
//
//   node --test electron/test/ffmpeg-bundle.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON = path.join(dir, '..');
const FF = path.join(ELECTRON, '..', 'third_party', 'ffmpeg');
const MAIN = readFileSync(path.join(ELECTRON, 'main.mjs'), 'utf8');
const PKG = JSON.parse(readFileSync(path.join(ELECTRON, 'package.json'), 'utf8'));

test('the engine is started with the bundled ffmpeg first on PATH and its libraries visible to VLC', () => {
    assert.match(MAIN, /PATH:\s*\[path\.join\(_ffDir,\s*'bin'\)/);
    assert.match(MAIN, /LD_LIBRARY_PATH:\s*\[_vlcDir,\s*path\.join\(_ffDir,\s*'lib'\)/);
    assert.match(MAIN, /\.\.\.vlcEnv,\s*\.\.\.ffEnv/);
});

test('electron-builder ships third_party/ffmpeg as resources/ffmpeg', () => {
    const r = PKG.build.extraResources.find((e) => e.from === '../third_party/ffmpeg');
    assert.ok(r, 'extraResources entry missing');
    assert.equal(r.to, 'ffmpeg');
});

test('the prebuilt binary and the sonames the VLC plugins link are present', () => {
    for (const f of ['bin/ffmpeg', 'lib/libavcodec.so.63', 'lib/libavformat.so.63', 'lib/libavutil.so.61']) {
        assert.ok(existsSync(path.join(FF, f)), `${f} missing (git lfs pull?)`);
    }
});

test('the bundled ffmpeg runs from its own libraries with an empty environment', { skip: !existsSync(path.join(FF, 'bin', 'ffmpeg')) }, () => {
    const out = execFileSync(path.join(FF, 'bin', 'ffmpeg'), ['-hide_banner', '-version'], { env: {}, encoding: 'utf8' });
    assert.match(out, /^ffmpeg version 9\.0\.2/);
    const ldd = execFileSync('ldd', [path.join(FF, 'bin', 'ffmpeg')], { env: {}, encoding: 'utf8' });
    for (const lib of ['libavcodec', 'libavformat', 'libavutil']) {
        const line = ldd.split('\n').find((l) => l.includes(lib + '.so'));
        assert.ok(line && line.includes(path.join('third_party', 'ffmpeg')), `${lib} must resolve inside third_party/ffmpeg: ${line}`);
    }
});
