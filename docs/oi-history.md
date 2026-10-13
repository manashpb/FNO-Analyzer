# Daily OI archive framework

`services/oi_history.py` provides a standard-library SQLite archive, and
`services/oi_downloader.py` handles background incremental updates. In Scanners,
click **Data update** to backfill or resume; **Cancel update** stops after the
in-flight request. Reload restores the running job. Saved data and missing-date
records persist across server restarts; jobs do not automatically restart.

AOC historical requests and expiry discovery use
`https://api.niftychain.in/api/v10`, configurable with
`providers.aoc.history_base_url`. Live requests retain their existing base URL.
All AOC requests share a lock, with a configurable
`providers.aoc.request_interval_seconds` default of 2 (minimum 1). This is an
application precaution, not a verified official quota. HTTP 429 stops updates,
with a cooldown of at least 60 seconds or Retry-After (seconds or HTTP date).
Authentication and transport failures also stop updates without automatic retries.

The intended database location is `data/oi_history.sqlite3` (git-ignored).
No external database service is needed. Connections close after each transaction.
Full normalized chains and snapshot fields are retained alongside indexed ATM
call/put OI, spot, strike, expiry, calendar DTE, source observation timestamp,
fetch timestamp, lot size and OI unit. Schema v2 also stores per-strike call/put
OI, OI change, volume, price, IV, delta, gamma, theta and vega in
`option_strikes`. Schema v4 retains every original field once in a zlib-compressed
UTF-8 JSON BLOB in `chains.payload`; queryable numeric columns remain unchanged.
The legacy `option_strikes.fields` column contains `{}` and is no longer a raw
field source. Use `read_chain(symbol, day, expiry)` to decode one requested chain;
`decode_payload()` supports both legacy text and compressed data. Schema v3 adds
persisted date-level download skips separately from the exchange calendar. AOC's Greek keys are
`cD/pD`, `cG/pG`, `cTh/pTh`, `cV/pV`; IV uses `cIV/pIV`.
Missing OI/Greeks stay null; zero OI is valid. Historical lot size and OI units
remain unknown unless the provider establishes them; today's lot size is not
retroactively assigned to older observations. Current ticker metadata is stored
separately in the universe.
ATM is the closest available strike to spot; equal distances choose the lower
strike. Provider timestamps must match the actual observation date in IST.
The provider adapter must also verify symbol/expiry, snapshot completeness,
OI units and the end-of-day convention before ingesting a response.

The current AOC ticker roster is filtered using the existing stock map, known
non-stock symbols and targeted Dhan searches for new unclassified symbols.
The map is not regenerated. Unclassifiable symbols stop the update rather than
silently omitting possible new stocks. Historical absence is not a zero
observation. Universe refreshes preserve previously archived symbols.

Historical expiry dates come directly from one AOC `get-expiry-dates` request
for RELIANCE per update. The shared stock expiry list is reused for every stock;
snapshot availability is still checked separately for each stock/date/expiry.
The archive scope is the nearest
expiry for each date, not every simultaneously listed expiry. Each contract's
`first_date` is its front-expiry selection window (day after the preceding
listed expiry), not proof of a stock's historical listing date. A truncated
expiry roster may limit actual coverage, which is shown per stock.

The supplied 2025/2026 holiday dates are installed with user provenance and are
excluded before requesting any stock snapshot. Existing chains are retained.
The downloader probes other unknown calendar dates, including weekends, because no
verified exchange calendar feed is supplied. Only a same-date returned snapshot
proves that day has trading data. A stale snapshot or 404 is recorded as
unavailable for that stock/date/expiry. If the first six actual stock fetches
for a date are all unavailable (empty, wrong-date snapshot, or 404), the remaining
stocks are skipped. A success or validation error among those first six prevents
the shortcut, as does any already stored chain on that date. Provider/auth/rate
errors still stop the job. Sampling resets on each date and excludes previously
saved/unavailable stock tasks. A heuristic date skip is persisted in `day_skips`
and excluded from future update plans; it is not declared a calendar holiday and
does not affect session DTE. Date skips and user holidays are shown in the UI's
coverage details. Heuristic skips may omit a stock that has data despite the six
unavailable samples; this is the explicitly requested request-saving rule.
Empty expiry discovery stops the update. Calendar holidays/exceptional sessions
can be populated via `set_calendar` with explicit provenance.
Calendar DTE counts all days to expiry. Session DTE counts trading sessions after
the observation through expiry and returns null for incomplete calendars. Both
are zero on expiry day. Session DTE is computed from the calendar so corrected
calendar entries do not leave stale derived values.

`candidate_plan(start, end)` returns missing symbol/date/expiry tasks for active symbols,
including interrupted-download holes. Stored snapshots are skipped, so repeated
updates fetch subsequent dates without redownloading completed history.
Errors remain retryable; explicit provider-confirmed unavailability is recorded
and skipped. Transport/authentication errors must never be marked unavailable.
`plan(start,end)` remains available for callers with a complete verified calendar.
No data retention deletion is automatic. `status()` reports actual stored
coverage and missing/error attempt counts. HTTP polling shares a thread-safe
30-second summary cache, invalidated when an update finishes, fails or is cancelled.
Job progress remains current; archive totals can lag by up to 30 seconds while running.
The background updater counts and downloads candidates one date at a time using
SQL anti-joins, rather than loading the entire saved archive key set or pending
year into memory. `candidate_plan()` is a compatibility helper that still returns
a list; the worker uses `iter_candidate_days()` directly. A date-first chain
index supports existing-data checks.

