(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const num = value => value == null ? "—" : Number(value).toFixed(2);
  let state = null, timer = null, pending = false, version = 0;
  let applied = {months: "12", side: "either", direction: "absolute", threshold: 2, opposite: 0};
  const combined = side => side === "ce_dominant" || side === "pe_dominant";
  function pair(row) {
    const p = row.periods[applied.months];
    const ce = p?.ce?.z, pe = p?.pe?.z;
    if (!Number.isFinite(ce) || !Number.isFinite(pe)) return null;
    return applied.side === "ce_dominant" ? [ce, pe] : [pe, ce];
  }
  function passes(row) {
    if (!combined(applied.side)) return strength(row) >= applied.threshold;
    const values = pair(row);
    return values !== null && values[0] >= applied.threshold && values[1] <= applied.opposite;
  }
  async function request(method = "GET") {
    const response = await fetch('api/scanners/oi-zscore/' + (method === "POST" ? "update" : "status"), {method});
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Z-score request failed; restart the backend if outdated");
    return body;
  }
  function details(side) {
    if (!side) return "Unavailable";
    return `Z ${num(side.z)} · n ${side.n} · mean ${num(side.mean)} · SD ${num(side.sd)}` +
      (side.reason ? ` · ${esc(side.reason)}` : "") +
      `<details><summary>Sample dates</summary>${side.samples.map(s => `${esc(s.day)} · expiry ${esc(s.expiry)} · ATM ${num(s.atm_strike)} · OI ${num(s.oi)}`).join("<br>") || "None"}</details>`;
  }
  function table(rows) {
    if (!rows.length) return "No stocks to display.";
    const showGap = combined(applied.side);
    return `<table><thead><tr><th>Stock</th><th>Closing date / expiry</th><th>ATM / DTE</th><th>CE · ${applied.months}M</th><th>PE · ${applied.months}M</th>${showGap ? `<th>${applied.side === 'ce_dominant' ? 'CE − PE' : 'PE − CE'} Z gap</th>` : ''}</tr></thead><tbody>${rows.map(r => {
      const p = r.periods[applied.months];
      const values = showGap ? pair(r) : null;
      return `<tr><td>${esc(r.symbol)}</td><td>${esc(r.day)}<br>${esc(r.expiry)}</td><td>${num(r.atm_strike)} / ${r.dte}</td><td>${details(p?.ce)}</td><td>${details(p?.pe)}</td>${showGap ? `<td>${num(values ? values[0] - values[1] : null)}</td>` : ''}</tr>`;
    }).join("")}</tbody></table>`;
  }
  function strength(row) {
    if (combined(applied.side)) {
      const values = pair(row);
      return values ? values[0] - values[1] : -Infinity;
    }
    const p = row.periods[applied.months];
    const sides = applied.side === "either" ? [p?.ce, p?.pe] : [p?.[applied.side]];
    const values = sides.filter(s => s?.z != null).map(s => applied.direction === "absolute" ? Math.abs(s.z) : applied.direction === "low" ? -s.z : s.z);
    return values.length ? Math.max(...values) : -Infinity;
  }
  function render() {
    if (!state) return;
    const rows = state.rows || [];
    const query = $("zSearch").value.trim().toLowerCase();
    const sort = $("zSort").value || "strength";
    const visible = rows.filter(r => [r.symbol, r.name, r.disp].some(value => String(value || '').toLowerCase().includes(query)));
    const compare = (a, b) => {
      const av = sort === "strength" ? strength(a) : a.periods[applied.months]?.[sort]?.z;
      const bv = sort === "strength" ? strength(b) : b.periods[applied.months]?.[sort]?.z;
      if (av == null && bv != null) return 1;
      if (bv == null && av != null) return -1;
      return (av == null ? 0 : bv - av) || a.symbol.localeCompare(b.symbol);
    };
    const matches = visible.filter(passes).sort(compare);
    $("zResults").innerHTML = table(matches);
    const all = [...visible].sort(compare);
    $("zAll").innerHTML = table(all);
    globalThis.watchlists?.mount("zResults", matches, state.stored?.updated_at);
    globalThis.watchlists?.mount("zAll", all, state.stored?.updated_at);
    $("zStatus").textContent = `${state.status}${state.status === 'running' ? ` · ${state.processed}/${state.total} stocks` : ''} · ${matches.length} matches · ${rows.length} stocks stored${state.stored ? ` · baselines as of ${state.stored.as_of} · updated ${state.stored.updated_at}` : ' · click Update rolling Z-scores'}${state.error ? ' · ' + state.error : ''}`;
    if (state.needs_update && state.status !== "running") $("zStatus").textContent += " · update required: date or archive changed";
    if (query) $("zStatus").textContent += ` · ${visible.length} stocks matching search`;
    if (combined(applied.side)) $("zStatus").textContent += ` · ${applied.side === 'ce_dominant' ? 'CE' : 'PE'} Z ≥ ${applied.threshold} AND ${applied.side === 'ce_dominant' ? 'PE' : 'CE'} Z ≤ ${applied.opposite} · ${applied.months}M`;
    $("zUpdate").disabled = pending || state.status === "running";
  }
  $("zSort").addEventListener("change", render);
  $("zSearch").addEventListener("input", render);
  function syncSetup() {
    const joint = combined($("zSide").value);
    $("zOppositeControl").hidden = !joint;
    $("zDirection").disabled = joint;
  }
  $("zSide").addEventListener("change", syncSetup);
  syncSetup();
  async function poll() {
    clearTimeout(timer);
    const current = version;
    try {
      const next = await request();
      if (current !== version) return;
      state = next; render();
    } catch (e) { if (current === version) $("zStatus").textContent = e.message; }
    if (current === version && state?.status === "running") timer = setTimeout(poll, 1500);
  }
  $("zRun").addEventListener("click", () => {
    const threshold = Number($("zThreshold").value);
    if (!$("zThreshold").value.trim() || !Number.isFinite(threshold) || threshold < 0) {
      $("zStatus").textContent = "Enter a finite threshold of zero or greater."; return;
    }
    const opposite = Number($("zOpposite").value);
    if (combined($("zSide").value) && (!$("zOpposite").value.trim() || !Number.isFinite(opposite))) {
      $("zStatus").textContent = "Enter a finite opposite-side Z cutoff."; return;
    }
    applied = {months: $("zPeriod").value, side: $("zSide").value, direction: $("zDirection").value, threshold, opposite};
    render();
  });
  $("zUpdate").addEventListener("click", async () => {
    if (pending || state?.status === "running") return;
    pending = true; version++; clearTimeout(timer); $("zUpdate").disabled = true;
    try { state = await request("POST"); render(); }
    catch (e) { $("zStatus").textContent = e.message; }
    finally { pending = false; $("zUpdate").disabled = state?.status === "running"; if (state?.status === "running") timer = setTimeout(poll, 1500); }
  });
  poll();
})();
