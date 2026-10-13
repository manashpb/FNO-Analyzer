/* Archived expiry-cycle heatmap. Numeric cells remain absent when unobserved. */
(() => {
  const el = id => document.getElementById(id), canvas = el('oiHeatCanvas'), ctx = canvas.getContext('2d');
  let data = null, symbol = '', ticket = 0, view, drag, geometry, cells = [], selected = '', message = '', loading = false;
  const mode = el('oiHeatMode'), expiry = el('oiHeatExpiry'), status = el('oiHeatStatus'), tip = el('oiHeatTip');
  const topView = el('oiHeatTop'), labels = el('oiHeatLabels'), grid = el('oiHeatGrid');
  const valid = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const color = t => `hsl(${240 * (1 - t)},100%,50%)`;
  function parts(row) {
    if (mode.value === 'ce') return [['CE', row[1], 0, 1]];
    if (mode.value === 'pe') return [['PE', row[2], 0, 1]];
    return valid(row[1]) && valid(row[2]) ? [['CE − PE', row[1] - row[2], 0, 1]] : [];
  }
  function ranked(day) {
    const result = new Map();
    for (const [side, column, offset] of [['CE', 1, 0], ['PE', 2, 0]]) {
      const rows = day.cells.filter(row => valid(row[column])).slice()
        .sort((a, b) => b[column] - a[column] || a[0] - b[0]).slice(0, 3);
      rows.forEach((row, index) => {
        const entries = result.get(row[0]) || [];
        entries.push([side, row[column], offset, 1, index + 1,
          rows[0][column] > 0 ? row[column] / rows[0][column] : null]);
        result.set(row[0], entries);
      });
    }
    const maxima = [...result.entries()].flatMap(([strike, entries]) =>
      entries.filter(entry => entry[4] === 1).map(entry => ({strike, side:entry[0], value:entry[1]})));
    const ce = maxima.find(entry => entry.side === 'CE'), pe = maxima.find(entry => entry.side === 'PE');
    result.sharedStrike = ce && pe && ce.strike === pe.strike ? ce.strike : null;
    result.pcr = ce && pe && ce.value > 0 && Number.isFinite(pe.value / ce.value) ? pe.value / ce.value : null;
    return result;
  }
  function strikeWindow() {
    const input = el('oiHeatStrikes');
    const count = Math.min(80, Math.max(1, Math.round(Number(input.value) || 8)));
    input.value = String(count);
    const s = data.strikes;
    const latest = data.days.at(-1);
    const target = latest?.atm ?? latest?.spot ?? s[Math.floor(s.length / 2)];
    let atm = 0;
    s.forEach((value, i) => {if (Math.abs(value - target) < Math.abs(s[atm] - target)) atm = i;});
    const first = Math.max(0, atm - count), last = Math.min(s.length - 1, atm + count);
    const fallback = s.length > 1 ? s[1] - s[0] : Math.max(s[0] * .01, 1);
    const low = first ? (s[first - 1] + s[first]) / 2 : s[first] - fallback / 2;
    const high = last < s.length - 1 ? (s[last] + s[last + 1]) / 2 : s[last] + (last ? s[last] - s[last - 1] : fallback) / 2;
    return {y: low, h: high - low};
  }
  function reset() {
    if (!data || !data.strikes.length) return draw();
    view = {x:0,n:data.dates.length,...strikeWindow()};
    draw();
  }
  function draw() {
    const w = canvas.clientWidth, h = canvas.clientHeight, dpr = window.devicePixelRatio || 1;
    canvas.width = w*dpr; canvas.height = h*dpr; ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.fillStyle = '#101620'; ctx.fillRect(0,0,w,h); ctx.font='13px sans-serif'; cells=[];
    if (!data || !view || !data.strikes.length || !data.dates.length) {ctx.fillStyle='#aab4c4';ctx.fillText(message || data?.reason || 'Select a stock to load archived OI',20,40);return;}
    const l=76,t=20,pw=Math.max(1,w-l-25),ph=h-110;
    const X=i => l+(i-view.x)/view.n*pw, Y=v => t+ph-(v-view.y)/view.h*ph;
    geometry={l,t,pw,ph,X,Y};
    const dates=new Map(data.dates.map((v,i)=>[v,i])), strikes=data.strikes, visible=[];
    for(const day of data.days) {
      const i=dates.get(day.date); if(i===undefined || i+1<=view.x || i>=view.x+view.n) continue;
      const ranks = topView.checked ? ranked(day) : null;
      for(const row of day.cells) {
        const j=strikes.indexOf(row[0]);
        const lo=j ? (strikes[j-1]+row[0])/2 : row[0]-(strikes[1]-row[0] || view.h)/2;
        const hi=j<strikes.length-1 ? (row[0]+strikes[j+1])/2 : row[0]+(row[0]-strikes[j-1] || view.h)/2;
        if(hi<=view.y || lo>=view.y+view.h) continue;
        for(const [side,value,offset,fraction,rank,ratio] of (ranks ? ranks.get(row[0]) || [] : parts(row))) if(typeof value === 'number' && Number.isFinite(value) && i+offset+fraction>view.x && i+offset<view.x+view.n) visible.push({day,i,strike:row[0],side,value,lo,hi,offset,fraction,rank,ratio,shared:!!ranks && ranks.sharedStrike === row[0],pcr:ranks?.pcr});
      }
    }
    const values=visible.map(c=>c.value), min=values.length?Math.min(...values):0,max=values.length?Math.max(...values):0;
    ctx.save();ctx.beginPath();ctx.rect(l,t,pw,ph);ctx.clip();
    for(const c of visible) {
      const x=X(c.i+c.offset),y=Y(c.hi),cw=pw/view.n*c.fraction,ch=Y(c.lo)-y;
      if (!topView.checked || (c.rank === 1 && !(c.shared && c.side === 'PE'))) {
        ctx.fillStyle=topView.checked ? c.shared ? '#ffff00' : c.side === 'CE' ? '#ff3c3c' : '#28ff5a'
          : color(max===min?.5:(c.value-min)/(max-min));
        ctx.fillRect(x,y,cw,ch);
      }
      cells.push({...c,x,y,cw,ch});
    }
    // Date centres are i + .5, so integer positions divide adjacent dates.
    // Draw behind spot/labels, with a light overlay to remain visible over OI cells.
    if (grid.checked) {
      ctx.beginPath();ctx.strokeStyle='rgba(190,201,217,.22)';ctx.lineWidth=1;
      for (let i=Math.max(1,Math.ceil(view.x));i<data.dates.length && i<=view.x+view.n;i++) {
        const x=X(i);ctx.moveTo(x,t);ctx.lineTo(x,t+ph);
      }
      for (const strike of strikes) if (strike>=view.y && strike<=view.y+view.h) {
        const y=Y(strike);ctx.moveTo(l,y);ctx.lineTo(l+pw,y);
      }
      ctx.stroke();
    }
    // Outline keeps spot readable over every rainbow colour.
    ctx.lineJoin='round';ctx.lineCap='round';ctx.beginPath();
    const byDate=new Map(data.days.map(d=>[d.date,d]));let connected=false;
    const spotPoints=[];
    data.dates.forEach((date,i)=>{
      const day=byDate.get(date);
      if(!day || !valid(day.spot)){connected=false;return;}
      const x=X(i+.5),y=Y(day.spot);
      if(connected)ctx.lineTo(x,y);else ctx.moveTo(x,y);
      connected=true;spotPoints.push({x,y});
    });
    ctx.strokeStyle='#05080d';ctx.lineWidth=7;ctx.stroke();
    ctx.strokeStyle='#ffffff';ctx.lineWidth=3;ctx.stroke();
    for(const {x,y} of spotPoints){
      ctx.beginPath();ctx.arc(x,y,4,0,Math.PI*2);
      ctx.fillStyle='#ffffff';ctx.fill();ctx.strokeStyle='#05080d';ctx.lineWidth=2;ctx.stroke();
    }
    if (topView.checked && labels.checked) {
      ctx.font='bold 11px sans-serif';ctx.textAlign='center';
      const groups = new Map();
      for (const c of cells) {
        const key=c.day.date+':'+c.strike;
        const group=groups.get(key) || [];group.push(c);groups.set(key,group);
      }
      for (const group of groups.values()) {
        const c=group[0];
        const segments=group.map(entry => ({
          text:(entry.rank === 1 ? entry.side : entry.side+entry.rank)+' '+(entry.rank === 1
            ? entry.value.toLocaleString('en-IN',{maximumFractionDigits:2})+' lots'
            : entry.ratio === null ? '\u2014%' : (entry.ratio*100).toLocaleString('en-IN',{maximumFractionDigits:1})+'%'),
          color:entry.rank === 1 ? '#ffffff' : `rgba(${entry.side === 'CE' ? '255,60,60' : '40,255,90'},${entry.rank === 1 ? 1 : Math.max(.12,entry.ratio ?? 0)})`
        }));
        const x=c.x+c.cw/2,y=c.y+c.ch/2+4;
        const gap=ctx.measureText(' / ').width;
        const width=segments.reduce((sum,segment)=>sum+ctx.measureText(segment.text).width,0)+gap*(segments.length-1);
        let cursor=x-width/2;
        ctx.textAlign='left';ctx.strokeStyle='#05080d';ctx.lineWidth=3;
        segments.forEach((segment,index)=>{
          ctx.strokeText(segment.text,cursor,y);ctx.fillStyle=segment.color;ctx.fillText(segment.text,cursor,y);
          cursor+=ctx.measureText(segment.text).width;
          if(index<segments.length-1){ctx.fillStyle='#bec9d9';ctx.strokeText(' / ',cursor,y);ctx.fillText(' / ',cursor,y);cursor+=gap;}
        });
        ctx.textAlign='center';
        ctx.fillStyle='#ffffff';
        if (group.some(entry => entry.rank === 1 && entry.side === 'CE')) {
          const pcrText='PCR '+(c.pcr === null ? '\u2014' : c.pcr.toFixed(2));
          ctx.strokeText(pcrText,x,y+13);ctx.fillText(pcrText,x,y+13);
        }
      }
      ctx.textAlign='left';
    }
    ctx.restore();
    ctx.strokeStyle='#586274';ctx.strokeRect(l,t,pw,ph);ctx.fillStyle='#bec9d9';ctx.font='11px sans-serif';
    const tickStrikes=strikes.filter(v=>v>=view.y && v<=view.y+view.h);
    const tickStride=Math.max(1,Math.ceil(tickStrikes.length/Math.max(1,Math.floor(ph/22))));
    tickStrikes.forEach((v,i)=>{
      if(i%tickStride===0)ctx.fillText(v.toLocaleString('en-IN',{maximumFractionDigits:8}),5,Y(v)+4);
      ctx.beginPath();ctx.moveTo(l-5,Y(v));ctx.lineTo(l,Y(v));ctx.stroke();
    });
    // Tick marks follow all date boundaries, independently of date label thinning.
    for(let i=Math.max(1,Math.ceil(view.x));i<data.dates.length && i<=view.x+view.n;i++) {
      ctx.beginPath();ctx.moveTo(X(i),t+ph);ctx.lineTo(X(i),t+ph+5);ctx.stroke();
    }
    const stride=Math.max(1,Math.ceil(view.n/Math.max(1,pw/85)));
    for(let i=Math.max(0,Math.floor(view.x));i<data.dates.length && i<view.x+view.n;i+=stride){ctx.fillText(data.dates[i].slice(5),X(i+.5)-18,t+ph+20);}
    ctx.fillText('Trading dates (IST) · '+data.expiry.slice(0,4),l,t+ph+40);
    if (topView.checked) {
      ctx.fillStyle='#ff3c3c';ctx.fillText('Call OI · top 3',l,h-25);
      ctx.fillStyle='#28ff5a';ctx.fillText('Put OI · top 3',l+160,h-25);
      ctx.fillStyle='#ffff00';ctx.fillText('Yellow · CE/PE maxima at same strike',l+320,h-25);
      ctx.fillStyle='#bec9d9';ctx.fillText('Ranks 2/3: CE/PE % labels only · ties: lower strike first',l,h-9);
      return;
    }
    for(let i=0;i<pw;i++){ctx.fillStyle=color(i/pw);ctx.fillRect(l+i,h-36,1,10);}
    ctx.fillStyle='#bec9d9';ctx.fillText('Visible min '+min.toLocaleString('en-IN',{maximumFractionDigits:2})+' lots',l,h-9);ctx.textAlign='right';ctx.fillText('Visible max '+max.toLocaleString('en-IN',{maximumFractionDigits:2})+' lots',l+pw,h-9);ctx.textAlign='left';
  }
  async function load(name,force=false) {
    if(!name || (!force && name===symbol && (loading || data))) return;
    const changed=name!==symbol;symbol=name;if(changed)selected='';const id=++ticket;
    data=null;view=null;loading=true;message='Loading archived closing OI…';tip.classList.add('hidden');status.textContent=message;draw();
    try {
      const response=await fetch('/api/history/oi/heatmap?'+new URLSearchParams({ticker:name,expiry:selected}));
      const result=await response.json();if(id!==ticket)return;if(!response.ok)throw Error(typeof result.error === 'string' ? result.error : result.error?.message || result.message || 'Archive request failed');
      data=result;message='';selected=data.expiry;expiry.replaceChildren(...data.expiries.map(v=>{const o=document.createElement('option');o.value=v;o.textContent=v;o.selected=v===selected;return o;}));
      status.textContent=data.reason || `${name} · ${data.previous_expiry} to ${data.expiry} · ${data.days.length}/${data.dates.length} dates archived. Blank cells mean missing data; dates without trading evidence are omitted. OI in lots · ticker lot size used when historical lot size is absent.`;
      reset();
    }catch(e){if(id!==ticket)return;message=e.message+' · Reload archive after restarting the backend if this endpoint is unavailable.';status.textContent=message;draw();}
    finally {if(id===ticket)loading=false;}
  }
  el('oiHeatStrikes').onchange=()=>{if(!data || !data.strikes.length || !view)return;Object.assign(view,strikeWindow());tip.classList.add('hidden');draw();};
  topView.onchange=()=>{mode.disabled=topView.checked;labels.disabled=!topView.checked;tip.classList.add('hidden');draw();};
  labels.onchange=draw;grid.onchange=draw;
  expiry.onchange=()=>{selected=expiry.value;load(symbol,true);};mode.onchange=draw;
  el('oiHeatReset').onclick=reset;el('oiHeatReload').onclick=()=>load(symbol,true);canvas.ondblclick=reset;
  canvas.addEventListener('wheel',e=>{
    if(!view||!geometry)return;e.preventDefault();const r=canvas.getBoundingClientRect(),g=geometry,fx=Math.max(0,Math.min(1,(e.clientX-r.left-g.l)/g.pw)),fy=Math.max(0,Math.min(1,1-(e.clientY-r.top-g.t)/g.ph)),factor=e.deltaY>0?1.2:1/1.2;
    if(!e.altKey){const n=Math.min(data.dates.length,Math.max(1,view.n*factor));view.x=Math.max(0,Math.min(data.dates.length-n,view.x+fx*(view.n-n)));view.n=n;}
    if(!e.shiftKey){const h=Math.max(.01,view.h*factor);view.y+=fy*(view.h-h);view.h=h;}tip.classList.add('hidden');draw();
  },{passive:false});
  canvas.onpointerdown=e=>{if(!view)return;drag={x:e.clientX,y:e.clientY,view:{...view}};canvas.setPointerCapture(e.pointerId);tip.classList.add('hidden');};
  canvas.onpointermove=e=>{
    if(drag){view.x=Math.max(0,Math.min(data.dates.length-view.n,drag.view.x-(e.clientX-drag.x)/geometry.pw*view.n));view.y=drag.view.y+(e.clientY-drag.y)/geometry.ph*view.h;draw();return;}
    const r=canvas.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top,c=cells.find(c=>x>=c.x&&x<c.x+c.cw&&y>=c.y&&y<c.y+c.ch);
    tip.classList.toggle('hidden',!c);if(c){const peers=topView.checked ? cells.filter(entry=>entry.day.date===c.day.date && entry.strike===c.strike) : [c];tip.textContent=`${c.day.date} · Strike ${c.strike} · ${peers.map(entry=>entry.side+(entry.rank ? ' #'+entry.rank : '')+' OI '+entry.value.toLocaleString('en-IN',{maximumFractionDigits:2})+' lots').join(' / ')}${c.rank ? ' · '+(c.ratio === null ? 'Relative OI unavailable (zero maximum)' : (c.ratio*100).toLocaleString('en-IN',{maximumFractionDigits:1})+'% of daily '+c.side+' maximum') : ''}${c.rank ? ' · PCR (highest PE / highest CE): '+(c.pcr === null ? '—' : c.pcr.toFixed(2)) : ''} · Lot size ${c.day.lot_size ?? "—"} (${c.day.lot_basis ?? "archived"}) · Spot ${c.day.spot} · ATM ${c.day.atm}`;tip.style.left=Math.min(x+12,Math.max(0,r.width-330))+'px';tip.style.top=Math.max(0,y-45)+'px';}
  };
  canvas.onpointerup=canvas.onpointercancel=()=>{drag=null;};canvas.onpointerleave=()=>tip.classList.add('hidden');
  new ResizeObserver(draw).observe(canvas);window.oiHeatmap={load};
})();
