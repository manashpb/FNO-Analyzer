"""Persistent daily option-chain archive, independent of the provider transport.

Only ingest confirmed daily snapshots. A downloader must supply the actual
observation date, historical contract roster and verified exchange calendar.
"""
from datetime import date, datetime, timedelta
from contextlib import contextmanager
import json
import logging
import math
from pathlib import Path
import sqlite3
import zlib
from copy import deepcopy
from threading import Lock
from time import monotonic
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
LOG = logging.getLogger(__name__)
MAX_ERROR_ATTEMPTS = 3


def finite(value):
    if isinstance(value, bool):
        return None
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):
        return None


class OIHistoryStore:
    def __init__(self, path):
        self.path = Path(path)
        self._status_lock = Lock()
        self._status_cache = None
        self._status_at = 0
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version > 5:
                raise ValueError("OI archive schema is newer than this application")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS universe (
                    symbol TEXT PRIMARY KEY, metadata TEXT NOT NULL,
                    first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, active INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS calendar (
                    day TEXT PRIMARY KEY, trading INTEGER NOT NULL, source TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS expiries (
                    symbol TEXT NOT NULL, expiry TEXT NOT NULL, provider_id TEXT NOT NULL,
                    first_date TEXT NOT NULL, source TEXT NOT NULL,
                    PRIMARY KEY(symbol, expiry));
                CREATE TABLE IF NOT EXISTS chains (
                    symbol TEXT NOT NULL, day TEXT NOT NULL, expiry TEXT NOT NULL,
                    observed_at TEXT NOT NULL, calendar_dte INTEGER NOT NULL,
                    spot REAL NOT NULL, atm_strike REAL NOT NULL,
                    call_oi REAL, put_oi REAL, lot_size REAL, oi_unit TEXT NOT NULL,
                    payload TEXT NOT NULL, fetched_at TEXT NOT NULL,
                    PRIMARY KEY(symbol, day, expiry));
                CREATE INDEX IF NOT EXISTS chains_dte ON chains(symbol, calendar_dte, expiry);
                CREATE INDEX IF NOT EXISTS chains_day ON chains(day);
                CREATE TABLE IF NOT EXISTS option_strikes (
                    symbol TEXT NOT NULL, day TEXT NOT NULL, expiry TEXT NOT NULL,
                    strike REAL NOT NULL, call_oi REAL, put_oi REAL,
                    call_oi_change REAL, put_oi_change REAL,
                    call_volume REAL, put_volume REAL, call_price REAL, put_price REAL,
                    call_iv REAL, put_iv REAL, call_delta REAL, put_delta REAL,
                    call_gamma REAL, put_gamma REAL, call_theta REAL, put_theta REAL,
                    call_vega REAL, put_vega REAL, fields TEXT NOT NULL,
                    PRIMARY KEY(symbol, day, expiry, strike));
                CREATE TABLE IF NOT EXISTS attempts (
                    symbol TEXT NOT NULL, day TEXT NOT NULL, expiry TEXT NOT NULL,
                    status TEXT NOT NULL, reason TEXT NOT NULL,
                    PRIMARY KEY(symbol, day, expiry));
                CREATE TABLE IF NOT EXISTS day_skips (
                    day TEXT PRIMARY KEY, reason TEXT NOT NULL,
                    sample_count INTEGER NOT NULL, recorded_at TEXT NOT NULL);
            """)
        if version < 4:
            self._migrate_raw_storage()
        with self.connect() as db:
            columns = {row["name"] for row in db.execute("PRAGMA table_info(attempts)")}
            if "error_count" not in columns:
                db.execute("ALTER TABLE attempts ADD COLUMN error_count INTEGER NOT NULL DEFAULT 0")
                db.execute("UPDATE attempts SET error_count=1 WHERE status='error'")
            db.execute("PRAGMA user_version=5")

    @staticmethod
    def decode_payload(value):
        """Read legacy JSON text or schema-v4 zlib-compressed UTF-8 JSON."""
        if isinstance(value, bytes):
            value = zlib.decompress(value).decode("utf-8")
        return json.loads(value)

    @staticmethod
    def encode_payload(value):
        return zlib.compress(json.dumps(value, allow_nan=False,
                                        separators=(",", ":")).encode("utf-8"))

    def read_chain(self, symbol, day, expiry):
        """Decode only the requested chain, including every original provider field."""
        with self.connect() as db:
            row = db.execute("SELECT payload FROM chains WHERE symbol=? AND day=? AND expiry=?",
                             (symbol.upper(), day, expiry)).fetchone()
        return self.decode_payload(row[0]) if row else None

    def heatmap(self, symbol, expiry=""):
        """Local projections only; dates need archived or sourced trading evidence."""
        symbol = symbol.upper()
        with self.connect() as db:
            expiries = [r[0] for r in db.execute(
                "SELECT expiry FROM expiries WHERE symbol=? UNION SELECT expiry FROM chains WHERE symbol=? ORDER BY expiry",
                (symbol, symbol))]
            selected = expiry or (expiries[-1] if expiries else "")
            if selected not in expiries:
                return {"expiries": expiries, "expiry": selected, "dates": [], "strikes": [], "days": [],
                        "reason": "No archived expiry available. Use Scanners → Data update."}
            previous = max((e for e in expiries if e < selected), default=None)
            if previous is None:
                return {"expiries": expiries, "expiry": selected, "dates": [], "strikes": [], "days": [],
                        "reason": "Previous expiry is unavailable; cycle boundaries cannot be verified."}
            dates = [r[0] for r in db.execute(
                "SELECT DISTINCT day FROM chains WHERE day BETWEEN ? AND ? UNION SELECT day FROM calendar WHERE trading=1 AND day BETWEEN ? AND ? ORDER BY day",
                (previous, selected, previous, selected))]
            meta = db.execute("SELECT metadata FROM universe WHERE symbol=?", (symbol,)).fetchone()
            current_lot = finite(json.loads(meta[0]).get("Lot")) if meta else None
            rows = db.execute("SELECT day,spot,atm_strike,lot_size,oi_unit FROM chains WHERE symbol=? AND expiry=? AND day BETWEEN ? AND ? ORDER BY day",
                              (symbol, selected, previous, selected)).fetchall()
            days = {r["day"]: {"date": r["day"], "spot": r["spot"], "atm": r["atm_strike"],
                              "lot_size": r["lot_size"] if r["lot_size"] and r["lot_size"] > 0 else current_lot,
                              "lot_basis": "archived" if r["lot_size"] and r["lot_size"] > 0 else "ticker metadata",
                              "oi_unit": r["oi_unit"], "cells": []} for r in rows}
            strikes = set()
            for r in db.execute("SELECT day,strike,call_oi,put_oi FROM option_strikes WHERE symbol=? AND expiry=? AND day BETWEEN ? AND ? ORDER BY day,strike",
                                (symbol, selected, previous, selected)):
                if r["day"] in days:
                    strikes.add(r["strike"])
                    day = days[r["day"]]
                    def lots(value):
                        value = finite(value)
                        if value is None or value < 0:
                            return None
                        if day["oi_unit"] == "lots":
                            return value
                        lot = day["lot_size"]
                        return value / lot if lot and lot > 0 else None
                    day["cells"].append([r["strike"], lots(r["call_oi"]), lots(r["put_oi"])])
        return {"expiries": expiries, "expiry": selected, "previous_expiry": previous,
                "dates": dates, "strikes": sorted(strikes), "days": list(days.values()),
                "reason": "" if days else "No closing chains for this cycle. Use Scanners → Data update."}

    def _migrate_raw_storage(self, batch_size=32):
        # Keyset batches bound payload memory. Each commit is independently resumable.
        last = None
        processed = 0
        while True:
            with self.connect() as db:
                where = "WHERE (symbol,day,expiry) > (?,?,?)" if last else ""
                rows = db.execute(f"SELECT symbol,day,expiry,payload FROM chains {where} "
                                  "ORDER BY symbol,day,expiry LIMIT ?",
                                  (*last, batch_size) if last else (batch_size,)).fetchall()
                if not rows:
                    db.execute("PRAGMA user_version=4")
                    LOG.info("OI archive storage migration complete (%s chains)", processed)
                    return
                for row in rows:
                    key = tuple(row[:3])
                    # Previously committed v4 chains already have their projections.
                    if isinstance(row["payload"], bytes):
                        continue
                    raw = self.decode_payload(row["payload"])
                    strikes = {finite(r.get("sp")): r for r in raw["strikes"]
                               if finite(r.get("sp")) is not None and finite(r.get("sp")) > 0}
                    # Refuse to discard legacy fields if they differ from the raw chain.
                    projected = set()
                    for strike in db.execute("SELECT strike,fields FROM option_strikes "
                                             "WHERE symbol=? AND day=? AND expiry=?", key):
                        if json.loads(strike["fields"]) != strikes.get(strike["strike"]):
                            raise ValueError("Legacy strike fields differ from archived chain")
                        projected.add(strike["strike"])
                    self._write_strikes(db, *key, [r for value, r in strikes.items() if value not in projected])
                    db.execute("UPDATE option_strikes SET fields='{}' "
                               "WHERE symbol=? AND day=? AND expiry=?", key)
                    db.execute("UPDATE chains SET payload=? WHERE symbol=? AND day=? AND expiry=?",
                               (self.encode_payload(raw), *key))
                last = tuple(rows[-1][:3])
            processed += len(rows)
            if processed % 512 == 0:
                LOG.info("OI archive storage migration: %s chains processed", processed)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def set_universe(self, stocks, as_of):
        day = date.fromisoformat(as_of).isoformat()
        symbols = [str(row["Name"]).upper() for row in stocks]
        if not symbols or len(symbols) != len(set(symbols)):
            raise ValueError("Supply a nonempty, unique, verified stock universe")
        with self.connect() as db:
            db.execute("UPDATE universe SET active=0")
            for symbol, row in zip(symbols, stocks):
                db.execute("""INSERT INTO universe VALUES(?,?,?,?,1)
                    ON CONFLICT(symbol) DO UPDATE SET metadata=excluded.metadata,
                    last_seen=excluded.last_seen, active=1""",
                    (symbol, json.dumps(row, allow_nan=False), day, day))

    def set_calendar(self, days, source):
        if not source:
            raise ValueError("Calendar provenance required")
        with self.connect() as db:
            for day, trading in days.items():
                if not isinstance(trading, bool):
                    raise ValueError("Calendar flags must be boolean")
                db.execute("INSERT OR REPLACE INTO calendar VALUES(?,?,?)",
                           (date.fromisoformat(day).isoformat(), int(trading), source))

    def set_expiries(self, symbol, contracts, source, replace=False):
        with self.connect() as db:
            if replace:
                db.execute("DELETE FROM expiries WHERE symbol=?", (symbol.upper(),))
            for contract in contracts:
                expiry = date.fromisoformat(contract["expiry"])
                start = date.fromisoformat(contract["first_date"])
                if start > expiry or not source:
                    raise ValueError("Invalid contract availability or provenance")
                db.execute("INSERT OR REPLACE INTO expiries VALUES(?,?,?,?,?)",
                           (symbol.upper(), expiry.isoformat(), str(contract["provider_id"]),
                            start.isoformat(), source))

    def ingest(self, symbol, day, expiry, observed_at, snapshot, strikes,
               lot_size=None, oi_unit="unknown"):
        day_date, expiry_date = date.fromisoformat(day), date.fromisoformat(expiry)
        observed = datetime.fromisoformat(observed_at)
        if observed.tzinfo is None or observed.astimezone(IST).date() != day_date:
            raise ValueError("Snapshot timestamp must match observation date in IST")
        if day_date > expiry_date:
            raise ValueError("Snapshot is after expiry")
        spot = finite(snapshot.get("uv"))
        valid = [(finite(row.get("sp")), row) for row in strikes]
        valid = [(strike, row) for strike, row in valid if strike is not None and strike > 0]
        if not spot or spot <= 0 or not valid:
            raise ValueError("Valid spot and full chain required")
        if len({strike for strike, _ in valid}) != len(valid):
            raise ValueError("Duplicate strikes")
        atm, row = min(valid, key=lambda item: (abs(item[0] - spot), item[0]))
        call, put = finite(row.get("cOI")), finite(row.get("pOI"))
        if any(value is not None and value < 0 for value in (call, put)):
            raise ValueError("Negative OI")
        payload = self.encode_payload({"snapshot": snapshot, "strikes": strikes})
        with self.connect() as db:
            trading = db.execute("SELECT trading FROM calendar WHERE day=?", (day,)).fetchone()
            contract = db.execute("SELECT first_date FROM expiries WHERE symbol=? AND expiry=?",
                                  (symbol.upper(), expiry)).fetchone()
            if not trading or not trading[0] or not contract or day < contract[0]:
                raise ValueError("Verified trading date and available contract required")
            db.execute("INSERT OR REPLACE INTO chains VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       (symbol.upper(), day, expiry, observed.isoformat(), (expiry_date-day_date).days,
                        spot, atm, call, put, finite(lot_size), oi_unit, payload,
                        datetime.now(IST).isoformat()))
            db.execute("DELETE FROM attempts WHERE symbol=? AND day=? AND expiry=?",
                       (symbol.upper(), day, expiry))
            db.execute("DELETE FROM option_strikes WHERE symbol=? AND day=? AND expiry=?",
                       (symbol.upper(), day, expiry))
            self._write_strikes(db, symbol.upper(), day, expiry, strikes)

    @staticmethod
    def _write_strikes(db, symbol, day, expiry, strikes):
        keys = ("cOI", "pOI", "cOIC", "pOIC", "cVol", "pVol", "cLtp", "pLtp",
                "cIV", "pIV", "cD", "pD", "cG", "pG", "cTh", "pTh", "cV", "pV")
        for row in strikes:
            strike = finite(row.get("sp"))
            if strike is None or strike <= 0:
                continue
            values = (symbol, day, expiry, strike, *(finite(row.get(key)) for key in keys),
                      '{}')
            db.execute(f"INSERT OR REPLACE INTO option_strikes VALUES({','.join('?' for _ in values)})", values)

    def record_attempt(self, symbol, day, expiry, status, reason=""):
        if status not in ("unavailable", "error"):
            raise ValueError("Invalid attempt status")
        date.fromisoformat(day)
        date.fromisoformat(expiry)
        with self.connect() as db:
            db.execute("""INSERT INTO attempts(symbol,day,expiry,status,reason,error_count)
                VALUES(?,?,?,?,?,?) ON CONFLICT(symbol,day,expiry) DO UPDATE SET
                status=excluded.status, reason=excluded.reason,
                error_count=attempts.error_count + excluded.error_count""",
                       (symbol.upper(), day, expiry, status, reason, int(status == "error")))

    def has_day_data(self, day):
        with self.connect() as db:
            return db.execute("SELECT 1 FROM chains WHERE day=? LIMIT 1", (day,)).fetchone() is not None

    def record_day_skip(self, day, sample_count=6):
        date.fromisoformat(day)
        with self.connect() as db:
            if db.execute("SELECT 1 FROM chains WHERE day=? LIMIT 1", (day,)).fetchone():
                return False
            db.execute("INSERT OR REPLACE INTO day_skips VALUES(?,?,?,?)",
                       (day, "First six stock fetches unavailable", sample_count, datetime.now(IST).isoformat()))
        return True

    def plan(self, start, end):
        """Per-contract missing dates, including holes; errors have bounded retries.

        Missing calendar dates block planning: weekdays are not a holiday calendar.
        Explicit provider-unavailable dates are retained and not repeatedly fetched.
        """
        first, last = date.fromisoformat(start), date.fromisoformat(end)
        if first > last:
            raise ValueError("Start must precede end")
        with self.connect() as db:
            calendar = {row["day"]: row["trading"] for row in db.execute(
                "SELECT * FROM calendar WHERE day BETWEEN ? AND ?", (start, end))}
            day = first
            while day <= last:
                if day.isoformat() not in calendar:
                    raise ValueError(f"Missing verified calendar date: {day}")
                day += timedelta(days=1)
            return [dict(row) for row in db.execute("""
                SELECT e.symbol, c.day, e.expiry, e.provider_id FROM expiries e
                JOIN universe u ON u.symbol=e.symbol AND u.active=1
                JOIN calendar c ON c.trading=1 AND c.day BETWEEN e.first_date AND e.expiry
                WHERE c.day BETWEEN ? AND ?
                AND NOT EXISTS (SELECT 1 FROM chains h WHERE h.symbol=e.symbol
                    AND h.expiry=e.expiry AND h.day=c.day)
                AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.symbol=e.symbol
                    AND a.expiry=e.expiry AND a.day=c.day
                    AND (a.status='unavailable' OR a.error_count>=?))
                AND NOT EXISTS (SELECT 1 FROM day_skips d WHERE d.day=c.day)
                ORDER BY c.day, e.symbol, e.expiry""", (start, end, MAX_ERROR_ATTEMPTS))]

    def status(self):
        with self.connect() as db:
            return {"schema_version": 5, "max_error_attempts": MAX_ERROR_ATTEMPTS,
                    "retry_exhausted": db.execute(
                        "SELECT COUNT(*) FROM attempts WHERE status='error' AND error_count>=?",
                        (MAX_ERROR_ATTEMPTS,)).fetchone()[0],
                    "chains": db.execute("SELECT COUNT(*) FROM chains").fetchone()[0],
                    "strike_rows": db.execute("SELECT COUNT(*) FROM option_strikes").fetchone()[0],
                    "coverage": [dict(row) for row in db.execute("""SELECT symbol,
                        MIN(day) first_date, MAX(day) last_date, COUNT(*) snapshots
                        FROM chains GROUP BY symbol ORDER BY symbol""")],
                    "attempts": [dict(row) for row in db.execute(
                        "SELECT status, COUNT(*) count FROM attempts GROUP BY status")],
                    "day_skips": [dict(row) for row in db.execute(
                        "SELECT day,reason,sample_count FROM day_skips ORDER BY day")],
                    "holiday_dates": [row[0] for row in db.execute(
                        "SELECT day FROM calendar WHERE trading=0 AND source='User-supplied holiday dates' ORDER BY day")]}

    def cached_status(self, ttl=30):
        """Share summaries across HTTP polling threads; returned values are isolated."""
        with self._status_lock:
            now = monotonic()
            if self._status_cache is None or now - self._status_at >= ttl:
                self._status_cache = self.status()
                self._status_at = monotonic()
            return deepcopy(self._status_cache)

    def invalidate_status(self):
        with self._status_lock:
            self._status_cache = None

    def iter_candidate_days(self, start, end):
        """SQL excludes saved/absent dates; only one day's tasks enter memory.

        Connections close before yielding, so provider waits never hold read locks.
        Unknown calendar dates remain candidates, never assumed trading sessions.
        """
        first, last = date.fromisoformat(start), date.fromisoformat(end)
        if first > last:
            raise ValueError("Start must precede end")
        day = first
        while day <= last:
            value = day.isoformat()
            with self.connect() as db:
                tasks = [dict(row) for row in db.execute("""
                    SELECT e.symbol, ? AS day, e.expiry, e.provider_id FROM expiries e
                    JOIN universe u ON u.symbol=e.symbol AND u.active=1
                    WHERE ? BETWEEN e.first_date AND e.expiry
                    AND NOT EXISTS (SELECT 1 FROM chains h WHERE h.symbol=e.symbol
                        AND h.day=? AND h.expiry=e.expiry)
                    AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.symbol=e.symbol
                        AND a.day=? AND a.expiry=e.expiry
                        AND (a.status='unavailable' OR a.error_count>=?))
                    AND NOT EXISTS (SELECT 1 FROM calendar c WHERE c.day=? AND c.trading=0)
                    AND NOT EXISTS (SELECT 1 FROM day_skips d WHERE d.day=?)
                    ORDER BY e.symbol,e.expiry""",
                    (value, value, value, value, MAX_ERROR_ATTEMPTS, value, value))]
            if tasks:
                yield tasks
            day += timedelta(days=1)

    def candidate_count(self, start, end):
        return sum(len(tasks) for tasks in self.iter_candidate_days(start, end))

    def candidate_plan(self, start, end):
        """Compatibility helper; background updates use the bounded iterator."""
        return [task for tasks in self.iter_candidate_days(start, end) for task in tasks]

    def session_dte(self, day, expiry):
        """Sessions after observation through expiry; expiry-day DTE is zero."""
        first, last = date.fromisoformat(day), date.fromisoformat(expiry)
        if first > last:
            raise ValueError("Observation is after expiry")
        with self.connect() as db:
            rows = list(db.execute("SELECT trading FROM calendar WHERE day>? AND day<=?", (day, expiry)))
        return sum(row[0] for row in rows) if len(rows) == (last-first).days else None
