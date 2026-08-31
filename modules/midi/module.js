/* ============================================================
   Ham Radio Web Studio — MIDI Link ("HRWS-M1")
   Live MIDI over a voice channel — and a design experiment in
   HOW digital audio should fail.

   The idea: a MIDI score is split into fixed bars (5 or 10 s of
   song time), each bar becomes a few packets, the receiver
   buffers one bar of latency and plays the reconstruction back
   to back — a seamless concert, a few seconds behind the wire.

   The philosophy (the D2 argument, applied to music): the note
   payload is sent as FIXED-WIDTH 5-byte records with NO error
   correction, on purpose. Variable-length coding would let one
   flipped bit desynchronize everything after it, and FEC + CRC
   discipline would turn a damaged bar into silence. Fixed-width
   raw records trap every bit error inside one field of one note:
   a wrong pitch, a wrong beat, a wrong instrument — the drunk
   orchestra — while the music keeps playing. Only the skeleton
   (segment headers: timing, bar index, the program table) rides
   the D1 Viterbi chain, so the orchestra may lose its sobriety
   but never the stage. An optional ARMOR mode sends the notes
   through the full FEC instead, making the contrast audible:
   armored music drops out cleanly; bare music slurs.

   The stack, bottom to top:
     modem    4-FSK, 500 Bd, tones 800/1300/1800/2300 Hz
              (Gray-coded 2 bits/symbol — a tone error is a
              1-bit error, i.e. a SMALL musical error), fits
              300–2700 Hz SSB, 1000 bps raw
     framing  D1 packets: 16-symbol sync (per-packet timing
              re-lock), 7-byte Viterbi-coded header with CRC-16
     skeleton segment header (MHDR): FEC + CRC — protected
     flesh    note packets (MNOTES): 5-byte records
              t:11 · dur:11 · pitch:7 · vel:7 · ch:4  (5 ms ticks)
              BARE: raw symbols, advisory CRC-32 (reported as
              "drunk", never enforced) · ARMOR: full K=7 FEC,
              CRC-enforced (drop, never slur)
     synth    hand-rolled Web Audio GM synth (PeriodicWave
              harmonic recipes for 14 timbre families across all
              128 programs + a noise/sine drum kit) so the whole
              orchestra renders in the browser, offline,
              dependency-free — in this studio's tradition

   Practical use: none. We are hams; it is interesting, it is
   harmless, and the failure modes are educational. Identify per
   your local regulations; both ends need this studio.
   ============================================================ */
"use strict";

