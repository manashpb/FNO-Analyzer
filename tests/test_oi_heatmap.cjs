const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
let path=[];
const textColors=[],fills=[],labels=[],rects=[],ticks=[],strokes=[],ctx=new Proxy({beginPath:()=>{path=[]},moveTo:(x,y)=>path.push(['move',x,y]),lineTo:(x,y)=>path.push(['line',x,y]),measureText:t=>({width:t.length*6}),fillText:(t,x)=>{textColors.push({text:t,color:ctx.fillStyle});labels.push(t);if(x===5)ticks.push(t)},stroke:()=>strokes.push({width:ctx.lineWidth,color:ctx.strokeStyle,path:path.slice()}),fillRect:(...a)=> {rects.push(a);fills.push(ctx.fillStyle)}},{get:(o,k)=>o[k]||(()=>{})}),nodes=new Map();
function node(id){if(!nodes.has(id))nodes.set(id,{value:id==='oiHeatMode'?'ce':'',clientWidth:900,clientHeight:480,classList:{add(){},toggle(){}},style:{},getContext:()=>ctx,replaceChildren(){},addEventListener(k,v){this[k]=v},getBoundingClientRect:()=>({left:0,top:0,width:900}),setPointerCapture(){}});return nodes.get(id)}
const fixture={expiry:'2026-10-29',previous_expiry:'2026-09-29',expiries:['2026-10-29'],dates:['2026-10-01','2026-10-02'],strikes:[100,110],days:[{date:'2026-10-01',spot:105,atm:100,cells:[[100,0,12],[110,9,null]]},{date:'2026-10-02',spot:109,atm:110,cells:[[100,null,20],[110,30,4]]}]};
const sandbox={document:{getElementById:node,createElement:()=>({})},window:{devicePixelRatio:1},ResizeObserver:class{observe(){}},fetch:async()=>({ok:true,json:async()=>fixture}),URLSearchParams};
const html=fs.readFileSync('frontend/index.html','utf8');assert(/id="oiHeatTop" checked/.test(html));assert(/id="oiHeatLabels" checked/.test(html));
vm.runInNewContext(fs.readFileSync('frontend/oi-heatmap.js','utf8'),sandbox);
(async()=>{await sandbox.window.oiHeatmap.load('TEST');assert(labels.includes('Visible min 0 lots'));assert.deepEqual(ticks,['100','110']);
assert(!strokes.some(s=>s.color==='rgba(190,201,217,.22)'));
strokes.length=0;node('oiHeatGrid').checked=true;node('oiHeatGrid').onchange();
const grid=strokes.find(s=>s.color==='rgba(190,201,217,.22)');assert(grid);
assert.deepEqual(grid.path,[['move',475.5,20],['line',475.5,390],['move',76,297.5],['line',875,297.5],['move',76,112.5],['line',875,112.5]]);
assert(strokes.some(s=>JSON.stringify(s.path)===JSON.stringify([['move',475.5,390],['line',475.5,395]])));
strokes.length=0;node('oiHeatGrid').checked=false;node('oiHeatGrid').onchange();assert(!strokes.some(s=>s.color==='rgba(190,201,217,.22)'));
assert(strokes.some(s=>s.width===7&&s.color==='#05080d'));assert(strokes.some(s=>s.width===3&&s.color==='#ffffff'));assert(labels.includes('Visible max 30 lots'));node('oiHeatMode').value='pe';node('oiHeatMode').onchange();assert(labels.includes('Visible min 4 lots'));assert(labels.includes('Visible max 20 lots'));node('oiHeatMode').value='difference';labels.length=0;rects.length=0;node('oiHeatMode').onchange();assert(labels.includes('Visible min -12 lots'));assert(labels.includes('Visible max 26 lots'));assert.equal(rects.filter(r=>r[2]>1&&r[3]>10).length,3);node('oiHeatCanvas').onpointermove({clientX:250,clientY:280});assert(node('oiHeatTip').textContent.includes('CE − PE OI -12 lots'));node('oiHeatCanvas').wheel({clientX:850,clientY:220,deltaY:-1,shiftKey:true,preventDefault(){}});node('oiHeatCanvas').ondblclick();assert(rects.every(a=>a.every(Number.isFinite)));sandbox.fetch=async()=>({ok:false,json:async()=>({error:'Route not found'})});await sandbox.window.oiHeatmap.load('TEST',true);assert(node('oiHeatStatus').textContent.includes('Route not found'));assert(labels.some(t=>t.includes('Route not found')));sandbox.fetch=async()=>({ok:true,json:async()=>fixture});await sandbox.window.oiHeatmap.load('TEST');assert.equal(node('oiHeatStatus').textContent.includes('Route not found'),false);fixture.strikes=[80,90,100,110,120,130,140];fixture.days[1].cells.push([140,9999,9999]);node('oiHeatMode').value='ce';await sandbox.window.oiHeatmap.load('TEST',true);node('oiHeatStrikes').value='1';labels.length=0;node('oiHeatStrikes').onchange();assert(labels.includes('Visible max 30 lots'));assert(!labels.includes('Visible max 9,999 lots'));node('oiHeatStrikes').value='80';labels.length=0;node('oiHeatStrikes').onchange();assert(labels.includes('Visible max 9,999 lots'));node('oiHeatStrikes').value='1000';node('oiHeatStrikes').onchange();assert.equal(node('oiHeatStrikes').value,'80');node('oiHeatStrikes').value='1';node('oiHeatStrikes').onchange();labels.length=0;node('oiHeatCanvas').ondblclick();assert(labels.includes('Visible max 30 lots'));assert(ticks.every(t=>fixture.strikes.includes(Number(t.replaceAll(',','')))));fixture.strikes=[100,110,120,130];fixture.days=[{date:fixture.dates[0],spot:115,atm:110,cells:[[130,100,10],[110,80,40],[100,80,80],[120,20,null]]}];
node('oiHeatStrikes').value='80';await sandbox.window.oiHeatmap.load('TEST',true);
node('oiHeatTop').checked=true;labels.length=0;rects.length=0;node('oiHeatTop').onchange();
assert.equal(node('oiHeatMode').disabled,true);assert.equal(node('oiHeatLabels').disabled,false);
assert.equal(rects.filter(r=>r[2]>1&&r[3]>10).length,3); // background plus two full-width maximum cells
assert(rects.filter(r=>r[2]>1&&r[3]>10).slice(1).every(r=>r[2]===799/2));
assert(!labels.some(t=>t.startsWith('Visible max')));
node('oiHeatLabels').checked=true;labels.length=0;node('oiHeatLabels').onchange();
assert(labels.includes('CE 100 lots'));assert(textColors.some(c=>c.text==='CE 100 lots'&&c.color==='#ffffff'));assert(textColors.some(c=>c.text==='PE 80 lots'&&c.color==='#ffffff'));assert(labels.includes('PE3 12.5%'));assert(labels.includes('CE2 80%'));assert(labels.includes('CE3 80%'));assert(labels.includes('PE 80 lots'));assert(labels.includes('PE2 50%'));assert(textColors.some(c=>c.text==='CE2 80%'&&c.color==='rgba(255,60,60,0.8)'));assert(textColors.some(c=>c.text==='PE2 50%'&&c.color==='rgba(40,255,90,0.5)'));
assert(!labels.some(t=>t.includes('CE 20%')));
node('oiHeatStrikes').value='1';labels.length=0;node('oiHeatStrikes').onchange();
assert(!labels.some(t=>t.includes('100 lots')));assert(labels.includes('CE2 80%'));assert(labels.includes('CE3 80%'));assert(labels.includes('PE 80 lots'));assert(labels.includes('PE2 50%')); // ranking stays global when maximum is offscreen
node('oiHeatStrikes').value='80';node('oiHeatStrikes').onchange();
fixture.days[0].cells=[[100,100,200],[110,50,100],[120,20,50],[130,null,null]];
labels.length=0;fills.length=0;await sandbox.window.oiHeatmap.load('TEST',true);
assert.equal(fills.filter(c=>c==='#ffff00').length,1);assert(labels.includes('PCR 2.00'));assert(labels.includes('CE 100 lots'));assert(labels.includes('PE 200 lots'));assert(labels.includes('CE2 50%'));assert(labels.includes('PE2 50%'));assert(labels.includes('CE3 20%'));assert(labels.includes('PE3 25%'));
node('oiHeatCanvas').onpointermove({clientX:150,clientY:300});
assert(node('oiHeatTip').textContent.includes('PCR (highest PE / highest CE): 2.00'));assert(node('oiHeatTip').textContent.includes('CE #1 OI 100 lots / PE #1 OI 200 lots'));
fixture.days[0].cells=[[100,0,200],[110,null,100]];
labels.length=0;await sandbox.window.oiHeatmap.load('TEST',true);assert(labels.includes('PCR \u2014'));
fixture.days[0].cells=[[100,100,null],[110,50,null]];
labels.length=0;await sandbox.window.oiHeatmap.load('TEST',true);assert(labels.includes('PCR \u2014'));
node('oiHeatTop').checked=false;node('oiHeatTop').onchange();assert.equal(node('oiHeatMode').disabled,false);
console.log('Heatmap strike ticks, outlined spot line, modes, errors, strike window, count bounds, colour rescaling and reset passed')})().catch(e=>{console.error(e);process.exitCode=1});
