from typing import Any


def _number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _ratio(numerator: float | None, denominator: float | None) -> float | None:
    if numerator is None or denominator in (None, 0, 0.0):
        return None
    return numerator / denominator


def compute_metrics(snapshot: dict[str, Any], strikes: list[dict[str, Any]]) -> dict[str, Any]:
    values = {key: _number(value) for key, value in snapshot.items()}
    spot = values.get("uv")
    atm = _atm_strike(strikes, spot)
    atm_call = _iv_at(strikes, atm, "cIV")
    atm_put = _iv_at(strikes, atm, "pIV")
    total_call = values.get("tOICe")
    total_put = values.get("tOIPe")
    total_oi = total_call + total_put if total_call is not None and total_put is not None else None
    skew = atm_put - atm_call if atm_call is not None and atm_put is not None else None
    return {
        "symbol": snapshot.get("s"),
        "expiry": snapshot.get("exp"),
        "date": snapshot.get("dt"),
        "spot": spot,
        "spot_chg": values.get("uvc"),
        "fut": values.get("fp"),
        "fut_chg": values.get("fpc"),
        "pcr_oi": _ratio(values.get("tOIPe"), values.get("tOICe")),
        "pcr_oi_chg": _ratio(values.get("tOICPe"), values.get("tOICCe")),
        "pcr_vol": _ratio(values.get("tVolPe"), values.get("tVolCe")),
        "total_oi": total_oi,
        "total_oi_ce": total_call,
        "total_oi_pe": total_put,
        "total_vol_ce": values.get("tVolCe"),
        "total_vol_pe": values.get("tVolPe"),
        "max_oi_ce": values.get("mOiCe"),
        "max_oi_pe": values.get("mOiPe"),
        "max_oi_chg_ce": values.get("mOICCe"),
        "max_oi_chg_pe": values.get("mOICPe"),
        "max_vol_ce": values.get("mVolCe"),
        "max_vol_pe": values.get("mVolPe"),
        "max_pain": _compute_max_pain(strikes, spot),
        "atm_strike": atm,
        "atm_iv_ce": atm_call,
        "atm_iv_pe": atm_put,
        "iv_skew": skew,
        "levels": {
            "res": values.get("res"),
            "res2": values.get("res2"),
            "sup": values.get("sup"),
            "sup2": values.get("sup2"),
            "exp_res": values.get("expRes"),
            "exp_sup": values.get("expSup"),
            "eor": values.get("eor"),
            "eos": values.get("eos"),
            "eor_f": values.get("eorF"),
            "eos_f": values.get("eosF"),
        },
        "top_oi_builds": _top_by_abs(strikes, "cOIC", "pOIC", n=8),
        "top_volume": _top_by_abs(strikes, "cVol", "pVol", n=8),
    }


def _atm_strike(strikes: list[dict[str, Any]], spot: float | None) -> float | None:
    if spot is None:
        return None
    candidates = [(_number(row.get("sp")), abs(_number(row.get("sp")) - spot)) for row in strikes if _number(row.get("sp")) is not None]
    if not candidates:
        return None
    return min(candidates, key=lambda item: item[1])[0]


def _iv_at(strikes: list[dict[str, Any]], strike: float | None, key: str) -> float | None:
    if strike is None:
        return None
    for row in strikes:
        if _number(row.get("sp")) == strike:
            return _number(row.get(key))
    return None


def _compute_max_pain(strikes: list[dict[str, Any]], spot: float | None) -> float | None:
    valid = [(row, _number(row.get("sp"))) for row in strikes if _number(row.get("sp")) is not None]
    if not valid:
        return None

    def pain(mid: float) -> float:
        total = 0.0
        for row, strike in valid:
            call_oi = _number(row.get("cOI")) or 0.0
            put_oi = _number(row.get("pOI")) or 0.0
            total += abs(mid - strike) * (call_oi + put_oi)
        return total

    candidates = sorted({strike for _, strike in valid})
    return min(candidates, key=pain)


def _top_by_abs(strikes: list[dict[str, Any]], call_key: str, put_key: str, n: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for row in strikes:
        strike = _number(row.get("sp"))
        if strike is None:
            continue
        for side, key in (("CE", call_key), ("PE", put_key)):
            value = _number(row.get(key))
            if value is None:
                continue
            rows.append({"strike": strike, "side": side, "value": value, "abs": abs(value)})
    rows.sort(key=lambda item: item["abs"], reverse=True)
    return rows[:n]
