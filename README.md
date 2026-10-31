# FNO Analyzer V2

V2 is an independent deployment package. It does not import from or modify the V1 directory. The working Python service and vanilla browser client from V1 were reorganized into a smaller application with isolated AOC and Dhan adapters.

The experimental `DHAN_SCRAPER` React/Express project, probe scripts, credential extractor, and captured request material are not part of V2. Dhan scanx access is implemented by one provider module.

## Structure

```text
FNO_ANALYZER_V2/
├── config.json
├── frontend/
│   ├── index.html
│   ├── app.js
│   └── style.css
├── src/fno_analyzer/
│   ├── application.py
│   ├── config.py
│   ├── errors.py
│   ├── http_server.py
│   ├── providers/
│   │   ├── aoc.py
│   │   └── dhan.py
│   └── services/
│       ├── metrics.py
│       └── symbol_map.py
├── data/dhan_map.json
├── scripts/
├── tests/
├── deploy/
│   ├── nginx/
│   ├── systemd/
│   └── fno-analyzer.env.example
├── Dockerfile
├── compose.yml
├── pyproject.toml
└── requirements.txt
```

## Dashboard tabs

The dashboard has **Live**, **Historical**, **Sectors**, **Scanners**, and
**Option Fair Price** tabs. Option Fair Price appears immediately after Scanners.

## Option Fair Price

Select a symbol and Dhan expiry, then use the **Call (CE)** box on the left and
**Put (PE)** box on the right. They stack on narrow screens. Both use the existing
Dhan credentials from the Analyzer configuration; no separate setup or external
calculator directory is required.

Each box has independent controls:

- **Strike price:** defaults to ATM. The shared **Strikes each side of ATM** input
  defaults to **8 above and 8 below, plus ATM** (17 strikes when available), with
  a range of 1–80 per side. Changing it updates both dropdowns immediately without
  fetching another chain. A selected strike outside the new window resets to ATM.
- **Buy / Sell:** green for Buy and red for Sell.
- **Entry spot:** the underlying level at which you want to enter.
- **Stop-loss distance:** underlying spot points from entry; defaults to **25**.
- **Target distance:** underlying spot points from entry; defaults to **50**.

The results show the spot level and estimated option premium at **Entry**,
**Stop-loss**, and **Target**. Buy calls and sell puts place SL below entry and
target above; sell calls and buy puts reverse those levels. Delta, Gamma and
Theta are always visible beneath each box.

Pricing preserves the original Option Fair Price calculator's method:

```text
spot move = scenario spot − current spot
estimated premium = max(0, LTP + Delta × spot move
                           + 0.5 × Gamma × spot move² + Theta / 7)
```

Premiums are in points per unit, before costs, using fixed Greeks from the loaded
quote. Missing or invalid LTP/Greeks leave estimates unavailable. Expired contracts
use intrinsic value. Expand **How prices are estimated** for the calculation and
level-direction notes.

**Refresh** loads quotes manually. **Auto refresh (10s)** runs while the tab is
active, with a 60-second delay after errors. **Last refreshed** shows the cached
quote acquisition time in IST. Entry levels and positions survive quote refresh;
changing the symbol resets entry spots to the newly loaded spot.

## Configuration

`config.json` is the only application configuration file. It contains both AOC and Dhan settings, with secrets blank by design. Do not put the V1 token or JWT into source control.

Environment variables override the secret fields:

| Variable | Purpose |
| --- | --- |
| `FNO_AOC_TOKEN` | AOC bearer token |
| `FNO_DHAN_JWT` | Dhan `JWTtoken` from the options-trader session |
| `FNO_DHAN_ENTITY_ID` | Dhan entity id used for symbol searches |
| `FNO_DHAN_CLIENT_ID` | Dhan client id when required by the account |
| `FNO_DATA_DIR` | Writable directory for the generated Dhan map |
| `FNO_SERVER_HOST` | Bind address; keep loopback behind a proxy |
| `FNO_SERVER_PORT` | Application port |

`providers.dhan.authorisation` is sent literally in the Dhan `authorisation` header. The default is `Token`; the JWT is sent separately in the `auth` header. This avoids the duplicated `Token Token` header produced by V1.

## Local development

```bash
cd FNO_ANALYZER_V2
python -m venv .venv
.venv/Scripts/activate
python -m pip install -r requirements.txt
set FNO_AOC_TOKEN=your-aoc-token
set FNO_DHAN_JWT=your-dhan-jwt
set FNO_DHAN_ENTITY_ID=your-entity-id
python run.py
```

On Linux or macOS, use `export` instead of `set`. Open `http://127.0.0.1:8000`.

The V2 symbol map is already present as a generated cache. Rebuild it with:

```bash
python scripts/build_symbol_map.py
```

The map is written atomically to `data/dhan_map.json`. A persistent data directory should be used in production.

