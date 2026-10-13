"""Stored ATM OI baselines and closing scores; no provider requests."""
import calendar
from copy import deepcopy
from datetime import date, datetime
import json
import logging
from statistics import mean, stdev
from threading import Lock, Thread

from ..errors import AppError
from .oi_history import IST, finite
from .oi_downloader import expiry_date, NON_STOCKS

PERIODS = (3, 6, 12)
MIN_SAMPLES = 3
LOG = logging.getLogger(__name__)


def months_before(day, months):
    year, month = divmod(day.year * 12 + day.month - 1 - months, 12)
    month += 1
    return day.replace(year=year, month=month,
                       day=min(day.day, calendar.monthrange(year, month)[1]))


def baseline(rows, day, expiry, dte, months, side):
    cutoff = months_before(day, months).isoformat()
    # Earlier observations have larger DTEs. Never look forward toward expiry.
    selected = {}
    for r in rows:
        actual_dte = r['calendar_dte']
        if not (cutoff <= r['day'] < day.isoformat() and r['expiry'] < expiry):
            continue
        if actual_dte != dte and (dte <= 1 or actual_dte < dte):
            continue
        previous = selected.get(r['expiry'])
        if previous is None or actual_dte < previous['calendar_dte']:
            selected[r['expiry']] = r
    # Select the observation before validating either leg so CE/PE share dates.
    samples = [dict(day=r['day'], expiry=r['expiry'], atm_strike=r['atm_strike'],
                    dte=r['calendar_dte'], target_dte=dte,
                    fallback=r['calendar_dte'] != dte,
                    oi=r[side], oi_unit=r['oi_unit'], lot_size=r['lot_size'])
               for r in sorted(selected.values(), key=lambda r: r['day'])
               if finite(r[side]) is not None and r[side] >= 0]
    values = [r['oi'] for r in samples]
    units = {r['oi_unit'] for r in samples}
    lots = {r['lot_size'] for r in samples if r['lot_size'] is not None}
    reason = ('Incompatible OI units' if len(units) > 1 else
              'Historical lot size changed' if len(lots) > 1 else
              'Fewer than 3 qualifying prior expiries' if len(values) < MIN_SAMPLES else None)
    sd = stdev(values) if len(values) >= MIN_SAMPLES else None
    if reason is None and sd == 0:
        reason = 'Zero historical variance'
    return dict(n=len(values), mean=mean(values) if values else None, sd=sd,
                samples=samples, reason=reason, cutoff=cutoff)


def score(stats, oi):
    result = deepcopy(stats)
    oi = finite(oi)
    result['oi'] = oi
    result['z'] = None
    if oi is None or oi < 0:
        result['reason'] = 'ATM OI unavailable'
    if result['reason'] is None:
        value = (oi - stats['mean']) / stats['sd']
        result['z'] = finite(value)
        if result['z'] is None:
            result['reason'] = 'Nonfinite score'
    return result


