#!/usr/bin/env node
/* Headless checks for the D-SSTV Audio Postcard engine (VREC-mini).
   Run:  node run_postcard_tests.js
   Writes postcard_crosscompat.png for the desktop-VREC decode check
   (driven by run_all.sh / the python step below). */
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

global.window = {};
global.document = { createElement: () => ({ getContext: () => null, style: {} }) };

require("/home/claude/ham-radio-web-studio/modules/dsstv/module.js");
const T = global.window.__DSSTV_TEST__;

let failures = 0;
function check(name, ok, extra) {
  if (ok) console.log("  ok  " + name);
  else { console.log("FAIL  " + name + (extra ? " — " + extra : "")); failures++; }
}
const S = T.PC_S;

/* ============ 1. geometry: every sample owns a unique pixel =========== */
console.log("[geometry]");
{
  const g = T.pcGeom(S), cap = T.pcCapacity(S);
  check("capacity 26235", cap === 26235, "got " + cap);
  const seen = new Uint8Array(S * S);
  const pt = { x: 0, y: 0 };
  let dup = 0, oob = 0;
  for (let i = 0; i < cap; i++) {
    T.pcXY(i, g, pt);
    if (pt.x < 0 || pt.y < 0 || pt.x >= S || pt.y >= S) { oob++; continue; }
    const k = pt.y * S + pt.x;
    if (seen[k]) dup++;
    seen[k] = 1;
  }
  check("spiral: 0 duplicate pixels", dup === 0, dup + " dups");
  check("spiral: 0 out of bounds", oob === 0, oob + " oob");

  /* header ring never touches the spiral, and is itself collision-free */
  let ringDup = 0, ringOnData = 0;
  const ringSeen = new Uint8Array(S * S);
  T.pcRingXY(S, (x, y) => {
    const k = y * S + x;
    if (seen[k]) ringOnData++;
    if (ringSeen[k]) ringDup++;
    ringSeen[k] = 1;
  });
  check("ring: 0 pixels on the spiral", ringOnData === 0, ringOnData);
  check("ring: 0 duplicate pixels", ringDup === 0, ringDup);

  /* cosmetic midpoints must never overwrite data pixels (paint guard) */
  const img = { width: S, height: S, data: new Uint8ClampedArray(S * S * 4) };
  const codes = new Uint8Array(cap);
  for (let i = 0; i < cap; i++) codes[i] = (i * 37) & 0xff;
  T.pcPaintRange(img, codes, 0, cap, cap);
  let bad = 0;
  for (let i = 0; i < cap; i++) {
    T.pcXY(i, g, pt);
    if (img.data[(pt.y * S + pt.x) * 4 + 1] !== codes[i]) bad++;
  }
  check("paint: all data pixels survive midpoints", bad === 0, bad + " clobbered");
}

/* ============ 2. mu-law + ring bytes vs Python reference ============== */
console.log("[reference vectors]");
{
  const IN = [-1.0, -0.5, -0.1, -0.01, 0.0, 0.003, 0.05, 0.33, 0.77, 1.0];
  const OUT = [0, 16, 52, 98, 128, 141, 188, 230, 249, 255];
  let enc = true;
  for (let i = 0; i < IN.length; i++)
    if (T.pcMulawEncode(IN[i]) !== OUT[i]) enc = false;
  check("mu-law encode matches vinyl_codec", enc);

  const PROBE = [0, 1, 64, 127, 128, 129, 200, 255];
  const VALS = [-1.0, -0.9572737086635957, -0.05814500388034755,
                -8.621159565072034e-05, 8.621159565072034e-05,
                0.00026436226853700933, 0.08788022623483743, 1.0];
  let dec = true;
  for (let i = 0; i < PROBE.length; i++)
    if (Math.abs(T.PC_ULAW[PROBE[i]] - VALS[i]) > 3e-7) dec = false;
  check("mu-law decode LUT matches vinyl_codec", dec);

  const REF = "565245430101800c00007b660000dc05aa05f8113a07e4cbdf18";
  const ring = T.pcPackRing(3200, 26235);
  const hex = Array.from(ring).map(b => b.toString(16).padStart(2, "0")).join("");
  check("ring record byte-exact vs struct.pack + zlib.crc32", hex === REF, hex);
  const parsed = T.pcParseRing(ring, 0);
  check("ring parses back", !!parsed && parsed.rate === 3200 &&
        parsed.n === 26235 && Math.abs(parsed.pitch - 1.5) < 1e-9 &&
        Math.abs(parsed.step - 1.45) < 1e-9 &&
        Math.abs(parsed.fInner - 0.185) < 1e-9);
  ring[9] ^= 1;
  check("ring CRC rejects damage", T.pcParseRing(ring, 0) === null);
}