## API

The browser API remains compatible with V1:

- `/api/health`, `/api/ready`, `/api/config`
- `/api/tickers`, `/api/expiries`, `/api/data`, `/api/historical`
- `/api/dhan/map`, `/api/dhan/chain`, `/api/dhan/ivpivr`, `/api/dhan/skew`, `/api/dhan/term`
- `/api/sectors`, `/api/sectors/intraday`, `/api/sectors/components`
- `GET /api/fair-price/expiries?ticker=NIFTY`
- `GET /api/fair-price/chain?ticker=NIFTY&expiry=<raw-expdatej>`
- `POST /api/scanners/oi-zscore/update`, `GET /api/scanners/oi-zscore/status`

Errors use HTTP `400`, `404`, `502`, `503`, or `504` as appropriate and return an `error` message plus a stable `code`.

## ATM OI Z-score scanner

Under **Scanners**, use **Update rolling Z-scores** to calculate stored closing
scores from the local OI archive. Select the baseline period, side, direction and
threshold, then click **Run Z-score scan** to apply the filters. Combined setups
require both the dominant-side threshold and the opposite-side cutoff.

After a page reload, both the matched-stock list and **All stored scores** list
stay empty until a valid **Run Z-score scan**. Status polling, updating scores,
sorting or searching do not reveal stocks before that first scan. Saved scores
remain available on the server. Once run, the lists support immediate CE/PE
sorting, stock search and export to a browser-local watchlist.

## IV scanners

The Live dashboard includes a daily **ATM OI Z-score through the expiry cycle**
chart below the OI expiry-cycle plot. Choose an expiry, 3M/6M/1Y baseline, and
CE/PE visibility. Hover shows scores and baseline sample dates; wheel zooms dates,
drag pans, and Reset view restores the cycle. Each archived close uses its own
ATM and prior-expiry baseline; missing scores leave gaps. Reload archive reads
saved data without provider requests or a rolling Z-score update. The option
chain and both expiry-cycle charts have independent Collapse/Expand buttons.

The **Scanners** tab also includes a **Highest OI closing scanner** using the local
historical OI database. Choose bullish (highest put OI) or bearish (highest call OI).
Enable price distance < X%, CE/PE maximum strike gap > Y available intervals,
and second-highest / highest OI < Z% independently. Price distance uses the
highest-OI strike as denominator. N defaults to 0 (latest close only) and applies
only to the second OI filter; N > 0 requires it on each of N trading dates,
including the latest close, for the same expiry. Missing history fails the filter.
Results show the closing date, applied settings, exclusions and watchlist selection.
Run scan applies edited controls; Collapse and Clear results work independently.
Refresh closing data with Data update. Scanning makes no provider requests.

The **Scanners** tab beside Sectors scans NSE stock rows from Dhan's IV movers
(`HighestIVP`, one-year lookback, page 1, count 350). Index rows are excluded.
Current IVP strictly above/below the selected cutoffs determines which stocks
need history; stocks between the cutoffs never trigger history requests.
The falling and rising conditions have separate toggles, enabled by default.
Disable either condition to show all stocks passing that block's IVP cutoff,
including those with insufficient history. That block makes no history requests
and shows current IV/IVP only. Click Run scan to apply the selected toggles.

Both historical ATM IV and IVP are smoothed with a trailing simple moving
average (default 3 observations). The lookback (default 5 observations) compares
the latest smoothed IV with the smoothed IV that many valid daily observations
earlier. It measures net change, not a requirement that every day moves in the
same direction. Dates and values remain aligned when sorting descending Dhan
history; invalid dates, nonpositive IV, and invalid IVP are excluded. At least
`lookback + smoothing` valid rows are required. High-IVP rows match negative IV
change; low-IVP rows match positive IV change. Tables distinguish current values
from smoothed history, show actual dates, and include absolute IV change in
percentage points and relative percentage change.

One background scan runs at a time per application process. History and movers
requests share a lock and wait at least one second between upstream requests.
History is cached for 15 minutes (shared with the IVP/IVR plot), and movers for
5 minutes. HTTP 429 stops the scan and starts a cooldown of at least 60 seconds
or the upstream Retry-After duration. Authentication failures stop the scan;
other stock-specific failures are listed as skipped. Cancellation stops after
the current request. Partial results and progress remain available, including
after a browser reload; restarting the server clears scans and caches.

- `POST /api/scanners/iv/start?high=80&low=20&days=5&smoothing=3&falling=true&rising=true`
- `GET /api/scanners/iv/status?id=<scan-id>` (omit id for the latest scan)
- `POST /api/scanners/iv/cancel?id=<scan-id>`

Validation: `python -m unittest discover -s tests`; frontend regression checks:
`node tests/test_ivr_chart.cjs`.

## EC2 deployment with Docker

