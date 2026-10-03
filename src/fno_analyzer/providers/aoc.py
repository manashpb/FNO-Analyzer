import time
from typing import Any

import requests

from ..errors import ConfigurationError, ProviderAuthError, ProviderError, UpstreamNotFound, UpstreamTimeout


ENDPOINTS = {
    "tickers": "get-tickers",
    "expiries": "get-expiry-dates",
    "live": "live-data",
    "historical": "historical-data",
    "sectors": "sectorial-data-compact",
    "sector_intraday": "sectorial-intraday-compact",
    "sector_components": "sectorial-components-compact",
}


def number(value: Any) -> Any:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(value)
    except (TypeError, ValueError):
        return value


def kv_to_dict(keys: list[str], values: list[Any]) -> dict[str, Any]:
    return {key: number(value) for key, value in zip(keys, values)}


def parse_payload(payload: dict[str, Any]) -> dict[str, Any]:
    data = payload.get("data") or {}
    snapshot: dict[str, Any] = {}
    strikes: list[dict[str, Any]] = []
    snapshot_data = data.get("snapshot") or {}
    strikes_data = data.get("strikes") or {}
    if isinstance(snapshot_data, dict) and snapshot_data.get("k") is not None:
        snapshot = kv_to_dict(snapshot_data.get("k") or [], snapshot_data.get("v") or [])
    if isinstance(strikes_data, dict) and strikes_data.get("k") is not None:
        keys = strikes_data.get("k") or []
        strikes = [kv_to_dict(keys, row) for row in strikes_data.get("v") or []]
    return {
        "snapshot": snapshot,
        "strikes": strikes,
        "statusCode": payload.get("statusCode"),
        "message": payload.get("message"),
    }


class AocClient:
    name = "aoc"

    def __init__(self, settings: dict[str, Any]):
        config = settings["providers"]["aoc"]
        self.base_url = str(config.get("base_url", "")).rstrip("/")
        self.token = str(config.get("token") or "")
        self.timeout = float(settings["server"].get("request_timeout_seconds", 30))
        self.cache_ttl = float(settings["cache"].get("ticker_ttl_seconds", 21600))
        self.session = requests.Session()
        if self.token:
            self.session.headers["Authorization"] = f"Bearer {self.token}"
        self._tickers: list[dict[str, Any]] | None = None
        self._tickers_at = 0.0

    @property
    def configured(self) -> bool:
        return bool(self.token and self.base_url)

    def _url(self, endpoint: str) -> str:
        return f"{self.base_url}/{ENDPOINTS[endpoint]}"

    def _get(self, endpoint: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        if not self.configured:
            raise ConfigurationError(
                "AOC is not configured; set providers.aoc.token or FNO_AOC_TOKEN",
                provider=self.name,
            )
        url = self._url(endpoint)
        try:
            response = self.session.get(url, params=params, timeout=self.timeout)
        except requests.Timeout as exc:
            raise UpstreamTimeout(self.name, "AOC request timed out") from exc
        except requests.RequestException as exc:
            raise ProviderError("AOC request failed", provider=self.name) from exc
        if response.status_code in (401, 403):
            raise ProviderAuthError(self.name, "AOC authentication failed; refresh the AOC token")
        if response.status_code == 404:
            raise UpstreamNotFound(self.name, "AOC resource was not found")
        if not 200 <= response.status_code < 300:
            raise ProviderError(f"AOC returned HTTP {response.status_code}", provider=self.name)
        try:
            payload = response.json()
        except ValueError as exc:
            raise ProviderError("AOC returned invalid JSON", provider=self.name) from exc
        if not isinstance(payload, dict):
            raise ProviderError("AOC returned an invalid response", provider=self.name)
        status = payload.get("statusCode")
        if status not in (None, 200):
            message = str(payload.get("message") or "AOC request was rejected")
            raise ProviderError(message[:240], code="AOC_STATUS_ERROR", provider=self.name)
        return payload

    def get_tickers(self, force: bool = False) -> list[dict[str, Any]]:
        if not force and self._tickers is not None and time.monotonic() - self._tickers_at < self.cache_ttl:
            return self._tickers
        payload = self._get("tickers")
        tickers = payload.get("data") or []
        if not isinstance(tickers, list):
            raise ProviderError("AOC ticker response was invalid", provider=self.name)
        tickers = [item for item in tickers if isinstance(item, dict)]
        tickers.sort(
            key=lambda item: (
                0 if item.get("Fav") else 1,
                str(item.get("disp") or item.get("Name") or "").lower(),
            )
        )
        self._tickers = tickers
        self._tickers_at = time.monotonic()
        return tickers

    def get_expiries(self, ticker: str) -> list[str]:
        payload = self._get("expiries", {"ticker": ticker})
        values = payload.get("data") or []
        return [str(value) for value in values] if isinstance(values, list) else []

    def fetch_live(self, ticker: str) -> dict[str, Any]:
        return self._get("live", {"symbol": ticker, "cacheBust": int(time.time() * 1000)})

    def fetch_historical(self, ticker: str, expiry: str, timestamp_ms: int) -> dict[str, Any]:
        return self._get("historical", {"ticker": ticker, "expiry": expiry, "timestamp": int(timestamp_ms)})

    def fetch_sectors(self) -> dict[str, Any]:
        return self._get("sectors")

    def fetch_sector_intraday(self, start_ms: int, end_ms: int, interval: int) -> dict[str, Any]:
        return self._get(
            "sector_intraday",
            {"startTime": int(start_ms), "endTime": int(end_ms), "interval": int(interval)},
        )

    def fetch_sector_components(self, sector_id: int) -> dict[str, Any]:
        payload = self._get("sector_components", {"sectorId": int(sector_id)})
        data = payload.get("data") or {}
        if not isinstance(data, dict):
            return {"ts": None, "sectorId": int(sector_id), "components": []}

        def column(name: str) -> list[Any]:
            values = data.get(name) or []
            return values if isinstance(values, list) else [values]

        symbols = column("symbol")
        components = []
        for index, symbol in enumerate(symbols):
            components.append(
                {
                    "sid": column("sid")[index] if index < len(column("sid")) else None,
                    "symbol": symbol,
                    "ltp": column("ltp")[index] if index < len(column("ltp")) else None,
                    "chg": column("chg")[index] if index < len(column("chg")) else None,
                    "pchg": column("pchg")[index] if index < len(column("pchg")) else None,
                    "wt": column("wt")[index] if index < len(column("wt")) else None,
                }
            )
        return {"ts": data.get("ts"), "sectorId": int(sector_id), "components": components}
