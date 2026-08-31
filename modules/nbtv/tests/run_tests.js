#!/usr/bin/env node
/* Headless checks for the NBTV media additions. */
"use strict";
const fs = require("fs");
const path = require("path");

/* ---- minimal browser stubs so the module IIFE loads ------------------ */
global.window = {};
global.document = { createElement: () => ({}) };   // Encoder guards getContext

require("/home/claude/ham-radio-web-studio/modules/nbtv/module.js");
const T = global.window.__NBTV_TEST__;

let failures = 0;
function check(name, ok, extra) {
  if (ok) console.log("  ok  " + name);
  else { console.log("FAIL  " + name + (extra ? " — " + extra : "")); failures++; }
}
const J = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, n), "utf8"));
const B = (n) => new Uint8Array(fs.readFileSync(path.join(__dirname, n)));

/* ===================== 1. GIF decoder ================================= */
console.log("[gif decoder]");
{
  const exp = J("solid.expected.json");
  const g = T.decodeGif(B("solid.gif"));
  check("solid: size", g.width === exp.w && g.height === exp.h);
  check("solid: frame count", g.frames.length === 3, "got " + g.frames.length);
  check("solid: delays", JSON.stringify(g.frames.map(f => f.delayMs)) ===
    JSON.stringify(exp.delays), JSON.stringify(g.frames.map(f => f.delayMs)));
  let bad = 0;
  for (let i = 0; i < 3; i++) {
    const want = exp.frames[i], got = g.frames[i].rgba;
    for (let p = 0, q = 0; p < want.length; p += 3, q += 4)
      if (got[q] !== want[p] || got[q + 1] !== want[p + 1] ||
          got[q + 2] !== want[p + 2] || got[q + 3] !== 255) bad++;
  }
  check("solid: pixel-exact", bad === 0, bad + " wrong px");
}
{
  const exp = J("delta.expected.json");
  const g = T.decodeGif(B("delta.gif"));
  check("delta: frame count", g.frames.length === exp.frames.length);
  let bad = 0, worst = "";
  for (let i = 0; i < exp.frames.length; i++) {
    const want = exp.frames[i], got = g.frames[i].rgba;
    for (let p = 0, q = 0; p < want.length; p += 3, q += 4)
      if (got[q] !== want[p] || got[q + 1] !== want[p + 1] || got[q + 2] !== want[p + 2]) {
        bad++; if (!worst) worst = `frame ${i} px ${p / 3}`;
      }
  }
  check("delta: partial frames composite pixel-exact", bad === 0,
    bad + " wrong px, first at " + worst);
}
{
  const exp = J("dispose.expected.json");
  const g = T.decodeGif(B("dispose.gif"));
  check("dispose: frame count", g.frames.length === exp.nframes);
  const want = exp.frame0, got = g.frames[0].rgba;
  let bad = 0;
  for (let p = 0, q = 0; p < want.length; p += 3, q += 4)
    if (got[q] !== want[p] || got[q + 1] !== want[p + 1] || got[q + 2] !== want[p + 2]) bad++;
  check("dispose: first frame exact", bad === 0, bad + " wrong px");
  /* disposal 2 must actually clear: frame 2's box region outside frame 3's
     paint must not still be green everywhere (alpha 0 where cleared) */
  check("dispose: decode did not throw + 3 composited buffers",
    g.frames.every(f => f.rgba.length === exp.w * exp.h * 4));
}
{
  const exp = J("interlace.expected.json");
  const g = T.decodeGif(B("interlace.gif"));
  const got = g.frames[0].rgba;
  let bad = 0;
  for (let i = 0; i < exp.grey.length; i++)
    if (got[i * 4] !== exp.grey[i]) bad++;
  check("interlace: row de-interleave pixel-exact", bad === 0, bad + " wrong px");
}
{
  let threw = false;
  try { T.decodeGif(new Uint8Array([1, 2, 3, 4])); } catch (e) { threw = true; }
  check("garbage input throws cleanly", threw);
}