Discovery finishes before chain downloads begin. Updates use a trailing calendar
year through yesterday in IST. Snapshot requests use 16:00 IST; accepted snapshots
must be between 15:25 and 16:00, with matching symbol, expiry, source date and
timestamp. Earlier intraday snapshots are retryable validation errors, not daily
closing data. Exceptional sessions with different hours currently need explicit
support. Provider expiry dates are never replaced by assumed weekdays.
Initial backfills can take days at conservative pacing; the dashboard estimates
the minimum pacing time and reports saved/unavailable/error counts separately.
The browser need not stay open, but the backend must remain running.

Routes: POST `/api/history/oi/start`, GET `/api/history/oi/status`,
POST `/api/history/oi/cancel?id=<id>`. GET start/cancel is rejected; concurrent
updates receive 409. Query parameters are used on POST, as for the IV scanner.

The ATM OI Z-score scanner is implemented in `services/oi_zscore.py` and
`frontend/oi-zscore.js`. Click **Update rolling Z-scores** after the archive
download finishes. It makes no provider calls. SQLite tables `oi_z_baselines`,
`oi_z_scores`, and `oi_z_meta` retain an atomically replaced generation across
restarts; background job progress itself is in-memory. The additive tables do
not change archive schema version 5. POST `/api/scanners/oi-zscore/update` starts
the update; GET `/api/scanners/oi-zscore/status` returns progress and stored scores.
Repeated concurrent updates receive 409. Reload restores progress/results.

Confirmed method: raw ATM CE/PE OI, sample standard deviation (n−1), at least
three prior monthly expiries, and calendar DTE matching. Z = (target OI − prior
mean) / prior SD. Each observation uses its own closest-to-spot ATM (ties lower).
One observation per prior expiry is available at any exact calendar DTE;
the target/current expiry is excluded. The 3/6/12-month windows use calendar
month subtraction with month-end clamping and select prior observation dates
on/after the cutoff and strictly before the target date. For target DTE >= 2, missing exact DTE uses the latest earlier archived
observation in that prior expiry (the smallest available larger DTE). DTE 0
and 1 require exact matches. Later observations are never used. Selection stays
within the rolling window and uses one date per expiry for both sides; missing
leg OI stays unavailable. Samples expose actual DTE, target DTE and fallback flags. Zero OI is valid; missing OI, fewer than three
samples, zero variance, known unit differences or known lot changes yield an
unavailable score with a reason. Both sides expose mean, SD, count and individual
sample dates, expiries, ATM strikes and OI.

Scanner results are closing scores for each active archived stock's latest
available closing date, which is explicitly shown. **Run Z-score scan** applies
period, side, positive/negative/absolute direction and threshold to these stored
scores, sorted by strength. All scores and unavailable reasons remain inspectable.
The Sort control also orders either list by CE or PE Z-score from high to low,
with unavailable values last. Search stock filters both lists immediately by
stock symbol, ignoring case and surrounding spaces. Sort/search preserve applied
scan filters and do not require a new download or scan.
The **CE high + PE low** and **PE high + CE low** setups require dominant-side
Z >= Threshold (default 2) AND opposite-side Z <= its signed cutoff (default 0,
e.g. -1 for stricter filtering). Both sides must have finite scores in the same
selected period. Direction is disabled for these setups. Apply changes with
Run Z-score scan. Scan strength ranks combined matches by dominant Z minus
opposite Z, shown in a gap column; explicit CE/PE sorting remains available.
Joint cutoffs are checked before ranking, so a large gap alone never qualifies.
Different stocks can have different latest dates. Live stock cards show 3M/6M/1Y
CE/PE scores from current ATM OI against stored baselines at today's calendar DTE;
the card is blank for indices and outside Live. Dhan uses the full normalized
chain for ATM selection.
On weekends, an undated live quote uses the persisted latest closing scores
for the same expiry, explicitly labelled with the archived observation date and
DTE. A dated stale quote can show that closing fallback only if its date matches
the stored close. The fallback does not apply current OI to a nearby DTE.
Live baselines include only already expired monthly
contracts, with at least DTE 0–62 available for front-month use. After the date
changes, live scores require a manual update. Status also flags archive changes.
PCR (Vol) is removed from the top cards for stocks and indices.

Live intraday OI is compared with historical closing OI, not matched intraday
history. Historical lot sizes and units are often unknown; raw OI comparability
across AOC/Dhan, splits and other corporate actions is unverified. No retroactive
lot normalization is applied. A one-year archive may not contain three comparable
expiries within a 3-month window, especially when exact DTE falls on a missing
date. Scores describe OI deviations and are not directional trading signals.


Storage migration and compaction:

- Schema v4 migration runs once on startup in transactions of at most 32 chains.
  It checks duplicate raw strike fields before removing them, rebuilds numeric
  projections, and preserves full normalized provider data. Interrupted migrations
  resume using already compressed chains; the schema version changes only when
  all batches finish. Subsequent startups skip the migration scan.
- Updating storage frees SQLite pages for reuse but does not shrink the file.
  Compaction is an explicit offline operation, never part of ordinary startup.
- Stop the application, then run:

  ```text
  python scripts/compact_oi_history.py --database data/oi_history.sqlite3 --backup data/oi_history.sqlite3.pre-v4
  ```

  This retains a SQLite backup, migrates, verifies all raw chain fields and existing
  numeric strike values against the backup, then runs VACUUM and integrity checks.
  It refuses to overwrite an existing backup. Restart the application afterward.
  The backup consumes additional disk space and can be moved to backup storage
  after verification. Allow space for the backup and VACUUM's temporary file.
  Older application versions must not write to a schema-v4 archive.
