const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const nodes=new Map(), calls=[], strokes=[], fills=[];
const ctx = new Proxy({stroke(){strokes.push({color:this.strokeStyle,path:[...this.path]});},
  beginPath(){this.path=[];},moveTo(x,y){this.path.push(['move',x,y]);},lineTo(x,y){this.path.push(['line',x,y]);},
  fillText(text){fills.push(text);}}, {get(target,key){return target[key] || (()=>{});}});
function element(id){
  if (!nodes.has(id)) {
    const classes=new Set();
    nodes.set(id,{value:'12',checked:true,style:{},handlers:{},clientWidth:900,clientHeight:360,
      classList:{add:c=>classes.add(c),remove:c=>classes.delete(c)},
      addEventListener:(type,fn)=>element(id).handlers[type]=fn,
      getContext:()=>ctx,setPointerCapture:()=>{},getBoundingClientRect:()=>({left:0,top:0,width:900}),
      replaceChildren(...children){this.children=children;}});
  }
  return nodes.get(id);
}
const sandbox={document:{getElementById:element,createElement:()=>({})},window:{},URLSearchParams,
  ResizeObserver:class{observe(){}},fetch:url=>new Promise(resolve=>calls.push({url,resolve}))};
vm.runInNewContext(fs.readFileSync('frontend/oi-zcycle.js','utf8'),sandbox);
const side=z=>({z,n:3,oi:40,mean:20,sd:10,reason:z===null?'Missing OI':null,samples:[]});
const day=(date,z)=>({date,atm:100,spot:101,dte:5,periods:{'12':{ce:side(z),pe:side(z)}}});
const body={expiries:['2026-09-24','2026-10-29'],expiry:'2026-10-29',previous_expiry:'2026-09-24',
  dates:['2026-10-01','2026-10-02','2026-10-05'], days:[day('2026-10-01',-2),day('2026-10-05',3)]};
const finish=(call,data)=>call.resolve({ok:true,json:async()=>data});
(async()=>{
  const old=sandbox.window.oiZCycle.load('OLD');
  const latest=sandbox.window.oiZCycle.load('NEW');
  finish(calls[1],body);await latest;
  const status=element('zCycleStatus').textContent;
  assert.match(status,/NEW.*2\/3/);
  finish(calls[0],{...body,expiry:'2026-09-24'});await old;
  assert.equal(element('zCycleStatus').textContent,status);
  await sandbox.window.oiZCycle.load('NEW');assert.equal(calls.length,2);
  const ce=strokes.find(s=>s.color==='#ff3c3c');
  assert.equal(ce.path.filter(p=>p[0]==='move').length,2);
  assert.equal(ce.path.filter(p=>p[0]==='line').length,0); // Blank day breaks the line.
  assert.ok(fills.some(text=>/^-[0-9]/.test(text))); // Signed Z-axis includes negatives.
  element('zCycleCanvas').onpointermove({clientX:65+815/2,clientY:100});
  assert.match(element('zCycleTip').textContent,/2026-10-02.*ATM —/);
  assert.match(element('zCycleTip').textContent,/CE Z —/);
  element('zCycleCE').checked=false;element('zCycleCE').handlers.change();
  assert.equal(element('zCycleCE').checked,false);
  element('zCycleExpiry').value='2026-09-24';element('zCycleExpiry').handlers.change();
  assert.match(calls[2].url,/expiry=2026-09-24/);
  finish(calls[2],{...body,expiry:'2026-09-24'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(element('zCycleCE').checked,false);
  console.log('Z-score cycle: signed scores, missing-day gaps, stale replies, refresh caching, hover and controls passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
