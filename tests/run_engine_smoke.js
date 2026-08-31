#!/usr/bin/env node
/* Core smoke for js/audio-engine.js — the one file every module trusts
   and no module test executes (they all stub it, which is how a
   ReferenceError lived in the streaming pipe undetected). This loads the
   REAL engine against a stub AudioContext and pushes real samples through
   openMonitorStream / openTXStream / playPCM.
   Run:  node run_engine_smoke.js   (plain node, no dependencies) */
"use strict";
const fs = require("fs");
const path = require("path");

let failures = 0;
function check(name, ok, extra) {
  if (ok) console.log("  ok  " + name);
  else { console.log("FAIL  " + name + (extra ? " — " + extra : "")); failures++; }
}

/* ---------------- stub Web Audio ---------------- */
function param(v) {
  return { value: v, setValueAtTime() {}, linearRampToValueAtTime() {},
           setTargetAtTime() {}, exponentialRampToValueAtTime() {},
           cancelScheduledValues() {} };
}
function makeNode(ctx) {
  return {
    connect(n) { return n; }, disconnect() {},
    start(when) {
      ctx._starts++;
      if (ctx._sched && this.buffer)
        ctx._sched.push({ when: when || 0,
                          data: Float32Array.from(this.buffer.getChannelData(0)) });
      if (this.onended) setTimeout(() => this.onended(), 0);
    },
    stop() {},
    gain: param(1), frequency: param(0), Q: param(1),
    buffer: null, onended: null,
    fftSize: 2048, frequencyBinCount: 1024, smoothingTimeConstant: 0.8,
    getByteFrequencyData() {}, getFloatTimeDomainData() {},
    stream: {}
  };
}
class StubAudioContext {
  constructor(opts) {
    this.sampleRate = (opts && opts.sampleRate) || 48000;
    this.state = "running";
    this.currentTime = 0;
    this.destination = makeNode(this);
    this._starts = 0;
    this._buffers = [];
  }
  resume() { this.state = "running"; return Promise.resolve(); }
  close() { return Promise.resolve(); }
  createGain() { return makeNode(this); }
  createAnalyser() { return makeNode(this); }
  createBiquadFilter() { return makeNode(this); }
  createScriptProcessor() { return makeNode(this); }
  createMediaStreamSource() { return makeNode(this); }
  createMediaStreamDestination() { return makeNode(this); }
  createBuffer(ch, len, rate) {
    const chans = [];
    for (let i = 0; i < ch; i++) chans.push(new Float32Array(len));
    const b = { numberOfChannels: ch, length: len, sampleRate: rate,
                getChannelData: i => chans[i] };
    this._buffers.push(b);
    return b;
  }
  createBufferSource() { return makeNode(this); }
}

const win = { AudioContext: StubAudioContext };
const doc = { createElement: () => ({ getContext: () => null, style: {} }) };

const src = fs.readFileSync(path.join(__dirname, "..", "js", "audio-engine.js"), "utf8");
let AudioEngine;
try {
  AudioEngine = new Function("window", "document", "navigator", "performance",
    src + "\n;return AudioEngine;")(
    win, doc, { mediaDevices: {} }, { now: () => Date.now() });
} catch (e) {
  check("audio-engine.js evaluates", false, e.message);
  console.log(`\n1 FAILURE(S)`);
  process.exit(1);
}
check("audio-engine.js evaluates", typeof AudioEngine === "function");

