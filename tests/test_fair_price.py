import sys
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import Mock
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from fno_analyzer.application import Application
from fno_analyzer.providers.dhan import normalize_dhan_chain, EXPDATEJ_OFFSET
from fno_analyzer.errors import InvalidParameter


class FairPriceTests(unittest.TestCase):
    def app(self):
        app = Application.__new__(Application)
        app._entry = Mock(return_value={'seg': 0, 'sid': 13})
        app.dhan = Mock()
        app.aoc = Mock()
        return app

    def test_greeks_preserved_on_full_chain(self):
        raw = {'sltp': 100, 'oc': {str(k): {'ce': {'ltp': 12, 'optgeeks': {'delta': .5, 'gamma': .02, 'theta': -7}}} for k in [90,100,110]}}
        chain = normalize_dhan_chain(raw, 'NIFTY', 1)
        self.assertEqual(len(chain['_all_strikes']), 3)
        for row in chain['_all_strikes']:
            self.assertEqual((row['cD'], row['cG'], row['cT']), (.5,.02,-7))
            self.assertIsNone(row['pG'])

    def test_chain_uses_requested_expiry_full_rows_and_cached_time(self):
        app = self.app()
        app._dhan_chain_data = Mock(return_value={'snapshot': {'uv': 100}, 'strikes': [{'sp':100}], '_all_strikes': [{'sp':90}, {'sp':100}], 'refreshed_at':'2026-10-23T12:00:00+05:30'})
        data, status = app.dispatch('/api/fair-price/chain', {'ticker':['NIFTY'], 'expiry':['1470000000']})
        app._dhan_chain_data.assert_called_once_with({'seg':0,'sid':13},1470000000)
        self.assertEqual(status,200)
        self.assertEqual(len(data['strikes']),2)
        self.assertEqual(data['refreshed_at'],'2026-10-23T12:00:00+05:30')
        self.assertIn('15:30:00+05:30',data['expires_at'])
        app.aoc.assert_not_called()
        with self.assertRaises(InvalidParameter):
            app.dispatch('/api/fair-price/chain', {'ticker':['NIFTY'], 'expiry':['bad']})

    def test_expiries_filter_expired_and_sort(self):
        app = self.app()
        def expiry(year):
            return int(datetime(year,1,1,tzinfo=ZoneInfo('Asia/Kolkata')).timestamp()) - EXPDATEJ_OFFSET
        app.dhan.expiry_list.return_value = {'data':{'exps':[{'explst':[expiry(2099),expiry(2000),expiry(2098)]}]}}
        data, status = app.dispatch('/api/fair-price/expiries', {'ticker':['NIFTY']})
        self.assertEqual(status,200)
        self.assertEqual([row['id'] for row in data['expiries']],[expiry(2098),expiry(2099)])
