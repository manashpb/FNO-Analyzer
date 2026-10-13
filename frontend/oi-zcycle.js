/* Local daily ATM Z-score history. Missing observations remain gaps. */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const canvas = $('zCycleCanvas'), ctx = canvas.getContext('2d'), tip = $('zCycleTip');
  let data = null, symbol = '', selected = '', ticket = 0, view = null, geometry = null, drag = null, loading = false;
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const sides = () => [['ce', '#ff3c3c', $('zCycleCE').checked], ['pe', '#28ff5a', $('zCyclePE').checked]].filter(s => s[2]);
  const period = () => $('zCyclePeriod').value;
  const num = value => finite(value) ? value.toFixed(2) : '—';
  function reset() {
    view = data?.dates.length ? {x:0, n:data.dates.length} : null;
    tip.classList.add('hidden'); draw();
  }
  function draw() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w*dpr; canvas.height = h*dpr; ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.fillStyle = '#101620'; ctx.fillRect(0,0,w,h); ctx.font = '12px sans-serif';
    geometry = null;
    if (!data || !view) {
      ctx.fillStyle = '#aab4c4'; ctx.fillText(data?.reason || 'Select a stock to load closing Z-scores', 20, 40); return;
    }
    const l = 65, t = 20, pw = Math.max(1,w-l-20), ph = h-80;
    const byDate = new Map(data.days.map(d => [d.date,d]));
    const values = [0];
    data.dates.forEach((date,i) => {
      if (i+.5 < view.x || i+.5 > view.x+view.n) return;
      for (const [side] of sides()) {
        const z = byDate.get(date)?.periods[period()]?.[side]?.z;
        if (finite(z)) values.push(z);
      }
    });
    let low = Math.min(-3, ...values), high = Math.max(3, ...values);
    const padding = Math.max(.5, (high-low)*.12); low -= padding; high += padding;
    const X = i => l+(i+.5-view.x)/view.n*pw, Y = z => t+ph-(z-low)/(high-low)*ph;
    geometry = {l,t,pw,ph,X,Y};
    ctx.textAlign = 'right';
    for (let k=0;k<=5;k++) {
      const z=low+(high-low)*k/5, y=Y(z);
      ctx.strokeStyle='#273140';ctx.beginPath();ctx.moveTo(l,y);ctx.lineTo(l+pw,y);ctx.stroke();
      ctx.fillStyle='#aab4c4';ctx.fillText(z.toFixed(2),l-8,y+4);
    }
    ctx.save();ctx.beginPath();ctx.rect(l,t,pw,ph);ctx.clip();
    ctx.setLineDash([4,4]);ctx.strokeStyle='#8794a8';ctx.beginPath();ctx.moveTo(l,Y(0));ctx.lineTo(l+pw,Y(0));ctx.stroke();ctx.setLineDash([]);
    ctx.lineWidth=1;ctx.lineCap='round';ctx.setLineDash([1,5]);ctx.strokeStyle='#d6ac62';
    for (const z of [3,-3]) {
      const y=Y(z);
      ctx.beginPath();ctx.moveTo(l,y);ctx.lineTo(l+pw,y);ctx.stroke();
      ctx.fillStyle='#d6ac62';ctx.fillText(z>0 ? '+3' : '−3',l+pw-6,y-5);
    }
    ctx.setLineDash([]);ctx.lineCap='butt';
    for (const [side,color] of sides()) {
      ctx.beginPath(); let connected=false; const points=[];
      data.dates.forEach((date,i) => {
        const z=byDate.get(date)?.periods[period()]?.[side]?.z;
        if (!finite(z)) {connected=false;return;}
        const x=X(i),y=Y(z);
        if (connected) ctx.lineTo(x,y); else ctx.moveTo(x,y);
        connected=true;points.push([x,y]);
      });
      ctx.strokeStyle=color;ctx.lineWidth=2;ctx.stroke();ctx.fillStyle=color;
      for (const [x,y] of points) {ctx.beginPath();ctx.arc(x,y,3,0,Math.PI*2);ctx.fill();}
    }
    ctx.restore();ctx.textAlign='center';ctx.fillStyle='#aab4c4';
    const step=Math.max(1,Math.ceil(view.n/Math.max(1,pw/100)));
    data.dates.forEach((date,i) => {
      if (i+.5>=view.x && i+.5<=view.x+view.n && i%step===0) ctx.fillText(date,X(i),t+ph+24);
    });
    ctx.fillText('Archived trading date (IST)',l+pw/2,h-12);
    if (values.length===1) {ctx.textAlign='left';ctx.fillText('No available scores for the visible dates and enabled sides',l+10,t+25);}
  }
  async function load(name, reload=false) {
    if (!name) return;
    const next = String(name).toUpperCase();
    if (!reload && next===symbol && (loading || data)) return;
    if (next!==symbol) selected='';
    symbol=next;
    const current=++ticket, requested=selected;
    data=null;view=null;loading=true;tip.classList.add('hidden');
    $('zCycleStatus').textContent='Loading archived Z-scores…';draw();
    try {
      const params=new URLSearchParams({ticker:symbol}); if (requested) params.set('expiry',requested);
      const response=await fetch('/api/history/oi/zscore-cycle?'+params);
      const body=await response.json();
      if (current!==ticket) return;
      if (!response.ok) throw new Error(body.error || 'Z-score cycle request failed');
      data=body;selected=body.expiry;
      $('zCycleExpiry').replaceChildren(...body.expiries.map(value => {
        const option=document.createElement('option');option.value=value;option.textContent=value;return option;
      }));
      $('zCycleExpiry').value=selected;
      updateStatus();reset();
    } catch(e) {
      if (current!==ticket) return;
      $('zCycleStatus').textContent=e.message;
      $('zCycleExpiry').replaceChildren();draw();
    } finally {if (current===ticket) loading=false;}
  }
  function updateStatus() {
    if (!data) return;
    const available=data.days.filter(d => sides().some(([side]) => finite(d.periods[period()]?.[side]?.z))).length;
    $('zCycleStatus').textContent=data.reason || `${symbol} · expiry ${data.expiry} · ${period()}M baseline · ${available}/${data.dates.length} dates with scores · closing history only`;
  }
  $('zCycleExpiry').addEventListener('change',()=>{selected=$('zCycleExpiry').value;load(symbol,true);});
  for (const id of ['zCyclePeriod','zCycleCE','zCyclePE']) $(id).addEventListener('change',()=>{tip.classList.add('hidden');updateStatus();draw();});
  $('zCycleReload').addEventListener('click',()=>load(symbol,true));
  $('zCycleReset').addEventListener('click',reset);canvas.ondblclick=reset;
  canvas.addEventListener('wheel',e=>{
    if (!view || !geometry) return;e.preventDefault();
    const r=canvas.getBoundingClientRect(), f=Math.max(0,Math.min(1,(e.clientX-r.left-geometry.l)/geometry.pw));
    const n=Math.max(1,Math.min(data.dates.length,view.n*(e.deltaY>0?1.2:1/1.2)));
    view.x=Math.max(0,Math.min(data.dates.length-n,view.x+f*(view.n-n)));view.n=n;
    tip.classList.add('hidden');draw();
  },{passive:false});
  canvas.onpointerdown=e=>{if (!view || !geometry) return;drag={x:e.clientX,view:{...view}};canvas.setPointerCapture(e.pointerId);tip.classList.add('hidden');};
  canvas.onpointermove=e=>{
    if (!view || !geometry) return;
    if (drag) {view.x=Math.max(0,Math.min(data.dates.length-view.n,drag.view.x-(e.clientX-drag.x)/geometry.pw*view.n));draw();return;}
    const r=canvas.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;
    if (x<geometry.l || x>geometry.l+geometry.pw || y<geometry.t || y>geometry.t+geometry.ph) {tip.classList.add('hidden');return;}
    const i=Math.max(0,Math.min(data.dates.length-1,Math.round(view.x+(x-geometry.l)/geometry.pw*view.n-.5)));
    const date=data.dates[i],day=data.days.find(d=>d.date===date);
    tip.textContent = `${date} · ATM ${day?.atm ?? '—'} · DTE ${day?.dte ?? '—'} · spot ${num(day?.spot)}\n` + sides().map(([side])=>{
      const s=day?.periods[period()]?.[side];
      return `${side.toUpperCase()} Z ${num(s?.z)} · OI ${num(s?.oi)} · n ${s?.n ?? 0} · mean ${num(s?.mean)} · SD ${num(s?.sd)}${s?.reason ? ' · '+s.reason : ''}\nSamples: ${s?.samples.map(v=>`${v.day} (DTE ${v.dte}${v.fallback ? ', earlier observation' : ''})`).join(', ') || 'none'}`;
    }).join('\n');
    tip.classList.remove('hidden');tip.style.whiteSpace='pre-wrap';tip.style.maxWidth='420px';
    tip.style.left=Math.max(0,Math.min(x+12,r.width-430))+'px';tip.style.top=Math.max(0,y-60)+'px';
  };
  canvas.onpointerup=canvas.onpointercancel=()=>{drag=null;};canvas.onpointerleave=()=>tip.classList.add('hidden');
  new ResizeObserver(draw).observe(canvas);
  window.oiZCycle={load};
})();
