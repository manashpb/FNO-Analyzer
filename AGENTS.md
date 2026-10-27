# FNO Analyzer: repository context

This file summarizes the current application and the behavior established with
the user. Read it before modifying this repository, and update relevant sections
when behavior or architecture changes. It is context, not a list of new feature
requests. Source code is authoritative if this summary becomes stale.

## Purpose and stack

- NSE futures and options dashboard with AOC and Dhan data sources.
- Python 3.11+ backend using `requests`, `tzdata`, and the standard-library
  `ThreadingHTTPServer`. There is no Flask/FastAPI service. The daily OI archive
  uses standard-library SQLite with an incremental AOC background downloader.
- Vanilla HTML/CSS/JavaScript frontend with custom canvas charts. No React,
  frontend build step, or chart library is currently used.
- Current package is `fno-analyzer-v2`, version 2.0.0. This repository is the
  independent V2 app; it does not depend on a V1 directory or experimental
  DHAN_SCRAPER project.
- Default local address: `http://127.0.0.1:8000`. Market dates use
  `Asia/Kolkata` (IST).

## Code map

| Location | Responsibility |
| --- | --- |
| `run.py`, `src/fno_analyzer/__main__.py` | Application entry points |
| `src/fno_analyzer/http_server.py` | HTTP handling, static files, JSON errors, security headers; scanner actions use POST |
| `src/fno_analyzer/application.py` | Route dispatch, provider orchestration, chain caching, analytics, sectors, term structure |
| `src/fno_analyzer/config.py` | Defaults, config merge, environment overrides, path resolution |
| `src/fno_analyzer/providers/aoc.py` | AOC requests and compact payload normalization |
| `src/fno_analyzer/providers/dhan.py` | Search, expiry lists, option chains, normalization, analytics history and movers, pacing and caching |
| `src/fno_analyzer/services/metrics.py` | PCRs, ATM strike/IV, IV skew, levels, top OI/volume, existing max-pain calculation |
| `src/fno_analyzer/services/symbol_map.py` | AOC-to-Dhan mapping, aliases, lookup, atomic cache writes |
| `src/fno_analyzer/services/scanners.py` | Background IV reversal scanner and trailing smoothing |
| `src/fno_analyzer/cache.py`, `errors.py` | Thread-safe TTL cache and structured application/provider errors |
| `frontend/index.html`, `style.css` | Dashboard structure and dark theme |
| `frontend/app.js` | Dashboard modes, requests, watchlist, chain, sectors, custom charts |
| `frontend/watchlists.js` | Browser-local watchlists, cached sector groups, scanner selection/export |
| `frontend/scanners.js` | Scanner controls, progress polling, result tables, cancellation, reload recovery |
| `data/dhan_map.json` | Generated symbol mapping cache |
| `scripts/build_symbol_map.py` | Rebuild symbol mapping |
| `tests/` | Python tests and Node frontend regression checks |
| `deploy/`, `Dockerfile`, `compose.yml` | Nginx/systemd and Docker deployment |

## Dashboard features

Top tabs are **Live**, **Historical**, **Sectors**, and **Scanners** (beside
Sectors), followed by **Option Fair Price**. Live offers AOC/Dhan source selection and automatic refresh. Historical
snapshots and sector data come from AOC. The sidebar watchlist groups symbols.
Live defaults to Dhan with automatic AOC backup via GET `/api/live?ticker=...`.
Responses identify the actual `source` and any `fallback_reason`. Live startup
uses `/api/live/tickers` from the saved Dhan map, with AOC only if it is absent.
Dhan chain/analytics metadata uses cached AOC metadata only, never a blocking
AOC request. Missing lot metadata remains unavailable. Explicit AOC selection
still uses `/api/data`. Backup responses clear Dhan analytics displays.

Header metrics use six cards: paired Spot/Future, Lot Size/ATM Slippage,
PCR/Max Pain and ATM IV/IVP, plus wider ATM OI Z-score and Max OI Strikes cards.
Desktop shows one row; narrow screens wrap. ATM slippage is the larger valid
ATM CE/PE bid-ask spread multiplied by lot size (rupees per lot), falling back
to explicitly labelled points when lot size is missing; unavailable
metadata or quotes are explained. One independent background `/api/tickers`
request populates lot metadata after Dhan startup; chain requests remain independent.
Custom watchlists show a visible Remove button on each stock and a TradingView
read-only combined string with comma-separated exchange-prefixed symbols and a
Copy button for pasting into TradingView. The string updates with list edits;
clipboard failures select the text for manual Ctrl+C.

