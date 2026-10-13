"""Background IV scans with deterministic, trailing-only smoothing."""
from copy import deepcopy
from datetime import datetime
import math
from threading import Event, Lock, Thread
from typing import Any
from uuid import uuid4

from ..errors import AppError, InvalidParameter, ProviderError
from ..providers.dhan import IST, _analytics_date_key


def finite(value: Any) -> float | None:
    if value is None or isinstance(value, bool) or value == "":
        return None
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):
        return None


def iv_trend(data: Any, days: int, smoothing: int) -> dict[str, Any] | None:
    if not isinstance(data, dict):
        return None
    dates, iv, ivp = (data.get(key) for key in ("date", "iv", "ivp"))
    if not all(isinstance(values, list) for values in (dates, iv, ivp)):
        return None
    points = {}
    for date, raw_iv, raw_ivp in zip(dates, iv, ivp):
        timestamp = _analytics_date_key(date)
        v, p = finite(raw_iv), finite(raw_ivp)
        if not math.isfinite(timestamp) or v is None or v <= 0 or p is None or not 0 <= p <= 100:
            continue
        # Deduplicate dates without detaching values from their original rows.
        points.setdefault(timestamp, (v, p))
    ordered = sorted(points.items())
    if len(ordered) < days + smoothing:
        return None
    smoothed = []
    for index in range(smoothing - 1, len(ordered)):
        window = ordered[index - smoothing + 1:index + 1]
        smoothed.append((ordered[index][0],
                         sum(point[1][0] for point in window) / smoothing,
                         sum(point[1][1] for point in window) / smoothing))
    start, end = smoothed[-days - 1], smoothed[-1]
    change = end[1] - start[1]
    return {
        "start_date": datetime.fromtimestamp(start[0], IST).strftime("%d-%b-%Y"),
        "end_date": datetime.fromtimestamp(end[0], IST).strftime("%d-%b-%Y"),
        "iv_start": start[1], "iv_end": end[1], "iv_change": change,
        "iv_change_pct": change / start[1] * 100,
        "ivp_start": start[2], "ivp_end": end[2], "ivp_change": end[2] - start[2],
    }


class IVScanner:
    def __init__(self, dhan):
        self.dhan = dhan
        self.lock = Lock()
        self.cancel_event = Event()
        self.state = None

    def start(self, high: float, low: float, days: int, smoothing: int,
              falling: bool = True, rising: bool = True) -> dict:
        if not (math.isfinite(high) and math.isfinite(low) and 0 <= low < high <= 100):
            raise InvalidParameter("Cutoffs must satisfy 0 ≤ low < high ≤ 100")
        if not 1 <= days <= 60 or not 1 <= smoothing <= 20:
            raise InvalidParameter("Lookback must be 1–60 observations and smoothing 1–20")
        with self.lock:
            if self.state and self.state["status"] == "running":
                raise AppError("A scan is already running", code="SCAN_BUSY", status=409)
            self.cancel_event = Event()
            self.state = {
                "id": uuid4().hex, "status": "running", "high_cutoff": high,
                "low_cutoff": low, "days": days, "smoothing": smoothing,
                "falling": falling, "rising": rising,
                "total_stocks": 0, "candidates": 0, "checked": 0,
                "high": [], "low": [], "skipped": [], "error": None,
            }
            snapshot = deepcopy(self.state)
            Thread(target=self._run, args=(high, low, days, smoothing, falling, rising), daemon=True).start()
            return snapshot

    def snapshot(self, scan_id: str) -> dict:
        with self.lock:
            if not scan_id:
                return deepcopy(self.state) if self.state else {"status": "idle"}
            if not self.state or self.state["id"] != scan_id:
                raise AppError("Scan not found; start a new scan", code="SCAN_NOT_FOUND", status=404)
            return deepcopy(self.state)

    def cancel(self, scan_id: str) -> dict:
        self.snapshot(scan_id)
        with self.lock:
            if self.state["id"] == scan_id and self.state["status"] == "running":
                self.cancel_event.set()
        return self.snapshot(scan_id)

    def _run(self, high, low, days, smoothing, falling=True, rising=True):
        try:
            movers = self.dhan.iv_movers().get("data")
            if not isinstance(movers, list):
                raise ProviderError("Dhan returned invalid IV movers data", provider="dhan")
            stocks = {}
            for row in movers:
                if not isinstance(row, dict) or row.get("exch") != "NSE" or row.get("segId") != 1:
                    continue
                p = finite(row.get("ivp"))
                v = finite(row.get("atmiv"))
                sid = finite(row.get("secId"))
                if p is None or not 0 <= p <= 100 or v is None or v <= 0 or sid is None or sid <= 0 or not sid.is_integer():
                    continue
                stocks.setdefault(int(sid), {"symbol": str(row.get("symbol") or sid),
                                            "sid": int(sid), "ivp": p, "iv": v})
            candidates = [(row, "high" if row["ivp"] > high else "low")
                          for row in stocks.values() if row["ivp"] > high or row["ivp"] < low]
            with self.lock:
                self.state.update(total_stocks=len(stocks), candidates=len(candidates))
            for row, group in candidates:
                if self.cancel_event.is_set():
                    break
                if not (falling if group == "high" else rising):
                    # IVP-only scans do not require history or exclude short histories.
                    with self.lock:
                        self.state[group].append(row)
                        self.state["checked"] += 1
                    continue
                try:
                    history = self.dhan.analytics_history(1, row["sid"], "1y")
                    trend = iv_trend(history.get("data"), days, smoothing)
                    with self.lock:
                        if trend is None:
                            self.state["skipped"].append({"symbol": row["symbol"], "reason": "Insufficient valid IV/IVP history"})
                        elif (group == "high" and trend["iv_change"] < -1e-9) or (group == "low" and trend["iv_change"] > 1e-9):
                            self.state[group].append({**row, **trend})
                        self.state["checked"] += 1
                except AppError as exc:
                    if exc.code in ("DHAN_RATE_LIMIT", "PROVIDER_AUTH_ERROR", "CONFIGURATION_ERROR"):
                        raise
                    with self.lock:
                        self.state["skipped"].append({"symbol": row["symbol"], "reason": exc.message})
                        self.state["checked"] += 1
            with self.lock:
                self.state["high"].sort(key=lambda row: row["iv_change_pct"] if falling else -row["ivp"])
                self.state["low"].sort(key=lambda row: -row["iv_change_pct"] if rising else row["ivp"])
                self.state["status"] = "cancelled" if self.cancel_event.is_set() else "complete"
        except Exception as exc:
            with self.lock:
                self.state["status"] = "failed"
                self.state["error"] = exc.message if isinstance(exc, AppError) else "Scan failed unexpectedly"
