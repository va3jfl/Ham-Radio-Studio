/* ============================================================
   Ham Radio Web Studio — HRWS-D3 · moving pictures
   Phase 12b: the pictures start moving.

   Digital moving television over an ordinary SSB voice channel —
   NBTV's great-grandchild. D1 sends a still as independent
   16-line stripes; D3 sends only the stripes' 16×16 blocks that
   CHANGED since the last frame, each either INTRA (absolute,
   self-contained) or DELTA (residual vs. the picture both ends
   already share). At 500 bps net that is 1–2 fps of small,
   honest, moving pictures.

   The stack, bottom to top (the D1 chain, unchanged):
     modem    4-FSK, 500 Bd, tones 800/1300/1800/2300 Hz
              (Gray-coded 2 bits/symbol, continuous phase,
              1000 bps raw, fits 300–2700 Hz SSB)
     FEC      convolutional K=7 rate 1/2 (G1=171o, G2=133o),
              soft-decision Viterbi, 24-row block interleaver
     framing  every packet: 16-symbol sync (fresh timing lock,
              drift can never accumulate), 7-byte coded header
              (type, seq, len, CRC-16), payload + CRC-32
     codec    the D1 mini-JPEG toolbox (8×8 DCT, quality-scaled
              quantization, zigzag, Exp-Golomb) applied per
              16×16 macroblock, INTRA or DELTA per block
     engine   conditional replenishment: per frame, one packet
              carrying a block bitmap + the changed blocks.
              A walking INTRA refresh re-anchors the oldest
              blocks so a lost packet heals by itself — the
              same forced-update idea H.261 used in 1988 at
              64 kbit/s, here at 0.5.

   Failure philosophy (the family trait): a corrupted packet is
   DROPPED whole by its CRC — the screen keeps the last good
   picture and simply goes stale until the refresh sweep repaints
   it. Noise costs freshness, never garbage.

   On-air: PAD 0.25 s · 1900 Hz leader 0.35 s (tune/VOX) ·
   24-symbol clock preamble · session header ×2 · frame packets
   paced with 1900 Hz filler · END. Late joiners lock onto any
   packet; the session header repeats every 5 s so they learn the
   geometry within one breath.

   This is an experiment: both ends need this studio. Identify
   per your local regulations.
   ============================================================ */
"use strict";

