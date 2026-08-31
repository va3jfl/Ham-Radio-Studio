/* ============================================================
   Ham Radio Web Studio — FT8 module (beta)

   What works today:
   • UTC-locked 15-second slot clock
   • Continuous capture, resampled to FT8's native 12 kHz
   • Per-slot spectrogram of the 200–2500 Hz passband
   • Costas-array sync detection: finds FT8 carriers and reports
     frequency, time offset and sync strength — you can watch a
     band full of signals light up

   What's on the roadmap (and honestly labelled in the UI):
   • The 77-bit message unpack + LDPC(174,91) decode that turns a
     detected carrier into "CQ VE3ABC FN03". That's a chunky, well
     specified piece of math and it slots in right where
     _analyzeSlot() hands over its candidates.
   ============================================================ */
"use strict";

(function () {

  const SR = 12000;              // FT8 native rate
  const SYM = 1920;              // samples per symbol (0.16 s)
  const HOP = 960;               // spectrogram hop = half symbol
  const NFFT = 2048;
  const BIN_HZ = SR / NFFT;      // 5.859 Hz
  const TONE_HZ = 6.25;
  const COSTAS = [3, 1, 4, 0, 6, 5, 2];
  const SYNC_POS = [0, 36, 72];  // symbol indices of the three sync blocks
  const F_LO = 200, F_HI = 2500;
  const SLOT = 15;

  const def = {
    id: "ft8",

    init(ctx) {
      this.ctx = ctx;
      this.monitoring = false;
      this.unsub = null;
      this.slotBuf = new Float32Array(SR * SLOT);
      this.writePtr = 0;
      this.slotNum = -1;
      this.hann = DSP.hannWindow(SYM);
    },

    createPanel(el) {
      el.innerHTML = `
        <div class="mod-layout">
          <div class="mod-main">
            <div class="card">
              <header class="card-head"><h3>Slot clock</h3>
                <span class="card-tag mono" id="ft8-slotlbl">—</span></header>
              <div style="padding:14px">
                <div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap">
                  <span class="vfd" id="ft8-count" style="font-size:34px">--.-</span>
                  <span class="muted">seconds into the current 15 s cycle</span>
                </div>
                <div style="height:8px;background:#05070b;border:1px solid rgba(96,114,150,0.3);border-radius:4px;overflow:hidden;margin-top:10px">
                  <div id="ft8-slotbar" style="height:100%;width:0%;background:#45c7d6"></div>
                </div>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>Slot spectrogram · 200–2500 Hz</h3>
                <span class="card-tag mono" id="ft8-anstat">idle</span></header>
              <canvas id="ft8-spec" class="mod-canvas" width="740" height="240" style="border:none;border-radius:0"></canvas>
              <footer class="card-foot mono muted">Each column is 80 ms of the last completed slot. Amber ticks mark detected Costas sync.</footer>
            </div>
            <div class="card">
              <header class="card-head"><h3>Sync candidates</h3></header>
              <table class="band-table">
                <thead><tr><th>Freq</th><th>dT</th><th>Sync score</th><th>Status</th></tr></thead>
                <tbody id="ft8-cands"><tr><td colspan="4" class="muted">Monitoring off</td></tr></tbody>
              </table>
            </div>
          </div>
          <div class="mod-side">
            <div class="card">
              <header class="card-head"><h3>Control</h3></header>
              <div class="card-foot" style="border-top:none;display:flex;flex-direction:column;gap:10px">
                <button class="btn btn-accent" id="ft8-monitor">Start monitoring</button>
                <button class="btn" id="ft8-tune">Tune (1500 Hz, 5 s)</button>
                <button class="btn" id="ft8-test">Send loopback test signal</button>
                <button class="btn btn-danger" id="ft8-abort" disabled>Abort TX</button>
                <span class="mod-status" id="ft8-stat"></span>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>Message decode <span class="beta-flag">roadmap</span></h3></header>
              <div class="card-foot" style="border-top:none">
                <p class="mod-note">Sync detection is live — turning candidates into readable messages needs the 77-bit unpack + LDPC(174,91) soft decoder, which is next on this module's roadmap. The hook is <span class="mono">_analyzeSlot()</span> in <span class="mono">modules/ft8/module.js</span>.</p>
                <p class="mod-note" style="margin-top:10px">The test signal carries a valid Costas frame with random payload symbols so you can exercise the detector over a speaker-to-mic loop. It is <strong>not</strong> a valid FT8 message — keep it off the air.</p>
              </div>
            </div>
          </div>
        </div>`;

      const $ = (id) => el.querySelector("#" + id);
      this.ui = {
        count: $("ft8-count"), slotbar: $("ft8-slotbar"), slotlbl: $("ft8-slotlbl"),
        spec: $("ft8-spec"), anstat: $("ft8-anstat"), cands: $("ft8-cands"),
        monitor: $("ft8-monitor"), stat: $("ft8-stat"), abort: $("ft8-abort")
      };
      this.ui.monitor.addEventListener("click", () => this.monitoring ? this.stopMonitor() : this.startMonitor());
      $("ft8-tune").addEventListener("click", () => this.tune());
      $("ft8-test").addEventListener("click", () => this.sendTest());
      this.ui.abort.addEventListener("click", () => this.ctx.audio.stopTX());
    },

    onActivate() {
      this._clockTimer = setInterval(() => this._tickClock(), 100);
      this._offTxStart = this.ctx.audio.on("tx-start", () => { if (this.ui) this.ui.abort.disabled = false; });
      this._offTxEnd = this.ctx.audio.on("tx-end", () => { if (this.ui) { this.ui.abort.disabled = true; this.ui.stat.textContent = ""; } });
    },
    onDeactivate() {
      this.stopMonitor();
      clearInterval(this._clockTimer);
      if (this._offTxStart) this._offTxStart();
      if (this._offTxEnd) this._offTxEnd();
    },

    _tickClock() {
      const now = Date.now() / 1000;
      const pos = now % SLOT;
      this.ui.count.textContent = pos.toFixed(1);
      this.ui.slotbar.style.width = (pos / SLOT * 100) + "%";
      const even = Math.floor(now / SLOT) % 2 === 0;
      this.ui.slotlbl.textContent = `slot ${even ? "even (:00/:30)" : "odd (:15/:45)"}`;
    },

    /* ---------------- capture ---------------- */
    startMonitor() {
      if (!this.ctx.audio.rxActive) {
        this.ctx.log("Start audio first (top bar), then monitoring.");
        return;
      }
      this.slotBuf.fill(0);
      this.writePtr = 0;
      this.slotNum = Math.floor(Date.now() / 1000 / SLOT);
      this.unsub = this.ctx.audio.onSamples((samples, sr) => {
        const chunk = DSP.resampleLinear(samples, sr, SR);
        const nowSlot = Math.floor(Date.now() / 1000 / SLOT);
        if (nowSlot !== this.slotNum) {
          const done = this.slotBuf.slice(0, this.writePtr);
          this.slotNum = nowSlot;
          this.writePtr = 0;
          this.slotBuf.fill(0);
          if (done.length > SR * 12) setTimeout(() => this._analyzeSlot(done), 10);
        }
        const room = this.slotBuf.length - this.writePtr;
        this.slotBuf.set(room >= chunk.length ? chunk : chunk.subarray(0, room), this.writePtr);
        this.writePtr = Math.min(this.slotBuf.length, this.writePtr + chunk.length);
      });
      this.monitoring = true;
      this.ui.monitor.textContent = "Stop monitoring";
      this.ui.anstat.textContent = "waiting for slot boundary…";
      this.ctx.log("Monitoring — analysis runs at each :00/:15/:30/:45");
    },

    stopMonitor() {
      if (this.unsub) { this.unsub(); this.unsub = null; }
      this.monitoring = false;
      if (this.ui) {
        this.ui.monitor.textContent = "Start monitoring";
        this.ui.anstat.textContent = "idle";
      }
    },

    /* ---------------- analysis ---------------- */
    _analyzeSlot(buf) {
      const t0 = performance.now();
      this.ui.anstat.textContent = "analyzing…";

      const frames = Math.floor((buf.length - SYM) / HOP);
      if (frames < 60) { this.ui.anstat.textContent = "slot too short"; return; }

      const binLo = Math.floor(F_LO / BIN_HZ);
      const binHi = Math.ceil(F_HI / BIN_HZ);
      const nBins = binHi - binLo;

      // normalized log-power spectrogram, rows = time frames
      const gram = [];
      for (let f = 0; f < frames; f++) {
        const ps = DSP.powerSpectrum(buf.subarray(f * HOP, f * HOP + SYM), NFFT, this.hann);
        const row = new Float32Array(nBins);
        let mean = 0;
        for (let b = 0; b < nBins; b++) { row[b] = Math.log10(ps[binLo + b] + 1e-12); mean += row[b]; }
        mean /= nBins;
        for (let b = 0; b < nBins; b++) row[b] -= mean; // per-frame normalize
        gram.push(row);
      }

      // Costas correlation: score every (base bin, start frame) pair
      const toneBin = (t) => Math.round(t * TONE_HZ / BIN_HZ);
      const maxStart = Math.min(30, frames - 158); // allow up to ~2.4 s late start
      const candidates = [];
      for (let b = 0; b < nBins - 8; b++) {
        let best = -Infinity, bestO = 0;
        for (let o = 0; o <= Math.max(0, maxStart); o++) {
          let s = 0, cells = 0;
          for (const sp of SYNC_POS) {
            for (let k = 0; k < 7; k++) {
              const fr = o + (sp + k) * 2; // 2 hops per symbol
              if (fr >= frames) { s = -Infinity; break; }
              s += gram[fr][b + toneBin(COSTAS[k])];
              cells++;
            }
            if (s === -Infinity) break;
          }
          if (s !== -Infinity && cells === 21) {
            s /= 21;
            if (s > best) { best = s; bestO = o; }
          }
        }
        if (best > 0.55) candidates.push({ bin: b, score: best, off: bestO });
      }

      // peak-pick with 3-bin separation
      candidates.sort((a, c) => c.score - a.score);
      const picked = [];
      for (const c of candidates) {
        if (picked.every(p => Math.abs(p.bin - c.bin) > 3)) picked.push(c);
        if (picked.length >= 12) break;
      }
      picked.forEach(p => {
        p.freq = (binLo + p.bin) * BIN_HZ;
        p.dt = p.off * (HOP / SR) - 0.5;
      });

      this._drawGram(gram, picked, binLo, nBins, frames);
      this._listCandidates(picked);

      const ms = (performance.now() - t0).toFixed(0);
      this.ui.anstat.textContent = `${picked.length} candidate${picked.length === 1 ? "" : "s"} · ${ms} ms`;
      if (picked.length) this.ctx.log(`${picked.length} FT8 sync candidate(s), strongest ${picked[0].freq.toFixed(0)} Hz`);
    },

    _drawGram(gram, picked, binLo, nBins, frames) {
      const c = this.ui.spec, ctx = c.getContext("2d");
      const img = ctx.createImageData(frames, nBins);
      const px = img.data;
      for (let f = 0; f < frames; f++) {
        for (let b = 0; b < nBins; b++) {
          const v = Math.max(0, Math.min(1, (gram[f][b] + 0.6) / 2.2));
          const o = ((nBins - 1 - b) * frames + f) * 4;
          px[o] = 10 + v * 245; px[o + 1] = 14 + v * 180; px[o + 2] = 30 + v * 60; px[o + 3] = 255;
        }
      }
      // draw scaled onto the visible canvas
      const tmp = document.createElement("canvas");
      tmp.width = frames; tmp.height = nBins;
      tmp.getContext("2d").putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = "#05070b";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(tmp, 0, 0, c.width, c.height);
      // candidate ticks
      ctx.fillStyle = "#ffb454";
      for (const p of picked) {
        const y = c.height - (p.bin / nBins) * c.height;
        ctx.fillRect(0, y - 1, 8, 2);
        ctx.fillRect(c.width - 8, y - 1, 8, 2);
      }
    },

    _listCandidates(picked) {
      if (!picked.length) {
        this.ui.cands.innerHTML = `<tr><td colspan="4" class="muted">No sync found this slot</td></tr>`;
        return;
      }
      this.ui.cands.innerHTML = picked.map(p => `
        <tr>
          <td>${p.freq.toFixed(0)} Hz</td>
          <td>${p.dt >= 0 ? "+" : ""}${p.dt.toFixed(1)} s</td>
          <td>${p.score.toFixed(2)}</td>
          <td class="muted">sync ok · decode pending LDPC</td>
        </tr>`).join("");
    },

    /* ---------------- TX helpers ---------------- */
    tune() {
      const tw = new ToneWriter(SR);
      tw.keyedTone(1500, 5, 0.01);
      this.ui.stat.textContent = "tuning…";
      this.ctx.audio.playPCM(tw.result(), SR);
    },

    /* Valid Costas framing + random payload symbols: a detector
       workout for loopback tests. NOT a decodable FT8 message. */
    sendTest() {
      const symbols = new Array(79);
      for (let i = 0; i < 79; i++) symbols[i] = Math.floor(Math.random() * 8);
      for (const sp of SYNC_POS) for (let k = 0; k < 7; k++) symbols[sp + k] = COSTAS[k];

      const base = 1200 + Math.floor(Math.random() * 600);
      const tw = new ToneWriter(SR);
      const symSec = SYM / SR;
      tw.silence(0.3);
      for (const s of symbols) tw.tone(base + s * TONE_HZ, symSec);
      tw.silence(0.2);

      this.ui.stat.textContent = `test signal @ ${base} Hz (12.6 s) — loopback only`;
      this.ctx.log(`Loopback test signal @ ${base} Hz. Watch for it in the next slot analysis.`);
      this.ctx.audio.playPCM(tw.result(), SR);
    }
  };

  HRWS.registerModule(def);
})();
