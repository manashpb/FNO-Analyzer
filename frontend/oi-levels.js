(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const num = value => value == null ? "—" : Number(value).toFixed(2);
  let pending = false;
  function sync() {
    for (const name of ["Distance", "Gap", "Second"]) $("ol" + name).disabled = !$("ol" + name + "On").checked;
    $("olDays").disabled = !$("olSecondOn").checked;
  }
  for (const name of ["Distance", "Gap", "Second"]) $("ol" + name + "On").addEventListener("change", sync);
  sync();
  $("olRun").addEventListener("click", async () => {
    if (pending) return;
    const params = new URLSearchParams({direction: $("olDirection").value});
    for (const name of ["Distance", "Gap", "Second", "Days"]) {
      const enabled = name === "Days" ? $("olSecondOn").checked : $("ol" + name + "On").checked;
      const input = $("ol" + name);
      if (enabled && (!input.value.trim() || !input.checkValidity())) {
        $("olStatus").textContent = "Enter a valid value for " + name.toLowerCase() + "."; return;
      }
      params.set(name.toLowerCase(), enabled ? input.value : name === "Days" ? "0" : "off");
    }
    pending = true; $("olRun").disabled = true;
    $("olResults").textContent = ""; $("olExcluded").textContent = "";
    $("olStatus").textContent = "Scanning archived closing chains…";
    try {
      const response = await fetch('/api/scanners/oi-levels/run?' + params, {method: "POST"});
      const state = await response.json();
      if (!response.ok) throw new Error(state.error || "OI scanner request failed; restart the backend if outdated");
      const side = state.settings.direction === "bullish" ? "PE" : "CE";
      $("olResults").innerHTML = state.rows.length ? `<table><thead><tr><th>Stock</th><th>Closing date / expiry</th><th>Close</th><th>Highest CE strike</th><th>Highest PE strike</th><th>Distance to ${side} %</th><th>Gap intervals</th><th>Second ${side} strike / OI %</th><th>Second OI history</th></tr></thead><tbody>${state.rows.map(r => `<tr><td>${esc(r.symbol)}</td><td>${esc(r.day)}<br>${esc(r.expiry)}</td><td>${num(r.close)}</td><td>${num(r.call_strike)}</td><td>${num(r.put_strike)}</td><td>${num(r.distance)}</td><td>${r.gap}</td><td>${num(r.second_strike)} / ${num(r.second_pct)}%</td><td>${r.history.map(h => `${esc(h.day)}: ${num(h.second_pct)}%`).join("<br>") || "Disabled"}</td></tr>`).join("")}</tbody></table>` : "No matching stocks.";
      globalThis.watchlists?.mount("olResults", state.rows, state.id);
      $("olExcluded").innerHTML = state.excluded.length ? `<table><thead><tr><th>Stock</th><th>Reason</th></tr></thead><tbody>${state.excluded.map(r => `<tr><td>${esc(r.symbol)}</td><td>${esc(r.reason)}</td></tr>`).join("")}</tbody></table>` : "None.";
      $("olStatus").textContent = `${state.settings.direction} · ${state.rows.length} matches / ${state.total} stocks · closing date ${state.as_of || "unavailable"} · X ${state.settings.distance ?? "off"}, Y ${state.settings.gap ?? "off"}, Z ${state.settings.second ?? "off"}, N ${state.settings.days}`;
    } catch (e) { $("olStatus").textContent = e.message; }
    finally { pending = false; $("olRun").disabled = false; }
  });
})();