(function () {

  /* ---------------- modem constants (the D1/D3 chain) ---------------- */
  const TONES = [800.0, 1300.0, 1800.0, 2300.0];
  const BAUD = 500.0;
  const GRAY_ENC = [0, 1, 3, 2];        // 2-bit value -> tone index
  const GRAY_DEC = [0, 1, 3, 2];        // tone index  -> 2-bit value
  const SYNCSEQ = [0, 3, 1, 2, 3, 0, 2, 1, 3, 3, 0, 0, 2, 1, 1, 2];
  const PREAMBLE_SYMS = 24;
  const LEADER_S = 0.35, LEADER_F = 1900.0;
  const PAD_S = 0.25;
  const TX_FS = 12000;                  // 24 samples/symbol exactly

  /* ---------------- M1 constants ---------------- */
  const PKT_END = 3;                    // shared END semantics
  const PKT_MHDR = 6;                   // protected segment header
  const PKT_MNOTES_RAW = 7;             // bare notes  (drunk orchestra)
  const PKT_MNOTES_FEC = 8;             // armored notes (drop, never slur)
  const MAGIC0 = 0x4D, MAGIC1 = 0x31;   // "M1"
  const NOTE_BYTES = 5;                 // fixed-width record
  const TICK_S = 0.005;                 // 5 ms time base
  const MAX_TICKS = 2047;               // 11-bit fields
  const SEG_OPTS = [5, 10];             // bar length, seconds
  const MAX_NOTES_PKT = 50;             // ≤ 250 B raw ≈ 2.2 s air per packet
  const GUARD_S = 1.5;                  // RX playback guard behind the wire

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

  /* radix-2 complex FFT (shared with the picture modules) */
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
      run(x) {
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
     Bit I/O
     ===================================================================== */
  class BitWriter {
    constructor() { this.bytes = []; this.cur = 0; this.nb = 0; }
    bit(b) {
      this.cur = (this.cur << 1) | (b & 1);
      if (++this.nb === 8) { this.bytes.push(this.cur); this.cur = 0; this.nb = 0; }
    }
    bits(v, n) { for (let i = n - 1; i >= 0; i--) this.bit((v >> i) & 1); }
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
  }

  /* =====================================================================
     FEC — convolutional K=7 rate 1/2, soft Viterbi, 24-row interleaver.
     Byte-for-byte the D1 chain. Used for headers always, and for the
     note payload only in ARMOR mode.
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

  /* FEC-coded section (headers, armored notes): interleave(conv(bits)) */
  function codeSection(bytes) {
    const coded = interleave(convEncode(bytesToBits(bytes)));
    const nSym = coded.length >> 1;
    const tones = new Uint8Array(nSym);
    for (let i = 0; i < nSym; i++)
      tones[i] = GRAY_ENC[(coded[2 * i] << 1) | coded[2 * i + 1]];
    return tones;
  }
  function sectionSyms(nBytes) { return 8 * nBytes + 6; }

  /* RAW section (bare notes): bytes straight onto Gray tones, 2 bits/sym.
     No coding, no interleave: a tone error is a 1-bit error that lands in
     exactly one field of one note — the drunk-orchestra channel. */
  function rawSection(bytes) {
    const tones = new Uint8Array(bytes.length * 4);
    let p = 0;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      tones[p++] = GRAY_ENC[(b >> 6) & 3];
      tones[p++] = GRAY_ENC[(b >> 4) & 3];
      tones[p++] = GRAY_ENC[(b >> 2) & 3];
      tones[p++] = GRAY_ENC[b & 3];
    }
    return tones;
  }
  function rawSectionSyms(nBytes) { return 4 * nBytes; }

  /* packet header: type u8 · seq u16 · len u16 · crc16 = 7 bytes (D1's) */
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

  function buildPacketTones(type, seq, payload, raw) {
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
    tones.push(...(raw ? rawSection(withCrc) : codeSection(withCrc)));
    return Uint8Array.from(tones);
  }
  function packetSymCount(len, raw) {
    return SYNCSEQ.length + HDR_SYMS + (raw ? rawSectionSyms(len + 4) : sectionSyms(len + 4));
  }

  /* =====================================================================
     Note records — the fixed-width flesh.
     t:11 · dur:11 · pitch:7 · vel:7 · ch:4 = 40 bits = 5 bytes, so every
     record starts on a byte boundary and a bit error can never shift its
     neighbours. Times and durations are 5 ms ticks within the segment.
     ===================================================================== */
  function packNotes(recs) {
    const bw = new BitWriter();
    for (const n of recs) {
      bw.bits(clamp(n.t, 0, MAX_TICKS), 11);
      bw.bits(clamp(n.dur, 1, MAX_TICKS), 11);
      bw.bits(clamp(n.pitch, 0, 127), 7);
      bw.bits(clamp(n.vel, 1, 127), 7);
      bw.bits(n.ch & 15, 4);
    }
    return bw.finish();
  }
  function unpackNotes(bytes) {
    const out = [];
    const n = Math.floor(bytes.length / NOTE_BYTES);
    const br = new BitReader(bytes);
    for (let i = 0; i < n; i++) {
      out.push({
        t: br.bits(11), dur: Math.max(1, br.bits(11)),
        pitch: br.bits(7), vel: Math.max(1, br.bits(7)), ch: br.bits(4)
      });
    }
    return out;
  }

  /* =====================================================================
     Segment header (MHDR) — the protected skeleton: which bar this is,
     how long a bar lasts, how the orchestra is seated (program table).
     ===================================================================== */
  function buildMhdr(sessionId, segIdx, segTotal, segS, armor, noteCount, subPkts, programs) {
    const b = new Uint8Array(32);
    b[0] = MAGIC0; b[1] = MAGIC1;
    b[2] = (sessionId >> 8) & 255; b[3] = sessionId & 255;
    b[4] = (segIdx >> 8) & 255; b[5] = segIdx & 255;
    b[6] = (segTotal >> 8) & 255; b[7] = segTotal & 255;
    b[8] = Math.round(segS * 2);
    b[9] = armor ? 1 : 0;
    b[10] = (noteCount >> 8) & 255; b[11] = noteCount & 255;
    b[12] = subPkts;
    for (let i = 0; i < 16; i++) b[13 + i] = (programs && programs[i]) ? programs[i] & 127 : 0;
    return b;
  }
  function parseMhdr(p) {
    if (p.length < 32 || p[0] !== MAGIC0 || p[1] !== MAGIC1) return null;
    const segS = p[8] / 2;
    if (segS < 2 || segS > 20) return null;
    const programs = [];
    for (let i = 0; i < 16; i++) programs.push(p[13 + i]);
    return {
      sessionId: (p[2] << 8) | p[3],
      segIdx: (p[4] << 8) | p[5],
      segTotal: (p[6] << 8) | p[7],
      segS, armor: !!(p[9] & 1),
      noteCount: (p[10] << 8) | p[11],
      subPkts: p[12], programs
    };
  }

  /* MNOTES seq packs the bar and the sub-packet: self-describing even
     when the header is lost — the show must go on */
  function notesSeq(segIdx, sub) { return ((segIdx & 0x1FFF) << 3) | (sub & 7); }
  function notesSeqParse(seq) { return { segIdx: seq >> 3, sub: seq & 7 }; }

  /* =====================================================================
     Standard MIDI File — reader (format 0/1, tempo map, running status)
     and writer (format 0, used to save what the receiver heard).
     ===================================================================== */
  function parseMidi(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let p = 0;
    const u32 = () => (u8[p++] << 24 | u8[p++] << 16 | u8[p++] << 8 | u8[p++]) >>> 0;
    const u16 = () => (u8[p++] << 8 | u8[p++]);
    if (u32() !== 0x4D546864) throw new Error("not a MIDI file (no MThd)");
    const hlen = u32();
    const format = u16(), ntrks = u16(), division = u16();
    p += hlen - 6;
    if (division & 0x8000) throw new Error("SMPTE-timed MIDI unsupported");
    if (format === 2) throw new Error("format-2 MIDI unsupported");
    const tpq = division || 480;

    const tempos = [{ tick: 0, us: 500000 }];
    const raw = [];                                  // {tick, ch, kind, a, b}
    const warnings = [];
    for (let tr = 0; tr < ntrks; tr++) {
      if (p + 8 > u8.length) break;
      if (u32() !== 0x4D54726B) { warnings.push("track " + tr + ": bad MTrk"); break; }
      const len = u32();
      const end = p + len;
      let tick = 0, status = 0;
      while (p < end) {
        let d = 0, c;
        do { c = u8[p++]; d = (d << 7) | (c & 0x7F); } while (c & 0x80);
        tick += d;
        let b = u8[p];
        if (b & 0x80) { status = b; p++; } else if (!(status & 0x80)) { p++; continue; }
        const hi = status & 0xF0, ch = status & 0x0F;
        if (hi === 0x80 || hi === 0x90 || hi === 0xA0 || hi === 0xB0 || hi === 0xE0) {
          const a = u8[p++], v = u8[p++];
          if (hi === 0x90 && v > 0) raw.push({ tick, ch, kind: "on", a, b: v });
          else if (hi === 0x80 || (hi === 0x90 && v === 0)) raw.push({ tick, ch, kind: "off", a });
        } else if (hi === 0xC0 || hi === 0xD0) {
          const a = u8[p++];
          if (hi === 0xC0) raw.push({ tick, ch, kind: "prog", a });
        } else if (status === 0xFF) {
          const type = u8[p++];
          let ml = 0;
          do { c = u8[p++]; ml = (ml << 7) | (c & 0x7F); } while (c & 0x80);
          if (type === 0x51 && ml === 3)
            tempos.push({ tick, us: (u8[p] << 16) | (u8[p + 1] << 8) | u8[p + 2] });
          p += ml;
          if (type === 0x2F) { p = end; }
        } else if (status === 0xF0 || status === 0xF7) {
          let ml = 0;
          do { c = u8[p++]; ml = (ml << 7) | (c & 0x7F); } while (c & 0x80);
          p += ml;
        } else p++;                                   // unknown realtime — skip
      }
      p = end;
    }

    tempos.sort((a, b) => a.tick - b.tick);
    const tickToSec = tk => {
      let sec = 0, lastTick = 0, us = 500000;
      for (const t of tempos) {
        if (t.tick >= tk) break;
        sec += (t.tick - lastTick) * us / (tpq * 1e6);
        lastTick = t.tick; us = t.us;
      }
      return sec + (tk - lastTick) * us / (tpq * 1e6);
    };

    raw.sort((a, b) => a.tick - b.tick || (a.kind === "off" ? -1 : 1));
    const open = {};                                  // ch:pitch -> stack
    const notes = [];
    const programs = new Array(16).fill(-1);
    const curProg = new Array(16).fill(0);
    let orphans = 0;
    for (const e of raw) {
      if (e.kind === "prog") { curProg[e.ch] = e.a; continue; }
      const key = e.ch * 128 + e.a;
      if (e.kind === "on") {
        if (programs[e.ch] < 0) programs[e.ch] = curProg[e.ch];
        (open[key] ||= []).push({ tick: e.tick, vel: e.b });
      } else {
        const st = open[key];
        if (st && st.length) {
          const o = st.shift();
          const t0 = tickToSec(o.tick), t1 = tickToSec(e.tick);
          notes.push({ t: t0, dur: Math.max(0.02, t1 - t0),
                       pitch: e.a, vel: o.vel, ch: e.ch });
        } else orphans++;
      }
    }
    let lastTick = 0;
    for (const e of raw) lastTick = Math.max(lastTick, e.tick);
    const endS = tickToSec(lastTick);
    for (const key in open)
      for (const o of open[key]) {
        const ch = Math.floor(key / 128), pitch = key % 128;
        notes.push({ t: tickToSec(o.tick),
                     dur: Math.max(0.05, endS - tickToSec(o.tick)),
                     pitch, vel: o.vel, ch });
      }
    if (orphans) warnings.push(orphans + " orphaned note-offs ignored");
    notes.sort((a, b) => a.t - b.t || a.pitch - b.pitch);
    for (let i = 0; i < 16; i++) if (programs[i] < 0) programs[i] = 0;
    return { notes, programs, durationS: notes.length ?
             Math.max(...notes.map(n => n.t + n.dur)) : 0, warnings };
  }

  function writeMidi(notes, programs) {
    const TPQ = 480;                                  // tempo 500000 → 960 ticks/s
    const ev = [];
    for (let ch = 0; ch < 16; ch++)
      if (programs && programs[ch]) ev.push({ tick: 0, ord: 0, bytes: [0xC0 | ch, programs[ch] & 127] });
    for (const n of notes) {
      const on = Math.round(n.t * 960);
      const off = Math.max(on + 1, Math.round((n.t + n.dur) * 960));
      ev.push({ tick: on, ord: 2, bytes: [0x90 | (n.ch & 15), n.pitch & 127, clamp(n.vel, 1, 127)] });
      ev.push({ tick: off, ord: 1, bytes: [0x80 | (n.ch & 15), n.pitch & 127, 0] });
    }
    ev.sort((a, b) => a.tick - b.tick || a.ord - b.ord);
    const out = [];
    const vlq = v => {
      const st = [v & 0x7F];
      while ((v >>= 7) > 0) st.unshift((v & 0x7F) | 0x80);
      out.push(...st);
    };
    out.push(0, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20);  // tempo 500000
    let last = 0;
    for (const e of ev) { vlq(e.tick - last); last = e.tick; out.push(...e.bytes); }
    out.push(0, 0xFF, 0x2F, 0x00);
    const trk = Uint8Array.from(out);
    const file = new Uint8Array(14 + 8 + trk.length);
    const w32 = (o, v) => { file[o] = v >>> 24; file[o + 1] = (v >> 16) & 255; file[o + 2] = (v >> 8) & 255; file[o + 3] = v & 255; };
    const w16 = (o, v) => { file[o] = (v >> 8) & 255; file[o + 1] = v & 255; };
    file.set([0x4D, 0x54, 0x68, 0x64], 0); w32(4, 6); w16(8, 0); w16(10, 1); w16(12, TPQ);
    file.set([0x4D, 0x54, 0x72, 0x6B], 14); w32(18, trk.length);
    file.set(trk, 22);
    return file;
  }

  /* =====================================================================
     Built-in demo score — 60 s, five parts, deterministic. Sounds like a
     small band warming up over Am–F–C–G; enough voices to hear the
     orchestra get drunk one section at a time.
     ===================================================================== */
  function makeDemoScore() {
    let s = 20260705;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const notes = [];
    const add = (t, dur, pitch, vel, ch) => notes.push({ t, dur, pitch, vel, ch });
    const beat = 60 / 96, bar = 4 * beat, bars = 24;
    const roots = [57, 53, 48, 55];                    // A F C G
    const triads = [[57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62]];
    const penta = [57, 60, 62, 64, 67, 69, 72, 74];
    for (let b = 0; b < bars; b++) {
      const t0 = b * bar, ci = b % 4;
      const root = roots[ci];
      for (let q = 0; q < 4; q++)                      // bass, ch1
        add(t0 + q * beat, beat * 0.55, root - 24 + (q === 3 && rnd() < 0.4 ? 7 : 0), 96, 1);
      for (const q of [0, 2])                          // piano chords, ch0
        for (const pv of triads[ci])
          add(t0 + q * beat, beat * 1.85, pv, 70, 0);
      add(t0, bar * 0.98, root, 50, 3);                // strings pad, ch3
      add(t0, bar * 0.98, root + 7, 46, 3);
      if (b >= 2) {                                    // flute lead, ch2
        let idx = 2 + ((b * 3) % 4);
        for (let e = 0; e < 8; e++) {
          if (rnd() < 0.28) continue;
          idx = clamp(idx + (rnd() < 0.5 ? -1 : 1) + (rnd() < 0.15 ? 2 : 0), 0, penta.length - 1);
          const oct = b >= bars - 6 ? 12 : 0;
          add(t0 + e * beat / 2, beat * (rnd() < 0.2 ? 0.9 : 0.45),
              penta[idx] + oct, 78 + Math.floor(rnd() * 18), 2);
        }
      }
      for (let e = 0; e < 8; e++)                      // hats, ch9
        add(t0 + e * beat / 2, 0.06, 42, e % 2 ? 48 : 68, 9);
      add(t0, 0.1, 36, 110, 9);                        // kick 1 & 3
      add(t0 + 2 * beat, 0.1, 36, 104, 9);
      if (b % 2 === 1) add(t0 + 3.5 * beat, 0.1, 36, 90, 9);
      add(t0 + beat, 0.12, 38, 100, 9);                // snare 2 & 4
      add(t0 + 3 * beat, 0.12, 38, 100, 9);
      if (b % 4 === 3) add(t0 + 3.5 * beat, 0.3, 46, 82, 9);
      if (b === 0 || b === 16) add(t0, 1.2, 49, 100, 9);
    }
    notes.sort((a, b) => a.t - b.t || a.pitch - b.pitch);
    const programs = new Array(16).fill(0);
    programs[1] = 33; programs[2] = 73; programs[3] = 48;
    return { notes, programs,
             durationS: Math.max(...notes.map(n => n.t + n.dur)), name: "demo score" };
  }

  /* =====================================================================
     Segmenter — bars of segS seconds, thinned to the channel's honest
     capacity (loudest notes win, then time order is restored).
     ===================================================================== */
  function segAirSyms(nNotes, armor) {
    let syms = packetSymCount(32, false);              // MHDR, always protected
    let left = nNotes;
    while (left > 0) {
      const take = Math.min(MAX_NOTES_PKT, left);
      syms += packetSymCount(take * NOTE_BYTES, !armor);
      left -= take;
    }
    return syms;
  }
  function segCapacity(segS, armor) {
    const budget = segS * BAUD - 40;                   // small pacing margin
    let n = 0;
    while (segAirSyms(n + 1, armor) <= budget) n++;
    return n;
  }

  function segmentScore(score, segS, armor) {
    const segTotal = Math.max(1, Math.ceil((score.durationS + 0.001) / segS));
    const cap = segCapacity(segS, armor);
    const segs = [];
    let totalNotes = 0, sentNotes = 0;
    for (let i = 0; i < segTotal; i++) {
      const a = i * segS, b = (i + 1) * segS;
      let recs = [];
      for (const n of score.notes) {
        if (n.t < a || n.t >= b) continue;
        recs.push({
          t: clamp(Math.round((n.t - a) / TICK_S), 0, MAX_TICKS),
          dur: clamp(Math.round(n.dur / TICK_S), 1, MAX_TICKS),
          pitch: clamp(Math.round(n.pitch), 0, 127),
          vel: clamp(Math.round(n.vel), 1, 127),
          ch: n.ch & 15
        });
      }
      totalNotes += recs.length;
      let thinned = 0;
      if (recs.length > cap) {
        thinned = recs.length - cap;
        recs = recs.map((r, k) => [r, k])
                    .sort((x, y) => y[0].vel - x[0].vel || x[1] - y[1])
                    .slice(0, cap)
                    .sort((x, y) => x[0].t - y[0].t || x[1] - y[1])
                    .map(x => x[0]);
      } else {
        recs.sort((x, y) => x.t - y.t || x.pitch - y.pitch);
      }
      sentNotes += recs.length;
      segs.push({ idx: i, recs, thinned });
    }
    return { segs, segTotal, cap, totalNotes, sentNotes,
             thinnedPct: totalNotes ? 100 * (totalNotes - sentNotes) / totalNotes : 0 };
  }

  /* =====================================================================
     Symbols → air (one phase accumulator, 1900 Hz pacing filler)
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

  /* the whole concert to air: bar slots on a real-time grid, packets
     inside each slot, 1900 Hz filler between — the receiver's latency is
     one bar plus a guard, and it never grows */
  function buildSongAudio(score, cfg, opts) {
    const o = opts || {};
    const fs = TX_FS;
    const armor = !!cfg.armor;
    const segS = cfg.segS;
    const sessionId = cfg.sessionId != null ? cfg.sessionId & 0xFFFF
                    : (1 + Math.floor(Math.random() * 65534));
    const plan = segmentScore(score, segS, armor);
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
    if (o.voxHdr) push(run.tone(LEADER_F, Math.round(0.7 * fs)));
    push(run.tone(LEADER_F, Math.round(LEADER_S * fs)), { type: "leader" });
    const pre = new Uint8Array(PREAMBLE_SYMS);
    for (let i = 0; i < PREAMBLE_SYMS; i++) pre[i] = i & 1 ? 3 : 0;
    push(run.symbols(pre), { type: "preamble" });
    const origin = n;
    const spSeg = fs * segS;
    for (const seg of plan.segs) {
      const slot = origin + Math.round(seg.idx * spSeg);
      if (n < slot) push(run.tone(LEADER_F, slot - n), { type: "filler" });
      const subPkts = Math.ceil(seg.recs.length / MAX_NOTES_PKT) || 0;
      push(run.symbols(buildPacketTones(PKT_MHDR, seg.idx,
        buildMhdr(sessionId, seg.idx, plan.segTotal, segS, armor,
                  seg.recs.length, subPkts, score.programs), false)),
        { type: "mhdr", seg: seg.idx });
      for (let sub = 0; sub < subPkts; sub++) {
        const batch = seg.recs.slice(sub * MAX_NOTES_PKT, (sub + 1) * MAX_NOTES_PKT);
        push(run.symbols(buildPacketTones(
          armor ? PKT_MNOTES_FEC : PKT_MNOTES_RAW,
          notesSeq(seg.idx, sub), packNotes(batch), !armor)),
          { type: "mnotes", seg: seg.idx, sub, notes: batch.length });
      }
    }
    push(run.symbols(buildPacketTones(PKT_END, 0, new Uint8Array(0), false)), { type: "end" });
    const sig = new Float32Array(n);
    let p = 0;
    for (const part of parts) { sig.set(part, p); p += part.length; }
    rampEdges(sig, fs);
    const pad = Math.round(PAD_S * fs);
    const y = new Float32Array(pad + n + pad);
    y.set(sig, pad);
    for (const L of layout) L.at += pad;
    return { y, fs, layout, plan, sessionId, segS, armor, airS: y.length / fs };
  }

  /* =====================================================================
     Concert state — radio-agnostic. Collects verified skeleton + note
     records (with their sobriety verdicts) into a song-time schedule.
     ===================================================================== */
  class ConcertRx {
    constructor() { this.reset(null); }
    reset(h) {
      this.sessionId = h ? h.sessionId : null;
      this.segS = h ? h.segS : null;
      this.armor = h ? h.armor : false;
      this.segTotal = h ? h.segTotal : 0;
      this.programs = h ? h.programs.slice() : new Array(16).fill(0);
      this.segs = {};                        // idx -> {hdr, noteCount, subPkts, subs:{}}
      this.pending = [];                     // notes heard before any header
      this.firstSeg = -1;
      this.stats = { notes: 0, drunkPkts: 0, cleanPkts: 0, dropPkts: 0,
                     hdrs: 0, orphans: 0 };
    }
    _seg(idx) {
      return this.segs[idx] ||= { hdr: false, noteCount: 0, subPkts: 0, subs: {} };
    }
    applyMhdr(h) {
      const isNew = this.sessionId === null || this.sessionId !== h.sessionId;
      /* notes that arrived before ANY header were held blind; they belong
         to this session and must survive the reset. Pending notes from a
         DIFFERENT old session are stale and correctly discarded. */
      const held = this.sessionId === null ? this.pending : [];
      if (isNew) { this.reset(h); this.pending = held; this.stats.orphans = held.length; }
      const s = this._seg(h.segIdx);
      s.hdr = true;
      s.noteCount = h.noteCount;
      s.subPkts = h.subPkts;
      this.segTotal = h.segTotal;
      this.programs = h.programs.slice();
      this.stats.hdrs++;
      if (this.firstSeg < 0) this.firstSeg = h.segIdx;
      const flushed = [];
      if (this.pending.length) {
        for (const p of this.pending) flushed.push(this.applyNotes(p.segIdx, p.sub, p.recs, p.drunk));
        this.pending = [];
      }
      return { isNew, segIdx: h.segIdx, flushed: flushed.filter(Boolean) };
    }
    applyNotes(segIdx, sub, recs, drunk) {
      if (this.sessionId === null) {          // header not heard yet — hold the notes
        this.pending.push({ segIdx, sub, recs, drunk });
        this.stats.orphans++;
        return null;
      }
      const s = this._seg(segIdx);
      if (s.subs[sub]) return null;           // duplicate
      s.subs[sub] = true;
      if (this.firstSeg < 0 || segIdx < this.firstSeg) this.firstSeg = segIdx;
      const out = recs.map(r => ({
        seg: segIdx,
        t: segIdx * this.segS + r.t * TICK_S,
        dur: r.dur * TICK_S,
        pitch: r.pitch, vel: r.vel, ch: r.ch, drunk
      }));
      this.stats.notes += out.length;
      if (drunk) this.stats.drunkPkts++; else this.stats.cleanPkts++;
      return { segIdx, sub, notes: out, drunk };
    }
    noteRate() {
      return this.stats.cleanPkts + this.stats.drunkPkts
        ? this.stats.notes / Math.max(1, Object.keys(this.segs).length * (this.segS || 10))
        : 0;
    }
  }

  /* =====================================================================
     Streaming receiver — the D3 state machine (per-packet sync re-lock
     over a rolling buffer) taught to read RAW sections: bare notes are
     hard-decided symbol by symbol, their CRC is a sobriety report, not
     a gate. Armored notes and all headers keep the Viterbi + CRC law.
     ===================================================================== */
  class StreamRX {
    constructor(fs, cb) {
      this.fs = fs;
      this.cb = cb || {};
      this.spSym = fs / BAUD;
      this.buf = new Float32Array(1 << 17);
      this.len = 0;
      this.base = 0;
      this.cursor = 0;
      this.state = "hunt";
      this.hdr = null;
      this.con = new ConcertRx();
      this.stats = { pkts: 0, crcFail: 0, hdrFail: 0, sync: 0, netBytes: 0 };
      this.gate = 3e-4;
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
    _decodeSectionRaw(pos, nBytes, E) {
      const out = new Uint8Array(nBytes);
      let sym = 0;
      for (let i = 0; i < nBytes; i++) {
        let v = 0;
        for (let k = 0; k < 4; k++) {
          this._energies(pos + sym * this.spSym, pos + (sym + 1) * this.spSym, E);
          let best = 0;
          for (let t = 1; t < 4; t++) if (E[t] > E[best]) best = t;
          v = (v << 2) | GRAY_DEC[best];
          sym++;
        }
        out[i] = v;
      }
      return out;
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
            this.cursor += this.spSym;
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
          if (++scanned >= 48) return true;
        }
        this._compact();
        return false;
      }

      if (!this.hdr) {
        const need = (SYNCSEQ.length + HDR_SYMS + 2) * this.spSym;
        if (this.avail - this.cursor < need) { this._compact(); return false; }
        const rl = this._refine(this.cursor, 0.6, 1 / 16, E);
        if (rl.score < 0.30) {
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
          return false;
        }
        let pos = rl.pos + SYNCSEQ.length * this.spSym;
        const hb = this._decodeSection(pos, 7, E);
        pos += HDR_SYMS * this.spSym;
        if (crc16(hb, 5) !== ((hb[5] << 8) | hb[6])) {
          this.stats.hdrFail++;
          this.cursor = pos;
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

      const raw = this.hdr.type === PKT_MNOTES_RAW;
      const bodySyms = raw ? rawSectionSyms(this.hdr.len + 4) : sectionSyms(this.hdr.len + 4);
      if (this.avail - this.hdr.bodyAt < (bodySyms + 2) * this.spSym) return false;
      const body = raw ? this._decodeSectionRaw(this.hdr.bodyAt, this.hdr.len + 4, E)
                       : this._decodeSection(this.hdr.bodyAt, this.hdr.len + 4, E);
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
      if (type === PKT_MHDR) {
        if (!ok) { this.stats.crcFail++; }
        else {
          const h = parseMhdr(payload);
          if (!h) this.stats.hdrFail++;
          else {
            const r = this.con.applyMhdr(h);
            if (this.cb.onMhdr) this.cb.onMhdr(h, r, this);
            if (r.flushed && this.cb.onNotes)
              for (const f of r.flushed) this.cb.onNotes(f, this);
          }
        }
      } else if (type === PKT_MNOTES_RAW || type === PKT_MNOTES_FEC) {
        const armored = type === PKT_MNOTES_FEC;
        if (armored && !ok) {
          this.stats.crcFail++;                 // armor law: drop, never slur
          this.con.stats.dropPkts++;
        } else if (payload.length % NOTE_BYTES !== 0) {
          this.stats.hdrFail++;                 // impossible length — framing lie
        } else {
          if (!ok) this.stats.crcFail++;        // bare: report the drunkenness…
          this.stats.netBytes += payload.length;
          const q = notesSeqParse(seq);
          const r = this.con.applyNotes(q.segIdx, q.sub, unpackNotes(payload), !ok);
          if (r && this.cb.onNotes) this.cb.onNotes(r, this);  // …and play anyway
        }
      } else if (type === PKT_END && ok) {
        this.ended = true;
        this.state = "hunt";
        if (this.cb.log) this.cb.log("end of transmission");
        if (this.cb.onEnd) this.cb.onEnd(this);
      } else if (!ok) {
        this.stats.crcFail++;
      }
      if (this.cb.onStats) this.cb.onStats(this);
    }
  }

  /* =====================================================================
     GM synth — hand-rolled Web Audio, in this studio's tradition.
     Fourteen timbre families as PeriodicWave harmonic recipes cover all
     128 GM programs; channel 10 is a small noise-and-sine drum kit.
     It will not be mistaken for a concert hall — it WILL be mistaken
     for a rather charming 1993 sound card, which is exactly the budget.
     ===================================================================== */
  const FAMS = {
    piano:   { h: [1, .55, .32, .2, .13, .08, .05, .03], a: .004, pluck: true, dk: 2.2 },
    mallet:  { h: [1, .02, .28, 0, .12, 0, .05],          a: .003, pluck: true, dk: 1.3 },
    bell:    { h: [1, 0, 0, .6, 0, 0, 0, .35, 0, 0, 0, .15], a: .003, pluck: true, dk: 2.6 },
    organ:   { h: [1, .85, .55, .45, .28, .18, .1],       a: .02, d: .05, s: .9, r: .08 },
    pluck:   { h: [1, .62, .4, .3, .22, .15, .1, .07],    a: .004, pluck: true, dk: 1.1 },
    bass:    { h: [1, .5, .22, .08],                      a: .006, pluck: true, dk: 1.6 },
    strings: { h: [1, .5, .33, .25, .2, .17, .14, .12, .1, .09], a: .14, d: .1, s: .8, r: .3, dual: 6 },
    brass:   { h: [1, .7, .55, .42, .3, .2, .12],         a: .06, d: .08, s: .75, r: .15 },
    reed:    { h: [1, 0, .68, 0, .4, 0, .24, 0, .12],     a: .05, d: .06, s: .8, r: .12 },
    flute:   { h: [1, .14, .05, .02],                     a: .07, d: .05, s: .85, r: .15 },
    lead:    { h: [1, 0, .33, 0, .2, 0, .14, 0, .11],     a: .01, d: .03, s: .85, r: .1 },
    pad:     { h: [1, .5, .33, .25, .2, .17, .14, .12],   a: .3, d: .2, s: .8, r: .5, dual: 8 }
  };
  function progFamily(p) {
    p = clamp(p | 0, 0, 127);
    if (p < 8) return "piano";
    if (p < 16) return (p === 9 || p === 10 || p === 14) ? "bell" : "mallet";
    if (p < 24) return "organ";
    if (p < 32) return "pluck";
    if (p < 40) return "bass";
    if (p < 48) return "strings";
    if (p < 56) return "pad";
    if (p < 64) return "brass";
    if (p < 72) return "reed";
    if (p < 80) return "flute";
    if (p < 88) return "lead";
    if (p < 112) return "pad";
    return "mallet";
  }

  class GMSynth {
    constructor(actx, dest) {
      this.actx = actx;
      this.master = actx.createGain();
      this.master.gain.value = 0.55;
      this.master.connect(dest || actx.destination);
      this._waves = {};
      this._noise = null;
      this._live = [];                      // {stopT, nodes[]}
    }
    setGain(v) { this.master.gain.value = clamp(v, 0, 1); }
    _wave(fam) {
      if (!this._waves[fam]) {
        const h = FAMS[fam].h;
        const im = new Float32Array(h.length + 1);
        for (let i = 0; i < h.length; i++) im[i + 1] = h[i];
        this._waves[fam] = this.actx.createPeriodicWave(new Float32Array(im.length), im);
      }
      return this._waves[fam];
    }
    _noiseBuf() {
      if (!this._noise) {
        const n = this.actx.sampleRate;
        const b = this.actx.createBuffer(1, n, this.actx.sampleRate);
        const d = b.getChannelData(0);
        let s = 22222;
        for (let i = 0; i < n; i++) {
          s = (s * 1103515245 + 12345) & 0x7fffffff;
          d[i] = (s / 0x3fffffff) - 1;
        }
        this._noise = b;
      }
      return this._noise;
    }
    _admit(stopT, nodes) {
      const now = this.actx.currentTime;
      this._live = this._live.filter(v => v.stopT > now);
      if (this._live.length > 72) return false;         // full pit — drop quietly
      this._live.push({ stopT, nodes });
      return true;
    }
    allOff() {
      for (const v of this._live)
        for (const n of v.nodes) { try { n.stop(); } catch (e) {} try { n.disconnect(); } catch (e) {} }
      this._live = [];
    }
    noteAt(when, ch, pitch, vel, dur, prog) {
      if (ch === 9) { this._drum(when, pitch, vel); return; }
      const fam = FAMS[progFamily(prog || 0)];
      const f = 440 * Math.pow(2, (pitch - 69) / 12);
      if (f < 20 || f > 9000) return;
      const g0 = Math.pow(clamp(vel, 1, 127) / 127, 1.5) * 0.2;
      const ac = this.actx;
      const gain = ac.createGain();
      gain.gain.value = 0;
      gain.connect(this.master);
      const oscs = [];
      const mk = det => {
        const o = ac.createOscillator();
        o.setPeriodicWave(this._wave(progFamily(prog || 0)));
        o.frequency.value = f;
        if (det) o.detune.value = det;
        o.connect(gain);
        oscs.push(o);
      };
      mk(0);
      if (fam.dual) { mk(fam.dual); mk(-fam.dual); }
      const gPeak = fam.dual ? g0 / 1.7 : g0;
      let stopT;
      const gp = gain.gain;
      gp.setValueAtTime(0, when);
      gp.linearRampToValueAtTime(gPeak, when + fam.a);
      if (fam.pluck) {
        const dk = fam.dk * clamp(1 + (60 - pitch) / 48, 0.4, 2.6);
        const end = Math.min(dur + 0.09, dk);
        gp.setTargetAtTime(0.0001, when + fam.a, end / 5);
        stopT = when + end + 0.3;
      } else {
        gp.setTargetAtTime(fam.s * gPeak, when + fam.a, fam.d);
        gp.setValueAtTime(fam.s * gPeak, when + Math.max(fam.a + fam.d, dur));
        gp.setTargetAtTime(0.0001, when + Math.max(fam.a + fam.d, dur), fam.r / 3);
        stopT = when + Math.max(fam.a + fam.d, dur) + fam.r + 0.25;
      }
      if (!this._admit(stopT, oscs)) { gain.disconnect(); return; }
      for (const o of oscs) { o.start(when); o.stop(stopT); }
      oscs[0].onended = () => { try { gain.disconnect(); } catch (e) {} };
    }
    _drum(when, note, vel) {
      const ac = this.actx;
      const g0 = Math.pow(clamp(vel, 1, 127) / 127, 1.4);
      const out = (env, len) => {
        const g = ac.createGain();
        g.gain.value = 0;
        g.connect(this.master);
        env(g.gain);
        return g;
      };
      const noise = (bpF, bpQ, hp, len, amp) => {
        const src = ac.createBufferSource();
        src.buffer = this._noiseBuf();
        src.loop = true;
        let node = src;
        if (hp) { const f = ac.createBiquadFilter(); f.type = "highpass"; f.frequency.value = hp; node.connect(f); node = f; }
        if (bpF) { const f = ac.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = bpF; f.Q.value = bpQ || 1; node.connect(f); node = f; }
        const g = out(gp => {
          gp.setValueAtTime(amp * g0, when);
          gp.setTargetAtTime(0.0001, when, len / 4);
        });
        node.connect(g);
        if (!this._admit(when + len + 0.2, [src])) { g.disconnect(); return; }
        src.start(when);
        src.stop(when + len + 0.2);
        src.onended = () => { try { g.disconnect(); } catch (e) {} };
      };
      const thump = (f0, f1, len, amp) => {
        const o = ac.createOscillator();
        o.frequency.setValueAtTime(f0, when);
        o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), when + len * 0.6);
        const g = out(gp => {
          gp.setValueAtTime(amp * g0, when);
          gp.setTargetAtTime(0.0001, when, len / 4);
        });
        o.connect(g);
        if (!this._admit(when + len + 0.2, [o])) { g.disconnect(); return; }
        o.start(when);
        o.stop(when + len + 0.2);
        o.onended = () => { try { g.disconnect(); } catch (e) {} };
      };
      if (note === 35 || note === 36) thump(125, 44, 0.20, 0.9);
      else if (note === 38 || note === 40 || note === 39) { noise(1800, 1, 0, 0.18, 0.5); thump(195, 150, 0.07, 0.25); }
      else if (note === 42 || note === 44) noise(0, 0, 7000, 0.06, 0.28);
      else if (note === 46) noise(0, 0, 6500, 0.32, 0.26);
      else if (note === 49 || note === 57) noise(5200, 0.6, 0, 1.1, 0.35);
      else if (note === 51 || note === 53 || note === 59) noise(7400, 2.2, 0, 0.5, 0.2);
      else if (note >= 41 && note <= 50) thump(90 + (note - 41) * 15, 55, 0.24, 0.55);
      else noise(3000, 1, 0, 0.08, 0.22);
    }
  }

  /* =====================================================================
     Spectrogram (the "on-air scope") — same look as the sibling modules
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

  /* channel colours for the piano rolls */
  const CH_COLORS = ["#45c7d6", "#f5c346", "#e06fae", "#8ad46b", "#7f9cf5",
                     "#f28d5c", "#5cd6b0", "#c98bf0", "#d6d05c", "#bfc7d6",
                     "#6bd4d4", "#f0a3a3", "#a3f0c2", "#f0d9a3", "#a3b8f0", "#d6a3f0"];

  function drawRoll(canvas, notes, t0, t1, opts) {
    const o = opts || {};
    const c = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    c.fillStyle = "#05070b";
    c.fillRect(0, 0, W, H);
    const span = Math.max(0.5, t1 - t0);
    const pLo = 26, pHi = 98;
    const x = t => (t - t0) / span * W;
    const yP = p => H - 14 - (clamp(p, pLo, pHi) - pLo) / (pHi - pLo) * (H - 22);
    if (o.segS) {
      c.strokeStyle = "rgba(96,114,150,0.22)";
      c.lineWidth = 1;
      for (let s = Math.ceil(t0 / o.segS) * o.segS; s <= t1; s += o.segS) {
        c.beginPath(); c.moveTo(x(s) + 0.5, 0); c.lineTo(x(s) + 0.5, H); c.stroke();
      }
    }
    for (const n of notes) {
      const nt1 = n.t + Math.max(0.04, n.dur);
      if (nt1 < t0 || n.t > t1) continue;
      const col = CH_COLORS[n.ch & 15];
      if (n.ch === 9) {
        c.fillStyle = (o.dim || n.dim) ? "rgba(96,114,150,0.25)" : (n.drunk ? "#f5c346" : col);
        c.fillRect(x(n.t), H - 10, 2, 8);
        continue;
      }
      c.fillStyle = (o.dim || n.dim) ? "rgba(96,114,150,0.25)" : col;
      const h = 3;
      c.fillRect(x(n.t), yP(n.pitch) - h / 2, Math.max(1.5, x(nt1) - x(n.t)), h);
      if (n.drunk) {
        c.strokeStyle = "rgba(245,195,70,0.9)";
        c.strokeRect(x(n.t) - 0.5, yP(n.pitch) - h / 2 - 1, Math.max(2, x(nt1) - x(n.t)) + 1, h + 2);
      }
    }
    if (o.playhead !== undefined && o.playhead >= t0 && o.playhead <= t1) {
      c.strokeStyle = "#f5c346";
      c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(x(o.playhead), 0); c.lineTo(x(o.playhead), H); c.stroke();
    }
  }

  /* =====================================================================
     Module definition (browser shell)
     ===================================================================== */
  const CHANNELS = [["Off (direct)", null, "ssb"], ["SSB 2.7 kHz", 2700, "ssb"],
                    ["SSB 2.4 kHz", 2400, "ssb"], ["FM 3 kHz (FRS)", 3000, "fm"]];

  const def = {
    id: "midi",

    init(ctx) {
      this.ctx = ctx;
      this.segS = 10;
      this.armor = false;
      this.voxHdr = false;
      this.squelchDb = -48;
      this.source = "demo";
      this.score = makeDemoScore();
      this.scoreName = "demo score";
      this.enc = null;
      this.synth = null;
      this.player = null;                 // {playStart, song0, segS, scheduled[]}
      this.listening = false;
      this.rx = null;
      this.auditioning = false;
      this._busy = false;
      this._meterAt = 0;
      this._scopeBuf = null;
      this._scopeAt = 0;
      this._rollTimer = 0;
      if (!this._subscribed) {
        this._subscribed = true;
        ctx.audio.onSamples((samples, sr) => this._rxFeed(samples, sr));
      }
    },

    createPanel(el) {
      const chanOpts = CHANNELS.map((c, i) => `<option value="${i}">${c[0]}</option>`).join("");
      el.innerHTML = `
        <div class="mod-layout">
          <div class="mod-main">
            <div class="card">
              <header class="card-head"><h3>RX concert</h3>
                <span class="card-tag mono" id="m1-stage">idle</span></header>
              <div style="padding:10px;background:#05070b">
                <canvas id="m1-roll" width="740" height="220" style="width:100%;display:block"></canvas>
              </div>
              <div class="card-foot mod-controls">
                <span class="mono" id="m1-rxinfo" style="flex:1">—</span>
                <label class="field" style="flex-direction:row;align-items:center;gap:6px">
                  <span>Vol</span>
                  <input type="range" id="m1-vol" min="0" max="100" value="60" style="width:90px"></label>
                <button class="btn btn-mini" id="m1-savemid" disabled>Save RX .mid</button>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>On-air scope</h3>
                <span class="card-tag mono" id="m1-airinfo">—</span></header>
              <div style="padding:10px;background:#05070b">
                <canvas id="m1-spec" width="740" height="150" style="width:100%;display:block"></canvas>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>TX score</h3>
                <span class="card-tag mono" id="m1-txtag">what will fly</span></header>
              <div style="padding:10px;background:#05070b">
                <canvas id="m1-txroll" width="740" height="200" style="width:100%;display:block"></canvas>
              </div>
              <div class="card-foot mod-controls">
                <label class="field"><span>Source</span>
                  <select id="m1-source">
                    <option value="demo">Demo score (built in)</option>
                    <option value="file">MIDI file</option>
                  </select></label>
                <label class="btn" for="m1-file">Load MIDI…</label>
                <input type="file" id="m1-file" accept=".mid,.midi,audio/midi" style="display:none">
                <button class="btn" id="m1-audition">Audition (local)</button>
                <span class="mono" id="m1-scoreinfo" style="flex:1;font-size:11px;text-align:right">—</span>
              </div>
            </div>
          </div>
          <div class="mod-side">
            <div class="card">
              <header class="card-head"><h3>Score · link</h3></header>
              <div class="card-body mod-controls" style="flex-direction:column;align-items:stretch">
                <label class="field"><span>Bar length</span>
                  <select id="m1-seg">
                    <option value="5">5 s (lower latency)</option>
                    <option value="10" selected>10 s</option>
                  </select></label>
                <label class="field"><span>Note armour</span>
                  <select id="m1-armor">
                    <option value="bare" selected>Bare — the drunk orchestra</option>
                    <option value="fec">Full FEC — drop, never slur</option>
                  </select></label>
                <div class="mod-note mono" id="m1-linkinfo" style="font-size:11px">—</div>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>Transmit</h3></header>
              <div class="card-body mod-controls" style="flex-direction:column;align-items:stretch">
                <button class="btn btn-accent" id="m1-encode">Encode</button>
                <button class="btn" id="m1-play" disabled>Transmit (play on air)</button>
                <button class="btn" id="m1-stop">Stop</button>
                <button class="btn" id="m1-savewav" disabled>Save WAV → download</button>
                <label class="field"><span>Loopback channel</span>
                  <select id="m1-chan">${chanOpts}</select></label>
                <div class="mod-controls">
                  <label class="field" style="flex-direction:row;align-items:center;gap:6px">
                    <input type="checkbox" id="m1-noise"><span>Noise, SNR</span></label>
                  <input type="number" id="m1-snr" value="-4" min="-8" max="40" style="width:64px">
                  <span class="mono">dB</span>
                </div>
                <button class="btn" id="m1-loop" disabled>Loopback test</button>
                <label class="field" style="flex-direction:row;align-items:center;gap:6px">
                  <input type="checkbox" id="m1-voxhdr"><span>VOX keying header (FRS)</span></label>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>Receive</h3></header>
              <div class="card-body mod-controls" style="flex-direction:column;align-items:stretch">
                <button class="btn" id="m1-listen">Listen (live concert)</button>
                <div class="mod-controls">
                  <span class="mono" id="m1-meter" style="min-width:64px">— dB</span>
                  <label class="field" style="flex:1"><span>Squelch</span>
                    <input type="range" id="m1-squelch" min="-70" max="-15" step="1" value="-48"></label>
                </div>
                <label class="btn" for="m1-wavin" style="text-align:center">Decode WAV…</label>
                <input type="file" id="m1-wavin" accept=".wav,audio/wav,audio/x-wav" style="display:none">
                <button class="btn" id="m1-selftest">Self-test (loopback)</button>
              </div>
            </div>
            <div class="mod-note">
              HRWS-M1 sends a MIDI score over a voice channel in 5/10-second
              bars; the receiver buffers one bar and plays the reconstruction
              seamlessly, one bar behind the wire. The <b>skeleton</b> (bar
              headers, the program table) rides the D1 Viterbi chain; the
              <b>notes</b> are fixed-width 5-byte records with, in Bare mode,
              <b>no error correction on purpose</b> — a bit error stays inside
              one field of one note. Wrong pitch, wrong beat, wrong instrument:
              the drunk orchestra. Amber-ringed notes on the roll arrived
              drunk; the music plays regardless. Armour mode sends the same
              notes through full FEC instead: damaged bars drop to silence,
              clean ones are perfect — the D2 philosophy argument, scored for
              ensemble.
            </div>
            <div class="mod-note">
              The synth is a hand-rolled Web Audio General MIDI approximation
              (14 timbre families over all 128 programs, plus a drum kit) so
              the whole orchestra renders in the browser — offline,
              dependency-free, honestly 1993. Practical use: none. We are
              hams; it is interesting and it is harmless. Identify per your
              local regulations; both ends need this studio.
            </div>
          </div>
        </div>`;

      const $ = id => el.querySelector("#m1-" + id);
      this.ui = {
        stage: $("stage"), roll: $("roll"), rxinfo: $("rxinfo"),
        vol: $("vol"), savemid: $("savemid"),
        spec: $("spec"), airinfo: $("airinfo"),
        txroll: $("txroll"), txtag: $("txtag"), source: $("source"),
        file: $("file"), audition: $("audition"), scoreinfo: $("scoreinfo"),
        seg: $("seg"), armor: $("armor"), linkinfo: $("linkinfo"),
        encode: $("encode"), play: $("play"), stop: $("stop"), savewav: $("savewav"),
        chan: $("chan"), noise: $("noise"), snr: $("snr"), loop: $("loop"),
        voxhdr: $("voxhdr"),
        listen: $("listen"), meter: $("meter"), squelch: $("squelch"),
        wavin: $("wavin"), selftest: $("selftest")
      };

      this.ui.seg.addEventListener("change", () => {
        this.segS = parseInt(this.ui.seg.value, 10);
        this._invalidate(); this._refreshScoreUi();
      });
      this.ui.armor.addEventListener("change", () => {
        this.armor = this.ui.armor.value === "fec";
        this._invalidate(); this._refreshScoreUi();
      });
      this.ui.voxhdr.addEventListener("change", () => { this.voxHdr = this.ui.voxhdr.checked; this._invalidate(); });
      this.ui.vol.addEventListener("input", () => {
        if (this.synth) this.synth.setGain(parseInt(this.ui.vol.value, 10) / 100 * 0.9);
      });
      this.ui.squelch.addEventListener("input", () => {
        this.squelchDb = parseFloat(this.ui.squelch.value);
        if (this.rx) this.rx.gate = Math.pow(10, this.squelchDb / 20) * 0.7;
      });
      this.ui.source.addEventListener("change", () => {
        if (this.ui.source.value === "demo") {
          this.score = makeDemoScore();
          this.scoreName = "demo score";
          this.source = "demo";
          this._invalidate(); this._refreshScoreUi();
        } else this.source = "file";
      });
      this.ui.file.addEventListener("change", e => {
        const f = e.target.files && e.target.files[0];
        if (f) this._loadMidiFile(f);
        e.target.value = "";
      });
      this.ui.audition.addEventListener("click", () => this._audition());
      this.ui.encode.addEventListener("click", () => this._encode());
      this.ui.play.addEventListener("click", () => this._playAir());
      this.ui.stop.addEventListener("click", () => this._stopEverything());
      this.ui.savewav.addEventListener("click", () => this._saveWav());
      this.ui.loop.addEventListener("click", () => this._loopback());
      this.ui.listen.addEventListener("click", () => this._toggleListen());
      this.ui.wavin.addEventListener("change", e => {
        const f = e.target.files && e.target.files[0];
        if (f) this._decodeWavFile(f);
        e.target.value = "";
      });
      this.ui.savemid.addEventListener("click", () => this._saveRxMid());
      this.ui.selftest.addEventListener("click", () => this._selfTest());

      this._refreshScoreUi();
      const rc = this.ui.roll.getContext("2d");
      rc.fillStyle = "#05070b";
      rc.fillRect(0, 0, this.ui.roll.width, this.ui.roll.height);
      this._rollTimer = setInterval(() => this._rxRollTick(), 400);
    },

    onDeactivate() {
      this.listening = false;
      this.rx = null;
      this.auditioning = false;
      if (this.synth) this.synth.allOff();
      if (this._rollTimer) clearInterval(this._rollTimer);
      this._rollTimer = 0;
      this.player = null;
      this.ui = null;
    },

    _stage(t) { if (this.ui) this.ui.stage.textContent = t; },
    _invalidate() {
      this.enc = null;
      if (this.ui) this.ui.play.disabled = this.ui.savewav.disabled = this.ui.loop.disabled = true;
    },
    _ensureSynth() {
      const audio = this.ctx.audio;
      audio.ensureContext();
      if (!this.synth) {
        this.synth = new GMSynth(audio.ctx, audio.monitorBus || audio.ctx.destination);
        this.synth.setGain(parseInt(this.ui.vol.value, 10) / 100 * 0.9);
      }
      return this.synth;
    },

    /* ---------------- score side ---------------- */
    _refreshScoreUi() {
      if (!this.ui) return;
      const plan = segmentScore(this.score, this.segS, this.armor);
      const dim = this.score.notes.map(n => ({ t: n.t, dur: n.dur, pitch: n.pitch, ch: n.ch, dim: true }));
      const bright = [];
      for (const s of plan.segs)
        for (const r of s.recs)
          bright.push({ t: s.idx * this.segS + r.t * TICK_S, dur: r.dur * TICK_S,
                        pitch: r.pitch, ch: r.ch });
      drawRoll(this.ui.txroll, dim.concat(bright), 0,
               Math.max(this.segS, this.score.durationS), { segS: this.segS });
      const dur = this.score.durationS;
      this.ui.scoreinfo.textContent =
        `${this.scoreName} · ${this.score.notes.length} notes · ${dur.toFixed(0)} s · ` +
        `${(this.score.notes.length / Math.max(1, dur)).toFixed(1)} notes/s`;
      this.ui.linkinfo.textContent =
        `4-FSK 500 Bd · ${this.armor ? "notes armoured (K=7 FEC)" : "notes bare (drunk channel)"} · ` +
        `capacity ${(plan.cap / this.segS).toFixed(1)} notes/s · ` +
        `RX latency ≈ ${(this.segS + GUARD_S).toFixed(1)} s` +
        (plan.thinnedPct > 0.5 ? ` · ⚠ thinning ${plan.thinnedPct.toFixed(0)} % (loudest win)` : "");
      this.ui.txtag.textContent = plan.thinnedPct > 0.5
        ? `${plan.sentNotes}/${plan.totalNotes} notes will fly`
        : "what will fly";
    },

    async _loadMidiFile(f) {
      try {
        const buf = await f.arrayBuffer();
        const sc = parseMidi(buf);
        if (!sc.notes.length) throw new Error("no notes found");
        this.score = sc;
        this.scoreName = f.name;
        this.source = "file";
        this.ui.source.value = "file";
        for (const w of sc.warnings) this.ctx.log("midi: " + w);
        this.ctx.log(`midi: loaded ${f.name} — ${sc.notes.length} notes, ` +
                     `${sc.durationS.toFixed(0)} s`);
        this._invalidate();
        this._refreshScoreUi();
      } catch (e) {
        this.ctx.log("midi load failed: " + e.message);
      }
    },

    _audition() {
      if (this.auditioning) {
        this.auditioning = false;
        if (this.synth) this.synth.allOff();
        this.ui.audition.textContent = "Audition (local)";
        return;
      }
      const synth = this._ensureSynth();
      const plan = segmentScore(this.score, this.segS, this.armor);
      const t0 = this.ctx.audio.ctx.currentTime + 0.25;
      let n = 0;
      for (const s of plan.segs)
        for (const r of s.recs) {
          synth.noteAt(t0 + s.idx * this.segS + r.t * TICK_S, r.ch, r.pitch, r.vel,
                       r.dur * TICK_S, this.score.programs[r.ch]);
          n++;
        }
      this.auditioning = true;
      this.ui.audition.textContent = "Stop audition";
      this.ctx.log(`auditioning the ${n}-note thinned score locally (what the far end would hear on a clean channel)`);
      setTimeout(() => {
        if (this.auditioning && this.ui) {
          this.auditioning = false;
          this.ui.audition.textContent = "Audition (local)";
        }
      }, (this.score.durationS + 2) * 1000);
    },

    /* ---------------- TX ---------------- */
    async _encode() {
      if (this._busy) return;
      this._busy = true;
      this.ui.encode.disabled = true;
      try {
        this._stage("encoding…");
        await tick();
        const t0 = performance.now();
        this.enc = buildSongAudio(this.score, { segS: this.segS, armor: this.armor },
                                  { voxHdr: this.voxHdr });
        drawSpectrogram(this.ui.spec, this.enc.y, TX_FS);
        const p = this.enc.plan;
        this.ui.airinfo.textContent =
          `${p.sentNotes}/${p.totalNotes} notes · ${p.segTotal} bars · ${this.enc.airS.toFixed(0)} s air`;
        this.ctx.log(`M1 encoded ${this.scoreName}: ${p.sentNotes}/${p.totalNotes} notes ` +
          `(${p.thinnedPct.toFixed(0)} % thinned) in ${p.segTotal} × ${this.segS} s bars, ` +
          `${this.armor ? "armoured" : "bare"} → ${this.enc.airS.toFixed(0)} s on air ` +
          `(${((performance.now() - t0) / 1000).toFixed(1)} s)`);
        this._stage("ready");
        this.ui.play.disabled = this.ui.savewav.disabled = this.ui.loop.disabled = false;
      } catch (e) {
        console.error(e);
        this._stage("error");
        this.ctx.log("M1 encode failed: " + e.message);
      } finally {
        this._busy = false;
        this.ui.encode.disabled = false;
      }
    },

    _playAir() {
      if (!this.enc) return;
      this.ctx.audio.playPCM(this.enc.y, TX_FS);
      this.ctx.log(`M1 concert on air (${this.enc.airS.toFixed(0)} s)`);
    },

    _stopEverything() {
      this.ctx.audio.stopTX();
      if (this.synth) this.synth.allOff();
      this.auditioning = false;
      if (this.ui) this.ui.audition.textContent = "Audition (local)";
      this.player = null;
      this._stage("idle");
    },

    _saveWav() {
      if (!this.enc) return;
      const buf = wavEncode16(this.enc.y, TX_FS);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
      a.download = `m1_${this.segS}s_${this.armor ? "armor" : "bare"}.wav`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
      this.ctx.log(`saved ${a.download} (${(buf.byteLength / 1048576).toFixed(1)} MB)`);
    },

    /* ---------------- RX side ---------------- */
    _anchorPlayer(h, playback) {
      const actx = this.ctx.audio.ensureContext();
      this.player = {
        segS: h.segS,
        song0: h.segIdx * h.segS,
        playStart: actx.currentTime + h.segS + GUARD_S,
        programs: h.programs.slice(),
        scheduled: [], late: 0, playback
      };
      if (this.ui) this.ui.savemid.disabled = true;
    },

    _makeRxCallbacks(label, playback) {
      return {
        log: m => this.ctx.log("m1: " + m),
        onMhdr: (h, r) => {
          if (r.isNew || !this.player) this._anchorPlayer(h, playback);
          this.player.programs = h.programs.slice();
          this._stage(`bar ${h.segIdx + 1}/${h.segTotal} · ` +
                      `${h.armor ? "armoured" : "bare"} · ${label}`);
          if (r.isNew)
            this.ctx.log(`m1: session ${h.sessionId} — ${h.segTotal} bars of ${h.segS} s, ` +
                         `${h.armor ? "armoured notes" : "bare notes (drunk channel)"} · ` +
                         `playback ${playback ? `starts in ${(h.segS + GUARD_S).toFixed(0)} s` : "muted"}`);
        },
        onNotes: (r, rx) => {
          if (!this.player) return;
          const P = this.player;
          const actx = this.ctx.audio.ctx;
          for (const n of r.notes) {
            const when = P.playStart + (n.t - P.song0);
            if (P.playback && this.synth) {
              if (when < actx.currentTime + 0.03) P.late++;
              else this.synth.noteAt(when, n.ch, n.pitch, n.vel, n.dur,
                                     P.programs[n.ch] || 0);
            }
            P.scheduled.push(n);
          }
          if (this.ui) {
            this.ui.savemid.disabled = P.scheduled.length === 0;
            const st = rx.con.stats;
            this.ui.rxinfo.textContent =
              `${st.notes} notes · ${st.cleanPkts} clean` +
              (st.drunkPkts ? ` · ${st.drunkPkts} drunk 🍷` : "") +
              (st.dropPkts ? ` · ${st.dropPkts} dropped` : "") +
              (P.late ? ` · ${P.late} too late` : "") + ` · ${label}`;
          }
        },
        onEnd: rx => {
          const st = rx.con.stats;
          this._stage(`end of programme — ${st.notes} notes` +
                      (st.drunkPkts ? `, ${st.drunkPkts} drunk packets` : "") +
                      (st.dropPkts ? `, ${st.dropPkts} dropped` : ""));
        },
        onStats: () => {}
      };
    },

    _rxRollTick() {
      if (!this.ui || !this.player) return;
      const P = this.player;
      const actx = this.ctx.audio.ctx;
      const songNow = P.song0 + (actx.currentTime - P.playStart);
      const t0 = Math.max(P.song0 - 1, songNow - 6);
      drawRoll(this.ui.roll, P.scheduled, t0, t0 + 24,
               { segS: P.segS, playhead: songNow });
    },

    async _toggleListen() {
      if (this.listening) {
        this.listening = false;
        this.rx = null;
        this.ui.listen.textContent = "Listen (live concert)";
        this._stage("idle");
        return;
      }
      const audio = this.ctx.audio;
      if (!audio.rxActive) {
        try { await audio.startRX(); }
        catch (e) { this.ctx.log("input error: " + e.message); return; }
      }
      this._ensureSynth();
      this.listening = true;
      this.rx = null;
      this.ui.listen.textContent = "Stop listening";
      this._stage("listening — the hall is open");
      this.ctx.log("M1 listening — one bar of latency, then the concert follows the wire");
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
        this.rx = new StreamRX(sr, this._makeRxCallbacks("live", true));
        this.rx.gate = Math.pow(10, this.squelchDb / 20) * 0.7;
      }
      this.rx.push(block);
      this.rx.drain();
      this._scopeFeed(block, sr);
    },

    _scopeFeed(block, sr) {
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
      const nowT = performance.now();
      if (nowT - this._scopeAt > 1500 && S.n > S.sr) {
        this._scopeAt = nowT;
        drawSpectrogram(this.ui.spec, S.y.subarray(0, S.n), S.sr);
      }
    },

    async _decodeBuffer(y, fs, label, playback) {
      const rx = new StreamRX(fs, this._makeRxCallbacks(label, playback));
      const step = Math.round(0.5 * fs);
      for (let p = 0; p < y.length; p += step) {
        rx.push(y.subarray(p, Math.min(y.length, p + step)));
        await rx.drain();
        this._stage(`decoding ${label}… ${Math.round(100 * Math.min(1, (p + step) / y.length))} %`);
      }
      await rx.drain();
      if (this.ui && rx.con.stats.notes === 0)
        this._stage(rx.stats.pkts ? "no notes decoded" : "no sync found — is this HRWS-M1?");
      return rx;
    },

    async _decodeWavFile(f) {
      if (this._busy) return;
      this._busy = true;
      try {
        this._ensureSynth();
        const buf = await f.arrayBuffer();
        const wav = wavDecodeMono(buf);
        this.ctx.log(`decoding ${f.name}: ${(wav.y.length / wav.rate).toFixed(1)} s @ ${wav.rate} Hz`);
        drawSpectrogram(this.ui.spec, wav.y, wav.rate);
        this.ui.airinfo.textContent = `${f.name} · ${(wav.y.length / wav.rate).toFixed(0)} s`;
        await this._decodeBuffer(wav.y, wav.rate, "WAV", true);
      } catch (e) {
        console.error(e);
        this.ctx.log("WAV decode failed: " + e.message);
        this._stage("error");
      } finally {
        this._busy = false;
      }
    },

    async _loopback() {
      if (!this.enc || this._busy) return;
      this._busy = true;
      try {
        this._ensureSynth();
        let sig = this.enc.y;
        const ch = CHANNELS[parseInt(this.ui.chan.value, 10) || 0];
        const snr = this.ui.noise.checked ? parseFloat(this.ui.snr.value) : null;
        if (ch[1] || snr !== null) {
          this._stage("channel sim…");
          await tick();
          sig = channelSimulate(sig, TX_FS, ch[1], snr, 7, ch[2]);
          drawSpectrogram(this.ui.spec, sig, TX_FS);
          this.ctx.log(`channel sim: ${ch[0]}` + (snr !== null ? `, SNR ${snr} dB` : ""));
        }
        const rx = await this._decodeBuffer(sig, TX_FS, "loopback", true);
        const st = rx.con.stats;
        this.ctx.log(`loopback: ${st.notes} notes` +
                     (st.drunkPkts ? `, ${st.drunkPkts} drunk packets 🍷` : ", all sober") +
                     (st.dropPkts ? `, ${st.dropPkts} armoured packets dropped` : "") +
                     ` — the concert plays ${this.segS + GUARD_S | 0} s behind the wire`);
      } catch (e) {
        console.error(e);
        this.ctx.log("loopback failed: " + e.message);
        this._stage("error");
      } finally {
        this._busy = false;
      }
    },

    _saveRxMid() {
      const P = this.player;
      if (!P || !P.scheduled.length) return;
      const notes = P.scheduled.map(n => ({
        t: Math.max(0, n.t - P.song0), dur: n.dur,
        pitch: n.pitch, vel: n.vel, ch: n.ch
      })).sort((a, b) => a.t - b.t);
      const file = writeMidi(notes, P.programs);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([file], { type: "audio/midi" }));
      a.download = "m1_received.mid";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
      this.ctx.log(`saved m1_received.mid — ${notes.length} notes, exactly as heard` +
                   ` (drunk ones included; that's the point)`);
    },

    async _selfTest() {
      if (this._busy) return;
      this._busy = true;
      const log = m => this.ctx.log("m1 self-test: " + m);
      const key = (seg, r) => `${seg}:${r.t}:${r.dur}:${r.pitch}:${r.vel}:${r.ch}`;
      const sentSet = plan => {
        const s = new Set();
        for (const sg of plan.segs)
          for (const r of sg.recs) s.add(key(sg.idx, r));
        return s;
      };
      const gotKeys = P => P.scheduled.map(n =>
        key(n.seg, { t: Math.round((n.t - n.seg * 5) / TICK_S), dur: Math.round(n.dur / TICK_S),
                     pitch: n.pitch, vel: n.vel, ch: n.ch }));
      try {
        const demo = makeDemoScore();
        const short = { notes: demo.notes.filter(n => n.t < 20), programs: demo.programs,
                        durationS: 20 };
        this._stage("self-test 1/3: bare, direct…");
        await tick();
        const e1 = buildSongAudio(short, { segS: 5, armor: false, sessionId: 777 }, {});
        const rx1 = await this._decodeBuffer(e1.y, TX_FS, "self-test 1/3", false);
        const s1 = sentSet(e1.plan);
        const g1 = gotKeys(this.player);
        const ok1 = g1.length === e1.plan.sentNotes && g1.every(k => s1.has(k));
        log(`bare/direct: ${ok1 ? "PASS" : "FAIL"} — ${g1.length}/${e1.plan.sentNotes} notes, ` +
            (ok1 ? "every field exact" : "field mismatches on a clean channel"));

        this._stage("self-test 2/3: bare, deliberate noise…");
        await tick();
        const noisy = channelSimulate(e1.y, TX_FS, 2400, DRUNK_SNR, 7, "ssb");
        const rx2 = await this._decodeBuffer(noisy, TX_FS,
          "self-test 2/3 · deliberate simulated noise", false);
        const g2 = gotKeys(this.player);
        const wrong = g2.filter(k => !s1.has(k)).length;
        const st2 = rx2.con.stats;
        const ok2 = g2.length >= 0.6 * e1.plan.sentNotes && st2.drunkPkts > 0;
        log(`bare @ ${DRUNK_SNR} dB: ${ok2 ? "PASS" : "check"} — ${g2.length}/${e1.plan.sentNotes} notes ` +
            `played on, ${st2.drunkPkts} drunk packets, ${wrong} notes came out wrong 🍷 ` +
            `(the orchestra slurred but never stopped)`);

        this._stage("self-test 3/3: armoured, same noise…");
        await tick();
        const e3 = buildSongAudio(short, { segS: 5, armor: true, sessionId: 778 }, {});
        const n3 = channelSimulate(e3.y, TX_FS, 2400, DRUNK_SNR, 7, "ssb");
        const rx3 = await this._decodeBuffer(n3, TX_FS, "self-test 3/3 · armoured + noise", false);
        const s3 = sentSet(e3.plan);
        const g3 = gotKeys(this.player);
        const wrong3 = g3.filter(k => !s3.has(k)).length;
        const ok3 = wrong3 === 0;
        log(`armour @ ${DRUNK_SNR} dB: ${ok3 ? "PASS" : "FAIL"} — ${g3.length}/${e3.plan.sentNotes} notes, ` +
            `${rx3.con.stats.dropPkts} packets dropped, ${wrong3} wrong notes ` +
            `(armour drops, never slurs)`);
        this._stage(ok1 && ok2 && ok3 ? "self-test PASS — sober, drunk, armoured"
                                      : "self-test: see log");
        log("(self-test decodes silently; run Loopback with noise to HEAR the drunk orchestra)");
      } catch (e) {
        console.error(e);
        this.ctx.log("self-test error: " + e.message);
        this._stage("self-test error");
      } finally {
        this._busy = false;
        this.player = null;
      }
    }
  };

  /* calibrated in headless tests: low enough that bare notes slur,
     high enough that the Viterbi-armoured skeleton stands */
  const DRUNK_SNR = -4;

  const HOST = (typeof HRWS !== "undefined" && HRWS)
    || (typeof window !== "undefined" ? window.HRWS : null);
  if (HOST) HOST.registerModule(def);

  /* headless test hook */
  window.__M1_TEST__ = {
    TONES, BAUD, SYNCSEQ, TX_FS, NOTE_BYTES, TICK_S, MAX_NOTES_PKT, GUARD_S, SEG_OPTS,
    PKT_END, PKT_MHDR, PKT_MNOTES_RAW, PKT_MNOTES_FEC, MAGIC0, MAGIC1, DRUNK_SNR,
    clamp, crc32, crc16, BitWriter, BitReader,
    convEncode, viterbiDecode, interleave, deinterleave, bytesToBits, bitsToBytes,
    codeSection, rawSection, sectionSyms, rawSectionSyms,
    buildPacketTones, packetSymCount,
    packNotes, unpackNotes, buildMhdr, parseMhdr, notesSeq, notesSeqParse,
    parseMidi, writeMidi, makeDemoScore, segmentScore, segAirSyms, segCapacity,
    ToneRun, buildSongAudio, ConcertRx, StreamRX, progFamily, drawSpectrogram, drawRoll,
    channelSimulate, fftBandpass, makeBiquad, wavEncode16, wavDecodeMono
  };
})();
