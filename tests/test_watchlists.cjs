const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
class Node {
  constructor(tag='div'){this.tag=tag;this.children=[];this.value='';this.dataset={};this.classes=new Set();this.classList={toggle:(name,on)=>{on??=!this.classes.has(name);on?this.classes.add(name):this.classes.delete(name);return on;}};}
  appendChild(n){this.children.push(n);return n;}
  append(...nodes){nodes.forEach(n=>this.appendChild(n));}
  prepend(n){this.children.unshift(n);}
  replaceChildren(...nodes){this.children=nodes;}
  insertBefore(n,b){this.children.splice(this.children.indexOf(b),0,n);}
  setAttribute(k,v){this[k]=v;}
  querySelector(s){return this.querySelectorAll(s)[0] || null;}
  querySelectorAll(s){
    const all=this.children.flatMap(c=>[c,...c.querySelectorAll('*')]);
    if(s==='*')return all;
    if(s==='thead tr')return all.filter(c=>c.tag==='thead').flatMap(c=>c.children);
    if(s==='tbody tr')return all.filter(c=>c.tag==='tbody').flatMap(c=>c.children);
    return all.filter(c=>s.startsWith('.') ? c.className?.split(' ').includes(s.slice(1)) : c.tag===s);
  }
}
const flush=()=>new Promise(r=>setImmediate(r));
function harness(storage=new Map(),fetch=async()=>{throw Error('offline');},published=false){
  const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);};
  const document={getElementById:get,createElement:tag=>new Node(tag),createTextNode:text=>Object.assign(new Node('text'),{textContent:text}),
    querySelectorAll:s=>[...nodes.values()].flatMap(n=>n.querySelectorAll(s))};
  const clipboard={text:'',async writeText(text){this.text=text;}};
  const window={};if(published)vm.runInNewContext(fs.readFileSync('frontend/stock-sectors.js','utf8'),{window});vm.runInNewContext(fs.readFileSync('frontend/watchlists.js','utf8'),{document,window,localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},fetch,navigator:{clipboard}});
  return {api:window.watchlists,get,storage,clipboard};
}
function scan(root,count){root.replaceChildren();const table=new Node('table'),head=new Node('thead'),body=new Node('tbody');head.append(new Node('tr'));for(let i=0;i<count;i++)body.append(new Node('tr'));table.append(head,body);root.append(table);return body;}
(async()=>{
  const h=harness();const universe=[{Name:'NIFTY'},{Name:'TCS'},{Name:'LT'},{Name:'M&M'}];
  h.api.setUniverse(universe,{mapped:[{aoc:'NIFTY',seg:0},{aoc:'LT',ticker:'LARSEN',seg:2}]},()=>{});
  h.get('wlName').value='Tech';h.get('wlCreate').onclick();const id=h.get('wlSelect').value;
  assert(h.api.add(id,['tcs','TCS','LARSEN','MAHINDRA','<unknown>']).includes('3 symbols added'));
  let saved=JSON.parse(h.storage.get('fno-watchlists-v1'));assert.deepEqual(saved.lists.find(l=>l.id===id).symbols,['TCS','LT','M&M']);
  assert.equal(h.api.tradingViewSymbols(['TCS','LT','M&M','NIFTY','SENSEX','TCS']), 'NSE:TCS,NSE:LT,NSE:M&M,NSE:NIFTY,BSE:SENSEX');
  assert.equal(h.get('wlExport').disabled,false);
  assert.equal(h.get('wlTradingView').value,'NSE:TCS,NSE:LT,NSE:M&M');
  await h.get('wlExport').onclick();assert.equal(h.clipboard.text,'NSE:TCS,NSE:LT,NSE:M&M');
  h.clipboard.writeText=async()=>{throw Error('denied');};
  let selected=false;h.get('wlTradingView').focus=()=>{};h.get('wlTradingView').select=()=>{selected=true;};
  await h.get('wlExport').onclick();assert(selected);assert(h.get('wlMessage').textContent.includes('Ctrl+C'));

  const remove=h.get('wlBody').querySelectorAll('.wl-remove').find(n=>n['aria-label']==='Remove TCS');
  remove.onclick();
  assert.deepEqual(JSON.parse(h.storage.get('fno-watchlists-v1')).lists.find(l=>l.id===id).symbols,['LT','M&M']);
  assert(!h.get('wlBody').querySelectorAll('.wl-item').some(n=>n.dataset.name==='TCS'));
  assert.equal(h.get('wlTradingView').value,'NSE:LT,NSE:M&M');
  const reload=harness(h.storage);assert.equal(reload.get('wlSelect').value,id);
  h.get('wlName').value='TECH';h.get('wlCreate').onclick();assert(h.get('wlMessage').textContent.includes('already exists'));
  const root=h.get('results');let body=scan(root,2);h.api.mount('results',[{symbol:'TCS'},{symbol:'LT'}],'job1');
  let toolbar=root.children[0],all=toolbar.children[0].children[0],button=toolbar.children[2];
  assert.equal(button.disabled,true);all.checked=true;all.onchange();assert(body.querySelectorAll('input').every(b=>b.checked));
  body.querySelectorAll('input')[0].checked=false;body.querySelectorAll('input')[0].onchange();assert.equal(all.indeterminate,true);
  body=scan(root,2);h.api.mount('results',[{symbol:'LT'},{symbol:'TCS'}],'job1');assert.equal(body.querySelectorAll('input')[0].checked,true);assert.equal(body.querySelectorAll('input')[1].checked,false);
  scan(root,2);h.api.mount('results',[{symbol:'LT'},{symbol:'TCS'}],'job2');assert.equal(root.children[0].children[2].disabled,true);
  h.get('wlClear').onclick();assert.deepEqual(JSON.parse(h.storage.get('fno-watchlists-v1')).lists.find(l=>l.id===id).symbols,[]);
  assert.equal(h.get('wlExport').disabled,true);
  h.get('wlDelete').onclick();assert(!JSON.parse(h.storage.get('fno-watchlists-v1')).lists.some(l=>l.id===id));
  // Cached sectors exclude indices from sector memberships and open without requests.
  const cache=new Map([['fno-watchlist-sectors-v1',JSON.stringify({groups:[{name:'IT',symbols:['TCS','NIFTY']} ]})]]);let calls=0;
  const c=harness(cache,async()=>{calls++;throw Error('should not fetch');});c.api.setUniverse(universe,{mapped:[{aoc:'NIFTY',seg:0}]},()=>{});
  assert.equal(c.get('wlSelect').value,'sectors');assert.equal(calls,0);
  const groups=c.get('wlBody').children.filter(n=>n.className==='wl-group');assert(groups.some(n=>n.children[0].textContent==='Indices (1)'));assert(groups.some(n=>n.children[0].textContent==='IT (1)'));
  c.get('wlName').value='Grouped';c.get('wlCreate').onclick();const groupedId=c.get('wlSelect').value;
  c.api.add(groupedId,['TCS','LT','NIFTY'],true);
  assert(c.get('wlBody').children.some(n=>n.children[0]?.textContent==='IT (1)'));
  assert.equal(c.api.groupedTradingViewSymbols(['TCS','LT','NIFTY','TCS']),'###Indices,NSE:NIFTY,###IT,NSE:TCS,###Other / not classified,NSE:LT');
  assert.equal(c.api.dhanSymbols(['LARSEN','MAHINDRA','TCS','TCS']),'LT,M&M,TCS');
  await c.get('wlExportGrouped').onclick();assert(c.clipboard.text.includes('###IT,NSE:TCS'));
  await c.get('wlExportDhan').onclick();assert.equal(c.clipboard.text,'TCS,LT,NIFTY');
  const restored=harness(c.storage);restored.api.setUniverse(universe,{mapped:[{aoc:'NIFTY',seg:0}]},()=>{});
  assert(restored.get('wlBody').children.some(n=>n.children[0]?.textContent==='IT (1)'));
  const groupedRoot=c.get('groupedResults');scan(groupedRoot,2);c.api.mount('groupedResults',[{symbol:'TCS'},{symbol:'LT'}],'grouped1');
  const tools=groupedRoot.children[0];assert(tools.children[3].disabled);tools.children[0].children[0].checked=true;tools.children[0].children[0].onchange();
  tools.children[1].value=groupedId;tools.children[3].onclick();
  assert(JSON.parse(c.storage.get('fno-watchlists-v1')).lists.find(l=>l.id===groupedId).grouped);
  // First sector request is asynchronous and does not hide available symbols.
  let release;const pending=harness(new Map(),()=>new Promise(r=>release=r));pending.api.setUniverse(universe,null,()=>{});
  assert(pending.get('wlBody').querySelectorAll('.wl-item').length===4);
  release({ok:true,json:async()=>({sectors:[]})});await flush();assert(pending.storage.has('fno-watchlist-sectors-v1'));
  let requests=0;
  const fresh=harness(new Map(),async url=>{requests++;return {ok:true,json:async()=>url==='api/sectors' ? {sectors:[{sectorId:2,displaySymbol:'IT'}]} : {components:[{symbol:'TCS'}]}};});
  fresh.api.setUniverse(universe,{mapped:[{aoc:'NIFTY',seg:0}]},()=>{});await flush();
  assert.equal(requests,2);assert(JSON.parse(fresh.storage.get('fno-watchlist-sectors-v1')).groups.some(g=>g.name==='IT'&&g.symbols.includes('TCS')));
  fresh.api.setUniverse(universe,null,()=>{});assert.equal(requests,2);
  let failures=0;const failed=harness(new Map(),async()=>{failures++;return {ok:false,json:async()=>({error:'AOC authentication failed'})};});
  failed.api.setUniverse(universe,null,()=>{});await flush();failed.api.setUniverse(universe,null,()=>{});assert.equal(failures,1);
  assert(failed.get('wlBody').children[0].textContent.includes('AOC authentication failed'));
  // Published classification replaces stale broad-index caches and resolves new listings.
  const published=harness(new Map([['fno-watchlist-sectors-v1',JSON.stringify({groups:[{name:'NIFTY',symbols:['TCS','UJJIVANSFB']}]})]]),async()=>{throw Error('classification must work offline');},true);
  published.api.setUniverse(universe,{mapped:[{aoc:'NIFTY',seg:0}]},()=>{});
  published.get('wlName').value='New listings';published.get('wlCreate').onclick();const newId=published.get('wlSelect').value;
  const newRoot=published.get('newResults');scan(newRoot,1);published.api.mount('newResults',[{symbol:'UJJIVANSFB'}],'new');
  const newTools=newRoot.children[0];newTools.children[1].value=newId;newTools.children[0].children[0].checked=true;newTools.children[0].children[0].onchange();newTools.children[3].onclick();
  assert.equal(JSON.parse(published.storage.get('fno-watchlists-v1')).lists.find(l=>l.id===newId).symbols[0],'UJJIVANSFB');
  assert.equal(published.api.groupedTradingViewSymbols(['UJJIVANSFB','TCS']),'###Financial Services,NSE:UJJIVANSFB,###Information Technology,NSE:TCS');
  assert.equal(published.api.dhanSymbols(['UJJIVANSFB']),'UJJIVANSFB');
  const stockWindow={};vm.runInNewContext(fs.readFileSync('frontend/stock-sectors.js','utf8'),{window:stockWindow});
  const stockNames=Object.keys(stockWindow.stockSectors);assert(stockNames.length>=750);
  assert(!published.api.groupedTradingViewSymbols(stockNames).includes('Other / not classified'));
  const mapping=JSON.parse(fs.readFileSync('data/dhan_map.json','utf8'));
  for(const row of mapping.mapped.filter(r=>Number(r.seg)===2))assert(stockWindow.stockSectors[row.aoc] || stockWindow.stockSectors[row.ticker],row.aoc+' has no classification');
  assert(published.api.add(newId,['<unknown>']).includes('Unknown symbols'));
  console.log('Watchlists: persistence, aliases, deduplication, CRUD, scanner selections, polling and cached/background sectors passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
