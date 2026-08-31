/* ============================================================
   Ham Radio Web Studio — "QAM File Link" module
   A one-way FILE TRANSFER modem: a JavaScript port of the DSP
   core of VA3JFL's "audiomodem" (Python, DMT-48) with the
   duplex/ARQ/IP layers removed and a simplex file protocol +
   callsign beacon put in their place.

   Physical layer (faithful to the Python original):
     DMT/OFDM   real-valued multicarrier via Hermitian-symmetric
                IFFT + cyclic prefix (ADSL-style), per-bin
                least-squares equalization from preamble B
     frame      [preamble A][preamble B][header sym][data ...][guard]
                A: energy on even bins only -> two identical time
                   halves; Schmidl & Cox autocorrelation finds it,
                   cross-correlation against the known waveform
                   refines timing; the two halves also yield an
                   SNR estimate and (new here) the carrier
                   frequency offset of a mistuned SSB rig
                B: PN-QPSK on every used bin -> channel estimate
     header     QPSK, 12 bytes + CRC-16, 3x bit repetition,
                majority vote
     pilots     every 8th used bin; each data symbol's pilots give
                common-phase + phase-slope (timing drift) which a
                closed-loop fractional resampler nulls out (SFO)
     QAM        Gray square constellations: QPSK / 16 / 64 / 256 /
                1024 / 4096-QAM
     FEC        Reed-Solomon RS(255,223) over GF(2^8), codewords
                column-interleaved; payload scrambled; CRC-32
     MPX        alternate low/high subband bin fill (frequency
                diversity) with per-subband SNR metering
     bonding    stereo: two independent lanes (L/R) striped with
                alternate file segments — for direct-wire links

   Link layer (new, simplex):
     BEACON     short frame carrying the sender's callsign. The RX
                side arms, locks, and reads callsign + SNR + drift
                + CFO; the ops confirm on voice ("locked — send
                it!") and the sender presses SEND. Beacons also
                pre-train the receiver's SFO loop.
     META       file name, size, CRC-32, segment plan, passes
     DATA       [u16 segment index][bytes] — each segment fills
                one OFDM frame; repeat passes fill anything lost
     EOF        end of a pass; RX reports missing segments

   Profiles:
     "HF SSB 2.4 kHz"  400–2600 Hz, nfft 1024, cp 4 ms — fits a
                       normal ham SSB channel (the whole point)
     "Wide audio"      300–18000 Hz, nfft 512 — direct cable, FM
                       wideband gear, links between laptops
     "Ultra 96/192k"   experimental wideband for direct wire and
                       consumer 24-bit interfaces (WAV/loopback)

   Both ends need this studio. Identify per your regulations.
   ============================================================ */
"use strict";

