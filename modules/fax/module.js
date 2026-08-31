/* ============================================================
   Ham Radio Web Studio — Fax module
   Radiofax (WEFAX): weather charts have crossed oceans as an FM
   subcarrier since the 1950s — black 1500 Hz, white 2300 Hz,
   120 lines per minute, no per-line sync: just a start tone,
   phasing pulses, then trust in a good clock. Its phone-line
   twin is Group 1 analog fax (ITU T.2, 1300/2100 Hz, 180 LPM) —
   the machine offices had before G3's digital modems. Both live
   here, plus a wideband direct-wire preset for fun.
   ============================================================ */
"use strict";

(function () {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const PRESETS = {
    "WEFAX 576 (HF weather)": { fb: 1500, fw: 2300, lpm: 120, start: 300, stop: 450 },
    "WEFAX 288":              { fb: 1500, fw: 2300, lpm: 60,  start: 675, stop: 450 },
    "G1 phone fax (T.2)":     { fb: 1300, fw: 2100, lpm: 180, start: 300, stop: 450 },
    "Wideband wire fax":      { fb: 4000, fw: 12000, lpm: 960, start: 300, stop: 450 }
  };

  /* FAXDSP-BEGIN */
  class FaxRx {
    /* quadrature FM discriminator → pixel accumulator → lines */
    constructor(fs, cfg, pxPerLine, onLine, onTone) {
      this.fs = fs; this.cfg = cfg; this.px = pxPerLine;
      this.onLine = onLine; this.onTone = onTone || (() => {});
      const fc = (cfg.fb + cfg.fw) / 2;
      const w = 2 * Math.PI * fc / fs;
      this.sr = Math.cos(w); this.si = -Math.sin(w); this.nr = 1; this.ni = 0;
      this.al = 1 - Math.exp(-2 * Math.PI * Math.abs(cfg.fw - cfg.fb) * 0.7 / fs);
      this.I = 0; this.Q = 0; this.pI = 1; this.pQ = 0;
      this.fc = fc; this.kv = 1 / (cfg.fw - cfg.fb);
      this.spl = fs * 60 / cfg.lpm;                 // samples per line (fractional)
      this.ppm = 0;
      this.acc = 0; this.na = 0; this.cur = 0; this.next = this.spl / this.px;
      this.line = new Float32Array(pxPerLine); this.li = 0;
      // tone watch: decimated val stream @2 kHz, Goertzel every 0.25 s
      this.td = Math.max(1, Math.round(fs / 2000)); this.tc = 0; this.ta = 0;
      this.tv = new Float32Array(512); this.ti = 0;
    }
    setPpm(p) { this.ppm = p; }
    nudge(px) { this.cur -= px * (this.spl / this.px); }
    process(block) {
      let nr = this.nr, ni = this.ni, I = this.I, Q = this.Q, pI = this.pI, pQ = this.pQ;
      const al = this.al, sr = this.sr, si = this.si;
      const splEff = this.spl * (1 + this.ppm * 1e-6);
      const spp = splEff / this.px;
      for (let i = 0; i < block.length; i++) {
        const x = block[i];
        I += (x * nr - I) * al; Q += (x * ni - Q) * al;
        const t = nr * sr - ni * si; ni = nr * si + ni * sr; nr = t;
        const cross = I * pQ - Q * pI, dot = I * pI + Q * pQ;
        pI = I; pQ = Q;
        const df = Math.atan2(cross, dot) * this.fs / (2 * Math.PI);
        let v = clamp(((this.fc - df) - this.cfg.fb) * this.kv, 0, 1);
        if (this.cfg.invert) v = 1 - v;
        this.acc += v; this.na++;
        this.ta += v;
        if (++this.tc === this.td) {
          this.tv[this.ti] = this.ta / this.td; this.ti = (this.ti + 1) % 512;
          this.ta = 0; this.tc = 0;
          if (this.ti === 0) this._tones();
        }
        if (++this.cur >= this.next) {
          this.next += spp;
          this.line[this.li++] = this.na ? this.acc / this.na : 0;
          this.acc = 0; this.na = 0;
          if (this.li >= this.px) {
            this.li = 0;
            this.onLine(Float32Array.from(this.line));
          }
        }
      }
      const g = 1 / Math.sqrt(nr * nr + ni * ni);
      this.nr = nr * g; this.ni = ni * g;
      this.I = I; this.Q = Q; this.pI = pI; this.pQ = pQ;
    }
    _tones() {                                       // 512 samples @2 kHz = 0.256 s
      const pw = (f) => {
        const w = 2 * Math.PI * f / 2000; let c = 2 * Math.cos(w), s1 = 0, s2 = 0;
        for (let i = 0; i < 512; i++) { const s0 = this.tv[i] + c * s1 - s2; s2 = s1; s1 = s0; }
        return s1 * s1 + s2 * s2 - c * s1 * s2;
      };
      let tot = 0, mean = 0;
      for (let i = 0; i < 512; i++) mean += this.tv[i];
      mean /= 512;
      for (let i = 0; i < 512; i++) { const d = this.tv[i] - mean; tot += d * d; }
      if (tot < 1e-4) return;
      const s = pw(this.cfg.start) / (tot * 256), e = pw(this.cfg.stop) / (tot * 256);
      if (s > 0.5) this.onTone("start");
      else if (e > 0.5) this.onTone("stop");
    }
  }

  /* TX: freq staircase, phase-continuous — start tone, phasing, rows, stop */
  function faxSynth(rows, fs, cfg, opts) {
    const o = opts || {};
    const spl = fs * 60 / cfg.lpm, px = rows[0].length, spp = spl / px;
    const segs = [];
    const sq = (f, sec) => { const T = 1 / (2 * f);            // start/stop = b/w square
      for (let t = 0; t < sec; t += 2 * T) { segs.push([cfg.fw, T]); segs.push([cfg.fb, T]); } };
    sq(cfg.start, o.startSec === undefined ? 3 : o.startSec);
    const nPh = Math.round((o.phasingSec === undefined ? 4 : o.phasingSec) * cfg.lpm / 60);
    for (let l = 0; l < nPh; l++) {                            // white line, 5 % black at start
      segs.push([cfg.fb, spl * 0.05 / fs]); segs.push([cfg.fw, spl * 0.95 / fs]);
    }
    let n = 0;
    for (const s of segs) n += Math.round(s[1] * fs);
    const total = n + Math.ceil(rows.length * spl) + Math.round(3 * fs) + fs;
    const y = new Float32Array(total);
    let ph = 0, pos = 0;
    const tone = (f, ns) => { const w = 2 * Math.PI * f / fs;
      for (let i = 0; i < ns && pos < total; i++) { ph += w; y[pos++] = 0.7 * Math.sin(ph); } };
    for (const s of segs) tone(s[0], Math.round(s[1] * fs));
    for (const row of rows) {
      let cur = 0;
      for (let p = 0; p < px; p++) {
        const a = Math.round(cur); cur += spp; const b = Math.round(cur);
        const v = cfg.invert ? 1 - row[p] : row[p];
        tone(cfg.fb + v * (cfg.fw - cfg.fb), b - a);
      }
    }
    const T2 = 1 / (2 * cfg.stop);
    for (let t = 0; t < 3; t += 2 * T2) { tone(cfg.fw, Math.round(T2 * fs)); tone(cfg.fb, Math.round(T2 * fs)); }
    return y.subarray(0, pos);
  }
  function faxTestPage(px, lines) {
    const rows = [];
    for (let l = 0; l < lines; l++) {
      const r = new Float32Array(px);
      for (let i = 0; i < px; i++) {
        const u = i / px;
        if (l < lines * 0.2) r[i] = u;                                   // gradient
        else if (l < lines * 0.4) r[i] = (i >> 5) & 1 ? 1 : 0;           // bars
        else if (l < lines * 0.6) r[i] = ((i >> 4) ^ (l >> 2)) & 1;      // checker
        else if (l < lines * 0.8) r[i] = Math.abs(u - (l % 40) / 40) < 0.01 ? 0 : 1; // diagonal
        else r[i] = (Math.sin(u * 40 * Math.PI) > 0) === ((l & 4) > 0) ? 1 : 0;
      }
      rows.push(r);
    }
    return rows;
  }
  /* FAXDSP-END */

  const def = {
    id: "fax",
    init(ctx) {
      this.ctx = ctx; this.ui = null;
      this.preset = "WEFAX 576 (HF weather)";
      this.rx = null; this.on = false; this.auto = true; this.y = 0;
      this._unsub = ctx.audio.onSamples((a, sr) => {
        if (!this.on) return;
        if (!this.rx || this.rx.fs !== sr) this._mk(sr);
        this.rx.process(a);
      });
      ctx.log("Fax ready — weather charts by radio, and the phone fax your office had before modems.");
    },
    _cfg() { const p = { ...PRESETS[this.preset] };
      p.invert = this.ui && this.ui.inv.checked; return p; },
    _mk(sr) {
      this.rx = new FaxRx(sr, this._cfg(), 1024,
        (line) => this._line(line),
        (tone) => this._tone(tone));
      this.rx.setPpm(this.ui ? parseInt(this.ui.ppm.value, 10) : 0);
    },
    _tone(t) {
      if (!this.auto) return;
      if (t === "start" && !this.printing) { this.printing = true; this.ctx.log("Fax: start tone — printing."); }
      if (t === "stop" && this.printing) { this.printing = false; this.ctx.log("Fax: stop tone — page complete."); }
      if (this.ui) this.ui.tag.textContent = this.printing ? "printing" : "armed";
    },
    _line(vals) {
      if (this.auto && !this.printing) return;
      const cv = this.ui && this.ui.cv; if (!cv) return;
      const g = cv.getContext("2d");
      if (this.y >= cv.height) {                       // scroll the paper
        g.drawImage(cv, 0, 2, cv.width, cv.height - 2, 0, 0, cv.width, cv.height - 2);
        this.y = cv.height - 2;
      }
      const img = g.createImageData(cv.width, 2);
      for (let x = 0; x < cv.width; x++) {
        const v = Math.round(vals[Math.floor(x / cv.width * vals.length)] * 255);
        for (let r2 = 0; r2 < 2; r2++) {
          const p = (r2 * cv.width + x) * 4;
          img.data[p] = img.data[p + 1] = img.data[p + 2] = v; img.data[p + 3] = 255;
        }
      }
      g.putImageData(img, 0, this.y); this.y += 2;
    },
    createPanel(el) {
      el.innerHTML = `
      <div class="mod-layout"><div class="mod-main">
        <div class="card">
          <header class="card-head"><h3>Fax printer</h3><span class="card-tag mono" id="fx-tag">off</span></header>
          <div class="card-body">
            <div class="mod-controls">
              <label class="field"><span>Preset</span><select id="fx-preset">
                ${Object.keys(PRESETS).map(k => `<option>${k}</option>`).join("")}</select></label>
              <label class="field"><span>Slant <em id="fx-ppm-val">0 ppm</em></span>
                <input type="range" id="fx-ppm" min="-300" max="300" value="0"></label>
              <label class="field"><span>Phase</span><span>
                <button class="btn btn-mini" id="fx-nl">◀◀</button><button class="btn btn-mini" id="fx-nl1">◀</button>
                <button class="btn btn-mini" id="fx-nr1">▶</button><button class="btn btn-mini" id="fx-nr">▶▶</button></span></label>
              <label class="field" style="min-width:0"><span>&nbsp;</span>
                <label class="mono muted" style="font-size:12px"><input type="checkbox" id="fx-auto" checked> auto start/stop tones</label></label>
              <label class="field" style="min-width:0"><span>&nbsp;</span>
                <label class="mono muted" style="font-size:12px"><input type="checkbox" id="fx-inv"> invert</label></label>
              <label class="field"><span>&nbsp;</span><button class="btn btn-accent" id="fx-go">Start RX</button></label>
              <label class="field"><span>&nbsp;</span><button class="btn" id="fx-save">Save PNG</button></label>
              <label class="field"><span>&nbsp;</span><button class="btn" id="fx-clear">Clear</button></label>
            </div>
            <canvas id="fx-cv" width="1024" height="700" style="width:100%;margin-top:10px;background:#e9e6dc;border-radius:8px"></canvas>
            <footer class="card-foot mono muted">Fax free-runs between phasing pulses — the slant slider is your soundcard's honesty knob (WEFAX charts lean when clocks disagree by parts-per-million). Auto mode arms on the start tone and rests on the stop tone.</footer>
          </div>
        </div>
        <div class="card">
          <header class="card-head"><h3>Transmit</h3></header>
          <div class="card-body"><div class="mod-controls">
            <label class="field"><span>&nbsp;</span><button class="btn btn-accent" id="fx-tx">Send test page</button></label>
            <label class="field"><span>&nbsp;</span><button class="btn btn-danger" id="fx-txstop">Stop</button></label>
            <label class="field"><span>SNR (dB)</span><input type="number" id="fx-snr" value="18" min="0" max="40" step="1" style="width:70px"></label>
            <label class="field"><span>&nbsp;</span><button class="btn" id="fx-self">Loopback test</button></label>
          </div>
          <footer class="card-foot mono muted">The test page carries gradients, bars and diagonals — everything a slant or phase error loves to expose. Self-test prints it straight to the paper through pure math.</footer></div>
        </div>
      </div>
      <div class="mod-side"><div class="card">
        <header class="card-head"><h3>Catching real charts</h3></header>
        <div class="card-body" style="font-size:12px;line-height:1.55;color:var(--muted,#8b95a7)">
          Coastal stations still transmit weather charts on HF — tune your radio in <b>USB,
          1.9 kHz below</b> the listed frequency so black lands on 1500 Hz. Classics: Boston
          (NMF) 6340.5/9110, New Orleans (NMG) 8503.9, Pt. Reyes (NMC) 8682, Northwood (UK),
          DWD Pinneberg 7880. Charts run ~10 minutes at 120 LPM. The <b>G1 preset</b> reads the
          analog phone fax of the pre-modem era, and the wideband preset is for wire-to-wire
          play between two studios.
        </div>
      </div></div></div>`;
      const q = (id) => el.querySelector("#" + id);
      const ui = this.ui = { tag: q("fx-tag"), preset: q("fx-preset"), ppm: q("fx-ppm"),
        ppmVal: q("fx-ppm-val"), auto: q("fx-auto"), inv: q("fx-inv"), go: q("fx-go"),
        save: q("fx-save"), clear: q("fx-clear"), cv: q("fx-cv"),
        tx: q("fx-tx"), txstop: q("fx-txstop"), self: q("fx-self"), snr: q("fx-snr") };
      const g = ui.cv.getContext("2d");
      g.fillStyle = "#e9e6dc"; g.fillRect(0, 0, ui.cv.width, ui.cv.height);
      ui.preset.addEventListener("change", () => { this.preset = ui.preset.value; this.rx = null; });
      ui.inv.addEventListener("change", () => { this.rx = null; });
      ui.ppm.addEventListener("input", () => { ui.ppmVal.textContent = ui.ppm.value + " ppm";
        if (this.rx) this.rx.setPpm(parseInt(ui.ppm.value, 10)); });
      ui.auto.addEventListener("change", () => { this.auto = ui.auto.checked;
        if (!this.auto) this.printing = true; });
      [["fx-nl", -32], ["fx-nl1", -4], ["fx-nr1", 4], ["fx-nr", 32]].forEach(([id, n]) =>
        q(id).addEventListener("click", () => { if (this.rx) this.rx.nudge(n); }));
      ui.go.addEventListener("click", () => {
        this.on = !this.on;
        this.printing = !this.auto;
        ui.go.textContent = this.on ? "Stop RX" : "Start RX";
        ui.go.classList.toggle("btn-accent", !this.on);
        ui.tag.textContent = this.on ? (this.auto ? "armed" : "printing") : "off";
        if (this.on && !this.ctx.audio.rxActive)
          this.ctx.log("Fax: press “Start audio” in the sidebar so the printer has an input.");
      });
      ui.save.addEventListener("click", () => {
        ui.cv.toBlob((b) => { const a = document.createElement("a");
          a.href = URL.createObjectURL(b);
          a.download = "fax_" + new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-") + ".png";
          a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); });
      });
      ui.clear.addEventListener("click", () => {
        g.fillStyle = "#e9e6dc"; g.fillRect(0, 0, ui.cv.width, ui.cv.height); this.y = 0; });
      ui.tx.addEventListener("click", async () => {
        const fs = this.ctx.audio.ensureContext().sampleRate;
        const cfg = this._cfg();
        if (cfg.fw > fs * 0.45) { this.ctx.log("Fax TX: this preset needs a wider device rate."); return; }
        const y = faxSynth(faxTestPage(512, 240), fs, cfg, {});
        this.ctx.log(`Fax sending test page (${(y.length / fs).toFixed(0)} s at ${cfg.lpm} LPM).`);
        await this.ctx.audio.playPCM(y, fs);
      });
      ui.txstop.addEventListener("click", () => this.ctx.audio.stopTX());
      ui.self.addEventListener("click", () => {
        const fs = 24000, cfg = this._cfg();
        const y = faxSynth(faxTestPage(512, 200), fs, cfg, { startSec: 1, phasingSec: 1 });
        const snrDb = clamp(parseFloat(ui.snr.value) || 18, 0, 40);
        let sp = 0; for (let i = 0; i < y.length; i++) sp += y[i] * y[i]; sp /= y.length;
        const nAmp = Math.sqrt(sp / Math.pow(10, snrDb / 10) * (fs / 2) / ((cfg.fw - cfg.fb) * 1.5));
        for (let i = 0; i < y.length; i++) y[i] += nAmp * (Math.random() + Math.random() + Math.random() - 1.5) * 0.82;
        const rx = new FaxRx(fs, cfg, 1024, (l) => this._line(l), () => {});
        const was = { on: this.on, pr: this.printing };
        this.printing = true; this.on = false;
        for (let i = 0; i < y.length; i += 8192) rx.process(y.subarray(i, Math.min(i + 8192, y.length)));
        this.printing = was.pr;
        this.ctx.log("Fax self-test: test page printed through the real demodulator — pure math.");
      });
    },
    onActivate() {}, onDeactivate() { this.on = false; this.ui = null; }
  };
  HRWS.registerModule(def);
})();