The chain dashboard includes metrics cards, configurable strike display,
an optional Vertical Spread mode (width 1â€“4 available strike intervals),
and a clickable Spread help dialog. `frontend/spreads.js` computes same-expiry
call/put bid, ask and width-minus-opposite-bid (Opp) values from loaded rows.
Mid columns are omitted; put quotes display Bid before Ask. Compare each side's
Ask directly with its Opp value.
Opp is red above Ask, green below Ask, yellow when equal to quote precision.
The interpretation units toggle converts the advantage to rupees per lot using
the selected ticker's lot size, falling back to points if unavailable.
The strike pair stays centered between mirrored call/put columns. Bullish
interpretation compares Call Ask with width minus Put Bid; bearish compares
Put Ask with width minus Call Bid. Advantages are per-unit points before costs
and financing; width is undiscounted. Missing/nonpositive/crossed leg quotes
remain unavailable, never replaced with LTP. Pairing precedes the display window.
Mode/width survive refresh within the page; Default mode is initial on reload.
The dashboard also includes
interactive OI/OI-change/volume charts (`frontend/profile-charts.js`) with hover,
wheel zoom, pointer drag pan, reset and call/put visibility. They fill three
columns on desktop and stack on narrow screens. The redundant IV Smile in
Charts is removed; the separate volatility skew panel remains.
The OI expiry-cycle heatmap (`frontend/oi-heatmap.js`) sits below skew and uses
GET `/api/history/oi/heatmap?ticker=...&expiry=YYYY-MM-DD` with local SQLite
projections only. An independent expiry selector covers previous expiry through
selected expiry inclusively. Equal-width dates require archived chain evidence
or a sourced trading calendar; unknown dates are omitted and known missing
stock/date cells remain blank. The archive stores front expiry only, so the next
contract on the previous expiry date may be missing. Heatmap OI values, tooltips and scale labels use lots: stored lot units pass
through, otherwise divide by archived lot size or explicitly labelled current
universe ticker Lot metadata. Missing lot sizes leave OI unavailable. This is
a display conversion only; archive values and Z-score calculations stay raw.
CE/PE modes show OI in lots;
CE âˆ’ PE mode shows signed call-minus-put OI at every strike in lots. Both
sides must be available; missing legs stay blank, and negative differences are
retained in the visible rainbow min/max. Spot is a thick white line with a dark outline and daily markers, broken at
missing dates. The Background grid toggle defaults off and persists within the page. Vertical
grid lines and X tick marks divide adjacent date centres; horizontal grid lines
and Y tick marks cover each visible archived strike. Date labels stay centred on
their date columns. Grid follows zoom/pan and sits behind spot and OI labels.
Y-axis ticks use actual archived strikes only, thinning labels
when crowded; zoom/pan never introduce interpolated strike labels. Rainbow min/max follows
visible cells after two-axis wheel zoom, drag pan or mode changes. Shift-wheel
zooms dates, Alt-wheel strikes; reset/double-click restores the full cycle.
The Â± strikes from ATM control defaults to 8 (1â€“80 per side, plus ATM),
centres the Y window on the latest archived ATM (ties lower), and preserves
the current date window when edited. Reset restores this chosen strike window;
the count persists across symbols, expiries and archive reloads within the page.
Reload archive refreshes saved data without provider requests.
The Top 3 OI strikes view and labels are enabled by default and use one full-width column per day. Daily CE/PE
rankings cover all archived strikes before viewport filtering; ties prefer lower
strikes. Only highest CE/PE cells are colored red/green; shared maxima are yellow.
Optional labels combine overlapping CE/PE entries: rank 1 in lots, ranks 2/3 as
percentages of the corresponding daily maximum, without secondary cell fills.
Secondary labels use CE2, CE3, PE2 and PE3. Highest OI text is white.
Secondary CE text is red and PE text green,
with opacity proportional to the daily side maximum (12% minimum for readability).
PCR is daily highest PE divided by highest CE, shown in tooltips and beneath
the CE maximum label; missing/zero CE makes PCR unavailable. Axes, strike window,
zoom/pan and outlined spot line are shared; controls persist within the page.