/* ===================== 2. sliceTrack ================================== */
console.log("[sliceTrack]");
{
  const rate = 48000, f0 = 1000, dur = 0.8;
  const n = Math.round(rate * dur);
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = Math.sin(2 * Math.PI * f0 * i / rate);
  const trk = { data, rate, dur: n / rate };

  /* same-rate consecutive slices == contiguous read */
  const fps = 12.5, per = rate / fps;
  let maxErr = 0, pos = 0;
  for (let k = 0; k < 8; k++) {
    const s = T.sliceTrack(trk, k / fps, per, rate);
    for (let i = 0; i < per; i++, pos++) {
      const e = Math.abs(s[i] - data[pos % n]);
      if (e > maxErr) maxErr = e;
    }
  }
  check("same-rate slices are sample-exact incl. loop wrap", maxErr < 1e-6,
    "maxErr " + maxErr);

  /* cross-rate: 48k -> 96k linear interpolation error stays tiny */
  const out = T.sliceTrack(trk, 0.1, 9600, 96000);
  let werr = 0;
  for (let i = 0; i < out.length; i++) {
    const srcPos = 0.1 * rate + i * rate / 96000;
    const i0 = Math.floor(srcPos) % n, i1 = (i0 + 1) % n, fr = srcPos - Math.floor(srcPos);
    const want = data[i0] + (data[i1] - data[i0]) * fr;
    const e = Math.abs(out[i] - want);
    if (e > werr) werr = e;
  }
  check("96 kHz resample matches reference interpolation", werr < 1e-6, "err " + werr);

  /* empty / missing track -> silence, no crash */
  const z = T.sliceTrack(null, 0, 100, 48000);
  check("null track gives silence", z.length === 100 && z.every(v => v === 0));
}

/* ===================== 3. SndTx ring balance ========================== */
console.log("[SndTx ring]");
{
  const tx = new T.SndTx(48000, 7400);
  let drift = false;
  for (let k = 0; k < 200; k++) {
    const nlen = 3840 + (k % 3);          // varying frame lengths, like spl rounding
    tx.push(new Float32Array(nlen));
    tx.mixInto(new Float32Array(nlen));
    if (tx.wp !== tx.rp) drift = true;
  }
  check("push/mix stays in lockstep (no ring drift)", !drift);
}

