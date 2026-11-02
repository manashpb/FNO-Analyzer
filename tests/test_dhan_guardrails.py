from pathlib import Path
import sys
from unittest import TestCase
from unittest.mock import Mock, patch
from datetime import datetime
from threading import Lock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from fno_analyzer.providers.dhan import DhanClient
from fno_analyzer.errors import ProviderError, ProviderAuthError
from fno_analyzer.application import Application, IST
from fno_analyzer.cache import TTLCache


class GuardrailTests(TestCase):
    def client(self):
        return DhanClient({'providers':{'dhan':{'jwt':'synthetic','option_chain_url':'https://unused.invalid'}},'server':{}})

    @patch('fno_analyzer.providers.dhan.time.sleep')
    def test_auth_and_rate_limit_circuit_prevents_more_requests(self, sleep):
        for status in (401,429):
            client=self.client()
            client.session.post=Mock(return_value=Mock(status_code=status,headers={'Retry-After':'120'}))
            for _ in range(2):
                with self.assertRaises(ProviderError):
                    client._post('https://unused.invalid',{})
            self.assertEqual(client.session.post.call_count,1)

    def test_dhan_bridge_full_chain_cache_and_no_aoc_calls(self):
        app=Application.__new__(Application)
        app.optionchain_lock=Lock();app.optionchain_cache=TTLCache(60)
        app._entry=Mock(return_value={'seg':0,'sid':13})
        app._dhan_chain_data=Mock(return_value={'refreshed_at':'2026-11-02T10:00:00+05:30',
            'snapshot':{'s':'NIFTY','exp':'03-Nov-2026'},'_all_strikes':[{'sp':100},{'sp':200}]})
        app.aoc=Mock()
        with patch('fno_analyzer.application.datetime') as clock:
            clock.now.return_value=datetime(2026,11,2,10,tzinfo=IST)
            clock.fromisoformat.side_effect=datetime.fromisoformat
            result=app.optionchain_live('NIFTY');again=app.optionchain_live('NIFTY')
        self.assertEqual(result['strikes'],[{'sp':100},{'sp':200}])
        self.assertEqual(result['refreshed_at'],again['refreshed_at'])
        self.assertEqual(result['timestamp_kind'],'snapshot-acquisition')
        app._dhan_chain_data.assert_called_once()
        app.aoc.fetch_live.assert_not_called()