Below the OI expiry-cycle heatmap, `frontend/oi-zcycle.js` plots daily closing
ATM CE/PE OI Z-scores from GET `/api/history/oi/zscore-cycle?ticker=...&expiry=...`.
The endpoint calculates locally from archive projections, independently of the
stored latest/live baseline update. It uses each day's ATM, prior monthly expiries,
3M/6M/1Y observation-date windows, sample SD, minimum 3 samples, and existing
previous-observation DTE fallback (DTE 0/1 exact only). Known target/baseline unit
or lot changes disable scores. It excludes the current expiry from baselines.
Dates and inclusive cycle boundaries follow the OI heatmap evidence rules;
missing chains/scores break lines. CE red, PE green; signed Y scale fits enabled
visible scores, zero and dotted horizontal reference lines at +3 and −3 (always
within the displayed Y range). Expiry/period/side controls, hover with baseline sample
dates, date zoom/pan, reset and reload are independent from the OI heatmap.
Same-symbol live refresh preserves its viewport and avoids repeated archive reads.
`frontend/chain-panels.js` provides independent Collapse/Expand controls on the
option-chain table and both expiry-cycle bodies; state survives refresh and
symbol changes within the page, with ARIA expanded/controls attributes.

The watchlist opens from the left and reserves 330px on desktop; narrow screens
show it in normal page flow above content. `frontend/watchlists.js` owns named
lists, selection, comma/newline bulk input, alias normalization and deduplication,
individual removal, clear/delete controls and localStorage persistence in this
browser. Built-in Sectors (initial default) and All symbols are read-only.
Sectors keeps indices separate and caches provider sector memberships locally;
first-load/explicit refresh fetches components sequentially in the background,
showing current groups and unclassified stocks immediately. Opening a cached list
never waits for sector requests. The refresh button rebuilds local lists and
refreshes sector membership when Sectors is selected. Unknown bulk names are
reported and omitted. IV high/low and Z-score matched/all results expose symbol
checkboxes, select/deselect all displayed rows and destination-watchlist selection.
Selections persist across polling and sorting for the same scan/update and reset
for a new one. Custom watchlists are browser-local, not server/account synced. IVP/IVR and skew hidden-series selections
persist when loading another stock or refreshing data.
The dashboard also includes IVP/IVR history, volatility skew, and IV
term structure. Backend metrics use the full normalized Dhan chain, even when
displayed strikes are limited. Preserve `_all_strikes` and coverage metadata.
The existing max-pain implementation is an absolute-distance weighted OI
calculation; do not assume it implements a different payoff formula.

Term structure is currently restricted to NIFTY and SENSEX. It supports expiry
selection, call/put/OTM modes, strikes around ATM, and interactive canvas views.
The skew endpoint currently constructs one expiry series from the current chain.
Sectors include summaries, component expansion, a heat/pie view, and intraday
charts with absolute/percentage display options.

## Provider and date contracts

- AOC has explicit `providers.aoc.api_mode` (`legacy` default or `v27`), with
  `FNO_AOC_API_MODE` override. Local configuration selects v27. V27 routes tickers,
  live-data and expiry lists to `v27_base_url`; array lists and unwrapped compact
  chains are supported. Historical and sector routing remain legacy pending
  verification. See `docs/aoc-api-migration.md` for captures and rollback.

- AOC uses a bearer token and compact `k`/`v` arrays. Normalize by column name,
  not by assumed column position. AOC also supplies ticker/lot metadata.
- Dhan's `authorisation` header is a literal value, normally `Token`; the JWT
  goes separately in the `auth` header. Do not concatenate `Token Token`.
- Symbol mapping uses scanx segments: indices `0`, equities `2`. Analytics uses
  indices `0`, equities `1`. The chart-facing `ivp_ivr()` translates scanx IDs;
  `analytics_history()` receives analytics IDs directly. Never translate the
  movers' `segId=1` through the scanx mapping again.
- Mapping/search aliases include `LT -> LARSEN`, `NIFTY_2 -> NIFTY`, and
  `M&M -> MAHINDRA`.
- Dhan `expdatej` expiry IDs use an epoch offset of `315532800` seconds for
  display. Preserve the distinction between raw expiry IDs and Unix timestamps.
- Dhan analytics history contains aligned arrays: `date`, `ivp`, `ivr`, `iv`,
  `spotPrice`. Observed dates are `DD-MM-YYYY`; text-month dates also occur in
  tests. Responses can be newest-first and contain invalid/padded values.
