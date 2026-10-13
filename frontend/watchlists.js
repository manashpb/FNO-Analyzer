(() => {
  'use strict';
  const $ = id => document.getElementById(id), key = 'fno-watchlists-v1';
  let lists = [{id:'default', name:'My watchlist', symbols:[]}], selected = 'sectors';
  let universe = [], lookup = new Map(), map = null, choose = () => {}, active = '', ready = false;
  const scans = new Map();
  let sectors=[], sectorLoading=false, sectorLoaded=false, sectorAttempted=false, sectorNote='';
  try {const cache=JSON.parse(localStorage.getItem('fno-watchlist-sectors-v1'));if(Array.isArray(cache?.groups)){sectors=cache.groups.filter(g=>typeof g.name==='string'&&Array.isArray(g.symbols));sectorLoaded=true;sectorNote='Cached sector groups';}}catch(_){}
  async function loadSectors(force=false) {
    if(!ready || sectorLoading || ((sectorLoaded || sectorAttempted) && !force))return;
    sectorAttempted=true;sectorLoading=true;sectorNote='Loading sector groups in background';if(selected==='sectors')render();
    async function request(url){const response=await fetch(url);const data=await response.json();if(!response.ok)throw Error(typeof data.error==='string' ? data.error : data.error?.message || 'Sector data unavailable');return data;}
    try {
      const result=await request('api/sectors');const pending=[];
      for(const [i,sector] of (result.sectors || []).entries()) {
        const data=await request('api/sectors/components?sectorId='+encodeURIComponent(sector.sectorId));
        pending.push({name:sector.displaySymbol || sector.symbol,symbols:(data.components || []).map(c=>c.symbol)});
        sectorNote=`Loading sectors ${i+1}/${result.sectors.length}`;
        if(!sectorLoaded)sectors=[...pending];if(selected==='sectors')render();
      }
      sectors=pending;sectorLoaded=true;sectorNote='Sector groups loaded';
      try{localStorage.setItem('fno-watchlist-sectors-v1',JSON.stringify({groups:sectors}));}catch(_){}
    }catch(e){sectorNote=e.message+'. Use refresh to retry; uncategorized symbols remain available.';}
    finally{sectorLoading=false;if(selected==='sectors')render();}
  }
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (saved && Array.isArray(saved.lists)) {
      const ids = new Set();
      lists = saved.lists.filter(l => l && typeof l.id === 'string' && !['all','sectors'].includes(l.id) &&
        typeof l.name === 'string' && Array.isArray(l.symbols) && !ids.has(l.id) && ids.add(l.id))
        .map(l => ({id:l.id, name:l.name, symbols:[...new Set(l.symbols.filter(s => typeof s === 'string'))]}));
      selected = ['all','sectors'].includes(saved.selected) || lists.some(l => l.id === saved.selected) ? saved.selected : 'all';
    }
  } catch (_) { /* Keep a usable default when browser storage is unavailable. */ }
  const message = text => { $('wlMessage').textContent = text; };
  function save() {
    try { localStorage.setItem(key, JSON.stringify({lists, selected})); }
    catch (_) { message('Browser storage unavailable. Changes last only until this page closes.'); }
    refreshTargets();
  }
  function option(value, text) {
    const node=document.createElement('option');node.value=value;node.textContent=text;return node;
  }
  function targets(select) {
    const previous=select.value;
    select.replaceChildren(...lists.map(l=>option(l.id,l.name)));
    select.value=lists.some(l=>l.id===previous) ? previous : lists.some(l=>l.id===selected) ? selected : lists[0]?.id || '';
  }
  function refreshTargets() {
    document.querySelectorAll('.scan-watchlist-target').forEach(targets);
  }
  function resolve(symbol) { return lookup.get(String(symbol).trim().toUpperCase()); }
  function add(id, symbols) {
    const list=lists.find(l=>l.id===id);
    if (!list) return 'Create a watchlist and choose it first.';
    if (!ready) return 'Symbols are still loading. Try again in a moment.';
    let added=0;const unknown=[];
    for (const symbol of symbols) {
      if (!String(symbol).trim()) continue;
      const ticker=resolve(symbol);
      if (!ticker) {unknown.push(String(symbol).trim());continue;}
      if (!list.symbols.includes(ticker.Name)) {list.symbols.push(ticker.Name);added++;}
    }
    selected=id;render();save();
    return `${added} symbols added to ${list.name}.`+(unknown.length ? ` Unknown symbols: ${[...new Set(unknown)].join(', ')}.` : '');
  }
  function render() {
    $('wlSelect').replaceChildren(option('sectors','Sectors'),option('all','All symbols'),...lists.map(l=>option(l.id,l.name)));
    $('wlSelect').value=selected;
    const custom=lists.find(l=>l.id===selected);
    $('wlClear').disabled=$('wlDelete').disabled=$('wlAdd').disabled=!custom;
    $('wlExport').disabled=!custom || !custom.symbols.length;
    $('wlTradingView').value=custom ? tradingViewSymbols(custom.symbols) : '';
    const body=$('wlBody');body.replaceChildren();
    const indices=new Set((map?.mapped || []).filter(m=>String(m.seg)==='0').map(m=>m.aoc));
    const commodities=new Set((map?.unmapped || []).filter(m=>(m.reason || '').includes("segment 'M'")).map(m=>m.aoc));
    const items=custom ? custom.symbols.map(name=>universe.find(t=>t.Name===name) || {Name:name}) : universe;
    let groups=custom ? [[custom.name,items]] : [['Indices',items.filter(t=>indices.has(t.Name))],
      ['Stocks',items.filter(t=>!indices.has(t.Name)&&!commodities.has(t.Name))],['Commodities',items.filter(t=>commodities.has(t.Name))]];
    if(selected==='sectors') {
      const placed=new Set([...indices,...commodities]);
      const sectorGroups=sectors.map(group=>[group.name,group.symbols.map(resolve).filter(t=>t&&!indices.has(t.Name)&&!commodities.has(t.Name))]);
      for(const [,rows] of sectorGroups)for(const ticker of rows)placed.add(ticker.Name);
      groups=[['Indices',items.filter(t=>indices.has(t.Name))],...sectorGroups,
        ['Commodities',items.filter(t=>commodities.has(t.Name))],['Other / not classified',items.filter(t=>!placed.has(t.Name))]];
      const note=document.createElement('p');note.className='hint';note.textContent=sectorNote || 'Sector groups will load in background.';body.appendChild(note);
    }
    for (const [name,rows] of groups) {
      if (!rows.length) continue;
      const group=document.createElement('div');group.className='wl-group';
      const head=document.createElement('button');head.className='wl-ghead';head.textContent=`${name} (${rows.length})`;
      head.onclick=()=>group.classList.toggle('collapsed');group.appendChild(head);
      const container=document.createElement('div');container.className='wl-list';
      for (const ticker of [...rows].sort((a,b)=>a.Name.localeCompare(b.Name))) {
        const entry=document.createElement('div');entry.className='wl-entry';
        const button=document.createElement('button');button.className='wl-item';button.dataset.name=ticker.Name;
        button.classList.toggle('sel',ticker.Name===active);button.textContent=ticker.Name+(ticker.disp ? ' · '+ticker.disp : '');
        button.onclick=()=>{const current=resolve(ticker.Name);if(current)choose(current);else message('Symbol is unavailable in the current universe.');};
        entry.appendChild(button);
        if (custom) {
          const remove=document.createElement('button');remove.className='wl-remove';remove.textContent='Remove';remove.title='Remove '+ticker.Name+' from this watchlist';remove.setAttribute('aria-label','Remove '+ticker.Name);
          remove.onclick=()=>{custom.symbols=custom.symbols.filter(s=>s!==ticker.Name);render();save();};entry.appendChild(remove);
        }
        container.appendChild(entry);
      }
      group.appendChild(container);body.appendChild(group);
    }
    if (!body.children.length) body.textContent=custom ? 'This watchlist is empty. Add symbols or scanner results.' : 'Symbols are loading…';
  }
  $('wlSelect').onchange=()=>{selected=$('wlSelect').value;message('');render();save();if(selected==='sectors')loadSectors();};
  $('wlCreate').onclick=()=>{
    const name=$('wlName').value.trim();
    if(!name)return message('Enter a watchlist name.');
    if(lists.some(l=>l.name.toLowerCase()===name.toLowerCase()))return message('A watchlist with this name already exists.');
    const id='list-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
    lists.push({id,name,symbols:[]});selected=id;$('wlName').value='';message('');render();save();
  };
  $('wlClear').onclick=()=>{const list=lists.find(l=>l.id===selected);if(list){list.symbols=[];render();message('Watchlist cleared.');save();}};
  $('wlDelete').onclick=()=>{lists=lists.filter(l=>l.id!==selected);selected='all';render();message('Watchlist deleted.');save();};
  $('wlAdd').onclick=()=>{const result=add(selected,$('wlSymbols').value.split(/[,\n\r]+/));message(result);};
  function tradingViewSymbols(symbols) {
    const aliases = {NIFTY:'NSE:NIFTY', NIFTY_2:'NSE:NIFTY', BANKNIFTY:'NSE:BANKNIFTY', SENSEX:'BSE:SENSEX', BANKEX:'BSE:BANKEX', LARSEN:'NSE:LT', MAHINDRA:'NSE:M&M'};
    const commodities=new Set((map?.unmapped || []).filter(m=>(m.reason || '').includes("segment 'M'")).map(m=>m.aoc));
    return [...new Set(symbols.map(symbol => aliases[symbol] || `${commodities.has(symbol) ? 'MCX' : 'NSE'}:${symbol}`))].join(',');
  }
  $('wlExport').onclick=async()=>{
    const list=lists.find(l=>l.id===selected);if(!list?.symbols.length)return;
    const field=$('wlTradingView');field.value=tradingViewSymbols(list.symbols);
    try {
      await navigator.clipboard.writeText(field.value);
      message(`${list.symbols.length} symbols copied. Paste into TradingView.`);
    } catch (_) {
      field.focus();field.select();
      message('Select and copy the TradingView string with Ctrl+C, then paste into TradingView.');
    }
  };
  function mount(id, rows, generation) {
    const root=$(id), table=root.querySelector('table');if(!table)return;
    let state=scans.get(id);
    if(!state || state.generation!==generation){state={generation,selected:new Set()};scans.set(id,state);}
    const symbols=rows.map(r=>r.symbol), allowed=new Set(symbols);
    state.selected=new Set([...state.selected].filter(s=>allowed.has(s)));
    const toolbar=document.createElement('div');toolbar.className='scan-watchlist-tools';
    const selectAll=document.createElement('input');selectAll.type='checkbox';selectAll.setAttribute('aria-label','Select all displayed scan symbols');
    const allLabel=document.createElement('label');allLabel.appendChild(selectAll);allLabel.appendChild(document.createTextNode(' Select all'));
    const destination=document.createElement('select');destination.className='scan-watchlist-target';destination.setAttribute('aria-label','Destination watchlist');targets(destination);if(lists.some(l=>l.id===state.target))destination.value=state.target;destination.onchange=()=>state.target=destination.value;
    const button=document.createElement('button');button.textContent='Add selected to watchlist';button.type='button';
    const note=document.createElement('span');note.className='hint';note.setAttribute('role','status');
    toolbar.append(allLabel,destination,button,note);root.insertBefore(toolbar,table);
    const header=document.createElement('th');header.textContent='Select';table.querySelector('thead tr').prepend(header);
    const boxes=[];
    table.querySelectorAll('tbody tr').forEach((tr,index)=>{
      const symbol=symbols[index],cell=document.createElement('td'),box=document.createElement('input');box.type='checkbox';box.checked=state.selected.has(symbol);
      box.setAttribute('aria-label','Select '+symbol);box.onchange=()=>{box.checked?state.selected.add(symbol):state.selected.delete(symbol);sync();};
      cell.appendChild(box);tr.prepend(cell);boxes.push(box);
    });
    function sync(){selectAll.checked=symbols.length>0&&symbols.every(s=>state.selected.has(s));selectAll.indeterminate=state.selected.size>0&&!selectAll.checked;button.disabled=!state.selected.size;}
    selectAll.onchange=()=>{state.selected=selectAll.checked?new Set(symbols):new Set();boxes.forEach(b=>b.checked=selectAll.checked);sync();};
    button.onclick=()=>{const result=add(destination.value,[...state.selected]);note.textContent=result;message(result);};sync();
  }
  window.watchlists={add,mount,tradingViewSymbols,setUniverse(tickers,dhanMap,onSelect){
    universe=tickers;map=dhanMap;choose=onSelect;ready=universe.length>0;lookup=new Map();
    for(const ticker of universe)lookup.set(ticker.Name.toUpperCase(),ticker);
    for(const entry of map?.mapped || []){const ticker=lookup.get(String(entry.aoc).toUpperCase());if(ticker)for(const alias of [entry.ticker,entry.symbol,entry.sym,entry.dhan])if(alias)lookup.set(String(alias).toUpperCase(),ticker);}
    for(const [alias,name] of [['LARSEN','LT'],['NIFTY_2','NIFTY'],['MAHINDRA','M&M']]){const ticker=lookup.get(name);if(ticker)lookup.set(alias,ticker);}
    render();if(selected==='sectors')loadSectors();
  },refresh(){render();if(selected==='sectors')loadSectors(true);},setActive(name){active=name;document.querySelectorAll('.wl-item').forEach(el=>el.classList.toggle('sel',el.dataset.name===active));}};
  render();
})();