class OIZScoreService:
    def __init__(self, store):
        self.store = store
        self.lock = Lock()
        self.state = dict(status='idle', processed=0, total=0, error=None)
        with store.connect() as db:
            db.executescript('''
                CREATE INDEX IF NOT EXISTS chains_z_updated ON chains(fetched_at);
                CREATE TABLE IF NOT EXISTS oi_z_baselines (
                    symbol TEXT, dte INTEGER, months INTEGER, payload TEXT NOT NULL,
                    PRIMARY KEY(symbol,dte,months));
                CREATE TABLE IF NOT EXISTS oi_z_scores (
                    symbol TEXT PRIMARY KEY, payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS oi_z_meta (
                    id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
            ''')

    def snapshot(self):
        with self.lock:
            result = deepcopy(self.state)
        with self.store.connect() as db:
            meta = db.execute('SELECT payload FROM oi_z_meta WHERE id=1').fetchone()
            result['stored'] = json.loads(meta[0]) if meta else None
            source = db.execute('SELECT COUNT(*),MAX(fetched_at) FROM chains').fetchone()
            result['needs_update'] = not result['stored'] or (
                result['stored']['as_of'] != datetime.now(IST).date().isoformat()
                or result['stored'].get('dte_policy') != 'previous_available_except_0_1'
                or result['stored']['source_count'] != source[0]
                or result['stored']['source_last'] != source[1])
            result['rows'] = [json.loads(r[0]) for r in db.execute(
                'SELECT payload FROM oi_z_scores ORDER BY symbol')]
        return result

    def start(self):
        with self.lock:
            if self.state['status'] == 'running':
                raise AppError('Z-score update already running', code='ZSCORE_BUSY', status=409)
            self.state = dict(status='running', processed=0, total=0, error=None)
        Thread(target=self._run, daemon=True, name='oi-zscore').start()
        return self.snapshot()

    def _run(self):
        try:
            self.rebuild()
            with self.lock:
                self.state['status'] = 'completed'
        except Exception:
            LOG.exception('Z-score rebuild failed')
            with self.lock:
                self.state.update(status='failed', error='Z-score update failed; previous stored results retained')

    def rebuild(self, today=None):
        today = today or datetime.now(IST).date()
        # Copy only numeric projections in a consistent read; never decode chain BLOBs.
        with self.store.connect() as db:
            rows = [dict(r) for r in db.execute('''SELECT c.symbol,c.day,c.expiry,
                c.calendar_dte,c.atm_strike,c.call_oi,c.put_oi,c.oi_unit,c.lot_size
                FROM chains c JOIN universe u ON u.symbol=c.symbol WHERE u.active=1
                AND c.day>=? AND c.day<? ORDER BY c.symbol,c.day''',
                (months_before(today, 24).isoformat(), today.isoformat()))]
            source_count = db.execute('SELECT COUNT(*) FROM chains').fetchone()[0]
            source_last = db.execute('SELECT MAX(fetched_at) FROM chains').fetchone()[0]
        grouped = {}
        for row in rows:
            if row['symbol'] not in NON_STOCKS:
                grouped.setdefault(row['symbol'], []).append(row)
        with self.lock:
            self.state['total'] = len(grouped)
        stored_baselines, stored_scores = [], []
        for symbol, history in grouped.items():
            target = history[-1]
            day = date.fromisoformat(target['day'])
            periods = {}
            for months in PERIODS:
                periods[str(months)] = {label: score(baseline(history, day, target['expiry'],
                    target['calendar_dte'], months, side), target[side])
                    for label, side in [('ce', 'call_oi'), ('pe', 'put_oi')]}
            stored_scores.append((symbol, json.dumps(dict(symbol=symbol, day=target['day'],
                expiry=target['expiry'], dte=target['calendar_dte'], atm_strike=target['atm_strike'],
                periods=periods), allow_nan=False)))
            # All observed DTEs plus a complete front-month range with previous-observation fallback.
            for dte in sorted(set(range(63)) | {r['calendar_dte'] for r in history}):
                for months in PERIODS:
                    stats = {label: baseline(history, today, today.isoformat(), dte, months, side)
                             for label, side in [('ce', 'call_oi'), ('pe', 'put_oi')]}
                    stored_baselines.append((symbol, dte, months, json.dumps(stats, allow_nan=False)))
            with self.lock:
                self.state['processed'] += 1
        meta = dict(as_of=today.isoformat(), updated_at=datetime.now(IST).isoformat(),
                    source_count=source_count, source_last=source_last, stocks=len(grouped),
                    method='sample', minimum_samples=MIN_SAMPLES, oi_basis='raw', expiry_class='monthly',
                    dte_policy='previous_available_except_0_1')
        # Atomic replacement preserves the previous generation on failure/restart.
        with self.store.connect() as db:
            db.execute('DELETE FROM oi_z_baselines')
            db.execute('DELETE FROM oi_z_scores')
            db.executemany('INSERT INTO oi_z_baselines VALUES(?,?,?,?)', stored_baselines)
            db.executemany('INSERT INTO oi_z_scores VALUES(?,?)', stored_scores)
            db.execute('INSERT OR REPLACE INTO oi_z_meta VALUES(1,?)', (json.dumps(meta),))

    def cycle(self, symbol, expiry=''):
        """Daily closing ATM scores, calculated locally with each date's own baseline."""
        symbol = symbol.upper()
        result = dict(symbol=symbol, expiries=[], expiry=expiry, dates=[], days=[], reason=None)
        if symbol in NON_STOCKS:
            result['reason'] = 'ATM OI Z-scores are available for stocks only'
            return result
        with self.store.connect() as db:
            db.execute('BEGIN')
            expiries = [r[0] for r in db.execute('''SELECT expiry FROM expiries WHERE symbol=?
                UNION SELECT expiry FROM chains WHERE symbol=? ORDER BY expiry''', (symbol, symbol))]
            selected = expiry or (expiries[-1] if expiries else '')
            result.update(expiries=expiries, expiry=selected)
            previous = max((e for e in expiries if e < selected), default=None)
            if selected not in expiries or previous is None:
                result['reason'] = 'Archived expiry and previous expiry required. Use Scanners → Data update.'
                return result
            result['previous_expiry'] = previous
            result['dates'] = [r[0] for r in db.execute('''SELECT day FROM chains WHERE day BETWEEN ? AND ?
                UNION SELECT day FROM calendar WHERE trading=1 AND day BETWEEN ? AND ? ORDER BY day''',
                (previous, selected, previous, selected))]
            history = [dict(r) for r in db.execute('''SELECT day,expiry,calendar_dte,atm_strike,
                spot,call_oi,put_oi,lot_size,oi_unit FROM chains WHERE symbol=? AND day>=? AND day<=?
                ORDER BY day,expiry''', (symbol, months_before(date.fromisoformat(previous), 12).isoformat(), selected))]
        for target in history:
            if target['expiry'] != selected or target['day'] < previous:
                continue
            day = date.fromisoformat(target['day'])
            periods = {}
            for months in PERIODS:
                sides = {}
                for label, side in [('ce', 'call_oi'), ('pe', 'put_oi')]:
                    stats = baseline(history, day, selected, target['calendar_dte'], months, side)
                    if any(s['oi_unit'] != target['oi_unit'] for s in stats['samples']):
                        stats['reason'] = 'Incompatible OI units'
                    if target['lot_size'] is not None and any(s['lot_size'] is not None and s['lot_size'] != target['lot_size'] for s in stats['samples']):
                        stats['reason'] = 'Historical lot size changed'
                    sides[label] = score(stats, target[side])
                periods[str(months)] = sides
            result['days'].append(dict(date=target['day'], expiry=selected, dte=target['calendar_dte'],
                                       atm=target['atm_strike'], spot=target['spot'], periods=periods))
        if not result['days']:
            result['reason'] = 'No closing chains archived for this expiry cycle'
        return result

    def live(self, symbol, snapshot, strikes):
        symbol = symbol.upper()
        with self.store.connect() as db:
            stock = db.execute('SELECT 1 FROM universe WHERE symbol=?', (symbol,)).fetchone()
            if not stock or symbol in NON_STOCKS:
                return None
            meta_row = db.execute('SELECT payload FROM oi_z_meta WHERE id=1').fetchone()
            meta = json.loads(meta_row[0]) if meta_row else None
        result = dict(periods={}, reason=None, stored=meta)
        today = datetime.now(IST).date()
        timestamp = finite(snapshot.get('ts'))
        # An undated weekend quote cannot establish today's observation/DTE.
        # Show the persisted closing result explicitly, without re-dating quotes.
        if (timestamp is None and today.weekday() >= 5):
            return self._closing_fallback(symbol, snapshot, meta,
                'Latest archived close; live observation date unavailable on weekend')
        if not meta or meta['as_of'] != today.isoformat():
            result['reason'] = 'Update rolling Z-scores for today in Scanners'
            return result
        if timestamp is not None and timestamp > 0:
            try:
                observed_day = datetime.fromtimestamp(timestamp / 1000 if timestamp > 1e11 else timestamp, IST).date()
            except (ValueError, OverflowError, OSError):
                result['reason'] = 'Invalid source observation timestamp'
                return result
            if observed_day != today:
                return self._closing_fallback(symbol, snapshot, meta,
                    'Latest archived close; source quote is dated ' + observed_day.isoformat(),
                    observed_day.isoformat())
        try:
            expiry = expiry_date(snapshot.get('exp'))
        except ValueError:
            result['reason'] = 'Expiry unavailable'
            return result
        dte = (expiry - today).days
        spot = finite(snapshot.get('uv'))
        valid = [r for r in strikes if finite(r.get('sp')) is not None and r['sp'] > 0]
        if dte < 0 or spot is None or spot <= 0 or not valid:
            result['reason'] = 'Current ATM or expiry unavailable'
            return result
        atm = min(valid, key=lambda r: (abs(r['sp'] - spot), r['sp']))
        result.update(atm_strike=atm['sp'], dte=dte, day=today.isoformat(), expiry=expiry.isoformat())
        with self.store.connect() as db:
            for row in db.execute('SELECT months,payload FROM oi_z_baselines WHERE symbol=? AND dte=?', (symbol, dte)):
                stats = json.loads(row['payload'])
                result['periods'][str(row['months'])] = {
                    'ce': score(stats['ce'], atm.get('cOI')), 'pe': score(stats['pe'], atm.get('pOI'))}
        if not result['periods']:
            result['reason'] = 'No stored baseline at this DTE; update rolling Z-scores'
        return result

    def _closing_fallback(self, symbol, snapshot, meta, reason, expected_day=None):
        with self.store.connect() as db:
            row = db.execute('SELECT payload FROM oi_z_scores WHERE symbol=?', (symbol,)).fetchone()
        saved = json.loads(row[0]) if row else None
        try:
            expiry = expiry_date(snapshot.get('exp')).isoformat()
        except ValueError:
            expiry = None
        if saved and saved['expiry'] == expiry and (expected_day is None or saved['day'] == expected_day):
            saved.update(reason=reason, stored=meta, basis='archived_close')
            return saved
        return dict(periods={}, stored=meta,
                    reason='No stored closing score matching this quote date/expiry')
