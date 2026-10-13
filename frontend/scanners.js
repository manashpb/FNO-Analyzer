(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  let scan = null;
  let timer = null;
  let controlsEdited = false;
  const fmt = value => Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 });
  const signed = value => (value > 0 ? "+" : "") + fmt(value);
  const escape = value => String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

  async function request(path, method = "GET") {
    const response = await fetch(path, { method });
    const body = await response.json();
    if (!response.ok) {
      const error = new Error(body.error || "Scan request failed");
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function table(id, rows, running, directionEnabled) {
    if (!rows.length) {
      $(id).textContent = running ? "Scanning qualifying stocks…" : "No matches among checked stocks.";
      return;
    }
    $(id).innerHTML = `<table><thead><tr><th>Stock</th><th>Current IVP</th><th>Current IV %</th>${directionEnabled ? '<th>Smoothed IV start → end</th><th>IV Δ (pp)</th><th>IV Δ %</th><th>Smoothed IVP start → end</th><th>History dates</th>' : ''}</tr></thead><tbody>${rows.map(row => `<tr>
      <td>${escape(row.symbol)}</td><td>${fmt(row.ivp)}</td><td>${fmt(row.iv)}</td>
      ${directionEnabled ? `<td>${fmt(row.iv_start)} → ${fmt(row.iv_end)}</td><td>${signed(row.iv_change)}</td><td>${signed(row.iv_change_pct)}%</td>
      <td>${fmt(row.ivp_start)} → ${fmt(row.ivp_end)}</td><td>${escape(row.start_date)} → ${escape(row.end_date)}</td>` : ''}
    </tr>`).join("")}</tbody></table>`;
  }

  function render(state) {
    scan = state;
    const running = state.status === "running";
    $("scanRun").disabled = running;
    $("scanCancel").disabled = !running;
    $("scannerForm").querySelectorAll("input").forEach(input => { input.disabled = running; });
    $("scanHighTitle").textContent = `High IVP > ${state.high_cutoff} · ${state.falling !== false ? "IV cooling" : "IVP only"} (${state.high.length})`;
    $("scanLowTitle").textContent = `Low IVP < ${state.low_cutoff} · ${state.rising !== false ? "IV rising" : "IVP only"} (${state.low.length})`;
    const progress = `${state.checked}/${state.candidates} candidates checked · ${state.total_stocks} stocks in movers · ${state.skipped.length} skipped`;
    $("scanStatus").textContent = `${running ? "Scanning" : state.status === "complete" ? "Complete" : state.status === "cancelled" ? "Cancelled — partial results" : "Failed — partial results"}: ${progress}${state.error ? " · " + state.error : ""}`;
    table("scanHighResults", state.high, running, state.falling !== false);
    table("scanLowResults", state.low, running, state.rising !== false);
    globalThis.watchlists?.mount("scanHighResults", state.high, state.id);
    globalThis.watchlists?.mount("scanLowResults", state.low, state.id);
    $("scanSkipped").hidden = !state.skipped.length;
    $("scanSkippedTitle").textContent = `Skipped stocks (${state.skipped.length})`;
    $("scanSkippedList").innerHTML = state.skipped.map(row => `<li>${escape(row.symbol)}: ${escape(row.reason)}</li>`).join("");
  }

  function supportsDirectionFilters(state) {
    return typeof state.falling === "boolean" && typeof state.rising === "boolean";
  }

  $("scannerForm").addEventListener("input", () => {
    controlsEdited = true;
    if (scan && scan.status !== "running") {
      $("scanStatus").textContent = "Filters changed. Click Run scan to apply them; displayed results use the previous scan settings.";
    }
  });

  async function poll() {
    try {
      const state = await request("api/scanners/iv/status?id=" + encodeURIComponent(scan.id));
      render(state);
      if (state.status === "running") timer = setTimeout(poll, 1500);
    } catch (error) {
      if (error.status === 404) {
        scan = null;
        $("scanRun").disabled = false;
        $("scanCancel").disabled = true;
        $("scannerForm").querySelectorAll("input").forEach(input => { input.disabled = false; });
        $("scanStatus").textContent = "Scan no longer available; run a new scan. Displayed results are from the previous scan.";
        return;
      }
      $("scanStatus").textContent = "Progress request failed: " + error.message + ". Retrying…";
      timer = setTimeout(poll, 5000);
    }
  }

  $("scannerForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (scan && scan.status === "running") return;
    const params = new URLSearchParams({ high: $("scanHigh").value, low: $("scanLow").value, days: $("scanDays").value, smoothing: $("scanSmooth").value, falling: String($("scanFalling").checked), rising: String($("scanRising").checked) });
    if (Number(params.get("low")) >= Number(params.get("high"))) {
      $("scanStatus").textContent = "Low IVP cutoff must be below the high IVP cutoff.";
      return;
    }
    clearTimeout(timer);
    $("scanRun").disabled = true;
    $("scanStatus").textContent = "Starting scan…";
    try {
      const state = await request("api/scanners/iv/start?" + params, "POST");
      if (!supportsDirectionFilters(state) || state.falling !== $("scanFalling").checked || state.rising !== $("scanRising").checked) {
        throw new Error("The running server did not apply your direction filters. Restart the application to load the updated backend, then run the scan again.");
      }
      controlsEdited = false;
      render(state);
      timer = setTimeout(poll, 500);
    } catch (error) {
      $("scanStatus").textContent = error.message;
      $("scanRun").disabled = false;
    }
  });
  $("scanCancel").addEventListener("click", async () => {
    if (!scan) return;
    $("scanCancel").disabled = true;
    try {
      await request("api/scanners/iv/cancel?id=" + encodeURIComponent(scan.id), "POST");
      $("scanStatus").textContent = "Cancelling after the current history request…";
    } catch (error) {
      $("scanStatus").textContent = error.message;
      $("scanCancel").disabled = false;
    }
  });
  // Resume the server's last scan after a reload, without starting more requests.
  request("api/scanners/iv/status").then(state => {
    if (state.status !== "idle" && !scan && !$("scanRun").disabled) {
      if (!supportsDirectionFilters(state)) {
        $("scanStatus").textContent = "The running server uses an older scanner. Restart the application before scanning; your filter selections have been kept.";
        return;
      }
      if (controlsEdited) return;
      $("scanHigh").value = state.high_cutoff;
      $("scanLow").value = state.low_cutoff;
      $("scanDays").value = state.days;
      $("scanSmooth").value = state.smoothing;
      $("scanFalling").checked = state.falling;
      $("scanRising").checked = state.rising;
      render(state);
      if (state.status === "running") timer = setTimeout(poll, 500);
    }
  }).catch(() => {});
})();
