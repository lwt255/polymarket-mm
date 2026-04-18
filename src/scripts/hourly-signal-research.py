"""
Hourly-candle signal research.

Fetches Binance 1h klines for 6 assets and tests whether v4-style
price-only signals predict next-hour direction (close >= open).

Runs on VPS (Binance access) or locally if Binance is reachable.
"""
import json
import sys
import urllib.request
from datetime import datetime, timezone
from collections import defaultdict

BINANCE_SYMBOLS = {
    'bitcoin': 'BTCUSDT',
    'ethereum': 'ETHUSDT',
    'solana': 'SOLUSDT',
    'xrp': 'XRPUSDT',
    'bnb': 'BNBUSDT',
    'dogecoin': 'DOGEUSDT',
}

DAYS = 365
LIMIT_PER_CALL = 1000  # Binance max


def fetch_klines(symbol, days):
    """Fetch N days of 1h klines. Binance returns up to 1000 per call."""
    end_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    start_ms = end_ms - days * 24 * 3600 * 1000
    klines = []
    cursor = start_ms
    while cursor < end_ms:
        url = f'https://api.binance.com/api/v3/klines?symbol={symbol}&interval=1h&startTime={cursor}&limit={LIMIT_PER_CALL}'
        req = urllib.request.Request(url, headers={'User-Agent': 'research'})
        with urllib.request.urlopen(req) as resp:
            batch = json.loads(resp.read())
        if not batch:
            break
        klines.extend(batch)
        last_close = batch[-1][6]  # close time
        if len(batch) < LIMIT_PER_CALL:
            break
        cursor = last_close + 1
    return klines


def candles(klines):
    """Convert raw klines to simple dicts."""
    out = []
    for k in klines:
        open_ms = int(k[0])
        o, h, l, c = float(k[1]), float(k[2]), float(k[3]), float(k[4])
        v = float(k[5])
        out.append({
            'open_ms': open_ms,
            'hour_utc': datetime.fromtimestamp(open_ms / 1000, tz=timezone.utc).hour,
            'dow_utc': datetime.fromtimestamp(open_ms / 1000, tz=timezone.utc).weekday(),
            'o': o, 'h': h, 'l': l, 'c': c, 'v': v,
            'up': c >= o,
            'ret': (c - o) / o,
        })
    return out


def baseline(data):
    print('=== Baseline UP rate by asset (unconditional) ===')
    for asset, candles_ in data.items():
        up = sum(1 for c in candles_ if c['up'])
        print(f'  {asset:<10} {len(candles_):>5} candles  {up / len(candles_) * 100:>5.2f}% UP')
    print()


def prev_direction_test(data):
    """Does the prior candle direction predict the next? Full window + quarterly splits."""
    print('=== Prior candle direction → next (full window) ===')
    for asset, candles_ in data.items():
        n_up_prev, up_after_up = 0, 0
        n_down_prev, up_after_down = 0, 0
        for i in range(1, len(candles_)):
            prev = candles_[i - 1]
            cur = candles_[i]
            if prev['up']:
                n_up_prev += 1
                if cur['up']:
                    up_after_up += 1
            else:
                n_down_prev += 1
                if cur['up']:
                    up_after_down += 1
        u_after_u = up_after_up / n_up_prev * 100 if n_up_prev else 0
        u_after_d = up_after_down / n_down_prev * 100 if n_down_prev else 0
        diff = u_after_u - u_after_d
        print(f'  {asset:<10} UP-after-UP: {u_after_u:>5.2f}%  UP-after-DOWN: {u_after_d:>5.2f}%  diff: {diff:+.2f}pp')
    print()

    # Split into 4 equal-length windows to check regime stability
    print('=== Prior-direction edge by quarter (regime check) ===')
    print(f'  {"asset":<10} {"Q1":>10} {"Q2":>10} {"Q3":>10} {"Q4":>10}')
    for asset, candles_ in data.items():
        n = len(candles_)
        qsize = n // 4
        line = f'  {asset:<10}'
        for q in range(4):
            lo, hi = q * qsize, (q + 1) * qsize if q < 3 else n
            window = candles_[lo:hi]
            n_up, w_up = 0, 0
            n_dn, w_dn = 0, 0
            for i in range(1, len(window)):
                if window[i - 1]['up']:
                    n_up += 1
                    if window[i]['up']:
                        w_up += 1
                else:
                    n_dn += 1
                    if window[i]['up']:
                        w_dn += 1
            if n_up and n_dn:
                diff = (w_up / n_up - w_dn / n_dn) * 100
                line += f'  {diff:>+7.2f}pp'
            else:
                line += f'  {"n/a":>9}'
        # show date range of Q1 and Q4 for context
        def dstr(c):
            return datetime.fromtimestamp(c['open_ms'] / 1000, tz=timezone.utc).strftime('%Y-%m-%d')
        line += f'   [{dstr(candles_[0])} → {dstr(candles_[-1])}]'
        print(line)
    print()


