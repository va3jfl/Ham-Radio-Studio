/* ============================================================
   Ham Radio Web Studio — VLF Radio module
   The soundcard IS the radio down here. Below ~24 kHz (or up to
   ~96 kHz on a 192 k interface) a sound card samples actual
   radio spectrum: plug a coil of wire into line-in and you are
   receiving — submarine MSK giants, Alpha navigation, time
   stations, sferics from thunderstorms half a world away, and
   on special days SAQ Grimeton's 17.2 kHz Alexanderson
   alternator, radio's living steam engine.

   RX: full-band spectrum + waterfall of the input, click to
   tune. A software down-converter (NCO → I/Q low-pass → remix)
   gives CW (with BFO pitch), USB, LSB and AM in a selectable
   bandwidth, played live to your speakers. A mains-hum comb
   (one delay-line subtraction notches EVERY 50/60 Hz harmonic
   at once) makes coil audio listenable.

   TX: the sound card + a coil is a magnetic-induction
   transmitter. Carrier, CW keyer and QRSS (1–60 s dots) at any
   frequency the card can make. Physics is honest: induction
   falls as 1/r³ — across the room with a bare card, farther
   with an amplifier and a serious loop; dedicated builders have
   bridged a kilometre or two. Below 9 kHz is internationally
   unallocated spectrum (check your local rules), which is why
   the "Dreamer's Band" lives at 8.97 kHz.
   ============================================================ */
"use strict";

