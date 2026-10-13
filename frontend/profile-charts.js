/* Interactive strike profiles using the dashboard's canvas stack. */
(() => {
  "use strict";
  class ProfileChart {
    constructor(canvas) {
      this.canvas = canvas; this.rows = []; this.hidden = new Set(); this.start = 0; this.count = 20;
      this.controls = document.createElement("div"); this.controls.className = "profile-controls";
      for (const [key, label, color] of [["ce", "Calls", "#f97583"], ["pe", "Puts", "#56d364"]]) {
        const button = document.createElement("button"); button.textContent = label; button.style.color = color;
        button.setAttribute("aria-pressed", "true");
        button.addEventListener("click", () => {
          if (this.hidden.has(key)) this.hidden.delete(key); else this.hidden.add(key);
          button.setAttribute("aria-pressed", String(!this.hidden.has(key))); this.draw();
        }); this.controls.append(button);
      }
      const reset = document.createElement("button"); reset.textContent = "Reset";
      reset.addEventListener("click", () => {this.reset(); this.draw();}); this.controls.append(reset);
      const instructions = document.createElement("p"); instructions.className = "profile-instructions";
      instructions.textContent = "Hover values · wheel to zoom · drag to pan · double-click to reset";
      canvas.before(this.controls, instructions);
      this.tooltip = document.createElement("div"); this.tooltip.className = "profile-tooltip";
      this.tooltip.setAttribute("role", "status"); canvas.after(this.tooltip);
      canvas.addEventListener("wheel", e => {
        if (!this.rows.length) return;
        e.preventDefault();
        const ratio = this.ratio(e.clientX), anchor = this.start + ratio * this.count;
        this.count = Math.min(this.rows.length, Math.max(Math.min(3,this.rows.length), Math.round(this.count * (e.deltaY > 0 ? 1.25 : .8))));
        this.start = Math.round(anchor - ratio * this.count); this.clamp(); this.draw();
      }, {passive:false});
      canvas.addEventListener("pointerdown", e => {
        if (e.button !== 0) return;
        this.drag = {x:e.clientX, start:this.start}; canvas.setPointerCapture(e.pointerId);
      });
      canvas.addEventListener("pointermove", e => {
        if (this.drag) {
          this.start = this.drag.start - Math.round((e.clientX - this.drag.x) / Math.max(1, this.canvas.getBoundingClientRect().width - 70) * this.count);
          this.clamp(); this.draw();
        }
        const index = Math.min(this.rows.length - 1, this.start + Math.min(this.count - 1, Math.floor(this.ratio(e.clientX) * this.count)));
        const row = this.rows[index]; if (!row) return;
        const value = key => Number.isFinite(row[key]) ? row[key].toLocaleString("en-IN", {maximumFractionDigits:2}) : "—";
        this.tooltip.textContent = `Strike ${row.sp}${row.sp === this.atm ? " · ATM" : ""}` +
          (!this.hidden.has("ce") ? ` · Call ${value("ce")} ${this.units}` : "") +
          (!this.hidden.has("pe") ? ` · Put ${value("pe")} ${this.units}` : "");
      });
      const end = () => {this.drag = null;};
      canvas.addEventListener("pointerup", end); canvas.addEventListener("pointercancel", end);
      canvas.addEventListener("lostpointercapture", end);
      canvas.addEventListener("pointerleave", () => {this.tooltip.textContent = "";});
      canvas.addEventListener("dblclick", () => {this.reset(); this.draw();});
    }
    ratio(x) {const r = this.canvas.getBoundingClientRect(); return Math.max(0, Math.min(.99999, (x - r.left - 58) / Math.max(1,r.width - 70)));}
    clamp() {this.start = Math.max(0, Math.min(this.start, Math.max(0,this.rows.length - this.count)));}
    reset() {
      this.count = Math.min(20, this.rows.length);
      const index = this.rows.findIndex(r => r.sp === this.atm);
      this.start = Math.max(0, index - Math.floor(this.count / 2)); this.clamp(); this.tooltip.textContent = "";
    }
    setData(rows, atm, units, symbol) {
      const changed = this.symbol !== symbol || this.rows.length !== rows.length || rows.some((r,i) => r.sp !== this.rows[i]?.sp);
      this.rows = rows.filter(r => Number.isFinite(r.sp)).sort((a,b) => a.sp - b.sp);
      this.atm = atm; this.units = units; this.symbol = symbol;
      if (changed) this.reset(); else this.clamp(); this.draw();
    }
    draw() {
      this.tooltip.textContent = "";
      const c = this.canvas, rect = c.getBoundingClientRect(), w = Math.max(1,rect.width), h = Math.max(1,rect.height);
      const dpr = window.devicePixelRatio || 1; c.width = Math.round(w*dpr); c.height = Math.round(h*dpr);
      const ctx = c.getContext("2d"); ctx.scale(dpr,dpr); ctx.clearRect(0,0,w,h);
      const rows = this.rows.slice(this.start,this.start + this.count);
      ctx.font = "10px Segoe UI"; ctx.fillStyle = "#8b949e";
      if (!rows.length || this.hidden.size === 2) {ctx.fillText(rows.length ? "Enable Calls or Puts to show data" : "No strike data", 15,35); return;}
      const values = rows.flatMap(r => ["ce","pe"].filter(k => !this.hidden.has(k)).map(k => r[k])).filter(Number.isFinite);
      let min = Math.min(0,...values), max = Math.max(0,...values); if (min === max) max = min + 1;
      const padding = (max-min)*.08; if (min<0) min-=padding; max+=padding;
      const left=58, right=12, top=18, bottom=32, cw=w-left-right, ch=h-top-bottom;
      if(cw<=0 || ch<=0) return;
      const Y = v => top + (max-v)/(max-min)*ch, zero=Y(0), step=cw/rows.length, bw=Math.min(16,step*.34);
      ctx.textAlign="right";
      for(let i=0;i<=4;i++) {
        const v=min+(max-min)*i/4,y=Y(v);ctx.strokeStyle="#2d3440";ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(w-right,y);ctx.stroke();
        ctx.fillStyle="#8b949e";ctx.fillText(Intl.NumberFormat("en-IN", {notation:"compact",maximumFractionDigits:1}).format(v),left-6,y+3);
      }
      ctx.save();ctx.beginPath();ctx.rect(left,top,cw,ch);ctx.clip();
      rows.forEach((r,i) => {
        const x=left+step*(i+.5);
        if(r.sp===this.atm){ctx.strokeStyle="#58a6ff";ctx.setLineDash([4,3]);ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,top+ch);ctx.stroke();ctx.setLineDash([]);}
        for(const [key,color,offset] of [["ce","#f97583",-bw],["pe","#56d364",0]]) {
          if(this.hidden.has(key)||!Number.isFinite(r[key]))continue;
          ctx.fillStyle=color; const y=Y(r[key]);ctx.fillRect(x+offset,Math.min(y,zero),bw,Math.max(1,Math.abs(y-zero)));
        }
      }); ctx.restore(); ctx.textAlign="center";ctx.fillStyle="#8b949e";
      const frequency = Math.max(1,Math.ceil(rows.length / Math.max(2,Math.floor(cw/65))));
      rows.forEach((r,i)=>{if(i%frequency===0)ctx.fillText(String(r.sp),left+step*(i+.5),h-10);});
      ctx.textAlign="left";ctx.fillText(this.units,left,11);
    }
  }
  window.ProfileChart = ProfileChart;
})();
