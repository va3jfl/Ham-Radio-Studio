/* ============================================================
   Ham Radio Web Studio — Channel Lab
   An ionosonde in a browser tab: transmit a one-second chirp,
   matched-filter what comes back, and the channel confesses its
   impulse response — one peak per path. Two skywave hops draw
   as two spikes milliseconds apart; flutter smears them; a wire
   draws a single clean needle. This is the instrument that lets
   you SEE what the conditions simulator (and the real sky) does
   to every other mode in this studio.
   ============================================================ */
"use strict";
(function () {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  /* CHDSP-BEGIN */
  const CFS = 12000, CT = 1.0, CF1 = 300, CF2 = 2700;
  function makeChirp() {
    const n = Math.round(CFS * CT), y = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const f = CF1 + (CF2 - CF1) * i / n;
      ph += 2 * Math.PI * f / CFS;
      let a = 0.8;
      const e = Math.round(0.01 * CFS);
      if (i < e) a *= 0.5 - 0.5 * Math.cos(Math.PI * i / e);
      else if (n - i <= e) a *= 0.5 - 0.5 * Math.cos(Math.PI * (n - i) / e);
      y[i] = a * Math.sin(ph);
    }
    return y;
  }
  function chirpIR(rx) {                 // rx: Float32Array @12 kHz, ≥ chirp+spread
    const ref = makeChirp();
    const N = 1 << Math.ceil(Math.log2(rx.length + ref.length));
    const ar = new Float64Array(N), ai = new Float64Array(N);
    const br = new Float64Array(N), bi = new Float64Array(N);
    ar.set(rx);
    for (let i = 0; i < ref.length; i++)                 // Hann-weighted matched filter:
      br[i] = ref[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / ref.length));   // sidelobes → −31 dB
    DSP.fft(ar, ai); DSP.fft(br, bi);
    for (let i = 0; i < N; i++) {        // A · conj(B)
      const r = ar[i] * br[i] + ai[i] * bi[i];
      const im = ai[i] * br[i] - ar[i] * bi[i];
      ar[i] = r; ai[i] = im;
    }
    for (let i = 0; i < N; i++) ai[i] = -ai[i];      // inverse via conj trick
    DSP.fft(ar, ai);
    const mag = new Float64Array(rx.length);
    let pk = 0, pki = 0;
    for (let i = 0; i < rx.length; i++) {
      mag[i] = Math.sqrt(ar[i] * ar[i] + ai[i] * ai[i]);
      if (mag[i] > pk) { pk = mag[i]; pki = i; }
    }
    // window 20 ms after the main arrival, normalized dB
    const W = Math.round(0.020 * CFS);
    const ir = new Float64Array(W);
    for (let i = 0; i < W; i++) ir[i] = 20 * Math.log10((mag[pki + i] || 1e-12) / pk);
    // taps: greedy peaks above −16 dB (below that lives the windowed-chirp sidelobe floor) with a ±0.35 ms exclusion zone
    const taps = [], excl = Math.round(0.0006 * CFS);
    const used = new Uint8Array(W);
    for (let k = 0; k < 6; k++) {
      let bi = -1, bv = -16;
      for (let i = 0; i < W; i++) if (!used[i] && ir[i] > bv) { bv = ir[i]; bi = i; }
      if (bi < 0) break;
      taps.push({ i: bi, ms: bi / CFS * 1000, db: ir[bi] });
      for (let i = Math.max(0, bi - excl); i < Math.min(W, bi + excl + 1); i++) used[i] = 1;
    }
    taps.sort((a, b) => a.i - b.i);
    // RMS delay spread over taps
    let p = 0, m1 = 0;
    for (const t of taps) { const w = Math.pow(10, t.db / 10); p += w; m1 += w * t.ms; }
    m1 /= p || 1;
    let m2 = 0;
    for (const t of taps) m2 += Math.pow(10, t.db / 10) * (t.ms - m1) * (t.ms - m1);
    const spread = Math.sqrt(m2 / (p || 1));
    return { ir, taps, spread, snr: 20 * Math.log10(pk / (median(mag) + 1e-12)) };
  }
  function median(a) { const s = Float64Array.from(a).sort(); return s[s.length >> 1]; }
  /* CHDSP-END */
  const def = {
    id: "chanlab",
    init(ctx) {
      this.ctx = ctx; this.ui = null; this.armed = false;
      this.buf = null; this.bn = 0; this.dec = 1; this.da = 0; this.dk = 0;
      this._unsub = ctx.audio.onSamples((a, sr) => {
        if (!this.armed) return;
        this.dec = Math.max(1, Math.round(sr / CFS));
        for (let i = 0; i < a.length; i++) {
          this.da += a[i];
          if (++this.dk === this.dec) {
            this.dk = 0;
            if (this.bn < this.buf.length) this.buf[this.bn++] = this.da / this.dec;
            this.da = 0;
          }
        }
        if (this.bn >= this.buf.length) { this.armed = false; this._analyze(this.buf); }
      });
      ctx.log("Channel Lab ready — chirp the channel and it confesses its impulse response.");
    },
    _analyze(rx) {
      const r = chirpIR(rx);
      const u = this.ui; if (!u) return;
      u.tag.textContent = "done";
      u.out.textContent = `arrival SNR ${r.snr.toFixed(0)} dB · ${r.taps.length} path${r.taps.length === 1 ? "" : "s"} · ` +
        `RMS delay spread ${r.spread.toFixed(2)} ms\n` +
        r.taps.map(t => `  path @ ${t.ms.toFixed(2)} ms  ${t.db.toFixed(1)} dB`).join("\n");
      const cv = u.cv, g = cv.getContext("2d");
      g.fillStyle = "#0a0e14"; g.fillRect(0, 0, cv.width, cv.height);
      g.strokeStyle = "#45c7d6"; g.beginPath();
      for (let x = 0; x < cv.width; x++) {
        const i = Math.floor(x / cv.width * r.ir.length);
        const y = clamp(-r.ir[i] / 40, 0, 1) * (cv.height - 18) + 4;
        x ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
      g.fillStyle = "#ffb454"; g.font = "10px 'IBM Plex Mono', monospace";
      for (const t of r.taps) {
        const x = t.i / r.ir.length * cv.width;
        g.fillRect(x, 4, 1, cv.height - 22);
        g.fillText(t.ms.toFixed(1) + "ms", x + 3, 14);
      }
      g.fillStyle = "#8b95a7";
      g.fillText("0", 2, cv.height - 4); g.fillText("20 ms", cv.width - 36, cv.height - 4);
    },
    createPanel(el) {
      el.innerHTML = `
      <div class="mod-layout"><div class="mod-main"><div class="card">
        <header class="card-head"><h3>Chirp sounder</h3><span class="card-tag mono" id="cl-tag">idle</span></header>
        <div class="card-body">
          <div class="mod-controls">
            <label class="field"><span>&nbsp;</span><button class="btn btn-accent" id="cl-send">Send chirp (1 s)</button></label>
            <label class="field"><span>&nbsp;</span><button class="btn" id="cl-arm">Arm receiver</button></label>
            <label class="field"><span>SNR (dB)</span><input type="number" id="cl-snr" value="15" min="-5" max="40" style="width:70px"></label>
            <label class="field"><span>&nbsp;</span><button class="btn" id="cl-self">Loopback test (2-path)</button></label>
          </div>
          <canvas id="cl-cv" width="900" height="160" style="width:100%;margin-top:10px;border-radius:8px;background:#0a0e14"></canvas>
          <pre class="mono" id="cl-out" style="font-size:12px;margin-top:8px;white-space:pre-wrap"></pre>
          <footer class="card-foot mono muted">Arm the receiver, send the chirp from the far station (or the next room, or through the 🧪 conditions loopback) — the matched filter compresses one second of sweep into microseconds of arrival. Two ionospheric hops = two orange needles; their spacing is the sky's geometry in milliseconds. RMS delay spread is the number that decides which QAM profile survives.</footer>
        </div></div></div></div>`;
      const q = (id) => el.querySelector("#" + id);
      const ui = this.ui = { tag: q("cl-tag"), send: q("cl-send"), arm: q("cl-arm"),
        snr: q("cl-snr"), self: q("cl-self"), cv: q("cl-cv"), out: q("cl-out") };
      ui.send.addEventListener("click", async () => {
        this.ctx.log("Channel Lab: chirp away (300→2700 Hz, 1 s).");
        await this.ctx.audio.playPCM(makeChirp(), CFS);
      });
      ui.arm.addEventListener("click", () => {
        this.buf = new Float32Array(Math.round(CFS * 2.5)); this.bn = 0;
        this.armed = true; ui.tag.textContent = "listening 2.5 s…"; ui.out.textContent = "";
        if (!this.ctx.audio.rxActive) this.ctx.log("Channel Lab: press “Start audio” first.");
      });
      ui.self.addEventListener("click", () => {
        const snrDb = clamp(parseFloat(ui.snr.value) || 15, -5, 40);
        const ch = makeChirp(), n = ch.length + Math.round(0.3 * CFS);
        const y = new Float32Array(n);
        const d2 = Math.round(0.0024 * CFS), g2 = Math.pow(10, -6 / 20);
        for (let i = 0; i < ch.length; i++) {
          y[i + 100] += ch[i];
          y[i + 100 + d2] += g2 * ch[i];
        }
        let sp = 0; for (let i = 0; i < n; i++) sp += y[i] * y[i]; sp /= n;
        const nA = Math.sqrt(sp / Math.pow(10, snrDb / 10));
        for (let i = 0; i < n; i++) y[i] += nA * (Math.random() + Math.random() + Math.random() - 1.5) * 0.82;
        this._analyze(y);
        this.ctx.log(`Channel Lab loopback: 2 paths (0 / 2.4 ms, −6 dB) at ${snrDb} dB — pure math.`);
      });
    },
    onActivate() {}, onDeactivate() { this.armed = false; this.ui = null; }
  };
  HRWS.registerModule(def);
})();
