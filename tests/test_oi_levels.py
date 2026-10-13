import tempfile
import unittest
from pathlib import Path

from fno_analyzer.errors import InvalidParameter
from fno_analyzer.services.oi_history import OIHistoryStore
from fno_analyzer.services.oi_levels import OILevelsScanner, levels


class OILevelsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = OIHistoryStore(Path(self.temp.name) / 'oi.sqlite3')
        self.store.set_universe([{'Name': 'TEST'}, {'Name': 'MISSING'}, {'Name': 'NIFTY'}], '2025-01-01')
        self.scanner = OILevelsScanner(self.store)
        self.rows = [dict(sp=100, cOI=10, pOI=100), dict(sp=105, cOI=20, pOI=20),
                     dict(sp=115, cOI=100, pOI=10)]

    def ingest(self, day, rows=None, spot=101, expiry='2025-01-30'):
        self.store.set_calendar({day: True}, 'fixture')
        self.store.set_expiries('TEST', [dict(expiry=expiry, first_date='2025-01-01', provider_id='fixture')], 'fixture')
        self.store.ingest('TEST', day, expiry, day + 'T15:30:00+05:30',
                          {'uv': spot}, rows or self.rows)

    def test_latest_filters_and_strict_boundaries(self):
        self.ingest('2025-01-03')
        result = self.scanner.scan(gap=1)
        self.assertEqual([r['symbol'] for r in result['rows']], ['TEST'])
        self.assertEqual(result['total'], 2)
        row = result['rows'][0]
        self.assertEqual((row['distance'], row['gap'], row['second_pct']), (1, 2, 20))
        self.assertFalse(self.scanner.scan(distance=1, gap=1)['rows'])
        self.assertFalse(self.scanner.scan(gap=2)['rows'])
        self.assertFalse(self.scanner.scan(gap=1, second=20)['rows'])

    def test_history_applies_only_to_second_filter(self):
        self.ingest('2025-01-02', spot=140)
        self.ingest('2025-01-03')
        self.assertTrue(self.scanner.scan(gap=1, days=2)['rows'])
        bad = [dict(r, pOI=90 if r['sp'] == 105 else r['pOI']) for r in self.rows]
        self.ingest('2025-01-02', bad)
        self.assertFalse(self.scanner.scan(gap=1, days=2)['rows'])
        self.assertTrue(self.scanner.scan(gap=1, days=0)['rows'])
        self.assertTrue(self.scanner.scan(gap=1, second=None, days=60)['rows'])

    def test_missing_dates_and_expiry_roll_fail_history(self):
        self.ingest('2025-01-03')
        self.store.set_calendar({'2025-01-02': True}, 'fixture')
        self.assertFalse(self.scanner.scan(gap=1, days=2)['rows'])
        self.ingest('2025-01-02', expiry='2025-01-02')
        self.assertFalse(self.scanner.scan(gap=1, days=2)['rows'])

    def test_bearish_and_tie_ranking(self):
        self.ingest('2025-01-03', spot=114)
        row = self.scanner.scan(direction='bearish', gap=1)['rows'][0]
        self.assertEqual(row['target_strike'], 115)
        strikes = [dict(strike=100, call_oi=100, put_oi=100), dict(strike=105, call_oi=100, put_oi=20)]
        result = levels(strikes, 101, 'call')
        self.assertEqual(result['call_strike'], 100)
        self.assertEqual(result['second_pct'], 100)
        strikes[1]['call_oi'] = None
        self.assertIsNone(levels(strikes, 101, 'call')['second_pct'])

    def test_validation(self):
        for kwargs in [dict(distance=float('nan')), dict(second=101), dict(days=-1),
                       dict(days=1.5), dict(gap=1.2), dict(direction='other')]:
            with self.assertRaises(InvalidParameter):
                self.scanner.scan(**kwargs)
