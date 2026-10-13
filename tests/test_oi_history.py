import json
from unittest.mock import patch
import tempfile
import unittest
from pathlib import Path

from fno_analyzer.services.oi_history import OIHistoryStore


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = OIHistoryStore(Path(self.temp.name) / "history.sqlite3")
        self.store.set_universe([{"Name": "TEST"}, {"Name": "NEW"}], "2026-10-06")
        self.store.set_calendar({"2026-10-02": True, "2026-10-03": False,
                                 "2026-10-04": False, "2026-10-05": False,
                                 "2026-10-06": True}, "synthetic holiday calendar")
        self.store.set_expiries("TEST", [{"expiry": "2026-10-06",
            "first_date": "2026-10-02", "provider_id": "opaque"}], "fixture")

    def ingest(self, day="2026-10-02", observed="2026-10-02T15:30:00+05:30"):
        self.store.ingest("TEST", day, "2026-10-06", observed, {"uv": 105},
                          [{"sp": 110, "cOI": 9, "pOI": 10},
                           {"sp": 100, "cOI": 0, "pOI": 12}])

    def test_heatmap_cycle_keeps_verified_gaps_and_zero_oi(self):
        self.store.set_universe([{"Name": "TEST", "Lot": 1}], "2026-10-06")
        self.store.set_expiries("TEST", [{"expiry": "2026-10-01",
            "first_date": "2026-09-01", "provider_id": "prior"}], "fixture")
        self.store.set_calendar({"2026-10-01": True}, "fixture")
        self.ingest()
        result = self.store.heatmap("test", "2026-10-06")
        self.assertEqual(result["previous_expiry"], "2026-10-01")
        self.assertEqual(result["dates"], ["2026-10-01", "2026-10-02", "2026-10-06"])
        self.assertEqual(len(result["days"]), 1)
        self.assertEqual(result["days"][0]["cells"][0], [100, 0, 12])
        self.assertEqual(result["days"][0]["atm"], 100)
        self.assertEqual(result["strikes"], [100, 110])

    def test_heatmap_lots_and_missing_lot_size(self):
        self.store.set_expiries("TEST", [{"expiry": "2026-10-01",
            "first_date": "2026-09-01", "provider_id": "prior"}], "fixture")
        self.ingest()
        self.assertEqual(self.store.heatmap("TEST")["days"][0]["cells"][0], [100, None, None])
        self.store.set_universe([{"Name": "TEST", "Lot": 4}], "2026-10-06")
        day = self.store.heatmap("TEST")["days"][0]
        self.assertEqual(day["cells"][0], [100, 0, 3])
        self.assertEqual(day["lot_basis"], "ticker metadata")
        with self.store.connect() as db:
            db.execute("UPDATE chains SET lot_size=2")
        self.assertEqual(self.store.heatmap("TEST")["days"][0]["cells"][0], [100, 0, 6])
        with self.store.connect() as db:
            db.execute("UPDATE chains SET oi_unit='lots'")
        self.assertEqual(self.store.heatmap("TEST")["days"][0]["cells"][0], [100, 0, 12])

    def test_heatmap_requires_known_previous_expiry(self):
        self.ingest()
        result = self.store.heatmap("TEST")
        self.assertEqual(result["days"], [])
        self.assertIn("Previous expiry", result["reason"])
        self.assertEqual(self.store.heatmap("UNKNOWN")["dates"], [])

    def test_incremental_holes_and_partial_universe(self):
        self.assertEqual(len(self.store.plan("2026-10-02", "2026-10-06")), 2)
        self.ingest("2026-10-06", "2026-10-06T15:30:00+05:30")
        self.assertEqual(self.store.plan("2026-10-02", "2026-10-06")[0]["day"], "2026-10-02")
        self.ingest()
        self.ingest()
        self.assertEqual(self.store.status()["chains"], 2)
        self.assertEqual(self.store.plan("2026-10-02", "2026-10-06"), [])

    def test_dte_zero_oi_and_atm_tie(self):
        self.ingest()
        with self.store.connect() as db:
            row = db.execute("SELECT * FROM chains").fetchone()
        self.assertEqual((row["calendar_dte"], row["atm_strike"], row["call_oi"]), (4, 100, 0))
        self.assertEqual(self.store.session_dte("2026-10-02", "2026-10-06"), 1)
        self.assertEqual(self.store.session_dte("2026-10-06", "2026-10-06"), 0)
        self.assertIsNone(self.store.session_dte("2026-10-01", "2026-10-07"))

    def test_stale_snapshot_and_nontrading_day(self):
        with self.assertRaises(ValueError):
            self.ingest(observed="2026-10-01T15:30:00+05:30")
        with self.assertRaises(ValueError):
            self.ingest("2026-10-03", "2026-10-03T15:30:00+05:30")
        with self.assertRaises(ValueError):
            self.store.plan("2026-10-01", "2026-10-06")

    def test_errors_retry_unavailable_persists(self):
        self.store.record_attempt("TEST", "2026-10-02", "2026-10-06", "error")
        self.assertEqual(len(self.store.plan("2026-10-02", "2026-10-06")), 2)
        self.store.record_attempt("TEST", "2026-10-02", "2026-10-06", "unavailable", "not listed")
        self.assertEqual(len(self.store.plan("2026-10-02", "2026-10-06")), 1)
        reopened = OIHistoryStore(self.store.path)
        self.assertEqual(reopened.status()["attempts"], [{"status": "unavailable", "count": 1}])

    def test_error_limit_persists_and_leaves_other_dates_eligible(self):
        for attempt in range(1, 4):
            self.store.record_attempt("test", "2026-10-02", "2026-10-06", "error")
            self.store = OIHistoryStore(self.store.path)
            expected = 2 if attempt < 3 else 1
            self.assertEqual(len(self.store.plan("2026-10-02", "2026-10-06")), expected)
            self.assertEqual(self.store.candidate_count("2026-10-02", "2026-10-06"), expected)
        self.assertEqual(self.store.status()["retry_exhausted"], 1)
        self.assertEqual(self.store.candidate_plan("2026-10-02", "2026-10-06")[0]["day"], "2026-10-06")
        self.ingest()
        self.assertEqual(self.store.status()["retry_exhausted"], 0)

    def test_legacy_attempt_migration_counts_one_known_failure(self):
        with self.store.connect() as db:
            db.execute("DROP TABLE attempts")
            db.execute("CREATE TABLE attempts (symbol TEXT, day TEXT, expiry TEXT, status TEXT, reason TEXT, PRIMARY KEY(symbol,day,expiry))")
            db.execute("INSERT INTO attempts VALUES('TEST','2026-10-02','2026-10-06','error','fixture')")
            db.execute("PRAGMA user_version=4")
        reopened = OIHistoryStore(self.store.path)
        with reopened.connect() as db:
            self.assertEqual(db.execute("SELECT error_count FROM attempts").fetchone()[0], 1)
        reopened.record_attempt("TEST", "2026-10-02", "2026-10-06", "error")
        reopened.record_attempt("TEST", "2026-10-02", "2026-10-06", "error")
        self.assertEqual(reopened.candidate_count("2026-10-02", "2026-10-02"), 0)

    def test_greeks_full_fields_and_atomic_replacement(self):
        row = {"sp": 100, "cOI": 12, "pOI": 20, "cD": 0.5, "pD": -0.5,
               "cG": 0.02, "pG": 0.03, "cTh": -2, "pTh": -3,
               "cV": 4, "pV": 5, "cIV": 25, "pIV": 26, "futureField": "kept"}
        self.store.ingest("TEST", "2026-10-02", "2026-10-06",
                          "2026-10-02T15:30:00+05:30", {"uv": 100}, [row])
        with self.store.connect() as db:
            greek = db.execute("SELECT * FROM option_strikes").fetchone()
        self.assertEqual((greek["call_delta"], greek["put_delta"], greek["call_vega"]), (0.5, -0.5, 4))
        self.assertEqual(greek["fields"], "{}")
        raw = self.store.read_chain("TEST", "2026-10-02", "2026-10-06")
        self.assertEqual(raw["strikes"], [row])
        self.ingest()
        self.assertEqual(self.store.status()["strike_rows"], 2)

    def test_unknown_calendar_dates_are_only_candidates(self):
        self.assertEqual(len(self.store.candidate_plan("2026-10-01", "2026-10-06")), 2)
        self.store.set_expiries("TEST", [{"expiry": "2026-10-06", "first_date": "2026-10-01",
                                        "provider_id": "opaque"}], "fixture", replace=True)
        self.assertEqual(self.store.candidate_plan("2026-10-01", "2026-10-06")[0]["day"], "2026-10-01")
        self.assertIsNone(self.store.session_dte("2026-09-30", "2026-10-06"))


    def test_compression_and_requested_chain_only(self):
        self.ingest()
        with self.store.connect() as db:
            value = db.execute("SELECT payload FROM chains").fetchone()[0]
        self.assertIsInstance(value, bytes)
        self.assertEqual(self.store.read_chain("test", "2026-10-02", "2026-10-06")["snapshot"], {"uv": 105})
        self.assertIsNone(self.store.read_chain("TEST", "2026-10-01", "2026-10-06"))

    def test_legacy_migration_preserves_raw_and_rebuilds_missing_projections(self):
        self.ingest()
        self.ingest("2026-10-06", "2026-10-06T15:30:00+05:30")
        before = self.store.read_chain("TEST", "2026-10-02", "2026-10-06")
        before["snapshot"]["unknown"] = "retained"
        before["strikes"][0]["unknown"] = [1, 2, 3]
        with self.store.connect() as db:
            db.execute("PRAGMA user_version=3")
            db.execute("UPDATE chains SET payload=?", (json.dumps(before),))
            for row in before["strikes"]:
                db.execute("UPDATE option_strikes SET fields=? WHERE strike=?",
                           (json.dumps(row), row["sp"]))
            db.execute("DELETE FROM option_strikes WHERE day='2026-10-06'")
        migrate = OIHistoryStore._migrate_raw_storage
        with patch.object(OIHistoryStore, "_migrate_raw_storage",
                          lambda store: migrate(store, batch_size=1)):
            reopened = OIHistoryStore(self.store.path)
        self.assertEqual(reopened.read_chain("TEST", "2026-10-02", "2026-10-06"), before)
        self.assertEqual(reopened.status()["strike_rows"], 4)
        with reopened.connect() as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 5)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM option_strikes WHERE fields!='{}'").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM chains WHERE typeof(payload)!='blob'").fetchone()[0], 0)
        with patch.object(OIHistoryStore, "_migrate_raw_storage", side_effect=AssertionError("repeat migration")):
            OIHistoryStore(self.store.path)

    def test_migration_refuses_discarding_different_legacy_fields(self):
        self.ingest()
        raw = self.store.read_chain("TEST", "2026-10-02", "2026-10-06")
        with self.store.connect() as db:
            db.execute("PRAGMA user_version=3")
            db.execute("UPDATE chains SET payload=?", (json.dumps(raw),))
            db.execute("UPDATE option_strikes SET fields=?", ('{"extra":"preserve"}',))
        with self.assertRaisesRegex(ValueError, "differ"):
            OIHistoryStore(self.store.path)
        with self.store.connect() as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 3)
            self.assertEqual(db.execute("SELECT fields FROM option_strikes LIMIT 1").fetchone()[0], '{"extra":"preserve"}')

    def test_statistics_cache_expiry_copy_and_final_refresh(self):
        with patch("fno_analyzer.services.oi_history.monotonic", return_value=100) as clock:
            with patch.object(self.store, "status", wraps=self.store.status) as summary:
                first = self.store.cached_status()
                self.ingest()
                first["coverage"].append({"symbol": "MUTATED"})
                self.assertEqual(self.store.cached_status()["chains"], 0)
                self.assertEqual(summary.call_count, 1)
                clock.return_value = 131
                self.assertEqual(self.store.cached_status()["chains"], 1)
                self.assertEqual(summary.call_count, 2)
                self.store.invalidate_status()
                self.assertEqual(self.store.cached_status()["chains"], 1)
                self.assertEqual(summary.call_count, 3)

    def test_daily_planning_matches_holes_and_uses_date_index(self):
        self.ingest()
        self.store.set_expiries("NEW", [{"expiry": "2026-10-06", "first_date": "2026-10-01",
                                        "provider_id": "opaque"}], "fixture")
        self.store.record_attempt("NEW", "2026-10-01", "2026-10-06", "unavailable")
        self.store.record_attempt("TEST", "2026-10-06", "2026-10-06", "error")
        batches = list(self.store.iter_candidate_days("2026-10-01", "2026-10-06"))
        self.assertEqual([[r["symbol"] for r in batch] for batch in batches], [["NEW"], ["NEW", "TEST"]])
        self.assertEqual([batch[0]["day"] for batch in batches], ["2026-10-02", "2026-10-06"])
        self.assertEqual(self.store.candidate_count("2026-10-01", "2026-10-06"), 3)
        with self.store.connect() as db:
            plan = db.execute("EXPLAIN QUERY PLAN SELECT 1 FROM chains WHERE day=? LIMIT 1", ("2026-10-02",)).fetchall()
        self.assertIn("chains_day", str([tuple(r) for r in plan]))

    def test_interrupted_migration_resumes_committed_batches(self):
        self.ingest()
        self.ingest("2026-10-06", "2026-10-06T15:30:00+05:30")
        raw = self.store.read_chain("TEST", "2026-10-02", "2026-10-06")
        with self.store.connect() as db:
            db.execute("PRAGMA user_version=3")
            db.execute("UPDATE chains SET payload=?", (json.dumps(raw),))
            for row in raw["strikes"]:
                db.execute("UPDATE option_strikes SET fields=? WHERE strike=?", (json.dumps(row), row["sp"]))
        encode = self.store.encode_payload
        calls = []
        def interrupted(value):
            calls.append(value)
            if len(calls) == 2:
                raise RuntimeError("interrupted")
            return encode(value)
        with patch.object(self.store, "encode_payload", side_effect=interrupted):
            with self.assertRaisesRegex(RuntimeError, "interrupted"):
                self.store._migrate_raw_storage(batch_size=1)
        with self.store.connect() as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 3)
            self.assertEqual(db.execute("SELECT count(*) FROM chains WHERE typeof(payload)='blob'").fetchone()[0], 1)
        reopened = OIHistoryStore(self.store.path)
        self.assertEqual(reopened.read_chain("TEST", "2026-10-06", "2026-10-06"), raw)
        self.assertEqual(reopened.status()["chains"], 2)

    def test_offline_compaction_retains_backup_and_verifies_values(self):
        import importlib.util
        script = Path(__file__).resolve().parents[1] / "scripts" / "compact_oi_history.py"
        spec = importlib.util.spec_from_file_location("compact_history", script)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.ingest()
        backup = self.store.path.with_suffix(".sqlite3.backup")
        module.compact(self.store.path, backup)
        self.assertTrue(backup.is_file())
        self.assertEqual(self.store.status()["chains"], 1)
        with self.assertRaisesRegex(ValueError, "never overwritten"):
            module.compact(self.store.path, backup)
