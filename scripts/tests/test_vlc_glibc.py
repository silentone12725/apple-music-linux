import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('glibc', Path(__file__).parents[1] / 'check-vlc-glibc.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class GlibcTests(unittest.TestCase):
    def test_only_requirements_not_definitions(self):
        self.assertEqual(m.required_versions('Version definition section\n Name: GLIBC_2.43\nVersion needs section\n Name: GLIBC_2.9\n Name: GLIBC_2.38\n Name: GLIBC_PRIVATE'), ['2.9', '2.38'])
        self.assertEqual(m.required_versions('Version definition section\n Name: GLIBC_2.43'), [])

    def test_numeric_order(self):
        self.assertLess(m.version('2.9'), m.version('2.38'))
        self.assertGreater(m.version('2.43'), m.version('2.38'))

    def test_build_host_ceiling(self):
        with patch.object(m.subprocess, 'check_output', return_value='glibc 2.35\n'):
            m.check_build_env()
        with patch.object(m.subprocess, 'check_output', return_value='glibc 2.43\n'):
            with self.assertRaises(ValueError):
                m.check_build_env()


if __name__ == '__main__':
    unittest.main()
