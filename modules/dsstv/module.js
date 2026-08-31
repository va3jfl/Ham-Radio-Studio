/* ============================================================
   Ham Radio Web Studio — Digital SSTV module ("HRWS-D1")
   An experimental DIGITAL image mode designed for this studio:
   pixel-perfect pictures over a normal SSB voice channel, with
   live stripe-by-stripe results and FEC that shrugs off noise.

   The stack, bottom to top:
     modem    4-FSK, 500 Bd, tones 800/1300/1800/2300 Hz
              (Gray-coded 2 bits/symbol, continuous phase,
              1000 bps raw, fits 300–2700 Hz SSB)
     FEC      convolutional K=7 rate 1/2 (G1=171o, G2=133o),
              soft-decision Viterbi, 24-row block interleaver
     framing  every packet: 16-symbol sync sequence (fresh
              timing lock each packet — clock drift can never
              accumulate), 7-byte coded header (type, seq, len,
              CRC-16), payload + CRC-32
     codec    mini-JPEG: YCbCr 4:2:0, 8×8 DCT, quality-scaled
              quantization, zigzag, Exp-Golomb entropy coding;
              the image is coded as INDEPENDENT 16-line stripes
              so each packet decodes (and paints) on its own
     link     header packet + one packet per stripe + end
              packet; optional repeat passes fill any stripe
              the channel destroyed (CRC decides)

   On-air: PAD 0.25 s · 1900 Hz leader 0.35 s (tune/VOX) ·
   24-symbol clock preamble · packets · PAD. All timing is
   sample-rate independent; RX decodes a WAV at its own rate.

   This is an experiment: both ends need this studio. Identify
   per your local regulations.
   ============================================================ */
"use strict";

