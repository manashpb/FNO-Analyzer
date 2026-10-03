import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from fno_analyzer.application import Application
from fno_analyzer.config import load_settings
from fno_analyzer.errors import ConfigurationError
from fno_analyzer.providers.aoc import AocClient, parse_payload
from fno_analyzer.providers.dhan import (
    DhanClient,
    expiry_ids,
    format_expiry,
    latest_ivp_ivr,
    normalize_dhan_chain,
)
from fno_analyzer.services.metrics import compute_metrics
from fno_analyzer.services.symbol_map import load_map, save_map


class ConfigTests(unittest.TestCase):
    def test_environment_overrides_secret_and_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "config.json"
            config_path.write_text(json.dumps({"providers": {"aoc": {}, "dhan": {}}}), encoding="utf-8")
            with patch.dict("os.environ", {
                "FNO_AOC_TOKEN": "aoc-test",
                "FNO_DHAN_JWT": "jwt-test",
                "FNO_DHAN_ENTITY_ID": "entity-test",
                "FNO_DATA_DIR": str(Path(directory) / "runtime"),
            }, clear=False):
                settings = load_settings(config_path)
            self.assertEqual(settings["providers"]["aoc"]["token"], "aoc-test")
            self.assertEqual(settings["providers"]["dhan"]["jwt"], "jwt-test")
            self.assertEqual(settings["providers"]["dhan"]["entity_id"], "entity-test")
            self.assertEqual(settings["data_path"], str((Path(directory) / "runtime").resolve()))


class AocTests(unittest.TestCase):
    def test_compact_payload_is_parsed_by_column_name(self):
        payload = {
            "data": {
                "snapshot": {"k": ["s", "uv", "exp"], "v": ["NIFTY", "24500.5", "29-Sep-2026"]},
                "strikes": {"k": ["sp", "cIV", "name"], "v": [[24500, 14.2, "NIFTY CALL"]]},
            }
        }
        result = parse_payload(payload)
        self.assertEqual(result["snapshot"]["s"], "NIFTY")
        self.assertEqual(result["snapshot"]["uv"], 24500.5)
        self.assertEqual(result["strikes"][0]["cIV"], 14.2)
        self.assertEqual(result["strikes"][0]["name"], "NIFTY CALL")

    def test_sector_components_are_transposed_for_the_browser(self):
        client = AocClient({
            "providers": {"aoc": {"base_url": "https://example.invalid", "token": "token"}},
            "server": {"request_timeout_seconds": 30},
            "cache": {"ticker_ttl_seconds": 0},
        })
        client._get = lambda endpoint, params: {"data": {
            "ts": 1,
            "sid": [10, 11],
            "symbol": ["AAA", "BBB"],
            "ltp": [100, 200],
            "chg": [1, -2],
            "pchg": [1.1, -0.9],
            "wt": [4, 5],
        }}
        result = client.fetch_sector_components(33)
        self.assertEqual(result["sectorId"], 33)
        self.assertEqual(result["components"][1]["symbol"], "BBB")
        self.assertEqual(result["components"][1]["wt"], 5)


