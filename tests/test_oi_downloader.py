from datetime import datetime
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fno_analyzer.errors import AppError, ProviderError
from fno_analyzer.services.oi_downloader import OIHistoryUpdater, validate_snapshot
from fno_analyzer.services.oi_history import OIHistoryStore, IST
from fno_analyzer.providers.aoc import AocClient


class Clock(datetime):
    @classmethod
    def now(cls, tz=None):
        return datetime(2026, 10, 6, 18, tzinfo=IST)


def payload(day, symbol="TEST", expiry="06-Oct-2026", hour=15):
    observed = datetime.fromisoformat(day + f"T{hour}:30:00+05:30")
    snapshot = {"s": symbol, "exp": expiry, "dt": observed.strftime("%d-%b-%Y"),
                "ts": int(observed.timestamp() * 1000), "uv": 100}
    row = {"sp": 100, "cOI": 10, "pOI": 20, "cD": 0.5, "pD": -0.5}
    return {"data": {"snapshot": {"k": list(snapshot), "v": list(snapshot.values())},
                     "strikes": {"k": list(row), "v": [list(row.values())]}}}


class FakeAoc:
    configured = True
    request_interval = 2

    def __init__(self):
        self.calls = []
        self.failure = None

    def get_tickers(self, force=False):
        return [{"Name": "TEST"}, {"Name": "NIFTY"}]

    def get_expiries(self, symbol):
        self.calls.append(("expiry", symbol))
        return ["29-Sep-2026", "06-Oct-2026"]

    def fetch_historical(self, symbol, expiry, timestamp):
        self.calls.append((symbol, expiry, timestamp))
        if self.failure:
            raise self.failure
        day = datetime.fromtimestamp(timestamp/1000, IST).date().isoformat()
        return payload("2026-10-01" if day == "2026-10-03" else day)


class UpdaterTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.store = OIHistoryStore(root / "oi.sqlite3")
        mapping = root / "map.json"
        mapping.write_text(json.dumps({"mapped": [{"aoc": "TEST", "seg": 2},
                                                    {"aoc": "NIFTY", "seg": 0}]}))
        self.aoc = FakeAoc()
        self.updater = OIHistoryUpdater(self.aoc, self.store, mapping)
        plan = self.store.iter_candidate_days
        self.plan_patch = patch.object(self.store, "iter_candidate_days", side_effect=lambda *args: plan("2026-10-01", "2026-10-03"))
        self.plan_patch.start()
        self.addCleanup(self.plan_patch.stop)

    def run_update(self):
        with patch("fno_analyzer.services.oi_downloader.Thread"), patch("fno_analyzer.services.oi_downloader.datetime", Clock):
            self.updater.start()
            self.updater._run()
        return self.updater.snapshot()

    def test_resume_and_stale_holiday_snapshot(self):
        state = self.run_update()
        self.assertEqual(state["status"], "complete")
        self.assertEqual((state["saved"], state["unavailable"]), (1, 1))
        self.assertEqual(state["excluded"], ["NIFTY"])
        self.assertEqual(self.aoc.calls[0], ("expiry", "RELIANCE"))
        self.assertEqual(self.run_update()["total"], 0)
        self.assertEqual(self.store.status()["chains"], 1)
        self.assertIsNone(self.store.session_dte("2026-10-01", "2026-10-06"))

    def test_current_day_cutoff_and_closing_snapshot(self):
        self.plan_patch.stop()
        plan = self.store.iter_candidate_days
        for hour, minute, second, expected_end, expected_saved in (
            (15, 59, 59, "2026-10-05", 0),
            (16, 0, 0, "2026-10-06", 1),
            (18, 0, 0, "2026-10-06", 0),
        ):
            with self.subTest(hour=hour, minute=minute, second=second):
                observed_now = datetime(2026, 10, 6, hour, minute, second, tzinfo=IST)

                class CutoffClock(datetime):
                    @classmethod
                    def now(cls, tz=None):
                        return observed_now.astimezone(tz)

                with patch("fno_analyzer.services.oi_downloader.Thread"), \
                     patch("fno_analyzer.services.oi_downloader.datetime", CutoffClock), \
                     patch.object(self.store, "iter_candidate_days", side_effect=lambda start, end: plan("2026-10-06", end) if end >= "2026-10-06" else []):
                    self.updater.start()
                    self.updater._run()
                state = self.updater.snapshot()
                self.assertEqual(state["status"], "complete")
                self.assertEqual(state["end"], expected_end)
                self.assertEqual(state["saved"], expected_saved)
        fetches = [call for call in self.aoc.calls if call[0] == "TEST"]
        self.assertEqual(len(fetches), 1)
        self.assertEqual(datetime.fromtimestamp(fetches[0][2] / 1000, IST),
                         datetime(2026, 10, 6, 16, tzinfo=IST))
        self.assertEqual(self.store.status()["chains"], 1)

    def test_rate_limit_stops_and_leaves_retryable_gap(self):
        self.aoc.failure = ProviderError("Private provider text", code="AOC_RATE_LIMIT")
        state = self.run_update()
        self.assertEqual(state["status"], "failed")
        self.assertEqual(len(self.aoc.calls), 2)
        self.assertNotIn("Private", state["error"])
        self.assertEqual(self.store.status()["attempts"], [{"status": "error", "count": 1}])
        self.aoc.failure = None
        self.assertEqual(self.run_update()["saved"], 1)

    def test_busy_cancel_and_snapshot_copy(self):
        with patch("fno_analyzer.services.oi_downloader.Thread"):
            state = self.updater.start()
            with self.assertRaises(AppError):
                self.updater.start()
            self.updater.cancel(state["id"])
            self.updater._run()
        state = self.updater.snapshot()
        self.assertEqual(state["status"], "cancelled")
        self.assertEqual(self.aoc.calls, [])
        state["excluded"].append("mutated")
        self.assertEqual(self.updater.snapshot()["excluded"], [])

    def test_repeated_invalid_snapshots_stop_after_three_updates(self):
        from unittest.mock import Mock
        fetch = Mock(side_effect=lambda symbol, expiry, timestamp: payload(
            datetime.fromtimestamp(timestamp / 1000, IST).date().isoformat(), symbol="WRONG"))
        self.aoc.fetch_historical = fetch
        for _ in range(3):
            self.assertEqual(self.run_update()["errors"], 2)
            OIHistoryStore(self.store.path)
        self.assertEqual(self.run_update()["total"], 0)
        self.assertEqual(fetch.call_count, 6)
        self.assertEqual(self.updater.snapshot()["archive"]["retry_exhausted"], 2)

    def test_wrong_identity_and_intraday_rejected(self):
        from fno_analyzer.providers.aoc import parse_payload
        task = {"symbol": "TEST", "day": "2026-10-02", "expiry": "2026-10-06"}
        cutoff = datetime(2026, 10, 2, 16, tzinfo=IST)
        for value in (payload("2026-10-02", symbol="OTHER"),
                      payload("2026-10-02", expiry="29-Sep-2026"),
                      payload("2026-10-02", hour=11)):
            with self.assertRaises(ValueError):
                validate_snapshot(task, parse_payload(value), cutoff)

    def test_new_stock_classification_without_map_regeneration(self):
        from unittest.mock import Mock
        self.aoc.get_tickers = lambda force: [{"Name": "TEST"}, {"Name": "NEW"}, {"Name": "NIFTY"}]
        symbol_client = Mock()
        symbol_client.search.return_value = [{"Ticker_t": "NEW", "Seg_s": "E", "d_exch_t": "NSE"}]
        self.updater.symbol_client = symbol_client
        # The fake snapshot transport supports TEST only; discard candidates so
        # this check isolates membership and discovery of a newly added stock.
        self.store.iter_candidate_days.side_effect = lambda *args: []
        state = self.run_update()
        self.assertEqual(state["symbols"], 2)
        symbol_client.search.assert_called_once_with("NEW")
        self.assertEqual(state["excluded"], ["NIFTY"])

        self.assertEqual([call for call in self.aoc.calls if call[0] == "expiry"], [("expiry", "RELIANCE")])
        self.assertEqual(state["discovered"], 1)
        self.assertEqual(state["expiries_applied"], 2)
        with self.store.connect() as db:
            shared = list(db.execute("SELECT symbol,expiry,provider_id,first_date FROM expiries ORDER BY symbol,expiry"))
        self.assertEqual([(row[1], row[2], row[3]) for row in shared if row[0] == "NEW"],
                         [(row[1], row[2], row[3]) for row in shared if row[0] == "TEST"])

    def prepare_day_sampling(self, response):
        names = [f"STOCK{index:02}" for index in range(10)]
        self.store.set_universe([{"Name": name} for name in names], "2026-10-06")
        self.aoc.get_tickers = lambda force: [{"Name": name} for name in names]
        self.aoc.fetch_historical = response
        # Exercise the actual planner over two dates, to verify day reset.
        plan = OIHistoryStore.iter_candidate_days
        self.store.iter_candidate_days.side_effect = lambda *args: plan(self.store, "2026-10-04", "2026-10-05")
        return names

    def test_first_six_unavailable_skip_remaining_and_persist(self):
        calls = []
        def missing(symbol, expiry, timestamp):
            day = datetime.fromtimestamp(timestamp / 1000, IST).date().isoformat()
            calls.append((symbol, day))
            if day == "2026-10-04":
                return {"data": {}}
            return payload(day, symbol=symbol)
        self.prepare_day_sampling(missing)
        state = self.run_update()
        self.assertEqual(state["status"], "complete")
        self.assertEqual(len([call for call in calls if call[1] == "2026-10-04"]), 6)
        self.assertEqual(len([call for call in calls if call[1] == "2026-10-05"]), 10)
        self.assertEqual((state["checked"], state["processed"], state["skipped_tasks"]), (16, 20, 4))
        self.assertEqual(state["skipped_days"], ["2026-10-04"])
        reopened = OIHistoryStore(self.store.path)
        self.assertEqual(reopened.status()["day_skips"][0]["day"], "2026-10-04")
        with reopened.connect() as db:
            self.assertIsNone(db.execute("SELECT trading FROM calendar WHERE day='2026-10-04'").fetchone())
        self.assertEqual(reopened.candidate_plan("2026-10-04", "2026-10-05"), [])
        self.assertEqual(self.run_update()["total"], 0)

    def test_success_or_validation_error_in_first_six_prevents_skip(self):
        for error in (False, True):
            with self.subTest(error=error):
                with self.store.connect() as db:
                    db.execute("DELETE FROM option_strikes")
                    db.execute("DELETE FROM chains")
                    db.execute("DELETE FROM attempts")
                calls = []
                def response(symbol, expiry, timestamp):
                    day = datetime.fromtimestamp(timestamp / 1000, IST).date().isoformat()
                    calls.append((symbol, day))
                    if symbol == "STOCK02":
                        return payload(day, symbol="WRONG" if error else symbol)
                    return {"data": {}}
                self.prepare_day_sampling(response)
                self.run_update()
                self.assertEqual(len(calls), 20)
                self.assertEqual(self.store.status()["day_skips"], [])

    def test_all_user_holidays_excluded_without_requests(self):
        from fno_analyzer.services.oi_calendar import USER_HOLIDAYS
        self.assertEqual(len(USER_HOLIDAYS), 20)
        self.assertEqual(set(self.store.status()["holiday_dates"]), USER_HOLIDAYS)
        self.store.set_universe([{"Name": "TEST"}], "2026-10-06")
        self.store.set_expiries("TEST", [{"first_date": "2025-10-01", "expiry": "2026-12-31",
                                        "provider_id": "31-Dec-2026"}], "test")
        for day in USER_HOLIDAYS:
            self.assertEqual(list(OIHistoryStore.iter_candidate_days(self.store, day, day)), [])


class PacingTests(unittest.TestCase):
    def test_429_cooldown_and_shared_pacing(self):
        client = AocClient({"providers": {"aoc": {"base_url": "https://example.test", "token": "test"}},
                            "server": {}, "cache": {}})
        with patch.object(client, "_request", return_value={}), patch("fno_analyzer.providers.aoc.time.sleep") as sleep:
            client._get("live")
            client._get("historical")
            self.assertGreater(sleep.call_args.args[0], 1)
        from unittest.mock import Mock
        response = Mock(status_code=429, headers={"Retry-After": "120"})
        with patch.object(client.session, "get", return_value=response), patch("fno_analyzer.providers.aoc.time.sleep"):
            with self.assertRaises(ProviderError):
                client._get("historical")
            with self.assertRaises(ProviderError):
                client._get("live")
            self.assertGreater(client._cooldown_until - client._last_request, 119)
