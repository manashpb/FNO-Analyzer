# AOC API migration reference

Recorded 2026-10-12 from repository code and user-supplied browser captures.
No credentials are stored here. The v27 contract is incomplete; these captures
do not establish expiry, historical, sector, or full-chain compatibility.

## Existing implementation (rollback reference)

- Live/ticker/sector base: `https://apim4.niftychain.in/api/v10`.
- Historical/expiry base: `https://api.niftychain.in/api/v10`.
- Authentication: `Authorization: Bearer <TOKEN>`.
- All requests use GET.
- Tickers: `/get-tickers`, no parameters; object with a `data` array.
- Live: `/live-data?symbol=<TICKER>&cacheBust=<UNIX_MILLISECONDS>`.
- Expiries: `/get-expiry-dates?ticker=<TICKER>`.
- Historical: `/historical-data?ticker=<TICKER>&expiry=<EXPIRY>&timestamp=<UNIX_MILLISECONDS>`.
- Sectors: `/sectorial-data-compact`.
- Sector intraday: `/sectorial-intraday-compact?startTime=<MS>&endTime=<MS>&interval=<INTERVAL>`.
- Sector components: `/sectorial-components-compact?sectorId=<ID>`.
- Chain response: object containing `data.snapshot` and `data.strikes`, each
  using compact `k`/`v` fields; normalize by column name.

## Captured v27 requests

- Base: `https://v27.aoccalculator.in/api/v27`.
- Tickers: GET `/get-tickers`, no body or query parameters, HTTP 200.
- Ticker authentication: `Authorization: Bearer <TOKEN>`.
- Ticker response: top-level array of objects with `Diff`, `Fav`, `Lot`, `Name`,
  `Sid`, optional `disp`, and `userFav`.
- Live summary: GET `/public/oc-summary/NIFTY`, no body or query parameters,
  HTTP 200. No Authorization header appears in the supplied capture.
- Browser sends Origin `https://aoccalculator.in` and Referer
  `https://aoccalculator.in/`; whether the server requires them is unverified.
- Live summary response has not yet been supplied. Do not assume it contains
  the per-strike chain or supports the legacy compact parser.

## Rollback and migration constraints

Keep legacy endpoint paths and normalization available when implementing v27.
Select the API version explicitly rather than retrying authentication failures
against alternate hosts. Preserve separate historical routing until new
historical and expiry requests are verified. A rollback must restore both the
endpoint selection and its corresponding response parser, not just the hostname.
Do not save browser authorization values, cookies, or unredacted request exports.

The provider now supports explicit `api_mode: "v27"` for tickers, live-data and
expiry lists, using `v27_base_url`. The local configuration selects v27.
To roll back, set `providers.aoc.api_mode` to `legacy` and restart the app
(or set `FNO_AOC_API_MODE=legacy`). Existing legacy base URLs are preserved.
Historical and sector routes still use the existing legacy bases.

Additional read-only probes confirmed v27 GET `/live-data?symbol=NIFTY`
returns an unwrapped compact chain and GET `/get-expiry-dates?ticker=NIFTY`
returns a plain array. Ticker array and chain normalization support both modes.

## Historical range probe (2026-10-12)

One authenticated, read-only request using the locally configured token returned
HTTP 200 JSON (9,724 bytes):
`GET https://v27.aoccalculator.in/api/v27/historical-data?ticker=NIFTY-AI&expiry=27-Oct-2026&timestampFrom=1791775800000&timestampTo=1791777410323`.

- Requested IST range: 2026-10-12 09:00:00 through 09:26:50.323.
- Response has top-level `snapshot`, `strikes`, `changes`, and `spotSeries`;
  there is no legacy `data` wrapper.
- `snapshot`: compact `k`/`v`, 70 columns. Returned symbol `nifty`, expiry
  `13-Oct-2026`, source date `12-Oct-2026`, timestamp 09:31:00.327 IST.
- `strikes`: compact `k`/`v`, 16 rows with 56 columns including strike, call/put
  LTP, OI, OI change, volume, IV, Greeks and contract names. Contract names
  also identify 13 October, not the requested 27 October expiry.
- `changes`: 8 rows, 9 columns of timestamped levels and maximum-OI/volume
  strikes. At least one returned timestamp is later than the requested end.
- `spotSeries`: empty `k` and `v` arrays.
- Snapshot underlying value `uv` was 22571.45; futures price `fp` was 22625.
- No bid/ask columns appear in the returned strike column list; do not substitute
  LTP for spread quotes.

This call returns chain data, not merely a live-price series. The mismatched
expiry and out-of-range snapshot prevent treating this endpoint as verified
historical-range storage or expiry selection. `NIFTY-AI` may have special
routing, but that explanation is unverified. Preserve source-date/expiry
validation; do not archive this response under the requested expiry/time.

## Sector watchlist routing verification (2026-10-13)

Read-only probes confirmed v27 `/sectorial-data-compact` and
`/sectorial-components-compact?sectorId=13` return HTTP 200 with unwrapped
column arrays. The legacy components host rejected the current configured token.
Explicit v27 mode now routes summaries and components to v27, wrapping summaries
in `data` and accepting either wrapped or unwrapped component arrays. Legacy mode
keeps legacy routes and parsing. Sector intraday remains on its legacy route
pending separate verification. No authentication-failure retry or host fallback
was added. Browser Sectors watchlists retain memberships locally after loading.