(function () {

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /* Reference signals a coil + soundcard can actually meet.
     Schedules and status vary — treat as a map, not a promise. */
  const STATIONS = [
    { f: 8970,   bw: 200,  mode: "CW",  name: "Dreamer's Band 8.97",  note: "sub-9 kHz amateur experiments — unallocated spectrum" },
    { f: 11905,  bw: 500,  mode: "USB", name: "Alpha 11.905 (RU)",    note: "RSDN-20 navigation pulses" },
    { f: 12649,  bw: 500,  mode: "USB", name: "Alpha 12.649 (RU)",    note: "RSDN-20 navigation pulses" },
    { f: 14881,  bw: 500,  mode: "USB", name: "Alpha 14.881 (RU)",    note: "RSDN-20 navigation pulses" },
    { f: 17200,  bw: 200,  mode: "CW",  name: "SAQ 17.2 (SE)",        note: "Grimeton Alexanderson alternator — scheduled heritage CW" },
    { f: 19580,  bw: 300,  mode: "USB", name: "GBZ 19.58 (UK)",       note: "MSK" },
    { f: 20270,  bw: 300,  mode: "USB", name: "ICV 20.27 (IT)",       note: "MSK" },
    { f: 20900,  bw: 300,  mode: "USB", name: "FTA 20.9 (FR)",        note: "MSK" },
    { f: 21750,  bw: 300,  mode: "USB", name: "HWU 21.75 (FR)",       note: "MSK" },
    { f: 22100,  bw: 300,  mode: "USB", name: "GQD 22.1 (UK)",        note: "MSK — Skelton" },
    { f: 23400,  bw: 300,  mode: "USB", name: "DHO38 23.4 (DE)",      note: "MSK — off-air window daily" },
    { f: 24000,  bw: 300,  mode: "USB", name: "NAA 24.0 (US)",        note: "MSK — Cutler, Maine" },
    { f: 24800,  bw: 300,  mode: "USB", name: "NLK 24.8 (US)",        note: "MSK — Jim Creek" },
    { f: 25200,  bw: 300,  mode: "USB", name: "NML 25.2 (US)",        note: "MSK — LaMoure" },
    { f: 37500,  bw: 300,  mode: "USB", name: "TFK/NRK 37.5 (IS)",    note: "MSK — Grindavík" },
    { f: 40000,  bw: 100,  mode: "CW",  name: "JJY 40 (JP)",          note: "time signal" },
    { f: 60000,  bw: 100,  mode: "CW",  name: "MSF / WWVB / JJY 60",  note: "time signals (UK / US / JP)" },
    { f: 66666,  bw: 100,  mode: "CW",  name: "RBU 66.66 (RU)",       note: "time signal" },
    { f: 77500,  bw: 100,  mode: "CW",  name: "DCF77 77.5 (DE)",      note: "time signal" }
  ];

  const MORSE = {
    A:".-",B:"-...",C:"-.-.",D:"-..",E:".",F:"..-.",G:"--.",H:"....",I:"..",J:".---",
    K:"-.-",L:".-..",M:"--",N:"-.",O:"---",P:".--.",Q:"--.-",R:".-.",S:"...",T:"-",
    U:"..-",V:"...-",W:".--",X:"-..-",Y:"-.--",Z:"--..","0":"-----","1":".----",
    "2":"..---","3":"...--","4":"....-","5":".....","6":"-....","7":"--...","8":"---..",
    "9":"----.","/":"-..-.","?":"..--..",".":".-.-.-",",":"--..--","=":"-...-"
  };

  /* ============================================================
     VLFDSP-BEGIN — pure DSP core (Node-testable)
     ============================================================ */
  class VlfBiquad {
    /* RBJ low-pass */
    constructor(fs, fc, q) { this.set(fs, fc, q); this.x1=0; this.x2=0; this.y1=0; this.y2=0; }
    set(fs, fc, q) {
      fc = clamp(fc, 1, fs * 0.49);
      const w = 2 * Math.PI * fc / fs, cw = Math.cos(w), sw = Math.sin(w);
      const al = sw / (2 * q), a0 = 1 + al;
      this.b0 = ((1 - cw) / 2) / a0; this.b1 = (1 - cw) / a0; this.b2 = this.b0;
      this.a1 = (-2 * cw) / a0;      this.a2 = (1 - al) / a0;
    }
    reset() { this.x1=this.x2=this.y1=this.y2=0; }
    run(x) {
      const y = this.b0*x + this.b1*this.x1 + this.b2*this.x2 - this.a1*this.y1 - this.a2*this.y2;
      this.x2=this.x1; this.x1=x; this.y2=this.y1; this.y1=y;
      return y;
    }
  }

  /* One delay-line subtraction notches EVERY harmonic of the mains
     frequency at once: H(z) = (1 − a·z^-T)/…, T = fs / mains. */
  class VlfHumComb {
    constructor(fs, mains, depth = 0.97) { this.setup(fs, mains, depth); }
    setup(fs, mains, depth) {
      this.T = Math.max(2, Math.round(fs / mains));
      this.a = clamp(depth, 0, 1);
      this.buf = new Float32Array(this.T);
      this.p = 0;
    }
    run(x) {
      const d = this.buf[this.p];
      this.buf[this.p] = x;
      this.p = (this.p + 1) % this.T;
      return (x - this.a * d) * 0.55;     // tame the +6 dB comb peaks
    }
  }

  /* The receiver: NCO complex mix → 4th-order Butterworth I/Q
     low-pass → remix to audio. Modes:
       CW  : NCO at f0,          remix at pitch (a BFO)
       USB : NCO at f0 + bw/2,   remix at +bw/2, opposite sideband
             rejected by the low-pass — true single-sideband
       LSB : NCO at f0 − bw/2,   conjugate remix
       AM  : NCO at f0, magnitude, DC-blocked
  */
  class VlfDemod {
    constructor(fs) {
      this.fs = fs;
      this.mode = "CW"; this.f0 = 17200; this.bw = 200; this.pitch = 700;
      /* 12th-order Butterworth per rail (6 sections): sideband
         rejection in a Weaver demodulator IS this skirt. Q ladder for
         N=12: 1/(2·cos((2k−1)π/24)). */
      this.Qs = [0.5043, 0.5412, 0.6302, 0.8213, 1.3066, 3.8306];
      this.fi = this.Qs.map(q => new VlfBiquad(fs, 100, q));
      this.fq = this.Qs.map(q => new VlfBiquad(fs, 100, q));
      this.dc = 0;
      this._retune();
      this.pw = 0;                        // smoothed passband power
    }
    tune(f0, bw, mode, pitch) {
      this.f0 = clamp(f0, 30, this.fs * 0.49);
      this.bw = clamp(bw, 20, 6000);
      this.mode = mode; this.pitch = clamp(pitch || 700, 100, 2000);
      this._retune();
    }
    _retune() {
      const half = this.bw / 2;
      let fNco = this.f0, fMix = this.pitch, cut = half, s = 1;
      if (this.mode === "USB") { fNco = this.f0 + half; fMix = half; s = 1; }
      else if (this.mode === "LSB") { fNco = this.f0 - half; fMix = half; s = -1; }
      else if (this.mode === "AM") { fNco = this.f0; fMix = 0; s = 1; cut = half; }
      else { /* CW */ fNco = this.f0; fMix = this.pitch; s = 1; cut = Math.max(40, half); }
      this.s = s;
      // NCO as a rotating phasor: one complex multiply per sample
      const wN = 2 * Math.PI * fNco / this.fs;
      this.ncoStepR = Math.cos(wN); this.ncoStepI = -Math.sin(wN);
      this.ncoR = 1; this.ncoI = 0;
      const wM = 2 * Math.PI * fMix / this.fs;
      this.mixStepR = Math.cos(wM); this.mixStepI = Math.sin(wM);
      this.mixR = 1; this.mixI = 0;
      const cutEff = Math.max(30, cut * 0.9);   // slight trim pushes the image deeper into the skirt
      for (let i = 0; i < this.Qs.length; i++) {
        this.fi[i].set(this.fs, cutEff, this.Qs[i]); this.fi[i].reset();
        this.fq[i].set(this.fs, cutEff, this.Qs[i]); this.fq[i].reset();
      }
      this._norm = 0;
    }
    /* in: Float32 block (real). out: Float32 audio block, same length. */
    process(inp) {
      const n = inp.length, out = new Float32Array(n);
      let nr = this.ncoR, ni = this.ncoI;
      const sr = this.ncoStepR, si = this.ncoStepI;
      let mr = this.mixR, mi = this.mixI;
      const tr = this.mixStepR, ti = this.mixStepI;
      const am = this.mode === "AM", sgn = this.s;
      let pw = this.pw;
      for (let k = 0; k < n; k++) {
        const x = inp[k];
        // complex mix down
        let I = x * nr, Q = x * ni;
        const nR = nr * sr - ni * si, nI = nr * si + ni * sr; nr = nR; ni = nI;
        // I/Q low-pass (12th-order Butterworth)
        for (let s2 = 0; s2 < 6; s2++) { I = this.fi[s2].run(I); Q = this.fq[s2].run(Q); }
        pw += (I * I + Q * Q - pw) * 0.0005;
        let a;
        if (am) {
          const mag = Math.sqrt(I * I + Q * Q);
          this.dc += (mag - this.dc) * 0.0004;
          a = (mag - this.dc) * 2;
        } else {
          a = 2 * (I * mr - sgn * Q * mi);
          const mR = mr * tr - mi * ti, mI = mr * ti + mi * tr; mr = mR; mi = mI;
        }
        out[k] = a;
      }
      // renormalize the phasors (they drift a hair per million samples)
      let g = 1 / Math.sqrt(nr * nr + ni * ni); nr *= g; ni *= g;
      g = 1 / Math.sqrt(mr * mr + mi * mi); mr *= g; mi *= g;
      this.ncoR = nr; this.ncoI = ni; this.mixR = mr; this.mixI = mi;
      this.pw = pw;
      return out;
    }
    bandDb() { return this.pw > 1e-12 ? 10 * Math.log10(this.pw) : -120; }
  }
  /* ---- Time-station decoding (DCF77 · MSF · WWVB) ----
     All three drop carrier amplitude at the top of every second; the
     drop's LENGTH is the bit. We envelope-detect at 1 kHz, PLL onto
     the second edges, classify widths, and assemble the minute frame
     at the marker. */
  const TIME_PROTO = {
    DCF77: { f: 77500, kind: "dcf" },
    MSF:   { f: 60000, kind: "msf" },
    WWVB:  { f: 60000, kind: "wwvb" }
  };

  class VlfTimeRx {
    constructor(fs, proto, onEvent) {
      this.fs = fs; this.kind = TIME_PROTO[proto].kind; this.f0 = TIME_PROTO[proto].f;
      this.proto = proto; this.ev = onEvent || (() => {});
      const w = 2 * Math.PI * this.f0 / fs;
      this.sr = Math.cos(w); this.si = -Math.sin(w); this.nr = 1; this.ni = 0;
      this.al = 1 - Math.exp(-2 * Math.PI * 40 / fs);   // 40 Hz envelope LPF
      this.I = 0; this.Q = 0;
      this.dec = Math.round(fs / 1000);                 // → 1 kHz envelope
      this.acc = 0; this.k = 0; this.n = 0;
      this.env = new Float32Array(4000); this.ep = 0;   // ring, 4 s
      this.hi = 1e-6; this.lo = 0;
      this.state = 1; this.edgeN = -1;                  // carrier state, last fall (ms idx)
      this.ms = 0;                                       // envelope-sample counter (1 kHz)
      this.secStart = -1; this.lowRuns = [];             // low intervals within current second
      this.bits = []; this.locked = 0;
      this.decoded = null; this.status = "listening for second pulses…";
    }
    process(block) {
      let nr = this.nr, ni = this.ni, I = this.I, Q = this.Q;
      const sr = this.sr, si = this.si, al = this.al;
      for (let i = 0; i < block.length; i++) {
        const x = block[i];
        I += (x * nr - I) * al; Q += (x * ni - Q) * al;
        const tR = nr * sr - ni * si; ni = nr * si + ni * sr; nr = tR;
        this.acc += Math.sqrt(I * I + Q * Q);
        if (++this.k === this.dec) {
          this._ms(this.acc / this.dec); this.acc = 0; this.k = 0;
        }
        this.n++;
      }
      const g = 1 / Math.sqrt(nr * nr + ni * ni);
      this.nr = nr * g; this.ni = ni * g; this.I = I; this.Q = Q;
    }
    _ms(v) {
      const t = this.ms++;
      this.env[this.ep] = v; this.ep = (this.ep + 1) % this.env.length;
      this.hi = Math.max(v, this.hi * 0.99995);
      this.lo = Math.min(v, this.lo * 1.0002 + this.hi * 1e-5);
      const thr = this.lo + (this.hi - this.lo) * 0.55;
      const s = v > thr ? 1 : 0;
      if (this.state === 1 && s === 0) {                 // falling edge
        const since = this.secStart >= 0 ? t - this.secStart : 1e9;
        if (since > 700) {                               // genuine second boundary
          if (this.secStart >= 0) this._second(this.secStart, t);
          this.secStart = t;
        }                                                // else: intra-second drop (MSF B-window)
        this._fall = t;
      } else if (this.state === 0 && s === 1 && this._fall >= 0) {
        this.lowRuns.push([this._fall - this.secStart, t - this._fall]);
        this._fall = -1;
      }
      this.state = s;
      // long silence with carrier high → DCF minute gap handled in _second
      if (this.secStart >= 0 && t - this.secStart > 2600) {   // lost it
        this.secStart = -1; this.lowRuns = []; this.locked = 0;
        this.status = "carrier lost — listening…";
      }
    }
    /* one elapsed second: classify its low pulses */
    _second(t0, t1) {
      const dur = t1 - t0;
      const runs = this.lowRuns; this.lowRuns = [];
      const near = (x, c, tol) => Math.abs(x - c) <= tol;
      let sym = null;                                    // {bit} | {mark} | {a,b}
      if (this.kind === "dcf") {
        const r0 = runs.find(r => r[0] < 60);
        if (dur > 1600 && dur < 2400) {                  // missing 59th drop
          sym = { minuteGap: true, bit: r0 ? (near(r0[1], 200, 60) ? 1 : 0) : 0 };
        } else if (r0) sym = { bit: near(r0[1], 200, 60) ? 1 : (near(r0[1], 100, 55) ? 0 : null) };
      } else if (this.kind === "wwvb") {
        const r0 = runs.find(r => r[0] < 60);
        if (r0) {
          if (near(r0[1], 800, 130)) sym = { mark: true };
          else if (near(r0[1], 500, 120)) sym = { bit: 1 };
          else if (near(r0[1], 200, 90)) sym = { bit: 0 };
        }
      } else {                                            // msf
        let a = 0, b = 0, mk = false;
        for (const [off, len] of runs) {
          if (off < 60 && len > 380) mk = true;           // 500 ms minute pulse
          const lowIn = (w0, w1) => (off < w1 && off + len > w0 + 40);
          if (lowIn(100, 200)) a = 1;
          if (lowIn(200, 300)) b = 1;
        }
        sym = mk ? { mark: true } : { a, b };
      }
      this.ev({ type: "second", t0, sym });
      this._assemble(sym, t0);
    }
    _assemble(sym, t0) {
      if (!sym) { this.bits.push(null); return; }
      const K = this.kind;
      const minuteMark = (K === "dcf" && sym.minuteGap) ||
                         (K !== "dcf" && sym.mark && this._lastMark === false && K === "wwvb"
                            ? this._wwvbDouble : false) ||
                         (K === "msf" && sym.mark);
      if (K === "wwvb") {                                 // P0(:59) then Pr(:00) = minute
        if (sym.mark && this._prevWasMark) {
          const fr = this.bits.slice(-60);                 // [:00 … :59] of the ended minute
          this.bits = [sym];                               // new frame starts with this :00
          this._prevWasMark = false;
          this.locked = 1;
          const d = this._parse60(fr);
          if (d) { this.decoded = d; this.decoded.edgeMs = t0; this.status = "minute decoded — " + d.text; }
          else this.status = "minute marker found — collecting a full frame…";
          this.ev({ type: "minute", t0, decoded: d });
          return;
        }
        this._prevWasMark = !!sym.mark;
        this.bits.push(sym);
        if (this.bits.length > 130) this.bits.splice(0, this.bits.length - 130);
        if (!this.locked) this.status = "hearing seconds — waiting for a minute marker…";
        return;
      }
      if (K === "dcf" && sym.minuteGap) {                  // gap sym IS second :58 — frame first…
        this.bits.push(sym);
        this._minute(t0);
        return;
      }
      if (minuteMark) this._minute(t0);
      this.bits.push(sym);
      if (this.bits.length > 130) this.bits.splice(0, this.bits.length - 130);
      if (!this.locked) this.status = "hearing seconds — waiting for a minute marker…";
    }
    _minute(t0) {
      // the PREVIOUS 59-60 symbols are the frame that just ended
      const need = this.kind === "msf" ? 59 : 59;
      const fr = this.bits.slice(-need);
      this.bits = [];
      this.locked = 1;
      const d = this._parse(fr);
      if (d) { this.decoded = d; this.decoded.edgeMs = t0; this.status = "minute decoded — " + d.text; }
      else this.status = "minute marker found — collecting a full frame…";
      this.ev({ type: "minute", t0, decoded: d });
    }
    edgeDelta() { return this.kind === "wwvb" ? 60000 : 0; }   // WWVB frame = its own minute
    _parse60(fr) {
      if (fr.length < 60) return null;
      const bit = (i) => (fr[i] && fr[i].bit !== undefined && fr[i].bit !== null) ? fr[i].bit : null;
      const bcd = (idx, wts) => { let v = 0, ok = true;
        idx.forEach((i, j) => { const b = bit(i); if (b === null) ok = false; else v += b * wts[j]; });
        return ok ? v : null; };
      const min = bcd([1,2,3,5,6,7,8],[40,20,10,8,4,2,1]);
      const hr  = bcd([12,13,15,16,17,18],[20,10,8,4,2,1]);
      const doy = bcd([22,23,25,26,27,28,30,31,32,33],[200,100,80,40,20,10,8,4,2,1]);
      const yr  = bcd([45,46,47,48,50,51,52,53],[80,40,20,10,8,4,2,1]);
      if (min === null || hr === null || doy === null || yr === null) return null;
      const utcMs = Date.UTC(2000 + yr, 0, 1) + (doy - 1) * 86400000 + hr * 3600000 + min * 60000;
      return { proto: "WWVB", parity: true, utcMs,
               text: `WWVB ${String(hr).padStart(2,"0")}:${String(min).padStart(2,"0")} UTC · day ${doy} · 20${String(yr).padStart(2,"0")}` };
    }
    _parse(fr) {
      const bit = (i) => (fr[i] && fr[i].bit !== undefined && fr[i].bit !== null) ? fr[i].bit : null;
      const bcd = (idx, wts) => { let v = 0, ok = true;
        idx.forEach((i, j) => { const b = bit(i); if (b === null) ok = false; else v += b * wts[j]; });
        return ok ? v : null; };
      const par = (idx, p) => { let s = 0, ok = true;
        idx.forEach(i => { const b = bit(i); if (b === null) ok = false; else s ^= b; });
        const pb = bit(p); return ok && pb !== null ? (s === pb) : false; };
      if (fr.length < 55) return null;
      if (this.kind === "dcf") {
        if (bit(20) !== 1) return null;
        const min = bcd([21,22,23,24,25,26,27],[1,2,4,8,10,20,40]);
        const hr  = bcd([29,30,31,32,33,34],[1,2,4,8,10,20]);
        const day = bcd([36,37,38,39,40,41],[1,2,4,8,10,20]);
        const mon = bcd([45,46,47,48,49],[1,2,4,8,10]);
        const yr  = bcd([50,51,52,53,54,55,56,57],[1,2,4,8,10,20,40,80]);
        const cest = bit(17) === 1;
        const pOK = par([21,22,23,24,25,26,27],28) && par([29,30,31,32,33,34],35) &&
                    par([36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57],58);
        if (min === null || hr === null || !pOK) return null;
        const utcMs = Date.UTC(2000 + yr, mon - 1, day, hr, min) - (cest ? 2 : 1) * 3600000;
        return { proto: "DCF77", parity: true, utcMs,
                 text: `DCF77 ${String(hr).padStart(2,"0")}:${String(min).padStart(2,"0")} ` +
                       `${String(day).padStart(2,"0")}.${String(mon).padStart(2,"0")}.${2000+yr} ` +
                       (cest ? "CEST" : "CET") };
      }
      if (this.kind === "wwvb") return null;              // handled via _parse60
      if (false) {
        const min = bcd([1,2,3,5,6,7,8],[40,20,10,8,4,2,1]);
        const hr  = bcd([12,13,15,16,17,18],[20,10,8,4,2,1]);
        const doy = bcd([22,23,25,26,27,28,30,31,32,33],[200,100,80,40,20,10,8,4,2,1]);
        const yr  = bcd([45,46,47,48,50,51,52,53],[80,40,20,10,8,4,2,1]);
        if (min === null || hr === null || doy === null || yr === null) return null;
        const jan1 = Date.UTC(2000 + yr, 0, 1);
        const utcMs = jan1 + (doy - 1) * 86400000 + hr * 3600000 + min * 60000;
        return { proto: "WWVB", parity: true, utcMs,
                 text: `WWVB ${String(hr).padStart(2,"0")}:${String(min).padStart(2,"0")} UTC · day ${doy} · 20${String(yr).padStart(2,"0")}` };
      }
      // MSF: A bits carry the data
      const A = (i) => (fr[i] && fr[i].a !== undefined) ? fr[i].a : null;
      const B = (i) => (fr[i] && fr[i].b !== undefined) ? fr[i].b : null;
      const abcd = (i0, wts) => { let v = 0, ok = true;
        wts.forEach((wt, j) => { const b = A(i0 + j); if (b === null) ok = false; else v += b * wt; });
        return ok ? v : null; };
      // frame slice starts at second 1 → index 0 here is second 1
      const off = -1;
      const yr  = abcd(17 + off, [80,40,20,10,8,4,2,1]);
      const mon = abcd(25 + off, [10,8,4,2,1]);
      const day = abcd(30 + off, [20,10,8,4,2,1]);
      const hr  = abcd(39 + off, [20,10,8,4,2,1]);
      const min = abcd(45 + off, [40,20,10,8,4,2,1]);
      const bst = B(58 + off);
      if (min === null || hr === null) return null;
      const utcMs = Date.UTC(2000 + (yr || 0), (mon || 1) - 1, day || 1, hr, min) - (bst ? 1 : 0) * 3600000;
      return { proto: "MSF", parity: true, utcMs,
               text: `MSF ${String(hr).padStart(2,"0")}:${String(min).padStart(2,"0")} ` +
                     `${String(day).padStart(2,"0")}/${String(mon).padStart(2,"0")}/20${String(yr).padStart(2,"0")} ` +
                     (bst ? "BST" : "UTC") };
    }
  }

  /* DCF77 minute synthesizer (self-test + harness): builds the frame
     for the minute CONTAINING utcMs+60 s, per spec (time = next minute) */
  function dcfFrameFor(utcMs, cest) {
    const zone = cest ? 2 : 1;
    const d = new Date(utcMs + 60000 + zone * 3600000);   // local next-minute
    const bcdBits = (v, wts) => wts.map(w2 => (Math.floor(v / w2) % ((w2 === 1 || w2 === 10 || w2 === 100) ? 10 : 2) >= 1 ? 1 : 0));
    const enc = (v, wts) => { const out = []; let r = v;
      // classic BCD: split tens/units
      const tens = Math.floor(v / 10), units = v % 10;
      for (const w2 of wts) {
        if (w2 < 10) out.push((units >> Math.log2(w2)) & 1);
        else out.push((tens >> Math.log2(w2 / 10)) & 1);
      } return out; };
    const bits = new Array(59).fill(0);
    bits[16] = 0; bits[17] = cest ? 1 : 0; bits[18] = cest ? 0 : 1; bits[20] = 1;
    const put = (arr, at) => arr.forEach((b, i) => bits[at + i] = b);
    put(enc(d.getUTCMinutes(), [1,2,4,8,10,20,40]), 21);
    put(enc(d.getUTCHours(),   [1,2,4,8,10,20]), 29);
    put(enc(d.getUTCDate(),    [1,2,4,8,10,20]), 36);
    put(enc(((d.getUTCDay() + 6) % 7) + 1, [1,2,4]), 42);
    put(enc(d.getUTCMonth() + 1, [1,2,4,8,10]), 45);
    put(enc(d.getUTCFullYear() % 100, [1,2,4,8,10,20,40,80]), 50);
    const px = (a, b2) => { let s = 0; for (let i = a; i <= b2; i++) s ^= bits[i]; return s; };
    bits[28] = px(21,27); bits[35] = px(29,34); bits[58] = px(36,57);
    return bits;
  }
  function dcfSynth(bits, fs, f0, amp = 0.5) {
    const n = Math.round(60 * fs);
    const y = new Float32Array(n);
    const w = 2 * Math.PI * f0 / fs;
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const tMs = i / fs * 1000;
      const sec = Math.floor(tMs / 1000), inMs = tMs - sec * 1000;
      let a = amp;
      if (sec < 59) { const drop = bits[sec] ? 200 : 100; if (inMs < drop) a = amp * 0.15; }
      ph += w; y[i] = a * Math.sin(ph);
    }
    return y;
  }
  /* ---- QRSS grabber core: NCO mix → 12th-order LPF → decimate →
          long Hann FFT. Sub-hertz bins turn minutes of listening into
          one readable picture — the grabber, QRSS culture's artifact. */
  class QrssGrab {
    constructor(fs, f0, span, res, onRow) {
      this.fs = fs; this.f0 = f0; this.span = span; this.onRow = onRow;
      this.M = Math.max(1, Math.round(fs / Math.max(64, span * 2.6)));
      this.rate = fs / this.M;
      const w = 2 * Math.PI * f0 / fs;
      this.cr = Math.cos(w); this.ci = -Math.sin(w); this.pr = 1; this.pi = 0;
      const Qs = [0.5043, 0.5412, 0.6302, 0.8213, 1.3066, 3.8306];
      this.fi = Qs.map(q => new VlfBiquad(fs, span * 0.62, q));
      this.fq = Qs.map(q => new VlfBiquad(fs, span * 0.62, q));
      this.N = Math.min(8192, Math.max(64, Math.pow(2, Math.round(Math.log2(this.rate / res)))));
      this.res = this.rate / this.N;
      this.bufR = new Float32Array(this.N); this.bufI = new Float32Array(this.N);
      this.bp = 0; this.filled = 0; this.decCnt = 0; this.hopCnt = 0; this.hopLen = this.rate | 0;
      this.win = new Float32Array(this.N);
      for (let i = 0; i < this.N; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / this.N);
      this.nBins = 2 * Math.floor(this.span / 2 / this.res) + 1;
    }
    setHop(sec) { this.hopLen = Math.max(1, Math.round(sec * this.rate)); }
    process(x) {
      let pr = this.pr, pi = this.pi;
      for (let i = 0; i < x.length; i++) {
        const s = x[i];
        let I = s * pr, Q = s * pi;
        const nr = pr * this.cr - pi * this.ci; pi = pr * this.ci + pi * this.cr; pr = nr;
        for (let k = 0; k < 6; k++) { I = this.fi[k].run(I); Q = this.fq[k].run(Q); }
        if (++this.decCnt === this.M) {
          this.decCnt = 0;
          this.bufR[this.bp] = I; this.bufI[this.bp] = Q;
          this.bp = (this.bp + 1) % this.N;
          if (this.filled < this.N) this.filled++;
          if (++this.hopCnt >= this.hopLen && this.filled >= this.N) {
            this.hopCnt = 0; this._spectrum();
          }
        }
      }
      const g = 1 / Math.sqrt(pr * pr + pi * pi); this.pr = pr * g; this.pi = pi * g;
    }
    _spectrum() {
      const N = this.N, re = new Float64Array(N), im = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        const j = (this.bp + i) % N;
        re[i] = this.bufR[j] * this.win[i]; im[i] = this.bufI[j] * this.win[i];
      }
      DSP.fft(re, im);
      const half = (this.nBins - 1) / 2, row = new Float32Array(this.nBins);
      for (let b = 0; b < this.nBins; b++) {
        let k = b - half; if (k < 0) k += N;
        row[b] = re[k] * re[k] + im[k] * im[k];
      }
      this.onRow(row, this.res, this.f0 - half * this.res);
    }
  }
  /* ---- Natural radio: sferics, tweeks, whistlers ---- */
  class VlfNatRx {
    constructor(fs, onEvent) {
      this.fs = fs; this.ev = onEvent || (() => {});
      this.hp = new VlfBiquad(fs, 300, 0.707); this._hpMode = "hp";
      // convert biquad to HP by spectral trick: y = x - LP(x)
      this.lp = new VlfBiquad(fs, Math.min(12000, fs * 0.45), 0.707);
      const mk = (f, bw) => { const w = 2 * Math.PI * f / fs;
        return { sr: Math.cos(w), si: -Math.sin(w), nr: 1, ni: 0,
                 al: 1 - Math.exp(-2 * Math.PI * bw / fs), I: 0, Q: 0 }; };
      this.bH = mk(6800, 1800); this.bL = mk(1800, 700);
      this.dec = Math.max(1, Math.round(fs / 1000)); this.k = 0;
      this.aW = 0; this.aH = 0; this.aL = 0;
      this.base = 1e-4; this.bH2 = 1e-5; this.bL2 = 1e-5;
      this.state = 0; this.t0 = 0; this.ms = 0; this.pk = 0;
      this.hiHist = new Float32Array(1500); this.hp2 = 0;   // 1.5 s of hi-band env
      this.loRun = 0; this.lastW = -9e9;
      this.counts = { sferic: 0, tweek: 0, whistler: 0 };
    }
    _band(b, x) {
      b.I += (x * b.nr - b.I) * b.al; b.Q += (x * b.ni - b.Q) * b.al;
      const t = b.nr * b.sr - b.ni * b.si; b.ni = b.nr * b.si + b.ni * b.sr; b.nr = t;
      return Math.sqrt(b.I * b.I + b.Q * b.Q);
    }
    process(block) {
      for (let i = 0; i < block.length; i++) {
        const x = block[i] - this.lp.run(block[i]) + this.lp.run(0) * 0; // wideband via raw
        const w = block[i];
        this.aW += Math.abs(w);
        this.aH += this._band(this.bH, w);
        this.aL += this._band(this.bL, w);
        if (++this.k < this.dec) continue;
        this.k = 0; const t = this.ms++;
        const eW = this.aW / this.dec, eH = this.aH / this.dec, eL = this.aL / this.dec;
        this.aW = this.aH = this.aL = 0;
        this.base += (Math.min(eW, this.base * 3) - this.base) * 0.002;
        this.bH2 += (Math.min(eH, this.bH2 * 3) - this.bH2) * 0.002;
        this.bL2 += (Math.min(eL, this.bL2 * 3) - this.bL2) * 0.002;
        this.hiHist[t % 1500] = eH;
        // impulse machine
        if (this.state === 0 && eW > this.base * 4.5) { this.state = 1; this.t0 = t; this.pk = eW; }
        else if (this.state === 1) {
          if (eW > this.pk) this.pk = eW;
          if (eW < this.base * 2.2) {
            const dur = t - this.t0, db = 20 * Math.log10(this.pk / this.base);
            this.state = 0;
            if (dur <= 4) { this.counts.sferic++; this.ev({ type: "sferic", t, dur, db }); }
            else if (dur <= 60) { this.counts.tweek++; this.ev({ type: "tweek", t, dur, db }); }
          } else if (t - this.t0 > 120) this.state = 0;
        }
        // whistler: sustained low-band rise preceded by hi-band pulse
        if (eL > this.bL2 * 3.2) this.loRun++; else this.loRun = 0;
        if (this.loRun === 260 && t - this.lastW > 2500) {
          let hiPk = 0, tau = 0;
          for (let d = 150; d <= 1200; d++) {
            const v = this.hiHist[(t - 260 - d + 3000) % 1500];
            if (v > hiPk) { hiPk = v; tau = d; }
          }
          if (hiPk > this.bH2 * 3.5) {
            this.lastW = t; this.counts.whistler++;
            this.ev({ type: "whistler", t, tau, db: 20 * Math.log10(hiPk / this.bH2) });
          }
        }
      }
    }
  }
  /* VLFDSP-END */

  /* ---- tiny gapless local player (own path to the speakers, so
          RX monitoring never lights the TX system) ---- */
  class VlfOut {
    constructor(actx, dest) {
      this.ctx = actx;
      this.gain = actx.createGain(); this.gain.gain.value = 0.8;
      this.gain.connect(dest || actx.destination);
      this.when = 0; this.lead = 0.2;
    }
    push(chunk, rate) {
      if (!chunk.length) return;
      const buf = this.ctx.createBuffer(1, chunk.length, rate);
      buf.getChannelData(0).set(chunk);
      const src = this.ctx.createBufferSource();
      src.buffer = buf; src.connect(this.gain);
      const now = this.ctx.currentTime;
      if (this.when < now + 0.03) {
        this.when = now + this.lead;                 // adaptive cushion:
        this.lead = Math.min(0.45, this.lead + 0.05); // deepen on underrun
      }
      src.start(this.when);
      this.when += chunk.length / rate;
      src.onended = () => { try { src.disconnect(); } catch (e) {} };
    }
    setVolume(v) { this.gain.gain.value = v; }
  }

  /* ============================================================ */
  const def = {
    id: "vlf",

    init(ctx) {
      this.ctx = ctx;
      this.ui = null;
      this.demod = null;
      this.comb = null;
      this.out = null;
      this.mainsHz = 0;             // 0 = comb off
      this.listening = false;
      this.showStations = true;
      this.avg = null;              // spectrum averaging buffer
      this.holdMax = null;
      this.rx = { f0: 17200, bw: 200, mode: "CW", pitch: 700 };
      this.tx = { f: 8970, mode: "carrier", wpm: 12, qrss: 3,
                  text: "CQ CQ DE " + (ctx.settings().callsign || "N0CALL") };
      this.keyer = null;
      this._txTimers = [];
      this.timeOn = false; this.timeRx = null; this.timeProto = "DCF77";
      this._tsWall = { ms: 0, wall: Date.now() };
      this.qgOn = false; this.qg = null; this.qgX = 0;
      this.nrOn = false; this.nr = null; this.nrLog = [];
      this._unsub = ctx.audio.onSamples((a, sr) => this._feed(a, sr));
      ctx.log("VLF Radio ready — a coil on line-in is a real antenna down here. Start audio and look at the whole band.");
    },

    _ensureChain(sr) {
      if (!this.demod || this.demod.fs !== sr) {
        this.demod = new VlfDemod(sr);
        this.demod.tune(this.rx.f0, this.rx.bw, this.rx.mode, this.rx.pitch);
        this.comb = this.mainsHz ? new VlfHumComb(sr, this.mainsHz) : null;
      }
      if (!this.out) {
        const actx = this.ctx.audio.ensureContext();
        this.out = new VlfOut(actx);
      }
    },

    _feed(block, sr) {
      this._ensureChain(sr);
      let x = block;
      if (this.comb) {
        const y = new Float32Array(block.length);
        for (let i = 0; i < block.length; i++) y[i] = this.comb.run(block[i]);
        x = y;
      }
      if (this.timeOn) {
        if (!this.timeRx || this.timeRx.fs !== sr || this.timeRx.proto !== this.timeProto)
          this._tsMake(sr);
        this.timeRx.process(x);
        this._tsWall = { ms: this.timeRx.ms, wall: Date.now() };
      }
      if (this.nrOn) {
        if (!this.nr || this.nr.fs !== sr) this.nr = new VlfNatRx(sr, (e) => this._nrEvent(e));
        this.nr.process(x);
      }
      if (this.qgOn && this.qg) {
        if (this.qg.fs !== sr) this._qgStart();          // device rate changed
        else this.qg.process(x);
      }
      this._lastBlock = x; this._lastRate = sr;     // spectrum grabs this
      if (this.listening) {
        const audio = this.demod.process(x);
        this.out.push(audio, sr);
      } else {
        this.demod.process(x);                       // keep the meter live
      }
    },

    /* ---------------- panel ---------------- */
    createPanel(el) {
      el.innerHTML = `
      <style>
        .vlf-spec { width:100%; height:130px; display:block; background:var(--bg1,#0a0e14);
          border:1px solid var(--line,rgba(96,114,150,.22)); border-radius:8px 8px 0 0; cursor:crosshair; }
        .vlf-wf { width:100%; height:190px; display:block; background:#000;
          border:1px solid var(--line,rgba(96,114,150,.22)); border-top:none; border-radius:0 0 8px 8px; cursor:crosshair; }
        .vlf-ro { display:flex; gap:14px; flex-wrap:wrap; margin-top:8px; font-family:var(--font-mono); font-size:12px; color:var(--muted,#8b95a7); }
        .vlf-ro b { color:var(--amber,#ffb454); font-weight:600; }
        .vlf-seg { display:inline-flex; border:1px solid var(--line,rgba(96,114,150,.22)); border-radius:8px; overflow:hidden; }
        .vlf-seg .btn { border:none; border-radius:0; margin:0; }
        .vlf-meter { height:10px; background:rgba(255,255,255,.05); border-radius:5px; overflow:hidden; margin-top:6px; }
        .vlf-meter i { display:block; height:100%; width:0%; background:linear-gradient(90deg,#3ddc84,#ffb454,#ff5d5d); }
        .vlf-sta { max-height:330px; overflow-y:auto; }
        .vlf-sta button { display:block; width:100%; text-align:left; background:none; border:none; cursor:pointer;
          padding:6px 8px; border-radius:6px; color:var(--text,#d9dfea); font-family:var(--font-mono); font-size:12px; }
        .vlf-sta button:hover { background:rgba(255,180,84,.08); }
        .vlf-sta b { color:var(--amber,#ffb454); }
        .vlf-sta small { color:var(--muted,#8b95a7); display:block; font-size:10.5px; }
        .vlf-note { font-size:12px; line-height:1.55; color:var(--muted,#8b95a7); }
      </style>
      <div class="mod-layout">
        <div class="mod-main">
          <div class="card">
            <header class="card-head"><h3>VLF spectrum — the whole band your soundcard hears</h3>
              <span class="card-tag mono" id="vlf-range">0 – ? kHz</span></header>
            <div class="card-body">
              <canvas class="vlf-spec" id="vlf-spec" width="1000" height="130"></canvas>
              <canvas class="vlf-wf" id="vlf-wf" width="1000" height="190"></canvas>
              <div class="vlf-ro">
                <span>cursor <b id="vlf-cursor">—</b></span>
                <span>tuned <b id="vlf-tuned">—</b></span>
                <span>band power <b id="vlf-pw">—</b></span>
                <label class="mono" style="font-size:12px"><input type="checkbox" id="vlf-showsta" checked> station markers</label>
                <label class="mono" style="font-size:12px">avg <select id="vlf-avg"><option value="1">off</option><option value="4" selected>4</option><option value="16">16</option></select></label>
                <label class="mono" style="font-size:12px">device rate <select id="vlf-rate">
                  <option value="0">default</option><option value="96000">96 kHz (reload)</option><option value="192000">192 kHz (reload)</option></select></label>
              </div>
              <footer class="card-foot mono muted">Click anywhere to tune. Above ~23 kHz needs a 96/192 k soundcard — that's where the 40/60/77.5 kHz time stations live.</footer>
            </div>
          </div>

          <div class="card">
            <header class="card-head"><h3>Receiver</h3><span class="card-tag mono" id="vlf-rx-tag">CW · 200 Hz</span></header>
            <div class="card-body">
              <div class="mod-controls">
                <label class="field"><span>Center (Hz)</span>
                  <input type="number" id="vlf-f0" min="30" step="10" value="17200" style="width:110px"></label>
                <label class="field"><span>Mode</span>
                  <span class="vlf-seg">
                    <button class="btn btn-accent" data-m="CW">CW</button>
                    <button class="btn" data-m="USB">USB</button>
                    <button class="btn" data-m="LSB">LSB</button>
                    <button class="btn" data-m="AM">AM</button>
                  </span></label>
                <label class="field"><span>Bandwidth</span>
                  <select id="vlf-bw">
                    <option value="50">50 Hz</option><option value="100">100 Hz</option>
                    <option value="200" selected>200 Hz</option><option value="300">300 Hz</option>
                    <option value="500">500 Hz</option><option value="1000">1 kHz</option>
                    <option value="2400">2.4 kHz</option><option value="3000">3 kHz</option>
                    <option value="6000">6 kHz</option>
                  </select></label>
                <label class="field"><span>CW pitch <em id="vlf-pitch-val">700 Hz</em></span>
                  <input type="range" id="vlf-pitch" min="300" max="1200" step="10" value="700"></label>
                <label class="field"><span>Hum comb</span>
                  <select id="vlf-hum">
                    <option value="0">off</option><option value="60">60 Hz + harmonics</option>
                    <option value="50">50 Hz + harmonics</option>
                  </select></label>
                <label class="field"><span>Volume <em id="vlf-vol-val">80%</em></span>
                  <input type="range" id="vlf-vol" min="0" max="100" value="80"></label>
                <label class="field"><span>&nbsp;</span>
                  <button class="btn btn-accent" id="vlf-listen">▶ Listen</button></label>
              </div>
              <div class="vlf-meter"><i id="vlf-meter-i"></i></div>
              <footer class="card-foot mono muted">The hum comb is one trick that makes coil audio civilised: a single delay-line subtraction notches every mains harmonic at once. Whistlers and sferics live in AM/USB wide; carriers in CW narrow.</footer>
            </div>
          </div>

          <div class="card">
            <header class="card-head"><h3>Time-station decoder</h3><span class="card-tag mono" id="vlf-ts-tag">off</span></header>
            <div class="card-body">
              <div class="mod-controls">
                <label class="field"><span>Station</span>
                  <select id="vlf-ts-sta">
                    <option value="DCF77">DCF77 · 77.5 kHz (EU)</option>
                    <option value="MSF">MSF · 60 kHz (UK)</option>
                    <option value="WWVB">WWVB · 60 kHz (US)</option>
                  </select></label>
                <label class="field"><span>&nbsp;</span>
                  <button class="btn btn-accent" id="vlf-ts-go">Start</button></label>
                <label class="field"><span>&nbsp;</span>
                  <button class="btn" id="vlf-ts-self">Self-test</button></label>
              </div>
              <canvas id="vlf-ts-strip" width="960" height="26" style="width:100%;height:26px;margin-top:10px;border-radius:6px;background:rgba(255,255,255,.04)"></canvas>
              <div class="mono" id="vlf-ts-time" style="font-size:20px;color:var(--amber,#ffb454);margin-top:8px">— — : — —</div>
              <div class="mono muted" id="vlf-ts-off" style="font-size:12px"></div>
              <div class="mono muted" id="vlf-ts-status" style="font-size:12px;margin-top:2px">decoder off</div>
              <footer class="card-foot mono muted">One bit per second rides the carrier's amplitude; a full minute carries the date. Needs a 192 k device rate (96 k reaches JJY40 only). Offset honesty: the soundcard path adds ±0.2 s of its own latency.</footer>
            </div>
          </div>

          <div class="card">
            <header class="card-head"><h3>QRSS grabber</h3><span class="card-tag mono" id="vlf-qg-tag">off</span></header>
            <div class="card-body">
              <div class="mod-controls">
                <label class="field"><span>Center (Hz)</span>
                  <input type="number" id="vlf-qg-f" min="30" step="1" value="8970" style="width:100px"></label>
                <label class="field"><span>&nbsp;</span>
                  <button class="btn btn-mini" id="vlf-qg-rx">← RX</button></label>
                <label class="field"><span>Span</span>
                  <select id="vlf-qg-span"><option value="50">50 Hz</option><option value="100" selected>100 Hz</option>
                    <option value="200">200 Hz</option><option value="400">400 Hz</option></select></label>
                <label class="field"><span>Bins</span>
                  <select id="vlf-qg-res"><option value="1">1 Hz</option><option value="0.5" selected>0.5 Hz</option>
                    <option value="0.25">0.25 Hz</option></select></label>
                <label class="field"><span>Window</span>
                  <select id="vlf-qg-win"><option value="5" selected>5 min</option><option value="10">10 min</option>
                    <option value="20">20 min</option><option value="30">30 min</option></select></label>
                <label class="field"><span>Brightness <em id="vlf-qg-br-val"></em></span>
                  <input type="range" id="vlf-qg-br" min="-120" max="-50" value="-95"></label>
                <label class="field"><span>&nbsp;</span>
                  <button class="btn btn-accent" id="vlf-qg-go">Start</button></label>
                <label class="field"><span>&nbsp;</span>
                  <button class="btn" id="vlf-qg-save">Save PNG</button></label>
                <label class="mono muted" style="font-size:12px;align-self:flex-end"><input type="checkbox" id="vlf-qg-auto"> auto-grab</label>
              </div>
              <canvas id="vlf-qg-cv" width="1000" height="330" style="width:100%;margin-top:10px;border-radius:8px;background:#06090f"></canvas>
              <footer class="card-foot mono muted">Sub-hertz bins integrate minutes of signal into one picture — QRSS3 letters read like handwriting. Auto-grab saves a stamped PNG each full window, the classic grabber artifact. Watch 8.97 kHz, or your own QRSS TX from across the shack.</footer>
            </div>
          </div>

          <div class="card">
            <header class="card-head"><h3>Natural radio logger</h3><span class="card-tag mono" id="vlf-nr-tag">off</span></header>
            <div class="card-body">
              <div class="mod-controls">
                <label class="field"><span>&nbsp;</span><button class="btn btn-accent" id="vlf-nr-go">Start logging</button></label>
                <label class="field"><span>&nbsp;</span><button class="btn" id="vlf-nr-save">Save log</button></label>
                <label class="field"><span>&nbsp;</span><button class="btn" id="vlf-nr-self">Self-test</button></label>
                <span class="mono" id="vlf-nr-counts" style="font-size:12px;color:var(--amber,#ffb454);align-self:center">— sferics · — tweeks · — whistlers</span>
              </div>
              <pre class="mono" id="vlf-nr-log" style="max-height:140px;min-height:70px;overflow:auto;background:rgba(255,255,255,.04);border-radius:8px;padding:8px;font-size:11px;white-space:pre-wrap"></pre>
              <footer class="card-foot mono muted">Sferics are lightning heard raw — every click a stroke, often continents away. Tweeks are sferics that rang the Earth-ionosphere waveguide. A whistler rode the magnetosphere out and back: high notes arrive first, the log records the fall time. Best after dark, coil away from the house.</footer>
            </div>
          </div>

          <div class="card">
            <header class="card-head"><h3>Transmit — magnetic induction</h3><span class="card-tag mono" id="vlf-tx-tag">idle</span></header>
            <div class="card-body">
              <div class="mod-controls">
                <label class="field"><span>Frequency (Hz)</span>
                  <input type="number" id="vlf-txf" min="30" step="1" value="8970" style="width:110px"></label>
                <label class="field"><span>&nbsp;</span>
                  <button class="btn btn-mini" id="vlf-txcopy" title="Copy the receiver's tuned frequency">← use RX freq</button></label>
                <label class="field"><span>Mode</span>
                  <span class="vlf-seg">
                    <button class="btn btn-accent" data-t="carrier">Carrier</button>
                    <button class="btn" data-t="cw">CW</button>
                    <button class="btn" data-t="qrss">QRSS</button>
                  </span></label>
                <label class="field"><span>WPM <em id="vlf-wpm-val">12</em></span>
                  <input type="range" id="vlf-wpm" min="5" max="30" value="12"></label>
                <label class="field"><span>QRSS dot</span>
                  <select id="vlf-qrss"><option value="1">1 s</option><option value="3" selected>3 s (QRSS3)</option>
                    <option value="10">10 s</option><option value="30">30 s</option><option value="60">60 s</option></select></label>
              </div>
              <div class="mod-controls" style="margin-top:8px">
                <label class="field" style="flex:1;min-width:240px"><span>Message <em class="muted" id="vlf-dur"></em></span>
                  <input type="text" id="vlf-text" class="mono" maxlength="60"></label>
                <label class="field"><span>&nbsp;</span><button class="btn btn-accent" id="vlf-txgo">Key ON</button></label>
                <label class="field"><span>&nbsp;</span><button class="btn btn-danger" id="vlf-txstop" disabled>Stop</button></label>
              </div>
              <footer class="card-foot mono muted">Honest physics: a bare soundcard + coil reaches across the room (near-field falls as 1/r³). An audio amplifier and a big series-tuned loop stretch that to hundreds of metres — the record chasers have bridged a couple of km. Below 9 kHz is internationally unallocated (check local rules); above it, your amateur privileges apply. Use a series resistor — soundcards dislike driving raw copper.</footer>
            </div>
          </div>
        </div>

        <div class="mod-side">
          <div class="card">
            <header class="card-head"><h3>Station guide</h3><span class="card-tag mono">tap to tune</span></header>
            <div class="card-body vlf-sta" id="vlf-sta"></div>
            <footer class="card-foot mono muted">Schedules and status vary — this is a map, not a promise. Greyed entries sit above your current soundcard's range.</footer>
          </div>
          <div class="card">
            <header class="card-head"><h3>Your antenna is a coil</h3></header>
            <div class="card-body vlf-note">
              Many turns of wire — a loop on a frame, a big spool, even headphone cords in a pinch —
              straight into line-in. More turns and area = more signal; keep it away from monitors and
              switching supplies (they own VLF indoors). Face the loop's plane at the station to null
              local noise. What you'll hear first: mains harmonics (that's the comb's job), the crackle
              of <b>sferics</b> — lightning, worldwide — and with luck the falling whistle of a
              <b>whistler</b>, a lightning stroke that rode the magnetosphere to reach you. Wide AM,
              comb on, lights off. Welcome to the basement of the spectrum.
            </div>
          </div>
        </div>
      </div>`;

      const q = (id) => el.querySelector("#" + id);
      const ui = this.ui = {
        range: q("vlf-range"), spec: q("vlf-spec"), wf: q("vlf-wf"),
        cursor: q("vlf-cursor"), tuned: q("vlf-tuned"), pw: q("vlf-pw"),
        showsta: q("vlf-showsta"), avg: q("vlf-avg"), rate: q("vlf-rate"),
        rxTag: q("vlf-rx-tag"), f0: q("vlf-f0"), bw: q("vlf-bw"),
        pitch: q("vlf-pitch"), pitchVal: q("vlf-pitch-val"),
        hum: q("vlf-hum"), vol: q("vlf-vol"), volVal: q("vlf-vol-val"),
        listen: q("vlf-listen"), meter: q("vlf-meter-i"),
        txTag: q("vlf-tx-tag"), txf: q("vlf-txf"), txcopy: q("vlf-txcopy"),
        wpm: q("vlf-wpm"), wpmVal: q("vlf-wpm-val"), qrss: q("vlf-qrss"),
        text: q("vlf-text"), dur: q("vlf-dur"), txgo: q("vlf-txgo"), txstop: q("vlf-txstop"),
        sta: q("vlf-sta"),
        modeBtns: Array.from(el.querySelectorAll("[data-m]")),
        txModeBtns: Array.from(el.querySelectorAll("[data-t]"))
      };
      ui.text.value = this.tx.text;

      /* ---- receiver wiring ---- */
      const retune = () => {
        this.rx.f0 = clamp(parseFloat(ui.f0.value) || 17200, 30, 96000);
        this.rx.bw = parseInt(ui.bw.value, 10);
        this.rx.pitch = parseInt(ui.pitch.value, 10);
        if (this.demod) this.demod.tune(this.rx.f0, this.rx.bw, this.rx.mode, this.rx.pitch);
        ui.rxTag.textContent = `${this.rx.mode} · ${this.rx.bw >= 1000 ? (this.rx.bw / 1000) + " kHz" : this.rx.bw + " Hz"}`;
        ui.tuned.textContent = (this.rx.f0 / 1000).toFixed(3) + " kHz " + this.rx.mode;
      };
      ui.f0.addEventListener("change", retune);
      ui.bw.addEventListener("change", retune);
      ui.pitch.addEventListener("input", () => { ui.pitchVal.textContent = ui.pitch.value + " Hz"; retune(); });
      ui.modeBtns.forEach(b => b.addEventListener("click", () => {
        this.rx.mode = b.dataset.m;
        ui.modeBtns.forEach(x => x.classList.toggle("btn-accent", x === b));
        retune();
      }));
      ui.hum.addEventListener("change", () => {
        this.mainsHz = parseInt(ui.hum.value, 10);
        this.comb = (this.mainsHz && this.demod) ? new VlfHumComb(this.demod.fs, this.mainsHz) : null;
      });
      ui.vol.addEventListener("input", () => {
        ui.volVal.textContent = ui.vol.value + "%";
        if (this.out) this.out.setVolume(ui.vol.value / 100);
      });
      ui.listen.addEventListener("click", () => {
        this.listening = !this.listening;
        ui.listen.textContent = this.listening ? "■ Mute" : "▶ Listen";
        ui.listen.classList.toggle("btn-accent", !this.listening);
        if (this.listening && !this.ctx.audio.rxActive)
          this.ctx.log("VLF: press “Start audio” in the sidebar so the receiver has an input.");
      });

      /* ---- spectrum interaction ---- */
      const pickFreq = (ev, cv) => {
        const r = cv.getBoundingClientRect();
        const fs = this._lastRate || this.ctx.audio.sampleRate;
        return clamp((ev.clientX - r.left) / r.width, 0, 1) * fs / 2;
      };
      for (const cv of [ui.spec, ui.wf]) {
        cv.addEventListener("click", (ev) => {
          ui.f0.value = Math.round(pickFreq(ev, cv));
          retune();
        });
        cv.addEventListener("mousemove", (ev) => {
          ui.cursor.textContent = (pickFreq(ev, cv) / 1000).toFixed(3) + " kHz";
        });
      }
      ui.showsta.addEventListener("change", () => { this.showStations = ui.showsta.checked; });
      ui.rate.addEventListener("change", () => {
        const v = parseInt(ui.rate.value, 10) || null;
        this.ctx.audio.setPreferredRate(v);
        this.ctx.log(v ? `VLF: preferred rate ${v} Hz saved — reload the page to apply (unlocks up to ${v / 2000} kHz).`
                       : "VLF: preferred rate reset to the device default (applies on reload).");
      });

      /* ---- time-station decoder ---- */
      ui.tsTag = q("vlf-ts-tag"); ui.tsSta = q("vlf-ts-sta"); ui.tsGo = q("vlf-ts-go");
      ui.tsSelf = q("vlf-ts-self"); ui.tsStrip = q("vlf-ts-strip");
      ui.tsTime = q("vlf-ts-time"); ui.tsOff = q("vlf-ts-off"); ui.tsStatus = q("vlf-ts-status");
      this._tsCells = [];
      ui.tsSta.addEventListener("change", () => {
        this.timeProto = ui.tsSta.value;
        this.timeRx = null; this._tsCells = []; this._tsPaint();
        const f = TIME_PROTO[this.timeProto].f;
        ui.f0.value = f; ui.bw.value = "100";
        this.rx.mode = "CW";
        ui.modeBtns.forEach(x => x.classList.toggle("btn-accent", x.dataset.m === "CW"));
        retune();
      });
      ui.tsGo.addEventListener("click", () => {
        if (!this.timeOn) {
          const need = 2.05 * TIME_PROTO[this.timeProto].f;
          const have = this.ctx.audio.sampleRate;
          if (have < need) {
            this.ctx.log(`Time decoder: ${this.timeProto} needs a ≥${Math.ceil(need / 1000)} kHz device — pick 192 kHz in “device rate” above and reload.`);
            return;
          }
          if (!this.ctx.audio.rxActive) this.ctx.log("Time decoder: press “Start audio” in the sidebar first.");
        }
        this.timeOn = !this.timeOn;
        ui.tsGo.textContent = this.timeOn ? "Stop" : "Start";
        ui.tsGo.classList.toggle("btn-accent", !this.timeOn);
        ui.tsTag.textContent = this.timeOn ? this.timeProto : "off";
        ui.tsStatus.textContent = this.timeOn ? "listening for second pulses…" : "decoder off";
      });
      ui.tsSelf.addEventListener("click", () => {
        const fs = 48000, f0 = 15000;                       // synthetic band self-test
        const now = Date.now();
        const base = now - (now % 60000) - 60000;           // frame announcing the current minute
        const rx = new VlfTimeRx(fs, "DCF77", (e) => this._tsEvent(e, rx, true));
        const w = 2 * Math.PI * f0 / fs; rx.f0 = f0; rx.sr = Math.cos(w); rx.si = -Math.sin(w);
        const y1 = dcfSynth(dcfFrameFor(base, false), fs, f0);
        const y2 = dcfSynth(dcfFrameFor(base + 60000, false), fs, f0);
        const y = new Float32Array(y1.length + y2.length);
        y.set(y1, 0); y.set(y2, y1.length);
        for (let i = 0; i < y.length; i += 4096) rx.process(y.subarray(i, Math.min(i + 4096, y.length)));
        this.ctx.log("Time decoder self-test: two synthetic DCF77 minutes decoded through the real chain — no antenna, pure math.");
      });
      this._tsMake = (sr) => {
        this.timeRx = new VlfTimeRx(sr, this.timeProto, (e) => this._tsEvent(e, this.timeRx, false));
      };
      this._tsEvent = (e, rx, selftest) => {
        const u = this.ui; if (!u) return;
        if (e.type === "second") {
          const s = e.sym;
          this._tsCells.push(!s ? "x" : s.mark || s.minuteGap ? "M" : (s.a !== undefined ? (s.a || s.b ? "1" : "0") : String(s.bit)));
          if (this._tsCells.length > 60) this._tsCells.shift();
          this._tsPaint();
        } else if (e.type === "minute") {
          if (e.decoded) {
            u.tsTime.textContent = e.decoded.text + (selftest ? "  (self-test)" : "");
            if (!selftest) {
              const wallAtEdge = this._tsWall.wall - (rx.ms - e.t0);
              const off = wallAtEdge - (e.decoded.utcMs + rx.edgeDelta());
              u.tsOff.textContent = `your PC clock is ${off >= 0 ? "+" : ""}${(off / 1000).toFixed(2)} s ` +
                `${off >= 0 ? "fast" : "slow"} vs ${e.decoded.proto} (±0.2 s soundcard path)`;
            } else u.tsOff.textContent = "";
          }
          u.tsStatus.textContent = rx.status;
          this._tsCells.push("|"); this._tsPaint();
        }
      };
      this._tsPaint = () => {
        const cv = this.ui && this.ui.tsStrip; if (!cv) return;
        const g = cv.getContext("2d"); g.clearRect(0, 0, cv.width, cv.height);
        const wCell = cv.width / 61;
        this._tsCells.forEach((c, i) => {
          g.fillStyle = c === "1" ? "#7bd88f" : c === "0" ? "#3a4a5f" :
                        c === "M" ? "#ffb454" : c === "|" ? "#ff5d5d" : "#803040";
          g.fillRect(i * wCell + 1, 3, wCell - 2, cv.height - 6);
        });
      };

      /* ---- QRSS grabber ---- */
      ["qgTag","qg-tag","qgF","qg-f","qgRx","qg-rx","qgSpan","qg-span","qgRes","qg-res",
       "qgWin","qg-win","qgBr","qg-br","qgBrVal","qg-br-val","qgGo","qg-go","qgSave","qg-save",
       "qgAuto","qg-auto","qgCv","qg-cv"].forEach((v, i, a) => {
        if (i % 2 === 0) ui[v] = q("vlf-" + a[i + 1]);
      });
      const qgHeader = () => {
        const g = ui.qgCv.getContext("2d");
        g.fillStyle = "#06090f"; g.fillRect(0, 0, ui.qgCv.width, ui.qgCv.height);
        g.fillStyle = "#8b95a7"; g.font = "11px 'IBM Plex Mono', monospace";
        const call = (this.ctx.settings().callsign || "N0CALL").toUpperCase();
        g.fillText(`${call} grabber · ${ui.qgF.value} Hz ± ${ui.qgSpan.value / 2} Hz · ` +
                   `${ui.qgRes.value} Hz bins · ${ui.qgWin.value} min · start ` +
                   new Date().toISOString().slice(0, 16).replace("T", " ") + "z", 8, 13);
        g.strokeStyle = "rgba(139,149,167,.4)";
        for (let fr2 = -2; fr2 <= 2; fr2++) {
          const y2 = 20 + (ui.qgCv.height - 24) * (0.5 - fr2 / 4);
          g.strokeRect(0, y2, 4, 0.5);
          g.fillText(String(Math.round(parseFloat(ui.qgF.value) + fr2 * ui.qgSpan.value / 4)), 8, y2 + 3);
        }
        this.qgX = 96;
      };
      this._qgStart = () => {
        const fs = this.ctx.audio.sampleRate;
        const f0 = clamp(parseFloat(ui.qgF.value) || 8970, 30, fs * 0.48);
        this.qg = new QrssGrab(fs, f0, parseInt(ui.qgSpan.value, 10),
                               parseFloat(ui.qgRes.value), (row, res, fLo) => this._qgRow(row));
        this.qg.setHop(parseInt(ui.qgWin.value, 10) * 60 / (ui.qgCv.width - 96));
        qgHeader();
        ui.qgTag.textContent = `${f0} Hz · ${this.qg.res.toFixed(2)} Hz bins`;
      };
      this._qgRow = (row) => {
        const cv = ui.qgCv, g = cv.getContext("2d");
        const floor = parseInt(ui.qgBr.value, 10), range = 55;
        const top = 20, hgt = cv.height - 24;
        const img = g.createImageData(1, hgt);
        for (let y2 = 0; y2 < hgt; y2++) {
          const b = Math.floor((1 - y2 / (hgt - 1)) * (row.length - 1));
          const db = 10 * Math.log10(row[b] + 1e-20);
          const v = clamp((db - floor) / range, 0, 1);
          const p = y2 * 4;
          img.data[p] = 255 * Math.pow(v, 1.4);
          img.data[p + 1] = 255 * Math.pow(v, 2.2) * 0.85;
          img.data[p + 2] = 60 + 120 * v * (1 - v) * 2;
          img.data[p + 3] = 255;
        }
        g.putImageData(img, this.qgX, top);
        if (++this.qgX >= cv.width) {
          if (ui.qgAuto.checked) this._qgSave();
          qgHeader();
        }
      };
      this._qgSave = () => {
        const call = (this.ctx.settings().callsign || "N0CALL").toUpperCase();
        const name = `qrss_${call}_${ui.qgF.value}Hz_` +
          new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "z.png";
        ui.qgCv.toBlob((b) => {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(b); a.download = name; a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        });
        this.ctx.log("Grabber: saved " + name);
      };
      ui.qgBr.addEventListener("input", () => { ui.qgBrVal.textContent = ui.qgBr.value + " dB"; });
      ui.qgRx.addEventListener("click", () => { ui.qgF.value = Math.round(this.rx.f0); });
      ui.qgGo.addEventListener("click", () => {
        this.qgOn = !this.qgOn;
        ui.qgGo.textContent = this.qgOn ? "Stop" : "Start";
        ui.qgGo.classList.toggle("btn-accent", !this.qgOn);
        if (this.qgOn) {
          this._qgStart();
          if (!this.ctx.audio.rxActive) this.ctx.log("Grabber: press “Start audio” in the sidebar so it has an input.");
        } else ui.qgTag.textContent = "off";
      });
      ui.qgSave.addEventListener("click", () => this._qgSave());

      /* ---- natural radio logger ---- */
      ui.nrTag = q("vlf-nr-tag"); ui.nrGo = q("vlf-nr-go"); ui.nrSave = q("vlf-nr-save");
      ui.nrSelf = q("vlf-nr-self"); ui.nrCounts = q("vlf-nr-counts"); ui.nrLog = q("vlf-nr-log");
      this._nrEvent = (e) => {
        const u = this.ui; if (!u) return;
        const stamp = new Date().toISOString().slice(11, 19) + "z";
        const line = e.type === "whistler"
          ? `${stamp}  WHISTLER  fall ≈${(e.tau / 1000).toFixed(2)} s  +${e.db.toFixed(0)} dB`
          : `${stamp}  ${e.type}  ${e.dur} ms  +${e.db.toFixed(0)} dB`;
        if (e.type !== "sferic" || this.nrLog.length < 400) this.nrLog.push(line);
        if (e.type !== "sferic") { u.nrLog.textContent += line + "\n"; u.nrLog.scrollTop = 1e9; }
        const c = this.nr ? this.nr.counts : { sferic: 0, tweek: 0, whistler: 0 };
        u.nrCounts.textContent = `${c.sferic} sferics · ${c.tweek} tweeks · ${c.whistler} whistlers`;
      };
      ui.nrGo.addEventListener("click", () => {
        this.nrOn = !this.nrOn; this.nr = null;
        ui.nrGo.textContent = this.nrOn ? "Stop logging" : "Start logging";
        ui.nrGo.classList.toggle("btn-accent", !this.nrOn);
        ui.nrTag.textContent = this.nrOn ? "listening" : "off";
        if (this.nrOn && !this.ctx.audio.rxActive)
          this.ctx.log("Natural radio: press “Start audio” so the logger has an input.");
      });
      ui.nrSave.addEventListener("click", () => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([this.nrLog.join("\n")], { type: "text/plain" }));
        a.download = "natural-radio-" + new Date().toISOString().slice(0, 10) + ".txt"; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      });
      ui.nrSelf.addEventListener("click", () => {
        const fs = 48000, n = fs * 12, y = new Float32Array(n);
        for (let i = 0; i < n; i++) y[i] = (Math.random() - 0.5) * 0.02;
        const burst = (at, ms, f) => { const a0 = Math.round(at * fs), L = Math.round(ms * fs / 1000);
          for (let i = 0; i < L; i++) y[a0 + i] += 0.5 * Math.sin(2 * Math.PI * f * i / fs) * Math.exp(-i / (L / 3)); };
        for (let k = 0; k < 8; k++) burst(0.5 + k * 0.7, 1.5, 4000 + k * 500);   // sferics
        burst(6.2, 12, 1700); burst(6.9, 15, 1750);                              // tweeks
        const w0 = Math.round(8.5 * fs);                                          // whistler sweep
        for (let i = 0; i < fs * 0.9; i++) {
          const f = 7000 * Math.pow(1300 / 7000, i / (fs * 0.9));
          y[w0 + i] += 0.35 * Math.sin(2 * Math.PI * f * i / fs);
        }
        const rx = new VlfNatRx(fs, (e) => this._nrEvent(e));
        const keep = this.nr; this.nr = rx;
        for (let i = 0; i < n; i += 4096) rx.process(y.subarray(i, Math.min(i + 4096, n)));
        this.nr = keep;
        this.ctx.log(`Natural-radio self-test: ${rx.counts.sferic} sferics, ${rx.counts.tweek} tweeks, ${rx.counts.whistler} whistler — pure math.`);
      });

      /* ---- station guide ---- */
      const paintStations = () => {
        const nyq = (this._lastRate || this.ctx.audio.sampleRate) / 2;
        ui.sta.innerHTML = STATIONS.map((s, i) =>
          `<button data-i="${i}" ${s.f > nyq ? 'style="opacity:.35"' : ""}>
             <b>${(s.f / 1000).toFixed(s.f % 1000 ? 3 : 1)} kHz</b> ${s.name}
             <small>${s.note}${s.f > nyq ? " — needs a wider soundcard" : ""}</small></button>`).join("");
      };
      paintStations();
      this._paintStations = paintStations;
      ui.sta.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-i]");
        if (!b) return;
        const s = STATIONS[parseInt(b.dataset.i, 10)];
        ui.f0.value = s.f;
        ui.bw.value = String(s.bw);
        this.rx.mode = s.mode;
        ui.modeBtns.forEach(x => x.classList.toggle("btn-accent", x.dataset.m === s.mode));
        retune();
        this.ctx.log(`VLF tuned to ${s.name} — ${s.note}.`);
      });

      /* ---- transmit wiring ---- */
      const txDur = () => {
        const unit = this.tx.mode === "qrss" ? this.tx.qrss : 1.2 / this.tx.wpm;
        let units = 0;
        for (const ch of this.tx.text.toUpperCase()) {
          if (ch === " ") { units += 4; continue; }
          const m = MORSE[ch]; if (!m) continue;
          for (const el2 of m) units += (el2 === "." ? 1 : 3) + 1;
          units += 2;
        }
        const s = units * unit;
        ui.dur.textContent = this.tx.mode === "carrier" ? "" :
          "≈ " + (s >= 90 ? (s / 60).toFixed(1) + " min" : Math.round(s) + " s");
      };
      const setTxMode = (m) => {
        this.tx.mode = m;
        ui.txModeBtns.forEach(x => x.classList.toggle("btn-accent", x.dataset.t === m));
        ui.txgo.textContent = m === "carrier" ? "Key ON" : "Send";
        txDur();
      };
      ui.txModeBtns.forEach(b => b.addEventListener("click", () => setTxMode(b.dataset.t)));
      ui.txf.addEventListener("change", () => { this.tx.f = clamp(parseFloat(ui.txf.value) || 8970, 30, 96000); });
      ui.txcopy.addEventListener("click", () => { ui.txf.value = Math.round(this.rx.f0); ui.txf.dispatchEvent(new Event("change")); });
      ui.wpm.addEventListener("input", () => { this.tx.wpm = parseInt(ui.wpm.value, 10); ui.wpmVal.textContent = ui.wpm.value; txDur(); });
      ui.qrss.addEventListener("change", () => { this.tx.qrss = parseInt(ui.qrss.value, 10); txDur(); });
      ui.text.addEventListener("input", () => { this.tx.text = ui.text.value; txDur(); });
      ui.txgo.addEventListener("click", () => this._txStart());
      ui.txstop.addEventListener("click", () => this._txStop("stopped"));
      txDur();
      retune();
    },

    /* ---- keyer-based TX (zero memory, any speed, live abort) ---- */
    _txStart() {
      const ui = this.ui;
      const nyq = this.ctx.audio.ensureContext().sampleRate / 2;
      if (this.tx.f > nyq * 0.98) {
        this.ctx.log(`VLF TX: ${this.tx.f} Hz is above this soundcard's ${Math.round(nyq)} Hz ceiling — pick the 96/192 k device rate and reload.`);
        return;
      }
      this._txStop();
      if (!this.keyer) this.keyer = this.ctx.audio.makeKeyer(this.tx.f, 0.004);
      this.keyer.setFreq(this.tx.f);
      if (this.tx.mode === "carrier") {
        this.keyer.down();
        ui.txTag.textContent = `carrier · ${this.tx.f} Hz`;
        ui.txgo.disabled = true; ui.txstop.disabled = false;
        return;
      }
      const unit = (this.tx.mode === "qrss" ? this.tx.qrss : 1.2 / this.tx.wpm) * 1000;
      let t = 60;
      const on = (d) => { this._txTimers.push(setTimeout(() => this.keyer && this.keyer.down(), t)); t += d; 
                          this._txTimers.push(setTimeout(() => this.keyer && this.keyer.up(), t)); };
      for (const ch of this.tx.text.toUpperCase()) {
        if (ch === " ") { t += 4 * unit; continue; }
        const m = MORSE[ch]; if (!m) continue;
        for (const el2 of m) { on((el2 === "." ? 1 : 3) * unit); t += unit; }
        t += 2 * unit;
      }
      this._txTimers.push(setTimeout(() => this._txStop("message complete"), t + 100));
      ui.txTag.textContent = `${this.tx.mode.toUpperCase()} · ${this.tx.f} Hz`;
      ui.txgo.disabled = true; ui.txstop.disabled = false;
      this.ctx.log(`VLF ${this.tx.mode.toUpperCase()} keying "${this.tx.text}" at ${this.tx.f} Hz.`);
    },
    _txStop(why) {
      this._txTimers.forEach(clearTimeout);
      this._txTimers = [];
      if (this.keyer) this.keyer.up();
      if (this.ui) {
        this.ui.txTag.textContent = "idle";
        this.ui.txgo.disabled = false; this.ui.txstop.disabled = true;
      }
      if (why) this.ctx.log("VLF TX " + why + ".");
    },

    /* ---- spectrum painting ---- */
    _paint() {
      const ui = this.ui; if (!ui) return;
      const fs = this._lastRate || this.ctx.audio.sampleRate;
      ui.range.textContent = "0 – " + (fs / 2000).toFixed(0) + " kHz";
      const spec = ui.spec.getContext("2d"), W = ui.spec.width, H = ui.spec.height;
      spec.fillStyle = "#0a0e14"; spec.fillRect(0, 0, W, H);

      if (this._lastBlock && this._lastBlock.length >= 2048) {
        const N = 4096;
        const ps = DSP.powerSpectrum(this._lastBlock, N);
        const nAvg = parseInt(ui.avg.value, 10);
        if (!this.avg || this.avg.length !== ps.length || nAvg === 1) this.avg = Float32Array.from(ps);
        else for (let i = 0; i < ps.length; i++) this.avg[i] += (ps[i] - this.avg[i]) / nAvg;
        const bins = this.avg.length;
        // spectrum line
        spec.strokeStyle = "#45c7d6"; spec.beginPath();
        for (let x = 0; x < W; x++) {
          const b = Math.floor(x / W * bins);
          const db = 10 * Math.log10(this.avg[b] + 1e-12);
          const y = clamp((-(db + 20) / 80) * H, 0, H - 1);
          x ? spec.lineTo(x, y) : spec.moveTo(x, y);
        }
        spec.stroke();
        // waterfall row
        const wf = ui.wf.getContext("2d");
        wf.drawImage(ui.wf, 0, 0, ui.wf.width, ui.wf.height - 1, 0, 1, ui.wf.width, ui.wf.height - 1);
        const row = wf.createImageData(ui.wf.width, 1);
        for (let x = 0; x < ui.wf.width; x++) {
          const b = Math.floor(x / ui.wf.width * bins);
          const db = 10 * Math.log10(this.avg[b] + 1e-12);
          const v = clamp((db + 100) / 80, 0, 1);
          const p = x * 4;
          row.data[p] = 255 * Math.pow(v, 1.6);
          row.data[p + 1] = 255 * Math.pow(v, 2.6) * 0.75 + 40 * v;
          row.data[p + 2] = 90 * v * (1 - v) * 4 * 0.35 + 30 * v;
          row.data[p + 3] = 255;
        }
        wf.putImageData(row, 0, 0);
      } else {
        spec.fillStyle = "rgba(139,149,167,.7)";
        spec.font = "12px 'IBM Plex Mono', monospace";
        spec.fillText("Start audio in the sidebar — a coil on line-in is the antenna", 16, H / 2);
      }

      /* passband + station overlays on the spectrum */
      const fx = (f) => f / (fs / 2) * W;
      const x0 = fx(this.rx.f0 - this.rx.bw / 2), x1 = fx(this.rx.f0 + this.rx.bw / 2);
      spec.fillStyle = "rgba(255,180,84,.14)";
      spec.fillRect(x0, 0, Math.max(2, x1 - x0), H);
      spec.strokeStyle = "#ffb454";
      spec.beginPath(); spec.moveTo(fx(this.rx.f0), 0); spec.lineTo(fx(this.rx.f0), H); spec.stroke();
      if (this.showStations) {
        spec.fillStyle = "rgba(123,216,143,.8)";
        spec.font = "9px 'IBM Plex Mono', monospace";
        for (const s of STATIONS) {
          if (s.f > fs / 2) continue;
          const x = fx(s.f);
          spec.fillRect(x, 0, 1, 10);
          spec.fillText(s.name.split(" ")[0], x + 2, 9);
        }
      }
      /* meter */
      const db = this.demod ? this.demod.bandDb() : -120;
      ui.pw.textContent = db.toFixed(0) + " dB";
      ui.meter.style.width = clamp((db + 90) / 90 * 100, 0, 100) + "%";
    },

    onActivate() {
      this._paintT = setInterval(() => this._paint(), 90);
      this._staT = setInterval(() => this._paintStations && this._paintStations(), 5000);
    },
    onDeactivate() {
      clearInterval(this._paintT); clearInterval(this._staT);
      this._txStop();
      this.listening = false;
      this.ui = null;
    }
  };

  HRWS.registerModule(def);
})();
