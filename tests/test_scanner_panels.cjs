const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function node() {
  return {hidden: false, attrs: {}, handlers: {}, children: [],
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
    appendChild(n) { this.children.push(n); },
    addEventListener(k, fn) { (this.handlers[k] ||= []).push(fn); },
    fire(k) { (this.handlers[k] || []).forEach(fn => fn()); }};
}
const nodes = new Map();
const get = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
const panels = [
  ['zResults zAll', 'zRun zUpdate'], ['oiCoverage oiStocks', 'oiUpdate'],
  ['scanHighResults scanLowResults scanSkippedList', 'scanRun'],
  ['scanHighResults', 'scanRun'], ['scanLowResults', 'scanRun']
].map(([clearTargets, resultActions]) => {
  const p = node(); p.dataset = {clearTargets, resultActions};
  const children = {'.scanner-panel-body': node(), '.scanner-collapse': node(), '.scanner-clear': node()};
  p.querySelector = key => key === '.scanner-clear-note' ? children['.scanner-panel-body'].children[0] : children[key];
  return p;
});
vm.runInNewContext(fs.readFileSync('frontend/scanner-panels.js', 'utf8'), {
  document: {getElementById: get, querySelectorAll: () => panels, createElement: node}
});
const high = panels[3], low = panels[4];
high.querySelector('.scanner-collapse').fire('click');
assert.equal(high.querySelector('.scanner-panel-body').hidden, true);
assert.equal(high.querySelector('.scanner-collapse').attrs['aria-expanded'], 'false');
assert.equal(low.querySelector('.scanner-panel-body').hidden, false);
high.querySelector('.scanner-clear').fire('click');
assert.equal(get('scanHighResults').attrs['data-results-cleared'], '');
assert.equal(get('scanLowResults').attrs['data-results-cleared'], undefined);
// A later render can replace content without undoing the clear.
get('scanHighResults').innerHTML = '<table>new partial results</table>';
assert.equal(get('scanHighResults').attrs['data-results-cleared'], '');
get('scannerForm').fire('submit');
assert.equal(get('scanHighResults').attrs['data-results-cleared'], undefined);
assert.equal(high.querySelector('.scanner-panel-body').hidden, true);
panels[0].querySelector('.scanner-clear').fire('click');
assert.equal(get('zAll').attrs['data-results-cleared'], '');
get('oiUpdate').fire('click');
assert.equal(get('zAll').attrs['data-results-cleared'], '');
get('zRun').fire('click');
assert.equal(get('zAll').attrs['data-results-cleared'], undefined);
get('scanSkippedClear').fire('click');
assert.equal(get('scanSkippedList').attrs['data-results-cleared'], '');
console.log('Scanner panels: independent collapse/clear, polling preservation and action restore passed');
