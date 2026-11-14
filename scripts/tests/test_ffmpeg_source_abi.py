"""Exercise the actual source-ABI shell preflight only; no compiler/build runs."""
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).parents[1] / 'build-vlc-ffmpeg.sh'


class SourceABITests(unittest.TestCase):
    def check_source(self, util_major):
        text = SCRIPT.read_text()
        start = text.index('# Fail before compilation if the supplied source has the wrong major ABI.')
        end = text.index('\nSTAGE=', start)
        preflight = text[start:end]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ['libavcodec', 'libavformat', 'libavutil']:
                (root / name).mkdir()
            for name in ['libavcodec', 'libavformat']:
                (root / name / 'version_major.h').write_text(f'#define {name.upper()}_VERSION_MAJOR 62\n')
            # Both headers exist: existence alone must not select this decoy.
            (root / 'libavutil/version_major.h').write_text('#define LIBAVUTIL_VERSION_MINOR 0\n')
            (root / 'libavutil/version.h').write_text(f'#define LIBAVUTIL_VERSION_MAJOR {util_major}\n')
            command = 'set -eu\nSRC="$1"\nWANT="libavcodec.so.62 libavformat.so.62 libavutil.so.60"\n' + preflight
            return subprocess.run(['bash', '-c', command, 'abi-test', str(root)], text=True, capture_output=True)

    def test_ffmpeg8_major_in_avutil_version_h(self):
        result = self.check_source(60)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_incompatible_avutil_major_is_still_rejected(self):
        result = self.check_source(61)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('libavutil.so.60 required, source declares libavutil major 61', result.stderr)


if __name__ == '__main__':
    unittest.main()
