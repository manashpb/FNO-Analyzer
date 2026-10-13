const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const spreads = require('../frontend/spreads.js');
const rows = [
  {sp:1000,cBid:100,cAsk:101,pBid:50,pAsk:51},
  {sp:1050,cBid:81,cAsk:82,pBid:84,pAsk:85},
  {sp:1125,cBid:60,cAsk:61,pBid:110,pAsk:111}
];
const pair = spreads.build([...rows].reverse(), 1)[0];
assert.deepEqual(pair.call, {bid:18,ask:20,mid:19});
assert.deepEqual(pair.put, {bid:33,ask:35,mid:34});
assert.equal(pair.callOpp, 17);
assert.equal(pair.putOpp, 32);
assert.equal(spreads.oppClass(17,20), 'spread-opp opp-lower');
assert.equal(spreads.oppClass(32,30), 'spread-opp opp-higher');
assert.equal(spreads.oppClass(20,20), 'spread-opp');
assert.equal(spreads.oppClass(null,20), 'spread-opp');
assert.equal(spreads.interpretation(pair.bullish,true,50), 'Put credit better by ₹150.00 / lot');
assert.match(spreads.interpretation(pair.bullish,true,0), /Lot size unavailable/);
assert.equal(pair.bullish.text, 'Put credit better by 3.00 pts');
assert.equal(pair.bearish.text, 'Call credit better by 3.00 pts');
assert.equal(spreads.build(rows, 2)[0].width, 125, 'actual irregular strike width');
assert.equal(spreads.build(rows, 4).length, 0);
for (const bad of [null, 0, NaN, Infinity, -1]) {
  const missing = spreads.build([{...rows[0], cBid:bad}, rows[1]], 1)[0];
  assert.equal(missing.call.mid, null);
  assert.equal(missing.bullish.text, 'Quotes unavailable');
  assert.equal(missing.put.mid, 34, 'other side remains usable');
}
assert.equal(spreads.build([{...rows[0],cBid:102}, rows[1]], 1)[0].call.mid, null);
const equal = spreads.build([rows[0], {...rows[1],pBid:81,pAsk:82}],1)[0];
assert.equal(equal.bullish.text, 'Similar quoted cost');
const cheaperCall = spreads.build([rows[0], {...rows[1],pBid:80,pAsk:81}],1)[0];
assert.match(cheaperCall.bullish.text, /Call debit better/);
assert.match(cheaperCall.bearish.text, /Put debit better/);

// Exercise real chain rendering without initiating the application or provider calls.
let source = fs.readFileSync('frontend/app.js','utf8');
source = source.replace(/  init\(\);/, '  globalThis.chainTest = {set:(s,mode,width,count)=>{state=s;spreadMode=mode;spreadWidth=width;chainCount=count;},render:renderChain};');
const elements = {};
const context = {window:{VerticalSpreads:spreads,addEventListener(){}},document:{getElementById:id=>elements[id] ||= {classList:{toggle(){}},innerHTML:'',textContent:''}},console};
vm.runInNewContext(source, context);
context.chainTest.set({strikes:rows,metrics:{atm_strike:1050,spot:1050},ticker:{Lot:10}},true,1,1);
context.chainTest.render({atm_strike:1050,spot:1050});
assert.match(elements.chainTable.innerHTML, /1050 \/ 1125/);
assert.match(elements.chainTable.innerHTML, /ATM leg/);
assert.match(elements.chainTable.innerHTML, /Bullish interpretation/);
assert.doesNotMatch(elements.chainTable.innerHTML, /<th>Mid<\/th>/);
assert.match(elements.chainTable.innerHTML, /compare with Put Ask">Opp<\/th><th>Bid<\/th><th>Ask<\/th>/);
assert.match(elements.chainTable.innerHTML, /class="spread-opp opp-higher">50\.00<\/td>/);
assert.match(elements.chainTable.innerHTML, /class="spread-opp opp-higher">55\.00<\/td>/);
assert.match(elements.chainHint.textContent, /1\/2 pairs/);
context.chainTest.set({strikes:rows,ticker:{Lot:10}},false,1,20);
context.chainTest.render({atm_strike:1050,spot:1050});
assert.match(elements.chainTable.innerHTML, /OI Chg/);
assert.doesNotMatch(elements.chainTable.innerHTML, /Bullish interpretation/);
console.log('Spread pricing, invalid quotes, irregular widths, comparisons, ATM window and default rendering passed');
