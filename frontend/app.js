(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const CE = "#f97583", PE = "#56d364", ACCENT = "#58a6ff";
  const GRID = "#2d3440", TICK = "#8b949e", BG = "#0d1117";
  const REFRESH_MS = 15000;
  const SECTOR_REFRESH_MS = 30000;
  const CHART_PAD_L = 56, CHART_PAD_R = 16, CHART_PAD_T = 14, CHART_PAD_B = 34;
  const SECTOR_COLORS = ["#f8504e", "#ff9f1c", "#ffe600", "#3ddc84", "#1ac8db", "#4c9dff", "#9d5cff", "#ff58b0", "#b7ef20", "#ff6b35", "#2ee6e0", "#ff8c8f", "#c9d1d9", "#d99aff"];
  const ID_DASHES = [[], [5, 4], [], [2, 4], [], [7, 3, 2, 3], [], [4, 2, 1, 2]];

  let state = null;
  let ticker = null;
  let tickers = [];
  let mode = "live";
  let isHistorical = false;
  let source = "dhan";
  let dhanMap = null;
  let chainCount = 20;
  let spreadMode = false;
  let spreadWidth = 1;
  let spreadRupees = false;
  const profileCharts = new Map();
  let chartsVisible = true;
  let timer = null;
  let sectorsTimer = null;
  let sectorState = null;
  let intradayState = null;
  let idChart = null;
  let ivrIvp = null;
  let skew = null;
  let ivrLookback = "1y";
  let skewSeriesIndex = 0;
  let ivrVisible = true;
  let skewVisible = true;
  let ivrChart = null;
  let skewChart = null;
  let term = null;
  let termAll = [];
  let termSel = new Set();
  let termTouched = false;
  let termTicker = null;
  let termCache = new Map();
  let termData = [];
  let termMode = "call";
  let termVisible = true;
  let termChart = null;
  let liveRequest = 0;
  let historicalRequest = 0;
  let analyticsRequest = 0;
  const componentsCache = new Map();
  const expandedSectors = new Set();

  async function fetchJson(url, opts) {
    const resp = await fetch(url, opts);
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const detail = json && typeof json.error === "string" ? json.error : "HTTP " + resp.status;
      throw new Error(detail);
    }
    return json;
  }

  function invalidateRequests() {
    liveRequest++;
    historicalRequest++;
    analyticsRequest++;
  }

  function banner(msg) {
    const b = $("errorBanner");
    if (msg) { b.textContent = msg; b.classList.remove("hidden"); }
    else b.classList.add("hidden");
  }

  function fmtInt(n) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    if (Math.abs(n) >= 1e7) return (n / 1e7).toFixed(2) + " Cr";
    if (Math.abs(n) >= 1e5) return +(n / 1e5).toFixed(2) + " L";
    return new Intl.NumberFormat("en-IN").format(Math.round(n));
  }

  function fmtLots(v, lot) {
    if (v == null || isNaN(v)) return "—";
    if (lot == null || !isFinite(lot) || lot <= 0) return fmtInt(v);
    const l = v / lot;
    if (Math.abs(l) >= 1e7) return (l / 1e7).toFixed(2) + " Cr";
    if (Math.abs(l) >= 1e5) return +(l / 1e5).toFixed(2) + " L";
    const r = Math.round(l * 10) / 10;
    return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 }).format(r);
  }

  function fmtNum(n, d = 2) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    return new Intl.NumberFormat("en-IN", { maximumFractionDigits: d }).format(n);
  }

  function valueNumber(value) {
    if (value === null || value === undefined || isNaN(value) || !isFinite(value)) return null;
    return +value;
  }

  function firstNum(arr) {
    if (!Array.isArray(arr)) return null;
    for (let i = 0; i < arr.length; i++) {
      const value = valueNumber(arr[i]);
      if (value !== null) return value;
    }
    return null;
  }

  function shortErr(msg) {
    const s = String(msg || "error");
    return s.length > 60 ? s.slice(0, 57) + "…" : s;
  }

  function ivrDateMs(value) {
    if (value === null || value === undefined || String(value).trim() === "") return null;
    const text = String(value).trim();
    if (/^\d+(?:\.\d+)?$/.test(text)) {
      const n = Number(text);
      const ms = n < 1e12 ? n * 1000 : n;
      return isFinite(ms) ? ms : null;
    }
    // Dhan supplies day-month-year; never let Date.parse interpret it as US dates.
    const parts = text.match(/^(\d{1,2})[-\/]([A-Za-z]{3}|\d{1,2})[-\/](\d{4})$/);
    if (parts) {
      const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
      const month = /^\d+$/.test(parts[2]) ? Number(parts[2]) - 1 : months.indexOf(parts[2].toLowerCase());
      const day = Number(parts[1]), year = Number(parts[3]);
      const utc = Date.UTC(year, month, day);
      const check = new Date(utc);
      if (month < 0 || month > 11 || check.getUTCFullYear() !== year || check.getUTCMonth() !== month || check.getUTCDate() !== day) return null;
      return utc - 19800000;
    }
    const parsed = Date.parse(text);
    return isFinite(parsed) ? parsed : null;
  }

  function fmtDayLabel(ms) {
    return new Date(ms).toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "2-digit" });
  }

  function fmtExpLabel(s) {
    if (!s) return "?";
    if (s.expiryJ) {
      return new Date(s.expiryJ * 1000).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" });
    }
    return String(s.expiry || "Expiry");
  }

  function shortTermLabel(expiry) {
    const s = String(expiry || "");
    const parts = s.split("-");
    if (parts.length === 3) {
      const dd = parts[0].padStart(2, "0");
      const mm = parts[1];
      const yy = parts[2].slice(-2);
      return `${dd}-${mm}-${yy}`;
    }
    return s;
  }

  function cls(v) { return v > 0 ? "positive" : v < 0 ? "negative" : ""; }
  function sign(v) { return v > 0 ? "+" : ""; }

  function card(label, value, sub) {
    return `<div class="card"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div><div class="sub">${sub || ""}</div></div>`;
  }

  function atmSlipInfo(m, T) {
    const lot = T && T.Lot != null ? +T.Lot : null;
    const row = state && state.strikes.find(r => r.sp === m.atm_strike);
    if (!row) return { value: null, sub: "ATM quotes unavailable" };
    const ce = row.cBid > 0 && row.cAsk >= row.cBid ? row.cAsk - row.cBid : null;
    const pe = row.pBid > 0 && row.pAsk >= row.pBid ? row.pAsk - row.pBid : null;
    const spreads = [ce, pe].filter(v => v != null);
    if (!spreads.length) return { value: null, sub: "no bid/ask data" };
    return {
      value: Math.max(...spreads) * (lot > 0 && isFinite(lot) ? lot : 1),
      units: lot > 0 && isFinite(lot) ? "₹ / lot" : "points",
      sub: `max(CE ${ce != null ? fmtNum(ce) : "—"}, PE ${pe != null ? fmtNum(pe) : "—"})` + (lot > 0 && isFinite(lot) ? ` × lot ${fmtInt(lot)}` : " · lot size unavailable"),
    };
  }

  function renderCards(m, T) {
    const d = m.spot - (m.max_pain ?? m.spot);
    const lot = T && T.Lot != null ? fmtInt(T.Lot) : "—";
    const lotSub = T && T.Diff != null ? `Strike step ${T.Diff}` : "";
    const slip = atmSlipInfo(m, T);
    const z = mode === "live" ? state?.oi_zscore : null;
    const zSub = z ? [3, 6, 12].map(months => {
      const p = z.periods?.[String(months)];
      return `<span title="${escapeHtml(`CE: ${p?.ce?.reason || 'available'}; PE: ${p?.pe?.reason || 'available'}`)}">${months}M CE ${fmtNum(p?.ce?.z)} / PE ${fmtNum(p?.pe?.z)} (n ${p?.ce?.n ?? 0}/${p?.pe?.n ?? 0})</span>`;
    }).join("<br>") + `<br>${escapeHtml(z.reason || `ATM ${z.atm_strike} · ${z.dte} calendar DTE · raw OI`)}${z.basis === 'archived_close' ? `<br>Close ${escapeHtml(z.day)} · ${z.dte} calendar DTE` : ''}` +
      (z.periods?.['12']?.ce?.reason ? `<br>CE: ${escapeHtml(z.periods['12'].ce.reason)}` : '') +
      (z.periods?.['12']?.pe?.reason ? `<br>PE: ${escapeHtml(z.periods['12'].pe.reason)}` : '') : "";
    const ivpD = ivrIvp && ivrIvp.data ? ivrIvp.data : null;
    const latest = ivrIvp && ivrIvp.latest;
    const ivpLatest = ivpD ? (valueNumber(latest && latest.ivp) ?? firstNum(ivpD.ivp)) : null;
    const ivrLatest = ivpD ? (valueNumber(latest && latest.ivr) ?? firstNum(ivpD.ivr)) : null;
    const ivpSub = ivrIvp && ivrIvp.error
      ? shortErr(ivrIvp.error)
      : ivrLatest === null
        ? (source === "dhan" ? (mode === "live" ? "no data" : "live only") : "Dhan source only")
        : "IVR " + fmtNum(ivrLatest) + " · " + ivrLookback;
    const pair = (first, second) => `<div class="card card-pair">${first}${second}</div>`;
    const metric = (label, value, sub) => `<div class="paired-metric"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div><div class="sub">${sub || ""}</div></div>`;
    $("cards").innerHTML = [
      pair(metric(`${tickerName()} · Spot`, fmtNum(m.spot), `<span class="${cls(m.spot_chg)}">${sign(m.spot_chg)}${fmtNum(m.spot_chg)}</span>` + (isHistorical ? " (historical)" : "")),
        metric("Future", fmtNum(m.fut), `<span class="${cls(m.fut_chg)}">${sign(m.fut_chg)}${fmtNum(m.fut_chg)}</span>`)),
      pair(metric("Lot Size", lot, lotSub || (lot === "—" ? "Metadata unavailable" : "")),
        metric(`ATM Slippage · ${slip.units || "points"}`, slip.value == null ? "—" : fmtNum(slip.value), escapeHtml(slip.sub))),
      pair(metric("PCR (OI)", fmtNum(m.pcr_oi), `OI chg PCR ${fmtNum(m.pcr_oi_chg)}`),
        metric("Max Pain", fmtNum(m.max_pain), `<span class="${cls(d)}">${sign(d)}${fmtNum(d)} from spot</span>`)),
      pair(metric("ATM IV · CE / PE", `${fmtNum(m.atm_iv_ce)}% / ${fmtNum(m.atm_iv_pe)}%`, `Skew ${fmtNum(m.iv_skew)}`),
        metric("IVP", ivpLatest === null ? "—" : fmtNum(ivpLatest) + "%", escapeHtml(ivpSub))),
      card("ATM OI Z-score · CE / PE", z ? `${fmtNum(z.periods?.['12']?.ce?.z)} / ${fmtNum(z.periods?.['12']?.pe?.z)} · 1Y` : "—", zSub).replace('class="card"', 'class="card card-wide"'),
      card("Max OI Strikes", `${fmtInt(m.max_oi_ce)} / ${fmtInt(m.max_oi_pe)}`, `CE / PE · expiry ${escapeHtml(m.expiry)}`).replace('class="card"', 'class="card card-wide"'),
    ].join("");
  }

  function tickerName() {
    if (!state || !state.ticker) return ticker && (ticker.disp || ticker.Name) || "—";
    return state.ticker.disp || state.ticker.Name || "—";
  }

  function chainWindow(strikes, atmStrike, spot, n) {
    if (!n || strikes.length <= n) return strikes;
    let idx = strikes.findIndex(r => r.sp === atmStrike);
    if (idx < 0 && spot != null) {
      let best = 0, bd = Infinity;
      strikes.forEach((r, i) => {
        const d = Math.abs((r.sp ?? 0) - spot);
        if (d < bd) { bd = d; best = i; }
      });
      idx = best;
    }
    if (idx < 0) return strikes.slice(0, n);
    let start = idx - Math.floor(n / 2);
    start = Math.max(0, Math.min(start, strikes.length - n));
    return strikes.slice(start, start + n);
  }

  function colMax(view, key) {
    return Math.max(0, ...view.map(r => {
      const v = r[key];
      return v == null || isNaN(v) ? 0 : Math.abs(v);
    }));
  }

  function colRanks(view, key) {
    const vals = view.map(r => {
      const v = r[key];
      return v == null || isNaN(v) ? null : Math.abs(v);
    });
    const uniq = [...new Set(vals.filter(v => v != null).map(v => Math.round(v)))].sort((a, b) => b - a);
    const max = uniq[0], sec = uniq.length > 1 ? uniq[1] : null;
    return vals.map(v => {
      if (v == null) return "";
      const rv = Math.round(v);
      if (rv === max) return "mx1";
      if (sec !== null && rv === sec) return "mx2";
      return "";
    });
  }

  function barStyle(v, maxAbs, side) {
    if (v == null || isNaN(v) || !(maxAbs > 0)) return "";
    const p = Math.max(2, Math.min(100, Math.abs(v) / maxAbs * 100));
    const c = side === "CE" ? "rgba(249,117,131,.20)" : "rgba(86,211,100,.20)";
    const dir = side === "CE" ? "to left" : "to right";
    return ` style="background:linear-gradient(${dir},${c} ${p}%,transparent ${p}%)"`;
  }

  function renderChain(m) {
    if (!state) return;
    $("chainTable").classList.toggle("spread-chain", spreadMode);
    if (spreadMode) { renderSpreads(m); return; }
    const all = state.strikes.filter(r => r.sp != null);
    const lot = state.ticker && state.ticker.Lot != null ? +state.ticker.Lot : null;
    const view = chainWindow(all, m.atm_strike, m.spot, chainCount);
    const cMaxV = colMax(view, "cVol"), cMaxO = colMax(view, "cOI"), cMaxC = colMax(view, "cOIC");
    const pMaxV = colMax(view, "pVol"), pMaxO = colMax(view, "pOI"), pMaxC = colMax(view, "pOIC");
    const rCV = colRanks(view, "cVol"), rCO = colRanks(view, "cOI"), rCC = colRanks(view, "cOIC");
    const rPV = colRanks(view, "pVol"), rPO = colRanks(view, "pOI"), rPC = colRanks(view, "pOIC");
    let rows = "";
    view.forEach((r, i) => {
      rows += `<tr class="${r.sp === m.atm_strike ? "atm-row" : ""}">
        <td>${fmtNum(r.cD)}</td>
        <td>${fmtNum(r.cIV)}%</td>
        <td class="${cls(r.cOIC)} ${rCC[i]}"${barStyle(r.cOIC, cMaxC, "CE")}>${sign(r.cOIC)}${fmtLots(r.cOIC, lot)}</td>
        <td class="${rCO[i]}"${barStyle(r.cOI, cMaxO, "CE")}>${fmtLots(r.cOI, lot)}</td>
        <td class="${rCV[i]}"${barStyle(r.cVol, cMaxV, "CE")}>${fmtLots(r.cVol, lot)}</td>
        <td>${fmtNum(r.cAsk)}</td>
        <td>${fmtNum(r.cBid)}</td>
        <td>${fmtNum(r.cLtp)}</td>
        <td class="strike">${r.sp}</td>
        <td>${fmtNum(r.pLtp)}</td>
        <td>${fmtNum(r.pBid)}</td>
        <td>${fmtNum(r.pAsk)}</td>
        <td class="${rPV[i]}"${barStyle(r.pVol, pMaxV, "PE")}>${fmtLots(r.pVol, lot)}</td>
        <td class="${rPO[i]}"${barStyle(r.pOI, pMaxO, "PE")}>${fmtLots(r.pOI, lot)}</td>
        <td class="${cls(r.pOIC)} ${rPC[i]}"${barStyle(r.pOIC, pMaxC, "PE")}>${sign(r.pOIC)}${fmtLots(r.pOIC, lot)}</td>
        <td>${fmtNum(r.pIV)}%</td>
        <td>${fmtNum(r.pD)}</td>
      </tr>`;
    });
    const header = `<thead><tr>
        <th colspan="8" class="side-ce">CALLS</th>
        <th class="strike-h" rowspan="2">Strike</th>
        <th colspan="8" class="side-pe">PUTS</th>
      </tr><tr>
        <th>Δ</th><th>IV</th><th>OI Chg</th><th>OI</th><th>Vol</th><th>Ask</th><th>Bid</th><th>LTP</th>
        <th>LTP</th><th>Bid</th><th>Ask</th><th>Vol</th><th>OI</th><th>OI Chg</th><th>IV</th><th>Δ</th>
      </tr></thead>`;
    $("chainTable").innerHTML = header + rows;
    $("chainHint").textContent = `${view.length}/${all.length} strikes · centered on ATM · Vol/OI/OI Chg in lots · gold = max · blue = 2nd max` +
      (source === "dhan" ? " · bid/ask via Dhan" : "");
  }

  function renderSpreads(m) {
    const pairs = window.VerticalSpreads.build(state.strikes, spreadWidth);
    const view = chainWindow(pairs, m.atm_strike, m.spot, chainCount);
    const price = value => value == null ? "—" : value.toFixed(2);
    const lot = Number(state.ticker && state.ticker.Lot);
    const interpretation = result => `<td class="spread-reading ${result.winner ? "spread-edge" : ""}">${window.VerticalSpreads.interpretation(result, spreadRupees, lot)}</td>`;
    const header = `<colgroup><col style="width:230px"><col span="3"><col style="width:150px"><col span="3"><col style="width:230px"></colgroup><thead><tr><th colspan="4" class="side-ce">CALL SPREAD · lower call − higher call</th><th rowspan="2" class="strike-h">Strike pair</th><th colspan="4" class="side-pe">PUT SPREAD · higher put − lower put</th></tr><tr>
      <th title="Compare Call Ask with Opp (width minus Put Bid); lower cost wins">Bullish interpretation</th><th>Bid</th><th>Ask</th><th title="Width minus Put Bid: compare with Call Ask">Opp</th>
      <th title="Width minus Call Bid: compare with Put Ask">Opp</th><th>Bid</th><th>Ask</th><th title="Compare Put Ask with Opp (width minus Call Bid); lower cost wins">Bearish interpretation</th></tr></thead>`;
    $("chainTable").innerHTML = header + view.map(r => `<tr class="${r.sp === m.atm_strike || r.upper === m.atm_strike ? "atm-row" : ""}">
      ${interpretation(r.bullish)}<td>${price(r.call.bid)}</td><td>${price(r.call.ask)}</td><td class="${window.VerticalSpreads.oppClass(r.callOpp, r.call.ask)}">${price(r.callOpp)}</td>
      <td class="strike">${r.sp} / ${r.upper}<small>Width ${r.width}${r.sp === m.atm_strike || r.upper === m.atm_strike ? " · ATM leg" : ""}</small></td>
      <td class="${window.VerticalSpreads.oppClass(r.putOpp, r.put.ask)}">${price(r.putOpp)}</td><td>${price(r.put.bid)}</td><td>${price(r.put.ask)}</td>${interpretation(r.bearish)}</tr>`).join("") +
      (!view.length ? '<tr><td colspan="9" class="spread-reading">Not enough strikes for this spread width.</td></tr>' : "");
    $("chainHint").textContent = `${view.length}/${pairs.length} pairs · ${spreadWidth} strike interval${spreadWidth > 1 ? "s" : ""} · quotes in points · interpretation ${spreadRupees && lot > 0 ? "in ₹ / lot" : "in points"} · estimated quotes before costs` +
      (state.coverage && state.coverage.is_truncated ? " · loaded chain is truncated" : "") +
      (view.length && !view.some(r => r.call.mid != null || r.put.mid != null) ? " · valid bid/ask quotes unavailable from this snapshot" : "");
  }

  function setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const W = Math.max(1, rect.width);
    const H = Math.max(1, rect.height);
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    return { ctx, W, H };
  }

  function niceMax(v) {
    if (!(v > 0)) return 1;
    const exp = Math.floor(Math.log10(v));
    const f = v / Math.pow(10, exp);
    const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return n * Math.pow(10, exp);
  }

  function renderCharts() {
    if (!state || !chartsVisible) return;
    const st = state.strikes, m = state.metrics;
    const lot = state.ticker && state.ticker.Lot != null ? +state.ticker.Lot : null;
    const lots = (v) => v == null || lot == null || lot <= 0 ? v : v / lot;
    [["chartOi", "cOI", "pOI"], ["chartOiChg", "cOIC", "pOIC"], ["chartVol", "cVol", "pVol"]].forEach(([id, ce, pe]) => {
      if (!profileCharts.has(id)) profileCharts.set(id, new window.ProfileChart($(id)));
      profileCharts.get(id).setData(st.map(r => ({sp:r.sp, ce:lots(r[ce]), pe:lots(r[pe])})), m.atm_strike, lot > 0 ? "lots" : "units", tickerName());
    });
  }

  function renderAll() {
    if (!state) return;
    const m = state.metrics;
    if (ticker?.Name === state.ticker?.Name) state.ticker = {...ticker, ...state.ticker, Lot: state.ticker.Lot ?? ticker.Lot};
    renderCards(m, state.ticker);
    renderChain(m);
    renderCharts();
  }

  function drawMsg(canvas, msg, color) {
    const { ctx, W, H } = setupCanvas(canvas);
    ctx.fillStyle = color || TICK;
    ctx.textAlign = "center";
    ctx.font = "12px Segoe UI";
    ctx.fillText(msg, W / 2, H / 2);
  }

  function buildIvrPts(data) {
    const dates = data.date || [];
    const pts = [];
    for (let i = 0; i < data.ivp.length; i++) {
      const t = ivrDateMs(dates[i]);
      if (t === null || !isFinite(t)) continue;
      pts.push({
        t,
        spot: valueNumber(data.spotPrice ? data.spotPrice[i] : null),
        ivr: valueNumber(data.ivr ? data.ivr[i] : null),
        ivp: valueNumber(data.ivp[i]),
        iv: valueNumber(data.iv ? data.iv[i] : null),
      });
    }
    pts.sort((a, b) => a.t - b.t);
    return pts;
  }

  function renderChipLegend(el, entries, hiddenSet, onToggle) {
    if (!el) return;
    el.innerHTML = "";
    entries.forEach(e => {
      const chip = document.createElement("span");
      chip.className = "legend-chip" + (hiddenSet.has(e.key) ? " off" : "");
      chip.innerHTML = `<i style="background:${e.color}"></i>${escapeHtml(e.label)}`;
      chip.onclick = (ev) => { ev.stopPropagation(); onToggle(e.key); };
      el.appendChild(chip);
    });
  }

  class IvrChart {
    constructor(canvas, tooltip, legendEl) {
      this.canvas = canvas;
      this.tooltip = tooltip;
      this.legendEl = legendEl;
      this.pts = [];
      this.hidden = new Set();
      this.view = { i0: 0, i1: 0 };
      this.drag = null;
      this.hover = null;
      this.geom = null;
      this.padL = 58; this.padR = 46; this.padT = 34; this.padB = 26;
      this.bind();
    }

    getSeries() {
      return [
        { key: "spot", label: "Spot", color: "#00e5ff" },
        { key: "ivr", label: "IVR", color: "#ffa726" },
        { key: "ivp", label: "IVP", color: "#00ff00" },
        { key: "iv", label: "ATM IV", color: "#e040fb" },
      ];
    }

    seriesInfo() {
      return [
        { key: "spot", label: "Spot", get: p => p.spot, axis: "spot", color: "#00e5ff", dash: [3, 3], w: 2.2 },
        { key: "ivr", label: "IVR", get: p => p.ivr, axis: "iv", color: "#ffa726", dash: [], w: 1.8 },
        { key: "ivp", label: "IVP", get: p => p.ivp, axis: "iv", color: "#00ff00", dash: [], w: 1.8 },
        { key: "iv", label: "ATM IV", get: p => p.iv, axis: "iv", color: "#e040fb", dash: [6, 4], w: 2.0 },
      ];
    }

    toggle(key) {
      if (this.hidden.has(key)) this.hidden.delete(key);
      else this.hidden.add(key);
      renderChipLegend(this.legendEl, this.getSeries(), this.hidden, (k) => this.toggle(k));
      this.draw();
    }

    setData(pts) {
      this.pts = pts;
      this.hover = null;
      this.tooltip.classList.add("hidden");
      this.reset();
    }

    message(text, color) {
      this.pts = [];
      this.hover = null;
      this.tooltip.classList.add("hidden");
      drawMsg(this.canvas, text, color || TICK);
      this.geom = null;
    }

    reset() {
      if (!this.pts.length) return;
      this.view.i0 = 0;
      this.view.i1 = this.pts.length - 1;
      this.draw();
    }

    indexAt(px) {
      const g = this.geom;
      if (!g || !this.pts.length) return this.view.i0;
      const target = g.x0 + Math.max(0, Math.min(1, (px - g.padL) / g.cw)) * g.xspan;
      let lo = this.view.i0, hi = this.view.i1;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (this.pts[mid].t < target) lo = mid + 1;
        else hi = mid;
      }
      return lo > this.view.i0 && target - this.pts[lo - 1].t <= this.pts[lo].t - target ? lo - 1 : lo;
    }

    X(t) { const g = this.geom; return g.padL + (t - g.x0) / g.xspan * g.cw; }
    Ys(v) { const g = this.geom; return g.padT + g.ch - (v - g.spotLo) / (g.spotHi - g.spotLo) * g.ch; }
    Yr(v) { const g = this.geom; return g.padT + g.ch - (v - g.rLo) / (g.rHi - g.rLo) * g.ch; }

    draw() {
      const { ctx, W, H } = setupCanvas(this.canvas);
      const P = this.pts;
      if (!P.length) return;
      const { padL, padR, padT, padB } = this;
      const i0 = this.view.i0, i1 = this.view.i1;
      const win = P.slice(i0, i1 + 1);
      const x0 = win[0].t, x1 = win[win.length - 1].t;
      const xspan = Math.max(1, x1 - x0);
      const cw = W - padL - padR, ch = H - padT - padB;
      this.geom = { W, H, cw, ch, padL, padR, padT, padB, x0, x1, xspan };

      let smin = Infinity, smax = -Infinity;
      win.forEach(p => {
        if (p.spot !== null && isFinite(p.spot)) {
          if (p.spot < smin) smin = p.spot;
          if (p.spot > smax) smax = p.spot;
        }
      });
      if (!isFinite(smin)) { smin = 0; smax = 1; }
      const sPad = (smax - smin) * 0.06 || 1;
      const spotLo = smin - sPad, spotHi = smax + sPad;
      this.geom.spotLo = spotLo; this.geom.spotHi = spotHi;

      let rMax = 100;
      win.forEach(p => [p.ivr, p.ivp, p.iv].forEach(v => {
        if (v !== null && isFinite(v) && v > rMax) rMax = v;
      }));
      const rLo = 0, rHi = Math.max(100, Math.ceil(rMax / 10) * 10);
      this.geom.rLo = rLo; this.geom.rHi = rHi;

      ctx.strokeStyle = GRID; ctx.lineWidth = 1; ctx.font = "10px Segoe UI";
      ctx.textAlign = "right"; ctx.fillStyle = TICK;
      for (let i = 0; i <= 5; i++) {
        const v = spotLo + (spotHi - spotLo) * i / 5;
        const y = this.Ys(v);
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
        ctx.fillText(fmtNum(v, Math.abs(v) >= 1000 ? 0 : 1), padL - 6, y + 4);
      }
      ctx.textAlign = "left"; ctx.fillStyle = TICK;
      for (let i = 0; i <= 5; i++) {
        const v = rLo + (rHi - rLo) * i / 5;
        const y = this.Yr(v);
        ctx.fillText(String(Math.round(v)), W - padR + 5, y + 4);
      }
      ctx.textAlign = "center"; ctx.fillStyle = TICK;
      const xTicks = Math.min(6, win.length);
      for (let i = 0; i < xTicks; i++) {
        const idx = i0 + Math.round(i * (win.length - 1) / (xTicks - 1 || 1));
        ctx.fillText(fmtDayLabel(P[idx].t), this.X(P[idx].t), H - 9);
      }

      ctx.fillStyle = "#00e5ff"; ctx.textAlign = "left";
      ctx.fillText("Spot", 4, padT - 8);
      ctx.fillStyle = "#ffa726";
      ctx.fillText("Rank / IV %", W - padR + 5, padT - 8);

      const series = this.seriesInfo();
      series.forEach(s => {
        if (this.hidden.has(s.key)) return;
        ctx.strokeStyle = s.color; ctx.lineWidth = s.w; ctx.setLineDash(s.dash);
        ctx.beginPath();
        let started = false;
        win.forEach(p => {
          const v = s.get(p);
          if (v === null || !isFinite(v)) { started = false; return; }
          const x = this.X(p.t), y = s.axis === "spot" ? this.Ys(v) : this.Yr(v);
          if (!started) { ctx.moveTo(x, y); started = true; }
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.setLineDash([]);
      });

      if (this.hover !== null && P[this.hover] && this.hover >= i0 && this.hover <= i1) {
        const p = P[this.hover];
        const x = this.X(p.t);
        ctx.strokeStyle = "#e6edf3"; ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ch); ctx.stroke();
        ctx.setLineDash([]);
        series.forEach(s => {
          if (this.hidden.has(s.key)) return;
          const v = s.get(p);
          if (v === null || !isFinite(v)) return;
          ctx.fillStyle = s.color;
          ctx.beginPath(); ctx.arc(x, s.axis === "spot" ? this.Ys(v) : this.Yr(v), 3.2, 0, Math.PI * 2); ctx.fill();
        });
        this.showTooltip(p, x);
      } else {
        this.tooltip.classList.add("hidden");
      }
    }

    showTooltip(p, x) {
      const rows = [];
      this.seriesInfo().forEach(s => {
        if (this.hidden.has(s.key)) return;
        const v = s.get(p);
        let txt = "—";
        if (v !== null && isFinite(v)) {
          if (s.key === "spot") txt = fmtNum(v, 2);
          else if (s.key === "ivr") txt = fmtNum(v, 2) + "%";
          else if (s.key === "ivp") txt = fmtNum(v, 2) + "%";
          else txt = Number(v).toFixed(1) + "%";
        }
        rows.push(`<div class="tt-row"><span><i style="background:${s.color}"></i>${s.label}</span><span>${txt}</span></div>`);
      });
      this.tooltip.innerHTML = `<div class="tt-t">${escapeHtml(new Date(p.t).toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" }))}</div>` + rows.join("");
      this.tooltip.classList.remove("hidden");
      const rect = this.canvas.getBoundingClientRect();
      this.tooltip.style.left = Math.max(8, Math.min(rect.width - 200, x + 14)) + "px";
      this.tooltip.style.top = "36px";
    }

    bind() {
      const c = this.canvas;
      c.addEventListener("wheel", (e) => {
        if (!this.pts.length) return;
        e.preventDefault();
        const rect = c.getBoundingClientRect();
        const anchor = this.indexAt(e.clientX - rect.left);
        const factor = e.deltaY < 0 ? 1 / 1.25 : 1.25;
        const span = this.view.i1 - this.view.i0 + 1;
        const newSpan = Math.min(this.pts.length, Math.max(3, Math.round(span * factor) + 1));
        const frac = (anchor - this.view.i0) / span;
        let i0 = this.view.i0 + Math.round((span - newSpan) * frac);
        i0 = Math.max(0, Math.min(i0, this.pts.length - newSpan));
        this.view.i0 = i0;
        this.view.i1 = i0 + newSpan - 1;
        this.draw();
      }, { passive: false });

      c.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        this.drag = { x: e.clientX, i0: this.view.i0 };
        this.hover = null;
        this.tooltip.classList.add("hidden");
        this.draw();
      });

      window.addEventListener("mousemove", (e) => {
        if (!this.pts.length) return;
        const rect = c.getBoundingClientRect();
        const x = e.clientX - rect.left;
        if (this.drag) {
          const span = this.view.i1 - this.view.i0;
          const ppix = (rect.width - this.padL - this.padR) / span;
          let i0 = this.drag.i0 - Math.round((e.clientX - this.drag.x) / ppix);
          i0 = Math.max(0, Math.min(i0, this.pts.length - span - 1));
          this.view.i0 = i0;
          this.view.i1 = i0 + span;
          this.draw();
        } else {
          this.hover = this.indexAt(x);
          this.draw();
        }
      });

      window.addEventListener("mouseup", () => { this.drag = null; });
      c.addEventListener("mouseleave", () => {
        this.hover = null;
        this.drag = null;
        this.tooltip.classList.add("hidden");
        this.draw();
      });
      c.addEventListener("dblclick", () => this.reset());
    }
  }

  class SkewChart {
    constructor(canvas, tooltip, legendEl) {
      this.canvas = canvas;
      this.tooltip = tooltip;
      this.legendEl = legendEl;
      this.strikes = [];
      this.callIv = new Map();
      this.putIv = new Map();
      this.atm = null;
      this.spot = null;
      this.strikesPerSide = 8;
      this.hidden = new Set();
      this.view = { i0: 0, i1: 0 };
      this.drag = null;
      this.hover = null;
      this.geom = null;
      this.padL = 44; this.padR = 12; this.padT = 34; this.padB = 22;
      this.bind();
    }

    getSeries() {
      return [
        { key: "call", label: "Call IV", color: "#00ff00" },
        { key: "put", label: "Put IV", color: "#ef5350" },
        { key: "otm", label: "OTM IV", color: "#26c6da" },
      ];
    }

    otm(s) {
      if (s < this.atm) return this.putIv.get(s) ?? null;
      if (s > this.atm) return this.callIv.get(s) ?? null;
      return null;
    }

    toggle(key) {
      if (this.hidden.has(key)) this.hidden.delete(key);
      else this.hidden.add(key);
      renderChipLegend(this.legendEl, this.getSeries(), this.hidden, (k) => this.toggle(k));
      this.draw();
    }

    setData(exp, spot) {
      const callIv = new Map(), putIv = new Map();
      const strikesSet = new Set();
      (exp.options || []).forEach(o => {
        if (!o || typeof o.strike !== "number" || typeof o.iv !== "number" || !isFinite(o.strike) || !isFinite(o.iv)) return;
        strikesSet.add(o.strike);
        if (o.optionType === "CE") callIv.set(o.strike, o.iv);
        else if (o.optionType === "PE") putIv.set(o.strike, o.iv);
      });
      const strikes = [...strikesSet].sort((a, b) => a - b);
      this.strikes = strikes;
      this.callIv = callIv;
      this.putIv = putIv;
      this.spot = spot;
      let atm = strikes[0] || null;
      if (spot !== null && isFinite(spot) && atm !== null) strikes.forEach(s => {
        if (Math.abs(s - spot) < Math.abs(atm - spot)) atm = s;
      });
      this.atm = atm;
      this.hover = null;
      this.tooltip.classList.add("hidden");
      this.reset();
    }

    message(text, color) {
      this.strikes = [];
      this.hover = null;
      this.tooltip.classList.add("hidden");
      drawMsg(this.canvas, text, color || TICK);
      this.geom = null;
    }

    reset() {
      if (!this.strikes.length) return;
      const atmIndex = this.strikes.indexOf(this.atm);
      const center = atmIndex >= 0 ? atmIndex : 0;
      this.view.i0 = Math.max(0, center - this.strikesPerSide);
      this.view.i1 = Math.min(this.strikes.length - 1, center + this.strikesPerSide);
      this.hover = null;
      this.tooltip.classList.add("hidden");
      this.draw();
    }

    indexAt(px) {
      const rect = this.canvas.getBoundingClientRect();
      const cw = rect.width - this.padL - this.padR;
      const span = this.view.i1 - this.view.i0 || 1;
      const f = (px - this.padL) / cw;
      const i = Math.round(this.view.i0 + f * span);
      return Math.max(this.view.i0, Math.min(this.view.i1, i));
    }

    X(s) { const g = this.geom; return g.padL + (s - g.xMin) / (g.xMax - g.xMin || 1) * g.cw; }
    Y(v) { const g = this.geom; return g.padT + g.ch - (v - g.yLo) / (g.yHi - g.yLo || 1) * g.ch; }

    draw() {
      const { ctx, W, H } = setupCanvas(this.canvas);
      const strikes = this.strikes;
      if (!strikes.length) return;
      const { padL, padR, padT, padB } = this;
      const i0 = this.view.i0, i1 = this.view.i1;
      const win = strikes.slice(i0, i1 + 1);
      const cw = W - padL - padR, ch = H - padT - padB;

      let xMin = win[0], xMax = win[win.length - 1];
      const buf = (xMax - xMin) * 0.04 || 1;
      xMin -= buf; xMax += buf;

      const series = [
        { key: "call", get: (s) => this.callIv.get(s) ?? null, color: "#00ff00", dash: [] },
        { key: "put", get: (s) => this.putIv.get(s) ?? null, color: "#ef5350", dash: [] },
        { key: "otm", get: (s) => this.otm(s), color: "#26c6da", dash: [6, 4] },
      ];
      const visibleValues = [];
      series.forEach(sr => {
        if (this.hidden.has(sr.key)) return;
        win.forEach(strike => {
          const value = sr.get(strike);
          if (value != null && isFinite(value)) visibleValues.push(value);
        });
      });
      const minIv = visibleValues.length ? Math.min(...visibleValues) : 0;
      const maxIv = visibleValues.length ? Math.max(...visibleValues) : 1;
      const padding = Math.max((maxIv - minIv) * 0.08, 0.1);
      const yLo = Math.max(0, minIv - padding), yHi = maxIv + padding;
      this.geom = { W, H, cw, ch, padL, padR, padT, padB, xMin, xMax, yLo, yHi };

      ctx.strokeStyle = GRID; ctx.fillStyle = TICK;
      ctx.font = "10px Segoe UI"; ctx.textAlign = "right"; ctx.lineWidth = 1;
      for (let i = 0; i <= 5; i++) {
        const value = yLo + (yHi - yLo) * i / 5;
        const y = this.Y(value);
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
        ctx.fillText(fmtNum(value, 2), padL - 6, y + 4);
      }

      series.forEach(sr => {
        if (this.hidden.has(sr.key)) return;
        ctx.strokeStyle = sr.color; ctx.lineWidth = 1.6; ctx.setLineDash(sr.dash);
        ctx.beginPath();
        let started = false;
        win.forEach(s => {
          const v = sr.get(s);
          if (v === null || v === undefined || !isFinite(v)) { started = false; return; }
          const x = this.X(s), y = this.Y(v);
          if (!started) { ctx.moveTo(x, y); started = true; }
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = sr.color;
        win.forEach(s => {
          const v = sr.get(s);
          if (v === null || v === undefined || !isFinite(v)) return;
          ctx.beginPath(); ctx.arc(this.X(s), this.Y(v), 2.4, 0, Math.PI * 2); ctx.fill();
        });
      });

      const spot = this.spot;
      if (spot !== null && isFinite(spot) && spot >= xMin && spot <= xMax) {
        const x = this.X(spot);
        ctx.strokeStyle = "#ffa726"; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ch); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#ffa726"; ctx.font = "bold 10px Segoe UI"; ctx.textAlign = "center";
        ctx.fillText("ATM " + (Number.isInteger(spot) ? spot : spot.toFixed(1)), x, padT - 7);
      }

      ctx.font = "10px Segoe UI"; ctx.fillStyle = TICK; ctx.textAlign = "center";
      const step = Math.max(1, Math.ceil(win.length / 7));
      win.forEach((s, i) => { if (i % step === 0) ctx.fillText(String(s), this.X(s), H - 8); });

      if (this.hover !== null && this.hover >= i0 && this.hover <= i1 && strikes[this.hover] !== undefined) {
        const s = strikes[this.hover];
        const x = this.X(s);
        ctx.strokeStyle = "#e6edf3"; ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ch); ctx.stroke();
        ctx.setLineDash([]);
        series.forEach(sr => {
          if (this.hidden.has(sr.key)) return;
          const v = sr.get(s);
          if (v === null || v === undefined || !isFinite(v)) return;
          const y = this.Y(v);
          ctx.strokeStyle = BG; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.stroke();
          ctx.fillStyle = sr.color;
          ctx.beginPath(); ctx.arc(x, y, 3.6, 0, Math.PI * 2); ctx.fill();
        });
        this.showTooltip(s, x);
      } else {
        this.tooltip.classList.add("hidden");
      }
    }

    showTooltip(strike, x) {
      const fmtIv = (v) => (v === null || v === undefined || !isFinite(v)) ? "—" : Number(v).toFixed(1) + "%";
      const rows = [`<div class="tt-t">Strike ${fmtNum(strike, 0)}${strike === this.atm ? " · ATM" : ""}</div>`];
      const entries = [
        { key: "call", label: "Call IV", color: "#00ff00", get: (s) => this.callIv.get(s) ?? null },
        { key: "put", label: "Put IV", color: "#ef5350", get: (s) => this.putIv.get(s) ?? null },
        { key: "otm", label: "OTM IV", color: "#26c6da", get: (s) => this.otm(s) },
      ];
      entries.forEach(en => {
        if (this.hidden.has(en.key)) return;
        rows.push(`<div class="tt-row"><span><i style="background:${en.color}"></i>${en.label}</span><span>${fmtIv(en.get(strike))}</span></div>`);
      });
      if (strike === this.atm && (!this.hidden.has("call") || !this.hidden.has("put"))) {
        const vals = [this.callIv.get(strike), this.putIv.get(strike)].filter(v => v != null && isFinite(v));
        if (vals.length) rows.push(`<div class="tt-row"><span><i style="background:#ffa726"></i>ATM IV avg</span><span>${Number(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1)}%</span></div>`);
      }
      this.tooltip.innerHTML = rows.join("");
      this.tooltip.classList.remove("hidden");
      const rect = this.canvas.getBoundingClientRect();
      this.tooltip.style.left = Math.max(8, Math.min(rect.width - 200, x + 14)) + "px";
      this.tooltip.style.top = "38px";
    }

    bind() {
      const c = this.canvas;
      c.addEventListener("wheel", (e) => {
        if (!this.strikes.length) return;
        e.preventDefault();
        const rect = c.getBoundingClientRect();
        const anchor = this.indexAt(e.clientX - rect.left);
        const factor = e.deltaY < 0 ? 1 / 1.25 : 1.25;
        const span = this.view.i1 - this.view.i0 + 1;
        const newSpan = Math.min(this.strikes.length, Math.max(3, Math.round(span * factor) + 1));
        const frac = (anchor - this.view.i0) / span;
        let i0 = this.view.i0 + Math.round((span - newSpan) * frac);
        i0 = Math.max(0, Math.min(i0, this.strikes.length - newSpan));
        this.view.i0 = i0;
        this.view.i1 = i0 + newSpan - 1;
        this.draw();
      }, { passive: false });

      c.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        this.drag = { x: e.clientX, i0: this.view.i0 };
        this.hover = null;
        this.tooltip.classList.add("hidden");
        this.draw();
      });

      window.addEventListener("mousemove", (e) => {
        if (!this.strikes.length) return;
        const rect = c.getBoundingClientRect();
        const x = e.clientX - rect.left;
        if (this.drag) {
          const span = this.view.i1 - this.view.i0;
          const ppix = (rect.width - this.padL - this.padR) / span;
          let i0 = this.drag.i0 - Math.round((e.clientX - this.drag.x) / ppix);
          i0 = Math.max(0, Math.min(i0, this.strikes.length - span - 1));
          this.view.i0 = i0;
          this.view.i1 = i0 + span;
          this.draw();
        } else {
          this.hover = this.indexAt(x);
          this.draw();
        }
      });

      window.addEventListener("mouseup", () => { this.drag = null; });
      c.addEventListener("mouseleave", () => {
        this.hover = null;
        this.drag = null;
        this.tooltip.classList.add("hidden");
        this.draw();
      });
      c.addEventListener("dblclick", () => this.reset());
    }
  }

  class TermChart {
    constructor(canvas, tooltip) {
      this.canvas = canvas;
      this.tooltip = tooltip;
      this.rows = [];
      this.mode = "call";
      this.view = { lo: 0, hi: 0 };
      this.fullLo = 0; this.fullHi = 0;
      this.drag = null;
      this.hover = null;
      this.geom = null;
      this.spheres = [];
      this.k = 8;
      this.padL = 78; this.padR = 14; this.padT = 34; this.padB = 26;
      this.bind();
    }

    ivOf(row, r) {
      if (this.mode === "call") return r.cIV;
      if (this.mode === "put") return r.pIV;
      return r.sp < (row.atm ?? Infinity) ? r.pIV : r.cIV;
    }

    setData(rows) {
      this.rows = rows || [];
      this.hover = null;
      this.geom = null;
      this.tooltip.classList.add("hidden");
      let lo = Infinity, hi = -Infinity;
      this.rows.forEach(row => (row.strikes || []).forEach(r => {
        if (r.sp < lo) lo = r.sp;
        if (r.sp > hi) hi = r.sp;
      }));
      if (!isFinite(lo)) { this.fullLo = 0; this.fullHi = 0; }
      else {
        const step = this.strikeStep();
        const anchor = this.rows.length ? (this.rows[0].atm ?? null) : null;
        const k = Math.max(1, this.k | 0) || 8;
        if (anchor !== null && step > 0 && isFinite(step)) {
          this.fullLo = Math.max(lo, anchor - k * step);
          this.fullHi = Math.min(hi, anchor + k * step);
        } else {
          this.fullLo = lo;
          this.fullHi = hi;
        }
      }
      this.view.lo = this.fullLo;
      this.view.hi = this.fullHi;
      this.draw();
    }

    strikeStep() {
      const set = new Set();
      this.rows.forEach(row => (row.strikes || []).forEach(r => set.add(r.sp)));
      const arr = [...set].sort((a, b) => a - b);
      let step = 0;
      for (let i = 1; i < arr.length; i++) {
        const d = arr[i] - arr[i - 1];
        if (d > 0 && (step === 0 || d < step)) step = d;
      }
      return step;
    }

    message(text, color) {
      this.rows = [];
      this.hover = null;
      this.spheres = [];
      this.geom = null;
      this.tooltip.classList.add("hidden");
      drawMsg(this.canvas, text, color || TICK);
    }

    reset() { this.setData(this.rows); }

    normSpheres() {
      const lo = this.view.lo, hi = this.view.hi;
      let vmin = Infinity, vmax = -Infinity;
      this.rows.forEach(row => (row.strikes || []).forEach(r => {
        if (r.sp < lo || r.sp > hi) return;
        const v = this.ivOf(row, r);
        if (v === null || v === undefined || !isFinite(v)) return;
        if (v < vmin) vmin = v;
        if (v > vmax) vmax = v;
      }));
      if (!isFinite(vmin)) return [];
      const spread = vmax - vmin || 1;
      const out = [];
      this.rows.forEach((row, i) => {
        (row.strikes || []).forEach(r => {
          if (r.sp < lo || r.sp > hi) return;
          const v = this.ivOf(row, r);
          if (v === null || v === undefined || !isFinite(v)) return;
          const n = (v - vmin) / spread;
          out.push({ row, i, sp: r.sp, iv: v, n, cIV: r.cIV, pIV: r.pIV });
        });
      });
      return out;
    }

    draw() {
      const { ctx, W, H } = setupCanvas(this.canvas);
      if (!this.rows.length) return;
      const { padL, padR, padT, padB } = this;
      const cw = W - padL - padR, ch = H - padT - padB;
      const rowH = ch / this.rows.length;
      const sLo = this.view.lo, sHi = this.view.hi;
      const sspanv = sHi - sLo || 1;
      const X = (s) => padL + (s - sLo) / sspanv * cw;
      const Y = (i) => padT + rowH * (i + 0.5);
      this.geom = { W, H, cw, ch, padL, padR, sLo, sHi };

      const xy = this.normSpheres();
      this.spheres = xy.map(p => {
        const r = Math.max(2.2, 5 + 16 * p.n);
        return { ...p, x: X(p.sp), y: Y(p.i), r };
      });

      ctx.font = "10px Segoe UI";
      ctx.strokeStyle = GRID; ctx.lineWidth = 1;
      for (let i = 0; i <= this.rows.length; i++) {
        const y = Math.round(padT + i * rowH) + 0.5;
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      }
      ctx.fillStyle = TICK; ctx.textAlign = "left";
      this.rows.forEach((row, i) => {
        ctx.fillText(shortTermLabel(row.expiry), 2, Y(i) + 3);
      });

      ctx.textAlign = "center";
      const ticks = Math.max(2, Math.round(cw / 70));
      for (let t = 0; t <= ticks; t++) {
        const s = sLo + sspanv * t / ticks;
        const x = X(s);
        ctx.fillText(fmtNum(s, 0), x, H - 10);
      }

      this.spheres.forEach(p => {
        const hue = Math.round(240 - 240 * p.n);
        const base = `hsl(${hue}, 90%, 55%)`;
        const light = `hsl(${hue}, 96%, 74%)`;
        const g = ctx.createRadialGradient(p.x - p.r * 0.35, p.y - p.r * 0.4, p.r * 0.15, p.x, p.y, p.r);
        g.addColorStop(0, light);
        g.addColorStop(1, base);
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
        ctx.lineWidth = 0.8; ctx.strokeStyle = "rgba(0,0,0,.45)";
        ctx.stroke();
      });

      ctx.font = "bold 10px Segoe UI";
      ctx.fillStyle = "#ffa726";
      ctx.textAlign = "center";
      this.rows.forEach((row, i) => {
        if (row.atm === null || row.atm === undefined || row.atm < sLo || row.atm > sHi) return;
        const x = X(row.atm);
        ctx.strokeStyle = "#ffa726"; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ch); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillText("ATM " + fmtNum(row.atm, 0), x, padT + i * rowH - 7);
      });

      const grd = ctx.createLinearGradient(W - padR - 120, 0, W - padR, 0);
      for (let t = 0; t <= 8; t++) {
        const n = t / 8;
        grd.addColorStop(n, `hsl(${Math.round(240 - 240 * n)}, 92%, 55%)`);
      }
      ctx.fillStyle = grd;
      const bary = H - 8, barx = W - padR - 120;
      ctx.fillRect(barx, bary, 120, 5);
      ctx.strokeStyle = GRID; ctx.strokeRect(barx, bary, 120, 5);
      ctx.fillStyle = TICK; ctx.textAlign = "right";
      ctx.fillText("low", barx - 2, bary + 5);
      ctx.textAlign = "left";
      ctx.fillText("high", barx + 122, bary + 5);

      if (this.hover !== null && this.spheres[this.hover]) {
        const p = this.spheres[this.hover];
        ctx.strokeStyle = "#e6edf3"; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r + 2.5, 0, Math.PI * 2); ctx.stroke();
        this.showTooltip(p);
      } else {
        this.tooltip.classList.add("hidden");
      }
    }

    showTooltip(p) {
      const fmtIv = (v) => (v === null || v === undefined || !isFinite(v)) ? "—" : Number(v).toFixed(1) + "%";
      const rows = [
        `<div class="tt-t">${escapeHtml(shortTermLabel(p.row.expiry))} · Strike ${fmtNum(p.sp, 0)}</div>`,
        `<div class="tt-row"><span><i style="background:#ffa726"></i>Call IV</span><span>${fmtIv(p.cIV)}</span></div>`,
        `<div class="tt-row"><span><i style="background:#ef5350"></i>Put IV</span><span>${fmtIv(p.pIV)}</span></div>`,
      ];
      if (this.mode === "otm") {
        rows.splice(1, 0,
          `<div class="tt-row"><span><i style="background:#00e5ff"></i>OTM IV</span><span>${fmtIv(p.iv)}</span></div>`);
      }
      this.tooltip.innerHTML = rows.join("");
      this.tooltip.classList.remove("hidden");
      const rect = this.canvas.getBoundingClientRect();
      this.tooltip.style.left = Math.max(8, Math.min(rect.width - 200, p.x + 14)) + "px";
      this.tooltip.style.top = Math.max(10, Math.min(rect.height - 90, p.y - 20)) + "px";
    }

    bind() {
      const c = this.canvas;
      c.addEventListener("wheel", (e) => {
        if (!this.rows.length) return;
        e.preventDefault();
        const rect = c.getBoundingClientRect();
        const { padL, padR, sLo, sHi } = this.geom;
        const cw = rect.width - padL - padR;
        const span = sHi - sLo;
        const px = e.clientX - rect.left;
        const s0 = sLo + span * (px - padL) / cw;
        const factor = e.deltaY < 0 ? 1 / 1.3 : 1.3;
        const fullSpan = this.fullHi - this.fullLo;
        const minSpan = Math.max(2, fullSpan / 40);
        let newSpan = Math.max(minSpan, Math.min(fullSpan, span * factor));
        let lo = s0 - (s0 - sLo) * factor;
        lo = Math.max(this.fullLo, Math.min(lo, this.fullHi - newSpan));
        this.view.lo = lo;
        this.view.hi = lo + newSpan;
        this.draw();
      }, { passive: false });

      c.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        this.drag = { x: e.clientX, lo: this.view.lo };
        this.hover = null;
        this.tooltip.classList.add("hidden");
      });

      window.addEventListener("mousemove", (e) => {
        if (!this.rows.length || !this.geom) return;
        const rect = c.getBoundingClientRect();
        const x = e.clientX - rect.left, y = e.clientY - rect.top;
        if (this.drag) {
          const span = this.view.hi - this.view.lo;
          const cw = rect.width - this.padL - this.padR;
          const ds = (this.drag.x - e.clientX) / cw * span;
          let lo = this.drag.lo + ds;
          lo = Math.max(this.fullLo, Math.min(lo, this.fullHi - span));
          this.view.lo = lo;
          this.view.hi = lo + span;
          this.draw();
        } else {
          let best = -1, bestD = Infinity;
          for (let i = 0; i < this.spheres.length; i++) {
            const p = this.spheres[i];
            const dx = x - p.x, dy = y - p.y;
            const d2 = dx * dx + dy * dy;
            const lim = p.r + 5;
            if (d2 < lim * lim && d2 < bestD) { bestD = d2; best = i; }
          }
          this.hover = best;
          this.draw();
        }
      });

      window.addEventListener("mouseup", () => { this.drag = null; });
      c.addEventListener("mouseleave", () => {
        this.hover = null;
        this.drag = null;
        this.tooltip.classList.add("hidden");
        if (this.rows.length) this.draw();
      });
      c.addEventListener("dblclick", () => this.reset());
    }
  }

  function renderSkewExps() {
    const el = $("skewExps");
    if (!el) return;
    el.innerHTML = "";
    if (!skew || !Array.isArray(skew.data) || !skew.data.length) return;
    skew.data.forEach((s, i) => {
      const b = document.createElement("button");
      b.className = "skew-exp" + (i === skewSeriesIndex ? " active" : "");
      b.textContent = fmtExpLabel(s);
      b.onclick = () => { skewSeriesIndex = i; renderAnalyticsCharts(); };
      el.appendChild(b);
    });
  }

  function renderAnalyticsCharts() {
    if (!state) return;
    if (ivrVisible) {
      const err = ivrIvp && ivrIvp.error;
      if (err) {
        ivrChart.message("IVP/IVR: " + shortErr(err), "#ff8b8b");
      } else {
        const d = (ivrIvp && ivrIvp.data) || null;
        if (d && Array.isArray(d.ivp) && d.ivp.length) {
          ivrChart.setData(buildIvrPts(d));
        } else {
          const isEquitySeg = (dhanMap && dhanMap.mapped || []).some(r => ticker && r.aoc === ticker.Name && r.seg === 2);
          const noneMsg = source === "dhan"
            ? (isEquitySeg
                ? "IVP / IVR is index-segment only on Dhan — no history for this equity; see ATM IV & IV skew below"
                : "No IVP / IVR history for this symbol")
            : "IVP / IVR requires the Dhan source";
          ivrChart.message(noneMsg);
        }
      }
    }
    if (skewVisible) {
      const err = skew && skew.error;
      if (err) {
        skewChart.message("IV skew: " + shortErr(err), "#ff8b8b");
        $("skewExps").innerHTML = "";
      } else {
        const sdata = (skew && skew.data) || null;
        const exp = sdata && sdata.length ? (sdata[skewSeriesIndex] || sdata[0]) : null;
        if (exp && Array.isArray(exp.options) && exp.options.length) {
          skewChart.setData(exp, state.metrics.spot);
        } else {
          skewChart.message(source === "dhan" ? "No skew data for this symbol" : "IV skew requires the Dhan source");
        }
renderSkewExps();
      }
    }
    if (termChart && termVisible) {
      const err = term && term.error;
      if (err) {
        termChart.message("IV term structure: " + shortErr(err), "#f85149");
        $("termExps").innerHTML = "";
      } else if (termData.length) {
        termChart.mode = termMode;
        termChart.setData(termData);
      } else {
        termChart.message(termAll.length ? "Select expiries above to plot" : "IV term structure: no data", TICK);
      }
      renderTermLegend();
    }
  }

  function termEligible() {
    return mode === "live" && source === "dhan" && dhanMap && ticker && (ticker.Name === "NIFTY" || ticker.Name === "SENSEX");
  }

  function rebuildTermData() {
    termData = [...termSel].map(j => termCache.get(j)).filter(Boolean)
      .sort((a, b) => a.expdatej - b.expdatej);
  }

  function renderTermExps() {
    const el = $("termExps");
    if (!el) return;
    el.innerHTML = "";
    termAll.forEach(o => {
      const b = document.createElement("button");
      b.className = "term-exp" + (termSel.has(o.expdatej) ? " active" : "");
      b.textContent = shortTermLabel(o.label);
      b.title = o.label;
      b.onclick = () => toggleTermExp(o.expdatej);
      el.appendChild(b);
    });
  }

  function renderTermLegend() {
    const el = $("termLegend");
    if (!el) return;
    let moded = el.dataset.moded;
    if (moded === termMode) return;
    el.innerHTML = "";
    el.dataset.moded = termMode;
    const mk = (label, color) => {
      const s = document.createElement("span");
      s.className = "legend-chip";
      s.innerHTML = `<i style="background:${color}"></i>${escapeHtml(label)}`;
      el.appendChild(s);
    };
    mk("low IV", "hsl(240,92%,55%)");
    mk("high IV", "hsl(0,92%,55%)");
    mk(termMode === "call" ? "Call IV" : termMode === "put" ? "Put IV" : "OTM IV", "#58a6ff");
    const note = document.createElement("span");
    note.className = "legend-chip";
    note.textContent = "sphere size = IV";
    el.appendChild(note);
  }

  function toggleTermExp(j) {
    termTouched = true;
    if (termSel.has(j)) termSel.delete(j);
    else {
      termSel.add(j);
      if (!termCache.has(j)) fetchTermExp(j);
    }
    rebuildTermData();
    renderTermExps();
    if (termData.length) {
      termChart.mode = termMode;
      termChart.setData(termData);
    } else {
      termChart.message(termAll.length ? "Select expiries above to plot" : "IV term structure: no data", TICK);
    }
  }

  async function fetchTermExp(j) {
    try {
      const t = await fetchJson("/api/dhan/term?ticker=" + encodeURIComponent(ticker.Name) + "&exp=" + j);
      (t.data || []).forEach(e => termCache.set(e.expdatej, e));
      rebuildTermData();
      renderTermExps();
      if (termSel.has(j) && termData.length) {
        termChart.mode = termMode;
        termChart.setData(termData);
      }
    } catch (e) {
      banner("IV term structure: " + shortErr(e.message));
    }
  }

  function applyTerm(t) {
    term = t;
    if (Array.isArray(t.expiries)) termAll = t.expiries;
    (t.data || []).forEach(e => termCache.set(e.expdatej, e));
    if (ticker && ticker.Name !== termTicker) {
      termSel = new Set();
      termTouched = false;
      termTicker = ticker.Name;
    }
    if (!termTouched) {
      termSel = new Set((t.data || []).map(e => e.expdatej));
    }
    rebuildTermData();
    renderTermExps();
  }

  function clearTerm() {
    term = null;
    termAll = [];
    termSel = new Set();
    termTouched = false;
    termCache.clear();
    termData = [];
    if (termChart) termChart.message("");
    const el = $("termExps");
    if (el) el.innerHTML = "";
    const sec = $("termSection");
    if (sec) sec.classList.add("hidden");
  }

  function clearAnalytics() {
    analyticsRequest++;
    clearTerm();
    ivrIvp = null;
    skew = null;
    skewSeriesIndex = 0;
    ivrChart.message("");
    skewChart.message("");
    $("skewExps").innerHTML = "";
    if (state) renderCards(state.metrics, state.ticker);
  }

  async function loadAnalytics() {
    if (!ticker || mode !== "live" || source !== "dhan" || !dhanMap || (state && state.source === "aoc")) {
      clearAnalytics();
      return;
    }
    const requestId = ++analyticsRequest;
    const requestedName = ticker.Name;
    const isTerm = requestedName === "NIFTY" || requestedName === "SENSEX";
    const name = encodeURIComponent(requestedName);
    const qIvr = "/api/dhan/ivpivr?ticker=" + name + "&lookback=" + encodeURIComponent(ivrLookback);
    const qSk = "/api/dhan/skew?ticker=" + name;
    const qTerm = isTerm
      ? "/api/dhan/term?ticker=" + name + (termTouched && termSel.size
          ? "&exp=" + [...termSel].join("&exp=")
          : "&exps=3")
      : null;
    const settled = await Promise.allSettled([
      fetchJson(qIvr),
      fetchJson(qSk),
      qTerm ? fetchJson(qTerm) : Promise.resolve(null),
    ]);
    if (requestId !== analyticsRequest || !ticker || ticker.Name !== requestedName || mode !== "live" || source !== "dhan") return;
    const errorText = (result) => result.status === "rejected"
      ? (result.reason && result.reason.message ? result.reason.message : String(result.reason))
      : null;
    ivrIvp = settled[0].status === "fulfilled" ? settled[0].value : { error: errorText(settled[0]) };
    skew = settled[1].status === "fulfilled" ? settled[1].value : { error: errorText(settled[1]) };
    if (isTerm && settled[2].status === "fulfilled" && settled[2].value) {
      applyTerm(settled[2].value);
      $("termSection").classList.remove("hidden");
    } else if (isTerm && settled[2].status === "rejected") {
      clearTerm();
      term = { error: errorText(settled[2]) };
      $("termSection").classList.remove("hidden");
    } else {
      clearTerm();
    }
    if (!(skewSeriesIndex < ((skew && skew.data || []).length))) skewSeriesIndex = 0;
    if (state) renderCards(state.metrics, state.ticker);
    renderAnalyticsCharts();
  }

  function sectorColor(pchg, maxAbs) {
    const rel = Math.min(1, Math.abs(pchg || 0) / (maxAbs || 1));
    if (pchg >= 0) return `hsl(145 ${52 + rel * 22}% ${58 - rel * 18}%)`;
    return `hsl(355 ${52 + rel * 22}% ${58 - rel * 18}%)`;
  }

  function renderSectorSummary(sectors) {
    const up = sectors.filter(s => s.pchg > 0).length;
    const down = sectors.filter(s => s.pchg < 0).length;
    const sorted = [...sectors].sort((a, b) => b.pchg - a.pchg);
    const best = sorted[0], worst = sorted[sorted.length - 1];
    const nifty = sectors.find(s => s.symbol === "NIFTY");
    const adv = sectors.reduce((a, s) => a + (s.adv || 0), 0);
    const dec = sectors.reduce((a, s) => a + (s.dec || 0), 0);
    const unch = sectors.reduce((a, s) => a + (s.unch || 0), 0);
    $("sectorSummary").innerHTML = `
      <div class="chip"><div class="k">Sectors</div><div class="v">${up}▲ · ${down}▼</div></div>
      <div class="chip"><div class="k">Best</div><div class="v ${cls(best.pchg)}">${escapeHtml(best.displaySymbol)} ${best.pchg > 0 ? "+" : ""}${best.pchg.toFixed(2)}%</div></div>
      <div class="chip"><div class="k">Worst</div><div class="v ${cls(worst.pchg)}">${escapeHtml(worst.displaySymbol)} ${worst.pchg > 0 ? "+" : ""}${worst.pchg.toFixed(2)}%</div></div>
      <div class="chip"><div class="k">Breadth</div><div class="v">${adv} / ${dec} / ${unch}</div></div>
      <div class="chip"><div class="k">NIFTY</div><div class="v ${cls(nifty && nifty.pchg)}">${fmtNum(nifty ? nifty.ltp : null)} (${nifty && nifty.pchg > 0 ? "+" : ""}${fmtNum(nifty ? nifty.pchg : null)})</div></div>`;
  }

  function renderSectorComponents(sectors) {
    const sorted = [...sectors].sort((a, b) => b.pchg - a.pchg);
    const el = $("sectorComponents");
    el.innerHTML = "";
    for (const s of sorted) {
      const item = document.createElement("div");
      item.className = "sec-item";
      const head = document.createElement("button");
      head.className = "sec-head";
      head.innerHTML = `<span class="caret">▸</span><span class="nm">${escapeHtml(s.displaySymbol)}</span>` +
        `<span class="idx"><span class="${cls(s.pchg)}">${s.pchg > 0 ? "+" : ""}${s.pchg.toFixed(2)}%</span>` +
        `<span>${fmtNum(s.ltp)}</span><span class="${cls(s.chg)}">${sign(s.chg)}${fmtNum(s.chg)}</span></span>`;
      let body = null;
      const refreshBody = () => {
        const cached = componentsCache.get(s.sectorId);
        if (cached) renderSectorComponentBody(cached, body);
        else loadSectorComponents(s.sectorId, body);
      };
      head.onclick = () => {
        const open = item.classList.toggle("open");
        head.querySelector(".caret").textContent = open ? "▾" : "▸";
        if (open) {
          expandedSectors.add(s.sectorId);
          if (!body) {
            body = document.createElement("div");
            body.className = "sec-body";
            body.innerHTML = `<div class="load-msg">Loading…</div>`;
            item.appendChild(body);
            refreshBody();
          }
        } else {
          expandedSectors.delete(s.sectorId);
        }
      };
      item.appendChild(head);
      if (expandedSectors.has(s.sectorId)) {
        item.classList.add("open");
        head.querySelector(".caret").textContent = "▾";
        body = document.createElement("div");
        body.className = "sec-body";
        item.appendChild(body);
        refreshBody();
      }
      el.appendChild(item);
    }
  }

  async function loadSectorComponents(sectorId, body) {
    try {
      const d = await fetchJson("/api/sectors/components?sectorId=" + encodeURIComponent(sectorId));
      componentsCache.set(sectorId, d);
      renderSectorComponentBody(d, body);
    } catch (e) {
      body.innerHTML = `<div class="load-msg">Failed to load constituents: ${escapeHtml(e.message)}</div>`;
    }
  }

  function renderSectorComponentBody(d, body) {
    const comps = d.components || [];
    if (!comps.length) { body.innerHTML = `<div class="load-msg">No constituents reported.</div>`; return; }
    const sorted = [...comps].sort((a, b) => (b.wt || 0) - (a.wt || 0));
    const rows = sorted.map(c => `<tr>
      <td>${escapeHtml(c.symbol)}</td>
      <td>${fmtNum(c.ltp)}</td>
      <td class="${cls(c.chg)}">${sign(c.chg)}${fmtNum(c.chg)}</td>
      <td class="${cls(c.pchg)}">${c.pchg > 0 ? "+" : ""}${fmtNum(c.pchg)}%</td>
      <td>${c.wt != null ? c.wt.toFixed(2) : "—"}</td>
    </tr>`).join("");
    body.innerHTML = `<table><thead><tr><th>Stock</th><th>LTP</th><th>Chg</th><th>%Chg</th><th>Wt%</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function drawPie(sectors) {
    const canvas = $("sectorPie");
    const { ctx, W, H } = setupCanvas(canvas);
    if (!sectors || !sectors.length) { ctx.fillStyle = TICK; ctx.textAlign = "center"; ctx.fillText("No data", W / 2, H / 2); return; }
    const sorted = [...sectors].sort((a, b) => Math.abs(b.pchg) - Math.abs(a.pchg));
    const total = sorted.reduce((s, x) => s + Math.abs(x.pchg || 0), 0) || 1;
    const maxAbs = Math.max(...sorted.map(s => Math.abs(s.pchg || 0)), 1);
    const cx = W / 2, cy = H / 2;
    const r = Math.min(W, H) * 0.4;
    const inner = r * 0.58;
    let a = -Math.PI / 2;
    for (const s of sorted) {
      const frac = Math.abs(s.pchg || 0) / total;
      const a2 = a + frac * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, a, a2);
      ctx.arc(cx, cy, inner, a2, a, true);
      ctx.closePath();
      ctx.fillStyle = sectorColor(s.pchg, maxAbs);
      ctx.fill();
      ctx.strokeStyle = BG; ctx.lineWidth = 1.5; ctx.stroke();
      const mid = (a + a2) / 2;
      if (frac > 0.035) {
        const lx = cx + Math.cos(mid) * (r + inner) / 2;
        const ly = cy + Math.sin(mid) * (r + inner) / 2;
        ctx.fillStyle = "rgba(13,17,23,.9)"; ctx.font = "bold 10px Segoe UI"; ctx.textAlign = "center";
        ctx.fillText((s.pchg > 0 ? "+" : "") + s.pchg.toFixed(2) + "%", lx, ly + 3);
      }
      a = a2;
    }
    ctx.fillStyle = TICK; ctx.textAlign = "center"; ctx.font = "22px Segoe UI";
    ctx.fillText(String(sectors.length), cx, cy - 5);
    ctx.font = "11px Segoe UI";
    ctx.fillText("sectors", cx, cy + 13);
    renderPieLegend(sectors, maxAbs);
  }

  function renderPieLegend(sectors, maxAbs) {
    const sorted = [...sectors].sort((a, b) => b.pchg - a.pchg);
    $("sectorPieLegend").innerHTML = sorted.map(s => `<div class="item">
      <span class="dot" style="background:${sectorColor(s.pchg, maxAbs)}"></span>
      <span>${escapeHtml(s.displaySymbol)}</span>
      <span class="pct ${cls(s.pchg)}">${s.pchg > 0 ? "+" : ""}${s.pchg.toFixed(2)}%</span>
    </div>`).join("");
  }

  async function loadSectors() {
    try {
      const d = await fetchJson("/api/sectors");
      sectorState = d;
      renderSectorSummary(d.sectors);
      renderSectorComponents(d.sectors);
      drawPie(d.sectors);
      if (mode === "sectors") $("updated").textContent = "Sectors · " + new Date().toLocaleTimeString();
      banner("");
    } catch (e) {
      banner("Sectors load failed: " + e.message);
    }
  }

  function buildIdLegend() {
    const el = $("idLegend");
    el.innerHTML = "";
    for (const s of idChart.getSeries()) {
      const chip = document.createElement("span");
      chip.className = "id-chip" + (s.visible ? "" : " off");
      chip.innerHTML = `<i style="background:${s.color}"></i>${escapeHtml(s.displaySymbol)}`;
      chip.onclick = () => { chip.classList.toggle("off"); idChart.toggle(s.symbol); };
      chip.onmouseenter = () => idChart.setHighlight(s.symbol);
      chip.onmouseleave = () => idChart.setHighlight(null);
      el.appendChild(chip);
    }
  }

  async function loadIntraday() {
    try {
      const d = await fetchJson("/api/sectors/intraday");
      intradayState = d;
      idChart.setData(d.ts, d.series);
      buildIdLegend();
    } catch (e) {
      banner("Intraday load failed: " + e.message);
    }
  }

  class IntradayChart {
    constructor(canvas, tooltip) {
      this.canvas = canvas;
      this.tooltip = tooltip;
      this.ts = [];
      this.series = [];
      this.hidden = new Set();
      this.n = 0;
      this.view = { i0: 0, i1: 0, y0: 0, y1: 0 };
      this.metric = "pchg";
      this.drag = null;
      this.hover = null;
      this.highlight = null;
      this.geom = null;
      this.bind();
    }

    setMetric(m) { this.metric = m; if (this.n) { this.computeY(); this.draw(); } }

    setHighlight(symbol) { this.highlight = symbol; this.draw(); }

    setData(ts, series) {
      this.ts = ts;
      this.n = ts.length;
      this.series = series.map((s, i) => ({
        symbol: s.symbol,
        displaySymbol: s.displaySymbol,
        ltp: s.ltp || [],
        pchg: s.pchg || [],
        color: SECTOR_COLORS[i % SECTOR_COLORS.length],
        dash: ID_DASHES[i % ID_DASHES.length],
        visible: !this.hidden.has(s.symbol),
      }));
      this.reset();
    }

    getSeries() { return this.series; }
    yValues(s) { return this.metric === "pchg" ? s.pchg : s.ltp; }

    reset() {
      this.view.i0 = 0;
      this.view.i1 = Math.max(0, this.n - 1);
      this.computeY();
      this.draw();
    }

    computeY() {
      let lo = Infinity, hi = -Infinity;
      for (const s of this.series) {
        if (!s.visible) continue;
        const yv = this.yValues(s);
        for (let i = this.view.i0; i <= this.view.i1; i++) {
          const v = yv[i];
          if (v === null || v === undefined || isNaN(v)) continue;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      if (!isFinite(lo)) { lo = 0; hi = 1; }
      const pad = (hi - lo) * 0.08 || 1;
      this.view.y0 = lo - pad;
      this.view.y1 = hi + pad;
    }

    toggle(symbol) {
      if (this.hidden.has(symbol)) this.hidden.delete(symbol);
      else this.hidden.add(symbol);
      const s = this.series.find(x => x.symbol === symbol);
      if (s) s.visible = !this.hidden.has(symbol);
      this.computeY();
      this.draw();
    }

    bind() {
      const c = this.canvas;
      c.addEventListener("wheel", (e) => {
        if (!this.n) return;
        e.preventDefault();
        const rect = c.getBoundingClientRect();
        const anchor = this.indexAt(e.clientX - rect.left);
        const factor = e.deltaY < 0 ? 1 / 1.25 : 1.25;
        const span = this.view.i1 - this.view.i0 + 1;
        const newSpan = Math.max(5, Math.min(this.n, Math.round(span * factor) + 1));
        const frac = (anchor - this.view.i0) / span;
        let i0 = this.view.i0 + Math.round((span - newSpan) * frac);
        i0 = Math.max(0, Math.min(i0, this.n - newSpan));
        this.view.i0 = i0;
        this.view.i1 = i0 + newSpan - 1;
        this.computeY();
        this.draw();
      }, { passive: false });

      c.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        this.drag = { x: e.clientX, i0: this.view.i0 };
        this.hover = null;
        this.tooltip.classList.add("hidden");
      });

      window.addEventListener("mousemove", (e) => {
        const rect = c.getBoundingClientRect();
        const x = e.clientX - rect.left;
        if (this.drag) {
          const span = this.view.i1 - this.view.i0;
          const ppix = (rect.width - CHART_PAD_L - CHART_PAD_R) / span;
          let i0 = this.drag.i0 - Math.round((e.clientX - this.drag.x) / ppix);
          i0 = Math.max(0, Math.min(i0, this.n - span - 1));
          this.view.i0 = i0;
          this.view.i1 = i0 + span;
          this.computeY();
          this.draw();
        } else {
          this.hover = this.n ? this.indexAt(x) : null;
          this.draw();
        }
      });

      window.addEventListener("mouseup", () => { this.drag = null; });
      c.addEventListener("mouseleave", () => { this.hover = null; this.draw(); });
      c.addEventListener("dblclick", () => this.reset());
    }

    indexAt(px) {
      const rect = this.canvas.getBoundingClientRect();
      const cw = rect.width - CHART_PAD_L - CHART_PAD_R;
      const span = this.view.i1 - this.view.i0 || 1;
      const f = (px - CHART_PAD_L) / cw;
      const i = Math.round(this.view.i0 + f * span);
      return Math.max(this.view.i0, Math.min(this.view.i1, i));
    }

    xOf(i) { return this.geom.padL + (i - this.view.i0) / this.geom.span * this.geom.cw; }
    yOf(v) { return this.geom.padT + this.geom.ch - (v - this.view.y0) / (this.view.y1 - this.view.y0) * this.geom.ch; }
    timeOf(i) { return new Date(this.ts[i]).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }

    draw() {
      const { ctx, W, H } = setupCanvas(this.canvas);
      if (!this.n) { ctx.fillStyle = TICK; ctx.textAlign = "center"; ctx.fillText("No intraday data yet", W / 2, H / 2); return; }
      const padL = CHART_PAD_L, padR = CHART_PAD_R, padT = CHART_PAD_T, padB = CHART_PAD_B;
      const cw = W - padL - padR, ch = H - padT - padB;
      const span = (this.view.i1 - this.view.i0) || 1;
      this.geom = { W, H, cw, ch, padL, padR, padT, padB, span };
      const ticks = 5;
      ctx.strokeStyle = GRID; ctx.fillStyle = TICK;
      ctx.font = "10px Segoe UI"; ctx.textAlign = "right"; ctx.lineWidth = 1;
      for (let t = 0; t <= ticks; t++) {
        const v = this.view.y0 + (this.view.y1 - this.view.y0) * t / ticks;
        const y = this.yOf(v);
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
        const label = this.metric === "pchg" ? (v > 0 ? "+" : "") + v.toFixed(2) + "%" : fmtNum(v);
        ctx.fillText(label, padL - 6, y + 4);
      }
      if (this.view.y0 < 0 && this.view.y1 > 0) {
        const y = this.yOf(0);
        ctx.strokeStyle = TICK; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.textAlign = "center";
      const xTicks = Math.min(6, span + 1);
      for (let t = 0; t < xTicks; t++) {
        const i = this.view.i0 + Math.round(span * t / (xTicks - 1 || 1));
        if (i < 0 || i >= this.n) continue;
        ctx.fillText(this.timeOf(i), this.xOf(i), H - 12);
      }
      for (const s of this.series) {
        if (!s.visible) continue;
        const dim = this.highlight && s.symbol !== this.highlight;
        const yv = this.yValues(s);
        ctx.strokeStyle = s.color;
        ctx.lineWidth = this.highlight === s.symbol ? 2.6 : 1.7;
        ctx.setLineDash(s.dash);
        ctx.globalAlpha = dim ? 0.12 : 1;
        ctx.shadowColor = s.color;
        ctx.shadowBlur = this.highlight === s.symbol ? 9 : 5;
        ctx.beginPath();
        let started = false;
        for (let i = this.view.i0; i <= this.view.i1; i++) {
          if (i < 0 || i >= this.n) continue;
          const v = yv[i];
          if (v === null || v === undefined || isNaN(v)) { started = false; continue; }
          const x = this.xOf(i), y = this.yOf(v);
          if (!started) { ctx.moveTo(x, y); started = true; }
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
      }
      if (this.hover != null) {
        const x = this.xOf(this.hover);
        ctx.strokeStyle = "#e6edf3"; ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ch); ctx.stroke();
        ctx.setLineDash([]);
        for (const s of this.series) {
          if (!s.visible) continue;
          if (this.highlight && s.symbol !== this.highlight) continue;
          const v = this.yValues(s)[this.hover];
          if (v === null || v === undefined || isNaN(v)) continue;
          const y = this.yOf(v);
          ctx.fillStyle = s.color;
          ctx.shadowColor = s.color; ctx.shadowBlur = 6;
          ctx.beginPath(); ctx.arc(x, y, this.highlight === s.symbol ? 4 : 2.5, 0, Math.PI * 2); ctx.fill();
          ctx.shadowBlur = 0;
        }
        this.showTooltip();
      } else {
        this.tooltip.classList.add("hidden");
      }
    }

    showTooltip() {
      const t = new Date(this.ts[this.hover]).toLocaleString();
      let rows = "";
      for (const s of this.series) {
        if (!s.visible) continue;
        const v = this.yValues(s)[this.hover];
        if (v === null || v === undefined || isNaN(v)) continue;
        const val = this.metric === "pchg" ? (v > 0 ? "+" : "") + v.toFixed(2) + "%" : fmtNum(v);
        rows += `<div class="tt-row"><span><i style="background:${s.color}"></i>${escapeHtml(s.displaySymbol)}</span><span>${val}</span></div>`;
      }
      this.tooltip.innerHTML = `<div class="tt-t">${escapeHtml(t)}</div>` + rows;
      this.tooltip.classList.remove("hidden");
      const x = Math.max(140, Math.min(this.geom.W - 160, this.xOf(this.hover) + 16));
      this.tooltip.style.left = x + "px";
      this.tooltip.style.top = CHART_PAD_T + "px";
    }
  }

  function syncWlActive() {
    window.watchlists.setActive(ticker?.Name);
  }

  function buildWatchlist() {
    window.watchlists.setUniverse(tickers, dhanMap, selectTicker);
  }

  function toggleWL(open) {
    const openNow = open !== undefined ? open : !$("wlPane").classList.contains("open");
    $("wlPane").classList.toggle("open", openNow);
    document.body.classList.toggle("watchlist-open", openNow);
    $("wlToggle").setAttribute("aria-expanded", String(openNow));
    if (openNow) buildWatchlist();
    window.dispatchEvent(new Event("resize"));
  }

  async function load() {
    if (!ticker) return;
    const requestId = ++liveRequest;
    const requestedName = ticker.Name;
    const btn = $("refreshBtn");
    btn.disabled = true;
    const useDhan = source === "dhan";
    try {
      const url = useDhan
        ? "/api/live?ticker=" + encodeURIComponent(requestedName)
        : "/api/data?ticker=" + encodeURIComponent(requestedName);
      const data = await fetchJson(url);
      if (requestId !== liveRequest || !ticker || ticker.Name !== requestedName) return;
      state = data;
      window.oiHeatmap.load(requestedName);
      window.oiZCycle.load(requestedName);
      renderAll();
      if (data.source !== "aoc") loadAnalytics();
      else clearAnalytics();
      $("updated").textContent = "Live · " + (data.source === "aoc" ? "AOC backup" : useDhan ? "Dhan" : "AOC") + " · " + new Date().toLocaleTimeString();
      banner(data.fallback_reason ? "Using AOC backup. Dhan: " + data.fallback_reason : "");
    } catch (e) {
      if (requestId !== liveRequest || !ticker || ticker.Name !== requestedName) return;
      banner("Failed to load live data: " + e.message);
    } finally {
      if (requestId === liveRequest) btn.disabled = false;
    }
  }

  async function loadHistorical() {
    if (!ticker) return;
    const expiry = $("expirySelect").value;
    const timeStr = $("histTime").value;
    if (!expiry || !timeStr) { banner("Select expiry and date/time"); return; }
    const ts = new Date(timeStr).getTime();
    if (!isFinite(ts) || ts <= 0) { banner("Select a valid date and time"); return; }
    const requestId = ++historicalRequest;
    const requestedName = ticker.Name;
    const btn = $("histLoadBtn");
    btn.disabled = true;
    try {
      const data = await fetchJson(`/api/historical?ticker=${encodeURIComponent(requestedName)}&expiry=${encodeURIComponent(expiry)}&timestamp=${ts}`);
      if (requestId !== historicalRequest || !ticker || ticker.Name !== requestedName) return;
      state = data;
      window.oiHeatmap.load(requestedName);
      window.oiZCycle.load(requestedName);
      renderAll();
      $("updated").textContent = `Historical · ${expiry} · ${new Date(ts).toLocaleString()}`;
      banner("");
    } catch (e) {
      if (requestId !== historicalRequest || !ticker || ticker.Name !== requestedName) return;
      banner("Failed to load historical data: " + e.message);
    } finally {
      if (requestId === historicalRequest) btn.disabled = false;
    }
  }

  function startAuto() {
    clearInterval(timer);
    timer = setInterval(() => {
      if (!$("refreshBtn").disabled) load();
    }, REFRESH_MS);
  }

  function stopAuto() {
    clearInterval(timer);
    timer = null;
  }

  function startSectors() {
    clearInterval(sectorsTimer);
    sectorsTimer = setInterval(() => { loadSectors(); loadIntraday(); }, SECTOR_REFRESH_MS);
  }

  function stopSectors() {
    clearInterval(sectorsTimer);
    sectorsTimer = null;
  }

  function setMode(next) {
    invalidateRequests();
    mode = next;
    isHistorical = next === "hist";
    $("modeLive").classList.toggle("active", next === "live");
    $("modeHist").classList.toggle("active", next === "hist");
    $("modeSectors").classList.toggle("active", next === "sectors");
    $("modeScanners").classList.toggle("active", next === "scanners");
    const sectors = next === "sectors";
    const scanners = next === "scanners";
    $("symbolCtrls").classList.toggle("hidden", sectors || scanners);
    $("liveCtrls").classList.toggle("hidden", next !== "live");
    $("histCtrls").classList.toggle("hidden", next !== "hist");
    $("chainPage").classList.toggle("hidden", sectors || scanners);
    $("sectorPage").classList.toggle("hidden", !sectors);
    $("scannerPage").classList.toggle("hidden", !scanners);
    $("updated").classList.toggle("hidden", scanners);
    stopAuto();
    stopSectors();
    if (next === "live") { startAuto(); load(); }
    else if (next === "hist") { clearAnalytics(); populateExpiries(); ensureDefaultTime(); loadHistorical(); }
    else if (sectors) { clearAnalytics(); loadSectors(); loadIntraday(); startSectors(); }
    else { clearAnalytics(); }
  }

  async function populateExpiries() {
    if (!ticker) return;
    const sel = $("expirySelect");
    sel.innerHTML = "";
    try {
      const { expiries } = await fetchJson("/api/expiries?ticker=" + encodeURIComponent(ticker.Name));
      for (const e of expiries) {
        const opt = document.createElement("option");
        opt.value = e; opt.textContent = e;
        sel.appendChild(opt);
      }
      sel.value = expiries[expiries.length - 1] || "";
    } catch (err) {
      banner("Could not load expiries: " + err.message);
    }
  }

  function defaultTimeValue() {
    const d = new Date(Date.now() - 86400000);
    d.setHours(9, 20, 0, 0);
    return toLocalInput(d);
  }

  function toLocalInput(d) {
    const p = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function ensureDefaultTime() {
    if (!$("histTime").value) $("histTime").value = defaultTimeValue();
  }

  function renderCombo(filter) {
    const list = $("symbolList");
    const q = (filter || "").toLowerCase();
    list.innerHTML = "";
    const groups = [
      { label: "Favourites", items: tickers.filter(t => t.Fav && t.userFav) },
      { label: "All", items: tickers.filter(t => !(t.Fav && t.userFav)) },
    ];
    let shown = 0;
    for (const g of groups) {
      const matches = g.items.filter(t =>
        !q || (t.Name || "").toLowerCase().includes(q) || (t.disp || "").toLowerCase().includes(q));
      if (!matches.length) continue;
      const li = document.createElement("li");
      li.className = "group"; li.textContent = g.label;
      list.appendChild(li);
      for (const t of matches.slice(0, q ? 25 : 15)) {
        const li = document.createElement("li");
        if (ticker && t.Name === ticker.Name) li.classList.add("sel");
        li.innerHTML = `<span class="code">${escapeHtml(t.Name)}</span><span class="desc">${escapeHtml(t.disp || "")}</span>`;
        li.onmousedown = (e) => { e.preventDefault(); selectTicker(t); };
        list.appendChild(li);
        shown++;
      }
    }
    list.classList.toggle("hidden", shown === 0);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function selectTicker(t) {
    invalidateRequests();
    clearAnalytics();
    ticker = t;
    window.oiHeatmap.load(t.Name);
    window.oiZCycle.load(t.Name);
    const input = $("symbolSearch");
    input.value = (t.disp || t.Name);
    $("symbolList").classList.add("hidden");
    syncWlActive();
    if (isHistorical) {
      populateExpiries().then(() => { $("histTime").value = defaultTimeValue(); loadHistorical(); });
    } else if (mode === "live") {
      load();
    }
  }

  function initCombo() {
    const input = $("symbolSearch");
    input.addEventListener("focus", () => renderCombo(input.value));
    input.addEventListener("input", () => renderCombo(input.value));
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".combo")) $("symbolList").classList.add("hidden");
    });
  }

  window.addEventListener("resize", () => {
    if (state) renderCharts();
    if (sectorState) drawPie(sectorState.sectors);
    if (idChart) idChart.draw();
    renderAnalyticsCharts();
  });

  async function init() {
    idChart = new IntradayChart($("sectorLine"), $("idTooltip"));
    ivrChart = new IvrChart($("chartIvrIvp"), $("ivrTooltip"), $("ivrLegend"));
    skewChart = new SkewChart($("chartSkew"), $("skewTooltip"), $("skewLegend"));
    termChart = new TermChart($("chartTerm"), $("termTooltip"));
    renderChipLegend($("ivrLegend"), ivrChart.getSeries(), ivrChart.hidden, (k) => ivrChart.toggle(k));
    renderChipLegend($("skewLegend"), skewChart.getSeries(), skewChart.hidden, (k) => skewChart.toggle(k));
    renderTermLegend();
    $("refreshBtn").addEventListener("click", load);
    $("histLoadBtn").addEventListener("click", loadHistorical);
    $("idReset").addEventListener("click", () => idChart.reset());
    $("idRelative").addEventListener("change", (e) => idChart.setMetric(e.target.checked ? "pchg" : "ltp"));
    $("autoToggle").addEventListener("change", (e) => {
      if (e.target.checked) startAuto(); else stopAuto();
    });
    $("sourceSelect").addEventListener("change", (e) => {
      invalidateRequests();
      source = e.target.value;
      clearAnalytics();
      if (mode === "live") load();
    });
    $("chainStrikes").addEventListener("change", (e) => {
      chainCount = +e.target.value;
      if (state) renderChain(state.metrics);
    });
    $("chainSpreadMode").addEventListener("change", e => {
      spreadMode = e.target.checked;
      $("spreadWidthControl").classList.toggle("hidden", !spreadMode);
      $("spreadUnitsControl").classList.toggle("hidden", !spreadMode);
      $("chainCountLabel").textContent = spreadMode ? "Pairs" : "Strikes";
      if (state) renderChain(state.metrics);
    });
    $("spreadWidth").addEventListener("change", e => {
      spreadWidth = +e.target.value;
      if (state) renderChain(state.metrics);
    });
    $("spreadRupees").addEventListener("change", e => {
      spreadRupees = e.target.checked;
      if (state) renderChain(state.metrics);
    });
    const spreadHelp = $("spreadHelpDialog");
    $("spreadHelp").addEventListener("click", () => spreadHelp.showModal());
    $("spreadHelpClose").addEventListener("click", () => spreadHelp.close());
    spreadHelp.addEventListener("click", e => { if (e.target === spreadHelp) {
      const rect = spreadHelp.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) spreadHelp.close();
    }});
    $("wlToggle").addEventListener("click", () => toggleWL());
    $("wlClose").addEventListener("click", () => toggleWL(false));
    $("wlBackdrop").addEventListener("click", () => toggleWL(false));
    $("wlRebuild").addEventListener("click", () => { buildWatchlist(); window.watchlists.refresh(); });
    $("chartsToggle").addEventListener("click", () => {
      chartsVisible = !chartsVisible;
      $("chartsWrap").classList.toggle("collapsed", !chartsVisible);
      $("chartsToggle").textContent = chartsVisible ? "Collapse" : "Expand";
      if (chartsVisible && state) renderCharts();
    });
    $("ivrLookback").addEventListener("change", (e) => {
      ivrLookback = e.target.value;
      loadAnalytics();
    });
    $("ivrToggle").addEventListener("click", () => {
      ivrVisible = !ivrVisible;
      $("ivrWrap").classList.toggle("collapsed", !ivrVisible);
      $("ivrToggle").textContent = ivrVisible ? "Collapse" : "Expand";
      $("ivrTooltip").classList.add("hidden");
      if (ivrVisible) renderAnalyticsCharts();
    });
    $("skewToggle").addEventListener("click", () => {
      skewVisible = !skewVisible;
      $("skewWrap").classList.toggle("collapsed", !skewVisible);
      $("skewToggle").textContent = skewVisible ? "Collapse" : "Expand";
      if (skewVisible) renderAnalyticsCharts();
    });
    $("ivrReset").addEventListener("click", () => ivrChart.reset());
    $("skewStrikes").addEventListener("change", () => {
      const input = $("skewStrikes");
      const value = Number(input.value);
      const count = isFinite(value) ? Math.max(1, Math.min(80, Math.trunc(value))) : 8;
      input.value = count;
      skewChart.strikesPerSide = count;
      skewChart.reset();
    });
    $("skewReset").addEventListener("click", () => skewChart.reset());
    $("termMode").querySelectorAll("button").forEach(b => {
      b.addEventListener("click", () => {
        termMode = b.dataset.mode;
        $("termMode").querySelectorAll("button").forEach(x => x.classList.toggle("active", x === b));
        if (termChart && termEligible()) { termChart.mode = termMode; termChart.draw(); }
      });
    });
    $("termReset").addEventListener("click", () => termChart.reset());
    $("termK").addEventListener("change", () => {
      let k = parseInt($("termK").value, 10);
      if (!isFinite(k) || k < 1) k = 1;
      if (k > 80) k = 80;
      $("termK").value = k;
      if (termChart) { termChart.k = k; termChart.reset(); }
    });
    $("termToggle").addEventListener("click", () => {
      termVisible = !termVisible;
      $("termWrap").classList.toggle("collapsed", !termVisible);
      $("termToggle").textContent = termVisible ? "Collapse" : "Expand";
      $("termTooltip").classList.add("hidden");
      if (termVisible) renderAnalyticsCharts();
    });
    $("modeLive").addEventListener("click", () => setMode("live"));
    $("modeHist").addEventListener("click", () => setMode("hist"));
    $("modeSectors").addEventListener("click", () => setMode("sectors"));
    $("modeScanners").addEventListener("click", () => setMode("scanners"));
    initCombo();
    try {
      const [{ tickers: list }, runtime] = await Promise.all([
        fetchJson("/api/live/tickers"),
        fetchJson("/api/config").catch(() => ({ providers: {} })),
      ]);
      tickers = list;
      buildWatchlist();
      const first = list.find(t => t.Name === "NIFTY") || list[0];
      try {
        const map = await fetchJson("/api/dhan/map");
        dhanMap = map && Array.isArray(map.mapped) && map.mapped.length ? map : null;
      } catch (e2) {
        dhanMap = null;
      }
      buildWatchlist();
      source = "dhan";
      $("sourceSelect").value = source;
      selectTicker(first);
      // Load lot metadata independently so Dhan startup and chains remain responsive.
      fetchJson("/api/tickers").then(({tickers: metadata}) => {
        const byName = new Map((metadata || []).map(t => [t.Name, t]));
        tickers = tickers.map(t => ({...t, ...byName.get(t.Name)}));
        if (ticker) ticker = tickers.find(t => t.Name === ticker.Name) || ticker;
        if (state?.ticker) {
          state.ticker = {...state.ticker, ...byName.get(state.ticker.Name)};
          renderAll();
        }
        buildWatchlist();
      }).catch(() => {});
    } catch (e) {
      banner("Could not load tickers: " + e.message);
    }
    setMode(mode);
  }

  init();
})();
