/* ============================================================
   Ham Radio Web Studio — Hellschreiber module (Feld Hell)
   Rudolf Hell's 1929 fuzzy-mode masterpiece: text sent as
   literal pixels, keyed column by column, decoded BY EYE on a
   scrolling paper strip. There is no bit decision anywhere —
   the human is the error correction, so it degrades like
   analog: weak signals print faint and snowy, never garbled.

   Standard Feld Hell timing: 2.5 characters/second, each a
   7-column × 14-half-pixel cell → 245 half-pixels/second
   (4.0816 ms each). Columns key bottom-to-top; the receiver
   paints every column TWICE, stacked — the famous double line
   that makes asynchronous reception work: whatever your clock
   phase, one clean copy of the text is always readable.
   Glyphs keep vertical pixels in pairs (no lone half-dots),
   the traditional trick that tames the keying bandwidth.
   ============================================================ */
"use strict";

(function () {

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /* ============================================================
     HELLDSP-BEGIN — pure core (Node-testable)
     ============================================================ */
  const HELL_HPPS = 245;          // half-pixels per second
  const HELL_ROWS = 14;           // half-pixel rows per column
  const HELL_COLS = 7;            // columns per character

  /* Original 5×7 glyphs (rows top→bottom), centered in the 7-column
     cell with blank guard columns — each design row spans two
     half-pixel rows, so vertical dots always come in pairs. */
  const HELL_FONT = {
    "A":["01110","10001","10001","11111","10001","10001","10001"],
    "B":["11110","10001","10001","11110","10001","10001","11110"],
    "C":["01110","10001","10000","10000","10000","10001","01110"],
    "D":["11110","10001","10001","10001","10001","10001","11110"],
    "E":["11111","10000","10000","11110","10000","10000","11111"],
    "F":["11111","10000","10000","11110","10000","10000","10000"],
    "G":["01110","10001","10000","10111","10001","10001","01111"],
    "H":["10001","10001","10001","11111","10001","10001","10001"],
    "I":["01110","00100","00100","00100","00100","00100","01110"],
    "J":["00111","00010","00010","00010","00010","10010","01100"],
    "K":["10001","10010","10100","11000","10100","10010","10001"],
    "L":["10000","10000","10000","10000","10000","10000","11111"],
    "M":["10001","11011","10101","10101","10001","10001","10001"],
    "N":["10001","11001","10101","10011","10001","10001","10001"],
    "O":["01110","10001","10001","10001","10001","10001","01110"],
    "P":["11110","10001","10001","11110","10000","10000","10000"],
    "Q":["01110","10001","10001","10001","10101","10010","01101"],
    "R":["11110","10001","10001","11110","10100","10010","10001"],
    "S":["01111","10000","10000","01110","00001","00001","11110"],
    "T":["11111","00100","00100","00100","00100","00100","00100"],
    "U":["10001","10001","10001","10001","10001","10001","01110"],
    "V":["10001","10001","10001","10001","10001","01010","00100"],
    "W":["10001","10001","10001","10101","10101","11011","10001"],
    "X":["10001","10001","01010","00100","01010","10001","10001"],
    "Y":["10001","10001","01010","00100","00100","00100","00100"],
    "Z":["11111","00001","00010","00100","01000","10000","11111"],
    "0":["01110","10001","10011","10101","11001","10001","01110"],
    "1":["00100","01100","00100","00100","00100","00100","01110"],
    "2":["01110","10001","00001","00110","01000","10000","11111"],
    "3":["11110","00001","00001","01110","00001","00001","11110"],
    "4":["00010","00110","01010","10010","11111","00010","00010"],
    "5":["11111","10000","11110","00001","00001","10001","01110"],
    "6":["01110","10000","10000","11110","10001","10001","01110"],
    "7":["11111","00001","00010","00100","01000","01000","01000"],
    "8":["01110","10001","10001","01110","10001","10001","01110"],
    "9":["01110","10001","10001","01111","00001","00001","01110"],
    ".":["00000","00000","00000","00000","00000","01100","01100"],
    ",":["00000","00000","00000","00000","01100","00100","01000"],
    "?":["01110","10001","00001","00110","00100","00000","00100"],
    "!":["00100","00100","00100","00100","00100","00000","00100"],
    "/":["00001","00010","00010","00100","01000","01000","10000"],
    "-":["00000","00000","00000","01110","00000","00000","00000"],
    "=":["00000","00000","11111","00000","11111","00000","00000"],
    "+":["00000","00100","00100","11111","00100","00100","00000"],
    ":":["00000","01100","01100","00000","01100","01100","00000"],
    "'":["00100","00100","01000","00000","00000","00000","00000"],
    "(":["00010","00100","01000","01000","01000","00100","00010"],
    ")":["01000","00100","00010","00010","00010","00100","01000"],
    "@":["01110","10001","00001","01101","10101","10101","01110"],
    " ":["00000","00000","00000","00000","00000","00000","00000"]
  };

  /* text → array of columns; each column is a 14-bit mask,
     bit 0 = BOTTOM half-pixel (transmit order bottom→top). */
  function hellColumns(text) {
    const cols = [];
    for (const raw of String(text).toUpperCase()) {
      const g = HELL_FONT[raw] || HELL_FONT[" "];
      for (let c = 0; c < HELL_COLS; c++) {
        let mask = 0;
        if (c >= 1 && c <= 5) {                 // guard columns 0 and 6
          for (let r = 0; r < 7; r++) {
            if (g[r][c - 1] === "1") {
              const top = (6 - r) * 2;          // design row → two half-pixels
              mask |= (1 << top) | (1 << (top + 1));
            }
          }
        }
        cols.push(mask);
      }
    }
    return cols;
  }

  /* columns → shaped OOK audio. Contiguous ON half-pixels merge into
     one keyed segment with raised-cosine edges — clean spectrum. */
  function hellSynth(cols, fs, f0, edgeMs = 2, amp = 0.9) {
    const hp = fs / HELL_HPPS;
    const total = Math.ceil(cols.length * HELL_ROWS * hp) + Math.round(fs * 0.05);
    const y = new Float32Array(total);
    const edge = Math.max(4, Math.round(edgeMs / 1000 * fs));
    const w = 2 * Math.PI * f0 / fs;
    let ph = 0, pos = 0, run = -1;              // run = sample where current ON run began
    const key = (startS, endS) => {
      const n0 = Math.round(startS), n1 = Math.min(total, Math.round(endS));
      const e = Math.min(edge, Math.floor((n1 - n0) / 2));
      for (let i = n0; i < n1; i++) {
        let a = amp;
        if (i - n0 < e) a *= 0.5 - 0.5 * Math.cos(Math.PI * (i - n0) / e);
        else if (n1 - i <= e) a *= 0.5 - 0.5 * Math.cos(Math.PI * (n1 - i) / e);
        y[i] = a * Math.sin(ph + w * (i - n0));
      }
      ph = (ph + w * (n1 - n0)) % (2 * Math.PI);
    };
    for (const mask of cols) {
      for (let r = 0; r < HELL_ROWS; r++) {
        const on = (mask >> r) & 1;
        if (on && run < 0) run = pos;
        if (!on && run >= 0) { key(run, pos); run = -1; }
        pos += hp;
      }
    }
    if (run >= 0) key(run, pos);
    return y;
  }

  /* Receiver: quadrature envelope at f0 → one half-pixel sample every
     fs/245 samples → columns of 14 brightness values (0..1-ish, AGC
     left to the display). Emits columns via onColumn(Float32Array14). */
  class HellRx {
    constructor(fs, onColumn) {
      this.fs = fs; this.onColumn = onColumn;
      this.f0 = 980;
      this._retune();
      this.hp = fs / HELL_HPPS;
      this.acc = 0; this.nacc = 0; this.next = this.hp;
      this.col = new Float32Array(HELL_ROWS); this.ri = 0;
      this.n = 0;
    }
    tune(f0) { this.f0 = clamp(f0, 100, this.fs * 0.45); this._retune(); }
    _retune() {
      const w = 2 * Math.PI * this.f0 / this.fs;
      this.sr = Math.cos(w); this.si = -Math.sin(w);
      this.nr = 1; this.ni = 0;
      // one-pole I/Q low-pass ≈ 180 Hz — matched-ish to the half-pixel
      this.al = 1 - Math.exp(-2 * Math.PI * 180 / this.fs);
      this.I = 0; this.Q = 0;
    }
    process(block) {
      let nr = this.nr, ni = this.ni;
      const sr = this.sr, si = this.si, al = this.al;
      let I = this.I, Q = this.Q;
      for (let k = 0; k < block.length; k++) {
        const x = block[k];
        I += (x * nr - I) * al;
        Q += (x * ni - Q) * al;
        const t = nr * sr - ni * si; ni = nr * si + ni * sr; nr = t;
        this.acc += Math.sqrt(I * I + Q * Q); this.nacc++;
        if (++this.n >= this.next) {
          this.next += this.hp;
          this.col[this.ri++] = this.nacc ? this.acc / this.nacc : 0;
          this.acc = 0; this.nacc = 0;
          if (this.ri === HELL_ROWS) {
            this.ri = 0;
            this.onColumn(Float32Array.from(this.col));
          }
        }
      }
      const g = 1 / Math.sqrt(nr * nr + ni * ni);
      this.nr = nr * g; this.ni = ni * g; this.I = I; this.Q = Q;
    }
  }
  /* HELLDSP-END */

  /* ============================================================ */
  const def = {
    id: "hell",

    init(ctx) {
      this.ctx = ctx;
      this.ui = null;
      this.freq = 980;
      this.rx = null;
      this.decoding = false;
      this.invert = false;
      this.peak = 1e-6;                // display AGC
      this.px = 0;                     // paint cursor
      this._unsub = ctx.audio.onSamples((a, sr) => {
        if (!this.decoding) return;
        if (!this.rx || this.rx.fs !== sr) {
          this.rx = new HellRx(sr, (col) => this._paintColumn(col));
          this.rx.tune(this.freq);
        }
        this.rx.process(a);
      });
      this._untune = ctx.onTune((f) => {
        this.freq = Math.round(f);
        if (this.ui) this.ui.freq.value = this.freq;
        if (this.rx) this.rx.tune(this.freq);
        this._marker();
      });
      ctx.log("Hellschreiber ready — 1929's fuzzy mode: your eyes are the decoder.");
    },

    _marker() {
      this.ctx.setMarker({ freq: this.freq, color: "#ffd166", label: "HELL" });
    },

    createPanel(el) {
      const call = this.ctx.settings().callsign || "N0CALL";
      el.innerHTML = `
      <style>
        .hl-paper { width:100%; height:150px; display:block; background:#f4efe4; border-radius:8px;
          border:1px solid var(--line,rgba(96,114,150,.22)); image-rendering:pixelated; }
        .hl-note { font-size:12px; line-height:1.55; color:var(--muted,#8b95a7); }
      </style>
      <div class="mod-layout">
        <div class="mod-main">
          <div class="card">
            <header class="card-head"><h3>Receive — the paper strip</h3>
              <span class="card-tag mono" id="hl-rx-tag">idle</span></header>
            <div class="card-body">
              <canvas class="hl-paper" id="hl-paper" width="1100" height="150"></canvas>
              <div class="mod-controls" style="margin-top:10px">
                <label class="field"><span>Tone (Hz)</span>
                  <input type="number" id="hl-freq" min="300" max="3000" step="10" value="980" style="width:100px"></label>
                <label class="field"><span>&nbsp;</span>
                  <button class="btn btn-accent" id="hl-start">Start decoder</button></label>
                <label class="field"><span>&nbsp;</span>
                  <button class="btn" id="hl-clear">Clear paper</button></label>
                <label class="field"><span>Contrast <em id="hl-con-val">1.4</em></span>
                  <input type="range" id="hl-con" min="8" max="40" value="14"></label>
                <label class="mono muted" style="font-size:12px;align-self:flex-end"><input type="checkbox" id="hl-inv"> invert scan</label>
              </div>
              <footer class="card-foot mono muted">Click the waterfall on a Hell signal — text prints twice, stacked; read whichever copy your clock phase aligned. Faint and snowy at low signal is the mode working, not failing.</footer>
            </div>
          </div>
          <div class="card">
            <header class="card-head"><h3>Transmit</h3><span class="card-tag mono" id="hl-tx-tag">idle</span></header>
            <div class="card-body">
              <div class="mod-controls">
                <label class="field" style="flex:1;min-width:260px"><span>Text <em class="muted" id="hl-dur"></em></span>
                  <input type="text" id="hl-text" class="mono" maxlength="120" value="CQ CQ DE ${call} ${call} K"></label>
                <label class="field"><span>Edges</span>
                  <select id="hl-edge"><option value="2" selected>soft (clean)</option><option value="0.4">hard (classic)</option></select></label>
                <label class="field"><span>&nbsp;</span><button class="btn btn-accent" id="hl-send">Send</button></label>
                <label class="field"><span>&nbsp;</span><button class="btn btn-danger" id="hl-stop" disabled>Stop</button></label>
                <label class="field"><span>SNR (dB)</span><input type="number" id="hl-snr" value="6" min="-6" max="30" step="1" style="width:70px"></label>
                <label class="field"><span>&nbsp;</span><button class="btn" id="hl-self">Loopback test</button></label>
              </div>
              <footer class="card-foot mono muted">Standard Feld Hell: 2.5 characters/second, 245 half-pixels/second — timing-compatible with any Hell software; the font is just what your pixels look like.</footer>
            </div>
          </div>
        </div>
        <div class="mod-side">
          <div class="card">
            <header class="card-head"><h3>Why Hell is special</h3></header>
            <div class="card-body hl-note">
              Invented by Rudolf Hell in 1929 and used for decades of press and field traffic,
              Hellschreiber sends no codes — it sends the <b>shape of the letters</b>, one pixel
              column at a time. Your eye does the decoding, and eyes are magnificent error
              correctors: through static and fading the text goes grey and fuzzy but stays
              readable long after coded modes give up. The double line isn't a bug — with no
              synchronization at all, printing everything twice guarantees one aligned copy.
              Machines from the 1930s and this browser tab speak the same 245 pixels per second.
            </div>
          </div>
        </div>
      </div>`;

      const q = (id) => el.querySelector("#" + id);
      const ui = this.ui = {
        paper: q("hl-paper"), rxTag: q("hl-rx-tag"), freq: q("hl-freq"),
        start: q("hl-start"), clear: q("hl-clear"), con: q("hl-con"), conVal: q("hl-con-val"),
        inv: q("hl-inv"), txTag: q("hl-tx-tag"), text: q("hl-text"), dur: q("hl-dur"),
        edge: q("hl-edge"), send: q("hl-send"), stop: q("hl-stop"), self: q("hl-self"), snr: q("hl-snr")
      };
      const g = ui.paper.getContext("2d");
      g.fillStyle = "#f4efe4"; g.fillRect(0, 0, ui.paper.width, ui.paper.height);
      this.px = 0;

      ui.freq.addEventListener("change", () => {
        this.freq = clamp(parseInt(ui.freq.value, 10) || 980, 300, 3000);
        if (this.rx) this.rx.tune(this.freq);
        this._marker();
      });
      ui.start.addEventListener("click", () => {
        this.decoding = !this.decoding;
        ui.start.textContent = this.decoding ? "Stop decoder" : "Start decoder";
        ui.start.classList.toggle("btn-accent", !this.decoding);
        ui.rxTag.textContent = this.decoding ? `printing · ${this.freq} Hz` : "idle";
        if (this.decoding) {
          this._marker();
          if (!this.ctx.audio.rxActive) this.ctx.log("Hell: press “Start audio” in the sidebar so the printer has an input.");
        }
      });
      ui.clear.addEventListener("click", () => {
        g.fillStyle = "#f4efe4"; g.fillRect(0, 0, ui.paper.width, ui.paper.height);
        this.px = 0; this.peak = 1e-6;
      });
      ui.con.addEventListener("input", () => { ui.conVal.textContent = (ui.con.value / 10).toFixed(1); });
      ui.inv.addEventListener("change", () => { this.invert = ui.inv.checked; });

      const durTxt = () => {
        const s = ui.text.value.length / 2.5;
        ui.dur.textContent = "≈ " + (s >= 90 ? (s / 60).toFixed(1) + " min" : Math.round(s) + " s");
      };
      ui.text.addEventListener("input", durTxt); durTxt();

      ui.send.addEventListener("click", async () => {
        const fs = this.ctx.audio.ensureContext().sampleRate;
        const cols = hellColumns(ui.text.value);
        const y = hellSynth(cols, fs, this.freq, parseFloat(ui.edge.value));
        ui.send.disabled = true; ui.stop.disabled = false;
        ui.txTag.textContent = `sending · ${this.freq} Hz`;
        this.ctx.log(`Hell sending "${ui.text.value}" (${(cols.length / HELL_COLS / 2.5).toFixed(0)} s).`);
        await this.ctx.audio.playPCM(y, fs);
        ui.send.disabled = false; ui.stop.disabled = true;
        ui.txTag.textContent = "idle";
      });
      ui.stop.addEventListener("click", () => {
        this.ctx.audio.stopTX();
        this.ctx.log("Hell transmission stopped.");
      });

      ui.self.addEventListener("click", () => {
        const fs = this.ctx.audio.sampleRate;
        const y = hellSynth(hellColumns("HELL 73"), fs, this.freq, 2);
        const snrDb = clamp(parseFloat(ui.snr.value) || 6, -6, 30);
        let sp = 0; for (let i = 0; i < y.length; i++) sp += y[i] * y[i]; sp /= y.length;
        const nAmp = Math.sqrt(sp / Math.pow(10, snrDb / 10) * (fs / 2) / 350);
        for (let i = 0; i < y.length; i++) y[i] += nAmp * (Math.random() + Math.random() + Math.random() - 1.5) * 0.82;
        const rx = new HellRx(fs, (c) => this._paintColumn(c));
        rx.tune(this.freq);
        const was = this.decoding; this.decoding = true;
        for (let i = 0; i < y.length; i += 4096) rx.process(y.subarray(i, Math.min(i + 4096, y.length)));
        this.decoding = was;
        this.ctx.log("Hell self-test: 'HELL 73' printed straight onto the paper — no audio, pure math.");
      });
    },

    /* paint one 14-value column, doubled (the famous two lines) */
    _paintColumn(col) {
      const ui = this.ui; if (!ui) return;
      const g = ui.paper.getContext("2d");
      const W = ui.paper.width, H = ui.paper.height;
      const cw = 4, chp = Math.floor(H / (HELL_ROWS * 2));   // column width px, half-pixel height px
      let mx = 0;
      for (let i = 0; i < HELL_ROWS; i++) if (col[i] > mx) mx = col[i];
      this.peak = Math.max(mx, this.peak * 0.999);
      const gain = (this.ui.con ? this.ui.con.value / 10 : 1.4) / (this.peak || 1e-6);
      if (this.px + cw > W) {                                 // scroll the paper
        g.drawImage(ui.paper, cw, 0, W - cw, H, 0, 0, W - cw, H);
        g.fillStyle = "#f4efe4"; g.fillRect(W - cw, 0, cw, H);
        this.px = W - cw;
      }
      for (let r = 0; r < HELL_ROWS; r++) {
        const v = clamp(col[r] * gain, 0, 1);
        const shade = Math.round(244 - v * 214);              // paper → ink
        g.fillStyle = `rgb(${shade},${Math.round(shade * 0.97)},${Math.round(shade * 0.9)})`;
        const row = this.invert ? r : (HELL_ROWS - 1 - r);    // bottom-to-top scan
        g.fillRect(this.px, row * chp, cw, chp);              // upper copy
        g.fillRect(this.px, (row + HELL_ROWS) * chp, cw, chp);// lower copy
      }
      this.px += cw;
    },

    onActivate() { this._marker(); },
    onDeactivate() {
      this.decoding = false;
      if (this.ui) { this.ui.start.textContent = "Start decoder"; }
      this.ui = null;
    }
  };

  HRWS.registerModule(def);
})();