(function () {

  /* ---------------- modem constants ---------------- */
  const TONES = [800.0, 1300.0, 1800.0, 2300.0];
  const BAUD = 500.0;
  const GRAY_ENC = [0, 1, 3, 2];        // 2-bit value -> tone index
  const GRAY_DEC = [0, 1, 3, 2];        // tone index  -> 2-bit value
  const SYNCSEQ = [0, 3, 1, 2, 3, 0, 2, 1, 3, 3, 0, 0, 2, 1, 1, 2];
  const PREAMBLE_SYMS = 24;
  const LEADER_S = 0.35, LEADER_F = 1900.0;
  const PAD_S = 0.25;
  const PKT_HDR = 1, PKT_STRIPE = 2, PKT_END = 3;
  const STRIPE_H = 16;                  // luma rows per stripe (chroma: 8)
  const MAGIC0 = 0x44, MAGIC1 = 0x31;   // "D1"

  const SIZES = [[160, 120], [240, 180], [320, 240]];
  const QUALITY = { low: 35, med: 60, high: 80 };

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

  /* radix-2 complex FFT (shared with the analog SSTV module) */
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
     Bit I/O + Exp-Golomb
     ===================================================================== */
  class BitWriter {
    constructor() { this.bytes = []; this.cur = 0; this.nb = 0; }
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
     Mini-JPEG: 8×8 DCT, quality-scaled quantization, zigzag, Exp-Golomb.
     Images are planes {r,g,b: Float64Array 0..255, w, h}. The image is
     coded as independent STRIPE_H-line stripes.
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
  function dct8x8(px, out) {                   // px: 64 values centred (−128)
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

  function rgbToPlanes(img) {
    /* full-range YCbCr with 4:2:0 chroma */
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

  /* read one padded 8×8 block from a plane (edge replicate) */
  function grabBlock(plane, pw, ph, r0, c0, out) {
    for (let r = 0; r < 8; r++) {
      const rr = Math.min(ph - 1, r0 + r);
      for (let c = 0; c < 8; c++) {
        const cc = Math.min(pw - 1, c0 + c);
        out[r * 8 + c] = plane[rr * pw + cc] - 128.0;
      }
    }
  }
  function putBlock(plane, pw, ph, r0, c0, blk) {
    for (let r = 0; r < 8; r++) {
      const rr = r0 + r;
      if (rr >= ph) break;
      for (let c = 0; c < 8; c++) {
        const cc = c0 + c;
        if (cc >= pw) break;
        plane[rr * pw + cc] = clamp(blk[r * 8 + c] + 128.0, 0, 255);
      }
    }
  }

  function encodeBlock(bw, blk, qt, pred) {
    const co = new Float64Array(64);
    dct8x8(blk, co);
    const q = new Int32Array(64);
    for (let i = 0; i < 64; i++) q[i] = Math.round(co[i] / qt[i]);
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
    /* filled to the last coefficient — no EOB needed */
  }
  function decodeBlock(br, qt, pred, out) {
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
    const co = new Float64Array(64);
    for (let i = 0; i < 64; i++) co[i] = q[i] * qt[i];
    idct8x8(co, out);
  }

  /* stripe s covers luma rows [s*16, s*16+16) and chroma rows [s*8, s*8+8) */
  function encodeStripe(P, s, qtY, qtC) {
    const bw = new BitWriter();
    const blk = new Float64Array(64);
    const bwY = Math.ceil(P.w / 8), bwC = Math.ceil(P.wc / 8);
    const predY = { dc: 0 }, predB = { dc: 0 }, predR = { dc: 0 };
    for (let br2 = 0; br2 < 2; br2++) {
      const r0 = s * STRIPE_H + br2 * 8;
      if (r0 >= P.h) break;
      for (let bc = 0; bc < bwY; bc++) {
        grabBlock(P.Y, P.w, P.h, r0, bc * 8, blk);
        encodeBlock(bw, blk, qtY, predY);
      }
    }
    const rc0 = s * (STRIPE_H >> 1);
    if (rc0 < P.hc) {
      for (let bc = 0; bc < bwC; bc++) {
        grabBlock(P.Cb, P.wc, P.hc, rc0, bc * 8, blk);
        encodeBlock(bw, blk, qtC, predB);
      }
      for (let bc = 0; bc < bwC; bc++) {
        grabBlock(P.Cr, P.wc, P.hc, rc0, bc * 8, blk);
        encodeBlock(bw, blk, qtC, predR);
      }
    }
    return bw.finish();
  }
  function decodeStripe(P, s, bytes, qtY, qtC) {
    const br = new BitReader(bytes);
    const blk = new Float64Array(64);
    const bwY = Math.ceil(P.w / 8), bwC = Math.ceil(P.wc / 8);
    const predY = { dc: 0 }, predB = { dc: 0 }, predR = { dc: 0 };
    for (let br2 = 0; br2 < 2; br2++) {
      const r0 = s * STRIPE_H + br2 * 8;
      if (r0 >= P.h) break;
      for (let bc = 0; bc < bwY; bc++) {
        decodeBlock(br, qtY, predY, blk);
        putBlock(P.Y, P.w, P.h, r0, bc * 8, blk);
      }
    }
    const rc0 = s * (STRIPE_H >> 1);
    if (rc0 < P.hc) {
      for (let bc = 0; bc < bwC; bc++) {
        decodeBlock(br, qtC, predB, blk);
        putBlock(P.Cb, P.wc, P.hc, rc0, bc * 8, blk);
      }
      for (let bc = 0; bc < bwC; bc++) {
        decodeBlock(br, qtC, predR, blk);
        putBlock(P.Cr, P.wc, P.hc, rc0, bc * 8, blk);
      }
    }
  }

  /* =====================================================================
     FEC — convolutional K=7 rate 1/2 (G1=171o, G2=133o), soft Viterbi,
     24-row block interleaver (spreads FSK symbol-error bit pairs).
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

  function convEncode(bits) {                   // bits: Uint8Array, adds 6-bit tail
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
    /* llr[j] > 0 means coded bit j more likely 1. Returns nBits data bits. */
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
          if (t >= nBits && u === 1) continue;          // tail is zeros
          const full = ((s << 1) | u) & 0x7F;
          const o1 = PARITY[full & G1], o2 = PARITY[full & G2];
          const m = base + (o1 ? l0 : -l0) + (o2 ? l1 : -l1);
          const ns = full & 0x3F;
          if (m > pm2[ns]) {
            pm2[ns] = m;
            dec[t * NS + ns] = (s << 1) | u;            // prev state + input
          }
        }
      }
      const t2 = pm; pm = pm2; pm2 = t2;
    }
    const out = new Uint8Array(nBits);
    let s = 0;                                          // tail forces state 0
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

  /* coded section = interleave(convEncode(bits(bytes))) → tone symbols */
  function codeSection(bytes) {
    const coded = interleave(convEncode(bytesToBits(bytes)));
    const nSym = coded.length >> 1;                     // always even
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

  /* =====================================================================
     Image → on-air audio
     ===================================================================== */
  /* Turn a finished symbol stream into air:
     PAD · [vox 1900] · leader 1900 · symbols · PAD, 3 ms raised-cos ramps.
     Shared by the image encoder and the audio-postcard encoder. */
  function symbolsToAir(tonesAll, fs, voxHdr) {
    const spSym = fs / BAUD;
    const nVox = voxHdr ? Math.round(0.7 * fs) : 0;
    const nLead = Math.round(LEADER_S * fs);
    const nPad = Math.round(PAD_S * fs);
    const symStart = nPad + nVox + nLead;
    const nSig = Math.round(tonesAll.length * spSym);
    const y = new Float32Array(symStart + nSig + nPad);
    let ph = 0;
    const k = 2 * Math.PI / fs;
    for (let i = 0; i < nVox + nLead; i++) {
      ph += k * LEADER_F;
      y[nPad + i] = 0.85 * Math.sin(ph);
    }
    let cursor = 0;
    for (let siIdx = 0; siIdx < tonesAll.length; siIdx++) {
      const f = TONES[tonesAll[siIdx]];
      const n0 = Math.round(cursor);
      cursor += spSym;
      const n1 = Math.round(cursor);
      for (let i = n0; i < n1; i++) {
        ph += k * f;
        y[symStart + i] = 0.85 * Math.sin(ph);
      }
    }
    const nf = Math.round(0.003 * fs);
    for (let i = 0; i < nf; i++) {
      const r = Math.sin(0.5 * Math.PI * i / nf) ** 2;
      y[nPad + i] *= r;
      y[symStart + nSig - 1 - i] *= r;
    }
    return { y, symStart, spSym };
  }

  function encodeImageD(img, quality, passes, fs, voxHdr) {
    const P = rgbToPlanes(img);
    const qtY = quantTable(QLUMA, quality), qtC = quantTable(QCHROMA, quality);
    const nStripes = Math.ceil(P.h / STRIPE_H);
    const stripes = [];
    let payloadBytes = 0;
    for (let s = 0; s < nStripes; s++) {
      const b = encodeStripe(P, s, qtY, qtC);
      stripes.push(b);
      payloadBytes += b.length;
    }
    const hdrPayload = new Uint8Array(12);
    hdrPayload[0] = MAGIC0; hdrPayload[1] = MAGIC1;
    hdrPayload[2] = P.w >> 8; hdrPayload[3] = P.w & 255;
    hdrPayload[4] = P.h >> 8; hdrPayload[5] = P.h & 255;
    hdrPayload[6] = quality;
    hdrPayload[7] = STRIPE_H;
    hdrPayload[8] = nStripes >> 8; hdrPayload[9] = nStripes & 255;
    hdrPayload[10] = passes;
    hdrPayload[11] = 0;

    /* symbol stream: preamble, then per pass: header + stripes; then end */
    const tonesAll = [];
    for (let i = 0; i < PREAMBLE_SYMS; i++) tonesAll.push(i & 1 ? 3 : 0);
    const layout = [];
    for (let pass = 0; pass < passes; pass++) {
      layout.push({ type: PKT_HDR, seq: pass, at: tonesAll.length,
                    syms: packetSymCount(hdrPayload.length) });
      tonesAll.push(...buildPacketTones(PKT_HDR, pass, hdrPayload));
      for (let s = 0; s < nStripes; s++) {
        layout.push({ type: PKT_STRIPE, seq: s, at: tonesAll.length,
                      syms: packetSymCount(stripes[s].length) });
        tonesAll.push(...buildPacketTones(PKT_STRIPE, s, stripes[s]));
      }
    }
    layout.push({ type: PKT_END, seq: 0, at: tonesAll.length,
                  syms: packetSymCount(0) });
    tonesAll.push(...buildPacketTones(PKT_END, 0, new Uint8Array(0)));

    const air = symbolsToAir(tonesAll, fs, voxHdr);
    return {
      y: air.y, layout, symStart: air.symStart, spSym: air.spSym,
      nStripes, payloadBytes, totalSyms: tonesAll.length,
      airS: air.y.length / fs, header: hdrPayload
    };
  }

  /* =====================================================================
     Demodulator
     ===================================================================== */
  function toneEnergies(y, fs, t0, t1, out) {
    /* windowed correlation vs the 4 tones over the central 76 % */
    const g = 0.12;
    const len = t1 - t0;
    let a = Math.round(t0 + g * len);
    let b = Math.round(t1 - g * len);
    a = clamp(a, 0, y.length);
    b = clamp(b, a + 4, y.length);
    for (let t = 0; t < 4; t++) {
      const w = 2 * Math.PI * TONES[t] / fs;
      let cr = 0, ci = 0;
      for (let i = a; i < b; i++) {
        cr += y[i] * Math.cos(w * i);
        ci += y[i] * Math.sin(w * i);
      }
      out[t] = (cr * cr + ci * ci) / Math.max(1, b - a);
    }
  }

  function syncScoreAt(y, fs, pos, spSym, E) {
    let score = 0;
    for (let k = 0; k < SYNCSEQ.length; k++) {
      toneEnergies(y, fs, pos + k * spSym, pos + (k + 1) * spSym, E);
      const want = SYNCSEQ[k];
      let other = 0;
      for (let t = 0; t < 4; t++) if (t !== want && E[t] > other) other = E[t];
      score += (E[want] - other) / (E[want] + other + 1e-12);
    }
    return score / SYNCSEQ.length;
  }

  function refineSync(y, fs, guess, spSym, spanSyms, stepFrac, E) {
    let best = -2, bestPos = guess;
    const step = spSym * stepFrac;
    const half = spanSyms * spSym;
    for (let pos = guess - half; pos <= guess + half; pos += step) {
      if (pos < 0) continue;
      const sc = syncScoreAt(y, fs, pos, spSym, E);
      if (sc > best) { best = sc; bestPos = pos; }
    }
    return { pos: bestPos, score: best };
  }

  function readSectionLLR(y, fs, pos, spSym, nSyms, E) {
    /* returns {llr Float64Array(2*nSyms), end} — max-log soft bits */
    const llr = new Float64Array(2 * nSyms);
    for (let k = 0; k < nSyms; k++) {
      toneEnergies(y, fs, pos + k * spSym, pos + (k + 1) * spSym, E);
      const lg = [Math.log(E[0] + 1e-12), Math.log(E[1] + 1e-12),
                  Math.log(E[2] + 1e-12), Math.log(E[3] + 1e-12)];
      /* Gray map: msb=1 → tones {2,3} (values 3,2); lsb=1 → tones {1,2} */
      llr[2 * k] = Math.max(lg[GRAY_ENC.indexOf(2)], lg[GRAY_ENC.indexOf(3)])
                 - Math.max(lg[GRAY_ENC.indexOf(0)], lg[GRAY_ENC.indexOf(1)]);
      llr[2 * k + 1] = Math.max(lg[1], lg[2]) - Math.max(lg[0], lg[3]);
    }
    return llr;
  }

  function decodeSection(y, fs, pos, spSym, nBytes, E) {
    const nSyms = sectionSyms(nBytes);
    const llr = readSectionLLR(y, fs, pos, spSym, nSyms, E);
    const bits = viterbiDecode(deinterleave(llr), nBytes * 8);
    return bitsToBytes(bits);
  }

  async function decodeSignalD(y0, fs, opts) {
    const o = opts || {};
    const say = m => { if (o.log) o.log(m); };
    const y = fftBandpass(y0, fs, 500, 2700);
    const spSym = fs / BAUD;
    const E = new Float64Array(4);
    const stats = { stripesOk: 0, nStripes: 0, crcFail: 0, hdrFail: 0,
                    passes: 0, syncScore: 0 };
    let hdr = null, P = null, have = null, img = null, pc = null;

    /* acquisition: first sync anywhere in the opening seconds */
    const searchEnd = Math.min(y.length, Math.round(8.0 * fs));
    let best = { score: -2, pos: 0 };
    for (let pos = 0; pos + SYNCSEQ.length * spSym < searchEnd; pos += spSym / 3) {
      const sc = syncScoreAt(y, fs, pos, spSym, E);
      if (sc > best.score) best = { score: sc, pos };
      if (sc > 0.85) break;                              // early exit on a clean hit
    }
    if (best.score < 0.40) {
      say("no sync found — is this an HRWS-D1 recording?");
      return { img: null, stats, hdr: null };
    }
    let lock = refineSync(y, fs, best.pos, spSym, 0.6, 1 / 16, E);
    stats.syncScore = lock.score;
    say(`sync acquired, score ${lock.score.toFixed(2)}`);

    const finishImage = () => {
      if (!P) return null;
      return planesToRgb(P);
    };

    let cursor = lock.pos;
    let done = false;
    let guardMisses = 0;
    while (!done && cursor + (SYNCSEQ.length + HDR_SYMS) * spSym < y.length) {
      /* re-lock timing on this packet's sync sequence */
      const rl = refineSync(y, fs, cursor, spSym, 0.6, 1 / 16, E);
      if (rl.score < 0.30) {
        /* this packet's sync is gone — count the loss, hunt for the next.
           The window must exceed the longest possible packet (a destroyed
           stripe still occupies its full airtime). */
        guardMisses++;
        stats.crcFail++;
        if (o.onStripe) o.onStripe(-1, null, stats);
        if (guardMisses > 3) { say("carrier lost"); break; }
        let hunt = { score: -2, pos: cursor };
        const huntEnd = Math.min(y.length - SYNCSEQ.length * spSym,
                                 cursor + 24000 * spSym);
        for (let pos = cursor + spSym; pos < huntEnd; pos += spSym / 3) {
          const sc = syncScoreAt(y, fs, pos, spSym, E);
          if (sc > hunt.score) hunt = { score: sc, pos };
          if (sc > 0.8) break;
        }
        if (hunt.score < 0.40) { say("no further packets"); break; }
        cursor = refineSync(y, fs, hunt.pos, spSym, 0.6, 1 / 16, E).pos;
        continue;
      }
      guardMisses = 0;
      let pos = rl.pos + SYNCSEQ.length * spSym;

      const hb = decodeSection(y, fs, pos, spSym, 7, E);
      pos += HDR_SYMS * spSym;
      const hOK = crc16(hb, 5) === ((hb[5] << 8) | hb[6]);
      if (!hOK) {
        stats.hdrFail++;
        cursor = pos;                                    // resync will recover
        continue;
      }
      const type = hb[0];
      const seq = (hb[1] << 8) | hb[2];
      const len = (hb[3] << 8) | hb[4];
      const body = decodeSection(y, fs, pos, spSym, len + 4, E);
      pos += sectionSyms(len + 4) * spSym;
      const payload = body.subarray(0, len);
      const gotCrc = ((body[len] << 24) | (body[len + 1] << 16) |
                      (body[len + 2] << 8) | body[len + 3]) >>> 0;
      const ok = crc32(payload) === gotCrc;

      if (type === PKT_HDR && ok && payload.length >= 12 &&
          payload[0] === MAGIC0 && payload[1] === MAGIC1 &&
          payload[11] === PC_FLAG) {
        /* audio postcard header: [2..4]=n u24LE [5]=S/32 [6]=rate/25
           [8..9]=nChunks u16LE — see encodePostcardD */
        const n = payload[2] | (payload[3] << 8) | (payload[4] << 16);
        const S = payload[5] * 32, rate = payload[6] * 25;
        const nChunks = payload[8] | (payload[9] << 8);
        if (n < 2 || S < 64 || S > 2048 || rate < PC_MIN_RATE ||
            n > pcCapacity(S) || nChunks !== Math.ceil(n / PC_CHUNK)) {
          stats.hdrFail++;
        } else {
          if (!pc) {
            pc = { S, n, rate, nChunks, passes: payload[10], got: 0,
                   codes: new Uint8Array(n).fill(128),
                   have: new Uint8Array(nChunks) };
            stats.nStripes = nChunks;
            say(`audio postcard: ${(n / rate).toFixed(1)} s @ ${rate} Hz ` +
                `\u03bc-law, ${nChunks} chunks, ${pc.passes} pass` +
                `${pc.passes > 1 ? "es" : ""}`);
            if (o.onPostcard) o.onPostcard(pc);
          }
          stats.passes = Math.max(stats.passes, seq + 1);
        }
      } else if (type === PKT_HDR && ok && payload.length >= 12 &&
          payload[0] === MAGIC0 && payload[1] === MAGIC1) {
        const w = (payload[2] << 8) | payload[3];
        const h = (payload[4] << 8) | payload[5];
        const nStripes = (payload[8] << 8) | payload[9];
        if (!hdr) {
          hdr = { w, h, quality: payload[6], stripeH: payload[7],
                  nStripes, passes: payload[10],
                  qtY: quantTable(QLUMA, payload[6]),
                  qtC: quantTable(QCHROMA, payload[6]) };
          stats.nStripes = nStripes;
          const wc = Math.ceil(w / 2), hc = Math.ceil(h / 2);
          P = { Y: new Float64Array(w * h).fill(128),
                Cb: new Float64Array(wc * hc).fill(128),
                Cr: new Float64Array(wc * hc).fill(128),
                w, h, wc, hc };
          have = new Uint8Array(nStripes);
          say(`header: ${w}×${h} q${hdr.quality}, ${nStripes} stripes, ` +
              `${hdr.passes} pass${hdr.passes > 1 ? "es" : ""}`);
          if (o.onHeader) o.onHeader(hdr);
        }
        stats.passes = Math.max(stats.passes, seq + 1);
      } else if (type === PKT_STRIPE && pc) {
        if (!ok) {
          stats.crcFail++;
          if (o.onStripe) o.onStripe(-1, null, stats);
        } else if (seq < pc.nChunks && !pc.have[seq]) {
          const off = seq * PC_CHUNK;
          const take = Math.min(payload.length, pc.n - off);
          if (take > 0) pc.codes.set(payload.subarray(0, take), off);
          pc.have[seq] = 1; pc.got++; stats.stripesOk++;
          if (o.onChunk) o.onChunk(seq, off, off + take, pc, stats);
          if (pc.got === pc.nChunks) {
            say(`all ${pc.nChunks} chunks received \u2014 postcard complete`);
            done = true;
          }
        }
      } else if (type === PKT_STRIPE && hdr) {
        if (!ok) {
          stats.crcFail++;
          if (o.onStripe) o.onStripe(-1, null, stats);
        } else if (seq < hdr.nStripes && !have[seq]) {
          try {
            decodeStripe(P, seq, payload, hdr.qtY, hdr.qtC);
            have[seq] = 1;
            stats.stripesOk++;
            if (o.onStripe) o.onStripe(seq, planesToRgb(P), stats);
            if (stats.stripesOk === hdr.nStripes) {
              say(`all ${hdr.nStripes} stripes received — image complete`);
              done = true;
            }
          } catch (e) {
            stats.crcFail++;                             // malformed despite CRC
          }
        }
      } else if (type === PKT_END && ok) {
        say(`end of transmission (${stats.stripesOk}/${stats.nStripes} stripes)`);
        done = true;
      } else if (!ok) {
        stats.crcFail++;
      }
      cursor = pos;
      if (o.progress) o.progress(Math.min(1, cursor / y.length));
      await tick();
      if (hdr && stats.stripesOk === hdr.nStripes && done) break;
    }

    img = finishImage();
    return { img, stats, hdr, postcard: pc };
  }

  /* =====================================================================
     AUDIO POSTCARD — a VREC-mini virtual vinyl pressing over HRWS-D1
     ---------------------------------------------------------------------
     A 320x320 px "45" whose groove IS the audio: each sample is one
     mu-law byte written as pixel brightness along a closed-form
     Archimedean spiral (VREC v1 format, miniaturized). The disc travels
     as RAW mu-law bytes in ordinary D1 stripe packets — no DCT, no loss:
     the bytes on the air are literally the pixels of the groove, and
     both ends render the identical pressing deterministically.

     Geometry (fractions of S = 320):
       disc .495 | header ring .478 | data .460 -> .185 | label .150
       pitch 1.5 px/rev, step 1.45 px/sample.
       Uniqueness proof: two continuous points closer than sqrt(2) are the
       only ones that can round (half-up) into the same pixel. Consecutive
       samples sit 1.45 px of arc apart (chord ~1.44997 > sqrt2) and
       adjacent revolutions ~1.5 px apart, so every sample owns a pixel.
     Capacity: (ro^2-ri^2)/(2k*step) = 26235 samples = 15.0 s @ 1750 Hz.

     The header ring (VREC 26-byte records, repeated ~660x) is rendered
     LOCALLY on both ends — zero airtime — which makes any saved PNG a
     fully self-describing record that the desktop VREC Studio decoder
     and turntable will play unmodified.

     The deck below never touches the codes[] buffer: it is an optical
     pickup that decodes pixels live from the canvas, exactly like the
     desktop GrooveReader. If a stripe hasn't arrived yet, you hear the
     blank groove.                                                     */

  function fmtAir(s) { return s < 90 ? s.toFixed(0) + " s" : (s / 60).toFixed(1) + " min"; }

  const PC_S = 320;                       // pressing canvas (square)
  const PC_F_DISC = 0.495, PC_F_HEADER = 0.478;
  const PC_F_OUTER = 0.460, PC_F_INNER = 0.185;
  const PC_F_LABEL = 0.150, PC_F_HOLE = 0.014;
  const PC_PITCH = 1.5, PC_STEP = 1.45;   // px/rev, px/sample (>sqrt2)
  const PC_RING_STEP = 1.5;               /* the header ring is ALWAYS walked
     at the format's default step — the decoder must find the ring before it
     can know the disc's own step (VREC ring_xy default) */
  const PC_VERSION = 1, PC_FLAG_MULAW = 0x01;
  const PC_RING_BYTES = 26;
  const PC_CHUNK = 512;                   // mu-law bytes per stripe packet
  const PC_FLAG = 1;                      // hdrPayload[11] marker
  const PC_MIN_RATE = 1600;
  const PC_REC_MAX_S = 15.5;              // recorder hard stop
  const PC_RATES = [
    { rate: 4800, name: "Voice+ · 4.8 kHz" },
    { rate: 3200, name: "AM · 3.2 kHz" },
    { rate: 2400, name: "Shortwave · 2.4 kHz" },
    { rate: 1750, name: "DX · 1.75 kHz" }
  ];

  /* ------------------------------ mu-law ------------------------------ */

  function pcMulawEncode(x) {             // float [-1,1] -> byte
    if (x > 1) x = 1; else if (x < -1) x = -1;
    const y = (x < 0 ? -1 : 1) * Math.log1p(255 * Math.abs(x)) / Math.log1p(255);
    const b = Math.floor((y + 1) * 127.5 + 0.5);
    return b < 0 ? 0 : b > 255 ? 255 : b;
  }
  const PC_ULAW = (() => {                // byte -> float (decoder LUT)
    const t = new Float32Array(256);
    for (let b = 0; b < 256; b++) {
      const y = b / 127.5 - 1;
      t[b] = (y < 0 ? -1 : 1) * (Math.pow(256, Math.abs(y)) - 1) / 255;
    }
    return t;
  })();

  /* ----------------------------- geometry ----------------------------- */

  function pcGeom(S) {
    const k = PC_PITCH / (2 * Math.PI);
    return { S, k, ro: PC_F_OUTER * S, ri: PC_F_INNER * S, cx: S / 2, cy: S / 2 };
  }
  function pcCapacity(S) {
    const g = pcGeom(S);
    return Math.floor((g.ro * g.ro - g.ri * g.ri) / (2 * g.k * PC_STEP));
  }
  /* Pixel of sample i. Closed form, half-up rounding — this formula IS
     the file format (identical to VREC spiral_xy). */
  function pcXY(i, g, out) {
    const r2 = g.ro * g.ro - 2 * g.k * (i * PC_STEP);
    const r = Math.sqrt(r2 > 0 ? r2 : 0);
    const th = (g.ro - r) / g.k;
    out.x = Math.floor(g.cx + r * Math.cos(th) + 0.5);
    out.y = Math.floor(g.cy + r * Math.sin(th) + 0.5);
    return out;
  }
  function pcGrooveR(pos, g) {            // radius floor = ri/2 (runout)
    const v = g.ro * g.ro - 2 * g.k * PC_STEP * Math.max(0, pos);
    const fl = (g.ri * g.ri) * 0.25;
    return Math.sqrt(v > fl ? v : fl);
  }
  function pcGrooveTh(pos, g) { return (g.ro - pcGrooveR(pos, g)) / g.k; }
  function pcPosForR(r, g) {              // inverse of pcGrooveR (data band)
    return (g.ro * g.ro - r * r) / (2 * g.k * PC_STEP);
  }

  /* ------------------- header ring (VREC v1, 26 B LE) ------------------ */

  function pcPackRing(rate, n) {
    const b = new Uint8Array(PC_RING_BYTES);
    const dv = new DataView(b.buffer);
    b[0] = 0x56; b[1] = 0x52; b[2] = 0x45; b[3] = 0x43;   // "VREC"
    b[4] = PC_VERSION; b[5] = PC_FLAG_MULAW;
    dv.setUint32(6, rate >>> 0, true);
    dv.setUint32(10, n >>> 0, true);
    dv.setUint16(14, Math.round(PC_PITCH * 1000), true);
    dv.setUint16(16, Math.round(PC_STEP * 1000), true);
    dv.setUint16(18, Math.round(PC_F_OUTER * 10000), true);
    dv.setUint16(20, Math.round(PC_F_INNER * 10000), true);
    dv.setUint32(22, crc32(b.subarray(0, 22)) >>> 0, true);
    return b;
  }
  function pcParseRing(buf, off) {
    if (buf[off] !== 0x56 || buf[off + 1] !== 0x52 ||
        buf[off + 2] !== 0x45 || buf[off + 3] !== 0x43) return null;
    const body = buf.subarray(off, off + 22);
    const dv = new DataView(buf.buffer, buf.byteOffset + off, PC_RING_BYTES);
    if ((crc32(body) >>> 0) !== dv.getUint32(22, true)) return null;
    return {
      version: buf[off + 4], flags: buf[off + 5],
      rate: dv.getUint32(6, true), n: dv.getUint32(10, true),
      pitch: dv.getUint16(14, true) / 1000, step: dv.getUint16(16, true) / 1000,
      fOuter: dv.getUint16(18, true) / 10000, fInner: dv.getUint16(20, true) / 10000
    };
  }
  function pcRingXY(S, cb) {              // walk the ring at PC_RING_STEP
    const rh = PC_F_HEADER * S, c = S / 2;
    const m = Math.floor(2 * Math.PI * rh / PC_RING_STEP), da = PC_RING_STEP / rh;
    for (let i = 0; i < m; i++) {
      const th = i * da;
      cb(Math.floor(c + rh * Math.cos(th) + 0.5),
         Math.floor(c + rh * Math.sin(th) + 0.5), i, m);
    }
    return m;
  }
  function pcWriteRing(img, rate, n) {
    const rec = pcPackRing(rate, n), d = img.data, W = img.width;
    pcRingXY(img.width, (x, y, i) => {
      const v = rec[i % PC_RING_BYTES], p = (y * W + x) * 4;
      d[p] = v; d[p + 1] = v; d[p + 2] = v; d[p + 3] = 255;
    });
  }
  /* Optical ring read: scan the G channel around the circle, count valid
     record copies (>=3 rejects grazes) — same policy as the desktop. */
  function pcReadRing(img) {
    const W = img.width, d = img.data;
    const m = Math.floor(2 * Math.PI * PC_F_HEADER * Math.min(W, img.height) / PC_RING_STEP);
    const stream = new Uint8Array(m + PC_RING_BYTES);
    pcRingXY(Math.min(W, img.height), (x, y, i) => {
      stream[i] = d[(y * W + x) * 4 + 1];
    });
    stream.set(stream.subarray(0, PC_RING_BYTES), m);
    let first = null, copies = 0;
    for (let i = 0; i + PC_RING_BYTES <= stream.length; i++) {
      if (stream[i] !== 0x56) continue;
      const h = pcParseRing(stream, i);
      if (h) { copies++; if (!first) first = h; }
    }
    return copies >= 3 ? first : null;
  }

  /* ------------------------ audio fit + press ------------------------- */

  function pcResample(x, from, to) {
    if (from === to || !x.length) return Float32Array.from(x);
    const cut = 0.45 * Math.min(from, to);
    const f = fftBandpass(x, from, 0, cut);          // brickwall first
    const m = Math.max(1, Math.round(x.length * to / from));
    const out = new Float32Array(m), N = f.length, ratio = from / to;
    for (let k = 0; k < m; k++) {                    // Catmull-Rom cubic
      const pos = k * ratio, i = Math.floor(pos), t = pos - i;
      const a = f[i > 0 ? i - 1 : 0], b = f[i < N ? i : N - 1];
      const c = f[i + 1 < N ? i + 1 : N - 1], e = f[i + 2 < N ? i + 2 : N - 1];
      out[k] = b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - e +
               t * (3 * (b - c) + e - a)));
    }
    return out;
  }
  function pcFitPlan(durS, rate, cap) {   // lower rate before trimming;
    let use = rate | 0, trimmed = false;  // rate floored to /25 for the link
    if (durS > 0 && durS * use > cap) {
      use = Math.max(PC_MIN_RATE, Math.min(use, Math.floor(cap / durS)));
      use = Math.max(PC_MIN_RATE, Math.floor(use / 25) * 25);
      if (durS * use > cap) trimmed = true;
    }
    return { rate: use, trimmed };
  }
  /* Master the take: resample, trim to capacity, normalize, mu-law. */
  function pcPress(audio, srcRate, wantRate) {
    const cap = pcCapacity(PC_S);
    const plan = pcFitPlan(audio.length / srcRate, wantRate, cap);
    let a = pcResample(audio, srcRate, plan.rate);
    if (a.length > cap) a = a.subarray(0, cap);
    let peak = 0;
    for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > peak) peak = v; }
    if (peak > 0) { const s = 0.95 / peak; for (let i = 0; i < a.length; i++) a[i] *= s; }
    const codes = new Uint8Array(a.length);
    for (let i = 0; i < a.length; i++) codes[i] = pcMulawEncode(a[i]);
    return { codes, rate: plan.rate, n: codes.length,
             durS: codes.length / plan.rate, trimmed: plan.trimmed, cap };
  }

  /* --------------------------- pressing art --------------------------- */

  function pcRng(seed) {                  // LCG + Box-Muller (cosmetics only)
    let s = seed >>> 0, spare = null;
    const u = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    return {
      norm(sd) {
        if (spare !== null) { const v = spare; spare = null; return v * sd; }
        let a = 0; while (a === 0) a = u();
        const m = Math.sqrt(-2 * Math.log(a)), b = 2 * Math.PI * u();
        spare = m * Math.sin(b);
        return m * Math.cos(b) * sd;
      }
    };
  }
  /* Near-black disc, two soft sheen highlights, per-ring noise. Painted
     first; grooves overwrite it, so the gloss lives only in the gaps. */
  function pcBackground(img) {
    const W = img.width, H = img.height, S = Math.min(W, H);
    const d = img.data, rd = PC_F_DISC * S, cx = W / 2, cy = H / 2;
    const rng = pcRng(20260612);
    const rn = new Float32Array(Math.floor(rd) + 3);
    for (let i = 0; i < rn.length; i++) rn[i] = rng.norm(2.4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4, dx = x - cx, dy = y - cy;
      const R = Math.hypot(dx, dy);
      if (R > rd) { d[p] = 12; d[p + 1] = 13; d[p + 2] = 14; d[p + 3] = 255; continue; }
      let g = 15;
      const ang = Math.atan2(dy, dx), rr = Math.min(1, R / rd);
      for (const a0 of [2.35, -0.79]) {
        let da = ang - a0;
        da -= 2 * Math.PI * Math.floor((da + Math.PI) / (2 * Math.PI));
        g += 34 * Math.exp(-(da * da) / 0.18) * rr;
      }
      g += rn[Math.min(R | 0, rn.length - 1)];
      const v = g < 0 ? 0 : g > 255 ? 255 : g | 0;
      d[p] = v; d[p + 1] = v; d[p + 2] = v; d[p + 3] = 255;
    }
  }

  let _pcOcc = null;                      // occupied-pixel mask cache
  function pcOccupied(S, n) {
    if (_pcOcc && _pcOcc.S === S && _pcOcc.n === n) return _pcOcc.mask;
    const g = pcGeom(S), mask = new Uint8Array(S * S), pt = { x: 0, y: 0 };
    for (let i = 0; i < n; i++) { pcXY(i, g, pt); mask[pt.y * S + pt.x] = 1; }
    _pcOcc = { S, n, mask };
    return mask;
  }
  /* Paint samples [i0,i1) plus the cosmetic midpoints they touch.
     Midpoints fill the 1.45 px gaps so grooves render as solid lines;
     the decoder never reads them (written only on unoccupied pixels). */
  function pcPaintRange(img, codes, i0, i1, n) {
    const W = img.width, S = Math.min(W, img.height);
    const g = pcGeom(S), d = img.data, occ = pcOccupied(S, n), pt = { x: 0, y: 0 };
    i0 = Math.max(0, i0); i1 = Math.min(n, i1);
    for (let i = i0; i < i1; i++) {
      pcXY(i, g, pt);
      const p = (pt.y * W + pt.x) * 4, v = codes[i];
      d[p] = v; d[p + 1] = v; d[p + 2] = v; d[p + 3] = 255;
    }
    const m0 = Math.max(0, i0 - 1), m1 = Math.min(n - 1, i1);
    for (let i = m0; i < m1; i++) {       // midpoint of pair (i, i+1)
      const s = (i + 0.5) * PC_STEP;
      const r = Math.sqrt(Math.max(g.ro * g.ro - 2 * g.k * s, 0));
      const th = (g.ro - r) / g.k;
      const x = Math.floor(g.cx + r * Math.cos(th) + 0.5);
      const y = Math.floor(g.cy + r * Math.sin(th) + 0.5);
      if (occ[y * S + x]) continue;
      const p = (y * W + x) * 4, v = ((codes[i] + codes[i + 1]) / 2) | 0;
      d[p] = v; d[p + 1] = v; d[p + 2] = v; d[p + 3] = 255;
    }
  }
  /* Read the groove back off the pixels (byte-exact inverse of paint). */
  function pcReadCodes(img, hdr) {
    const W = img.width, S = Math.min(W, img.height), d = img.data;
    const k = hdr.pitch / (2 * Math.PI), ro = hdr.fOuter * S;
    const out = new Uint8Array(hdr.n), c = S / 2;
    for (let i = 0; i < hdr.n; i++) {
      const r2 = ro * ro - 2 * k * (i * hdr.step);
      const r = Math.sqrt(r2 > 0 ? r2 : 0), th = (ro - r) / k;
      const x = Math.floor(c + r * Math.cos(th) + 0.5);
      const y = Math.floor(c + r * Math.sin(th) + 0.5);
      out[i] = d[(y * W + x) * 4 + 1];
    }
    return out;
  }

  /* Label art (cosmetic — the decoder never looks under r = 0.15*S). */
  function pcDrawLabel(c2, S, meta) {
    const cx = S / 2, cy = S / 2, lr = PC_F_LABEL * S;
    c2.save();
    c2.beginPath(); c2.arc(cx, cy, lr, 0, 2 * Math.PI);
    const grad = c2.createRadialGradient(cx - lr * 0.3, cy - lr * 0.35, lr * 0.1, cx, cy, lr);
    grad.addColorStop(0, "rgb(196,58,50)"); grad.addColorStop(1, "rgb(150,36,32)");
    c2.fillStyle = grad; c2.fill();
    c2.strokeStyle = "rgba(245,233,205,.9)"; c2.lineWidth = 1;
    c2.beginPath(); c2.arc(cx, cy, lr - 1, 0, 2 * Math.PI); c2.stroke();
    c2.strokeStyle = "rgba(245,233,205,.35)";
    c2.beginPath(); c2.arc(cx, cy, lr - 4, 0, 2 * Math.PI); c2.stroke();
    c2.fillStyle = "rgb(245,233,205)"; c2.textAlign = "center";
    const T = (t, y, px, w) => {
      c2.font = (w || "") + " " + px + "px 'Chakra Petch', monospace";
      c2.fillText(t, cx, cy + y);
    };
    T("AUDIO POSTCARD", -19, 7.5, "600");
    T(meta.who || "VIA HRWS-D1", -8, 10, "700");
    const mm = Math.floor(meta.durS / 60), ss = Math.round(meta.durS % 60);
    T(mm + ":" + String(ss).padStart(2, "0") + " \u00b7 " + meta.rate + " Hz", 13, 7);
    T("\u03bc-LAW \u00b7 45 RPM", 22, 6.5);
    c2.fillStyle = "rgb(8,8,9)";
    c2.beginPath(); c2.arc(cx, cy, PC_F_HOLE * S, 0, 2 * Math.PI); c2.fill();
    c2.strokeStyle = "rgba(255,255,255,.25)";
    c2.beginPath(); c2.arc(cx, cy, PC_F_HOLE * S + 0.8, 0, 2 * Math.PI); c2.stroke();
    c2.restore();
  }

  /* Full pressing onto a canvas. codes may be partially received; pass
     haveAll=false to keep it re-paintable. Returns the live ImageData. */
  function pcRenderToCanvas(cv, codes, meta) {
    cv.width = PC_S; cv.height = PC_S;
    const c2 = cv.getContext("2d", { willReadFrequently: true });
    const img = c2.createImageData(PC_S, PC_S);
    pcBackground(img);
    c2.putImageData(img, 0, 0);
    pcDrawLabel(c2, PC_S, meta);          // vector art (label only)
    const fin = c2.getImageData(0, 0, PC_S, PC_S);
    pcWriteRing(fin, meta.rate, meta.n);  // exact pixels from here on
    pcPaintRange(fin, codes, 0, meta.n, meta.n);
    c2.putImageData(fin, 0, 0);
    return fin;
  }

  /* ------------------------- link layer (TX) -------------------------- */

  /* Postcard header payload (12 B, same slot as the image header):
     [0]=0x44 [1]=0x31  [2..4]=n_samples u24LE  [5]=S/32  [6]=rate/25
     [7]=pressing ver   [8..9]=nChunks u16LE    [10]=passes [11]=1
     Image mode keeps [11]=0, so old receivers simply ignore postcards. */
  function encodePostcardD(codes, rate, passes, fs, voxHdr) {
    const n = codes.length, nChunks = Math.ceil(n / PC_CHUNK) || 1;
    const hdrPayload = new Uint8Array(12);
    hdrPayload[0] = MAGIC0; hdrPayload[1] = MAGIC1;
    hdrPayload[2] = n & 0xff; hdrPayload[3] = (n >> 8) & 0xff;
    hdrPayload[4] = (n >> 16) & 0xff;
    hdrPayload[5] = (PC_S / 32) | 0;
    hdrPayload[6] = (rate / 25) | 0;
    hdrPayload[7] = PC_VERSION;
    hdrPayload[8] = nChunks & 0xff; hdrPayload[9] = (nChunks >> 8) & 0xff;
    hdrPayload[10] = passes; hdrPayload[11] = PC_FLAG;
    const tonesAll = [];
    for (let i = 0; i < PREAMBLE_SYMS; i++) tonesAll.push(i & 1 ? 3 : 0);
    let payloadBytes = 0;
    for (let p = 0; p < passes; p++) {
      tonesAll.push(...buildPacketTones(PKT_HDR, 0, hdrPayload));
      for (let c = 0; c < nChunks; c++) {
        const chunk = codes.subarray(c * PC_CHUNK, Math.min(n, (c + 1) * PC_CHUNK));
        tonesAll.push(...buildPacketTones(PKT_STRIPE, c, chunk));
        payloadBytes += chunk.length;
      }
    }
    tonesAll.push(...buildPacketTones(PKT_END, 0, new Uint8Array(0)));
    const air = symbolsToAir(tonesAll, fs, voxHdr);
    return {
      y: air.y, layout: "postcard", symStart: air.symStart, spSym: air.spSym,
      nStripes: nChunks, payloadBytes, totalSyms: tonesAll.length,
      airS: air.y.length / fs, header: hdrPayload,
      postcard: { S: PC_S, n, rate, nChunks, codes }
    };
  }
  /* Honest airtime estimate before you key up. */
  function pcAirEstimate(n, passes, voxHdr) {
    const full = Math.floor(n / PC_CHUNK), rem = n - full * PC_CHUNK;
    const perPass = packetSymCount(12) + full * packetSymCount(PC_CHUNK) +
                    (rem ? packetSymCount(rem) : 0);
    const syms = perPass * passes + packetSymCount(0);
    return (PREAMBLE_SYMS + syms) / BAUD + 0.6 + (voxHdr ? 0.7 : 0) + 0.35;
  }

  /* A pressing as a portable object: the vinyl circle with TRANSPARENT
     corners. Nothing outside the record edge carries information — the
     header ring (0.478) and the groove band (0.185..0.460) both live
     inside PC_F_DISC (0.495) — so the alpha crop is loss-free for this
     deck, for _pcLoadPng, and for the desktop VREC Studio (its ring and
     groove readers only ever sample inside the disc). */
  function pcCircularPng(srcCanvas) {
    const cv = document.createElement("canvas");
    cv.width = PC_S; cv.height = PC_S;
    const c = cv.getContext("2d");
    c.imageSmoothingEnabled = false;
    c.drawImage(srcCanvas, 0, 0, PC_S, PC_S);
    c.globalCompositeOperation = "destination-in";
    c.beginPath();
    c.arc(PC_S / 2, PC_S / 2, PC_F_DISC * PC_S + 0.5, 0, 2 * Math.PI);
    c.fill();
    c.globalCompositeOperation = "source-over";
    return cv.toDataURL("image/png");
  }

  /* stateful biquad (RBJ) — the deck's reconstruction filter */
  function makeBiquad(type, f0, Q, fs) {
    const w0 = 2 * Math.PI * f0 / fs;
    const cw = Math.cos(w0), sw = Math.sin(w0);
    const al = sw / (2 * Q);
    let b0, b1, b2, a0, a1, a2;
    if (type === "hp") {
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
    } else {
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
    }
    a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al;
    b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
    return {
      z1: 0, z2: 0,
      step(v) {
        const y = b0 * v + this.z1;
        this.z1 = b1 * v - a1 * y + this.z2;
        this.z2 = b2 * v - a2 * y;
        return y;
      }
    };
  }

  /* Render a whole side offline: the pickup's exact per-sample formula
     (linear-interpolated PC_ULAW along the closed-form spiral, gain 0.95)
     at steady speed. This is what the deck plays when nothing is wrong —
     save it to WAV and any difference you HEAR live is, by construction,
     downstream of this studio: OS mixer, virtual cables, processors. */
  function pcRenderSide(img, meta) {
    const ring = pcReadRing(img);
    const S = Math.min(img.width, img.height), W = img.width;
    const n = (ring && ring.n) || meta.n;
    const rate = (ring && ring.rate) || meta.rate;
    const pitch = (ring && ring.pitch) || PC_PITCH;
    const gs = (ring && ring.step) || PC_STEP;
    const fo = (ring && ring.fOuter) || PC_F_OUTER;
    const is16 = !!(ring && (ring.version === 2 || (ring.flags & 0x02)));
    const k2 = pitch / (2 * Math.PI), ro = fo * S, cx = S / 2, cy = S / 2;
    const sampAt = i => {
      const r2 = ro * ro - 2 * k2 * (i * gs);
      const r = Math.sqrt(r2 > 0 ? r2 : 0), th = (ro - r) / k2;
      const x = Math.floor(cx + r * Math.cos(th) + 0.5);
      const y = Math.floor(cy + r * Math.sin(th) + 0.5);
      const p = (y * W + x) * 4, d = img.data;
      if (is16) {
        const u = (d[p + 1] << 8) | ((d[p] & 15) << 4) | (d[p + 2] & 15);
        return (u - 32768) / 32767;
      }
      return PC_ULAW[d[p + 1]];
    };
    const fc = Math.min(0.45 * rate, 21000);
    const lp = [makeBiquad("lp", fc, 0.5412, DECK_RATE),
                makeBiquad("lp", fc, 1.3066, DECK_RATE)];
    const step = rate / DECK_RATE;
    const out = new Float32Array(Math.floor((n - 1) / step));
    for (let k = 0; k < out.length; k++) {
      const idx = (k + 1) * step;
      let i0 = idx | 0; if (i0 > n - 2) i0 = n - 2;
      const fr = idx - i0;
      const g0 = sampAt(i0) * (1 - fr) + sampAt(i0 + 1) * fr;
      out[k] = lp[1].step(lp[0].step(g0)) * 0.95;
    }
    return out;
  }

  /* ================== PostcardDeck: the mini turntable ==================
     Live optical pickup with real deck feel:
       - drag the tonearm off its rest -> motor starts, platter spins up
       - drop the needle on the groove -> plays from that radius
       - drag the spinning disc        -> scratch (position chases hand)
       - park the arm past the edge    -> motor coasts down
     Physics ported from VREC record_player.py: velocity slew 0.25/block,
     scratch follower kp = 1/(0.045*rate) clamped to +-48x, CLV playback
     with the platter shown at a constant visual 45 RPM at the rim.     */

  /* 48 kHz out: v2 discs up to 44.1 kHz never fold on read, and most
     contexts take the stream natively */
  const DECK_RATE = 48000, DECK_BLOCK = 768;

  class PostcardDeck {
    constructor(canvas, audio, onInfo) {
      this.cv = canvas; this.c2 = canvas.getContext("2d");
      this.audio = audio; this.onInfo = onInfo || (() => {});
      this.W = 520; this.H = 310;
      canvas.width = this.W; canvas.height = this.H;
      this.P = { x: 150, y: 160 };        // platter center
      this.PIVOT = { x: 386, y: 56 };     // tonearm pivot
      this.discPx = 232;                  // disc draw size (px)
      this.scale = this.discPx / PC_S;
      this.dPC = Math.hypot(this.PIVOT.x - this.P.x, this.PIVOT.y - this.P.y);
      this.restR = 150;                   // needle radius on the rest
      this.armLen = this.dPC - PC_F_LABEL * PC_S * this.scale * 0.85;
      this.mode = "rest";                 // rest | lifted | playing | returning
      this.armR = this.restR;
      this.motorOn = false; this.motorEnv = 0;
      this.pos = 0; this.vel = 0; this.A = 0; this.A0 = 0;
      this.scratch = { active: false, target: 0 };
      this.drag = null; this.title = ""; this.loaded = false;
      this.stream = null; this.pump = null; this.raf = 0;
      this._pushed = 0; this._t0 = 0;
      this.sfxOn = false;   /* VREC-transparent by default: the groove
                                 bytes ARE the audio, nothing added. The
                                 vintage surface theater (hiss, pops,
                                 rumble, thump) is opt-in. */
      this.sfx = { hissLP: 0, popEnv: 0, popSign: 1, rumPh: 0,
                   dropEnv: 0, dropPh: 0, clickEnv: 0, rndS: 22222 };
      this.discCv = document.createElement("canvas");
      this.discCv.width = PC_S; this.discCv.height = PC_S;
      this._bindPointer();
      this._draw = this._draw.bind(this);
      this.raf = requestAnimationFrame(this._draw);
      this._lastT = performance.now();
    }

    /* Load a pressing straight off a canvas. Reads the header ring
       OPTICALLY first (self-describing disc); link metadata is only the
       fallback. */
    load(srcCanvas, fallbackMeta, title) {
      if (srcCanvas && srcCanvas.data && srcCanvas.width) {
        this.srcCv = null;                 // raw ImageData-like: use directly
        this.img = srcCanvas;
      } else {
        this.srcCv = srcCanvas;
        const S0 = Math.max(64, Math.min(4096,
          Math.min(srcCanvas.width || PC_S, srcCanvas.height || PC_S)));
        this.discCv.width = S0; this.discCv.height = S0;
        const d2 = this.discCv.getContext("2d", { willReadFrequently: true });
        d2.imageSmoothingEnabled = false;  // grooves are data, never smooth
        d2.clearRect(0, 0, S0, S0);
        d2.drawImage(srcCanvas, 0, 0, S0, S0);
        this.img = d2.getImageData(0, 0, S0, S0);
      }
      const ring = pcReadRing(this.img);
      const m = ring || fallbackMeta;
      if (!m || !m.n || !m.rate) {
        this._fault = "not a VREC pressing \u2014 no readable header ring";
        this.loaded = false; this._info();
        return false;
      }
      this._fault = "";
      this.meta = { n: m.n, rate: m.rate };
      /* geometry from the disc's own header ring: any size, any pitch/step,
         v1 mu-law or v2 16-bit PCM — pressings from the desktop VREC Studio
         play here natively */
      const S = Math.min(this.img.width, this.img.height);
      const pitch = (ring && ring.pitch) || PC_PITCH;
      this.gStep = (ring && ring.step) || PC_STEP;
      const fo = (ring && ring.fOuter) || PC_F_OUTER;
      const fi = (ring && ring.fInner) || PC_F_INNER;
      this.g = { S, k: pitch / (2 * Math.PI), ro: fo * S, ri: fi * S,
                 cx: S / 2, cy: S / 2 };
      this.is16 = !!(ring && (ring.version === 2 || (ring.flags & 0x02)));
      this.scale = this.discPx / S;
      this._pxLo = this.g.ri * this.scale * 0.9;
      this._pxVinyl = Math.min(0.5, fo + 0.035) * S * this.scale;
      /* reconstruction filter: what a proper DAC (or the OS resampler the
         desktop player leans on) does — kills interpolation images */
      const fc = Math.min(0.45 * m.rate, 21000);
      this._lp = [makeBiquad("lp", fc, 0.5412, DECK_RATE),
                  makeBiquad("lp", fc, 1.3066, DECK_RATE)];
      this.baseV = this.meta.rate / DECK_RATE;   // samples per out-sample
      const outerRps = this.meta.rate * this.gStep / (2 * Math.PI * this.g.ro);
      this.visSlow = outerRps / (45 / 60);       // real rev -> shown rev
      this.title = title || "AUDIO POSTCARD";
      this.ringRead = !!ring;
      this.loaded = true;
      this.pos = 0; this.vel = 0;
      if (this.mode === "playing") this.mode = "lifted";
      this._info();
      return true;
    }
    /* RX repaints the source canvas as stripes land; re-grab the pixels
       so the needle hears new grooves on its very next pass. */
    markDirty() {
      if (!this.srcCv || !this.loaded) return;
      const S0 = this.discCv.width;
      const d2 = this.discCv.getContext("2d", { willReadFrequently: true });
      d2.drawImage(this.srcCv, 0, 0, S0, S0);
      this.img = d2.getImageData(0, 0, S0, S0);
    }

    /* ---------------- optical pickup (the whole point) ---------------- */
    _px(i) {
      const g = this.g, r2 = g.ro * g.ro - 2 * g.k * (i * this.gStep);
      const r = Math.sqrt(r2 > 0 ? r2 : 0), th = (g.ro - r) / g.k;
      const x = Math.floor(g.cx + r * Math.cos(th) + 0.5);
      const y = Math.floor(g.cy + r * Math.sin(th) + 0.5);
      return (y * this.img.width + x) * 4;
    }
    _sampAt(i) {
      const d = this.img.data, p = this._px(i);
      if (this.is16) {
        const u = (d[p + 1] << 8) | ((d[p] & 15) << 4) | (d[p + 2] & 15);
        return (u - 32768) / 32767;
      }
      return PC_ULAW[d[p + 1]];
    }
    _briAt(i) { return this.img.data[this._px(i) + 1]; }
    _grooveR(pos) {
      const v = this.g.ro * this.g.ro - 2 * this.g.k * this.gStep * Math.max(0, pos);
      const fl = this.g.ri * this.g.ri * 0.25;
      return Math.sqrt(v > fl ? v : fl);
    }
    _grooveTh(pos) { return (this.g.ro - this._grooveR(pos)) / this.g.k; }
    _posForR(r) { return (this.g.ro * this.g.ro - r * r) / (2 * this.g.k * this.gStep); }
    _read(idx) {
      const n = this.meta.n;
      if (idx < 0) idx = 0; else if (idx > n - 1) idx = n - 1;
      let i0 = idx | 0; if (i0 > n - 2) i0 = n - 2;
      const fr = idx - i0;
      return this._sampAt(i0) * (1 - fr) + this._sampAt(i0 + 1) * fr;
    }

    /* ------------------------- audio engine --------------------------- */
    /* deck clock: the audio context's own clock when it runs (immune to
       wall drift and timer throttling), wall clock as the fallback */
    _clockNow() {
      const c = this.audio && this.audio.ctx;
      if (c && c.state === "running") {
        if (this._clockSrc !== "audio") {          // re-anchor, keep continuity
          this._clockSrc = "audio";
          this._clock0 = c.currentTime - this._pushed / DECK_RATE;
        }
        return c.currentTime;
      }
      if (this._clockSrc !== "wall") {
        this._clockSrc = "wall";
        this._clock0 = performance.now() / 1000 - this._pushed / DECK_RATE;
      }
      return performance.now() / 1000;
    }
    _deckFault(e) {
      console.error(e);                              // see console — really
      this._fault = "deck fault: " + e.message;
      this._closeStream();
      this.motorOn = false;
      this.mode = this.loaded ? "lifted" : "rest";
      this._info();
    }
    _ensureStream() {
      if (this.stream) return;
      try {
        this.stream = this.audio.openMonitorStream(DECK_RATE, 0.09);
        this._pushed = 0; this._fault = "";
        this._clockSrc = ""; this._clockNow();
        const prime = this._renderBlock(DECK_BLOCK * 3);
        this.stream.push(prime); this._pushed += prime.length;
      } catch (e) { this._deckFault(e); return; }
      /* interval is only the background backstop; _draw() also pumps every
         frame, so a throttled timer can never starve the needle */
      this.pump = setInterval(() => this._pump(), 24);
      const c = this.audio && this.audio.ctx;
      if (c && c.state !== "running") {
        this._fault = "audio suspended \u2014 click Start audio (top right)";
        try { c.resume().then(() => { this._fault = ""; this._info(); }); } catch (e) {}
        this._info();
      }
    }
    _pump() {
      if (!this.stream) return;
      try {
        let guard = 0;
        while (guard++ < 32) {
          const ahead = this._pushed / DECK_RATE - (this._clockNow() - this._clock0);
          if (ahead >= 0.075) break;
          const b = this._renderBlock(DECK_BLOCK);
          this.stream.push(b);
          this._pushed += b.length;
        }
      } catch (e) { this._deckFault(e); }
    }
    _closeStream() {
      if (this.pump) { clearInterval(this.pump); this.pump = null; }
      if (this.stream) { this.stream.stop(); this.stream = null; }
    }
    _rnd() { // tiny LCG for sfx noise
      this.sfx.rndS = (this.sfx.rndS * 1664525 + 1013904223) >>> 0;
      return this.sfx.rndS / 4294967296;
    }
    _renderBlock(N) {
      const out = new Float32Array(N), s = this.sfx;
      const playing = this.mode === "playing" && this.loaded;
      /* motor envelope (per block) — target_v multiplies through it, so
         spin-up and coast-down bend the pitch like a real deck */
      const dtB = N / DECK_RATE, tau = this.motorOn ? 0.35 : 0.9;
      this.motorEnv += ((this.motorOn ? 1 : 0) - this.motorEnv) *
                       (1 - Math.exp(-dtB / tau));
      if (this.motorEnv < 0.0005) this.motorEnv = 0;
      let target = 0;
      if (playing) {
        if (this.scratch.active) {
          const kp = 1 / (0.045 * DECK_RATE);      // follower gain (desktop)
          target = (this.scratch.target - this.pos) * kp;
          const lim = 48 * this.baseV;
          if (target > lim) target = lim; else if (target < -lim) target = -lim;
        } else target = this.baseV * this.motorEnv;
      }
      const v1 = this.vel + (target - this.vel) * 0.25;
      const dv = (v1 - this.vel) / N;
      let v = this.vel, ended = false;
      for (let k = 0; k < N; k++) {
        v += dv;
        let gsmp = 0;
        if (playing) {
          this.pos += v;
          if (this.pos >= this.meta.n - 1) { this.pos = this.meta.n - 1; ended = true; }
          if (this.pos < 0) this.pos = 0;
          gsmp = this._read(this.pos);
        }
        if (this._lp) gsmp = this._lp[1].step(this._lp[0].step(gsmp));
        let smp = gsmp;
        if (playing) {
          if (this.sfxOn) {
            smp *= 0.85;                          // headroom for the dirt
            /* surface: hiss + crackle scale with groove speed */
            const sp = Math.min(2.5, Math.abs(v) / (this.baseV || 1e-9));
            const w = this._rnd() * 2 - 1;
            s.hissLP += 0.22 * (w - s.hissLP);
            smp += s.hissLP * 0.010 * (0.45 + 0.55 * sp);
            if (this._rnd() < 0.00045 * (0.5 + sp)) {
              s.popEnv = 0.25 + 0.65 * this._rnd();
              s.popSign = this._rnd() < 0.5 ? -1 : 1;
            }
          }
        } else if (this.drag && this.drag.kind === "disc" && this.sfxOn) {
          const w = this._rnd() * 2 - 1;          // handling swish
          s.hissLP += 0.22 * (w - s.hissLP);
          smp += s.hissLP * 0.006;
        }
        if (s.popEnv > 0.001) {
          if (this.sfxOn) smp += s.popSign * s.popEnv * 0.32;
          s.popEnv *= 0.982;
        }
        if (this.sfxOn && this.motorEnv > 0.002) { // 27 Hz rumble
          s.rumPh += 2 * Math.PI * 27 / DECK_RATE;
          smp += Math.sin(s.rumPh) * 0.011 * this.motorEnv;
        }
        if (s.dropEnv > 0.001) {                   // needle-drop thump
          if (this.sfxOn) {
            s.dropPh += 2 * Math.PI * 55 / DECK_RATE;
            smp += (Math.sin(s.dropPh) * 0.6 + (this._rnd() - 0.5) * 0.5) * s.dropEnv * 0.5;
          }
          s.dropEnv *= 0.9974;
        }
        if (s.clickEnv > 0.001) {
          if (this.sfxOn) smp += (this._rnd() - 0.5) * s.clickEnv;
          s.clickEnv *= 0.90;
        }
        smp *= this.sfxOn ? 0.9 : 0.95;
        out[k] = smp > 1 ? 1 : smp < -1 ? -1 : smp;
      }
      this.vel = v1;
      if (ended && !this._endLatch) {             // end of side: auto-return
        this._endLatch = true;
        setTimeout(() => { this._autoReturn(); this._endLatch = false; }, 500);
      }
      return out;
    }

    /* -------------------------- deck actions -------------------------- */
    /* auto-play: motor on, needle onto the groove at atPos — what the
       desktop VREC deck does the moment a record lands on it */
    dropNeedle(atPos) {
      if (!this.loaded) return;
      this.motorOn = true;
      this.pos = Math.max(0, Math.min(this.meta.n - 2, atPos || 0));
      this.vel = 0;
      this.A0 = this.A - this._grooveTh(this.pos) / this.visSlow;
      this.armR = this._grooveR(this.pos) * this.scale;
      this.mode = "playing";
      this.sfx.dropEnv = 1; this.sfx.dropPh = 0;
      this._ensureStream(); this._info();
    }
    startStop() {
      if (!this.loaded) return;
      this.motorOn = !this.motorOn;
      this._ensureStream(); this._info();
    }
    _autoReturn() {
      if (this.mode !== "playing" && this.mode !== "lifted") return;
      this.mode = "returning"; this.motorOn = false;
      this.sfx.clickEnv = 0.25; this._info();
    }
    eject() { this._closeStream(); this.motorOn = false; this.motorEnv = 0;
              this.mode = "rest"; this.armR = this.restR;
              this.loaded = false; this.title = ""; this.pos = 0; this.vel = 0;
              this._fault = ""; this._info(); }
    destroy() {
      this.eject(); cancelAnimationFrame(this.raf);
      this._unbindPointer(); this.loaded = false;
    }

    /* ------------------------- pointer input -------------------------- */
    _evt(e) {
      const r = this.cv.getBoundingClientRect();
      return { x: (e.clientX - r.left) * (this.W / r.width),
               y: (e.clientY - r.top) * (this.H / r.height) };
    }
    _tip() {
      const a = this._armAngle(this.armR);
      return { x: this.PIVOT.x + this.armLen * Math.cos(a),
               y: this.PIVOT.y + this.armLen * Math.sin(a) };
    }
    _armAngle(r) {                        // law of cosines at the pivot
      const d = this.dPC, L = this.armLen;
      let cosA = (d * d + L * L - r * r) / (2 * d * L);
      cosA = Math.max(-1, Math.min(1, cosA));
      const beta = Math.atan2(this.P.y - this.PIVOT.y, this.P.x - this.PIVOT.x);
      return beta - Math.acos(cosA);      // elbow out: rest sits lower-right
    }
    _bindPointer() {
      this._down = (e) => {
        if (!this.loaded) return;
        const p = this._evt(e), tip = this._tip();
        if (p.x >= 14 && p.x <= 106 && p.y >= 12 && p.y <= 42) {
          this.startStop(); e.preventDefault(); return;
        }
        if (Math.hypot(p.x - tip.x, p.y - tip.y) < 26) {
          this.drag = { kind: "arm" };
          if (this.mode === "rest") {     // lifting off the rest wakes it
            this.motorOn = true; this._ensureStream();
            this.sfx.clickEnv = 0.35;
          }
          if (this.mode === "playing") this.sfx.clickEnv = 0.3;
          this.mode = "lifted";
          this._info();
        } else if (Math.hypot(p.x - this.P.x, p.y - this.P.y) < this.discPx / 2 + 6) {
          this.drag = { kind: "disc", ang: Math.atan2(p.y - this.P.y, p.x - this.P.x) };
          if (this.mode === "playing") {
            this.scratch.active = true; this.scratch.target = this.pos;
            this._ensureStream();
          }
        } else return;
        e.preventDefault();
        this.cv.setPointerCapture && this.cv.setPointerCapture(e.pointerId);
      };
      this._move = (e) => {
        if (!this.drag) return;
        const p = this._evt(e);
        if (this.drag.kind === "arm") {
          let r = Math.hypot(p.x - this.P.x, p.y - this.P.y);
          const lo = this._pxLo || PC_F_LABEL * PC_S * this.scale * 0.92;
          this.armR = Math.max(lo, Math.min(this.restR + 8, r));
        } else {
          const ang = Math.atan2(p.y - this.P.y, p.x - this.P.x);
          let da = ang - this.drag.ang;
          da -= 2 * Math.PI * Math.floor((da + Math.PI) / (2 * Math.PI));
          this.drag.ang = ang;
          this.A += da;                   // hand rules the platter
          if (this.scratch.active) {
            const rN = this._grooveR(this.scratch.target);
            let t = this.scratch.target + this.visSlow * rN * da / PC_STEP;
            this.scratch.target = Math.max(0, Math.min(this.meta.n - 2, t));
          }
        }
        e.preventDefault();
      };
      this._up = (e) => {
        if (!this.drag) return;
        if (this.drag.kind === "arm") {
          const rNat = this.armR / this.scale;
          const dEdge = this._pxVinyl || PC_F_DISC * PC_S * this.scale;
          if (this.armR > dEdge + 4) {    // parked past the edge
            this.mode = "returning"; this.motorOn = false;
          } else if (rNat <= this.g.ro + 3 && rNat >= this.g.ri - 3) {
            const pos = Math.max(0, Math.min(this.meta.n - 2, this._posForR(
              Math.min(this.g.ro, Math.max(this.g.ri, rNat)))));
            this.pos = pos; this.vel = 0;
            this.A0 = this.A - this._grooveTh(pos) / this.visSlow;
            this.mode = "playing";
            this.sfx.dropEnv = 1; this.sfx.dropPh = 0;
            this._ensureStream();
          }                               // else: hovers over label/gap
          this._info();
        } else if (this.scratch.active) {
          this.scratch.active = false;    // resume from wherever the hand left it
          this.pos = Math.max(0, Math.min(this.meta.n - 2, this.scratch.target));
          this.A0 = this.A - this._grooveTh(this.pos) / this.visSlow;
        }
        this.drag = null;
      };
      this.cv.addEventListener("pointerdown", this._down);
      window.addEventListener("pointermove", this._move);
      window.addEventListener("pointerup", this._up);
      this.cv.style.touchAction = "none";
    }
    _unbindPointer() {
      this.cv.removeEventListener("pointerdown", this._down);
      window.removeEventListener("pointermove", this._move);
      window.removeEventListener("pointerup", this._up);
    }

    _info() {
      const st = { rest: "STOPPED", lifted: "CUEING", playing: "PLAYING",
                   returning: "RETURNING" }[this.mode];
      this.onInfo(this._fault ? st + " \u00b7 \u26a0 " + this._fault : st);
    }

    /* ----------------------------- drawing ---------------------------- */
    _draw(t) {
      this.raf = requestAnimationFrame(this._draw);
      const dt = Math.min(0.05, (t - this._lastT) / 1000); this._lastT = t;
      this._pump();                                  // rAF keeps the needle fed
      const c = this.c2, W = this.W, H = this.H;

      /* platter angle bookkeeping */
      if (this.loaded) {
        const handOnDisc = this.drag && this.drag.kind === "disc";
        /* the pickup is real: as pos spirals inward, so does the arm —
           a frozen tonearm was the one thing that made it look staged */
        if (this.mode === "playing" && !(this.drag && this.drag.kind === "arm"))
          this.armR = Math.max(this._pxLo || PC_F_LABEL * PC_S * this.scale * 0.98,
                               this._grooveR(this.pos) * this.scale);
        if (this.mode === "playing" && !handOnDisc) {
          this.A = this.A0 + this._grooveTh(this.pos) / this.visSlow;
        } else if (!handOnDisc) {
          this.A += 2 * Math.PI * 0.75 * this.motorEnv * dt;   // 45 RPM idle
        }
        if (this.mode === "returning") {
          this.armR += Math.min(170 * dt, this.restR - this.armR);
          if (this.restR - this.armR < 0.8) {
            this.armR = this.restR; this.mode = "rest";
            this.vel = 0; this._info();
            if (!this.motorOn && this.motorEnv < 0.02) this._closeStream();
          }
        }
        if (this.mode === "rest" && !this.motorOn && this.motorEnv < 0.005 &&
            this.stream && !this.scratch.active) this._closeStream();
      }

      /* cabinet */
      c.clearRect(0, 0, W, H);
      c.fillStyle = "#17181c";
      c.beginPath(); c.roundRect(0, 0, W, H, 14); c.fill();
      c.strokeStyle = "rgba(255,255,255,.06)";
      c.beginPath(); c.roundRect(0.5, 0.5, W - 1, H - 1, 13.5); c.stroke();

      /* platter + strobe dots */
      const P = this.P;
      const pg = c.createRadialGradient(P.x, P.y, 10, P.x, P.y, 130);
      pg.addColorStop(0, "#2a2c31"); pg.addColorStop(1, "#101114");
      c.fillStyle = pg;
      c.beginPath(); c.arc(P.x, P.y, 128, 0, 2 * Math.PI); c.fill();
      c.fillStyle = "rgba(255,255,255,.18)";
      for (let i = 0; i < 48; i++) {
        const a = this.A + i * Math.PI / 24;
        c.fillRect(P.x + 123 * Math.cos(a) - 1, P.y + 123 * Math.sin(a) - 1, 2, 2);
      }

      /* the record */
      if (this.loaded) {
        /* the pressing PNG is square (sleeve corners and all); clip to the
           vinyl edge so only the record itself turns on the platter */
        const vinylR = this._pxVinyl || PC_F_DISC * PC_S * this.scale;
        c.save(); c.translate(P.x, P.y);
        c.beginPath(); c.arc(0, 0, vinylR + 0.5, 0, 2 * Math.PI); c.clip();
        c.rotate(this.A);
        c.drawImage(this.discCv, -this.discPx / 2, -this.discPx / 2,
                    this.discPx, this.discPx);
        c.restore();
        c.strokeStyle = "rgba(255,255,255,.10)";      // machined rim
        c.lineWidth = 1;
        c.beginPath(); c.arc(P.x, P.y, vinylR + 1, 0, 2 * Math.PI); c.stroke();
      } else {
        c.fillStyle = "rgba(255,255,255,.25)";
        c.font = "10px 'Chakra Petch', monospace"; c.textAlign = "center";
        c.fillText("NO DISC", P.x, P.y + 3);
      }
      c.fillStyle = "#0a0a0b";                       // spindle
      c.beginPath(); c.arc(P.x, P.y, 3.4, 0, 2 * Math.PI); c.fill();
      c.strokeStyle = "rgba(255,255,255,.3)"; c.stroke();

      /* tonearm rest bracket */
      const restA = this._armAngle(this.restR);
      const rx = this.PIVOT.x + (this.armLen - 6) * Math.cos(restA);
      const ry = this.PIVOT.y + (this.armLen - 6) * Math.sin(restA);
      c.strokeStyle = "rgba(255,255,255,.22)"; c.lineWidth = 3;
      c.beginPath(); c.arc(rx, ry, 9, restA + 0.5, restA + Math.PI - 0.5); c.stroke();

      /* tonearm */
      const lifted = this.mode === "lifted" || this.mode === "returning";
      const a = this._armAngle(this.armR);
      const tip = { x: this.PIVOT.x + this.armLen * Math.cos(a),
                    y: this.PIVOT.y + this.armLen * Math.sin(a) };
      if (lifted) {                                   // shadow when raised
        c.strokeStyle = "rgba(0,0,0,.45)"; c.lineWidth = 4;
        c.beginPath(); c.moveTo(this.PIVOT.x + 4, this.PIVOT.y + 5);
        c.lineTo(tip.x + 4, tip.y + 5); c.stroke();
      }
      c.strokeStyle = "rgba(255,255,255,.28)"; c.lineWidth = 7;   // counterweight
      c.beginPath();
      c.moveTo(this.PIVOT.x - 22 * Math.cos(a), this.PIVOT.y - 22 * Math.sin(a));
      c.lineTo(this.PIVOT.x - 8 * Math.cos(a), this.PIVOT.y - 8 * Math.sin(a));
      c.stroke();
      c.strokeStyle = "#c8ccd4"; c.lineWidth = 3.2;               // arm tube
      c.beginPath(); c.moveTo(this.PIVOT.x, this.PIVOT.y);
      c.lineTo(tip.x, tip.y); c.stroke();
      c.fillStyle = "#2e3138";                                    // pivot base
      c.beginPath(); c.arc(this.PIVOT.x, this.PIVOT.y, 13, 0, 2 * Math.PI); c.fill();
      c.strokeStyle = "rgba(255,255,255,.25)"; c.lineWidth = 1; c.stroke();
      c.save();                                                    // headshell
      c.translate(tip.x, tip.y); c.rotate(a);
      c.fillStyle = lifted ? "#e8b64c" : "#d9a83f";
      c.fillRect(-13, -4, 16, 8);
      c.restore();
      c.fillStyle = this.mode === "playing" ? "#ff5546" : "rgba(255,255,255,.5)";
      c.beginPath(); c.arc(tip.x, tip.y, 2.4, 0, 2 * Math.PI); c.fill();

      /* START/STOP + lamp */
      c.fillStyle = "#22242a";
      c.beginPath(); c.roundRect(14, 12, 92, 30, 6); c.fill();
      c.strokeStyle = "rgba(255,255,255,.14)"; c.stroke();
      c.fillStyle = this.motorOn ? "#57e389" : "#555a63";
      c.beginPath(); c.arc(30, 27, 4.5, 0, 2 * Math.PI); c.fill();
      c.fillStyle = "#e6e8ee"; c.font = "600 10px 'Chakra Petch', monospace";
      c.textAlign = "left"; c.fillText("START/STOP", 42, 31);
      c.fillStyle = "rgba(255,255,255,.4)"; c.font = "9px 'Chakra Petch', monospace";
      c.fillText("45 RPM", 16, 56);

      /* info panel */
      if (this.loaded) {
        const n = this.meta.n, rate = this.meta.rate;
        const cur = this.pos / rate, tot = n / rate;
        const fmt = (s) => (s / 60 | 0) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
        c.textAlign = "left";
        c.fillStyle = "rgba(255,255,255,.55)"; c.font = "9px 'Chakra Petch', monospace";
        c.fillText("NOW LOADED", 306, 118);
        c.fillStyle = "#e6e8ee"; c.font = "700 13px 'Chakra Petch', monospace";
        c.fillText(this.title.slice(0, 22), 306, 136);
        c.fillStyle = "rgba(255,255,255,.65)"; c.font = "10px 'Chakra Petch', monospace";
        c.fillText(rate + " Hz \u00b7 \u03bc-law \u00b7 " + fmt(tot), 306, 154);
        c.fillText(this.ringRead ? "header ring: read optically" :
                                   "header ring: (link metadata)", 306, 170);
        const st = { rest: "STOPPED", lifted: "CUEING", playing: "PLAYING",
                     returning: "ARM RETURNING" }[this.mode];
        c.fillStyle = this.mode === "playing" ? "#57e389" : "#f2c14e";
        c.font = "700 11px 'Chakra Petch', monospace";
        c.fillText(st + (this.scratch.active ? " \u00b7 SCRATCH" : ""), 306, 192);
        c.fillStyle = "#e6e8ee"; c.font = "700 16px 'Chakra Petch', monospace";
        c.fillText(fmt(cur), 306, 214);
        c.fillStyle = "rgba(255,255,255,.35)";
        c.fillRect(306, 224, 200, 3);
        c.fillStyle = "#f2c14e";
        c.fillRect(306, 224, 200 * Math.min(1, this.pos / Math.max(1, n - 1)), 3);
        c.fillStyle = "rgba(255,255,255,.4)"; c.font = "8.5px 'Chakra Petch', monospace";
        c.fillText("UNDER THE STYLUS \u2014 the pixels being decoded now", 306, 246);
        /* live proof of the optical pickup: the groove's G-channel around
           the current read position, straight off the disc image. While a
           postcard is still arriving you can watch silence turn to signal
           here, chunk by chunk, before the needle even reaches it. */
        {
          const base = Math.max(0, Math.min(this.meta.n - 100, (this.pos | 0) - 50));
          for (let k = 0; k < 100; k++) {
            const gv = this._briAt(base + k);
            c.fillStyle = "rgb(" + gv + "," + gv + "," + gv + ")";
            c.fillRect(306 + k * 2, 250, 2, 12);
          }
          const tick = Math.max(0, Math.min(99, (this.pos | 0) - base));
          c.fillStyle = "#ff5546";
          c.fillRect(306 + tick * 2, 248, 2, 16);
          c.strokeStyle = "rgba(255,255,255,.25)"; c.lineWidth = 1;
          c.strokeRect(305.5, 249.5, 201, 13);
        }
        c.fillStyle = "rgba(255,255,255,.55)";
        c.fillText("drag the tonearm \u00b7 drop it on the groove", 306, 282);
        c.fillText("drag the disc to scratch \u00b7 park past edge", 306, 294);
      }
    }
  }


  /* ---------------- built-in test pattern (array form) --------------- */
  function testPattern(w, h) {
    const r = new Float64Array(w * h), g = new Float64Array(w * h), b = new Float64Array(w * h);
    const bars = [[255, 255, 255], [255, 255, 0], [0, 255, 255], [0, 255, 0],
                  [255, 0, 255], [255, 0, 0], [0, 0, 255], [35, 35, 35]];
    const top = Math.round(h * 0.52);
    for (let row = 0; row < top; row++)
      for (let i = 0; i < w; i++) {
        const c = bars[Math.min(bars.length - 1, Math.floor(i * bars.length / w))];
        r[row * w + i] = c[0]; g[row * w + i] = c[1]; b[row * w + i] = c[2];
      }
    const g1 = Math.round(h * 0.70);
    for (let row = top; row < g1; row++)
      for (let i = 0; i < w; i++) {
        const v = Math.round(255 * i / (w - 1));
        r[row * w + i] = v; g[row * w + i] = v; b[row * w + i] = v;
      }
    const sq = Math.max(6, Math.floor(w / 26));
    for (let row = g1; row < h; row++)
      for (let i = 0; i < w; i++) {
        const v = (((Math.floor(row / sq) + Math.floor(i / sq)) % 2) * 165 + 45);
        r[row * w + i] = v; g[row * w + i] = v; b[row * w + i] = v;
      }
    const cx = w * 0.5, cy = (g1 + h) / 2;
    const rad = (h - g1) * 0.42, rad2 = rad / 2;
    const lw = Math.max(2, Math.floor(h / 90));
    for (let row = g1; row < h; row++)
      for (let i = 0; i < w; i++) {
        const d = Math.hypot(i - cx, row - cy);
        const idx = row * w + i;
        if (Math.abs(d - rad) < lw) { r[idx] = 255; g[idx] = 60; b[idx] = 60; }
        else if (d < rad2) {
          if (rad2 - d < lw) { r[idx] = 255; g[idx] = 210; b[idx] = 80; }
          else { r[idx] = 20; g[idx] = 20; b[idx] = 20; }
        }
      }
    return { r, g, b, w, h };
  }

  function psnr(a, b, trim) {
    trim = trim === undefined ? 4 : trim;
    const w = a.w, h = a.h;
    let mse = 0, cnt = 0;
    for (let r = trim; r < h - trim; r++)
      for (let i = trim; i < w - trim; i++) {
        const idx = r * w + i;
        for (const p of ["r", "g", "b"]) {
          const d = a[p][idx] - b[p][idx];
          mse += d * d; cnt++;
        }
      }
    mse /= cnt;
    return mse < 1e-9 ? 99.0 : 20.0 * Math.log10(255.0 / Math.sqrt(mse));
  }

  /* =====================================================================
     Spectrogram (the "on-air scope") — same look as the SSTV module
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
    id: "dsstv",

    init(ctx) {
      this.ctx = ctx;
      this.sizeIdx = 1;                    // 240×180
      this.quality = "med";
      this.passes = 1;
      this.voxHdr = false;
      this.voxThr = -42.0;
      this.source = "pattern";
      this.overlayCall = true;
      this.imageObj = null;
      this.snapCanvas = null;
      this.enc = null;                     // last encodeImageD result
      this.encRate = 48000;
      this.lastImg = null;
      this.listening = false;
      this._busy = false;
      this._ring = [];
      this._ringLen = 0;
      this._cap = null;
      this._capLen = 0;
      this._silence = 0;
      this._meterAt = 0;
      this.pcTake = null;                  // recorded take {y, sr}
      this.pcArmed = null;                 // pressed disc {codes, rate, n, durS}
      this.pcRateSel = 3200;
      this._pcRec = null;
      this._pcRecAt = 0;
      this._pcTxImg = null;
      this._pcRxImg = null;
      this._pcRxDone = false;
      this.deck = null;
      if (!this._subscribed) {
        this._subscribed = true;
        ctx.audio.onSamples((samples, sr) => this._voxFeed(samples, sr));
      }
    },

    createPanel(el) {
      const sizeOpts = SIZES.map((s, i) =>
        `<option value="${i}"${i === 1 ? " selected" : ""}>${s[0]}×${s[1]}</option>`).join("");
      const chanOpts = CHANNELS.map((c, i) => `<option value="${i}">${c[0]}</option>`).join("");
      const pcRateOpts = PC_RATES.map(r =>
        `<option value="${r.rate}"${r.rate === 3200 ? " selected" : ""}>${r.name}</option>`).join("");
      el.innerHTML = `
        <div class="mod-layout">
          <div class="mod-main">
            <div class="card">
              <header class="card-head"><h3>RX picture (digital)</h3>
                <span class="card-tag mono" id="dsstv-stage">idle</span></header>
              <div style="padding:14px;display:flex;justify-content:center;background:#05070b">
                <canvas id="dsstv-rx" width="240" height="180"
                  style="max-width:100%;border:1px solid rgba(96,114,150,0.3);background:#333;image-rendering:pixelated"></canvas>
              </div>
              <div class="card-foot mod-controls">
                <span class="mono" id="dsstv-rxinfo" style="flex:1">—</span>
                <button class="btn" id="dsstv-play-rx" style="display:none">\u25b6 Play on deck</button>
                <button class="btn" id="dsstv-saveimg" disabled>Save image</button>
              </div>
            </div>
            <div class="card" id="dsstv-deck-card" style="display:none">
              <header class="card-head"><h3>Postcard deck · live optical pickup</h3>
                <span class="card-tag mono">45 RPM</span></header>
              <div style="padding:10px;background:#05070b;display:flex;justify-content:center">
                <canvas id="dsstv-deck" width="520" height="310" style="max-width:100%"></canvas>
              </div>
              <div class="card-foot mod-controls">
                <span class="mono" id="dsstv-deck-info" style="flex:1;font-size:11px">—</span>
                <label class="field" style="flex-direction:row;align-items:center;gap:6px"
                       title="vintage hiss, pops and rumble \u2014 off = VREC-transparent: the groove bytes and nothing else">
                  <input type="checkbox" id="dsstv-pc-sfx"><span>Surface noise</span></label>
                <button class="btn btn-mini" id="dsstv-pc-sidewav" title="offline render of this exact disc through the pickup formula \u2014 ground truth for your ears">Save side WAV</button>
                <label class="btn btn-mini" for="dsstv-pc-load">Load disc PNG\u2026</label>
                <input type="file" id="dsstv-pc-load" accept="image/png,image/*" style="display:none">
                <button class="btn btn-mini" id="dsstv-eject">Eject</button>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>On-air scope</h3>
                <span class="card-tag mono" id="dsstv-airinfo">—</span></header>
              <div style="padding:10px;background:#05070b">
                <canvas id="dsstv-spec" width="740" height="150" style="width:100%;display:block"></canvas>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>TX picture</h3></header>
              <div style="padding:14px;display:flex;justify-content:center;background:#05070b">
                <canvas id="dsstv-tx" width="240" height="180"
                  style="max-width:100%;border:1px solid rgba(96,114,150,0.3);background:#000"></canvas>
              </div>
              <div class="card-foot mod-controls">
                <label class="field"><span>Source</span>
                  <select id="dsstv-source">
                    <option value="pattern">Test pattern</option>
                    <option value="image">Uploaded image</option>
                    <option value="camera">Webcam snapshot</option>
                    <option value="postcard">Audio postcard</option>
                  </select></label>
                <label class="btn" for="dsstv-file">Load image…</label>
                <input type="file" id="dsstv-file" accept="image/*" style="display:none">
                <button class="btn" id="dsstv-snap">Snap webcam</button>
                <label class="field" style="flex-direction:row;align-items:center;gap:6px">
                  <input type="checkbox" id="dsstv-call" checked><span>Callsign overlay</span></label>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>Audio postcard</h3>
                <span class="card-tag mono">VREC-mini \u00b7 \u03bc-law vinyl</span></header>
              <div class="card-body mod-controls" style="flex-wrap:wrap">
                <label class="btn" for="dsstv-pc-audio">\u2460 Load audio\u2026</label>
                <input type="file" id="dsstv-pc-audio" accept="audio/*" style="display:none">
                <button class="btn" id="dsstv-pc-rec">\u2460 Record mic (15 s)</button>
                <button class="btn" id="dsstv-pc-playtake" disabled>\u25b6 Play take</button>
                <label class="field"><span>\u2461 Fidelity</span>
                  <select id="dsstv-pc-rate">${pcRateOpts}</select></label>
                <button class="btn btn-accent" id="dsstv-pc-press" disabled>\u2462 Press disc \u2192 TX</button>
                <button class="btn" id="dsstv-pc-audition" disabled>Audition on deck</button>
                <button class="btn" id="dsstv-pc-savepng" disabled>Save disc PNG</button>
              </div>
              <div class="card-foot mod-controls">
                <span class="mono" id="dsstv-pc-status" style="flex:1;font-size:11px">record a
                  take or load a file, \u2461 pick a fidelity, \u2462 press the disc \u2014 the groove IS the audio</span>
              </div>
            </div>
          </div>
          <div class="mod-side">
            <div class="card">
              <header class="card-head"><h3>Image · link</h3></header>
              <div class="card-body mod-controls" style="flex-direction:column;align-items:stretch">
                <label class="field"><span>Size</span>
                  <select id="dsstv-size">${sizeOpts}</select></label>
                <label class="field"><span>Quality</span>
                  <select id="dsstv-quality">
                    <option value="low">Low (smallest)</option>
                    <option value="med" selected>Medium</option>
                    <option value="high">High</option>
                  </select></label>
                <label class="field"><span>Passes (repeats)</span>
                  <select id="dsstv-passes">
                    <option value="1" selected>1</option>
                    <option value="2">2</option>
                    <option value="3">3</option>
                  </select></label>
                <label class="field" style="flex-direction:row;align-items:center;gap:6px">
                  <input type="checkbox" id="dsstv-voxhdr"><span>VOX keying header (FRS)</span></label>
                <div class="mod-note mono" id="dsstv-linkinfo" style="font-size:11px">
                  4-FSK 500 Bd · 1000 bps raw · K=7 Viterbi · per-stripe CRC</div>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>Transmit</h3></header>
              <div class="card-body mod-controls" style="flex-direction:column;align-items:stretch">
                <button class="btn btn-accent" id="dsstv-encode">Encode</button>
                <button class="btn" id="dsstv-play" disabled>Transmit (play on air)</button>
                <button class="btn" id="dsstv-stop">Stop</button>
                <button class="btn" id="dsstv-savewav" disabled>Save WAV → download</button>
                <label class="field"><span>Loopback channel</span>
                  <select id="dsstv-chan">${chanOpts}</select></label>
                <div class="mod-controls">
                  <label class="field" style="flex-direction:row;align-items:center;gap:6px">
                    <input type="checkbox" id="dsstv-noise"><span>Noise, SNR</span></label>
                  <input type="number" id="dsstv-snr" value="10" min="-5" max="40" style="width:64px">
                  <span class="mono">dB</span>
                </div>
                <button class="btn" id="dsstv-loop" disabled>Loopback test</button>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>Receive</h3></header>
              <div class="card-body mod-controls" style="flex-direction:column;align-items:stretch">
                <label class="btn" for="dsstv-wavin" style="text-align:center">Decode WAV…</label>
                <input type="file" id="dsstv-wavin" accept=".wav,audio/wav,audio/x-wav" style="display:none">
                <button class="btn" id="dsstv-listen">Listen (VOX)</button>
                <div class="mod-controls">
                  <span class="mono" id="dsstv-meter" style="min-width:64px">— dB</span>
                  <label class="field" style="flex:1"><span>VOX threshold</span>
                    <input type="range" id="dsstv-vox" min="-70" max="-15" step="1" value="-42"></label>
                </div>
                <button class="btn" id="dsstv-selftest">Self-test (loopback)</button>
              </div>
            </div>
            <div class="mod-note">
              HRWS-D1 is an experimental digital image mode built for this
              studio: pictures arrive pixel-perfect stripe by stripe, each
              protected by FEC and a CRC — noise costs stripes, never
              smears them, and repeat passes fill the gaps. Both ends need
              this studio. Identify per your local regulations.
            </div>
            <div class="mod-note">
              <b>Audio postcards</b> are miniature VREC vinyl pressings:
              your voice becomes μ-law bytes written as pixel brightness
              along a spiral groove, sent byte-exact in ordinary D1 packets
              (~62 B/s — a full 15 s disc is ~7 min of air; the status line
              shows the honest estimate before you key up). The receiver's
              deck plays the disc <i>optically</i>, decoding the pixels
              under the needle in real time — and any saved PNG is a real
              VREC record the desktop VREC Studio will play.
            </div>
          </div>
        </div>`;

      const $ = id => el.querySelector("#dsstv-" + id);
      this.ui = {
        rx: $("rx"), tx: $("tx"), spec: $("spec"),
        stage: $("stage"), rxinfo: $("rxinfo"), airinfo: $("airinfo"),
        saveimg: $("saveimg"), source: $("source"), file: $("file"),
        snap: $("snap"), call: $("call"),
        size: $("size"), quality: $("quality"), passes: $("passes"),
        voxhdr: $("voxhdr"), linkinfo: $("linkinfo"),
        encode: $("encode"), play: $("play"), savewav: $("savewav"),
        chan: $("chan"), noise: $("noise"), snr: $("snr"), loop: $("loop"),
        wavin: $("wavin"), listen: $("listen"), meter: $("meter"),
        vox: $("vox"), selftest: $("selftest"),
        pcRec: $("pc-rec"), pcAudio: $("pc-audio"),
        pcPlayTake: $("pc-playtake"), pcRate: $("pc-rate"),
        pcPress: $("pc-press"), pcAudition: $("pc-audition"),
        pcSavePng: $("pc-savepng"), pcStatus: $("pc-status"),
        deckCard: $("deck-card"), deck: $("deck"),
        deckInfo: $("deck-info"), eject: $("eject"),
        pcLoad: $("pc-load"), playRx: $("play-rx"), pcSfx: $("pc-sfx"),
        pcSideWav: $("pc-sidewav")
      };

      this.ui.size.addEventListener("change", () => {
        this.sizeIdx = parseInt(this.ui.size.value, 10);
        this._sizeChanged();
      });
      this.ui.quality.addEventListener("change", () => { this.quality = this.ui.quality.value; this._invalidate(); });
      this.ui.passes.addEventListener("change", () => { this.passes = parseInt(this.ui.passes.value, 10); this._invalidate(); this._pcUpdateStatus(); });
      this.ui.voxhdr.addEventListener("change", () => { this.voxHdr = this.ui.voxhdr.checked; this._invalidate(); this._pcUpdateStatus(); });
      this.ui.vox.addEventListener("input", () => { this.voxThr = parseFloat(this.ui.vox.value); });
      this.ui.call.addEventListener("change", () => { this.overlayCall = this.ui.call.checked; this._renderSource(); });
      this.ui.source.addEventListener("change", () => { this.source = this.ui.source.value; this._renderSource(); });
      this.ui.file.addEventListener("change", e => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        const img = new Image();
        img.onload = () => {
          this.imageObj = img;
          this.source = "image";
          this.ui.source.value = "image";
          this._renderSource();
          this.ctx.log(`image loaded (${img.width}×${img.height})`);
        };
        img.src = URL.createObjectURL(f);
      });
      this.ui.snap.addEventListener("click", () => this._snapWebcam());
      this.ui.encode.addEventListener("click", () => this._encode());
      this.ui.play.addEventListener("click", () => this._play());
      el.querySelector("#dsstv-stop").addEventListener("click", () => {
        this.ctx.audio.stopTX();
        this.ctx.log("D-SSTV transmission stopped.");
      });
      this.ui.savewav.addEventListener("click", () => this._saveWav());
      this.ui.loop.addEventListener("click", () => this._loopback());
      this.ui.wavin.addEventListener("change", e => {
        const f = e.target.files && e.target.files[0];
        if (f) this._decodeWavFile(f);
        e.target.value = "";
      });
      this.ui.listen.addEventListener("click", () => this._toggleListen());
      this.ui.saveimg.addEventListener("click", () => this._saveImage());
      this.ui.selftest.addEventListener("click", () => this._selfTest());

      this.ui.pcRec.addEventListener("click", () => this._pcRecToggle());
      this.ui.pcPlayTake.addEventListener("click", () => this._pcPlayTake());
      this.ui.pcAudio.addEventListener("change", e => {
        const f = e.target.files && e.target.files[0];
        if (f) this._pcLoadAudio(f);
        e.target.value = "";
      });
      this.ui.pcRate.addEventListener("change", () => {
        this.pcRateSel = parseInt(this.ui.pcRate.value, 10);
        this.pcArmed = null;
        this.ui.pcAudition.disabled = this.ui.pcSavePng.disabled = true;
        if (this.source === "postcard") this._renderSource();
        this._pcUpdateStatus();
      });
      this.ui.pcPress.addEventListener("click", () => this._pcPress());
      this.ui.pcAudition.addEventListener("click", () => this._pcAudition());
      this.ui.pcSavePng.addEventListener("click", () => this._pcSavePng());
      this.ui.eject.addEventListener("click", () => {
        if (this.deck) this.deck.eject();          // deck stays on the bench
        this.ctx.log("deck: ejected \u2014 load a disc PNG or audition a pressing");
      });
      this.ui.pcLoad.addEventListener("change", e => {
        const f = e.target.files && e.target.files[0];
        if (f) this._pcLoadPng(f);
        e.target.value = "";
      });
      this.ui.playRx.addEventListener("click", () => this._playRx());
      this.ui.pcSideWav.addEventListener("click", () => {
        if (!this.deck || !this.deck.loaded) {
          this.ctx.log("deck: nothing on the platter to render"); return;
        }
        const y = pcRenderSide(this.deck.img, this.deck.meta);
        const buf = wavEncode16(y, DECK_RATE);
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
        a.download = "postcard_side_" + this.deck.meta.rate + "hz.wav";
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
        this.ctx.log("deck: rendered this side offline (" +
          (y.length / DECK_RATE).toFixed(1) + " s @ " + DECK_RATE + " Hz) \u2014 " +
          "this WAV is the pickup's ground truth; if the live deck sounds " +
          "different from this file, the difference is in your audio routing");
      });
      this.ui.pcSfx.addEventListener("change", () => {
        if (this.deck) this.deck.sfxOn = this.ui.pcSfx.checked;
        this.ctx.log("deck: surface noise " + (this.ui.pcSfx.checked
          ? "on \u2014 vintage theater" : "off \u2014 VREC-transparent"));
      });

      this._sizeChanged();
    },

    onDeactivate() {
      this.listening = false;
      if (this._pcRec) this._pcRec = null;
      if (this.deck) { this.deck.destroy(); this.deck = null; }
      this._pcTxImg = this._pcRxImg = null;
      this.ui = null;
    },

    _stage(t) { if (this.ui) this.ui.stage.textContent = t; },
    _size() { return SIZES[this.sizeIdx]; },
    _invalidate() {
      this.enc = null;
      if (this.ui) this.ui.play.disabled = this.ui.savewav.disabled = this.ui.loop.disabled = true;
    },

    _sizeChanged() {
      const [w, h] = this._size();
      for (const cv of [this.ui.rx, this.ui.tx]) { cv.width = w; cv.height = h; }
      const rc = this.ui.rx.getContext("2d");
      rc.fillStyle = "#333"; rc.fillRect(0, 0, w, h);
      this._invalidate();
      this._renderSource();
    },

    _renderSource() {
      if (!this.ui) return;
      if (this.source === "postcard") {
        const cv = this.ui.tx;
        if (this.pcArmed) {
          this._pcTxImg = pcRenderToCanvas(cv, this.pcArmed.codes,
                                           this._pcLabelMeta(this.pcArmed));
        } else {
          cv.width = PC_S; cv.height = PC_S;
          const c = cv.getContext("2d");
          c.fillStyle = "#05070b"; c.fillRect(0, 0, PC_S, PC_S);
          c.strokeStyle = "rgba(96,114,150,0.4)"; c.setLineDash([6, 6]);
          c.beginPath(); c.arc(PC_S / 2, PC_S / 2, PC_F_DISC * PC_S, 0, 2 * Math.PI);
          c.stroke(); c.setLineDash([]);
          c.fillStyle = "#888"; c.font = "13px monospace"; c.textAlign = "center";
          c.fillText("record a take, then Press disc", PC_S / 2, PC_S / 2 - 8);
          c.fillText("in the Audio postcard card", PC_S / 2, PC_S / 2 + 12);
        }
        this._invalidate();
        return;
      }
      const [w, h] = this._size();
      const c = this.ui.tx.getContext("2d");
      c.imageSmoothingEnabled = true;
      c.imageSmoothingQuality = "high";
      c.fillStyle = "#000";
      c.fillRect(0, 0, w, h);
      if (this.source === "pattern") {
        const p = testPattern(w, h);
        const id = c.createImageData(w, h);
        for (let i = 0; i < w * h; i++) {
          id.data[i * 4] = p.r[i]; id.data[i * 4 + 1] = p.g[i];
          id.data[i * 4 + 2] = p.b[i]; id.data[i * 4 + 3] = 255;
        }
        c.putImageData(id, 0, 0);
      } else {
        const src = this.source === "image" ? this.imageObj : this.snapCanvas;
        if (src) {
          const s = Math.min(w / src.width, h / src.height);
          const nw = Math.max(1, Math.round(src.width * s));
          const nh = Math.max(1, Math.round(src.height * s));
          c.drawImage(src, (w - nw) >> 1, (h - nh) >> 1, nw, nh);
        } else {
          c.fillStyle = "#888";
          c.font = "14px monospace";
          c.textAlign = "center";
          c.fillText(this.source === "image" ? "load an image…" : "snap the webcam…", w / 2, h / 2);
        }
      }
      if (this.overlayCall) {
        const call = (this.ctx.settings().callsign || "").trim().toUpperCase();
        if (call) {
          let size = Math.max(12, Math.round(h * 0.105));
          c.textBaseline = "top";
          c.textAlign = "left";
          let tw;
          for (;;) {
            c.font = `bold ${size}px "Chakra Petch", monospace`;
            tw = c.measureText(call).width;
            if (tw <= w - 20 || size <= 10) break;
            size -= 2;
          }
          const pad = Math.max(3, Math.floor(size / 6));
          c.fillStyle = "rgb(4,4,8)";
          c.fillRect(Math.max(0, 8 - pad), Math.max(0, 6 - pad),
                     Math.min(w, tw + 2 * pad), Math.min(h, size + 2 * pad));
          c.fillStyle = "#fff";
          c.fillText(call, 8, 6);
        }
      }
      this._invalidate();
    },

    async _snapWebcam() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: false
        });
        const video = document.createElement("video");
        video.muted = true; video.playsInline = true;
        video.srcObject = stream;
        await video.play();
        await new Promise(r => setTimeout(r, 350));
        const cv = document.createElement("canvas");
        cv.width = video.videoWidth || 640;
        cv.height = video.videoHeight || 480;
        cv.getContext("2d").drawImage(video, 0, 0);
        stream.getTracks().forEach(t => t.stop());
        this.snapCanvas = cv;
        this.source = "camera";
        this.ui.source.value = "camera";
        this._renderSource();
        this.ctx.log("webcam frame captured");
      } catch (e) {
        this.ctx.log("webcam unavailable: " + e.message);
      }
    },

    _grabTxPlanes() {
      const [w, h] = this._size();
      const d = this.ui.tx.getContext("2d").getImageData(0, 0, w, h).data;
      const n = w * h;
      const img = { r: new Float64Array(n), g: new Float64Array(n), b: new Float64Array(n), w, h };
      for (let i = 0; i < n; i++) {
        img.r[i] = d[i * 4]; img.g[i] = d[i * 4 + 1]; img.b[i] = d[i * 4 + 2];
      }
      return img;
    },

    /* ---------------- TX ---------------- */
    async _encode() {
      if (this._busy) return;
      this._busy = true;
      this.ui.encode.disabled = true;
      try {
        const fs = this.ctx.audio.ensureContext().sampleRate;
        this.encRate = Math.min(fs, 48000);   // voice-band mode: never render at studio wideband rates — the engine upsamples cleanly on playback
        this._stage("encoding…");
        await tick();
        const t0 = performance.now();
        if (this.source === "postcard") {
          if (!this.pcArmed) throw new Error("press a postcard first");
          this.enc = encodePostcardD(this.pcArmed.codes, this.pcArmed.rate,
                                     this.passes, this.encRate, this.voxHdr);
          this.ui.airinfo.textContent =
            `${(this.enc.payloadBytes / 1024).toFixed(1)} kB postcard → ` +
            `${fmtAir(this.enc.airS)} on air`;
          this.ui.linkinfo.textContent =
            `${this.enc.nStripes} chunks · ${(this.enc.payloadBytes / 1024).toFixed(1)} kB · ` +
            `${this.enc.totalSyms} symbols · ${fmtAir(this.enc.airS)}`;
          this.ctx.log(`D-SSTV encoded audio postcard: ` +
            `${this.pcArmed.durS.toFixed(1)} s @ ${this.pcArmed.rate} Hz \u03bc-law → ` +
            `${fmtAir(this.enc.airS)} on air ` +
            `(${((performance.now() - t0) / 1000).toFixed(1)} s)`);
        } else {
          const img = this._grabTxPlanes();
          this.enc = encodeImageD(img, QUALITY[this.quality], this.passes, this.encRate, this.voxHdr);
          this.ui.airinfo.textContent =
            `${(this.enc.payloadBytes / 1024).toFixed(1)} kB image → ${this.enc.airS.toFixed(0)} s on air`;
          this.ui.linkinfo.textContent =
            `${this.enc.nStripes} stripes · ${(this.enc.payloadBytes / 1024).toFixed(1)} kB · ` +
            `${this.enc.totalSyms} symbols · ${this.enc.airS.toFixed(0)} s`;
          this.ctx.log(`D-SSTV encoded ${img.w}×${img.h} q${QUALITY[this.quality]}: ` +
            `${(this.enc.payloadBytes / 1024).toFixed(1)} kB → ${this.enc.airS.toFixed(0)} s on air ` +
            `(${((performance.now() - t0) / 1000).toFixed(1)} s)`);
        }
        drawSpectrogram(this.ui.spec, this.enc.y, this.encRate);
        this._stage("ready");
        this.ui.play.disabled = this.ui.savewav.disabled = this.ui.loop.disabled = false;
      } catch (e) {
        this._stage("error");
        this.ctx.log("D-SSTV encode failed: " + e.message);
      } finally {
        this._busy = false;
        this.ui.encode.disabled = false;
      }
    },

    _play() {
      if (!this.enc) return;
      this.ctx.audio.playPCM(this.enc.y, this.encRate);
      this.ctx.log(`D-SSTV burst playing (${this.enc.airS.toFixed(0)} s)`);
    },

    _saveWav() {
      if (!this.enc) return;
      const buf = wavEncode16(this.enc.y, this.encRate);
      const [w, h] = this._size();
      const name = this.enc.layout === "postcard"
        ? `dsstv_postcard_${this.enc.postcard.rate}hz_${this.passes}pass.wav`
        : `dsstv_${w}x${h}_q${QUALITY[this.quality]}_${this.passes}pass.wav`;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
      this.ctx.log(`saved ${name} (${(buf.byteLength / 1048576).toFixed(1)} MB)`);
    },

    async _loopback() {
      if (!this.enc || this._busy) return;
      let sig = this.enc.y;
      const ch = CHANNELS[parseInt(this.ui.chan.value, 10) || 0];
      const snr = this.ui.noise.checked ? parseFloat(this.ui.snr.value) : null;
      if (ch[1] || snr !== null) {
        this._stage("channel sim…");
        await tick();
        sig = channelSimulate(sig, this.encRate, ch[1], snr, 7, ch[2]);
        drawSpectrogram(this.ui.spec, sig, this.encRate);
        this.ctx.log(`channel sim: ${ch[0]}` + (snr !== null ? `, SNR ${snr} dB` : ""));
      }
      await this._rxPipeline(sig, this.encRate, "loopback");
    },

    /* ---------------- RX ---------------- */
    _paintImage(img) {
      const c = this.ui.rx.getContext("2d");
      if (this.ui.rx.width !== img.w || this.ui.rx.height !== img.h) {
        this.ui.rx.width = img.w; this.ui.rx.height = img.h;
      }
      const id = c.createImageData(img.w, img.h);
      for (let i = 0; i < img.w * img.h; i++) {
        id.data[i * 4] = img.r[i]; id.data[i * 4 + 1] = img.g[i];
        id.data[i * 4 + 2] = img.b[i]; id.data[i * 4 + 3] = 255;
      }
      c.putImageData(id, 0, 0);
    },

    async _rxPipeline(y, fs, source) {
      if (this._busy) return;
      this._busy = true;
      this.ui.saveimg.disabled = true;
      try {
        this._stage("hunting sync…");
        this._pcRxDone = false;
        this._pcRxImg = null;
        if (this.ui.playRx) this.ui.playRx.style.display = "none";
        const res = await decodeSignalD(y, fs, {
          log: m => this.ctx.log("dsstv: " + m),
          onHeader: h => {
            this._stage(`receiving ${h.w}×${h.h}…`);
            const c = this.ui.rx.getContext("2d");
            this.ui.rx.width = h.w; this.ui.rx.height = h.h;
            c.fillStyle = "#333"; c.fillRect(0, 0, h.w, h.h);
          },
          onPostcard: p => {
            this._stage("receiving audio postcard…");
            /* blank pressing appears at once (background, ring, label,
               silent grooves); chunks fill the groove as they land */
            this._pcRxImg = pcRenderToCanvas(this.ui.rx, p.codes,
              { rate: p.rate, n: p.n, durS: p.n / p.rate, who: null });
            this._deckEnsure();
            this.ui.deckCard.style.display = "";
            this.ui.playRx.style.display = "";
            if (this.deck &&
                this.deck.load(this.ui.rx, { n: p.n, rate: p.rate }, "RX POSTCARD")) {
              this.deck.dropNeedle(0);             // decodes on its own,
              this.ctx.log("dsstv: postcard on the deck \u2014 auto-playing " +
                           "as the chunks land (the needle reads the download)");
            }
          },
          onChunk: (seq, a, b, p) => {
            if (!this._pcRxImg) return;
            pcPaintRange(this._pcRxImg, p.codes, a, b, p.n);
            this.ui.rx.getContext("2d").putImageData(this._pcRxImg, 0, 0);
            if (this.deck) this.deck.markDirty();
            this.ui.rxinfo.textContent =
              `chunks ${p.got}/${p.nChunks} · ${source}`;
          },
          onStripe: (seq, img, st) => {
            if (img) this._paintImage(img);
            this.ui.rxinfo.textContent =
              `stripes ${st.stripesOk}/${st.nStripes}` +
              (st.crcFail ? ` · ${st.crcFail} CRC fail` : "") + ` · ${source}`;
          },
          progress: p => this._stage(`decoding… ${Math.round(100 * p)} %`)
        });
        if (res.img) {
          this._paintImage(res.img);
          this.lastImg = { img: res.img };
          this.ui.saveimg.disabled = false;
        }
        const st = res.stats;
        if (res.postcard && !res.img) {
          const p = res.postcard;
          this._pcRxDone = p.got > 0;
          this.lastImg = null;
          this.ui.saveimg.disabled = !this._pcRxDone;
          this.ui.rxinfo.textContent =
            `postcard ${(p.n / p.rate).toFixed(1)} s @ ${p.rate} Hz · ` +
            `chunks ${p.got}/${p.nChunks}` +
            (st.crcFail ? ` · ${st.crcFail} CRC fail` : "") +
            ` · sync ${st.syncScore.toFixed(2)} · ${source}`;
          this._stage(p.got === p.nChunks ? "postcard complete"
                      : `postcard partial (${p.got}/${p.nChunks})`);
          this.ctx.log(`D-SSTV postcard: ${p.got}/${p.nChunks} chunks` +
            (st.crcFail ? `, ${st.crcFail} failed CRC` : "") + ` (${source})` +
            ` — it's on the deck below, drop the needle`);
          return;
        }
        this.ui.rxinfo.textContent = res.hdr
          ? `${res.hdr.w}×${res.hdr.h} q${res.hdr.quality} · stripes ${st.stripesOk}/${st.nStripes}` +
            (st.crcFail ? ` · ${st.crcFail} CRC fail` : "") +
            ` · sync ${st.syncScore.toFixed(2)} · ${source}`
          : `no HRWS-D1 signal found · ${source}`;
        this._stage(res.hdr && st.stripesOk === st.nStripes ? "complete"
                    : res.hdr ? "partial" : "no signal");
        this.ctx.log(`D-SSTV decode: ${st.stripesOk}/${st.nStripes || "?"} stripes` +
          (st.crcFail ? `, ${st.crcFail} failed CRC` : "") + ` (${source})`);
      } catch (e) {
        this._stage("error");
        this.ctx.log("D-SSTV decode failed: " + e.message);
      } finally {
        this._busy = false;
      }
    },

    async _decodeWavFile(file) {
      try {
        this._stage("reading " + file.name + "…");
        const wav = wavDecodeMono(await file.arrayBuffer());
        this.ctx.log(`loaded ${file.name} (${(wav.y.length / wav.rate).toFixed(1)} s @ ${wav.rate} Hz)`);
        drawSpectrogram(this.ui.spec, wav.y, wav.rate);
        this.ui.airinfo.textContent = `${file.name} · ${(wav.y.length / wav.rate).toFixed(1)} s @ ${wav.rate} Hz`;
        await this._rxPipeline(wav.y, wav.rate, "file");
      } catch (e) {
        this._stage("error");
        this.ctx.log("WAV read failed: " + e.message);
      }
    },

    _saveImage() {
      if (this._pcRxDone) {
        const a = document.createElement("a");
        a.href = pcCircularPng(this.ui.rx);
        a.download = "dsstv_postcard_rx.png";
        document.body.appendChild(a);
        a.click();
        setTimeout(() => a.remove(), 2000);
        this.ctx.log("saved RX postcard PNG — a circular pressing, corners transparent (they carry nothing, so they weigh nothing) \u2014 a real VREC disc; the desktop " +
                     "VREC Studio turntable will play it as-is");
        return;
      }
      if (!this.lastImg) return;
      const img = this.lastImg.img;
      const cv = document.createElement("canvas");
      cv.width = img.w; cv.height = img.h;
      const c = cv.getContext("2d");
      const id = c.createImageData(img.w, img.h);
      for (let i = 0; i < img.w * img.h; i++) {
        id.data[i * 4] = img.r[i]; id.data[i * 4 + 1] = img.g[i];
        id.data[i * 4 + 2] = img.b[i]; id.data[i * 4 + 3] = 255;
      }
      c.putImageData(id, 0, 0);
      const a = document.createElement("a");
      a.href = cv.toDataURL("image/png");
      a.download = `dsstv_rx_${img.w}x${img.h}.png`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 2000);
    },

    /* ---------------- live listening (VOX) ---------------- */
    async _toggleListen() {
      if (this.listening) {
        this.listening = false;
        this._cap = null;
        this._ring = []; this._ringLen = 0;
        this.ui.listen.textContent = "Listen (VOX)";
        this._stage("idle");
        return;
      }
      const audio = this.ctx.audio;
      if (!audio.rxActive) {
        try { await audio.startRX(); }
        catch (e) { this.ctx.log("input error: " + e.message); return; }
      }
      this.listening = true;
      this._cap = null;
      this._ring = []; this._ringLen = 0;
      this.ui.listen.textContent = "Stop listening";
      this._stage("listening… (VOX armed)");
      this.ctx.log("D-SSTV listening — VOX armed");
    },

    _voxFeed(block, sr) {
      if (this._pcRec && this.ui) { this._pcRecFeed(block, sr); return; }
      if (!this.listening || !this.ui) return;
      let s = 0;
      for (let i = 0; i < block.length; i++) s += block[i] * block[i];
      const level = 20 * Math.log10(Math.sqrt(s / block.length) + 1e-12);
      const now = performance.now();
      if (now - this._meterAt > 120) {
        this._meterAt = now;
        this.ui.meter.textContent = level.toFixed(0) + " dB";
      }
      if (this._cap === null) {
        this._ring.push(block);
        this._ringLen += block.length;
        while (this._ringLen > sr && this._ring.length > 1)
          this._ringLen -= this._ring.shift().length;
        if (level > this.voxThr && !this._busy) {
          this._cap = this._ring.slice();
          this._capLen = this._ringLen;
          this._silence = 0;
          this._stage("signal! recording…");
          this.ctx.log("VOX triggered — capturing burst");
        }
      } else {
        this._cap.push(block);
        this._capLen += block.length;
        if (level < this.voxThr - 4) this._silence += block.length / sr;
        else this._silence = 0;
        if (this._silence > 1.5 || this._capLen / sr > 480) {
          const y = new Float32Array(this._capLen);
          let p = 0;
          for (const b of this._cap) { y.set(b, p); p += b.length; }
          this._cap = null;
          this._ring = []; this._ringLen = 0;
          this.ctx.log(`captured ${(y.length / sr).toFixed(1)} s — processing`);
          drawSpectrogram(this.ui.spec, y, sr);
          this.ui.airinfo.textContent = `live burst · ${(y.length / sr).toFixed(1)} s @ ${sr} Hz`;
          this._rxPipeline(y, sr, "live").then(() => {
            if (this.listening) this._stage("listening… (VOX armed)");
          });
        }
      }
    },

    /* ---------------- self-test ---------------- */
    async _selfTest() {
      if (this._busy) return;
      const log = m => this.ctx.log("dsstv self-test: " + m);
      try {
        const fs = this.ctx.audio.ensureContext().sampleRate;
        const img = testPattern(160, 120);
        this._stage("self-test 1/2: direct…");
        await tick();
        const enc = encodeImageD(img, QUALITY.med, 1, fs, false);
        log(`160×120 med: ${(enc.payloadBytes / 1024).toFixed(1)} kB, ${enc.airS.toFixed(0)} s air`);
        this._busy = false;
        await this._rxPipeline(enc.y, fs, "self-test");
        const ok1 = this.ui.rxinfo.textContent.includes(`stripes ${enc.nStripes}/${enc.nStripes}`);
        log(`direct: ${ok1 ? "PASS" : "FAIL"} — ` +
            (this.lastImg ? `PSNR ${psnr(img, this.lastImg.img).toFixed(1)} dB (codec-limited)` : "no image"));
        this._stage("self-test 2/2: SSB 2.7 kHz, SNR 10 dB…");
        await tick();
        const rx = channelSimulate(enc.y, fs, 2700, 10, 7, "ssb");
        await this._rxPipeline(rx, fs, "self-test 2/2 · deliberate simulated noise");
        const ok2 = this.ui.rxinfo.textContent.includes(`stripes ${enc.nStripes}/${enc.nStripes}`);
        log(`SSB SNR 10: ${ok2 ? "PASS — FEC held every stripe" : "some stripes lost (expected only below ~8 dB)"}`);
        /* the stats left on screen are from the noise pass — say so, or a
           clean loop looks like it was judged "noisy" */
        this.ui.rxinfo.textContent += "  ·  direct pass was clean; these stats are the deliberate-noise pass";
        this._stage(ok1 && ok2 ? "self-test PASS (clean + noisy channel)" : "self-test: see log");
      } catch (e) {
        this.ctx.log("self-test error: " + e.message);
        this._stage("self-test error");
      } finally {
        this._busy = false;
      }
    },

    /* ---------------- audio postcard (VREC-mini) ---------------- */
    _pcLabelMeta(p) {
      const call = (this.ctx.settings().callsign || "").trim().toUpperCase();
      return { rate: p.rate, n: p.n, durS: p.durS,
               who: call ? "DE " + call : "HRWS-D1" };
    },

    _pcUpdateStatus() {
      if (!this.ui) return;
      const el = this.ui.pcStatus;
      if (this.pcArmed) {
        const p = this.pcArmed;
        const air = pcAirEstimate(p.n, this.passes, this.voxHdr);
        el.textContent =
          `pressed: ${p.durS.toFixed(1)} s @ ${p.rate} Hz \u00b7 ` +
          `${(p.n / 1024).toFixed(1)} kB \u00b7 ~${fmtAir(air)} on air \u2014 ` +
          `now Encode, then Transmit`;
        return;
      }
      if (!this.pcTake) {
        el.textContent = "record a take or load a file, \u2461 pick a fidelity, \u2462 press the disc \u2014 " +
                         "the groove IS the audio";
        return;
      }
      const durIn = this.pcTake.y.length / this.pcTake.sr;
      const cap = pcCapacity(PC_S);
      const plan = pcFitPlan(durIn, this.pcRateSel, cap);
      const n = Math.min(Math.round(durIn * plan.rate), cap);
      const air = pcAirEstimate(Math.max(n, 2), this.passes, this.voxHdr);
      el.textContent =
        `take ${durIn.toFixed(1)} s \u2192 ${plan.rate} Hz` +
        (plan.rate < this.pcRateSel ? " (auto-fit)" : "") +
        (plan.trimmed ? " \u00b7 will trim to 15 s" : "") +
        ` \u00b7 ${(n / 1024).toFixed(1)} kB \u00b7 ~${fmtAir(air)} on air`;
    },

    async _pcRecToggle() {
      if (this._pcRec) { this._pcFinishRec(); return; }
      const audio = this.ctx.audio;
      if (!audio.rxActive) {
        try { await audio.startRX(); }
        catch (e) { this.ctx.log("mic error: " + e.message); return; }
      }
      this._pcRec = { chunks: [], len: 0, sr: 48000, t0: performance.now() };
      this.ui.pcRec.textContent = "\u25a0 Stop";
      this.ui.pcStatus.textContent = "recording\u2026 speak now (15 s max)";
      this.ctx.log("postcard: recording take\u2026");
    },

    _pcRecFeed(block, sr) {
      const r = this._pcRec;
      r.sr = sr;
      r.chunks.push(new Float32Array(block));
      r.len += block.length;
      const s = r.len / sr;
      const now = performance.now();
      if (now - this._pcRecAt > 250) {
        this._pcRecAt = now;
        this.ui.pcStatus.textContent =
          `recording\u2026 ${s.toFixed(1)} s / ${PC_REC_MAX_S.toFixed(0)} s`;
      }
      if (s >= PC_REC_MAX_S) this._pcFinishRec();
    },

    _pcFinishRec() {
      const r = this._pcRec;
      this._pcRec = null;
      if (this.ui) this.ui.pcRec.textContent = "\u2460 Record mic (15 s)";
      if (!r || !r.len) { this._pcUpdateStatus(); return; }
      const y = new Float32Array(r.len);
      let p = 0;
      for (const b of r.chunks) { y.set(b, p); p += b.length; }
      /* trim silent edges (keep 80 ms of air around the voice) */
      const thr = 0.004, pad = Math.round(0.08 * r.sr);
      let a = 0, b = y.length - 1;
      while (a < y.length && Math.abs(y[a]) < thr) a++;
      while (b > a && Math.abs(y[b]) < thr) b--;
      a = Math.max(0, a - pad); b = Math.min(y.length, b + pad + 1);
      const t = (b - a) > 0.15 * r.sr ? y.subarray(a, b) : y;
      this.pcTake = { y: new Float32Array(t), sr: r.sr };
      this.pcArmed = null;
      this.ui.pcPlayTake.disabled = this.ui.pcPress.disabled = false;
      this.ui.pcAudition.disabled = this.ui.pcSavePng.disabled = true;
      this.ctx.log(`postcard: take captured, ` +
        `${(this.pcTake.y.length / r.sr).toFixed(1)} s`);
      this._pcUpdateStatus();
    },

    /* any audio file the browser can decode becomes the take — music
       files skip the microphone (and every processing stage) entirely */
    async _pcLoadAudio(f) {
      try {
        const actx = this.ctx.audio.ensureContext();
        const buf = await actx.decodeAudioData(await f.arrayBuffer());
        const N = Math.min(buf.length, buf.sampleRate * 300);
        const y = new Float32Array(N);
        for (let c = 0; c < buf.numberOfChannels; c++) {
          const d = buf.getChannelData(c);
          for (let i = 0; i < N; i++) y[i] += d[i];
        }
        if (buf.numberOfChannels > 1)
          for (let i = 0; i < N; i++) y[i] /= buf.numberOfChannels;
        this.pcTake = { y, sr: buf.sampleRate, name: f.name };
        this.pcArmed = null;
        this.ui.pcPlayTake.disabled = this.ui.pcPress.disabled = false;
        this.ui.pcStatus.textContent =
          "loaded \u201c" + f.name + "\u201d \u2014 " +
          (N / buf.sampleRate).toFixed(1) + " s @ " + buf.sampleRate +
          " Hz \u00b7 \u2461 pick a fidelity \u00b7 \u2462 press";
        this.ctx.log("postcard: " + f.name + " is the take (" +
          (N / buf.sampleRate).toFixed(1) + " s) \u2014 press it to a disc");
      } catch (e) {
        this.ctx.log("postcard: could not decode that file \u2014 " + e.message);
      }
    },

    _pcPlayTake() {
      if (!this.pcTake) return;
      this.ctx.audio.playMonitor(this.pcTake.y, this.pcTake.sr);
    },

    _pcPress() {
      if (!this.pcTake) return;
      const p = pcPress(this.pcTake.y, this.pcTake.sr, this.pcRateSel);
      if (p.n < 2) { this.ctx.log("postcard: take too short"); return; }
      this.pcArmed = p;
      this.source = "postcard";
      this.ui.source.value = "postcard";
      this._renderSource();                // paints the pressing on TX
      this.ui.pcAudition.disabled = this.ui.pcSavePng.disabled = false;
      const air = pcAirEstimate(p.n, this.passes, this.voxHdr);
      this.ctx.log(`postcard pressed: ${p.durS.toFixed(1)} s @ ${p.rate} Hz ` +
        `\u03bc-law (${(p.n / 1024).toFixed(1)} kB, ~${fmtAir(air)} on air ` +
        `at ${this.passes} pass${this.passes > 1 ? "es" : ""})` +
        (p.trimmed ? " \u2014 trimmed to fit the disc" : ""));
      this._pcUpdateStatus();
    },

    _deckEnsure() {
      if (this.deck || !this.ui) return;
      this.deck = new PostcardDeck(this.ui.deck, this.ctx.audio, st => {
        if (this.ui) this.ui.deckInfo.textContent = st.toLowerCase() +
          " \u00b7 optical pickup \u2014 the needle reads the pixels";
      });
      this.deck.sfxOn = !!(this.ui && this.ui.pcSfx && this.ui.pcSfx.checked);
    },

    _pcAudition() {
      if (!this.pcArmed) return;
      if (this.source !== "postcard") {
        this.source = "postcard";
        this.ui.source.value = "postcard";
      }
      this._renderSource();
      this._deckEnsure();
      this.ui.deckCard.style.display = "";
      const call = (this.ctx.settings().callsign || "").trim().toUpperCase();
      if (this.deck.load(this.ui.tx, { n: this.pcArmed.n, rate: this.pcArmed.rate },
                         call ? "DE " + call : "MY POSTCARD"))
        this.deck.dropNeedle(0);
      this.ui.deckCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
      this.ctx.log("postcard on the deck \u2014 auto-playing; drag the arm to " +
                   "re-cue, drag the disc to scratch, park past the edge to stop");
    },

    _playRx() {
      if (!this._pcRxImg) return;
      this._deckEnsure();
      this.ui.deckCard.style.display = "";
      if (this.deck.load(this.ui.rx, null, "RX POSTCARD")) {
        this.deck.dropNeedle(0);
        this.ui.deckCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    },

    async _pcLoadPng(f) {
      try {
        const url = URL.createObjectURL(f);
        const img = new Image();
        await new Promise((res, rej) => {
          img.onload = res; img.onerror = () => rej(new Error("not an image"));
          img.src = url;
        });
        URL.revokeObjectURL(url);
        const cv = document.createElement("canvas");
        cv.width = PC_S; cv.height = PC_S;
        const c = cv.getContext("2d");
        c.imageSmoothingEnabled = img.width !== PC_S;   // 1:1 discs stay exact
        c.drawImage(img, 0, 0, PC_S, PC_S);
        this._deckEnsure();
        this.ui.deckCard.style.display = "";
        /* ring-only load: a real pressing is self-describing */
        if (this.deck.load(cv, null, f.name.replace(/\.[^.]+$/, "").slice(0, 22)
                                          .toUpperCase() || "DISC")) {
          this.deck.dropNeedle(0);
          this.ctx.log("deck: " + f.name + " on the platter \u2014 header ring " +
                       "read optically, auto-playing");
        } else {
          this.ctx.log("deck: " + f.name + " has no readable VREC header ring " +
                       "\u2014 is it a pressing saved from here or the desktop studio?");
        }
      } catch (e) {
        this.ctx.log("deck: could not load disc \u2014 " + e.message);
      }
    },

    _pcSavePng() {
      if (!this.pcArmed) return;
      const cv = document.createElement("canvas");
      pcRenderToCanvas(cv, this.pcArmed.codes, this._pcLabelMeta(this.pcArmed));
      const a = document.createElement("a");
      a.href = pcCircularPng(cv);
      a.download = `postcard_${this.pcArmed.rate}hz_` +
                   `${this.pcArmed.durS.toFixed(0)}s.png`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 2000);
      this.ctx.log("saved postcard PNG \u2014 a circular pressing, corners transparent (they carry nothing, so they weigh nothing) \u2014 a real VREC disc; the desktop " +
                   "VREC Studio turntable will play it as-is");
    }
  };

  const HOST = (typeof HRWS !== "undefined" && HRWS)
    || (typeof window !== "undefined" ? window.HRWS : null);
  if (HOST) HOST.registerModule(def);

  /* headless test hook */
  window.__DSSTV_TEST__ = {
    TONES, BAUD, SYNCSEQ, STRIPE_H, QUALITY, SIZES,
    BitWriter, BitReader, dct8x8, idct8x8, quantTable, QLUMA, QCHROMA,
    rgbToPlanes, planesToRgb, encodeStripe, decodeStripe,
    convEncode, viterbiDecode, interleave, deinterleave,
    bytesToBits, bitsToBytes, codeSection, sectionSyms,
    buildPacketTones, packetSymCount, encodeImageD, decodeSignalD,
    channelSimulate, testPattern, psnr, crc32, crc16,
    wavEncode16, wavDecodeMono, toneEnergies, syncScoreAt,
    /* audio postcard (VREC-mini) */
    PC_S, PC_PITCH, PC_STEP, PC_CHUNK, PC_RATES, PC_MIN_RATE,
    PC_F_DISC, PC_F_HEADER, PC_F_OUTER, PC_F_INNER, PC_F_LABEL,
    pcMulawEncode, PC_ULAW, pcGeom, pcCapacity, pcXY,
    pcGrooveR, pcGrooveTh, pcPosForR,
    pcPackRing, pcParseRing, pcRingXY, pcWriteRing, pcReadRing,
    pcResample, pcFitPlan, pcPress, pcBackground, pcOccupied,
    pcPaintRange, pcReadCodes, encodePostcardD, pcAirEstimate, pcRenderSide,
    symbolsToAir
  };
})();


