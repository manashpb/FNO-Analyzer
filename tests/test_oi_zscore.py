import math
from datetime import date
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from fno_analyzer.services.oi_history import OIHistoryStore
from fno_analyzer.services.oi_zscore import OIZScoreService, baseline, months_before, score


def row(day, expiry, oi, dte=5):
    return dict(symbol='TEST', day=day, expiry=expiry, calendar_dte=dte,
                atm_strike=100, call_oi=oi, put_oi=oi*2, oi_unit='unknown', lot_size=None)


class ZScoreTests(unittest.TestCase):
    def test_exact_dte_prior_expiry_window_and_sample_sd(self):
        rows = [row('2026-07-25','2026-07-30',0), row('2026-08-22','2026-08-27',10),
                row('2026-09-19','2026-09-24',20), row('2026-10-20','2026-10-29',999,9),
                row('2026-10-24','2026-10-29',999), row('2026-06-20','2026-06-25',999)]
        b = baseline(rows, date(2026,10,24), '2026-10-29',5,3,'call_oi')
        self.assertEqual(b['n'],3)
        self.assertEqual((b['mean'],b['sd']),(10,10))
        self.assertEqual(score(b,30)['z'],2)
        self.assertEqual([s['oi'] for s in b['samples']],[0,10,20])
        self.assertEqual(months_before(date(2024,5,31),3), date(2024,2,29))

    def test_previous_available_dte_per_expiry_and_expiry_exceptions(self):
        rows = [row('2026-07-24', '2026-07-30', 10, 6),
                row('2026-07-23', '2026-07-30', 999, 7),
                row('2026-08-22', '2026-08-27', 20, 5),
                row('2026-08-21', '2026-08-27', 999, 6),
                row('2026-09-18', '2026-09-24', 30, 6),
                row('2026-09-20', '2026-09-24', 999, 4),
                row('2026-10-20', '2026-10-29', 999, 9)]
        b = baseline(rows, date(2026,10,24), '2026-10-29', 5, 3, 'call_oi')
        self.assertEqual([s['oi'] for s in b['samples']], [10,20,30])
        self.assertEqual([s['dte'] for s in b['samples']], [6,5,6])
        self.assertEqual([s['fallback'] for s in b['samples']], [True,False,True])
        self.assertEqual(score(b,40)['z'], 2)
        for dte in (0,1):
            self.assertEqual(baseline(rows,date(2026,10,24),'2026-10-29',dte,3,'call_oi')['n'],0)
        exact = row('2026-09-23','2026-09-24',50,1)
        self.assertEqual(baseline(rows+[exact],date(2026,10,24),'2026-10-29',1,3,'call_oi')['n'],1)
        # Missing OI on the selected date must not select a different CE date.
        rows[0]['call_oi'] = None
        self.assertEqual(baseline(rows,date(2026,10,24),'2026-10-29',5,3,'call_oi')['n'],2)
        self.assertEqual(baseline(rows,date(2026,10,24),'2026-10-29',5,3,'put_oi')['n'],3)

    def test_missing_zero_variance_and_lot_change(self):
        rows = [row('2026-07-25','2026-07-30',10),row('2026-08-22','2026-08-27',10)]
        def calc():
            return score(baseline(rows,date(2026,10,24),'2026-10-29',5,6,'call_oi'),20)
        self.assertIsNone(calc()['z'])
        rows.append(row('2026-09-19','2026-09-24',10))
        self.assertEqual(calc()['reason'],'Zero historical variance')
        rows[0]['lot_size'], rows[1]['lot_size'] = 100, 50
        self.assertEqual(calc()['reason'],'Historical lot size changed')
        self.assertIsNone(score(baseline(rows,date(2026,10,24),'2026-10-29',5,6,'call_oi'),None)['z'])

    def test_stored_periods_persist_and_live_uses_full_atm(self):
        with tempfile.TemporaryDirectory() as tmp:
            store=OIHistoryStore(Path(tmp)/'oi.sqlite3')
            store.set_universe([{'Name':'TEST'}],'2026-10-24')
            for day, expiry, oi in [('2026-06-20','2026-06-25',0),('2026-07-25','2026-07-30',10),
                                    ('2026-08-22','2026-08-27',20),('2026-09-19','2026-09-24',30),
                                    ('2026-10-24','2026-10-29',40)]:
                store.set_calendar({day:True},'fixture')
                store.set_expiries('TEST',[dict(expiry=expiry,first_date=day,provider_id=expiry)],'fixture')
                store.ingest('TEST',day,expiry,day+'T15:30:00+05:30',{'uv':105},
                             [{'sp':110,'cOI':999,'pOI':999},{'sp':100,'cOI':oi,'pOI':oi*2}])
            service=OIZScoreService(store)
            service.rebuild(date(2026,10,25))
            saved=service.snapshot()['rows'][0]
            self.assertEqual(set(saved['periods']), {'3','6','12'})
            self.assertEqual(saved['periods']['3']['ce']['n'],3)
            self.assertEqual(saved['periods']['3']['ce']['z'],2)
            reopened=OIZScoreService(OIHistoryStore(store.path))
            self.assertEqual(reopened.snapshot()['rows'],[saved])
            self.assertIsNone(reopened.live('NIFTY',{},[]))
            with patch('fno_analyzer.services.oi_zscore.datetime') as clock:
                clock.now.return_value.date.return_value=date(2026,10,25)
                closing=reopened.live('TEST',{'uv':105,'exp':'29-Oct-2026'},[])
                self.assertEqual(closing['basis'],'archived_close')
                self.assertEqual(closing['day'],'2026-10-24')
                self.assertEqual(closing['periods']['3']['ce']['z'],2)
                self.assertNotIn('basis',reopened.live('TEST',{'exp':'30-Oct-2026'},[]))
                clock.fromtimestamp.return_value.date.return_value=date(2026,10,25)
                live=reopened.live('TEST',{'uv':105,'exp':'30-Oct-2026','ts':1792895400},[
                    {'sp':110,'cOI':999},{'sp':100,'cOI':40,'pOI':80}])
                self.assertEqual(live['atm_strike'],100)
                self.assertEqual(live['periods']['3']['ce']['n'],3)
                clock.now.return_value.date.return_value=date(2026,10,26)
                self.assertIn('Update',reopened.live('TEST',{},[])['reason'])


if __name__ == '__main__':
    unittest.main()
