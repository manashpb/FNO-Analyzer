(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  let state = null;
  let timer = null;
  let pending = false;
  let generation = 0;
  const fmt = n => Number(n || 0).toLocaleString("en-IN");
  const escape = value => String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  async function request(path, method = "GET") {
    const response = await fetch(path, { method });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Archive request failed. Restart the app if the backend is outdated.");
    return body;
  }
  function render(next) {
    state = next;
    const running = next.status === "running";
    $("oiUpdate").disabled = running || pending;
    $("oiCancel").disabled = !running || pending;
    const archive = next.archive;
    if (next.status === "idle") $("oiStatus").textContent = "Click Data update to backfill or resume the daily archive.";
    else $("oiStatus").textContent = `${next.status} · ${next.phase} · ${fmt(next.discovered)}/1 shared expiry list · ${fmt(next.expiries_applied)}/${fmt(next.symbols)} stocks prepared · ${fmt(next.processed ?? next.checked)}/${fmt(next.total)} tasks processed · ${fmt(next.checked)} fetched · ${fmt(next.saved)} saved · ${fmt(next.unavailable)} unavailable · ${fmt(next.skipped_tasks)} skipped after day sampling · ${fmt(next.errors)} errors${next.current ? " · " + next.current : ""}${next.error ? " · " + next.error : ""}`;
    const hours = next.minimum_seconds ? ` · At least ${(next.minimum_seconds / 3600).toFixed(1)} hours of request pacing for this update` : "";
    $("oiCoverage").textContent = `${fmt(archive.chains)} snapshots stored · ${fmt(archive.coverage.length)} stocks with data · ${fmt(archive.retry_exhausted)} stock/date/expiry gaps excluded after ${archive.max_error_attempts ?? 3} failed attempts · ${next.request_interval_seconds}s minimum between AOC requests${hours}`;
    const coverage = archive.coverage;
    $("oiStocks").innerHTML = coverage.length ? `<table><thead><tr><th>Stock</th><th>First stored date</th><th>Last stored date</th><th>Snapshots</th></tr></thead><tbody>${coverage.map(row => `<tr><td>${escape(row.symbol)}</td><td>${escape(row.first_date)}</td><td>${escape(row.last_date)}</td><td>${fmt(row.snapshots)}</td></tr>`).join("")}</tbody></table>` : "No historical chains stored yet.";
    if (next.excluded?.length) {
      const note = document.createElement("p");
      note.textContent = `Excluded (indices, commodities or unclassified symbols): ${next.excluded.join(", ")}`;
      $("oiStocks").appendChild(note);
    }
    if (archive.day_skips?.length) {
      const note = document.createElement("p");
      note.textContent = `Dates skipped after six unavailable stock fetches: ${archive.day_skips.map(row => row.day).join(", ")}`;
      $("oiStocks").appendChild(note);
    }
    if (archive.holiday_dates?.length) {
      const note = document.createElement("p");
      note.textContent = `User-supplied holiday exclusions: ${archive.holiday_dates.join(", ")}`;
      $("oiStocks").appendChild(note);
    }
  }
  async function poll() {
    clearTimeout(timer);
    const version = generation;
    try {
      const next = await request("api/history/oi/status");
      if (version !== generation) return;
      render(next);
    } catch (error) {
      if (version !== generation) return;
      $("oiStatus").textContent = error.message;
    }
    if (version === generation && state?.status === "running") timer = setTimeout(poll, 2000);
  }
  async function action(path) {
    if (pending) return;
    pending = true;
    generation += 1;
    clearTimeout(timer);
    $("oiUpdate").disabled = true;
    $("oiCancel").disabled = true;
    try { render(await request(path, "POST")); }
    catch (error) { $("oiStatus").textContent = error.message; }
    finally {
      pending = false;
      $("oiUpdate").disabled = state?.status === "running";
      $("oiCancel").disabled = state?.status !== "running";
      if (state?.status === "running") timer = setTimeout(poll, 2000);
    }
  }
  $("oiUpdate").addEventListener("click", () => action("api/history/oi/start"));
  $("oiCancel").addEventListener("click", () => {
    if (state?.id) action("api/history/oi/cancel?id=" + encodeURIComponent(state.id));
  });
  poll();
})();
