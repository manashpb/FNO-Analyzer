const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const nodes = new Map(), calls = [], timers = [];
function element(id) {
  if (!nodes.has(id)) nodes.set(id, {value:'', textContent:'', innerHTML:'', disabled:false, handlers:{},
    addEventListener(type, fn) { this.handlers[type]=fn; }});
  return nodes.get(id);
}
vm.runInNewContext(fs.readFileSync('frontend/oi-zscore.js','utf8'), {
  document:{getElementById:element}, fetch:(url,options)=>new Promise(resolve=>calls.push({url,options,resolve})),
  setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout:()=>{}
});
const side=z=>({z,n:3,mean:10,sd:5,reason:z==null?'No data':null,samples:[]});
const row=(symbol,ce,pe)=>({symbol,day:'2026-10-09',expiry:'2026-10-29',atm_strike:100,dte:20,
  periods:{'12':{ce:side(ce),pe:side(pe)},'3':{ce:side(null),pe:side(null)}}});
const rows=[row('<HIGH>',3,1),row('LOW',-4,0),row('MISSING',null,null)];
const state=status=>({status,rows,processed:1,total:3,stored:null});
const finish=(call,body,ok=true)=>call.resolve({ok,json:async()=>body});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
  const updating=element('zUpdate').handlers.click();
  assert.equal(calls[1].options.method,'POST');
  finish(calls[0],state('idle')); await flush();
  assert.equal(element('zUpdate').disabled,true);
  finish(calls[1],state('running')); await updating;
  assert.equal(element('zUpdate').disabled,true);
  assert.match(element('zResults').innerHTML,/&lt;HIGH&gt;/);
  assert.match(element('zResults').innerHTML,/LOW/);
  assert.doesNotMatch(element('zResults').innerHTML,/MISSING/);
  assert.match(element('zAll').innerHTML,/MISSING/);
  element('zSort').value='ce';element('zSort').handlers.change();
  let html=element('zAll').innerHTML;
  assert.ok(html.indexOf('&lt;HIGH&gt;') < html.indexOf('<td>LOW</td>'));
  assert.ok(html.indexOf('<td>LOW</td>') < html.indexOf('<td>MISSING</td>'));
  rows[0].periods['12'].pe.z=-5;
  element('zSort').value='pe';element('zSort').handlers.change();
  html=element('zAll').innerHTML;
  assert.ok(html.indexOf('<td>LOW</td>') < html.indexOf('&lt;HIGH&gt;'));
  assert.ok(html.indexOf('&lt;HIGH&gt;') < html.indexOf('<td>MISSING</td>'));
  element('zSearch').value='  hiGH  ';element('zSearch').handlers.input();
  assert.match(element('zAll').innerHTML,/&lt;HIGH&gt;/);
  assert.doesNotMatch(element('zAll').innerHTML,/<td>LOW<\/td>/);
  assert.doesNotMatch(element('zResults').innerHTML,/<td>LOW<\/td>/);
  element('zSearch').value='nothing';element('zSearch').handlers.input();
  assert.equal(element('zAll').innerHTML,'No stocks to display.');
  element('zSearch').value='';element('zSearch').handlers.input();
  rows[0].periods['12'].pe.z=1;
  element('zPeriod').value='12';element('zSide').value='ce';element('zDirection').value='high';element('zThreshold').value='2';
  element('zRun').handlers.click();
  assert.doesNotMatch(element('zResults').innerHTML,/LOW/);
  element('zDirection').value='low';element('zRun').handlers.click();
  assert.match(element('zResults').innerHTML,/LOW/);
  assert.doesNotMatch(element('zResults').innerHTML,/HIGH/);
  element('zThreshold').value='-1';element('zRun').handlers.click();
  assert.match(element('zStatus').textContent,/finite threshold/);
  element('zPeriod').value='3';element('zThreshold').value='2';element('zRun').handlers.click();
  assert.equal(element('zResults').innerHTML,'No stocks to display.');
  rows.push(row('CE_EDGE',2,0),row('CE_STRONG',4,-2),row('PE_EDGE',0,2),
    row('PE_STRONG',-2,4),row('BOTH_HIGH',5,4),row('GAP_ONLY',1,-9),row('NO_OPPOSITE',5,null));
  element('zPeriod').value='12';element('zSide').value='ce_dominant';
  element('zOpposite').value='0';element('zSort').value='strength';
  element('zSide').handlers.change();
  assert.equal(element('zOppositeControl').hidden,false);
  assert.equal(element('zDirection').disabled,true);
  // Setup edits wait for Run; they do not overwrite applied filters.
  element('zSearch').handlers.input();
  assert.equal(element('zResults').innerHTML,'No stocks to display.');
  element('zRun').handlers.click();
  html=element('zResults').innerHTML;
  assert.match(html,/CE_EDGE/);assert.match(html,/CE_STRONG/);
  assert.ok(html.indexOf('CE_STRONG')<html.indexOf('CE_EDGE'));
  for (const excluded of ['BOTH_HIGH','GAP_ONLY','NO_OPPOSITE','PE_EDGE']) assert.doesNotMatch(html,new RegExp(excluded));
  assert.match(html,/CE − PE/);
  element('zOpposite').value='-1';element('zRun').handlers.click();
  assert.match(element('zResults').innerHTML,/CE_STRONG/);
  assert.doesNotMatch(element('zResults').innerHTML,/CE_EDGE/);
  element('zSide').value='pe_dominant';element('zOpposite').value='0';element('zRun').handlers.click();
  html=element('zResults').innerHTML;
  assert.match(html,/PE_EDGE/);assert.match(html,/PE_STRONG/);
  assert.ok(html.indexOf('PE_STRONG')<html.indexOf('PE_EDGE'));
  assert.doesNotMatch(html,/BOTH_HIGH/);assert.match(html,/PE − CE/);
  element('zOpposite').value='';element('zRun').handlers.click();
  assert.match(element('zStatus').textContent,/finite opposite-side/);
  element('zSide').value='either';element('zSide').handlers.change();
  assert.equal(element('zDirection').disabled,false);
  assert.equal(element('zOppositeControl').hidden,true);
  console.log('Z-score sorting, search, filters, unavailable scores, escaping and late update responses passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
