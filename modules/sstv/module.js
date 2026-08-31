/* ============================================================
   Ham Radio Web Studio — SSTV module
   A JavaScript port of "Experimental SSTV Studio" (Python) by
   VA3JFL: classic SSTV encode + decode (Martin M1/M2, Scottie
   S1/S2, Robot 36/72, full VIS headers) plus the experiment —
   TIME-COMPRESSED SSTV. Encode as normal, compress the audio
   2x…8x before it goes on air, stretch it back on the far side
   and feed a normal decoder. Two methods:

     "fm"        FM turbo — demodulate to an instantaneous-
                 frequency track, resample THAT, resynthesize.
                 Pitch is inherently preserved (1200–2300 Hz),
                 so it still fits an SSB voice channel.
     "resample"  tape-style speed-up. Nearly lossless but every
                 frequency scales with the factor — wideband
                 links only (FM, direct audio, cables).

   RX: VIS detect → PLL-style sync tracking with slant + wander
   correction → per-line demod → optional jitter repair,
   VE3NEA-inspired non-local-means denoise, constrained sharpen.
   Auto-detection tries factor × method until a VIS parses.

   Both ends must speak this scheme for compressed modes; at
   1x it is plain, standards-compliant SSTV. Identify per your
   local regulations.
   ============================================================ */
"use strict";

