import json
import time
from threading import Lock
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import requests

from ..errors import ConfigurationError, ProviderAuthError, ProviderError, UpstreamNotFound, UpstreamTimeout
from ..cache import TTLCache

IST = ZoneInfo("Asia/Kolkata")
EXPDATEJ_OFFSET = 315532800
SEARCH_ALIASES = {"LT": "LARSEN", "NIFTY_2": "NIFTY", "M&M": "MAHINDRA"}


def number(value: Any) -> Any:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(value)
    except (TypeError, ValueError):
        return value


def format_expiry(timestamp: int | float | None) -> str | None:
    if timestamp is None:
        return None
    try:
        return datetime.fromtimestamp(float(timestamp), IST).strftime("%d-%b-%Y")
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def expiry_ids(payload: dict[str, Any]) -> list[int]:
    data = payload.get("data") or payload
    if not isinstance(data, dict):
        return []
    groups = data.get("exps") or data.get("explst") or []
    values: set[int] = set()
    for group in groups or []:
        if not isinstance(group, dict):
            continue
        inst = str(group.get("inst") or "")
        if inst and not inst.upper().startswith("OPT"):
            continue
        items = group.get("explst") or ([group] if "expdatej" in group else [])
        for item in items:
            value = number(item.get("expdatej") if isinstance(item, dict) else item)
            if value is not None:
                try:
                    values.add(int(value))
                except (TypeError, ValueError):
                    continue
    return sorted(values)


def latest_ivp_ivr(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict):
        return {}
    dates = data.get("date")
    if not isinstance(dates, list):
        dates = []
    fields = ("ivp", "ivr", "iv", "spotPrice")
    arrays = {key: data.get(key) for key in fields if isinstance(data.get(key), list)}
    if not arrays:
        return {}
    if dates:
        limit = len(dates)
        index = max(range(limit), key=lambda item: _analytics_date_key(dates[item]))
    else:
        index = 0
    point: dict[str, Any] = {"date": dates[index] if dates else None}
    for key, values in arrays.items():
        point[key] = values[index] if index < len(values) else None
    return point


