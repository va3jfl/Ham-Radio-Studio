/* ============================================================
   Ham Radio Web Studio — APRS module
   A complete soundcard APRS station: Bell 202 AFSK 1200 Bd,
   AX.25 UI frames with HDLC bit-stuffing and CRC-16/X-25,
   APRS position / status / message (with auto-ACK) encoding,
   and a receive parser covering uncompressed, compressed,
   Mic-E and object position reports.

   RX chain: dual quadrature correlators (1200/2200 Hz) with
   independent per-tone AGC (survives FM pre-emphasis "twist"),
   soft-decision discriminator, early/late PLL bit timing that
   runs at any soundcard rate, NRZI + HDLC deframer, FCS check.

   TX chain: HDLC flags/stuffing, NRZI, continuous-phase AFSK
   synthesis at the engine rate (live) or 48 kHz (WAV render).

   No digipeating, no IGate — this is a standalone off-grid
   station. Key your rig with VOX or manual PTT. Identify per
   your regulations.
   ============================================================ */
"use strict";

(function () {

  const MARK = 1200, SPACE = 2200, BAUD = 1200;
  const APRS_DEST = "APZHWS";          // APZ* = experimental APRS destination

  const SYMBOLS = [
    ["/-", "House"], ["/>", "Car"], ["/<", "Motorcycle"], ["/[", "Person"],
    ["/b", "Bicycle"], ["/j", "Jeep"], ["/k", "Truck"], ["/U", "Bus"],
    ["/s", "Ship/boat"], ["/Y", "Yacht"], ["/^", "Large aircraft"],
    ["/'", "Small aircraft"], ["/O", "Balloon"], ["/_", "WX station"],
    ["/r", "Repeater"], ["/&", "HF gateway"], ["/`", "Dish antenna"],
    ["/y", "Yagi @ QTH"], ["/=", "Train"], ["/v", "Van"]
  ];

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function tick() { return new Promise(r => setTimeout(r, 0)); }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  /* ---------------- CRC-16/X-25 (AX.25 FCS) ---------------- */
  function fcs16(bytes, n) {
    let crc = 0xFFFF;
    const m = n === undefined ? bytes.length : n;
    for (let i = 0; i < m; i++) {
      crc ^= bytes[i];
      for (let k = 0; k < 8; k++)
        crc = (crc & 1) ? (crc >> 1) ^ 0x8408 : crc >> 1;
    }
    return (crc ^ 0xFFFF) & 0xFFFF;
  }

  /* ---------------- AX.25 UI frames ---------------- */
  function splitCall(s) {
    const m = /^([A-Z0-9]{1,6})(?:-(\d{1,2}))?$/.exec((s || "").toUpperCase().trim());
    if (!m) return null;
    const ssid = m[2] ? parseInt(m[2], 10) : 0;
    if (ssid > 15) return null;
    return { call: m[1], ssid };
  }
  function encodeAddr(call, ssid, last, hbit) {
    const b = new Uint8Array(7);
    const c = (call + "      ").slice(0, 6);
    for (let i = 0; i < 6; i++) b[i] = c.charCodeAt(i) << 1;
    b[6] = 0x60 | ((ssid & 0x0F) << 1) | (last ? 1 : 0) | (hbit ? 0x80 : 0);
    return b;
  }
  function decodeAddr(bytes, off) {
    let call = "";
    for (let i = 0; i < 6; i++) {
      const ch = (bytes[off + i] >> 1) & 0x7F;
      if (ch !== 0x20) call += String.fromCharCode(ch);
    }
    const ssid = (bytes[off + 6] >> 1) & 0x0F;
    return { call, ssid, h: !!(bytes[off + 6] & 0x80),
             last: !!(bytes[off + 6] & 0x01) };
  }
  function callStr(a) { return a.call + (a.ssid ? "-" + a.ssid : ""); }

  function buildUIFrame(destStr, srcStr, pathStrs, infoStr) {
    const dest = splitCall(destStr), src = splitCall(srcStr);
    if (!dest || !src) throw new Error("bad callsign");
    const path = (pathStrs || []).map(p => {
      const c = splitCall(p.replace(/\*$/, ""));
      if (!c) throw new Error("bad path element: " + p);
      return c;
    }).slice(0, 8);
    const info = [];
    for (let i = 0; i < infoStr.length; i++) info.push(infoStr.charCodeAt(i) & 0xFF);
    const out = [];
    out.push(...encodeAddr(dest.call, dest.ssid, false, false));
    out.push(...encodeAddr(src.call, src.ssid, path.length === 0, false));
    path.forEach((p, i) =>
      out.push(...encodeAddr(p.call, p.ssid, i === path.length - 1, false)));
    out.push(0x03, 0xF0);               // UI, no layer-3
    out.push(...info);
    const fcs = fcs16(Uint8Array.from(out));
    out.push(fcs & 0xFF, (fcs >> 8) & 0xFF);   // little-endian on air
    return Uint8Array.from(out);
  }

  function parseFrame(bytes) {
    if (bytes.length < 18) return null;
    const fcs = fcs16(bytes, bytes.length - 2);
    if (fcs !== (bytes[bytes.length - 2] | (bytes[bytes.length - 1] << 8))) return null;
    const dest = decodeAddr(bytes, 0);
    const src = decodeAddr(bytes, 7);
    const path = [];
    let off = 14, last = src.last;
    while (!last && off + 7 <= bytes.length - 4 && path.length < 8) {
      const a = decodeAddr(bytes, off);
      path.push(a);
      last = a.last;
      off += 7;
    }
    if (off + 2 > bytes.length - 2) return null;
    const ctl = bytes[off], pid = bytes[off + 1];
    let info = "";
    for (let i = off + 2; i < bytes.length - 2; i++)
      info += String.fromCharCode(bytes[i]);
    return { dest, src, path, ctl, pid, info,
             addrText: callStr(src) + ">" + callStr(dest) +
               (path.length ? "," + path.map(p => callStr(p) + (p.h ? "*" : "")).join(",") : "") };
  }

  /* ---------------- APRS payload encoding ---------------- */
  function fmtLat(lat) {
    const ns = lat >= 0 ? "N" : "S";
    const a = Math.abs(lat);
    const d = Math.floor(a);
    const min = (a - d) * 60;
    return pad2(d) + (min < 10 ? "0" : "") + min.toFixed(2) + ns;
  }
  function fmtLon(lon) {
    const ew = lon >= 0 ? "E" : "W";
    const a = Math.abs(lon);
    const d = Math.floor(a);
    const min = (a - d) * 60;
    return (d < 100 ? "0" : "") + pad2(d) + (min < 10 ? "0" : "") + min.toFixed(2) + ew;
  }
  function buildPosition(lat, lon, symbol, comment, messaging) {
    const table = symbol[0], code = symbol[1];
    return (messaging ? "=" : "!") + fmtLat(lat) + table + fmtLon(lon) + code +
           (comment || "");
  }
  function buildStatus(text) { return ">" + text; }
  function buildMessage(to, text, seq) {
    const addr = (to.toUpperCase() + "         ").slice(0, 9);
    return ":" + addr + ":" + text + (seq !== undefined ? "{" + seq : "");
  }
  function buildAck(to, seq) {
    const addr = (to.toUpperCase() + "         ").slice(0, 9);
    return ":" + addr + ":ack" + seq;
  }

  /* ---------------- APRS payload parsing ---------------- */
  function parseLatLon(s) {
    /* "DDMM.mmN/DDDMM.mmW" with symbol chars around */
    const m = /^(\d{2})(\d{2}\.\d{2})([NS])(.)(\d{3})(\d{2}\.\d{2})([EW])(.)/.exec(s);
    if (!m) return null;
    let lat = parseInt(m[1], 10) + parseFloat(m[2]) / 60;
    if (m[3] === "S") lat = -lat;
    let lon = parseInt(m[5], 10) + parseFloat(m[6]) / 60;
    if (m[7] === "W") lon = -lon;
    return { lat, lon, table: m[4], code: m[8], rest: s.slice(19) };
  }
  const B91 = c => c.charCodeAt(0) - 33;
  function parseCompressed(s) {
    /* "/YYYYXXXXcsT..." — table, base-91 lat/lon, symbol, cs+type */
    if (s.length < 13) return null;
    const table = s[0];
    if (!/[\/\\A-Za-j]/.test(table)) return null;
    let y = 0, x = 0;
    for (let i = 0; i < 4; i++) { y = y * 91 + B91(s[1 + i]); x = x * 91 + B91(s[5 + i]); }
    const lat = 90 - y / 380926;
    const lon = -180 + x / 190463;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon, table, code: s[9], rest: s.slice(13) };
  }
  function parseMicE(dest, info) {
    /* Mic-E: latitude, message and lon offset ride in the DESTINATION */
    if (info.length < 9) return null;
    if (!/[`'\x1c\x1d]/.test(info[0])) return null;
    let lat = 0, msgBits = 0, ns = "S", lonOff = 0, ew = "E";
    const digits = [];
    for (let i = 0; i < 6; i++) {
      const c = dest.charCodeAt(i);
      let d, bit = 0, custom = false;
      if (c >= 0x30 && c <= 0x39) d = c - 0x30;                 // 0-9
      else if (c >= 0x41 && c <= 0x4A) { d = c - 0x41; bit = 1; custom = true; } // A-J
      else if (c >= 0x50 && c <= 0x59) { d = c - 0x50; bit = 1; }               // P-Y
      else if (c === 0x4B || c === 0x4C || c === 0x5A) {        // K L Z
        d = 0;                                                   // space digit
        bit = c === 0x4C ? 0 : 1;
        if (c === 0x4B) custom = true;
      } else return null;
      digits.push(d);
      if (i < 3) msgBits |= bit << (2 - i);
      if (i === 3) ns = bit ? "N" : "S";
      if (i === 4) lonOff = bit ? 100 : 0;
      if (i === 5) ew = bit ? "W" : "E";
      void custom;
    }
    lat = digits[0] * 10 + digits[1] +
          (digits[2] * 10 + digits[3] + (digits[4] * 10 + digits[5]) / 100) / 60;
    if (ns === "S") lat = -lat;
    /* longitude from info bytes 1..3 */
    let ld = info.charCodeAt(1) - 28 + lonOff;
    if (ld >= 180 && ld <= 189) ld -= 80;
    else if (ld >= 190 && ld <= 199) ld -= 190;
    let lm = info.charCodeAt(2) - 28;
    if (lm >= 60) lm -= 60;
    const lh = info.charCodeAt(3) - 28;
    let lon = ld + (lm + lh / 100) / 60;
    if (ew === "W") lon = -lon;
    /* speed / course, bytes 4..6 */
    let sp = (info.charCodeAt(4) - 28) * 10;
    const dcTmp = info.charCodeAt(5) - 28;
    sp += Math.floor(dcTmp / 10);
    if (sp >= 800) sp -= 800;
    let course = (dcTmp % 10) * 100 + (info.charCodeAt(6) - 28);
    if (course >= 400) course -= 400;
    const MSGS = ["Emergency", "Priority", "Special", "Committed",
                  "Returning", "In Service", "En Route", "Off Duty"];
    return { lat, lon, code: info[7], table: info[8],
             speedKt: sp, course,
             message: MSGS[7 - msgBits] || "?",
             rest: info.slice(9) };
  }

  function parseInfo(info, destCall) {
    const t = info[0];
    if (/[`'\x1c\x1d]/.test(t)) {
      const m = parseMicE(destCall, info);
      if (m) return Object.assign({ type: "pos", via: "Mic-E",
                                    comment: m.rest.trim() }, m);
    }
    if (t === "!" || t === "=") {
      const body = info.slice(1);
      const u = parseLatLon(body);
      if (u) return { type: "pos", via: "plain", lat: u.lat, lon: u.lon,
                      table: u.table, code: u.code, comment: u.rest.trim() };
      const c = parseCompressed(body);
      if (c) return { type: "pos", via: "compressed", lat: c.lat, lon: c.lon,
                      table: c.table, code: c.code, comment: c.rest.trim() };
    }
    if (t === "@" || t === "/") {
      const body = info.slice(8);          // skip 7-char timestamp
      const u = parseLatLon(body);
      if (u) return { type: "pos", via: "timestamped", lat: u.lat, lon: u.lon,
                      table: u.table, code: u.code, comment: u.rest.trim() };
      const c = parseCompressed(body);
      if (c) return { type: "pos", via: "compressed", lat: c.lat, lon: c.lon,
                      table: c.table, code: c.code, comment: c.rest.trim() };
    }
    if (t === ";" && info.length > 18) {
      const name = info.slice(1, 10).trim();
      const alive = info[10] === "*";
      const body = info.slice(18);
      const u = parseLatLon(body);
      if (u) return { type: "object", name, alive, lat: u.lat, lon: u.lon,
                      table: u.table, code: u.code, comment: u.rest.trim() };
    }
    if (t === ":" && info.length >= 11 && info[10] === ":") {
      const to = info.slice(1, 10).trim();
      let text = info.slice(11);
      const am = /^ack(\S{1,5})$/.exec(text);
      if (am) return { type: "ack", to, seq: am[1] };
      const rm = /^rej(\S{1,5})$/.exec(text);
      if (rm) return { type: "rej", to, seq: rm[1] };
      let seq;
      const sm = /\{(\S{1,5})$/.exec(text);
      if (sm) { seq = sm[1]; text = text.slice(0, sm.index); }
      return { type: "msg", to, text, seq };
    }
    if (t === ">") return { type: "status", text: info.slice(1) };
    if (t === "T" && info[1] === "#") return { type: "telemetry", raw: info };
    return { type: "other", raw: info };
  }

  /* ---------------- geo ---------------- */
  function distBearing(lat1, lon1, lat2, lon2) {
    const R = 6371.0, d2r = Math.PI / 180;
    const p1 = lat1 * d2r, p2 = lat2 * d2r, dl = (lon2 - lon1) * d2r;
    const a = Math.sin((p2 - p1) / 2) ** 2 +
              Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    const dist = 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    const brg = (Math.atan2(y, x) / d2r + 360) % 360;
    return { dist, brg };
  }

  /* =====================================================================
     HDLC bitstream <-> bytes
     ===================================================================== */
  function frameToStuffedBits(frame, txdelayFlags, tailFlags) {
    const bits = [];
    const flag = [0, 1, 1, 1, 1, 1, 1, 0];
    for (let f = 0; f < txdelayFlags; f++) bits.push(...flag);
    let run = 0;
    for (const byte of frame)
      for (let b = 0; b < 8; b++) {                 // LSB first
        const bit = (byte >> b) & 1;
        bits.push(bit);
        if (bit) { if (++run === 5) { bits.push(0); run = 0; } }
        else run = 0;
      }
    for (let f = 0; f < tailFlags; f++) bits.push(...flag);
    return bits;
  }

  /* =====================================================================
     AFSK TX — NRZI + continuous-phase Bell 202 synthesis at any rate
     ===================================================================== */
  function afskSynth(stuffedBits, fs, amp) {
    amp = amp || 0.6;
    const spb = fs / BAUD;
    const n = Math.ceil(stuffedBits.length * spb) + Math.round(fs * 0.02);
    const out = new Float32Array(n);
    let phase = 0, tone = MARK, p = 0;
    let tNext = 0;
    for (let i = 0; i < stuffedBits.length; i++) {
      if (stuffedBits[i] === 0) tone = (tone === MARK) ? SPACE : MARK;  // NRZI
      tNext += spb;
      const end = Math.round(tNext);
      const w = 2 * Math.PI * tone / fs;
      while (p < end) {
        out[p++] = amp * Math.sin(phase);
        phase += w;
        if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
      }
    }
    return out.subarray(0, p + Math.round(fs * 0.01));
  }

  function renderFrames(frames, fs, opts) {
    const o = opts || {};
    const parts = [new Float32Array(Math.round(fs * 0.15))];
    for (const fr of frames) {
      const bits = frameToStuffedBits(fr, o.txdelay || 32, o.tail || 3);
      parts.push(afskSynth(bits, fs, o.amp));
      parts.push(new Float32Array(Math.round(fs * (o.gapS === undefined ? 0.12 : o.gapS))));
    }
    parts.push(new Float32Array(Math.round(fs * 0.15)));
    let total = 0;
    for (const pt of parts) total += pt.length;
    const out = new Float32Array(total);
    let p = 0;
    for (const pt of parts) { out.set(pt, p); p += pt.length; }
    return out;
  }

  /* =====================================================================
     AFSK RX — quadrature correlators + per-tone AGC + early/late PLL
     ===================================================================== */
  class HdlcDec {
    constructor(onFrame) {
      this.onFrame = onFrame;
      this.prevTone = 1;
      this._run = 0;
      this._bits = [];
      this._open = false;
      this.crcErrors = 0;
      this.framesOk = 0;
      this.sawFlag = false;
    }
    pushTone(tone) {
      const bit = tone === this.prevTone ? 1 : 0;    // NRZI decode
      this.prevTone = tone;
      if (bit) {
        this._run++;
        if (this._run <= 5) { if (this._open) this._bits.push(1); }
        else if (this._run >= 7) { this._open = false; this._bits.length = 0; }
        return;                                      // run == 6: hold
      }
      if (this._run === 5) { this._run = 0; return; }        // destuffed
      if (this._run === 6) {                                 // FLAG
        this._run = 0;
        this.sawFlag = true;
        if (this._open && this._bits.length >= 6)
          this._close(this._bits.length - 6);                // drop 0+11111
        this._open = true;
        this._bits.length = 0;
        return;
      }
      this._run = 0;
      if (this._open) {
        this._bits.push(0);
        if (this._bits.length > 3400) { this._open = false; this._bits.length = 0; }
      }
    }
    _close(nbits) {
      if (nbits < 18 * 8 || nbits % 8 !== 0) return;
      const n = nbits >> 3;
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        let v = 0;
        for (let b = 0; b < 8; b++) v |= this._bits[i * 8 + b] << b;   // LSB first
        bytes[i] = v;
      }
      const want = bytes[n - 2] | (bytes[n - 1] << 8);
      if (fcs16(bytes, n - 2) !== want) { this.crcErrors++; return; }
      this.framesOk++;
      this.onFrame(bytes);
    }
  }

  class AfskRx {
    constructor(fs, onFrame) {
      this.fs = fs;
      this.onFrame = onFrame;               // (bytes, meta)
      this.spb = fs / BAUD;
      this.N = Math.round(this.spb);        // correlator window
      this.ring = new Float64Array(1 << Math.ceil(Math.log2(this.spb * 4 + 8)));
      this.mask = this.ring.length - 1;
      this.w = 0;
      this.phase = this.spb;
      this.w1 = 2 * Math.PI * MARK / fs;
      this.w2 = 2 * Math.PI * SPACE / fs;
      this.agc1 = 0.1; this.agc2 = 0.1;
      this.quality = 0;
      this.level = -90;
      this.dcd = 0;
      this._pending = 0;
      this._lastTone = 1;
      this.crcErrors = 0;
      this.framesOk = 0;
      /* dual slicers: AGC-normalized (twist-tolerant) and flat (level-
         tolerant) — a frame counts when either FCS passes; duplicates
         within half a second are suppressed. */
      this._lastSig = null;
      this._lastAt = -1e9;
      const deliver = (bytes) => {
        const sig = bytes.length + ":" +
          (bytes[bytes.length - 2] | (bytes[bytes.length - 1] << 8));
        if (sig === this._lastSig && this.w - this._lastAt < this.fs / 2) return;
        this._lastSig = sig; this._lastAt = this.w;
        this.framesOk++;
        this.dcd = 120;
        this.onFrame(bytes, { quality: this.quality, level: this.level });
      };
      this.decA = new HdlcDec(deliver);
      this.decB = new HdlcDec(deliver);
    }

    _corr(endIdx) {
      let c1 = 0, s1 = 0, c2 = 0, s2 = 0;
      const start = endIdx - this.N;
      for (let i = 0; i < this.N; i++) {
        const t = start + i;
        const x = this.ring[t & this.mask];
        c1 += x * Math.cos(this.w1 * t); s1 += x * Math.sin(this.w1 * t);
        c2 += x * Math.cos(this.w2 * t); s2 += x * Math.sin(this.w2 * t);
      }
      return { m1: Math.hypot(c1, s1), m2: Math.hypot(c2, s2) };
    }
    _softAgc(endIdx) {
      const c = this._corr(endIdx);
      return c.m1 / (this.agc1 + 1e-9) - c.m2 / (this.agc2 + 1e-9);
    }

    feed(samples) {
      let acc = 0;
      const half = this.spb / 2;
      for (let i = 0; i < samples.length; i++) {
        const x = samples[i];
        acc += x * x;
        this.ring[this.w & this.mask] = x;
        this.w++;
        if (--this.phase <= 0) {
          this.phase += this.spb;
          this._pending = this.w;
        }
        if (this._pending && this.w >= this._pending + half) {
          this._bitDecide(this._pending);
          this._pending = 0;
        }
      }
      if (samples.length)
        this.level = 20 * Math.log10(Math.sqrt(acc / samples.length) + 1e-10);
      if (this.dcd > 0) this.dcd--;
    }

    _bitDecide(end) {
      const c = this._corr(end);
      /* per-tone AGC: tracks emphasis twist */
      this.agc1 = Math.max(this.agc1 * 0.999, this.agc1 * 0.94 + c.m1 * 0.06);
      this.agc2 = Math.max(this.agc2 * 0.999, this.agc2 * 0.94 + c.m2 * 0.06);
      const dA = c.m1 / (this.agc1 + 1e-9) - c.m2 / (this.agc2 + 1e-9);
      const dB = c.m1 - c.m2;
      const toneA = dA >= 0 ? 1 : 0;
      const conf = Math.abs(dA);
      const sig = (c.m1 + c.m2) / (this.agc1 + this.agc2 + 1e-9);
      if (sig > 0.45)
        this.quality = 0.97 * this.quality + 0.03 * Math.min(conf, 1.5);
      /* transition-based DPLL: on a tone change, the discriminator zero
         crossing should sit half a bit before the tick. Sample the AGC
         discriminator there: its sign tells which side the transition
         actually fell on. Sign-based, so twist cannot bias it. */
      if (toneA !== this._lastTone && sig > 0.3) {
        const dMid = this._softAgc(end - Math.round(this.spb / 2));
        const late = (dMid >= 0) === (toneA === 1);   // new tone already there
        this.phase += (late ? -0.08 : 0.08) * this.spb;
      }
      this._lastTone = toneA;
      this.decA.pushTone(toneA);
      this.decB.pushTone(dB >= 0 ? 1 : 0);
      this.crcErrors = this.decA.crcErrors + this.decB.crcErrors;
      if (this.decA.sawFlag || this.decB.sawFlag) {
        this.decA.sawFlag = this.decB.sawFlag = false;
        this.dcd = Math.max(this.dcd, 40);
      }
    }
  }

  /* ---------------- WAV (mono) ---------------- */
  function wavEncode16(samples, rate) {
    const dataSz = samples.length * 2;
    const buf = new ArrayBuffer(44 + dataSz);
    const dv = new DataView(buf);
    const ws = (p, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(p + i, s.charCodeAt(i)); };
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
      out[i] = v;                              // channel 0
      p += bytes * nch;
    }
    return { rate: fmt.rate, samples: out };
  }

  /* ---------------- channel simulation ----------------
     bandpass (1-pole HP + windowed-sinc LP) + emphasis twist shelf +
     gain + AWGN — the FM voice path an HT presents to a soundcard. */
  class AfskChannel {
    constructor(fs, opts) {
      const o = opts || {};
      this.fs = fs;
      this.snrDb = o.snrDb === undefined ? null : o.snrDb;
      this.gain = o.gain === undefined ? 0.5 : o.gain;
      this.twistDb = o.twistDb || 0;
      let seed = (o.seed | 0) || 1;
      this.rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
      const fHi = o.fHi || 3000, fLo = o.fLo === undefined ? 250 : o.fLo;
      const nt = 121;
      this.h = new Float64Array(nt);
      const mid = (nt - 1) / 2;
      let hs = 0;
      for (let i = 0; i < nt; i++) {
        const x = i - mid;
        const sc = x === 0 ? 2 * fHi / fs : Math.sin(2 * Math.PI * fHi / fs * x) / (Math.PI * x);
        const r = 2 * i / (nt - 1) - 1;
        const k = 6.0 * Math.sqrt(Math.max(0, 1 - r * r));
        let bi = 1, t = 1;
        for (let q = 1; q < 24; q++) { t *= (k / (2 * q)) ** 2; bi += t; }
        let b0 = 1; t = 1;
        for (let q = 1; q < 24; q++) { t *= (6.0 / (2 * q)) ** 2; b0 += t; }
        this.h[i] = sc * bi / b0;
        hs += this.h[i];
      }
      for (let i = 0; i < nt; i++) this.h[i] /= hs;
      this.zi = new Float64Array(nt - 1);
      this.hpA = Math.exp(-2 * Math.PI * fLo / fs);
      this.hpX1 = 0; this.hpY1 = 0;
      this.shA = Math.exp(-2 * Math.PI * 1700 / fs);   // twist pivot
      this.shY = 0;
      this.sigP = (0.42 * this.gain) ** 2;             // AFSK tone power
    }
    _gauss() {
      const u1 = Math.max(this.rnd(), 1e-12), u2 = this.rnd();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    }
    process(x) {
      const y = Float64Array.from(x);
      const a = this.hpA;
      let x1 = this.hpX1, y1 = this.hpY1;
      for (let i = 0; i < y.length; i++) {
        const v = a * (y1 + y[i] - x1);
        x1 = y[i]; y[i] = v; y1 = v;
      }
      this.hpX1 = x1; this.hpY1 = y1;
      if (this.twistDb) {
        const g = Math.pow(10, this.twistDb / 20);
        const sa = this.shA;
        let lp = this.shY;
        for (let i = 0; i < y.length; i++) {
          lp = sa * lp + (1 - sa) * y[i];
          y[i] = lp + g * (y[i] - lp);        // highs scaled by g
        }
        this.shY = lp;
      }
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
      if (this.snrDb !== null) {
        const nP = Math.sqrt(this.sigP / Math.pow(10, this.snrDb / 10));
        for (let i = 0; i < out.length; i++) out[i] += this._gauss() * nP;
      }
      return Float32Array.from(out);
    }
  }

  /* =====================================================================
     Browser shell
     ===================================================================== */
  const LS_KEY = "hrws-aprs";
  function loadPrefs() {
    try { return Object.assign({ lat: "", lon: "", sym: 0, ssid: "0",
      comment: "Ham Radio Web Studio", path: "WIDE1-1,WIDE2-1",
      interval: 5, autoAck: true }, JSON.parse(localStorage.getItem(LS_KEY) || "{}")); }
    catch { return { lat: "", lon: "", sym: 0, ssid: "0",
      comment: "Ham Radio Web Studio", path: "WIDE1-1,WIDE2-1",
      interval: 5, autoAck: true }; }
  }
  function savePrefs(p) { try { localStorage.setItem(LS_KEY, JSON.stringify(p)); } catch {} }

  const RADAR_SCALES = [25, 100, 400, 1600];

  const def = {
    id: "aprs",

    init(ctx) {
      this.ctx = ctx;
      this.prefs = loadPrefs();
      this.rx = null;
      this.armed = false;
      this.stations = new Map();
      this.pendingMsgs = new Map();          // seq -> {to,text}
      this.msgSeq = 10 + Math.floor(Math.random() * 80);
      this.beaconTimer = null;
      this.pollTimer = null;
      this._blink = { rx: 0, tx: 0, err: 0 };
      this._dirty = false;
      this._busy = false;
      if (!this._subscribed) {
        this._subscribed = true;
        ctx.audio.onSamples((ch0, sr) => {
          if (this.armed && this.rx) this.rx.feed(ch0);
        });
      }
    },

    createPanel(el) {
      const symOpts = SYMBOLS.map((s, i) =>
        `<option value="${i}"${i === this.prefs.sym ? " selected" : ""}>${s[0]}  ${s[1]}</option>`).join("");
      const ssidOpts = Array.from({ length: 16 }, (_, i) =>
        `<option${String(i) === String(this.prefs.ssid) ? " selected" : ""}>${i}</option>`).join("");
      const scaleOpts = RADAR_SCALES.map((k, i) =>
        `<option value="${k}"${i === 1 ? " selected" : ""}>${k} km</option>`).join("");
      el.innerHTML = `
        <div class="mod-layout">
          <div class="mod-main">
            <div class="card">
              <header class="card-head"><h3>APRS monitor — AFSK 1200</h3>
                <span class="card-tag mono" id="ap-state">idle</span></header>
              <div style="padding:12px;background:#0b0d10">
                <div style="display:flex;gap:14px;flex-wrap:wrap">
                  <div>
                    <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">
                      <canvas id="ap-radar" width="230" height="230"
                        style="border:1px solid rgba(96,114,150,0.35);background:#05070b"></canvas>
                    </div>
                    <div style="display:flex;gap:6px;align-items:center">
                      <span class="mono" style="font-size:10px;color:#5a6470">RANGE</span>
                      <select id="ap-scale" style="font-size:11px">${scaleOpts}</select>
                    </div>
                  </div>
                  <div style="flex:1;min-width:250px">
                    <div id="ap-leds" style="display:flex;gap:12px;margin-bottom:8px"></div>
                    <div class="mono" style="font-size:11px" id="ap-bars"></div>
                    <div class="mono" style="font-size:11px;margin-top:6px;color:#c9d1d9"
                      id="ap-stats">0 frames · 0 CRC errors</div>
                    <div style="max-height:150px;overflow:auto;margin-top:8px">
                      <table class="mono" style="font-size:10px;width:100%;border-collapse:collapse"
                        id="ap-table"><thead><tr style="color:#5a6470;text-align:left">
                        <th>CALL</th><th>DIST</th><th>BRG</th><th>VIA</th><th>AGE</th><th>COMMENT</th>
                        </tr></thead><tbody></tbody></table>
                    </div>
                  </div>
                </div>
                <div id="ap-log" class="mono" style="margin-top:10px;height:170px;overflow:auto;
                  font-size:10.5px;line-height:1.45;background:#05070b;padding:6px;
                  border:1px solid rgba(96,114,150,0.25);white-space:pre-wrap"></div>
              </div>
            </div>
          </div>
          <div class="mod-side">
            <div class="card">
              <header class="card-head"><h3>My station</h3></header>
              <div class="card-body mod-controls" style="flex-direction:column;align-items:stretch">
                <div class="mod-controls">
                  <label class="field" style="flex:1"><span>Latitude °</span>
                    <input id="ap-lat" type="number" step="0.0001" min="-90" max="90"
                      value="${this.prefs.lat}" placeholder="46.49"></label>
                  <label class="field" style="flex:1"><span>Longitude °</span>
                    <input id="ap-lon" type="number" step="0.0001" min="-180" max="180"
                      value="${this.prefs.lon}" placeholder="-80.99"></label>
                </div>
                <div class="mod-controls">
                  <label class="field" style="flex:1"><span>Symbol</span>
                    <select id="ap-sym">${symOpts}</select></label>
                  <label class="field"><span>SSID</span>
                    <select id="ap-ssid">${ssidOpts}</select></label>
                </div>
                <label class="field"><span>Comment</span>
                  <input id="ap-comment" value="${this.prefs.comment}" maxlength="43"></label>
                <label class="field"><span>Path</span>
                  <input id="ap-path" value="${this.prefs.path}"></label>
                <div class="mod-controls">
                  <button class="btn btn-accent" id="ap-beacon" style="flex:1">Send position</button>
                  <button class="btn" id="ap-auto">Auto ▶</button>
                  <select id="ap-int" style="width:64px">
                    ${[1, 2, 5, 10, 30].map(v => `<option${v === this.prefs.interval ? " selected" : ""}>${v}</option>`).join("")}
                  </select><span class="mono" style="font-size:10px">min</span>
                </div>
                <div class="mod-controls">
                  <input id="ap-status" placeholder="status text…" style="flex:1">
                  <button class="btn" id="ap-sendstatus">Status</button>
                </div>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>Messages</h3></header>
              <div class="card-body mod-controls" style="flex-direction:column;align-items:stretch">
                <div class="mod-controls">
                  <label class="field" style="width:110px"><span>To</span>
                    <input id="ap-msgto" placeholder="VE3ABC-7"></label>
                  <label class="field" style="flex:1"><span>Text</span>
                    <input id="ap-msgtext" maxlength="67"></label>
                </div>
                <div class="mod-controls">
                  <button class="btn btn-accent" id="ap-msgsend" style="flex:1">Send message</button>
                  <label class="field" style="flex-direction:row;align-items:center;gap:5px">
                    <input type="checkbox" id="ap-autoack" ${this.prefs.autoAck ? "checked" : ""}>
                    <span>Auto-ACK</span></label>
                </div>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>Receive / audio</h3></header>
              <div class="card-body mod-controls" style="flex-direction:column;align-items:stretch">
                <button class="btn" id="ap-arm">ARM RX ▶</button>
                <label class="btn" for="ap-wavin" style="text-align:center">Decode WAV…</label>
                <input type="file" id="ap-wavin" accept=".wav,audio/wav,audio/x-wav" style="display:none">
                <button class="btn" id="ap-savewav">Save beacon WAV</button>
                <button class="btn" id="ap-clear">Clear stations</button>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>Loopback lab</h3></header>
              <div class="card-body mod-controls" style="flex-direction:column;align-items:stretch">
                <div class="mod-controls">
                  <label class="field" style="flex-direction:row;align-items:center;gap:5px">
                    <input type="checkbox" id="ap-noise" checked><span>SNR</span></label>
                  <input type="number" id="ap-snr" value="15" min="0" max="40" style="width:56px">
                  <span class="mono">dB · twist</span>
                  <input type="number" id="ap-twist" value="6" min="-12" max="12" style="width:52px">
                  <span class="mono">dB</span>
                </div>
                <button class="btn" id="ap-loop">Run loopback</button>
                <button class="btn" id="ap-selftest">Self-test</button>
              </div>
            </div>
            <div class="mod-note">
              Soundcard APRS: Bell 202 AFSK 1200 Bd, AX.25 UI frames.
              Enter your coordinates above — they drive the beacon, the
              distance/bearing table and the radar plot. Key the rig with
              VOX or manual PTT. Monitor-only is fine unarmed for TX. No
              digipeating or IGate. Identify per your regulations.
            </div>
          </div>
        </div>`;

      const $ = id => el.querySelector("#ap-" + id);
      this.ui = {
        state: $("state"), radar: $("radar"), scale: $("scale"),
        leds: $("leds"), bars: $("bars"), stats: $("stats"),
        table: $("table").querySelector("tbody"), log: $("log"),
        lat: $("lat"), lon: $("lon"), sym: $("sym"), ssid: $("ssid"),
        comment: $("comment"), path: $("path"),
        beacon: $("beacon"), auto: $("auto"), int: $("int"),
        status: $("status"), sendstatus: $("sendstatus"),
        msgto: $("msgto"), msgtext: $("msgtext"), msgsend: $("msgsend"),
        autoack: $("autoack"),
        arm: $("arm"), wavin: $("wavin"), savewav: $("savewav"),
        clear: $("clear"), noise: $("noise"), snr: $("snr"),
        twist: $("twist"), loop: $("loop"), selftest: $("selftest")
      };
      this._buildLeds();

      const saveP = () => {
        this.prefs.lat = this.ui.lat.value;
        this.prefs.lon = this.ui.lon.value;
        this.prefs.sym = parseInt(this.ui.sym.value, 10);
        this.prefs.ssid = this.ui.ssid.value;
        this.prefs.comment = this.ui.comment.value;
        this.prefs.path = this.ui.path.value;
        this.prefs.interval = parseInt(this.ui.int.value, 10);
        this.prefs.autoAck = this.ui.autoack.checked;
        savePrefs(this.prefs);
      };
      for (const k of ["lat", "lon", "sym", "ssid", "comment", "path", "int", "autoack"])
        this.ui[k].addEventListener("change", saveP);

      this.ui.beacon.addEventListener("click", () => this._sendBeacon());
      this.ui.auto.addEventListener("click", () => this._toggleAuto());
      this.ui.sendstatus.addEventListener("click", () => this._sendStatus());
      this.ui.msgsend.addEventListener("click", () => this._sendMsg());
      this.ui.arm.addEventListener("click", () => this._toggleArm());
      this.ui.wavin.addEventListener("change", e => {
        const f = e.target.files && e.target.files[0];
        if (f) this._decodeWav(f);
        e.target.value = "";
      });
      this.ui.savewav.addEventListener("click", () => this._saveWav());
      this.ui.clear.addEventListener("click", () => {
        this.stations.clear(); this._dirty = true;
        this._mon("stations cleared", "#5a6470");
      });
      this.ui.scale.addEventListener("change", () => { this._dirty = true; });
      this.ui.loop.addEventListener("click", () => this._loopback());
      this.ui.selftest.addEventListener("click", () => this._selfTest());

      this.pollTimer = setInterval(() => this._poll(), 150);
      this._mon("APRS monitor ready — " + this._myCall(), "#5a6470");
    },

    onDeactivate() {
      this.armed = false;
      if (this.beaconTimer) { clearInterval(this.beaconTimer); this.beaconTimer = null; }
      if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
      this.ui = null;
    },

    /* ---------------- helpers ---------------- */
    _buildLeds() {
      const names = ["PWR", "DCD", "RX", "TX", "ERR"];
      const colors = { PWR: "#3ddc84", DCD: "#4dd0e1", RX: "#ffb347",
                       TX: "#ffb347", ERR: "#ff5252" };
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
    _myCall() {
      const base = (this.ctx.settings().callsign || "N0CALL").toUpperCase().split("-")[0];
      const ss = parseInt(this.prefs.ssid, 10) || 0;
      return base + (ss ? "-" + ss : "");
    },
    _myPos() {
      const lat = parseFloat(this.ui ? this.ui.lat.value : this.prefs.lat);
      const lon = parseFloat(this.ui ? this.ui.lon.value : this.prefs.lon);
      if (!isFinite(lat) || !isFinite(lon)) return null;
      return { lat, lon };
    },
    _mon(text, color) {
      if (!this.ui) return;
      const d = document.createElement("div");
      const ts = new Date().toTimeString().slice(0, 8);
      d.textContent = `[${ts}] ${text}`;
      if (color) d.style.color = color;
      this.ui.log.appendChild(d);
      while (this.ui.log.childNodes.length > 300)
        this.ui.log.removeChild(this.ui.log.firstChild);
      this.ui.log.scrollTop = this.ui.log.scrollHeight;
    },

    /* ---------------- TX ---------------- */
    _pathList() {
      return this.ui.path.value.split(",").map(s => s.trim()).filter(Boolean);
    },
    _tx(infoStr, label) {
      try {
        const frame = buildUIFrame(APRS_DEST, this._myCall(), this._pathList(), infoStr);
        const er = Math.min(this.ctx.audio.ensureContext().sampleRate, 48000);   // synth ≤48 k regardless of context rate
        const audio = renderFrames([frame], er, {});
        this.ctx.audio.playPCM(audio, er);
        this._blink.tx = performance.now() + audio.length / er * 1000;
        this._mon(">>> " + this._myCall() + ">" + APRS_DEST +
          (this._pathList().length ? "," + this._pathList().join(",") : "") +
          ": " + infoStr, "#ffb347");
        if (label) this.ctx.log("APRS TX: " + label);
      } catch (e) {
        this.ctx.log("APRS TX failed: " + e.message);
      }
    },
    _sendBeacon() {
      const p = this._myPos();
      if (!p) { this._mon("set your coordinates first", "#ff5252"); return; }
      const sym = SYMBOLS[parseInt(this.ui.sym.value, 10)][0];
      this._tx(buildPosition(p.lat, p.lon, sym, this.ui.comment.value, true),
               "position beacon");
    },
    _toggleAuto() {
      if (this.beaconTimer) {
        clearInterval(this.beaconTimer);
        this.beaconTimer = null;
        this.ui.auto.textContent = "Auto ▶";
        this._mon("auto-beacon stopped", "#5a6470");
        return;
      }
      if (!this._myPos()) { this._mon("set your coordinates first", "#ff5252"); return; }
      const min = Math.max(1, parseInt(this.ui.int.value, 10) || 5);
      this._sendBeacon();
      this.beaconTimer = setInterval(() => this._sendBeacon(), min * 60000);
      this.ui.auto.textContent = "Auto ■";
      this._mon(`auto-beacon every ${min} min`, "#5a6470");
    },
    _sendStatus() {
      const t = this.ui.status.value.trim();
      if (t) this._tx(buildStatus(t), "status");
    },
    _sendMsg() {
      const to = splitCall(this.ui.msgto.value);
      const text = this.ui.msgtext.value.trim();
      if (!to || !text) { this._mon("message needs a callsign and text", "#ff5252"); return; }
      const seq = String(this.msgSeq++);
      this.pendingMsgs.set(seq, { to: callStr(to), text });
      this._tx(buildMessage(callStr(to), text, seq), "message to " + callStr(to));
    },

    /* ---------------- RX ---------------- */
    _mkRx(fs) {
      return new AfskRx(fs, (bytes, meta) => this._onFrame(bytes, meta));
    },
    _toggleArm() {
      if (this.armed) {
        this.armed = false;
        this.ui.arm.textContent = "ARM RX ▶";
        this._mon("RX disarmed", "#5a6470");
        return;
      }
      const arm = () => {
        const er = Math.min(this.ctx.audio.ensureContext().sampleRate, 48000);   // synth ≤48 k regardless of context rate
        if (!this.rx || this.rx.fs !== er) this.rx = this._mkRx(er);
        this.armed = true;
        this.ui.arm.textContent = "ARM RX ■ (armed)";
        this._mon("RX armed — listening for 1200 Bd packets", "#5a6470");
      };
      if (!this.ctx.audio.rxActive)
        this.ctx.audio.startRX().then(arm).catch(e => this.ctx.log("input error: " + e.message));
      else arm();
    },

    _onFrame(bytes, meta) {
      const f = parseFrame(bytes);
      if (!f) return;
      this._blink.rx = performance.now();
      this._mon(f.addrText + ": " + f.info.replace(/[\x00-\x1f]/g, "·"));
      const p = parseInfo(f.info, f.dest.call);
      const from = callStr(f.src);
      if (p.type === "pos" || p.type === "object") {
        const name = p.type === "object" ? p.name : from;
        this.stations.set(name, {
          call: name, lat: p.lat, lon: p.lon, table: p.table, code: p.code,
          comment: (p.comment || "").slice(0, 40), via: p.via || p.type,
          course: p.course, speedKt: p.speedKt, ts: Date.now()
        });
        this._dirty = true;
        const mine = this._myPos();
        let where = p.lat.toFixed(4) + ", " + p.lon.toFixed(4);
        if (mine) {
          const db = distBearing(mine.lat, mine.lon, p.lat, p.lon);
          where += ` · ${db.dist.toFixed(1)} km @ ${db.brg.toFixed(0)}°`;
        }
        this._mon(`  └ ${name} ${p.via === "Mic-E" ? "[Mic-E] " : ""}${where}` +
          (p.speedKt ? ` · ${(p.speedKt * 1.852).toFixed(0)} km/h` : ""), "#3ddc84");
      } else if (p.type === "msg") {
        const me = this._myCall();
        if (p.to === me || p.to === me.split("-")[0]) {
          this._mon(`  └ MESSAGE for you from ${from}: ${p.text}`, "#4dd0e1");
          if (p.seq !== undefined && this.ui && this.ui.autoack.checked)
            setTimeout(() => this._tx(buildAck(from, p.seq), "auto-ACK to " + from), 1200);
        } else {
          this._mon(`  └ msg ${from} → ${p.to}: ${p.text}`, "#5a6470");
        }
      } else if (p.type === "ack") {
        const pend = this.pendingMsgs.get(p.seq);
        if (pend && p.to.startsWith(this._myCall().split("-")[0])) {
          this._mon(`  └ ✓ delivered: "${pend.text}" acked by ${from}`, "#3ddc84");
          this.pendingMsgs.delete(p.seq);
        }
      } else if (p.type === "status") {
        this._mon(`  └ status ${from}: ${p.text}`, "#5a6470");
      }
    },

    async _decodeWav(file) {
      if (this._busy) return;
      this._busy = true;
      try {
        const wav = wavDecode(await file.arrayBuffer());
        this._mon(`decoding ${file.name}: ${(wav.samples.length / wav.rate).toFixed(1)} s @ ${wav.rate} Hz`, "#5a6470");
        const rx = this._mkRx(wav.rate);
        const before = rx.framesOk;
        const chunk = Math.round(wav.rate * 0.5);
        for (let p = 0; p < wav.samples.length; p += chunk) {
          rx.feed(wav.samples.subarray(p, Math.min(p + chunk, wav.samples.length)));
          await tick();
        }
        this._mon(`WAV done: ${rx.framesOk - before} frame(s), ${rx.crcErrors} CRC error(s)`, "#5a6470");
      } catch (e) {
        this.ctx.log("WAV decode failed: " + e.message);
      } finally {
        this._busy = false;
      }
    },

    _saveWav() {
      const p = this._myPos();
      if (!p) { this._mon("set your coordinates first", "#ff5252"); return; }
      try {
        const sym = SYMBOLS[parseInt(this.ui.sym.value, 10)][0];
        const frame = buildUIFrame(APRS_DEST, this._myCall(), this._pathList(),
          buildPosition(p.lat, p.lon, sym, this.ui.comment.value, true));
        const audio = renderFrames([frame], 48000, {});
        const buf = wavEncode16(audio, 48000);
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
        a.download = `aprs_beacon_${this._myCall().replace("-", "_")}.wav`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
        this._mon("beacon WAV saved (48 kHz mono)", "#5a6470");
      } catch (e) {
        this.ctx.log("WAV render failed: " + e.message);
      }
    },

    async _loopback() {
      if (this._busy) return;
      this._busy = true;
      try {
        const p = this._myPos() || { lat: 46.49, lon: -80.99 };
        const sym = SYMBOLS[parseInt(this.ui.sym.value, 10)][0];
        const me = this._myCall();
        const frames = [
          buildUIFrame(APRS_DEST, me, ["WIDE1-1"],
            buildPosition(p.lat, p.lon, sym, this.ui.comment.value, true)),
          buildUIFrame(APRS_DEST, "VE3TST-9", ["WIDE1-1", "WIDE2-1"],
            buildMessage(me, "loopback test de VE3TST", "7"))
        ];
        const snr = this.ui.noise.checked ? parseFloat(this.ui.snr.value) : null;
        const twist = parseFloat(this.ui.twist.value) || 0;
        this._mon(`loopback: 2 frames` +
          (snr !== null ? `, SNR ${snr} dB` : "") + `, twist ${twist} dB`, "#5a6470");
        const audio = renderFrames(frames, 48000, {});
        const y = new AfskChannel(48000, { snrDb: snr, twistDb: twist,
          gain: 0.5, seed: 7 }).process(audio);
        if (!this.rx || this.rx.fs !== 48000) this.rx = this._mkRx(48000);
        const chunk = 24000;
        for (let q = 0; q < y.length; q += chunk) {
          this.rx.feed(y.subarray(q, Math.min(q + chunk, y.length)));
          await tick();
        }
      } catch (e) {
        this.ctx.log("loopback failed: " + e.message);
      } finally {
        this._busy = false;
      }
    },

    async _selfTest() {
      const log = m => this.ctx.log("aprs self-test: " + m);
      const frame = buildUIFrame(APRS_DEST, "VA3JFL-9", ["WIDE1-1"],
        buildPosition(46.49, -80.99, "/>", "self test", true));
      for (const [label, opts] of [
        ["clean", { snrDb: null, twistDb: 0 }],
        ["12 dB SNR + 9 dB twist", { snrDb: 12, twistDb: 9 }]
      ]) {
        let got = 0;
        const rx = new AfskRx(48000, () => got++);
        const y = new AfskChannel(48000, Object.assign({ gain: 0.5, seed: 3 }, opts))
          .process(renderFrames([frame], 48000, {}));
        for (let p = 0; p < y.length; p += 24000) {
          rx.feed(y.subarray(p, Math.min(p + 24000, y.length)));
          await tick();
        }
        log(`${label}: ${got === 1 ? "PASS" : "FAIL"} (${got} frame)`);
      }
      log("done");
    },

    /* ---------------- meters + radar ---------------- */
    _poll() {
      if (!this.ui) return;
      const now = performance.now();
      this._led("RX", now - this._blink.rx < 350);
      this._led("TX", now < this._blink.tx);
      this._led("DCD", !!(this.rx && this.rx.dcd > 0));
      this._led("ERR", now - this._blink.err < 400);
      this.ui.state.textContent = this.armed ? "armed" : "idle";
      if (this.rx) {
        const bar = (label, v, lo, hi) => {
          const f = clamp((v - lo) / (hi - lo), 0, 1);
          const b = Math.round(f * 18);
          return `${label} ${"█".repeat(b)}${"░".repeat(18 - b)} ${v.toFixed(1)}`;
        };
        this.ui.bars.innerHTML =
          bar("LEVEL", this.rx.level, -60, 0) + " dBFS<br>" +
          bar("QUAL ", this.rx.quality * 66, 0, 100) + " %";
        this.ui.stats.textContent =
          `${this.rx.framesOk} frames · ${this.rx.crcErrors} CRC errors · ` +
          `${this.stations.size} stations heard`;
        if (this.rx.crcErrors !== this._lastCrc) {
          this._blink.err = now;
          this._lastCrc = this.rx.crcErrors;
        }
      }
      if (this._dirty) { this._dirty = false; this._renderTable(); this._renderRadar(); }
    },

    _renderTable() {
      const mine = this._myPos();
      const rows = [...this.stations.values()]
        .sort((a, b) => b.ts - a.ts).slice(0, 60);
      this.ui.table.innerHTML = rows.map(st => {
        let dist = "—", brg = "—";
        if (mine) {
          const db = distBearing(mine.lat, mine.lon, st.lat, st.lon);
          dist = db.dist.toFixed(1); brg = db.brg.toFixed(0) + "°";
        }
        const age = Math.round((Date.now() - st.ts) / 1000);
        const ageS = age < 90 ? age + "s" : Math.round(age / 60) + "m";
        return `<tr style="border-top:1px solid rgba(96,114,150,0.15)">
          <td style="color:#3ddc84">${st.call}</td><td>${dist}</td><td>${brg}</td>
          <td>${st.via}</td><td>${ageS}</td>
          <td style="color:#8a94a3">${st.comment || ""}</td></tr>`;
      }).join("");
    },

    _renderRadar() {
      const cv = this.ui.radar, c = cv.getContext("2d");
      const W = cv.width, R = W / 2 - 6, cx = W / 2, cy = W / 2;
      c.fillStyle = "#05070b";
      c.fillRect(0, 0, W, W);
      c.strokeStyle = "#181d24";
      for (let i = 1; i <= 4; i++) {
        c.beginPath();
        c.arc(cx, cy, R * i / 4, 0, 2 * Math.PI);
        c.stroke();
      }
      c.beginPath(); c.moveTo(cx, 6); c.lineTo(cx, W - 6); c.stroke();
      c.beginPath(); c.moveTo(6, cy); c.lineTo(W - 6, cy); c.stroke();
      c.fillStyle = "#5a6470";
      c.font = "8px monospace";
      const scale = parseFloat(this.ui.scale.value);
      c.fillText("N", cx - 3, 12);
      c.fillText(scale + "km", cx + R * 0.72, cy - 3);
      const mine = this._myPos();
      c.fillStyle = "#ffb347";
      c.fillRect(cx - 2, cy - 2, 4, 4);
      if (!mine) {
        c.fillStyle = "#5a6470";
        c.fillText("set coordinates", cx - 36, cy + 16);
        return;
      }
      for (const st of this.stations.values()) {
        const db = distBearing(mine.lat, mine.lon, st.lat, st.lon);
        if (db.dist > scale) continue;
        const r = R * db.dist / scale;
        const a = (db.brg - 90) * Math.PI / 180;
        const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
        c.fillStyle = "#3ddc84";
        c.beginPath(); c.arc(x, y, 3, 0, 2 * Math.PI); c.fill();
        c.fillStyle = "#c9d1d9";
        c.fillText(st.call, x + 4, y + 3);
      }
    }
  };

  const HOST = (typeof HRWS !== "undefined" && HRWS)
    || (typeof window !== "undefined" ? window.HRWS : null);
  if (HOST) HOST.registerModule(def);

  /* headless test hook */
  window.__APRS_TEST__ = {
    fcs16, splitCall, encodeAddr, decodeAddr, buildUIFrame, parseFrame,
    frameToStuffedBits, afskSynth, renderFrames, AfskRx, AfskChannel,
    buildPosition, buildStatus, buildMessage, buildAck,
    parseInfo, parseMicE, parseLatLon, parseCompressed,
    distBearing, wavEncode16, wavDecode, SYMBOLS, APRS_DEST
  };
})();


