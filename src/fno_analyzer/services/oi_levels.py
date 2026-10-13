"""Highest-OI closing scanner, using local archive projections only."""
from datetime import datetime
from uuid import uuid4

from ..errors import InvalidParameter
from .oi_history import IST, finite
from .oi_downloader import NON_STOCKS


def levels(strikes, spot, side):
    ordered = sorted(strikes, key=lambda r: r['strike'])
    ranks = {}
    for leg in ('call', 'put'):
        valid = [r for r in ordered if finite(r[leg + '_oi']) is not None and r[leg + '_oi'] >= 0]
        ranks[leg] = sorted(valid, key=lambda r: (-r[leg + '_oi'], r['strike']))
    selected = ranks[side]
    if not selected or selected[0][side + '_oi'] <= 0:
        return None
    call, put = [ranks[leg][0]['strike'] if ranks[leg] and ranks[leg][0][leg + '_oi'] > 0 else None for leg in ('call', 'put')]
    target = selected[0]['strike']
    if target <= 0 or finite(spot) is None or spot <= 0:
        return None
    grid = [r['strike'] for r in ordered]
    return dict(call_strike=call, put_strike=put, target_strike=target,
                distance=100 * abs(spot - target) / target,
                gap=abs(grid.index(call) - grid.index(put)) if call is not None and put is not None else None,
                second_strike=selected[1]['strike'] if len(selected) >= 2 else None,
                second_pct=100 * selected[1][side + '_oi'] / selected[0][side + '_oi'] if len(selected) >= 2 else None)


class OILevelsScanner:
    def __init__(self, store):
        self.store = store

    def scan(self, direction='bullish', distance=2, gap=2, second=50, days=0):
        if direction not in ('bullish', 'bearish'):
            raise InvalidParameter('Direction must be bullish or bearish')
        for name, value, maximum in [('Distance', distance, None), ('Gap', gap, None), ('Second OI', second, 100)]:
            if value is not None and (finite(value) is None or value < 0 or (maximum is not None and value > maximum)):
                raise InvalidParameter(f'{name} must be a finite nonnegative number' + (' up to 100' if maximum else ''))
        if isinstance(days, bool) or not isinstance(days, int) or not 0 <= days <= 60:
            raise InvalidParameter('Days must be an integer from 0 to 60')
        if gap is not None and int(gap) != gap:
            raise InvalidParameter('Strike gap must be an integer')
        side = 'put' if direction == 'bullish' else 'call'
        count = max(1, days) if second is not None else 1
        today = datetime.now(IST).date().isoformat()
        matches, excluded = [], []
        with self.store.connect() as db:
            db.execute('BEGIN')
            dates = [r[0] for r in db.execute('''SELECT day FROM (
                SELECT day FROM chains WHERE day < ? UNION
                SELECT day FROM calendar WHERE trading=1 AND day < ?)
                ORDER BY day DESC LIMIT ?''', (today, today, count))]
            stocks = [r[0] for r in db.execute('SELECT symbol FROM universe WHERE active=1 ORDER BY symbol') if r[0] not in NON_STOCKS]
            chains, projections = {}, {}
            if dates:
                placeholders = ','.join('?' for _ in dates)
                for row in db.execute(f'SELECT symbol,day,expiry,spot FROM chains WHERE day IN ({placeholders}) ORDER BY expiry', dates):
                    chains.setdefault((row['symbol'], row['day']), dict(row))
                for row in db.execute(f'''SELECT s.symbol,s.day,s.expiry,s.strike,s.call_oi,s.put_oi
                    FROM chains AS c INDEXED BY chains_day CROSS JOIN option_strikes AS s
                    ON s.symbol=c.symbol AND s.day=c.day AND s.expiry=c.expiry
                    WHERE c.day IN ({placeholders})''', dates):
                    projections.setdefault((row['symbol'], row['day'], row['expiry']), []).append(dict(row))
            for symbol in stocks:
                latest = chains.get((symbol, dates[0])) if dates else None
                reason, history, current = None, [], None
                if latest is None:
                    reason = 'Missing latest closing chain; update the OI database'
                else:
                    current = levels(projections.get((symbol, latest['day'], latest['expiry']), []), latest['spot'], side)
                    if current is None:
                        reason = 'Insufficient valid OI strikes'
                    elif distance is not None and current['distance'] >= distance:
                        reason = 'Price distance is not less than X'
                    elif gap is not None and (current['gap'] is None or current['gap'] <= gap):
                        reason = 'Strike gap is not more than Y'
                    elif second is not None:
                        if len(dates) < count:
                            reason = 'Insufficient archived trading dates'
                        for day in dates:
                            chain = chains.get((symbol, day))
                            if chain is None or chain['expiry'] != latest['expiry']:
                                reason = reason or 'Missing history for the same expiry'
                                break
                            values = levels(projections.get((symbol, day, chain['expiry']), []), chain['spot'], side)
                            if values is None or values['second_pct'] is None:
                                reason = reason or 'Insufficient historical OI strikes'
                                break
                            history.append(dict(day=day, second_pct=values['second_pct']))
                            if values['second_pct'] >= second:
                                reason = reason or 'Second-highest OI is not less than Z%'
                if reason:
                    excluded.append(dict(symbol=symbol, reason=reason))
                else:
                    matches.append(dict(symbol=symbol, day=latest['day'], expiry=latest['expiry'],
                                        close=latest['spot'], history=history, **current))
        matches.sort(key=lambda r: (r['distance'], r['symbol']))
        return dict(id=uuid4().hex, rows=matches, excluded=excluded, dates=dates,
                    as_of=dates[0] if dates else None, total=len(stocks),
                    settings=dict(direction=direction, distance=distance, gap=gap, second=second, days=days))