(function () {

  /* ---------------- constants ---------------- */
  const MAGIC = 0xA7, VERSION = 1;
  const FT_DATA = 0, FT_BEACON = 2, FT_META = 3, FT_EOF = 4;
  const FT_NAMES = { 0: "DATA", 2: "BEACON", 3: "META", 4: "EOF" };

  const MODES = ["qpsk", "16qam", "64qam", "256qam", "1024qam", "4096qam"];
  const MODE_BITS = { qpsk: 2, "16qam": 4, "64qam": 6,
                      "256qam": 8, "1024qam": 10, "4096qam": 12 };
  const MODE_ID = {}; MODES.forEach((m, i) => MODE_ID[m] = i);
  const ID_MODE = {}; MODES.forEach((m, i) => ID_MODE[i] = m);

  /* rough SNR (dB) each constellation wants — shown next to the RX
     beacon lock so the ops can pick a mode over voice */
  const MODE_NEEDS = { qpsk: 12, "16qam": 19, "64qam": 26,
                       "256qam": 33, "1024qam": 40, "4096qam": 47 };

  const PROFILES = {
    ssbn: {
      label: "SSB narrow 500 Hz (CW filter)", fs: 48000, nfft: 2048, cp: 384,
      f_lo: 400, f_hi: 900, guard: 480, maxDataSyms: 108,
      modes: ["qpsk", "16qam"], bond: false,
      note: "weak-signal experiments through a 500 Hz filter \u2014 slow but tenacious"
    },
    ssb: {
      label: "HF SSB 2.4 kHz", fs: 48000, nfft: 1024, cp: 192,
      f_lo: 400, f_hi: 2600, guard: 480, maxDataSyms: 72,
      modes: ["qpsk", "16qam", "64qam", "256qam"], bond: false,
      note: "fits a normal SSB voice channel; carrier-offset search for mistuned rigs"
    },
    fmn: {
      label: "FM voice 3 kHz (2 m / 70 cm)", fs: 48000, nfft: 1024, cp: 96,
      f_lo: 300, f_hi: 3000, guard: 480, maxDataSyms: 72,
      modes: ["qpsk", "16qam", "64qam", "256qam"], bond: false,
      note: "mic/speaker path of any NBFM rig \u2014 HTs and mobiles; full-quieting supports 64-QAM"
    },
    fmm: {
      label: "FM data 6.5 kHz (9k6 jack)", fs: 48000, nfft: 512, cp: 64,
      f_lo: 300, f_hi: 6500, guard: 288, maxDataSyms: 64,
      modes: ["qpsk", "16qam", "64qam", "256qam", "1024qam"], bond: false,
      note: "flat discriminator / packet-radio data jack of an FM rig"
    },
    fmw: {
      label: "FM flat 10 kHz (link radios)", fs: 48000, nfft: 512, cp: 64,
      f_lo: 300, f_hi: 10000, guard: 288, maxDataSyms: 64,
      modes: ["qpsk", "16qam", "64qam", "256qam", "1024qam"], bond: false,
      note: "flat-audio FM link transceivers and wider data jacks \u2014 the VHF/UHF speed rung between the 9k6 port and WBFM"
    },
    wbfm: {
      label: "WBFM 15 kHz", fs: 48000, nfft: 512, cp: 64,
      f_lo: 300, f_hi: 15000, guard: 288, maxDataSyms: 48,
      modes: ["qpsk", "16qam", "64qam", "256qam", "1024qam"], bond: false,
      note: "wideband FM links \u2014 broadcast-style audio bandwidth"
    },
    cable: {
      label: "Cable 18 kHz (stereo)", fs: 48000, nfft: 512, cp: 64,
      f_lo: 300, f_hi: 18000, guard: 288, maxDataSyms: 48,
      modes: ["qpsk", "16qam", "64qam", "256qam", "1024qam", "4096qam"],
      bond: true,
      note: "direct wire between soundcards at 48 k; stereo bonding doubles throughput"
    },
    full48: {
      label: "Full audio 21 kHz (mono)", fs: 48000, nfft: 512, cp: 64,
      f_lo: 300, f_hi: 21000, guard: 288, maxDataSyms: 48,
      modes: ["qpsk", "16qam", "64qam", "256qam", "1024qam", "4096qam"], bond: false,
      note: "everything a 48 k soundcard carries in one channel \u2014 mono wire, FM-ATV sound subcarriers, video senders"
    },
    uwave: {
      label: "Microwave FM 40 kHz", fs: 96000, nfft: 512, cp: 64,
      f_lo: 300, f_hi: 40000, guard: 576, maxDataSyms: 96,
      modes: ["qpsk", "16qam", "64qam", "256qam", "1024qam", "4096qam"], bond: false,
      note: "wide-baseband FM gear on the microwave bands (10 GHz ATV-style links) \u2014 needs a 96 k device for live use"
    },
    hifi: {
      label: "HiFi 96 kHz (stereo)", fs: 96000, nfft: 512, cp: 64,
      f_lo: 3000, f_hi: 43680, guard: 576, maxDataSyms: 96,
      modes: ["qpsk", "16qam", "64qam", "256qam", "1024qam", "4096qam"],
      bond: true,
      note: "consumer interfaces that do 96 k but not 192 k \u2014 direct wire (WAV / loopback if the browser runs at 48 k)"
    },
    sdr80: {
      label: "SDR / IF 80 kHz (mono)", fs: 192000, nfft: 512, cp: 64,
      f_lo: 300, f_hi: 80000, guard: 1152, maxDataSyms: 96,
      modes: ["qpsk", "16qam", "64qam", "256qam", "1024qam", "4096qam"], bond: false,
      note: "a mono 192 k pipe into an SDR or IF port \u2014 WAV / loopback unless the browser runs a 192 k context"
    },
    ultra: {
      label: "Ultra 192 kHz (stereo)", fs: 192000, nfft: 512, cp: 64,
      f_lo: 3000, f_hi: 87360, guard: 1152, maxDataSyms: 96,
      modes: ["qpsk", "16qam", "64qam", "256qam", "1024qam", "4096qam"],
      bond: true,
      note: "experimental \u2014 direct wire + 24-bit consumer interfaces (WAV / loopback)"
    }
  };

  /* ---------------- small utilities ---------------- */
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function tick() { return new Promise(r => setTimeout(r, 0)); }

  /* deterministic PRNG (shared tables must match TX<->RX in JS only —
     no cross-compat with the Python needed, so an LCG is fine) */
  function makeLcg(seed) {
    let s = (seed | 0) || 1;
    return () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x80000000;
    };
  }

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
  function crc16(bytes, n) {                       // CCITT-FALSE
    let c = 0xFFFF;
    const m = n === undefined ? bytes.length : n;
    for (let i = 0; i < m; i++) {
      c ^= bytes[i] << 8;
      for (let k = 0; k < 8; k++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF;
    }
    return c;
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

  /* PN bit + scramble tables (deterministic, seeded) */
  const PN_BITS = (() => {
    const rnd = makeLcg(0xB175);
    const t = new Uint8Array(1 << 16);
    for (let i = 0; i < t.length; i++) t[i] = rnd() < 0.5 ? 0 : 1;
    return t;
  })();
  function pnBits(n, offset) {
    const out = new Uint8Array(n);
    const off = offset || 0;
    for (let i = 0; i < n; i++) out[i] = PN_BITS[(i + off) & 0xFFFF];
    return out;
  }
  const SCRAMBLE_TAB = (() => {
    const rnd = makeLcg(0x5C2A);
    const t = new Uint8Array(1 << 16);
    for (let i = 0; i < t.length; i++) t[i] = Math.floor(rnd() * 256) & 0xFF;
    return t;
  })();
  function scramble(bytes, offset) {
    const out = new Uint8Array(bytes.length);
    const off = offset || 0;
    for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ SCRAMBLE_TAB[(i + off) & 0xFFFF];
    return out;
  }
  const PAD_BYTES = (() => {
    const rnd = makeLcg(0xC0DE);
    const t = new Uint8Array(1 << 14);
    for (let i = 0; i < t.length; i++) t[i] = Math.floor(rnd() * 256) & 0xFF;
    return t;
  })();

  /* radix-2 complex FFT (shared across the studio's modules) */
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

  /* =====================================================================
     Gray-coded square QAM, unit average power (port of dsp.QAM)
     ===================================================================== */
  class QAM {
    constructor(bitsPerSym) {
      this.bps = bitsPerSym;
      this.axisBits = bitsPerSym >> 1;
      const m = 1 << this.axisBits;
      this.gray = new Int32Array(m);
      this.grayInv = new Int32Array(m);
      for (let i = 0; i < m; i++) this.gray[i] = i ^ (i >> 1);
      for (let i = 0; i < m; i++) this.grayInv[this.gray[i]] = i;
      const lv = new Float64Array(m);
      let p = 0;
      for (let i = 0; i < m; i++) { lv[i] = 2 * i - (m - 1); p += lv[i] * lv[i]; }
      this.norm = Math.sqrt((p / m) * 2);
      this.levels = new Float64Array(m);
      for (let i = 0; i < m; i++) this.levels[i] = lv[i] / this.norm;
      this.m = m;
    }
    map(bits, outRe, outIm) {
      /* bits length = n * bps -> n symbols into outRe/outIm */
      const n = bits.length / this.bps;
      const h = this.axisBits;
      for (let s = 0; s < n; s++) {
        let iIdx = 0, qIdx = 0;
        const base = s * this.bps;
        for (let b = 0; b < h; b++) iIdx = (iIdx << 1) | bits[base + b];
        for (let b = 0; b < h; b++) qIdx = (qIdx << 1) | bits[base + h + b];
        outRe[s] = this.levels[this.grayInv[iIdx]];
        outIm[s] = this.levels[this.grayInv[qIdx]];
      }
    }
    demap(re, im, n, outBits) {
      const h = this.axisBits, m = this.m;
      for (let s = 0; s < n; s++) {
        let vi = Math.round((re[s] * this.norm + (m - 1)) / 2);
        let vq = Math.round((im[s] * this.norm + (m - 1)) / 2);
        vi = clamp(vi, 0, m - 1); vq = clamp(vq, 0, m - 1);
        const gi = this.gray[vi], gq = this.gray[vq];
        const base = s * this.bps;
        for (let b = 0; b < h; b++) {
          outBits[base + b] = (gi >> (h - 1 - b)) & 1;
          outBits[base + h + b] = (gq >> (h - 1 - b)) & 1;
        }
      }
    }
    hard(re, im, n, outRe, outIm) {
      const m = this.m;
      for (let s = 0; s < n; s++) {
        let vi = clamp(Math.round((re[s] * this.norm + (m - 1)) / 2), 0, m - 1);
        let vq = clamp(Math.round((im[s] * this.norm + (m - 1)) / 2), 0, m - 1);
        outRe[s] = this.levels[vi];
        outIm[s] = this.levels[vq];
      }
    }
  }

  /* =====================================================================
     StreamResampler — continuous-state fractional resampler.
     Polyphase zero-stuff upsample (FFT overlap-save FIR) + 6-point
     windowed-sinc fractional reader. `ratio` maps input rate to the
     modem's nominal rate; `ppm` on top is steered by the SFO loop.
     Port of dsp.StreamResampler with a rate-conversion extension.
     ===================================================================== */
  class StreamResampler {
    constructor(fs, fPass, attenDb) {
      attenDb = attenDb || 75.0;
      const up = this.UP = fs >= 96000 ? 8 : 4;
      const fp = fPass / (up * fs);
      let fst = (fs - fPass) / (up * fs);
      fst = Math.max(fst, fp + 0.002);
      const width = fst - fp;
      let ntaps = Math.ceil((attenDb - 8) / (2.285 * 2 * Math.PI * width));
      ntaps = Math.min(Math.max(ntaps | 1, 31), 1023);
      const fc = (fp + fst) / 2.0;
      const beta = attenDb > 50 ? 0.1102 * (attenDb - 8.7) : 5.0;
      const h = new Float64Array(ntaps);
      const mid = (ntaps - 1) / 2;
      let hsum = 0;
      const i0b = besselI0(beta);
      for (let i = 0; i < ntaps; i++) {
        const x = i - mid;
        const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
        const r = 2 * i / (ntaps - 1) - 1;
        const win = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0b;
        h[i] = sinc * win;
        hsum += h[i];
      }
      for (let i = 0; i < ntaps; i++) h[i] = h[i] / hsum * up;
      this.h = h;
      this.ntaps = ntaps;
      /* overlap-save state */
      this.nfftOS = 1 << Math.ceil(Math.log2(4 * ntaps));
      this.Hre = new Float64Array(this.nfftOS);
      this.Him = new Float64Array(this.nfftOS);
      for (let i = 0; i < ntaps; i++) this.Hre[i] = h[i];
      fft(this.Hre, this.Him, false);
      this.zi = new Float64Array(ntaps - 1);
      this.hist = new Float64Array(0);
      this.t = 2.0;
      this.ppm = 0.0;
      this.ratio = 1.0;           // fs_in / fs_nominal
      this._sre = new Float64Array(this.nfftOS);
      this._sim = new Float64Array(this.nfftOS);
    }

    _upN(x) {
      const up = this.UP, nh = this.ntaps;
      const z = new Float64Array(up * x.length);
      for (let i = 0; i < x.length; i++) z[i * up] = x[i];
      const buf = new Float64Array(this.zi.length + z.length);
      buf.set(this.zi); buf.set(z, this.zi.length);
      const step = this.nfftOS - (nh - 1);
      const outLen = Math.max(0, buf.length - (nh - 1));
      const out = new Float64Array(outLen);
      let pos = 0;
      while (pos + nh - 1 < buf.length) {
        const sre = this._sre, sim = this._sim;
        sre.fill(0); sim.fill(0);
        const avail = Math.min(this.nfftOS, buf.length - pos);
        for (let i = 0; i < avail; i++) sre[i] = buf[pos + i];
        fft(sre, sim, false);
        for (let k = 0; k < this.nfftOS; k++) {
          const r = sre[k] * this.Hre[k] - sim[k] * this.Him[k];
          sim[k] = sre[k] * this.Him[k] + sim[k] * this.Hre[k];
          sre[k] = r;
        }
        fft(sre, sim, true);
        const valid = Math.min(step, buf.length - (nh - 1) - pos);
        for (let i = 0; i < valid; i++) out[pos + i] = sre[nh - 1 + i];
        pos += valid;
      }
      this.zi = buf.slice(buf.length - (nh - 1));
      return out;
    }

    process(x) {
      if (!x.length) return new Float64Array(0);
      const up = this._upN(x);
      const merged = new Float64Array(this.hist.length + up.length);
      merged.set(this.hist); merged.set(up, this.hist.length);
      this.hist = merged;
      const step = this.UP * this.ratio * (1.0 + this.ppm * 1e-6);
      const limit = this.hist.length - 3.0;
      if (this.t >= limit) return new Float64Array(0);
      const m = Math.floor((limit - this.t) / step) + 1;
      const out = new Float64Array(m);
      let cnt = 0, tt = this.t;
      for (let s = 0; s < m; s++, tt = this.t + step * (s)) {
        tt = this.t + step * s;
        if (tt >= limit) break;
        const i = Math.floor(tt);
        const f = tt - i;
        let y = 0, wsum = 0;
        for (let j = -2; j <= 3; j++) {
          const d = j - f;
          const w = (d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d)) *
                    Math.cos(Math.PI * d / 6.0) ** 2;
          y += w * this.hist[i + j];
          wsum += w;
        }
        out[cnt++] = y / wsum;
      }
      const tNext = this.t + step * cnt;
      const consumed = Math.min(Math.max(Math.floor(tNext) - 2, 0), this.hist.length);
      this.hist = this.hist.slice(consumed);
      this.t = tNext - consumed;
      return cnt === out.length ? out : out.slice(0, cnt);
    }
  }
  function besselI0(x) {
    let s = 1, t = 1;
    for (let k = 1; k < 32; k++) {
      t *= (x / (2 * k)) * (x / (2 * k));
      s += t;
      if (t < 1e-12 * s) break;
    }
    return s;
  }

  /* ---------------- WAV (stereo-capable) ---------------- */
  function wavEncode16(chans, rate) {
    const nch = chans.length, n = chans[0].length;
    const dataSz = n * 2 * nch;
    const buf = new ArrayBuffer(44 + dataSz);
    const dv = new DataView(buf);
    const ws = (p, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(p + i, s.charCodeAt(i)); };
    ws(0, "RIFF"); dv.setUint32(4, 36 + dataSz, true); ws(8, "WAVE");
    ws(12, "fmt "); dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); dv.setUint16(22, nch, true);
    dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2 * nch, true);
    dv.setUint16(32, 2 * nch, true); dv.setUint16(34, 16, true);
    ws(36, "data"); dv.setUint32(40, dataSz, true);
    let p = 44;
    for (let i = 0; i < n; i++)
      for (let c = 0; c < nch; c++) {
        dv.setInt16(p, Math.round(clamp(chans[c][i], -1, 1) * 32767), true);
        p += 2;
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
    const chans = [];
    for (let c = 0; c < Math.min(nch, 2); c++) chans.push(new Float32Array(n));
    let p = data.off;
    for (let i = 0; i < n; i++)
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
        if (c < 2) chans[c][i] = v;
        p += bytes;
      }
    return { rate: fmt.rate, bits, nch, chans };
  }

  /* ---------------- channel simulation (per lane) ----------------
     codec-style FIR lowpass + AC-coupling highpass + gain + AWGN +
     optional clock skew via the same StreamResampler the RX uses
     (mirrors selftest.StreamChannel). For the SSB profile a bandpass
     restricted to the voice channel stands in for the rig's filter. */
  class StreamChannel {
    constructor(fs, opts) {
      const o = opts || {};
      this.fs = fs;
      this.snrDb = o.snrDb === undefined ? null : o.snrDb;
      this.gain = o.gain === undefined ? 0.5 : o.gain;
      this.rnd = makeLcg(o.seed || 1);
      const fHi = o.fHi || 0.475 * fs;
      const fLo = o.fLo === undefined ? 120.0 : o.fLo;
      /* FIR lowpass (short, codec-like) */
      const nt = fs >= 96000 ? 201 : 121;
      this.h = new Float64Array(nt);
      const mid = (nt - 1) / 2;
      let hs = 0;
      for (let i = 0; i < nt; i++) {
        const x = i - mid;
        const s = x === 0 ? 2 * fHi / fs : Math.sin(2 * Math.PI * fHi / fs * x) / (Math.PI * x);
        const r = 2 * i / (nt - 1) - 1;
        this.h[i] = s * besselI0(6.0 * Math.sqrt(Math.max(0, 1 - r * r))) / besselI0(6.0);
        hs += this.h[i];
      }
      for (let i = 0; i < nt; i++) this.h[i] /= hs;
      this.zi = new Float64Array(nt - 1);
      this.hpA = Math.exp(-2 * Math.PI * fLo / fs);
      this.hpX1 = 0; this.hpY1 = 0;
      this.rs = o.ppm ? new StreamResampler(fs, fHi * 1.02) : null;
      if (this.rs) this.rs.ppm = o.ppm;
      this.sigP = (0.13 * this.gain) ** 2;         // nominal in-frame power
    }
    _gauss() {
      const u1 = Math.max(this.rnd(), 1e-12), u2 = this.rnd();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    }
    process(x) {
      let y = Float64Array.from(x);
      if (this.rs) y = this.rs.process(y);
      /* AC coupling highpass */
      const a = this.hpA;
      let x1 = this.hpX1, y1 = this.hpY1;
      for (let i = 0; i < y.length; i++) {
        const yy = a * (y1 + y[i] - x1);
        x1 = y[i]; y[i] = yy; y1 = yy;
      }
      this.hpX1 = x1; this.hpY1 = y1;
      /* FIR lowpass with state */
      const nh = this.h.length;
      const buf = new Float64Array(this.zi.length + y.length);
      buf.set(this.zi); buf.set(y, this.zi.length);
      const out = new Float64Array(y.length);
      for (let i = 0; i < y.length; i++) {
        let s = 0;
        for (let j = 0; j < nh; j++) s += buf[i + j] * this.h[nh - 1 - j];
        out[i] = s * this.gain;
      }
      this.zi = buf.slice(buf.length - (nh - 1));
      if (this.snrDb !== null && out.length) {
        const nP = Math.sqrt(this.sigP / Math.pow(10, this.snrDb / 10));
        for (let i = 0; i < out.length; i++) out[i] += this._gauss() * nP;
      }
      return out;
    }
  }

  /* =====================================================================
     Reed-Solomon RS(255,223) over GF(2^8), generator 0x11D — a direct
     port of fec.py (Berlekamp-Massey + Chien + Forney). Codewords are
     column-interleaved so a burst spreads across many codewords.
     ===================================================================== */
  const RS_N = 255, RS_K = 223, RS_T = 16;
  const GF_EXP = new Int32Array(512);
  const GF_LOG = new Int32Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11D;
    }
    for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
  })();
  function gfMul(a, b) { return (a === 0 || b === 0) ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]; }
  function gfInv(a) { return GF_EXP[255 - GF_LOG[a]]; }
  function gfPow(a, p) { return a === 0 ? 0 : GF_EXP[((GF_LOG[a] * p) % 255 + 255) % 255]; }

  const RS_GEN = (() => {                 // generator poly, without leading 1
    let g = [1];
    for (let i = 0; i < RS_N - RS_K; i++) {
      const q = [1, gfPow(2, i)];
      const r = new Array(g.length + 1).fill(0);
      for (let a = 0; a < g.length; a++)
        for (let b = 0; b < 2; b++)
          r[a + b] ^= gfMul(g[a], q[b]);
      g = r;
    }
    return Int32Array.from(g.slice(1));
  })();

  function rsEncodeBlock(data, out) {     // data: 223 bytes -> out: 255 bytes
    const par = new Int32Array(RS_N - RS_K);
    for (let i = 0; i < RS_K; i++) {
      const fb = data[i] ^ par[0];
      par.copyWithin(0, 1);
      par[RS_N - RS_K - 1] = 0;
      if (fb) {
        const lf = GF_LOG[fb];
        for (let j = 0; j < RS_GEN.length; j++)
          if (RS_GEN[j]) par[j] ^= GF_EXP[GF_LOG[RS_GEN[j]] + lf];
      }
    }
    out.set(data.subarray(0, RS_K), 0);
    for (let j = 0; j < RS_N - RS_K; j++) out[RS_K + j] = par[j];
  }

  function rsDecodeBlock(code) {          // 255 bytes -> {data|null, nerr}
    const c = Int32Array.from(code);
    const synd = new Int32Array(2 * RS_T);
    let any = 0;
    for (let i = 0; i < 2 * RS_T; i++) {
      let s = 0;
      for (let j = 0; j < RS_N; j++) {
        if (!c[j]) continue;
        s ^= GF_EXP[(GF_LOG[c[j]] + (RS_N - 1 - j) * i) % 255];
      }
      synd[i] = s;
      any |= s;
    }
    if (!any) return { data: code.slice(0, RS_K), nerr: 0 };

    /* Berlekamp-Massey */
    let sigma = [1], prev = [1], L = 0, m = 1, b = 1;
    for (let n = 0; n < 2 * RS_T; n++) {
      let d = synd[n];
      for (let i = 1; i <= L; i++)
        d ^= gfMul(i < sigma.length ? sigma[i] : 0, synd[n - i]);
      if (d === 0) { m++; continue; }
      const coef = gfMul(d, gfInv(b));
      const shifted = new Array(m).fill(0).concat(prev);
      const ext = Math.max(sigma.length, shifted.length);
      const ns = new Array(ext).fill(0);
      for (let i = 0; i < ext; i++) {
        const a = i < sigma.length ? sigma[i] : 0;
        const cc = i < shifted.length ? gfMul(coef, shifted[i]) : 0;
        ns[i] = a ^ cc;
      }
      if (2 * L <= n) {
        prev = sigma; sigma = ns;
        L = n + 1 - L; b = d; m = 1;
      } else {
        sigma = ns; m++;
      }
    }
    const nerr = L;
    if (nerr > RS_T) return { data: null, nerr: -1 };

    /* Chien search */
    const errPos = [];
    const sigRev = sigma.slice().reverse();
    for (let j = 0; j < RS_N; j++) {
      const deg = RS_N - 1 - j;
      const x = GF_EXP[(255 - (deg % 255)) % 255];
      let y = sigRev[0];
      for (let k = 1; k < sigRev.length; k++) y = gfMul(y, x) ^ sigRev[k];
      if (y === 0) errPos.push(j);
    }
    if (errPos.length !== nerr) return { data: null, nerr: -1 };

    /* Forney (fcr = 0 convention) */
    const omega = new Array(2 * RS_T).fill(0);
    for (let i = 0; i < 2 * RS_T; i++) {
      if (!synd[i]) continue;
      for (let k = 0; k < sigma.length; k++)
        if (k + i < 2 * RS_T && sigma[k]) omega[i + k] ^= gfMul(synd[i], sigma[k]);
    }
    const dsig = new Array(Math.max(1, sigma.length - 1)).fill(0);
    for (let i = 1; i < sigma.length; i += 2) dsig[i - 1] = sigma[i];
    for (const j of errPos) {
      const deg = RS_N - 1 - j;
      const xinv = GF_EXP[(255 - (deg % 255)) % 255];
      let num = 0, xp = 1;
      for (const co of omega) {
        if (co) num ^= gfMul(co, xp);
        xp = gfMul(xp, xinv);
      }
      let den = 0; xp = 1;
      for (const co of dsig) {
        if (co) den ^= gfMul(co, xp);
        xp = gfMul(xp, xinv);
      }
      if (den === 0) return { data: null, nerr: -1 };
      let q = 0;
      if (num) q = GF_EXP[((GF_LOG[num] - GF_LOG[den]) % 255 + 255) % 255];
      const mag = gfMul(q, GF_EXP[deg % 255]);
      c[j] ^= mag;
    }
    /* verify */
    for (let i = 0; i < 2 * RS_T; i++) {
      let s = 0;
      for (let j = 0; j < RS_N; j++) {
        if (!c[j]) continue;
        s ^= GF_EXP[(GF_LOG[c[j]] + (RS_N - 1 - j) * i) % 255];
      }
      if (s !== 0) return { data: null, nerr: -1 };
    }
    return { data: Uint8Array.from(c.subarray(0, RS_K)), nerr };
  }

  function nCodewords(len) { return Math.max(1, Math.ceil(len / RS_K)); }
  function fecEncode(payload) {
    const ncw = nCodewords(payload.length);
    const buf = new Uint8Array(ncw * RS_K);
    buf.set(payload);
    buf.set(PAD_BYTES.subarray(0, ncw * RS_K - payload.length), payload.length);
    const out = new Uint8Array(ncw * RS_N);
    const cw = new Uint8Array(RS_N);
    for (let i = 0; i < ncw; i++) {
      rsEncodeBlock(buf.subarray(i * RS_K, (i + 1) * RS_K), cw);
      for (let b = 0; b < RS_N; b++) out[b * ncw + i] = cw[b];   // column interleave
    }
    return out;
  }
  function fecDecode(stream, payloadLen) {
    const ncw = nCodewords(payloadLen);
    if (stream.length < ncw * RS_N) return { data: null, corrected: -1 };
    const cw = new Uint8Array(RS_N);
    const out = new Uint8Array(ncw * RS_K);
    let total = 0;
    for (let i = 0; i < ncw; i++) {
      for (let b = 0; b < RS_N; b++) cw[b] = stream[b * ncw + i];
      const r = rsDecodeBlock(cw);
      if (r.data === null) return { data: null, corrected: -1 };
      out.set(r.data, i * RS_K);
      total += r.nerr;
    }
    return { data: out.subarray(0, payloadLen), corrected: total };
  }
  function codedLen(len, fec) { return fec ? nCodewords(len) * RS_N : len; }
  function maxPayloadForCoded(cap, fec) {
    return fec ? Math.floor(cap / RS_N) * RS_K : cap;
  }

  /* =====================================================================
     OFDM core (port of dsp.OFDM). One extension vs the Python: on the
     narrow SSB profile the 288-bit header doesn't fit one QPSK symbol,
     so the header may span several symbols (nHdrSyms).
     ===================================================================== */
  class OFDM {
    constructor(cfg) {
      this.cfg = cfg;
      const n = cfg.nfft, fs = cfg.fs;
      const kLo = Math.ceil(cfg.f_lo * n / fs);
      const kHi = Math.min(Math.floor(cfg.f_hi * n / fs), (n >> 1) - 1);
      this.used = new Int32Array(kHi - kLo + 1);
      for (let i = 0; i < this.used.length; i++) this.used[i] = kLo + i;
      this.nUsed = this.used.length;
      const npil = Math.ceil(this.nUsed / cfg.pilot_step);
      this.pilotPos = new Int32Array(npil);
      for (let i = 0; i < npil; i++) this.pilotPos[i] = i * cfg.pilot_step;
      const mask = new Uint8Array(this.nUsed).fill(1);
      for (const p of this.pilotPos) mask[p] = 0;
      const dp = [];
      for (let i = 0; i < this.nUsed; i++) if (mask[i]) dp.push(i);
      this.dataPos = Int32Array.from(dp);
      this.nData = dp.length;
      this.sym = n + cfg.cp;

      /* MPX fill order: alternate low/high subband */
      const half = this.nData >> 1;
      const inter = new Int32Array(this.nData);
      for (let i = 0; i < half; i++) {
        inter[2 * i] = this.dataPos[i];
        inter[2 * i + 1] = this.dataPos[half + i];
      }
      if (this.nData & 1) inter[this.nData - 1] = this.dataPos[this.nData - 1];
      this.dataPosMpx = inter;
      const kMid = (kLo + kHi) >> 1;
      this.mpxLoMask = new Uint8Array(this.nData);
      for (let i = 0; i < this.nData; i++)
        this.mpxLoMask[i] = this.used[this.dataPos[i]] < kMid ? 1 : 0;

      const rnd = makeLcg(0x0FD1);
      const qpsk = new QAM(2);
      /* preamble A: BPSK on even used bins */
      const evens = [];
      for (let i = 0; i < this.nUsed; i++) if ((this.used[i] & 1) === 0) evens.push(i);
      this.evenPos = Int32Array.from(evens);
      this.preARe = new Float64Array(this.nUsed);
      this.preAIm = new Float64Array(this.nUsed);
      for (const e of this.evenPos)
        this.preARe[e] = (rnd() < 0.5 ? -1 : 1) * Math.SQRT2;
      /* preamble B: PN QPSK on all used bins */
      const pbBits = new Uint8Array(this.nUsed * 2);
      for (let i = 0; i < pbBits.length; i++) pbBits[i] = rnd() < 0.5 ? 0 : 1;
      this.preBRe = new Float64Array(this.nUsed);
      this.preBIm = new Float64Array(this.nUsed);
      qpsk.map(pbBits, this.preBRe, this.preBIm);
      /* pilot PN table, 16 patterns */
      this.nPil = npil;
      this.pilotTabRe = [];
      this.pilotTabIm = [];
      for (let t = 0; t < 16; t++) {
        const bb = new Uint8Array(npil * 2);
        for (let i = 0; i < bb.length; i++) bb[i] = rnd() < 0.5 ? 0 : 1;
        const re = new Float64Array(npil), im = new Float64Array(npil);
        qpsk.map(bb, re, im);
        this.pilotTabRe.push(re);
        this.pilotTabIm.push(im);
      }
      this.qams = {};
      for (const m of MODES) if (!this.qams[MODE_BITS[m]]) this.qams[MODE_BITS[m]] = new QAM(MODE_BITS[m]);

      /* fixed TX gain from a probe symbol */
      const probe = this._ifftSym(this.preBRe, this.preBIm);
      let s = 0;
      for (let i = 0; i < probe.length; i++) s += probe[i] * probe[i];
      const std = Math.sqrt(s / probe.length);
      this.gain = cfg.tx_rms / Math.max(std, 1e-9);
      this.preAWave = this._mod(this.preARe, this.preAIm);
      this.preBWave = this._mod(this.preBRe, this.preBIm);
      this.preACore = this.preAWave.slice(cfg.cp);
      /* quadrature (Hilbert) twin of the A core: same tones rotated
         -90 deg (V -> -jV). A complex matched filter |C| built from the
         pair is carrier-phase and CFO invariant — a real-only template
         scales by |cos(phase)| and lets the half-symbol sidelobe win
         on unlucky phases. */
      {
        const qIm = new Float64Array(this.nUsed);
        for (let i = 0; i < this.nUsed; i++) qIm[i] = -this.preARe[i];
        const q = this._ifftSym(this.preAIm, qIm);
        this.preACoreQ = new Float64Array(n);
        for (let i = 0; i < n; i++) this.preACoreQ[i] = q[i] * this.gain;
      }

      /* header may span several QPSK symbols (narrow profiles) */
      this.hdrSymBits = this.nData * 2;
      this.nHdrSyms = Math.max(1, Math.ceil((HDR_BITS * HDR_REP) / this.hdrSymBits));
      this._fftRe = new Float64Array(n);
      this._fftIm = new Float64Array(n);
    }

    _ifftSym(valsRe, valsIm) {
      const n = this.cfg.nfft;
      const re = new Float64Array(n), im = new Float64Array(n);
      for (let i = 0; i < this.nUsed; i++) {
        const k = this.used[i];
        re[k] = valsRe[i]; im[k] = valsIm[i];
        re[n - k] = valsRe[i]; im[n - k] = -valsIm[i];
      }
      fft(re, im, true);
      const sc = n / Math.sqrt(this.nUsed * 2);
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) out[i] = re[i] * sc;
      return out;
    }
    _mod(valsRe, valsIm) {
      const x = this._ifftSym(valsRe, valsIm);
      const cp = this.cfg.cp;
      const out = new Float64Array(cp + x.length);
      out.set(x.subarray(x.length - cp), 0);
      out.set(x, cp);
      for (let i = 0; i < out.length; i++) out[i] *= this.gain;
      return out;
    }

    /* FFT of one received symbol with optional CFO derotation.
       cfoHz shifts a mistuned SSB signal back onto the bin grid: the
       real samples are rotated by e^{-j2pi*cfo*n/fs} (n = absolute
       sample index so the rotation stays coherent across symbols;
       pilots absorb the constant phase). */
    fftBins(buf, s0, cfoHz, outRe, outIm) {
      const n = this.cfg.nfft, fs = this.cfg.fs;
      const re = this._fftRe, im = this._fftIm;
      if (cfoHz) {
        const w = -2 * Math.PI * cfoHz / fs;
        for (let i = 0; i < n; i++) {
          const ph = w * (s0 + i);
          const x = buf[s0 + i];
          re[i] = x * Math.cos(ph);
          im[i] = x * Math.sin(ph);
        }
      } else {
        for (let i = 0; i < n; i++) { re[i] = buf[s0 + i]; im[i] = 0; }
      }
      fft(re, im, false);
      for (let i = 0; i < this.nUsed; i++) {
        outRe[i] = re[this.used[i]];
        outIm[i] = im[this.used[i]];
      }
    }

    symVals(symIdx, dataRe, dataIm, nSyms, mpx, outRe, outIm) {
      outRe.fill(0); outIm.fill(0);
      const pt = symIdx & 15;
      for (let i = 0; i < this.nPil; i++) {
        outRe[this.pilotPos[i]] = this.pilotTabRe[pt][i];
        outIm[this.pilotPos[i]] = this.pilotTabIm[pt][i];
      }
      const pos = mpx ? this.dataPosMpx : this.dataPos;
      for (let i = 0; i < nSyms; i++) {
        outRe[pos[i]] = dataRe[i];
        outIm[pos[i]] = dataIm[i];
      }
    }

    bitsPerDataSym(mode) { return this.nData * MODE_BITS[mode]; }

    modFrame(headerBits, dataBits, mode, mpx) {
      const parts = [this.preAWave, this.preBWave];
      const qpsk = this.qams[2];
      const vr = new Float64Array(this.nUsed), vi = new Float64Array(this.nUsed);
      const dr = new Float64Array(this.nData), di = new Float64Array(this.nData);
      for (let hs = 0; hs < this.nHdrSyms; hs++) {
        const chunk = headerBits.subarray(hs * this.hdrSymBits, (hs + 1) * this.hdrSymBits);
        qpsk.map(chunk, dr, di);
        this.symVals(hs, dr, di, this.nData, false, vr, vi);
        parts.push(this._mod(vr, vi));
      }
      if (dataBits && dataBits.length) {
        const qam = this.qams[MODE_BITS[mode]];
        const bps = this.bitsPerDataSym(mode);
        const nsym = Math.floor(dataBits.length / bps);
        const sr = new Float64Array(this.nData), si = new Float64Array(this.nData);
        for (let i = 0; i < nsym; i++) {
          qam.map(dataBits.subarray(i * bps, (i + 1) * bps), sr, si);
          this.symVals(this.nHdrSyms + i, sr, si, this.nData, mpx, vr, vi);
          parts.push(this._mod(vr, vi));
        }
      }
      let total = this.cfg.guard;
      for (const p of parts) total += p.length;
      const out = new Float32Array(total);
      let p = 0;
      for (const seg of parts) {
        for (let i = 0; i < seg.length; i++)
          out[p + i] = clamp(seg[i], -this.cfg.clip, this.cfg.clip);
        p += seg.length;
      }
      return out;
    }

    frameSamples(nDataSyms) {
      return (2 + this.nHdrSyms + nDataSyms) * this.sym + this.cfg.guard;
    }
  }

  /* =====================================================================
     Frame header (12 bytes, 3x repeated, CRC-16) — framing.py layout.
     byte 5 ("ack" in the duplex original) now carries the pass index;
     byte 8 ("snr_q") is a spare aux byte.
     ===================================================================== */
  const HDR_LEN = 12, HDR_BITS = 96, HDR_REP = 3;

  function packHeader(h) {
    const b = new Uint8Array(HDR_LEN);
    b[0] = MAGIC;
    b[1] = (VERSION << 4) | (h.ftype & 0x0F);
    b[2] = h.flags & 0xFF;
    b[3] = h.nsyms & 0xFF;
    b[4] = h.seq & 0xFF;
    b[5] = h.pass & 0xFF;
    b[6] = (h.length >> 8) & 0xFF;
    b[7] = h.length & 0xFF;
    b[8] = h.aux & 0xFF;
    b[9] = 0;
    const c = crc16(b, 10);
    b[10] = c >> 8; b[11] = c & 0xFF;
    return b;
  }
  function unpackHeader(b) {
    if (b.length !== HDR_LEN || b[0] !== MAGIC) return null;
    if (crc16(b, 10) !== ((b[10] << 8) | b[11])) return null;
    if ((b[1] >> 4) !== VERSION) return null;
    return {
      ftype: b[1] & 0x0F, flags: b[2], nsyms: b[3], seq: b[4], pass: b[5],
      length: (b[6] << 8) | b[7], aux: b[8],
      mode: ID_MODE[b[2] & 0x07] || "qpsk",
      mpx: !!(b[2] & 0x08), fec: !!(b[2] & 0x10)
    };
  }
  function makeFlags(mode, mpx, fec) {
    return (MODE_ID[mode] & 0x07) | (mpx ? 0x08 : 0) | (fec ? 0x10 : 0);
  }

  class FrameBuilder {
    constructor(cfg, ofdm) {
      this.cfg = cfg;
      this.o = ofdm;
      const padLen = ofdm.nHdrSyms * ofdm.hdrSymBits - HDR_BITS * HDR_REP;
      this._hdrPad = pnBits(padLen, 911);
    }
    maxPayload(mode, fec) {
      const bitsCap = this.cfg.maxDataSyms * this.o.bitsPerDataSym(mode);
      const raw = maxPayloadForCoded(bitsCap >> 3, fec);
      return Math.max(raw - 4, 0);
    }
    nsymsFor(blobLen, mode, fec) {
      const coded = codedLen(blobLen, fec);
      const bps = this.o.bitsPerDataSym(mode);
      return Math.ceil(coded * 8 / bps);
    }
    _headerBits(h) {
      const bits = bytesToBits(packHeader(h));
      const out = new Uint8Array(this.o.nHdrSyms * this.o.hdrSymBits);
      for (let r = 0; r < HDR_REP; r++) out.set(bits, r * HDR_BITS);
      out.set(this._hdrPad, HDR_BITS * HDR_REP);
      return out;
    }
    build(ftype, seq, pass, payload, mode, mpx, fec) {
      let bits = null, nsyms = 0, length = 0;
      if (payload && payload.length) {
        const blob = new Uint8Array(payload.length + 4);
        blob.set(payload);
        const c = crc32(payload);
        blob[payload.length] = (c >>> 24) & 255;
        blob[payload.length + 1] = (c >>> 16) & 255;
        blob[payload.length + 2] = (c >>> 8) & 255;
        blob[payload.length + 3] = c & 255;
        const scr = scramble(blob, 0);
        const coded = fec ? fecEncode(scr) : scr;
        nsyms = this.nsymsFor(blob.length, mode, fec);
        const cap = nsyms * this.o.bitsPerDataSym(mode);
        const cb = bytesToBits(coded);
        bits = new Uint8Array(cap);
        bits.set(cb);
        bits.set(pnBits(cap - cb.length, 0), cb.length);
        length = blob.length;
      }
      const h = { ftype, flags: makeFlags(mode, mpx, fec), nsyms,
                  seq, pass, length, aux: 0 };
      const samples = this.o.modFrame(this._headerBits(h), bits, mode, mpx);
      return { samples, header: h, nsyms };
    }
    parseHeaderBits(hard) {
      if (hard.length < HDR_BITS * HDR_REP) return null;
      const bits = new Uint8Array(HDR_BITS);
      for (let i = 0; i < HDR_BITS; i++) {
        const s = hard[i] + hard[HDR_BITS + i] + hard[2 * HDR_BITS + i];
        bits[i] = s >= 2 ? 1 : 0;
      }
      return unpackHeader(bitsToBytes(bits));
    }
    decodePayload(dataBits, h) {
      if (h.length < 5) return { payload: null, corrected: 0 };
      const codedNeed = codedLen(h.length, h.fec);
      if (dataBits.length < codedNeed * 8) return { payload: null, corrected: 0 };
      const coded = bitsToBytes(dataBits.subarray(0, codedNeed * 8));
      let blob, corrected = 0;
      if (h.fec) {
        const r = fecDecode(coded, h.length);
        if (r.data === null) return { payload: null, corrected: -1 };
        blob = r.data;
        corrected = r.corrected;
      } else {
        blob = coded.subarray(0, h.length);
      }
      blob = scramble(blob, 0);
      const n = blob.length - 4;
      const got = ((blob[n] << 24) | (blob[n + 1] << 16) |
                   (blob[n + 2] << 8) | blob[n + 3]) >>> 0;
      const payload = blob.subarray(0, n);
      if (crc32(payload) !== got) return { payload: null, corrected };
      return { payload: Uint8Array.from(payload), corrected };
    }
    frameDuration(nsyms) {
      return this.o.frameSamples(nsyms) / this.cfg.fs;
    }
  }

  /* =====================================================================
     Demodulator — port of dsp.Demod: HUNT (Schmidl-Cox + xcorr refine),
     HEADER (least-squares channel estimate from preamble B), DATA
     (per-symbol pilot common-phase + slope correction, EVM metering,
     closed-loop SFO via the fractional resampler). Extension for the
     SSB profile: a carrier-frequency-offset search on preamble A
     (mistuned rigs), resolved to ±2 bins on preamble B.
     ===================================================================== */
  const HUNT = 0, HEADER = 1, DATA = 2;

  class Demod {
    constructor(cfg, ofdm, builder, onFrame, name) {
      this.cfg = cfg;
      this.o = ofdm;
      this.builder = builder;
      this.onFrame = onFrame;             // (hdr, payload|null, corrected, metrics)
      this.name = name || "L";
      this.buf = new Float64Array(0);
      this.bufBase = 0;                   // absolute index of buf[0] (CFO phase)
      this.state = HUNT;
      this.metrics = { snr: 0, level: -90, drift_ppm: 0, sfo_corr_ppm: 0,
                       snr_lo: 0, snr_hi: 0, cfo: 0 };
      this.constPoints = [];
      this._L = cfg.nfft >> 1;
      this._minLvl = 1e-3;
      this._scThresh = 0.55;
      this.timingAdv = 10;
      this.rsmp = new StreamResampler(cfg.fs, cfg.f_hi * 1.03);
      this.cfo = 0.0;
      this._resetFrame();
      this._xr = new Float64Array(ofdm.nUsed);
      this._xi = new Float64Array(ofdm.nUsed);
    }
    setInputRate(fsIn) { this.rsmp.ratio = fsIn / this.cfg.fs; }

    _resetFrame() {
      this.Hre = null; this.Him = null;
      this.fstart = 0;
      this.hdr = null;
      this.symI = 0;
      this.bits = null;
      this._lastTau = 0;
      this._tauSyms = 0;
      this._hdrBitsAcc = null;
      this._hdrSymI = 0;
      this._driftFresh = false;
    }

    feed(samples) {
      if (samples.length) {
        let s = 0;
        for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i];
        this.metrics.level = 20 * Math.log10(Math.sqrt(s / samples.length) + 1e-10);
      }
      const rs = this.rsmp.process(samples);
      if (!rs.length) return;
      const merged = new Float64Array(this.buf.length + rs.length);
      merged.set(this.buf); merged.set(rs, this.buf.length);
      this.buf = merged;
      let progress = true;
      while (progress) {
        progress = false;
        if (this.state === HUNT) progress = this._hunt();
        else if (this.state === HEADER) progress = this._header();
        else if (this.state === DATA) progress = this._data();
      }
      const keep = Math.max(4 * this.cfg.fs,
        this.o.frameSamples(this.cfg.maxDataSyms) + 2 * this.cfg.fs);
      if (this.buf.length > keep) {
        const cut = this.buf.length - keep;
        this.buf = this.buf.slice(cut);
        this.bufBase += cut;
        if (this.state !== HUNT) {
          this.fstart -= cut;
          if (this.fstart < 0) { this.state = HUNT; this._resetFrame(); }
        }
      }
    }

    _cut(n) { this.buf = this.buf.slice(n); this.bufBase += n; }

    _hunt() {
      if (this.cfg.cfoSearch) return this._huntXcorr();
      const L = this._L, sym = this.o.sym, cp = this.cfg.cp, n = this.cfg.nfft;
      const need = 2 * L + sym + cp;
      const x = this.buf;
      if (x.length < need + 256) return false;
      const nmax = x.length - 2 * L;
      /* Schmidl-Cox metric via cumulative sums */
      let cy = 0, ce = 0;
      const P = new Float64Array(nmax + 1);
      const R = new Float64Array(nmax + 1);
      {
        const cyA = new Float64Array(nmax + L + 1);
        const ceA = new Float64Array(nmax + L + 1);
        for (let i = 0; i < nmax + L; i++) {
          cyA[i + 1] = cyA[i] + x[i] * x[i + L];
          ceA[i + 1] = ceA[i] + x[i + L] * x[i + L];
        }
        for (let d = 0; d <= nmax; d++) {
          P[d] = cyA[d + L] - cyA[d];
          R[d] = ceA[d + L] - ceA[d];
        }
      }
      let d0 = -1;
      const gate = this._minLvl * this._minLvl * L;
      for (let d = 0; d <= nmax; d++) {
        const M = (P[d] * P[d]) / (R[d] * R[d] + 1e-12);
        if (M > this._scThresh && R[d] > gate) { d0 = d; break; }
      }
      if (d0 < 0) {
        const tail = 2 * L + 256;
        if (this.buf.length > tail) this._cut(this.buf.length - tail);
        return false;
      }
      let dpk = d0, mBest = -1;
      const hi = Math.min(d0 + cp + L, nmax + 1);
      for (let d = d0; d < hi; d++) {
        const M = (P[d] * P[d]) / (R[d] * R[d] + 1e-12);
        if (M > mBest) { mBest = M; dpk = d; }
      }
      /* fine timing: normalized cross-correlation vs preamble-A core */
      const srchLo = Math.max(dpk - cp, 0);
      const srchHi = dpk + cp;
      if (srchHi + n > x.length) return false;
      const tpl = this.o.preACore;
      let tplE = 0;
      for (let i = 0; i < n; i++) tplE += tpl[i] * tpl[i];
      let best = -1, bidx = srchLo;
      let segE = 0;
      for (let i = 0; i < n; i++) segE += x[srchLo + i] * x[srchLo + i];
      for (let d = srchLo; d <= srchHi; d++) {
        let c = 0;
        for (let i = 0; i < n; i++) c += x[d + i] * tpl[i];
        const nc = Math.abs(c) / Math.sqrt(segE * tplE + 1e-12);
        if (nc > best) { best = nc; bidx = d; }
        segE += x[d + n] * x[d + n] - x[d] * x[d];
      }
      if (best < 0.35) { this._cut(dpk + L); return true; }
      return this._lockAt(bidx);
    }

    _huntXcorr() {
      /* CFO-tolerant acquisition for SSB. Complex matched filter over
         each half of preamble A (in-phase + quadrature templates), sum
         of magnitudes -> carrier-phase invariant envelope; the phase
         step between the two half-correlations is the Moose CFO
         estimate (range +-fs/2L ~ +-47 Hz). Adaptive median gate keeps
         band-limited data symbols from false-alarming; an even/odd
         bin-energy check (huge on A, ~1 on data) verifies the lock. */
      const L = this._L, cp = this.cfg.cp, n = this.cfg.nfft;
      const x = this.buf;
      const need = 2 * L + this.o.sym + cp;
      if (x.length < need + 256) return false;
      const t1 = this.o.preACore.subarray(0, L);
      const tq = this.o.preACoreQ.subarray(0, L);
      let tE = 0;
      for (let i = 0; i < L; i++) tE += t1[i] * t1[i];
      const scanEnd = x.length - need;
      const corr = (d, out) => {
        let c1 = 0, q1 = 0, c2 = 0, q2 = 0, e1 = 0, e2 = 0;
        for (let i = 0; i < L; i++) {
          const a = x[d + i], b = x[d + L + i];
          c1 += a * t1[i]; q1 += a * tq[i];
          c2 += b * t1[i]; q2 += b * tq[i];
          e1 += a * a; e2 += b * b;
        }
        out.m = (Math.hypot(c1, q1) / Math.sqrt(e1 * tE + 1e-12) +
                 Math.hypot(c2, q2) / Math.sqrt(e2 * tE + 1e-12)) * 0.5;
        out.c1 = c1; out.q1 = q1; out.c2 = c2; out.q2 = q2;
        return out.m;
      };
      const w = {};
      let best = -1, bidx = -1;
      const samples = [];
      for (let d = 0; d <= scanEnd; d += 8) {
        const sc = corr(d, w);
        if (sc > best) { best = sc; bidx = d; }
        samples.push(sc);
      }
      samples.sort((a, b) => a - b);
      const med = samples.length ? samples[samples.length >> 1] : 0;
      if (best < Math.max(0.32, 2.2 * med)) {
        const tail = need + 64;
        if (this.buf.length > tail) this._cut(this.buf.length - tail);
        return false;
      }
      let fbest = best, fidx = bidx;
      for (let d = Math.max(0, bidx - 28); d <= Math.min(scanEnd, bidx + 28); d++) {
        if (d === bidx) continue;
        const sc = corr(d, w);
        if (sc > fbest) { fbest = sc; fidx = d; }
      }
      corr(fidx, w);
      /* Moose: CFO from the phase step across the L-sample lag.
         Correlating the REAL signal against the ANALYTIC template
         selects the conjugate term, so C2 = C1 * e^{-j*dw*L} — hence
         the minus sign on the phase. */
      const cr = w.c2 * w.c1 + w.q2 * w.q1;
      const ci = w.q2 * w.c1 - w.c2 * w.q1;
      let cfo = -Math.atan2(ci, cr) * this.cfg.fs / (2 * Math.PI * L);
      /* verify + refine on the even/odd bin-energy ratio */
      const spacing = this.cfg.fs / n;
      let es0 = this._evenScore(fidx, cfo);
      if (es0 < 3.0) {                     // not a preamble — nudge, retry
        this._cut(fidx + 8);
        return true;
      }
      const esL = this._evenScore(fidx, cfo - 0.125 * spacing);
      const esH = this._evenScore(fidx, cfo + 0.125 * spacing);
      if (esL > es0 || esH > es0) {
        if (esL > esH) { cfo -= 0.125 * spacing; es0 = esL; }
        else { cfo += 0.125 * spacing; es0 = esH; }
      }
      this.cfo = cfo;
      /* SNR estimate that survives CFO: even bins carry signal+noise,
         odd bins noise only, counts are ~equal */
      this._snrOverride = 10 * Math.log10(Math.max((es0 - 1) / 2, 0.01));
      return this._lockAt(fidx, true);
    }

    _lockAt(bidx, keepCfo) {
      /* common post-acquisition path: SNR estimate from the identical
         halves of preamble A, then the CFO search, then HEADER */
      const L = this._L;
      const x = this.buf;
      this.fstart = Math.max(bidx - this.cfg.cp, 0);
      let nv = 0, sv = 0;
      for (let i = 0; i < L; i++) {
        const d = x[bidx + i] - x[bidx + L + i];
        nv += d * d;
        sv += x[bidx + i] * x[bidx + i];
      }
      nv = nv / L / 2;
      sv = Math.max(sv / L - nv, 1e-12);
      this.metrics.snr = 10 * Math.log10(sv / Math.max(nv, 1e-12));
      if (keepCfo) {
        if (this._snrOverride !== undefined) {
          this.metrics.snr = this._snrOverride;
          this._snrOverride = undefined;
        }
        this.metrics.cfo = this.cfo;
        this.state = HEADER;
        return true;
      }
      if (this.cfg.cfoSearch) {
        const spacing = this.cfg.fs / this.cfg.nfft;
        let bestS = -1, bestF = 0;
        for (let f = -0.75; f <= 0.751; f += 0.125) {
          const sc = this._evenScore(bidx, f * spacing);
          if (sc > bestS) { bestS = sc; bestF = f; }
        }
        const lo = this._evenScore(bidx, (bestF - 0.0625) * spacing);
        const hi2 = this._evenScore(bidx, (bestF + 0.0625) * spacing);
        let f2 = bestF + 0.0625 * 0.5 * (hi2 - lo) / Math.max(2 * bestS - lo - hi2, 1e-9);
        if (!isFinite(f2) || Math.abs(f2 - bestF) > 0.13) f2 = bestF;
        this.cfo = f2 * spacing;
      } else {
        this.cfo = 0;
      }
      this.state = HEADER;
      return true;
    }

    _evenScore(bidx, cfoHz) {
      this.o.fftBins(this.buf, bidx, cfoHz, this._xr, this._xi);
      let even = 0, odd = 0;
      for (let i = 0; i < this.o.nUsed; i++) {
        const e = this._xr[i] * this._xr[i] + this._xi[i] * this._xi[i];
        if ((this.o.used[i] & 1) === 0) even += e; else odd += e;
      }
      return even / (odd + 1e-12);
    }

    _takeSym(idx, outRe, outIm) {
      const s0 = this.fstart + idx * this.o.sym + this.cfg.cp - this.timingAdv;
      if (s0 + this.cfg.nfft > this.buf.length) return false;
      this.o.fftBins(this.buf, s0, this.cfo, outRe, outIm);
      return true;
    }

    _header() {
      const nU = this.o.nUsed;
      const br = new Float64Array(nU), bi = new Float64Array(nU);
      if (!this._takeSym(1, br, bi)) return false;
      /* integer-bin CFO ambiguity: try preamble B shifted 0/±2 bins */
      if (this.cfg.cfoSearch) {
        let bestS = -1, bestShift = 0;
        for (const s of [-2, 0, 2]) {
          let cr = 0, ci = 0;
          for (let i = 0; i < nU; i++) {
            const j = i - s;
            if (j < 0 || j >= nU) continue;
            /* Y[i] * conj(preB[j]) */
            cr += br[i] * this.o.preBRe[j] + bi[i] * this.o.preBIm[j];
            ci += bi[i] * this.o.preBRe[j] - br[i] * this.o.preBIm[j];
          }
          const m = cr * cr + ci * ci;
          if (m > bestS) { bestS = m; bestShift = s; }
        }
        if (bestShift !== 0) {
          this.cfo += bestShift * this.cfg.fs / this.cfg.nfft;
          if (!this._takeSym(1, br, bi)) return false;
        }
        this.metrics.cfo = this.cfo;
      }
      /* channel estimate H = Yb / preB (per bin) */
      this.Hre = new Float64Array(nU);
      this.Him = new Float64Array(nU);
      let hMag = 0;
      for (let i = 0; i < nU; i++) {
        const pr = this.o.preBRe[i], pi = this.o.preBIm[i];
        const den = pr * pr + pi * pi;
        this.Hre[i] = (br[i] * pr + bi[i] * pi) / den;
        this.Him[i] = (bi[i] * pr - br[i] * pi) / den;
        hMag += Math.hypot(this.Hre[i], this.Him[i]);
      }
      if (hMag / nU < 1e-6) { this._abort(); return true; }
      /* the single-symbol estimate is the noise bottleneck for dense
         constellations; soundcard/cable/FM channels are smooth in
         frequency, so a 3-tap smooth buys ~3 dB of estimate SNR
         (edges kept raw — radio filters can be steep there) */
      if (nU > 24) {
        const sr = Float64Array.from(this.Hre), si = Float64Array.from(this.Him);
        for (let i = 1; i < nU - 1; i++) {
          this.Hre[i] = 0.25 * sr[i - 1] + 0.5 * sr[i] + 0.25 * sr[i + 1];
          this.Him[i] = 0.25 * si[i - 1] + 0.5 * si[i] + 0.25 * si[i + 1];
        }
      }
      this._lastTau = 0;
      this._tauSyms = 0;
      /* header symbols (may span several on narrow profiles) */
      if (this._hdrBitsAcc === null) {
        this._hdrBitsAcc = new Uint8Array(this.o.nHdrSyms * this.o.hdrSymBits);
        this._hdrSymI = 0;
      }
      const xr = this._xr, xi = this._xi;
      const dr = new Float64Array(this.o.nData), di = new Float64Array(this.o.nData);
      while (this._hdrSymI < this.o.nHdrSyms) {
        if (!this._takeSym(2 + this._hdrSymI, xr, xi)) return false;
        this._equalize(xr, xi);
        this._pilotCorrect(xr, xi, this._hdrSymI);
        for (let i = 0; i < this.o.nData; i++) {
          dr[i] = xr[this.o.dataPos[i]];
          di[i] = xi[this.o.dataPos[i]];
        }
        this.o.qams[2].demap(dr, di, this.o.nData,
          this._hdrBitsAcc.subarray(this._hdrSymI * this.o.hdrSymBits));
        this._hdrSymI++;
      }
      const h = this.builder.parseHeaderBits(this._hdrBitsAcc);
      this._hdrBitsAcc = null;
      if (h === null || h.nsyms > this.cfg.maxDataSyms) { this._abort(); return true; }
      this.hdr = h;
      if (h.nsyms === 0) {
        this.onFrame(h, null, 0, Object.assign({}, this.metrics));
        this._advance(0);
        return true;
      }
      this.symI = 0;
      this.bits = new Uint8Array(h.nsyms * this.o.bitsPerDataSym(h.mode));
      this.state = DATA;
      return true;
    }

    _equalize(xr, xi) {
      for (let i = 0; i < this.o.nUsed; i++) {
        const hr = this.Hre[i], hi = this.Him[i];
        const den = hr * hr + hi * hi + 1e-15;
        const r = (xr[i] * hr + xi[i] * hi) / den;
        xi[i] = (xi[i] * hr - xr[i] * hi) / den;
        xr[i] = r;
      }
    }

    _data() {
      const h = this.hdr;
      const qam = this.o.qams[MODE_BITS[h.mode]];
      const pos = h.mpx ? this.o.dataPosMpx : this.o.dataPos;
      const bps = this.o.bitsPerDataSym(h.mode);
      const xr = this._xr, xi = this._xi;
      const dr = new Float64Array(this.o.nData), di = new Float64Array(this.o.nData);
      let moved = false;
      while (this.symI < h.nsyms) {
        if (!this._takeSym(2 + this.o.nHdrSyms + this.symI, xr, xi)) return moved;
        this._equalize(xr, xi);
        this._pilotCorrect(xr, xi, this.o.nHdrSyms + this.symI);
        for (let i = 0; i < this.o.nData; i++) {
          dr[i] = xr[pos[i]];
          di[i] = xi[pos[i]];
        }
        qam.demap(dr, di, this.o.nData, this.bits.subarray(this.symI * bps));
        if ((this.symI & 1) === 0 && this.constPoints.length < 800)
          for (let i = 0; i < this.o.nData; i += 4)
            this.constPoints.push(dr[i], di[i]);
        this._subbandSnr(dr, di, qam);
        this.symI++;
        moved = true;
      }
      this._sfoUpdate();
      const res = this.builder.decodePayload(this.bits, h);
      this.onFrame(h, res.payload, res.corrected, Object.assign({}, this.metrics));
      this._advance(h.nsyms);
      return true;
    }

    _pilotCorrect(xr, xi, symIdx) {
      const o = this.o, pp = o.pilotPos, np = o.nPil;
      const pr = o.pilotTabRe[symIdx & 15], pi = o.pilotTabIm[symIdx & 15];
      const er = new Float64Array(np), ei = new Float64Array(np);
      for (let i = 0; i < np; i++) {
        const yr = xr[pp[i]], yi = xi[pp[i]];
        er[i] = yr * pr[i] + yi * pi[i];
        ei[i] = yi * pr[i] - yr * pi[i];
      }
      /* slope from adjacent pilot pairs */
      let sr = 0, si = 0;
      for (let i = 1; i < np; i++) {
        sr += er[i] * er[i - 1] + ei[i] * ei[i - 1];
        si += ei[i] * er[i - 1] - er[i] * ei[i - 1];
      }
      const dphi = Math.atan2(si, sr);
      let dk = 0;
      for (let i = 1; i < np; i++) dk += o.used[pp[i]] - o.used[pp[i - 1]];
      dk /= (np - 1);
      const b = dphi / dk;
      let ar = 0, ai = 0;
      for (let i = 0; i < np; i++) {
        const k = o.used[pp[i]];
        const c = Math.cos(-b * k), s = Math.sin(-b * k);
        ar += er[i] * c - ei[i] * s;
        ai += er[i] * s + ei[i] * c;
      }
      const a = Math.atan2(ai, ar);
      for (let i = 0; i < o.nUsed; i++) {
        const ph = -(a + b * o.used[i]);
        const c = Math.cos(ph), s = Math.sin(ph);
        const r = xr[i] * c - xi[i] * s;
        xi[i] = xr[i] * s + xi[i] * c;
        xr[i] = r;
      }
      /* pilot EVM -> SNR metric; slope -> timing drift ppm */
      let mr = 0, mi = 0;
      const ecr = new Float64Array(np), eci = new Float64Array(np);
      for (let i = 0; i < np; i++) {
        const k = o.used[pp[i]];
        const ph = -(a + b * k);
        const c = Math.cos(ph), s = Math.sin(ph);
        ecr[i] = er[i] * c - ei[i] * s;
        eci[i] = er[i] * s + ei[i] * c;
        mr += ecr[i]; mi += eci[i];
      }
      mr /= np; mi /= np;
      let ev = 0, sp = 0;
      for (let i = 0; i < np; i++) {
        ev += (ecr[i] - mr) ** 2 + (eci[i] - mi) ** 2;
        sp += ecr[i] * ecr[i] + eci[i] * eci[i];
      }
      ev = ev / np + 1e-12;
      sp /= np;
      const snr = 10 * Math.log10(Math.max(sp / ev, 1.0));
      this.metrics.snr = 0.8 * this.metrics.snr + 0.2 * Math.min(snr, 48.0);
      const tau = -b * this.cfg.nfft / (2 * Math.PI);
      const dsym = symIdx - this._tauSyms;
      if (dsym > 0 && this._tauSyms > 0) {
        const ppm = clamp(-(tau - this._lastTau) / (dsym * o.sym) * 1e6, -500, 500);
        this._driftFresh = true;
        this.metrics.drift_ppm = 0.7 * this.metrics.drift_ppm + 0.3 * ppm;
      }
      this._lastTau = tau;
      this._tauSyms = symIdx;
    }

    _sfoUpdate() {
      const resid = this.metrics.drift_ppm;
      if (this._driftFresh && Math.abs(resid) > 0.7) {
        const step = clamp(-0.6 * resid, -150, 150);
        this.rsmp.ppm = clamp(this.rsmp.ppm + step, -600, 600);
      }
      this._driftFresh = false;
      this.metrics.sfo_corr_ppm = this.rsmp.ppm;
    }

    _subbandSnr(dr, di, qam) {
      const n = this.o.nData;
      const hr = new Float64Array(n), hi = new Float64Array(n);
      qam.hard(dr, di, n, hr, hi);
      let eLo = 0, eHi = 0, pLo = 0, pHi = 0, nLo = 0, nHi = 0;
      for (let i = 0; i < n; i++) {
        const e = (dr[i] - hr[i]) ** 2 + (di[i] - hi[i]) ** 2 + 1e-12;
        const p = hr[i] * hr[i] + hi[i] * hi[i];
        if (this.o.mpxLoMask[i]) { eLo += e; pLo += p; nLo++; }
        else { eHi += e; pHi += p; nHi++; }
      }
      const sLo = nLo ? 10 * Math.log10((pLo / nLo) / (eLo / nLo)) : 0;
      const sHi = nHi ? 10 * Math.log10((pHi / nHi) / (eHi / nHi)) : 0;
      this.metrics.snr_lo = 0.8 * this.metrics.snr_lo + 0.2 * Math.min(sLo, 45);
      this.metrics.snr_hi = 0.8 * this.metrics.snr_hi + 0.2 * Math.min(sHi, 45);
    }

    _advance(nsyms) {
      const end = this.fstart + (2 + this.o.nHdrSyms + nsyms) * this.o.sym;
      this._cut(Math.max(end, 0));
      this.state = HUNT;
      this._resetFrame();
    }
    _abort() {
      this._cut(this.fstart + this._L);
      this.state = HUNT;
      this._resetFrame();
    }
  }

  /* =====================================================================
     Simplex file protocol
     ===================================================================== */
  function makeConfig(profileId) {
    const p = PROFILES[profileId];
    return {
      profileId, fs: p.fs, nfft: p.nfft, cp: p.cp,
      f_lo: p.f_lo, f_hi: p.f_hi, guard: p.guard,
      maxDataSyms: p.maxDataSyms, pilot_step: 8,
      tx_rms: 0.13, clip: 0.95,
      cfoSearch: profileId === "ssb" || profileId === "ssbn"
    };
  }

  function buildBeaconPayload(callsign) {
    const cs = (callsign || "NOCALL").slice(0, 16);
    const enc = [];
    for (let i = 0; i < cs.length; i++) enc.push(cs.charCodeAt(i) & 0xFF);
    return Uint8Array.from([0x51, 0x42, enc.length, ...enc]);   // "QB"
  }
  function parseBeaconPayload(p) {
    if (p.length < 3 || p[0] !== 0x51 || p[1] !== 0x42) return null;
    const n = p[2];
    if (p.length < 3 + n) return null;
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(p[3 + i]);
    return s;
  }
  function buildMetaPayload(name, size, fileCrc, segLen, nSegs, passes, lanes) {
    const nb = [];
    const nm = name.slice(0, 64);
    for (let i = 0; i < nm.length; i++) nb.push(nm.charCodeAt(i) & 0xFF);
    const b = new Uint8Array(1 + nb.length + 4 + 4 + 2 + 2 + 1 + 1);
    let p = 0;
    b[p++] = nb.length;
    for (const c of nb) b[p++] = c;
    b[p++] = (size >>> 24) & 255; b[p++] = (size >>> 16) & 255;
    b[p++] = (size >>> 8) & 255; b[p++] = size & 255;
    b[p++] = (fileCrc >>> 24) & 255; b[p++] = (fileCrc >>> 16) & 255;
    b[p++] = (fileCrc >>> 8) & 255; b[p++] = fileCrc & 255;
    b[p++] = (segLen >> 8) & 255; b[p++] = segLen & 255;
    b[p++] = (nSegs >> 8) & 255; b[p++] = nSegs & 255;
    b[p++] = passes & 255;
    b[p++] = lanes & 255;
    return b;
  }
  function parseMetaPayload(b) {
    if (b.length < 15) return null;
    const nl = b[0];
    if (b.length < 1 + nl + 14) return null;
    let name = "";
    for (let i = 0; i < nl; i++) name += String.fromCharCode(b[1 + i]);
    let p = 1 + nl;
    const rd32 = () => { const v = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0; p += 4; return v; };
    const rd16 = () => { const v = (b[p] << 8) | b[p + 1]; p += 2; return v; };
    const size = rd32(), fileCrc = rd32(), segLen = rd16(), nSegs = rd16();
    const passes = b[p++], lanes = b[p++];
    return { name, size, fileCrc, segLen, nSegs, passes, lanes };
  }

  /* render a complete transmission (all lanes) into sample arrays */
  function renderTransmission(fileBytes, name, opts) {
    const cfg = makeConfig(opts.profile);
    const ofdm = new OFDM(cfg);
    const builder = new FrameBuilder(cfg, ofdm);
    const mode = opts.mode, mpx = !!opts.mpx, fec = opts.fec !== false;
    const passes = opts.passes || 1;
    const lanes = opts.bond && PROFILES[opts.profile].bond ? 2 : 1;
    const segLen = builder.maxPayload(mode, fec) - 2;
    if (segLen < 16) throw new Error("mode too small for this profile");
    const nSegs = Math.max(1, Math.ceil(fileBytes.length / segLen));
    if (nSegs > 65535) throw new Error("file too large for one transfer");
    const fileCrc = crc32(fileBytes);
    const meta = buildMetaPayload(name, fileBytes.length, fileCrc,
                                  segLen, nSegs, passes, lanes);
    const laneFrames = [];
    for (let l = 0; l < lanes; l++) laneFrames.push([]);
    const pushAll = (samples) => { for (const lf of laneFrames) lf.push(samples); };

    const nBeacons = opts.beacons === undefined ? 2 : opts.beacons;
    const beacon = buildBeaconPayload(opts.callsign);
    for (let i = 0; i < nBeacons; i++)
      pushAll(builder.build(FT_BEACON, i, 0, beacon, "qpsk", false, fec).samples);

    for (let pass = 0; pass < passes; pass++) {
      pushAll(builder.build(FT_META, 0, pass, meta, "qpsk", false, fec).samples);
      for (let s = 0; s < nSegs; s++) {
        const a = s * segLen;
        const seg = fileBytes.subarray(a, Math.min(a + segLen, fileBytes.length));
        const pl = new Uint8Array(2 + seg.length);
        pl[0] = (s >> 8) & 255; pl[1] = s & 255;
        pl.set(seg, 2);
        const fr = builder.build(FT_DATA, s & 0xFF, pass, pl, mode, mpx, fec).samples;
        laneFrames[s % lanes].push(fr);
      }
      pushAll(builder.build(FT_EOF, 0, pass,
                            Uint8Array.from([pass]), "qpsk", false, fec).samples);
    }

    const pad = Math.round(0.15 * cfg.fs);
    let maxLen = 0;
    const laneLens = laneFrames.map(lf => {
      let n = 0;
      for (const f of lf) n += f.length;
      maxLen = Math.max(maxLen, n);
      return n;
    });
    const chans = [];
    for (let l = 0; l < lanes; l++) {
      const y = new Float32Array(pad + maxLen + pad);
      let p = pad;
      for (const f of laneFrames[l]) { y.set(f, p); p += f.length; }
      chans.push(y);
    }
    const bps = builder.maxPayload(mode, fec) /
                builder.frameDuration(builder.nsymsFor(segLen + 2 + 4, mode, fec));
    return {
      chans, cfg, nSegs, segLen, passes, lanes, fileCrc,
      airS: chans[0].length / cfg.fs,
      netBps: bps * lanes,
      frameDur: builder.frameDuration(builder.nsymsFor(segLen + 2 + 4, mode, fec))
    };
  }

  /* receive session: state across frames (survives multiple passes) */
  class RxSession {
    constructor(ev) {
      this.ev = ev || {};
      this.reset();
    }
    reset() {
      this.meta = null;
      this.data = null;
      this.have = null;
      this.got = 0;
      this.done = false;
      this.stats = { frames: 0, crcFail: 0, corrected: 0, beacons: 0 };
    }
    feedFrame(hdr, payload, corrected, metrics, lane) {
      this.stats.frames++;
      if (corrected > 0) this.stats.corrected += corrected;
      if (payload === null) {
        this.stats.crcFail++;
        if (this.ev.onFail) this.ev.onFail(hdr, metrics, lane);
        return;
      }
      if (hdr.ftype === FT_BEACON) {
        const call = parseBeaconPayload(payload);
        this.stats.beacons++;
        if (call !== null && this.ev.onBeacon) this.ev.onBeacon(call, metrics, lane);
      } else if (hdr.ftype === FT_META) {
        const m = parseMetaPayload(payload);
        if (!m) return;
        const key = m.name + "|" + m.size + "|" + m.fileCrc;
        if (!this.meta || this.key !== key) {
          this.meta = m;
          this.key = key;
          this.data = new Uint8Array(m.size);
          this.have = new Uint8Array(m.nSegs);
          this.got = 0;
          this.done = false;
        }
        if (this.ev.onMeta) this.ev.onMeta(m, hdr.pass, metrics);
      } else if (hdr.ftype === FT_DATA) {
        if (!this.meta) return;
        const idx = (payload[0] << 8) | payload[1];
        if (idx >= this.meta.nSegs || this.have[idx]) return;
        const seg = payload.subarray(2);
        this.data.set(seg, idx * this.meta.segLen);
        this.have[idx] = 1;
        this.got++;
        if (this.ev.onSeg) this.ev.onSeg(idx, this.got, this.meta.nSegs, metrics);
        if (this.got === this.meta.nSegs) this._finish();
      } else if (hdr.ftype === FT_EOF) {
        if (this.ev.onEof && this.meta)
          this.ev.onEof(hdr.pass, this.meta.nSegs - this.got, this.meta);
      }
    }
    _finish() {
      if (this.done || !this.meta) return;
      this.done = true;
      const ok = crc32(this.data) === this.meta.fileCrc;
      if (this.ev.onDone) this.ev.onDone(this.data, this.meta, ok);
    }
    missing() {
      if (!this.meta) return [];
      const out = [];
      for (let i = 0; i < this.meta.nSegs; i++) if (!this.have[i]) out.push(i);
      return out;
    }
  }

  /* one receiver = one profile config + one demod per lane + a session */
  class QamRx {
    constructor(profileId, ev) {
      this.cfg = makeConfig(profileId);
      this.ofdm = new OFDM(this.cfg);
      this.builder = new FrameBuilder(this.cfg, this.ofdm);
      this.session = new RxSession(ev);
      this.lanes = [];
      for (let l = 0; l < 2; l++) {
        const lane = l;
        this.lanes.push(new Demod(this.cfg, this.ofdm, this.builder,
          (h, p, c, m) => this.session.feedFrame(h, p, c, m, lane),
          "LR"[l]));
      }
    }
    setInputRate(fsIn) { for (const d of this.lanes) d.setInputRate(fsIn); }
    feed(chans) {
      this.lanes[0].feed(chans[0]);
      if (chans.length > 1 && chans[1]) this.lanes[1].feed(chans[1]);
    }
    metrics() { return this.lanes.map(d => d.metrics); }
  }

  /* =====================================================================
     Browser shell — a little rack modem front panel.
     ===================================================================== */
  const LOOP_CHANNELS = [
    ["Direct (gain only)", { fLo: 20, fHi: null }],
    ["SSB 2.7 kHz", { fLo: 300, fHi: 2700 }],
    ["FM voice 3 kHz", { fLo: 250, fHi: 3000 }],
    ["FM data 7 kHz", { fLo: 100, fHi: 7000 }],
    ["WBFM 15 kHz", { fLo: 50, fHi: 15000 }],
    ["Cable (codec LP)", { fLo: 120, fHi: null }]
  ];

  const DEMO_TEXT = "HRWS QAM File Link demo payload — the quick brown fox " +
    "jumps over the lazy dog 0123456789. ";

  const def = {
    id: "qamlink",

    init(ctx) {
      this.ctx = ctx;
      this.profile = "fmn";
      this.mode = "qpsk";
      this.mpx = true;
      this.fec = true;
      this.bond = false;
      this.passes = 1;
      this.fileBytes = null;
      this.fileName = "";
      this.render = null;
      this.rx = null;
      this.armed = false;
      this.beaconTimer = null;
      this.pollTimer = null;
      this._busy = false;
      this._lockUntil = 0;
      this._lockCall = "";
      this._blink = { rx: 0, err: 0 };
      this._playRs = null;
      if (!this._subscribed) {
        this._subscribed = true;
        ctx.audio.onSamples((ch0, sr, ch1) => this._liveFeed(ch0, sr, ch1));
      }
    },

    createPanel(el) {
      const profOpts = Object.keys(PROFILES).map(id =>
        `<option value="${id}"${id === this.profile ? " selected" : ""}>${PROFILES[id].label}</option>`).join("");
      const chanOpts = LOOP_CHANNELS.map((c, i) =>
        `<option value="${i}"${i === 2 ? " selected" : ""}>${c[0]}</option>`).join("");
      el.innerHTML = `
        <div class="mod-layout">
          <div class="mod-main">
            <div class="card">
              <header class="card-head"><h3>QAM link — receiver</h3>
                <span class="card-tag mono" id="qam-lock">idle</span></header>
              <div style="padding:12px;background:#0b0d10">
                <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start">
                  <div>
                    <canvas id="qam-const" width="170" height="170"
                      style="border:1px solid rgba(96,114,150,0.35);background:#05070b"></canvas>
                    <div class="mono" style="font-size:10px;color:#5a6470;text-align:center">CONSTELLATION (L)</div>
                  </div>
                  <div style="flex:1;min-width:230px">
                    <div id="qam-leds" style="display:flex;gap:12px;margin-bottom:8px"></div>
                    <div class="mono" style="font-size:11px" id="qam-bars"></div>
                    <div class="mono" style="font-size:11px;color:#c9d1d9;margin-top:6px" id="qam-readout">—</div>
                  </div>
                </div>
                <div style="margin-top:10px">
                  <canvas id="qam-map" width="720" height="46"
                    style="width:100%;border:1px solid rgba(96,114,150,0.25);background:#05070b"></canvas>
                  <div class="mono" style="font-size:11px" id="qam-rxinfo">no transfer yet</div>
                </div>
                <div id="qam-filecard" style="display:none;margin-top:10px;padding:10px;
                     border:1px solid rgba(61,220,132,0.4);border-radius:6px">
                  <div class="mono" id="qam-fileinfo"></div>
                  <div style="display:flex;gap:8px;margin-top:6px;align-items:center">
                    <button class="btn" id="qam-dl">Download file</button>
                    <img id="qam-preview" style="display:none;max-height:120px;
                         border:1px solid rgba(96,114,150,0.3)">
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="mod-side">
            <div class="card">
              <header class="card-head"><h3>Link profile</h3></header>
              <div class="card-body mod-controls" style="flex-direction:column;align-items:stretch">
                <label class="field"><span>Profile</span>
                  <select id="qam-profile">${profOpts}</select></label>
                <div class="mod-note mono" id="qam-profnote" style="font-size:10px"></div>
                <label class="field"><span>Constellation</span>
                  <select id="qam-mode"></select></label>
                <div class="mod-controls">
                  <label class="field" style="flex-direction:row;align-items:center;gap:5px">
                    <input type="checkbox" id="qam-fec" checked><span>RS FEC</span></label>
                  <label class="field" style="flex-direction:row;align-items:center;gap:5px">
                    <input type="checkbox" id="qam-mpx" checked><span>MPX</span></label>
                  <label class="field" style="flex-direction:row;align-items:center;gap:5px">
                    <input type="checkbox" id="qam-bond"><span>Stereo bond</span></label>
                </div>
                <label class="field"><span>Passes (repeats)</span>
                  <select id="qam-passes"><option>1</option><option>2</option><option>3</option></select></label>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>Send</h3></header>
              <div class="card-body mod-controls" style="flex-direction:column;align-items:stretch">
                <label class="btn" for="qam-file" style="text-align:center">Choose file…</label>
                <input type="file" id="qam-file" style="display:none">
                <div class="mono" style="font-size:11px" id="qam-plan">no file selected</div>
                <button class="btn" id="qam-beacon">Beacon ▶ (callsign)</button>
                <button class="btn btn-accent" id="qam-send" disabled>SEND FILE</button>
                <button class="btn" id="qam-stop">Stop TX</button>
                <button class="btn" id="qam-savewav" disabled>Save TX WAV</button>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>Receive</h3></header>
              <div class="card-body mod-controls" style="flex-direction:column;align-items:stretch">
                <button class="btn" id="qam-arm">ARM RX ▶</button>
                <label class="btn" for="qam-wavin" style="text-align:center">Decode WAV…</label>
                <input type="file" id="qam-wavin" accept=".wav,audio/wav,audio/x-wav" style="display:none">
                <button class="btn" id="qam-reset">Reset RX session</button>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>Loopback lab</h3></header>
              <div class="card-body mod-controls" style="flex-direction:column;align-items:stretch">
                <label class="field"><span>Channel</span>
                  <select id="qam-chan">${chanOpts}</select></label>
                <div class="mod-controls">
                  <label class="field" style="flex-direction:row;align-items:center;gap:5px">
                    <input type="checkbox" id="qam-noise" checked><span>SNR</span></label>
                  <input type="number" id="qam-snr" value="20" min="-5" max="60" style="width:58px">
                  <span class="mono">dB</span>
                  <input type="number" id="qam-ppm" value="120" min="-500" max="500" style="width:64px">
                  <span class="mono">ppm</span>
                </div>
                <button class="btn" id="qam-loop">Run loopback</button>
                <button class="btn" id="qam-selftest">Self-test</button>
              </div>
            </div>
            <div class="mod-note">
              One-way OFDM file transfer — a port of the "audiomodem" DMT
              engine (VA3JFL). Flow: the receiving op presses ARM RX, the
              sender runs the Beacon; when the lock banner shows the
              callsign and SNR, confirm on voice and press SEND. Repeat
              passes fill lost segments. Both ends need this studio.
              Identify per your regulations.
            </div>
          </div>
        </div>`;

      const $ = id => el.querySelector("#qam-" + id);
      this.ui = {
        lock: $("lock"), const: $("const"), leds: $("leds"), bars: $("bars"),
        readout: $("readout"), map: $("map"), rxinfo: $("rxinfo"),
        filecard: $("filecard"), fileinfo: $("fileinfo"), dl: $("dl"),
        preview: $("preview"),
        profile: $("profile"), profnote: $("profnote"), mode: $("mode"),
        fec: $("fec"), mpx: $("mpx"), bond: $("bond"), passes: $("passes"),
        file: $("file"), plan: $("plan"), beacon: $("beacon"),
        send: $("send"), savewav: $("savewav"),
        arm: $("arm"), wavin: $("wavin"), reset: $("reset"),
        chan: $("chan"), noise: $("noise"), snr: $("snr"), ppm: $("ppm"),
        loop: $("loop"), selftest: $("selftest")
      };
      this._buildLeds();
      this._profileChanged();

      this.ui.profile.addEventListener("change", () => {
        this.profile = this.ui.profile.value;
        this._profileChanged();
      });
      this.ui.mode.addEventListener("change", () => { this.mode = this.ui.mode.value; this._plan(); });
      this.ui.fec.addEventListener("change", () => { this.fec = this.ui.fec.checked; this._plan(); });
      this.ui.mpx.addEventListener("change", () => { this.mpx = this.ui.mpx.checked; this._plan(); });
      this.ui.bond.addEventListener("change", () => { this.bond = this.ui.bond.checked; this._plan(); });
      this.ui.passes.addEventListener("change", () => { this.passes = parseInt(this.ui.passes.value, 10); this._plan(); });
      this.ui.file.addEventListener("change", async e => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        this.fileBytes = new Uint8Array(await f.arrayBuffer());
        this.fileName = f.name;
        this.ctx.log(`file loaded: ${f.name} (${(f.size / 1024).toFixed(1)} kB)`);
        this._plan();
      });
      this.ui.beacon.addEventListener("click", () => this._toggleBeacon());
      this.ui.send.addEventListener("click", () => this._send());
      el.querySelector("#qam-stop").addEventListener("click", () => {
        if (this.beaconTimer) {
          clearInterval(this.beaconTimer);
          this.beaconTimer = null;
          this.ui.beacon.textContent = "Beacon ▶ (callsign)";
        }
        this.ctx.audio.stopTX();
        this.ctx.log("QAM transmission stopped.");
      });
      this.ui.savewav.addEventListener("click", () => this._saveWav());
      this.ui.arm.addEventListener("click", () => this._toggleArm());
      this.ui.wavin.addEventListener("change", e => {
        const f = e.target.files && e.target.files[0];
        if (f) this._decodeWav(f);
        e.target.value = "";
      });
      this.ui.reset.addEventListener("click", () => {
        this.rx = null;
        this._paintMap(null);
        this.ui.rxinfo.textContent = "session cleared";
        this.ui.filecard.style.display = "none";
      });
      this.ui.loop.addEventListener("click", () => this._loopback());
      this.ui.selftest.addEventListener("click", () => this._selfTest());

      this.pollTimer = setInterval(() => this._poll(), 150);
    },

    onDeactivate() {
      this.armed = false;
      if (this.beaconTimer) { clearInterval(this.beaconTimer); this.beaconTimer = null; }
      if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
      this.ui = null;
    },

    /* ---------------- UI helpers ---------------- */
    _buildLeds() {
      const names = ["PWR", "SYNC L", "SYNC R", "RX", "LOCK", "ERR"];
      const colors = { PWR: "#3ddc84", "SYNC L": "#3ddc84", "SYNC R": "#3ddc84",
                       RX: "#ffb347", LOCK: "#4dd0e1", ERR: "#ff5252" };
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
    _led(name, on) {
      if (!this.leds) return;
      this.leds[name].style.background = on ? this._ledColors[name] : "#3a3f47";
    },

    _profileChanged() {
      const p = PROFILES[this.profile];
      this.ui.profnote.textContent = p.note;
      this.ui.mode.innerHTML = p.modes.map(m =>
        `<option value="${m}">${m.toUpperCase()}</option>`).join("");
      if (!p.modes.includes(this.mode)) this.mode = p.modes[0];
      this.ui.mode.value = this.mode;
      this.ui.bond.disabled = !p.bond;
      if (!p.bond) { this.bond = false; this.ui.bond.checked = false; }
      if (this.armed) this._toggleArm();          // profile switch drops the RX
      this.rx = null;
      this._plan();
    },

    _plan() {
      if (!this.ui) return;
      let text;
      try {
        const cfg = makeConfig(this.profile);
        const ofdm = new OFDM(cfg);
        const builder = new FrameBuilder(cfg, ofdm);
        const segLen = builder.maxPayload(this.mode, this.fec) - 2;
        const lanes = this.bond && PROFILES[this.profile].bond ? 2 : 1;
        const fd = builder.frameDuration(builder.nsymsFor(segLen + 6, this.mode, this.fec));
        const net = segLen / fd * lanes;
        text = `${ofdm.nData} data bins · seg ${segLen} B · ~${(net * 8 / 1000).toFixed(1)} kbit/s net`;
        if (this.fileBytes) {
          /* exact airtime: mirror renderTransmission frame-for-frame —
             beacons/meta/EOF are tiny QPSK frames, so charging them at
             full data-frame duration (the old formula) badly
             overestimated small transfers */
          const nSegs = Math.max(1, Math.ceil(this.fileBytes.length / segLen));
          const dur = (p, m) => builder.frameDuration(builder.nsymsFor(p + 4, m, this.fec));
          const call = (this.ctx.settings().callsign || "NOCALL").toUpperCase();
          const meta = buildMetaPayload(this.fileName || "file", this.fileBytes.length, 0,
                                        segLen, nSegs, this.passes, lanes);
          const laneS = new Array(lanes).fill(0);
          for (let s = 0; s < nSegs; s++) {
            const len = Math.min(segLen, this.fileBytes.length - s * segLen);
            laneS[s % lanes] += dur(2 + len, this.mode);
          }
          const air = 2 * dur(buildBeaconPayload(call).length, "qpsk") +
                      this.passes * (dur(meta.length, "qpsk") + Math.max(...laneS) + dur(1, "qpsk")) +
                      0.30;
          text = `${this.fileName} (${(this.fileBytes.length / 1024).toFixed(1)} kB) → ` +
                 `${nSegs} segs × ${this.passes} pass → ${air.toFixed(1)} s on air · ` +
                 `~${(net * 8 / 1000).toFixed(1)} kbit/s`;
        }
        this.ui.send.disabled = !this.fileBytes;
        this.ui.savewav.disabled = !this.fileBytes;
      } catch (e) {
        text = "plan error: " + e.message;
      }
      this.ui.plan.textContent = text;
      this.render = null;
    },

    /* ---------------- live audio plumbing ---------------- */
    _engineRate() { return this.ctx.audio.ensureContext().sampleRate; },

    _playChans(chans, fs) {
      /* hand the buffers straight to the engine — it resamples cleanly
         to the context rate, so live playback and Save-WAV now share
         one identical path with no resampler detour */
      const F = (a) => a instanceof Float32Array ? a : Float32Array.from(a);
      this.ctx.audio.playPCM(F(chans[0]), fs, chans.length > 1 ? F(chans[1]) : undefined);
    },

    _liveFeed(ch0, sr, ch1) {
      if (!this.armed || !this.rx) return;
      this.rx.setInputRate(sr);
      this.rx.feed(ch1 ? [ch0, ch1] : [ch0]);
      this._blink.rx = performance.now();
    },

    /* ---------------- TX ---------------- */
    _renderNow() {
      if (!this.fileBytes) return null;
      if (this.render) return this.render;
      const call = (this.ctx.settings().callsign || "NOCALL").toUpperCase();
      this.render = renderTransmission(this.fileBytes, this.fileName, {
        profile: this.profile, mode: this.mode, mpx: this.mpx,
        fec: this.fec, passes: this.passes, bond: this.bond, callsign: call
      });
      return this.render;
    },

    _send() {
      if (this._busy) return;
      if (this.beaconTimer) {
        clearInterval(this.beaconTimer);
        this.beaconTimer = null;
        this.ui.beacon.textContent = "Beacon ▶ (callsign)";
        this.ctx.log("beacon paused — sending the file");
      }
      try {
        const r = this._renderNow();
        if (!r) return;
        if (r.cfg.fs > this._engineRate() * 1.05) {
          this.ctx.log(`this profile needs a ${r.cfg.fs / 1000} kHz audio path \u2014 set your output device (Windows Sound settings) or the NBTV sample-rate option to ${r.cfg.fs / 1000} kHz and reload for live play; Save WAV works right now`);
          return;
        }
        this._playChans(r.chans, r.cfg.fs);
        this.ctx.log(`QAM sending "${this.fileName}"${r.lanes > 1 ? " (stereo bond — use a stereo path!)" : ""} — ${r.nSegs} segments, ` +
          `${this.passes} pass${this.passes > 1 ? "es" : ""}, ${r.airS.toFixed(1)} s on air ` +
          `(${(r.netBps * 8 / 1000).toFixed(1)} kbit/s net)`);
      } catch (e) {
        this.ctx.log("send failed: " + e.message);
      }
    },

    _toggleBeacon() {
      if (this.beaconTimer) {
        clearInterval(this.beaconTimer);
        this.beaconTimer = null;
        this.ui.beacon.textContent = "Beacon ▶ (callsign)";
        this.ctx.log("beacon stopped");
        return;
      }
      const cfg = makeConfig(this.profile);
      if (cfg.fs > this._engineRate() * 1.05) {
        this.ctx.log("beacon: profile rate exceeds the soundcard — use WAV/loopback");
        return;
      }
      const ofdm = new OFDM(cfg);
      const builder = new FrameBuilder(cfg, ofdm);
      const call = (this.ctx.settings().callsign || "NOCALL").toUpperCase();
      const pl = buildBeaconPayload(call);
      const fr = builder.build(FT_BEACON, 0, 0, pl, "qpsk", false, this.fec).samples;
      const fire = () => this._playChans([fr], cfg.fs);
      fire();
      this.beaconTimer = setInterval(fire, Math.max(1200, 1000 * fr.length / cfg.fs + 400));
      this.ui.beacon.textContent = "Beacon ■ (stop)";
      this.ctx.log(`beacon running: "${call}" on ${PROFILES[this.profile].label}`);
    },

    _saveWav() {
      try {
        const r = this._renderNow();
        if (!r) return;
        const buf = wavEncode16(r.chans, r.cfg.fs);
        const name = `qamlink_${this.fileName.replace(/[^A-Za-z0-9._-]/g, "_")}` +
                     `_${this.profile}_${this.mode}.wav`;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
        this.ctx.log(`saved ${name} (${(buf.byteLength / 1048576).toFixed(1)} MB, ` +
                     `${r.lanes === 2 ? "stereo" : "mono"} @ ${r.cfg.fs} Hz)`);
      } catch (e) {
        this.ctx.log("WAV render failed: " + e.message);
      }
    },

    /* ---------------- RX ---------------- */
    _mkRx() {
      const self = this;
      return new QamRx(this.profile, {
        onBeacon(call, m) {
          self._lockCall = call;
          self._lockUntil = performance.now() + 4000;
          const hint = Object.entries(MODE_NEEDS)
            .filter(([mo]) => PROFILES[self.profile].modes.includes(mo))
            .filter(([, need]) => m.snr >= need + 2).map(([mo]) => mo).pop() || "qpsk";
          self.ctx.log(`LOCK: "${call}" · SNR ${m.snr.toFixed(1)} dB` +
            (m.cfo ? ` · CFO ${m.cfo.toFixed(1)} Hz` : "") +
            ` — ${hint.toUpperCase()} looks safe; tell them on voice`);
        },
        onMeta(meta, pass) {
          self.ctx.log(`file header: "${meta.name}" ${(meta.size / 1024).toFixed(1)} kB, ` +
            `${meta.nSegs} segments, pass ${pass + 1}/${meta.passes}` +
            (meta.lanes > 1 ? " (stereo-bonded)" : ""));
          self._paintMap(self.rx.session);
        },
        onSeg(idx, got, total) {
          self._blink.rx = performance.now();
          self._paintMap(self.rx.session);
          if (self.ui) self.ui.rxinfo.textContent =
            `receiving: ${got}/${total} segments`;
        },
        onEof(pass, missing, meta) {
          if (missing > 0)
            self.ctx.log(`pass ${pass + 1} done — ${missing} segment${missing > 1 ? "s" : ""} ` +
              `missing; ${pass + 1 < meta.passes ? "next pass repairs" : "ask for another pass"}`);
        },
        onDone(bytes, meta, ok) {
          self.ctx.log(`file complete: "${meta.name}" — CRC ${ok ? "OK ✓" : "MISMATCH"}`);
          self._fileReady(bytes, meta, ok);
        },
        onFail() {
          self._blink.err = performance.now();
          if (self.rx && self.ui) self.ui.rxinfo.textContent =
            `frame failed (${self.rx.session.stats.crcFail} total)`;
        }
      });
    },

    _toggleArm() {
      if (this.armed) {
        this.armed = false;
        this.ui.arm.textContent = "ARM RX ▶";
        this.ctx.log("RX disarmed (session kept — Reset clears it)");
        return;
      }
      const cfg = makeConfig(this.profile);
      if (cfg.fs > this._engineRate() * 1.05) {
        this.ctx.log("this profile exceeds the soundcard rate — use Decode WAV");
        return;
      }
      const arm = () => {
        if (!this.rx) this.rx = this._mkRx();
        this.rx.setInputRate(this._engineRate());
        this.armed = true;
        this.ui.arm.textContent = "ARM RX ■ (armed)";
        this.ctx.log(`RX armed on ${PROFILES[this.profile].label} — waiting for a beacon or file`);
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
        this.ctx.log(`decoding ${file.name}: ${(wav.chans[0].length / wav.rate).toFixed(1)} s, ` +
          `${wav.nch} ch @ ${wav.rate} Hz`);
        if (!this.rx) this.rx = this._mkRx();
        this.rx.setInputRate(wav.rate);
        const chunk = Math.round(wav.rate * 0.5);
        for (let p = 0; p < wav.chans[0].length; p += chunk) {
          const parts = wav.chans.map(c => c.subarray(p, Math.min(p + chunk, c.length)));
          this.rx.feed(parts);
          this.ui.rxinfo.textContent =
            `decoding WAV… ${Math.round(100 * p / wav.chans[0].length)} %`;
          await tick();
        }
        const st = this.rx.session.stats;
        this.ui.rxinfo.textContent = this.rx.session.meta
          ? `WAV done: ${this.rx.session.got}/${this.rx.session.meta.nSegs} segments, ` +
            `${st.crcFail} failed, ${st.corrected} bytes RS-corrected`
          : "WAV done: no QAM-link frames found";
      } catch (e) {
        this.ctx.log("WAV decode failed: " + e.message);
      } finally {
        this._busy = false;
      }
    },

    _fileReady(bytes, meta, ok) {
      this.ui.filecard.style.display = "block";
      this.ui.fileinfo.textContent =
        `${meta.name} · ${(meta.size / 1024).toFixed(1)} kB · CRC ${ok ? "OK" : "BAD"}`;
      const blob = new Blob([bytes]);
      const url = URL.createObjectURL(blob);
      this.ui.dl.onclick = () => {
        const a = document.createElement("a");
        a.href = url; a.download = meta.name || "received.bin";
        document.body.appendChild(a); a.click();
        setTimeout(() => a.remove(), 2000);
      };
      if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(meta.name)) {
        this.ui.preview.src = url;
        this.ui.preview.style.display = "block";
      } else {
        this.ui.preview.style.display = "none";
      }
    },

    _paintMap(session) {
      const cv = this.ui && this.ui.map;
      if (!cv) return;
      const c = cv.getContext("2d");
      c.fillStyle = "#05070b";
      c.fillRect(0, 0, cv.width, cv.height);
      if (!session || !session.meta) return;
      const n = session.meta.nSegs;
      const cols = Math.min(n, Math.max(16, Math.ceil(Math.sqrt(n * 14))));
      const rows = Math.ceil(n / cols);
      const cw = cv.width / cols, ch = cv.height / rows;
      for (let i = 0; i < n; i++) {
        c.fillStyle = session.have[i] ? "#3ddc84" : "#2c323c";
        c.fillRect((i % cols) * cw + 1, Math.floor(i / cols) * ch + 1,
                   Math.max(1, cw - 2), Math.max(1, ch - 2));
      }
    },

    _poll() {
      if (!this.ui) return;
      const now = performance.now();
      const m = this.rx ? this.rx.metrics() : null;
      this._led("RX", now - this._blink.rx < 300);
      this._led("ERR", now - this._blink.err < 400);
      const locked = now < this._lockUntil;
      this._led("LOCK", locked);
      this.ui.lock.textContent = locked ? `LOCK · ${this._lockCall}` :
        this.armed ? "armed" : "idle";
      if (m) {
        this._led("SYNC L", this.rx.lanes[0].state !== HUNT);
        this._led("SYNC R", this.rx.lanes[1].state !== HUNT);
        const bar = (label, v, lo, hi) => {
          const f = clamp((v - lo) / (hi - lo), 0, 1);
          const blocks = Math.round(f * 18);
          return `${label} ${"█".repeat(blocks)}${"░".repeat(18 - blocks)} ${v.toFixed(1)}`;
        };
        this.ui.bars.innerHTML =
          bar("SNR L", m[0].snr, 0, 45) + " dB<br>" +
          bar("SNR R", m[1].snr, 0, 45) + " dB<br>" +
          bar("LEVEL", m[0].level, -60, 0) + " dBFS";
        this.ui.readout.textContent =
          `drift ${m[0].drift_ppm.toFixed(1)} ppm · SFO corr ${m[0].sfo_corr_ppm.toFixed(0)} ppm` +
          (this.profile === "ssb" ? ` · CFO ${m[0].cfo.toFixed(1)} Hz` : "") +
          ` · MPX lo/hi ${m[0].snr_lo.toFixed(0)}/${m[0].snr_hi.toFixed(0)} dB`;
        this._drawConst();
      }
    },

    _drawConst() {
      const cv = this.ui.const, c = cv.getContext("2d");
      c.fillStyle = "rgba(5,7,11,0.35)";
      c.fillRect(0, 0, 170, 170);
      c.strokeStyle = "#181d24";
      for (const p of [0.25, 0.5, 0.75]) {
        c.beginPath(); c.moveTo(170 * p, 0); c.lineTo(170 * p, 170); c.stroke();
        c.beginPath(); c.moveTo(0, 170 * p); c.lineTo(170, 170 * p); c.stroke();
      }
      const pts = this.rx ? this.rx.lanes[0].constPoints : [];
      c.fillStyle = "#3ddc84";
      const s = 170 / 4;
      for (let i = 0; i + 1 < pts.length; i += 2) {
        const x = 85 + pts[i] * s, y = 85 - pts[i + 1] * s;
        if (x >= 0 && x <= 170 && y >= 0 && y <= 170) c.fillRect(x, y, 1.6, 1.6);
      }
      if (pts.length > 600) pts.splice(0, pts.length - 600);
    },

    /* ---------------- loopback + self-test ---------------- */
    async _loopback() {
      if (this._busy) return;
      this._busy = true;
      try {
        const bytes = this.fileBytes ||
          (() => { const t = DEMO_TEXT.repeat(24); const b = new Uint8Array(t.length);
                   for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i); return b; })();
        const name = this.fileBytes ? this.fileName : "demo.txt";
        const call = (this.ctx.settings().callsign || "NOCALL").toUpperCase();
        const r = renderTransmission(bytes, name, {
          profile: this.profile, mode: this.mode, mpx: this.mpx,
          fec: this.fec, passes: this.passes, bond: this.bond, callsign: call
        });
        const chSpec = LOOP_CHANNELS[parseInt(this.ui.chan.value, 10)][1];
        const snr = this.ui.noise.checked ? parseFloat(this.ui.snr.value) : null;
        const ppm = parseFloat(this.ui.ppm.value) || 0;
        this.ctx.log(`loopback: ${PROFILES[this.profile].label}, ${this.mode.toUpperCase()}, ` +
          `${LOOP_CHANNELS[parseInt(this.ui.chan.value, 10)][0]}` +
          (snr !== null ? `, SNR ${snr} dB` : "") + (ppm ? `, ${ppm} ppm skew` : ""));
        this.rx = this._mkRx();
        this.rx.setInputRate(r.cfg.fs);
        const chans = r.chans.map((y, i) => new StreamChannel(r.cfg.fs, {
          snrDb: snr, ppm, gain: 0.5, seed: 3 + i,
          fLo: chSpec.fLo, fHi: chSpec.fHi || 0.475 * r.cfg.fs
        }).process(y));
        const chunk = Math.round(r.cfg.fs * 0.5);
        for (let p = 0; p < chans[0].length; p += chunk) {
          this.rx.feed(chans.map(y => y.subarray(p, Math.min(p + chunk, y.length))));
          this.ui.rxinfo.textContent =
            `loopback… ${Math.round(100 * p / chans[0].length)} %`;
          await tick();
        }
        const s = this.rx.session;
        this.ui.rxinfo.textContent = s.meta
          ? `loopback done: ${s.got}/${s.meta.nSegs} segments · ` +
            `${s.stats.crcFail} failed · ${s.stats.corrected} B RS-corrected`
          : "loopback done: nothing decoded (SNR too low for this mode?)";
      } catch (e) {
        this.ctx.log("loopback failed: " + e.message);
      } finally {
        this._busy = false;
      }
    },

    async _selfTest() {
      if (this._busy) return;
      const log = m => this.ctx.log("qam self-test: " + m);
      const t = DEMO_TEXT.repeat(16);
      const bytes = new Uint8Array(t.length);
      for (let i = 0; i < t.length; i++) bytes[i] = t.charCodeAt(i);
      const cases = [
        ["fmn", "16qam", 22, 120, "FM voice 3 kHz"],
        ["ssb", "qpsk", 14, 200, "HF SSB (CFO + skew)"]
      ];
      for (const [prof, mode, snr, ppm, label] of cases) {
        const r = renderTransmission(bytes, "selftest.txt", {
          profile: prof, mode, mpx: true, fec: true, passes: 1,
          bond: false, callsign: "SELFTEST"
        });
        let done = null;
        const rx = new QamRx(prof, {
          onDone: (b, meta, ok) => { done = ok && b.length === bytes.length; }
        });
        rx.setInputRate(r.cfg.fs);
        const spec = prof === "ssb" ? { fLo: 300, fHi: 2700 } : { fLo: 250, fHi: 3000 };
        const y = new StreamChannel(r.cfg.fs, {
          snrDb: snr, ppm, gain: 0.5, seed: 11,
          fLo: spec.fLo, fHi: spec.fHi
        }).process(r.chans[0]);
        const chunk = Math.round(r.cfg.fs * 0.5);
        for (let p = 0; p < y.length; p += chunk) {
          rx.feed([y.subarray(p, Math.min(p + chunk, y.length))]);
          await tick();
        }
        log(`${label} @ ${mode.toUpperCase()}, SNR ${snr} dB, ${ppm} ppm: ` +
            (done === true ? "PASS — file intact" : "FAIL"));
      }
      log("done");
    }
  };

  const HOST = (typeof HRWS !== "undefined" && HRWS)
    || (typeof window !== "undefined" ? window.HRWS : null);
  if (HOST) HOST.registerModule(def);

  /* headless test hook */
  window.__QAMLINK_TEST__ = {
    PROFILES, MODES, MODE_BITS, makeConfig,
    QAM, StreamResampler, StreamChannel, OFDM, FrameBuilder, Demod,
    rsEncodeBlock, rsDecodeBlock, fecEncode, fecDecode, scramble,
    crc32, crc16, bytesToBits, bitsToBytes, pnBits,
    packHeader, unpackHeader,
    buildBeaconPayload, parseBeaconPayload,
    buildMetaPayload, parseMetaPayload,
    renderTransmission, RxSession, QamRx,
    wavEncode16, wavDecode, fft,
    FT_DATA, FT_BEACON, FT_META, FT_EOF
  };
})();



