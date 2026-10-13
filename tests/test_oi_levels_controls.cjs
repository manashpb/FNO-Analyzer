const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const nodes = new Map(), calls = [], mounts = [];
function element(id) {
  if (!nodes.has(id)) nodes.set(id, {value:'0', checked:true, handlers:{}, disabled:false,
    checkValidity(){return this.value !== '-1';},
    addEventListener(type, fn){this.handlers[type] = fn;}});
  return nodes.get(id);
}
element('olDirection').value = 'bullish';
element('olDistance').value = '2'; element('olGap').value = '2'; element('olSecond').value = '50';
vm.runInNewContext(fs.readFileSync('frontend/oi-levels.js', 'utf8'), {
  document:{getElementById:element}, URLSearchParams,
  fetch:(url, options)=>new Promise(resolve=>calls.push({url,options,resolve})),
  watchlists:{mount:(...args)=>mounts.push(args)}
});
(async()=>{
  element('olSecondOn').checked = false; element('olSecondOn').handlers.change();
  assert.equal(element('olDays').disabled, true);
  assert.equal(element('olSecond').disabled, true);
  const running = element('olRun').handlers.click();
  assert.equal(calls[0].options.method, 'POST');
  assert.match(calls[0].url, /second=off/);
  assert.match(calls[0].url, /days=0/);
  await element('olRun').handlers.click(); assert.equal(calls.length, 1);
  element('olDirection').value = 'bearish';
  calls[0].resolve({ok:true,json:async()=>({id:'scan1', total:2, as_of:'2025-01-03',
    settings:{direction:'bullish',distance:2,gap:2,second:null,days:0},
    rows:[{symbol:'<TEST>',day:'2025-01-03',expiry:'2025-01-30',close:101,
      call_strike:115,put_strike:100,distance:1,gap:3,second_strike:105,second_pct:20,history:[]}],
    excluded:[{symbol:'BAD',reason:'Missing <history>'}]})});
  await running;
  assert.match(element('olStatus').textContent, /^bullish/);
  assert.equal(element('olDirection').value, 'bearish');
  assert.match(element('olResults').innerHTML, /&lt;TEST&gt;/);
  assert.match(element('olExcluded').innerHTML, /&lt;history&gt;/);
  assert.equal(mounts[0][0], 'olResults'); assert.equal(mounts[0][2], 'scan1');
  element('olDistance').value = '-1'; await element('olRun').handlers.click();
  assert.equal(calls.length, 1); assert.match(element('olStatus').textContent, /valid value/);
  console.log('OI levels controls: optional filters, defaults, pending requests, applied settings and watchlist export passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
