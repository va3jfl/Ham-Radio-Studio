/* ============================================================
   Ham Radio Web Studio — Olivia module
   Pawel Jalocha SP9VRC's weak-signal text mode, famous for two
   things: decoding below where your ear gives up, and sounding
   like wind-chime music while it does. M tones step across the
   bandwidth; every 64-symbol block hides one character per bit
   plane inside a Walsh function — lose half the tones to noise
   and the correlation still points at the right letter.
   Standard format: Gray-coded tones, the published scrambler,
   13-step plane rotation — fldigi should read us and vice versa.
   ============================================================ */
"use strict";
(function () {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const MODES = {
    "Olivia 8/250":   { M: 8,  bw: 250 },
    "Olivia 16/500":  { M: 16, bw: 500 },
    "Olivia 32/1000": { M: 32, bw: 1000 }
  };
  /* OLVDSP-BEGIN */
  const SCR = 0xE257E6D0291574ECn;
  const scrBit = (i) => Number((SCR >> BigInt(i & 63)) & 1n);
  const gray = (v) => v ^ (v >> 1);
  const igray = (t) => { t ^= t >> 1; t ^= t >> 2; t ^= t >> 4; return t; };
  const walshEnc = (c) => {           // 7-bit char -> 64 hard bits
    const idx = c & 63, sign = (c >> 6) & 1, out = new Uint8Array(64);
    for (let i = 0; i < 64; i++) {
      let p = idx & i, b = 0; while (p) { b ^= p & 1; p >>= 1; }
      out[i] = b ^ sign;
    }
    return out;
  };
  const wht64 = (v) => {              // in-place fast Walsh-Hadamard
    for (let len = 1; len < 64; len <<= 1)
      for (let i = 0; i < 64; i += len << 1)
        for (let j = i; j < i + len; j++) {
          const a = v[j], b = v[j + len];
          v[j] = a + b; v[j + len] = a - b;
        }
  };
  class OliviaTx {
    constructor(fs, cfg, center) {
      this.fs = fs; this.M = cfg.M; this.bw = cfg.bw;
      this.nb = Math.log2(cfg.M) | 0;
      this.sp = cfg.bw / cfg.M;
      this.Ts = cfg.M / cfg.bw;
      this.f0 = center - cfg.bw / 2 + this.sp / 2;
    }
    render(text) {
      const chars = [];
      for (const ch of text) chars.push(ch.charCodeAt(0) & 127);
      while (chars.length % this.nb) chars.push(0);
      const nBlk = chars.length / this.nb;
      const syms = new Uint8Array(nBlk * 64);
      for (let b = 0; b < nBlk; b++)
        for (let p = 0; p < this.nb; p++) {
          const bits = walshEnc(chars[b * this.nb + p]);
          for (let i = 0; i < 64; i++)
            if (bits[i] ^ scrBit(i + 13 * p)) syms[b * 64 + i] |= (1 << p);
        }
      const spS = this.Ts * this.fs, edge = Math.round(spS / 8);
      const n = Math.ceil(syms.length * spS) + Math.round(0.2 * this.fs);
      const y = new Float32Array(n);
      let ph = 0, cur = 0;
      for (let s = 0; s < syms.length; s++) {
        const f = this.f0 + gray(syms[s]) * this.sp;
        const w = 2 * Math.PI * f / this.fs;
        const a0 = Math.round(cur); cur += spS; const a1 = Math.round(cur);
        for (let i = a0; i < a1; i++) {
          let a = 0.85;
          if (i - a0 < edge) a *= 0.5 - 0.5 * Math.cos(Math.PI * (i - a0) / edge);
          else if (a1 - i <= edge) a *= 0.5 - 0.5 * Math.cos(Math.PI * (a1 - i) / edge);
          ph += w; y[i] = a * Math.sin(ph);
        }
      }
      return y;
    }
  }
  class OliviaRx {
    constructor(fs, cfg, center, onText) {
      this.fs = fs; this.M = cfg.M; this.nb = Math.log2(cfg.M) | 0;
      this.sp = cfg.bw / cfg.M; this.Ts = cfg.M / cfg.bw;
      this.f0 = center - cfg.bw / 2 + this.sp / 2;
      this.onText = onText || (() => {});
      this.spS = this.Ts * fs;
      this.buf = new Float32Array(Math.ceil(this.spS * 200));
      this.n = 0; this.base = 0; this.locked = false; this.off = 0;
      this.q = 0;
    }
    feed(x) {
      if (this.n + x.length > this.buf.length) {          // slide window
        const keep = Math.ceil(this.spS * 140);
        this.buf.copyWithin(0, this.n - keep, this.n);
        this.base += this.n - keep; this.n = keep;
        if (this.locked) this.off -= 0;                    // off is absolute-adjusted below
      }
      this.buf.set(x, this.n); this.n += x.length;
      this._run();
    }
    _tonePow(at) {                                         // M Goertzels over one symbol
      const L = Math.round(this.spS), out = new Float64Array(this.M);
      const a = Math.round(at) - this.base;
      if (a < 0 || a + L > this.n) return null;
      for (let m = 0; m < this.M; m++) {
        const w = 2 * Math.PI * (this.f0 + m * this.sp) / this.fs;
        const c = 2 * Math.cos(w); let s1 = 0, s2 = 0;
        for (let i = 0; i < L; i++) { const s0 = this.buf[a + i] + c * s1 - s2; s2 = s1; s1 = s0; }
        out[m] = s1 * s1 + s2 * s2 - c * s1 * s2;
      }
      return out;
    }
    _soft(pow) {                                           // per-plane max-log soft bits
      const sb = new Float64Array(this.nb);
      for (let p = 0; p < this.nb; p++) {
        let m1 = 0, m0 = 0;
        for (let t = 0; t < this.M; t++) {
          const g = igray(t), v = pow[t];
          if ((g >> p) & 1) { if (v > m1) m1 = v; } else if (v > m0) m0 = v;
        }
        sb[p] = Math.log(m1 + 1e-12) - Math.log(m0 + 1e-12);
      }
      return sb;
    }
    _decodeBlock(at) {                                     // -> {chars, q} | null
      const soft = [];
      for (let s = 0; s < 64; s++) {
        const pw = this._tonePow(at + s * this.spS);
        if (!pw) return null;
        soft.push(this._soft(pw));
      }
      let chars = "", qsum = 0;
      for (let p = 0; p < this.nb; p++) {
        const v = new Float64Array(64);
        for (let i = 0; i < 64; i++)
          v[i] = soft[i][p] * (scrBit(i + 13 * p) ? -1 : 1);
        wht64(v);
        let bi = 0, bv = 0, tot = 0;
        for (let i = 0; i < 64; i++) { const a = Math.abs(v[i]); tot += a;
          if (a > bv) { bv = a; bi = i; } }
        qsum += bv / (tot / 64 + 1e-12);
        const c = bi | (v[bi] > 0 ? 64 : 0);
        chars += String.fromCharCode(c);
      }
      return { chars, q: qsum / this.nb };
    }
    _run() {
      const blkS = 64 * this.spS;
      if (!this.locked) {
        if (this.n < blkS + this.spS) return;
        let best = { q: -1, at: 0 };
        const steps = 16;
        for (let k = 0; k < steps; k++) {
          const at = this.base + (k / steps) * this.spS;
          for (let bshift = 0; bshift < 64; bshift += 1) {
            if ((this.base + this.n) - (at + bshift * this.spS) < blkS) break;
            const r = this._decodeBlock(at + bshift * this.spS);
            if (r && r.q > best.q) best = { q: r.q, at: at + bshift * this.spS, r };
            break;                                        // one block-phase per k; slide via consume
          }
        }
        // block-phase search: try 64 positions at best symbol phase
        let b2 = best;
        for (let bs = 1; bs < 64; bs++) {
          const at = best.at + bs * this.spS;
          if ((this.base + this.n) - at < blkS) break;
          const r = this._decodeBlock(at);
          if (r && r.q > b2.q) b2 = { q: r.q, at, r };
        }
        if (b2.q > 8) {
          this.locked = true; this.off = b2.at + blkS;
          this.q = b2.q; this.onText(b2.r.chars, b2.q);
        } else if (this.n > blkS * 2.2) {
          this.base += Math.round(blkS); this.n -= Math.round(blkS);
          this.buf.copyWithin(0, Math.round(blkS), this.n + Math.round(blkS));
        }
        return;
      }
      while ((this.base + this.n) - this.off >= blkS) {
        let best = null;
        for (const d of [0, -this.spS / 8, this.spS / 8]) {
          const r = this._decodeBlock(this.off + d);
          if (r && (!best || r.q > best.q)) best = { ...r, d };
        }
        if (!best) return;
        this.q = best.q;
        if (best.q > 3) this.onText(best.chars, best.q);
        this.off += blkS + best.d;
      }
    }
  }
  /* OLVDSP-END */
  const def = {
    id: "olivia",
    init(ctx) {
      this.ctx = ctx; this.ui = null; this.mode = "Olivia 32/1000";
      this.center = 1500; this.rx = null; this.on = false;
      this._unsub = ctx.audio.onSamples((a, sr) => {
        if (!this.on) return;
        if (!this.rx || this.rx.fs !== sr) this._mk(sr);
        this.rx.feed(a);
        if (this.ui) this.ui.q.textContent = this.rx.locked ? ("locked · q " + this.rx.q.toFixed(1)) : "searching…";
      });
      this._untune = ctx.onTune((f) => { this.center = Math.round(f);
        if (this.ui) this.ui.fc.value = this.center; this.rx = null; this._mark(); });
      ctx.log("Olivia ready — the mode that sings under the noise.");
    },
    _mark() { this.ctx.setMarker({ freq: this.center, color: "#9d7bd8", label: "OLV" }); },
    _mk(sr) {
      this.rx = new OliviaRx(sr, MODES[this.mode], this.center, (txt) => {
        if (this.ui) { this.ui.out.textContent += txt.replace(/\u0000/g, ""); this.ui.out.scrollTop = 1e9; }
      });
    },
    createPanel(el) {
      el.innerHTML = `
      <div class="mod-layout"><div class="mod-main">
        <div class="card"><header class="card-head"><h3>Receive</h3><span class="card-tag mono" id="ol-q">idle</span></header>
        <div class="card-body">
          <div class="mod-controls">
            <label class="field"><span>Mode</span><select id="ol-mode">
              ${Object.keys(MODES).map(k => `<option${k === "Olivia 32/1000" ? " selected" : ""}>${k}</option>`).join("")}</select></label>
            <label class="field"><span>Center (Hz)</span><input type="number" id="ol-fc" value="1500" min="300" max="3500" step="10" style="width:90px"></label>
            <label class="field"><span>&nbsp;</span><button class="btn btn-accent" id="ol-go">Start decoder</button></label>
            <label class="field"><span>&nbsp;</span><button class="btn" id="ol-clr">Clear</button></label>
            <label class="field"><span>SNR (dB)</span><input type="number" id="ol-snr" value="-4" min="-12" max="30" step="1" style="width:70px"></label>
            <label class="field"><span>&nbsp;</span><button class="btn" id="ol-self">Loopback test</button></label>
          </div>
          <pre class="mono" id="ol-out" style="min-height:120px;max-height:220px;overflow:auto;background:rgba(255,255,255,.04);border-radius:8px;padding:10px;white-space:pre-wrap"></pre>
          <footer class="card-foot mono muted">Click the waterfall on an Olivia signal (a soft musical warble). Acquisition takes one block (~2 s at 32/1000); letters then arrive a handful at a time — the FEC decides per block, not per beep.</footer>
        </div></div>
        <div class="card"><header class="card-head"><h3>Transmit</h3></header><div class="card-body">
          <div class="mod-controls">
            <label class="field" style="flex:1;min-width:260px"><span>Text</span>
              <input type="text" id="ol-txt" class="mono" maxlength="200" value="CQ CQ DE N0CALL OLIVIA 73"></label>
            <label class="field"><span>&nbsp;</span><button class="btn btn-accent" id="ol-send">Send</button></label>
            <label class="field"><span>&nbsp;</span><button class="btn btn-danger" id="ol-stop">Stop</button></label>
          </div>
          <footer class="card-foot mono muted">Standard Olivia framing — Gray tones, Walsh blocks, the published scrambler — so fldigi and friends should copy you.</footer>
        </div></div>
      </div></div>`;
      const q = (id) => el.querySelector("#" + id);
      const ui = this.ui = { q: q("ol-q"), mode: q("ol-mode"), fc: q("ol-fc"),
        go: q("ol-go"), clr: q("ol-clr"), self: q("ol-self"), snr: q("ol-snr"), out: q("ol-out"),
        txt: q("ol-txt"), send: q("ol-send"), stop: q("ol-stop") };
      ui.txt.value = "CQ CQ DE " + (this.ctx.settings().callsign || "N0CALL") + " OLIVIA 73";
      ui.mode.addEventListener("change", () => { this.mode = ui.mode.value; this.rx = null; });
      ui.fc.addEventListener("change", () => { this.center = parseInt(ui.fc.value, 10) || 1500; this.rx = null; this._mark(); });
      ui.go.addEventListener("click", () => {
        this.on = !this.on; this.rx = null;
        ui.go.textContent = this.on ? "Stop decoder" : "Start decoder";
        ui.go.classList.toggle("btn-accent", !this.on);
        ui.q.textContent = this.on ? "searching…" : "idle";
        if (this.on) { this._mark();
          if (!this.ctx.audio.rxActive) this.ctx.log("Olivia: press “Start audio” so the decoder has an input."); }
      });
      ui.clr.addEventListener("click", () => { ui.out.textContent = ""; });
      ui.send.addEventListener("click", async () => {
        const fs = this.ctx.audio.ensureContext().sampleRate;
        const tx = new OliviaTx(fs, MODES[this.mode], this.center);
        const y = tx.render(ui.txt.value);
        this.ctx.log(`Olivia sending ${ui.txt.value.length} chars (${(y.length / fs).toFixed(0)} s).`);
        await this.ctx.audio.playPCM(y, fs);
      });
      ui.stop.addEventListener("click", () => this.ctx.audio.stopTX());
      ui.self.addEventListener("click", () => {
        const fs = 8000, cfg = MODES[this.mode];
        const snrDb = clamp(parseFloat(this.ui.snr.value) || -4, -12, 30);
        const msg = "OLIVIA LOOPBACK 73 ";
        const y = new OliviaTx(fs, cfg, 1500).render(msg);
        let sp = 0; for (let i = 0; i < y.length; i++) sp += y[i] * y[i]; sp /= y.length;
        const nAmp = Math.sqrt(sp / Math.pow(10, snrDb / 10) * (fs / 2) / cfg.bw);
        const z = new Float32Array(y.length + fs);
        for (let i = 0; i < z.length; i++) z[i] = (y[i] || 0) + nAmp * (Math.random() + Math.random() + Math.random() - 1.5) * 0.82;
        let got = "";
        const rx = new OliviaRx(fs, cfg, 1500, (t) => got += t);
        for (let i = 0; i < z.length; i += 4096) rx.feed(z.subarray(i, Math.min(i + 4096, z.length)));
        ui.out.textContent += "\n[loopback @ " + snrDb + " dB in-band] " + got.replace(/\u0000/g, "·") + "\n";
        this.ctx.log("Olivia self-test decoded through noise — pure math, no audio.");
      });
      this._mark();
    },
    onActivate() { this._mark(); },
    onDeactivate() { this.on = false; this.ui = null; }
  };
  HRWS.registerModule(def);
})();