class DhanTests(unittest.TestCase):
    def test_normalization_keeps_iv_rows_and_full_totals(self):
        payload = {
            "oc": {
                "100": {"ce": {"OI": 10, "oichng": 2, "vol": 3, "ltp": 20, "iv": 12}, "pe": {"OI": 5, "vol": 4, "ltp": 2, "iv": 13}},
                "200": {"ce": {"iv": 15}},
                "300": {"ce": {"OI": 100, "oichng": 50, "vol": 60, "ltp": 1, "iv": 20}},
            },
            "sltp": 150,
            "SChng": 4,
            "explst": [1475087400],
            "fl": {"1475087400": {"ltp": 25100, "pc": 25050}},
        }
        result = normalize_dhan_chain(payload, "NIFTY", max_strikes=1)
        self.assertEqual(result["coverage"]["raw_strike_count"], 3)
        self.assertEqual(result["coverage"]["returned_strike_count"], 1)
        self.assertTrue(result["coverage"]["is_truncated"])
        self.assertEqual(result["snapshot"]["tOICe"], 110)
        self.assertEqual(result["snapshot"]["tOIPe"], 5)
        self.assertEqual(result["snapshot"]["mOiCe"], 300)
        self.assertEqual(result["snapshot"]["fpc"], 50)
        self.assertEqual(result["strikes"][0]["sp"], 100)
        self.assertEqual(len(result["_all_strikes"]), 3)

    def test_headers_keep_authorisation_literal_and_separate_jwt(self):
        settings = {
            "providers": {"dhan": {"jwt": "jwt", "authorisation": "Token"}},
            "server": {"request_timeout_seconds": 30},
        }
        client = DhanClient(settings)
        headers = client._headers()
        self.assertEqual(headers["authorisation"], "Token")
        self.assertEqual(headers["auth"], "jwt")

    def test_expiry_parser_accepts_grouped_and_direct_lists(self):
        self.assertEqual(expiry_ids({"data": {"exps": [{"inst": "OPTIDX", "explst": [{"expdatej": 2}, {"expdatej": 1}]}]}}), [1, 2])
        self.assertEqual(expiry_ids({"data": {"explst": [{"expdatej": 3}]}}), [3])

    def test_expiry_format_uses_ist(self):
        self.assertIsNotNone(format_expiry(1790620200))

    def test_latest_ivp_ivr_uses_newest_date_not_trailing_padding(self):
        data = {
            "date": ["25-Sep-2026", "24-Sep-2026", "23-Sep-2026"],
            "ivp": [45.93, 53.73, 0],
            "ivr": [29.66, 35.79, 0],
            "iv": [18.4, 19.1, 0],
            "spotPrice": [1287.3, 1280.0, 0],
        }
        self.assertEqual(
            latest_ivp_ivr(data),
            {
                "date": "25-Sep-2026",
                "ivp": 45.93,
                "ivr": 29.66,
                "iv": 18.4,
                "spotPrice": 1287.3,
            },
        )


class MetricsTests(unittest.TestCase):
    def test_metrics_use_all_chain_rows(self):
        snapshot = {
            "s": "TEST",
            "uv": 100,
            "exp": "29-Sep-2026",
            "tOICe": 100,
            "tOIPe": 200,
            "tOICCe": 10,
            "tOICPe": 20,
            "tVolCe": 30,
            "tVolPe": 40,
            "mOiCe": 100,
            "mOiPe": 90,
        }
        strikes = [
            {"sp": 90, "cOI": 10, "pOI": 20, "cIV": 11, "pIV": 12},
            {"sp": 100, "cOI": 90, "pOI": 180, "cVol": 25, "pVol": 35, "cIV": 13, "pIV": 15, "cOIC": 5, "pOIC": 7},
        ]
        result = compute_metrics(snapshot, strikes)
        self.assertEqual(result["atm_strike"], 100)
        self.assertEqual(result["atm_iv_ce"], 13)
        self.assertEqual(result["iv_skew"], 2)
        self.assertEqual(result["max_pain"], 100)
        self.assertEqual(result["top_volume"][0]["strike"], 100)


class MapTests(unittest.TestCase):
    def test_map_save_and_load(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "nested" / "dhan_map.json"
            value = {"mapped": [{"aoc": "NIFTY", "seg": 0, "sid": 13}], "unmapped": []}
            save_map(path, value)
            self.assertEqual(load_map(path), value)


class ApplicationTests(unittest.TestCase):
    def test_health_does_not_require_provider_credentials(self):
        settings = {
            "providers": {"aoc": {"base_url": "", "token": ""}, "dhan": {"jwt": ""}},
            "server": {"request_timeout_seconds": 30, "refresh_seconds": 15},
            "cache": {"chain_ttl_seconds": 6, "ticker_ttl_seconds": 0},
            "chain": {"max_strikes": 100},
            "public": {"base_url": ""},
        }
        application = Application(settings)
        result, status = application.dispatch("/api/health", {})
        self.assertEqual(status, 200)
        self.assertEqual(result["status"], "ok")
        with self.assertRaises(ConfigurationError):
            application.dispatch("/api/ready", {})


if __name__ == "__main__":
    unittest.main()
