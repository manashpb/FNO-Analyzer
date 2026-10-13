const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('frontend/scanners.js', 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const state = overrides => ({id:'scan', status:'complete', high_cutoff:70, low_cutoff:30,
  days:5, smoothing:3, falling:true, rising:true, high:[], low:[], skipped:[],
  checked:0, candidates:0, total_stocks:0, ...overrides});

function harness() {
  const elements = {};
  const get = id => elements[id] ||= {value:'', checked:true, disabled:false,
    listeners:{}, addEventListener(event, handler) {this.listeners[event] = handler;},
    querySelectorAll() {return Object.values(elements).filter(el => 'value' in el);}};
  get('scanHigh').value = '70'; get('scanLow').value = '30';
  get('scanDays').value = '5'; get('scanSmooth').value = '3';
  let resolveInitial;
  let reply = state({falling:false, rising:false});
  let submitted;
  vm.runInNewContext(source, {
    document:{getElementById:get}, URLSearchParams, setTimeout:()=>1, clearTimeout:()=>{},
    fetch:(url, options) => {
      if (options.method === 'POST') {
        submitted = url;
        return Promise.resolve({ok:true, json:async()=>reply});
      }
      return new Promise(resolve => {resolveInitial = body => resolve({ok:true,json:async()=>body});});
    },
  });
  return {get, resolveInitial:body=>resolveInitial(body), setReply:body=>{reply=body;},
    submit:()=>get('scannerForm').listeners.submit({preventDefault(){}}),
    submitted:()=>submitted};
}

(async () => {
  const late = harness();
  late.get('scanFalling').checked = false;
  late.get('scannerForm').listeners.input();
  late.resolveInitial(state());
  await flush();
  assert.equal(late.get('scanFalling').checked, false, 'late restored scan must not overwrite edits');
  assert.equal(late.get('scanHigh').value, '70');

  const old = harness();
  old.resolveInitial(state({falling:undefined,rising:undefined}));
  await flush();
  old.get('scanFalling').checked = false;
  old.get('scanRising').checked = false;
  old.setReply(state({falling:undefined,rising:undefined}));
  await old.submit();
  assert.equal(old.get('scanFalling').checked, false, 'legacy backend must not re-enable toggle');
  assert.match(old.get('scanStatus').textContent, /Restart the application/);

  const current = harness();
  current.resolveInitial({status:'idle'});
  await flush();
  current.get('scanFalling').checked = false;
  current.get('scanRising').checked = false;
  await current.submit();
  assert.match(current.submitted(), /falling=false&rising=false/);
  assert.equal(current.get('scanFalling').checked, false);
  assert.match(current.get('scanHighTitle').textContent, /High IVP > 70 · IVP only/);
  console.log('Scanner controls: late responses, old backend, and disabled direction filters passed');
})().catch(error => {console.error(error); process.exitCode=1;});
