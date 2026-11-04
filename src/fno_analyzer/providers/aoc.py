import time
import math
import os
from pathlib import Path
from threading import Lock
from datetime import datetime, timezone, timedelta, time as clock_time
from zoneinfo import ZoneInfo
from email.utils import parsedate_to_datetime
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

V27_SERVERS = ("https://v27.aoccalculator.in/api/v27", "https://v27.niftychain.in/api/v27")


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
    data = payload.get("data") if "data" in payload else payload
    data = data or {}
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
        self.api_mode = str(config.get("api_mode", "legacy"))
        self.v27_base_url = str(config.get("v27_base_url", "https://v27.aoccalculator.in/api/v27")).rstrip("/")
        # Only share credentials between the two official mirrors. Custom URLs stay isolated.
        self._v27_servers = [self.v27_base_url]
        if self.v27_base_url in V27_SERVERS:
            self._v27_servers += [url for url in V27_SERVERS if url != self.v27_base_url]
        self._active_server = self.v27_base_url
        self._failed_servers: dict[str, float] = {}
        self.token = str(config.get("token") or "")
        self.backtester_only = os.getenv("FNO_AOC_BACKTESTER_ONLY", "1") != "0"
        self.pause_file = Path(os.getenv("FNO_AOC_PAUSE_FILE", str(Path(__file__).resolve().parents[3] / "AOC_PAUSED")))
        self.timeout = float(settings["server"].get("request_timeout_seconds", 30))
        self.cache_ttl = float(settings["cache"].get("ticker_ttl_seconds", 21600))
        self.session = requests.Session()
        if self.token:
            self.session.headers["Authorization"] = f"Bearer {self.token}"
        if self.api_mode == "v27":
            self.session.headers.update({"Accept": "application/json", "Origin": "https://aoccalculator.in",
                                         "Referer": "https://aoccalculator.in/"})
        self._tickers: list[dict[str, Any]] | None = None
        self._tickers_at = 0.0
        self._request_lock = Lock()
        self._last_request = 0.0
        self._cooldown_until = 0.0
        self.request_interval = max(1.0, float(config.get("request_interval_seconds", 2)))
        self.history_base_url = str(config.get("history_base_url", "https://api.niftychain.in/api/v10")).rstrip("/")

    @property
    def configured(self) -> bool:
        return bool(self.token and self.base_url and not self.pause_file.exists())

    def _check_paused(self):
        if self.pause_file.exists():
            raise ProviderError("AOC requests are paused by the administrator", code="AOC_PAUSED",
                                provider=self.name, retryable=False)

    def _url(self, endpoint: str) -> str:
        return f"{self.base_url}/{ENDPOINTS[endpoint]}"

    def _get(self, endpoint: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        self._check_paused()
        if self.backtester_only:
            if endpoint not in ("tickers", "expiries", "historical"):
                raise ProviderError("AOC account supports backtester only", code="AOC_BACKTESTER_ONLY", provider=self.name)
            if endpoint == "historical":
                now = datetime.now(ZoneInfo("Asia/Kolkata"))
                requested = datetime.fromtimestamp(float((params or {}).get("timestamp", 0)) / 1000, now.tzinfo)
                allowed = requested <= now - timedelta(hours=8)
                if now.time() >= clock_time(17) and requested.date() == now.date() and requested <= now:
                    allowed = True
                if not allowed:
                    raise ProviderError("AOC history requires an eight-hour delay; today's close is available after 17:00 IST", code="AOC_HISTORY_DELAY", provider=self.name)
        with self._request_lock:
            if time.monotonic() < self._cooldown_until:
                raise ProviderError("AOC rate-limit cooldown is active", code="AOC_RATE_LIMIT", provider=self.name)
            time.sleep(max(0, self.request_interval - (time.monotonic() - self._last_request)))
            self._last_request = time.monotonic()
            return self._request(endpoint, params)

    def _request(self, endpoint: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        self._check_paused()
        if not self.configured:
            raise ConfigurationError(
                "AOC is not configured; set providers.aoc.token or FNO_AOC_TOKEN",
                provider=self.name,
            )
        name = "sectorial-intraday" if self.api_mode == "v27" and endpoint == "sector_intraday" else ENDPOINTS[endpoint]
        url = (f"{self.v27_base_url}/{name}"
               if self.api_mode == "v27" else
               f"{self.history_base_url}/{ENDPOINTS[endpoint]}"
               if endpoint in ("historical", "expiries") else self._url(endpoint))
        if self.api_mode == "v27":
            response = self._v27_get(name, params)
        else:
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
        if response.status_code == 429:
            retry = response.headers.get("Retry-After", "60")
            try:
                seconds = float(retry)
            except (TypeError, ValueError):
                try:
                    seconds = (parsedate_to_datetime(retry) - datetime.now(timezone.utc)).total_seconds()
                except (TypeError, ValueError, OverflowError):
                    seconds = 60
            self._cooldown_until = time.monotonic() + max(60, seconds)
            raise ProviderError("AOC rate limit reached; update stopped", code="AOC_RATE_LIMIT", provider=self.name)
        if not 200 <= response.status_code < 300:
            raise ProviderError(f"AOC returned HTTP {response.status_code}", provider=self.name)
        try:
            payload = response.json()
        except ValueError as exc:
            raise ProviderError("AOC returned invalid JSON", provider=self.name) from exc
        if isinstance(payload, list) and endpoint in ("tickers", "expiries", "sector_intraday"):
            payload = {"data": payload}
        if not isinstance(payload, dict):
            raise ProviderError("AOC returned an invalid response", provider=self.name)
        status = payload.get("statusCode")
        if status not in (None, 200):
            message = str(payload.get("message") or "AOC request was rejected")
            raise ProviderError(message[:240], code="AOC_STATUS_ERROR", provider=self.name)
        return payload

    def _v27_get(self, name: str, params: dict[str, Any] | None):
        servers = [self._active_server] + [s for s in self._v27_servers if s != self._active_server]
        available = [s for s in servers if self._failed_servers.get(s, 0) <= time.monotonic()]
        if not available:
            raise ProviderError("AOC servers temporarily unavailable; retry shortly", provider=self.name)
        for index, server in enumerate(available):
            if index:
                time.sleep(max(0, self.request_interval - (time.monotonic() - self._last_request)))
            self._last_request = time.monotonic()
            self._check_paused()
            try:
                response = self.session.get(f"{server}/{name}", params=params,
                                            timeout=(min(5.0, self.timeout), self.timeout))
            except requests.RequestException as exc:
                self._failed_servers[server] = time.monotonic() + 300
                if index + 1 < len(available):
                    continue
                if isinstance(exc, requests.Timeout):
                    raise UpstreamTimeout(self.name, "AOC servers timed out") from exc
                raise ProviderError("AOC servers could not be reached", provider=self.name) from exc
            if response.status_code >= 500:
                self._failed_servers[server] = time.monotonic() + 300
                if index + 1 < len(available):
                    continue
            else:
                self._active_server = server
                self._failed_servers.pop(server, None)
            return response

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
        payload = self._get("sectors")
        return payload if "data" in payload else {"data": payload}

    def fetch_sector_intraday(self, start_ms: int, end_ms: int, interval: int) -> dict[str, Any]:
        payload = self._get(
            "sector_intraday",
            {"startTime": int(start_ms), "endTime": int(end_ms), "interval": int(interval)},
        )
        if self.api_mode != "v27":
            return payload
        sectors = payload.get("data")
        if not isinstance(sectors, list):
            raise ProviderError("AOC sector intraday response was invalid", provider=self.name)
        # Every sector must use the same timeline expected by the chart API.
        # Join by timestamp rather than position: sectors can have missing bars.
        rows = []
        timestamps = set()
        for sector in sectors:
            if not isinstance(sector, dict) or not isinstance(sector.get("data"), list):
                raise ProviderError("AOC sector intraday series was invalid", provider=self.name)
            points = {}
            for point in sector["data"]:
                if not isinstance(point, dict):
                    raise ProviderError("AOC sector intraday point was invalid", provider=self.name)
                stamp = point.get("timestamp")
                if isinstance(stamp, bool) or not isinstance(stamp, (int, float)) or not math.isfinite(stamp):
                    raise ProviderError("AOC sector intraday timestamp was invalid", provider=self.name)
                points[stamp] = point
            timestamps.update(points)
            rows.append((sector, points))
        timeline = sorted(timestamps)
        return {"data": [{"symbol": sector.get("symbol"),
                          "displaySymbol": sector.get("displaySymbol"),
                          "ts": timeline,
                          "ltp": [points.get(stamp, {}).get("lastTradedPrice") for stamp in timeline],
                          "pchg": [points.get(stamp, {}).get("percentChange") for stamp in timeline]}
                         for sector, points in rows]}

    def fetch_sector_components(self, sector_id: int) -> dict[str, Any]:
        payload = self._get("sector_components", {"sectorId": int(sector_id)})
        data = payload.get("data", payload) or {}
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
