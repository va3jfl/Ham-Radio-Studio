#!/usr/bin/env node
/* UI smoke for Digital SSTV — builds the actual panel in a headless DOM,
   checks every ui element resolved, then runs a scripted turntable
   session: load, motor, needle drop, verify the pump actually advances
   the groove, eject. Catches panel wiring bugs and dead-pump regressions.
   Run:  node run_ui_smoke.js          (needs jsdom: `npm i jsdom`,
                                        or NODE_PATH=<dir>/node_modules)   */
"use strict";
let JSDOM;
try { ({ JSDOM } = require("jsdom")); }
catch (e) {
  console.log("  (jsdom not installed — skipping UI smoke; `npm i jsdom` to enable)");
  process.exit(0);
}
const path = require("path");

let failures = 0;
function check(name, ok, extra) {
  if (ok) console.log("  ok  " + name);
  else { console.log("FAIL  " + name + (extra ? " — " + extra : "")); failures++; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const dom = new JSDOM("<!doctype html><html><body></body></html>",
                      { pretendToBeVisual: true });
const win = dom.window;

function fake2d(cv) {
  const store = { canvas: cv };
  const grad = () => ({ addColorStop() {} });
  const target = {
    canvas: cv,
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    createRadialGradient: grad, createLinearGradient: grad,
    createPattern: () => ({}),
    measureText: () => ({ width: 8 })
  };
  return new Proxy(target, {
    get(t, k) { if (k in t) return t[k]; if (k in store) return store[k]; return () => undefined; },
    set(t, k, v) { store[k] = v; return true; }
  });
}
win.HTMLCanvasElement.prototype.getContext = function () { return fake2d(this); };
win.HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,";
win.URL.createObjectURL = () => "blob:smoke";
win.URL.revokeObjectURL = () => {};

global.window = win;
global.document = win.document;
/* keep Node's native performance — jsdom's recurses when made global */
global.requestAnimationFrame = win.requestAnimationFrame.bind(win);
global.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
try { global.navigator = win.navigator; }
catch (e) { Object.defineProperty(global, "navigator", { value: win.navigator, configurable: true }); }
global.Blob = win.Blob;
global.Image = win.Image;

let registered = null;
global.HRWS = { registerModule: d => { registered = d; } };

let monitorPushed = 0, monitorOpens = 0;
const ctx = {
  audio: {
    ctx: undefined,                       // no Web Audio here: wall-clock path
    onSamples() {}, ensureContext() { return { sampleRate: 48000 }; },
    startRX: async () => {}, rxActive: false,
    playPCM() {}, stopTX() {}, stopAll() {},
    openTXStream() { return { push() {}, close() {}, stop() {} }; },
    openMonitorStream() {
      monitorOpens++;
      return { push(a) { monitorPushed += a.length; }, stop() {}, close() {} };
    }
  },
  log: () => {},
  settings: () => ({ callsign: "VA3TST" })
};

(async () => {
  console.log("[ui smoke: Digital SSTV]");
  require(path.join(__dirname, "..", "module.js"));
  check("module registered with the host", !!registered && registered.id === "dsstv");

  registered.init(ctx);
  const panel = win.document.createElement("div");
  win.document.body.appendChild(panel);
  let built = true, err = null;
  try { registered.createPanel(panel); }
  catch (e) { built = false; err = e; }
  check("createPanel builds without throwing", built, err && (err.stack || err.message));
  if (!built) process.exit(1);

  const missing = Object.entries(registered.ui)
    .filter(([, v]) => !v).map(([k]) => k);
  check("every this.ui element resolved", missing.length === 0, missing.join(", "));

  /* ---------------- scripted turntable session ---------------- */
  registered._deckEnsure();
  registered.ui.deckCard.style.display = "";
  const deck = registered.deck;
  check("deck constructed", !!deck);

  /* a blank canvas has no readable ring: load must refuse politely */
  const blank = win.document.createElement("canvas");
  blank.width = 320; blank.height = 320;
  check("ring-only load of a blank disc is refused",
        deck.load(blank, null, "BLANK") === false && !deck.loaded);
  check("refusal reported on the info line", /header ring/.test(deck._fault || ""),
        deck._fault);

  /* with link metadata (the RX path) it loads */
  check("load with fallback metadata", deck.load(blank, { n: 16000, rate: 3200 },
        "TEST DISC") === true && deck.loaded);

  /* the user's exact flow: motor, then needle on the groove */
  deck.startStop();
  check("motor starts a monitor stream", deck.motorOn && monitorOpens === 1);
  await sleep(250);
  check("idle pump feeds the stream", monitorPushed > 24000 * 0.15,
        monitorPushed + " samples in 250 ms");
  const p0 = monitorPushed;

  deck.dropNeedle(0);
  check("needle drop enters PLAYING", deck.mode === "playing");
  const arm0 = deck.armR;
  await sleep(450);
  check("the groove actually advances (the frozen-at-0:01 bug)",
        deck.pos > 3200 * 0.25, "pos " + deck.pos.toFixed(0) +
        " of " + deck.meta.n + " after 450 ms");
  check("pump kept feeding while playing", monitorPushed - p0 > 24000 * 0.3,
        (monitorPushed - p0) + " samples");
  check("no deck fault", !deck._fault, deck._fault);
  check("tonearm tracks the groove inward (not just for looks)",
        deck.armR < arm0 - 1.2,
        "armR " + arm0.toFixed(1) + " -> " + deck.armR.toFixed(1) + " px");

  /* transparency: the pickup must be bit-honest by default */
  check("surface noise defaults OFF (checkbox + deck)",
        deck.sfxOn === false && registered.ui.pcSfx && !registered.ui.pcSfx.checked);
  for (let i = 0; i < 40; i++) deck._renderBlock(384);   // settle spin-up
  let blk = deck._renderBlock(384);
  let mn = Infinity, mx = -Infinity;
  for (const v of blk) { if (v < mn) mn = v; if (v > mx) mx = v; }
  check("clean pickup: constant groove comes out flat (no added dirt)",
        mx - mn < 1e-9, (mx - mn).toExponential(2));
  deck.sfxOn = true;
  for (let i = 0; i < 3; i++) blk = deck._renderBlock(384);
  mn = Infinity; mx = -Infinity;
  for (const v of blk) { if (v < mn) mn = v; if (v > mx) mx = v; }
  check("surface-noise toggle actually adds the theater",
        mx - mn > 1e-4, (mx - mn).toExponential(2));
  deck.sfxOn = false;

  /* draw loop is alive (rAF under pretendToBeVisual) */
  const t1 = deck._lastT;
  await sleep(80);
  check("draw loop ticking", deck._lastT !== t1);

  /* ------------- end-to-end fidelity: groove -> ear ------------- */
  {
    const T = win.__DSSTV_TEST__;
    const rate = 3200, n = Math.round(rate * 2.0);
    const codes = new Uint8Array(n);
    for (let i = 0; i < n; i++)
      codes[i] = T.pcMulawEncode(0.6 * Math.sin(2 * Math.PI * 440 * i / rate));
    const img = { width: 320, height: 320, data: new Uint8ClampedArray(320 * 320 * 4) };
    T.pcBackground(img);
    T.pcWriteRing(img, rate, n);
    T.pcPaintRange(img, codes, 0, n, n);
    const ring = T.pcReadRing(img);
    check("pressed pixels carry a readable ring", !!ring && ring.n === n && ring.rate === rate);

    deck.load(blank, { n, rate }, "FIDELITY");
    deck.img = img;                        // the real pressed pixels
    deck._closeStream();
    deck._endLatch = true;                 // no auto-return mid-measure
    deck.sfxOn = false;
    deck.motorOn = true; deck.motorEnv = 1;
    deck.mode = "playing"; deck.pos = 0; deck.vel = deck.baseV;
    const chunks = [];
    let guard = 0;
    while (deck.pos < n - 2 && guard++ < 3000) chunks.push(deck._renderBlock(384));
    let len = 0;
    for (const c of chunks) len += c.length;
    const y = new Float32Array(len);
    { let p = 0; for (const c of chunks) { y.set(c, p); p += c.length; } }
    const ref = T.pcRenderSide(img, { n, rate });
    const m = Math.min(y.length, ref.length) - 200;
    let se = 0, sr = 0, corr = 0, ne = 0, nr = 0;
    for (let k = 100; k < m; k++) {
      const d = y[k] - ref[k];
      se += d * d; sr += ref[k] * ref[k];
      corr += y[k] * ref[k]; ne += y[k] * y[k]; nr += ref[k] * ref[k];
    }
    const snr = 10 * Math.log10(sr / Math.max(se, 1e-20));
    const rho = corr / Math.sqrt(Math.max(ne * nr, 1e-20));
    check("live pickup === ground-truth formula: " + snr.toFixed(1) + " dB", snr >= 60);
    check("no doubling/echo in the pickup: corr " + rho.toFixed(6), rho >= 0.9999);
    /* fit amplitude+phase (the reconstruction filter's group delay is a
       delay, not a degradation) and measure the residual */
    {
      const wT = 2 * Math.PI * 440 / 48000, M = m - 100;
      let cs = 0, sn = 0;
      for (let k = 100; k < m; k++) { cs += y[k] * Math.cos(wT * k); sn += y[k] * Math.sin(wT * k); }
      const A = 2 * Math.hypot(cs, sn) / M, phi = Math.atan2(cs, sn);
      let seT = 0, srT = 0;
      for (let k = 100; k < m; k++) {
        const ideal = A * Math.sin(wT * k + phi);
        const d = y[k] - ideal;
        seT += d * d; srT += ideal * ideal;
      }
      const snrT = 10 * Math.log10(srT / Math.max(seT, 1e-20));
      check("440 Hz tone through the groove: " + snrT.toFixed(1) +
            " dB residual (mu-law-limited)", snrT >= 24);
    }
    /* reconstruction filter: interpolation images of 440 Hz around the
       3200 Hz disc rate (2760/3640 Hz) must be buried */
    const goertzel = (sig, f, fs, a, b) => {
      let cr = 0, ci = 0;
      for (let k = a; k < b; k++) {
        const ph = 2 * Math.PI * f * k / fs;
        cr += sig[k] * Math.cos(ph); ci += sig[k] * Math.sin(ph);
      }
      return Math.hypot(cr, ci) / (b - a);
    };
    const a0 = 4800, b0 = m;
    const fund = goertzel(y, 440, 48000, a0, b0);
    const img1 = goertzel(y, 2760, 48000, a0, b0);
    const img2 = goertzel(y, 3640, 48000, a0, b0);
    const imDb = 20 * Math.log10(Math.max(img1, img2) / Math.max(fund, 1e-12));
    check("interpolation images buried: " + imDb.toFixed(1) + " dB below the tone",
          imDb <= -28);
    deck.mode = "rest"; deck.motorOn = false;
  }

  /* ------------- v2: a 16-bit PCM pressing plays natively ------------- */
  {
    const T = win.__DSSTV_TEST__;
    const rate = 3200, n = Math.round(rate * 1.5), S = 320;
    const img = { width: S, height: S, data: new Uint8ClampedArray(S * S * 4) };
    /* v2 header ring: repack v1 bytes, flip version/flags, refresh the CRC */
    const rec = Uint8Array.from(T.pcPackRing(rate, n));
    rec[4] = 2; rec[5] = 0x02;
    const c = T.crc32(rec.subarray(0, 22)) >>> 0;
    rec[22] = c & 255; rec[23] = (c >> 8) & 255;
    rec[24] = (c >> 16) & 255; rec[25] = (c >> 24) & 255;
    T.pcRingXY(S, (x, y2, i) => {
      const v = rec[i % 26], p = (y2 * S + x) * 4;
      img.data[p] = v; img.data[p + 1] = v; img.data[p + 2] = v; img.data[p + 3] = 255;
    });
    /* 16-bit samples: hi byte in G, low nibbles split across R and B */
    const pt = { x: 0, y: 0 };
    const g = T.pcGeom(S);
    for (let i = 0; i < n; i++) {
      const v = 0.6 * Math.sin(2 * Math.PI * 440 * i / rate);
      const u = Math.max(0, Math.min(65535, Math.round(v * 32767) + 32768));
      T.pcXY(i, g, pt);
      const p = (pt.y * S + pt.x) * 4;
      img.data[p] = (u >> 4) & 15;
      img.data[p + 1] = (u >> 8) & 255;
      img.data[p + 2] = u & 15;
      img.data[p + 3] = 255;
    }
    const ring = T.pcReadRing(img);
    check("v2 ring reads (version 2, PCM16 flag)",
          !!ring && ring.version === 2 && !!(ring.flags & 0x02) && ring.n === n);
    check("deck loads the v2 disc ring-only",
          deck.load(img, null, "V2 CD") === true && deck.is16 === true);
    deck._closeStream();
    deck._endLatch = true;
    deck.sfxOn = false;
    deck.motorOn = true; deck.motorEnv = 1;
    deck.mode = "playing"; deck.pos = 0; deck.vel = deck.baseV;
    const chunks = [];
    let guard = 0;
    while (deck.pos < n - 2 && guard++ < 3000) chunks.push(deck._renderBlock(768));
    let len = 0;
    for (const cc of chunks) len += cc.length;
    const y = new Float32Array(len);
    { let p = 0; for (const cc of chunks) { y.set(cc, p); p += cc.length; } }
    const ref = T.pcRenderSide(img, { n, rate });
    const m2 = Math.min(y.length, ref.length) - 200;
    let se = 0, sr = 0;
    for (let k = 100; k < m2; k++) { const d = y[k] - ref[k]; se += d * d; sr += ref[k] * ref[k]; }
    const snr16 = 10 * Math.log10(sr / Math.max(se, 1e-20));
    check("v2 pickup === ground truth: " + snr16.toFixed(1) + " dB", snr16 >= 60);
    {
      const wT = 2 * Math.PI * 440 / 48000, M = m2 - 100;
      let cs = 0, sn = 0;
      for (let k = 100; k < m2; k++) { cs += y[k] * Math.cos(wT * k); sn += y[k] * Math.sin(wT * k); }
      const A = 2 * Math.hypot(cs, sn) / M, phi = Math.atan2(cs, sn);
      let seT = 0, srT = 0;
      for (let k = 100; k < m2; k++) {
        const ideal = A * Math.sin(wT * k + phi);
        const d = y[k] - ideal;
        seT += d * d; srT += ideal * ideal;
      }
      const snrI = 10 * Math.log10(srT / Math.max(seT, 1e-20));
      check("v2 16-bit tone residual: " + snrI.toFixed(1) + " dB", snrI >= 35);
    }
    deck.mode = "rest"; deck.motorOn = false;
  }

  /* eject keeps the bench, clears the platter */
  registered.ui.eject.click();
  check("eject unloads but the deck card stays",
        !deck.loaded && registered.ui.deckCard.style.display !== "none");
  check("eject closed the stream", deck.stream === null);

  /* the received-postcard affordance */
  check("Play-on-deck and Load-disc controls wired",
        typeof registered._playRx === "function" &&
        typeof registered._pcLoadPng === "function" &&
        !!registered.ui.playRx && !!registered.ui.pcLoad);

  registered.onDeactivate && registered.onDeactivate();
  deck.destroy();
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nDigital SSTV UI smoke passed");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
