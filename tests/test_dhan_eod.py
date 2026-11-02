import json
from datetime import date, datetime
from pathlib import Path
import tempfile
import sys
from unittest import TestCase
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from fno_analyzer.services.dhan_eod import DhanEODUpdater
from fno_analyzer.services.oi_history import OIHistoryStore, IST
from fno_analyzer.services.oi_zscore import OIZScoreService
from fno_analyzer.providers.dhan import EXPDATEJ_OFFSET
from fno_analyzer.errors import ProviderError


class Clock(datetime):
    @classmethod
    def now(cls, tz=None):
        return cls(2026, 11, 2, 16, 5, tzinfo=IST)


class DhanEODTests(TestCase):
    def test_today_eod_is_full_chain_idempotent_and_used_for_zscore(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = OIHistoryStore(Path(tmp)/'oi.sqlite3')
            store.set_universe([{'Name': 'TEST'}], '2026-11-02')
            for day, expiry, oi in [('2026-08-22','2026-08-25',10),
                                    ('2026-09-22','2026-09-25',20),('2026-10-23','2026-10-26',30)]:
                store.set_calendar({day:True}, 'fixture')
                store.set_expiries('TEST',[{'expiry':expiry,'provider_id':expiry,'first_date':day}],'fixture')
                store.ingest('TEST',day,expiry,day+'T15:30:00+05:30',{'uv':100},
                             [{'sp':100,'cOI':oi,'pOI':oi*2}])
            mapping=Path(tmp)/'map.json'
            mapping.write_text(json.dumps({'mapped':[{'aoc':'TEST','sid':1,'seg':2}]}))
            client=Mock(configured=True)
            expiry=int(datetime(2026,11,5,tzinfo=IST).timestamp())-EXPDATEJ_OFFSET
            client.option_chain.return_value={'sltp':100,'explst':[expiry],
                'oc':{'90':{'ce':{'OI':5}},'100':{'ce':{'OI':40},'pe':{'OI':80}}}}
            updater=DhanEODUpdater(client,store,str(mapping))
            scores=OIZScoreService(store)
            updater.rebuild_scores=lambda:scores.rebuild(date(2026,11,2))
            with patch('fno_analyzer.services.dhan_eod.datetime',Clock):
                updater._download()
                updater._download()
            client.option_chain.assert_called_once_with(2,1,-1)
            with store.connect() as db:
                row=dict(db.execute("SELECT * FROM chains WHERE day='2026-11-02'").fetchone())
            payload=store.decode_payload(row['payload'])
            self.assertEqual(len(payload['strikes']),2)
            self.assertEqual(payload['snapshot']['source'],'dhan-eod-temporary')
            self.assertNotIn('ts',payload['snapshot'])
            result=scores.snapshot()['rows'][0]
            self.assertEqual(result['day'],'2026-11-02')
            self.assertEqual(result['periods']['3']['ce']['z'],2)
            self.assertEqual(result['periods']['3']['pe']['z'],2)

    def test_provider_error_stops_job_without_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            store=OIHistoryStore(Path(tmp)/'oi.sqlite3')
            mapping=Path(tmp)/'map.json';mapping.write_text(json.dumps({'mapped':[{'aoc':'TEST','seg':2,'sid':1}]}))
            client=Mock(configured=True);client.option_chain.side_effect=ProviderError('blocked')
            updater=DhanEODUpdater(client,store,str(mapping))
            with patch('fno_analyzer.services.dhan_eod.datetime',Clock),self.assertRaises(ProviderError):
                updater._download()
            self.assertEqual(client.option_chain.call_count,1)