- Parse numeric day-month-year dates explicitly. Browser `Date.parse()` can
  treat ambiguous dates as US month-first and discard other dates. Keep values
  paired with their original date before sorting. Latest values come from the
  newest valid date, not an assumed first/last array position.
- Dhan stock history works in the verified live calls. Do not assume analytics
  is index-only merely because an old UI message suggests that.

## Established chart behavior

IVP/IVR dates display consistently in IST with year labels. Unix seconds and
milliseconds are supported by the frontend parser. Hover lookup finds the
nearest plotted calendar timestamp, rather than assuming rows are evenly
spaced. IVP/IVR tooltips retain up to two decimals.

Skew Call IV is green (`#00ff00`) in its line, markers, legend, and tooltip;
Put IV is red and OTM IV is cyan/dashed. The **Â± strikes from ATM** input defaults
to 8 per side, accepts 1â€“80, and includes ATM. Reset restores that window;
available strikes bound each side. The Y-axis fits the visible strikes and
enabled series, including OTM-only display, with padding at both ends. Changing
the strike count, zooming, panning, or hiding a series recalculates the scale;
do not revert to a fixed zero-based Y-axis for skew.

Scanner page boxes have independent Collapse/Expand and Clear results controls.
Clearing hides displayed results for the current page until the relevant Run or
Update action; polling cannot restore them. It does not cancel jobs or delete
stored scores/archive data. Collapse state survives updates within the page.

## IV scanner contract

1. Fetch Dhan `/chart-analytics-api/ivmovers` with:
   `{"data":{"exch":"NSE","page":1,"count":350,"lookback":"1y","flag":"HighestIVP"}}`.
2. Stock rows are `exch=NSE`, `segId=1`; exclude indices. Use `symbol`, `secId`,
   `atmiv`, and `ivp` directly. Deduplicate by security ID. The current scan
   universe is the returned first page; full future pagination is not implemented.
3. Apply strict current IVP cutoffs first: high `ivp > high`, low `ivp < low`.
   Defaults are 80 and 20; require `0 <= low < high <= 100`.
4. Each group has an independent direction toggle, enabled by default:
   **Require IV falling for high IVP**, **Require IV rising for low IVP**.
   When disabled, show all cutoff matches, make no history requests for that
   group, and include stocks with insufficient history. Show current IV/IVP only.
5. For enabled groups, fetch the existing one-year IVP/IVR history with analytics
   segment 1 and the movers' security ID. Smooth both IV and IVP with a trailing
   simple moving average. Smoothing defaults to 3 observations, range 1â€“20.
6. Lookback X defaults to 5, range 1â€“60, and means **valid dated daily
   observations**, not calendar days. The source can include current-day
   snapshots. Compare the latest smoothed IV with X observations earlier;
   this is net change, not a requirement for monotonic daily movement.
7. Require at least `X + smoothing` valid rows. Sort dates, deduplicate them,
   exclude invalid dates, nonfinite/nonpositive IV, or IVP outside 0â€“100.
   Zero IVP is valid. High group matches negative smoothed IV change; low group
   matches positive change, using a small numerical tolerance.
8. Results show current IV/IVP separately from smoothed start/end values and
   actual history dates. IV absolute change is in percentage points; relative
   IV change is a percentage. Enabled groups sort by relative change strength;
   IVP-only high/low groups sort by descending/ascending IVP respectively.

One background daemon worker runs per application process. State is protected
by a lock and exposed as copied snapshots. Progress and partial results are
available while running; skipped stocks have reasons. Cancellation stops after
the in-flight request. Authentication/configuration/rate-limit errors stop a
scan; other provider failures skip that stock. Scans and caches are in-memory
and disappear on server restart. The UI can restore the last scan after reload.

Analytics requests are serialized behind a provider lock and paced at least
one second apart. History cache TTL is 900 seconds, shared with the IVP/IVR
chart; movers TTL is 300 seconds. HTTP 429 stops the scan and sets a cooldown
of at least 60 seconds or numeric Retry-After. Avoid burst requests or automatic
retry loops against Dhan. These are app pacing rules, not a verified official
Dhan quota.

Changing controls requires **Run scan**. Edited controls must not be overwritten
by delayed status responses. Scan responses must explicitly acknowledge the
boolean `falling`/`rising` flags; an older backend must produce an upgrade/restart
message instead of silently resetting the toggles or displaying filtered results
as IVP-only results.