/* ===================== 4. end-to-end sound-in-vision ================== */
console.log("[TX -> demod round trip — television-style sound plan]");
{
  const mode = T.MODES[0];                              // club32
  const rate = 48000;
  const g = new T.Geometry(mode, rate);
  const lineRate = g.lines * g.fps;
  const plan = T.sndPlan(mode, rate, null);             // Direct cable

  check("carrier sits on the half-line tooth grid",
    Math.abs(((plan.f / lineRate) % 1) - 0.5) < 1e-9, "f " + plan.f);
  check("carrier above the video guard (TV-style)",
    plan.f > plan.guard * 1.6 && plan.f <= 19000,
    `f ${plan.f} guard ${plan.guard.toFixed(0)}`);
  check("club32 Direct plan: 17 kHz carrier, video moat to 7.4 kHz",
    plan.f === 17000 && Math.abs(plan.guard - 7380) < 1,
    `f ${plan.f} guard ${plan.guard}`);
  check("every wide setting keeps the full moat (the 7k magic everywhere)",
    plan.f - T.sndPlan(mode, rate, 15000).guard >= 3.6 * 2600 &&
    plan.f - T.sndPlan(mode, rate, 10000).guard >= 3.6 * 2600,
    "gaps " + (plan.f - T.sndPlan(mode, rate, 15000).guard));
  const p60 = T.sndPlan(T.MODES.find(m => m.id === "e60") || T.MODES[1], rate, null);
  check("plan adapts per mode", p60.f !== plan.f || p60.guard !== plan.guard,
    `e60 f ${p60.f}`);
  check("carrier stays at the top on narrow filters (video-only shaping)",
    T.sndPlan(mode, rate, 5000).f === plan.f, "5k -> " + T.sndPlan(mode, rate, 5000).f);

  const f0 = 800, durS = 2, nFrames = Math.round(durS * g.fps);
  const nA = rate * durS, audio = new Float32Array(nA);
  for (let i = 0; i < nA; i++) audio[i] = 0.8 * Math.sin(2 * Math.PI * f0 * i / rate);
  const trk = { data: audio, rate, dur: durS };

  function stairGrid() {
    const gr = new Float32Array(g.lines * g.nPx * 3);
    for (let li = 0; li < g.lines; li++) {
      const rg = 0.5 + 0.5 * Math.sin(2 * Math.PI * li / g.lines);
      for (let j = 0; j < g.nPx; j++) {
        const v = (0.1 + 0.8 * j / (g.nPx - 1)) * rg;
        gr.set([v, v, v], (li * g.nPx + j) * 3);
      }
    }
    return gr;
  }
  function flatGrid() { return new Float32Array(g.lines * g.nPx * 3).fill(0.5); }

  /* full TX path: encode -> sound guard -> carrier mix; RX: decoder with
     notch at the plan frequency + SndRxCore */
  function run(grid, sndOn, sr, guardOnly) {
    const fs = sr || rate;
    const gg = new T.Geometry(mode, fs);
    const pl = T.sndPlan(mode, fs, null);
    const enc = new T.Encoder(gg, "mono"); enc.setFrameFromGrid(grid);
    const dec = new T.Decoder(gg, "mono"); dec.setSyncLevel(0.15);
    dec.setSoundNotch(pl.f);                     // always on, like the app
    const guard = (sndOn || guardOnly) ? new T.FIRLowpass(fs, pl.guard) : null;
    const tx = sndOn ? new T.SndTx(fs, pl.f, pl.aud) : null;
    const nFr = Math.round(durS * gg.fps);
    const chunks = []; let frames = [];
    for (let i = 0; i < nFr; i++) {
      let comp = enc.encodeFrame().comp;
      if (guard) comp = guard.process(comp);
      if (tx) { tx.push(T.sliceTrack({ data: audio, rate, dur: durS }, i / gg.fps, comp.length, fs)); tx.mixInto(comp); }
      chunks.push(comp);
      frames = frames.concat(dec.feed(comp, null));
    }
    let tot = 0; for (const c of chunks) tot += c.length;
    const s = new Float32Array(tot); let p = 0;
    for (const c of chunks) { s.set(c, p); p += c.length; }
    return { s, frames, fs, plan: pl, g: gg };
  }
  const mean = a => { let x = 0; for (const v of a) x += v; return x / a.length; };
  function corrOf(out, fs) {
    const skip = Math.round(0.4 * fs);
    let cs = 0, cc = 0, oo = 0, nn = 0;
    for (let i = skip; i < out.length; i++) {
      const ph = 2 * Math.PI * f0 * i / fs;
      cs += out[i] * Math.sin(ph); cc += out[i] * Math.cos(ph);
      oo += out[i] * out[i]; nn++;
    }
    return Math.sqrt(cs * cs + cc * cc) / Math.sqrt(oo * nn / 2 + 1e-12);
  }
  function pearson(a, b) {
    const ma = mean(a), mb = mean(b); let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; ab += x * y; aa += x * x; bb += y * y; }
    return ab / Math.sqrt(aa * bb + 1e-12);
  }

  const base = run(flatGrid(), false);
  check("baseline (no sound) still decodes", base.frames.length >= nFrames - 2,
    "frames " + base.frames.length);
  const talk = run(flatGrid(), true);
  check("decoder still frames up with the subcarrier riding",
    talk.frames.length >= nFrames - 2, "frames " + talk.frames.length);
  /* fair comparison: a talkie is by design a sound-guarded picture, so
     it must match a guarded SILENT decode — the carrier itself now costs
     nothing (it lives outside the video band, behind the always-on notch) */
  const silG = run(flatGrid(), false, rate, true);
  const lumaG = mean(silG.frames.at(-1).rgb), lumaT = mean(talk.frames.at(-1).rgb);
  check("talkie luma matches the guarded silent baseline (±0.02)",
    Math.abs(lumaT - lumaG) < 0.02, `talkie ${lumaT.toFixed(3)} vs ${lumaG.toFixed(3)}`);
  const corr48 = corrOf(new T.SndRxCore(rate, talk.plan.f, lineRate).demod(talk.s), rate);
  check("800 Hz soundtrack recovered (corr > 0.9)", corr48 > 0.9, "corr " + corr48.toFixed(3));

  const sc = run(stairGrid(), false, rate, true), st = run(stairGrid(), true);
  const r = pearson(sc.frames.at(-1).rgb, st.frames.at(-1).rgb);
  check("staircase talkie tracks the guarded silent decode (r > 0.995)", r > 0.995, "r " + r.toFixed(4));
  const scFull = run(stairGrid(), false);
  const rG = pearson(scFull.frames.at(-1).rgb, sc.frames.at(-1).rgb);
  check("sound guard keeps a faithful (if softer) picture (r > 0.95 vs full-BW)",
    rG > 0.95, "r " + rG.toFixed(4));

  /* 44.1 kHz device: the fractional-delay comb must stay tuned */
  const t44 = run(flatGrid(), true, 44100);
  const core44 = new T.SndRxCore(44100, t44.plan.f, t44.g.lines * t44.g.fps);
  check("fractional comb: 44.1 kHz round trip decodes sound (corr > 0.85)",
    corrOf(core44.demod(t44.s), 44100) > 0.85,
    "corr " + corrOf(new T.SndRxCore(44100, t44.plan.f, t44.g.lines * t44.g.fps).demod(t44.s), 44100).toFixed(3));
  check("44.1 kHz picture frames up", t44.frames.length >= Math.round(durS * t44.g.fps) - 2,
    "frames " + t44.frames.length);

  /* torture text image (dense line-to-line detail): the guard keeps the
     soundtrack listenable — this was −4 dB before the TV-style plan */
  function textGrid() {
    const gr = new Float32Array(g.lines * g.nPx * 3);
    let seed = 777;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let li = 0; li < g.lines; li++)
      for (let j = 0; j < g.nPx; j++) {
        let v = (li % 2) ? 0.75 : 0.2;
        if (li > 4 && li < 12 && ((j >> 2) % 2 === Math.floor(rnd() * 2))) v = rnd() > 0.5 ? 0.9 : 0.1;
        gr.set([v, v, v], (li * g.nPx + j) * 3);
      }
    return gr;
  }
  const tx3 = run(textGrid(), true);
  const out3 = new T.SndRxCore(rate, tx3.plan.f, lineRate).demod(tx3.s);
  const skip3 = Math.round(0.5 * rate);
  let cs3 = 0, cc3 = 0, n3 = 0;
  for (let i = skip3; i < out3.length; i++) {
    const ph = 2 * Math.PI * f0 * i / rate;
    cs3 += out3[i] * Math.sin(ph); cc3 += out3[i] * Math.cos(ph); n3++;
  }
  const A3 = 2 * cs3 / n3, B3 = 2 * cc3 / n3;
  let res3 = 0;
  for (let i = skip3; i < out3.length; i++) {
    const ph = 2 * Math.PI * f0 * i / rate;
    const rr = out3[i] - A3 * Math.sin(ph) - B3 * Math.cos(ph);
    res3 += rr * rr;
  }
  const snr3 = 20 * Math.log10(Math.sqrt((A3 * A3 + B3 * B3) / 2) / Math.sqrt(res3 / n3));
  check("torture text image: soundtrack SNR > 16 dB", snr3 > 16, "snr " + snr3.toFixed(1) + " dB");
}

