from datetime import datetime
from pathlib import Path
from threading import Lock
from typing import Any
from zoneinfo import ZoneInfo

from .cache import TTLCache
from .errors import AppError, ConfigurationError, InvalidParameter, ProviderError
from .providers.aoc import AocClient, parse_payload
from .providers.dhan import (
    DhanClient,
    EXPDATEJ_OFFSET,
    expiry_ids,
    format_expiry,
    latest_ivp_ivr,
    normalize_dhan_chain,
)
from .services.metrics import compute_metrics
from .services.scanners import IVScanner
from .services.oi_history import OIHistoryStore
from .services.oi_downloader import OIHistoryUpdater
from .services.oi_zscore import OIZScoreService
from .services.oi_levels import OILevelsScanner
from .services.symbol_map import build_symbol_map, load_map, lookup_map, save_map

IST = ZoneInfo("Asia/Kolkata")


class Application:
    def __init__(self, settings: dict[str, Any]):
        self.settings = settings
        self.aoc = AocClient(settings)
        self.dhan = DhanClient(settings)
        self.iv_scanner = IVScanner(self.dhan)
        self.oi_history = OIHistoryUpdater(self.aoc,
            OIHistoryStore(Path(settings["data_path"]) / "oi_history.sqlite3"), settings["map_path"], self.dhan)
        self.oi_zscore = OIZScoreService(self.oi_history.store)
        self.oi_levels = OILevelsScanner(self.oi_history.store)
        self.chain_cache = TTLCache(settings["cache"].get("chain_ttl_seconds", 6))
        self.map_lock = Lock()

    def ticker_meta(self, name: str, fallback: str | None = None) -> dict[str, Any] | None:
        query = name.upper()
        if fallback is not None:
            return next((dict(t) for t in (self.aoc._tickers or [])
                         if str(t.get("Name") or "").upper() == query),
                        {"Name": query, "disp": fallback})
        try:
            for ticker in self.aoc.get_tickers():
                if str(ticker.get("Name") or "").upper() == query:
                    return ticker
        except AppError:
            if fallback is None:
                raise
            return {"Name": query, "disp": fallback}
        if fallback is not None:
            return {"Name": query, "disp": fallback}
        return None

    def _aoc_result(self, payload: dict[str, Any], ticker: str) -> dict[str, Any]:
        data = parse_payload(payload)
        return {
            "snapshot": data["snapshot"],
            "strikes": data["strikes"],
            "metrics": compute_metrics(data["snapshot"], data["strikes"]),
            "oi_zscore": self.oi_zscore.live(ticker, data["snapshot"], data["strikes"]),
            "ticker": self.ticker_meta(ticker),
        }

    def _dhan_chain_data(self, entry: dict[str, Any], expiry: int = -1) -> dict[str, Any]:
        seg = int(entry["seg"])
        sid = int(entry["sid"])
        key = (seg, sid, int(expiry))
        chain = self.chain_cache.get(key)
        if chain is None:
            raw = self.dhan.option_chain(seg, sid, expiry)
            chain = normalize_dhan_chain(raw, str(entry.get("aoc") or ""), self.settings["chain"]["max_strikes"])
            self.chain_cache.set(key, chain)
        return chain

    def _dhan_result(self, entry: dict[str, Any]) -> dict[str, Any]:
        chain = self._dhan_chain_data(entry)
        all_strikes = chain.get("_all_strikes") or chain.get("strikes") or []
        return {
            "snapshot": chain["snapshot"],
            "strikes": chain["strikes"],
            "metrics": compute_metrics(chain["snapshot"], all_strikes),
            "oi_zscore": self.oi_zscore.live(str(entry.get("aoc") or ""), chain["snapshot"], all_strikes),
            "coverage": chain.get("coverage", {}),
            "ticker": next((dict(t) for t in (self.aoc._tickers or [])
                            if t.get("Name") == entry.get("aoc")),
                           {"Name": entry.get("aoc"), "disp": entry.get("disp") or entry.get("aoc")}),
            "dhan": {
                "sid": int(entry["sid"]),
                "seg": int(entry["seg"]),
                "disp": entry.get("disp"),
            },
        }

    def _entry(self, ticker: str) -> dict[str, Any]:
        entry = lookup_map(self.settings["map_path"], ticker)
        if entry is None:
            raise InvalidParameter(
                f"{ticker.upper()} is not mapped for Dhan",
                code="UNMAPPED_SYMBOL",
            )
        return entry

    def dhan_map(self, refresh: bool = False) -> dict[str, Any]:
        with self.map_lock:
            value = None if refresh else load_map(self.settings["map_path"])
            if value is None:
                value = build_symbol_map(self.dhan, self.aoc.get_tickers(), self.dhan.segment_map)
                save_map(self.settings["map_path"], value)
            return value

    def intraday_window(self) -> tuple[int, int]:
        now = datetime.now(IST)
        start = now.replace(hour=9, minute=0, second=0, microsecond=0)
        start_ms = int(start.timestamp() * 1000)
        end_ms = max(start_ms, int(now.timestamp() * 1000))
        return start_ms, end_ms

    def dispatch(self, path: str, query: dict[str, list[str]]) -> tuple[dict[str, Any], int]:
        if path == "/api/scanners/oi-levels/run":
            def optional(name, default):
                value = self._value(query, name, default)
                return None if value == "off" else float(value)
            return self.oi_levels.scan(
                self._value(query, "direction", "bullish"),
                optional("distance", "2"), optional("gap", "2"),
                optional("second", "50"), int(self._value(query, "days", "0"))), 200
        if path == "/api/scanners/oi-zscore/update":
            with self.oi_history.lock:
                if self.oi_history.state["status"] == "running":
                    raise AppError("Finish or cancel Data update before updating Z-scores", code="ARCHIVE_BUSY", status=409)
            return self.oi_zscore.start(), 200
        if path == "/api/scanners/oi-zscore/status":
            return self.oi_zscore.snapshot(), 200
        if path == "/api/history/oi/zscore-cycle":
            return self.oi_zscore.cycle(self._ticker(query), self._value(query, "expiry", "")), 200
        if path == "/api/history/oi/start":
            with self.oi_zscore.lock:
                if self.oi_zscore.state['status'] == 'running':
                    raise AppError("Finish the Z-score update before Data update", code="ZSCORE_BUSY", status=409)
            return self.oi_history.start(), 200
        if path == "/api/history/oi/heatmap":
            return self.oi_history.store.heatmap(self._ticker(query), self._value(query, "expiry", "")), 200
        if path == "/api/history/oi/status":
            return self.oi_history.snapshot(), 200
        if path == "/api/history/oi/cancel":
            return self.oi_history.cancel(self._value(query, "id")), 200
        if path == "/api/scanners/iv/start":
            falling = self._value(query, "falling", "true").lower()
            rising = self._value(query, "rising", "true").lower()
            if falling not in ("true", "false") or rising not in ("true", "false"):
                raise InvalidParameter("Falling and rising filters must be true or false")
            return self.iv_scanner.start(
                float(self._value(query, "high", "80")),
                float(self._value(query, "low", "20")),
                self._integer(query, "days", minimum=1),
                self._integer(query, "smoothing", minimum=1),
                falling == "true", rising == "true",
            ), 200
        if path == "/api/scanners/iv/status":
            return self.iv_scanner.snapshot(self._value(query, "id", "")), 200
        if path == "/api/scanners/iv/cancel":
            return self.iv_scanner.cancel(self._value(query, "id")), 200
        if path == "/api/health":
            return {
                "status": "ok",
                "service": "fno-analyzer",
                "version": "2.0.0",
            }, 200
        if path == "/api/ready":
            ready = self.aoc.configured or self.dhan.configured
            if not ready:
                raise ConfigurationError("No data provider is configured")
            return {
                "status": "ready",
                "providers": {"aoc": self.aoc.configured, "dhan": self.dhan.configured},
            }, 200
        if path == "/api/config":
            return {
                "refresh_seconds": self.settings["server"]["refresh_seconds"],
                "providers": {"aoc": self.aoc.configured, "dhan": self.dhan.configured},
                "public_base_url": self.settings["public"].get("base_url", ""),
            }, 200
        if path == "/api/tickers":
            return {"tickers": self.aoc.get_tickers()}, 200
        if path == "/api/live/tickers":
            mapping = load_map(self.settings["map_path"]) or {}
            tickers = [{"Name": row["aoc"], "disp": row.get("disp") or row["aoc"],
                        "Fav": row["aoc"] in ("NIFTY", "SENSEX", "BANKNIFTY"), "userFav": True}
                       for row in mapping.get("mapped", []) if row.get("aoc")]
            if tickers:
                return {"tickers": tickers}, 200
            return {"tickers": self.aoc.get_tickers()}, 200
        if path == "/api/live":
            ticker = self._ticker(query)
            try:
                result = self._dhan_result(self._entry(ticker))
                if not result.get("strikes"):
                    raise ProviderError("Dhan returned an empty option chain", provider="dhan")
                result["source"] = "dhan"
            except AppError as dhan_error:
                try:
                    result = self._aoc_result(self.aoc.fetch_live(ticker), ticker)
                    if not result.get("strikes"):
                        raise ProviderError("AOC returned an empty option chain", provider="aoc")
                    result["source"] = "aoc"
                    result["fallback_reason"] = str(dhan_error)
                except AppError as aoc_error:
                    raise ProviderError(f"Dhan: {dhan_error}; AOC backup: {aoc_error}") from aoc_error
            return result, 200
        if path == "/api/expiries":
            ticker = self._ticker(query)
            return {"expiries": self.aoc.get_expiries(ticker)}, 200
        if path == "/api/data":
            ticker = self._ticker(query)
            return self._aoc_result(self.aoc.fetch_live(ticker), ticker), 200
        if path == "/api/historical":
            ticker = self._ticker(query)
            expiry = self._value(query, "expiry")
            timestamp = self._integer(query, "timestamp", minimum=1)
            result = self._aoc_result(self.aoc.fetch_historical(ticker, expiry, timestamp), ticker)
            result["as_of"] = timestamp
            result.pop("oi_zscore", None)
            return result, 200
        if path == "/api/dhan/map":
            refresh = self._value(query, "refresh", "").lower() in ("1", "true", "yes")
            return self.dhan_map(refresh), 200
        if path == "/api/dhan/chain":
            ticker = self._ticker(query)
            return self._dhan_result(self._entry(ticker)), 200
        if path == "/api/dhan/ivpivr":
            ticker = self._ticker(query)
            entry = self._entry(ticker)
            lookback = self._value(query, "lookback", "1y")
            payload = self.dhan.ivp_ivr(int(entry["seg"]), int(entry["sid"]), lookback)
            data = payload.get("data") or {}
            if not isinstance(data, dict):
                data = {}
            return {
                "ticker": self.ticker_meta(ticker, entry.get("disp") or entry.get("aoc")),
                "dhan": {"sid": int(entry["sid"]), "seg": int(entry["seg"]), "disp": entry.get("disp")},
                "lookback": lookback,
                "latest": latest_ivp_ivr(data),
                "data": data,
            }, 200
        if path == "/api/dhan/skew":
            ticker = self._ticker(query)
            entry = self._entry(ticker)
            chain = self._dhan_chain_data(entry)
            options = []
            for row in chain.get("strikes", []):
                if row.get("cIV") is not None:
                    options.append({"strike": row["sp"], "iv": row["cIV"], "optionType": "CE"})
                if row.get("pIV") is not None:
                    options.append({"strike": row["sp"], "iv": row["pIV"], "optionType": "PE"})
            snapshot = chain.get("snapshot") or {}
            return {
                "ticker": self.ticker_meta(ticker, entry.get("disp") or entry.get("aoc")),
                "dhan": {"sid": int(entry["sid"]), "seg": int(entry["seg"]), "disp": entry.get("disp")},
                "exps": [snapshot.get("exp")] if snapshot.get("exp") else [],
                "data": [{"expiry": snapshot.get("exp"), "spot": snapshot.get("uv"), "options": options}],
            }, 200
        if path == "/api/dhan/term":
            return self._dhan_term(query), 200
        if path == "/api/sectors":
            payload = self.aoc.fetch_sectors()
            return {"ts": (payload.get("data") or {}).get("ts"), "sectors": self._sector_rows(payload)}, 200
        if path == "/api/sectors/intraday":
            start_ms, end_ms = self.intraday_window()
            if "startTime" in query or "endTime" in query:
                start_ms = self._integer(query, "startTime", minimum=1)
                end_ms = self._integer(query, "endTime", minimum=1)
            interval = self._integer({"interval": [self._value(query, "interval", "1")]}, "interval", minimum=1)
            if end_ms < start_ms:
                raise InvalidParameter("endTime must not be before startTime")
            payload = self.aoc.fetch_sector_intraday(start_ms, end_ms, interval)
            data = payload.get("data") or []
            series = [
                {
                    "symbol": item.get("symbol"),
                    "displaySymbol": item.get("displaySymbol"),
                    "ltp": item.get("ltp", []),
                    "pchg": item.get("pchg", []),
                }
                for item in data
                if isinstance(item, dict)
            ]
            timestamps = data[0].get("ts", []) if data and isinstance(data[0], dict) else []
            return {
                "ts": timestamps,
                "series": series,
                "startTime": start_ms,
                "endTime": end_ms,
                "interval": interval,
            }, 200
        if path == "/api/sectors/components":
            sector_id = self._integer(query, "sectorId", minimum=1)
            return self.aoc.fetch_sector_components(sector_id), 200
        raise InvalidParameter("Route not found", code="NOT_FOUND")

    def _dhan_term(self, query: dict[str, list[str]]) -> dict[str, Any]:
        ticker = self._ticker(query)
        if ticker not in ("NIFTY", "SENSEX"):
            raise InvalidParameter("IV term structure is available only for NIFTY and SENSEX")
        entry = self._entry(ticker)
        all_expiries = expiry_ids(self.dhan.expiry_list(int(entry["seg"]), int(entry["sid"])))
        if not all_expiries:
            raise ProviderError("Dhan returned no option expiries", provider="dhan", retryable=True)
        if "exps" in query:
            count = self._integer(query, "exps", minimum=1)
            selected = all_expiries[: min(count, len(all_expiries))]
        else:
            requested = []
            for value in query.get("exp", []):
                try:
                    requested.append(int(value))
                except ValueError as exc:
                    raise InvalidParameter("exp must contain integers", code="INVALID_PARAMETER") from exc
            selected = [value for value in requested if value in all_expiries] or all_expiries[:1]
        selected = list(dict.fromkeys(selected))
        data = []
        for expiry_id in selected:
            chain = self._dhan_chain_data(entry, expiry_id)
            strikes = [
                {"sp": row["sp"], "cIV": row.get("cIV"), "pIV": row.get("pIV")}
                for row in chain.get("strikes", [])
                if row.get("sp") is not None
            ]
            spot = (chain.get("snapshot") or {}).get("uv")
            if spot is None or not strikes:
                atm = None
            else:
                atm = min((row["sp"] for row in strikes), key=lambda value: abs(value - spot))
            data.append(
                {
                    "expiry": format_expiry(expiry_id + EXPDATEJ_OFFSET),
                    "expdatej": expiry_id,
                    "spot": spot,
                    "atm": atm,
                    "strikes": strikes,
                }
            )
        return {
            "ticker": self.ticker_meta(ticker, entry.get("disp") or entry.get("aoc")),
            "dhan": {"sid": int(entry["sid"]), "seg": int(entry["seg"]), "disp": entry.get("disp")},
            "expiries": [
                {"expdatej": value, "label": format_expiry(value + EXPDATEJ_OFFSET)}
                for value in all_expiries
            ],
            "data": data,
        }

    def _sector_rows(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        data = payload.get("data") or {}

        def column(name: str) -> list[Any]:
            values = data.get(name) or []
            return values if isinstance(values, list) else [values]

        ids = column("sectorId")
        return [
            {
                "sectorId": ids[index] if index < len(ids) else None,
                "symbol": self._column_value(data, "symbol", index),
                "displaySymbol": self._column_value(data, "displaySymbol", index),
                "ltp": self._column_value(data, "ltp", index),
                "chg": self._column_value(data, "chg", index),
                "pchg": self._column_value(data, "pchg", index),
                "high": self._column_value(data, "high", index),
                "low": self._column_value(data, "low", index),
                "open": self._column_value(data, "open", index),
                "prevClose": self._column_value(data, "prevClose", index),
                "adv": self._column_value(data, "adv", index),
                "dec": self._column_value(data, "dec", index),
                "unch": self._column_value(data, "unch", index),
                "total": self._column_value(data, "total", index),
            }
            for index in range(len(ids))
        ]

    @staticmethod
    def _column_value(data: dict[str, Any], name: str, index: int) -> Any:
        values = data.get(name) or []
        if not isinstance(values, list):
            values = [values]
        return values[index] if index < len(values) else None

    @staticmethod
    def _value(query: dict[str, list[str]], name: str, default: str = "") -> str:
        values = query.get(name) or []
        return values[0] if values else default

    def _ticker(self, query: dict[str, list[str]]) -> str:
        value = self._value(query, "ticker").strip().upper()
        if not value or len(value) > 64:
            raise InvalidParameter("ticker is required")
        return value

    @classmethod
    def _integer(cls, query: dict[str, list[str]], name: str, minimum: int = 0) -> int:
        raw = cls._value(query, name)
        try:
            value = int(raw)
        except (TypeError, ValueError) as exc:
            raise InvalidParameter(f"{name} must be an integer", code="INVALID_PARAMETER") from exc
        if value < minimum:
            raise InvalidParameter(f"{name} must be at least {minimum}", code="INVALID_PARAMETER")
        return value