## Routes

Highest OI closing scanner uses `services/oi_levels.py` and `frontend/oi-levels.js`.
POST `/api/scanners/oi-levels/run` reads local archive projections in one consistent
SQLite transaction; no provider requests or archive writes. Bullish targets highest
PE OI, bearish highest CE OI. Optional strict filters: absolute close-to-strike
distance / selected strike × 100 < X; absolute index distance between CE/PE maxima
on the sorted available strike grid > Y; selected-side second/highest OI × 100 < Z.
Ties prefer lower strikes. N defaults to 0 (latest close only), range 0–60;
N applies only to the second OI filter and includes latest close in N trading dates.
Dates require archive evidence or sourced trading calendar; missing dates and
expiry changes fail history rather than shortening the window. Latest close uses
the latest archive/calendar trading date before today IST, shared by all stocks.
The panel supports independent collapse, clear, and matched-stock watchlist export.
Controls apply only on Run; results show applied settings, archive date and exclusions.

ATM OI Z-scores are implemented in `services/oi_zscore.py` and
`frontend/oi-zscore.js`, with additive SQLite `oi_z_baselines`, `oi_z_scores`,
`oi_z_meta` tables (archive schema remains 5). Scanners provides a manual rolling
update and filters for period, side, direction and threshold.
On page reload, Z-score stock lists stay empty until **Run Z-score scan** is
clicked with valid settings. Startup status, update actions, polling, search and
sorting do not reveal stocks before that first scan; stored scores are preserved.
The matched and all-stocks lists support immediate CE/PE Z sorting high to low
(unavailable last) and case-insensitive stock search, without rerunning the scan.
Combined CE-high/PE-low and PE-high/CE-low setups require dominant Z >= threshold
(default 2) AND opposite Z <= signed cutoff (default 0), both finite in the same
period. Run applies edits; direction is disabled for combined setups. Default
scan-strength sorting uses dominant-minus-opposite Z and exposes the gap column.
Stored closing scores and Live current ATM scores use raw OI, sample SD, minimum 3 prior monthly expiries,
calendar DTE with previous-observation fallback and each day's own ATM (ties lower), excluding current expiry.
Rolling 3/6/12-month windows use prior observation dates; counts, sample dates and
unavailable reasons are exposed. Missing exact historical DTE uses the latest earlier archived observation per prior expiry (larger DTE), except DTE 0 and 1 which require exact matches. No lot imputation.
Updates use local projections only and replace results atomically. Live requires
baselines updated for today's IST date. Total OI is replaced by a 3M/6M/1Y CE/PE
Z-score card, blank for indices; PCR (Vol) is removed for all symbols.
Undated weekend quotes show the persisted latest archived closing scores for the
same expiry, explicitly labelled with closing date/DTE. Stale dated quotes require
an exact archived-date match for this fallback; current OI is never re-dated.
Provider
unit/corporate-action comparability is unverified; known lot/unit changes disable
scores. POST `/api/scanners/oi-zscore/update`, GET `/api/scanners/oi-zscore/status`.
See `docs/oi-history.md` for the calculation and storage contract.