/* [6] carrier squelch: no subcarrier, or non-NBTV input, must leave the
   speaker silent — without it the AGC amplifies comb residue to grind */
{
  const mode = T.MODES[0], rate = 48000;
  const g = new T.Geometry(mode, rate);
  const plan = T.sndPlan(mode, rate, null);
  const lineRate = g.lines * g.fps;
  const durS = 2, nFrames = Math.round(durS * g.fps);
  function outRms(x) {
    const out = new T.SndRxCore(rate, plan.f, lineRate).demod(x);
    const skip = Math.round(0.6 * rate);
    let r = 0, n = 0;
    for (let i = skip; i < out.length; i++) { r += out[i] * out[i]; n++; }
    return Math.sqrt(r / n);
  }
  const enc = new T.Encoder(g, "mono");
  const gr = new Float32Array(g.lines * g.nPx * 3);
  for (let li = 0; li < g.lines; li++)
    for (let j = 0; j < g.nPx; j++) {
      const v = 0.1 + 0.8 * j / (g.nPx - 1);
      gr.set([v, v, v], (li * g.nPx + j) * 3);
    }
  enc.setFrameFromGrid(gr);
  const chunks = [];
  for (let i = 0; i < nFrames; i++) chunks.push(enc.encodeFrame().comp);
  let tot = 0; for (const c of chunks) tot += c.length;
  const pic = new Float32Array(tot); let p6 = 0;
  for (const c of chunks) { pic.set(c, p6); p6 += c.length; }
  const rmsPic = outRms(pic);
  check("squelch: silent picture (no carrier) stays quiet", rmsPic < 0.01, "rms " + rmsPic.toFixed(4));
  const noise = new Float32Array(rate * durS);
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < noise.length; i++) noise[i] = 0.3 * (rand() * 2 - 1);
  const rmsN = outRms(noise);
  check("squelch: white noise input stays quiet", rmsN < 0.01, "rms " + rmsN.toFixed(4));
  const tone = new Float32Array(rate * durS);
  for (let i = 0; i < tone.length; i++) tone[i] = 0.5 * Math.sin(2 * Math.PI * 1000 * i / rate);
  const rmsT = outRms(tone);
  check("squelch: plain audio input stays quiet", rmsT < 0.01, "rms " + rmsT.toFixed(4));
}

