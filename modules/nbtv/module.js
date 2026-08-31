/* ============================================================
   Ham Radio Web Studio — NBTV module
   Narrow-band ("mechanical") television over the sound card,
   ported from NBTV Studio (Python) by VA3JFL so the two are
   signal-compatible: what this module transmits, the Python
   suite decodes, and vice-versa.

   Signal convention (identical to the reference):
     video units 0..1: sync tip = 0.00, black = 0.30, white = 1.00
     mapped to audio as a = 2v − 1
     every line starts with a sync pulse (12 % of the line);
     the first line of each frame carries a broad 50 % pulse;
     in frame-sequential colour the RED field carries broad
     pulses on its first TWO lines (colour-phase anchor).

   In this port: mono, frame-sequential, line-sequential AND
   stereo Y/C colour (L = composite luma, R = alternating U/V
   chroma — a mono receiver still gets clean black & white);
   authentic low-pass output filters; live webcam and test
   patterns; and the QR-frame FILE LINK — files ride the video
   as a carousel of QR codes rendered pixel-exact on the scan
   grid, reassembled and CRC-checked on the far side.

   QR vendor libs (lazy-loaded from ./vendor/):
     qrcode-generator (MIT, Kazuhiko Arase) — encode
     jsQR (Apache-2.0, Cosmo Wolfe) — decode
   ============================================================ */
"use strict";

