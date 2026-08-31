/* ============================================================
   Ham Radio Web Studio — Propagation Oracle
   Heuristics guess; antennas know. Every 15-second FT8 slot,
   the Oracle scores your audio for structured signals — coherent
   tones standing above the noise median — on whatever band your
   rig is feeding it. Per-band history builds through the day,
   the solar dashboard's numbers ride alongside, and the verdict
   line says when your antenna and the ionosphere disagree with
   the textbook. Measurement beats prophecy; we show both.
   ============================================================ */
"use strict";
(function () {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const BANDS = ["80m", "40m", "30m", "20m", "17m", "15m", "12m", "10m", "6m"];
  /* ORCDSP-BEGIN */
  function slotScore(avgSpec) {          // structured-signal score, dB above median
    const n = avgSpec.length, s = Float32Array.from(avgSpec).sort();
    const med = s[n >> 1] + 1e-20;
    const top = [];
    for (let i = n - 1; i >= n - 20; i--) top.push(s[i]);
    const mt = top.reduce((a, b) => a + b, 0) / top.length;
    return 10 * Math.log10(mt / med);
  }
  function solarRate(band, sfi, kp, day) {
    const hi = { "6m": 28, "10m": 28, "12m": 24, "15m": 21, "17m": 18, "20m": 14, "30m": 10, "40m": 7, "80m": 3.5 }[band];
    let muf = 8 + (sfi - 65) * 0.14;                 // crude daytime F2 MUF proxy
    if (!day) muf *= 0.62;
    muf *= 1 - clamp((kp - 3) * 0.08, 0, 0.4);
    if (band === "80m" || band === "40m") return day ? (kp > 4 ? "Poor" : "Fair") : (kp > 5 ? "Poor" : "Good");
    if (muf > hi * 1.15) return "Good";
    if (muf > hi * 0.85) return "Fair";
    return "Poor";
  }
  /* ORCDSP-END */
  const SPARK = "▁▂▃▄▅▆▇█";
  const def = {
    id: "oracle",
    init(ctx) {
      this.ctx = ctx; this.ui = null; this.band = "20m"; this.on = false;
      this.hist = {}; BANDS.forEach(b => this.hist[b] = []);
      this.acc = null; this.nacc = 0; this.slot = -1;
      this.solar = null;
      this._unsub = ctx.audio.onSamples((a, sr) => this._feed(a, sr));
      this._t = setInterval(() => this._tick(), 1000);
      fetch("api/solar.php").then(r => r.json()).then(j => { this.solar = j; this._render(); }).catch(() => {});
      this._solT = setInterval(() => {
        fetch("api/solar.php").then(r => r.json()).then(j => { this.solar = j; this._render(); }).catch(() => {});
      }, 600000);
      ctx.log("Propagation Oracle ready — heuristics guess, antennas know.");
    },
    _feed(a, sr) {
      if (!this.on) return;
      const ps = DSP.powerSpectrum(a, 4096);
      const nb = Math.min(ps.length, Math.floor(3000 / (sr / 4096)));
      if (!this.acc || this.acc.length !== nb) { this.acc = new Float64Array(nb); this.nacc = 0; }
      for (let i = 0; i < nb; i++) this.acc[i] += ps[i];
      this.nacc++;
    },
    _tick() {
      const now = Date.now(), slot = Math.floor(now / 15000);
      if (slot === this.slot) return;
      if (this.slot >= 0 && this.on && this.acc && this.nacc > 3) {
        const avg = Array.from(this.acc, v => v / this.nacc);
        const sc = slotScore(avg);
        const h = this.hist[this.band];
        h.push(clamp(sc, 0, 30));
        if (h.length > 60) h.shift();
        this.acc = null; this.nacc = 0;
        this._render();
      }
      this.slot = slot;
    },
    _isDay() {
      const h = new Date().getUTCHours() + new Date().getUTCMinutes() / 60;
      // crude local-solar day from browser offset
      const lh = (h - new Date().getTimezoneOffset() / 60 + 24) % 24;
      return lh > 6.5 && lh < 19.5;
    },
    _render() {
      const u = this.ui; if (!u) return;
      const sfi = this.solar && this.solar.sfi || 120, kp = this.solar && this.solar.kp || 2;
      const day = this._isDay();
      u.sol.textContent = this.solar
        ? `SFI ${this.solar.sfi ?? "—"} · Kp ${this.solar.kp ?? "—"} · A ${this.solar.a_est ?? "—"}` +
          (this.solar.xray_class ? ` · X-ray ${this.solar.xray_class}` : "")
        : "solar: fetching…";
      let best = null, rows = "";
      for (const b of BANDS) {
        const h = this.hist[b];
        const last = h.length ? h[h.length - 1] : null;
        const spark = h.slice(-30).map(v => SPARK[clamp(Math.floor(v / 30 * 8), 0, 7)]).join("") || "·";
        const rate = solarRate(b, sfi, kp, day);
        let verdict = "no data — tune the rig here and let a few slots pass";
        if (last !== null) {
          const open = last > 9, trend = h.length > 4 ? last - h[h.length - 4] : 0;
          verdict = (open ? "measuring OPEN" : last > 5 ? "signals present" : "quiet") +
            ` (${last.toFixed(1)} dB${trend > 1.5 ? ", rising" : trend < -1.5 ? ", fading" : ""})` +
            ` · solar says ${rate}` +
            (open && rate === "Poor" ? " — antenna wins: surprise opening!" :
             !open && rate === "Good" && last < 4 ? " — heuristic optimistic here" : "");
          if (open && (!best || last > best.v)) best = { b, v: last };
        }
        rows += `<tr${b === this.band ? ' style="color:var(--amber,#ffb454)"' : ""}>` +
          `<td class="mono">${b}</td><td class="mono" style="letter-spacing:1px">${spark}</td>` +
          `<td class="mono" style="font-size:11px">${verdict}</td></tr>`;
      }
      u.tbl.innerHTML = rows;
      u.best.textContent = best ? `Best measured bet right now: ${best.b} (${best.v.toFixed(1)} dB structured signal)` :
        "Best bet: feed me a band — measurement beats prophecy.";
    },
    createPanel(el) {
      el.innerHTML = `
      <div class="mod-layout"><div class="mod-main"><div class="card">
        <header class="card-head"><h3>Propagation Oracle</h3><span class="card-tag mono" id="or-sol">solar: fetching…</span></header>
        <div class="card-body">
          <div class="mod-controls">
            <label class="field"><span>Rig is tuned to</span><select id="or-band">
              ${BANDS.map(b => `<option${b === "20m" ? " selected" : ""}>${b}</option>`).join("")}</select></label>
            <label class="field"><span>&nbsp;</span><button class="btn btn-accent" id="or-go">Start metering</button></label>
            <span class="mono muted" style="font-size:11px;align-self:center">park the rig on a band's FT8 frequency; each 15-s slot becomes one measurement</span>
          </div>
          <div class="mono" id="or-best" style="margin:10px 0;color:var(--amber,#ffb454);font-size:13px"></div>
          <table style="width:100%;border-collapse:collapse;font-size:12px"><tbody id="or-tbl"></tbody></table>
          <footer class="card-foot mono muted">The score is coherent-tone energy above the noise median — FT8 slots full of stations light it up regardless of whether you can decode them. Sparklines are the last 30 slots per band. When "measuring OPEN" argues with "solar says Poor", trust the antenna: that's sporadic-E, grayline, or the ionosphere being interesting.</footer>
        </div></div></div></div>`;
      const q = (id) => el.querySelector("#" + id);
      this.ui = { sol: q("or-sol"), band: q("or-band"), go: q("or-go"),
                  best: q("or-best"), tbl: q("or-tbl") };
      this.ui.band.addEventListener("change", () => { this.band = this.ui.band.value; this._render(); });
      this.ui.go.addEventListener("click", () => {
        this.on = !this.on;
        this.ui.go.textContent = this.on ? "Stop metering" : "Start metering";
        this.ui.go.classList.toggle("btn-accent", !this.on);
        if (this.on && !this.ctx.audio.rxActive)
          this.ctx.log("Oracle: press “Start audio” so it can hear the band.");
      });
      this._render();
    },
    onActivate() { this._render(); },
    onDeactivate() { this.on = false; this.ui = null; }
  };
  HRWS.registerModule(def);
})();