/* [7] source audit: the pump and other UI paths never run headless, so a
   runtime crash there (like an assignment to a const) freezes the app while
   this suite stays green. Catch that class statically. */
{
  const fs = require("fs"), path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "module.js"), "utf8");
  function constReassignments(text) {
    const lines = text.split("\n");
    const found = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*const\s+([A-Za-z_$][\w$]*)\s*=/);
      if (!m) continue;
      const name = m[1];
      let depth = 0;
      for (let j = i + 1; j < Math.min(i + 250, lines.length); j++) {
        depth += (lines[j].match(/{/g) || []).length - (lines[j].match(/}/g) || []).length;
        if (depth < 0) break;
        const re = new RegExp("(^|[^.\\w$\\-])" + name.replace(/\$/g, "\\$") + "\\s*=(?![=>])");
        if (re.test(lines[j]) && !/\b(const|let|var)\b/.test(lines[j])) {
          found.push(`${name} const@${i + 1} reassigned@${j + 1}`);
          break;
        }
      }
    }
    return found;
  }
  const planted = constReassignments("function f() {\n  const x = 1;\n  x = 2;\n}");
  check("audit scanner catches a planted const reassignment", planted.length === 1,
    planted.join("; "));
  const hits = constReassignments(src);
  check("module has no assignments to const bindings", hits.length === 0, hits.join("; "));
}

/* [8] narrow-filter talkies: the sound channel scales its bandwidth with
   the carrier's clearance, so comms filters give clean comms-grade audio
   instead of a wide IF grinding on the picture band (3.8 dB before) */
{
  const mode = T.MODES[0], rate = 48000;
  const g = new T.Geometry(mode, rate);
  const lineRate = g.lines * g.fps;
  const plan = T.sndPlan(mode, rate, 3400);
  check("comms plan: carrier stays high, moat widens", plan.f === 17000 && plan.f - 3400 > 13000,
    "f " + plan.f);
  check("comms plan keeps full audio bandwidth", plan.aud === 2600,
    "aud " + Math.round(plan.aud));
  check("wide plan keeps full audio bandwidth", T.sndPlan(mode, rate, null).aud === 2600,
    "aud " + T.sndPlan(mode, rate, null).aud);
  const f0 = 500, durS = 3, nFrames = Math.round(durS * g.fps);
  const nA = rate * durS, audio = new Float32Array(nA);
  for (let i = 0; i < nA; i++) audio[i] = 0.8 * Math.sin(2 * Math.PI * f0 * i / rate);
  const trk = { data: audio, rate, dur: durS };
  const enc = new T.Encoder(g, "mono");
  const gr = new Float32Array(g.lines * g.nPx * 3);
  let seed = 777;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let li = 0; li < g.lines; li++)
    for (let j = 0; j < g.nPx; j++) {
      let v = (li % 2) ? 0.75 : 0.2;
      if (li > 4 && li < 12 && ((j >> 2) % 2 === Math.floor(rnd() * 2))) v = rnd() > 0.5 ? 0.9 : 0.1;
      gr.set([v, v, v], (li * g.nPx + j) * 3);
    }
  enc.setFrameFromGrid(gr);
  const userFir = new T.FIRLowpass(rate, 3400);
  const tx = new T.SndTx(rate, plan.f, plan.aud);
  const chunks = [];
  for (let i = 0; i < nFrames; i++) {
    let comp = enc.encodeFrame().comp;
    comp = userFir.process(comp);
    tx.push(T.sliceTrack(trk, i / g.fps, comp.length, rate));
    tx.mixInto(comp);
    chunks.push(comp);
  }
  let tot = 0; for (const c of chunks) tot += c.length;
  const s8 = new Float32Array(tot); let p8 = 0;
  for (const c of chunks) { s8.set(c, p8); p8 += c.length; }
  const out = new T.SndRxCore(rate, plan.f, lineRate, plan.aud).demod(s8);
  const skip = Math.round(0.5 * rate);
  let cs = 0, cc = 0, nn = 0;
  for (let i = skip; i < out.length; i++) {
    const ph = 2 * Math.PI * f0 * i / rate;
    cs += out[i] * Math.sin(ph); cc += out[i] * Math.cos(ph); nn++;
  }
  const A = 2 * cs / nn, B = 2 * cc / nn;
  let res = 0;
  for (let i = skip; i < out.length; i++) {
    const ph = 2 * Math.PI * f0 * i / rate;
    const r = out[i] - A * Math.sin(ph) - B * Math.cos(ph);
    res += r * r;
  }
  const snr = 20 * Math.log10(Math.sqrt((A * A + B * B) / 2) / Math.sqrt(res / nn));
  check("3.4 kHz comms talkie: torture image SNR > 14 dB", snr > 14,
    "snr " + snr.toFixed(1) + " dB");
}

