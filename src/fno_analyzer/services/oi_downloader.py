"""Resumable, paced AOC front-expiry daily archive updates."""
from itertools import chain
from copy import deepcopy
from datetime import date, datetime, time, timedelta
from threading import Event, Lock, Thread
from uuid import uuid4

from ..errors import AppError, ConfigurationError, InvalidParameter, ProviderError, UpstreamNotFound
from ..providers.aoc import parse_payload
from .oi_history import IST, finite
from .oi_calendar import USER_HOLIDAYS
from .symbol_map import ALIASES, _match_row, load_map

NON_STOCKS = {"NIFTY", "NIFTY_2", "NIFTY_M", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX",
              "CRUDEOIL", "NATURALGAS", "COPPER", "GOLD", "SILVER", "SILVERM",
              "BTC", "BTC1", "ETH", "ETH1"}


def expiry_date(value):
    # Explicit day/month ordering; do not use platform date heuristics.
    for fmt in ("%d-%b-%Y", "%Y-%m-%d", "%d-%m-%Y"):
        try:
            return datetime.strptime(str(value), fmt).date()
        except ValueError:
            pass
    raise ValueError("Unrecognized AOC expiry date")


def snapshot_time(snapshot):
    value = finite(snapshot.get("ts"))
    if value is None or value <= 0:
        raise ValueError("Snapshot timestamp missing")
    try:
        return datetime.fromtimestamp(value / 1000 if value > 1e11 else value, IST)
    except (OverflowError, OSError, ValueError) as exc:
        raise ValueError("Snapshot timestamp invalid") from exc


def validate_snapshot(task, data, cutoff):
    snapshot, strikes = data["snapshot"], data["strikes"]
    if not snapshot or not strikes:
        return None, "No snapshot available"
    if str(snapshot.get("s", "")).upper() != task["symbol"]:
        raise ValueError("Returned symbol does not match request")
    if expiry_date(snapshot.get("exp")) != date.fromisoformat(task["expiry"]):
        raise ValueError("Returned expiry does not match request")
    observed = snapshot_time(snapshot)
    if expiry_date(snapshot.get("dt")) != observed.date():
        raise ValueError("Snapshot date and timestamp disagree")
    if observed.date() != date.fromisoformat(task["day"]):
        return None, "No snapshot on requested date; provider returned a different date"
    if observed > cutoff or observed.time() < time(15, 25):
        raise ValueError("Snapshot is outside the daily closing window (15:25–16:00 IST)")
    return observed, None


