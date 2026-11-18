"""Pure static integration tests: no compiler, player, network or login."""
import difflib
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
import tempfile
from unittest.mock import patch as mock_patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('vlc_build', ROOT / 'scripts/build-vlc-mp4.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class CandidateTests(unittest.TestCase):
    def test_reviewed_patch_is_byte_identical(self):
        patch = ROOT / 'patches/vlc/3.0.24/playback01-candidate-c.patch'
        self.assertEqual(hashlib.sha256(patch.read_bytes()).hexdigest(),
                         '9eac960942eba7d147c662811c0a48013d797151eb16d9210c56edff18f3bb09')
        ref = json.loads((patch.parent / 'runtime-abi.json').read_text())
        self.assertEqual(hashlib.sha256(patch.read_bytes()).hexdigest(), ref['patchSHA256'])

    def test_hunks_are_applied_exactly_once(self):
        filler = ''.join(f'line {i}\n' for i in range(20))
        before = 'header\nold1\n' + filler + 'old2\nfooter\n'
        after = 'header\nnew1\n' + filler + 'new2\nfooter\n'
        patch = ''.join(difflib.unified_diff(before.splitlines(True), after.splitlines(True), fromfile='baseline/mp4.c', tofile='candidate/mp4.c'))
        self.assertEqual(sum(line.startswith('@@ ') for line in patch.splitlines()), 2)
        self.assertEqual(m.apply_candidate(before, patch), after)
        for source in [after, 'foreign source\n', before.replace('old2', 'other'),
                       before.replace('old1', 'new1'), before + before]:
            with self.assertRaises(ValueError):
                m.apply_candidate(source, patch)

    def test_reviewed_patch_applies_to_the_pinned_source_shape(self):
        patch = (ROOT / 'patches/vlc/3.0.24/playback01-candidate-c.patch').read_text()
        self.assertEqual(sum(line.startswith('@@ ') for line in patch.splitlines()), 3)
        for needle in ['b_exhausted_bound = false;', 'i_exhausted_bound );', 'DEMUX_TRACK_MAX_PRELOAD']:
            self.assertIn(needle, patch)


    def make_runtime(self, base):
        runtime, patches = base / 'vlc', base / 'patches'
        (runtime / 'plugins/demux').mkdir(parents=True)
        patches.mkdir()
        (runtime / 'core.so').write_bytes(b'known core')
        (runtime / m.PLUGIN).write_bytes(b'stock plugin')
        (runtime / 'plugins/plugins.dat').write_bytes(b'cache')
        (patches / 'playback01-candidate-c.patch').write_bytes(b'reviewed patch')
        reference = {'version': '3.0.24', 'sourceRevision': 'rev', 'sourceHashes': {'modules/a.c': 'aa'},
                     'headerHashes': {'modules/a.h': 'bb'}, 'patchSHA256': m.digest(patches / 'playback01-candidate-c.patch'),
                     'runtimeHashes': {'core.so': m.digest(runtime / 'core.so')}}
        (patches / 'runtime-abi.json').write_text(json.dumps(reference))
        build = base / 'build'
        build.mkdir()
        (build / 'libmp4_plugin.so').write_bytes(b'Candidate C')
        (build / 'mp4.c').write_text('patched')
        info = m.marker_info(reference, build / 'libmp4_plugin.so', build / 'mp4.c')
        return runtime, patches, build / 'libmp4_plugin.so', info

    def test_runtime_verification_rejects_foreign_plugin_and_core(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, patches, built, info = self.make_runtime(Path(directory))
            plugin = runtime / m.PLUGIN
            with mock_patch.object(m, 'PATCH_DIR', patches):
                self.assertEqual(m.install(runtime, built, info), info)
                plugin.write_bytes(b'foreign plugin')
                with self.assertRaises(ValueError):
                    m.verify_runtime(runtime)
                plugin.write_bytes(b'Candidate C')
                (runtime / 'core.so').write_bytes(b'foreign core')
                with self.assertRaises(ValueError):
                    m.verify_runtime(runtime)

    def test_install_writes_marker_atomically_and_clears_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, patches, built, info = self.make_runtime(Path(directory))
            with mock_patch.object(m, 'PATCH_DIR', patches):
                m.install(runtime, built, info)
                self.assertTrue(m.installed(runtime))
            self.assertEqual((runtime / m.PLUGIN).read_bytes(), b'Candidate C')
            self.assertEqual(sorted(p.name for p in runtime.rglob('*')),
                             sorted(['core.so', 'plugins', 'demux', 'libmp4_plugin.so', m.MARKER]))

    def test_marker_holds_no_local_build_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            _, _, _, info = self.make_runtime(Path(directory))
            text = json.dumps(info)
            self.assertNotIn(directory, text)
            for key in ['command', 'compiler', 'buildDirectory', 'tests']:
                self.assertNotIn(key, info)

    def test_crash_at_any_replace_never_leaves_an_unmarked_candidate(self):
        real_replace = m.os.replace
        for crash_at in [1, 2]:  # 1: marker rename, 2: plugin swap
            with self.subTest(crash_at=crash_at), tempfile.TemporaryDirectory() as directory:
                runtime, patches, built, info = self.make_runtime(Path(directory))
                calls = []

                def replace(src, dst):
                    calls.append(dst)
                    if len(calls) == crash_at:
                        raise OSError('simulated crash')
                    return real_replace(src, dst)

                with mock_patch.object(m, 'PATCH_DIR', patches):
                    with mock_patch.object(m.os, 'replace', side_effect=replace), self.assertRaises(OSError):
                        m.install(runtime, built, info)
                    candidate = (runtime / m.PLUGIN).read_bytes() == b'Candidate C'
                    marked = (runtime / m.MARKER).exists()
                    self.assertFalse(candidate and not marked, 'unmarked Candidate C plugin')
                    self.assertFalse(candidate)
                    self.assertEqual(marked, crash_at == 2)
                    # The next build sees an unverifiable state and rebuilds.
                    self.assertFalse(m.installed(runtime))
                    m.install(runtime, built, info)
                    self.assertTrue(m.installed(runtime))

    def test_stale_or_corrupt_marker_triggers_rebuild_not_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, patches, built, info = self.make_runtime(Path(directory))
            with mock_patch.object(m, 'PATCH_DIR', patches):
                m.install(runtime, built, info)
                stale = {k: v for k, v in info.items() if k != 'headerHashes'}
                for text in ['{"patchSHA256": ', json.dumps(stale), json.dumps(dict(info, patchSHA256='old'))]:
                    with self.subTest(text=text[:30]):
                        (runtime / m.MARKER).write_text(text)
                        self.assertFalse(m.installed(runtime))

    def test_staged_copy_must_match_the_build_output(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, patches, built, info = self.make_runtime(Path(directory))
            with mock_patch.object(m, 'PATCH_DIR', patches), \
                 mock_patch.object(m.shutil, 'copyfile', side_effect=lambda src, dst: Path(dst).write_bytes(b'torn')):
                with self.assertRaises(ValueError):
                    m.install(runtime, built, info)
            self.assertFalse((runtime / m.MARKER).exists())
            self.assertEqual((runtime / m.PLUGIN).read_bytes(), b'stock plugin')


HARDENED = """
  GNU_STACK      0x000000 0x0000000000000000 0x0000000000000000 0x000000 0x000000 RW  0x10
  GNU_RELRO      0x02c250 0x000000000002c250 0x000000000002c250 0x002db0 0x002db0 R   0x1
 0x0000000000000001 (NEEDED)             Shared library: [libz.so.1]
 0x000000000000001e (FLAGS)              BIND_NOW
 0x000000006ffffffb (FLAGS_1)            Flags: NOW
      Properties: x86 feature: IBT, SHSTK
	x86 feature used: x86, XMM
    12: 0000000000000000     0 FUNC    GLOBAL DEFAULT  UND __stack_chk_fail@GLIBC_2.4 (3)
    13: 0000000000000000     0 FUNC    GLOBAL DEFAULT  UND __memcpy_chk@GLIBC_2.3.4 (4)
    40: 0000000000012340   300 FUNC    GLOBAL DEFAULT   12 vlc_entry__3_0_0f
    41: 0000000000012440    30 FUNC    GLOBAL DEFAULT   12 vlc_entry_license__3_0_0f
"""


class HardeningTests(unittest.TestCase):
    def test_hardened_plugin_passes(self):
        self.assertEqual(m.hardening_problems(HARDENED), [])

    def test_each_missing_property_is_reported(self):
        cases = {
            'no RELRO segment': HARDENED.replace('GNU_RELRO', 'LOAD'),
            'no BIND_NOW': HARDENED.replace('BIND_NOW', '').replace('Flags: NOW', 'Flags: PIE'),
            'executable or missing GNU_STACK': HARDENED.replace(' RW  0x10', ' RWE 0x10'),
            'no CET (IBT/SHSTK) property': HARDENED.replace('IBT, SHSTK', 'IBT'),
            'zlib (cmov) support not linked': HARDENED.replace('libz.so.1', 'libm.so.6'),
            'no stack protector': HARDENED.replace('__stack_chk_fail', 'abort'),
            'no _FORTIFY_SOURCE checks': HARDENED.replace('__memcpy_chk', 'memcpy'),
            'VLC module entry not exported': HARDENED.replace('vlc_entry__3_0_0f', 'other_entry'),
            'internal symbols exported: MP4_Seek': HARDENED + '    42: 0000000000012540 30 FUNC GLOBAL DEFAULT 12 MP4_Seek\n',
        }
        for problem, text in cases.items():
            with self.subTest(problem):
                self.assertIn(problem, m.hardening_problems(text))


if __name__ == '__main__':
    unittest.main()
