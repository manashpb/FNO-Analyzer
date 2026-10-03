import json
import os
from pathlib import Path
import time
from typing import Any

from ..providers.dhan import number

ALIASES = {"LT": "LARSEN", "NIFTY_2": "NIFTY", "M&M": "MAHINDRA"}


def _match_row(term: str, rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    query = str(term).upper()

    def exact(items: list[dict[str, Any]]) -> dict[str, Any] | None:
        for row in items:
            for key in ("Ticker_t", "Sym_t", "ExchTradingSymbol_s"):
                value = row.get(key)
                if value and str(value).upper() == query:
                    return row
            if row.get("underlyingName") and str(row["underlyingName"]).upper() == query:
                return row
        return None

    first = exact(rows)
    if first is None:
        return None
    preferred = [row for row in rows if str(row.get("d_exch_t") or "").upper() in ("NSE", "IDX")]
    return exact(preferred) or first


def build_symbol_map(client: Any, tickers: list[dict[str, Any]], segment_map: dict[str, int] | None = None) -> dict[str, Any]:
    segments = segment_map or getattr(client, "segment_map", {"I": 0, "E": 2})
    mapped: list[dict[str, Any]] = []
    unmapped: list[dict[str, Any]] = []
    for ticker in tickers:
        name = str(ticker.get("Name") or "").upper()
        if not name:
            continue
        alias = ALIASES.get(name, name)
        try:
            rows = client.search(alias)
            row = _match_row(alias, rows)
            if row is None:
                rows = client.search(alias, all_rows=True)
                row = _match_row(alias, rows) or _match_row(name, rows)
        except Exception as exc:
            unmapped.append({"aoc": name, "reason": str(exc)[:120]})
            continue
        if row is None:
            unmapped.append({"aoc": name, "reason": "no exact Dhan match"})
            continue
        raw_segment = str(row.get("Seg_s") or "").upper()
        if raw_segment not in segments:
            unmapped.append({"aoc": name, "reason": f"unsupported segment {raw_segment!r}"})
            continue
        sid = number(row.get("Sid_s"))
        try:
            sid_int = int(sid) if sid is not None else None
        except (TypeError, ValueError):
            sid_int = None
        if sid_int is None:
            unmapped.append({"aoc": name, "reason": "missing Dhan security id"})
            continue
        mapped.append(
            {
                "aoc": name,
                "ticker": str(row.get("Ticker_t") or name),
                "sid": sid_int,
                "seg": int(segments[raw_segment]),
                "disp": str(row.get("CompName_t") or row.get("disp_sym_s") or name),
            }
        )
    return {"ts": int(time.time()), "mapped": mapped, "unmapped": unmapped}


def load_map(path: str | Path) -> dict[str, Any] | None:
    try:
        with Path(path).open("r", encoding="utf-8") as handle:
            value = json.load(handle)
        return value if isinstance(value, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def save_map(path: str | Path, value: dict[str, Any]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, target)


def lookup_map(path: str | Path, ticker: str) -> dict[str, Any] | None:
    value = load_map(path)
    if not value:
        return None
    query = ticker.upper()
    for entry in value.get("mapped", []):
        if str(entry.get("aoc", "")).upper() == query:
            return entry
    return None
