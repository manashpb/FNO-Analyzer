/* Same-expiry vertical quotes, in premium points per unit. */
(() => {
  "use strict";
  const quote = value => typeof value === "number" && Number.isFinite(value) && value > 0;
  function side(lower, upper, bidKey, askKey, put) {
    if (![lower[bidKey], lower[askKey], upper[bidKey], upper[askKey]].every(quote) ||
        lower[bidKey] > lower[askKey] || upper[bidKey] > upper[askKey]) return {bid:null, ask:null, mid:null};
    const bid = put ? upper[bidKey] - lower[askKey] : lower[bidKey] - upper[askKey];
    const ask = put ? upper[askKey] - lower[bidKey] : lower[askKey] - upper[bidKey];
    return {bid, ask, mid:(bid + ask) / 2};
  }
  function compare(debit, equivalent, direct, opposite) {
    if (debit == null || equivalent == null) return {text:"Quotes unavailable", winner:null};
    const difference = debit - equivalent;
    if (Math.abs(difference) < 0.005) return {text:"Similar quoted cost", winner:null};
    const winner = difference > 0 ? opposite : direct;
    return {text:`${winner} better by ${Math.abs(difference).toFixed(2)} pts`, winner, advantage:Math.abs(difference)};
  }
  function build(strikes, intervals) {
    if (!Number.isInteger(intervals) || intervals < 1 || intervals > 4) return [];
    const sorted = [...new Map(strikes.filter(r => Number.isFinite(r.sp)).map(r => [r.sp, r])).values()].sort((a,b) => a.sp - b.sp);
    return sorted.slice(0, Math.max(0, sorted.length - intervals)).map((lower, i) => {
      const upper = sorted[i + intervals], width = upper.sp - lower.sp;
      const call = side(lower, upper, "cBid", "cAsk", false);
      const put = side(lower, upper, "pBid", "pAsk", true);
      return {sp:lower.sp, upper:upper.sp, width, call, put,
        callOpp:put.bid == null ? null : width - put.bid,
        putOpp:call.bid == null ? null : width - call.bid,
        bullish:compare(call.ask, put.bid == null ? null : width - put.bid, "Call debit", "Put credit"),
        bearish:compare(put.ask, call.bid == null ? null : width - call.bid, "Put debit", "Call credit")};
    });
  }
  function oppClass(opp, ask) {
    if (opp == null || ask == null || Math.abs(opp - ask) < 0.005) return "spread-opp";
    return opp > ask ? "spread-opp opp-higher" : "spread-opp opp-lower";
  }
  function interpretation(result, rupees, lot) {
    if (!rupees || !result.winner) return result.text;
    if (!Number.isFinite(lot) || lot <= 0) return "Lot size unavailable · " + result.text;
    return `${result.winner} better by ₹${(result.advantage * lot).toLocaleString("en-IN", {minimumFractionDigits:2, maximumFractionDigits:2})} / lot`;
  }
  const api = {build, oppClass, interpretation};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else window.VerticalSpreads = api;
})();
