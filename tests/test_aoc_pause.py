import sys
import tempfile
from pathlib import Path
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from fno_analyzer.providers.aoc import AocClient
from fno_analyzer.errors import ProviderError


class PauseTests(unittest.TestCase):
    def test_pause_blocks_all_requests_and_can_resume_without_restart(self):
        client = AocClient({'providers': {'aoc': {'api_mode': 'v27',
            'base_url': 'https://unused.invalid', 'token': 'synthetic'}}, 'server': {}, 'cache': {}})
        client.session.get = Mock()
        with tempfile.TemporaryDirectory() as folder:
            client.pause_file = Path(folder) / 'AOC_PAUSED'
            self.assertTrue(client.configured)
            client.pause_file.touch()
            self.assertFalse(client.configured)
            for request in (lambda: client.fetch_live('NIFTY'),
                            lambda: client._request('historical', {}),
                            lambda: client._v27_get('get-tickers', {})):
                with self.assertRaises(ProviderError) as error:
                    request()
                self.assertEqual(error.exception.code, 'AOC_PAUSED')
                self.assertFalse(error.exception.retryable)
            client.session.get.assert_not_called()
            client.pause_file.unlink()
            self.assertTrue(client.configured)
