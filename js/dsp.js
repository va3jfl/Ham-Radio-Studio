/* ============================================================
   Ham Radio Web Studio — DSP toolkit
   Pure-math building blocks shared by every mode module.
   No DOM, no audio graph — just numbers in, numbers out.
   ============================================================ */
"use strict";

const DSP = (() => {

  /* ---------- Streaming Goertzel tone detector ----------
     Feed it raw samples; it emits one magnitude per block.
     Cheap enough to run several in parallel (RTTY mark/space,
     CW pitch, SSTV sync...). Bandwidth ≈ sampleRate / blockSize. */
  class Goertzel {
    constructor(freq, sampleRate, blockSize) {
      this.sampleRate = sampleRate;
      this.blockSize = blockSize;
      this.setFreq(freq);
      this.reset();
    }
    setFreq(freq) {
      this.freq = freq;
      const w = 2 * Math.PI * freq / this.sampleRate;
      this.coeff = 2 * Math.cos(w);
    }
    reset() { this.s1 = 0; this.s2 = 0; this.n = 0; }
    /* Push samples; calls onBlock(magnitude) once per completed block. */
    process(samples, onBlock) {
      const { coeff, blockSize } = this;
      let { s1, s2, n } = this;
      for (let i = 0; i < samples.length; i++) {
        const s0 = samples[i] + coeff * s1 - s2;
        s2 = s1; s1 = s0; n++;
        if (n >= blockSize) {
          const mag = Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / blockSize;
          onBlock(mag);
          s1 = 0; s2 = 0; n = 0;
        }
      }
      this.s1 = s1; this.s2 = s2; this.n = n;
    }
  }

  /* ---------- In-place iterative radix-2 FFT ----------
     re/im are Float32Array or Float64Array, length = power of 2. */
  function fft(re, im) {
    const n = re.length;
    // bit-reversal permutation
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
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        const half = len >> 1;
        for (let k = 0; k < half; k++) {
          const a = i + k, b = i + k + half;
          const vr = re[b] * cr - im[b] * ci;
          const vi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - vr; im[b] = im[a] - vi;
          re[a] += vr;        im[a] += vi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
  }

  /* Power spectrum of a real block (Hann-windowed, zero-padded to fftSize). */
  function powerSpectrum(samples, fftSize, win) {
    const re = new Float64Array(fftSize);
    const im = new Float64Array(fftSize);
    const n = Math.min(samples.length, fftSize);
    for (let i = 0; i < n; i++) re[i] = samples[i] * (win ? win[i] : 1);
    fft(re, im);
    const half = fftSize >> 1;
    const out = new Float64Array(half);
    for (let i = 0; i < half; i++) out[i] = re[i] * re[i] + im[i] * im[i];
    return out;
  }

  function hannWindow(n) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    return w;
  }

  /* ---------- Naive linear resampler ----------
     Good enough for decoder front-ends (FT8 12 kHz, etc.). */
  function resampleLinear(input, inRate, outRate) {
    if (inRate === outRate) return input;
    const ratio = inRate / outRate;
    const outLen = Math.floor(input.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const x = i * ratio;
      const i0 = Math.floor(x);
      const frac = x - i0;
      const a = input[i0] || 0;
      const b = input[i0 + 1 < input.length ? i0 + 1 : i0] || 0;
      out[i] = a + (b - a) * frac;
    }
    return out;
  }

  /* ---------- Simple single-pole smoothers ---------- */
  class EMA {
    constructor(alpha, init = 0) { this.a = alpha; this.v = init; }
    push(x) { this.v += this.a * (x - this.v); return this.v; }
  }

  /* Adaptive on/off threshold with hysteresis for envelope streams
     (CW keying detection and friends). Tracks a decaying peak and a
     rising floor, decides on/off between them. */
  class EnvelopeGate {
    constructor({ openRatio = 0.55, closeRatio = 0.4 } = {}) {
      this.peak = 1e-6;
      this.floor = 1e-6;
      this.state = false;
      this.openRatio = openRatio;
      this.closeRatio = closeRatio;
    }
    push(mag) {
      // peak decays slowly, floor rises slowly — both self-calibrating
      this.peak = Math.max(mag, this.peak * 0.999);
      this.floor = Math.min(mag, this.floor * 1.002 + 1e-9);
      const range = Math.max(this.peak - this.floor, 1e-9);
      const level = (mag - this.floor) / range;
      const snrOk = this.peak > this.floor * 3; // ignore pure noise
      if (this.state) {
        if (!snrOk || level < this.closeRatio) this.state = false;
      } else {
        if (snrOk && level > this.openRatio) this.state = true;
      }
      return this.state;
    }
  }

  /* ---------- Maidenhead grid helpers ---------- */
  function latLonToGrid(lat, lon, precision = 6) {
    lon += 180; lat += 90;
    const A = "ABCDEFGHIJKLMNOPQR";
    const a = "abcdefghijklmnopqrstuvwx";
    let g = A[Math.floor(lon / 20)] + A[Math.floor(lat / 10)];
    g += Math.floor((lon % 20) / 2).toString() + Math.floor(lat % 10).toString();
    if (precision >= 6) {
      g += a[Math.floor((lon % 2) * 12)] + a[Math.floor((lat % 1) * 24)];
    }
    return g;
  }
  function gridToLatLon(grid) {
    grid = grid.trim();
    if (!/^[A-Ra-r]{2}[0-9]{2}([A-Xa-x]{2})?$/.test(grid)) return null;
    const g = grid.toUpperCase();
    let lon = (g.charCodeAt(0) - 65) * 20 - 180;
    let lat = (g.charCodeAt(1) - 65) * 10 - 90;
    lon += parseInt(g[2], 10) * 2;
    lat += parseInt(g[3], 10);
    if (g.length >= 6) {
      lon += (g.charCodeAt(4) - 65) / 12 + 1 / 24;
      lat += (g.charCodeAt(5) - 65) / 24 + 1 / 48;
    } else {
      lon += 1; lat += 0.5;
    }
    return { lat, lon };
  }

  return { Goertzel, fft, powerSpectrum, hannWindow, resampleLinear, EMA, EnvelopeGate, latLonToGrid, gridToLatLon };
})();