/* ============ 3. press + pixel round trip (headless canvasless) ======= */
console.log("[pixel round trip]");
function makeVoice(n, sr) {
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    y[i] = 0.5 * Math.sin(2 * Math.PI * 220 * t) *
           (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t)) +
           0.2 * Math.sin(2 * Math.PI * 590 * t + 1.3);
  }
  return y;
}
let pressed;                      /* reused by later sections */
{
  const sr = 48000;
  pressed = T.pcPress(makeVoice(sr * 5, sr), sr, 3200);
  check("press: rate honored", pressed.rate === 3200, pressed.rate);
  check("press: ~5 s of samples", Math.abs(pressed.n - 16000) <= 2, pressed.n);

  const img = { width: S, height: S, data: new Uint8ClampedArray(S * S * 4) };
  T.pcBackground(img);
  T.pcWriteRing(img, pressed.rate, pressed.n);
  T.pcPaintRange(img, pressed.codes, 0, pressed.n, pressed.n);

  const hdr = T.pcReadRing(img);
  check("optical ring read", !!hdr && hdr.rate === 3200 && hdr.n === pressed.n);
  const back = T.pcReadCodes(img, hdr);
  let diff = 0;
  for (let i = 0; i < pressed.n; i++) if (back[i] !== pressed.codes[i]) diff++;
  check("optical groove read: byte-exact", diff === 0, diff + " bytes differ");

  /* progressive painting: silence first, then chunks, still byte-exact */
  const img2 = { width: S, height: S, data: new Uint8ClampedArray(S * S * 4) };
  T.pcBackground(img2);
  T.pcWriteRing(img2, pressed.rate, pressed.n);
  const blank = new Uint8Array(pressed.n).fill(128);
  T.pcPaintRange(img2, blank, 0, pressed.n, pressed.n);
  const grow = new Uint8Array(pressed.n).fill(128);
  const order = [];                                  /* shuffled chunk order */
  for (let c = 0; c * T.PC_CHUNK < pressed.n; c++) order.push(c);
  for (let i = order.length - 1; i > 0; i--) {
    const j = (i * 2654435761 >>> 8) % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (const c of order) {
    const a = c * T.PC_CHUNK, b = Math.min(pressed.n, a + T.PC_CHUNK);
    grow.set(pressed.codes.subarray(a, b), a);
    T.pcPaintRange(img2, grow, a, b, pressed.n);
  }
  const back2 = T.pcReadCodes(img2, T.pcReadRing(img2));
  let diff2 = 0;
  for (let i = 0; i < pressed.n; i++) if (back2[i] !== pressed.codes[i]) diff2++;
  check("progressive paint: byte-exact after shuffled chunks", diff2 === 0,
        diff2 + " bytes differ");
}

/* ============ 4. fit plan ============================================= */
console.log("[fit plan]");
{
  const cap = T.pcCapacity(S);
  const p1 = T.pcFitPlan(5, 3200, cap);
  check("5 s @ 3200 fits untouched", p1.rate === 3200 && !p1.trimmed);
  const p2 = T.pcFitPlan(15, 4800, cap);
  check("15 s auto-drops toward DX", p2.rate <= 1750 && p2.rate % 25 === 0 &&
        !p2.trimmed, JSON.stringify(p2));
  const p3 = T.pcFitPlan(30, 4800, cap);
  check("30 s floors at 1600 and trims", p3.rate === 1600 && p3.trimmed);
}

/* ============ 5. link round trip (encode -> demod -> chunks) ========== */
console.log("[link round trip]");
(async () => {
  const fs2 = 12000;
  const enc = T.encodePostcardD(pressed.codes, pressed.rate, 1, fs2, false);
  check("air stream produced", enc.y.length > fs2 && enc.layout === "postcard",
        enc.y.length + " samples");
  check("airtime estimate within 3 s of actual",
        Math.abs(T.pcAirEstimate(pressed.n, 1, false) - enc.airS) < 3,
        `est ${T.pcAirEstimate(pressed.n, 1, false).toFixed(1)} vs ${enc.airS.toFixed(1)}`);

  let sawHeader = null, chunkCalls = 0;
  const res = await T.decodeSignalD(enc.y, fs2, {
    log: () => {},
    onPostcard: p => { sawHeader = p; },
    onChunk: () => { chunkCalls++; }
  });
  check("postcard header decoded", !!res.postcard && !!sawHeader &&
        res.postcard.rate === pressed.rate && res.postcard.n === pressed.n);
  check("all chunks received", res.postcard &&
        res.postcard.got === res.postcard.nChunks,
        res.postcard ? `${res.postcard.got}/${res.postcard.nChunks}` : "none");
  check("onChunk fired per chunk", chunkCalls === res.postcard.nChunks,
        chunkCalls + " calls");
  let diff = 0;
  for (let i = 0; i < pressed.n; i++)
    if (res.postcard.codes[i] !== pressed.codes[i]) diff++;
  check("groove bytes byte-exact over the air", diff === 0, diff + " differ");

  /* FEC holds through a noisy SSB channel, like the image mode */
  const noisy = T.channelSimulate(enc.y, fs2, 2700, 10, 7, "ssb");
  const nres = await T.decodeSignalD(noisy, fs2, { log: () => {} });
  check("SSB 2.7 kHz @ 10 dB SNR: every chunk survives",
        nres.postcard && nres.postcard.got === nres.postcard.nChunks,
        nres.postcard ? `${nres.postcard.got}/${nres.postcard.nChunks}` : "none");
  let ndiff = 0;
  if (nres.postcard)
    for (let i = 0; i < pressed.n; i++)
      if (nres.postcard.codes[i] !== pressed.codes[i]) ndiff++;
  check("noisy channel: groove still byte-exact", ndiff === 0, ndiff + " differ");

  /* image mode untouched: old header path still round-trips */
  const img = T.testPattern(160, 120);
  const ienc = T.encodeImageD(img, T.QUALITY.med, 1, fs2, false);
  const ires = await T.decodeSignalD(ienc.y, fs2, { log: () => {} });
  check("image mode regression: all stripes",
        ires.stats.stripesOk === ienc.nStripes && !ires.postcard,
        `${ires.stats.stripesOk}/${ienc.nStripes}`);

  /* ============ 6. desktop-VREC cross-compat PNG ====================== */
  console.log("[cross-compat PNG]");
  const full = { width: S, height: S, data: new Uint8ClampedArray(S * S * 4) };
  T.pcBackground(full);
  T.pcWriteRing(full, pressed.rate, pressed.n);
  T.pcPaintRange(full, pressed.codes, 0, pressed.n, pressed.n);
  fs.writeFileSync(path.join(__dirname, "postcard_crosscompat.png"),
                   pngEncode(full));
  const sha = crypto.createHash("sha256")
    .update(Buffer.from(pressed.codes)).digest("hex");
  fs.writeFileSync(path.join(__dirname, "postcard_crosscompat.json"),
    JSON.stringify({ rate: pressed.rate, n: pressed.n, codes_sha: sha }));
  console.log("  ok  wrote postcard_crosscompat.png (+ expected json)");

  console.log("[press anti-alias]");
{
  /* mixed tone: 700 Hz in-band + 3.1 kHz beyond target Nyquist. A press
     without the brickwall would fold 3.1 kHz to 900 Hz — the singing harp */
  const sr = 24000, secs = 2, N = sr * secs;
  const x = new Float32Array(N);
  for (let i = 0; i < N; i++)
    x[i] = 0.45 * Math.sin(2 * Math.PI * 700 * i / sr) +
           0.45 * Math.sin(2 * Math.PI * 3100 * i / sr);
  const pr = T.pcPress(x, sr, 4000);
  const y = new Float32Array(pr.n);
  for (let i = 0; i < pr.n; i++) y[i] = T.PC_ULAW[pr.codes[i]];
  const goe = f => {
    let cr = 0, ci = 0;
    for (let k = 200; k < pr.n - 200; k++) {
      const ph = 2 * Math.PI * f * k / pr.rate;
      cr += y[k] * Math.cos(ph); ci += y[k] * Math.sin(ph);
    }
    return Math.hypot(cr, ci) / (pr.n - 400);
  };
  const inBand = goe(700), alias = goe(900);
  const dB = 20 * Math.log10(alias / Math.max(inBand, 1e-12));
  check("press keeps the in-band tone", inBand > 0.2, inBand.toFixed(3));
  check("press folds nothing: alias at 900 Hz is " + dB.toFixed(1) +
        " dB below 700 Hz", dB <= -35);
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall postcard tests passed");
  process.exit(failures ? 1 : 0);
})();

/* --------------- minimal PNG writer (RGBA8, filter 0) ----------------- */
function pngEncode(img) {
  const { width: w, height: h, data } = img;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * w * 4, w * 4)
      .copy(raw, y * (w * 4 + 1) + 1);
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type, "ascii"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(T.crc32(new Uint8Array(tb)) >>> 0);
    return Buffer.concat([len, tb, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}