(function () {

  /* base path of this module, for lazy-loading the vendor libs */
  const BASE = (function () {
    try {
      const s = document.currentScript;
      if (s && s.src) return s.src.slice(0, s.src.lastIndexOf("/") + 1);
    } catch (e) { /* headless */ }
    return "modules/nbtv/";
  })();

  /* ---------------- timing constants (fractions of one line) ------- */
  const SYNC_F   = 0.12;   // line sync pulse width
  const BPORCH_F = 0.05;   // back porch after sync
  const FPORCH_F = 0.03;   // front porch before next sync
  const BROAD_F  = 0.50;   // broad (frame) sync pulse width
  const BLACK    = 0.30;   // black level in video units

  /* colour helpers (BT.601-ish), as in the reference */
  const U_MAX = 0.886;     // range of (B − Y) for RGB in 0..1
  const V_MAX = 0.701;     // range of (R − Y)

  /* selectable TX output bandwidth */
  const FILTERS = [
    ["Direct cable (full bandwidth)", null],
    ["20 kHz low-pass", 20000],
    ["15 kHz low-pass", 15000],
    ["10 kHz low-pass (classic NBTV)", 10000],
    ["7 kHz low-pass", 7000],
    ["5 kHz low-pass", 5000],
    ["3.4 kHz low-pass (comms radio)", 3400]
  ];

  const ECL = ["L", "M", "Q", "H"];   // QR error-correction levels

  /* ---------------- mode table (same as the reference) ------------- */
  const MODES = [
    { id: "club32",  name: "NBTV Club 32 · 12.5 fps · 2:3 vertical",  lines: 32,  fps: 12.5,  aspect: [2, 3], scan: "V" },
    { id: "baird30", name: "Baird 30 · 12.5 fps · 3:7 vertical",      lines: 30,  fps: 12.5,  aspect: [3, 7], scan: "V" },
    { id: "exp24",   name: "Experimental 24 · 12.5 fps · vertical",   lines: 24,  fps: 12.5,  aspect: [2, 3], scan: "V" },
    { id: "club48",  name: "Club 48 · 12.5 fps · 4:3",                lines: 48,  fps: 12.5,  aspect: [4, 3], scan: "H" },
    { id: "e60",     name: "1931-era 60 · 20 fps · 4:3",              lines: 60,  fps: 20,    aspect: [4, 3], scan: "H" },

    { id: "l90",     name: "90-line · 12.5 fps · 4:3",                lines: 90,  fps: 12.5,  aspect: [4, 3], scan: "H" },
    { id: "l120",    name: "Mid-30s 120 · 12.5 fps · 4:3",            lines: 120, fps: 12.5,  aspect: [4, 3], scan: "H" },
    { id: "x96",     name: "X96 wideband · 12.5 fps · 4:3",           lines: 96,  fps: 12.5,  aspect: [4, 3], scan: "H" },
    { id: "x120f",   name: "X120 wideband · 25 fps [96k+ card]",      lines: 120, fps: 25,    aspect: [4, 3], scan: "H" },
    { id: "x160",    name: "X160 wideband · 12.5 fps",                lines: 160, fps: 12.5,  aspect: [4, 3], scan: "H" },
    { id: "x240",    name: "X240 hi-def slow · 6.25 fps",             lines: 240, fps: 6.25,  aspect: [4, 3], scan: "H" },
    { id: "x288",    name: "X288 hi-def slow · 6.25 fps",             lines: 288, fps: 6.25,  aspect: [4, 3], scan: "H" },
    { id: "x360",    name: "X360 photo-scan · 3.125 fps",             lines: 360, fps: 3.125, aspect: [4, 3], scan: "H" },
    { id: "x480",    name: "X480 photo-scan · 2 fps",                 lines: 480, fps: 2,     aspect: [4, 3], scan: "H" },
    { id: "uw32",    name: "UltraWide 32 · 12.5 fps · max detail",    lines: 32,  fps: 12.5,  aspect: [2, 3], scan: "V" }
  ];
  /* NBTVSND-BEGIN — sound-in-vision: an AM subcarrier riding the
     luminance, offset by HALF the line rate so it hides between the
     teeth of the video's spectral comb (the trick color TV used for
     chroma). ~15 % depth = the "slight flicker" budget. */
  /* raw-AM sound constants: SND_M is the modulation a full-scale (±1)
     soundtrack sample produces — no AGC, no limiting, just proportional.
     SND_CLIP leaves static headroom above ±1 so the modulator's own
     filter overshoot on hot transients passes clean instead of clipping;
     the video share is scaled so video + carrier + peak can never clip. */
  const SND_F0 = 7200, SND_M = 0.35, SND_CLIP = 1.2, SND_LVL = 0.15;
  /* Sound carrier placement, television-style: the video is band-limited
     below the carrier (the sound guard), and the carrier sits on the
     half-line-offset tooth grid ~1.8× above that guard, where the FIR's
     stopband is deep. fs caps keep it inside 44.1 k devices and Opus
     links. cutoffHz is the TX output filter (null = full bandwidth).
     Returns { f, guard }: carrier frequency and the video guard cutoff. */
  function sndPlan(fmt, fs, cutoffHz) {
    const lineRate = fmt ? fmt.lines * fmt.fps : 400;
    const rate = fs || 48000;
    /* the carrier always sits near the top of the soundcard band (capped
       so the whole AM envelope clears Opus links and 44.1 k devices) — the
       output filter shapes the VIDEO only, and narrower video just widens
       the quiet moat under the carrier. Full audio bandwidth everywhere. */
    const ceilSb = Math.min(0.46 * rate, 19800);
    let f = (Math.floor((ceilSb - 2600) / lineRate - 0.5) + 0.5) * lineRate;
    /* the video's top edge keeps a fixed moat below the carrier so the
       receiver's skirt sees ≥ 3.7× its corner — the clean gap the 7 kHz
       setting gets, now at every setting */
    const guard = Math.min(cutoffHz || 1e9, 0.19 * rate,
      Math.max(f - 3.7 * 2600, 0.3 * f));
    if (!(f > lineRate)) f = 1.5 * lineRate;      // degenerate tiny setups
    const aud = Math.max(700, Math.min(2600, 0.42 * (f - guard)));
    return { f, guard, aud };
  }
  function sndSubF(fmt, fs, cutoffHz) { return sndPlan(fmt, fs, cutoffHz).f; }
  class SndTx {
    constructor(fs, fSub, audBW) { this.fs = fs;
      const w = 2 * Math.PI * fSub / fs;
      this.cr = Math.cos(w); this.ci = Math.sin(w); this.pr = 1; this.pi = 0;
      this.lp = 0; this.aLP = 1 - Math.exp(-2 * Math.PI * (audBW || 2500) / fs);
      this.hp = 0; this.aHP = 1 - Math.exp(-2 * Math.PI * 250 / fs);
      this.ring = new Float32Array(fs); this.wp = 0; this.rp = 0; }
    push(a) { for (let i = 0; i < a.length; i++) { this.ring[this.wp] = a[i];
      this.wp = (this.wp + 1) % this.ring.length; } }
    mixInto(comp) {
      for (let i = 0; i < comp.length; i++) {
        let s = this.wp === this.rp ? 0 : this.ring[this.rp];
        if (this.wp !== this.rp) this.rp = (this.rp + 1) % this.ring.length;
        this.hp += (s - this.hp) * this.aHP; s -= this.hp;          // 250 Hz HP
        this.lp += (s - this.lp) * this.aLP; s = this.lp;           // 2.5 k LP
        /* raw AM, no gain riding: the soundtrack sample modulates the
           carrier proportionally. A quiet track simply modulates less;
           the safety clamp sits above the overshoot a full-scale
           transient picks up in the 250 Hz high-pass. */
        const m = 1 + SND_M * clamp(s, -SND_CLIP, SND_CLIP);
        const t2 = this.pr * this.cr - this.pi * this.ci;
        this.pi = this.pr * this.ci + this.pi * this.cr; this.pr = t2;
        comp[i] = comp[i] * (1 - SND_LVL * (1 + SND_M * SND_CLIP)) + SND_LVL * m * this.pr;
      }
      const g = 1 / Math.hypot(this.pr, this.pi); this.pr *= g; this.pi *= g;
    }
  }
  class SndRxCore {                    // demodulator maths, DOM-free
    constructor(fs, fSub, lineRate, audBW) {
      this.fs = fs;
      const w = 2 * Math.PI * fSub / fs;
      this.sr = Math.cos(w); this.si = -Math.sin(w); this.nr = 1; this.ni = 0;
      this.al = 1 - Math.exp(-2 * Math.PI * (audBW || 2600) / fs);
      this.aH = 1 - Math.exp(-2 * Math.PI * 1400 / fs);   // 2× gentle HP: video comb down, subcarrier intact
      this.h1 = 0; this.h2 = 0;
      /* 5th-order Butterworth I/Q low-pass: cascaded identical one-poles
         have a soft knee that leaked the picture's below-carrier energy
         at ~−29 dB and set an audible hash floor. A true Butterworth is
         flat to the corner and ~−46 dB by 3× out. Two biquads + one pole. */
      const bw = (audBW || 2600);
      const mkLP = (q) => {
        const w0 = 2 * Math.PI * bw / fs, cw = Math.cos(w0), sw = Math.sin(w0);
        const alp = sw / (2 * q), a0 = 1 + alp;
        return { b0: (1 - cw) / 2 / a0, b1: (1 - cw) / a0, b2: (1 - cw) / 2 / a0,
                 a1: -2 * cw / a0, a2: (1 - alp) / a0,
                 x1: 0, x2: 0, y1: 0, y2: 0 };
      };
      this.iqBq = [mkLP(0.618), mkLP(1.618), mkLP(0.618), mkLP(1.618)];  // I: [0,1]  Q: [2,3]
      this.I = [0]; this.Q = [0];   // final real pole each
      this.dc = 0;
      this.anlK = 2.6;                    // baseband magnitude limiter, x dc
      /* carrier squelch: raw-band reference + hysteresis + ramped gate */
      this.Ir = 0; this.Qr = 0; this.dcR = 0;
      this.sqOn = false;                  // squelch decision
      this.sqG = 0;                       // ramped gate 0..1
      this.q = 0;                         // carrier quality, for UI/tests
      this.cI = 0; this.cQ = 0;           // slow carrier vector (coherence)
      this.cA = 1 - Math.exp(-2 * Math.PI * 30 / fs);
      this.coh = 0;
      /* one-line delay comb: the video's spectral teeth sit at k·lineRate
         and cancel in x[n] − x[n−line], while the half-line-offset
         subcarrier arrives anti-phase and doubles — the whole reason the
         carrier lives between the teeth */
      /* fractional-delay comb: fs/lineRate is not an integer on 44.1 kHz
         devices (110.25 samples at Club 32) — an integer delay mistunes
         the teeth and lets the picture leak through. Two-tap linear
         interpolation keeps the nulls exactly on the line harmonics. */
      this.Df = lineRate ? fs / lineRate : 0;
      this.D = this.Df ? Math.ceil(this.Df) + 1 : 0;
      this.dl = this.D ? new Float32Array(this.D) : null;
      this.dp = 0;
      this.dfrac = this.Df ? this.Df - Math.floor(this.Df) : 0;
      this.dint = this.Df ? Math.floor(this.Df) : 0;
    }
    demod(x) {
      const out = new Float32Array(x.length);
      let nr = this.nr, ni = this.ni;
      const I = this.I, Q = this.Q;
      for (let i = 0; i < x.length; i++) {
        let s = x[i];
        if (this.D) {
          const n = this.D;
          const i0 = (this.dp - this.dint + n * 2) % n;
          const i1 = (i0 - 1 + n) % n;
          const d = this.dl[i0] * (1 - this.dfrac) + this.dl[i1] * this.dfrac;
          this.dl[this.dp] = s;
          this.dp = (this.dp + 1) % n;
          s = (s - d) * 0.5;
        }
        this.h1 += (s - this.h1) * this.aH; s -= this.h1;
        this.h2 += (s - this.h2) * this.aH; s -= this.h2;
        let iv = s * nr, qv = s * ni;
        for (let k = 0; k < 2; k++) {           // I through its two biquads
          const b = this.iqBq[k];
          const y = b.b0 * iv + b.b1 * b.x1 + b.b2 * b.x2 - b.a1 * b.y1 - b.a2 * b.y2;
          b.x2 = b.x1; b.x1 = iv; b.y2 = b.y1; b.y1 = y; iv = y;
        }
        for (let k = 2; k < 4; k++) {           // Q through its two biquads
          const b = this.iqBq[k];
          const y = b.b0 * qv + b.b1 * b.x1 + b.b2 * b.x2 - b.a1 * b.y1 - b.a2 * b.y2;
          b.x2 = b.x1; b.x1 = qv; b.y2 = b.y1; b.y1 = y; qv = y;
        }
        /* squelch reference: the same band BEFORE the comb. A real
           subcarrier passes the comb at gain 1 (q = comb/raw ≈ 0.5 with
           the video teeth alongside); a picture with no sound leaves
           only residue (q ≈ 0.01). Without this, the AGC amplifies that
           residue to full scale — raw video grind at the speaker. */
        this.Ir += (x[i] * nr - this.Ir) * this.al;
        this.Qr += (x[i] * ni - this.Qr) * this.al;
        I[0] += (iv - I[0]) * this.al; iv = I[0];
        Q[0] += (qv - Q[0]) * this.al; qv = Q[0];
        const t2 = nr * this.sr - ni * this.si; ni = nr * this.si + ni * this.sr; nr = t2;
        let mag = Math.sqrt(iv * iv + qv * qv);
        /* baseband impulse limiter (band-safe ANL): after the 3-pole
           selection only carrier + audio remain, so an AM peak is ≤ 2·dc.
           Clamping the detected magnitude at ~2.6·dc shears frame-pulse
           spikes without the intermodulation a wideband IF clipper causes
           when strong out-of-band video towers over the carrier. */
        const magLim = this.anlK * this.dc + 0.01;
        if (mag > magLim) mag = magLim;
        this.dc += (mag - this.dc) * 0.0006;
        this.dcR += (Math.sqrt(this.Ir * this.Ir + this.Qr * this.Qr) - this.dcR) * 0.0006;
        this.q = this.dc / (this.dcR + 1e-9);
        /* carrier coherence: both ends derive the carrier from the same
           formula, so a genuine carrier sits at ~0 Hz in this baseband —
           its 30 Hz-smoothed vector keeps its length. Noise and stray
           audio tumble, and their smoothed vector collapses. */
        this.cI += (iv - this.cI) * this.cA;
        this.cQ += (qv - this.cQ) * this.cA;
        this.coh = Math.sqrt(this.cI * this.cI + this.cQ * this.cQ) / (this.dc + 1e-9);
        if (this.sqOn) {
          if (this.coh < 0.35 || this.q < 0.12 || this.dc < 0.0015) this.sqOn = false;
        } else if (this.coh > 0.55 && this.q > 0.2 && this.dc > 0.003) this.sqOn = true;
        this.sqG += ((this.sqOn ? 1 : 0) - this.sqG) * 0.003;   // ~7 ms ramp
        let y = (mag - this.dc) * (3 / (this.dc + 1e-6)) * 0.25;
        /* no post-detector limiter: an envelope-tracking ceiling crushes
           the first milliseconds of every hard consonant after a pause
           (the "spit" on C's and A's). Frame-pulse clicks are already
           sheared band-safely at baseband by the magnitude limiter above,
           which by construction can never touch legitimate AM. */
        out[i] = clamp(y, -1, 1) * this.sqG;
      }
      const g = 1 / Math.hypot(nr, ni); this.nr = nr * g; this.ni = ni * g;
      return out;
    }
  }
  class SndRx {                        // demod core + speaker playback
    constructor(actx, fSub, lineRate, fs, audBW) {
      this.fs = fs || actx.sampleRate;
      this.core = new SndRxCore(this.fs, fSub, lineRate, audBW);
      this.gain = actx.createGain(); this.gain.gain.value = 0;   // opens on decoder lock
      this.gain.connect(actx.destination); this.actx = actx; this.when = 0;
      this.lead = 0.25;                // scheduling cushion, adapts upward
      this._gate = false;
    }
    /* second squelch layer: only a locked picture decoder means a real
       NBTV signal is on the input — noise and stray audio never lock */
    setGate(open) {
      if (this._gate === !!open) return;
      this._gate = !!open;
      this.gain.gain.setTargetAtTime(open ? 0.8 : 0, this.actx.currentTime, 0.03);
    }
    process(x) {
      const out = this.core.demod(x);
      const buf = this.actx.createBuffer(1, out.length, this.fs);
      buf.getChannelData(0).set(out);
      const src = this.actx.createBufferSource();
      src.buffer = buf; src.connect(this.gain);
      const now = this.actx.currentTime;
      if (this.when < now + 0.02) {
        /* first chunk, or a late main-thread tick drained the cushion —
           re-prime a little deeper each time so one busy paint doesn't
           turn the soundtrack into rhythmic dropouts */
        this.when = now + this.lead;
        this.lead = Math.min(0.45, this.lead + 0.05);
      }
      src.start(this.when); this.when += out.length / this.fs;
      return out;
    }
  }
  /* NBTVSND-END */

  /* ---------------- uploaded media (video / GIF / soundtrack) --------
     Videos are scanned into per-frame JPEG blobs at the mode's frame
     rate (decoded a window ahead during TX); their audio track — or a
     separately loaded soundtrack file — is decoded to mono PCM and
     sliced per frame so it rides the AM sound subcarrier locked to the
     picture timeline, looping with it. */
  const MEDIA_MAX_SECS = 120;      // frames + soundtrack cap (memory)
  const MEDIA_MAX_FRAMES = 1500;

  /* one picture-frame's worth of soundtrack, linearly resampled from
     track.rate to outRate, starting at tSec on the (looping) track */
  function sliceTrack(track, tSec, nOut, outRate) {
    const out = new Float32Array(nOut);
    if (!track || !track.data || !track.data.length) return out;
    const d = track.data, n = d.length, step = track.rate / outRate;
    let pos = ((tSec % track.dur) + track.dur) % track.dur * track.rate;
    for (let i = 0; i < nOut; i++) {
      const i0 = Math.floor(pos) % n, i1 = (i0 + 1) % n, fr = pos - Math.floor(pos);
      out[i] = d[i0] + (d[i1] - d[i0]) * fr;
      pos += step; if (pos >= n) pos -= n;
    }
    return out;
  }

  /* ---------- minimal GIF87a/89a decoder — LZW + full compositing ----
     Dependency-free, in the house style, so animated GIFs can play
     over NBTV. Handles interlace, transparency, local palettes and
     disposal methods 0–3; every returned frame is fully composited.
     Returns { width, height, frames: [{ rgba, delayMs }] }. */
  function gifLzw(data, minCode, npix) {
    const out = new Uint8Array(npix);
    const clear = 1 << minCode, eoi = clear + 1;
    const prefix = new Int32Array(4096), suffix = new Uint8Array(4096);
    const stack = new Uint8Array(4097);
    let codeSize = minCode + 1, next = eoi + 1, prev = -1, first = 0;
    let bits = 0, acc = 0, dp = 0, op = 0;
    while (dp < data.length || bits >= codeSize) {
      while (bits < codeSize && dp < data.length) { acc |= data[dp++] << bits; bits += 8; }
      if (bits < codeSize) break;
      const code = acc & ((1 << codeSize) - 1);
      acc >>= codeSize; bits -= codeSize;
      if (code === clear) { codeSize = minCode + 1; next = eoi + 1; prev = -1; continue; }
      if (code === eoi) break;
      if (prev === -1) {
        if (code >= clear) break;                       // corrupt stream
        out[op++] = code; first = code; prev = code;
        if (op >= npix) break;
        continue;
      }
      let c = code, sp = 0;
      if (c === next) { stack[sp++] = first; c = prev; }
      else if (c > next) break;                         // corrupt stream
      while (c >= clear) { stack[sp++] = suffix[c]; c = prefix[c]; }
      first = c; stack[sp++] = c;
      if (next < 4096) {
        prefix[next] = prev; suffix[next] = first; next++;
        if (next === (1 << codeSize) && codeSize < 12) codeSize++;
      }
      prev = code;
      while (sp > 0 && op < npix) out[op++] = stack[--sp];
      if (op >= npix) break;
    }
    return out;
  }

  function decodeGif(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b.length < 13 || b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46)
      throw new Error("not a GIF file");
    let p = 6;
    const W = b[p] | (b[p + 1] << 8), H = b[p + 2] | (b[p + 3] << 8);
    const packed = b[p + 4];
    p += 7;
    if (!W || !H || W * H > 4096 * 4096) throw new Error("unreasonable GIF canvas size");
    let gct = null;
    if (packed & 0x80) { const n = 2 << (packed & 7); gct = b.subarray(p, p + n * 3); p += n * 3; }
    const canvas = new Uint8ClampedArray(W * H * 4);    // composited here
    const frames = [];
    let gceDelay = 0, gceDisposal = 0, gceTransp = -1;
    const readSubBlocks = () => {
      const parts = []; let len = 0;
      while (p < b.length) {
        const n = b[p++]; if (!n) break;
        parts.push(b.subarray(p, p + n)); len += n; p += n;
      }
      const out = new Uint8Array(len); let o = 0;
      for (const q of parts) { out.set(q, o); o += q.length; }
      return out;
    };
    const skipSubBlocks = () => { while (p < b.length) { const n = b[p++]; if (!n) break; p += n; } };
    while (p < b.length) {
      const tag = b[p++];
      if (tag === 0x3B) break;                          // trailer
      if (tag === 0x21) {                               // extension
        const label = b[p++];
        if (label === 0xF9) {                           // graphic control
          const n = b[p++];
          const gp = b[p];
          gceDisposal = (gp >> 2) & 7;
          gceTransp = (gp & 1) ? b[p + 3] : -1;
          gceDelay = (b[p + 1] | (b[p + 2] << 8)) * 10;
          p += n; skipSubBlocks();
        } else skipSubBlocks();
        continue;
      }
      if (tag !== 0x2C) break;                          // unknown — stop cleanly
      const ix = b[p] | (b[p + 1] << 8), iy = b[p + 2] | (b[p + 3] << 8);
      const iw = b[p + 4] | (b[p + 5] << 8), ih = b[p + 6] | (b[p + 7] << 8);
      const ip = b[p + 8]; p += 9;
      let pal = gct;
      if (ip & 0x80) { const n = 2 << (ip & 7); pal = b.subarray(p, p + n * 3); p += n * 3; }
      if (!pal) throw new Error("GIF frame has no colour table");
      const minCode = b[p++];
      const idx = gifLzw(readSubBlocks(), minCode, iw * ih);
      const before = gceDisposal === 3 ? canvas.slice() : null;
      const rows = [];
      if (ip & 0x40) {                                  // interlaced
        const off = [0, 4, 2, 1], step = [8, 8, 4, 2];
        for (let pass = 0; pass < 4; pass++)
          for (let y = off[pass]; y < ih; y += step[pass]) rows.push(y);
      } else for (let y = 0; y < ih; y++) rows.push(y);
      let s = 0;
      for (const ry of rows) {
        const cy = iy + ry;
        for (let rx = 0; rx < iw; rx++, s++) {
          const ci = idx[s];
          if (ci === gceTransp) continue;
          const cx = ix + rx;
          if (cx >= W || cy >= H) continue;
          const o = (cy * W + cx) * 4, c3 = ci * 3;
          canvas[o] = pal[c3]; canvas[o + 1] = pal[c3 + 1];
          canvas[o + 2] = pal[c3 + 2]; canvas[o + 3] = 255;
        }
      }
      frames.push({ rgba: canvas.slice(), delayMs: gceDelay < 20 ? 100 : gceDelay });
      if (gceDisposal === 2) {                          // restore to background
        const x1 = Math.min(ix + iw, W), y1 = Math.min(iy + ih, H);
        for (let y = iy; y < y1; y++)
          canvas.fill(0, (y * W + ix) * 4, (y * W + x1) * 4);
      } else if (gceDisposal === 3 && before) canvas.set(before);
      gceDelay = 0; gceDisposal = 0; gceTransp = -1;
      if (frames.length >= 1200) break;                 // sanity cap
    }
    if (!frames.length) throw new Error("no image frames in GIF");
    return { width: W, height: H, frames };
  }


  const PATTERNS = [
    "Colour bars", "Grey staircase", "Horizontal gradient",
    "Crosshatch + circle test card", "Resolution wedges",
    "Motion demo (bouncing block + clock)", "Black & white split"
  ];
  const LIVE_PATTERNS = new Set(["Motion demo (bouncing block + clock)"]);

  /* ---------------- small helpers ---------------------------------- */
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function concatF32(a, b) {
    const out = new Float32Array(a.length + b.length);
    out.set(a, 0); out.set(b, a.length);
    return out;
  }

  /* linear-resample a Float32Array row to outLen points */
  function resampleRow(src, outLen) {
    const out = new Float32Array(outLen);
    const n = src.length;
    if (n === 0) return out;
    if (n === 1) { out.fill(src[0]); return out; }
    const step = (n - 1) / (outLen - 1 || 1);
    for (let k = 0; k < outLen; k++) {
      const pos = k * step;
      let i = Math.floor(pos);
      if (i >= n - 1) i = n - 2;
      const f = pos - i;
      out[k] = src[i] + (src[i + 1] - src[i]) * f;
    }
    return out;
  }

  /* CRC-32 (same polynomial as zlib.crc32 in the reference) */
  const CRC_T = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* base-36 fixed-width ints, as in the reference protocol */
  const B36 = "0123456789abcdefghijklmnopqrstuvwxyz";
  function b36e(n, w) {
    n = Math.floor(n);
    let s = "";
    for (let i = 0; i < w; i++) { s = B36[n % 36] + s; n = Math.floor(n / 36); }
    return s;
  }
  function b36d(s) {
    let v = 0;
    for (const ch of s) v = v * 36 + B36.indexOf(ch);
    return v;
  }

  function bytesToB64(u8) {
    let s = "";
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH)
      s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CH, u8.length)));
    return btoa(s);
  }
  function b64ToBytes(b) {
    const s = atob(b);
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  }

  /* ---------------- WAV read / write (16 / 24-bit PCM out;
                      8 / 16 / 24 / 32-bit PCM + float32 in) ------------ */
  function wavEncode(chans, rate, bits) {
    const nch = chans.length, n = chans[0].length, bytes = bits >> 3;
    const dataSz = n * nch * bytes;
    const buf = new ArrayBuffer(44 + dataSz);
    const dv = new DataView(buf);
    const wstr = (p, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(p + i, s.charCodeAt(i)); };
    wstr(0, "RIFF"); dv.setUint32(4, 36 + dataSz, true); wstr(8, "WAVE");
    wstr(12, "fmt "); dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);                       // PCM
    dv.setUint16(22, nch, true);
    dv.setUint32(24, rate, true);
    dv.setUint32(28, rate * nch * bytes, true);
    dv.setUint16(32, nch * bytes, true);
    dv.setUint16(34, bits, true);
    wstr(36, "data"); dv.setUint32(40, dataSz, true);
    let p = 44;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < nch; c++) {
        const s = clamp(chans[c][i], -1, 1);
        if (bits === 16) { dv.setInt16(p, Math.round(s * 32767), true); p += 2; }
        else {                                        // 24-bit little-endian
          let v = Math.round(s * 8388607);
          if (v < 0) v += 0x1000000;
          dv.setUint8(p, v & 255); dv.setUint8(p + 1, (v >> 8) & 255); dv.setUint8(p + 2, (v >> 16) & 255);
          p += 3;
        }
      }
    }
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
      if (id === 0x666d7420) {                        // "fmt "
        fmt = {
          tag: dv.getUint16(body, true),
          ch: dv.getUint16(body + 2, true),
          rate: dv.getUint32(body + 4, true),
          bits: dv.getUint16(body + 14, true),
          body, sz
        };
      } else if (id === 0x64617461) {                 // "data"
        data = { off: body, sz: Math.min(sz, dv.byteLength - body) };
      }
      pos = body + sz + (sz & 1);
    }
    if (!fmt || !data) throw new Error("missing fmt/data chunk");
    let tag = fmt.tag;
    if (tag === 0xFFFE && fmt.sz >= 40) tag = dv.getUint16(fmt.body + 24, true); // extensible
    const nch = fmt.ch, bits = fmt.bits, bytes = bits >> 3;
    const n = Math.floor(data.sz / (bytes * nch));
    const out = [];
    for (let c = 0; c < nch; c++) out.push(new Float32Array(n));
    const isFloat = tag === 3 && bits === 32;
    if (!isFloat && tag !== 1) throw new Error("unsupported WAV format tag " + tag);
    let p = data.off;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < nch; c++) {
        let v;
        if (isFloat) v = dv.getFloat32(p, true);
        else if (bits === 16) v = dv.getInt16(p, true) / 32768;
        else if (bits === 24) {
          let u = dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getUint8(p + 2) << 16);
          if (u >= 0x800000) u -= 0x1000000;
          v = u / 8388608;
        }
        else if (bits === 32) v = dv.getInt32(p, true) / 2147483648;
        else if (bits === 8) v = (dv.getUint8(p) - 128) / 128;
        else throw new Error("unsupported WAV sample width: " + bits + "-bit");
        out[c][i] = v;
        p += bytes;
      }
    }
    return { rate: fmt.rate, bits, ch: out };
  }

  /* ---------------- streaming FIR low-pass (windowed sinc) ---------- */
  class FIRLowpass {
    constructor(rate, cutoff, taps = 127) {
      this.enabled = cutoff != null && cutoff < rate * 0.49;
      this.delay = this.enabled ? (taps - 1) / 2 : 0;   // group delay, samples
      if (!this.enabled) return;
      const h = new Float32Array(taps);
      const mid = (taps - 1) / 2;
      let sum = 0;
      for (let i = 0; i < taps; i++) {
        const x = 2 * cutoff / rate * (i - mid);
        const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (taps - 1));
        h[i] = sinc * w; sum += h[i];
      }
      for (let i = 0; i < taps; i++) h[i] /= sum;
      this.h = h; this.taps = taps;
      this.state = new Float32Array(taps - 1);
    }
    process(block) {
      if (!this.enabled) return block;
      const t = this.taps, h = this.h, st = this.state, n = block.length;
      const x = new Float32Array(st.length + n);
      x.set(st); x.set(block, st.length);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let k = 0; k < t; k++) acc += h[k] * x[i + k];
        out[i] = acc;
      }
      st.set(x.subarray(x.length - (t - 1)));
      return out;
    }
  }

  /* narrow biquad notch (RBJ cookbook, DF2T) — pulls the sound
     subcarrier out of the video path so the picture stops glittering */
  class BiquadNotch {
    constructor(fs, f0, Q) {
      const w = 2 * Math.PI * f0 / fs, alpha = Math.sin(w) / (2 * Q), c = Math.cos(w);
      const a0 = 1 + alpha;
      this.b0 = 1 / a0; this.b1 = -2 * c / a0; this.b2 = 1 / a0;
      this.a1 = -2 * c / a0; this.a2 = (1 - alpha) / a0;
      this.z1 = 0; this.z2 = 0;
    }
    process(x) {
      const out = new Float32Array(x.length);
      let z1 = this.z1, z2 = this.z2;
      for (let i = 0; i < x.length; i++) {
        const v = x[i];
        const y = this.b0 * v + z1;
        z1 = this.b1 * v - this.a1 * y + z2;
        z2 = this.b2 * v - this.a2 * y;
        out[i] = y;
      }
      this.z1 = z1; this.z2 = z2;
      return out;
    }
  }

  /* ---------------- Geometry --------------------------------------- */
  function Geometry(mode, rate) {
    this.mode = mode;
    this.rate = rate;
    this.lines = mode.lines;
    this.fps = mode.fps;
    this.aspect = mode.aspect;
    this.scan = mode.scan;
    this.lineRate = mode.lines * mode.fps;          // Hz
    this.spl = rate / this.lineRate;                 // samples per line (float)
    this.activeF = 1 - SYNC_F - BPORCH_F - FPORCH_F; // 0.80
    this.actStartF = SYNC_F + BPORCH_F;              // 0.17
    this.actEndF = 1 - FPORCH_F;                     // 0.97
    this.nPx = clamp(Math.round(this.spl * this.activeF), 12, 800);
    this.usable = this.spl >= 24;
  }
  Geometry.prototype.gridSize = function () {
    // [width, height] of the source grid the encoder samples
    return this.scan === "V" ? [this.lines, this.nPx] : [this.nPx, this.lines];
  };
  Geometry.prototype.describe = function () {
    const bw = 0.5 * this.rate * this.activeF;
    return `${this.lines} lines @ ${this.fps} fps · line rate ${this.lineRate.toFixed(1)} Hz · ` +
           `${this.spl.toFixed(1)} smp/line · ~${this.nPx} px/line · video BW ≲ ${(bw / 1000).toFixed(1)} kHz`;
  };

  /* map a full-grid IMAGE luminance array (gh×gw, 0..1) into scan-line
     order — the pixel-exact path QR frames take (no resampling at all) */
  function imageLumaToGrid(img, gw, gh, geom) {
    const L = geom.lines, P = geom.nPx;
    const grid = new Float32Array(L * P * 3);
    if (geom.scan === "V") {
      for (let li = 0; li < L; li++)
        for (let j = 0; j < P; j++) {
          const v = img[(gh - 1 - j) * gw + li];
          const o = (li * P + j) * 3;
          grid[o] = v; grid[o + 1] = v; grid[o + 2] = v;
        }
    } else {
      for (let li = 0; li < L; li++)
        for (let j = 0; j < P; j++) {
          const v = img[li * gw + j];
          const o = (li * P + j) * 3;
          grid[o] = v; grid[o + 1] = v; grid[o + 2] = v;
        }
    }
    return grid;
  }

  /* decoded grid → display-space luminance (what the QR receiver scans) */
  function gridToDisplayLuma(grid, geom) {
    const L = geom.lines, P = geom.nPx;
    const V = geom.scan === "V";
    const w = V ? L : P, h = V ? P : L;
    const a = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const li = V ? x : y;
        const j = V ? (P - 1 - y) : x;
        const o = (li * P + j) * 3;
        a[y * w + x] = (grid[o] + grid[o + 1] + grid[o + 2]) / 3;
      }
    return { a, w, h };
  }

  /* ---------------- high-quality rescale ---------------------------
     One drawImage call taps at most a ~2×2 neighbourhood per output
     pixel (and Firefox ignores imageSmoothingQuality entirely), so
     shrinking a photo straight onto the tiny scan grid DECIMATES it —
     most source pixels never get looked at and the result is random
     blocks / colour soup. Paint shrinks nicely because it area-averages.
     This does the canvas equivalent: halve progressively until the last
     hop is ≤ 2:1, so every source pixel contributes. Same result in
     every browser; degenerates to a single plain draw for upscales. */
  let _hqA = null, _hqB = null;
  function hqDraw(ctx, src, sx, sy, sw, sh, dx, dy, dw, dh) {
    if (!(sw > 0 && sh > 0 && dw > 0 && dh > 0)) return;
    let cur = src, cx = sx, cy = sy, cw = sw, ch = sh;
    if (sw > 2 * dw || sh > 2 * dh) {
      if (!_hqA) { _hqA = document.createElement("canvas"); _hqB = document.createElement("canvas"); }
      let a = _hqA, b = _hqB;
      while (cw > 2 * dw || ch > 2 * dh) {
        const nw = Math.max(Math.ceil(dw), Math.ceil(cw / 2));
        const nh = Math.max(Math.ceil(dh), Math.ceil(ch / 2));
        if (a.width < nw) a.width = nw;          // grow-only pool, no churn
        if (a.height < nh) a.height = nh;
        const t = a.getContext("2d");
        t.imageSmoothingEnabled = true;
        t.imageSmoothingQuality = "high";
        t.clearRect(0, 0, nw, nh);
        t.drawImage(cur, cx, cy, cw, ch, 0, 0, nw, nh);
        cur = a; cx = 0; cy = 0; cw = nw; ch = nh;
        const s2 = a; a = b; b = s2;
      }
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(cur, cx, cy, cw, ch, dx, dy, dw, dh);
  }

  /* ---------------- test patterns (canvas port) --------------------- */
  function drawPattern(c2d, W, H, name, t) {
    c2d.fillStyle = "#000"; c2d.fillRect(0, 0, W, H);
    if (name === "Colour bars") {
      const cols = ["#fff", "#ff0", "#0ff", "#0f0", "#f0f", "#f00", "#00f", "#000"];
      const bw = W / cols.length;
      cols.forEach((c, i) => { c2d.fillStyle = c; c2d.fillRect(i * bw, 0, bw + 1, H * 0.75); });
      for (let i = 0; i < 8; i++) {
        const g = Math.round(255 * i / 7);
        c2d.fillStyle = `rgb(${g},${g},${g})`;
        c2d.fillRect(i * bw, H * 0.75, bw + 1, H * 0.25);
      }
    } else if (name === "Grey staircase") {
      const steps = 10, bw = W / steps;
      for (let i = 0; i < steps; i++) {
        const g = Math.round(255 * i / (steps - 1));
        c2d.fillStyle = `rgb(${g},${g},${g})`;
        c2d.fillRect(i * bw, 0, bw + 1, H);
      }
    } else if (name === "Horizontal gradient") {
      const gr = c2d.createLinearGradient(0, 0, W, 0);
      gr.addColorStop(0, "#000"); gr.addColorStop(1, "#fff");
      c2d.fillStyle = gr; c2d.fillRect(0, 0, W, H);
    } else if (name === "Crosshatch + circle test card") {
      c2d.fillStyle = "rgb(40,40,40)"; c2d.fillRect(0, 0, W, H);
      c2d.strokeStyle = "#fff"; c2d.lineWidth = 2;
      const n = 8;
      for (let i = 0; i <= n; i++) {
        const x = W * i / n;
        c2d.beginPath(); c2d.moveTo(x, 0); c2d.lineTo(x, H); c2d.stroke();
      }
      for (let j = 0; j <= n; j++) {
        const y = H * j / n;
        c2d.beginPath(); c2d.moveTo(0, y); c2d.lineTo(W, y); c2d.stroke();
      }
      const r = Math.min(W, H) * 0.45;
      c2d.lineWidth = 3;
      c2d.beginPath(); c2d.arc(W / 2, H / 2, r, 0, Math.PI * 2); c2d.stroke();
      c2d.lineWidth = 2;
      c2d.beginPath(); c2d.moveTo(W / 2 - r, H / 2); c2d.lineTo(W / 2 + r, H / 2); c2d.stroke();
      c2d.beginPath(); c2d.moveTo(W / 2, H / 2 - r); c2d.lineTo(W / 2, H / 2 + r); c2d.stroke();
      c2d.fillStyle = "#fff"; c2d.font = `bold ${Math.round(H * 0.11)}px monospace`;
      c2d.textAlign = "center"; c2d.textBaseline = "middle";
      c2d.fillText("NBTV", W / 2, H / 2 - r / 2);
    } else if (name === "Resolution wedges") {
      c2d.fillStyle = "#fff";
      let x = 10, wbar = 24;
      while (x < W - 10 && wbar >= 1) {
        for (let k = 0; k < 4; k++) { c2d.fillRect(x, 10, wbar, H / 2 - 20); x += wbar * 2; }
        wbar = Math.max(1, Math.floor(wbar * 0.6)); x += 12;
      }
      let y = H / 2 + 10, hbar = 24;
      while (y < H - 10 && hbar >= 1) {
        for (let k = 0; k < 4; k++) { c2d.fillRect(10, y, W - 20, hbar); y += hbar * 2; }
        hbar = Math.max(1, Math.floor(hbar * 0.6)); y += 12;
      }
    } else if (name === "Motion demo (bouncing block + clock)") {
      c2d.fillStyle = "rgb(20,20,60)"; c2d.fillRect(0, 0, W, H);
      for (let i = 0; i < 6; i++) {
        const g = Math.round(255 * i / 5);
        c2d.fillStyle = `rgb(${g},${g},${g})`;
        c2d.fillRect(i * W / 6, 0, W / 6 + 1, H * 0.18);
      }
      const px = 0.5 + 0.42 * Math.sin(t * 2.0);
      const py = 0.55 + 0.30 * Math.abs(Math.sin(t * 3.1));
      const s = Math.min(W, H) * 0.16;
      c2d.fillStyle = "rgb(255,80,80)";
      c2d.fillRect(px * W - s, py * H - s, s * 2, s * 2);
      c2d.fillStyle = "rgb(80,255,120)";
      c2d.beginPath();
      c2d.arc(W * 0.1 + s * 0.8, H * 0.65 + s * 0.8, s * 0.8, 0, Math.PI * 2);
      c2d.fill();
      c2d.fillStyle = "#fff"; c2d.font = `bold ${Math.round(H * 0.10)}px monospace`;
      c2d.textAlign = "center"; c2d.textBaseline = "middle";
      c2d.fillText(new Date().toLocaleTimeString("en-GB"), W / 2, H * 0.32);
    } else if (name === "Black & white split") {
      c2d.fillStyle = "#fff"; c2d.fillRect(0, 0, W / 2, H);
      c2d.fillStyle = "#000";
      c2d.beginPath(); c2d.ellipse(W * 0.35, H * 0.5, W * 0.10, H * 0.10, 0, 0, Math.PI * 2); c2d.fill();
      c2d.fillStyle = "#fff";
      c2d.beginPath(); c2d.ellipse(W * 0.65, H * 0.5, W * 0.10, H * 0.10, 0, 0, Math.PI * 2); c2d.fill();
    } else {
      c2d.fillStyle = "rgb(128,128,128)"; c2d.fillRect(0, 0, W, H);
    }
  }

  function drawIdCard(c2d, W, H, settings, mode) {
    c2d.fillStyle = "#0b0e13"; c2d.fillRect(0, 0, W, H);
    c2d.strokeStyle = "#ffb454"; c2d.lineWidth = Math.max(3, H * 0.012);
    c2d.strokeRect(W * 0.04, H * 0.05, W * 0.92, H * 0.9);
    const call = (settings.callsign || "N0CALL").toUpperCase();
    const grid = (settings.grid || "").toUpperCase();
    c2d.textAlign = "center"; c2d.fillStyle = "#ffb454";
    c2d.font = `bold ${Math.round(H * 0.26)}px monospace`;
    c2d.textBaseline = "middle";
    c2d.fillText(call, W / 2, H * 0.34);
    c2d.fillStyle = "#45c7d6"; c2d.font = `bold ${Math.round(H * 0.10)}px monospace`;
    c2d.fillText(grid || "— NBTV —", W / 2, H * 0.55);
    c2d.fillStyle = "#e8ecf4"; c2d.font = `${Math.round(H * 0.075)}px monospace`;
    c2d.fillText(`${mode.lines} LINES · ${mode.fps} FPS`, W / 2, H * 0.70);
    const utc = new Date().toISOString().slice(11, 19) + " UTC";
    c2d.fillStyle = "#7bd88f"; c2d.font = `bold ${Math.round(H * 0.08)}px monospace`;
    c2d.fillText(utc, W / 2, H * 0.84);
  }

  /* =====================================================================
     Encoder — source frames in, composite (+ optional chroma) audio out.
     ===================================================================== */
  class Encoder {
    constructor(geom, colorSys, gain = 0.9) {
      this.g = geom;
      this.cs = colorSys;
      this.gain = gain;
      this.phase = 0;          // running fractional sample position
      this.frameNo = 0;
      this.grid = null;        // Float32Array lines*nPx*3, row = scan line
      const [gw, gh] = geom.gridSize();
      this.gw = gw; this.gh = gh;
      this._fit = document.createElement("canvas");
      this._fit.width = gw; this._fit.height = gh;
      this._fctx = this._fit.getContext ? this._fit.getContext("2d", { willReadFrequently: true }) : null;
    }

    /* pixel-exact path: a grid built by the file sender bypasses all
       fitting and resampling, exactly like the reference */
    setFrameFromGrid(grid) { this.grid = grid; }

    /* fit a source canvas to the mode aspect and sample it to the grid */
    setFrameFromCanvas(src, fill) {
      const f = this._fctx, gw = this.gw, gh = this.gh;
      const [aw, ah] = this.g.aspect;
      /* canvases report .width; <img>/<video> sources measure by their
         natural size (stills now reach here at full resolution) */
      const sw0 = src.naturalWidth || src.videoWidth || src.width;
      const sh0 = src.naturalHeight || src.videoHeight || src.height;
      if (!sw0 || !sh0) return;
      const target = aw / ah, cur = sw0 / sh0;
      f.fillStyle = "#000"; f.fillRect(0, 0, gw, gh);
      if (fill) {                       // crop source to aspect
        let sx = 0, sy = 0, sw = sw0, sh = sh0;
        if (cur > target) { sw = Math.round(sh * target); sx = (sw0 - sw) >> 1; }
        else if (cur < target) { sh = Math.round(sw / target); sy = (sh0 - sh) >> 1; }
        hqDraw(f, src, sx, sy, sw, sh, 0, 0, gw, gh);
      } else {                          // letterbox on black (aspect space —
        // the grid has non-square pixels, so scale by mode aspect, not px)
        let dw = gw, dh = gh;
        if (cur > target) dh = Math.max(1, Math.round(gh * target / cur));
        else if (cur < target) dw = Math.max(1, Math.round(gw * cur / target));
        hqDraw(f, src, 0, 0, sw0, sh0,
          (gw - dw) >> 1, (gh - dh) >> 1, dw, dh);
      }
      const d = f.getImageData(0, 0, gw, gh).data;
      const L = this.g.lines, P = this.g.nPx;
      const grid = this.grid && this.grid.length === L * P * 3
        ? this.grid : new Float32Array(L * P * 3);
      if (this.g.scan === "V") {
        // scan line li = image column li, swept bottom-to-top
        for (let li = 0; li < L; li++) {
          for (let j = 0; j < P; j++) {
            const idx = ((gh - 1 - j) * gw + li) * 4;
            const o = (li * P + j) * 3;
            grid[o] = d[idx] / 255; grid[o + 1] = d[idx + 1] / 255; grid[o + 2] = d[idx + 2] / 255;
          }
        }
      } else {
        for (let li = 0; li < L; li++) {
          for (let j = 0; j < P; j++) {
            const idx = (li * gw + j) * 4;
            const o = (li * P + j) * 3;
            grid[o] = d[idx] / 255; grid[o + 1] = d[idx + 1] / 255; grid[o + 2] = d[idx + 2] / 255;
          }
        }
      }
      this.grid = grid;
    }

    _rowY(li) {
      const P = this.g.nPx, g = this.grid, base = li * P * 3;
      const row = new Float32Array(P);
      for (let j = 0; j < P; j++) {
        const o = base + j * 3;
        row[j] = 0.299 * g[o] + 0.587 * g[o + 1] + 0.114 * g[o + 2];
      }
      return row;
    }

    _row(li, field) {
      const P = this.g.nPx, g = this.grid, base = li * P * 3;
      if (this.cs === "mono" || this.cs === "yc") return this._rowY(li);
      const row = new Float32Array(P);
      if (this.cs === "fsc") {
        for (let j = 0; j < P; j++) row[j] = g[base + j * 3 + field];
      } else { // lsc
        const plane = (li + field) % 3;
        for (let j = 0; j < P; j++) row[j] = g[base + j * 3 + plane];
      }
      return row;
    }

    /* chroma row for Y/C: U = B−Y on even lines, V = R−Y on odd */
    _rowC(li, yRow) {
      const P = this.g.nPx, g = this.grid, base = li * P * 3;
      const row = new Float32Array(P);
      const even = li % 2 === 0;
      for (let j = 0; j < P; j++) {
        const o = base + j * 3;
        row[j] = even ? (g[o + 2] - yRow[j]) : (g[o] - yRow[j]);
      }
      return row;
    }

    /* one full frame of float32 audio at the geometry sample rate.
       Returns { comp, chroma } — chroma is null except in Y/C mode. */
    encodeFrame() {
      const g = this.g;
      if (!this.grid) this.grid = new Float32Array(g.lines * g.nPx * 3);
      const field = this.frameNo % 3;
      const colour = this.cs === "fsc" || this.cs === "lsc";
      const yc = this.cs === "yc";
      const chunks = [], cchunks = [];
      let total = 0;
      for (let li = 0; li < g.lines; li++) {
        const start = this.phase;
        this.phase += g.spl;
        const nsamp = Math.round(this.phase) - Math.round(start);
        const broad = colour ? (li === 0 || (li === 1 && field === 0)) : (li === 0);
        const line = new Float32Array(nsamp).fill(BLACK);
        const syncN = clamp(Math.round(nsamp * (broad ? BROAD_F : SYNC_F)), 1, nsamp - 2);
        line.fill(0, 0, syncN);
        let a0 = 0, a1 = 0;
        if (!broad) {
          a0 = clamp(Math.max(Math.round(nsamp * g.actStartF), syncN), 1, nsamp - 1);
          a1 = clamp(Math.round(nsamp * g.actEndF), a0 + 1, nsamp);
          const yRow = this._row(li, field);
          const vid = resampleRow(yRow, a1 - a0);
          for (let k = 0; k < vid.length; k++) line[a0 + k] = BLACK + (1 - BLACK) * vid[k];
          if (yc) {
            const cline = new Float32Array(nsamp).fill(0.5);
            const cmax = li % 2 === 0 ? U_MAX : V_MAX;
            const c = resampleRow(this._rowC(li, yRow), a1 - a0);
            for (let k = 0; k < c.length; k++)
              cline[a0 + k] = 0.5 + 0.5 * clamp(c[k] / cmax, -1, 1);
            cchunks.push(cline);
          }
        } else if (yc) {
          cchunks.push(new Float32Array(nsamp).fill(0.5));
        }
        chunks.push(line); total += nsamp;
      }
      const comp = new Float32Array(total);
      let p = 0;
      for (const c of chunks) {
        for (let i = 0; i < c.length; i++) comp[p + i] = (c[i] * 2 - 1) * this.gain;
        p += c.length;
      }
      let chroma = null;
      if (yc) {
        chroma = new Float32Array(total);
        p = 0;
        for (const c of cchunks) {
          for (let i = 0; i < c.length; i++) chroma[p + i] = (c[i] * 2 - 1) * this.gain;
          p += c.length;
        }
      }
      this.frameNo++;
      if (this.phase > 1e9) this.phase -= Math.floor(this.phase);
      return { comp, chroma };
    }
  }

  /* =====================================================================
     Decoder — edge-driven flywheel sync, direct port of the reference.
     Falling edges below the sync threshold start lines; pulse width
     separates line syncs from broad frame syncs; missing pulses are
     coasted through at the estimated line period. Y/C reads the second
     channel: porch-referenced chroma, nearest-line fill, YUV → RGB.
     ===================================================================== */
  class Decoder {
    constructor(geom, colorSys) {
      this.g = geom;
      this.cs = colorSys;
      this.buf = new Float32Array(0);
      this.cbuf = new Float32Array(0);
      this.base = 0;
      this.lo = null; this.hi = null;
      this.syncLevel = 0.15;
      this.saturation = 1.0;
      this.splNom = geom.spl;
      this.splEst = geom.spl;
      this.locked = false;
      this.synced = false;
      this.curStart = 0;
      this.curBroad = false;
      this.lineIdx = 0;
      this.lastHandledF = -1;
      const L = geom.lines, P = geom.nPx;
      this.yb = new Float32Array(L * P);
      this.rgb = new Float32Array(L * P * 3);
      this.urows = new Float32Array(L * P);
      this.vrows = new Float32Array(L * P);
      this.umask = new Uint8Array(L);
      this.vmask = new Uint8Array(L);
      this.curPhase = 0;
      this.framesCount = 0;
      this.linesCount = 0;
      this.coasted = 0;
      this._out = [];
      this._n01 = null;
      this._c01 = null;
    }

    setSyncLevel(v) { this.syncLevel = clamp(v, 0.03, 0.45); }
    setSaturation(v) { this.saturation = clamp(v, 0, 3); }
    /* f0 > 0 notches the AM sound subcarrier out of the video (RX side
       only — the transmitted signal is untouched); 0 turns it off */
    setSoundNotch(f0) {
      this._notch = f0 ? new BiquadNotch(this.g.rate, f0, 3) : null;
      /* residual subcarrier sidebands ride the extremes; track the
         normalization range on a lightly smoothed copy so ripple peaks
         don't stretch it (the decoded waveform itself stays full-res) */
      this._nrmA = 1 - Math.exp(-2 * Math.PI * 2500 / this.g.rate);
      this._nrmY = 0;
    }

    feed(block, block2) {
      if (!block || block.length === 0) return [];
      if (this._notch) {
        /* the biquad rings on sync edges; spikes past the signal's real
           extremes would poison the min/max normalization below, so clamp
           the notched block back into the raw block's range */
        let rm = Infinity, rM = -Infinity;
        for (let i = 0; i < block.length; i++) {
          const v = block[i];
          if (v < rm) rm = v;
          if (v > rM) rM = v;
        }
        block = this._notch.process(block);
        for (let i = 0; i < block.length; i++)
          block[i] = block[i] < rm ? rm : (block[i] > rM ? rM : block[i]);
      }
      if (!block2 || block2.length !== block.length) block2 = block;
      this.buf = concatF32(this.buf, block);
      this.cbuf = concatF32(this.cbuf, block2);

      /* normalization tracking (fast attack, slow decay) */
      let bm = Infinity, bM = -Infinity;
      if (this._notch) {
        let y = this._nrmY;
        const a = this._nrmA;
        for (let i = 0; i < block.length; i++) {
          y += (block[i] - y) * a;
          if (y < bm) bm = y;
          if (y > bM) bM = y;
        }
        this._nrmY = y;
      } else {
        for (let i = 0; i < block.length; i++) {
          const v = block[i];
          if (v < bm) bm = v;
          if (v > bM) bM = v;
        }
      }
      if (this.lo === null) { this.lo = bm; this.hi = bM; }
      else {
        const span0 = Math.max(this.hi - this.lo, 1e-6);
        this.lo = bm < this.lo ? bm : this.lo + 0.02 * (bm - this.lo);
        this.hi = bM > this.hi ? bM : this.hi - 0.0008 * span0;
      }
      const span = Math.max(this.hi - this.lo, 1e-6);
      const n = this.buf.length;
      const n01 = new Float32Array(n);
      const c01 = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        n01[i] = (this.buf[i] - this.lo) / span;
        c01[i] = (this.cbuf[i] - this.lo) / span;
      }
      this._n01 = n01;
      this._c01 = c01;

      /* falling / rising edges of the below-threshold mask */
      const lvl = this.syncLevel;
      const falls = [], rises = [];
      let prev = n01[0] < lvl;
      for (let i = 1; i < n; i++) {
        const cur = n01[i] < lvl;
        if (cur && !prev) falls.push(i);
        else if (!cur && prev) rises.push(i);
        prev = cur;
      }

      this._out = [];
      let unmatchedFallAbs = null;
      let rj = 0;
      for (let fi2 = 0; fi2 < falls.length; fi2++) {
        const fi = falls[fi2];
        const fAbs = this.base + fi;
        if (fAbs <= this.lastHandledF) continue;
        while (rj < rises.length && rises[rj] <= fi) rj++;
        if (rj >= rises.length) { unmatchedFallAbs = fAbs; break; }
        const width = rises[rj] - fi;
        this.lastHandledF = fAbs;
        if (width < Math.max(2, 0.03 * this.splEst)) continue;   // noise blip
        const broad = width >= 0.30 * this.splEst;
        this._handleSync(fAbs, broad);
      }

      /* trim the buffer, keeping the current line and any partial pulse */
      let keepAbs = this.base + n - 8;
      if (this.locked) keepAbs = Math.min(keepAbs, Math.floor(this.curStart) - 8);
      if (unmatchedFallAbs !== null) keepAbs = Math.min(keepAbs, unmatchedFallAbs - 8);
      keepAbs = Math.max(keepAbs, this.base);
      let cut = keepAbs - this.base;
      if (cut > 0) {
        this.buf = this.buf.slice(cut);
        this.cbuf = this.cbuf.slice(cut);
        this.base = keepAbs;
      }
      const maxlen = Math.round(this.splNom * (this.g.lines + 8));
      if (this.buf.length > maxlen) {                 // garbage input, no syncs
        cut = this.buf.length - maxlen;
        this.buf = this.buf.slice(cut);
        this.cbuf = this.cbuf.slice(cut);
        this.base += cut;
        if (this.locked && this.curStart < this.base) this.locked = false;
      }
      return this._out;
    }

    _handleSync(eAbs, broad) {
      if (!this.locked) {
        this.locked = true;
        this.curStart = eAbs;
        this.curBroad = broad;
        this.lineIdx = 0;
        if (broad) this._frameBegin(true);
        return;
      }
      let gap = eAbs - this.curStart;
      if (gap < 0.45 * this.splEst) return;           // too soon — ignore
      let coasted = false;
      while (gap > 1.6 * this.splEst) {               // coast missing pulses
        this._emitLine(this.curStart, this.curStart + this.splEst);
        this.curStart += this.splEst;
        gap = eAbs - this.curStart;
        this.coasted++;
        coasted = true;
      }
      const prevBroad = this.curBroad && !coasted;
      this._emitLine(this.curStart, eAbs);
      if (gap > 0.8 * this.splEst && gap < 1.2 * this.splEst) {
        this.splEst += 0.03 * (gap - this.splEst);
        const lim = 0.06 * this.splNom;
        this.splEst = clamp(this.splEst, this.splNom - lim, this.splNom + lim);
      }
      if (broad && !prevBroad) {                      // new frame begins here
        this._finishFrame();
        this.lineIdx = 0;
        this._frameBegin(true);
        this.synced = true;
      } else if (broad && prevBroad) {                // colour-phase anchor
        this.curPhase = 0;
      }
      this.curStart = eAbs;
      this.curBroad = broad;
    }

    _frameBegin(anchorPossible) {
      if (this.framesCount > 0 || !anchorPossible) this.curPhase = (this.curPhase + 1) % 3;
      else this.curPhase = 0;
    }

    _emitLine(s, e) {
      const g = this.g, P = g.nPx;
      if (!this.curBroad) {
        const L = e - s;
        const rel = s - this.base;
        let i0 = Math.round(rel + L * g.actStartF);
        let i1 = Math.round(rel + L * g.actEndF);
        i0 = clamp(i0, 0, this.buf.length - 2);
        i1 = clamp(i1, i0 + 2, this.buf.length);
        let p0 = Math.round(rel + L * SYNC_F * 1.05);
        let p1 = Math.round(rel + L * g.actStartF * 0.98);
        p0 = clamp(p0, 0, this.buf.length - 2);
        p1 = clamp(p1, p0 + 1, this.buf.length);
        let porch = 0;
        for (let i = p0; i < p1; i++) porch += this._n01[i];
        porch /= (p1 - p0);
        const m = i1 - i0;
        const vid = new Float32Array(m);
        for (let i = 0; i < m; i++) vid[i] = (this._n01[i0 + i] - porch) / (1 - BLACK);
        const row = resampleRow(vid, P);
        const li = this.lineIdx % g.lines;
        if (this.cs === "lsc") {
          const plane = (li + this.curPhase) % 3;
          for (let j = 0; j < P; j++) {
            const v = clamp(row[j], 0, 1);
            this.rgb[(li * P + j) * 3 + plane] = v;
            this.yb[li * P + j] = v;
          }
        } else { // mono, fsc, yc
          for (let j = 0; j < P; j++) this.yb[li * P + j] = clamp(row[j], 0, 1);
        }
        if (this.cs === "yc") {
          let cref = 0;
          for (let i = p0; i < p1; i++) cref += this._c01[i];
          cref /= (p1 - p0);
          const cseg = new Float32Array(m);
          for (let i = 0; i < m; i++) cseg[i] = this._c01[i0 + i] - cref;
          const crow = resampleRow(cseg, P);
          if (li % 2 === 0) {
            for (let j = 0; j < P; j++)
              this.urows[li * P + j] = crow[j] * 2 * U_MAX * this.saturation;
            this.umask[li] = 1;
          } else {
            for (let j = 0; j < P; j++)
              this.vrows[li * P + j] = crow[j] * 2 * V_MAX * this.saturation;
            this.vmask[li] = 1;
          }
        }
      }
      this.lineIdx++;
      this.linesCount++;
      this.curBroad = false;
      if (this.lineIdx >= this.g.lines && !this.synced) {
        this._finishFrame();                 // free-run wrap, no frame pulses
        this.lineIdx = 0;
        this._frameBegin(false);
      } else if (this.lineIdx >= 2 * this.g.lines) {
        this._finishFrame();                 // frame pulses lost mid-stream
        this.lineIdx = 0;
        this._frameBegin(false);
      }
    }

    /* nearest-row fill for the chroma parity this line skipped */
    _fillRows(rows, mask) {
      const L = this.g.lines, P = this.g.nPx;
      const idx = [];
      for (let i = 0; i < L; i++) if (mask[i]) idx.push(i);
      const out = new Float32Array(rows);
      if (!idx.length) return out;
      for (let i = 0; i < L; i++) {
        if (mask[i]) continue;
        let best = idx[0], bd = Math.abs(idx[0] - i);
        for (const k of idx) {
          const d = Math.abs(k - i);
          if (d < bd) { bd = d; best = k; }
        }
        out.set(rows.subarray(best * P, best * P + P), i * P);
      }
      return out;
    }

    _finishFrame() {
      const g = this.g, L = g.lines, P = g.nPx;
      const out = new Float32Array(L * P * 3);
      if (this.cs === "mono") {
        for (let i = 0; i < L * P; i++) {
          const v = this.yb[i];
          out[i * 3] = v; out[i * 3 + 1] = v; out[i * 3 + 2] = v;
        }
      } else if (this.cs === "fsc") {
        for (let i = 0; i < L * P; i++) this.rgb[i * 3 + this.curPhase] = this.yb[i];
        out.set(this.rgb);
      } else if (this.cs === "yc") {
        const u = this._fillRows(this.urows, this.umask);
        const v = this._fillRows(this.vrows, this.vmask);
        for (let i = 0; i < L * P; i++) {
          const y = this.yb[i];
          const r = y + v[i];
          const b = y + u[i];
          const gg = (y - 0.299 * r - 0.114 * b) / 0.587;
          out[i * 3] = clamp(r, 0, 1);
          out[i * 3 + 1] = clamp(gg, 0, 1);
          out[i * 3 + 2] = clamp(b, 0, 1);
        }
      } else {
        out.set(this.rgb);
      }
      this.framesCount++;
      this._out.push({
        rgb: out,
        info: {
          frames: this.framesCount, lines: this.linesCount,
          locked: this.locked, synced: this.synced,
          spl: this.splEst, coasted: this.coasted
        }
      });
    }
  }

  /* paint a (lines × nPx × rgb) grid onto a display canvas with the
     correct scan orientation (V = columns swept bottom-to-top) */
  function paintGrid(target, native, grid, geom) {
    const L = geom.lines, P = geom.nPx;
    const V = geom.scan === "V";
    const W = V ? L : P, H = V ? P : L;
    if (native.width !== W || native.height !== H) { native.width = W; native.height = H; }
    const nctx = native.getContext("2d");
    const img = nctx.createImageData(W, H);
    const d = img.data;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const li = V ? x : y;
        const j = V ? (P - 1 - y) : x;
        const o = (li * P + j) * 3;
        const q = (y * W + x) * 4;
        d[q]     = Math.round(clamp(grid[o], 0, 1) * 255);
        d[q + 1] = Math.round(clamp(grid[o + 1], 0, 1) * 255);
        d[q + 2] = Math.round(clamp(grid[o + 2], 0, 1) * 255);
        d[q + 3] = 255;
      }
    }
    nctx.putImageData(img, 0, 0);
    const t = target.getContext("2d");
    t.clearRect(0, 0, target.width, target.height);
    hqDraw(t, native, 0, 0, W, H, 0, 0, target.width, target.height);
  }

  /* =====================================================================
     File over NBTV — QR carousel. Direct port of the reference protocol:
       "M" + b36(chunks,3) + b36(size,6) + b36(crc32,7)   meta frame
       "N" + base64(filename)                              name frame
       "D" + b36(seq,3) + base64(chunk)                    data frames
     Frames are rendered pixel-exact on the scan grid and looped until the
     receiver has every chunk; CRC failure restarts collection.
     ===================================================================== */
  const QR_SKIP_LINES = 2;      // lines 0..1 may carry broad sync
  const QR_FILTER_RATIO = 0.55; // module width vs low-pass blur, minimum
  const MAX_CHUNKS = 36 * 36 * 36 - 1;

  /* the 7×7 finder pattern, plus its zero-mean stats (for Pearson) */
  const QR_FINDER = Float32Array.from([
    1, 1, 1, 1, 1, 1, 1,
    1, 0, 0, 0, 0, 0, 1,
    1, 0, 1, 1, 1, 0, 1,
    1, 0, 1, 1, 1, 0, 1,
    1, 0, 1, 1, 1, 0, 1,
    1, 0, 0, 0, 0, 0, 1,
    1, 1, 1, 1, 1, 1, 1
  ]);
  const FINDER_MEAN = 33 / 49;
  const FINDER_FZ = Float32Array.from(QR_FINDER, v => v - FINDER_MEAN);
  const FINDER_FZN = Math.sqrt(FINDER_FZ.reduce((s, v) => s + v * v, 0));

  /* byte-mode capacity, versions 1..40 × [L, M, Q, H] (ISO/IEC 18004) */
  const QR_CAP = [
    [17, 14, 11, 7], [32, 26, 20, 14], [53, 42, 32, 24], [78, 62, 46, 34],
    [106, 84, 60, 44], [134, 106, 74, 58], [154, 122, 86, 64], [192, 152, 108, 84],
    [230, 180, 130, 98], [271, 213, 151, 119], [321, 251, 177, 137], [367, 287, 203, 155],
    [425, 331, 241, 177], [458, 362, 258, 194], [520, 412, 292, 220], [586, 450, 322, 250],
    [644, 504, 364, 280], [718, 560, 394, 310], [792, 624, 442, 338], [858, 666, 482, 382],
    [929, 711, 509, 403], [1003, 779, 565, 439], [1091, 857, 611, 461], [1171, 911, 661, 511],
    [1273, 997, 715, 535], [1367, 1059, 751, 593], [1465, 1125, 805, 625], [1528, 1190, 868, 658],
    [1628, 1264, 908, 698], [1732, 1370, 982, 742], [1840, 1452, 1030, 790], [1952, 1538, 1112, 842],
    [2068, 1628, 1168, 898], [2188, 1722, 1228, 958], [2303, 1809, 1283, 983], [2431, 1911, 1351, 1051],
    [2563, 1989, 1423, 1093], [2699, 2099, 1499, 1139], [2809, 2213, 1579, 1219], [2953, 2331, 1663, 1273]
  ];
  function qrCapacity(version, ec) { return QR_CAP[version - 1][ec]; }

  /* module sizes and placement for a `need`-module QR in this geometry */
  function qrFit(geom, need) {
    const gs = geom.gridSize();
    const gw = gs[0], gh = gs[1];
    let alongTotal, crossTotal;
    if (geom.scan === "V") { alongTotal = gh; crossTotal = gw - QR_SKIP_LINES; }
    else { alongTotal = gw; crossTotal = gh - QR_SKIP_LINES; }
    const pAlong = Math.floor(alongTotal / need);
    const pCross = Math.floor(crossTotal / need);
    if (pAlong < 1 || pCross < 1) return null;
    const along0 = Math.floor((alongTotal - need * pAlong) / 2);
    const cross0 = QR_SKIP_LINES + Math.floor((crossTotal - need * pCross) / 2);
    let ph, pv, x0, y0;
    if (geom.scan === "V") { pv = pAlong; ph = pCross; y0 = along0; x0 = cross0; }
    else { ph = pAlong; pv = pCross; x0 = along0; y0 = cross0; }
    return { ph, pv, x0, y0, pAlong, pCross };
  }

  /* pick the largest QR version this mode (+ filter) can carry */
  function qrPlan(geom, cutoff, ec) {
    const spp = geom.spl * geom.activeF / geom.nPx;   // samples per px along line
    const blur = cutoff ? geom.rate / cutoff : 0;
    for (const trim of [0, 1, 2]) {
      for (let version = 40; version >= 1; version--) {
        const need = 17 + 4 * version + 4 - 2 * trim;
        const fit = qrFit(geom, need);
        if (!fit) continue;
        if (blur && (fit.pAlong < 2 || fit.pAlong * spp < QR_FILTER_RATIO * blur)) continue;
        const cap = qrCapacity(version, ec);
        if (cap < 17) continue;
        const marginal = [];
        if (fit.pCross === 1) marginal.push("1 scan line per module");
        if (!blur && fit.pAlong === 1) marginal.push("1 sample per module");
        return {
          plan: {
            version, trim, need,
            ph: fit.ph, pv: fit.pv, x0: fit.x0, y0: fit.y0,
            pAlong: fit.pAlong, pCross: fit.pCross,
            cap, marginal: marginal.join(", ")
          },
          err: null
        };
      }
    }
    return {
      plan: null,
      err: blur
        ? "This mode + filter can't carry a QR: the low-pass smears modules " +
          "along the scan line. Use Direct cable, a wider filter, or fewer lines."
        : "Mode too small for even the smallest QR code."
    };
  }

  /* one file-transfer frame as a pixel-exact scan grid */
  function qrRenderGrid(geom, plan, ec, payload) {
    const q = window.qrcode(plan.version, ECL[ec]);
    q.addData(payload, "Byte");
    q.make();
    const mc = q.getModuleCount();
    const qz = 2 - plan.trim;                 // quiet modules kept per side
    const gs = geom.gridSize();
    const gw = gs[0], gh = gs[1];
    const img = new Float32Array(gw * gh).fill(1);   // white background
    for (let r = 0; r < plan.need; r++) {
      for (let c = 0; c < plan.need; c++) {
        const mr = r - qz, mcc = c - qz;
        const dark = mr >= 0 && mcc >= 0 && mr < mc && mcc < mc && q.isDark(mr, mcc);
        if (!dark) continue;
        const yy = plan.y0 + r * plan.pv, xx = plan.x0 + c * plan.ph;
        for (let dy = 0; dy < plan.pv; dy++)
          img.fill(0, (yy + dy) * gw + xx, (yy + dy) * gw + xx + plan.ph);
      }
    }
    return imageLumaToGrid(img, gw, gh, geom);
  }

  class FileSender {
    constructor() { this.name = ""; this.data = null; this.grids = []; this.stats = null; }
    load(name, u8) { this.name = name; this.data = u8; this.grids = []; this.stats = null; }
    build(geom, cutoff, ec, repeat) {
      if (!this.data || !this.data.length)
        throw new Error("No file loaded (or the file is empty).");
      const { plan, err } = qrPlan(geom, cutoff, ec);
      if (!plan) throw new Error(err);
      const raw = Math.floor((plan.cap - 4) / 4) * 3;
      if (raw < 1) throw new Error("QR too small for any payload in this mode.");
      const n = Math.ceil(this.data.length / raw);
      if (n > MAX_CHUNKS)
        throw new Error(`File too big for this mode: needs ${n} chunks ` +
          `(max ${MAX_CHUNKS}). Use a bigger mode or a smaller file.`);
      const crc = crc32(this.data);
      const payloads = ["M" + b36e(n, 3) + b36e(this.data.length, 6) + b36e(crc, 7)];
      const nb64 = bytesToB64(new TextEncoder().encode(this.name));
      if (plan.cap >= 1 + nb64.length) payloads.push("N" + nb64);
      for (let i = 0; i < n; i++)
        payloads.push("D" + b36e(i + 1, 3) +
          bytesToB64(this.data.subarray(i * raw, Math.min((i + 1) * raw, this.data.length))));
      this.grids = payloads.map(p => qrRenderGrid(geom, plan, ec, p));
      const period = repeat / geom.fps;
      const passS = this.grids.length * period;
      this.stats = {
        plan, chunks: n, raw, totalFrames: this.grids.length,
        period, passSeconds: passS,
        rate: passS ? this.data.length / passS : 0
      };
      return this.stats;
    }
  }

  class FileReceiver {
    /* Stateless-per-frame QR receiver: scores every version that fits by
       its finder-pattern correlation, shift-searches the shortlist,
       re-rasterises the winner crisply and hands it to jsQR. */
    constructor(geom) {
      this.geom = geom;
      this.cands = [];
      for (let version = 40; version >= 1; version--) {
        for (const trim of [0, 1, 2]) {
          const need = 17 + 4 * version + 4 - 2 * trim;
          const fit = qrFit(geom, need);
          if (fit) {
            this.cands.push({ version, trim, need, ph: fit.ph, pv: fit.pv, x0: fit.x0, y0: fit.y0 });
            break;                       // one trim per version is enough
          }
        }
      }
      this.lastCand = null;
      this.reset();
    }

    reset() {
      this.n = null; this.size = null; this.crc = null; this.name = "";
      this.chunks = new Map();
      this.done = false; this.blob = null;
      this.framesSeen = 0; this.framesDecoded = 0;
    }

    _cells(a, w, h, c, dy, dx) {
      const bh = c.need * c.pv, bw = c.need * c.ph;
      const yy = c.y0 + dy, xx = c.x0 + dx;
      if (yy < 0 || xx < 0 || yy + bh > h || xx + bw > w) return null;
      const cells = new Float32Array(c.need * c.need);
      const inv = 1 / (c.pv * c.ph);
      for (let r = 0; r < c.need; r++) {
        for (let q = 0; q < c.need; q++) {
          let s = 0;
          for (let dy2 = 0; dy2 < c.pv; dy2++) {
            const row = (yy + r * c.pv + dy2) * w + xx + q * c.ph;
            for (let dx2 = 0; dx2 < c.ph; dx2++) s += a[row + dx2];
          }
          cells[r * c.need + q] = s * inv;
        }
      }
      return cells;
    }

    /* mean Pearson correlation of the three corner finders vs the ideal */
    _finderScore(cells, need, trim) {
      const q = 2 - trim;
      const m = need - 2 * q;
      if (m < 7) return -1e18;
      let total = 0;
      const corners = [[q, q], [q, q + m - 7], [q + m - 7, q]];
      for (const rc of corners) {
        const r0 = rc[0], c0 = rc[1];
        let mean = 0;
        for (let r = 0; r < 7; r++)
          for (let c = 0; c < 7; c++) mean += 1 - cells[(r0 + r) * need + c0 + c];
        mean /= 49;
        let num = 0, ss = 0;
        for (let r = 0; r < 7; r++)
          for (let c = 0; c < 7; c++) {
            const d = (1 - cells[(r0 + r) * need + c0 + c]) - mean;
            num += d * FINDER_FZ[r * 7 + c];
            ss += d * d;
          }
        total += num / (Math.sqrt(ss) * FINDER_FZN + 1e-9);
      }
      return total / 3;
    }

    /* binarise the cell grid, blow it up crisp, let jsQR read it */
    _tryDecode(cells, need) {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < cells.length; i++) {
        if (cells[i] < lo) lo = cells[i];
        if (cells[i] > hi) hi = cells[i];
      }
      if (hi - lo < 0.05) return null;
      const thr = 0.5 * (lo + hi);
      const S = 8, PAD = 32, W = need * S + 2 * PAD;
      const rgba = new Uint8ClampedArray(W * W * 4).fill(255);
      for (let r = 0; r < need; r++) {
        for (let c = 0; c < need; c++) {
          if (cells[r * need + c] > thr) continue;       // bright = white
          for (let y = 0; y < S; y++) {
            let idx = ((PAD + r * S + y) * W + PAD + c * S) * 4;
            for (let x = 0; x < S; x++) {
              rgba[idx] = 0; rgba[idx + 1] = 0; rgba[idx + 2] = 0;
              idx += 4;
            }
          }
        }
      }
      const res = window.jsQR(rgba, W, W, { inversionAttempts: "dontInvert" });
      return res && res.data ? res.data : null;
    }

    /* feed one decoded display frame; returns an event string or null */
    offer(luma) {
      if (this.done || typeof window.jsQR !== "function" || !this.cands.length) return null;
      this.framesSeen++;
      const a = luma.a, w = luma.w, h = luma.h;
      const scored = [];
      for (const c of this.cands) {
        const cl = this._cells(a, w, h, c, 0, 0);
        if (cl) scored.push([this._finderScore(cl, c.need, c.trim), c]);
      }
      if (!scored.length) return null;
      scored.sort((p, q) => q[0] - p[0]);
      const short = scored.slice(0, 2).map(t => t[1]);
      if (this.lastCand && short.indexOf(this.lastCand) < 0) short.unshift(this.lastCand);
      let best = { sc: -1e18, cells: null, c: null };
      for (const c of short) {
        const S = Math.max(2, c.ph + c.pv);
        for (let dy = -S; dy <= S; dy++) {
          for (let dx = -S; dx <= S; dx++) {
            const cl = this._cells(a, w, h, c, dy, dx);
            if (!cl) continue;
            const sc = this._finderScore(cl, c.need, c.trim);
            if (sc > best.sc) best = { sc, cells: cl, c };
          }
        }
      }
      if (!best.cells) return null;
      const data = this._tryDecode(best.cells, best.c.need);
      if (!data) return null;
      this.lastCand = best.c;
      this.framesDecoded++;
      return this._ingest(data);
    }

    _ingest(s) {
      try {
        const kind = s[0];
        if (kind === "M" && s.length >= 17) {
          this.n = b36d(s.slice(1, 4));
          this.size = b36d(s.slice(4, 10));
          this.crc = b36d(s.slice(10, 17));
          return this._maybeFinish() || "meta";
        }
        if (kind === "N") {
          const raw = new TextDecoder().decode(b64ToBytes(s.slice(1)));
          this.name = raw.split(/[\\/]/).pop().slice(0, 120);
          return "name";
        }
        if (kind === "D" && s.length > 4) {
          const seq = b36d(s.slice(1, 4));
          if (!this.chunks.has(seq)) {
            this.chunks.set(seq, b64ToBytes(s.slice(4)));
            return this._maybeFinish() || "chunk";
          }
          return null;
        }
      } catch (e) { return null; }
      return null;
    }

    _maybeFinish() {
      if (this.n === null || this.done || this.chunks.size < this.n) return null;
      let total = 0;
      for (let i = 1; i <= this.n; i++) {
        const c = this.chunks.get(i);
        if (!c) return null;
        total += c.length;
      }
      const blob = new Uint8Array(total);
      let p = 0;
      for (let i = 1; i <= this.n; i++) {
        const c = this.chunks.get(i);
        blob.set(c, p); p += c.length;
      }
      if (blob.length !== this.size || crc32(blob) !== this.crc) {
        this.chunks.clear();          // a wrong chunk slipped through
        return "crc-restart";
      }
      this.blob = blob;
      this.done = true;
      return "complete";
    }

    progress() { return [this.chunks.size, this.n]; }
  }

  /* lazy vendor-script loading */
  const _vendorLoads = {};
  function loadVendor(name) {
    const have = name === "jsqr" ? window.jsQR : window.qrcode;
    if (have) return Promise.resolve();
    if (_vendorLoads[name]) return _vendorLoads[name];
    _vendorLoads[name] = new Promise((res, rej) => {
      const sc = document.createElement("script");
      sc.src = BASE + "vendor/" + (name === "jsqr" ? "jsqr.js" : "qrcode.js");
      sc.onload = () => res();
      sc.onerror = () => { delete _vendorLoads[name]; rej(new Error(name + " failed to load")); };
      document.head.appendChild(sc);
    });
    return _vendorLoads[name];
  }

  /* =====================================================================
     Module definition
     ===================================================================== */
  const def = {
    id: "nbtv",

    init(ctx) {
      this.ctx = ctx;
      this.modeId = "club32";
      this.colorSys = "mono";
      this.fill = true;
      this.source = "pattern:" + PATTERNS[0];
      this.filterIdx = 0;
      this.dec = null;
      this.enc = null;
      this.firC = null;             // composite TX low-pass
      this.firK = null;             // chroma TX low-pass (Y/C)
      this.txRunning = false;
      this.loop = false;
      this.txNodes = new Set();
      this.txTimer = null;
      this.txNext = 0;
      this.txFrames = 0;
      this.selfTx = false;          // guard for our own tx-start event
      this.cam = null;              // MediaStream
      this.video = null;
      this.srcCanvas = null;
      this.imageObj = null;         // uploaded Image
      this.nativeTx = document.createElement("canvas");
      this.nativeRx = document.createElement("canvas");
      /* file link state */
      this.fileSender = new FileSender();
      this.fileRx = null;
      this.fileArmed = false;
      this.fileTxActive = false;
      this.fileFrame = 0;
      this.fileEc = 1;              // M
      this.fileRepeat = 2;
      this._lastOffer = 0;
      /* uploaded media (video / animated GIF) + soundtrack */
      this.media = null;            // { kind, name, dur, fps?, frames, nFrames }
      this.mediaAudio = null;       // { name, data, rate, dur } — mono PCM
      this.mediaFile = null;        // original video File (re-scanned on fps change)
      this.sndSrc = "off";          // AM sound subcarrier source: off | mic | media
      this._mediaEpoch = 0;         // cancels superseded loads
      this._winBusy = false;        // video decode-window filler guard
      this._lastBmp = null;
      this._gifCursor = 0;

      /* decode everything that arrives while RX runs */
      if (!this._subscribed) {
        this._subscribed = true;
        ctx.audio.onSamples((samples, sr, samples2) => {
          if (this.sndSrc === "mic" && this.sndTx) this.sndTx.push(samples);   // live mic commentary
          if (this.loop) return;               // loopback feeds RX internally
          if (this.sndRxOn && !this._wavBusy) {   // WAV decode plays its own soundtrack
            if (!this.sndRx) {
              const f = this.format;
              const pl = sndPlan(f, ctx.audio.ensureContext().sampleRate, this._cutoff());
              this.sndRx = new SndRx(ctx.audio.ensureContext(), pl.f,
                f ? f.lines * f.fps : 0, undefined, pl.aud);
            }
            this.sndRx.setGate(!!(this.dec && this.dec.locked));
            this.sndRx.process(samples);
          }
          if (!this.dec || !this.ui || this._wavBusy) return;
          const frames = this.dec.feed(samples, samples2);
          if (frames.length) this._showRxFrame(frames[frames.length - 1]);
          else if ((this._statTick = (this._statTick || 0) + 1) % 10 === 0) this._updateStats(null);
        });
        ctx.audio.on("rx-start", () => { this._rebuildDecoder(); this._updateSndUi(); });
        ctx.audio.on("rx-stop", () => this._updateSndUi());
        /* another module keyed up — stop our stream so signals don't mix */
        ctx.audio.on("tx-start", () => { if (!this.selfTx) this._stopTx(true); });
      }
    },

    createPanel(el) {
      const modeOpts = MODES.map(m => `<option value="${m.id}">${m.name}</option>`).join("");
      const srcOpts = PATTERNS.map(p => `<option value="pattern:${p}">${p}</option>`).join("") +
        `<option value="idcard">Station ID card</option>` +
        `<option value="image">Uploaded image</option>` +
        `<option value="media">Uploaded video / GIF</option>` +
        `<option value="camera">Webcam (live)</option>`;
      const filtOpts = FILTERS.map((f, i) => `<option value="${i}">${f[0]}</option>`).join("");
      el.innerHTML = `
        <div class="mod-layout">
          <div class="mod-main">
            <div class="card">
              <header class="card-head"><h3>RX monitor</h3>
                <span class="card-tag mono" id="nbtv-rx-stat">no signal</span></header>
              <div style="padding:14px;display:flex;justify-content:center;background:#05070b">
                <canvas id="nbtv-rx" width="384" height="288"
                  style="max-width:100%;border:1px solid rgba(96,114,150,0.3);background:#000"></canvas>
              </div>
              <div class="card-foot mod-controls">
                <label class="field" style="flex:1;min-width:170px"><span>Sync level</span>
                  <input type="range" id="nbtv-sync" min="0.03" max="0.45" step="0.01" value="0.15"></label>
                <span class="mono" id="nbtv-sync-val" style="min-width:40px">0.15</span>
                <label class="field" style="flex:1;min-width:170px"><span>Chroma sat (Y/C)</span>
                  <input type="range" id="nbtv-sat" min="0" max="3" step="0.05" value="1"></label>
                <button class="btn" id="nbtv-rxreset">Reset RX</button>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>TX monitor</h3>
                <span class="card-tag mono" id="nbtv-tx-stat">idle</span></header>
              <div style="padding:14px;display:flex;justify-content:center;background:#05070b">
                <canvas id="nbtv-tx" width="384" height="288"
                  style="max-width:100%;border:1px solid rgba(96,114,150,0.3);background:#000"></canvas>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>File link — QR over video</h3>
                <span class="card-tag mono" id="nbtv-fstat">idle</span></header>
              <div class="card-body mod-controls" style="flex-wrap:wrap">
                <label class="btn" for="nbtv-ffile">Choose file…</label>
                <input type="file" id="nbtv-ffile" style="display:none">
                <span class="mono" id="nbtv-fname" style="flex:1;min-width:140px;overflow:hidden;text-overflow:ellipsis">no file</span>
                <label class="field"><span>EC</span>
                  <select id="nbtv-fec">
                    <option value="0">L (biggest chunks)</option>
                    <option value="1" selected>M (default)</option>
                    <option value="2">Q (most robust)</option>
                  </select></label>
                <label class="field"><span>Repeat</span>
                  <input type="number" id="nbtv-frep" min="1" max="5" step="1" value="2" style="width:58px"></label>
                <button class="btn btn-accent" id="nbtv-fsend">Send file</button>
                <button class="btn" id="nbtv-fstop" disabled>Stop file</button>
              </div>
              <div class="card-foot">
                <div class="mono" id="nbtv-fplan" style="font-size:11px;white-space:pre-wrap"></div>
                <div class="mod-controls" style="margin-top:8px">
                  <button class="btn" id="nbtv-farm">Arm file RX</button>
                  <span class="mono" id="nbtv-frx" style="flex:1">RX idle</span>
                  <a class="btn btn-accent" id="nbtv-fdl" style="display:none" download>Save received file</a>
                </div>
              </div>
            </div>
          </div>
          <div class="mod-side">
            <div class="card">
              <header class="card-head"><h3>1 · Source</h3></header>
              <div class="card-body mod-controls" style="flex-direction:column;align-items:stretch">
                <label class="field"><span>Picture</span>
                  <select id="nbtv-source">${srcOpts}</select></label>
                <label class="field"><span>Fit</span>
                  <select id="nbtv-fit">
                    <option value="fill">Fill (crop)</option>
                    <option value="letterbox">Letterbox</option>
                  </select></label>
                <label class="btn" for="nbtv-file" style="text-align:center">Load image / video / GIF…</label>
                <input type="file" id="nbtv-file" accept="image/*,video/*" style="display:none">
                <div class="mod-note mono" id="nbtv-mediastat" style="font-size:11px;white-space:pre-wrap;display:none"></div>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>2 · Sound — AM subcarrier</h3></header>
              <div class="card-body mod-controls" style="flex-direction:column;align-items:stretch">
                <label class="field"><span>TX sound source</span>
                  <select id="nbtv-sndsrc">
                    <option value="off">off — picture only</option>
                    <option value="mic">live mic commentary</option>
                    <option value="media">file soundtrack</option>
                  </select></label>
                <label class="btn" for="nbtv-sfile" style="text-align:center">Load soundtrack (audio)…</label>
                <input type="file" id="nbtv-sfile" accept="audio/*,.wav,.mp3,.ogg,.m4a,.flac" style="display:none">
                <div class="mod-note mono" id="nbtv-sndstat" style="font-size:11px;white-space:pre-wrap"></div>
                <label class="mono muted" style="font-size:12px"><input type="checkbox" id="nbtv-sndrx"> 🔊 decode AM sound on RX (speaker)</label>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>3 · Mode</h3></header>
              <div class="card-body mod-controls" style="flex-direction:column;align-items:stretch">
                <label class="field"><span>Standard</span>
                  <select id="nbtv-mode">${modeOpts}</select></label>
                <label class="field"><span>Colour</span>
                  <select id="nbtv-colour">
                    <option value="mono">Monochrome</option>
                    <option value="fsc">Frame-sequential (R,G,B fields)</option>
                    <option value="lsc">Line-sequential (R,G,B lines)</option>
                    <option value="yc">Stereo Y/C (L luma · R chroma)</option>
                  </select></label>
                <div class="mod-note mono" id="nbtv-geom" style="font-size:11px"></div>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>4 · TX chain</h3></header>
              <div class="card-body mod-controls" style="flex-direction:column;align-items:stretch">
                <label class="field"><span>Output filter</span>
                  <select id="nbtv-filter">${filtOpts}</select></label>
                <label class="field"><span>Sample rate</span>
                  <select id="nbtv-rate">
                    <option value="0">Device default</option>
                    <option value="48000">48 000 Hz</option>
                    <option value="96000">96 000 Hz (wideband)</option>
                    <option value="192000">192 000 Hz (wideband)</option>
                  </select></label>
                <div class="mod-note mono" id="nbtv-rate-note" style="font-size:11px"></div>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>5 · Run</h3></header>
              <div class="card-body mod-controls" style="flex-direction:column;align-items:stretch">
                <button class="btn btn-accent" id="nbtv-loop">▶ Loopback — watch TX→RX live</button>
                <button class="btn btn-accent" id="nbtv-txstart">TX start (on air)</button>
                <button class="btn btn-danger" id="nbtv-txstop" disabled>Stop</button>
                <button class="btn" id="nbtv-selftest" style="font-size:11px">Quick self-test (5 silent frames)</button>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>WAV file</h3></header>
              <div class="card-body mod-controls" style="flex-direction:column;align-items:stretch">
                <label class="field"><span>Render length (s)</span>
                  <input type="number" id="nbtv-wavsec" min="1" max="600" step="1" value="10"></label>
                <label class="field"><span>Bit depth</span>
                  <select id="nbtv-wavbits">
                    <option value="16">16-bit PCM</option>
                    <option value="24" selected>24-bit PCM</option>
                  </select></label>
                <button class="btn" id="nbtv-wavrender">Render WAV → download</button>
                <label class="btn" for="nbtv-wavin" style="text-align:center">Decode WAV…</label>
                <input type="file" id="nbtv-wavin" accept=".wav,audio/wav,audio/x-wav" style="display:none">
                <div class="mod-note mono" id="nbtv-wavstat" style="font-size:11px;display:none"></div>
              </div>
            </div>
            <div class="mod-note">
              Composite video as baseband audio — built for cables, virtual
              audio devices, loopbacks, wideband FM links and other RF toys
              on permitted frequencies (32-line video wants ~5–10 kHz, far
              wider than one SSB channel, so mind the band plan on air).
              Stereo Y/C needs a two-channel path end to end. Load a video
              or animated GIF and it plays over the air; the clip's own
              audio track — or a soundtrack file paired with any picture —
              rides the AM sound-in-vision subcarrier, so the talkie
              arrives with its voice. New here? Press
              <span class="mono">▶ Loopback</span> — it runs TX into RX
              live on this page (nothing on the air, no mic needed) with
              every control adjustable while you watch and listen.
              Signal- and file-protocol-compatible
              with <span class="mono">NBTV Studio</span> (Python) by VA3JFL.
            </div>
          </div>
        </div>`;

      this.ui = {
        rx: el.querySelector("#nbtv-rx"),
        tx: el.querySelector("#nbtv-tx"),
        rxStat: el.querySelector("#nbtv-rx-stat"),
        txStat: el.querySelector("#nbtv-tx-stat"),
        mode: el.querySelector("#nbtv-mode"),
        colour: el.querySelector("#nbtv-colour"),
        geom: el.querySelector("#nbtv-geom"),
        filter: el.querySelector("#nbtv-filter"),
        rate: el.querySelector("#nbtv-rate"),
        rateNote: el.querySelector("#nbtv-rate-note"),
        source: el.querySelector("#nbtv-source"),
        fit: el.querySelector("#nbtv-fit"),
        file: el.querySelector("#nbtv-file"),
        sfile: el.querySelector("#nbtv-sfile"),
        mediastat: el.querySelector("#nbtv-mediastat"),
        sndsrc: el.querySelector("#nbtv-sndsrc"),
        sndstat: el.querySelector("#nbtv-sndstat"),
        loop: el.querySelector("#nbtv-loop"),
        sync: el.querySelector("#nbtv-sync"),
        syncVal: el.querySelector("#nbtv-sync-val"),
        sat: el.querySelector("#nbtv-sat"),
        rxReset: el.querySelector("#nbtv-rxreset"),
        txStart: el.querySelector("#nbtv-txstart"),
        txStop: el.querySelector("#nbtv-txstop"),
        selfTest: el.querySelector("#nbtv-selftest"),
        fstat: el.querySelector("#nbtv-fstat"),
        ffile: el.querySelector("#nbtv-ffile"),
        fname: el.querySelector("#nbtv-fname"),
        fec: el.querySelector("#nbtv-fec"),
        frep: el.querySelector("#nbtv-frep"),
        fsend: el.querySelector("#nbtv-fsend"),
        fstop: el.querySelector("#nbtv-fstop"),
        fplan: el.querySelector("#nbtv-fplan"),
        farm: el.querySelector("#nbtv-farm"),
        frx: el.querySelector("#nbtv-frx"),
        fdl: el.querySelector("#nbtv-fdl"),
        wavSec: el.querySelector("#nbtv-wavsec"),
        wavBits: el.querySelector("#nbtv-wavbits"),
        wavRender: el.querySelector("#nbtv-wavrender"),
        wavIn: el.querySelector("#nbtv-wavin"),
        wavStat: el.querySelector("#nbtv-wavstat")
      };

      this.ui.mode.value = this.modeId;
      this.ui.colour.value = this.colorSys;
      this.ui.source.value = this.source;
      this.ui.fit.value = this.fill ? "fill" : "letterbox";
      this.ui.filter.value = String(this.filterIdx);
      this.ui.fec.value = String(this.fileEc);
      this.ui.frep.value = String(this.fileRepeat);
      this.ui.sndsrc.value = this.sndSrc;
      this._updateMediaStat();

      this.ui.mode.addEventListener("change", () => {
        this.modeId = this.ui.mode.value;
        if (this.fileTxActive) { this.fileTxActive = false; this.ctx.log("file TX stopped — rebuild for the new mode"); }
        this._applyGeometry();
        this._updateFilePlan();
        this._maybeReextract();
        this._updateSndUi();
        this._restartRun();
      });
      this.ui.colour.addEventListener("change", () => {
        this.colorSys = this.ui.colour.value;
        this._applyGeometry();
        this._restartRun();
      });
      this.ui.filter.addEventListener("change", () => {
        this.filterIdx = parseInt(this.ui.filter.value, 10) || 0;
        if (this.txRunning) this._makeFilters(this.geomTx.rate);
        if (this.fileTxActive) this._rebuildFileTx();
        this._updateFilePlan();
        /* carrier + guard follow the filter; RX retunes to match */
        this.sndTx = null; this.sndGuard = null; this.sndCDel = null; this.sndRx = null;
        this._updateSndUi();
      });
      this.ui.rate.addEventListener("change", () => {
        const v = parseInt(this.ui.rate.value, 10) || null;
        const cur = this.ctx.audio.setPreferredRate(v);
        if (cur && v && cur !== v)
          this.ui.rateNote.textContent = `audio is running at ${cur} Hz — reload the page to switch`;
        else if (v) this.ui.rateNote.textContent = `will open the audio device at ${v} Hz`;
        else this.ui.rateNote.textContent = "";
        this._applyGeometry();
        this._updateFilePlan();
      });
      this.ui.sndsrc.addEventListener("change", (e) => {
        this._setSndSrc(e.target.value, true);
      });
      el.querySelector("#nbtv-sndrx").addEventListener("change", (e) => {
        this.sndRxOn = e.target.checked; this.sndRx = null;
        if (this.sndRxOn) this.ctx.log("NBTV sound decode on — listening for the " +
          Math.round(sndSubF(this.format, this._rate(), this._cutoff())) + " Hz subcarrier " +
          "(the picture notch there is always on, so the image stays clean either way).");
        this._updateSndUi();
      });
      this.ui.source.addEventListener("change", () => {
        this.source = this.ui.source.value;
        if (this.source === "camera") this._startCamera();
        else this._stopCamera();
        this._renderSource(this._idleT());
        this._previewTx();
      });
      this.ui.fit.addEventListener("change", () => {
        this.fill = this.ui.fit.value === "fill";
        this._renderSource(this._idleT());
        this._previewTx();
      });
      this.ui.file.addEventListener("change", (e) => {
        const f = e.target.files && e.target.files[0];
        e.target.value = "";
        if (!f) return;
        /* some platforms hand over files with an empty MIME type —
           fall back to the extension so a .gif still animates */
        const ext = (f.name.match(/\.([a-z0-9]+)$/i) || [, ""])[1].toLowerCase();
        if (f.type.startsWith("video/") ||
            (!f.type && ["mp4", "webm", "mov", "mkv", "m4v", "ogv", "avi"].includes(ext))) {
          this._loadVideo(f); return;
        }
        if (f.type === "image/gif" || (!f.type && ext === "gif")) {
          this._loadGif(f); return;
        }
        const img = new Image();
        const url = URL.createObjectURL(f);
        img.onload = () => {
          URL.revokeObjectURL(url);
          this.imageObj = img;
          this.source = "image";
          this.ui.source.value = "image";
          this._stopCamera();
          this._renderSource(0);
          this._previewTx();
          this.ctx.log(`image loaded (${img.width}×${img.height})`);
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          this._setMediaStat("can't open " + f.name);
          this.ctx.log("couldn't open " + f.name + " as an image, video or GIF");
        };
        img.src = url;
      });
      this.ui.sfile.addEventListener("change", async (e) => {
        const f = e.target.files && e.target.files[0];
        e.target.value = "";
        if (!f) return;
        this._setMediaStat("decoding soundtrack " + f.name + "…");
        try {
          const snd = await this._decodeSoundtrack(f, false);
          this.mediaAudio = snd;
          this._setSndSrc("media");
          this._updateMediaStat();
          this.ctx.log(`soundtrack loaded: ${f.name} · ${snd.dur.toFixed(1)} s — ` +
            `rides the AM sound subcarrier with whatever picture you transmit`);
        } catch (err) {
          this._setMediaStat("soundtrack error: " + err.message);
          this.ctx.log("soundtrack decode failed: " + err.message);
        }
      });
      this.ui.sync.addEventListener("input", () => {
        const v = parseFloat(this.ui.sync.value);
        this.ui.syncVal.textContent = v.toFixed(2);
        if (this.dec) this.dec.setSyncLevel(v);
      });
      this.ui.sat.addEventListener("input", () => {
        if (this.dec) this.dec.setSaturation(parseFloat(this.ui.sat.value));
      });
      this.ui.rxReset.addEventListener("click", () => this._rebuildDecoder());
      this.ui.txStart.addEventListener("click", () => this._startTx());
      this.ui.loop.addEventListener("click", () => {
        if (this.txRunning && this.loop) this._stopTx(false);
        else if (!this.txRunning) this._startTx(true);
      });
      this.ui.txStop.addEventListener("click", () => this._stopTx(false));
      this.ui.selfTest.addEventListener("click", () => this._selfTest());

      /* ------- file link wiring ------- */
      this.ui.ffile.addEventListener("change", (e) => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        f.arrayBuffer().then(ab => {
          this.fileSender.load(f.name, new Uint8Array(ab));
          this.ui.fname.textContent = `${f.name} · ${f.size} B`;
          this._updateFilePlan();
        });
      });
      this.ui.fec.addEventListener("change", () => {
        this.fileEc = parseInt(this.ui.fec.value, 10) || 0;
        if (this.fileTxActive) this._rebuildFileTx();
        this._updateFilePlan();
      });
      this.ui.frep.addEventListener("change", () => {
        this.fileRepeat = clamp(parseInt(this.ui.frep.value, 10) || 2, 1, 5);
        this.ui.frep.value = String(this.fileRepeat);
        if (this.fileTxActive) this._rebuildFileTx();
        this._updateFilePlan();
      });
      this.ui.fsend.addEventListener("click", () => this._startFileTx());
      this.ui.fstop.addEventListener("click", () => {
        this.fileTxActive = false;
        this.ui.fstop.disabled = true;
        this.ui.fstat.textContent = "idle";
        this.ctx.log("file TX stopped — back to the picture source");
      });
      this.ui.farm.addEventListener("click", () => this._toggleFileRx());

      /* ------- WAV render / decode ------- */
      this.ui.wavRender.addEventListener("click", () => this._renderWav());
      this.ui.wavIn.addEventListener("change", (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) this._decodeWav(f);
        e.target.value = "";
      });

      this._applyGeometry();
      this._updateFilePlan();
    },

    onActivate() {
      if (this.source === "camera" && !this.cam) this._startCamera();
    },

    onDeactivate() {
      this._stopTx(true);
      this._stopCamera();
      this.fileTxActive = false;
      this.ui = null;
    },

    /* ---------------- geometry / decoder plumbing -------------------- */
    _rate() {
      const a = this.ctx.audio;
      return a.ctx ? a.ctx.sampleRate : (a.preferredRate || 48000);
    },
    _mode() { return MODES.find(m => m.id === this.modeId) || MODES[0]; },
    _cutoff() { return FILTERS[this.filterIdx][1]; },

    _applyGeometry() {
      const geom = new Geometry(this._mode(), this._rate());
      this.geomTx = geom;
      /* the sound carrier sits on the half-line-offset tooth grid above the
         guarded video band (see sndPlan) — retune it with the mode */
      this.format = geom.mode;
      this.sndTx = null; this.sndGuard = null; this.sndCDel = null;
      this.sndRx = null;
      // display canvases follow the mode aspect. The backing store must
      // never be SMALLER than the native scan grid — a 360/480-line
      // picture squeezed into a 288-px canvas loses lines to a blurry
      // downscale (bars looked fine, photos went fuzzy). Grow the store
      // to fit the grid and pin the on-page CSS size, so hi-def modes
      // stay sharp and the layout doesn't move.
      const aw = geom.aspect[0], ah = geom.aspect[1];
      const dispW = Math.round(288 * aw / ah);
      const [nw, nh] = geom.gridSize();         // native grid, display-oriented
      const s = Math.max(1, nh / 288, nw / dispW);
      const H = Math.round(288 * s), W = Math.round(H * aw / ah);
      for (const cv of [this.ui.rx, this.ui.tx]) {
        cv.width = W; cv.height = H;
        cv.style.width = dispW + "px";          // same size on the page…
        cv.style.height = "auto";               // …sharper pixels behind it
      }
      this.ui.geom.textContent = geom.describe() +
        (geom.usable ? "" : "  ⚠ needs a higher sample rate — TX/RX disabled");
      this.ui.txStart.disabled = !geom.usable || this.txRunning;
      this.ui.loop.disabled = !geom.usable || this.txRunning;
      this._rebuildDecoder();
      this._updateSndUi();
      this._renderSource(performance.now() / 1000);
      this._previewTx();
    },

    _rebuildDecoder() {
      if (!this.ui) return;
      const geom = new Geometry(this._mode(), this._rate());
      this.dec = geom.usable ? new Decoder(geom, this.colorSys) : null;
      if (this.dec) {
        this.dec.setSyncLevel(parseFloat(this.ui.sync.value));
        this.dec.setSaturation(parseFloat(this.ui.sat.value));
        /* the notch always protects the picture: a talkie carrier without
           it doesn't just ripple the image, it breaks sync lock */
        this.dec.setSoundNotch(sndSubF(this._mode(), this._rate(), this._cutoff()));
      }
      if (this.fileArmed) {
        this.fileRx = geom.usable ? new FileReceiver(geom) : null;
        this.ui.frx.textContent = "armed — waiting for QR frames";
      }
      this.ui.rxStat.textContent = "no signal";
    },

    _updateStats(info) {
      if (!this.ui) return;
      if (!info) {
        if (this.dec && this.dec.locked) {
          this.ui.rxStat.textContent = `lock · line ${this.dec.lineIdx}`;
        }
        return;
      }
      const lockTxt = info.synced ? "SYNC" : (info.locked ? "lock" : "—");
      this.ui.rxStat.textContent =
        `${lockTxt} · f${info.frames} · spl ${info.spl.toFixed(1)} · coast ${info.coasted}`;
    },

    _showRxFrame(frame) {
      if (!this.ui || !this.dec) return;
      paintGrid(this.ui.rx, this.nativeRx, frame.rgb, this.dec.g);
      this._updateStats(frame.info);
      if (this.fileArmed && this.fileRx && !this.fileRx.done) {
        const now = performance.now();
        if (now - this._lastOffer > 120) {
          this._lastOffer = now;
          const ev = this.fileRx.offer(gridToDisplayLuma(frame.rgb, this.dec.g));
          if (ev) this._onFileRxEvent(ev);
          else this._fileRxStatus();
        }
      }
    },

    /* ---------------- source rendering -------------------------------- */
    _renderSource(t) {
      const geom = this.geomTx || new Geometry(this._mode(), this._rate());
      const aw = geom.aspect[0], ah = geom.aspect[1];
      const H = 480, W = Math.round(H * aw / ah);
      if (!this.srcCanvas) this.srcCanvas = document.createElement("canvas");
      if (this.srcCanvas.width !== W || this.srcCanvas.height !== H) {
        this.srcCanvas.width = W; this.srcCanvas.height = H;
      }
      const c = this.srcCanvas.getContext("2d");
      if (this.source.startsWith("pattern:")) {
        drawPattern(c, W, H, this.source.slice(8), t);
      } else if (this.source === "idcard") {
        drawIdCard(c, W, H, this.ctx.settings(), this._mode());
      } else if (this.source === "image") {
        c.fillStyle = "#000"; c.fillRect(0, 0, W, H);
        if (this.imageObj)
          this._drawFitted(c, W, H, this.imageObj,
            this.imageObj.naturalWidth || this.imageObj.width,
            this.imageObj.naturalHeight || this.imageObj.height);
        else {
          c.fillStyle = "#888"; c.font = "20px monospace";
          c.textAlign = "center"; c.fillText("load an image…", W / 2, H / 2);
        }
      } else if (this.source === "media") {
        c.fillStyle = "#000"; c.fillRect(0, 0, W, H);
        const bmp = this._mediaFrameAt(t);
        if (bmp) this._drawFitted(c, W, H, bmp, bmp.width, bmp.height);
        else if (!this.media) {
          c.fillStyle = "#888"; c.font = "20px monospace";
          c.textAlign = "center"; c.fillText("load a video or GIF…", W / 2, H / 2);
        }
      } else if (this.source === "camera") {
        c.fillStyle = "#000"; c.fillRect(0, 0, W, H);
        if (this.video && this.video.readyState >= 2) {
          this._drawFitted(c, W, H, this.video, this.video.videoWidth, this.video.videoHeight);
        } else {
          c.fillStyle = "#888"; c.font = "20px monospace";
          c.textAlign = "center"; c.fillText("waiting for camera…", W / 2, H / 2);
        }
      }
    },

    /* crop (fill) or letterbox a source into the mode-aspect canvas —
       the srcCanvas is square-pixel display space, so plain aspect math */
    _drawFitted(c, W, H, src, sw, sh) {
      if (!sw || !sh) return;
      const target = W / H, cur = sw / sh;
      if (this.fill) {
        let sx = 0, sy = 0, cw = sw, ch = sh;
        if (cur > target) { cw = sh * target; sx = (sw - cw) / 2; }
        else if (cur < target) { ch = sw / target; sy = (sh - ch) / 2; }
        hqDraw(c, src, sx, sy, cw, ch, 0, 0, W, H);
      } else {
        let dw = W, dh = H;
        if (cur > target) dh = H * target / cur;
        else if (cur < target) dw = W * cur / target;
        hqDraw(c, src, 0, 0, sw, sh, (W - dw) / 2, (H - dh) / 2, dw, dh);
      }
    },

    _idleT() { return this.source === "media" ? 0 : performance.now() / 1000; },

    /* the media frame that belongs at timeline second t (loops) */
    _mediaFrameAt(t) {
      const m = this.media;
      if (!m || !m.nFrames) return null;
      const tau = ((t % m.dur) + m.dur) % m.dur;
      if (m.kind === "gif") {
        let i = this._gifCursor || 0;
        if (i >= m.nFrames || m.frames[i].t0 > tau) i = 0;
        while (i + 1 < m.nFrames && m.frames[i + 1].t0 <= tau) i++;
        this._gifCursor = i;
        return m.frames[i].bmp;
      }
      /* video: JPEG-blob frames, decoded a window ahead */
      const idx = Math.min(m.nFrames - 1, Math.floor(tau * m.fps));
      this._ensureVideoWindow(idx);
      for (let k = idx; k >= 0 && k > idx - 6; k--)
        if (m.frames[k].bmp) { this._lastBmp = m.frames[k].bmp; return this._lastBmp; }
      return this._lastBmp;
    },

    /* keep ~1.8 s of video frames decoded ahead of idx; evict far ones */
    _ensureVideoWindow(idx) {
      const m = this.media;
      if (!m || m.kind !== "video" || this._winBusy) return;
      this._winBusy = true;
      const n = m.nFrames, WIN = Math.min(n, Math.ceil(m.fps * 1.8) + 6);
      (async () => {
        try {
          for (let off = 0; off < WIN; off++) {
            const fr = m.frames[(idx + off) % n];
            if (!fr.bmp) {
              const bmp = await createImageBitmap(fr.blob);
              if (this.media !== m) { bmp.close(); return; }
              fr.bmp = bmp;
            }
          }
          for (let k = 0; k < n; k++) {
            const ahead = (k - idx + n) % n;
            if (ahead > WIN && ahead < n - 10 && m.frames[k].bmp) {
              m.frames[k].bmp.close();
              m.frames[k].bmp = null;
            }
          }
        } catch (e) { /* a bad frame decode — leave the gap */ }
        finally { this._winBusy = false; }
      })();
    },

    /* offline path (WAV render): decode exactly the frame needed, now */
    async _ensureVideoFrame(t) {
      const m = this.media;
      if (!m || m.kind !== "video") return;
      const tau = ((t % m.dur) + m.dur) % m.dur;
      const idx = Math.min(m.nFrames - 1, Math.floor(tau * m.fps));
      const fr = m.frames[idx];
      if (!fr.bmp) fr.bmp = await createImageBitmap(fr.blob);
      const old = idx - 3;                       // keep memory flat offline
      if (!this.txRunning && old >= 0 && m.frames[old].bmp && this._lastBmp !== m.frames[old].bmp) {
        m.frames[old].bmp.close();
        m.frames[old].bmp = null;
      }
    },

    _isLiveSource() {
      return this.source === "camera" || this.source === "idcard" ||
        (this.source === "media" && !!this.media) ||
        (this.source.startsWith("pattern:") && LIVE_PATTERNS.has(this.source.slice(8)));
    },

    /* stills go to the encoder at full resolution — an image the user
       already cropped/sized for the mode keeps its definition instead of
       losing it to a round trip through the 480-px source canvas */
    _encSrc() {
      return (this.source === "image" && this.imageObj) ? this.imageObj : this.srcCanvas;
    },

    _previewTx() {
      if (!this.ui || !this.geomTx || !this.geomTx.usable) return;
      const enc = new Encoder(this.geomTx, this.colorSys);
      enc.setFrameFromCanvas(this._encSrc(), this.fill);
      paintGrid(this.ui.tx, this.nativeTx, enc.grid, this.geomTx);
    },

    async _startCamera() {
      if (this.cam) return;
      try {
        this.cam = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: false
        });
        this.video = document.createElement("video");
        this.video.muted = true;
        this.video.playsInline = true;
        this.video.srcObject = this.cam;
        await this.video.play();
        this.ctx.log("camera running");
        this._renderSource(performance.now() / 1000);
        this._previewTx();
      } catch (e) {
        this.ctx.log("camera unavailable: " + e.message);
        this.cam = null;
      }
    },

    _stopCamera() {
      if (this.cam) { this.cam.getTracks().forEach(t => t.stop()); this.cam = null; }
      this.video = null;
    },

    /* ---------------- uploaded media: video / GIF / soundtrack -------- */
    _setMediaStat(t) { if (this.ui) this.ui.mediastat.textContent = t; },

    _updateMediaStat() {
      if (!this.ui) return;
      const bits = [], m = this.media;
      if (m) bits.push(m.kind === "gif"
        ? `${m.name} · ${m.nFrames} GIF frame${m.nFrames === 1 ? "" : "s"} · ${m.dur.toFixed(1)} s loop`
        : `${m.name} · ${m.nFrames} frames · ${m.dur.toFixed(1)} s @ ${m.fps} fps`);
      if (this.mediaAudio)
        bits.push(`sound: ${this.mediaAudio.name} · ${this.mediaAudio.dur.toFixed(1)} s`);
      else if (m && m.kind === "video") bits.push("sound: none");
      this.ui.mediastat.textContent = bits.join("\n");
      this.ui.mediastat.style.display = bits.length ? "" : "none";
    },

    /* restart a live run (loopback or on-air TX) so mode/colour changes
       take effect immediately — file TX is left stopped, it needs a rebuild */
    _restartRun() {
      if (!this.txRunning || this.fileTxActive) return;
      const wasLoop = this.loop;
      this._stopTx(true);
      if (this.geomTx && this.geomTx.usable) this._startTx(wasLoop);
    },

    /* one glance answers "what sound will actually ride the subcarrier?" —
       this line is kept truthful from every place that changes the answer */
    _updateSndUi() {
      if (!this.ui) return;
      const f = Math.round(sndSubF(this._mode(), this._rate(), this._cutoff()));
      const audioUp = !!(this.ctx.audio && this.ctx.audio.rxActive);
      let txt;
      if (this.sndSrc === "off") {
        txt = `TX sound off — picture only (subcarrier ${f} Hz unused)`;
      } else if (this.sndSrc === "mic") {
        txt = audioUp
          ? `TX sound: 🎙 live mic → ${f} Hz subcarrier`
          : `TX sound: 🎙 live mic → ${f} Hz — ⚠ press “Start audio” (top right) for the mic`;
      } else if (this.mediaAudio) {
        const from = this.media && this.media.kind === "video" &&
          this.mediaAudio.name === this.media.name ? "video soundtrack" : "soundtrack file";
        txt = `TX sound: ♪ ${from} “${this.mediaAudio.name}” · ` +
          `${this.mediaAudio.dur.toFixed(1)} s → ${f} Hz subcarrier`;
      } else {
        txt = `TX sound: ♪ file soundtrack — ⚠ nothing loaded yet. ` +
          `Load a video with audio or “Load soundtrack” below.`;
      }
      txt += this.sndRxOn
        ? `\nRX: decoding ${f} Hz AM sound to the speaker`
        : `\nRX: sound decode off — tick the box to hear talkies`;
      const pl = sndPlan(this._mode(), this._rate(), this._cutoff());
      txt += `\nplan: video ≤ ${Math.round(pl.guard / 100) / 10} kHz · carrier ${f} Hz · sound ±${Math.round(pl.aud / 100) / 10} kHz — match mode + output filter on both ends`;
      this.ui.sndstat.textContent = txt;
    },

    _setSndSrc(v, verbose) {
      this.sndSrc = v;
      this.sndTx = null;
      if (this.ui) this.ui.sndsrc.value = v;
      this._updateSndUi();
      if (!verbose) return;
      if (v === "mic") this.ctx.log("NBTV sound-in-vision: mic commentary — subcarrier " +
        Math.round(sndSubF(this.format, this._rate(), this._cutoff())) + " Hz rides the picture (Start audio for the mic). " +
        "Slight shimmer is the price of talkies.");
      else if (v === "media") this.ctx.log(this.mediaAudio
        ? `NBTV sound-in-vision: ${this.mediaAudio.name} rides the ` +
          `${Math.round(sndSubF(this.format, this._rate(), this._cutoff()))} Hz subcarrier, locked to the picture timeline.`
        : "NBTV sound-in-vision set to file soundtrack — load a video with audio " +
          "or a soundtrack file first.");
      else this.ctx.log("NBTV sound-in-vision off");
    },

    _freeMedia() {
      const m = this.media;
      if (m) for (const f of m.frames)
        if (f.bmp) { try { f.bmp.close(); } catch (e) { /* gone */ } f.bmp = null; }
      this.media = null;
      this._lastBmp = null;
      this._gifCursor = 0;
    },

    /* decode a file's audio (works on plain audio files and on the audio
       track inside video containers) to mono PCM, capped at the media
       length limit; fromVideo=true returns null instead of throwing */
    async _decodeSoundtrack(file, fromVideo) {
      try {
        const ab = await file.arrayBuffer();
        const oc = new OfflineAudioContext(1, 1, 48000);
        const buf = await oc.decodeAudioData(ab);
        const n = Math.min(buf.length, Math.round(MEDIA_MAX_SECS * buf.sampleRate));
        if (!n) throw new Error("empty audio track");
        const data = new Float32Array(n);
        for (let c = 0; c < buf.numberOfChannels; c++) {
          const ch = buf.getChannelData(c);
          for (let i = 0; i < n; i++) data[i] += ch[i];
        }
        const g = 1 / Math.max(1, buf.numberOfChannels);
        for (let i = 0; i < n; i++) data[i] *= g;
        return { name: file.name, data, rate: buf.sampleRate, dur: n / buf.sampleRate };
      } catch (e) {
        if (!fromVideo) throw e;
        return null;
      }
    },

    async _loadVideo(file) {
      const epoch = ++this._mediaEpoch;
      this.mediaFile = file;
      this._setMediaStat("opening " + file.name + "…");
      /* the audio track decodes in parallel with the frame scan */
      const audioP = this._decodeSoundtrack(file, true);
      const fps = this._mode().fps;
      try {
        const got = await this._extractVideoFrames(file, fps, epoch);
        if (!got) return;                              // superseded
        this._freeMedia();
        this.mediaAudio = null;                        // replaced below if the clip has sound
        this.media = { kind: "video", name: file.name, dur: got.dur, fps,
          frames: got.frames, nFrames: got.frames.length };
        this._lastBmp = got.frames[0].bmp;
        this.source = "media";
        if (this.ui) this.ui.source.value = "media";
        this._stopCamera();
        this._renderSource(0);
        this._previewTx();
        this.ctx.log(`video loaded: ${file.name} — ${got.frames.length} frames · ` +
          `${got.dur.toFixed(1)} s @ ${fps} fps` +
          (got.truncated ? ` (clipped to the first ${got.dur.toFixed(0)} s)` : ""));
      } catch (e) {
        this._setMediaStat("video error: " + e.message);
        this.ctx.log("video load failed: " + e.message);
        return;
      }
      const snd = await audioP;
      if (epoch !== this._mediaEpoch) return;
      if (snd) {
        this.mediaAudio = snd;
        if (this.sndSrc !== "mic") this._setSndSrc("media");
        this.ctx.log(`soundtrack ready: ${snd.dur.toFixed(1)} s rides the ` +
          `${Math.round(sndSubF(this.format, this._rate(), this._cutoff()))} Hz AM subcarrier — a proper talkie ` +
          `(tick "decode AM sound" on the RX side to hear it)`);
      } else {
        this.ctx.log("no decodable audio track in " + file.name + " — picture only");
      }
      this._updateMediaStat();
      this._updateSndUi();
    },

    /* seek through the file and photograph every frame the mode will
       transmit; stored as JPEG blobs so a two-minute clip stays light */
    async _extractVideoFrames(file, fps, epoch) {
      const url = URL.createObjectURL(file);
      const v = document.createElement("video");
      v.preload = "auto"; v.muted = true; v.playsInline = true;
      const cleanup = () => {
        try { v.removeAttribute("src"); v.load(); } catch (e) { /* fine */ }
        URL.revokeObjectURL(url);
      };
      try {
        await new Promise((res, rej) => {
          v.onloadedmetadata = res;
          v.onerror = () => rej(new Error("the browser can't open this video format"));
          setTimeout(() => rej(new Error("timed out opening the video")), 15000);
          v.src = url;
        });
        if (!isFinite(v.duration)) {                   // MediaRecorder-webm quirk
          await new Promise((res) => {
            v.onseeked = res;
            setTimeout(res, 3000);
            v.currentTime = 1e7;
          });
          v.currentTime = 0;
        }
        let dur = Math.min(v.duration || 0, MEDIA_MAX_SECS);
        let truncated = (v.duration || 0) > MEDIA_MAX_SECS + 0.01;
        if (!(dur > 0)) throw new Error("video reports no duration");
        let n = Math.max(1, Math.round(dur * fps));
        if (n > MEDIA_MAX_FRAMES) { n = MEDIA_MAX_FRAMES; dur = n / fps; truncated = true; }
        const vw = v.videoWidth || 320, vh = v.videoHeight || 240;
        /* capture tall enough for the mode: photo-scan modes have more
           LINES than the old 288-px cap, which forced a soft upscale */
        const capH = clamp(this._mode().lines, 288, 480);
        const s = Math.min(1, (capH * 4 / 3) / vw, capH / vh);
        const cw = Math.max(2, Math.round(vw * s)), ch = Math.max(2, Math.round(vh * s));
        const cv = document.createElement("canvas");
        cv.width = cw; cv.height = ch;
        const c2 = cv.getContext("2d");
        const frames = new Array(n);
        for (let k = 0; k < n; k++) {
          const t = Math.min((k + 0.5) / fps, Math.max(0, dur - 0.01));
          await new Promise((res) => {
            let done = false;
            const fin = () => { if (!done) { done = true; res(); } };
            if (Math.abs(v.currentTime - t) < 1e-4) { fin(); return; }
            v.onseeked = fin;
            setTimeout(fin, 4000);
            v.currentTime = t;
          });
          if (epoch !== this._mediaEpoch) { cleanup(); return null; }
          hqDraw(c2, v, 0, 0, vw, vh, 0, 0, cw, ch);
          const blob = await new Promise((res) => cv.toBlob(res, "image/jpeg", 0.85));
          if (!blob) throw new Error("frame capture failed");
          frames[k] = { blob, bmp: null };
          if (k % 8 === 0 || k === n - 1)
            this._setMediaStat(`scanning ${file.name}… frame ${k + 1}/${n}`);
        }
        frames[0].bmp = await createImageBitmap(frames[0].blob);
        cleanup();
        return { frames, dur, truncated };
      } catch (e) { cleanup(); throw e; }
    },

    async _loadGif(file) {
      const epoch = ++this._mediaEpoch;
      this._setMediaStat("reading " + file.name + "…");
      try {
        const gif = decodeGif(new Uint8Array(await file.arrayBuffer()));
        if (epoch !== this._mediaEpoch) return;
        const s = Math.min(1, 384 / gif.width, 288 / gif.height);
        const cw = Math.max(2, Math.round(gif.width * s));
        const ch = Math.max(2, Math.round(gif.height * s));
        const src = document.createElement("canvas");
        src.width = gif.width; src.height = gif.height;
        const sc = src.getContext("2d");
        const dst = document.createElement("canvas");
        dst.width = cw; dst.height = ch;
        const dc = dst.getContext("2d");
        const frames = [];
        let t0 = 0;
        for (const f of gif.frames) {
          sc.putImageData(new ImageData(f.rgba, gif.width, gif.height), 0, 0);
          dc.fillStyle = "#000"; dc.fillRect(0, 0, cw, ch);
          hqDraw(dc, src, 0, 0, gif.width, gif.height, 0, 0, cw, ch);
          const bmp = await createImageBitmap(dst);
          if (epoch !== this._mediaEpoch) { bmp.close(); return; }
          frames.push({ bmp, t0 });
          t0 += f.delayMs / 1000;
          if (t0 >= MEDIA_MAX_SECS || frames.length >= MEDIA_MAX_FRAMES) break;
        }
        this._freeMedia();
        this.mediaFile = null;                        // GIFs never re-scan
        this.media = { kind: "gif", name: file.name, dur: Math.max(0.04, t0),
          frames, nFrames: frames.length };
        this.source = "media";
        if (this.ui) this.ui.source.value = "media";
        this._stopCamera();
        this._renderSource(0);
        this._previewTx();
        this._updateMediaStat();
        this.ctx.log(`GIF loaded: ${file.name} — ${frames.length} frame` +
          `${frames.length === 1 ? "" : "s"}, ${this.media.dur.toFixed(1)} s loop` +
          (frames.length > 1 ? " — it plays over the air" : ""));
      } catch (e) {
        this._setMediaStat("GIF error: " + e.message);
        this.ctx.log("GIF load failed: " + e.message);
      }
    },

    /* a mode change can change the frame rate — re-scan the loaded video
       so its timeline still maps one stored frame per transmitted frame */
    _maybeReextract() {
      const m = this.media;
      if (!m || m.kind !== "video" || !this.mediaFile) return;
      const fps = this._mode().fps;
      if (Math.abs(m.fps - fps) < 1e-9) return;
      const file = this.mediaFile;
      const epoch = ++this._mediaEpoch;
      this.ctx.log(`re-scanning ${m.name} at ${fps} fps for the new mode…`);
      this._extractVideoFrames(file, fps, epoch).then(got => {
        if (!got || epoch !== this._mediaEpoch) return;
        this._freeMedia();
        this.media = { kind: "video", name: file.name, dur: got.dur, fps,
          frames: got.frames, nFrames: got.frames.length };
        this._lastBmp = got.frames[0].bmp;
        this._updateMediaStat();
        if (this.source === "media") { this._renderSource(0); this._previewTx(); }
        this.ctx.log(`re-scan done — ${got.frames.length} frames @ ${fps} fps`);
      }).catch(e => this.ctx.log("re-scan failed: " + e.message));
    },

    /* ---------------- streaming transmit ------------------------------ */
    _makeFilters(rate) {
      const cutoff = this._cutoff();
      this.firC = new FIRLowpass(rate, cutoff);
      this.firK = new FIRLowpass(rate, cutoff);
    },

    _startTx(loop) {
      if (this.txRunning || !this.geomTx || !this.geomTx.usable) return;
      const audio = this.ctx.audio;
      const actx = audio.ensureContext();
      const geom = new Geometry(this._mode(), actx.sampleRate);  // real rate
      if (!geom.usable) {
        this.ctx.log(`mode needs a higher sample rate than ${actx.sampleRate} Hz`);
        this._applyGeometry();
        return;
      }
      this.geomTx = geom;
      this.format = geom.mode;
      this.enc = new Encoder(geom, this.colorSys);
      this._makeFilters(actx.sampleRate);
      this.sndTx = null; this.sndGuard = null; this.sndCDel = null;  // fresh ring + carrier + guard
      this._renderSource(this._idleT());
      this.enc.setFrameFromCanvas(this._encSrc(), this.fill);

      this.loop = !!loop;
      if (this.loop) {
        /* clean slate for the run, like the reference studio's
           Send → RX: rebuild the decoder at the exact TX rate */
        this._rebuildDecoder();
        this.sndRx = null;
      }
      this.txRunning = true;
      this.txFrames = 0;
      this.txNext = actx.currentTime + 0.15;
      this.ui.txStart.disabled = true;
      this.ui.txStop.disabled = false;
      this.ui.loop.textContent = this.loop ? "■ Stop loopback" : "▶ Loopback — watch TX→RX live";
      this.ui.loop.disabled = !this.loop;
      if (!this.loop) {                        // a real transmission
        this.selfTx = true;
        audio.emit("tx-start", { duration: 0 });
        this.selfTx = false;
      }
      const fName = FILTERS[this.filterIdx][0];
      this.ctx.log((this.loop ? "loopback " : "TX ") +
        `${geom.lines} lines / ${this.colorSys} @ ${actx.sampleRate} Hz · ${fName}` +
        (this.loop ? " — nothing on the air, RX is fed internally" : ""));

      const ahead = this.loop ? 0.12 : 1.0;    // loopback paints at 1×, not in bursts
      const pump = () => {
        if (!this.txRunning) return;
        while (this.txNext < actx.currentTime + ahead) {
          if (this.fileTxActive && this.fileSender.grids.length) {
            const grids = this.fileSender.grids;
            const idx = Math.floor(this.fileFrame / this.fileRepeat) % grids.length;
            this.enc.setFrameFromGrid(grids[idx]);
            this.fileFrame++;
            if (this.ui) {
              const pass = Math.floor(this.fileFrame / (this.fileRepeat * grids.length)) + 1;
              this.ui.fstat.textContent = `pass ${pass} · frame ${idx + 1}/${grids.length}`;
            }
          } else if (this._isLiveSource()) {
            const t = this.source === "media"
              ? this.txFrames / geom.fps               // stream timeline (loops)
              : performance.now() / 1000;              // wall clock
            this._renderSource(t);
            this.enc.setFrameFromCanvas(this._encSrc(), this.fill);
          }
          const fr = this.enc.encodeFrame();
          let comp = this.firC ? this.firC.process(fr.comp) : fr.comp;
          let chroma = fr.chroma
            ? (this.firK ? this.firK.process(fr.chroma) : fr.chroma) : null;
          if (this.sndSrc !== "off" && (this.sndSrc !== "media" || this.mediaAudio)) {
            if (!this.sndTx || this.sndTx.fs !== actx.sampleRate) {
              const plan = sndPlan(this.format, actx.sampleRate, this._cutoff());
              this.sndTx = new SndTx(actx.sampleRate, plan.f, plan.aud);
              /* sound guard: band-limit the video below the carrier like
                 real TV, so picture detail can't grind over the sound —
                 skipped for QR file TX, which needs its full bandwidth */
              this.sndGuard = plan.guard < (this._cutoff() || 1e9) * 0.999
                ? new FIRLowpass(actx.sampleRate, plan.guard) : null;
            }
            if (this.sndGuard && !this.fileTxActive) {
              comp = this.sndGuard.process(comp);
              if (chroma && this.sndGuard.delay > 0) {
                /* the guard FIR delays the luma by 63 samples — the chroma
                   must ride the same delay or the colour lands ~50 px off
                   the luminance (the "double image") */
                if (!this.sndCDel || this.sndCDel.length !== this.sndGuard.delay) {
                  this.sndCDel = new Float32Array(this.sndGuard.delay); this.sndCDp = 0;
                }
                const d = this.sndCDel, n = d.length, c2 = new Float32Array(chroma.length);
                for (let i = 0; i < chroma.length; i++) {
                  c2[i] = d[this.sndCDp]; d[this.sndCDp] = chroma[i];
                  this.sndCDp = (this.sndCDp + 1) % n;
                }
                chroma = c2;
              }
            }
            if (this.sndSrc === "media")
              this.sndTx.push(sliceTrack(this.mediaAudio,
                this.txFrames / geom.fps, comp.length, actx.sampleRate));
            this.sndTx.mixInto(comp);
          }
          if (this.loop) {
            /* loopback: straight into the decoder, nothing on the air */
            this._feedRx(comp, chroma);
          } else {
            const buf = actx.createBuffer(chroma ? 2 : 1, comp.length, actx.sampleRate);
            buf.copyToChannel(comp, 0);
            if (chroma) buf.copyToChannel(chroma, 1);
            const src = actx.createBufferSource();
            src.buffer = buf;
            src.connect(audio.txBus || audio.txGainNode);
            src.onended = () => this.txNodes.delete(src);
            this.txNodes.add(src);
            src.start(this.txNext);
          }
          this.txNext += comp.length / actx.sampleRate;
          this.txFrames++;
        }
        if (this.ui) {
          this.ui.txStat.textContent =
            (this.loop ? "loopback · " : "streaming · ") + `${this.txFrames} frames` +
            (this.colorSys === "yc" ? " · stereo" : "");
          paintGrid(this.ui.tx, this.nativeTx, this.enc.grid, geom);
        }
      };
      pump();
      this.txTimer = setInterval(pump, this.loop ? 80 : 250);
    },

    /* loopback path: what TX just generated goes straight to the picture
       decoder and (if enabled) the AM sound demodulator — real time, live
       controls, no soundcard round trip */
    _feedRx(comp, chroma) {
      if (this.sndRxOn) {
        if (!this.sndRx) {
          const f = this.format;
          const pl = sndPlan(f, this.ctx.audio.ensureContext().sampleRate, this._cutoff());
          this.sndRx = new SndRx(this.ctx.audio.ensureContext(), pl.f,
            f ? f.lines * f.fps : 0, undefined, pl.aud);
        }
        this.sndRx.setGate(!!(this.dec && this.dec.locked));
        this.sndRx.process(comp);
      }
      if (!this.dec) return;
      const frames = this.dec.feed(comp, chroma);
      if (frames.length) this._showRxFrame(frames[frames.length - 1]);
      else if ((this._statTick = (this._statTick || 0) + 1) % 4 === 0) this._updateStats(null);
    },

    _stopTx(quiet) {
      if (!this.txRunning) return;
      this.txRunning = false;
      const wasLoop = this.loop;
      this.loop = false;
      if (this.txTimer) { clearInterval(this.txTimer); this.txTimer = null; }
      this.txNodes.forEach(s => { try { s.stop(); } catch (e) { /* done */ } });
      this.txNodes.clear();
      if (!wasLoop) this.ctx.audio.emit("tx-end");   // loopback never went on air
      if (this.ui) {
        this.ui.txStat.textContent = "idle";
        this.ui.txStart.disabled = !(this.geomTx && this.geomTx.usable);
        this.ui.txStop.disabled = true;
        this.ui.loop.disabled = !(this.geomTx && this.geomTx.usable);
        this.ui.loop.textContent = "▶ Loopback — watch TX→RX live";
        if (this.fileTxActive) { this.ui.fstat.textContent = "idle"; this.ui.fstop.disabled = true; }
      }
      this.fileTxActive = false;
      if (!quiet) this.ctx.log((wasLoop ? "loopback" : "TX") +
        ` stopped after ${this.txFrames} frames`);
    },

    /* ---------------- file link: TX ----------------------------------- */
    get _wavStat() {
      if (this.ui && this.ui.wavStat.style.display === "none")
        this.ui.wavStat.style.display = "";
      return this.ui.wavStat;
    },

    _updateFilePlan() {
      if (!this.ui) return;
      const geom = new Geometry(this._mode(), this._rate());
      if (!geom.usable) { this.ui.fplan.textContent = "Plan: mode unusable at this sample rate."; return; }
      const { plan, err } = qrPlan(geom, this._cutoff(), this.fileEc);
      if (!plan) { this.ui.fplan.textContent = "Plan: " + err; return; }
      const raw = Math.floor((plan.cap - 4) / 4) * 3;
      let txt = `Plan: QR v${plan.version} (${plan.need}×${plan.need} modules), ` +
        `${raw} B/frame, module ${plan.pAlong}×${plan.pCross} px` +
        (plan.marginal ? ` — ${plan.marginal}` : "");
      if (this.fileSender.data) {
        const n = Math.ceil(this.fileSender.data.length / raw);
        const secs = (n + 2) * this.fileRepeat / geom.fps;
        txt += `\n${this.fileSender.name}: ${this.fileSender.data.length} B → ${n} chunks, ` +
          `~${secs.toFixed(1)} s per pass (~${(this.fileSender.data.length / secs).toFixed(0)} B/s)`;
      }
      this.ui.fplan.textContent = txt;
    },

    async _startFileTx() {
      if (!this.fileSender.data) { this.ctx.log("choose a file first"); return; }
      try { await loadVendor("qrcode"); }
      catch (e) { this.ctx.log("QR encoder unavailable: " + e.message); return; }
      const audio = this.ctx.audio;
      const actx = audio.ensureContext();
      const geom = new Geometry(this._mode(), actx.sampleRate);
      if (!geom.usable) { this.ctx.log("mode unusable at this sample rate"); return; }
      let stats;
      try {
        stats = this.fileSender.build(geom, this._cutoff(), this.fileEc, this.fileRepeat);
      } catch (e) {
        this.ui.fplan.textContent = "File TX: " + e.message;
        this.ctx.log("file TX: " + e.message);
        return;
      }
      this.fileTxActive = true;
      this.fileFrame = 0;
      this.ui.fstop.disabled = false;
      const p = stats.plan;
      this.ctx.log(`file TX ready: ${this.fileSender.name}, QR v${p.version}, ` +
        `${stats.raw} B/frame, ${stats.totalFrames} frames, ` +
        `~${stats.passSeconds.toFixed(1)} s/pass (~${stats.rate.toFixed(0)} B/s)`);
      this._updateFilePlan();
      if (!this.txRunning) this._startTx();
    },

    _rebuildFileTx() {
      if (!this.fileTxActive || !this.fileSender.data) return;
      const rate = this._rate();
      const geom = new Geometry(this._mode(), rate);
      try {
        this.fileSender.build(geom, this._cutoff(), this.fileEc, this.fileRepeat);
        this.fileFrame = 0;
        this.ctx.log("file TX carousel rebuilt for the new settings");
      } catch (e) {
        this.fileTxActive = false;
        this.ui.fstop.disabled = true;
        this.ui.fstat.textContent = "idle";
        this.ctx.log("file TX stopped: " + e.message);
      }
    },

    /* ---------------- file link: RX ----------------------------------- */
    async _toggleFileRx() {
      if (this.fileArmed) {
        this.fileArmed = false;
        this.fileRx = null;
        this.ui.farm.textContent = "Arm file RX";
        this.ui.frx.textContent = "RX idle";
        return;
      }
      try { await loadVendor("jsqr"); }
      catch (e) { this.ctx.log("QR decoder unavailable: " + e.message); return; }
      this.fileArmed = true;
      this.ui.farm.textContent = "Disarm file RX";
      this.ui.fdl.style.display = "none";
      const geom = this.dec ? this.dec.g : new Geometry(this._mode(), this._rate());
      this.fileRx = new FileReceiver(geom);
      this.ui.frx.textContent = "armed — waiting for QR frames";
      this.ctx.log("file RX armed — decoding QR frames from the picture");
    },

    _fileRxStatus() {
      if (!this.ui || !this.fileRx) return;
      const pr = this.fileRx.progress();
      const got = pr[0], n = pr[1];
      this.ui.frx.textContent =
        `chunks ${got}/${n === null ? "?" : n}` +
        (this.fileRx.name ? ` · ${this.fileRx.name}` : "") +
        ` · decoded ${this.fileRx.framesDecoded}/${this.fileRx.framesSeen} frames`;
    },

    _onFileRxEvent(ev) {
      if (!this.ui || !this.fileRx) return;
      if (ev === "crc-restart") {
        this.ctx.log("file RX: CRC mismatch — a bad chunk slipped through, collecting again");
      } else if (ev === "complete") {
        const name = this.fileRx.name || "received.bin";
        const blob = new Blob([this.fileRx.blob]);
        this.ui.fdl.href = URL.createObjectURL(blob);
        this.ui.fdl.download = name;
        this.ui.fdl.textContent = `Save ${name} (${this.fileRx.blob.length} B)`;
        this.ui.fdl.style.display = "";
        this.ui.frx.textContent = `complete · ${name} · CRC OK`;
        this.ctx.log(`file received: ${name} (${this.fileRx.blob.length} B, CRC OK)`);
        return;
      }
      this._fileRxStatus();
    },

    /* ---------------- WAV: offline render → download ------------------ */
    async _renderWav() {
      if (this._wavBusy) return;
      const rate = this._rate();
      const geom = new Geometry(this._mode(), rate);
      if (!geom.usable) { this._wavStat.textContent = `mode unusable at ${rate} Hz`; return; }
      const bits = parseInt(this.ui.wavBits.value, 10) === 16 ? 16 : 24;
      let secs = clamp(parseFloat(this.ui.wavSec.value) || 10, 1, 600);
      let nframes = Math.max(1, Math.ceil(secs * geom.fps));

      /* if the file carousel is active, render whole passes of it */
      const carousel = this.fileTxActive && this.fileSender.grids.length
        ? this.fileSender.grids : null;
      if (carousel) {
        const per = carousel.length * this.fileRepeat;
        nframes = Math.max(per, Math.ceil(nframes / per) * per);
      }

      this._wavBusy = true;
      this.ui.wavRender.disabled = true;
      const enc = new Encoder(geom, this.colorSys);
      const firC = new FIRLowpass(rate, this._cutoff());
      const firK = new FIRLowpass(rate, this._cutoff());
      /* the file soundtrack renders into the WAV; the mic can't (live-only) */
      const sndTrk = this.sndSrc === "media" && this.mediaAudio ? this.mediaAudio : null;
      const sndWavPlan = sndTrk ? sndPlan(this.format, rate, this._cutoff()) : null;
      const snd = sndTrk ? new SndTx(rate, sndWavPlan.f, sndWavPlan.aud) : null;
      const sndGuardW = snd && sndWavPlan.guard < (this._cutoff() || 1e9) * 0.999
        ? new FIRLowpass(rate, sndWavPlan.guard) : null;
      let wavCDel = null, wavCDp = 0;
      if (this.sndSrc === "mic")
        this.ctx.log("WAV render: mic commentary is live-only — it isn't in the file");
      if (!carousel && !this._isLiveSource()) {
        this._renderSource(0);
        enc.setFrameFromCanvas(this._encSrc(), this.fill);
      }
      const c0 = [], c1 = [];
      let total = 0;
      try {
        for (let i = 0; i < nframes; i++) {
          if (carousel) {
            enc.setFrameFromGrid(carousel[Math.floor(i / this.fileRepeat) % carousel.length]);
          } else if (this._isLiveSource()) {
            if (this.source === "media") await this._ensureVideoFrame(i / geom.fps);
            this._renderSource(i / geom.fps);              // deterministic timeline
            enc.setFrameFromCanvas(this._encSrc(), this.fill);
          }
          const fr = enc.encodeFrame();
          let comp = firC.process(fr.comp);
          let chroma = fr.chroma ? firK.process(fr.chroma) : null;
          if (snd) {
            if (sndGuardW) {
              comp = sndGuardW.process(comp);                // video below the carrier
              if (chroma && sndGuardW.delay > 0) {           // colour rides the same delay
                if (!wavCDel) { wavCDel = new Float32Array(sndGuardW.delay); wavCDp = 0; }
                const c2 = new Float32Array(chroma.length);
                for (let k2 = 0; k2 < chroma.length; k2++) {
                  c2[k2] = wavCDel[wavCDp]; wavCDel[wavCDp] = chroma[k2];
                  wavCDp = (wavCDp + 1) % wavCDel.length;
                }
                chroma = c2;
              }
            }
            snd.push(sliceTrack(sndTrk, i / geom.fps, comp.length, rate));
            snd.mixInto(comp);
          }
          if (!chroma) chroma = comp;                        // ch2 mirrors, like the reference
          c0.push(comp); c1.push(chroma);
          total += comp.length;
          if (i % 8 === 7) {
            this._wavStat.textContent = `rendering… ${Math.round(100 * (i + 1) / nframes)} %`;
            await new Promise(r => setTimeout(r, 0));
          }
        }
        const ch0 = new Float32Array(total), ch1 = new Float32Array(total);
        let p = 0;
        for (let i = 0; i < c0.length; i++) { ch0.set(c0[i], p); ch1.set(c1[i], p); p += c0[i].length; }
        const buf = wavEncode([ch0, ch1], rate, bits);
        const safe = s => s.replace(/[^\w.\-]+/g, "_");
        const name = carousel
          ? `nbtv_file_${safe(this.fileSender.name || "carousel")}.wav`
          : `nbtv_${this.modeId}_${this.colorSys}_${rate}.wav`;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
        const mb = (buf.byteLength / 1048576).toFixed(1);
        this._wavStat.textContent =
          `saved ${name} — ${nframes} frames, ${(total / rate).toFixed(1)} s, ${mb} MB` +
          (carousel ? ` (${nframes / (carousel.length * this.fileRepeat)} pass${nframes > carousel.length * this.fileRepeat ? "es" : ""} of the file carousel)` : "");
        this.ctx.log(`WAV rendered: ${name} (${mb} MB @ ${rate} Hz, ${bits}-bit stereo)`);
      } finally {
        this._wavBusy = false;
        this.ui.wavRender.disabled = false;
      }
    },

    /* ---------------- WAV: import + decode ---------------------------- */
    async _decodeWav(file) {
      if (this._wavBusy) return;
      this._wavBusy = true;
      this._wavStat.textContent = "reading " + file.name + "…";
      try {
        const wav = wavDecode(await file.arrayBuffer());
        const ch0 = wav.ch[0];
        const ch1 = wav.ch.length > 1 ? wav.ch[1] : wav.ch[0];
        const geom = new Geometry(this._mode(), wav.rate);   // file's own rate
        if (!geom.usable) {
          this._wavStat.textContent =
            `${wav.rate} Hz is too low for this mode (${geom.spl.toFixed(1)} smp/line) — pick a smaller mode`;
          return;
        }
        const dec = new Decoder(geom, this.colorSys);
        dec.setSyncLevel(parseFloat(this.ui.sync.value));
        dec.setSaturation(parseFloat(this.ui.sat.value));
        const mode = this._mode();
        let sndRx = null;
        if (this.sndRxOn) {
          dec.setSoundNotch(sndSubF(mode, wav.rate, this._cutoff()));
          try {          // AudioBuffer sample-rate limits vary by browser
            const plW = sndPlan(mode, wav.rate, this._cutoff());
            sndRx = new SndRx(this.ctx.audio.ensureContext(), plW.f,
              mode.lines * mode.fps, wav.rate, plW.aud);
          } catch (err) { sndRx = null; }
        }
        if (this.fileArmed) {
          this.fileRx = new FileReceiver(geom);
          this.ui.fdl.style.display = "none";
          this.ui.frx.textContent = "armed — scanning WAV frames";
        }
        const CHUNK = 65536;
        let nframes = 0, lastFrame = null;
        for (let i = 0; i < ch0.length; i += CHUNK) {
          const j = Math.min(i + CHUNK, ch0.length);
          if (sndRx) {
            try { sndRx.setGate(dec.locked); sndRx.process(ch0.subarray(i, j)); }
            catch (err) { sndRx = null; }
          }
          const frames = dec.feed(ch0.subarray(i, j), ch1.subarray(i, j));
          for (const f of frames) {
            nframes++;
            lastFrame = f;
            if (this.fileArmed && this.fileRx && !this.fileRx.done) {
              const ev = this.fileRx.offer(gridToDisplayLuma(f.rgb, geom));
              if (ev) this._onFileRxEvent(ev);
            }
          }
          if (lastFrame) {
            paintGrid(this.ui.rx, this.nativeRx, lastFrame.rgb, geom);
            this._updateStats(lastFrame.info);
          }
          this._wavStat.textContent =
            `decoding… ${Math.round(100 * j / ch0.length)} % · ${nframes} frames`;
          await new Promise(r => setTimeout(r, 0));
        }
        const secs = ch0.length / wav.rate;
        this._wavStat.textContent =
          `${file.name}: ${nframes} frames from ${secs.toFixed(1)} s @ ${wav.rate} Hz, ${wav.bits}-bit` +
          (nframes ? "" : " — no frames; check the mode matches the recording");
        this.ctx.log(`WAV decoded: ${file.name} → ${nframes} frames` +
          (this.fileRx && this.fileRx.done ? " · file transfer complete" : ""));
        if (this.fileArmed && this.fileRx && !this.fileRx.done) this._fileRxStatus();
      } catch (e) {
        this._wavStat.textContent = "WAV error: " + e.message;
        this.ctx.log("WAV decode failed: " + e.message);
      } finally {
        this._wavBusy = false;
      }
    },

    /* ---------------- software loopback self-test --------------------- */
    _selfTest() {
      const rate = this._rate();
      const geom = new Geometry(this._mode(), rate);
      if (!geom.usable) { this.ctx.log(`self-test: mode unusable at ${rate} Hz`); return; }
      this._renderSource(performance.now() / 1000);
      const enc = new Encoder(geom, this.colorSys);
      enc.setFrameFromCanvas(this._encSrc(), this.fill);
      const dec = new Decoder(geom, this.colorSys);
      dec.setSyncLevel(0.15);
      const firC = new FIRLowpass(rate, this._cutoff());
      const firK = new FIRLowpass(rate, this._cutoff());
      let last = null;
      for (let f = 0; f < 5; f++) {
        const fr = enc.encodeFrame();
        const comp = firC.process(fr.comp);
        const chroma = fr.chroma ? firK.process(fr.chroma) : null;
        const frames = dec.feed(comp, chroma);
        if (frames.length) last = frames[frames.length - 1];
      }
      if (last) {
        paintGrid(this.ui.rx, this.nativeRx, last.rgb, geom);
        this._updateStats(last.info);
        this.ctx.log(`quick check OK — ${last.info.frames} frames, ` +
          `spl ${last.info.spl.toFixed(2)} (nominal ${geom.spl.toFixed(2)}). ` +
          `For the full live experience press ▶ Loopback.`);
      } else {
        this.ctx.log("self-test FAILED — no frames decoded");
      }
    }
  };

  const HOST = (typeof HRWS !== "undefined" && HRWS)
    || (typeof window !== "undefined" ? window.HRWS : null);
  if (HOST) HOST.registerModule(def);
  /* headless test hook (used by the repo self-checks; harmless in the app) */
  window.__NBTV_TEST__ = {
    Geometry, Encoder, Decoder, FIRLowpass, FileSender, FileReceiver,
    resampleRow, crc32, b36e, b36d, qrPlan, qrFit, qrRenderGrid,
    gridToDisplayLuma, imageLumaToGrid, wavEncode, wavDecode, MODES, FILTERS,
    decodeGif, gifLzw, sliceTrack, SndTx, SndRxCore, sndSubF, sndPlan, BiquadNotch
  };
})();
