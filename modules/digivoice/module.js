/* ============================================================
   Ham Radio Web Studio — Digital Voice (HRWS-DV)
   An open studio-to-studio digital voice system built the way
   FreeDV is built: a low-rate LPC vocoder, Golay(24,12) FEC on
   the perceptually critical bits, and two modems — multicarrier
   differential PSK for SSB / FM voice channels, and 4FSK for
   the 9k6 data jack of FM rigs.

   Modes
     DV-1600   DQPSK · 22 carriers + pilot · 600–2700 Hz · any rig
     DV-2600   D8PSK · same carriers · quiet channels, better voice
     DV-3200F  4FSK 2000 Bd · FM data jack · best voice quality

   Voice path: mic → 8 kHz → LPC-10 vocoder (1600/2600/3200 bit/s)
   → 40 ms superframes with Golay-protected pitch/gain/LSF MSBs →
   modem → rig. PTT, PTT LOCK and VOX drive the transmitter; the
   receiver mutes while transmitting (half duplex).

   Not interoperable with FreeDV or M17 (their codecs are large
   C codebases); the framing deliberately mirrors FreeDV 1600 so
   a Codec2 WASM build can slot in as a future mode.
   ============================================================ */
"use strict";

(function () {

  const FS = 8000;                 // vocoder DSP rate
  const FRAME = 160;               // 20 ms analysis frame
  const ORDER = 10;                // LPC order

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function tick() { return new Promise(r => setTimeout(r, 0)); }

  /* ---------------- fractional resampler (voice grade) ----------------
     windowed-sinc, 6-point kernel — engine rate ↔ 8 kHz both ways */
  class Resamp {
    constructor(inRate, outRate) {
      this.ratio = inRate / outRate;
      this.buf = new Float32Array(0);
      this.pos = 3;
      /* anti-alias when decimating */
      this.lp = null;
      if (inRate > outRate * 1.01) {
        const fc = 0.45 * outRate / inRate, nt = 63, mid = 31;
        this.lp = new Float64Array(nt);
        let s = 0;
        for (let i = 0; i < nt; i++) {
          const x = i - mid;
          const sc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
          const wKaiser = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (nt - 1));
          this.lp[i] = sc * wKaiser;
          s += this.lp[i];
        }
        for (let i = 0; i < nt; i++) this.lp[i] /= s;
        this.zi = new Float32Array(nt - 1);
      }
    }
    process(x) {
      if (this.lp) {
        const nt = this.lp.length;
        const b = new Float32Array(this.zi.length + x.length);
        b.set(this.zi); b.set(x, this.zi.length);
        const y = new Float32Array(x.length);
        for (let i = 0; i < x.length; i++) {
          let s = 0;
          for (let j = 0; j < nt; j++) s += b[i + j] * this.lp[nt - 1 - j];
          y[i] = s;
        }
        this.zi = b.slice(b.length - (nt - 1));
        x = y;
      }
      const nb = new Float32Array(this.buf.length + x.length);
      nb.set(this.buf); nb.set(x, this.buf.length);
      this.buf = nb;
      const out = [];
      while (this.pos + 4 < this.buf.length) {
        const i0 = Math.floor(this.pos), fr = this.pos - i0;
        let s = 0, ws = 0;
        for (let k = -2; k <= 3; k++) {
          const dx = k - fr;
          const w = Math.abs(dx) < 1e-9 ? 1 :
            Math.sin(Math.PI * dx) / (Math.PI * dx) *
            (0.5 + 0.5 * Math.cos(Math.PI * dx / 3.2));
          s += this.buf[i0 + k] * w; ws += w;
        }
        out.push(s / (ws || 1));
        this.pos += this.ratio;
      }
      const keep = Math.max(0, Math.floor(this.pos) - 4);
      this.buf = this.buf.slice(keep);
      this.pos -= keep;
      return Float32Array.from(out);
    }
  }

  /* ---------------- LPC analysis ---------------- */
  function autocorr(x, order) {
    const r = new Float64Array(order + 1);
    for (let k = 0; k <= order; k++) {
      let s = 0;
      for (let i = k; i < x.length; i++) s += x[i] * x[i - k];
      r[k] = s;
    }
    return r;
  }
  function levinson(r, order) {
    const a = new Float64Array(order + 1);
    a[0] = 1;
    let e = r[0] || 1e-9;
    for (let i = 1; i <= order; i++) {
      let acc = r[i];
      for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
      const k = -acc / e;
      const tmp = a.slice();
      for (let j = 1; j < i; j++) a[j] = tmp[j] + k * tmp[i - j];
      a[i] = k;
      e *= (1 - k * k);
      if (e < 1e-12) e = 1e-12;
    }
    return { a, err: e };
  }

  /* ---------------- LPC <-> LSF ----------------
     line spectral frequencies via Chebyshev grid search */
  function lpcToLsf(a) {
    const p = new Float64Array(6), q = new Float64Array(6);
    /* P(z), Q(z) sum/difference polys, order 10 -> deg 5 in x=cos(w) */
    const pa = new Float64Array(12), qa = new Float64Array(12);
    pa[0] = 1; qa[0] = 1;
    for (let i = 1; i <= 11; i++) {
      const ai = i <= 10 ? a[i] : 0;
      const ar = 11 - i <= 10 ? a[11 - i] : (11 - i === 0 ? 1 : 0);
      pa[i] = ai + ar - pa[i - 1];
      qa[i] = ai - ar + qa[i - 1];
    }
    for (let i = 0; i <= 5; i++) { p[i] = pa[i]; q[i] = qa[i]; }
    /* Chebyshev evaluation of the symmetric half-polynomials */
    const evalP = (c, x) => {
      let sum = c[5] / 2;
      let t0 = 1, t1 = x;
      sum += c[4] * t1;
      for (let k = 2; k <= 5; k++) {
        const t2 = 2 * x * t1 - t0;
        sum += c[5 - k] * t2;
        t0 = t1; t1 = t2;
      }
      return sum;
    };
    const N = 512;
    const roots = [];
    let prevP = evalP(p, 1), prevQ = evalP(q, 1), prevX = 1;
    for (let i = 1; i <= N; i++) {
      const x = Math.cos(Math.PI * i / N);
      const vp = evalP(p, x), vq = evalP(q, x);
      if (vp * prevP < 0) {
        const xr = prevX + (x - prevX) * prevP / (prevP - vp);
        roots.push({ w: Math.acos(clamp(xr, -1, 1)), t: 0 });
      }
      if (vq * prevQ < 0) {
        const xr = prevX + (x - prevX) * prevQ / (prevQ - vq);
        roots.push({ w: Math.acos(clamp(xr, -1, 1)), t: 1 });
      }
      prevP = vp; prevQ = vq; prevX = x;
      if (roots.length >= 10) break;
    }
    roots.sort((u, v) => u.w - v.w);
    const lsf = new Float64Array(10);
    for (let i = 0; i < 10; i++)
      lsf[i] = roots[i] ? roots[i].w : (i + 1) * Math.PI / 11;
    /* enforce ordering + margins */
    for (let i = 0; i < 10; i++) {
      const lo = (i ? lsf[i - 1] : 0) + 0.008;
      lsf[i] = Math.max(lsf[i], lo);
    }
    return lsf;
  }
  function lsfToLpc(lsf) {
    /* rebuild P,Q from root pairs, multiply out, average */
    const pw = [], qw = [];
    for (let i = 0; i < 10; i++) (i % 2 === 0 ? pw : qw).push(lsf[i]);
    const poly = (ws) => {
      let c = [1];
      for (const w of ws) {
        const f = [1, -2 * Math.cos(w), 1];
        const nc = new Array(c.length + 2).fill(0);
        for (let i = 0; i < c.length; i++)
          for (let j = 0; j < 3; j++) nc[i + j] += c[i] * f[j];
        c = nc;
      }
      return c;
    };
    let P = poly(pw), Q = poly(qw);
    /* P *= (1+z^-1), Q *= (1-z^-1) */
    const mul = (c, f) => {
      const nc = new Array(c.length + 1).fill(0);
      for (let i = 0; i < c.length; i++) { nc[i] += c[i] * f[0]; nc[i + 1] += c[i] * f[1]; }
      return nc;
    };
    P = mul(P, [1, 1]); Q = mul(Q, [1, -1]);
    const a = new Float64Array(ORDER + 1);
    a[0] = 1;
    for (let i = 1; i <= ORDER; i++) a[i] = 0.5 * (P[i] + Q[i]);
    return a;
  }

  /* ---------------- pitch + voicing ---------------- */
  function pitchTrack(x, prev) {
    /* autocorrelation over 50–400 Hz on a lowpassed copy */
    const n = x.length;
    const lp = new Float64Array(n);
    let s = 0;
    for (let i = 0; i < n; i++) { s = 0.82 * s + 0.18 * x[i]; lp[i] = s; }
    let e0 = 0;
    for (let i = 0; i < n; i++) e0 += lp[i] * lp[i];
    if (e0 < 1e-7) return { lag: prev || 60, v: 0, nac: 0 };
    let best = 60, bv = -1;
    for (let lag = 20; lag <= 160; lag++) {
      let c = 0, e1 = 0;
      for (let i = lag; i < n; i++) { c += lp[i] * lp[i - lag]; e1 += lp[i - lag] * lp[i - lag]; }
      const nac = c / Math.sqrt(e0 * e1 + 1e-12);
      let sc = nac;
      if (prev && Math.abs(lag - prev) < prev * 0.2) sc += 0.06;   // continuity
      if (sc > bv) { bv = sc; best = lag; }
    }
    /* sub-multiple check: prefer the fundamental */
    for (const div of [2, 3]) {
      const l2 = Math.round(best / div);
      if (l2 >= 20) {
        let c = 0, e1 = 0;
        for (let i = l2; i < n; i++) { c += lp[i] * lp[i - l2]; e1 += lp[i - l2] * lp[i - l2]; }
        const nac = c / Math.sqrt(e0 * e1 + 1e-12);
        if (nac > bv * 0.88) { best = l2; bv = Math.max(bv, nac); }
      }
    }
    /* zero-crossing rate helps the decision */
    let zc = 0;
    for (let i = 1; i < n; i++) if ((x[i] >= 0) !== (x[i - 1] >= 0)) zc++;
    const v = (bv > 0.55 && zc < n * 0.32) ? 1 : 0;
    return { lag: best, v, nac: bv };
  }

  /* ---------------- scalar quantizers ---------------- */
  /* mel-ish LSF spacing: quantize deltas between consecutive LSFs */
  const LSF_BITS_HI = [5, 5, 4, 4, 4, 4, 4, 4, 3, 3];   // 40 b (3200)
  const LSF_BITS_MID = [4, 4, 4, 4, 4, 3, 3, 3, 3, 3];  // 35 b (2600)
  const LSF_BITS_LO = [4, 4, 4, 4, 3, 3, 3, 3, 2, 2];   // 32 b (1600 superframe)
  const LSF_MIN = 0.02, LSF_MAX = 3.10;
  function qLsf(lsf, bitsTab) {
    const idx = [];
    let prev = 0;
    for (let i = 0; i < 10; i++) {
      const span = (LSF_MAX - prev) * 0.9;
      const levels = 1 << bitsTab[i];
      const d = clamp(lsf[i] - prev, LSF_MIN, span);
      const q = clamp(Math.round((d - LSF_MIN) / (span - LSF_MIN) * (levels - 1)), 0, levels - 1);
      idx.push(q);
      prev = prev + LSF_MIN + q / (levels - 1) * (span - LSF_MIN);
    }
    return idx;
  }
  function dqLsf(idx, bitsTab) {
    const lsf = new Float64Array(10);
    let prev = 0;
    for (let i = 0; i < 10; i++) {
      const span = (LSF_MAX - prev) * 0.9;
      const levels = 1 << bitsTab[i];
      prev = prev + LSF_MIN + idx[i] / (levels - 1) * (span - LSF_MIN);
      lsf[i] = prev;
    }
    return lsf;
  }
  /* pitch: 7 bits log over 20..160 samples */
  const qPitch = lag => clamp(Math.round(Math.log(lag / 20) / Math.log(160 / 20) * 127), 0, 127);
  const dqPitch = q => Math.round(20 * Math.pow(160 / 20, q / 127));
  /* gain: log rms, 5/6 bits over -66..0 dBFS */
  function qGain(rms, bits) {
    const db = 20 * Math.log10(rms + 1e-9);
    return clamp(Math.round((db + 66) / 66 * ((1 << bits) - 1)), 0, (1 << bits) - 1);
  }
  const dqGain = (q, bits) => Math.pow(10, (q / ((1 << bits) - 1) * 66 - 66) / 20);

  /* ---------------- Golay(24,12) ---------------- */
  const GOLAY_GEN = 0xAE3;          // x^11+x^10+x^6+x^5+x^4+x^2+1 (0xC75 rev ok)
  function golaySyn(v) {
    /* compute 11-bit syndrome of 23-bit word via polynomial division */
    let r = v;
    for (let i = 22; i >= 11; i--)
      if (r & (1 << i)) r ^= GOLAY_GEN << (i - 11);
    return r & 0x7FF;
  }
  function golayEncode(d12) {
    const chk = golaySyn((d12 & 0xFFF) << 11);
    let w = ((d12 & 0xFFF) << 11) | chk;      // 23-bit codeword
    /* overall parity -> 24 bits */
    let p = 0, t = w;
    while (t) { p ^= t & 1; t >>>= 1; }
    return (w << 1) | p;
  }
  const wt = v => { let c = 0; while (v) { c += v & 1; v >>>= 1; } return c; };
  function golayDecode(w24) {
    const w = (w24 >>> 1) & 0x7FFFFF;
    /* trap decoding: try syndrome weight patterns */
    let s = golaySyn(w);
    if (s === 0) return { data: (w >>> 11) & 0xFFF, errs: 0 };
    /* error in check bits only */
    if (wt(s) <= 3) return { data: (w >>> 11) & 0xFFF, errs: wt(s) };
    /* single data-bit trial + syndrome weight 2 */
    for (let i = 0; i < 23; i++) {
      const s2 = s ^ golaySyn(1 << i);
      if (wt(s2) <= 2) {
        const wf = (w ^ (1 << i)) ^ s2;
        return { data: (wf >>> 11) & 0xFFF, errs: 1 + wt(s2) };
      }
    }
    /* two data-bit trials + syndrome weight <= 1 */
    for (let i = 11; i < 23; i++)
      for (let j = i + 1; j < 23; j++) {
        const s2 = s ^ golaySyn((1 << i) | (1 << j));
        if (wt(s2) <= 1) {
          const wf = (w ^ (1 << i) ^ (1 << j)) ^ s2;
          return { data: (wf >>> 11) & 0xFFF, errs: 2 + wt(s2) };
        }
      }
    /* three data-bit trials */
    for (let i = 11; i < 23; i++)
      for (let j = i + 1; j < 23; j++)
        for (let k = j + 1; k < 23; k++) {
          if (golaySyn((1 << i) | (1 << j) | (1 << k)) === s) {
            const wf = w ^ (1 << i) ^ (1 << j) ^ (1 << k);
            return { data: (wf >>> 11) & 0xFFF, errs: 3 };
          }
        }
    return { data: (w >>> 11) & 0xFFF, errs: -1 };   // uncorrectable
  }

  /* =====================================================================
     bit packing
     ===================================================================== */
  class BitWriter {
    constructor() { this.bits = []; }
    put(v, n) { for (let i = n - 1; i >= 0; i--) this.bits.push((v >> i) & 1); }
    get length() { return this.bits.length; }
  }
  class BitReader {
    constructor(bits) { this.bits = bits; this.p = 0; }
    get(n) { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | (this.bits[this.p++] & 1); return v; }
  }

  /* =====================================================================
     modes
     ===================================================================== */
  const MODES = {
    dv1600: {
      label: "DV-1600 · DQPSK · SSB + FM", vbps: 1600, lsfBits: LSF_BITS_LO,
      lsfPerFrame: false, bandVoice: false, gainBits: 6,
      net: 64, gross: 76, modem: "psk", pskBits: 2,
      note: "the workhorse — 22 carriers in 600\u20132700 Hz, fits any voice channel"
    },
    dv2600: {
      label: "DV-2600 · D8PSK · quiet channels", vbps: 2600, lsfBits: LSF_BITS_MID,
      lsfPerFrame: true, bandVoice: false, gainBits: 5,
      net: 104, gross: 116, modem: "psk", pskBits: 3,
      note: "same bandwidth, better voice \u2014 needs a clean, full-quieting path"
    },
    dv3200f: {
      label: "DV-3200F · 4FSK · FM data jack", vbps: 3200, lsfBits: LSF_BITS_HI,
      lsfPerFrame: true, bandVoice: true, gainBits: 6,
      net: 128, gross: 140, modem: "fsk",
      note: "2000 Bd 4FSK through the 9k6 packet jack \u2014 the best voice quality"
    },
    /* FreeDV compatibility — real libcodec2 1.2.0 in WebAssembly */
    fdv700d: {
      label: "FreeDV 700D — compatibility", engine: "freedv", vbps: 700,
      note: "the current HF standard \u2014 OFDM + LDPC, works down to ~\u22122 dB SNR; interoperates with freedv-gui and DV rigs"
    },
    fdv700e: {
      label: "FreeDV 700E — compatibility", engine: "freedv", vbps: 700,
      note: "faster sync and fading tolerance than 700D, needs a few dB more"
    },
    fdv1600: {
      label: "FreeDV 1600 — compatibility", engine: "freedv", vbps: 1300,
      note: "the classic 16-carrier mode (Codec 2 1300 + Golay) \u2014 lots of legacy activity"
    },
    fdv700c: {
      label: "FreeDV 700C — compatibility", engine: "freedv", vbps: 700,
      note: "legacy diversity mode, still heard on 80/40 m"
    }
  };

  /* =====================================================================
     vocoder — encoder
     ===================================================================== */
  class VoiceEncoder {
    constructor(modeId) {
      this.m = MODES[modeId];
      this.res = new Float32Array(0);
      this.prevLag = 60;
      this.hist = new Float32Array(FRAME);       // analysis look-back
      this.frames = [];                          // pending encoded frames
      this.pre = 0;
    }
    _analyze(pcm) {
      /* pre-emphasis */
      const x = new Float64Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) {
        x[i] = pcm[i] - 0.94 * this.pre;
        this.pre = pcm[i];
      }
      /* window: current frame + look-back for a 240-sample Hamming */
      const win = new Float64Array(240);
      for (let i = 0; i < 80; i++) win[i] = this.hist[FRAME - 80 + i];
      for (let i = 0; i < FRAME; i++) win[80 + i] = x[i];
      for (let i = 0; i < 240; i++)
        win[i] *= 0.54 - 0.46 * Math.cos(2 * Math.PI * i / 239);
      const r = autocorr(win, ORDER);
      r[0] *= 1.0001;                            // white-noise correction
      for (let k = 1; k <= ORDER; k++)           // lag window (60 Hz)
        r[k] *= Math.exp(-0.5 * (2 * Math.PI * 60 * k / FS) ** 2);
      const { a } = levinson(r, ORDER);
      const lsf = lpcToLsf(a);
      const pt = pitchTrack(x, this.prevLag);
      this.prevLag = pt.v ? pt.lag : this.prevLag;
      let rms = 0;
      for (let i = 0; i < pcm.length; i++) rms += pcm[i] * pcm[i];
      rms = Math.sqrt(rms / pcm.length);
      /* 4-band voicing for the 3200 mode: normalized autocorr per band */
      let bv = pt.v ? 0xF : 0;
      if (this.m.bandVoice && pt.v) {
        bv = 1;                                   // low band voiced
        let lp = 0, hpE = 0, lpE = 0;
        for (let i = 0; i < x.length; i++) {
          lp = 0.6 * lp + 0.4 * x[i];
          lpE += lp * lp; hpE += (x[i] - lp) * (x[i] - lp);
        }
        const hf = hpE / (lpE + hpE + 1e-9);
        if (hf < 0.72) bv |= 2;
        if (hf < 0.5) bv |= 4;
        if (hf < 0.3) bv |= 8;
      }
      this.hist.set(Float32Array.from(x.slice(x.length - FRAME)));
      return { lsf, lag: pt.lag, v: pt.v, rms, bv };
    }
    /* feed 8 kHz pcm; returns array of superframe bit-arrays (gross, FEC'd) */
    feed(pcm) {
      const nb = new Float32Array(this.res.length + pcm.length);
      nb.set(this.res); nb.set(pcm, this.res.length);
      this.res = nb;
      const out = [];
      while (this.res.length >= FRAME) {
        this.frames.push(this._analyze(this.res.slice(0, FRAME)));
        this.res = this.res.slice(FRAME);
        if (this.frames.length === 2) {
          out.push(this._pack(this.frames[0], this.frames[1]));
          this.frames = [];
        }
      }
      return out;
    }
    _pack(fA, fB) {
      const m = this.m;
      const w = new BitWriter();
      const lsfB = qLsf(fB.lsf, m.lsfBits);
      for (let i = 0; i < 10; i++) w.put(lsfB[i], m.lsfBits[i]);
      if (m.lsfPerFrame) {
        const lsfA = qLsf(fA.lsf, m.lsfBits);
        for (let i = 0; i < 10; i++) w.put(lsfA[i], m.lsfBits[i]);
      }
      const p1 = qPitch(fA.lag), p2 = qPitch(fB.lag);
      const g1 = qGain(fA.rms, m.gainBits), g2 = qGain(fB.rms, m.gainBits);
      w.put(p1, 7); w.put(p2, 7);
      w.put(fA.v, 1); w.put(fB.v, 1);
      w.put(g1, m.gainBits); w.put(g2, m.gainBits);
      if (m.bandVoice) { w.put(fA.bv, 4); w.put(fB.bv, 4); w.put(0, 2); }
      while (w.length < m.net) w.put(0, 1);
      /* critical 12: voicing(2) + pitch MSBs(3+3) + gain MSBs(2+2) */
      const crit = (fA.v << 11) | (fB.v << 10) |
        (((p1 >> 4) & 7) << 7) | (((p2 >> 4) & 7) << 4) |
        (((g1 >> (m.gainBits - 2)) & 3) << 2) | ((g2 >> (m.gainBits - 2)) & 3);
      const cw = golayEncode(crit);
      w.put(cw & 0xFFF, 12);                     // parity+overall (low half)
      return w.bits.slice(0, m.gross);
    }
  }

  /* =====================================================================
     vocoder — decoder / synthesizer
     ===================================================================== */
  class VoiceDecoder {
    constructor(modeId) {
      this.m = MODES[modeId];
      this.prevLsf = null;
      this.excPhase = 0;
      this.mem = new Float64Array(ORDER);
      this.pfMemN = new Float64Array(ORDER);
      this.pfMemD = new Float64Array(ORDER);
      this.de = 0;
      this.noiseSeed = 12345;
      this.lastGood = null;
      this.badRun = 0;
    }
    _noise() {
      this.noiseSeed = (this.noiseSeed * 1103515245 + 12345) & 0x7fffffff;
      return this.noiseSeed / 0x40000000 - 1;
    }
    /* returns Float32Array(320) of 8 kHz voice, or null on hard loss */
    decode(bits) {
      const m = this.m;
      const r = new BitReader(bits);
      const lsfIdxB = [], lsfIdxA = [];
      for (let i = 0; i < 10; i++) lsfIdxB.push(r.get(m.lsfBits[i]));
      if (m.lsfPerFrame) for (let i = 0; i < 10; i++) lsfIdxA.push(r.get(m.lsfBits[i]));
      let p1 = r.get(7), p2 = r.get(7);
      let v1 = r.get(1), v2 = r.get(1);
      let g1 = r.get(m.gainBits), g2 = r.get(m.gainBits);
      let bv1 = 0xF, bv2 = 0xF;
      if (m.bandVoice) { bv1 = r.get(4); bv2 = r.get(4); r.get(2); }
      while (r.p < m.net) r.get(1);
      const parity = r.get(12);
      /* FEC check on the critical 12 */
      const crit = (v1 << 11) | (v2 << 10) |
        (((p1 >> 4) & 7) << 7) | (((p2 >> 4) & 7) << 4) |
        (((g1 >> (m.gainBits - 2)) & 3) << 2) | ((g2 >> (m.gainBits - 2)) & 3);
      const dec = golayDecode(((crit << 12) | parity) >>> 0);
      if (dec.errs < 0) {
        /* uncorrectable — repeat last frame, fade */
        this.badRun++;
        if (!this.lastGood || this.badRun > 6) return new Float32Array(320);
        const rep = this.lastGood;
        return this._synthPair(rep.lsfA, rep.lsfB, rep.p1, rep.p2,
          rep.v1, rep.v2, rep.g1 * 0.5, rep.g2 * 0.4, rep.bv1, rep.bv2);
      }
      this.badRun = 0;
      if (dec.errs > 0) {                         // FEC repaired: adopt fixes
        const c = dec.data;
        v1 = (c >> 11) & 1; v2 = (c >> 10) & 1;
        p1 = (p1 & 0x0F) | (((c >> 7) & 7) << 4);
        p2 = (p2 & 0x0F) | (((c >> 4) & 7) << 4);
        g1 = (g1 & ((1 << (m.gainBits - 2)) - 1)) | (((c >> 2) & 3) << (m.gainBits - 2));
        g2 = (g2 & ((1 << (m.gainBits - 2)) - 1)) | ((c & 3) << (m.gainBits - 2));
      }
      const lsfB = dqLsf(lsfIdxB, m.lsfBits);
      let lsfA;
      if (m.lsfPerFrame) lsfA = dqLsf(lsfIdxA, m.lsfBits);
      else {
        lsfA = new Float64Array(10);
        const pv = this.prevLsf || lsfB;
        for (let i = 0; i < 10; i++) lsfA[i] = 0.5 * (pv[i] + lsfB[i]);
      }
      this.prevLsf = lsfB;
      const G1 = dqGain(g1, m.gainBits), G2 = dqGain(g2, m.gainBits);
      this.lastGood = { lsfA, lsfB, p1: dqPitch(p1), p2: dqPitch(p2),
                        v1, v2, g1: G1, g2: G2, bv1, bv2 };
      return this._synthPair(lsfA, lsfB, dqPitch(p1), dqPitch(p2),
                             v1, v2, G1, G2, bv1, bv2);
    }
    _synthPair(lsfA, lsfB, lagA, lagB, vA, vB, gA, gB, bvA, bvB) {
      const out = new Float32Array(320);
      this._synth(out, 0, lsfA, lagA, vA, gA, bvA);
      this._synth(out, 160, lsfB, lagB, vB, gB, bvB);
      return out;
    }
    _synth(out, off, lsf, lag, v, gain, bv) {
      const a = lsfToLpc(lsf);
      /* excitation */
      const exc = new Float64Array(FRAME);
      if (v) {
        const nBands = bv === 0xF ? 4 : (bv & 8 ? 4 : bv & 4 ? 3 : bv & 2 ? 2 : 1);
        let lp = 0;
        const mix = nBands / 4;                   // voiced fraction of spectrum
        for (let i = 0; i < FRAME; i++) {
          this.excPhase++;
          let pulse = 0;
          if (this.excPhase >= lag) { this.excPhase = 0; pulse = Math.sqrt(lag); }
          /* split: pulses low, noise high, crossover set by band count */
          lp = (1 - 0.22 * mix) * lp + 0.22 * mix * pulse;
          exc[i] = lp * 2.2 + this._noise() * 0.9 * (1 - mix) + pulse * (mix > 0.9 ? 0.4 : 0);
        }
      } else {
        for (let i = 0; i < FRAME; i++) exc[i] = this._noise();
      }
      /* LPC synthesis */
      const y = new Float64Array(FRAME);
      for (let i = 0; i < FRAME; i++) {
        let s = exc[i];
        for (let k = 1; k <= ORDER; k++) s -= a[k] * this.mem[k - 1];
        for (let k = ORDER - 1; k > 0; k--) this.mem[k] = this.mem[k - 1];
        this.mem[0] = s;
        y[i] = s;
      }
      /* gain match */
      let rms = 0;
      for (let i = 0; i < FRAME; i++) rms += y[i] * y[i];
      rms = Math.sqrt(rms / FRAME) + 1e-9;
      const sc = gain / rms;
      /* postfilter A(z/0.6)/A(z/0.85) + de-emphasis */
      const gn = 0.6, gd = 0.85;
      for (let i = 0; i < FRAME; i++) {
        const xin = y[i] * sc;
        let num = xin;
        for (let k = 1; k <= ORDER; k++) num += a[k] * Math.pow(gn, k) * this.pfMemN[k - 1];
        let den = num;
        for (let k = 1; k <= ORDER; k++) den -= a[k] * Math.pow(gd, k) * this.pfMemD[k - 1];
        for (let k = ORDER - 1; k > 0; k--) {
          this.pfMemN[k] = this.pfMemN[k - 1];
          this.pfMemD[k] = this.pfMemD[k - 1];
        }
        this.pfMemN[0] = xin;
        this.pfMemD[0] = den;
        this.de = den + 0.94 * this.de;
        out[off + i] = clamp(this.de, -1.4, 1.4);
      }
    }
  }

  /* =====================================================================
     PSK modem — 50 Bd multicarrier differential PSK at 8 kHz
     23 carriers on a 100 Hz grid, 600–2800 Hz; slot 11 (1700 Hz) is a
     DBPSK pilot whose superframe marker is a repeated phase.
     ===================================================================== */
  const PSK_SYM = 160;                     // 20 ms at 8 kHz
  const PSK_BINS = [];
  for (let i = 0; i < 23; i++) PSK_BINS.push(12 + 2 * i);   // 600..2800 Hz
  const PSK_PILOT = 11;

  class PskTx {
    constructor(bitsPerSym) {
      this.M = 1 << bitsPerSym;
      this.bps = bitsPerSym;
      this.phase = new Float64Array(23);
      this.gray = this.M === 4 ? [0, 1, 3, 2] : [0, 1, 3, 2, 6, 7, 5, 4];
    }
    /* superframe bits (gross, padded internally) -> Float32Array(320) */
    modulate(bits) {
      const capacity = 22 * this.bps * 2;
      const b = bits.slice();
      let pn = 0xACE1;
      while (b.length < capacity) {        // PN pad
        pn = ((pn >> 1) ^ (-(pn & 1) & 0xB400)) & 0xFFFF;
        b.push(pn & 1);
      }
      const out = new Float32Array(2 * PSK_SYM);
      let bp = 0;
      for (let sym = 0; sym < 2; sym++) {
        for (let c = 0; c < 23; c++) {
          if (c === PSK_PILOT) {
            this.phase[c] += sym === 0 ? 0 : Math.PI;   // marker, then flip
          } else {
            let v = 0;
            for (let k = 0; k < this.bps; k++) v = (v << 1) | b[bp++];
            const g = this.gray[v];
            this.phase[c] += (2 * Math.PI * g) / this.M + Math.PI / this.M;
          }
        }
        for (let i = 0; i < PSK_SYM; i++) {
          let sacc = 0;
          const t = i / FS;
          for (let c = 0; c < 23; c++) {
            const f = PSK_BINS[c] * 50;
            const amp = c === PSK_PILOT ? 1.35 : 1.0;
            sacc += amp * Math.cos(2 * Math.PI * f * t + this.phase[c]);
          }
          out[sym * PSK_SYM + i] = sacc * 0.052;
        }
        /* keep phases continuous into the next symbol */
        for (let c = 0; c < 23; c++) {
          const f = PSK_BINS[c] * 50;
          this.phase[c] = (this.phase[c] + 2 * Math.PI * f * PSK_SYM / FS) % (2 * Math.PI);
        }
      }
      return out;
    }
  }

  class PskRx {
    constructor(bitsPerSym, onSuperframe) {
      this.M = 1 << bitsPerSym;
      this.bps = bitsPerSym;
      this.onSF = onSuperframe;            // (bits[], meta)
      this.buf = new Float32Array(0);
      this.off = 0;                        // sample offset of next symbol
      this.locked = false;
      this.prev = null;                    // previous symbol bin phases
      this.symIdx = 0;                     // position within superframe
      this.pending = [];                   // demapped symbol bit groups
      this.quality = 0;
      this.grayInv = [];
      const g = this.M === 4 ? [0, 1, 3, 2] : [0, 1, 3, 2, 6, 7, 5, 4];
      g.forEach((v, i) => { this.grayInv[v] = i; });
      this._searchCnt = 0;
    }
    _dft(at) {
      /* complex bins at PSK_BINS for the 160 samples starting at `at` */
      const re = new Float64Array(23), im = new Float64Array(23);
      for (let c = 0; c < 23; c++) {
        const w = 2 * Math.PI * PSK_BINS[c] / PSK_SYM;
        let cr = 0, ci = 0;
        for (let i = 0; i < PSK_SYM; i++) {
          const x = this.buf[at + i];
          cr += x * Math.cos(w * i);
          ci -= x * Math.sin(w * i);
        }
        re[c] = cr; im[c] = ci;
      }
      return { re, im };
    }
    _metric(at) {
      /* data: M-power coherence over 3 pairs; pilot: 2-power over 6 pairs
         (the pilot is 2.6 dB hotter and BPSK, so it stays coherent at
         SNRs where the 4th power of the data phases is already mush) */
      let mr = 0, mi = 0, pr = 0, pi = 0;
      let prev = this._dft(at);
      for (let s = 1; s <= 6; s++) {
        const cur = this._dft(at + s * PSK_SYM);
        if (s <= 3)
          for (let c = 0; c < 23; c++) {
            if (c === PSK_PILOT) continue;
            const dr = cur.re[c] * prev.re[c] + cur.im[c] * prev.im[c];
            const di = cur.im[c] * prev.re[c] - cur.re[c] * prev.im[c];
            const ang = Math.atan2(di, dr) * this.M;
            if (Math.hypot(dr, di) > 1e-9) { mr += Math.cos(ang); mi += Math.sin(ang); }
          }
        const c = PSK_PILOT;
        const dr = cur.re[c] * prev.re[c] + cur.im[c] * prev.im[c];
        const di = cur.im[c] * prev.re[c] - cur.re[c] * prev.im[c];
        const ang2 = Math.atan2(di, dr) * 2;
        if (Math.hypot(dr, di) > 1e-9) { pr += Math.cos(ang2); pi += Math.sin(ang2); }
        prev = cur;
      }
      return { data: Math.hypot(mr, mi) / (3 * 22),
               pilot: Math.hypot(pr, pi) / 6 };
    }
    feed(samples) {
      const nb = new Float32Array(this.buf.length + samples.length);
      nb.set(this.buf); nb.set(samples, this.buf.length);
      this.buf = nb;
      if (!this.locked) this._acquire();
      while (this.locked && this.buf.length >= this.off + 2 * PSK_SYM)
        this._symbol();
      /* trim */
      const keep = Math.max(0, this.off - PSK_SYM);
      if (keep > 0) {
        this.buf = this.buf.slice(keep);
        this.off -= keep;
      }
      if (this.buf.length > FS * 4) {      // runaway guard
        this.buf = this.buf.slice(this.buf.length - FS);
        this.off = 0; this.locked = false; this.prev = null;
      }
    }
    _acquire() {
      if (this.buf.length < 8 * PSK_SYM) return;
      const lim = Math.min(this.buf.length - 7 * PSK_SYM - 4, 12 * PSK_SYM);
      const vals = [];
      let best = null, bestAt = 0;
      for (let at = 0; at < lim; at += 4) {
        const m = this._metric(at);
        vals.push(m.data);
        if (!best || m.data > best.data) { best = m; bestAt = at; }
      }
      if (!best) return;
      vals.sort((a, b) => a - b);
      const med = vals[vals.length >> 1] + 1e-6;
      const strong = best.pilot > 0.85 && best.data > 0.55;   // clean signal fast-path
      if (!strong && !(best.pilot > 0.5 && best.data > Math.max(0.16, 2.4 * med))) {
        const keep = 8 * PSK_SYM + 12 * PSK_SYM;
        if (this.buf.length > keep) this.buf = this.buf.slice(this.buf.length - keep);
        return;
      }
      for (let at = Math.max(0, bestAt - 3); at <= bestAt + 3; at++) {
        const m = this._metric(at);
        if (m.data > best.data) { best = m; bestAt = at; }
      }
      this.off = bestAt;
      this.locked = true;
      this.prev = null;
      this.symIdx = -1;                    // unknown until pilot marker
      this.pending = [];
      this.phCorr = 0;
      this.quality = Math.min(1, best.data + 0.2);
    }
    _symbol() {
      const cur = this._dft(this.off);
      if (this.prev) {
        /* pilot: dphi ~0 = superframe start, ~pi = second symbol; its
           deviation from {0, pi} is the common rotation (carrier offset)
           shared by every carrier — measure it and take it out. */
        const c = PSK_PILOT;
        const dr = cur.re[c] * this.prev.re[c] + cur.im[c] * this.prev.im[c];
        const di = cur.im[c] * this.prev.re[c] - cur.re[c] * this.prev.im[c];
        const markerObs = dr > 0;          // |dphi| < pi/2
        /* flywheel: markers alternate strictly (2-symbol superframes), so
           once framed, trust the rhythm; resync only after two consecutive
           disagreements — a single noisy pilot can no longer misframe us */
        let marker;
        if (this.symIdx === -1) {
          marker = markerObs;
          this._mDis = 0;
        } else {
          const expected = this.symIdx === 1;
          if (markerObs === expected) { this._mDis = 0; marker = expected; }
          else if (++this._mDis >= 2) { this._mDis = 0; marker = markerObs; }
          else marker = expected;
        }
        let dphiP = Math.atan2(di, dr);
        if (!marker) dphiP -= Math.sign(dphiP) * Math.PI;   // fold to ±pi/2
        if (this.phCorr === undefined) this.phCorr = 0;
        this.phCorr += 0.18 * (dphiP - this.phCorr);
        if (marker) { this.symIdx = 0; this.pending = []; }
        else if (this.symIdx === 0) this.symIdx = 1;
        /* data carriers */
        if (this.symIdx >= 0) {
          const group = [];
          let qacc = 0;
          for (let k = 0; k < 23; k++) {
            if (k === PSK_PILOT) continue;
            const r2 = cur.re[k] * this.prev.re[k] + cur.im[k] * this.prev.im[k];
            const i2 = cur.im[k] * this.prev.re[k] - cur.re[k] * this.prev.im[k];
            let ang = Math.atan2(i2, r2) - this.phCorr - Math.PI / this.M;
            const step = 2 * Math.PI / this.M;
            let idx = Math.round(ang / step);
            const res = ang - idx * step;
            idx = ((idx % this.M) + this.M) % this.M;
            qacc += 1 - Math.abs(res) / (step / 2);
            const v = this.grayInv[idx];
            for (let b = this.bps - 1; b >= 0; b--) group.push((v >> b) & 1);
          }
          this.quality = 0.9 * this.quality + 0.1 * (qacc / 22);
          this.pending.push(group);
          if (this.symIdx === 1 && this.pending.length === 2) {
            if (this.quality > 0.28)
              this.onSF(this.pending[0].concat(this.pending[1]),
                        { quality: this.quality });
            this.pending = [];
            this.symIdx = -1;
          } else if (this.pending.length > 2) {
            this.pending = []; this.symIdx = -1;
          }
        }
        if (this.quality < 0.25) { this.locked = false; this.prev = null; return; }
        /* slow timing maintenance every 16 symbols */
        if (!this._tm) this._tm = 0;
        if (++this._tm >= 16) {
          this._tm = 0;
          const base = Math.max(0, this.off - 7 * PSK_SYM);
          const m0 = this._metric(base).data;
          const mE = this._metric(Math.max(0, base - 2)).data;
          const mL = this._metric(base + 2).data;
          if (mE > m0 && mE > mL) this.off -= 1;
          else if (mL > m0 && mL > mE) this.off += 1;
        }
      }
      this.prev = cur;
      this.off += PSK_SYM;
    }
  }

  /* =====================================================================
     4FSK modem — 2000 Bd, tones 1000/3000/5000/7000 Hz, any sample rate
     superframe: 8-dibit sync word + 72 payload dibits (40 ms)
     ===================================================================== */
  const FSK_TONES = [1000, 3000, 5000, 7000];
  const FSK_BAUD = 2000;
  const FSK_SYNC = [3, 1, 2, 0, 0, 2, 1, 3];        // dibit sync word
  const FSK_GRAY = [0, 1, 3, 2];
  const FSK_PAYLOAD = 72;

  class FskTx {
    constructor(fs) { this.fs = fs; this.phase = 0; }
    modulate(bits) {
      const dib = FSK_SYNC.slice();
      let pn = 0x1DEA;
      const b = bits.slice();
      while (b.length < FSK_PAYLOAD * 2) {
        pn = ((pn >> 1) ^ (-(pn & 1) & 0xB400)) & 0xFFFF;
        b.push(pn & 1);
      }
      for (let i = 0; i < FSK_PAYLOAD; i++)
        dib.push(FSK_GRAY[(b[2 * i] << 1) | b[2 * i + 1]]);
      const spb = this.fs / FSK_BAUD;
      const n = Math.ceil(dib.length * spb);
      const out = new Float32Array(n);
      let p = 0, tNext = 0;
      for (const d of dib) {
        tNext += spb;
        const end = Math.round(tNext);
        const w = 2 * Math.PI * FSK_TONES[d] / this.fs;
        while (p < end) {
          out[p++] = 0.6 * Math.sin(this.phase);
          this.phase += w;
          if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
        }
      }
      return out.subarray(0, p);
    }
  }

  class FskRx {
    constructor(fs, onSuperframe) {
      this.fs = fs;
      this.onSF = onSuperframe;
      this.spb = fs / FSK_BAUD;
      this.N = Math.round(this.spb);
      this.ring = new Float64Array(1 << Math.ceil(Math.log2(this.spb * 4 + 8)));
      this.mask = this.ring.length - 1;
      this.w = 0;
      this.phase = this.spb;
      this.ws = FSK_TONES.map(f => 2 * Math.PI * f / fs);
      this.agc = [0.1, 0.1, 0.1, 0.1];
      this.hist = [];                       // decided dibits
      this.locked = false;
      this.frameAt = 0;                     // dibits until frame complete
      this.payload = [];
      this.quality = 0;
      this._pending = 0;
      this._lastTone = 0;
    }
    _mags(endIdx) {
      const m = [0, 0, 0, 0];
      const start = endIdx - this.N;
      for (let t = 0; t < 4; t++) {
        let cr = 0, ci = 0;
        const w = this.ws[t];
        for (let i = 0; i < this.N; i++) {
          const k = start + i;
          const x = this.ring[k & this.mask];
          cr += x * Math.cos(w * k); ci += x * Math.sin(w * k);
        }
        m[t] = Math.hypot(cr, ci);
      }
      return m;
    }
    feed(samples) {
      const half = this.spb / 2;
      for (let i = 0; i < samples.length; i++) {
        this.ring[this.w & this.mask] = samples[i];
        this.w++;
        if (--this.phase <= 0) { this.phase += this.spb; this._pending = this.w; }
        if (this._pending && this.w >= this._pending + half) {
          this._decide(this._pending);
          this._pending = 0;
        }
      }
    }
    _decide(end) {
      const m = this._mags(end);
      let best = 0, second = 0, tone = 0;
      const norm = [];
      for (let t = 0; t < 4; t++) {
        this.agc[t] = Math.max(this.agc[t] * 0.999, this.agc[t] * 0.94 + m[t] * 0.06);
        norm[t] = m[t] / (this.agc[t] + 1e-9);
        if (norm[t] > best) { second = best; best = norm[t]; tone = t; }
        else if (norm[t] > second) second = norm[t];
      }
      const conf = best - second;
      this.quality = 0.97 * this.quality + 0.03 * Math.min(conf, 1.2);
      /* transition DPLL, same principle as the APRS demod */
      if (tone !== this._lastTone && conf > 0.1) {
        const mm = this._mags(end - Math.round(this.spb / 2));
        let mt = 0, mtv = -1;
        for (let t = 0; t < 4; t++) {
          const v = mm[t] / (this.agc[t] + 1e-9);
          if (v > mtv) { mtv = v; mt = t; }
        }
        this.phase += (mt === tone ? -0.08 : 0.08) * this.spb;
      }
      this._lastTone = tone;
      this._dibit(tone);
    }
    _dibit(d) {
      if (!this.locked) {
        this.hist.push(d);
        if (this.hist.length > 8) this.hist.shift();
        if (this.hist.length === 8) {
          let err = 0;
          for (let i = 0; i < 8; i++) if (this.hist[i] !== FSK_SYNC[i]) err++;
          if (err === 0) {
            this.locked = true;
            this.payload = [];
            this.frameAt = FSK_PAYLOAD;
          }
        }
        return;
      }
      this.payload.push(d);
      if (--this.frameAt === 0) {
        const bits = [];
        for (const dd of this.payload) {
          const v = FSK_GRAY.indexOf(dd);
          bits.push((v >> 1) & 1, v & 1);
        }
        this.onSF(bits, { quality: this.quality });
        this.locked = false;
        this.hist = [];
        if (this.quality < 0.12) this.hist = [];
      }
    }
  }

  /* ---------------- channel sim (loopback lab) ---------------- */
  class DvChannel {
    constructor(fs, opts) {
      const o = opts || {};
      this.fs = fs;
      this.snrDb = o.snrDb === undefined ? null : o.snrDb;
      this.gain = o.gain === undefined ? 0.5 : o.gain;
      let seed = (o.seed | 0) || 1;
      this.rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
      const fHi = o.fHi || 3000, fLo = o.fLo === undefined ? 250 : o.fLo;
      const nt = 121, mid = 60;
      this.h = new Float64Array(nt);
      let hs = 0;
      for (let i = 0; i < nt; i++) {
        const x = i - mid;
        const sc = x === 0 ? 2 * fHi / fs : Math.sin(2 * Math.PI * fHi / fs * x) / (Math.PI * x);
        const r = 2 * i / (nt - 1) - 1;
        this.h[i] = sc * (0.54 - 0.46 * Math.cos(Math.PI * (r + 1)));
        hs += this.h[i];
      }
      for (let i = 0; i < nt; i++) this.h[i] /= hs;
      this.zi = new Float64Array(nt - 1);
      this.hpA = Math.exp(-2 * Math.PI * fLo / fs);
      this.hx = 0; this.hy = 0;
      this.sigP = (0.36 * this.gain) ** 2;
    }
    _gauss() {
      const u1 = Math.max(this.rnd(), 1e-12), u2 = this.rnd();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    }
    process(x) {
      const y = Float64Array.from(x);
      const a = this.hpA;
      let x1 = this.hx, y1 = this.hy;
      for (let i = 0; i < y.length; i++) {
        const v = a * (y1 + y[i] - x1);
        x1 = y[i]; y[i] = v; y1 = v;
      }
      this.hx = x1; this.hy = y1;
      const nh = this.h.length;
      const b = new Float64Array(this.zi.length + y.length);
      b.set(this.zi); b.set(y, this.zi.length);
      const out = new Float64Array(y.length);
      for (let i = 0; i < y.length; i++) {
        let s2 = 0;
        for (let j = 0; j < nh; j++) s2 += b[i + j] * this.h[nh - 1 - j];
        out[i] = s2 * this.gain;
      }
      this.zi = b.slice(b.length - (nh - 1));
      if (this.snrDb !== null) {
        /* calibrate against the actual filtered signal power (mid region,
           away from silence padding) so the SNR label is truthful for any
           waveform — multicarrier PSK, 4FSK and FreeDV all have different
           crest factors */
        let pw = 0, cnt = 0;
        for (let i = out.length >> 2; i < (3 * out.length) >> 2; i++) {
          pw += out[i] * out[i]; cnt++;
        }
        const sig = cnt && pw / cnt > 1e-8 ? pw / cnt : this.sigP;
        const nP = Math.sqrt(sig / Math.pow(10, this.snrDb / 10));
        for (let i = 0; i < out.length; i++) out[i] += this._gauss() * nP;
      }
      return Float32Array.from(out);
    }
  }

  /* =====================================================================
     TX / RX pipelines
     ===================================================================== */
  class DvTx {
    constructor(modeId, ioRate) {
      this.m = MODES[modeId];
      this.enc = new VoiceEncoder(modeId);
      this.down = new Resamp(ioRate, FS);
      if (this.m.modem === "psk") {
        this.psk = new PskTx(this.m.pskBits);
        this.up = new Resamp(FS, ioRate);
      } else {
        this.fsk = new FskTx(ioRate);
      }
    }
    /* mic samples at ioRate -> modulated audio at ioRate (may be empty) */
    feedMic(samples) {
      const pcm8 = this.down.process(samples);
      const sfs = this.enc.feed(pcm8);
      if (!sfs.length) return new Float32Array(0);
      const parts = [];
      for (const bits of sfs) {
        if (this.psk) parts.push(this.up.process(this.psk.modulate(bits)));
        else parts.push(this.fsk.modulate(bits));
      }
      let total = 0;
      for (const p of parts) total += p.length;
      const out = new Float32Array(total);
      let p = 0;
      for (const pt of parts) { out.set(pt, p); p += pt.length; }
      return out;
    }
    flush(ioRate) {
      /* push through one silent superframe to complete any partial frame */
      return this.feedMic(new Float32Array(Math.ceil(ioRate * 0.06)));
    }
  }

  class DvRx {
    constructor(modeId, ioRate, onVoice) {
      this.m = MODES[modeId];
      this.dec = new VoiceDecoder(modeId);
      this.onVoice = onVoice;               // (pcm8k Float32Array(320))
      this.superframes = 0;
      this.fecFixed = 0;
      this.fecFail = 0;
      this.level = -90;
      const onSF = (bits, meta) => {
        this.superframes++;
        this.quality = meta.quality;
        const before = this.dec.badRun;
        const voice = this.dec.decode(bits.slice(0, this.m.gross));
        if (this.dec.badRun > before) this.fecFail++;
        if (voice) this.onVoice(voice);
      };
      if (this.m.modem === "psk") {
        this.down = new Resamp(ioRate, FS);
        this.mdm = new PskRx(this.m.pskBits, onSF);
      } else {
        this.mdm = new FskRx(ioRate, onSF);
      }
      this.quality = 0;
    }
    get locked() { return !!(this.mdm.locked || (this.mdm.quality > 0.4)); }
    feed(samples) {
      let acc = 0;
      for (let i = 0; i < samples.length; i++) acc += samples[i] * samples[i];
      if (samples.length)
        this.level = 20 * Math.log10(Math.sqrt(acc / samples.length) + 1e-10);
      this.mdm.feed(this.down ? this.down.process(samples) : samples);
    }
  }

  /* ---------------- FreeDV pipelines (WASM engine) ---------------- */
  class FdvTx {
    constructor(handle, ioRate) {
      this.h = handle;
      this.down = new Resamp(ioRate, FS);
      this.up = new Resamp(FS, ioRate);
      this.acc = new Float32Array(0);
    }
    feedMic(samples) {
      const pcm8 = this.down.process(samples);
      const nb = new Float32Array(this.acc.length + pcm8.length);
      nb.set(this.acc); nb.set(pcm8, this.acc.length);
      this.acc = nb;
      const parts = [];
      while (this.acc.length >= this.h.nSpeech) {
        parts.push(this.up.process(
          this.h.txFrame(this.acc.subarray(0, this.h.nSpeech))));
        this.acc = this.acc.slice(this.h.nSpeech);
      }
      if (!parts.length) return new Float32Array(0);
      let total = 0;
      for (const p of parts) total += p.length;
      const out = new Float32Array(total);
      let p = 0;
      for (const pt of parts) { out.set(pt, p); p += pt.length; }
      return out;
    }
    flush(ioRate) {
      return this.feedMic(new Float32Array(
        Math.ceil(ioRate * (this.h.nSpeech / FS) * 1.1)));
    }
  }

  class FdvRx {
    constructor(handle, ioRate, onVoice) {
      this.h = handle;
      this.down = new Resamp(ioRate, FS);
      this.onVoice = onVoice;
      this.superframes = 0;
      this.fecFail = 0;
      this.level = -90;
      this.quality = 0;
      this.snr = -99;
      this.sync = 0;
      this.mdm = { locked: false, quality: 0 };
    }
    get locked() { return !!this.sync; }
    feed(samples) {
      let acc = 0;
      for (let i = 0; i < samples.length; i++) acc += samples[i] * samples[i];
      if (samples.length)
        this.level = 20 * Math.log10(Math.sqrt(acc / samples.length) + 1e-10);
      const r = this.h.rxChunk(this.down.process(samples));
      this.sync = r.sync;
      this.snr = r.snr;
      this.superframes += r.frames && r.sync ? r.frames : 0;
      if (r.frames && !r.sync) this.fecFail += r.frames;
      this.quality = r.sync
        ? clamp((r.snr + 5) / 25, 0.05, 1)
        : this.quality * 0.8;
      this.mdm.locked = !!r.sync;
      this.mdm.quality = this.quality;
      if (r.voice.length && r.sync) this.onVoice(r.voice);
    }
  }

  /* ---------------- synthetic talker (tests / loopback demo) -------- */
  function makeTalker(seconds, seed) {
    const n = Math.round(FS * seconds);
    const out = new Float32Array(n);
    let s = (seed | 0) || 7;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x40000000 - 1; };
    const FORM = [[730, 1090], [270, 2290], [530, 1840], [660, 1720], [300, 870]];
    let f0 = 110, ph = 0, seg = 0, segLeft = 0, voiced = true;
    let b1 = [0, 0], b2 = [0, 0], fA = 700, fB = 1100, env = 0;
    for (let i = 0; i < n; i++) {
      if (--segLeft <= 0) {
        seg++;
        voiced = seg % 4 !== 3;
        segLeft = Math.round(FS * (voiced ? 0.14 : 0.06));
        const F = FORM[seg % FORM.length];
        fA = F[0]; fB = F[1];
        f0 = 95 + 40 * Math.abs(Math.sin(seg * 1.3));
      }
      let exc;
      if (voiced) {
        ph += f0 / FS;
        exc = ph >= 1 ? (ph -= 1, 1.6) : -0.02;
        env = Math.min(1, env + 0.002);
      } else {
        exc = rnd() * 0.35;
        env = Math.max(0.35, env - 0.003);
      }
      /* two formant resonators */
      const r = 0.94;
      const filt = (bq, f, x) => {
        const w = 2 * Math.PI * f / FS;
        const y = x + 2 * r * Math.cos(w) * bq[0] - r * r * bq[1];
        bq[1] = bq[0]; bq[0] = y;
        return y * (1 - r);
      };
      out[i] = clamp((filt(b1, fA, exc) + 0.7 * filt(b2, fB, exc)) * env * 0.55, -1, 1);
    }
    return out;
  }

  /* ---------------- WAV (mono) ---------------- */
  function wavEncode16(samples, rate) {
    const dataSz = samples.length * 2;
    const buf = new ArrayBuffer(44 + dataSz);
    const dv = new DataView(buf);
    const ws = (p, str) => { for (let i = 0; i < str.length; i++) dv.setUint8(p + i, str.charCodeAt(i)); };
    ws(0, "RIFF"); dv.setUint32(4, 36 + dataSz, true); ws(8, "WAVE");
    ws(12, "fmt "); dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true);
    dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    ws(36, "data"); dv.setUint32(40, dataSz, true);
    for (let i = 0; i < samples.length; i++)
      dv.setInt16(44 + i * 2, Math.round(clamp(samples[i], -1, 1) * 32767), true);
    return buf;
  }
  function wavDecode(buf) {
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
                rate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
      else if (id === 0x64617461)
        data = { off: body, sz: Math.min(sz, dv.byteLength - body) };
      pos = body + sz + (sz & 1);
    }
    if (!fmt || !data) throw new Error("missing fmt/data chunk");
    const bytes = fmt.bits >> 3, nch = fmt.ch;
    const isFloat = fmt.tag === 3 && fmt.bits === 32;
    if (!isFloat && fmt.tag !== 1) throw new Error("unsupported WAV tag " + fmt.tag);
    const n = Math.floor(data.sz / (bytes * nch));
    const out = new Float32Array(n);
    let p = data.off;
    for (let i = 0; i < n; i++) {
      let v;
      if (isFloat) v = dv.getFloat32(p, true);
      else if (fmt.bits === 16) v = dv.getInt16(p, true) / 32768;
      else if (fmt.bits === 24) {
        let u = dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getUint8(p + 2) << 16);
        if (u >= 0x800000) u -= 0x1000000;
        v = u / 8388608;
      } else if (fmt.bits === 32) v = dv.getInt32(p, true) / 2147483648;
      else if (fmt.bits === 8) v = (dv.getUint8(p) - 128) / 128;
      else throw new Error("unsupported width " + fmt.bits);
      out[i] = v;
      p += bytes * nch;
    }
    return { rate: fmt.rate, samples: out };
  }

  /* =====================================================================
     Browser shell
     ===================================================================== */
  const LS_KEY = "hrws-dv";
  /* per-mode SNR squelch defaults, matching freedv-gui's conventions */
  const SQL_DEF = { fdv700d: -2, fdv700e: 1, fdv1600: 2, fdv700c: 2 };
  function loadPrefs() {
    try { return Object.assign({ mode: "dv1600", vox: false, voxThr: -32,
        sql: false, sqlThr: null },
      JSON.parse(localStorage.getItem(LS_KEY) || "{}")); }
    catch { return { mode: "dv1600", vox: false, voxThr: -32, sql: false, sqlThr: null }; }
  }

  const def = {
    id: "digivoice",

    init(ctx) {
      this.ctx = ctx;
      this.prefs = loadPrefs();
      this.tx = null;
      this.rx = null;
      this._txStr = null;
      this._rxStr = null;
      this.armed = false;
      this.ptt = false;
      this.lock = false;
      this.voxOpen = false;
      this.voxUntil = 0;
      this.micLevel = -90;
      this.pollTimer = null;
      this._busy = false;
      this._fdv = null;
      this._fdvLoading = null;
      this._txH = null;
      this._rxH = null;
      if (!this._subscribed) {
        this._subscribed = true;
        ctx.audio.onSamples((ch0, sr) => this._onAudio(ch0, sr));
      }
    },

    _txActive() { return this.ptt || this.lock || (this.prefs.vox && this.voxOpen); },

    _isFdv(id) { return MODES[id || this.prefs.mode].engine === "freedv"; },
    _ensureFdv() {
      if (this._fdv) return Promise.resolve(this._fdv);
      if (!this._fdvLoading) {
        this._fdvLoading = new Promise((res, rej) => {
          const go = () => window.FreeDVEngine()
            .then(e => { this._fdv = e; res(e); }, rej);
          if (window.FreeDVEngine) return go();
          const sc = document.createElement("script");
          sc.src = "modules/digivoice/freedv.js";
          sc.onload = go;
          sc.onerror = () => rej(new Error("freedv.js failed to load"));
          document.head.appendChild(sc);
        });
        this._fdvLoading.then(
          () => this._mon("FreeDV engine loaded — libcodec2 1.2.0 (WASM)"),
          e => { this._fdvLoading = null; this.ctx.log("FreeDV engine: " + e.message); });
      }
      return this._fdvLoading;
    },
    _closeH(which) {
      if (this[which]) { try { this[which].close(); } catch {} this[which] = null; }
    },

    _onAudio(ch0, sr) {
      /* mic level always (drives VOX + meter) */
      let acc = 0;
      for (let i = 0; i < ch0.length; i++) acc += ch0[i] * ch0[i];
      this.micLevel = 20 * Math.log10(Math.sqrt(acc / ch0.length) + 1e-10);
      if (this.prefs.vox && !this.lock && !this.ptt) {
        const now = performance.now();
        if (this.micLevel > this.prefs.voxThr) this.voxUntil = now + 700;
        this.voxOpen = now < this.voxUntil;
      } else this.voxOpen = false;
      const txOn = this._txActive();
      if (txOn) {
        if (!this.tx || this.tx.rate !== sr || this.tx.modeId !== this.prefs.mode) {
          if (this._isFdv()) {
            if (!this._fdv) { this._ensureFdv(); return; }   // wait for engine
            this._closeH("_txH");
            this._txH = this._fdv.open(this.prefs.mode);
            this.tx = new FdvTx(this._txH, sr);
          } else {
            this.tx = new DvTx(this.prefs.mode, sr);
          }
          this.tx.rate = sr; this.tx.modeId = this.prefs.mode;
        }
        const audio = this.tx.feedMic(ch0);
        if (audio.length) this._txPush(audio, sr);
        this._wasTx = true;
      } else {
        if (this._wasTx && this.tx) {           // key-up tail
          const tail = this.tx.flush(sr);
          if (tail.length) this._txPush(tail, sr);
          this._endStream("_txStr");
          this._wasTx = false;
        }
        if (this.armed && this.rx) this.rx.feed(ch0);   // half duplex
      }
    },

    /* ---- gapless live playback plumbing (engine TX streams) ----
       Repeated playPCM() calls kill each other; streams schedule every
       chunk back-to-back on the audio clock instead. */
    _push(slot, chunk, sr, lead, monitor) {
      let st = this[slot];
      if (!st || st.closed || st.rate !== sr)
        st = this[slot] = monitor
          ? this.ctx.audio.openMonitorStream(sr, lead || undefined)
          : this.ctx.audio.openTXStream(sr, lead || undefined);
      st.push(chunk);
    },
    _txPush(chunk, sr) { this._push("_txStr", chunk, sr); },
    _endStream(slot) {
      if (this[slot]) { try { this[slot].close(); } catch (e) {} this[slot] = null; }
    },

    _sqlEff() {
      return this.prefs.sqlThr !== null && this.prefs.sqlThr !== undefined
        ? this.prefs.sqlThr : (SQL_DEF[this.prefs.mode] !== undefined ? SQL_DEF[this.prefs.mode] : 0);
    },
    _applySquelchTo(handle) {
      if (handle) { try { handle.squelch(!!this.prefs.sql, this._sqlEff()); } catch {} }
    },
    _mkRx(sr) {
      // Decoded voice arrives one superframe at a time; a TX stream
      // (slightly longer cushion — decode timing breathes) plays them
      // seamlessly instead of each chunk cutting off the last.
      const play = (pcm8) => this._push("_rxStr", pcm8, FS, 0.35, true);   // local ears only — never the TX rail
      if (this._isFdv()) {
        if (!this._fdv) return null;
        this._closeH("_rxH");
        this._rxH = this._fdv.open(this.prefs.mode);
        this._applySquelchTo(this._rxH);
        return new FdvRx(this._rxH, sr, play);
      }
      return new DvRx(this.prefs.mode, sr, play);
    },

    createPanel(el) {
      const opt = (id) => `<option value="${id}"${id === this.prefs.mode ? " selected" : ""}>${MODES[id].label}</option>`;
      const modeOpts =
        `<optgroup label="HRWS native (studio-to-studio)">` +
        ["dv1600", "dv2600", "dv3200f"].map(opt).join("") + `</optgroup>` +
        `<optgroup label="FreeDV — compatibility (real Codec 2, WASM)">` +
        ["fdv700d", "fdv700e", "fdv1600", "fdv700c"].map(opt).join("") + `</optgroup>`;
      el.innerHTML = `
        <div class="mod-layout">
          <div class="mod-main">
            <div class="card">
              <header class="card-head"><h3>Digital voice — HRWS-DV</h3>
                <span class="card-tag mono" id="dv-state">idle</span></header>
              <div style="padding:14px;background:#0b0d10">
                <div id="dv-leds" style="display:flex;gap:12px;margin-bottom:10px"></div>
                <div class="mono" style="font-size:11px" id="dv-bars"></div>
                <div class="mono" style="font-size:11px;margin-top:6px;color:#c9d1d9"
                  id="dv-stats">—</div>
                <div style="display:flex;gap:10px;margin-top:14px;align-items:stretch">
                  <button id="dv-ptt" class="btn btn-accent" style="flex:2;font-size:20px;
                    padding:22px 0;letter-spacing:2px">PTT</button>
                  <button id="dv-lock" class="btn" style="flex:1">PTT<br>LOCK</button>
                </div>
                <div class="mod-controls" style="margin-top:10px;align-items:center">
                  <label class="field" style="flex-direction:row;align-items:center;gap:6px">
                    <input type="checkbox" id="dv-vox" ${this.prefs.vox ? "checked" : ""}>
                    <span>VOX</span></label>
                  <input type="range" id="dv-voxthr" min="-50" max="-12" step="1"
                    value="${this.prefs.voxThr}" style="flex:1">
                  <span class="mono" id="dv-voxlbl" style="font-size:10px;width:52px">
                    ${this.prefs.voxThr} dB</span>
                </div>
                <div id="dv-log" class="mono" style="margin-top:12px;height:120px;overflow:auto;
                  font-size:10.5px;line-height:1.45;background:#05070b;padding:6px;
                  border:1px solid rgba(96,114,150,0.25);white-space:pre-wrap"></div>
              </div>
            </div>
          </div>
          <div class="mod-side">
            <div class="card">
              <header class="card-head"><h3>Mode</h3></header>
              <div class="card-body mod-controls" style="flex-direction:column;align-items:stretch">
                <label class="field"><span>Digital voice mode</span>
                  <select id="dv-mode">${modeOpts}</select></label>
                <div class="mono" id="dv-modenote" style="font-size:10px;color:#8a94a3"></div>
                <div class="mod-controls" id="dv-sqlrow" style="align-items:center;display:none">
                  <label class="field" style="flex-direction:row;align-items:center;gap:6px"
                    title="mute the decoder below this SNR estimate">
                    <input type="checkbox" id="dv-sql"><span>SQL</span></label>
                  <input type="range" id="dv-sqlthr" min="-5" max="12" step="0.5" style="flex:1">
                  <span class="mono" id="dv-sqllbl" style="font-size:10px;width:56px"></span>
                </div>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>Receive</h3></header>
              <div class="card-body mod-controls" style="flex-direction:column;align-items:stretch">
                <button class="btn" id="dv-arm">ARM RX ▶</button>
                <label class="btn" for="dv-wavin" style="text-align:center">Decode DV WAV…</label>
                <input type="file" id="dv-wavin" accept=".wav,audio/wav" style="display:none">
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>WAV</h3></header>
              <div class="card-body mod-controls" style="flex-direction:column;align-items:stretch">
                <label class="btn" for="dv-vocin" style="text-align:center">Voice WAV → DV WAV</label>
                <input type="file" id="dv-vocin" accept=".wav,audio/wav" style="display:none">
                <button class="btn" id="dv-demowav">Save demo-talker DV WAV</button>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>Loopback lab</h3></header>
              <div class="card-body mod-controls" style="flex-direction:column;align-items:stretch">
                <div class="mod-controls">
                  <label class="field" style="flex-direction:row;align-items:center;gap:5px">
                    <input type="checkbox" id="dv-noise" checked><span>SNR</span></label>
                  <input type="number" id="dv-snr" value="16" min="0" max="40" style="width:56px">
                  <span class="mono">dB</span>
                </div>
                <button class="btn" id="dv-loop">Run loopback (demo talker)</button>
                <button class="btn" id="dv-selftest">Self-test (all modes)</button>
              </div>
            </div>
            <div class="mod-note">
              Studio-to-studio digital voice built like FreeDV: LPC vocoder,
              Golay(24,12) on the critical bits, differential PSK or 4FSK.
              Not interoperable with FreeDV/M17 (their codecs are separate
              large codebases) — both ends run this studio. PSK modes pass
              any SSB or FM voice channel and tolerate ±10 Hz mistuning;
              DV-3200F needs a 9k6 data jack. Half duplex: RX mutes while
              you transmit. Identify per your regulations.
            </div>
          </div>
        </div>`;

      const $ = id => el.querySelector("#dv-" + id);
      this.ui = {
        state: $("state"), leds: $("leds"), bars: $("bars"), stats: $("stats"),
        ptt: $("ptt"), lock: $("lock"), vox: $("vox"), voxthr: $("voxthr"),
        voxlbl: $("voxlbl"), log: $("log"), mode: $("mode"), modenote: $("modenote"),
        arm: $("arm"), wavin: $("wavin"), vocin: $("vocin"),
        sqlrow: $("sqlrow"), sql: $("sql"), sqlthr: $("sqlthr"), sqllbl: $("sqllbl"),
        demowav: $("demowav"), noise: $("noise"), snr: $("snr"),
        loop: $("loop"), selftest: $("selftest")
      };
      this._buildLeds();
      this._modeNote();

      const savePrefs = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(this.prefs)); } catch {} };
      this.ui.mode.addEventListener("change", async () => {
        this.prefs.mode = this.ui.mode.value;
        this.tx = null;
        this._closeH("_txH");
        this._modeNote(); savePrefs();
        this._mon("mode → " + MODES[this.prefs.mode].label);
        if (this._isFdv()) await this._ensureFdv();
        if (this.armed) this.rx = this._mkRx(this.ctx.audio.ensureContext().sampleRate);
      });
      const pttOn = (e) => { e.preventDefault(); this._pttSet(true); };
      const pttOff = () => this._pttSet(false);
      this.ui.ptt.addEventListener("mousedown", pttOn);
      this.ui.ptt.addEventListener("touchstart", pttOn, { passive: false });
      window.addEventListener("mouseup", pttOff);
      this.ui.ptt.addEventListener("touchend", pttOff);
      this.ui.lock.addEventListener("click", () => {
        this.lock = !this.lock;
        this.ui.lock.classList.toggle("btn-accent", this.lock);
        this._mon(this.lock ? "PTT locked — transmitting" : "PTT lock released");
        if (this.lock) this._needAudio();
      });
      this.ui.vox.addEventListener("change", () => {
        this.prefs.vox = this.ui.vox.checked; savePrefs();
        if (this.prefs.vox) this._needAudio();
        this._mon("VOX " + (this.prefs.vox ? "on" : "off"));
      });
      this.ui.voxthr.addEventListener("input", () => {
        this.prefs.voxThr = parseInt(this.ui.voxthr.value, 10);
        this.ui.voxlbl.textContent = this.prefs.voxThr + " dB";
        savePrefs();
      });
      this.ui.sql.addEventListener("change", () => {
        this.prefs.sql = this.ui.sql.checked; savePrefs();
        this._applySquelchTo(this._rxH);
        this._mon("FreeDV squelch " + (this.prefs.sql
          ? "on @ " + this._sqlEff().toFixed(1) + " dB SNR" : "off"));
      });
      this.ui.sqlthr.addEventListener("input", () => {
        this.prefs.sqlThr = parseFloat(this.ui.sqlthr.value);
        this.ui.sqllbl.textContent = this.prefs.sqlThr.toFixed(1) + " dB";
        savePrefs();
        this._applySquelchTo(this._rxH);       // live while armed
      });
      this.ui.arm.addEventListener("click", () => this._toggleArm());
      this.ui.wavin.addEventListener("change", e => {
        const f = e.target.files && e.target.files[0];
        if (f) this._decodeWav(f);
        e.target.value = "";
      });
      this.ui.vocin.addEventListener("change", e => {
        const f = e.target.files && e.target.files[0];
        if (f) this._encodeWav(f);
        e.target.value = "";
      });
      this.ui.demowav.addEventListener("click", () => this._demoWav());
      this.ui.loop.addEventListener("click", () => this._loopback());
      this.ui.selftest.addEventListener("click", () => this._selfTest());

      this.pollTimer = setInterval(() => this._poll(), 150);
      this._mon("digital voice ready — " + MODES[this.prefs.mode].label);
    },

    onDeactivate() {
      this.armed = false;
      this.ptt = false; this.lock = false;
      this._closeH("_txH"); this._closeH("_rxH");
      this._endStream("_txStr"); this._endStream("_rxStr");
      if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
      this.ui = null;
    },

    _needAudio() {
      if (!this.ctx.audio.rxActive)
        this.ctx.audio.startRX().catch(e => this.ctx.log("input error: " + e.message));
    },
    _pttSet(on) {
      if (on === this.ptt) return;
      this.ptt = on;
      if (on) this._needAudio();
    },
    _buildLeds() {
      const names = ["PWR", "SYNC", "RX", "TX", "VOX"];
      const colors = { PWR: "#3ddc84", SYNC: "#4dd0e1", RX: "#3ddc84",
                       TX: "#ff5252", VOX: "#ffb347" };
      this.leds = {};
      this.ui.leds.innerHTML = "";
      for (const n of names) {
        const d = document.createElement("div");
        d.style.cssText = "text-align:center";
        d.innerHTML = `<div style="width:14px;height:14px;border-radius:50%;
          background:#3a3f47;margin:0 auto;box-shadow:inset 0 0 3px #000"></div>
          <div class="mono" style="font-size:8px;color:#5a6470;margin-top:2px">${n}</div>`;
        this.ui.leds.appendChild(d);
        this.leds[n] = d.firstElementChild;
      }
      this.leds.PWR.style.background = colors.PWR;
      this._ledColors = colors;
    },
    _led(n, on) { if (this.leds) this.leds[n].style.background = on ? this._ledColors[n] : "#3a3f47"; },
    _modeNote() {
      this.ui.modenote.textContent = MODES[this.prefs.mode].note;
      const fdv = this._isFdv();
      this.ui.sqlrow.style.display = fdv ? "flex" : "none";
      if (fdv) {
        this.ui.sql.checked = !!this.prefs.sql;
        this.ui.sqlthr.value = this._sqlEff();
        this.ui.sqllbl.textContent = this._sqlEff().toFixed(1) + " dB";
      }
    },
    _mon(text) {
      if (!this.ui) return;
      const d = document.createElement("div");
      d.textContent = `[${new Date().toTimeString().slice(0, 8)}] ${text}`;
      this.ui.log.appendChild(d);
      while (this.ui.log.childNodes.length > 150)
        this.ui.log.removeChild(this.ui.log.firstChild);
      this.ui.log.scrollTop = this.ui.log.scrollHeight;
    },

    _toggleArm() {
      if (this.armed) {
        this.armed = false;
        this._endStream("_rxStr");
        this.ui.arm.textContent = "ARM RX ▶";
        this._mon("RX disarmed");
        return;
      }
      const arm = async () => {
        if (this._isFdv()) await this._ensureFdv();
        const sr = this.ctx.audio.ensureContext().sampleRate;
        this.rx = this._mkRx(sr);
        this.armed = true;
        this.ui.arm.textContent = "ARM RX ■ (monitoring)";
        this._mon("RX armed — listening for " + MODES[this.prefs.mode].label);
      };
      if (!this.ctx.audio.rxActive)
        this.ctx.audio.startRX().then(arm).catch(e => this.ctx.log("input error: " + e.message));
      else arm();
    },

    async _decodeWav(file) {
      if (this._busy) return;
      this._busy = true;
      try {
        const wav = wavDecode(await file.arrayBuffer());
        this._mon(`decoding ${file.name} (${(wav.samples.length / wav.rate).toFixed(1)} s)`);
        const chunks = [];
        let rx, rxH = null;
        if (this._isFdv()) {
          const eng = await this._ensureFdv();
          rxH = eng.open(this.prefs.mode);
          this._applySquelchTo(rxH);
          rx = new FdvRx(rxH, wav.rate, v => chunks.push(v));
        } else {
          rx = new DvRx(this.prefs.mode, wav.rate, v => chunks.push(v));
        }
        const step = Math.round(wav.rate / 2);
        for (let p = 0; p < wav.samples.length; p += step) {
          rx.feed(wav.samples.subarray(p, Math.min(p + step, wav.samples.length)));
          await tick();
        }
        if (rxH) rxH.close();
        let total = 0;
        for (const c of chunks) total += c.length;
        const voice = new Float32Array(total);
        let p = 0;
        for (const c of chunks) { voice.set(c, p); p += c.length; }
        this._mon(this._isFdv()
          ? `decoded ${rx.superframes} FreeDV frames · SNR est ${rx.snr > -90 ? rx.snr.toFixed(1) : "—"} dB — playing`
          : `decoded ${rx.superframes} superframes (${rx.fecFail} lost) — playing`);
        if (voice.length) this.ctx.audio.playMonitor(voice, FS);
      } catch (e) {
        this.ctx.log("DV WAV decode failed: " + e.message);
      } finally { this._busy = false; }
    },

    async _renderDv(voice8k, modeId) {
      modeId = modeId || this.prefs.mode;
      let tx, h = null;
      if (this._isFdv(modeId)) {
        const eng = await this._ensureFdv();
        h = eng.open(modeId);
        tx = new FdvTx(h, 48000);
      } else {
        tx = new DvTx(modeId, 48000);
      }
      const lead = new Float32Array(Math.round(48000 * 0.15));
      const parts = [lead];
      const padded = new Float32Array(voice8k.length + FRAME * 4);
      padded.set(voice8k);
      /* feed at 48 k: upsample the 8 k voice first */
      const up = new Resamp(FS, 48000);
      const v48 = up.process(padded);
      for (let p = 0; p < v48.length; p += 12000)
        parts.push(tx.feedMic(v48.subarray(p, Math.min(p + 12000, v48.length))));
      parts.push(tx.flush(48000));
      parts.push(new Float32Array(Math.round(48000 * 0.15)));
      let total = 0;
      for (const pt of parts) total += pt.length;
      const out = new Float32Array(total);
      let q = 0;
      for (const pt of parts) { out.set(pt, q); q += pt.length; }
      if (h) h.close();
      return out;
    },
    _saveWavFile(samples, rate, name) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([wavEncode16(samples, rate)], { type: "audio/wav" }));
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    },
    async _encodeWav(file) {
      if (this._busy) return;
      this._busy = true;
      try {
        const wav = wavDecode(await file.arrayBuffer());
        const down = new Resamp(wav.rate, FS);
        const v8 = down.process(wav.samples);
        this._mon(`encoding ${file.name} → ${MODES[this.prefs.mode].label}`);
        await tick();
        const dv = await this._renderDv(v8);
        this._saveWavFile(dv, 48000, `dv_${this.prefs.mode}.wav`);
        this._mon(`DV WAV saved (${(dv.length / 48000).toFixed(1)} s @ 48 kHz)`);
      } catch (e) {
        this.ctx.log("encode failed: " + e.message);
      } finally { this._busy = false; }
    },
    async _demoWav() {
      if (this._busy) return;
      this._busy = true;
      try {
        this._mon("rendering demo talker…");
        await tick();
        const dv = await this._renderDv(makeTalker(4, 7));
        this._saveWavFile(dv, 48000, `dv_demo_${this.prefs.mode}.wav`);
        this._mon("demo DV WAV saved");
      } finally { this._busy = false; }
    },

    async _loopback() {
      if (this._busy) return;
      this._busy = true;
      try {
        const m = MODES[this.prefs.mode];
        const snr = this.ui.noise.checked ? parseFloat(this.ui.snr.value) : null;
        this._mon(`loopback ${m.label}` + (snr !== null ? ` @ ${snr} dB` : " (clean)"));
        await tick();
        const dv = await this._renderDv(makeTalker(3, 11));
        const ch = new DvChannel(48000, { snrDb: snr, gain: 0.5, seed: 5,
          fHi: m.modem === "fsk" ? 8200 : 2900, fLo: m.modem === "fsk" ? 150 : 250 });
        const y = ch.process(dv);
        const chunks = [];
        let rx, rxH = null;
        if (this._isFdv()) {
          const eng = await this._ensureFdv();
          rxH = eng.open(this.prefs.mode);
          this._applySquelchTo(rxH);
          rx = new FdvRx(rxH, 48000, v => chunks.push(v));
        } else {
          rx = new DvRx(this.prefs.mode, 48000, v => chunks.push(v));
        }
        for (let p = 0; p < y.length; p += 24000) {
          rx.feed(y.subarray(p, Math.min(p + 24000, y.length)));
          await tick();
        }
        if (rxH) rxH.close();
        let total = 0;
        for (const c of chunks) total += c.length;
        const voice = new Float32Array(total);
        let q = 0;
        for (const c of chunks) { voice.set(c, q); q += c.length; }
        this._mon(this._isFdv()
          ? `loopback: ${rx.superframes} FreeDV frames · SNR est ${rx.snr > -90 ? rx.snr.toFixed(1) : "—"} dB — playing`
          : `loopback: ${rx.superframes} superframes, ${rx.fecFail} lost — playing`);
        if (voice.length) this.ctx.audio.playMonitor(voice, FS);
      } finally { this._busy = false; }
    },

    async _selfTest() {
      const log = m => { this.ctx.log("dv self-test: " + m); this._mon(m); };
      const SNRS = { dv1600: 14, dv2600: 20, dv3200f: 16,
                     fdv700d: 4, fdv700e: 8, fdv1600: 10, fdv700c: 9 };
      for (const [id, m] of Object.entries(MODES)) {
        try {
          if (this._isFdv(id)) await this._ensureFdv();
          const snr = SNRS[id];
          const dv = await this._renderDv(makeTalker(1.6, 3), id);
          const fsk = m.modem === "fsk";
          const ch = new DvChannel(48000, { snrDb: snr, gain: 0.5, seed: 3,
            fHi: fsk ? 8200 : 2900, fLo: fsk ? 150 : 250 });
          const y = ch.process(dv);
          let got = 0, energy = 0, lockedSeen = false;
          let rx, rxH = null;
          const onV = v => {
            got++;
            for (let i = 0; i < v.length; i++) energy += v[i] * v[i];
          };
          if (this._isFdv(id)) {
            rxH = this._fdv.open(id);
            rx = new FdvRx(rxH, 48000, onV);
          } else rx = new DvRx(id, 48000, onV);
          for (let p = 0; p < y.length; p += 24000) {
            rx.feed(y.subarray(p, Math.min(p + 24000, y.length)));
            lockedSeen = lockedSeen || rx.locked || rx.mdm.locked;
            await tick();
          }
          if (rxH) rxH.close();
          const ok = lockedSeen && got >= 8 && energy > 0.3;
          log(`${m.label} @ ${snr} dB: ${ok ? "PASS" : "FAIL"} ` +
            `(${got} voice blocks${this._isFdv(id) ? ", SNR est " + rx.snr.toFixed(1) + " dB" : ""})`);
        } catch (e) {
          log(`${m.label}: FAIL (${e.message})`);
        }
      }
      log("done");
    },

    _poll() {
      if (!this.ui) return;
      const txOn = this._txActive();
      this._led("TX", txOn);
      this._led("VOX", this.prefs.vox && this.voxOpen);
      this._led("SYNC", !!(this.armed && this.rx &&
        (this.rx.mdm.locked || this.rx.quality > 0.4)));
      this._led("RX", !!(this.armed && this.rx && this.rx.superframes > 0 &&
        performance.now() % 1000 < 700 && this.rx.quality > 0.3));
      this.ui.ptt.classList.toggle("btn-accent", !txOn);
      this.ui.ptt.style.background = txOn ? "rgba(255,82,82,0.25)" : "";
      this.ui.state.textContent = txOn ? "TX" : (this.armed ? "RX armed" : "idle");
      const bar = (label, v, lo, hi) => {
        const f = clamp((v - lo) / (hi - lo), 0, 1);
        const b = Math.round(f * 18);
        return `${label} ${"█".repeat(b)}${"░".repeat(18 - b)} ${v.toFixed(0)}`;
      };
      this.ui.bars.innerHTML =
        bar("MIC ", this.micLevel, -60, 0) + " dBFS<br>" +
        bar("QUAL", (this.rx ? this.rx.quality : 0) * 100, 0, 100) + " %";
      if (this.rx) {
        this.ui.stats.textContent = this._isFdv()
          ? `FreeDV · ${this.rx.locked ? "SYNC" : "searching"} · ` +
            `SNR ${this.rx.snr > -90 ? this.rx.snr.toFixed(1) : "—"} dB · ` +
            `Codec 2 ${MODES[this.prefs.mode].vbps} · ${this.rx.superframes} frames`
          : `${this.rx.superframes} superframes · ${this.rx.fecFail} lost · ` +
            `FEC-armored critical bits · ${MODES[this.prefs.mode].vbps} bit/s vocoder`;
      }
    }
  };

  const HOST = (typeof HRWS !== "undefined" && HRWS)
    || (typeof window !== "undefined" ? window.HRWS : null);
  if (HOST) HOST.registerModule(def);

  /* headless test hook */
  window.__DV_TEST__ = {
    FS, FRAME, MODES, Resamp, autocorr, levinson, lpcToLsf, lsfToLpc,
    pitchTrack, qLsf, dqLsf, LSF_BITS_LO, LSF_BITS_MID, LSF_BITS_HI,
    qPitch, dqPitch, qGain, dqGain,
    golayEncode, golayDecode, BitWriter, BitReader,
    VoiceEncoder, VoiceDecoder, PskTx, PskRx, FskTx, FskRx,
    DvTx, DvRx, FdvTx, FdvRx, DvChannel, makeTalker, wavEncode16, wavDecode,
    FSK_SYNC, PSK_BINS, PSK_PILOT
  };
})();



