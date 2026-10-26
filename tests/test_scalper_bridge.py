import sys
import unittest
from pathlib import Path
from threading import Lock
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from fno_analyzer.application import Application
from fno_analyzer.cache import TTLCache
from fno_analyzer.errors import ProviderError

class ScalperBridgeTests(unittest.TestCase):
    def app(self):
        app = Application.__new__(Application)
        app.settings = {'chain': {'max_strikes': 1}}
        app.scalper_cache, app.scalper_lock = TTLCache(1), Lock()
        app._entry = Mock(return_value={'seg': 0, 'sid': 13})
        app.dhan, app.aoc = Mock(), Mock()
        app.dhan.option_chain.return_value = {'sltp': 100, 'explst': [1470000000],
            'oc': {str(k): {'ce': {'ltp': 10, 'bid': 9, 'ask': 11}} for k in [90,100,110]}}
        return app

    def test_exact_expiry_full_chain_and_original_cached_timestamp(self):
        app = self.app()
        result, status = app.dispatch('/api/scalper/chain', {'ticker':['NIFTY'], 'expiry':['1470000000']})
        again = app.scalper_chain('NIFTY',1470000000)
        self.assertEqual(status,200)
        self.assertEqual(result['source'],'dhan-browser')
        self.assertEqual(len(result['strikes']),3)
        self.assertEqual(result['refreshed_at'],again['refreshed_at'])
        app.dhan.option_chain.assert_called_once_with(0,13,1470000000)
        app.aoc.fetch_live.assert_not_called()

    def test_wrong_expiry_or_provider_failure_never_falls_back(self):
        app = self.app()
        with self.assertRaises(ProviderError):
            app.scalper_chain('NIFTY',1470000001)
        app.dhan.option_chain.side_effect = ProviderError('Expired browser token')
        with self.assertRaises(ProviderError):
            app.scalper_chain('NIFTY',1470000000)
        app.aoc.fetch_live.assert_not_called()