(function () {

  /* ---------------- constants ---------------- */
  const F_BLACK = 1500.0, F_WHITE = 2300.0;
  const F_SPAN = F_WHITE - F_BLACK;
  const F_SYNC = 1200.0;
  const PAD = 0.250;
  const VIS_LEADER = 0.300, VIS_BREAK = 0.010, VIS_BIT = 0.030;

  const METHOD_RESAMPLE = "resample";
  const METHOD_FM = "fm";
  const FACTORS = [1.0, 1.25, 1.5, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0];
  const RATIONAL = {
    "1": [1, 1], "1.25": [5, 4], "1.5": [3, 2], "2": [2, 1], "3": [3, 1],
    "4": [4, 1], "5": [5, 1], "6": [6, 1], "7": [7, 1], "8": [8, 1]
  };
  function rational(f) { return RATIONAL[String(f)] || [Math.round(f), 1]; }

  /* timings from the classic N7CXI "SSTV Mode Specifications" (seconds) */
  const MODES = {
    "Martin M1":  { family: "martin",  vis: 44, w: 320, h: 256, scan: 0.146432, sync: 0.004862, porch: 0.000572, sep: 0.000572 },
    "Martin M2":  { family: "martin",  vis: 40, w: 320, h: 256, scan: 0.073216, sync: 0.004862, porch: 0.000572, sep: 0.000572 },
    "Scottie S1": { family: "scottie", vis: 60, w: 320, h: 256, scan: 0.138240, sync: 0.009, porch: 0.0015, sep: 0.0015 },
    "Scottie S2": { family: "scottie", vis: 56, w: 320, h: 256, scan: 0.088064, sync: 0.009, porch: 0.0015, sep: 0.0015 },
    "Robot 36":   { family: "robot36", vis: 8,  w: 320, h: 240, y_scan: 0.088, c_scan: 0.044, sync: 0.009, porch: 0.003, sep: 0.0045, sep_porch: 0.0015 },
    "Robot 72":   { family: "robot72", vis: 12, w: 320, h: 240, y_scan: 0.138, c_scan: 0.069, sync: 0.009, porch: 0.003, sep: 0.0045, sep_porch: 0.0015 },
    /* PD family (G4IJE): one sync per TWO image lines — sync · porch ·
       Y(even) · Cr(avg) · Cb(avg) · Y(odd). PD 120 is the ISS mode. */
    "PD 50":      { family: "pd", vis: 93, w: 320, h: 256, scan: 0.091520, sync: 0.020, porch: 0.00208 },
    "PD 90":      { family: "pd", vis: 99, w: 320, h: 256, scan: 0.170240, sync: 0.020, porch: 0.00208 },
    "PD 120":     { family: "pd", vis: 95, w: 640, h: 496, scan: 0.121600, sync: 0.020, porch: 0.00208 },
    "PD 160":     { family: "pd", vis: 98, w: 512, h: 400, scan: 0.195584, sync: 0.020, porch: 0.00208 },
    "PD 180":     { family: "pd", vis: 96, w: 640, h: 496, scan: 0.183040, sync: 0.020, porch: 0.00208 }
  };
  const VIS2MODE = {};
  for (const name in MODES) VIS2MODE[MODES[name].vis] = name;

  function linePeriod(m) {
    const f = m.family;
    if (f === "martin") return m.sync + m.porch + 3 * (m.scan + m.sep);
    if (f === "scottie") return 2 * m.sep + m.sync + m.porch + 3 * m.scan;
    if (f === "robot36") return m.sync + m.porch + m.y_scan + m.sep + m.sep_porch + m.c_scan;
    if (f === "robot72") return m.sync + m.porch + m.y_scan + 2 * (m.sep + m.sep_porch + m.c_scan);
    if (f === "pd") return m.sync + m.porch + 4 * m.scan;
    throw new Error(f);
  }
  /* PD transmits two image lines per sync — every tracker counts TX lines */
  function txLines(m) { return m.family === "pd" ? (m.h >> 1) : m.h; }
  function visDuration() { return 2 * VIS_LEADER + VIS_BREAK + 10 * VIS_BIT; }
  function nominalDuration(m) {
    let d = visDuration() + txLines(m) * linePeriod(m);
    if (m.family === "scottie") d += m.sync;          // Scottie "starting" sync
    return d;
  }
  function syncGeometry(m) {
    if (m.family === "scottie") return [2 * (m.sep + m.scan), m.sync];
    return [0.0, m.sync];
  }

  /* ---------------- small utilities ---------------- */
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function tick() { return new Promise(r => setTimeout(r, 0)); }

  function peakNorm(y, level) {
    let m = 0;
    for (let i = 0; i < y.length; i++) { const a = Math.abs(y[i]); if (a > m) m = a; }
    if (m < 1e-9) return y;
    const g = (level || 0.9) / m;
    const out = new Float32Array(y.length);
    for (let i = 0; i < y.length; i++) out[i] = y[i] * g;
    return out;
  }

  /* moving average, 'nearest' edge handling (ndi.uniform_filter1d) */
  function movingAvg(x, size) {
    const n = x.length, out = new Float32Array(n);
    if (size <= 1) { out.set(x); return out; }
    const half = size >> 1, hi = size - 1 - half;   // matches scipy origin
    const cs = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + x[i];
    const last = x[n - 1], first = x[0];
    for (let i = 0; i < n; i++) {
      let a = i - half, b = i + hi + 1;             // [a, b)
      let s = 0;
      if (a < 0) { s += first * (-a); a = 0; }
      if (b > n) { s += last * (b - n); b = n; }
      s += cs[b] - cs[a];
      out[i] = s / size;
    }
    return out;
  }

  function medianFilter1d(x, size) {
    if (!size || size < 3) return Float32Array.from(x);
    const n = x.length, out = new Float32Array(n);
    const half = size >> 1;
    const win = new Float32Array(size);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < size; k++) {
        let j = i - half + k;
        if (j < 0) j = 0; else if (j >= n) j = n - 1;   // 'nearest'
        win[k] = x[j];
      }
      win.sort();
      out[i] = win[half];
    }
    return out;
  }

  function gaussianFilter1d(x, sigma) {
    const n = x.length;
    const r = Math.max(1, Math.round(4 * sigma));
    const k = new Float64Array(2 * r + 1);
    let s = 0;
    for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-0.5 * (i / sigma) * (i / sigma)); s += k[i + r]; }
    for (let i = 0; i < k.length; i++) k[i] /= s;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let j = -r; j <= r; j++) {
        let q = i + j;
        if (q < 0) q = 0; else if (q >= n) q = n - 1;
        acc += k[j + r] * x[q];
      }
      out[i] = acc;
    }
    return out;
  }

  /* in-place iterative radix-2 complex FFT (re/im Float64Array) */
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

  /* chunked analytic signal with a zero-phase band limit applied in the
     frequency domain (replaces the reference's Butterworth sosfiltfilt +
     Hilbert — same zero-phase role, soft raised-cosine edges).
     emit(i0, i1, re, im, off) receives valid interior samples. */
  function analyticBand(y, fs, lo, hi, emit) {
    const n = y.length;
    const N = 131072, OV = 8192;
    const step = N - 2 * OV;
    const re = new Float64Array(N), im = new Float64Array(N);
    const gain = new Float64Array(N);
    const tw = 60.0;                                  // transition width, Hz
    const hiC = Math.min(hi, 0.47 * fs);
    for (let k = 0; k < N; k++) {
      const f = k * fs / N;
      if (k === 0 || k > N / 2) { gain[k] = 0; continue; }   // negative side off
      let g = 2.0;                                    // analytic ×2
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

  /* |analytic| envelope of the raw signal */
  function analyticAbs(y, fs) {
    const out = new Float32Array(y.length);
    analyticBand(y, fs, 0, 0.47 * fs, (a, b, re, im, off) => {
      for (let i = a; i < b; i++) {
        const k = off + (i - a);
        out[i] = Math.hypot(re[k], im[k]);
      }
    });
    return out;
  }

  /* =====================================================================
     FreqTrack — instantaneous-frequency track + fast window means.
     Per-sample conjugate-product phase differences (never a long absolute
     phase), clipped 200–3600 Hz, median-filtered; prefix cumsum in f64.
     ===================================================================== */
  class FreqTrack {
    constructor(y, fs, opts) {
      const o = opts || {};
      const lo = o.lo !== undefined ? o.lo : 900.0;
      const hi = o.hi !== undefined ? o.hi : 2900.0;
      const med = o.median !== undefined ? o.median : 5;
      const n = y.length;
      const f = new Float32Array(n);
      let pr = 0, pi = 0, have = false;
      const k2f = fs / (2 * Math.PI);
      analyticBand(y, fs, lo, hi, (a, b, re, im, off) => {
        for (let i = a; i < b; i++) {
          const k = off + (i - a);
          const cr = re[k], ci = im[k];
          if (have) {
            let v = Math.atan2(ci * pr - cr * pi, cr * pr + ci * pi) * k2f;
            if (v < 200) v = 200; else if (v > 3600) v = 3600;
            f[i - 1] = v;
          }
          pr = cr; pi = ci; have = true;
        }
      });
      if (n > 1) f[n - 1] = f[n - 2];
      this.f = (med && med >= 3) ? medianFilter1d(f, med) : f;
      this.fs = fs;
      this.n = n;
      const cs = new Float64Array(n + 1);
      for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + this.f[i];
      this.cs = cs;
    }

    mean(a, b) {
      let ai = Math.round(a), bi = Math.round(b);
      ai = clamp(ai, 0, this.n);
      bi = clamp(bi, ai + 1, this.n);
      if (bi <= ai) return 0;
      return (this.cs[bi] - this.cs[ai]) / (bi - ai);
    }

    /* mean frequency in each of w pixel windows; guard trims each side */
    scan(start, durSamples, w, guard) {
      const g = guard === undefined ? 0.18 : guard;
      const out = new Float64Array(w);
      for (let p = 0; p < w; p++) {
        let a = Math.round(start + durSamples * (p + g) / w);
        let b = Math.round(start + durSamples * (p + 1 - g) / w);
        a = clamp(a, 0, this.n);
        b = clamp(b, a + 1, this.n);
        a = Math.min(a, b - 1);
        out[p] = (this.cs[b] - this.cs[a]) / Math.max(b - a, 1);
      }
      return out;
    }

    coarse(stepS) {
      const step = Math.max(1, Math.round((stepS || 0.001) * this.fs));
      const m = Math.floor(this.n / step);
      const out = new Float64Array(m);
      for (let i = 0; i < m; i++) out[i] = (this.cs[(i + 1) * step] - this.cs[i * step]) / step;
      return { F: out, step };
    }
  }

  function freqToVal(f) { return clamp((f - F_BLACK) * (255.0 / F_SPAN), 0, 255); }

  /* ---------------- colour math (BT.601 studio swing) ---------------- */
  function rgbToYCrCb(r, g, b) {
    const Y = 16.0 + (65.738 * r + 129.057 * g + 25.064 * b) / 256.0;
    const Cr = 128.0 + (112.439 * r - 94.154 * g - 18.285 * b) / 256.0;
    const Cb = 128.0 + (-37.945 * r - 74.494 * g + 112.439 * b) / 256.0;
    return [Y, Cr, Cb];
  }
  function ycrcbToRgbPx(Y, Cr, Cb) {
    const y = 1.16438 * (Y - 16.0);
    return [
      clamp(y + 1.59603 * (Cr - 128.0), 0, 255),
      clamp(y - 0.81297 * (Cr - 128.0) - 0.39176 * (Cb - 128.0), 0, 255),
      clamp(y + 2.01723 * (Cb - 128.0), 0, 255)
    ];
  }

  /* ---------------- rational polyphase resampler --------------------- */
  function resamplePoly(x, up, down) {
    if (up === down) return Float32Array.from(x);
    const M = Math.max(up, down);
    const K = 12;                                     // half-taps per phase
    const L = 2 * K * M + 1, mid = K * M;
    const h = new Float64Array(L);
    let hs = 0;
    for (let k = 0; k < L; k++) {
      const t = (k - mid) / M;
      const s = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * k / (L - 1));
      h[k] = s * w; hs += h[k];
    }
    const g = up / hs;
    for (let k = 0; k < L; k++) h[k] *= g;
    const n = x.length;
    const outN = Math.ceil(n * up / down);
    const out = new Float32Array(outN);
    for (let j = 0; j < outN; j++) {
      const center = j * down + mid;                  // index at the up-rate
      let acc = 0;
      // taps where (center - k) is a multiple of `up`
      let k0 = center % up;
      for (let k = k0; k < L; k += up) {
        const xi = (center - k) / up;
        if (xi >= 0 && xi < n) acc += h[k] * x[xi];
      }
      out[j] = acc;
    }
    return out;
  }

  /* first-order IIR y[n] = (b0 x[n] + b1 x[n-1] - a1 y[n-1]) / a0 */
  function lfilter1(b0, b1, a0, a1, x) {
    const out = new Float32Array(x.length);
    let px = 0, py = 0;
    for (let i = 0; i < x.length; i++) {
      const v = (b0 * x[i] + b1 * px - a1 * py) / a0;
      out[i] = v; px = x[i]; py = v;
    }
    return out;
  }

  /* zero-phase FFT bandpass of a whole signal (channel sim / cleanup) */
  function fftBandpass(y, fs, lo, hi) {
    const out = new Float32Array(y.length);
    analyticBand(y, fs, lo, hi, (a, b, re, im, off) => {
      for (let i = a; i < b; i++) out[i] = re[off + (i - a)];   // real part = filtered (×2 halved below)
    });
    for (let i = 0; i < out.length; i++) out[i] *= 0.5;         // undo analytic ×2
    return out;
  }

  /* ---------------- WAV read / write (16-bit out; many in) ----------- */
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
     Encoder — VIS + per-family scan segments → frequency staircase →
     phase-continuous sine. Image input is three planes {r,g,b,w,h}.
     ===================================================================== */
  function visSegments(code) {
    const segs = [["t", 1900.0, VIS_LEADER], ["t", F_SYNC, VIS_BREAK],
                  ["t", 1900.0, VIS_LEADER], ["t", F_SYNC, VIS_BIT]];
    const bits = [];
    for (let i = 0; i < 7; i++) bits.push((code >> i) & 1);
    bits.push(bits.reduce((a, b) => a + b, 0) % 2);     // even parity
    for (const b of bits) segs.push(["t", b ? 1100.0 : 1300.0, VIS_BIT]);
    segs.push(["t", F_SYNC, VIS_BIT]);
    return segs;
  }

  function synthesize(segs, fs) {
    let cursor = 0.0;
    let total = 0;
    const lens = [];
    for (const s of segs) {
      const n0 = Math.round(cursor * fs);
      cursor += s[2];
      const n = Math.round(cursor * fs) - n0;
      lens.push(n);
      total += Math.max(0, n);
    }
    const freq = new Float64Array(total);
    let p = 0;
    for (let si = 0; si < segs.length; si++) {
      const n = lens[si];
      if (n <= 0) continue;
      const kind = segs[si][0], val = segs[si][1];
      if (kind === "t") {
        freq.fill(val, p, p + n);
      } else {                                          // pixel staircase
        const w = val.length;
        for (let i = 0; i < n; i++) {
          let idx = Math.floor(i * w / n);
          if (idx >= w) idx = w - 1;
          freq[p + i] = F_BLACK + val[idx] * (F_SPAN / 255.0);
        }
      }
      p += n;
    }
    const padN = Math.round(PAD * fs);
    const y = new Float32Array(padN + total + padN);
    let ph = 0;
    const k = 2 * Math.PI / fs;
    for (let i = 0; i < total; i++) {
      ph += k * freq[i];
      y[padN + i] = Math.sin(ph) * 0.85;
    }
    const nf = Math.round(0.005 * fs);
    for (let i = 0; i < nf; i++) {
      const r = Math.sin(0.5 * Math.PI * i / nf) ** 2;
      y[padN + i] *= r;
      y[padN + total - 1 - i] *= r;
    }
    return y;
  }

  function encodeImage(img, modeName, fs, progress) {
    const mode = MODES[modeName];
    const w = mode.w, h = mode.h, fam = mode.family;
    if (img.w !== w || img.h !== h) throw new Error(`image must be ${w}×${h}`);
    const segs = visSegments(mode.vis);
    const row = (plane, l) => plane.subarray(l * w, (l + 1) * w);

    if (fam === "martin" || fam === "scottie") {
      if (fam === "scottie") segs.push(["t", F_SYNC, mode.sync]);   // starting sync
      for (let l = 0; l < h; l++) {
        const G = row(img.g, l), B = row(img.b, l), R = row(img.r, l);
        if (fam === "martin") {
          segs.push(["t", F_SYNC, mode.sync], ["t", 1500.0, mode.porch],
                    ["s", G, mode.scan], ["t", 1500.0, mode.sep],
                    ["s", B, mode.scan], ["t", 1500.0, mode.sep],
                    ["s", R, mode.scan], ["t", 1500.0, mode.sep]);
        } else {
          segs.push(["t", 1500.0, mode.sep], ["s", G, mode.scan],
                    ["t", 1500.0, mode.sep], ["s", B, mode.scan],
                    ["t", F_SYNC, mode.sync], ["t", 1500.0, mode.porch],
                    ["s", R, mode.scan]);
        }
        if (progress) progress(l + 1, h);
      }
    } else {                                            // Robot 36 / 72
      const Y = new Float64Array(w * h), Cr = new Float64Array(w * h), Cb = new Float64Array(w * h);
      for (let i = 0; i < w * h; i++) {
        const t = rgbToYCrCb(img.r[i], img.g[i], img.b[i]);
        Y[i] = t[0]; Cr[i] = t[1]; Cb[i] = t[2];
      }
      const yrow = l => Y.subarray(l * w, (l + 1) * w);
      if (fam === "pd") {
        for (let l = 0; l < h; l += 2) {
          const cr = new Float64Array(w), cb = new Float64Array(w);
          for (let i = 0; i < w; i++) {
            cr[i] = 0.5 * (Cr[l * w + i] + Cr[(l + 1) * w + i]);
            cb[i] = 0.5 * (Cb[l * w + i] + Cb[(l + 1) * w + i]);
          }
          segs.push(["t", F_SYNC, mode.sync], ["t", 1500.0, mode.porch],
                    ["s", yrow(l), mode.scan], ["s", cr, mode.scan],
                    ["s", cb, mode.scan], ["s", yrow(l + 1), mode.scan]);
          if (progress) progress(l + 2, h);
        }
      } else if (fam === "robot36") {
        for (let l = 0; l < h; l++) {
          const pair = l - (l % 2);
          const other = Math.min(pair + 1, h - 1);
          const cvals = new Float64Array(w);
          const src = l % 2 === 0 ? Cr : Cb;
          for (let i = 0; i < w; i++)
            cvals[i] = 0.5 * (src[pair * w + i] + src[other * w + i]);
          const sepF = l % 2 === 0 ? 1500.0 : 2300.0;
          segs.push(["t", F_SYNC, mode.sync], ["t", 1500.0, mode.porch],
                    ["s", yrow(l), mode.y_scan], ["t", sepF, mode.sep],
                    ["t", 1900.0, mode.sep_porch], ["s", cvals, mode.c_scan]);
          if (progress) progress(l + 1, h);
        }
      } else {
        for (let l = 0; l < h; l++) {
          segs.push(["t", F_SYNC, mode.sync], ["t", 1500.0, mode.porch],
                    ["s", yrow(l), mode.y_scan],
                    ["t", 1500.0, mode.sep], ["t", 1900.0, mode.sep_porch],
                    ["s", Cr.subarray(l * w, (l + 1) * w), mode.c_scan],
                    ["t", 2300.0, mode.sep], ["t", 1900.0, mode.sep_porch],
                    ["s", Cb.subarray(l * w, (l + 1) * w), mode.c_scan]);
          if (progress) progress(l + 1, h);
        }
      }
    }
    return synthesize(segs, fs);
  }

  function voxPreamble(fs, dur) {
    const n = Math.round((dur || 0.7) * fs);
    const y = new Float32Array(n);
    const k = 2 * Math.PI * 1900.0 / fs;
    for (let i = 0; i < n; i++) y[i] = 0.85 * Math.sin(k * i);
    const nf = Math.max(8, Math.round(0.01 * fs));
    for (let i = 0; i < nf; i++) y[i] *= Math.sin(0.5 * Math.PI * i / nf) ** 2;
    return y;
  }

  /* =====================================================================
     Time compression / restore
     ===================================================================== */
  function burstSpectrumProbe(y, fs) {
    /* one FFT, two answers: (upper spectral edge, low band noisy?) */
    const nWant = Math.min(y.length, Math.round(2.0 * fs));
    const mid = y.length >> 1;
    const a0 = Math.max(0, mid - (nWant >> 1));
    const seg = y.subarray(a0, Math.min(y.length, a0 + nWant));
    if (seg.length < 4096) return [0.45 * fs, true];
    const N = 1 << Math.ceil(Math.log2(seg.length));
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < seg.length; i++)
      re[i] = seg[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / seg.length));
    fft(re, im, false);
    const half = N >> 1;
    const P = new Float64Array(half + 1);
    for (let k = 0; k <= half; k++) P[k] = re[k] * re[k] + im[k] * im[k];
    const hz = k => k * fs / N;
    const median = (lo, hi) => {
      const v = [];
      for (let k = 0; k <= half; k++) { const f = hz(k); if (f > lo && f < hi) v.push(P[k]); }
      if (!v.length) return 0;
      v.sort((x, z) => x - z);
      return v[v.length >> 1];
    };
    const ref = median(1200, 2400) + 1e-18;
    let edge = 2600.0;
    for (let k = half; k >= 0; k--) {
      if (hz(k) > 2000 && P[k] > ref / 300.0) { edge = hz(k); break; }
    }
    const low = median(350, 800) + 1e-18;
    return [edge, low > ref / 100.0];
  }

  function fmTimescale(y, fs, up, down) {
    /* resample the instantaneous-FREQUENCY envelope: exactly linear time
       base, pitch untouched — only the modulation rate changes. */
    const n = y.length;
    let env = analyticAbs(y, fs);
    env = movingAvg(env, Math.max(1, Math.round(0.010 * fs)));
    let mx = 0;
    for (let i = 0; i < n; i++) if (env[i] > mx) mx = env[i];
    const thr = 0.12 * (mx + 1e-12);
    let first = -1, last = -1;
    for (let i = 0; i < n; i++) if (env[i] > thr) { first = i; break; }
    for (let i = n - 1; i >= 0; i--) if (env[i] > thr) { last = i; break; }
    let on = 0;
    for (let i = 0; i < n; i++) if (env[i] > thr) on++;
    if (first < 0 || on < Math.round(0.05 * fs))
      return resamplePoly(y, up, down);
    const a = Math.max(0, Math.round(first - 0.02 * fs));
    const b = Math.min(n, Math.round(last + 0.02 * fs));
    const burstIn = y.subarray(a, b);

    const kIn = Math.max(1.0, up / down);
    const probe = burstSpectrumProbe(burstIn, fs);
    const edge = probe[0], lowNoisy = probe[1];
    const hi = Math.min(1900.0 + 3600.0 * kIn, edge + 300.0, 0.45 * fs);
    const lo = lowNoisy ? 900.0 : 200.0;
    const med = (up > down && up >= 5 * down) ? 1 : 3;
    const ft = new FreqTrack(burstIn, fs, { median: med, lo, hi: Math.max(hi, 3000.0) });
    const f2 = resamplePoly(ft.f, up, down);
    const m = f2.length;
    const burst = new Float32Array(m);
    let ph = 0;
    const k = 2 * Math.PI / fs;
    for (let i = 0; i < m; i++) {
      let fv = f2[i];
      if (fv < 400) fv = 400; else if (fv > 3500) fv = 3500;
      ph += k * fv;
      burst[i] = Math.sin(ph) * 0.85;
    }
    const nf = Math.max(8, Math.round(0.005 * fs));
    for (let i = 0; i < nf && i < m; i++) {
      const r = Math.sin(0.5 * Math.PI * i / nf) ** 2;
      burst[i] *= r;
      burst[m - 1 - i] *= r;
    }
    const pad0 = Math.round(a * up / down);
    const pad1 = Math.round((n - b) * up / down);
    const out = new Float32Array(pad0 + m + pad1);
    out.set(burst, pad0);
    return out;
  }

  function compressAudio(y, fs, factor, method) {
    if (factor <= 1.0 + 1e-9) return Float32Array.from(y);
    const nd = rational(factor);
    if (method === METHOD_RESAMPLE) return resamplePoly(y, nd[1], nd[0]);
    return fmTimescale(y, fs, nd[1], nd[0]);
  }
  function restoreAudio(y, fs, factor, method) {
    if (factor <= 1.0 + 1e-9) return Float32Array.from(y);
    const nd = rational(factor);
    if (method === METHOD_RESAMPLE) return resamplePoly(y, nd[0], nd[1]);
    return fmTimescale(y, fs, nd[0], nd[1]);
  }

  /* channel model for loopback tests: SSB bandpass + in-band noise, or a
     narrowband-FM voice path (pre/de-emphasis with its tilted hiss). */
  function channelSimulate(y, fs, bwHz, snrDb, seed, kind) {
    let rndState = (seed === undefined || seed === null) ? 12345 : (seed | 0) || 1;
    const rnd = () => {          // gaussian via Box-Muller on an LCG
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
      let out = lfilter1(1.0, -aC, 1.0 - aC, 0.0, y);          // pre-emphasis
      out = fftBandpass(out, fs, 300.0, Math.min(bwHz || 3000.0, 3000.0));
      if (snrDb !== null && snrDb !== undefined) {
        const p = rms(out) * Math.pow(10, -snrDb / 20);
        const nz = new Float32Array(out.length);
        for (let i = 0; i < nz.length; i++) nz[i] = rnd() * p;
        const nzf = fftBandpass(nz, fs, 300.0, Math.min(bwHz || 3000.0, 3000.0));
        for (let i = 0; i < out.length; i++) out[i] += nzf[i];
      }
      out = lfilter1(1.0 - aC, 0.0, 1.0, -aC, out);            // de-emphasis
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

  /* =====================================================================
     Decoder
     ===================================================================== */
  function findVis(ft) {
    const c = ft.coarse(0.001);
    const F = c.F, step = c.step;
    if (F.length < 400) return [null, null];
    const n = F.length;
    const m12 = new Uint8Array(n), m19 = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      m12[i] = Math.abs(F[i] - 1200.0) <= 90.0 ? 1 : 0;
      m19[i] = Math.abs(F[i] - 1900.0) <= 140.0 ? 1 : 0;
    }
    let fbCode = null, fbEnd = null;
    const meanU8 = (arr, a, b) => {
      let s = 0;
      for (let i = a; i < b; i++) s += arr[i];
      return s / (b - a);
    };
    const meanF = (a, b) => {
      let s = 0;
      for (let i = a; i < b; i++) s += F[i];
      return s / (b - a);
    };
    for (let i = 1; i < n; i++) {
      if (!(m12[i] && !m12[i - 1])) continue;         // rising edge of 1200
      if (i < 180 || i + 305 > n) continue;
      if (meanU8(m12, i, i + 26) < 0.72) continue;
      if (meanU8(m19, i - 175, i - 15) < 0.55) continue;
      const bits = [];
      let ok = true;
      for (let k = 1; k <= 8; k++) {
        const cIdx = i + 30 * k + 15;
        const fm = meanF(cIdx - 8, cIdx + 8);
        if (Math.abs(fm - 1100.0) <= 90.0) bits.push(1);
        else if (Math.abs(fm - 1300.0) <= 90.0) bits.push(0);
        else { ok = false; break; }
      }
      if (!ok) continue;
      const cIdx = i + 30 * 9 + 15;
      if (Math.abs(meanF(cIdx - 8, cIdx + 8) - 1200.0) > 90.0) continue;
      if (bits.reduce((a, b) => a + b, 0) % 2 !== 0) continue;
      let code = 0;
      for (let k = 0; k < 7; k++) code |= bits[k] << k;
      const end = (i + 300) * step;
      if (code in VIS2MODE) return [code, end];
      if (fbCode === null) { fbCode = code; fbEnd = end; }
    }
    return [fbCode, fbEnd];
  }

  function syncScore(ft, syncDur) {
    const n = ft.n;
    const sc = new Float32Array(n);
    for (let i = 0; i < n; i++) sc[i] = clamp((1520.0 - ft.f[i]) / 300.0, 0, 1);
    return movingAvg(sc, Math.max(3, Math.round(syncDur * ft.fs)));
  }

  function findFirstSync(ft, mode) {
    const sg = syncGeometry(mode);
    const sc = syncScore(ft, sg[1]);
    const limit = Math.min(ft.n, Math.round(10.0 * ft.fs));
    let i0 = -1;
    for (let i = 0; i < limit; i++) if (sc[i] > 0.65) { i0 = i; break; }
    if (i0 < 0) return 0.0;
    const span = Math.round(2 * sg[1] * ft.fs) + 1;
    let j = i0, best = sc[i0];
    for (let i = i0; i < Math.min(ft.n, i0 + span); i++)
      if (sc[i] > best) { best = sc[i]; j = i; }
    return j - (sg[0] + sg[1] / 2.0) * ft.fs;
  }

  function peakFrac(sc, i) {
    if (i <= 0 || i >= sc.length - 1) return 0.0;
    const y0 = sc[i - 1], y1 = sc[i], y2 = sc[i + 1];
    const den = y0 - 2 * y1 + y2;
    if (Math.abs(den) < 1e-12) return 0.0;
    return clamp((y0 - y2) / (2 * den), -0.5, 0.5);
  }

  function syncTrack(ft, mode, s0) {
    const Lnom = linePeriod(mode) * ft.fs;
    const N = txLines(mode);
    const sg = syncGeometry(mode);
    const center = (sg[0] + sg[1] / 2.0) * ft.fs;
    const sc = syncScore(ft, sg[1]);

    /* initial lock on line 1 (line 0's sync can merge with the VIS stop) */
    let e1 = s0 + Lnom + center;
    const w0 = Math.round(0.025 * ft.fs);
    {
      const a = Math.max(0, Math.round(e1 - w0));
      const b = Math.min(ft.n, Math.round(e1 + w0));
      if (b - a > 8) {
        let j = a, best = sc[a];
        for (let i = a; i < b; i++) if (sc[i] > best) { best = sc[i]; j = i; }
        if (sc[j] > 0.35) e1 = j + peakFrac(sc, j);
      }
    }

    const win = Math.round(clamp(linePeriod(mode) * 0.03, 0.005, 0.012) * ft.fs);
    let Lest = Lnom;
    const Llo = Lnom * 0.97, Lhi = Lnom * 1.03;
    const eClip = 0.0008 * ft.fs;
    const pos = new Float64Array(N);
    const conf = new Float64Array(N);
    let est = e1;
    for (let l = 1; l < N; l++) {
      const a = Math.max(0, Math.round(est - win));
      const b = Math.min(ft.n, Math.round(est + win));
      if (b - a < 4) { pos[l] = est; est += Lest; continue; }
      let j = a, best = sc[a];
      for (let i = a; i < b; i++) if (sc[i] > best) { best = sc[i]; j = i; }
      conf[l] = sc[j];
      if (sc[j] > 0.30) {
        const found = j + peakFrac(sc, j);
        const err = found - est;
        Lest = clamp(Lest + 0.08 * clamp(err, -eClip, eClip), Llo, Lhi);
        pos[l] = found;
        est = found + Lest;
      } else {
        pos[l] = est;
        est += Lest;
      }
    }

    /* head-of-image line length for line 0 */
    let Lhead = Lest;
    if (N >= 4) {
      const d = [];
      for (let l = 2; l < Math.min(N, 10); l++) d.push(pos[l] - pos[l - 1]);
      d.sort((x, z) => x - z);
      Lhead = d[d.length >> 1];
    }
    if (!(Lhead >= Llo && Lhead <= Lhi)) Lhead = Lnom;
    pos[0] = pos[1] - Lhead;
    conf[0] = 0.0;

    /* robust slant (least squares over confident lines) */
    let A = pos[0], B = Lnom;
    let cnt = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let l = 0; l < N; l++) {
      if (conf[l] > 0.45) {
        cnt++; sx += l; sy += pos[l]; sxx += l * l; sxy += l * pos[l];
      }
    }
    if (cnt >= Math.max(8, 0.15 * N)) {
      const den = cnt * sxx - sx * sx;
      if (Math.abs(den) > 1e-9) {
        B = (cnt * sxy - sx * sy) / den;
        A = (sy - B * sx) / cnt;
      }
    }
    if (Math.abs(B - Lnom) / Lnom > 0.05) B = Lnom;

    /* smooth the residual wander (bad lines bridged first) */
    let resid = new Float64Array(N);
    for (let l = 0; l < N; l++) resid[l] = pos[l] - (A + B * l);
    const goodIdx = [];
    for (let l = 0; l < N; l++) if (conf[l] >= 0.30) goodIdx.push(l);
    if (goodIdx.length >= 4 && goodIdx.length < N) {
      for (let l = 0; l < N; l++) {
        if (conf[l] >= 0.30) continue;
        /* linear interp from good neighbours */
        let lo = -1, hi = -1;
        for (const gI of goodIdx) { if (gI < l) lo = gI; else { hi = gI; break; } }
        if (lo < 0) resid[l] = resid[hi];
        else if (hi < 0) resid[l] = resid[lo];
        else resid[l] = resid[lo] + (resid[hi] - resid[lo]) * (l - lo) / (hi - lo);
      }
    }
    resid = Float64Array.from(medianFilter1d(Float32Array.from(resid), 5));
    resid = gaussianFilter1d(resid, 2.2);
    const starts = new Float64Array(N);
    for (let l = 0; l < N; l++) starts[l] = A + B * l + resid[l] - center;
    let q = 0;
    for (let l = 0; l < N; l++) if (conf[l] > 0.5) q++;
    return { starts, L: B, quality: q / N, slantPpm: (B / Lnom - 1.0) * 1e6 };
  }

  /* =====================================================================
     Image-domain cleanup: jitter repair, denoise, sharpen
     Images are {r,g,b: Float64Array(w*h) 0..255, w, h}.
     ===================================================================== */
  function rowShiftEst(a, b, w, k) {
    /* sub-pixel shift of row b vs row a; gradient xcorr, |cc| envelope */
    const n = w - 1;
    const ga = new Float64Array(n), gb = new Float64Array(n);
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ga[i] = a[i + 1] - a[i]; gb[i] = b[i + 1] - b[i]; ma += ga[i]; mb += gb[i]; }
    ma /= n; mb /= n;
    let ea = 0, eb = 0;
    for (let i = 0; i < n; i++) { ga[i] -= ma; gb[i] -= mb; ea += ga[i] * ga[i]; eb += gb[i] * gb[i]; }
    const e = Math.sqrt(ea * eb);
    if (e < 1e-6) return [0, 0];
    const cc = new Float64Array(2 * k + 1);
    for (let s = -k; s <= k; s++) {
      let acc = 0;
      for (let i = 0; i < n; i++) {
        const j = i + s;                              // gb padded by k both sides
        if (j >= 0 && j < n) acc += gb[j] * ga[i];
      }
      cc[s + k] = acc;
    }
    let i = 0, best = Math.abs(cc[0]);
    for (let s = 1; s < cc.length; s++) if (Math.abs(cc[s]) > best) { best = Math.abs(cc[s]); i = s; }
    if (i <= 0 || i >= cc.length - 1) return [0, 0];
    const sgn = cc[i] >= 0 ? 1 : -1;
    const y0 = sgn * cc[i - 1], y1 = sgn * cc[i], y2 = sgn * cc[i + 1];
    const den = y0 - 2 * y1 + y2;
    const d = Math.abs(den) < 1e-9 ? 0 : (y0 - y2) / (2 * den);
    const strength = best / e;
    const sharp = (best - Math.max(Math.abs(cc[0]), Math.abs(cc[cc.length - 1]))) / e;
    return [(i - k) + clamp(d, -1, 1), Math.min(strength, 4 * sharp)];
  }

  function rowShiftApply(row, w, s, out) {
    for (let i = 0; i < w; i++) {
      let x = clamp(i + s, 0, w - 1);
      const i0 = Math.floor(x);
      const fr = x - i0;
      const i1 = Math.min(w - 1, i0 + 1);
      out[i] = row[i0] + (row[i1] - row[i0]) * fr;
    }
  }

  function jitterRepair(img, maxShift, iters) {
    maxShift = maxShift || 4.5; iters = iters || 2;
    const w = img.w, h = img.h;
    const planes = [img.r, img.g, img.b];
    const X = planes.map(p => Float64Array.from(p));
    const total = [new Float64Array(h), new Float64Array(h), new Float64Array(h)];
    const tmp = new Float64Array(w);

    const roughness = ch => {
      const vals = [];
      for (let r = 1; r < h; r += 2) {
        const est = rowShiftEst(X[ch].subarray((r - 1) * w, r * w),
                                X[ch].subarray(r * w, (r + 1) * w), w, 7);
        if (est[1] > 0.15) vals.push(Math.abs(est[0]));
      }
      if (vals.length < 8) return null;
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    };

    for (let it = 0; it < iters; it++) {
      for (let ch = 0; ch < 3; ch++) {
        const dr = new Float64Array(h);
        for (let r = 1; r < h; r++) {
          const est = rowShiftEst(X[ch].subarray((r - 1) * w, r * w),
                                  X[ch].subarray(r * w, (r + 1) * w), w, 7);
          if (est[1] > 0.15) dr[r] = clamp(est[0], -6, 6);
        }
        const c = new Float64Array(h);
        let acc = 0;
        for (let r = 0; r < h; r++) { acc += dr[r]; c[r] = acc; }
        const lowc = gaussianFilter1d(c, 10.0);
        const corr = new Float64Array(h);
        for (let r = 0; r < h; r++) {
          let v = clamp(c[r] - lowc[r], -maxShift, maxShift);
          if (Math.abs(v) < 0.05) v = 0;
          corr[r] = v;
        }
        const before = roughness(ch);
        const saved = Float64Array.from(X[ch]);
        for (let r = 0; r < h; r++) {
          if (!corr[r]) continue;
          const row = X[ch].subarray(r * w, (r + 1) * w);
          rowShiftApply(row, w, corr[r], tmp);
          row.set(tmp);
        }
        const after = roughness(ch);
        if (before !== null && after !== null && after > before * 0.98) {
          X[ch].set(saved);                            // do no harm
        } else {
          for (let r = 0; r < h; r++) total[ch][r] += corr[r];
        }
      }
    }

    const out = { r: Float64Array.from(img.r), g: Float64Array.from(img.g), b: Float64Array.from(img.b), w, h };
    const op = [out.r, out.g, out.b];
    for (let ch = 0; ch < 3; ch++) {
      for (let r = 0; r < h; r++) {
        if (Math.abs(total[ch][r]) <= 0.03) continue;
        const row = planes[ch].subarray(r * w, (r + 1) * w);
        rowShiftApply(row, w, total[ch][r], tmp);
        op[ch].set(tmp, r * w);
      }
    }
    for (let ch = 0; ch < 3; ch++)
      for (let i = 0; i < w * h; i++) op[ch][i] = clamp(op[ch][i], 0, 255);
    return out;
  }

  function noiseSigma(chan, w, h) {
    const d = [];
    for (let r = 1; r < h; r++)
      for (let i = 0; i < w; i++)
        d.push(Math.abs(chan[r * w + i] - chan[(r - 1) * w + i]));
    d.sort((a, b) => a - b);
    return d[d.length >> 1] / (0.6745 * Math.SQRT2);
  }

  function despeckleLines(X, w, h, sigma) {
    const agreeT = 3.0 * sigma + 6.0, impT = 4.0 * sigma + 8.0;
    for (let r = 1; r < h - 1; r++) {
      for (let i = 0; i < w; i++) {
        const up = X[(r - 1) * w + i], dn = X[(r + 1) * w + i];
        const vm = 0.5 * (up + dn);
        if (Math.abs(up - dn) < agreeT && Math.abs(X[r * w + i] - vm) > impT)
          X[r * w + i] = vm;
      }
    }
    return X;
  }

  /* 2-D box mean with 'nearest' edges (for the NLM patch distance) */
  function boxFilter2(X, w, h, size, out) {
    const half = size >> 1;
    const tmp = out || new Float64Array(w * h);
    const rowAcc = new Float64Array(w * h);
    for (let r = 0; r < h; r++) {
      const cs = new Float64Array(w + 1);
      for (let i = 0; i < w; i++) cs[i + 1] = cs[i] + X[r * w + i];
      const first = X[r * w], last = X[r * w + w - 1];
      for (let i = 0; i < w; i++) {
        let a = i - half, b = i + size - half;
        let s = 0;
        if (a < 0) { s += first * (-a); a = 0; }
        if (b > w) { s += last * (b - w); b = w; }
        rowAcc[r * w + i] = (s + cs[b] - cs[a]) / size;
      }
    }
    for (let i = 0; i < w; i++) {
      const cs = new Float64Array(h + 1);
      for (let r = 0; r < h; r++) cs[r + 1] = cs[r] + rowAcc[r * w + i];
      const first = rowAcc[i], last = rowAcc[(h - 1) * w + i];
      for (let r = 0; r < h; r++) {
        let a = r - half, b = r + size - half;
        let s = 0;
        if (a < 0) { s += first * (-a); a = 0; }
        if (b > h) { s += last * (b - h); b = h; }
        tmp[r * w + i] = (s + cs[b] - cs[a]) / size;
      }
    }
    return tmp;
  }

  function nlm(X, w, h, sigma, hRel, dy, dx, patch) {
    patch = patch || 5;
    const h2 = Math.pow(hRel * Math.max(sigma, 0.5), 2);
    const acc = new Float64Array(w * h);
    const wsum = new Float64Array(w * h);
    const diff2 = new Float64Array(w * h);
    const D = new Float64Array(w * h);
    const reflect = (v, n) => {
      while (v < 0 || v >= n) {
        if (v < 0) v = -v - 1;
        if (v >= n) v = 2 * n - 1 - v;
      }
      return v;
    };
    const s2 = 2.0 * sigma * sigma;
    for (let u = -dy; u <= dy; u++) {
      for (let v = -dx; v <= dx; v++) {
        for (let r = 0; r < h; r++) {
          const rr = reflect(r + u, h);
          for (let i = 0; i < w; i++) {
            const ii = reflect(i + v, w);
            const d = X[r * w + i] - X[rr * w + ii];
            diff2[r * w + i] = d * d;
          }
        }
        boxFilter2(diff2, w, h, patch, D);
        for (let r = 0; r < h; r++) {
          const rr = reflect(r + u, h);
          for (let i = 0; i < w; i++) {
            const ii = reflect(i + v, w);
            const wgt = Math.exp(-Math.max(D[r * w + i] - s2, 0) / h2);
            acc[r * w + i] += wgt * X[rr * w + ii];
            wsum[r * w + i] += wgt;
          }
        }
      }
    }
    const out = new Float64Array(w * h);
    for (let i = 0; i < w * h; i++) out[i] = acc[i] / wsum[i];
    return out;
  }

  function denoiseImage(img, strength) {
    const w = img.w, h = img.h, n = w * h;
    const Y = new Float64Array(n), Cb = new Float64Array(n), Cr = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const R = img.r[i], G = img.g[i], B = img.b[i];
      const y = 0.299 * R + 0.587 * G + 0.114 * B;
      Y[i] = y;
      Cb[i] = (B - y) * 0.564 + 128.0;
      Cr[i] = (R - y) * 0.713 + 128.0;
    }
    const sig = noiseSigma(Y, w, h);
    if (sig * strength < 1.6) return img;              // already clean
    const say = Math.min(sig, 40.0);
    strength = strength * clamp(say / 10.0, 1.0, 1.8);
    despeckleLines(Y, w, h, say);
    despeckleLines(Cb, w, h, say);
    despeckleLines(Cr, w, h, say);
    const Y2 = nlm(Y, w, h, say, 0.75 * strength, 8, 3, 5);
    const Cb2 = nlm(Cb, w, h, say, 1.5 * strength, 8, 3, 5);
    const Cr2 = nlm(Cr, w, h, say, 1.5 * strength, 8, 3, 5);
    const out = { r: new Float64Array(n), g: new Float64Array(n), b: new Float64Array(n), w, h };
    for (let i = 0; i < n; i++) {
      const R = Y2[i] + 1.403 * (Cr2[i] - 128.0);
      const B = Y2[i] + 1.773 * (Cb2[i] - 128.0);
      const G = (Y2[i] - 0.299 * R - 0.114 * B) / 0.587;
      out.r[i] = clamp(R, 0, 255);
      out.g[i] = clamp(G, 0, 255);
      out.b[i] = clamp(B, 0, 255);
    }
    return out;
  }

  function gaussian2d(X, w, h, sigma) {
    const r = Math.max(1, Math.round(3 * sigma));
    const k = new Float64Array(2 * r + 1);
    let s = 0;
    for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-0.5 * (i / sigma) ** 2); s += k[i + r]; }
    for (let i = 0; i < k.length; i++) k[i] /= s;
    const t = new Float64Array(w * h), out = new Float64Array(w * h);
    for (let row = 0; row < h; row++) {
      for (let i = 0; i < w; i++) {
        let acc = 0;
        for (let j = -r; j <= r; j++) acc += k[j + r] * X[row * w + clamp(i + j, 0, w - 1)];
        t[row * w + i] = acc;
      }
    }
    for (let i = 0; i < w; i++) {
      for (let row = 0; row < h; row++) {
        let acc = 0;
        for (let j = -r; j <= r; j++) acc += k[j + r] * t[clamp(row + j, 0, h - 1) * w + i];
        out[row * w + i] = acc;
      }
    }
    return out;
  }

  function sharpenImage(img, amount, radius) {
    amount = amount || 0.8; radius = radius || 1.1;
    const w = img.w, h = img.h, n = w * h;
    const Y = new Float64Array(n);
    for (let i = 0; i < n; i++) Y[i] = 0.299 * img.r[i] + 0.587 * img.g[i] + 0.114 * img.b[i];
    const a = amount * clamp(1.0 - noiseSigma(Y, w, h) / 22.0, 0.15, 1.0);
    const blur = gaussian2d(Y, w, h, radius);
    const out = { r: new Float64Array(n), g: new Float64Array(n), b: new Float64Array(n), w, h };
    for (let r = 0; r < h; r++) {
      for (let i = 0; i < w; i++) {
        const idx = r * w + i;
        let lo = 255, hi = 0;
        for (let dr2 = -1; dr2 <= 1; dr2++)
          for (let di = -1; di <= 1; di++) {
            const v = Y[clamp(r + dr2, 0, h - 1) * w + clamp(i + di, 0, w - 1)];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        const y2 = clamp(Y[idx] + a * (Y[idx] - blur[idx]), lo, hi);
        const d = y2 - Y[idx];
        out.r[idx] = clamp(img.r[idx] + d, 0, 255);
        out.g[idx] = clamp(img.g[idx] + d, 0, 255);
        out.b[idx] = clamp(img.b[idx] + d, 0, 255);
      }
    }
    return out;
  }

  function psnr(a, b, trim) {
    trim = trim === undefined ? 4 : trim;
    const w = a.w, h = a.h;
    let mse = 0, cnt = 0;
    for (let r = trim; r < h - trim; r++) {
      for (let i = trim; i < w - trim; i++) {
        const idx = r * w + i;
        for (const p of ["r", "g", "b"]) {
          const d = a[p][idx] - b[p][idx];
          mse += d * d; cnt++;
        }
      }
    }
    mse /= cnt;
    return mse < 1e-9 ? 99.0 : 20.0 * Math.log10(255.0 / Math.sqrt(mse));
  }

  /* ---------------- full decode ---------------- */
  async function decodeSignal(y, fs, uiModeName, opts) {
    const o = opts || {};
    const say = m => { if (o.log) o.log(m); };
    let ft = new FreqTrack(y, fs, { lo: 700.0, hi: 3200.0 });   // wide: sharpest
    let vr = findVis(ft);
    let code = vr[0], visEnd = vr[1];
    if (visEnd !== null) {
      /* noise probe on the known 1900 Hz leader */
      const la = Math.round(visEnd - visDuration() * fs + 0.06 * fs);
      const lb = Math.round(la + 0.20 * fs);
      if (la >= 0 && lb <= ft.n) {
        let m = 0, s2 = 0;
        for (let i = la; i < lb; i++) m += ft.f[i];
        m /= (lb - la);
        for (let i = la; i < lb; i++) { const d = ft.f[i] - m; s2 += d * d; }
        const sigF = Math.sqrt(s2 / (lb - la));
        if (sigF > 22.0) {
          say(`Leader noise σ≈${sigF.toFixed(0)} Hz — narrow demod`);
          ft = new FreqTrack(y, fs, {});
          const vr2 = findVis(ft);
          if (vr2[1] !== null) { code = vr2[0]; visEnd = vr2[1]; }
        }
      }
    }
    let modeName;
    if (code !== null && code in VIS2MODE) {
      modeName = VIS2MODE[code];
      say(`VIS header: ${modeName} (code ${code})`);
    } else {
      modeName = uiModeName;
      if (code !== null) say(`VIS code ${code} unknown — using selected mode ${modeName}`);
      else say(`No VIS found — free-running as ${modeName}`);
    }
    const mode = MODES[modeName];
    const w = mode.w, h = mode.h, fam = mode.family;

    let s0;
    if (visEnd !== null) {
      s0 = visEnd;
      if (fam === "scottie") s0 += mode.sync * fs;
    } else {
      s0 = findFirstSync(ft, mode);
    }

    const st = syncTrack(ft, mode, s0);
    say(`Sync lock ${(st.quality * 100).toFixed(0)}% · slant ${st.slantPpm >= 0 ? "+" : ""}${st.slantPpm.toFixed(0)} ppm`);

    /* local (warped) line rate */
    const hT = txLines(mode);
    const Ls = new Float64Array(hT);
    for (let l = 0; l < hT - 1; l++) Ls[l] = st.starts[l + 1] - st.starts[l];
    Ls[hT - 1] = hT > 1 ? Ls[hT - 2] : linePeriod(mode) * fs;
    const LsF = medianFilter1d(Float32Array.from(Ls), 5);
    const Lp = linePeriod(mode);
    const wb = (l, offS) => st.starts[l] + (offS / Lp) * LsF[l];

    const img = { r: new Float64Array(w * h), g: new Float64Array(w * h), b: new Float64Array(w * h), w, h };
    const putRow = (l, rr, gg, bb) => {
      img.r.set(rr, l * w); img.g.set(gg, l * w); img.b.set(bb, l * w);
      if (o.sinkRow) o.sinkRow(l, img);
    };

    if (fam === "martin" || fam === "scottie") {
      let og, ob, orr;
      if (fam === "martin") {
        og = mode.sync + mode.porch;
        ob = og + mode.scan + mode.sep;
        orr = ob + mode.scan + mode.sep;
      } else {
        og = mode.sep;
        ob = og + mode.scan + mode.sep;
        orr = ob + mode.scan + mode.sync + mode.porch;
      }
      const sc = mode.scan * fs;
      for (let l = 0; l < h; l++) {
        const g = ft.scan(wb(l, og), sc, w).map(freqToVal);
        const b = ft.scan(wb(l, ob), sc, w).map(freqToVal);
        const r = ft.scan(wb(l, orr), sc, w).map(freqToVal);
        putRow(l, r, g, b);
        if (o.progress) o.progress(l + 1, h);
        if ((l & 15) === 15) await tick();
      }
    } else if (fam === "pd") {
      const oy1 = mode.sync + mode.porch;
      const ocr = oy1 + mode.scan;
      const ocb = ocr + mode.scan;
      const oy2 = ocb + mode.scan;
      const sc = mode.scan * fs;
      for (let tl = 0; tl < hT; tl++) {
        const y1 = ft.scan(wb(tl, oy1), sc, w).map(freqToVal);
        const cr = ft.scan(wb(tl, ocr), sc, w).map(freqToVal);
        const cb = ft.scan(wb(tl, ocb), sc, w).map(freqToVal);
        const y2 = ft.scan(wb(tl, oy2), sc, w).map(freqToVal);
        const r1 = new Float64Array(w), g1 = new Float64Array(w), b1 = new Float64Array(w);
        const r2 = new Float64Array(w), g2 = new Float64Array(w), b2 = new Float64Array(w);
        for (let i = 0; i < w; i++) {
          let px = ycrcbToRgbPx(y1[i], cr[i], cb[i]);
          r1[i] = px[0]; g1[i] = px[1]; b1[i] = px[2];
          px = ycrcbToRgbPx(y2[i], cr[i], cb[i]);
          r2[i] = px[0]; g2[i] = px[1]; b2[i] = px[2];
        }
        putRow(2 * tl, r1, g1, b1);
        putRow(2 * tl + 1, r2, g2, b2);
        if (o.progress) o.progress(2 * (tl + 1), h);
        if ((tl & 7) === 7) await tick();
      }
    } else if (fam === "robot36") {
      const oy = mode.sync + mode.porch;
      const osep = oy + mode.y_scan;
      const oc = osep + mode.sep + mode.sep_porch;
      const Yb = new Float64Array(h * w);
      const Crows = new Float64Array(h * w);
      const flags = new Uint8Array(h);
      for (let l = 0; l < h; l++) {
        const yv = ft.scan(wb(l, oy), mode.y_scan * fs, w).map(freqToVal);
        Yb.set(yv, l * w);
        const sepF = ft.mean(wb(l, osep), wb(l, osep) + mode.sep * fs);
        flags[l] = sepF > 1900.0 ? 1 : 0;
        const cv = ft.scan(wb(l, oc), mode.c_scan * fs, w).map(freqToVal);
        Crows.set(cv, l * w);
        /* provisional paint: assume standard parity */
        const k = l - (l % 2);
        const rr = new Float64Array(w), gg = new Float64Array(w), bb = new Float64Array(w);
        for (let i = 0; i < w; i++) {
          const cr = Crows[k * w + i];
          const cb = (k + 1) <= l ? Crows[(k + 1) * w + i] : 128.0;
          const px = ycrcbToRgbPx(Yb[l * w + i], cr, cb);
          rr[i] = px[0]; gg[i] = px[1]; bb[i] = px[2];
        }
        putRow(l, rr, gg, bb);
        if (o.progress) o.progress(l + 1, h);
        if ((l & 15) === 15) await tick();
      }
      let agree = 0;
      for (let l = 0; l < h; l++) if (flags[l] === (l % 2 === 1 ? 1 : 0)) agree++;
      const flipped = agree / h < 0.5;
      if (flipped) say("Robot 36 chroma parity flipped — corrected");
      for (let k = 0; k + 1 < h; k += 2) {
        for (let i = 0; i < w; i++) {
          const cr = flipped ? Crows[(k + 1) * w + i] : Crows[k * w + i];
          const cb = flipped ? Crows[k * w + i] : Crows[(k + 1) * w + i];
          let px = ycrcbToRgbPx(Yb[k * w + i], cr, cb);
          img.r[k * w + i] = px[0]; img.g[k * w + i] = px[1]; img.b[k * w + i] = px[2];
          px = ycrcbToRgbPx(Yb[(k + 1) * w + i], cr, cb);
          img.r[(k + 1) * w + i] = px[0]; img.g[(k + 1) * w + i] = px[1]; img.b[(k + 1) * w + i] = px[2];
        }
      }
    } else {                                            // robot72
      const oy = mode.sync + mode.porch;
      const ocr = oy + mode.y_scan + mode.sep + mode.sep_porch;
      const ocb = ocr + mode.c_scan + mode.sep + mode.sep_porch;
      for (let l = 0; l < h; l++) {
        const Yv = ft.scan(wb(l, oy), mode.y_scan * fs, w);
        const Cr = ft.scan(wb(l, ocr), mode.c_scan * fs, w);
        const Cb = ft.scan(wb(l, ocb), mode.c_scan * fs, w);
        const rr = new Float64Array(w), gg = new Float64Array(w), bb = new Float64Array(w);
        for (let i = 0; i < w; i++) {
          const px = ycrcbToRgbPx(freqToVal(Yv[i]), freqToVal(Cr[i]), freqToVal(Cb[i]));
          rr[i] = px[0]; gg[i] = px[1]; bb[i] = px[2];
        }
        putRow(l, rr, gg, bb);
        if (o.progress) o.progress(l + 1, h);
        if ((l & 15) === 15) await tick();
      }
    }

    let out = img;
    if (o.cleanup !== false) { out = jitterRepair(out); await tick(); }
    const dn = o.denoise === undefined ? 1.6 : o.denoise;
    if (dn) { out = denoiseImage(out, dn === true ? 1.6 : dn); await tick(); }
    if (o.sharpen) { out = sharpenImage(out); await tick(); }
    if (o.sinkDone) o.sinkDone(out);
    return {
      img: out, mode: modeName,
      info: { mode: modeName, vis: code, quality: st.quality, slantPpm: st.slantPpm, startS: s0 / fs }
    };
  }

  /* ---------------- auto factor / method detection ------------------- */
  async function autoRestore(y, fs, uiFactor, uiMethod, log) {
    const say = m => { if (log) log(m); };
    const head = y.subarray(0, Math.min(y.length, Math.round(4.5 * fs)));
    const rest = [2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 1.5, 1.25, 1.0]
      .filter(f => Math.abs(f - uiFactor) > 1e-9);
    const factors = [uiFactor].concat(rest);
    for (const meth of [METHOD_FM, METHOD_RESAMPLE]) {
      for (const f of factors) {
        let code = null;
        try {
          const r = restoreAudio(head, fs, f, meth);
          code = findVis(new FreqTrack(r, fs, {}))[0];
        } catch (e) { code = null; }
        await tick();
        if (code !== null && code in VIS2MODE) {
          say(`Auto-detect: ${f}x ${meth} -> VIS ${VIS2MODE[code]}`);
          return { y: restoreAudio(y, fs, f, meth), factor: f, method: meth, vis: code };
        }
      }
    }
    say(`Auto-detect failed — using selected ${uiFactor}x ${uiMethod}`);
    return { y: restoreAudio(y, fs, uiFactor, uiMethod), factor: uiFactor, method: uiMethod, vis: null };
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

  /* =====================================================================
     Spectrogram — the "on-air scope"
     ===================================================================== */
  const SPEC_STOPS = [[0.00, [10, 12, 20]], [0.35, [24, 62, 120]],
                      [0.60, [28, 168, 178]], [0.82, [245, 195, 70]],
                      [1.00, [255, 255, 255]]];
  function specLut() {
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
  }
  const SPEC_LUT = specLut();

  function drawSpectrogram(canvas, y, fs, fmax) {
    if (!canvas || !canvas.getContext) return;
    fmax = fmax || 5000;
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
        const q = ((kmax - 1 - k) * frames + t) * 4;      // low freq at bottom
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
    id: "sstv",

    init(ctx) {
      this.ctx = ctx;
      this.modeName = "Martin M1";
      this.factor = 2.0;
      this.method = METHOD_FM;
      this.voxHdr = false;
      this.auto = true;
      this.clean = true;
      this.denoise = 1.6;                 // Off=0 · Normal=1.6 · Strong=2.4
      this.sharpen = false;
      this.voxThr = -42.0;
      this.source = "pattern";
      this.overlayCall = true;
      this.imageObj = null;
      this.snapCanvas = null;
      this.yBase = null;
      this.yAir = null;
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

      if (!this._subscribed) {
        this._subscribed = true;
        ctx.audio.onSamples((samples, sr) => this._voxFeed(samples, sr));
      }
    },

    createPanel(el) {
      const modeOpts = Object.keys(MODES).map(m => `<option>${m}</option>`).join("");
      const facOpts = FACTORS.map(f =>
        `<option value="${f}"${f === 2 ? " selected" : ""}>${f === 1 ? "1x (off)" : f + "x"}</option>`).join("");
      const chanOpts = CHANNELS.map((c, i) => `<option value="${i}">${c[0]}</option>`).join("");
      el.innerHTML = `
        <div class="mod-layout">
          <div class="mod-main">
            <div class="card">
              <header class="card-head"><h3>RX picture</h3>
                <span class="card-tag mono" id="sstv-stage">idle</span></header>
              <div style="padding:14px;display:flex;justify-content:center;background:#05070b">
                <canvas id="sstv-rx" width="320" height="256"
                  style="max-width:100%;border:1px solid rgba(96,114,150,0.3);background:#000;image-rendering:pixelated"></canvas>
              </div>
              <div class="card-foot mod-controls">
                <span class="mono" id="sstv-rxinfo" style="flex:1">—</span>
                <button class="btn" id="sstv-saveimg" disabled>Save image</button>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>On-air scope</h3>
                <span class="card-tag mono" id="sstv-airinfo">—</span></header>
              <div style="padding:10px;background:#05070b">
                <canvas id="sstv-spec" width="740" height="150" style="width:100%;display:block"></canvas>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>TX picture</h3></header>
              <div style="padding:14px;display:flex;justify-content:center;background:#05070b">
                <canvas id="sstv-tx" width="320" height="256"
                  style="max-width:100%;border:1px solid rgba(96,114,150,0.3);background:#000"></canvas>
              </div>
              <div class="card-foot mod-controls">
                <label class="field"><span>Source</span>
                  <select id="sstv-source">
                    <option value="pattern">Test pattern</option>
                    <option value="image">Uploaded image</option>
                    <option value="camera">Webcam snapshot</option>
                  </select></label>
                <label class="btn" for="sstv-file">Load image…</label>
                <input type="file" id="sstv-file" accept="image/*" style="display:none">
                <button class="btn" id="sstv-snap">Snap webcam</button>
                <label class="field" style="flex-direction:row;align-items:center;gap:6px">
                  <input type="checkbox" id="sstv-call" checked><span>Callsign overlay</span></label>
              </div>
            </div>
          </div>
          <div class="mod-side">
            <div class="card">
              <header class="card-head"><h3>Mode · compression</h3></header>
              <div class="card-body mod-controls" style="flex-direction:column;align-items:stretch">
                <label class="field"><span>SSTV mode</span>
                  <select id="sstv-mode">${modeOpts}</select></label>
                <div class="mod-note mono" id="sstv-modeinfo" style="font-size:11px"></div>
                <label class="field"><span>Compression</span>
                  <select id="sstv-factor">${facOpts}</select></label>
                <label class="field"><span>Method</span>
                  <select id="sstv-method">
                    <option value="fm">FM turbo (SSB-safe)</option>
                    <option value="resample">Resample (wideband)</option>
                  </select></label>
                <label class="field" style="flex-direction:row;align-items:center;gap:6px">
                  <input type="checkbox" id="sstv-voxhdr"><span>VOX keying header (FRS)</span></label>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>Transmit</h3></header>
              <div class="card-body mod-controls" style="flex-direction:column;align-items:stretch">
                <button class="btn btn-accent" id="sstv-encode">Encode</button>
                <button class="btn" id="sstv-play" disabled>Transmit (play on air)</button>
                <button class="btn" id="sstv-stop">Stop</button>
                <button class="btn" id="sstv-savewav" disabled>Save WAV → download</button>
                <label class="field"><span>Loopback channel</span>
                  <select id="sstv-chan">${chanOpts}</select></label>
                <div class="mod-controls">
                  <label class="field" style="flex-direction:row;align-items:center;gap:6px">
                    <input type="checkbox" id="sstv-noise"><span>Noise, SNR</span></label>
                  <input type="number" id="sstv-snr" value="12" min="-5" max="40" style="width:64px">
                  <span class="mono">dB</span>
                </div>
                <button class="btn" id="sstv-loop" disabled>Loopback test</button>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>Receive</h3></header>
              <div class="card-body mod-controls" style="flex-direction:column;align-items:stretch">
                <label class="btn" for="sstv-wavin" style="text-align:center">Decode WAV…</label>
                <input type="file" id="sstv-wavin" accept=".wav,audio/wav,audio/x-wav" style="display:none">
                <button class="btn" id="sstv-listen">Listen (VOX)</button>
                <div class="mod-controls">
                  <span class="mono" id="sstv-meter" style="min-width:64px">— dB</span>
                  <label class="field" style="flex:1"><span>VOX threshold</span>
                    <input type="range" id="sstv-vox" min="-70" max="-15" step="1" value="-42"></label>
                </div>
                <label class="field" style="flex-direction:row;align-items:center;gap:6px">
                  <input type="checkbox" id="sstv-auto" checked><span>Auto-detect factor / method</span></label>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>Cleanup</h3></header>
              <div class="card-body mod-controls" style="flex-direction:column;align-items:stretch">
                <label class="field" style="flex-direction:row;align-items:center;gap:6px">
                  <input type="checkbox" id="sstv-clean" checked><span>Jitter repair</span></label>
                <label class="field"><span>Denoise</span>
                  <select id="sstv-denoise">
                    <option value="0">Off</option>
                    <option value="1.6" selected>Normal</option>
                    <option value="2.4">Strong</option>
                  </select></label>
                <label class="field" style="flex-direction:row;align-items:center;gap:6px">
                  <input type="checkbox" id="sstv-sharp"><span>Sharpen</span></label>
                <button class="btn" id="sstv-selftest">Self-test (loopback)</button>
              </div>
            </div>
            <div class="mod-note">
              Time-compressed SSTV is an experiment by VA3JFL: both ends need
              this scheme (at 1x it is plain SSTV any decoder reads). FM turbo
              stays inside 1200–2300 Hz, so it fits an SSB channel; Resample
              needs a wideband path. Identify per your local regulations.
            </div>
          </div>
        </div>`;

      const $ = id => el.querySelector("#sstv-" + id);
      this.ui = {
        rx: $("rx"), tx: $("tx"), spec: $("spec"),
        stage: $("stage"), rxinfo: $("rxinfo"), airinfo: $("airinfo"),
        saveimg: $("saveimg"), source: $("source"), file: $("file"),
        snap: $("snap"), call: $("call"),
        mode: $("mode"), modeinfo: $("modeinfo"), factor: $("factor"),
        method: $("method"), voxhdr: $("voxhdr"),
        encode: $("encode"), play: $("play"), savewav: $("savewav"),
        chan: $("chan"), noise: $("noise"), snr: $("snr"), loop: $("loop"),
        wavin: $("wavin"), listen: $("listen"), meter: $("meter"),
        vox: $("vox"), auto: $("auto"),
        clean: $("clean"), denoise: $("denoise"), sharp: $("sharp"),
        selftest: $("selftest")
      };

      this.ui.mode.value = this.modeName;
      this.ui.mode.addEventListener("change", () => {
        this.modeName = this.ui.mode.value;
        this._modeChanged();
      });
      this.ui.factor.addEventListener("change", () => {
        this.factor = parseFloat(this.ui.factor.value);
        this._modeChanged();
      });
      this.ui.method.addEventListener("change", () => { this.method = this.ui.method.value; });
      this.ui.voxhdr.addEventListener("change", () => { this.voxHdr = this.ui.voxhdr.checked; });
      this.ui.auto.addEventListener("change", () => { this.auto = this.ui.auto.checked; });
      this.ui.clean.addEventListener("change", () => { this.clean = this.ui.clean.checked; });
      this.ui.denoise.addEventListener("change", () => { this.denoise = parseFloat(this.ui.denoise.value); });
      this.ui.sharp.addEventListener("change", () => { this.sharpen = this.ui.sharp.checked; });
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
      el.querySelector("#sstv-stop").addEventListener("click", () => {
        this.ctx.audio.stopTX();
        this.ctx.log("SSTV transmission stopped.");
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

      this._modeChanged();
      this._renderSource();
    },

    onDeactivate() {
      this.listening = false;
      this.ui = null;
    },

    /* ---------------- shared helpers ---------------- */
    _stage(t) { if (this.ui) this.ui.stage.textContent = t; },
    _mode() { return MODES[this.modeName]; },

    _modeChanged() {
      const m = this._mode();
      const nom = nominalDuration(m);
      this.ui.modeinfo.textContent =
        `${m.w}×${m.h} · nominal ${nom.toFixed(1)} s · on-air ≈ ${(nom / this.factor).toFixed(1)} s at ${this.factor}x`;
      for (const cv of [this.ui.rx, this.ui.tx]) {
        if (cv.height !== m.h) { cv.height = m.h; }
        if (cv.width !== m.w) { cv.width = m.w; }
      }
      this.yBase = this.yAir = null;
      this.ui.play.disabled = this.ui.savewav.disabled = this.ui.loop.disabled = true;
      this._renderSource();
    },

    /* draw the current source, aspect-fit on black, optional callsign */
    _renderSource() {
      if (!this.ui) return;
      const m = this._mode();
      const c = this.ui.tx.getContext("2d");
      c.imageSmoothingEnabled = true;
      c.imageSmoothingQuality = "high";
      c.fillStyle = "#000";
      c.fillRect(0, 0, m.w, m.h);
      if (this.source === "pattern") {
        const p = testPattern(m.w, m.h);
        const id = c.createImageData(m.w, m.h);
        for (let i = 0; i < m.w * m.h; i++) {
          id.data[i * 4] = p.r[i]; id.data[i * 4 + 1] = p.g[i];
          id.data[i * 4 + 2] = p.b[i]; id.data[i * 4 + 3] = 255;
        }
        c.putImageData(id, 0, 0);
      } else {
        const src = this.source === "image" ? this.imageObj : this.snapCanvas;
        if (src) {
          const s = Math.min(m.w / src.width, m.h / src.height);
          const nw = Math.max(1, Math.round(src.width * s));
          const nh = Math.max(1, Math.round(src.height * s));
          c.drawImage(src, (m.w - nw) >> 1, (m.h - nh) >> 1, nw, nh);
        } else {
          c.fillStyle = "#888";
          c.font = "16px monospace";
          c.textAlign = "center";
          c.fillText(this.source === "image" ? "load an image…" : "snap the webcam…", m.w / 2, m.h / 2);
        }
      }
      if (this.overlayCall) {
        const call = (this.ctx.settings().callsign || "").trim().toUpperCase();
        if (call) {
          let size = Math.max(14, Math.round(m.h * 0.105));
          c.textBaseline = "top";
          c.textAlign = "left";
          let tw;
          for (;;) {
            c.font = `bold ${size}px "Chakra Petch", monospace`;
            tw = c.measureText(call).width;
            if (tw <= m.w - 20 || size <= 10) break;
            size -= 2;
          }
          const pad = Math.max(4, Math.floor(size / 6));
          const x = 8, yv = 6;
          c.fillStyle = "rgb(4,4,8)";
          c.fillRect(Math.max(0, x - pad), Math.max(0, yv - pad),
                     Math.min(m.w, tw + 2 * pad), Math.min(m.h, size + 2 * pad));
          c.fillStyle = "#fff";
          c.fillText(call, x, yv);
        }
      }
      this.yBase = this.yAir = null;
      this.ui.play.disabled = this.ui.savewav.disabled = this.ui.loop.disabled = true;
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
        await new Promise(r => setTimeout(r, 350));      // exposure settle
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
      const m = this._mode();
      const d = this.ui.tx.getContext("2d").getImageData(0, 0, m.w, m.h).data;
      const n = m.w * m.h;
      const img = { r: new Float64Array(n), g: new Float64Array(n), b: new Float64Array(n), w: m.w, h: m.h };
      for (let i = 0; i < n; i++) {
        img.r[i] = d[i * 4]; img.g[i] = d[i * 4 + 1]; img.b[i] = d[i * 4 + 2];
      }
      return img;
    },

    /* ---------------- TX chain ---------------- */
    async _encode() {
      if (this._busy) return;
      this._busy = true;
      this.ui.encode.disabled = true;
      try {
        const actx = this.ctx.audio.ensureContext();
        const fs = actx.sampleRate;
        this.encRate = Math.min(fs, 48000);   // voice-band mode: never render at studio wideband rates — the engine upsamples cleanly on playback
        const img = this._grabTxPlanes();
        this._stage("encoding…");
        await tick();
        const t0 = performance.now();
        const yBase = encodeImage(img, this.modeName, fs);
        this._stage(`compressing ${this.factor}x…`);
        await tick();
        let air = compressAudio(yBase, fs, this.factor, this.method);
        if (this.voxHdr) {
          const pre = voxPreamble(fs);
          const joined = new Float32Array(pre.length + air.length);
          joined.set(pre); joined.set(air, pre.length);
          air = joined;
        }
        this.yBase = yBase;
        this.yAir = air;
        const baseS = yBase.length / fs, airS = air.length / fs;
        drawSpectrogram(this.ui.spec, air, fs);
        this.ui.airinfo.textContent =
          `${baseS.toFixed(1)} s → ${airS.toFixed(1)} s on air (${this.factor}x ${this.method})`;
        this._stage("ready");
        this.ui.play.disabled = this.ui.savewav.disabled = this.ui.loop.disabled = false;
        this.ctx.log(`SSTV encoded ${this.modeName}: ${baseS.toFixed(1)} s → ` +
          `${airS.toFixed(1)} s on-air (${(100 * (1 - airS / baseS)).toFixed(0)}% airtime saved) ` +
          `in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
      } catch (e) {
        this._stage("error");
        this.ctx.log("SSTV encode failed: " + e.message);
      } finally {
        this._busy = false;
        this.ui.encode.disabled = false;
      }
    },

    _play() {
      if (!this.yAir) return;
      this.ctx.audio.playPCM(this.yAir, this.encRate);
      this.ctx.log(`SSTV on-air burst playing (${(this.yAir.length / this.encRate).toFixed(1)} s)`);
    },

    _saveWav() {
      if (!this.yAir) return;
      const buf = wavEncode16(this.yAir, this.encRate);
      const name = `sstv_onair_${this.modeName.replace(/ /g, "")}_${this.factor}x_${this.method}.wav`;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
      this.ctx.log(`saved ${name} (${(buf.byteLength / 1048576).toFixed(1)} MB)`);
    },

    async _loopback() {
      if (!this.yAir || this._busy) return;
      let sig = this.yAir;
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

    /* ---------------- RX chain ---------------- */
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
        let back = y, gf = this.factor, gm = this.method;
        if (this.auto) {
          this._stage("auto-detecting rate…");
          const r = await autoRestore(y, fs, this.factor, this.method, m => this.ctx.log(m));
          back = r.y; gf = r.factor; gm = r.method;
        } else if (this.factor > 1) {
          this._stage(`restoring ${gf}x (${gm})…`);
          await tick();
          back = restoreAudio(y, fs, gf, gm);
        }
        this._stage("decoding…");
        const rxC = this.ui.rx.getContext("2d");
        let painted = 0;
        const res = await decodeSignal(back, fs, this.modeName, {
          log: m => this.ctx.log("sstv: " + m),
          cleanup: this.clean,
          denoise: this.denoise || false,
          sharpen: this.sharpen,
          progress: (l, n) => { this._stage(`decoding… ${Math.round(100 * l / n)} %`); },
          sinkRow: (l, img) => {
            if (l - painted >= 8 || l === img.h - 1) {
              painted = l;
              this._paintImage(img);
            }
          }
        });
        this._paintImage(res.img);
        this.lastImg = { img: res.img, mode: res.mode };
        this.ui.saveimg.disabled = false;
        const inf = res.info;
        this.ui.rxinfo.textContent =
          `${res.mode} · restore ${gf}x ${gm} · sync ${(inf.quality * 100).toFixed(0)}% · ` +
          `slant ${inf.slantPpm >= 0 ? "+" : ""}${inf.slantPpm.toFixed(0)} ppm · ${source}`;
        this._stage("done");
        this.ctx.log(`SSTV decode complete: ${res.mode} (sync ${(inf.quality * 100).toFixed(0)}%)`);
      } catch (e) {
        this._stage("error");
        this.ctx.log("SSTV decode failed: " + e.message);
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
      if (!this.lastImg) return;
      const cv = document.createElement("canvas");
      cv.width = this.lastImg.img.w; cv.height = this.lastImg.img.h;
      const c = cv.getContext("2d");
      const id = c.createImageData(cv.width, cv.height);
      const img = this.lastImg.img;
      for (let i = 0; i < cv.width * cv.height; i++) {
        id.data[i * 4] = img.r[i]; id.data[i * 4 + 1] = img.g[i];
        id.data[i * 4 + 2] = img.b[i]; id.data[i * 4 + 3] = 255;
      }
      c.putImageData(id, 0, 0);
      const a = document.createElement("a");
      a.href = cv.toDataURL("image/png");
      a.download = `sstv_rx_${this.lastImg.mode.replace(/ /g, "")}.png`;
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
      this.ctx.log("SSTV listening — VOX armed, waiting for a burst");
    },

    _voxFeed(block, sr) {
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
          this._ringLen -= this._ring.shift().length;            // 1 s pre-roll
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
        if (this._silence > 1.5 || this._capLen / sr > 240) {
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
      this._busy = true;
      const log = m => this.ctx.log("sstv self-test: " + m);
      try {
        const fs = this.ctx.audio.ensureContext().sampleRate;
        /* 1) Robot 36 direct */
        this._stage("self-test 1/2: Robot 36 direct…");
        await tick();
        let m = MODES["Robot 36"];
        let ref = testPattern(m.w, m.h);
        let y = encodeImage(ref, "Robot 36", fs);
        this._busy = false;                         // let the pipeline run
        await this._rxPipeline(y, fs, "self-test");
        this._busy = true;
        let p1 = this.lastImg ? psnr(ref, this.lastImg.img) : 0;
        log(`Robot 36 direct: PSNR ${p1.toFixed(1)} dB ${p1 > 20 ? "PASS" : "FAIL"}`);
        /* 2) Scottie S2, FM 2x */
        this._stage("self-test 2/2: Scottie S2 · FM 2x…");
        await tick();
        m = MODES["Scottie S2"];
        ref = testPattern(m.w, m.h);
        const saveMode = this.modeName, saveF = this.factor, saveM = this.method;
        this.modeName = "Scottie S2"; this.ui.mode.value = "Scottie S2";
        y = encodeImage(ref, "Scottie S2", fs);
        const air = compressAudio(y, fs, 2.0, METHOD_FM);
        log(`on-air ${(air.length / fs).toFixed(1)} s (was ${(y.length / fs).toFixed(1)} s)`);
        this._busy = false;
        await this._rxPipeline(air, fs, "self-test");
        this._busy = true;
        const p2 = this.lastImg ? psnr(ref, this.lastImg.img) : 0;
        log(`Scottie S2 fm 2x: PSNR ${p2.toFixed(1)} dB ${p2 > 12 ? "PASS" : "FAIL"}`);
        this.modeName = saveMode; this.ui.mode.value = saveMode;
        this.factor = saveF; this.method = saveM;
        this._stage(p1 > 20 && p2 > 12 ? "self-test PASS" : "self-test FAIL");
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
  window.__SSTV_TEST__ = {
    MODES, VIS2MODE, linePeriod, txLines, visDuration, nominalDuration, syncGeometry,
    FreqTrack, findVis, syncTrack, decodeSignal, encodeImage, synthesize,
    visSegments, compressAudio, restoreAudio, fmTimescale, autoRestore,
    channelSimulate, resamplePoly, movingAvg, medianFilter1d, testPattern,
    jitterRepair, denoiseImage, sharpenImage, psnr, voxPreamble,
    wavEncode16, wavDecodeMono, freqToVal, METHOD_FM, METHOD_RESAMPLE
  };
})();