Install Docker and Docker Compose on the EC2 host, then:

```bash
cd /opt/fno-analyzer
cp deploy/fno-analyzer.env.example .env
chmod 600 .env
```

Put the AOC and Dhan secrets in `.env`, build, and start:

```bash
docker compose build
docker compose up -d
curl http://127.0.0.1:8000/api/health
```

The service is deliberately published on `127.0.0.1:8000`; do not publish the authenticated upstream proxy directly to the internet.

Install Nginx, copy `deploy/nginx/fno-analyzer.conf` to `/etc/nginx/sites-available/fno-analyzer`, replace `fno.example.com` with the actual subdomain, enable the site, and reload Nginx:

```bash
sudo ln -s /etc/nginx/sites-available/fno-analyzer /etc/nginx/sites-enabled/fno-analyzer
sudo nginx -t
sudo systemctl reload nginx
```

For HTTPS, point the DNS record at the EC2 public IP, install Certbot, obtain a certificate, and use `deploy/nginx/fno-analyzer-tls.conf` with the real hostname and certificate paths. Put authentication at Nginx or an identity-aware proxy before exposing the dashboard publicly.

For deployment beside an existing app at `/fnoanalyzer/`, see
[the EC2 subpath guide](docs/ec2-subpath.md). It includes the configuration for
the trading-journal server, systemd on loopback port 8001 and separate credentials.

## EC2 deployment with systemd

Create an unprivileged `fno` user, copy V2 to `/opt/fno-analyzer`, and create a virtual environment:

```bash
sudo useradd --system --home /opt/fno-analyzer --shell /usr/sbin/nologin fno || true
sudo python3 -m venv /opt/fno-analyzer/.venv
sudo /opt/fno-analyzer/.venv/bin/pip install -r /opt/fno-analyzer/requirements.txt
sudo install -d -o fno -g fno -m 750 /etc/fno-analyzer
sudo install -d -o fno -g fno -m 750 /var/lib/fno-analyzer
sudo cp /opt/fno-analyzer/deploy/fno-analyzer.env.example /etc/fno-analyzer/fno-analyzer.env
sudo chown root:fno /etc/fno-analyzer/fno-analyzer.env
sudo chmod 640 /etc/fno-analyzer/fno-analyzer.env
sudo cp /opt/fno-analyzer/deploy/systemd/fno-analyzer.service /etc/systemd/system/fno-analyzer.service
sudo systemctl daemon-reload
sudo systemctl enable --now fno-analyzer
```

Edit `/etc/fno-analyzer/fno-analyzer.env`, add the secrets, then run `sudo systemctl restart fno-analyzer`. Use the same Nginx virtual host to proxy to `127.0.0.1:8000`.

## Validation

Historical ATM OI storage is available under **Scanners → Data update**. It
archives daily front-expiry chains including per-strike Greeks in SQLite,
resumes missing dates and skips completed snapshots. The first trailing-year
backfill can take days at conservative pacing; keep the backend running.
See [daily OI archive details](docs/oi-history.md) for scope, DTE conventions,
configuration and provider limitations.

```bash
python -m compileall -q run.py src tests
node --check frontend/app.js
node --check frontend/fair-price.js
node --check frontend/oi-zscore.js
node tests/test_fair_price.cjs
node tests/test_oi_zscore_controls.cjs
node tests/test_oi_zscore_startup.cjs
python -m unittest discover -s tests -v
```

The V2 service is ready when `/api/health` returns `200`. `/api/ready` returns `503` until at least one provider has a secret configured. Rotate any credentials that were present in the V1 files before deploying V2.

### Sector-grouped watchlists and exports

All scanner result tables offer **Add selected by sector** beside the existing flat-list action. It adds checked symbols to the chosen watchlist and displays that list under sector headings, preserving the grouping across reloads. Sector grouping uses the published NSE Indices Nifty Total Market Industry classifications in `frontend/stock-sectors.js` (source and retrieval date are recorded in the file), rather than overlapping index memberships. The bundled snapshot covers 754 symbols, including all 218 equities in the provider ticker list audited on 31 October 2026. It works offline and supersedes old cached index groups. Each stock appears once; indices and commodities remain separate. Truly unknown future symbols remain explicitly unclassified until the published mapping is refreshed. Classified stocks such as UJJIVANSFB can be added even when the saved Dhan map predates the listing. This watchlist resolution does not create a Dhan security-ID mapping for option-chain requests. Provider ticker metadata is merged into the watchlist universe, including new symbols absent from that saved map.

Custom watchlists offer **Copy TradingView string by sector**, using `###Sector` section headings, and **Copy Dhan string**, using comma-separated exchange symbols without prefixes (for example `TCS,LT,M&M`). The existing flat TradingView export remains available. Clipboard failures select the export field for manual copying. Watchlists remain browser-local.
