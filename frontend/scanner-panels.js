(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  // Keep display state separate from provider state so polling cannot undo a clear.
  const cleared = new Set();
  function clear(ids) {
    ids.forEach(id => { cleared.add(id); $(id).setAttribute("data-results-cleared", ""); });
  }
  function restore(ids) {
    ids.forEach(id => { cleared.delete(id); $(id).removeAttribute("data-results-cleared"); });
  }
  document.querySelectorAll("#scannerPage section.scanner-panel").forEach(panel => {
    const body = panel.querySelector(".scanner-panel-body");
    const toggle = panel.querySelector(".scanner-collapse");
    const ids = panel.dataset.clearTargets.split(" ");
    const note = document.createElement("p");
    note.className = "scanner-clear-note";
    note.textContent = "Results cleared. Run or update again to display results.";
    note.hidden = true;
    body.appendChild(note);
    toggle.addEventListener("click", () => {
      body.hidden = !body.hidden;
      toggle.textContent = body.hidden ? "Expand" : "Collapse";
      toggle.setAttribute("aria-expanded", String(!body.hidden));
    });
    panel.querySelector(".scanner-clear").addEventListener("click", () => {
      clear(ids);
      document.querySelectorAll("#scannerPage section.scanner-panel").forEach(other => {
        const targets = other.dataset.clearTargets.split(" ");
        other.querySelector(".scanner-clear-note").hidden = !targets.every(id => cleared.has(id));
      });
    });
    panel.dataset.resultActions.split(" ").forEach(id => {
      const action = id === "scanRun" ? $("scannerForm") : $(id);
      action.addEventListener(id === "scanRun" ? "submit" : "click", () => {
        restore(ids);
        note.hidden = true;
      });
    });
  });
  $("scanSkippedClear").addEventListener("click", () => clear(["scanSkippedList"]));
})();
