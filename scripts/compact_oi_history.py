"""Offline OI archive backup, migration, verification and disk compaction.

Stop the application before running. The backup is retained on success or failure.
"""
import argparse
import logging
from contextlib import closing
from itertools import zip_longest
from pathlib import Path
import sqlite3
import sys
from time import monotonic

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from fno_analyzer.services.oi_history import OIHistoryStore


def verify_archive(backup, database):
    with closing(sqlite3.connect(backup.as_uri() + "?mode=ro", uri=True)) as old, \
         closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as new:
        if new.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("Migrated archive integrity check failed; backup retained")
        for table in ("universe", "calendar", "expiries", "attempts", "day_skips"):
            columns = list(old.execute(f"PRAGMA table_info({table})"))
            if not columns:
                continue  # pre-v3 backups need not have day_skips
            order = ",".join(r[1] for r in sorted(columns, key=lambda r: r[5]) if r[5])
            projection = ",".join(r[1] for r in columns)
            query = f"SELECT {projection} FROM {table} ORDER BY {order}"
            for a, b in zip_longest(old.execute(query), new.execute(query)):
                if a != b:
                    raise ValueError(f"Archive metadata differs: {table}")
        chains = "SELECT * FROM chains ORDER BY symbol,day,expiry"
        for a, b in zip_longest(old.execute(chains), new.execute(chains)):
            if a is None or b is None or a[:11] != b[:11] or a[12:] != b[12:]:
                raise ValueError("Archived chain metadata differs")
            if OIHistoryStore.decode_payload(a[11]) != OIHistoryStore.decode_payload(b[11]):
                raise ValueError("Archived raw provider fields differ")
            # Check every preexisting numeric strike; legacy missing projections may be added.
            query = "SELECT * FROM option_strikes WHERE symbol=? AND day=? AND expiry=? ORDER BY strike"
            projections = {r[3]: r[:-1] for r in new.execute(query, a[:3])}
            if old.execute("SELECT 1 FROM sqlite_master WHERE name='option_strikes'").fetchone():
                for strike in old.execute(query, a[:3]):
                    if projections.get(strike[3]) != strike[:-1]:
                        raise ValueError("Archived numeric strike fields differ")


def compact(database, backup):
    database, backup = Path(database).resolve(), Path(backup).resolve()
    if not database.is_file():
        raise ValueError("Archive does not exist")
    if backup == database or backup.exists():
        raise ValueError("Choose a new backup filename; existing files are never overwritten")
    backup.parent.mkdir(parents=True, exist_ok=True)
    before = database.stat().st_size
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as source, \
         closing(sqlite3.connect(backup)) as target:
        reported = monotonic()
        started = reported
        def progress(status, remaining, total):
            nonlocal reported
            now = monotonic()
            if now - reported >= 5:
                print("Backup pages:", total - remaining, "/", total,
                      "SQLite status:", status, flush=True)
                reported = now
            if status in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED) and now - started > 30:
                raise RuntimeError("Backup blocked by database locks; stop all archive users and retry")
        source.backup(target, pages=256, progress=progress)
    print("Backup saved:", backup, flush=True)
    print("Migrating archive in bounded transactions", flush=True)
    store = OIHistoryStore(database)
    verify_archive(backup, database)
    print("All raw provider fields, metadata and existing numeric strikes verified", flush=True)
    with closing(sqlite3.connect(database)) as db:
        db.execute("VACUUM")
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("Compacted archive integrity check failed; backup retained")
    print("Archive bytes:", before, "->", database.stat().st_size, flush=True)
    print("Saved chains:", store.status()["chains"], flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True)
    parser.add_argument("--backup", required=True)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    compact(args.database, args.backup)
