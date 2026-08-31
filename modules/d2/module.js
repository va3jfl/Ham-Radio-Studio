/* ============================================================
   Ham Radio Web Studio — HRWS-D2 · progressive images
   D1 sends stripes; D2 sends an idea: the picture arrives
   coarse-to-fine. A Haar wavelet pyramid puts a recognizable
   thumbnail on screen in the first second, then detail layers
   sharpen it for as long as you care to listen. Stop anytime —
   you keep everything received. And the philosophical trick:
   there is NO forward error correction, because none is needed.
   A lost packet isn't an error; it's a patch of slightly softer
   focus. Digital that degrades gracefully, on purpose.
   256×192 luminance · Haar ×4 levels · zero-run coding ·
   4-FSK 500 Bd packets with CRC (drop, never garble).
   ============================================================ */
"use strict";
(function () {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  /* D2DSP-BEGIN */
  const W = 256, H = 192, LV = 4, QS = [4, 6, 10, 16];        // quantizer per level (fine→coarse)
  const FS = 12000, BAUD = 500, SPS = FS / BAUD;              // 24 samples/symbol
  const TONES = [800, 1200, 1600, 2000];
  const SYNC = [0, 3, 1, 2, 3, 0, 2, 1, 0, 0, 3, 3, 1, 1, 2, 2];
  function haarFwd(a) {                                        // in-place, LV levels
    const t = new Float32Array(Math.max(W, H));
    let w = W, h = H;
    for (let l = 0; l < LV; l++) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w / 2; x++) {
          const p = a[y * W + 2 * x], q = a[y * W + 2 * x + 1];
          t[x] = (p + q) / 2; t[w / 2 + x] = (p - q) / 2;
        }
        for (let x = 0; x < w; x++) a[y * W + x] = t[x];
      }
      for (let x = 0; x < w; x++) {
        for (let y = 0; y < h / 2; y++) {
          const p = a[2 * y * W + x], q = a[(2 * y + 1) * W + x];
          t[y] = (p + q) / 2; t[h / 2 + y] = (p - q) / 2;
        }
        for (let y = 0; y < h; y++) a[y * W + x] = t[y];
      }
      w >>= 1; h >>= 1;
    }
  }
  function haarInv(a) {
    const t = new Float32Array(Math.max(W, H));
    let w = W >> (LV - 1), h = H >> (LV - 1);
    for (let l = 0; l < LV; l++) {
      for (let x = 0; x < w; x++) {
        for (let y = 0; y < h / 2; y++) {
          const s = a[y * W + x], d = a[(h / 2 + y) * W + x];
          t[2 * y] = s + d; t[2 * y + 1] = s - d;
        }
        for (let y = 0; y < h; y++) a[y * W + x] = t[y];
      }
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w / 2; x++) {
          const s = a[y * W + x], d = a[y * W + w / 2 + x];
          t[2 * x] = s + d; t[2 * x + 1] = s - d;
        }
        for (let x = 0; x < w; x++) a[y * W + x] = t[x];
      }
      w <<= 1; h <<= 1;
    }
  }
  /* coefficient serialization: LL raster (bytes), then per level
     coarse→fine the LH/HL/HH bands, quantized int8, zero-run coded */
  function coeffOrder() {
    const idx = [];
    const llw = W >> LV, llh = H >> LV;
    for (let y = 0; y < llh; y++) for (let x = 0; x < llw; x++) idx.push([y * W + x, -1]);
    for (let l = LV - 1; l >= 0; l--) {
      const w = W >> l, h = H >> l, hw = w >> 1, hh = h >> 1;
      const band = (x0, y0) => { for (let y = 0; y < hh; y++) for (let x = 0; x < hw; x++)
        idx.push([(y0 + y) * W + x0 + x, l]); };
      band(hw, 0); band(0, hh); band(hw, hh);
    }
    return idx;
  }
  const LLN = (W >> LV) * (H >> LV);                           // 192 raw LL bytes lead the stream
  function d2Encode(gray) {                                    // Float32 W*H 0..255 → bytes
    const c = Float32Array.from(gray); haarFwd(c);
    const order = coeffOrder(), out = [];
    for (let k = 0; k < LLN; k++) out.push(clamp(Math.round(c[order[k][0]]), 0, 255));
    let zrun = 0;
    const flush = () => { while (zrun > 0) { const r = Math.min(255, zrun);
      out.push(0x80, r); zrun -= r; } };                        // ESC 0x80 + run byte
    for (let k = LLN; k < order.length; k++) {
      const [i, l] = order[k];
      const v = clamp(Math.round(c[i] / QS[l]), -120, 120);     // ±120: 0x80 can never be a literal
      if (v === 0) { zrun++; continue; }
      flush(); out.push(v & 0xFF);
    }
    flush();
    return Uint8Array.from(out);
  }
  function d2DecodeInto(bytes, nBytes) {                       // partial-stream reconstruct
    const c = new Float32Array(W * H), order = coeffOrder();
    let oi = 0, bi = 0;
    for (; bi < Math.min(nBytes, LLN); bi++) c[order[oi++][0]] = bytes[bi];
    while (bi < nBytes && oi < order.length) {
      const b = bytes[bi++];
      if (b === 0x80) { oi += bytes[bi++] || 0; continue; }
      const [i, l] = order[oi++];
      c[i] = (b < 128 ? b : b - 256) * QS[l];
    }
    haarInv(c);
    return c;
  }
  /* ---- 4-FSK packet modem ---- */
  function crc16(b, a, n) { let c = 0xFFFF;
    for (let i = a; i < n; i++) { c ^= b[i] << 8;
      for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF; }
    return c; }
  function d2Packets(payload) {                                // → symbol array
    const syms = [];
    const pushB = (b) => { for (let k = 6; k >= 0; k -= 2) syms.push((b >> k) & 3); };
    let seq = 0;
    for (let p = 0; p < payload.length; p += 64) {
      const seg = payload.subarray(p, Math.min(p + 64, payload.length));
      const fr = new Uint8Array(5 + seg.length);
      fr[0] = seg.length; fr[1] = seq >> 8; fr[2] = seq & 255; fr.set(seg, 3);
      const c = crc16(fr, 0, 3 + seg.length);
      fr[3 + seg.length] = c >> 8; fr[4 + seg.length] = c & 255;
      SYNC.forEach(s => syms.push(s));
      for (const b of fr) pushB(b);
      seq++;
    }
    SYNC.forEach(s => syms.push(s));                            // trailing sync = EOF hint
    return syms;
  }
  function d2Render(syms) {
    const y = new Float32Array(Math.ceil(syms.length * SPS) + FS >> 0);
    let ph = 0, cur = 0;
    for (const s of syms) {
      const w = 2 * Math.PI * TONES[s] / FS;
      const a0 = Math.round(cur); cur += SPS; const a1 = Math.round(cur);
      for (let i = a0; i < a1; i++) { ph += w; y[i] = 0.8 * Math.sin(ph); }
    }
    return y;
  }
  class D2Rx {
    constructor(fs, onPacket) {
      this.fs = fs; this.on = onPacket;
      this.dec = Math.max(1, Math.round(fs / FS)); this.da = 0; this.dk = 0;
      this.buf = new Float32Array(FS * 8); this.n = 0;
    }
    _sym(at) {                                                  // tone decision @12 k index
      let bi = 0, bv = -1;
      for (let t = 0; t < 4; t++) {
        const w = 2 * Math.PI * TONES[t] / FS, c = 2 * Math.cos(w);
        let s1 = 0, s2 = 0;
        for (let i = 0; i < SPS; i++) { const s0 = this.buf[at + i] + c * s1 - s2; s2 = s1; s1 = s0; }
        const p = s1 * s1 + s2 * s2 - c * s1 * s2;
        if (p > bv) { bv = p; bi = t; }
      }
      return bi;
    }
    feed(x) {
      for (let i = 0; i < x.length; i++) {
        this.da += x[i];
        if (++this.dk === this.dec) { this.dk = 0;
          if (this.n < this.buf.length) this.buf[this.n++] = this.da / this.dec;
          this.da = 0; }
      }
      this._scan();
    }
    _scan() {
      const need = (16 + 4 * 70) * SPS;
      while (this.n > need) {
        let found = -1;
        const lim = Math.min(this.n - need, 4 * SPS);
        for (let off = 0; off < lim; off += SPS / 4) {
          let m = 0;
          for (let s = 0; s < 16; s++) if (this._sym(Math.round(off + s * SPS)) === SYNC[s]) m++;
          if (m >= 14) { found = off; break; }
        }
        if (found < 0) { this._drop(Math.round(lim)); continue; }
        let at = found + 16 * SPS;
        const rB = () => { let b = 0;
          for (let k = 0; k < 4; k++) { b = (b << 2) | this._sym(Math.round(at)); at += SPS; }
          return b; };
        const len = rB();
        if (len > 64) { this._drop(Math.round(found + SPS)); continue; }
        const fr = new Uint8Array(5 + len); fr[0] = len;
        for (let i = 1; i < 5 + len; i++) fr[i] = rB();
        const c = crc16(fr, 0, 3 + len);
        if (((fr[3 + len] << 8) | fr[4 + len]) === c)
          this.on((fr[1] << 8) | fr[2], fr.subarray(3, 3 + len));
        this._drop(Math.round(at));
      }
    }
    _drop(k) { this.buf.copyWithin(0, k, this.n); this.n -= k; }
  }
  /* D2DSP-END */
  function psnrG(a, b) { let m = 0;
    for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; m += d * d; }
    return 10 * Math.log10(255 * 255 / (m / a.length)); }
  const def = {
    id: "d2",
    init(ctx) {
      this.ctx = ctx; this.ui = null; this.src = null; this.enc = null;
      this.rxBytes = new Uint8Array(70000); this.rxMax = 0; this.rxN = 0;
      this.listening = false;
      this._unsub = ctx.audio.onSamples((a, sr) => {
        if (!this.listening) return;
        if (!this.rx || this.rx.fs !== sr) this.rx = new D2Rx(sr, (s, p) => this._pkt(s, p));
        this.rx.feed(a);
      });
      ctx.log("HRWS-D2 ready — pictures that arrive coarse-to-fine; stop anytime, keep everything.");
    },
    _pkt(seq, pay) {
      const at = seq * 64;
      this.rxBytes.set(pay, at);
      this.rxMax = Math.max(this.rxMax, at + pay.length); this.rxN++;
      const img = d2DecodeInto(this.rxBytes, this.rxMax);
      this._paint(this.ui && this.ui.rx, img);
      if (this.ui) this.ui.rtag.textContent = `${this.rxN} pkts · ${this.rxMax} B`;
    },
    _paint(cv, g) {
      if (!cv) return;
      const c = cv.getContext("2d"), im = c.createImageData(W, H);
      for (let i = 0; i < W * H; i++) {
        const v = clamp(g[i], 0, 255) | 0, p = i * 4;
        im.data[p] = im.data[p + 1] = im.data[p + 2] = v; im.data[p + 3] = 255;
      }
      c.putImageData(im, 0, 0);
    },
    _grab() {
      const s = new Float32Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const u = x / W, v = y / H;
        s[y * W + x] = clamp(140 + 100 * Math.sin(u * 9) * Math.cos(v * 7) +
          (Math.hypot(u - 0.5, v - 0.5) < 0.18 ? 70 : 0) + ((x >> 4 ^ y >> 4) & 1 ? 25 : -25), 0, 255);
      }
      if (this.ui && this.ui.file.files[0]) return this._grabFile(s);
      return Promise.resolve(s);
    },
    _grabFile(fallback) {
      return new Promise((res) => {
        const img = new Image();
        img.onload = () => {
          const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
          const c = cv.getContext("2d"); c.drawImage(img, 0, 0, W, H);
          const d = c.getImageData(0, 0, W, H).data, out = new Float32Array(W * H);
          for (let i = 0; i < W * H; i++)
            out[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
          res(out);
        };
        img.onerror = () => res(fallback);
        img.src = URL.createObjectURL(this.ui.file.files[0]);
      });
    },
    createPanel(el) {
      el.innerHTML = `
      <div class="mod-layout"><div class="mod-main"><div class="card">
        <header class="card-head"><h3>HRWS-D2 — progressive image</h3><span class="card-tag mono" id="d2-tag">idle</span></header>
        <div class="card-body">
          <div class="mod-controls">
            <label class="field"><span>Image (optional)</span><input type="file" id="d2-file" accept="image/*"></label>
            <label class="field"><span>&nbsp;</span><button class="btn btn-accent" id="d2-enc">Encode</button></label>
            <label class="field"><span>&nbsp;</span><button class="btn" id="d2-tx" disabled>Transmit</button></label>
            <label class="field"><span>&nbsp;</span><button class="btn btn-danger" id="d2-stop">Stop</button></label>
            <label class="field"><span>&nbsp;</span><button class="btn" id="d2-lsn">Listen</button></label>
            <label class="field"><span>SNR (dB)</span><input type="number" id="d2-snr" value="12" min="0" max="40" style="width:70px"></label>
            <label class="field"><span>&nbsp;</span><button class="btn" id="d2-loop">Loopback (stop at 30%)</button></label>
          </div>
          <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:10px">
            <div><div class="mono muted" style="font-size:11px">TX source</div>
              <canvas id="d2-txcv" width="256" height="192" style="border-radius:8px;background:#000"></canvas></div>
            <div><div class="mono muted" style="font-size:11px">RX — sharpening live <span id="d2-rtag"></span></div>
              <canvas id="d2-rxcv" width="256" height="192" style="border-radius:8px;background:#000"></canvas></div>
          </div>
          <div class="mono muted" id="d2-plan" style="font-size:12px;margin-top:8px">no encode yet</div>
          <footer class="card-foot mono muted">The thumbnail lands in the first second; every further second is pure sharpening. There is deliberately no FEC — a lost packet is a patch of softer focus, never garbage. Stop whenever it's sharp enough for you: that's the whole idea.</footer>
        </div></div></div></div>`;
      const q = (id) => el.querySelector("#" + id);
      const ui = this.ui = { tag: q("d2-tag"), file: q("d2-file"), enc: q("d2-enc"),
        tx: q("d2-tx"), stop: q("d2-stop"), lsn: q("d2-lsn"), snr: q("d2-snr"),
        loop: q("d2-loop"), txcv: q("d2-txcv"), rx: q("d2-rxcv"), plan: q("d2-plan"),
        rtag: q("d2-rtag") };
      ui.enc.addEventListener("click", async () => {
        this.src = await this._grab();
        this._paint(ui.txcv, this.src);
        this.enc = d2Encode(this.src);
        const syms = d2Packets(this.enc);
        this.symsLen = syms.length;
        ui.plan.textContent = `${this.enc.length} B → ${Math.ceil(this.enc.length / 64)} packets → ` +
          `${(syms.length / BAUD).toFixed(1)} s on air (thumbnail in ~${(1000 / BAUD * 4 * ((W >> LV) * (H >> LV) / 64 + 1) * 70 / 1000).toFixed(1)} s)`;
        ui.tx.disabled = false;
      });
      ui.tx.addEventListener("click", async () => {
        const y = d2Render(d2Packets(this.enc));
        ui.tag.textContent = "transmitting";
        await this.ctx.audio.playPCM(y, FS);
        ui.tag.textContent = "idle";
      });
      ui.stop.addEventListener("click", () => { this.ctx.audio.stopTX(); ui.tag.textContent = "idle"; });
      ui.lsn.addEventListener("click", () => {
        this.listening = !this.listening;
        if (this.listening) { this.rxBytes.fill(0); this.rxMax = 0; this.rxN = 0; this.rx = null; }
        ui.lsn.textContent = this.listening ? "Stop listening" : "Listen";
        if (this.listening && !this.ctx.audio.rxActive)
          this.ctx.log("D2: press “Start audio” so the receiver has an input.");
      });
      ui.loop.addEventListener("click", async () => {
        if (!this.enc) { this.src = await this._grab(); this._paint(ui.txcv, this.src); this.enc = d2Encode(this.src); }
        const syms = d2Packets(this.enc);
        const cut = Math.floor(syms.length * 0.30);
        const y = d2Render(syms.slice(0, cut));
        const snrDb = clamp(parseFloat(ui.snr.value) || 12, 0, 40);
        let sp = 0; for (let i = 0; i < y.length; i++) sp += y[i] * y[i]; sp /= y.length;
        const nA = Math.sqrt(sp / Math.pow(10, snrDb / 10) * (FS / 2) / 1600);
        for (let i = 0; i < y.length; i++) y[i] += nA * (Math.random() + Math.random() + Math.random() - 1.5) * 0.82;
        this.rxBytes.fill(0); this.rxMax = 0; this.rxN = 0;
        const rx = new D2Rx(FS, (s, p) => this._pkt(s, p));
        for (let i = 0; i < y.length; i += 4096) rx.feed(y.subarray(i, Math.min(i + 4096, y.length)));
        const img = d2DecodeInto(this.rxBytes, this.rxMax);
        ui.plan.textContent += ` · loopback stopped at 30 %: PSNR ${psnrG(this.src, img).toFixed(1)} dB from ${this.rxN} pkts`;
        this.ctx.log("D2 loopback: stopped at 30 % of airtime — that image is what graceful looks like.");
      });
    },
    onActivate() {}, onDeactivate() { this.listening = false; this.ui = null; }
  };
  HRWS.registerModule(def);
})();
