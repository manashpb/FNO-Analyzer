import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from fno_analyzer.application import Application
from fno_analyzer.errors import ProviderError


class LiveSourcesTests(unittest.TestCase):
    def app(self):
        app = Application.__new__(Application)
        app.settings = {"map_path": "unused"}
        app.aoc = Mock()
        app._entry = Mock(return_value={"aoc": "NIFTY"})
        app._dhan_result = Mock(return_value={"strikes": [{"sp": 100}]})
        app._aoc_result = Mock(return_value={"strikes": [{"sp": 200}]})
        return app

    def test_dhan_success_never_calls_aoc(self):
        app = self.app()
        result, status = app.dispatch("/api/live", {"ticker": ["NIFTY"]})
        self.assertEqual((status, result["source"]), (200, "dhan"))
        app.aoc.fetch_live.assert_not_called()

    def test_error_or_empty_chain_uses_backup(self):
        for empty in (False, True):
            app = self.app()
            if empty:
                app._dhan_result.return_value = {"strikes": []}
            else:
                app._dhan_result.side_effect = ProviderError("Unavailable", provider="dhan")
            result, status = app.dispatch("/api/live", {"ticker": ["NIFTY"]})
            self.assertEqual((status, result["source"]), (200, "aoc"))
            app.aoc.fetch_live.assert_called_once_with("NIFTY")
            self.assertIn("fallback_reason", result)

    def test_startup_tickers_do_not_require_aoc(self):
        app = self.app()
        with patch("fno_analyzer.application.load_map", return_value={"mapped": [{"aoc": "NIFTY"}]}):
            result, status = app.dispatch("/api/live/tickers", {})
        self.assertEqual(result["tickers"][0]["Name"], "NIFTY")
        app.aoc.get_tickers.assert_not_called()

    def test_both_fail_exposes_both_provider_errors(self):
        app = self.app()
        app._dhan_result.side_effect = ProviderError("Dhan unavailable")
        app.aoc.fetch_live.side_effect = ProviderError("AOC unavailable")
        with self.assertRaisesRegex(ProviderError, "Dhan:.*AOC backup:"):
            app.dispatch("/api/live", {"ticker": ["NIFTY"]})
