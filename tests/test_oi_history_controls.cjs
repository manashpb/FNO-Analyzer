const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const nodes = new Map();
function element(id) {
  if (!nodes.has(id)) nodes.set(id, { disabled: false, textContent: "", innerHTML: "", handlers: {},
    addEventListener(type, fn) { this.handlers[type] = fn; }, appendChild() {} });
  return nodes.get(id);
}
const calls = [];
const timers = [];
const context = {
  document: { getElementById: element, createElement: () => ({ textContent: "" }) },
  fetch: (url, options) => new Promise(resolve => calls.push({ url, options, resolve })),
  setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
};
vm.runInNewContext(fs.readFileSync("frontend/oi-history.js", "utf8"), context);
const state = (status, extra = {}) => ({ status, id: "test-job", phase: "daily snapshots",
  archive: { chains: 1, coverage: [{ symbol: "<TEST>", first_date: "2026-10-02", last_date: "2026-10-02", snapshots: 1 }] },
  request_interval_seconds: 2, ...extra });
const finish = (call, body, ok = true) => call.resolve({ ok, json: async () => body });
const flush = () => new Promise(resolve => setImmediate(resolve));

(async () => {
  // A delayed reload status must not overwrite a newly started job.
  const starting = element("oiUpdate").handlers.click();
  assert.equal(calls[1].options.method, "POST");
  finish(calls[0], state("idle"));
  await flush();
  assert.equal(element("oiUpdate").disabled, true);
  finish(calls[1], state("running"));
  await starting;
  assert.equal(element("oiUpdate").disabled, true);
  assert.equal(element("oiCancel").disabled, false);
  assert.match(element("oiStocks").innerHTML, /&lt;TEST&gt;/);
  element("oiCancel").handlers.click();
  assert.match(calls[2].url, /cancel\?id=test-job/);
  finish(calls[2], state("cancelled"));
  await flush();
  assert.equal(element("oiUpdate").disabled, false);
  assert.equal(element("oiCancel").disabled, true);
  const failing = element("oiUpdate").handlers.click();
  finish(calls[3], { error: "Rate-limit cooldown" }, false);
  await failing;
  assert.equal(element("oiStatus").textContent, "Rate-limit cooldown");
  assert.equal(element("oiUpdate").disabled, false);
  console.log("OI archive controls: stale responses, cancellation, escaping and request errors passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