/* [9] raw AM: no gain riding, ever. A -20 dB soundtrack must come out
   -20 dB relative to a full-scale one — the modulator may not "help". */
{
  const mode = T.MODES[0], rate = 48000;
  const g = new T.Geometry(mode, rate);
  const lineRate = g.lines * g.fps;
  const plan = T.sndPlan(mode, rate, null);
  const durS = 2, nFrames = Math.round(durS * g.fps);
  function levelOf(amp) {
    const nA = rate * durS, audio = new Float32Array(nA);
    for (let i = 0; i < nA; i++) audio[i] = amp * Math.sin(2 * Math.PI * 500 * i / rate);
    const enc = new T.Encoder(g, "mono");
    enc.setFrameFromGrid(new Float32Array(g.lines * g.nPx * 3).fill(0.5));
    const guard = new T.FIRLowpass(rate, plan.guard);
    const tx = new T.SndTx(rate, plan.f, plan.aud);
    const trk = { data: audio, rate, dur: durS };
    const chunks = [];
    for (let i = 0; i < nFrames; i++) {
      let comp = enc.encodeFrame().comp;
      comp = guard.process(comp);
      tx.push(T.sliceTrack(trk, i / g.fps, comp.length, rate));
      tx.mixInto(comp);
      chunks.push(comp);
    }
    let tot = 0; for (const c of chunks) tot += c.length;
    const s9 = new Float32Array(tot); let p9 = 0;
    for (const c of chunks) { s9.set(c, p9); p9 += c.length; }
    const out = new T.SndRxCore(rate, plan.f, lineRate, plan.aud).demod(s9);
    const skip = Math.round(0.6 * rate);
    let cs = 0, cc = 0, nn = 0;
    for (let i = skip; i < out.length; i++) {
      const ph = 2 * Math.PI * 500 * i / rate;
      cs += out[i] * Math.sin(ph); cc += out[i] * Math.cos(ph); nn++;
    }
    return Math.sqrt(((2 * cs / nn) ** 2 + (2 * cc / nn) ** 2) / 2);
  }
  const loud = levelOf(0.8), quiet = levelOf(0.08);
  const ratio = 20 * Math.log10(quiet / loud);
  check("raw AM linearity: -20 dB in comes out -20 dB (±1.5)",
    Math.abs(ratio + 20) < 1.5, ratio.toFixed(1) + " dB");
}