The daily OI archive is in `services/oi_history.py` and `oi_downloader.py`; see
`docs/oi-history.md`. Scanners has Data update/Cancel update controls implemented
in `frontend/oi-history.js`. SQLite data persists in `data/oi_history.sqlite3`.
Per-strike rows include call/put IV, delta, gamma, theta, vega, prices, OI and
volume, while raw normalized snapshot/strike fields are retained once in a
zlib-compressed JSON BLOB in `chains.payload` (schema 4). Decode requested chains
with `OIHistoryStore.read_chain()`; the legacy per-strike `fields` column holds
`{}`. Startup migrates legacy archives in resumable 32-chain transactions, preserving
all raw fields and skipping migration scans after completion. The downloader
queries missing tasks one date at a time using SQL, with a date-first chains index.
HTTP archive summaries are cached for 30 seconds and invalidated at job termination;
progress remains current. `scripts/compact_oi_history.py` is an offline backup,
full preservation verification and VACUUM tool; compaction never runs automatically.
Updates fetch historical expiries once using RELIANCE and reuse the shared stock
expiry list for every stock, then archive the front expiry per date
for a trailing calendar year through yesterday before 16:00 IST, or through today
at or after 16:00 IST, filling gaps and skipping saved
dates. Current stock membership uses the existing map and targeted Dhan searches
for new names; do not regenerate the entire map. Historical absence stays missing.
Requests use 16:00 IST and only accept matching source dates/timestamps in the
15:25â€“16:00 closing window. AOC returns stale previous-date snapshots on weekends
and after expiry: never save them as the requested date. Calendar DTE is exact;
session DTE returns null unless a full sourced calendar is available. Unknown
dates are probed without assuming weekday trading or global holidays.
AOC v27 mode routes historical/expiry APIs through `v27_base_url` alongside live data.
Legacy mode uses `providers.aoc.history_base_url` (default
`https://api.niftychain.in/api/v10`). V27 sector intraday uses `sectorial-intraday`;
per-sector point objects are normalized to shared timestamp-aligned arrays,
with missing bars kept as nulls. Legacy compact responses remain supported. All AOC requests share serialization and
`request_interval_seconds` (default 2, minimum 1); this is not an official quota.
User-supplied holidays in `services/oi_calendar.py` are excluded before requests.
If the first six actual fetches on a date are unavailable, skip the remaining
stocks for that date and persist a separate `day_skips` record (SQLite schema 3).
Successes or validation errors among those first six prevent the shortcut;
stored data on that date also prevents it. A sampled skip is not a holiday and
does not change session DTE. UI progress separates processed, fetched and skipped
tasks; coverage details list persisted skip dates and supplied holidays.
429 sets a cooldown of at least 60 seconds or Retry-After and stops the update.
Transport/auth failures stop. Each stock/date/expiry error is retried only until
three failed attempts have been recorded; exhausted gaps are excluded from future
updates. Schema 5 persists error counts; legacy errors count as one known failure.
Coverage displays the exhausted-gap count. Saved data clears the attempt record.
Jobs are in-memory, but completed snapshots and unavailable/error records persist.
Restarted backfills resume when Data update is clicked; there is no auto-resume.

- POST `/api/history/oi/start`.
- GET `/api/history/oi/status`.
- POST `/api/history/oi/cancel?id=<id>`.

- GET `/api/health`, `/api/ready`, `/api/config`.
- GET `/api/tickers`, `/api/expiries`, `/api/data`, `/api/historical`.
- GET `/api/dhan/map`, `/api/dhan/chain`, `/api/dhan/ivpivr`, `/api/dhan/skew`,
  `/api/dhan/term`.
- GET `/api/sectors`, `/api/sectors/intraday`, `/api/sectors/components`.
- POST `/api/scanners/iv/start?high=80&low=20&days=5&smoothing=3&falling=true&rising=true`.
- GET `/api/scanners/iv/status?id=<id>`; omit ID for latest state or idle.
- POST `/api/scanners/iv/cancel?id=<id>`.
- Scanner action arguments are query parameters, even on POST. GET requests to
  start/cancel are rejected. Errors use structured JSON with messages/codes;
  a second concurrent scan receives HTTP 409.

## Configuration, running, and validation

`config.json` is merged with defaults; `FNO_CONFIG` selects another file.
Environment overrides include `FNO_AOC_TOKEN`, `FNO_DHAN_JWT`,
`FNO_DHAN_ENTITY_ID`, `FNO_DHAN_CLIENT_ID`, `FNO_DHAN_AUTHORISATION`,
`FNO_SERVER_HOST`, `FNO_SERVER_PORT`, `FNO_DATA_DIR`, `FNO_STATIC_DIR`,
`FNO_REQUEST_TIMEOUT_SECONDS`, `FNO_REFRESH_SECONDS`, and `FNO_PUBLIC_BASE_URL`.
Older AOC/Dhan credential environment names are also supported in `config.py`.
Relative static/data paths resolve against the selected config directory.

Typical commands from the repository root:

```text
python -m pip install -r requirements.txt
python run.py
python scripts/build_symbol_map.py
python -m unittest discover -s tests
node --check frontend/app.js
node --check frontend/scanners.js
node tests/test_ivr_chart.cjs
node tests/test_scanner_controls.cjs
```

On the user's Windows machine, the `python` command may resolve to the Microsoft
Store placeholder. A working interpreter was found at
`C:\Users\manas\anaconda3\envs\collab\python.exe`; discover available runtimes
if commands fail. Do not assume globally installed Node/Python.

