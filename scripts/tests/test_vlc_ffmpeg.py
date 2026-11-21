"""Pure dependency-check tests: no compiler, player, library loading or downloads."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('checker', Path(__file__).parents[1] / 'check-vlc-ffmpeg.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class FFmpegTests(unittest.TestCase):
    def test_codec_format_and_packetizer_consumers_are_discovered(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            names = ['codec/a.so', 'demux/b.so', 'packetizer/c.so']
            for name in names:
                (root / name).parent.mkdir(exist_ok=True)
                (root / name).touch()
            with patch.object(m, 'needed', return_value=['libavcodec.so.62', 'libavutil.so.60', 'libc.so.6']):
                users = m.consumers(root)
            self.assertEqual(len(users), 3)
            self.assertTrue(all(v == ['libavcodec.so.62', 'libavutil.so.60'] for v in users.values()))

    def test_host_fallback_and_cross_abi_alias_are_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            with self.assertRaises(ValueError):
                m.check_resolved('libavcodec.so.62', Path('/usr/lib64/libavcodec.so.62'), [root])
            target = root / 'libavcodec.so.63'
            target.touch()
            alias = root / 'libavcodec.so.62'
            alias.symlink_to(target)
            with patch.object(m, 'dynamic', return_value='(SONAME) Library soname: [libavcodec.so.63]'):
                with self.assertRaises(ValueError):
                    m.check_resolved('libavcodec.so.62', alias, [root])
            with patch.object(m, 'dynamic', return_value='(SONAME) Library soname: [libavcodec.so.62]'):
                m.check_resolved('libavcodec.so.62', target, [root])

    def test_traditional_chinese_environment_uses_c_for_all_tools(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            plugin = root / 'plugin.so'
            plugin.touch()
            library = root / 'libavcodec.so.62'
            library.touch()
            calls = []

            def tool(command, **kwargs):
                calls.append(command)
                self.assertEqual(kwargs['env']['LC_ALL'], 'C')
                self.assertEqual(kwargs['env']['LANG'], 'C')
                if command[0] == 'readelf':
                    if Path(command[-1]) == plugin:
                        return '(NEEDED) Shared library: [libavcodec.so.62]'
                    return '(SONAME) Library soname: [libavcodec.so.62]'
                self.assertEqual(command[:2], ['ldd', '-r'])
                self.assertNotIn('LD_PRELOAD', kwargs['env'])
                return f'libavcodec.so.62 => {library} (0x123)\n'

            with patch.dict(os.environ, LC_ALL='zh_TW.UTF-8', LANG='zh_TW.UTF-8',
                            LANGUAGE='zh_TW:zh', LD_PRELOAD='/test/preload.so'), \
                 patch.object(m.subprocess, 'check_output', side_effect=tool):
                # Covers discovery (also --needed-only), ldd -r, and SONAME parsing.
                m.verify(root, root, root)
                self.assertEqual(os.environ['LC_ALL'], 'zh_TW.UTF-8')
            self.assertEqual([c[0] for c in calls], ['readelf', 'ldd', 'readelf'])

    def test_relocation_and_missing_dependency_errors_in_chinese_environment(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            plugin = root / 'plugin.so'
            for error in ['libavcodec.so.62 => not found', 'undefined symbol: avcodec_test']:
                with self.subTest(error=error), \
                     patch.dict(os.environ, LC_ALL='zh_TW.UTF-8', LANG='zh_TW.UTF-8'), \
                     patch.object(m, 'consumers', return_value={plugin: ['libavcodec.so.62']}), \
                     patch.object(m.subprocess, 'check_output', return_value=error) as tool:
                    with self.assertRaisesRegex(ValueError, 'unresolved ELF dependency/relocation'):
                        m.verify(root, root, root)
                    self.assertEqual(tool.call_args.kwargs['env']['LC_ALL'], 'C')

    def test_transitive_resample_library_is_checked(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            plugin = root / 'plugin.so'
            output = ('libavcodec.so.62 => ' + str(root / 'libavcodec.so.62') + ' (0x123)\n'
                      'libswresample.so.6 => /usr/lib64/libswresample.so.6 (0x456)\n')
            with patch.object(m, 'consumers', return_value={plugin: ['libavcodec.so.62']}), \
                 patch.object(m.subprocess, 'check_output', return_value=output), \
                 patch.object(m, 'dynamic', return_value='(SONAME) Library soname: [libavcodec.so.62]'):
                with self.assertRaises(ValueError):
                    m.verify(root, root, root)


if __name__ == '__main__':
    unittest.main()