/* [10] colour registration: the sound-guard FIR delays the luma; the
   chroma rides a matched delay or the colour lands ~50 px off. */
{
  const mode = T.MODES[0], rate = 48000;
  const g = new T.Geometry(mode, rate);
  const plan = T.sndPlan(mode, rate, null);
  const durS = 2, nFrames = Math.round(durS * g.fps);
  const nA = rate * durS, audio = new Float32Array(nA);
  for (let i = 0; i < nA; i++) audio[i] = 0.6 * Math.sin(2 * Math.PI * 500 * i / rate);
  function grid() {
    const gr = new Float32Array(g.lines * g.nPx * 3);
    for (let li = 0; li < g.lines; li++)
      for (let j = 0; j < g.nPx; j++) {
        const o = (li * g.nPx + j) * 3;
        if (j > 8 && j < 30 && li > 8 && li < 24) { gr[o] = 0.9; gr[o + 1] = 0.1; gr[o + 2] = 0.1; }
        else { gr[o] = gr[o + 1] = gr[o + 2] = 0.45; }
      }
    return gr;
  }
  function run(sndOn) {
    const enc = new T.Encoder(g, "yc");
    enc.setFrameFromGrid(grid());
    const dec = new T.Decoder(g, "yc"); dec.setSyncLevel(0.15);
    dec.setSoundNotch(plan.f);
    const guard = sndOn ? new T.FIRLowpass(rate, plan.guard) : null;
    const tx = sndOn ? new T.SndTx(rate, plan.f, plan.aud) : null;
    let cdl = null, cdp = 0, frames = [];
    for (let i = 0; i < nFrames; i++) {
      const fr = enc.encodeFrame();
      let comp = fr.comp, chroma = fr.chroma;
      if (guard) {
        comp = guard.process(comp);
        if (chroma && guard.delay > 0) {
          if (!cdl) cdl = new Float32Array(guard.delay);
          const c2 = new Float32Array(chroma.length);
          for (let k = 0; k < chroma.length; k++) {
            c2[k] = cdl[cdp]; cdl[cdp] = chroma[k]; cdp = (cdp + 1) % cdl.length;
          }
          chroma = c2;
        }
      }
      if (tx) {
        tx.push(T.sliceTrack({ data: audio, rate, dur: durS }, i / g.fps, comp.length, rate));
        tx.mixInto(comp);
      }
      frames = frames.concat(dec.feed(comp, chroma));
    }
    return frames.at(-1).rgb;
  }
  function redCentroid(rgb) {
    let rx = 0, rw = 0;
    for (let li = 10; li < 22; li++)
      for (let j = 0; j < g.nPx; j++) {
        const o = (li * g.nPx + j) * 3;
        const rness = Math.max(0, rgb[o] - (rgb[o + 1] + rgb[o + 2]) / 2);
        rx += rness * j; rw += rness;
      }
    return rx / (rw || 1);
  }
  const shift = Math.abs(redCentroid(run(true)) - redCentroid(run(false)));
  check("Y/C talkie: colour registered with luminance (< 3 px)", shift < 3,
    "shift " + shift.toFixed(2) + " px");
}

/* [11] hot-transient headroom: a normalized (0.98 peak) track with sharp
   onsets must pass the raw modulator without clipping distortion — the
   safety clamp sits above the high-pass filter's transient overshoot. */
{
  const mode = T.MODES[0], rate = 48000;
  const g = new T.Geometry(mode, rate);
  const lineRate = g.lines * g.fps;
  const plan = T.sndPlan(mode, rate, null);
  const durS = 3, nFrames = Math.round(durS * g.fps);
  const nA = rate * durS, audio = new Float32Array(nA);
  for (let i = 0; i < nA; i++) {
    const t = i / rate;
    const gate = (t * 5) % 1 < 0.5 ? 1 : 0;
    audio[i] = gate * 0.98 * Math.sin(2 * Math.PI * 700 * i / rate);
  }
  const enc = new T.Encoder(g, "mono");
  enc.setFrameFromGrid(new Float32Array(g.lines * g.nPx * 3).fill(0.5));
  const guard = new T.FIRLowpass(rate, plan.guard);
  const tx = new T.SndTx(rate, plan.f, plan.aud);
  const trk = { data: audio, rate, dur: durS };
  const chunks = [];
  for (let i = 0; i < nFrames; i++) {
    let comp = enc.encodeFrame().comp;
    comp = guard.process(comp);
    tx.push(T.sliceTrack(trk, i / g.fps, comp.length, rate));
    tx.mixInto(comp);
    chunks.push(comp);
  }
  let tot = 0; for (const c of chunks) tot += c.length;
  const s11 = new Float32Array(tot); let p11 = 0;
  for (const c of chunks) { s11.set(c, p11); p11 += c.length; }
  let clip = 0;
  for (let i = 0; i < s11.length; i++) if (Math.abs(s11[i]) > 1) clip++;
  const out = new T.SndRxCore(rate, plan.f, lineRate, plan.aud).demod(s11);
  const skip = Math.round(0.6 * rate);
  function amp(hf) {
    let cs = 0, cc = 0, nn = 0;
    for (let i = skip; i < out.length; i++) {
      const t = i / rate;
      if ((t * 5) % 1 > 0.08 && (t * 5) % 1 < 0.45) {
        const ph = 2 * Math.PI * hf * i / rate;
        cs += out[i] * Math.sin(ph); cc += out[i] * Math.cos(ph); nn++;
      }
    }
    return Math.sqrt(((2 * cs / nn) ** 2 + (2 * cc / nn) ** 2) / 2);
  }
  const a1 = amp(700), thd = 20 * Math.log10(Math.sqrt(amp(1400) ** 2 + amp(2100) ** 2) / a1);
  check("hot bursts: no composite clipping", clip === 0, "clips " + clip);
  check("hot bursts: harmonic distortion < -35 dB", thd < -35, thd.toFixed(1) + " dB");
}