(function () {

  /* ---------------- modem constants (identical to HRWS-D1) ---------------- */
  const TONES = [800.0, 1300.0, 1800.0, 2300.0];
  const BAUD = 500.0;
  const GRAY_ENC = [0, 1, 3, 2];        // 2-bit value -> tone index
  const SYNCSEQ = [0, 3, 1, 2, 3, 0, 2, 1, 3, 3, 0, 0, 2, 1, 1, 2];
  const PREAMBLE_SYMS = 24;
  const LEADER_S = 0.35, LEADER_F = 1900.0;
  const PAD_S = 0.25;
  const TX_FS = 12000;                  // synth rate: 24 samples/symbol exactly

  /* ---------------- D3 constants ---------------- */
  const PKT_END = 3;                    // same END semantics as D1
  const PKT_VHDR = 4;                   // session header (geometry, repeats)
  const PKT_VFRM = 5;                   // one frame's worth of changed blocks
  const MAGIC0 = 0x44, MAGIC1 = 0x33;   // "D3"
  const MB = 16;                        // macroblock: 16×16 luma, 8×8 chroma
  const SIZES = [[64, 48], [96, 64], [128, 96]];
  const QUALITY = { low: 30, med: 45, high: 60 };
  const FPS_OPTS = [0.5, 1, 1.5, 2];
  const VHDR_EVERY_S = 5;               // session header repeat period
  const SAD_THRESH = 2.0;               // mean |Δ| per pixel to call a block "moved"
  const MAX_PAYLOAD = 250;              // absolute safety cap, bytes

  /* ---------------- small utilities ---------------- */
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function tick() { return new Promise(r => setTimeout(r, 0)); }

  const CRC32_TAB = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC32_TAB[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function crc16(bytes, n) {           // CCITT-FALSE
    let c = 0xFFFF;
    const m = n === undefined ? bytes.length : n;
    for (let i = 0; i < m; i++) {
      c ^= bytes[i] << 8;
      for (let k = 0; k < 8; k++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF;
    }
    return c;
  }

  /* radix-2 complex FFT (shared with the D1/SSTV modules) */
  function fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (inverse ? 2 : -2) * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        const half = len >> 1;
        for (let k = 0; k < half; k++) {
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + half] * cr - im[i + k + half] * ci;
          const vi = re[i + k + half] * ci + im[i + k + half] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + half] = ur - vr; im[i + k + half] = ui - vi;
          const nr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = nr;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  function analyticBand(y, fs, lo, hi, emit) {
    const n = y.length;
    const N = 131072, OV = 8192;
    const step = N - 2 * OV;
    const re = new Float64Array(N), im = new Float64Array(N);
    const gain = new Float64Array(N);
    const tw = 60.0;
    const hiC = Math.min(hi, 0.47 * fs);
    for (let k = 0; k < N; k++) {
      const f = k * fs / N;
      if (k === 0 || k > N / 2) { gain[k] = 0; continue; }
      let g = 2.0;
      if (k === N / 2) g = 1.0;
      if (lo > 0) {
        if (f < lo - tw) g = 0;
        else if (f < lo + tw) g *= 0.5 - 0.5 * Math.cos(Math.PI * (f - (lo - tw)) / (2 * tw));
      }
      if (f > hiC + tw) g = 0;
      else if (f > hiC - tw) g *= 0.5 + 0.5 * Math.cos(Math.PI * (f - (hiC - tw)) / (2 * tw));
      gain[k] = g;
    }
    for (let base = -OV; base < n; base += step) {
      for (let k = 0; k < N; k++) {
        const j = base + k;
        re[k] = (j >= 0 && j < n) ? y[j] : 0;
        im[k] = 0;
      }
      fft(re, im, false);
      for (let k = 0; k < N; k++) { re[k] *= gain[k]; im[k] *= gain[k]; }
      fft(re, im, true);
      const a = base <= 0 ? 0 : base + OV;
      const b = Math.min(n, base + N - OV);
      if (b > a) emit(a, b, re, im, a - base);
    }
  }

  function fftBandpass(y, fs, lo, hi) {
    const out = new Float32Array(y.length);
    analyticBand(y, fs, lo, hi, (a, b, re, im, off) => {
      for (let i = a; i < b; i++) out[i] = re[off + (i - a)];
    });
    for (let i = 0; i < out.length; i++) out[i] *= 0.5;
    return out;
  }

  function peakNorm(y, level) {
    let m = 0;
    for (let i = 0; i < y.length; i++) { const a = Math.abs(y[i]); if (a > m) m = a; }
    if (m < 1e-9) return y;
    const g = (level || 0.9) / m;
    const out = new Float32Array(y.length);
    for (let i = 0; i < y.length; i++) out[i] = y[i] * g;
    return out;
  }

  function lfilter1(b0, b1, a0, a1, x) {
    const out = new Float32Array(x.length);
    let px = 0, py = 0;
    for (let i = 0; i < x.length; i++) {
      const v = (b0 * x[i] + b1 * px - a1 * py) / a0;
      out[i] = v; px = x[i]; py = v;
    }
    return out;
  }

  /* channel simulator — same behaviour as the D1 module's */
  function channelSimulate(y, fs, bwHz, snrDb, seed, kind) {
    let rndState = (seed === undefined || seed === null) ? 12345 : (seed | 0) || 1;
    const rnd = () => {
      rndState = (rndState * 1103515245 + 12345) & 0x7fffffff;
      const u1 = (rndState + 1) / 0x80000000;
      rndState = (rndState * 1103515245 + 12345) & 0x7fffffff;
      const u2 = (rndState + 1) / 0x80000000;
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    };
    const rms = x => {
      let s = 0;
      for (let i = 0; i < x.length; i++) s += x[i] * x[i];
      return Math.sqrt(s / x.length) + 1e-12;
    };
    if (kind === "fm") {
      const aC = Math.exp(-1.0 / (fs * 750e-6));
      let out = lfilter1(1.0, -aC, 1.0 - aC, 0.0, y);
      out = fftBandpass(out, fs, 300.0, Math.min(bwHz || 3000.0, 3000.0));
      if (snrDb !== null && snrDb !== undefined) {
        const p = rms(out) * Math.pow(10, -snrDb / 20);
        const nz = new Float32Array(out.length);
        for (let i = 0; i < nz.length; i++) nz[i] = rnd() * p;
        const nzf = fftBandpass(nz, fs, 300.0, Math.min(bwHz || 3000.0, 3000.0));
        for (let i = 0; i < out.length; i++) out[i] += nzf[i];
      }
      out = lfilter1(1.0 - aC, 0.0, 1.0, -aC, out);
      return peakNorm(out, 0.95);
    }
    let out = Float32Array.from(y);
    if (bwHz) out = fftBandpass(out, fs, 300.0, bwHz);
    if (snrDb !== null && snrDb !== undefined) {
      const p = rms(out) * Math.pow(10, -snrDb / 20);
      let nz = new Float32Array(out.length);
      for (let i = 0; i < nz.length; i++) nz[i] = rnd() * p;
      if (bwHz) nz = fftBandpass(nz, fs, 300.0, bwHz);
      for (let i = 0; i < out.length; i++) out[i] += nz[i];
    }
    return peakNorm(out, 0.95);
  }

  /* stateful biquad (RBJ) — the streaming receiver's band limiter.
     The offline D1 decoder FFT-bandpasses the whole recording; a live
     stream can't, so two of these (HP 450 · LP 2750) do the same job
     sample by sample with carried state. */
  function makeBiquad(type, f0, Q, fs) {
    const w0 = 2 * Math.PI * f0 / fs;
    const cw = Math.cos(w0), sw = Math.sin(w0);
    const al = sw / (2 * Q);
    let b0, b1, b2, a0, a1, a2;
    if (type === "hp") {
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
    } else {                                   // "lp"
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
    }
    a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al;
    b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
    return {
      z1: 0, z2: 0,
      run(x) {                                  // in-place, returns x
        let z1 = this.z1, z2 = this.z2;
        for (let i = 0; i < x.length; i++) {
          const v = x[i];
          const y = b0 * v + z1;
          z1 = b1 * v - a1 * y + z2;
          z2 = b2 * v - a2 * y;
          x[i] = y;
        }
        this.z1 = z1; this.z2 = z2;
        return x;
      }
    };
  }

  /* ---------------- WAV (16-bit out, many in) ---------------- */
  function wavEncode16(mono, rate) {
    const n = mono.length, dataSz = n * 2;
    const buf = new ArrayBuffer(44 + dataSz);
    const dv = new DataView(buf);
    const ws = (p, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(p + i, s.charCodeAt(i)); };
    ws(0, "RIFF"); dv.setUint32(4, 36 + dataSz, true); ws(8, "WAVE");
    ws(12, "fmt "); dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true);
    dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    ws(36, "data"); dv.setUint32(40, dataSz, true);
    let p = 44;
    for (let i = 0; i < n; i++) { dv.setInt16(p, Math.round(clamp(mono[i], -1, 1) * 32767), true); p += 2; }
    return buf;
  }

  function wavDecodeMono(buf) {
    const dv = new DataView(buf);
    if (dv.byteLength < 44 || dv.getUint32(0, false) !== 0x52494646 ||
        dv.getUint32(8, false) !== 0x57415645) throw new Error("not a RIFF/WAVE file");
    let pos = 12, fmt = null, data = null;
    while (pos + 8 <= dv.byteLength) {
      const id = dv.getUint32(pos, false);
      const sz = dv.getUint32(pos + 4, true);
      const body = pos + 8;
      if (id === 0x666d7420)
        fmt = { tag: dv.getUint16(body, true), ch: dv.getUint16(body + 2, true),
                rate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true), body, sz };
      else if (id === 0x64617461)
        data = { off: body, sz: Math.min(sz, dv.byteLength - body) };
      pos = body + sz + (sz & 1);
    }
    if (!fmt || !data) throw new Error("missing fmt/data chunk");
    let tag = fmt.tag;
    if (tag === 0xFFFE && fmt.sz >= 40) tag = dv.getUint16(fmt.body + 24, true);
    const nch = fmt.ch, bits = fmt.bits, bytes = bits >> 3;
    const isFloat = tag === 3 && bits === 32;
    if (!isFloat && tag !== 1) throw new Error("unsupported WAV format tag " + tag);
    const n = Math.floor(data.sz / (bytes * nch));
    const mono = new Float32Array(n);
    let p = data.off;
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let c = 0; c < nch; c++) {
        let v;
        if (isFloat) v = dv.getFloat32(p, true);
        else if (bits === 16) v = dv.getInt16(p, true) / 32768;
        else if (bits === 24) {
          let u = dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getUint8(p + 2) << 16);
          if (u >= 0x800000) u -= 0x1000000;
          v = u / 8388608;
        } else if (bits === 32) v = dv.getInt32(p, true) / 2147483648;
        else if (bits === 8) v = (dv.getUint8(p) - 128) / 128;
        else throw new Error("unsupported WAV width " + bits);
        acc += v; p += bytes;
      }
      mono[i] = acc / nch;
    }
    return { rate: fmt.rate, bits, y: mono };
  }

  /* =====================================================================
     Bit I/O + Exp-Golomb (D1's, plus a live bit count for rate control)
     ===================================================================== */
  class BitWriter {
    constructor() { this.bytes = []; this.cur = 0; this.nb = 0; }
    get bitLength() { return this.bytes.length * 8 + this.nb; }
    bit(b) {
      this.cur = (this.cur << 1) | (b & 1);
      if (++this.nb === 8) { this.bytes.push(this.cur); this.cur = 0; this.nb = 0; }
    }
    bits(v, n) { for (let i = n - 1; i >= 0; i--) this.bit((v >> i) & 1); }
    ue(v) {                                     // unsigned Exp-Golomb
      const x = v + 1;
      let nb = 0;
      while ((x >> (nb + 1)) > 0) nb++;
      for (let i = 0; i < nb; i++) this.bit(0);
      this.bits(x, nb + 1);
    }
    se(v) { this.ue(v > 0 ? 2 * v - 1 : -2 * v); }
    finish() {
      while (this.nb) this.bit(0);
      return Uint8Array.from(this.bytes);
    }
  }
  class BitReader {
    constructor(bytes) { this.b = bytes; this.pos = 0; }
    bit() {
      const byte = this.b[this.pos >> 3];
      const v = (byte >> (7 - (this.pos & 7))) & 1;
      this.pos++;
      if ((this.pos >> 3) > this.b.length) throw new Error("bitstream underrun");
      return v;
    }
    bits(n) { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | this.bit(); return v; }
    ue() {
      let nb = 0;
      while (this.bit() === 0) { if (++nb > 31) throw new Error("bad ue"); }
      let x = 1;
      for (let i = 0; i < nb; i++) x = (x << 1) | this.bit();
      return x - 1;
    }
    se() { const u = this.ue(); return (u & 1) ? (u + 1) >> 1 : -(u >> 1); }
  }

  /* =====================================================================
     Mini-JPEG toolbox — HRWS-D1's 8×8 DCT / quantization / zigzag /
     Exp-Golomb block syntax, split into quantize · entropy-write ·
     entropy-read · reconstruct so the SAME quantized coefficients can
     be written to air and folded back into the encoder's own reference
     picture. That closed loop is what makes DELTA blocks safe: both
     ends predict from literally the same pixels.
     ===================================================================== */
  const ZIGZAG = (() => {
    const z = [];
    let r = 0, c = 0, up = true;
    for (let i = 0; i < 64; i++) {
      z.push(r * 8 + c);
      if (up) {
        if (c === 7) { r++; up = false; }
        else if (r === 0) { c++; up = false; }
        else { r--; c++; }
      } else {
        if (r === 7) { c++; up = true; }
        else if (c === 0) { r++; up = true; }
        else { r++; c--; }
      }
    }
    return z;
  })();

  const QLUMA = [16,11,10,16,24,40,51,61, 12,12,14,19,26,58,60,55,
                 14,13,16,24,40,57,69,56, 14,17,22,29,51,87,80,62,
                 18,22,37,56,68,109,103,77, 24,35,55,64,81,104,113,92,
                 49,64,78,87,103,121,120,101, 72,92,95,98,112,100,103,99];
  const QCHROMA = [17,18,24,47,99,99,99,99, 18,21,26,66,99,99,99,99,
                   24,26,56,99,99,99,99,99, 47,66,99,99,99,99,99,99,
                   99,99,99,99,99,99,99,99, 99,99,99,99,99,99,99,99,
                   99,99,99,99,99,99,99,99, 99,99,99,99,99,99,99,99];
  function quantTable(base, quality) {
    const q = clamp(quality, 1, 100);
    const scale = q < 50 ? Math.floor(5000 / q) : 200 - 2 * q;
    const t = new Int32Array(64);
    for (let i = 0; i < 64; i++) t[i] = clamp(Math.floor((base[i] * scale + 50) / 100), 1, 255);
    return t;
  }

  const DCT_C = (() => {                       // cos table for DCT-II
    const c = new Float64Array(64);
    for (let k = 0; k < 8; k++)
      for (let n = 0; n < 8; n++)
        c[k * 8 + n] = Math.cos((2 * n + 1) * k * Math.PI / 16) *
                       (k === 0 ? Math.SQRT1_2 : 1) * 0.5;
    return c;
  })();
  function dct8x8(px, out) {
    const tmp = new Float64Array(64);
    for (let r = 0; r < 8; r++)
      for (let k = 0; k < 8; k++) {
        let s = 0;
        for (let n = 0; n < 8; n++) s += px[r * 8 + n] * DCT_C[k * 8 + n];
        tmp[r * 8 + k] = s;
      }
    for (let c = 0; c < 8; c++)
      for (let k = 0; k < 8; k++) {
        let s = 0;
        for (let n = 0; n < 8; n++) s += tmp[n * 8 + c] * DCT_C[k * 8 + n];
        out[k * 8 + c] = s;
      }
  }
  function idct8x8(co, out) {
    const tmp = new Float64Array(64);
    for (let c = 0; c < 8; c++)
      for (let n = 0; n < 8; n++) {
        let s = 0;
        for (let k = 0; k < 8; k++) s += co[k * 8 + c] * DCT_C[k * 8 + n];
        tmp[n * 8 + c] = s;
      }
    for (let r = 0; r < 8; r++)
      for (let n = 0; n < 8; n++) {
        let s = 0;
        for (let k = 0; k < 8; k++) s += tmp[r * 8 + k] * DCT_C[k * 8 + n];
        out[r * 8 + n] = s;
      }
  }

  function quantizeBlock(vals, qt) {           // vals: Float64Array(64) → Int32Array(64)
    const co = new Float64Array(64);
    dct8x8(vals, co);
    const q = new Int32Array(64);
    for (let i = 0; i < 64; i++) q[i] = Math.round(co[i] / qt[i]);
    return q;
  }
  function writeQBlock(bw, q, pred) {          // D1's block syntax, entropy only
    bw.se(q[0] - pred.dc);
    pred.dc = q[0];
    let pos = 1;
    while (pos < 64) {
      let run = 0;
      while (pos < 64 && q[ZIGZAG[pos]] === 0) { run++; pos++; }
      if (pos >= 64) { bw.ue(63); return; }     // EOB
      bw.ue(run);
      bw.se(q[ZIGZAG[pos]]);
      pos++;
    }
  }
  function readQBlock(br, pred) {
    const q = new Int32Array(64);
    const dc = pred.dc + br.se();
    pred.dc = dc;
    q[0] = dc;
    let pos = 1;
    while (pos < 64) {
      const run = br.ue();
      if (run === 63) break;                    // EOB
      pos += run;
      if (pos >= 64) throw new Error("AC overrun");
      q[ZIGZAG[pos]] = br.se();
      pos++;
    }
    return q;
  }
  function reconFromQ(q, qt, out) {
    const co = new Float64Array(64);
    for (let i = 0; i < 64; i++) co[i] = q[i] * qt[i];
    idct8x8(co, out);
  }

  /* ---------------- planes (full-range YCbCr 4:2:0, D1's) ---------------- */
  function rgbToPlanes(img) {
    const w = img.w, h = img.h;
    const Y = new Float64Array(w * h);
    for (let i = 0; i < w * h; i++)
      Y[i] = 0.299 * img.r[i] + 0.587 * img.g[i] + 0.114 * img.b[i];
    const wc = Math.ceil(w / 2), hc = Math.ceil(h / 2);
    const Cb = new Float64Array(wc * hc), Cr = new Float64Array(wc * hc);
    for (let r = 0; r < hc; r++) {
      for (let c = 0; c < wc; c++) {
        let sb = 0, sr = 0, cnt = 0;
        for (let dr = 0; dr < 2; dr++)
          for (let dc = 0; dc < 2; dc++) {
            const rr = Math.min(h - 1, 2 * r + dr), cc = Math.min(w - 1, 2 * c + dc);
            const i = rr * w + cc;
            const y = Y[i];
            sb += (img.b[i] - y) * 0.564 + 128.0;
            sr += (img.r[i] - y) * 0.713 + 128.0;
            cnt++;
          }
        Cb[r * wc + c] = sb / cnt;
        Cr[r * wc + c] = sr / cnt;
      }
    }
    return { Y, Cb, Cr, w, h, wc, hc };
  }

  function planesToRgb(P) {
    const w = P.w, h = P.h, wc = P.wc;
    const out = { r: new Float64Array(w * h), g: new Float64Array(w * h), b: new Float64Array(w * h), w, h };
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const i = r * w + c;
        const ci = (r >> 1) * wc + (c >> 1);
        const y = P.Y[i], cb = P.Cb[ci], cr = P.Cr[ci];
        const R = y + 1.403 * (cr - 128.0);
        const B = y + 1.773 * (cb - 128.0);
        const G = (y - 0.299 * R - 0.114 * B) / 0.587;
        out.r[i] = clamp(R, 0, 255);
        out.g[i] = clamp(G, 0, 255);
        out.b[i] = clamp(B, 0, 255);
      }
    }
    return out;
  }

  function makeGeom(w, h) {
    const nx = w / MB, ny = h / MB;
    return { w, h, wc: w >> 1, hc: h >> 1, nx, ny,
             nMB: nx * ny, bmBytes: Math.ceil(nx * ny / 8) };
  }
  function makePlanes(g) {
    return { Y: new Float64Array(g.w * g.h).fill(128),
             Cb: new Float64Array(g.wc * g.hc).fill(128),
             Cr: new Float64Array(g.wc * g.hc).fill(128),
             w: g.w, h: g.h, wc: g.wc, hc: g.hc };
  }

  /* block pixel helpers (all sizes are multiples of 16, so no edge pad) */
  function grabCentered(plane, pw, r0, c0, out) {        // INTRA input: px − 128
    for (let r = 0; r < 8; r++) {
      const base = (r0 + r) * pw + c0;
      for (let c = 0; c < 8; c++) out[r * 8 + c] = plane[base + c] - 128.0;
    }
  }
  function grabDiff(cur, ref, pw, r0, c0, out) {         // DELTA input: cur − ref
    for (let r = 0; r < 8; r++) {
      const base = (r0 + r) * pw + c0;
      for (let c = 0; c < 8; c++) out[r * 8 + c] = cur[base + c] - ref[base + c];
    }
  }
  function applyIntra(plane, pw, r0, c0, recon) {        // plane = recon + 128
    for (let r = 0; r < 8; r++) {
      const base = (r0 + r) * pw + c0;
      for (let c = 0; c < 8; c++) plane[base + c] = clamp(recon[r * 8 + c] + 128.0, 0, 255);
    }
  }
  function applyDelta(plane, pw, r0, c0, recon) {        // plane += recon
    for (let r = 0; r < 8; r++) {
      const base = (r0 + r) * pw + c0;
      for (let c = 0; c < 8; c++) plane[base + c] = clamp(plane[base + c] + recon[r * 8 + c], 0, 255);
    }
  }

  /* the four luma blocks of macroblock (mx,my), in raster order,
     then Cb, Cr — one shared walk used by encoder and decoder */
  const MB_LUMA = [[0, 0], [0, 8], [8, 0], [8, 8]];      // [dr, dc]

  function newPreds() {
    return { iY: { dc: 0 }, iB: { dc: 0 }, iR: { dc: 0 },
             dY: { dc: 0 }, dB: { dc: 0 }, dR: { dc: 0 } };
  }
  function clonePreds(p) {
    return { iY: { dc: p.iY.dc }, iB: { dc: p.iB.dc }, iR: { dc: p.iR.dc },
             dY: { dc: p.dY.dc }, dB: { dc: p.dB.dc }, dR: { dc: p.dR.dc } };
  }

  /* =====================================================================
     FEC — convolutional K=7 rate 1/2 (G1=171o, G2=133o), soft Viterbi,
     24-row block interleaver. Byte-for-byte the D1 chain.
     ===================================================================== */
  const G1 = 0o171, G2 = 0o133;
  const PARITY = (() => {
    const p = new Uint8Array(128);
    for (let i = 0; i < 128; i++) {
      let v = i, b = 0;
      while (v) { b ^= v & 1; v >>= 1; }
      p[i] = b;
    }
    return p;
  })();

  function convEncode(bits) {
    const n = bits.length;
    const out = new Uint8Array(2 * (n + 6));
    let sr = 0, p = 0;
    for (let i = 0; i < n + 6; i++) {
      const u = i < n ? bits[i] : 0;
      sr = ((sr << 1) | u) & 0x7F;
      out[p++] = PARITY[sr & G1];
      out[p++] = PARITY[sr & G2];
    }
    return out;
  }

  function viterbiDecode(llr, nBits) {
    const steps = nBits + 6;
    const NS = 64;
    let pm = new Float64Array(NS).fill(-1e18);
    let pm2 = new Float64Array(NS);
    pm[0] = 0;
    const dec = new Uint8Array(steps * NS);
    for (let t = 0; t < steps; t++) {
      pm2.fill(-1e18);
      const l0 = llr[2 * t], l1 = llr[2 * t + 1];
      for (let s = 0; s < NS; s++) {
        const base = pm[s];
        if (base < -1e17) continue;
        for (let u = 0; u <= 1; u++) {
          if (t >= nBits && u === 1) continue;
          const full = ((s << 1) | u) & 0x7F;
          const o1 = PARITY[full & G1], o2 = PARITY[full & G2];
          const m = base + (o1 ? l0 : -l0) + (o2 ? l1 : -l1);
          const ns = full & 0x3F;
          if (m > pm2[ns]) {
            pm2[ns] = m;
            dec[t * NS + ns] = (s << 1) | u;
          }
        }
      }
      const t2 = pm; pm = pm2; pm2 = t2;
    }
    const out = new Uint8Array(nBits);
    let s = 0;
    for (let t = steps - 1; t >= 0; t--) {
      const d = dec[t * NS + s];
      const u = d & 1;
      if (t < nBits) out[t] = u;
      s = d >> 1;
    }
    return out;
  }

  function interleavePerm(n) {
    const R = 24, C = Math.ceil(n / R);
    const perm = new Int32Array(n);
    let k = 0;
    for (let c = 0; c < C; c++)
      for (let r = 0; r < R; r++) {
        const i = r * C + c;
        if (i < n) perm[k++] = i;
      }
    return perm;
  }
  function interleave(arr) {
    const perm = interleavePerm(arr.length);
    const out = new arr.constructor(arr.length);
    for (let k = 0; k < arr.length; k++) out[k] = arr[perm[k]];
    return out;
  }
  function deinterleave(arr) {
    const perm = interleavePerm(arr.length);
    const out = new arr.constructor(arr.length);
    for (let k = 0; k < arr.length; k++) out[perm[k]] = arr[k];
    return out;
  }

  function bytesToBits(bytes) {
    const out = new Uint8Array(bytes.length * 8);
    for (let i = 0; i < bytes.length; i++)
      for (let b = 0; b < 8; b++) out[i * 8 + b] = (bytes[i] >> (7 - b)) & 1;
    return out;
  }
  function bitsToBytes(bits) {
    const out = new Uint8Array(bits.length >> 3);
    for (let i = 0; i < out.length; i++) {
      let v = 0;
      for (let b = 0; b < 8; b++) v = (v << 1) | bits[i * 8 + b];
      out[i] = v;
    }
    return out;
  }

  function codeSection(bytes) {
    const coded = interleave(convEncode(bytesToBits(bytes)));
    const nSym = coded.length >> 1;
    const tones = new Uint8Array(nSym);
    for (let i = 0; i < nSym; i++)
      tones[i] = GRAY_ENC[(coded[2 * i] << 1) | coded[2 * i + 1]];
    return tones;
  }
  function sectionSyms(nBytes) { return 8 * nBytes + 6; }

  /* packet header: type u8 · seq u16 · len u16 · crc16 = 7 bytes */
  function buildHeaderBytes(type, seq, len) {
    const b = new Uint8Array(7);
    b[0] = type;
    b[1] = seq >> 8; b[2] = seq & 255;
    b[3] = len >> 8; b[4] = len & 255;
    const c = crc16(b, 5);
    b[5] = c >> 8; b[6] = c & 255;
    return b;
  }
  const HDR_SYMS = sectionSyms(7);

  function buildPacketTones(type, seq, payload) {
    const withCrc = new Uint8Array(payload.length + 4);
    withCrc.set(payload);
    const c = crc32(payload);
    withCrc[payload.length] = (c >>> 24) & 255;
    withCrc[payload.length + 1] = (c >>> 16) & 255;
    withCrc[payload.length + 2] = (c >>> 8) & 255;
    withCrc[payload.length + 3] = c & 255;
    const tones = [];
    tones.push(...SYNCSEQ);
    tones.push(...codeSection(buildHeaderBytes(type, seq, payload.length)));
    tones.push(...codeSection(withCrc));
    return Uint8Array.from(tones);
  }
  function packetSymCount(len) { return SYNCSEQ.length + HDR_SYMS + sectionSyms(len + 4); }

  /* frame byte budget for a target frame rate: one packet per frame,
     116 fixed symbols (sync + coded header + payload CRC/tail) */
  function frameByteBudget(fps) {
    const symBudget = Math.floor(BAUD / fps);
    return clamp(Math.floor((symBudget - 116) / 8), 8, MAX_PAYLOAD);
  }

  /* =====================================================================
     The frame engine — encoder
     =====================================================================
     Closed loop: the encoder keeps a reference picture built ONLY from
     the quantized coefficients it actually put on the air, using the
     exact reconstruction math the decoder uses. When every packet
     lands, both ends hold bit-identical pictures; when one is lost,
     the difference is confined to those blocks and the walking INTRA
     refresh (oldest-block-first) repaints them within one sweep. */
  class D3Encoder {
    constructor(cfg) {
      this.cfg = cfg;                       // {w,h,mono,quality,fps,refresh[,streamId]}
      this.g = makeGeom(cfg.w, cfg.h);
      this.qtY = quantTable(QLUMA, cfg.quality);
      this.qtC = quantTable(QCHROMA, cfg.quality);
      this.ref = makePlanes(this.g);
      this.snap = makePlanes(this.g);       // SOURCE pixels as of each block's last send
      this.everSent = new Uint8Array(this.g.nMB);
      this.lastIntra = new Int32Array(this.g.nMB).fill(-1);
      this.frameNo = 0;
      this.streamId = cfg.streamId != null ? (cfg.streamId & 0xFFFF)
                    : (1 + Math.floor(Math.random() * 65534));
      this.emaMB = 14;                      // adaptive bytes-per-block estimate
      this.budget = frameByteBudget(cfg.fps);
    }

    vhdrPayload() {
      const b = new Uint8Array(12);
      b[0] = MAGIC0; b[1] = MAGIC1;
      b[2] = this.g.nx; b[3] = this.g.ny;
      b[4] = this.cfg.quality;
      b[5] = Math.round(this.cfg.fps * 10);
      b[6] = this.cfg.mono ? 1 : 0;
      b[7] = this.cfg.refresh;
      b[8] = this.streamId >> 8; b[9] = this.streamId & 255;
      return b;
    }

    /* has the SOURCE moved in this block since we last coded it?
       (Comparing against the codec reference instead would let a block's
       own quantization error re-flag it as motion every frame — the
       channel would spend forever re-coding its own noise.) */
    _mbSad(cur, mx, my) {
      const g = this.g, snap = this.snap;
      let s = 0;
      const r0 = my * MB, c0 = mx * MB;
      for (let r = 0; r < MB; r++) {
        const base = (r0 + r) * g.w + c0;
        for (let c = 0; c < MB; c++) s += Math.abs(cur.Y[base + c] - snap.Y[base + c]);
      }
      let sad = s / (MB * MB);
      if (!this.cfg.mono) {
        let sc = 0;
        const rc0 = my * 8, cc0 = mx * 8;
        for (let r = 0; r < 8; r++) {
          const base = (rc0 + r) * g.wc + cc0;
          for (let c = 0; c < 8; c++)
            sc += Math.abs(cur.Cb[base + c] - snap.Cb[base + c]) +
                  Math.abs(cur.Cr[base + c] - snap.Cr[base + c]);
        }
        sad += 0.25 * sc / (8 * 8);
      }
      return sad;
    }

    _snapMB(cur, mx, my) {
      const g = this.g;
      for (let r = 0; r < MB; r++) {
        const src0 = (my * MB + r) * g.w + mx * MB;
        for (let c = 0; c < MB; c++) this.snap.Y[src0 + c] = cur.Y[src0 + c];
      }
      if (!this.cfg.mono) {
        for (let r = 0; r < 8; r++) {
          const src0 = (my * 8 + r) * g.wc + mx * 8;
          for (let c = 0; c < 8; c++) {
            this.snap.Cb[src0 + c] = cur.Cb[src0 + c];
            this.snap.Cr[src0 + c] = cur.Cr[src0 + c];
          }
        }
      }
    }

    /* quantize one macroblock's blocks for a mode; returns entries the
       committer can both entropy-write and fold into the reference */
    _quantMB(cur, mx, my, intra) {
      const g = this.g, ref = this.ref;
      const vals = new Float64Array(64);
      const list = [];
      for (const [dr, dc] of MB_LUMA) {
        const r0 = my * MB + dr, c0 = mx * MB + dc;
        if (intra) grabCentered(cur.Y, g.w, r0, c0, vals);
        else grabDiff(cur.Y, ref.Y, g.w, r0, c0, vals);
        list.push({ q: quantizeBlock(vals, this.qtY), qt: this.qtY,
                    chain: "Y", plane: "Y", pw: g.w, r0, c0 });
      }
      if (!this.cfg.mono) {
        const r0 = my * 8, c0 = mx * 8;
        if (intra) grabCentered(cur.Cb, g.wc, r0, c0, vals);
        else grabDiff(cur.Cb, ref.Cb, g.wc, r0, c0, vals);
        list.push({ q: quantizeBlock(vals, this.qtC), qt: this.qtC,
                    chain: "B", plane: "Cb", pw: g.wc, r0, c0 });
        if (intra) grabCentered(cur.Cr, g.wc, r0, c0, vals);
        else grabDiff(cur.Cr, ref.Cr, g.wc, r0, c0, vals);
        list.push({ q: quantizeBlock(vals, this.qtC), qt: this.qtC,
                    chain: "R", plane: "Cr", pw: g.wc, r0, c0 });
      }
      return list;
    }

    _bitsFor(list, intra, preds) {
      const bw = new BitWriter();
      const cp = clonePreds(preds);
      bw.bit(intra ? 1 : 0);
      for (const e of list)
        writeQBlock(bw, e.q, cp[(intra ? "i" : "d") + e.chain]);
      return bw.bitLength;
    }

    _commit(bw, list, intra, preds) {
      bw.bit(intra ? 1 : 0);
      const recon = new Float64Array(64);
      for (const e of list) {
        writeQBlock(bw, e.q, preds[(intra ? "i" : "d") + e.chain]);
        reconFromQ(e.q, e.qt, recon);
        if (intra) applyIntra(this.ref[e.plane], e.pw, e.r0, e.c0, recon);
        else applyDelta(this.ref[e.plane], e.pw, e.r0, e.c0, recon);
      }
    }

    /* One frame in, one packet payload out. Mutates the reference. */
    encodeFrame(cur) {
      const g = this.g;
      const blockBudgetBits = Math.max(0, (this.budget - 2 - g.bmBytes) * 8);

      /* motion: which blocks moved since the shared picture */
      const sad = new Float64Array(g.nMB);
      const changed = [];
      for (let my = 0; my < g.ny; my++)
        for (let mx = 0; mx < g.nx; mx++) {
          const i = my * g.nx + mx;
          sad[i] = this._mbSad(cur, mx, my);
          if (sad[i] > SAD_THRESH) changed.push(i);
        }
      changed.sort((a, b) => sad[b] - sad[a]);

      /* walking refresh: the blocks whose last INTRA is oldest */
      const refreshSet = new Set();
      if (this.cfg.refresh > 0) {
        const order = [];
        for (let i = 0; i < g.nMB; i++) order.push(i);
        order.sort((a, b) => (this.lastIntra[a] - this.lastIntra[b]) || (a - b));
        for (let k = 0; k < Math.min(this.cfg.refresh, g.nMB); k++)
          refreshSet.add(order[k]);
      }

      /* candidate set, capped by the adaptive size estimate */
      const estK = Math.max(refreshSet.size,
                            Math.floor(blockBudgetBits / 8 / this.emaMB) + 1);
      const include = new Set(refreshSet);
      for (const i of changed) {
        if (include.size >= estK) break;
        include.add(i);
      }

      /* raster-order encode with a hard fit check per block */
      const bw = new BitWriter();
      const preds = newPreds();
      const committed = [];
      const modes = [];
      const rects = [];
      let intraN = 0, deltaN = 0;
      let cheapest = null;                 // fallback so a frame never starves
      let overrun = false;
      const take = (i, mx, my, list, intra) => {
        this._commit(bw, list, intra, preds);
        this._snapMB(cur, mx, my);
        committed.push(i);
        modes.push(intra ? 1 : 0);
        rects.push({ mx, my, intra });
        this.everSent[i] = 1;
        if (intra) { this.lastIntra[i] = this.frameNo; intraN++; } else deltaN++;
      };
      for (let i = 0; i < g.nMB; i++) {
        if (!include.has(i)) continue;
        const mx = i % g.nx, my = (i / g.nx) | 0;
        const forceIntra = refreshSet.has(i) || !this.everSent[i];
        const listI = this._quantMB(cur, mx, my, true);
        const bitsI = this._bitsFor(listI, true, preds);
        let list = listI, intra = true, bits = bitsI;
        if (!forceIntra) {
          const listD = this._quantMB(cur, mx, my, false);
          const bitsD = this._bitsFor(listD, false, preds);
          if (bitsD < bitsI) { list = listD; intra = false; bits = bitsD; }
        }
        if (committed.length === 0 && (!cheapest || bits < cheapest.bits))
          cheapest = { i, mx, my, list, intra, bits };
        if (bw.bitLength + bits > blockBudgetBits) continue;   // stays pending
        take(i, mx, my, list, intra);
      }
      /* budget smaller than the single cheapest block (busy scene, tight
         rate): ship that one block anyway. The pacing simply lets this
         frame's airtime overrun its slot, so the effective frame rate
         floats down instead of the picture starving — the 1–2 fps in the
         name is a target, not a promise the physics can't keep. */
      if (committed.length === 0 && cheapest &&
          2 + g.bmBytes + Math.ceil(cheapest.bits / 8) <= MAX_PAYLOAD) {
        take(cheapest.i, cheapest.mx, cheapest.my, cheapest.list, cheapest.intra);
        overrun = true;
      }

      /* payload: frame number · block bitmap · coded blocks */
      const coded = bw.finish();
      const payload = new Uint8Array(2 + g.bmBytes + coded.length);
      payload[0] = (this.frameNo >> 8) & 255;
      payload[1] = this.frameNo & 255;
      for (const i of committed) payload[2 + (i >> 3)] |= 0x80 >> (i & 7);
      payload.set(coded, 2 + g.bmBytes);

      if (committed.length > 0)
        this.emaMB = clamp(0.7 * this.emaMB + 0.3 * (coded.length / committed.length), 4, 60);

      const out = { payload, frameNo: this.frameNo, sent: committed, modes,
                    rects, bytes: payload.length, intraN, deltaN, overrun,
                    pending: changed.length - rects.filter(r0 => sad[r0.my * g.nx + r0.mx] > SAD_THRESH).length };
      this.frameNo++;
      return out;
    }
  }

  /* =====================================================================
     The frame engine — decoder (radio-agnostic; fed verified payloads)
     ===================================================================== */
  function parseVhdr(payload) {
    if (payload.length < 12 || payload[0] !== MAGIC0 || payload[1] !== MAGIC1) return null;
    const nx = payload[2], ny = payload[3];
    const quality = payload[4], fps = payload[5] / 10;
    if (nx < 1 || nx > 16 || ny < 1 || ny > 16) return null;
    if (quality < 1 || quality > 100 || fps < 0.3 || fps > 5) return null;
    return { w: nx * MB, h: ny * MB, mono: !!(payload[6] & 1),
             quality, fps, refresh: payload[7],
             streamId: (payload[8] << 8) | payload[9] };
  }

  class D3Decoder {
    constructor() { this.cfg = null; }
    reset(cfg) {
      this.cfg = cfg;
      this.g = makeGeom(cfg.w, cfg.h);
      this.qtY = quantTable(QLUMA, cfg.quality);
      this.qtC = quantTable(QCHROMA, cfg.quality);
      this.P = makePlanes(this.g);
      this.age = new Float64Array(this.g.nMB).fill(-1);
      this.frames = 0;
      this.mbUpdates = 0;
      this.corrupt = 0;
      this.waiting = 0;
      this.lastT = -1;
      this.dtEma = 0;
      this.fpsEma = 0;
      this.lastFrameNo = -1;
    }
    applyVhdr(payload) {
      const cfg = parseVhdr(payload);
      if (!cfg) return { bad: true };
      if (!this.cfg || this.cfg.streamId !== cfg.streamId) {
        this.reset(cfg);
        return { isNew: true, cfg };
      }
      return { isNew: false, cfg: this.cfg };
    }
    applyVfrm(payload, tStream) {
      if (!this.cfg) { this.waiting++; return null; }
      const g = this.g;
      if (payload.length < 2 + g.bmBytes) { this.corrupt++; return { corrupt: true }; }
      try {
        const frameNo = (payload[0] << 8) | payload[1];
        const list = [];
        for (let i = 0; i < g.nMB; i++)
          if (payload[2 + (i >> 3)] & (0x80 >> (i & 7))) list.push(i);
        const br = new BitReader(payload.subarray(2 + g.bmBytes));
        const preds = newPreds();
        const recon = new Float64Array(64);
        const rects = [];
        for (const i of list) {
          const mx = i % g.nx, my = (i / g.nx) | 0;
          const intra = br.bit() === 1;
          for (const [dr, dc] of MB_LUMA) {
            const q = readQBlock(br, preds[(intra ? "i" : "d") + "Y"]);
            reconFromQ(q, this.qtY, recon);
            if (intra) applyIntra(this.P.Y, g.w, my * MB + dr, mx * MB + dc, recon);
            else applyDelta(this.P.Y, g.w, my * MB + dr, mx * MB + dc, recon);
          }
          if (!this.cfg.mono) {
            let q = readQBlock(br, preds[(intra ? "i" : "d") + "B"]);
            reconFromQ(q, this.qtC, recon);
            if (intra) applyIntra(this.P.Cb, g.wc, my * 8, mx * 8, recon);
            else applyDelta(this.P.Cb, g.wc, my * 8, mx * 8, recon);
            q = readQBlock(br, preds[(intra ? "i" : "d") + "R"]);
            reconFromQ(q, this.qtC, recon);
            if (intra) applyIntra(this.P.Cr, g.wc, my * 8, mx * 8, recon);
            else applyDelta(this.P.Cr, g.wc, my * 8, mx * 8, recon);
          }
          this.age[i] = tStream;
          rects.push({ mx, my, intra });
        }
        this.mbUpdates += list.length;
        this.frames++;
        if (this.lastT >= 0) {
          const dt = tStream - this.lastT;
          if (dt > 1e-3 && dt < 10) {
            this.dtEma = this.dtEma ? 0.7 * this.dtEma + 0.3 * dt : dt;
            this.fpsEma = 1 / this.dtEma;
          }
        }
        this.lastT = tStream;
        this.lastFrameNo = frameNo;
        return { frameNo, n: list.length, rects, t: tStream };
      } catch (e) {
        this.corrupt++;                       // malformed despite CRC — drop whole
        return { corrupt: true };
      }
    }
    imageRGB() { return this.cfg ? planesToRgb(this.P) : null; }
  }

  /* =====================================================================
     Symbols → air. One phase accumulator for the whole stream: packets
     and 1900 Hz pacing filler splice with no phase step, so the far
     end's VOX and AGC see one continuous carrier.
     ===================================================================== */
  class ToneRun {
    constructor(fs) { this.fs = fs; this.ph = 0; this.k = 2 * Math.PI / fs; }
    tone(f, n, amp) {
      const a = amp === undefined ? 0.85 : amp;
      const out = new Float32Array(Math.max(0, n | 0));
      for (let i = 0; i < out.length; i++) {
        this.ph += this.k * f;
        out[i] = a * Math.sin(this.ph);
      }
      return out;
    }
    symbols(tones) {
      const sp = this.fs / BAUD;
      const out = new Float32Array(Math.round(tones.length * sp));
      let cursor = 0;
      for (let s = 0; s < tones.length; s++) {
        const f = TONES[tones[s]];
        const n0 = Math.round(cursor);
        cursor += sp;
        const n1 = Math.round(cursor);
        for (let i = n0; i < n1; i++) {
          this.ph += this.k * f;
          out[i] = 0.85 * Math.sin(this.ph);
        }
      }
      return out;
    }
  }

  function rampEdges(y, fs) {
    const nf = Math.round(0.003 * fs);
    for (let i = 0; i < nf && i < y.length; i++) {
      const r = Math.sin(0.5 * Math.PI * i / nf) ** 2;
      y[i] *= r;
      y[y.length - 1 - i] *= r;
    }
  }

  /* Offline stream assembly — the loopback / WAV-render / self-test /
     headless-test path. frameProvider(i, tSec) returns YCbCr planes. */
  function buildStreamAudio(cfg, frameProvider, nFrames, opts) {
    const o = opts || {};
    const fs = TX_FS;
    const enc = o.encoder || new D3Encoder(cfg);
    const run = new ToneRun(fs);
    const parts = [];
    const layout = [];
    let n = 0;
    const push = (arr, meta) => {
      if (!arr.length) return;
      parts.push(arr);
      if (meta) layout.push(Object.assign({ at: n, len: arr.length }, meta));
      n += arr.length;
    };
    const pushPacket = (type, seq, payload, meta) =>
      push(run.symbols(buildPacketTones(type, seq, payload)), meta);

    if (o.voxHdr) push(run.tone(LEADER_F, Math.round(0.7 * fs)));
    push(run.tone(LEADER_F, Math.round(LEADER_S * fs)), { type: "leader" });
    const pre = new Uint8Array(PREAMBLE_SYMS);
    for (let i = 0; i < PREAMBLE_SYMS; i++) pre[i] = i & 1 ? 3 : 0;
    push(run.symbols(pre), { type: "preamble" });

    const origin = n;
    const spF = fs / cfg.fps;
    const vhdrEvery = Math.max(1, Math.round(VHDR_EVERY_S * cfg.fps));
    let vhdrSeq = 0;
    let payloadBytes = 0;
    for (let i = 0; i < nFrames; i++) {
      const slot = origin + Math.round(i * spF);
      if (n < slot) push(run.tone(LEADER_F, slot - n), { type: "filler" });
      if (i === 0) {
        pushPacket(PKT_VHDR, vhdrSeq++, enc.vhdrPayload(), { type: "vhdr" });
        pushPacket(PKT_VHDR, vhdrSeq++, enc.vhdrPayload(), { type: "vhdr" });
      } else if (i % vhdrEvery === 0) {
        pushPacket(PKT_VHDR, vhdrSeq++, enc.vhdrPayload(), { type: "vhdr" });
      }
      const fr = enc.encodeFrame(frameProvider(i, i / cfg.fps));
      payloadBytes += fr.bytes;
      pushPacket(PKT_VFRM, fr.frameNo & 0xFFFF, fr.payload,
                 { type: "vfrm", seq: fr.frameNo, mbs: fr.sent.length, bytes: fr.bytes });
    }
    pushPacket(PKT_END, 0, new Uint8Array(0), { type: "end" });

    const sig = new Float32Array(n);
    let p = 0;
    for (const part of parts) { sig.set(part, p); p += part.length; }
    rampEdges(sig, fs);
    const pad = Math.round(PAD_S * fs);
    const y = new Float32Array(pad + n + pad);
    y.set(sig, pad);
    for (const L of layout) L.at += pad;
    return { y, fs, layout, enc, payloadBytes, airS: y.length / fs };
  }

  /* =====================================================================
     Built-in moving test card (pure math — the headless tests use it
     too): colour bars, a bouncing ball, a sweep line, and a dot-matrix
     seconds digit so every second visibly changes.
     ===================================================================== */
  const DIGIT_GLYPHS = [
    [7, 5, 5, 5, 7], [2, 6, 2, 2, 7], [7, 1, 7, 4, 7], [7, 1, 7, 1, 7],
    [5, 5, 7, 1, 1], [7, 4, 7, 1, 7], [7, 4, 7, 5, 7], [7, 1, 1, 1, 1],
    [7, 5, 7, 5, 7], [7, 5, 7, 1, 7]
  ];
  function tri(x, span) {
    if (span <= 0) return 0;
    const p = 2 * span;
    const m = ((x % p) + p) % p;
    return m < span ? m : p - m;
  }
  function motionPattern(w, h, t) {
    const n = w * h;
    const img = { r: new Float64Array(n), g: new Float64Array(n), b: new Float64Array(n), w, h };
    for (let r = 0; r < h; r++) {
      const v = 10 + 18 * r / h;
      for (let c = 0; c < w; c++) {
        const i = r * w + c;
        img.r[i] = v; img.g[i] = v + 3; img.b[i] = v + 12;
      }
    }
    const barsH = Math.max(6, Math.round(h / 6));
    const BARS = [[192, 192, 192], [192, 192, 0], [0, 192, 192], [0, 192, 0],
                  [192, 0, 192], [192, 0, 0], [0, 0, 192]];
    for (let r = 0; r < barsH; r++)
      for (let c = 0; c < w; c++) {
        const bcol = BARS[Math.min(6, Math.floor(7 * c / w))];
        const i = r * w + c;
        img.r[i] = bcol[0]; img.g[i] = bcol[1]; img.b[i] = bcol[2];
      }
    const sx = Math.floor((t * w / 6) % w);
    for (let r = barsH; r < h; r++)
      for (let c = sx; c < Math.min(w, sx + 2); c++) {
        const i = r * w + c;
        img.r[i] = 69; img.g[i] = 199; img.b[i] = 214;
      }
    const R = Math.max(4, Math.round(h / 6));
    const cx = R + tri(t * w * 0.35, w - 2 * R);
    const cy = barsH + R + tri(t * h * 0.55 + 7, Math.max(1, h - barsH - 2 * R));
    const R2 = R * R;
    for (let r = Math.max(0, cy - R) | 0; r <= Math.min(h - 1, cy + R); r++)
      for (let c = Math.max(0, cx - R) | 0; c <= Math.min(w - 1, cx + R); c++) {
        const dx = c - cx, dy = r - cy;
        if (dx * dx + dy * dy <= R2) {
          const i = r * w + c;
          img.r[i] = 235; img.g[i] = 196; img.b[i] = 64;
        }
      }
    const cell = Math.max(2, Math.round(w / 24));
    const gw = 5 * cell, gh = 7 * cell;
    const gx = w - gw - cell, gy = h - gh - cell;
    const glyph = DIGIT_GLYPHS[Math.floor(Math.max(0, t)) % 10];
    for (let r = 0; r < gh; r++)
      for (let c = 0; c < gw; c++) {
        const i = (gy + r) * w + (gx + c);
        img.r[i] = 18; img.g[i] = 20; img.b[i] = 28;
      }
    for (let gr = 0; gr < 5; gr++)
      for (let gc = 0; gc < 3; gc++) {
        if (!(glyph[gr] & (4 >> gc))) continue;
        for (let r = 0; r < cell; r++)
          for (let c = 0; c < cell; c++) {
            const i = (gy + (gr + 1) * cell + r) * w + (gx + (gc + 1) * cell + c);
            img.r[i] = 235; img.g[i] = 235; img.b[i] = 235;
          }
      }
    return img;
  }

  function psnrY(Pa, Pb) {
    let mse = 0;
    const n = Pa.Y.length;
    for (let i = 0; i < n; i++) {
      const d = Pa.Y[i] - Pb.Y[i];
      mse += d * d;
    }
    mse /= n;
    return mse < 1e-12 ? Infinity : 10 * Math.log10(255 * 255 / mse);
  }
  function planesMaxDiff(Pa, Pb, mono) {
    let m = 0;
    for (let i = 0; i < Pa.Y.length; i++) m = Math.max(m, Math.abs(Pa.Y[i] - Pb.Y[i]));
    if (!mono) {
      for (let i = 0; i < Pa.Cb.length; i++) {
        m = Math.max(m, Math.abs(Pa.Cb[i] - Pb.Cb[i]));
        m = Math.max(m, Math.abs(Pa.Cr[i] - Pb.Cr[i]));
      }
    }
    return m;
  }

  /* =====================================================================
     Streaming receiver. The D1 decoder reads a finished recording; live
     television never finishes, so this is the same acquisition (per-
     packet sync search + refine, soft LLRs, Viterbi, CRC verdicts) run
     as a state machine over a rolling buffer. Between packets the
     transmitter parks on 1900 Hz pacing filler, which correlates with
     no tone pattern — the hunt simply slides across it to the next
     packet's sync. Every packet re-locks timing, so clock drift can
     never accumulate no matter how long the programme runs.
     ===================================================================== */
  class StreamRX {
    constructor(fs, cb) {
      this.fs = fs;
      this.cb = cb || {};
      this.spSym = fs / BAUD;
      this.buf = new Float32Array(1 << 17);
      this.len = 0;                    // valid samples in buf
      this.base = 0;                   // absolute sample index of buf[0]
      this.cursor = 0;                 // absolute position (float)
      this.state = "hunt";
      this.hdr = null;                 // cached header between pumps
      this.dec = new D3Decoder();
      this.stats = { pkts: 0, crcFail: 0, hdrFail: 0, sync: 0, netBytes: 0 };
      this.gate = 3e-4;                // hunt squelch, mean |x| per symbol
      this.ended = false;
      this._bq = [makeBiquad("hp", 450, 0.707, fs), makeBiquad("lp", 2750, 0.707, fs)];
      this._E = new Float64Array(4);
      this._pumping = false;
    }
    get avail() { return this.base + this.len; }
    get timeS() { return this.cursor / this.fs; }

    push(x) {
      const f = Float32Array.from(x);
      this._bq[0].run(f);
      this._bq[1].run(f);
      if (this.len + f.length > this.buf.length) {
        let cap = this.buf.length;
        while (this.len + f.length > cap) cap *= 2;
        const nb = new Float32Array(cap);
        nb.set(this.buf.subarray(0, this.len));
        this.buf = nb;
      }
      this.buf.set(f, this.len);
      this.len += f.length;
    }

    async drain() {
      if (this._pumping) return;
      this._pumping = true;
      try {
        let n = 0;
        while (this._step()) {
          if ((++n & 7) === 0) await tick();
        }
      } finally {
        this._pumping = false;
      }
    }

    /* windowed correlation vs the 4 tones over the central 76 % (D1's) */
    _energies(t0, t1, E) {
      const g = 0.12;
      const lw = t1 - t0;
      let a = Math.round(t0 + g * lw) - this.base;
      let b = Math.round(t1 - g * lw) - this.base;
      a = clamp(a, 0, this.len);
      b = clamp(b, a + 4, this.len);
      for (let t = 0; t < 4; t++) {
        const w = 2 * Math.PI * TONES[t] / this.fs;
        let cr = 0, ci = 0;
        for (let i = a; i < b; i++) {
          cr += this.buf[i] * Math.cos(w * i);
          ci += this.buf[i] * Math.sin(w * i);
        }
        E[t] = (cr * cr + ci * ci) / Math.max(1, b - a);
      }
    }
    _syncScore(pos, E) {
      let score = 0;
      for (let k = 0; k < SYNCSEQ.length; k++) {
        this._energies(pos + k * this.spSym, pos + (k + 1) * this.spSym, E);
        const want = SYNCSEQ[k];
        let other = 0;
        for (let t = 0; t < 4; t++) if (t !== want && E[t] > other) other = E[t];
        score += (E[want] - other) / (E[want] + other + 1e-12);
      }
      return score / SYNCSEQ.length;
    }
    _refine(guess, spanSyms, stepFrac, E) {
      let best = -2, bestPos = guess;
      const step = this.spSym * stepFrac;
      const half = spanSyms * this.spSym;
      for (let pos = guess - half; pos <= guess + half; pos += step) {
        if (pos < this.base) continue;
        const sc = this._syncScore(pos, E);
        if (sc > best) { best = sc; bestPos = pos; }
      }
      return { pos: bestPos, score: best };
    }
    _readLLR(pos, nSyms, E) {
      const llr = new Float64Array(2 * nSyms);
      for (let k = 0; k < nSyms; k++) {
        this._energies(pos + k * this.spSym, pos + (k + 1) * this.spSym, E);
        const lg = [Math.log(E[0] + 1e-12), Math.log(E[1] + 1e-12),
                    Math.log(E[2] + 1e-12), Math.log(E[3] + 1e-12)];
        llr[2 * k] = Math.max(lg[GRAY_ENC.indexOf(2)], lg[GRAY_ENC.indexOf(3)])
                   - Math.max(lg[GRAY_ENC.indexOf(0)], lg[GRAY_ENC.indexOf(1)]);
        llr[2 * k + 1] = Math.max(lg[1], lg[2]) - Math.max(lg[0], lg[3]);
      }
      return llr;
    }
    _decodeSection(pos, nBytes, E) {
      const nSyms = sectionSyms(nBytes);
      const llr = this._readLLR(pos, nSyms, E);
      const bits = viterbiDecode(deinterleave(llr), nBytes * 8);
      return bitsToBytes(bits);
    }

    _compact() {
      const keep = 2 * this.fs;
      const anchor = this.hdr ? Math.min(this.cursor, this.hdr.bodyAt) : this.cursor;
      const cut = Math.floor(anchor - this.base - keep);
      if (cut > 4 * this.fs) {
        this.buf.copyWithin(0, cut, this.len);
        this.len -= cut;
        this.base += cut;
      }
    }

    _step() {
      const E = this._E;
      if (this.state === "hunt") {
        const need = (SYNCSEQ.length + 1) * this.spSym;
        let scanned = 0;
        while (this.avail - this.cursor >= need + this.spSym) {
          const a = clamp(Math.round(this.cursor) - this.base, 0, this.len);
          const b = Math.min(this.len, a + Math.round(this.spSym));
          let s = 0;
          for (let i = a; i < b; i++) s += Math.abs(this.buf[i]);
          if (s / Math.max(1, b - a) < this.gate) {
            this.cursor += this.spSym;                 // silence — slide fast
          } else {
            const sc = this._syncScore(this.cursor, E);
            if (sc > 0.55) {
              const r = this._refine(this.cursor, 0.6, 1 / 16, E);
              if (r.score > 0.45) {
                this.cursor = r.pos;
                this.stats.sync = r.score;
                this.state = "pkt";
                this.hdr = null;
                if (this.cb.log) this.cb.log(`sync acquired, score ${r.score.toFixed(2)}`);
                return true;
              }
            }
            this.cursor += this.spSym / 3;
          }
          if (++scanned >= 48) return true;            // yield to the UI
        }
        this._compact();
        return false;
      }

      if (!this.hdr) {
        const need = (SYNCSEQ.length + HDR_SYMS + 2) * this.spSym;
        if (this.avail - this.cursor < need) { this._compact(); return false; }
        const rl = this._refine(this.cursor, 0.6, 1 / 16, E);
        if (rl.score < 0.30) {
          /* pacing filler or a destroyed sync — bounded forward hunt */
          const limit = Math.min(this.avail - need, this.cursor + 4 * this.fs);
          let hunt = { score: -2, pos: this.cursor };
          for (let pos = this.cursor + this.spSym; pos < limit; pos += this.spSym / 3) {
            const sc = this._syncScore(pos, E);
            if (sc > hunt.score) hunt = { score: sc, pos };
            if (sc > 0.8) break;
          }
          if (hunt.score >= 0.40) {
            this.cursor = this._refine(hunt.pos, 0.6, 1 / 16, E).pos;
            return true;
          }
          if (this.avail - this.cursor > 4.5 * this.fs) {
            this.cursor = Math.max(this.cursor, limit);
            this.state = "hunt";
            if (this.cb.log) this.cb.log("carrier lost — hunting");
            return true;
          }
          return false;                                // wait for more audio
        }
        let pos = rl.pos + SYNCSEQ.length * this.spSym;
        const hb = this._decodeSection(pos, 7, E);
        pos += HDR_SYMS * this.spSym;
        if (crc16(hb, 5) !== ((hb[5] << 8) | hb[6])) {
          this.stats.hdrFail++;
          this.cursor = pos;                           // resync will recover
          return true;
        }
        const len = (hb[3] << 8) | hb[4];
        if (len > 300) {
          this.stats.hdrFail++;
          this.cursor = pos;
          return true;
        }
        this.hdr = { type: hb[0], seq: (hb[1] << 8) | hb[2], len, bodyAt: pos };
        return true;
      }

      const bodySyms = sectionSyms(this.hdr.len + 4);
      if (this.avail - this.hdr.bodyAt < (bodySyms + 2) * this.spSym) return false;
      const body = this._decodeSection(this.hdr.bodyAt, this.hdr.len + 4, E);
      const L = this.hdr.len;
      const payload = body.subarray(0, L);
      const got = ((body[L] << 24) | (body[L + 1] << 16) |
                   (body[L + 2] << 8) | body[L + 3]) >>> 0;
      const ok = crc32(payload) === got;
      const type = this.hdr.type, seq = this.hdr.seq;
      this.cursor = this.hdr.bodyAt + bodySyms * this.spSym;
      this.hdr = null;
      this._dispatch(type, seq, payload, ok, this.cursor / this.fs);
      this._compact();
      return true;
    }

    _dispatch(type, seq, payload, ok, t) {
      this.stats.pkts++;
      if (!ok) {
        this.stats.crcFail++;                          // dropped whole — never applied
        if (this.cb.onStats) this.cb.onStats(this);
        return;
      }
      if (type === PKT_VHDR) {
        const r = this.dec.applyVhdr(payload);
        if (r.bad) this.stats.hdrFail++;
        else if (r.isNew && this.cb.onVhdr) this.cb.onVhdr(r.cfg, this);
      } else if (type === PKT_VFRM) {
        this.stats.netBytes += payload.length;
        const r = this.dec.applyVfrm(payload, t);
        if (r && !r.corrupt && this.cb.onFrame) this.cb.onFrame(r, this);
      } else if (type === PKT_END) {
        this.ended = true;
        this.state = "hunt";
        if (this.cb.log) this.cb.log("end of transmission");
        if (this.cb.onEnd) this.cb.onEnd(this);
      }
      if (this.cb.onStats) this.cb.onStats(this);
    }
  }

  /* =====================================================================
     Spectrogram (the "on-air scope") — same look as the D1/SSTV modules
     ===================================================================== */
  const SPEC_STOPS = [[0.00, [10, 12, 20]], [0.35, [24, 62, 120]],
                      [0.60, [28, 168, 178]], [0.82, [245, 195, 70]],
                      [1.00, [255, 255, 255]]];
  const SPEC_LUT = (() => {
    const lut = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      for (let s = 0; s < SPEC_STOPS.length - 1; s++) {
        const a = SPEC_STOPS[s], b = SPEC_STOPS[s + 1];
        if (t >= a[0] && t <= b[0]) {
          const u = (t - a[0]) / (b[0] - a[0] + 1e-9);
          for (let k = 0; k < 3; k++) lut[i * 3 + k] = Math.round(a[1][k] + u * (b[1][k] - a[1][k]));
          break;
        }
      }
    }
    return lut;
  })();

  function drawSpectrogram(canvas, y, fs, fmax) {
    if (!canvas || !canvas.getContext) return;
    fmax = fmax || 3500;
    const W = canvas.width, H = canvas.height;
    const nfft = 1024;
    const hop = Math.max(nfft >> 2, Math.floor(y.length / Math.max(W, 1)) || 1);
    const frames = Math.max(1, Math.floor((y.length - nfft) / hop) + 1);
    const kmax = Math.min(nfft / 2, Math.floor(nfft * fmax / fs) + 1);
    const cols = new Float32Array(frames * kmax);
    const re = new Float64Array(nfft), im = new Float64Array(nfft);
    const win = new Float64Array(nfft);
    for (let i = 0; i < nfft; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / nfft);
    let mx = -1e9;
    for (let t = 0; t < frames; t++) {
      const off = t * hop;
      for (let i = 0; i < nfft; i++) {
        const j = off + i;
        re[i] = j < y.length ? y[j] * win[i] : 0;
        im[i] = 0;
      }
      fft(re, im, false);
      for (let k = 0; k < kmax; k++) {
        const db = 20 * Math.log10(Math.hypot(re[k], im[k]) + 1e-6);
        cols[t * kmax + k] = db;
        if (db > mx) mx = db;
      }
    }
    const tmp = document.createElement("canvas");
    tmp.width = frames; tmp.height = kmax;
    const tc = tmp.getContext("2d");
    const id = tc.createImageData(frames, kmax);
    for (let t = 0; t < frames; t++) {
      for (let k = 0; k < kmax; k++) {
        const v = clamp((cols[t * kmax + k] - mx + 70) * (255 / 70), 0, 255) | 0;
        const q = ((kmax - 1 - k) * frames + t) * 4;
        id.data[q] = SPEC_LUT[v * 3];
        id.data[q + 1] = SPEC_LUT[v * 3 + 1];
        id.data[q + 2] = SPEC_LUT[v * 3 + 2];
        id.data[q + 3] = 255;
      }
    }
    tc.putImageData(id, 0, 0);
    const c = canvas.getContext("2d");
    c.imageSmoothingEnabled = true;
    c.clearRect(0, 0, W, H);
    c.drawImage(tmp, 0, 0, W, H);
  }

  /* =====================================================================
     Module definition (browser shell)
     ===================================================================== */
  const CHANNELS = [["Off (direct)", null, "ssb"], ["SSB 2.7 kHz", 2700, "ssb"],
                    ["SSB 2.4 kHz", 2400, "ssb"], ["FM 3 kHz (FRS)", 3000, "fm"]];

  const def = {
    id: "d3",

    init(ctx) {
      this.ctx = ctx;
      this.sizeIdx = 0;                    // 64×48 — the motion size
      this.colour = false;                 // mono by default: NBTV blood
      this.quality = "low";           // motion first: cheap blocks, more of them
      this.fps = 1;
      this.refresh = 1;
      this.voxHdr = false;
      this.source = "pattern";
      this.overlayCall = true;
      this.overlayClock = true;
      this.squelchDb = -48;
      this.live = null;                    // running TX session
      this.listening = false;
      this.rx = null;                      // live StreamRX
      this.rxFrames = [];                  // replay ring
      this.replaying = false;
      this.camVideo = null;
      this.camStream = null;
      this.fileVideo = null;
      this._busy = false;
      this._flash = null;
      this._meterAt = 0;
      this._scopeBuf = null;
      this._scopeAt = 0;
      this._panelT0 = 0;
      this._raf = 0;
      this._prevAt = 0;
      if (!this._subscribed) {
        this._subscribed = true;
        ctx.audio.onSamples((samples, sr) => this._rxFeed(samples, sr));
      }
    },

    createPanel(el) {
      const sizeOpts = SIZES.map((s, i) =>
        `<option value="${i}"${i === this.sizeIdx ? " selected" : ""}>${s[0]}×${s[1]}</option>`).join("");
      const chanOpts = CHANNELS.map((c, i) => `<option value="${i}">${c[0]}</option>`).join("");
      const fpsOpts = FPS_OPTS.map(f =>
        `<option value="${f}"${f === this.fps ? " selected" : ""}>${f} fps</option>`).join("");
      el.innerHTML = `
        <div class="mod-layout">
          <div class="mod-main">
            <div class="card">
              <header class="card-head"><h3>RX monitor</h3>
                <span class="card-tag mono" id="d3-stage">idle</span></header>
              <div style="padding:14px;display:flex;justify-content:center;background:#05070b">
                <canvas id="d3-rx" width="96" height="64"
                  style="width:min(100%,560px);border:1px solid rgba(96,114,150,0.3);background:#333;image-rendering:pixelated"></canvas>
              </div>
              <div class="card-foot mod-controls">
                <span class="mono" id="d3-rxinfo" style="flex:1">—</span>
                <span class="mono" style="font-size:10px;opacity:0.7">freshness</span>
                <canvas id="d3-fresh" width="6" height="4"
                  style="height:40px;image-rendering:pixelated;border:1px solid rgba(96,114,150,0.3)"></canvas>
                <button class="btn btn-mini" id="d3-replay" disabled>Replay RX</button>
                <button class="btn btn-mini" id="d3-saveimg" disabled>Save frame</button>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>On-air scope</h3>
                <span class="card-tag mono" id="d3-airinfo">—</span></header>
              <div style="padding:10px;background:#05070b">
                <canvas id="d3-spec" width="740" height="150" style="width:100%;display:block"></canvas>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>TX picture · live</h3>
                <span class="card-tag mono" id="d3-txtag">what the encoder sees</span></header>
              <div style="padding:14px;display:flex;justify-content:center;background:#05070b">
                <canvas id="d3-tx" width="64" height="48"
                  style="width:min(100%,560px);border:1px solid rgba(96,114,150,0.3);background:#000;image-rendering:pixelated"></canvas>
              </div>
              <div class="card-foot mod-controls">
                <label class="field"><span>Source</span>
                  <select id="d3-source">
                    <option value="pattern">Moving test card</option>
                    <option value="camera">Webcam (live)</option>
                    <option value="video">Video file (loop)</option>
                  </select></label>
                <label class="btn" for="d3-vfile">Load video…</label>
                <input type="file" id="d3-vfile" accept="video/*" style="display:none">
                <label class="field" style="flex-direction:row;align-items:center;gap:6px">
                  <input type="checkbox" id="d3-call" checked><span>Callsign</span></label>
                <label class="field" style="flex-direction:row;align-items:center;gap:6px">
                  <input type="checkbox" id="d3-clock" checked><span>Clock</span></label>
              </div>
            </div>
          </div>
          <div class="mod-side">
            <div class="card">
              <header class="card-head"><h3>Picture · link</h3></header>
              <div class="card-body mod-controls" style="flex-direction:column;align-items:stretch">
                <label class="field"><span>Size</span>
                  <select id="d3-size">${sizeOpts}</select></label>
                <label class="field"><span>Colour</span>
                  <select id="d3-colour">
                    <option value="mono" selected>Mono (faster)</option>
                    <option value="colour">Colour 4:2:0</option>
                  </select></label>
                <label class="field"><span>Quality</span>
                  <select id="d3-quality">
                    <option value="low" selected>Low (most motion)</option>
                    <option value="med">Medium</option>
                    <option value="high">High</option>
                  </select></label>
                <label class="field"><span>Target rate</span>
                  <select id="d3-fps">${fpsOpts}</select></label>
                <label class="field"><span>INTRA refresh</span>
                  <select id="d3-refresh">
                    <option value="0">Off</option>
                    <option value="1" selected>1 block / frame</option>
                    <option value="2">2 blocks / frame</option>
                  </select></label>
                <div class="mod-note mono" id="d3-linkinfo" style="font-size:11px">—</div>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>Transmit</h3></header>
              <div class="card-body mod-controls" style="flex-direction:column;align-items:stretch">
                <button class="btn btn-accent" id="d3-golive">Go live (TX)</button>
                <button class="btn" id="d3-stop">Stop (END + sign-off)</button>
                <div class="mod-controls">
                  <label class="field" style="flex:1"><span>WAV length</span>
                    <select id="d3-wavdur">
                      <option value="10" selected>10 s</option>
                      <option value="20">20 s</option>
                      <option value="30">30 s</option>
                    </select></label>
                  <button class="btn" id="d3-recwav">Record WAV</button>
                </div>
                <label class="field"><span>Loopback channel</span>
                  <select id="d3-chan">${chanOpts}</select></label>
                <div class="mod-controls">
                  <label class="field" style="flex-direction:row;align-items:center;gap:6px">
                    <input type="checkbox" id="d3-noise"><span>Noise, SNR</span></label>
                  <input type="number" id="d3-snr" value="10" min="-5" max="40" style="width:64px">
                  <span class="mono">dB</span>
                </div>
                <button class="btn" id="d3-loop">Loopback (10 s of test card)</button>
                <label class="field" style="flex-direction:row;align-items:center;gap:6px">
                  <input type="checkbox" id="d3-voxhdr"><span>VOX keying header (FRS)</span></label>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>Receive</h3></header>
              <div class="card-body mod-controls" style="flex-direction:column;align-items:stretch">
                <button class="btn" id="d3-listen">Listen (live TV)</button>
                <div class="mod-controls">
                  <span class="mono" id="d3-meter" style="min-width:64px">— dB</span>
                  <label class="field" style="flex:1"><span>Squelch</span>
                    <input type="range" id="d3-squelch" min="-70" max="-15" step="1" value="-48"></label>
                </div>
                <label class="btn" for="d3-wavin" style="text-align:center">Decode WAV…</label>
                <input type="file" id="d3-wavin" accept=".wav,audio/wav,audio/x-wav" style="display:none">
                <button class="btn" id="d3-selftest">Self-test (loopback)</button>
              </div>
            </div>
            <div class="mod-note">
              HRWS-D3 is moving television over a voice channel: D1's protected
              stripes, but per frame only the 16×16 blocks that <i>changed</i>
              are sent — INTRA (self-contained) or DELTA (difference against
              the picture both ends already share). Noise drops a whole frame
              packet, never smears it; the walking INTRA refresh repaints the
              oldest blocks so a loss heals by itself. Both ends need this
              studio. Identify per your local regulations.
            </div>
            <div class="mod-note">
              Lineage: conditional replenishment with forced updating is how
              1988's H.261 videophones survived 64 kbit/s. Here it runs at
              0.5 kbit/s net — NBTV's great-grandchild, blocky and honest,
              1–2 fps through any SSB rig. The freshness map beside the
              monitor shows each block's age: cyan is seconds old, ember is
              waiting for the refresh sweep to come around.
            </div>
          </div>
        </div>`;

      const $ = id => el.querySelector("#d3-" + id);
      this.ui = {
        rx: $("rx"), fresh: $("fresh"), stage: $("stage"), rxinfo: $("rxinfo"),
        replay: $("replay"), saveimg: $("saveimg"),
        spec: $("spec"), airinfo: $("airinfo"),
        tx: $("tx"), txtag: $("txtag"), source: $("source"), vfile: $("vfile"),
        call: $("call"), clock: $("clock"),
        size: $("size"), colour: $("colour"), quality: $("quality"),
        fps: $("fps"), refresh: $("refresh"), linkinfo: $("linkinfo"),
        golive: $("golive"), stop: $("stop"), wavdur: $("wavdur"), recwav: $("recwav"),
        chan: $("chan"), noise: $("noise"), snr: $("snr"), loop: $("loop"),
        voxhdr: $("voxhdr"),
        listen: $("listen"), meter: $("meter"), squelch: $("squelch"),
        wavin: $("wavin"), selftest: $("selftest")
      };

      this.ui.size.addEventListener("change", () => {
        this.sizeIdx = parseInt(this.ui.size.value, 10);
        this._applyTxSize();
      });
      this.ui.colour.addEventListener("change", () => {
        this.colour = this.ui.colour.value === "colour";
        this._updateLink();
      });
      this.ui.quality.addEventListener("change", () => { this.quality = this.ui.quality.value; this._updateLink(); });
      this.ui.fps.addEventListener("change", () => { this.fps = parseFloat(this.ui.fps.value); this._updateLink(); });
      this.ui.refresh.addEventListener("change", () => { this.refresh = parseInt(this.ui.refresh.value, 10); this._updateLink(); });
      this.ui.voxhdr.addEventListener("change", () => { this.voxHdr = this.ui.voxhdr.checked; });
      this.ui.call.addEventListener("change", () => { this.overlayCall = this.ui.call.checked; });
      this.ui.clock.addEventListener("change", () => { this.overlayClock = this.ui.clock.checked; });
      this.ui.squelch.addEventListener("input", () => {
        this.squelchDb = parseFloat(this.ui.squelch.value);
        if (this.rx) this.rx.gate = Math.pow(10, this.squelchDb / 20) * 0.7;
      });
      this.ui.source.addEventListener("change", () => this._sourceChanged(this.ui.source.value));
      this.ui.vfile.addEventListener("change", e => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        this._loadVideoFile(f);
        e.target.value = "";
      });
      this.ui.golive.addEventListener("click", () => this._goLive());
      this.ui.stop.addEventListener("click", () => this._stopEverything());
      this.ui.recwav.addEventListener("click", () => this._recordWav());
      this.ui.loop.addEventListener("click", () => this._loopback());
      this.ui.listen.addEventListener("click", () => this._toggleListen());
      this.ui.wavin.addEventListener("change", e => {
        const f = e.target.files && e.target.files[0];
        if (f) this._decodeWavFile(f);
        e.target.value = "";
      });
      this.ui.replay.addEventListener("click", () => this._replay());
      this.ui.saveimg.addEventListener("click", () => this._saveFrame());
      this.ui.selftest.addEventListener("click", () => this._selfTest());

      this._panelT0 = performance.now();
      this._applyTxSize();
      const rc = this.ui.rx.getContext("2d");
      rc.fillStyle = "#333";
      rc.fillRect(0, 0, this.ui.rx.width, this.ui.rx.height);
      this._previewLoop();
    },

    onDeactivate() {
      if (this.live) this._stopTx(true);
      this.listening = false;
      this.rx = null;
      this.replaying = false;
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = 0;
      this._camStop();
      if (this.fileVideo) { try { this.fileVideo.pause(); } catch (e) {} this.fileVideo = null; }
      this.ui = null;
    },

    _stage(t) { if (this.ui) this.ui.stage.textContent = t; },
    _size() { return SIZES[this.sizeIdx]; },
    _cfg() {
      const [w, h] = this._size();
      return { w, h, mono: !this.colour, quality: QUALITY[this.quality],
               fps: this.fps, refresh: this.refresh };
    },

    _updateLink() {
      if (!this.ui) return;
      const cfg = this._cfg();
      const g = makeGeom(cfg.w, cfg.h);
      const budget = frameByteBudget(cfg.fps);
      const blkBytes = Math.max(0, budget - 2 - g.bmBytes);
      const perMB = cfg.mono ? 12 : 16;
      const estMB = blkBytes / perMB;
      const sweep = cfg.refresh > 0
        ? Math.ceil(g.nMB / cfg.refresh) / cfg.fps : 0;
      this.ui.linkinfo.textContent =
        `4-FSK 500 Bd · K=7 Viterbi · 500 bps net · budget ${budget} B/frame ` +
        `≈ ${estMB.toFixed(1)} blk · ${g.nMB} blocks total` +
        (sweep ? ` · refresh sweep ~${Math.round(sweep)} s` : " · no refresh (loss stays)");
      if (estMB < 1)
        this.ui.linkinfo.textContent += " · ⚠ budget below 1 block — drop rate/size";
    },

    _applyTxSize() {
      const [w, h] = this._size();
      this.ui.tx.width = w; this.ui.tx.height = h;
      this._updateLink();
    },

    /* ---------------- TX sources ---------------- */
    _sourceChanged(v) {
      this.source = v;
      if (v === "camera") this._camStart();
      else this._camStop();
      if (v !== "video" && this.fileVideo) { try { this.fileVideo.pause(); } catch (e) {} }
      if (v === "video" && this.fileVideo) this.fileVideo.play().catch(() => {});
    },
    async _camStart() {
      if (this.camStream) return;
      try {
        this.camStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 320 }, height: { ideal: 240 } }, audio: false
        });
        const v = document.createElement("video");
        v.muted = true; v.playsInline = true;
        v.srcObject = this.camStream;
        await v.play();
        this.camVideo = v;
        this.ctx.log("webcam live");
      } catch (e) {
        this.ctx.log("webcam unavailable: " + e.message);
        this.source = "pattern";
        if (this.ui) this.ui.source.value = "pattern";
      }
    },
    _camStop() {
      if (this.camStream) {
        this.camStream.getTracks().forEach(t => t.stop());
        this.camStream = null;
        this.camVideo = null;
      }
    },
    _loadVideoFile(f) {
      const v = document.createElement("video");
      v.muted = true; v.loop = true; v.playsInline = true;
      v.src = URL.createObjectURL(f);
      v.play().then(() => {
        this.fileVideo = v;
        this.source = "video";
        if (this.ui) this.ui.source.value = "video";
        this.ctx.log(`video loaded (${v.videoWidth}×${v.videoHeight}), looping`);
      }).catch(e => this.ctx.log("video failed: " + e.message));
    },

    /* draw the CLEAN frame the encoder will see (no flash overlays) */
    _renderSourceAt(cv, tPat, clockDate) {
      const w = cv.width, h = cv.height;
      const c = cv.getContext("2d");
      if (this.source === "pattern" || (this.source === "camera" && !this.camVideo) ||
          (this.source === "video" && !this.fileVideo)) {
        const p = motionPattern(w, h, tPat);
        const id = c.createImageData(w, h);
        for (let i = 0; i < w * h; i++) {
          id.data[i * 4] = p.r[i]; id.data[i * 4 + 1] = p.g[i];
          id.data[i * 4 + 2] = p.b[i]; id.data[i * 4 + 3] = 255;
        }
        c.putImageData(id, 0, 0);
      } else {
        const src = this.source === "camera" ? this.camVideo : this.fileVideo;
        const sw = src.videoWidth || 320, sh = src.videoHeight || 240;
        const s = Math.max(w / sw, h / sh);              // cover
        const nw = sw * s, nh = sh * s;
        c.imageSmoothingEnabled = true;
        c.drawImage(src, (w - nw) / 2, (h - nh) / 2, nw, nh);
      }
      if (this.overlayCall) {
        const call = (this.ctx.settings().callsign || "").trim().toUpperCase();
        if (call) {
          const size = Math.max(7, Math.round(h * 0.14));
          c.font = `bold ${size}px "Chakra Petch", monospace`;
          c.textBaseline = "top"; c.textAlign = "left";
          const tw = c.measureText(call).width;
          c.fillStyle = "rgb(4,4,8)";
          c.fillRect(1, 1, Math.min(w - 2, tw + 4), size + 3);
          c.fillStyle = "#fff";
          c.fillText(call, 3, 2);
        }
      }
      if (this.overlayClock) {
        const d = clockDate || new Date();
        const p2 = n => String(n).padStart(2, "0");
        const txt = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
        const size = Math.max(6, Math.round(h * 0.12));
        c.font = `${size}px "IBM Plex Mono", monospace`;
        c.textBaseline = "bottom"; c.textAlign = "left";
        const tw = c.measureText(txt).width;
        c.fillStyle = "rgb(4,4,8)";
        c.fillRect(1, h - size - 4, Math.min(w - 2, tw + 4), size + 3);
        c.fillStyle = "#cfe3ff";
        c.fillText(txt, 3, h - 2);
      }
    },

    _previewLoop() {
      const step = () => {
        if (!this.ui) return;
        this._raf = requestAnimationFrame(step);
        const now = performance.now();
        if (now - this._prevAt < 80) return;             // ~12 fps preview
        this._prevAt = now;
        this._renderSourceAt(this.ui.tx, (now - this._panelT0) / 1000, new Date());
        if (this._flash && now - this._flash.t < 450) {
          const c = this.ui.tx.getContext("2d");
          const a = 1 - (now - this._flash.t) / 450;
          c.lineWidth = 1;
          for (const r of this._flash.rects) {
            c.strokeStyle = r.intra ? `rgba(245,195,70,${a})` : `rgba(69,199,214,${a})`;
            c.strokeRect(r.mx * MB + 0.5, r.my * MB + 0.5, MB - 1, MB - 1);
          }
        } else if (this._flash) this._flash = null;
      };
      this._raf = requestAnimationFrame(step);
    },

    _grabPlanes() {
      const cv = this.ui.tx;
      this._renderSourceAt(cv, (performance.now() - this._panelT0) / 1000, new Date());
      const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
      const n = cv.width * cv.height;
      const img = { r: new Float64Array(n), g: new Float64Array(n),
                    b: new Float64Array(n), w: cv.width, h: cv.height };
      for (let i = 0; i < n; i++) {
        img.r[i] = d[i * 4]; img.g[i] = d[i * 4 + 1]; img.b[i] = d[i * 4 + 2];
      }
      return rgbToPlanes(img);
    },

    /* ---------------- TX engine (live air or WAV sink) ---------------- */
    _setLiveUi(on) {
      if (!this.ui) return;
      for (const k of ["size", "colour", "quality", "fps", "refresh", "source"])
        this.ui[k].disabled = on;
      this.ui.golive.disabled = on;
      this.ui.recwav.disabled = on;
      this.ui.loop.disabled = on;
    },

    _startTx(sink, opts) {
      const cfg = this._cfg();
      const enc = new D3Encoder(cfg);
      const run = new ToneRun(TX_FS);
      const L = this.live = {
        sink, enc, run, cfg,
        emitted: 0, frameIdx: 0,
        spF: TX_FS / cfg.fps,
        vhdrEvery: Math.max(1, Math.round(VHDR_EVERY_S * cfg.fps)),
        vhdrSeq: 0, bytes: 0,
        t0: performance.now(),
        nFrames: opts && opts.nFrames,       // undefined = until Stop
        onDone: opts && opts.onDone,
        timer: null
      };
      const push = arr => { if (arr.length) { sink.push(arr); L.emitted += arr.length; this._scopeFeed(arr, TX_FS); } };
      L.push = push;
      L.pushPkt = (type, seq, payload) =>
        push(run.symbols(buildPacketTones(type, seq, payload)));
      if (this.voxHdr) push(run.tone(LEADER_F, Math.round(0.7 * TX_FS)));
      const lead = run.tone(LEADER_F, Math.round(LEADER_S * TX_FS));
      const nf = Math.round(0.003 * TX_FS);
      for (let i = 0; i < nf; i++) lead[i] *= Math.sin(0.5 * Math.PI * i / nf) ** 2;
      push(lead);
      const pre = new Uint8Array(PREAMBLE_SYMS);
      for (let i = 0; i < PREAMBLE_SYMS; i++) pre[i] = i & 1 ? 3 : 0;
      push(run.symbols(pre));
      L.origin = L.emitted;
      this._setLiveUi(true);
      L.timer = setInterval(() => this._txTick(), 1000 / cfg.fps);
      this._txTick();
    },

    _txTick() {
      const L = this.live;
      if (!L || !this.ui) return;
      if (L.nFrames !== undefined && L.frameIdx >= L.nFrames) { this._stopTx(false); return; }
      const slot = L.origin + Math.round(L.frameIdx * L.spF);
      if (L.emitted < slot) L.push(L.run.tone(LEADER_F, slot - L.emitted));
      if (L.frameIdx === 0) {
        L.pushPkt(PKT_VHDR, L.vhdrSeq++, L.enc.vhdrPayload());
        L.pushPkt(PKT_VHDR, L.vhdrSeq++, L.enc.vhdrPayload());
      } else if (L.frameIdx % L.vhdrEvery === 0) {
        L.pushPkt(PKT_VHDR, L.vhdrSeq++, L.enc.vhdrPayload());
      }
      const fr = L.enc.encodeFrame(this._grabPlanes());
      L.pushPkt(PKT_VFRM, fr.frameNo & 0xFFFF, fr.payload);
      L.bytes += fr.bytes;
      L.frameIdx++;
      this._flash = { rects: fr.rects, t: performance.now() };
      const fpsNow = L.frameIdx / Math.max(0.5, (performance.now() - L.t0) / 1000);
      this.ui.airinfo.textContent =
        `f${fr.frameNo} · ${fr.sent.length} blk (${fr.intraN}i/${fr.deltaN}d) · ${fr.bytes} B`;
      this._stage((L.nFrames !== undefined ? "recording · " : "ON AIR · ") +
                  `${fpsNow.toFixed(2)} fps · ${(L.emitted / TX_FS).toFixed(0)} s`);
    },

    _stopTx(hard) {
      const L = this.live;
      if (!L) return;
      clearInterval(L.timer);
      this.live = null;
      if (!hard) {
        L.pushPkt(PKT_END, 0, new Uint8Array(0));
        const tail = L.run.tone(LEADER_F, Math.round(0.12 * TX_FS));
        const nf = Math.round(0.003 * TX_FS);
        for (let i = 0; i < nf; i++)
          tail[tail.length - 1 - i] *= Math.sin(0.5 * Math.PI * i / nf) ** 2;
        L.push(tail);
      }
      L.sink.close(hard);
      this._setLiveUi(false);
      this._stage("idle");
      this.ctx.log(`D3 ${hard ? "aborted" : "signed off"}: ${L.frameIdx} frames, ` +
                   `${(L.bytes / 1024).toFixed(1)} kB video in ${(L.emitted / TX_FS).toFixed(0)} s`);
      if (!hard && L.onDone) L.onDone(L);
    },

    _goLive() {
      if (this.live || this._busy) return;
      const audio = this.ctx.audio;
      audio.ensureContext();
      const stream = audio.openTXStream(TX_FS);
      this._startTx({
        push: a => stream.push(a),
        close: hard => { if (hard) stream.stop(); else stream.close(); }
      }, {});
      this.ctx.log(`D3 on air: ${this._cfg().w}×${this._cfg().h} ` +
                   `${this.colour ? "colour" : "mono"} q${QUALITY[this.quality]} @ ${this.fps} fps target`);
    },

    _stopEverything() {
      if (this.live) { this._stopTx(false); return; }
      this.ctx.audio.stopTX();
      this._stage("idle");
    },

    _recordWav() {
      if (this.live || this._busy) return;
      const dur = parseInt(this.ui.wavdur.value, 10);
      const cfg = this._cfg();
      const nFrames = Math.max(1, Math.round(dur * cfg.fps));
      const chunks = [];
      this._startTx({
        push: a => chunks.push(Float32Array.from(a)),
        close: () => {}
      }, {
        nFrames,
        onDone: () => {
          let n = 0;
          for (const c of chunks) n += c.length;
          const pad = Math.round(PAD_S * TX_FS);
          const y = new Float32Array(pad + n + pad);
          let p = pad;
          for (const c of chunks) { y.set(c, p); p += c.length; }
          drawSpectrogram(this.ui.spec, y, TX_FS);
          this.ui.airinfo.textContent = `WAV · ${(y.length / TX_FS).toFixed(0)} s @ ${TX_FS} Hz`;
          const buf = wavEncode16(y, TX_FS);
          const a = document.createElement("a");
          a.href = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
          a.download = `d3_${cfg.w}x${cfg.h}_${this.colour ? "col" : "mono"}_${cfg.fps}fps_${dur}s.wav`;
          document.body.appendChild(a);
          a.click();
          setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
          this.ctx.log(`saved ${a.download} (${(buf.byteLength / 1048576).toFixed(1)} MB)`);
        }
      });
      this.ctx.log(`recording ${dur} s of D3 to WAV — the sources run in real time`);
    },

    /* ---------------- RX side ---------------- */
    _makeRxCallbacks(label) {
      return {
        log: m => this.ctx.log("d3: " + m),
        onVhdr: (cfg, rx) => {
          if (!this.ui) return;
          this.ui.rx.width = cfg.w; this.ui.rx.height = cfg.h;
          const c = this.ui.rx.getContext("2d");
          c.fillStyle = "#333"; c.fillRect(0, 0, cfg.w, cfg.h);
          this.ui.fresh.width = cfg.w / MB;
          this.ui.fresh.height = cfg.h / MB;
          this.rxFrames = [];
          this.ui.replay.disabled = true;
          rx._t0 = -1;
          this._stage(`receiving ${cfg.w}×${cfg.h} ${cfg.mono ? "mono" : "colour"} @ ${cfg.fps} fps`);
          this.ctx.log(`d3: programme header — ${cfg.w}×${cfg.h} ` +
                       `${cfg.mono ? "mono" : "colour"} q${cfg.quality}, ` +
                       `${cfg.fps} fps target, refresh ${cfg.refresh}/frame`);
        },
        onFrame: (r, rx) => {
          if (!this.ui) return;
          if (rx._t0 < 0) rx._t0 = r.t;
          this._paintRx(rx, r);
          this._freshDraw(rx);
          const dur = Math.max(1, r.t - rx._t0);
          this.ui.rxinfo.textContent =
            `f${r.frameNo} · ${rx.dec.fpsEma ? rx.dec.fpsEma.toFixed(2) : "—"} fps · ` +
            `${r.n} blk · ${(rx.stats.netBytes / dur).toFixed(0)} B/s` +
            (rx.stats.crcFail ? ` · ${rx.stats.crcFail} lost` : "") + ` · ${label}`;
          this.ui.saveimg.disabled = false;
        },
        onEnd: rx => {
          this._stage(`end of programme (${rx.dec.frames} frames)` +
                      (rx.stats.crcFail ? ` · ${rx.stats.crcFail} lost` : ""));
        },
        onStats: rx => {
          if (!this.ui) return;
          if (rx.stats.crcFail && rx.stats.pkts % 3 === 0) this._freshDraw(rx);
        }
      };
    },

    _paintRx(rx, r) {
      const img = rx.dec.imageRGB();
      if (!img) return;
      const cv = this.ui.rx;
      if (cv.width !== img.w || cv.height !== img.h) { cv.width = img.w; cv.height = img.h; }
      const c = cv.getContext("2d");
      const id = c.createImageData(img.w, img.h);
      for (let i = 0; i < img.w * img.h; i++) {
        id.data[i * 4] = img.r[i]; id.data[i * 4 + 1] = img.g[i];
        id.data[i * 4 + 2] = img.b[i]; id.data[i * 4 + 3] = 255;
      }
      c.putImageData(id, 0, 0);
      if (r && !this.replaying) {
        this.rxFrames.push({ t: r.t, w: img.w, h: img.h, data: id.data.slice(0) });
        if (this.rxFrames.length > 240) this.rxFrames.shift();
        if (this.rxFrames.length > 1) this.ui.replay.disabled = false;
      }
    },

    _freshDraw(rx) {
      const dec = rx.dec;
      if (!dec.cfg || !this.ui) return;
      const g = dec.g;
      const c = this.ui.fresh.getContext("2d");
      const id = c.createImageData(g.nx, g.ny);
      const tNow = rx.timeS;
      for (let i = 0; i < g.nMB; i++) {
        let r0, g0, b0;
        if (dec.age[i] < 0) { r0 = 58; g0 = 20; b0 = 32; }         // never painted
        else {
          const a = clamp((tNow - dec.age[i]) / 25, 0, 1);          // fresh → stale
          r0 = Math.round(69 + a * (191 - 69));
          g0 = Math.round(199 - a * (199 - 120));
          b0 = Math.round(214 - a * (214 - 60));
        }
        id.data[i * 4] = r0; id.data[i * 4 + 1] = g0;
        id.data[i * 4 + 2] = b0; id.data[i * 4 + 3] = 255;
      }
      c.putImageData(id, 0, 0);
    },

    async _replay() {
      if (this.replaying || this.rxFrames.length < 2 || !this.ui) return;
      this.replaying = true;
      this.ui.replay.disabled = true;
      const frames = this.rxFrames.slice();
      this._stage(`replaying ${frames.length} frames at received pace`);
      const cv = this.ui.rx;
      const c = cv.getContext("2d");
      for (let i = 0; i < frames.length && this.ui && this.replaying; i++) {
        const f = frames[i];
        if (cv.width !== f.w || cv.height !== f.h) { cv.width = f.w; cv.height = f.h; }
        c.putImageData(new ImageData(f.data.slice(0), f.w, f.h), 0, 0);
        if (i + 1 < frames.length)
          await new Promise(r => setTimeout(r, 1000 * clamp(frames[i + 1].t - f.t, 0.05, 2.5)));
      }
      this.replaying = false;
      if (this.ui) { this.ui.replay.disabled = false; this._stage("replay done"); }
    },

    _saveFrame() {
      if (!this.ui) return;
      const a = document.createElement("a");
      a.href = this.ui.rx.toDataURL("image/png");
      a.download = `d3_frame_${this.ui.rx.width}x${this.ui.rx.height}.png`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 2000);
      this.ctx.log("saved RX frame PNG");
    },

    /* ---------------- live listening ---------------- */
    async _toggleListen() {
      if (this.listening) {
        this.listening = false;
        this.rx = null;
        this.ui.listen.textContent = "Listen (live TV)";
        this._stage("idle");
        return;
      }
      const audio = this.ctx.audio;
      if (!audio.rxActive) {
        try { await audio.startRX(); }
        catch (e) { this.ctx.log("input error: " + e.message); return; }
      }
      this.listening = true;
      this.rx = null;                        // built on the first block (needs sr)
      this.ui.listen.textContent = "Stop listening";
      this._stage("listening — tuner open");
      this.ctx.log("D3 listening — the monitor paints as frame packets verify");
    },

    _rxFeed(block, sr) {
      if (!this.listening || !this.ui) return;
      let s = 0;
      for (let i = 0; i < block.length; i++) s += block[i] * block[i];
      const level = 20 * Math.log10(Math.sqrt(s / block.length) + 1e-12);
      const now = performance.now();
      if (now - this._meterAt > 120) {
        this._meterAt = now;
        this.ui.meter.textContent = level.toFixed(0) + " dB";
      }
      if (!this.rx || this.rx.fs !== sr) {
        this.rx = new StreamRX(sr, this._makeRxCallbacks("live"));
        this.rx.gate = Math.pow(10, this.squelchDb / 20) * 0.7;
      }
      this.rx.push(block);
      this.rx.drain();
      this._scopeFeed(block, sr);
    },

    _scopeFeed(block, sr) {
      /* rolling 3 s scope shared by live TX and live RX */
      if (!this.ui) return;
      const keep = 3 * sr;
      if (!this._scopeBuf || this._scopeBuf.sr !== sr) {
        this._scopeBuf = { sr, y: new Float32Array(keep), n: 0 };
      }
      const S = this._scopeBuf;
      if (block.length >= keep) {
        S.y.set(block.subarray(block.length - keep));
        S.n = keep;
      } else {
        if (S.n + block.length > keep) {
          const cut = S.n + block.length - keep;
          S.y.copyWithin(0, cut, S.n);
          S.n -= cut;
        }
        S.y.set(block, S.n);
        S.n += block.length;
      }
      const now = performance.now();
      if (now - this._scopeAt > 1500 && S.n > S.sr) {
        this._scopeAt = now;
        drawSpectrogram(this.ui.spec, S.y.subarray(0, S.n), S.sr);
      }
    },

    /* ---------------- offline decode (WAV / loopback / self-test) ---------------- */
    async _decodeBuffer(y, fs, label) {
      const rx = new StreamRX(fs, this._makeRxCallbacks(label));
      const step = Math.round(0.5 * fs);
      for (let p = 0; p < y.length; p += step) {
        rx.push(y.subarray(p, Math.min(y.length, p + step)));
        await rx.drain();
        this._stage(`decoding ${label}… ${Math.round(100 * Math.min(1, (p + step) / y.length))} %`);
      }
      await rx.drain();
      if (this.ui && rx.dec.frames === 0)
        this._stage(rx.stats.pkts ? "no frames decoded" : "no sync found — is this HRWS-D3?");
      return rx;
    },

    async _decodeWavFile(f) {
      if (this._busy) return;
      this._busy = true;
      try {
        const buf = await f.arrayBuffer();
        const wav = wavDecodeMono(buf);
        this.ctx.log(`decoding ${f.name}: ${(wav.y.length / wav.rate).toFixed(1)} s @ ${wav.rate} Hz`);
        drawSpectrogram(this.ui.spec, wav.y, wav.rate);
        this.ui.airinfo.textContent = `${f.name} · ${(wav.y.length / wav.rate).toFixed(0)} s`;
        await this._decodeBuffer(wav.y, wav.rate, "WAV");
      } catch (e) {
        this.ctx.log("WAV decode failed: " + e.message);
        this._stage("error");
      } finally {
        this._busy = false;
      }
    },

    _patternProvider(clock0) {
      const cv = document.createElement("canvas");
      const [w, h] = this._size();
      cv.width = w; cv.height = h;
      const savedSource = this.source;
      return (i, tSec) => {
        this.source = "pattern";
        this._renderSourceAt(cv, tSec, new Date(clock0 + tSec * 1000));
        this.source = savedSource;
        const d = cv.getContext("2d").getImageData(0, 0, w, h).data;
        const n = w * h;
        const img = { r: new Float64Array(n), g: new Float64Array(n),
                      b: new Float64Array(n), w, h };
        for (let k = 0; k < n; k++) {
          img.r[k] = d[k * 4]; img.g[k] = d[k * 4 + 1]; img.b[k] = d[k * 4 + 2];
        }
        return rgbToPlanes(img);
      };
    },

    async _loopback() {
      if (this._busy || this.live) return;
      this._busy = true;
      try {
        const cfg = this._cfg();
        if (this.source !== "pattern")
          this.ctx.log("loopback always uses the moving test card (deterministic timing)");
        this._stage("rendering 10 s of test card…");
        await tick();
        const nFrames = Math.max(2, Math.round(10 * cfg.fps));
        const built = buildStreamAudio(cfg, this._patternProvider(Date.now()), nFrames,
                                       { voxHdr: this.voxHdr });
        let sig = built.y;
        const ch = CHANNELS[parseInt(this.ui.chan.value, 10) || 0];
        const snr = this.ui.noise.checked ? parseFloat(this.ui.snr.value) : null;
        if (ch[1] || snr !== null) {
          this._stage("channel sim…");
          await tick();
          sig = channelSimulate(sig, built.fs, ch[1], snr, 7, ch[2]);
          this.ctx.log(`channel sim: ${ch[0]}` + (snr !== null ? `, SNR ${snr} dB` : ""));
        }
        drawSpectrogram(this.ui.spec, sig, built.fs);
        this.ui.airinfo.textContent =
          `${nFrames} frames · ${(built.payloadBytes / 1024).toFixed(1)} kB video · ` +
          `${built.airS.toFixed(0)} s air`;
        const rx = await this._decodeBuffer(sig, built.fs, "loopback");
        this.ctx.log(`loopback: ${rx.dec.frames}/${nFrames} frames, ` +
                     `${rx.stats.crcFail} packets lost`);
      } catch (e) {
        this.ctx.log("loopback failed: " + e.message);
        this._stage("error");
      } finally {
        this._busy = false;
      }
    },

    async _selfTest() {
      if (this._busy || this.live) return;
      this._busy = true;
      const log = m => this.ctx.log("d3 self-test: " + m);
      try {
        const cfg = { w: 64, h: 48, mono: true, quality: QUALITY.med,
                      fps: 1, refresh: 1, streamId: 4242 };
        const nFrames = 8;
        this._stage("self-test 1/2: direct…");
        await tick();
        const built = buildStreamAudio(cfg,
          (i, t) => rgbToPlanes(motionPattern(cfg.w, cfg.h, t)), nFrames, {});
        log(`${nFrames} frames of moving card → ${(built.payloadBytes / 1024).toFixed(1)} kB, ` +
            `${built.airS.toFixed(0)} s air`);
        const rx1 = await this._decodeBuffer(built.y, built.fs, "self-test");
        const exact = planesMaxDiff(rx1.dec.P, built.enc.ref, true) < 1e-6;
        const ok1 = rx1.dec.frames >= nFrames - 1 && exact;
        log(`direct: ${ok1 ? "PASS" : "FAIL"} — ${rx1.dec.frames}/${nFrames} frames, ` +
            (exact ? "RX picture bit-exact with the encoder's closed loop"
                   : "closed loop diverged"));
        this._stage("self-test 2/2: SSB 2.4 kHz, SNR 10 dB…");
        await tick();
        const noisy = channelSimulate(built.y, built.fs, 2400, 10, 7, "ssb");
        const rx2 = await this._decodeBuffer(noisy, built.fs,
                                             "self-test 2/2 · deliberate simulated noise");
        const ok2 = rx2.dec.frames >= nFrames - 2;
        log(`SSB SNR 10: ${ok2 ? "PASS — FEC held the programme" :
             `${rx2.dec.frames}/${nFrames} frames (losses expected only below ~8 dB)`}` +
            (rx2.stats.crcFail ? `, ${rx2.stats.crcFail} packets dropped` : ""));
        if (this.ui) this.ui.rxinfo.textContent +=
          "  ·  direct pass was clean; these stats are the deliberate-noise pass";
        this._stage(ok1 && ok2 ? "self-test PASS (clean + noisy channel)" : "self-test: see log");
      } catch (e) {
        this.ctx.log("self-test error: " + e.message);
        this._stage("self-test error");
      } finally {
        this._busy = false;
      }
    }
  };

  const HOST = (typeof HRWS !== "undefined" && HRWS)
    || (typeof window !== "undefined" ? window.HRWS : null);
  if (HOST) HOST.registerModule(def);

  /* headless test hook */
  window.__D3_TEST__ = {
    TONES, BAUD, SYNCSEQ, PREAMBLE_SYMS, TX_FS, MB, SIZES, QUALITY, FPS_OPTS,
    PKT_END, PKT_VHDR, PKT_VFRM, MAGIC0, MAGIC1, VHDR_EVERY_S, SAD_THRESH,
    clamp, crc32, crc16,
    BitWriter, BitReader, quantTable, QLUMA, QCHROMA,
    dct8x8, idct8x8, quantizeBlock, writeQBlock, readQBlock, reconFromQ,
    rgbToPlanes, planesToRgb, makeGeom, makePlanes,
    grabCentered, grabDiff, applyIntra, applyDelta, newPreds, clonePreds,
    convEncode, viterbiDecode, interleave, deinterleave,
    bytesToBits, bitsToBytes, codeSection, sectionSyms,
    buildPacketTones, packetSymCount, frameByteBudget,
    D3Encoder, D3Decoder, parseVhdr, ToneRun, buildStreamAudio,
    StreamRX, motionPattern, psnrY, planesMaxDiff,
    channelSimulate, fftBandpass, makeBiquad, wavEncode16, wavDecodeMono
  };
})();
