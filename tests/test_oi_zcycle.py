from datetime import date
from pathlib import Path
import tempfile
import unittest

from fno_analyzer.services.oi_history import OIHistoryStore
from fno_analyzer.services.oi_zscore import OIZScoreService


class ZCycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = OIHistoryStore(Path(self.temp.name) / 'oi.sqlite3')
        self.service = OIZScoreService(self.store)
        self.store.set_universe([{'Name': 'TEST'}], '2026-10-01')
        for day, expiry, oi in [('2026-07-25', '2026-07-30', 10),
                                ('2026-08-22', '2026-08-27', 20),
                                ('2026-09-19', '2026-09-24', 30),
                                ('2026-10-24', '2026-10-29', 40),
                                ('2026-10-25', '2026-10-29', 50)]:
            self.ingest(day, expiry, oi, spot=114 if day.endswith('25') else 101)
        self.store.set_calendar({'2026-10-23': True}, 'fixture')

    def ingest(self, day, expiry, oi, spot=101, lot=1, unit='contracts'):
        self.store.set_calendar({day: True}, 'fixture')
        self.store.set_expiries('TEST', [dict(expiry=expiry, first_date=expiry[:7]+'-01', provider_id='fixture')], 'fixture')
        target = 110 if spot > 110 else 100
        self.store.ingest('TEST', day, expiry, day+'T15:30:00+05:30', {'uv':spot},
                          [dict(sp=k, cOI=oi if k == target else 999, pOI=oi*2 if k == target else 999)
                           for k in [100,110]], lot_size=lot, oi_unit=unit)

    def test_cycle_scores_use_daily_atm_and_no_current_expiry_baseline(self):
        result = self.service.cycle('test')
        self.assertEqual(result['expiry'], '2026-10-29')
        self.assertEqual(result['previous_expiry'], '2026-09-24')
        self.assertIn('2026-10-23', result['dates'])
        self.assertEqual([d['date'] for d in result['days']], ['2026-10-24','2026-10-25'])
        first, second = result['days']
        self.assertEqual((first['atm'],second['atm']), (100,110))
        for months in ('3','6','12'):
            self.assertEqual(first['periods'][months]['ce']['z'], 2)
            self.assertEqual(second['periods'][months]['ce']['z'], 3)
            self.assertEqual(second['periods'][months]['pe']['z'], 3)
            self.assertEqual(second['periods'][months]['ce']['n'], 3)
            self.assertTrue(all(s['expiry'] < result['expiry'] for s in second['periods'][months]['ce']['samples']))

    def test_expiry_day_requires_exact_baselines(self):
        self.ingest('2026-10-29','2026-10-29',60)
        row = self.service.cycle('TEST')['days'][-1]
        self.assertIsNone(row['periods']['12']['ce']['z'])
        self.assertEqual(row['periods']['12']['ce']['n'], 0)

    def test_current_unit_or_lot_change_disables_scores(self):
        self.ingest('2026-10-25','2026-10-29',50,lot=2)
        row = self.service.cycle('TEST')['days'][-1]
        self.assertEqual(row['periods']['12']['ce']['reason'], 'Historical lot size changed')
        self.assertIsNone(row['periods']['12']['ce']['z'])
        self.ingest('2026-10-25','2026-10-29',50,unit='lots')
        self.assertEqual(self.service.cycle('TEST')['days'][-1]['periods']['12']['ce']['reason'], 'Incompatible OI units')

    def test_unavailable_expiry_and_index(self):
        self.assertFalse(self.service.cycle('NIFTY')['days'])
        self.assertFalse(self.service.cycle('TEST','2026-12-31')['days'])
        self.assertFalse(self.service.cycle('UNKNOWN')['days'])
        self.assertFalse(self.service.cycle('TEST','2026-07-30')['days'])