/* [12] word attacks: hard consonants after a pause must come through at
   full amplitude from the first millisecond — no envelope-tracking
   ceiling may crush them (the "spit" on C's and A's, ratio was 0.37). */
{
  const mode = T.MODES[0], rate = 48000;
  const g = new T.Geometry(mode, rate);
  const lineRate = g.lines * g.fps;
  const plan = T.sndPlan(mode, rate, null);
  const durS = 4, nFrames = Math.round(durS * g.fps);
  const nA = rate * durS, audio = new Float32Array(nA);
  for (let i = 0; i < nA; i++) {
    const t = i / rate, cyc = t % 0.5;
    audio[i] = (cyc >= 0.3 ? 1 : 0) * 0.95 * Math.sin(2 * Math.PI * 700 * i / rate);
  }
  const enc = new T.Encoder(g, "mono");
  enc.setFrameFromGrid(new Float32Array(g.lines * g.nPx * 3).fill(0.5));
  const guard = new T.FIRLowpass(rate, plan.guard);
  const tx = new T.SndTx(rate, plan.f, plan.aud);
  const trk = { data: audio, rate, dur: durS };
  const chunks = [];
  for (let i = 0; i < nFrames; i++) {
    let comp = enc.encodeFrame().comp;
    comp = guard.process(comp);
    tx.push(T.sliceTrack(trk, i / g.fps, comp.length, rate));
    tx.mixInto(comp);
    chunks.push(comp);
  }
  let tot = 0; for (const c of chunks) tot += c.length;
  const s12 = new Float32Array(tot); let p12 = 0;
  for (const c of chunks) { s12.set(c, p12); p12 += c.length; }
  const out = new T.SndRxCore(rate, plan.f, lineRate, plan.aud).demod(s12);
  let atk = 0, an = 0, std = 0, sn = 0;
  for (let i = rate; i < out.length; i++) {
    const t = i / rate, cyc = t % 0.5;
    if (cyc >= 0.301 && cyc < 0.307) { atk += out[i] * out[i]; an++; }
    if (cyc >= 0.36 && cyc < 0.48) { std += out[i] * out[i]; sn++; }
  }
  const ratio = Math.sqrt(atk / an) / Math.sqrt(std / sn);
  check("word attacks arrive uncrushed (first 6 ms > 0.8x steady)", ratio > 0.8,
    "ratio " + ratio.toFixed(3));
}

/* [13] no dynamics in output paths — the policy, enforced. Static gains
   only; scheduling cushions adaptive; no compressor/waveshaper nodes
   anywhere in the project. */
{
  const fs = require("fs"), path = require("path");
  const root = path.join(__dirname, "..", "..", "..");
  const eng = fs.readFileSync(path.join(root, "js", "audio-engine.js"), "utf8");
  check("engine: static output trim present", eng.includes("OUT_TRIM"), "");
  check("engine: no per-chunk gain ratchet", !eng.includes("_scale = 1 / pk"), "");
  check("engine: adaptive stream cushion", eng.includes("st.lead = Math.min(0.45"), "");
  const vlf = fs.readFileSync(path.join(root, "modules", "vlf", "module.js"), "utf8");
  check("vlf player: adaptive cushion", vlf.includes("this.lead = Math.min(0.45"), "");
  let dyn = 0;
  const scan = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "tests") scan(fp); }
      else if (e.name.endsWith(".js")) {
        const t = fs.readFileSync(fp, "utf8");
        if (t.includes("createDynamicsCompressor") || t.includes("createWaveShaper")) dyn++;
      }
    }
  };
  scan(path.join(root, "js")); scan(path.join(root, "modules"));
  check("project: zero compressor/waveshaper nodes", dyn === 0, "found " + dyn);
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall tests passed");
process.exit(failures ? 1 : 0);
