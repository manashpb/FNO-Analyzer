import unittest
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from fno_analyzer.errors import AppError, InvalidParameter, ProviderError
from fno_analyzer.providers.dhan import DhanClient
from fno_analyzer.services.scanners import IVScanner, iv_trend


def history(values, percentiles=None):
    return {"date": [f"{i + 1:02d}-09-2026" for i in range(len(values))],
            "iv": values, "ivp": percentiles or [50] * len(values)}


class TrendTests(unittest.TestCase):
    def test_reverse_order_and_smooth_before_comparing(self):
        data = history([10, 20, 30, 40, 50], [10, 20, 30, 40, 50])
        result = iv_trend({key: list(reversed(value)) for key, value in data.items()}, 2, 3)
        self.assertEqual(result["iv_start"], 20)
        self.assertEqual(result["iv_end"], 40)
        self.assertEqual(result["iv_change"], 20)
        self.assertEqual(result["ivp_change"], 20)
        self.assertEqual(result["start_date"], "03-Sep-2026")
        self.assertEqual(result["end_date"], "05-Sep-2026")

    def test_noise_is_smoothed_and_missing_padding_excluded(self):
        result = iv_trend(history([30, 30, 30, 10, 35, 0, float("nan")]), 2, 3)
        self.assertLess(result["iv_change"], 0)  # Raw endpoint rose, smoothed IV cooled.
        self.assertEqual(result["end_date"], "05-Sep-2026")
        self.assertIsNone(iv_trend(history([10, 20]), 2, 3))
        self.assertEqual(iv_trend(history([20, 20, 20]), 1, 2)["iv_change"], 0)

    def test_zero_ivp_is_valid_but_invalid_dates_are_not(self):
        data = history([20, 21, 22], [0, 0, 0])
        data["date"][0] = "invalid"
        result = iv_trend(data, 1, 1)
        self.assertEqual(result["ivp_end"], 0)
        self.assertEqual(result["iv_change"], 1)


class FakeDhan:
    def __init__(self):
        self.calls = []
        self.rows = [
            {"symbol": name, "segId": seg, "secId": sid, "exch": "NSE", "ivp": ivp, "atmiv": 20}
            for name, seg, sid, ivp in [("HIGH", 1, 1, 90), ("LOW", 1, 2, 10),
                                      ("MIDDLE", 1, 3, 50), ("BOUNDARY", 1, 4, 80),
                                      ("INDEX", 0, 5, 95), ("SHORT", 1, 6, 95)]
        ]

    def iv_movers(self):
        return {"data": self.rows}

    def analytics_history(self, seg, sid, lookback):
        self.calls.append((seg, sid, lookback))
        return {"data": history([30, 25, 20, 15] if sid == 1 else [10, 15, 20, 25] if sid == 2 else [20])}


class ScannerTests(unittest.TestCase):
    def run_scan(self, scanner):
        with patch("fno_analyzer.services.scanners.Thread") as thread:
            state = scanner.start(80, 20, 2, 2)
            self.assertEqual(state["status"], "running")
            thread.assert_called_once()
        scanner._run(80, 20, 2, 2)
        return scanner.snapshot(state["id"])

    def test_prefilter_stock_only_strict_cutoffs_and_missing_history(self):
        dhan = FakeDhan()
        scanner = IVScanner(dhan)
        state = self.run_scan(scanner)
        self.assertEqual(state["status"], "complete")
        self.assertEqual([row["symbol"] for row in state["high"]], ["HIGH"])
        self.assertEqual([row["symbol"] for row in state["low"]], ["LOW"])
        self.assertEqual(state["skipped"][0]["symbol"], "SHORT")
        self.assertEqual(dhan.calls, [(1, 1, "1y"), (1, 2, "1y"), (1, 6, "1y")])
        state["high"].clear()
        self.assertEqual(len(scanner.snapshot(state["id"])["high"]), 1)

    def test_rate_limit_stops_further_history_requests(self):
        dhan = FakeDhan()
        def limited(*args):
            dhan.calls.append(args)
            raise ProviderError("Rate limited", code="DHAN_RATE_LIMIT")
        dhan.analytics_history = limited
        state = self.run_scan(IVScanner(dhan))
        self.assertEqual(state["status"], "failed")
        self.assertEqual(len(dhan.calls), 1)

    def test_direction_filters_off_return_cutoff_matches_without_history(self):
        dhan = FakeDhan()
        scanner = IVScanner(dhan)
        with patch("fno_analyzer.services.scanners.Thread"):
            state = scanner.start(80, 20, 2, 2, False, False)
        scanner._run(80, 20, 2, 2, False, False)
        result = scanner.snapshot(state["id"])
        self.assertEqual(result["status"], "complete")
        self.assertEqual([row["symbol"] for row in result["high"]], ["SHORT", "HIGH"])
        self.assertEqual([row["symbol"] for row in result["low"]], ["LOW"])
        self.assertEqual(result["skipped"], [])
        self.assertEqual(dhan.calls, [])
        self.assertFalse(result["falling"])
        self.assertFalse(result["rising"])

    def test_independent_direction_filters_only_fetch_enabled_group(self):
        for falling, rising, expected in [(False, True, [2]), (True, False, [1, 6])]:
            dhan = FakeDhan()
            scanner = IVScanner(dhan)
            with patch("fno_analyzer.services.scanners.Thread"):
                state = scanner.start(80, 20, 2, 2, falling, rising)
            scanner._run(80, 20, 2, 2, falling, rising)
            result = scanner.snapshot(state["id"])
            self.assertEqual(result["status"], "complete")
            self.assertEqual([call[1] for call in dhan.calls], expected)

    def test_validation_busy_and_cancel(self):
        scanner = IVScanner(FakeDhan())
        for args in [(80, 80, 5, 3), (float("nan"), 20, 5, 3), (80, 20, 61, 3)]:
            with self.assertRaises(InvalidParameter):
                scanner.start(*args)
        with patch("fno_analyzer.services.scanners.Thread"):
            state = scanner.start(80, 20, 2, 2)
            with self.assertRaises(AppError):
                scanner.start(80, 20, 2, 2)
            scanner.cancel(state["id"])
        scanner._run(80, 20, 2, 2)
        self.assertEqual(scanner.snapshot(state["id"])["status"], "cancelled")
        self.assertEqual(scanner.dhan.calls, [])


class AnalyticsTests(unittest.TestCase):
    def test_shared_cache_and_direct_movers_segment(self):
        client = DhanClient({"providers": {"dhan": {"ivpivr_url": "https://example.test/ivp_ivr"}}, "server": {}})
        with patch.object(client, "_post", return_value={"code": 0, "data": {}}) as post, \
                patch("fno_analyzer.providers.dhan.time.sleep") as sleep:
            client.analytics_history(1, 123)
            client.ivp_ivr(2, 123)
            self.assertEqual(post.call_count, 1)
            client.analytics_history(1, 456)
            sleep.assert_called_once()
            self.assertEqual(post.call_args.args[1]["data"]["SegID"], 1)


if __name__ == "__main__":
    unittest.main()