(async () => {
  const eng = new AudioEngine();
  let ctx;
  try { ctx = eng.ensureContext(); } catch (e) { ctx = null; }
  check("ensureContext builds the bus graph",
        !!ctx && !!eng.txBus && !!eng.monitorBus && !!eng.txGainNode);

  /* -------- the pipe that carried the bug -------- */
  let st = null, err = null;
  try {
    st = eng.openMonitorStream(24000, 0.09);
    const block = new Float32Array(384).fill(1.0);
    st.push(block);
    st.push(new Float32Array(384));                 // silence follows fine
  } catch (e) { err = e; }
  check("openMonitorStream().push() runs (the OUT_TRIM regression)",
        !err, err && (err.stack || "").split("\n")[0]);
  if (!err) {
    const buf = ctx._buffers[0];
    check("pushed samples reached a scheduled buffer",
          ctx._starts > 0 && !!buf && buf.length > 0);
    const expect = Math.pow(10, -2.5 / 20);
    let peak = 0, finite = true;
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      if (!Number.isFinite(d[i])) finite = false;
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
    }
    check("output trim is one static -2.5 dB", Math.abs(peak - expect) < 1e-3,
          "peak " + peak.toFixed(4) + " vs " + expect.toFixed(4));
    check("samples all finite", finite);
    check("24 kHz push was resampled to context rate",
          Math.abs(buf.length - 384 * ctx.sampleRate / 24000) < 8,
          buf.length + " samples");
    st.stop();
  }

  /* -------- TX pipe -------- */
  err = null;
  try {
    const tx = eng.openTXStream(12000, 0.1);
    tx.push(new Float32Array(240).fill(0.5));
    tx.close();
  } catch (e) { err = e; }
  check("openTXStream().push()/close() runs", !err,
        err && (err.stack || "").split("\n")[0]);

  /* -------- one-shot playback -------- */
  err = null;
  try {
    await Promise.race([
      eng.playPCM(new Float32Array(480).fill(0.25), 48000),
      new Promise(r => setTimeout(r, 300))
    ]);
  } catch (e) { err = e; }
  check("playPCM completes", !err, err && err.message);

  /* -------- stream reconstruction: no gaps, no overlaps, clean --------
     A "tunnel"/flanger sound requires a delayed copy: overlapping sources
     or repeated audio. This reconstructs the exact scheduled stream and
     proves neither can happen, then measures the resampler on a sine. */
  {
    const eng2 = new AudioEngine();
    const c2 = eng2.ensureContext();
    c2._sched = [];
    const st2 = eng2.openMonitorStream(24000, 0.05);
    let ph = 0;
    const w = 2 * Math.PI * 1000 / 24000;
    for (let b = 0; b < 40; b++) {
      const blk = new Float32Array(480);
      for (let i = 0; i < 480; i++) { ph += w; blk[i] = 0.6 * Math.sin(ph); }
      st2.push(blk);
    }
    st2.stop();
    const sch = c2._sched;
    check("stream scheduled its buffers", sch.length >= 40, sch.length + " buffers");
    let overlap = false, gapMax = 0;
    for (let i = 1; i < sch.length; i++) {
      const d = sch[i].when - (sch[i - 1].when + sch[i - 1].data.length / c2.sampleRate);
      if (d < -1e-9) overlap = true;
      gapMax = Math.max(gapMax, Math.abs(d));
    }
    check("no overlapping sources (echo/flange is impossible)", !overlap);
    check("gapless joints", gapMax < 1e-9, "max joint error " + gapMax.toExponential(2) + " s");
    let len = 0;
    for (const s of sch) len += s.data.length;
    const y = new Float32Array(len);
    { let p = 0; for (const s of sch) { y.set(s.data, p); p += s.data.length; } }
    const wOut = w * 24000 / c2.sampleRate;
    const M = len - 800;
    let cs = 0, sn = 0;
    for (let k = 400; k < len - 400; k++) { cs += y[k] * Math.cos(wOut * k); sn += y[k] * Math.sin(wOut * k); }
    const A = 2 * Math.hypot(cs, sn) / M, phi = Math.atan2(cs, sn);
    let se = 0, sr2 = 0;
    for (let k = 400; k < len - 400; k++) {
      const ideal = A * Math.sin(wOut * k + phi);
      const d = y[k] - ideal;
      se += d * d; sr2 += ideal * ideal;
    }
    const snr = 10 * Math.log10(sr2 / Math.max(se, 1e-20));
    check("reconstructed stream is one clean sine: " + snr.toFixed(1) + " dB", snr >= 45);
    const trim = Math.pow(10, -2.5 / 20);
    check("level is input x OUT_TRIM, no double-summing: A " + A.toFixed(3), Math.abs(A - 0.6 * trim) < 0.02);
  }

  /* -------- no other ghosts: every capitalized identifier resolves ----
     (a ReferenceError anywhere above would have failed its check; this
     is a cheap net for constants referenced only in rare branches) */
  const ids = new Set((src.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) || []));
  const undeclared = [...ids].filter(id =>
    !new RegExp("(const|let|var|class|function)\\s+" + id + "\\b").test(src) &&
    !/^(URL|RMS|DAC|IBM|LAN|FSK|PSK|BPSK|QAM|OFDM|SSTV|AUDIO|LINEAR|LIVE|ONE|ONLY|OUTPUT|RAW|README|JSON|NaN|TX|RX)$/.test(id) &&
    new RegExp("[^.\\w]" + id + "\\b(?!\\s*:)").test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "")));
  check("no undeclared SHOUTING constants in code", undeclared.length === 0,
        undeclared.join(", "));

  console.log(failures ? `\n${failures} FAILURE(S)` : "\naudio-engine smoke passed");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
