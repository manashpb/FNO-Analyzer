"""Temporary, acquisition-dated Dhan EOD collection; never backfills past dates."""
from datetime import datetime, time
from random import uniform
import json

from .oi_downloader import OIHistoryUpdater, expiry_date
from .oi_calendar import USER_HOLIDAYS
from .oi_history import IST
from .symbol_map import load_map
from ..errors import ConfigurationError, ProviderError
from ..providers.dhan import normalize_dhan_chain


class DhanEODUpdater(OIHistoryUpdater):
    provider_name = 'dhan-temporary'

    def _download(self):
        now = datetime.now(IST)
        day = now.date().isoformat()
        if now.weekday() >= 5 or day in USER_HOLIDAYS:
            raise ConfigurationError('No EOD collection on a configured non-trading day')
        close = now.replace(hour=16, minute=0, second=0, microsecond=0)
        if now < close:
            self._update(phase='waiting for 16:00 IST', scope='today only; temporary Dhan EOD')
            if self.stop.wait((close - now).total_seconds()):
                return
        entries = [e for e in (load_map(self.map_path) or {}).get('mapped', [])
                   if int(e.get('seg', -1)) == 2 and e.get('aoc')]
        entries = list({e['aoc']: e for e in entries}.values())
        if not entries:
            raise ConfigurationError('Saved Dhan stock map is required; no AOC discovery is performed')
        self._update(phase='temporary Dhan EOD', total=len(entries), symbols=len(entries),
                     scope='today only; acquisition time, exchange timestamp unavailable')
        saved = skipped = 0
        for index, entry in enumerate(entries):
            if self.stop.is_set():
                return
            if datetime.now(IST).date().isoformat() != day:
                raise ProviderError('EOD collection crossed midnight; stopped')
            symbol = entry['aoc']
            with self.store.connect() as db:
                exists = db.execute('SELECT 1 FROM chains WHERE symbol=? AND day=?', (symbol, day)).fetchone()
                meta = db.execute('SELECT metadata FROM universe WHERE symbol=?', (symbol,)).fetchone()
            if exists:
                skipped += 1
            else:
                if index and self.stop.wait(uniform(6, 9)):
                    return
                self._update(current=symbol)
                raw = self.aoc.option_chain(int(entry['seg']), int(entry['sid']), -1)
                acquired = datetime.now(IST)
                if acquired.date().isoformat() != day:
                    raise ProviderError('EOD collection crossed midnight; stopped')
                chain = normalize_dhan_chain(raw, symbol, 100)
                snapshot, strikes = chain['snapshot'], chain['_all_strikes']
                if not strikes or not snapshot.get('uv'):
                    raise ProviderError('Dhan returned an empty EOD chain')
                expiry = expiry_date(snapshot.get('exp')).isoformat()
                if expiry < day:
                    raise ProviderError('Dhan returned an expired EOD contract')
                snapshot.update(source='dhan-eod-temporary', timestamp_kind='snapshot-acquisition',
                                acquired_at=acquired.isoformat(), source_observed_at=None,
                                unit_basis='Raw provider OI; cross-provider comparability unverified',
                                dt=acquired.strftime('%d-%b-%Y'))
                # Preserve the archive's raw/unknown unit basis for requested Z-scores.
                # Retain the temporary source and the unverified comparability explicitly.
                with self.store.connect() as db:
                    db.execute('INSERT OR IGNORE INTO universe VALUES(?,?,?,?,?)',
                               (symbol, json.dumps({'Name': symbol, 'source': 'Dhan saved map'}), day, day, 1))
                    db.execute('INSERT OR IGNORE INTO calendar VALUES(?,?,?)',
                               (day, 1, 'Temporary Dhan EOD acquisition on configured trading day'))
                    db.execute('INSERT OR IGNORE INTO expiries VALUES(?,?,?,?,?)',
                               (symbol, expiry, expiry, day, 'Temporary Dhan front-expiry snapshot'))
                lot = json.loads(meta[0]).get('Lot') if meta else None
                self.store.ingest(symbol, day, expiry, acquired.isoformat(), snapshot, strikes,
                                  lot_size=lot, oi_unit='unknown')
                saved += 1
            self._update(processed=index + 1, checked=saved, saved=saved, skipped_tasks=skipped)
        if not self.stop.is_set() and getattr(self, 'rebuild_scores', None):
            self._update(phase='recalculating ATM OI Z-scores')
            self.rebuild_scores()
