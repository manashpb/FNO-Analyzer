const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const nodes = new Map();
function node(id) {
  if (!nodes.has(id)) {
    const classes = new Set();
    nodes.set(id, {classes, handlers:{}, attrs:{}, textContent:'Collapse',
      classList:{toggle(name){if(classes.has(name)){classes.delete(name);return false;}classes.add(name);return true;}},
      setAttribute(name,value){this.attrs[name]=value;}, addEventListener(name,fn){this.handlers[name]=fn;}});
  }
  return nodes.get(id);
}
vm.runInNewContext(fs.readFileSync('frontend/chain-panels.js','utf8'), {document:{getElementById:node}});
for (const prefix of ['chain','oiHeat','zCycle']) {
  node(prefix+'Toggle').handlers.click();
  assert.equal(node(prefix+'Body').classes.has('hidden'), true);
  assert.equal(node(prefix+'Toggle').attrs['aria-expanded'], 'false');
  assert.equal(node(prefix+'Toggle').textContent, 'Expand');
}
node('oiHeatToggle').handlers.click();
assert.equal(node('oiHeatBody').classes.has('hidden'), false);
assert.equal(node('chainBody').classes.has('hidden'), true);
assert.equal(node('zCycleBody').classes.has('hidden'), true);
assert.equal(node('oiHeatToggle').attrs['aria-expanded'], 'true');
console.log('Option chain and expiry-cycle panels collapse independently');