class OIHistoryUpdater:
    def __init__(self, aoc, store, map_path, symbol_client=None):
        self.aoc, self.store, self.map_path = aoc, store, map_path
        self.symbol_client = symbol_client
        self.store.set_calendar({day: False for day in USER_HOLIDAYS}, "User-supplied holiday dates")
        self.lock = Lock()
        self.stop = Event()
        self.state = {"status": "idle"}

    def snapshot(self):
        with self.lock:
            state = deepcopy(self.state)
        state["archive"] = self.store.cached_status()
        state["request_interval_seconds"] = self.aoc.request_interval
        return state

    def _update(self, **values):
        with self.lock:
            self.state.update(values)

    def start(self):
        if not self.aoc.configured:
            raise ConfigurationError("Configure AOC before updating the archive")
        with self.lock:
            if self.state["status"] == "running":
                raise AppError("An OI history update is already running", code="UPDATE_RUNNING", status=409)
            self.stop.clear()
            self.state = {"id": uuid4().hex, "status": "running", "phase": "expiry discovery",
                          "checked": 0, "total": 0, "saved": 0, "unavailable": 0,
                          "processed": 0, "skipped_tasks": 0, "skipped_days": [],
                          "errors": 0, "symbols": 0, "discovered": 0, "excluded": [],
                          "error": None, "current": None, "scope": "front expiry daily close"}
        Thread(target=self._run, daemon=True, name="oi-history-update").start()
        return self.snapshot()

    def cancel(self, job_id):
        with self.lock:
            if job_id != self.state.get("id"):
                raise InvalidParameter("Unknown OI history update ID")
            if self.state["status"] == "running":
                self.stop.set()
                self.state["phase"] = "cancelling after current request"
        return self.snapshot()

    def _run(self):
        try:
            self._download()
            self._update(status="cancelled" if self.stop.is_set() else "complete",
                         phase="finished", current=None)
        except AppError as exc:
            # Provider messages can include request material; only safe codes are exposed.
            self._update(status="failed", phase="stopped", error=f"Update stopped ({exc.code})", current=None)
        except Exception:
            self._update(status="failed", phase="stopped",
                         error="Archive update failed; check configuration and response format", current=None)

        finally:
            self.store.invalidate_status()

    def _download(self):
        now = datetime.now(IST)
        today = now.date()
        # The closing snapshot request is safe once its 16:00 IST cutoff has passed.
        end = today if now.time() >= time(16) else today - timedelta(days=1)
        try:
            start = today.replace(year=today.year - 1)
        except ValueError:
            start = today.replace(year=today.year - 1, day=28)
        self._update(start=start.isoformat(), end=end.isoformat())
        if self.stop.is_set():
            return
        tickers = self.aoc.get_tickers(force=True)
        mapping = load_map(self.map_path) or {}
        stocks = {row["aoc"].upper() for row in mapping.get("mapped", []) if row.get("seg") == 2}
        excluded_names = NON_STOCKS | {row["aoc"].upper() for row in mapping.get("mapped", []) if row.get("seg") == 0}
        with self.store.connect() as db:
            stocks.update(row[0] for row in db.execute("SELECT symbol FROM universe"))
        for ticker in tickers:
            name = str(ticker.get("Name", "")).upper()
            if name in stocks or name in excluded_names:
                continue
            if self.stop.is_set():
                return
            if self.symbol_client is None:
                raise ConfigurationError("Cannot classify new AOC symbols", code="STOCK_CLASSIFICATION_REQUIRED")
            alias = ALIASES.get(name, name)
            row = _match_row(alias, self.symbol_client.search(alias))
            if row is None:
                raise ConfigurationError("Cannot classify a new AOC symbol", code="STOCK_CLASSIFICATION_REQUIRED")
            if row.get("Seg_s") == "E" and row.get("d_exch_t") == "NSE":
                stocks.add(name)
            elif row.get("Seg_s") == "I":
                excluded_names.add(name)
            else:
                raise ConfigurationError("Unsupported AOC symbol classification", code="STOCK_CLASSIFICATION_REQUIRED")
        universe = [row for row in tickers if str(row.get("Name", "")).upper() in stocks]
        if not universe:
            raise ConfigurationError("No mapped AOC stocks", code="STOCK_MAP_REQUIRED")
        excluded = [str(row.get("Name", "")) for row in tickers if row not in universe]
        self.store.set_universe(universe, today.isoformat())
        self._update(symbols=len(universe), excluded=excluded)
        if self.stop.is_set():
            return
        self._update(current="RELIANCE · shared stock expiry list")
        raw = self.aoc.get_expiries("RELIANCE")
        if self.stop.is_set():
            return
        if not raw:
            # Never reuse stale contracts after failed shared discovery.
            raise ProviderError("No expiry roster", code="AOC_EMPTY_EXPIRIES")
        dated = sorted((expiry_date(value), value) for value in raw)
        if len({day for day, _ in dated}) != len(dated):
            raise ProviderError("Duplicate expiry roster", code="AOC_INVALID_EXPIRIES")
        contracts = []
        previous = None
        for expiry, provider_id in dated:
            # Shared front-expiry selection windows do not imply that each
            # stock was historically listed throughout the window.
            first = max(start, previous + timedelta(days=1)) if previous else start
            if expiry >= start and first <= expiry:
                contracts.append({"expiry": expiry.isoformat(), "provider_id": provider_id,
                                  "first_date": first.isoformat()})
            previous = expiry
        self._update(discovered=1, phase="applying shared expiries")
        for index, ticker in enumerate(universe):
            if self.stop.is_set():
                return
            symbol = str(ticker["Name"]).upper()
            self._update(current=symbol)
            self.store.set_expiries(symbol, contracts,
                "AOC shared RELIANCE expiry roster; front-expiry selection window", replace=True)
            self._update(expiries_applied=index + 1)
        if self.stop.is_set():
            return
        total = self.store.candidate_count(start.isoformat(), end.isoformat())
        tasks = chain.from_iterable(self.store.iter_candidate_days(start.isoformat(), end.isoformat()))
        self._update(phase="daily snapshots", total=total,
                     minimum_seconds=round(total * self.aoc.request_interval))
        saved = absent = errors = checked = skipped_tasks = 0
        skipped_days = []
        current_day = None
        day_fetches = day_unavailable = 0
        skip_day = False
        day_has_data = False
        for index, task in enumerate(tasks):
            if self.stop.is_set():
                return
            if task["day"] != current_day:
                current_day = task["day"]
                day_fetches = day_unavailable = 0
                skip_day = False
                day_has_data = self.store.has_day_data(current_day)
            if skip_day:
                skipped_tasks += 1
                self._update(processed=index + 1, skipped_tasks=skipped_tasks,
                             minimum_seconds=round((total - skipped_tasks) * self.aoc.request_interval))
                continue
            self._update(current=f"{task['symbol']} · {task['day']} · {task['expiry']}")
            unavailable = False
            cutoff = datetime.combine(date.fromisoformat(task["day"]), time(16), IST)
            try:
                payload = self.aoc.fetch_historical(task["symbol"], task["provider_id"],
                                                    int(cutoff.timestamp() * 1000))
                data = parse_payload(payload)
                observed, reason = validate_snapshot(task, data, cutoff)
                if observed is None:
                    self.store.record_attempt(task["symbol"], task["day"], task["expiry"], "unavailable", reason)
                    absent += 1
                    unavailable = True
                else:
                    # A valid timestamp proves this day had trading data. Absence
                    # for one stock cannot prove a market holiday.
                    self.store.set_calendar({task["day"]: True}, "AOC observed snapshot")
                    self.store.ingest(task["symbol"], task["day"], task["expiry"],
                                      observed.isoformat(), data["snapshot"], data["strikes"])
                    saved += 1
                    day_has_data = True
            except UpstreamNotFound:
                self.store.record_attempt(task["symbol"], task["day"], task["expiry"],
                                          "unavailable", "AOC historical resource not found")
                absent += 1
                unavailable = True
            except AppError:
                # Stop on transport/config/auth/rate-limit failures instead of
                # repeating the same failing request across thousands of stocks.
                self.store.record_attempt(task["symbol"], task["day"], task["expiry"], "error", "Provider request failed")
                raise
            except ValueError:
                self.store.record_attempt(task["symbol"], task["day"], task["expiry"], "error", "Invalid or incomplete daily snapshot")
                errors += 1
            checked += 1
            day_fetches += 1
            day_unavailable += int(unavailable)
            if day_fetches == 6 and day_unavailable == 6 and not day_has_data:
                skip_day = self.store.record_day_skip(current_day)
                if skip_day:
                    skipped_days.append(current_day)
            self._update(checked=checked, processed=index + 1, saved=saved, unavailable=absent,
                         errors=errors, skipped_tasks=skipped_tasks, skipped_days=skipped_days)
