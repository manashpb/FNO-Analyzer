const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const nodes = new Map(), calls = [], timers = [], mounts = [];
const element = id => {
  if (!nodes.has(id)) nodes.set(id, {value:'', innerHTML:'', textContent:'', handlers:{}, addEventListener(type, fn) {this.handlers[type] = fn;}});
  return nodes.get(id);
};
vm.runInNewContext(fs.readFileSync('frontend/oi-zscore.js','utf8'), {
  document:{getElementById:element}, fetch:()=>new Promise(resolve=>calls.push(resolve)),
  setTimeout:fn=>timers.push(fn), clearTimeout:()=>{}, watchlists:{mount:(...args)=>mounts.push(args)}
});
const score = {z:3,n:3,mean:10,sd:1,samples:[]};
const state = status => ({status,processed:1,total:2,rows:[{symbol:'SAVED_STOCK',periods:{'12':{ce:score,pe:score}}}]});
const finish = async status => {calls.shift()({ok:true,json:async()=>state(status)}); await new Promise(resolve=>setImmediate(resolve));};
(async()=>{
  await finish('running');
  assert.equal(element('zResults').innerHTML,'');
  assert.equal(element('zAll').innerHTML,'');
  element('zSort').handlers.change(); element('zSearch').handlers.input();
  assert.equal(element('zAll').innerHTML,'');
  timers.shift()(); await finish('complete');
  assert.equal(element('zResults').innerHTML,'');
  assert.equal(mounts.length,0);
  element('zThreshold').value='-1';element('zRun').handlers.click();
  assert.equal(element('zAll').innerHTML,'');
  element('zPeriod').value='12';element('zSide').value='either';element('zDirection').value='absolute';element('zThreshold').value='2';
  element('zRun').handlers.click();
  assert.match(element('zResults').innerHTML,/SAVED_STOCK/);
  assert.match(element('zAll').innerHTML,/SAVED_STOCK/);
  assert.equal(mounts.length,2);
  console.log('Z-score startup and polling hide stocks until a valid Run scan');
})().catch(error=>{console.error(error);process.exitCode=1;});