Backend modules are loaded once: after Python changes, restart the actual
running app, not merely a separate test server. Frontend changes need a reload
(Ctrl+F5 when stale). A previous defect was an old backend on port 8000 paired
with new static files: toggles re-enabled because flags were missing, and only
POLICYBZR appeared under IVP > 70. Restarting the real app resolved it; a live
IVP-only check returned 42 high matches and 17 low matches at cutoffs 70/30.
These counts and market values are historical verification examples, not fixed
expected outputs or recommendations.

Frontend assets and API requests use page-relative URLs, supporting both `/`
and `/fnoanalyzer/` with Nginx stripping the prefix. Always redirect the bare
prefix to its trailing-slash URL. `FNO_PUBLIC_BASE_URL` remains informational;
it does not configure routing. See `docs/ec2-subpath.md` for installation on the
existing trading-journal Nginx host, using loopback port 8001 and a separate
secret-free config. The subpath Nginx snippet must be included inside the existing
server block, not installed as a standalone conf.d server.

Docker uses Python 3.12 and publishes port 8000 on loopback with persistent
`fno-data`; Nginx and systemd examples are in `deploy/`. See `README.md` for
deployment commands and environment setup.

## Working conventions

- Preserve the existing lightweight stack and dark UI unless asked to change it.
- Keep changes scoped; preserve user edits. `config.json` may contain local
  credentials and must not be dumped, copied into docs, or committed with secrets.
- Never put tokens/JWTs, authorization headers, account IDs, or captured private
  request material in logs, tests, screenshots, or documentation. Use environment
  variables for deployment credentials; do not regenerate the map unnecessarily.
- Validate calculations with synthetic data and meaningful tests. For provider
  integration, make small read-only probes and inspect shapes without printing
  credentials. Do not treat a live stock count as a stable test assertion.
- Test the actual running backend/frontend combination when fixing state bugs.
  Distinguish edited controls, applied scan settings, cached data, and current
  provider values. Avoid reporting old scan results as a newly applied filter.
- Use IST explicitly, preserve date/value alignment, distinguish scanx versus
  analytics segments, and respect shared pacing/caches when extending scanners.
- Check `git diff --check`; avoid wholesale newline changes or unrelated rewrites.
- No trades, order placement, or brokerage transactions are implemented here.
- GET `/api/scalper/chain?ticker=...&expiry=...` is the Scalper Terminal's
  browser-token snapshot bridge. It uses only the existing Dhan browser client,
  verifies exact expiry, retains acquisition time, and shares a one-second cache
  under a lock. It returns all normalized strikes, without analytics or AOC fallback.
  Token Sync continues to own the browser JWT; no token is returned to the terminal.


## Option Fair Price

`frontend/fair-price.js` provides a separate tab after Scanners with its own Dhan
symbol/expiry selectors, one independent call box on the left and one put
box on the right (stacked on narrow screens). Each box has an ATM-centred strike
selector (configurable 1–80 available intervals per side, default ±8 plus ATM), segmented Buy/Sell radios, entry spot and nonnegative SL /
target distances (SL defaults to 25 points). Buy CE / sell PE use SL below and target above entry; sell CE /
buy PE reverse this. It preserves the OPTION-FAIR_PRICE widget calculation:
max(0, LTP + delta × spot move + 0.5 × gamma × spot move² + theta / 7).
Missing/invalid signed delta, gamma, theta or LTP leaves projections unavailable;
no IV fitting or quote substitution. Expired contracts use intrinsic value.
GET `/api/fair-price/expiries?ticker=...` lists active Dhan expiries; GET
`/api/fair-price/chain?ticker=...&expiry=<raw expdatej>` uses the shared configured
Dhan client/cache and full chain, including normalized cG/pG and cT/pT fields.
No credentials reach the browser. Cache acquisition time is shown in IST. Auto
refresh runs every 10 seconds only while this tab is active, backing off to 60
seconds after errors and clearing unavailable quotes. Scenario inputs survive
quote refresh; symbol changes reset entry spots. Delayed responses are discarded
when symbol/expiry changes. Tests: `node tests/test_fair_price.cjs` and
`python -m unittest discover -s tests -p test_fair_price.py`.

Fair-price layout emphasizes current premium, entry inputs and the scenario price
table. Each side explains its applied SL/target direction and always shows quote
Greeks. Buy is green and Sell red; the calculation method is expandable.
Changing the shared strike count immediately rebuilds both dropdowns locally,
preserving selected strikes within the window and falling back to ATM otherwise.
