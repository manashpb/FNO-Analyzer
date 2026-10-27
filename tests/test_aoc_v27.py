import sys
from pathlib import Path
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from fno_analyzer.providers.aoc import AocClient, parse_payload


class V27Tests(unittest.TestCase):
    def client(self, mode="v27"):
        return AocClient({"providers": {"aoc": {"api_mode": mode,
            "base_url": "https://legacy.invalid/api/v10", "token": "test"}},
            "server": {}, "cache": {}})

    def test_array_responses_and_routes(self):
        client = self.client()
        response = Mock(status_code=200)
        response.json.return_value = [{"Name": "NIFTY", "Lot": 65}]
        client.session.get = Mock(return_value=response)
        self.assertEqual(client.get_tickers()[0]["Lot"], 65)
        self.assertEqual(client.session.get.call_args.args[0],
                         "https://v27.aoccalculator.in/api/v27/get-tickers")
        response.json.return_value = ["13-Oct-2026"]
        self.assertEqual(client._request("expiries", {"ticker": "NIFTY"}),
                         {"data": ["13-Oct-2026"]})

    def test_live_and_legacy_routing(self):
        for mode, base in [("v27", "https://v27.aoccalculator.in/api/v27"),
                           ("legacy", "https://legacy.invalid/api/v10")]:
            client = self.client(mode)
            response = Mock(status_code=200)
            response.json.return_value = {}
            client.session.get = Mock(return_value=response)
            client.fetch_live("NIFTY")
            self.assertEqual(client.session.get.call_args.args[0], base + "/live-data")
            self.assertEqual(client.session.get.call_args.kwargs["params"]["symbol"], "NIFTY")
            client._request("historical", {})
            self.assertEqual(client.session.get.call_args.args[0],
                             (base if mode == "v27" else "https://api.niftychain.in/api/v10") + "/historical-data")

    def test_sector_routes_and_normalization(self):
        for mode, base in [("v27", "https://v27.aoccalculator.in/api/v27"),
                           ("legacy", "https://legacy.invalid/api/v10")]:
            client = self.client(mode)
            response = Mock(status_code=200)
            sectors = {"sectorId": [1], "symbol": ["IT"], "ts": 123}
            response.json.return_value = sectors if mode == "v27" else {"data": sectors}
            client.session.get = Mock(return_value=response)
            self.assertEqual(client.fetch_sectors(), {"data": sectors})
            self.assertEqual(client.session.get.call_args.args[0], base + "/sectorial-data-compact")
            components = {"symbol": ["TCS", "INFY"], "sid": [1, 2], "ltp": [100, 200]}
            response.json.return_value = components if mode == "v27" else {"data": components}
            result = client._request("sector_components", {"sectorId": 1})
            client._get = Mock(return_value=result)
            self.assertEqual([row["symbol"] for row in client.fetch_sector_components(1)["components"]], ["TCS", "INFY"])
            self.assertEqual(client.session.get.call_args.args[0], base + "/sectorial-components-compact")

    def test_intraday_route_and_timestamp_alignment(self):
        client = self.client()
        response = Mock(status_code=200)
        response.json.return_value = [
            {"symbol": "IT", "displaySymbol": "IT", "data": [
                {"timestamp": 2000, "lastTradedPrice": 20, "percentChange": 0},
                {"timestamp": 1000, "lastTradedPrice": 10, "percentChange": -1}]},
            {"symbol": "BANK", "data": [
                {"timestamp": 2000, "lastTradedPrice": 30, "percentChange": 2}]}]
        client.session.get = Mock(return_value=response)
        payload = client.fetch_sector_intraday(1000, 2000, 1)
        self.assertEqual(client.session.get.call_args.args[0],
                         "https://v27.aoccalculator.in/api/v27/sectorial-intraday")
        self.assertEqual(client.session.get.call_args.kwargs["params"],
                         {"startTime": 1000, "endTime": 2000, "interval": 1})
        self.assertEqual(payload["data"][0]["ts"], [1000, 2000])
        self.assertEqual(payload["data"][0]["pchg"], [-1, 0])
        self.assertEqual(payload["data"][1]["ltp"], [None, 30])
        self.assertEqual(payload["data"][1]["pchg"], [None, 2])

    def test_intraday_empty_and_malformed_response(self):
        from fno_analyzer.errors import ProviderError
        client = self.client()
        client._get = Mock(return_value={"data": []})
        self.assertEqual(client.fetch_sector_intraday(1, 2, 1), {"data": []})
        for data in ({}, [None], [{"data": {}}], [{"data": [{"timestamp": "bad"}]}]):
            client._get.return_value = {"data": data}
            with self.assertRaises(ProviderError):
                client.fetch_sector_intraday(1, 2, 1)

    def test_legacy_intraday_is_preserved(self):
        client = self.client("legacy")
        response = Mock(status_code=200)
        response.json.return_value = {"data": [{"symbol": "IT", "ts": [1], "ltp": [10], "pchg": [0]}]}
        client.session.get = Mock(return_value=response)
        self.assertEqual(client.fetch_sector_intraday(1, 2, 1), response.json.return_value)
        self.assertEqual(client.session.get.call_args.args[0],
                         "https://legacy.invalid/api/v10/sectorial-intraday-compact")

    def test_unwrapped_chain_matches_legacy(self):
        chain = {"snapshot": {"k": ["s", "uv"], "v": ["nifty", 22571.45]},
                 "strikes": {"k": ["sp", "cOI", "pOI"], "v": [[22550, 100, 200]]}}
        self.assertEqual(parse_payload(chain), parse_payload({"data": chain}))
        self.assertEqual(parse_payload(chain)["strikes"][0]["pOI"], 200)


if __name__ == "__main__":
    unittest.main()
