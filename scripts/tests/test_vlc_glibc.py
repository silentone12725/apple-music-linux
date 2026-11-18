import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('glibc', Path(__file__).parents[1] / 'check-vlc-glibc.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

DYNAMIC = ' 0x000000006ffffffe (VERNEED)            0xc5f8\n'
NEEDS_C = ("\nVersion needs section '.gnu.version_r' contains 1 entry:\n"
           ' Addr: 0x0000000000000000  Offset: 0x00c5f8  Link: 7 (.dynstr)\n'
           '  000000: Version: 1  File: libc.so.6  Cnt: 2\n'
           '  0x0010:   Name: GLIBC_2.38  Flags: none  Version: 3\n'
           '  0x0020:   Name: GLIBC_2.2.5  Flags: none  Version: 2\n')
# What a localized readelf prints when LC_ALL=C is not honoured (real binutils translations).
LOCALIZED = {
    'fr_FR.UTF-8': ("\nLa section de dépendances de version « .gnu.version_r » contient 1 entrée :\n"
                    '  0x0010:   Nom: GLIBC_2.38  Fanions: aucun  Version: 3\n'),
    'sv_SE.UTF-8': ("\nVersionbehovssektion ”.gnu.version_r” innehåller 1 post:\n"
                    '  0x0010:   Namn: GLIBC_2.38  Flaggor: ingen  Version: 3\n'),
    'zh_TW.UTF-8': ("\n版本需求區段「.gnu.version_r」包含 1 個項目：\n"
                    '  0x0010:   名稱: GLIBC_2.38  旗標: 無  版本: 3\n'),
}


class GlibcTests(unittest.TestCase):
    def test_only_requirements_not_definitions(self):
        self.assertEqual(m.required_versions('Version definition section\n Name: GLIBC_2.43\nVersion needs section\n Name: GLIBC_2.9\n Name: GLIBC_2.38\n Name: GLIBC_PRIVATE'), ['2.9', '2.38'])
        self.assertEqual(m.required_versions('Version definition section\n Name: GLIBC_2.43'), [])

    def test_definitions_after_needs_are_not_requirements(self):
        text = NEEDS_C + "\nVersion definition section '.gnu.version_d' contains 1 entry:\n  0x0000: Rev: 1  Flags: none  Index: 2  Cnt: 1  Name: GLIBC_2.43\n"
        self.assertEqual(m.required_versions(text), ['2.2.5', '2.38'])

    def test_numeric_order(self):
        self.assertLess(m.version('2.9'), m.version('2.38'))
        self.assertGreater(m.version('2.43'), m.version('2.38'))

    def test_build_host_ceiling(self):
        with patch.object(m.subprocess, 'check_output', return_value='glibc 2.35\n'):
            m.check_build_env()
        with patch.object(m.subprocess, 'check_output', return_value='glibc 2.43\n'):
            with self.assertRaises(ValueError):
                m.check_build_env()

    def test_readelf_runs_in_c_locale_whatever_the_user_locale(self):
        for locale in ['C', *LOCALIZED]:
            with self.subTest(locale=locale), \
                 patch.dict(os.environ, LC_ALL=locale, LANG=locale, LANGUAGE='zh_TW:fr:sv'), \
                 patch.object(m.subprocess, 'check_output', return_value=DYNAMIC + NEEDS_C) as tool:
                self.assertEqual(m.maximum('lib.so'), '2.38')
                env = tool.call_args.kwargs['env']
                self.assertEqual((env['LC_ALL'], env['LANG']), ('C', 'C'))
                self.assertNotIn('LANGUAGE', env)
                self.assertEqual(os.environ['LC_ALL'], locale)

    def test_localized_or_unrecognized_needs_fail_closed(self):
        for name, needs in [*LOCALIZED.items(), ('unrecognized', '\nsomething else entirely\n')]:
            with self.subTest(output=name), \
                 patch.object(m.subprocess, 'check_output', return_value=DYNAMIC + needs):
                with self.assertRaises(ValueError):
                    m.maximum('lib.so')

    def test_elf_without_version_needs_passes_with_no_requirement(self):
        with patch.object(m.subprocess, 'check_output', return_value=' 0x0000000000000001 (NEEDED) Shared library: [libfoo.so]\n'):
            self.assertIsNone(m.maximum('lib.so'))

    def test_non_glibc_needs_only_is_not_a_parse_failure(self):
        needs = "\nVersion needs section '.gnu.version_r' contains 1 entry:\n  0x0010:   Name: ZLIB_1.2.0  Flags: none  Version: 2\n"
        with patch.object(m.subprocess, 'check_output', return_value=DYNAMIC + needs):
            self.assertIsNone(m.maximum('lib.so'))

    def fake_runtime(self, directory):
        root = Path(directory)
        (root / 'lib.so').write_bytes(b'\x7fELF fake')
        return root

    def test_readelf_failure_is_an_audit_error(self):
        with tempfile.TemporaryDirectory() as d, \
             patch.object(m.subprocess, 'check_output', side_effect=subprocess.CalledProcessError(1, ['readelf'])):
            report = m.audit(self.fake_runtime(d), '2.38')
        self.assertTrue(report['errors'])
        self.assertIn('unreadable', report['errors'][0])

    def test_unparsed_needs_is_an_audit_error(self):
        with tempfile.TemporaryDirectory() as d, \
             patch.object(m.subprocess, 'check_output', return_value=DYNAMIC + LOCALIZED['fr_FR.UTF-8']):
            report = m.audit(self.fake_runtime(d), '2.38')
        self.assertTrue(report['errors'])

    def test_over_limit_elf_fails_the_command(self):
        with tempfile.TemporaryDirectory() as d, \
             patch.object(m.subprocess, 'check_output', return_value=DYNAMIC + NEEDS_C), \
             patch.object(sys, 'argv', ['check-vlc-glibc.py', '--runtime', d, '--max', '2.30']), \
             patch('builtins.print'):
            self.fake_runtime(d)
            with self.assertRaises(SystemExit) as exit_:
                m.main()
        self.assertEqual(exit_.exception.code, 1)

    @unittest.skipUnless(shutil.which('readelf'), 'binutils readelf not installed')
    def test_real_readelf_matches_c_locale_in_any_locale(self):
        target = Path(sys.executable).resolve()
        with patch.dict(os.environ, LC_ALL='C', LANG='C'):
            expected = m.maximum(target)
        self.assertIsNotNone(expected)
        for locale in LOCALIZED:
            with self.subTest(locale=locale), patch.dict(os.environ, LC_ALL=locale, LANG=locale, LANGUAGE=locale[:2]):
                self.assertEqual(m.maximum(target), expected)


if __name__ == '__main__':
    unittest.main()
