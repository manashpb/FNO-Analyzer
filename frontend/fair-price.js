/* Quote-anchored projection, matching OPTION-FAIR_PRICE/pricing.py. */
(function (root) {
  'use strict';
  const finite = x => typeof x === 'number' && Number.isFinite(x);
  function project(premium, spot, level, delta, gamma, theta, side, expired = false, strike = 0) {
    if (!['CE', 'PE'].includes(side) || !finite(level) || level <= 0) return null;
    if (expired) return finite(strike) && strike > 0 ? Math.max(0, side === 'CE' ? level - strike : strike - level) : null;
    if (![premium, spot, delta, gamma, theta].every(finite) || premium < 0 || spot <= 0 || gamma < 0 ||
        (side === 'CE' ? delta < 0 || delta > 1 : delta < -1 || delta > 0)) return null;
    const move = level - spot;
    const value = premium + delta * move + 0.5 * gamma * move * move + theta / 7;
    return finite(value) ? Math.max(0, value) : null;
  }
  function levels(entry, sl, target, side, sell) {
    if (![entry, sl, target].every(finite) || entry <= 0 || sl < 0 || target < 0) return null;
    const direction = (side === 'CE' ? 1 : -1) * (sell ? -1 : 1);
    return [entry, entry - direction * sl, entry + direction * target];
  }
  if (typeof module !== 'undefined') module.exports = {project, levels};
  if (typeof document === 'undefined') return;
  const $ = id => document.getElementById(id);
  const fmt = n => finite(n) ? n.toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '—';
  let active = false, initialized = false, generation = 0, chain = null, timer = null, symbols = [], busy = false;
  const cards = [];
  const number = input => input.value.trim() === '' ? NaN : Number(input.value);
  async function get(url) {
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok) throw new Error((typeof data.error === 'string' ? data.error : data.error?.message) || data.message || 'Dhan data unavailable');
    return data;
  }
  function clear(message) {
    chain = null;
    $('fairSpot').textContent = 'Spot —';
    $('fairUpdated').textContent = 'Last refreshed: —';
    $('fairStatus').textContent = message;
    cards.forEach(card => {card.strike.replaceChildren(); render(card);});
  }
  function render(card) {
    const row = chain?.strikes.find(row => row.sp === Number(card.strike.value));
    const prefix = card.side === 'CE' ? 'c' : 'p';
    const spot = chain?.snapshot?.uv;
    card.quote.textContent = fmt(row?.[prefix + 'Ltp']);
    card.greeks.textContent = `Delta ${fmt(row?.[prefix + 'D'])} · Gamma ${finite(row?.[prefix + 'G']) ? row[prefix + 'G'].toFixed(5) : '—'} · Theta ${fmt(row?.[prefix + 'T'])}`;
    const spots = levels(number(card.entry), number(card.sl), number(card.target), card.side, card.sell.checked);
    const expired = chain && Date.now() >= new Date(chain.expires_at).getTime();
    let unavailable = false;
    card.outputs.forEach((output, i) => {
      const level = spots?.[i];
      const price = row ? project(row[prefix + 'Ltp'], spot, level, row[prefix + 'D'], row[prefix + 'G'], row[prefix + 'T'], card.side, expired, row.sp) : null;
      output.spot.textContent = finite(level) && level > 0 ? fmt(level) : '—';
      output.price.textContent = fmt(price);
      if (price === null) unavailable = true;
    });
    const bullish = (card.side === 'CE') !== card.sell.checked;
    card.direction.textContent = `${card.sell.checked ? 'Sell' : 'Buy'} ${card.side}: stop-loss ${bullish ? 'below' : 'above'} entry · target ${bullish ? 'above' : 'below'} entry`;
    card.note.textContent = !chain ? 'Waiting for a quote.' : unavailable ? (!spots || spots.some(level => level <= 0) ? 'Enter a positive entry spot and valid distances.' : 'Price unavailable: this quote is missing valid LTP or Greeks.') : expired ? 'Contract expired · intrinsic value shown.' : 'Estimated premiums · points per unit';
  }
  for (const side of ['CE', 'PE']) {
    const box = document.createElement('article'); box.className = 'fair-box';
    box.innerHTML = `<div class="fair-box-head"><h3>${side === 'CE' ? 'Call' : 'Put'} <span>${side}</span></h3><div class="fair-market"><span>Current premium</span><strong class="fair-quote">—</strong></div></div>
      <div class="fair-contract"><label>Strike price <select aria-label="${side} strike"></select></label><fieldset class="fair-position"><legend>Position</legend><div><label><input type="radio" name="fairPosition${side}" value="buy" checked aria-label="Buy ${side}"><span>Buy</span></label><label><input type="radio" name="fairPosition${side}" value="sell" aria-label="Sell ${side}"><span>Sell</span></label></div></fieldset></div>
      <div class="fair-inputs"><label>Entry spot <span class="fair-unit">Underlying price</span><input type="number" min="0.01" step="any" aria-label="${side} entry spot"></label><label>Stop-loss distance <span class="fair-unit">Spot points</span><input type="number" min="0" step="any" value="25" aria-label="${side} SL distance"></label><label>Target distance <span class="fair-unit">Spot points</span><input type="number" min="0" step="any" value="50" aria-label="${side} target distance"></label></div>
      <p class="fair-direction"></p>
      <table aria-label="${side} estimated premiums"><thead><tr><th>Scenario</th><th>Spot level</th><th>Est. premium</th></tr></thead><tbody>${['Entry', 'Stop-loss', 'Target'].map(name => `<tr><th scope="row">${name}</th><td>—</td><td>—</td></tr>`).join('')}</tbody></table><p class="hint fair-note" role="status"></p><div class="fair-greeks"><strong>Quote Greeks</strong><p></p></div>`;
    const inputs = box.querySelectorAll('input[type=number]');
    const card = {side, box, strike: box.querySelector('select'), sell: box.querySelector('input[value=sell]'), entry: inputs[0], sl: inputs[1], target: inputs[2], quote: box.querySelector('.fair-quote'), greeks: box.querySelector('.fair-greeks p'), direction: box.querySelector('.fair-direction'), note: box.querySelector('.fair-note'), outputs: [...box.querySelectorAll('tbody tr')].map(row => ({spot: row.children[1], price: row.children[2]}))};
    box.addEventListener('input', () => render(card)); box.addEventListener('change', () => render(card));
    $(side === 'CE' ? 'fairCalls' : 'fairPuts').append(box); cards.push(card); render(card);
  }
  function updateStrikes() {
    if (!chain) return;
    const rows = chain.strikes, spot = chain.snapshot.uv;
    const atm = rows.reduce((a,b) => Math.abs(b.sp - spot) < Math.abs(a.sp - spot) ? b : a).sp;
    const center = rows.findIndex(row => row.sp === atm);
    const count = Math.max(1, Math.min(80, Math.round(Number($('fairStrikeCount').value) || 8)));
    const selectedRows = rows.filter((row, i) => Math.abs(i - center) <= count);
    cards.forEach(card => {
      const previous = Number(card.strike.value);
      card.strike.replaceChildren(...selectedRows.map(row => new Option(`${row.sp}${row.sp === atm ? ' (ATM)' : ''}`, row.sp)));
      card.strike.value = String(selectedRows.some(row => row.sp === previous) ? previous : atm);
      if (!card.entry.value) card.entry.value = String(spot);
      render(card);
    });
  }
  $('fairStrikeCount').addEventListener('input', () => {
    const input = $('fairStrikeCount');
    if (!input.value || !input.validity.valid) return;
    updateStrikes();
  });
  $('fairStrikeCount').addEventListener('change', () => {
    const input = $('fairStrikeCount');
    input.value = String(Math.max(1, Math.min(80, Math.round(Number(input.value) || 8))));
    updateStrikes();
  });
  function schedule(delay = 10000) {
    clearTimeout(timer);
    if (active && $('fairAuto').checked && $('fairExpiry').value) timer = setTimeout(refresh, delay);
  }
  async function refresh() {
    if (busy || !$('fairExpiry').value) return;
    const gen = generation; busy = true; clearTimeout(timer);
    $('fairStatus').textContent = 'Refreshing Dhan quote…';
    let delay = 10000;
    try {
      const data = await get(`api/fair-price/chain?ticker=${encodeURIComponent($('fairSymbol').value)}&expiry=${encodeURIComponent($('fairExpiry').value)}`);
      if (gen !== generation) return;
      const rows = data.strikes.filter(row => finite(row.sp) && row.sp > 0).sort((a,b) => a.sp - b.sp);
      const spot = data.snapshot?.uv;
      if (!finite(spot) || spot <= 0 || !rows.length) throw new Error('Dhan returned incomplete spot or strike data');
      chain = {...data, strikes: rows};
      updateStrikes();
      $('fairSpot').textContent = `Spot ${fmt(spot)}`;
      $('fairUpdated').textContent = 'Last refreshed: ' + new Date(data.refreshed_at).toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'}) + ' IST';
      $('fairStatus').textContent = 'Dhan connected · strikes near ATM';
    } catch (error) {
      if (gen === generation) clear(error.message + ' · quotes unavailable');
      delay = 60000;
    } finally {
      busy = false;
      if (gen === generation) schedule(delay);
      else if (active && $('fairExpiry').value) refresh();
    }
  }
  async function selectSymbol() {
    const gen = ++generation; clearTimeout(timer); $('fairExpiry').replaceChildren();
    cards.forEach(card => { card.entry.value = ''; });
    clear('Loading Dhan expiries…');
    if (!symbols.some(row => row.aoc === $('fairSymbol').value)) {clear('Choose a symbol from the list.'); return;}
    try {
      const data = await get('api/fair-price/expiries?ticker=' + encodeURIComponent($('fairSymbol').value));
      if (gen !== generation) return;
      $('fairExpiry').replaceChildren(...data.expiries.map(expiry => new Option(expiry.label, expiry.id)));
      if (!data.expiries.length) { clear('No active Dhan expiries.'); return; }
      refresh();
    } catch (error) {if (gen === generation) clear(error.message);}
  }
  async function init() {
    if (initialized) {schedule(); return;}
    initialized = true;
    try {
      const mapping = await get('api/dhan/map');
      symbols = (mapping.mapped || []).sort((a,b) => a.seg - b.seg || a.aoc.localeCompare(b.aoc));
      $('fairSymbols').replaceChildren(...symbols.map(row => new Option(row.disp || row.aoc, row.aoc)));
      if (!symbols.length) throw new Error('Dhan symbol map is missing');
      $('fairSymbol').value = symbols.some(row => row.aoc === 'NIFTY') ? 'NIFTY' : symbols[0].aoc;
      if (active) await selectSymbol(); else initialized = false;
    } catch (error) {clear(error.message); initialized = false;}
  }
  $('fairSymbol').addEventListener('change', selectSymbol);
  $('fairExpiry').addEventListener('change', () => {generation++; clear('Loading chain…'); refresh();});
  $('fairRefresh').addEventListener('click', () => $('fairExpiry').value ? refresh() : selectSymbol());
  $('fairAuto').addEventListener('change', () => schedule());
  root.FairPrice = {setActive(value) {active = value; clearTimeout(timer); if (value) init();}};
})(typeof window === 'undefined' ? globalThis : window);