def _analytics_date_key(value: Any) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    text = str(value or "").strip()
    try:
        return float(text)
    except (TypeError, ValueError):
        pass
    for pattern in ("%d-%b-%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(text, pattern).replace(tzinfo=IST).timestamp()
        except (TypeError, ValueError):
            continue
    return float("-inf")


def _row_from_option(option: dict[str, Any], side: str) -> dict[str, Any]:
    greek = option.get("optgeeks") or {}
    prefix = side
    return {
        f"{prefix}OI": number(option.get("OI")),
        f"{prefix}OIC": number(option.get("oichng")),
        f"{prefix}OICP": number(option.get("oiperchnge")),
        f"{prefix}Vol": number(option.get("vol")),
        f"{prefix}Ltp": number(option.get("ltp")),
        f"{prefix}Chg": number(option.get("p_chng")),
        f"{prefix}IV": number(option.get("iv")),
        f"{prefix}D": number(greek.get("delta")),
        f"{prefix}G": number(greek.get("gamma")),
        f"{prefix}T": number(greek.get("theta")),
        f"{prefix}Bid": number(option.get("bid")),
        f"{prefix}Ask": number(option.get("ask")),
    }


def normalize_dhan_chain(
    payload: dict[str, Any],
    aoc_ticker: str,
    max_strikes: int = 100,
) -> dict[str, Any]:
    option_map = payload.get("oc") or {}
    if not isinstance(option_map, dict):
        option_map = {}
    all_strikes: list[dict[str, Any]] = []
    for strike_key, raw_row in option_map.items():
        if not isinstance(raw_row, dict):
            continue
        try:
            strike = float(strike_key)
        except (TypeError, ValueError):
            continue
        call = raw_row.get("ce") if isinstance(raw_row.get("ce"), dict) else {}
        put = raw_row.get("pe") if isinstance(raw_row.get("pe"), dict) else {}
        if not call and not put:
            continue
        row = {"sp": strike}
        row.update(_row_from_option(call, "c"))
        row.update(_row_from_option(put, "p"))
        if not any(value is not None for key, value in row.items() if key != "sp"):
            continue
        all_strikes.append(row)

    spot = number(payload.get("sltp"))
    if spot is not None:
        ordered = sorted(all_strikes, key=lambda row: (abs(row["sp"] - spot), row["sp"]))
    else:
        ordered = sorted(all_strikes, key=lambda row: row["sp"])
    limit = max(1, int(max_strikes))
    selected = ordered[:limit]
    selected.sort(key=lambda row: row["sp"])
    all_strikes.sort(key=lambda row: row["sp"])

    def total(key: str) -> float | None:
        values = [row.get(key) for row in all_strikes if isinstance(row.get(key), (int, float))]
        return sum(values) if values else None

    def maximum_strike(key: str) -> float | None:
        values = [(row.get(key), row["sp"]) for row in all_strikes if isinstance(row.get(key), (int, float))]
        return max(values, key=lambda item: item[0])[1] if values else None

    expiry_values: list[int] = []
    for item in payload.get("explst") or []:
        value = number(item.get("expdatej") if isinstance(item, dict) else item)
        if value is not None:
            try:
                expiry_values.append(int(value))
            except (TypeError, ValueError):
                continue
    exp_ts = min(expiry_values) + EXPDATEJ_OFFSET if expiry_values else None

    future_ltp = None
    future_change = None
    futures = payload.get("fl") or {}
    if isinstance(futures, dict) and futures:
        valid_keys = []
        for key in futures:
            try:
                valid_keys.append((int(key), key))
            except (TypeError, ValueError):
                continue
        if valid_keys:
            future = futures[min(valid_keys)[1]] or {}
            future_ltp = number(future.get("ltp"))
            previous = number(future.get("pc"))
            if future_ltp is not None and previous is not None:
                future_change = future_ltp - previous

    snapshot = {
        "s": aoc_ticker,
        "exp": format_expiry(exp_ts),
        "dt": format_expiry(exp_ts),
        "uv": spot,
        "uvc": number(payload.get("SChng")),
        "fp": future_ltp,
        "fpc": future_change,
        "res": number(payload.get("oi_resist")),
        "sup": number(payload.get("oi_support")),
        "atmiv": number(payload.get("atmiv")),
        "tOICe": total("cOI"),
        "tOIPe": total("pOI"),
        "tOICCe": total("cOIC"),
        "tOICPe": total("pOIC"),
        "tVolCe": total("cVol"),
        "tVolPe": total("pVol"),
        "mOiCe": maximum_strike("cOI"),
        "mOiPe": maximum_strike("pOI"),
        "mOICCe": maximum_strike("cOIC"),
        "mOICPe": maximum_strike("pOIC"),
        "mVolCe": maximum_strike("cVol"),
        "mVolPe": maximum_strike("pVol"),
        "source": "dhan",
    }
    coverage = {
        "raw_strike_count": len(all_strikes),
        "returned_strike_count": len(selected),
        "is_truncated": len(selected) < len(all_strikes),
        "window_start": selected[0]["sp"] if selected else None,
        "window_end": selected[-1]["sp"] if selected else None,
    }
    return {
        "snapshot": snapshot,
        "strikes": selected,
        "coverage": coverage,
        "_all_strikes": all_strikes,
    }


class DhanClient:
    name = "dhan"

    def __init__(self, settings: dict[str, Any]):
        config = settings["providers"]["dhan"]
        self.search_url = str(config.get("search_url", ""))
        self.search_all_url = str(config.get("search_all_url", ""))
        self.expiry_list_url = str(config.get("expiry_list_url", ""))
        self.option_chain_url = str(config.get("option_chain_url", ""))
        self.ivpivr_url = str(config.get("ivpivr_url", ""))
        self.ivmovers_url = str(config.get("ivmovers_url") or self.ivpivr_url.rsplit("/", 1)[0] + "/ivmovers")
        self.analytics_cache = TTLCache(900)
        self.movers_cache = TTLCache(300)
        self.analytics_lock = Lock()
        self.analytics_next_request = 0.0
        self.jwt = str(config.get("jwt") or "")
        self.entity_id = str(config.get("entity_id") or "")
        self.client_id = str(config.get("client_id") or "")
        self.source = str(config.get("source") or "Y")
        self.broker_code = str(config.get("broker_code") or "DHN1804")
        self.authorisation = str(config.get("authorisation") or "Token")
        self.segment_map = config.get("scanx_segments") or {"I": 0, "E": 2}
        self.analytics_segments = config.get("analytics_segments") or {"0": 0, "2": 1}
        self.timeout = float(settings["server"].get("request_timeout_seconds", 30))
        self.session = requests.Session()

    @property
    def configured(self) -> bool:
        return bool(self.jwt)

    def _headers(self) -> dict[str, str]:
        headers = {
            "accept": "application/json, text/plain, */*",
            "content-type": "application/json",
            "origin": "https://options-trader.dhan.co",
            "referer": "https://options-trader.dhan.co/",
            "user-agent": "FNO-Analyzer/2.0",
        }
        if self.authorisation:
            headers["authorisation"] = self.authorisation
        if self.jwt:
            headers["auth"] = self.jwt
        return headers

    def _post(self, url: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.configured:
            raise ConfigurationError(
                "Dhan is not configured; set providers.dhan.jwt or FNO_DHAN_JWT",
                provider=self.name,
            )
        try:
            response = self.session.post(url, headers=self._headers(), json=payload, timeout=self.timeout)
        except requests.Timeout as exc:
            raise UpstreamTimeout(self.name, "Dhan request timed out") from exc
        except requests.RequestException as exc:
            raise ProviderError("Dhan request failed", provider=self.name) from exc
        if response.status_code in (401, 403):
            raise ProviderAuthError(self.name, "Dhan authentication failed; refresh the Dhan JWT")
        if response.status_code == 404:
            raise UpstreamNotFound(self.name, "Dhan resource was not found")
        if response.status_code == 429:
            try:
                delay = max(60.0, float(response.headers.get("Retry-After", 60)))
            except (TypeError, ValueError):
                delay = 60.0
            self.analytics_next_request = time.monotonic() + delay
            raise ProviderError("Dhan rate limit reached; wait before running again", code="DHAN_RATE_LIMIT", provider=self.name)
        if not 200 <= response.status_code < 300:
            raise ProviderError(f"Dhan returned HTTP {response.status_code}", provider=self.name)
        try:
            result = response.json()
        except ValueError as exc:
            raise ProviderError("Dhan returned invalid JSON", provider=self.name) from exc
        if not isinstance(result, dict):
            raise ProviderError("Dhan returned an invalid response", provider=self.name)
        return result

    def search(self, term: str, all_rows: bool = False) -> list[dict[str, Any]]:
        url = self.search_all_url if all_rows else self.search_url
        if not url:
            raise ConfigurationError("Dhan search URL is missing", provider=self.name)
        body = {
            "UserId": self.entity_id,
            "UserType": "C",
            "Source": self.source,
            "Data": json.dumps({"inst": "", "searchterm": term, "exch": "", "optionflag": False}),
            "broker_code": self.broker_code,
        }
        try:
            response = self.session.post(
                url,
                json=body,
                headers={"accept": "application/json", "content-type": "application/json"},
                timeout=self.timeout,
            )
        except requests.Timeout as exc:
            raise UpstreamTimeout(self.name, "Dhan search timed out") from exc
        except requests.RequestException as exc:
            raise ProviderError("Dhan search failed", provider=self.name) from exc
        if response.status_code in (401, 403):
            raise ProviderAuthError(self.name, "Dhan search authentication failed")
        if not 200 <= response.status_code < 300:
            raise ProviderError(f"Dhan search returned HTTP {response.status_code}", provider=self.name)
        try:
            result = response.json()
        except ValueError as exc:
            raise ProviderError("Dhan search returned invalid JSON", provider=self.name) from exc
        rows = result.get("data") if isinstance(result, dict) else []
        return rows if isinstance(rows, list) else []

    def expiry_list(self, seg: int, sid: int) -> dict[str, Any]:
        return self._post(self.expiry_list_url, {"Data": {"Seg": int(seg), "Sid": int(sid)}})

    def option_chain(self, seg: int, sid: int, exp: int = -1) -> dict[str, Any]:
        result = self._post(
            self.option_chain_url,
            {"data": {"Seg": int(seg), "Sid": int(sid), "Exp": int(exp)}},
        )
        code = result.get("code")
        if code not in (None, 0):
            raise ProviderError(
                str(result.get("remarks") or "Dhan rejected the option-chain request")[:240],
                code="DHAN_STATUS_ERROR",
                provider=self.name,
            )
        data = result.get("data") or {}
        if not isinstance(data, dict):
            raise ProviderError("Dhan option-chain data was invalid", provider=self.name)
        return data

    def ivp_ivr(self, seg: int, sid: int, lookback: str = "1y") -> dict[str, Any]:
        analytics_seg = self.analytics_segments.get(str(seg), 1)
        return self.analytics_history(int(analytics_seg), sid, lookback)

    def _analytics_post(self, url: str, body: dict[str, Any]) -> dict[str, Any]:
        if time.monotonic() < self.analytics_next_request:
            time.sleep(self.analytics_next_request - time.monotonic())
        try:
            result = self._post(url, body)
        finally:
            self.analytics_next_request = max(self.analytics_next_request, time.monotonic() + 1.0)
        if result.get("code") not in (None, 0):
            raise ProviderError(str(result.get("remarks") or "Dhan analytics request rejected")[:240], provider=self.name)
        return result

    def analytics_history(self, seg: int, sid: int, lookback: str = "1y") -> dict[str, Any]:
        # Movers already supply analytics segment IDs; do not translate them again.
        key = (int(seg), int(sid), lookback)
        with self.analytics_lock:
            cached = self.analytics_cache.get(key)
            if cached is not None:
                return cached
            result = self._analytics_post(self.ivpivr_url, {"data": {
                "SegID": int(seg), "SecID": int(sid), "lookback": lookback, "Range": "1Y",
            }})
            self.analytics_cache.set(key, result)
            return result

    def iv_movers(self) -> dict[str, Any]:
        with self.analytics_lock:
            cached = self.movers_cache.get("NSE")
            if cached is not None:
                return cached
            result = self._analytics_post(self.ivmovers_url, {"data": {
                "exch": "NSE", "page": 1, "count": 350, "lookback": "1y", "flag": "HighestIVP",
            }})
            self.movers_cache.set("NSE", result)
            return result