def cross_asset_test(data):
    """When multiple assets all moved same way in prior hour, does next hour confirm?"""
    print('=== Cross-asset same-direction → next hour BTC ===')
    # Align on open_ms; use BTC as the target
    by_time = defaultdict(dict)
    for asset, candles_ in data.items():
        for c in candles_:
            by_time[c['open_ms']][asset] = c
    times = sorted(by_time.keys())
    # For each time t, look at t-1 across all 6 assets; target is BTC at t
    outcomes = {'all_up': [], 'all_down': [], 'mixed': []}
    for i in range(1, len(times)):
        t, tp = times[i], times[i - 1]
        prev_slice = by_time[tp]
        cur_slice = by_time[t]
        if 'bitcoin' not in cur_slice or len(prev_slice) < 5:
            continue
        ups = sum(1 for a, c in prev_slice.items() if c['up'])
        downs = len(prev_slice) - ups
        btc_up_next = cur_slice['bitcoin']['up']
        if ups == len(prev_slice):
            outcomes['all_up'].append(btc_up_next)
        elif downs == len(prev_slice):
            outcomes['all_down'].append(btc_up_next)
        else:
            outcomes['mixed'].append(btc_up_next)
    for label, arr in outcomes.items():
        if not arr:
            continue
        wr = sum(arr) / len(arr) * 100
        print(f'  prior-hour {label:<8}  n={len(arr):>4}  next BTC UP: {wr:>5.2f}%')
    print()


def tod_bias_test(data):
    """Which UTC hours have directional skew?"""
    print('=== Time-of-day bias (UTC hour → UP rate) per asset ===')
    for asset, candles_ in data.items():
        by_hour = defaultdict(list)
        for c in candles_:
            by_hour[c['hour_utc']].append(c['up'])
        print(f'  {asset}:')
        # Find most extreme hours
        rates = []
        for h in range(24):
            arr = by_hour[h]
            if arr:
                wr = sum(arr) / len(arr) * 100
                rates.append((h, wr, len(arr)))
        rates.sort(key=lambda x: abs(x[1] - 50), reverse=True)
        for h, wr, n in rates[:5]:
            print(f'    UTC {h:02}:00  n={n:>3}  UP: {wr:>5.2f}%  (skew {wr - 50:+.2f}pp)')
    print()


def acceleration_test(data):
    """N consecutive same-direction candles → next candle continuation?"""
    print('=== Streak momentum (N same-direction → next matches) ===')
    for asset, candles_ in data.items():
        streaks = defaultdict(lambda: [0, 0])  # [n, wins]
        for i in range(3, len(candles_)):
            # Find current streak length of same direction
            streak_dir = candles_[i - 1]['up']
            streak_len = 1
            for j in range(i - 2, -1, -1):
                if candles_[j]['up'] == streak_dir:
                    streak_len += 1
                else:
                    break
            cont = candles_[i]['up'] == streak_dir
            streaks[streak_len][0] += 1
            streaks[streak_len][1] += 1 if cont else 0
        print(f'  {asset}:')
        for L in sorted(streaks.keys()):
            n, w = streaks[L]
            if n < 20:
                continue
            print(f'    streak={L}  n={n:>4}  continuation: {w / n * 100:>5.2f}%')
    print()


def main():
    print(f'Fetching {DAYS} days of 1h candles for {len(BINANCE_SYMBOLS)} assets...')
    data = {}
    for asset, sym in BINANCE_SYMBOLS.items():
        try:
            klines = fetch_klines(sym, DAYS)
            data[asset] = candles(klines)
            print(f'  {asset}: {len(data[asset])} candles')
        except Exception as e:
            print(f'  {asset}: FAILED {e}')
    print()
    baseline(data)
    prev_direction_test(data)
    cross_asset_test(data)
    tod_bias_test(data)
    acceleration_test(data)


if __name__ == '__main__':
    main()
