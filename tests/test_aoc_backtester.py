from datetime import datetime
from unittest import TestCase
from unittest.mock import patch, Mock
from fno_analyzer.config import DEFAULTS
from fno_analyzer.providers.aoc import AocClient
from fno_analyzer.errors import ProviderError
from zoneinfo import ZoneInfo

class BacktesterTests(TestCase):
    def test_access_boundaries(self):
        client = AocClient(DEFAULTS)
        client.backtester_only = True
        client._request = Mock(return_value={})
        client.request_interval = 0
        ist = ZoneInfo("Asia/Kolkata")
        for hour, requested_hour, allowed in [(16, 8, True), (16, 9, False), (16, 16, False), (17, 16, True)]:
            with self.subTest(hour=hour, requested_hour=requested_hour):
                now = datetime(2026, 11, 4, hour, tzinfo=ist)
                with patch("fno_analyzer.providers.aoc.datetime") as clock:
                    clock.now.return_value = now
                    clock.fromtimestamp.side_effect = datetime.fromtimestamp
                    params = {"timestamp": datetime(2026, 11, 4, requested_hour, tzinfo=ist).timestamp()*1000}
                    if allowed:
                        client._get("historical", params)
                    else:
                        with self.assertRaises(ProviderError) as error:
                            client._get("historical", params)
                        self.assertEqual(error.exception.code, "AOC_HISTORY_DELAY")
        for endpoint in ("live", "sectors", "sector_intraday"):
            with self.assertRaises(ProviderError) as error:
                client._get(endpoint)
            self.assertEqual(error.exception.code, "AOC_BACKTESTER_ONLY")
