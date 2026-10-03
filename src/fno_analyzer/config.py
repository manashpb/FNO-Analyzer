from copy import deepcopy
import json
import os
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]

DEFAULTS: dict[str, Any] = {
    "server": {
        "host": "127.0.0.1",
        "port": 8000,
        "static_dir": "frontend",
        "data_dir": "data",
        "request_timeout_seconds": 30,
        "refresh_seconds": 15,
    },
    "providers": {
        "aoc": {
            "base_url": "https://apim4.niftychain.in/api/v10",
            "token": "",
            "token_env": "FNO_AOC_TOKEN",
        },
        "dhan": {
            "search_url": "https://dhan-search.dhan.co/Search/api/Search/ScripUnderlying",
            "search_all_url": "https://dhan-search.dhan.co/Search/api/Search/Scrip",
            "expiry_list_url": "https://static-scanx.dhan.co/staticscanx/explist",
            "option_chain_url": "https://scanx.dhan.co/scanx/optchain",
            "ivpivr_url": "https://chart-analytics-api.dhan.co/chart-analytics-api/ivp_ivr",
            "jwt": "",
            "jwt_env": "FNO_DHAN_JWT",
            "entity_id": "",
            "entity_id_env": "FNO_DHAN_ENTITY_ID",
            "client_id": "",
            "client_id_env": "FNO_DHAN_CLIENT_ID",
            "source": "Y",
            "broker_code": "DHN1804",
            "authorisation": "Token",
            "scanx_segments": {"I": 0, "E": 2},
            "analytics_segments": {"0": 0, "2": 1},
        },
    },
    "cache": {
        "ticker_ttl_seconds": 21600,
        "chain_ttl_seconds": 6,
    },
    "chain": {
        "max_strikes": 100,
    },
    "public": {
        "base_url": "",
    },
}


def _merge(target: dict[str, Any], source: dict[str, Any]) -> dict[str, Any]:
    for key, value in source.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            _merge(target[key], value)
        else:
            target[key] = value
    return target


def _resolve_path(value: str | Path, base: Path) -> Path:
    path = Path(value)
    if not path.is_absolute():
        path = base / path
    return path.resolve()


def _env(name: str | None, fallback: Any = "") -> Any:
    if not name:
        return fallback
    value = os.getenv(name)
    return fallback if value is None else value


def _as_int(value: Any, name: str, minimum: int | None = None) -> int:
    try:
        result = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if minimum is not None and result < minimum:
        raise ValueError(f"{name} must be at least {minimum}")
    return result


def load_settings(config_path: str | Path | None = None) -> dict[str, Any]:
    requested = config_path or os.getenv("FNO_CONFIG") or ROOT / "config.json"
    path = Path(requested).expanduser().resolve()
    with path.open("r", encoding="utf-8") as handle:
        raw = json.load(handle)
    settings = _merge(deepcopy(DEFAULTS), raw)

    server = settings["server"]
    server["host"] = os.getenv("FNO_SERVER_HOST", server.get("host", "127.0.0.1"))
    server["port"] = _as_int(os.getenv("FNO_SERVER_PORT", server.get("port", 8000)), "server.port", 1)
    server["request_timeout_seconds"] = _as_int(
        os.getenv("FNO_REQUEST_TIMEOUT_SECONDS", server.get("request_timeout_seconds", 30)),
        "server.request_timeout_seconds",
        1,
    )
    server["refresh_seconds"] = _as_int(
        os.getenv("FNO_REFRESH_SECONDS", server.get("refresh_seconds", 15)),
        "server.refresh_seconds",
        1,
    )
    static_dir = _resolve_path(os.getenv("FNO_STATIC_DIR", server.get("static_dir", "frontend")), path.parent)
    data_dir = _resolve_path(os.getenv("FNO_DATA_DIR", server.get("data_dir", "data")), path.parent)

    providers = settings["providers"]
    aoc = providers["aoc"]
    aoc["base_url"] = str(aoc.get("base_url", "")).rstrip("/")
    aoc["token"] = _env(aoc.get("token_env"), aoc.get("token", "")) or os.getenv("AOC_TOKEN", "")
    dhan = providers["dhan"]
    dhan["jwt"] = _env(dhan.get("jwt_env"), dhan.get("jwt", "")) or os.getenv("DHAN_JWT", "")
    dhan["entity_id"] = _env(dhan.get("entity_id_env"), dhan.get("entity_id", "")) or os.getenv("DHAN_ENTITY_ID", "")
    dhan["client_id"] = _env(dhan.get("client_id_env"), dhan.get("client_id", "")) or os.getenv("DHAN_CLIENT_ID", "")
    dhan["authorisation"] = os.getenv("FNO_DHAN_AUTHORISATION", dhan.get("authorisation", "Token"))

    settings["cache"]["ticker_ttl_seconds"] = _as_int(
        settings["cache"].get("ticker_ttl_seconds", 21600), "cache.ticker_ttl_seconds", 0
    )
    settings["cache"]["chain_ttl_seconds"] = _as_int(
        settings["cache"].get("chain_ttl_seconds", 6), "cache.chain_ttl_seconds", 0
    )
    settings["chain"]["max_strikes"] = _as_int(
        settings["chain"].get("max_strikes", 100), "chain.max_strikes", 1
    )
    settings["public"]["base_url"] = os.getenv("FNO_PUBLIC_BASE_URL", settings["public"].get("base_url", ""))
    settings["config_path"] = str(path)
    settings["static_path"] = str(static_dir)
    settings["data_path"] = str(data_dir)
    settings["map_path"] = str(data_dir / "dhan_map.json")
    return settings
