#!/usr/bin/env node
/* UI smoke for MIDI Link — builds the actual panel in a headless DOM and
   exercises the safe flows. This is the test layer the engine suites can't
   provide: it catches wiring bugs (missing ids, null derefs) at panel-build
   time instead of on the user's server.
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

/* ---------- headless browser shell ---------- */
const dom = new JSDOM("<!doctype html><html><body></body></html>",
                      { pretendToBeVisual: true });
const win = dom.window;

function fake2d(cv) {
  const store = { canvas: cv };
  const target = {
    canvas: cv,
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    measureText: () => ({ width: 8 })
  };
  return new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k];
      if (k in store) return store[k];
      return () => undefined;
    },
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
global.ImageData = function (data, w, h) { return { data, width: w, height: h }; };

/* ---------- fake studio host + audio engine ---------- */
let registered = null;
global.HRWS = { registerModule: d => { registered = d; } };

function audioNode() {
  const param = { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {},
                  setTargetAtTime() {}, exponentialRampToValueAtTime() {} };
  return { connect() {}, disconnect() {}, start() {}, stop() {},
           gain: param, frequency: param, detune: param, Q: param,
           setPeriodicWave() {}, buffer: null, loop: false, type: "", onended: null };
}
const actx = {
  currentTime: 0, sampleRate: 48000, destination: audioNode(),
  createGain: audioNode, createOscillator: audioNode,
  createBufferSource: audioNode, createBiquadFilter: audioNode,
  createBuffer: (ch, len) => ({ getChannelData: () => new Float32Array(len) }),
  createPeriodicWave: () => ({})
};
const logs = [];
const ctx = {
  audio: {
    ctx: actx, monitorBus: null,
    onSamples() {}, ensureContext() { return actx; },
    startRX: async () => {}, rxActive: false,
    playPCM() {}, stopTX() {},
    openTXStream() { return { push() {}, close() {}, stop() {} }; }
  },
  log: m => logs.push(String(m)),
  settings: () => ({ callsign: "VA3TST" })
};

(async () => {
  console.log("[ui smoke: MIDI Link]");
  require(path.join(__dirname, "..", "module.js"));
  check("module registered with the host", !!registered && registered.id === "midi");

  registered.init(ctx);
  const panel = win.document.createElement("div");
  win.document.body.appendChild(panel);
  let built = true, err = null;
  try { registered.createPanel(panel); }
  catch (e) { built = false; err = e; }
  check("createPanel builds without throwing", built, err && (err.stack || err.message));
  if (!built) { process.exit(1); }

  const missing = Object.entries(registered.ui)
    .filter(([, v]) => !v).map(([k]) => k);
  check("every this.ui element resolved", missing.length === 0, missing.join(", "));

  /* safe interactions */
  const fire = (el, type) => el.dispatchEvent(new win.Event(type, { bubbles: true }));
  registered.ui.seg.value = "5"; fire(registered.ui.seg, "change");
  registered.ui.armor.value = "fec"; fire(registered.ui.armor, "change");
  registered.ui.vol.value = "80"; fire(registered.ui.vol, "input");
  registered.ui.squelch.value = "-40"; fire(registered.ui.squelch, "input");
  check("link info reflects settings",
        /armoured/.test(registered.ui.linkinfo.textContent),
        registered.ui.linkinfo.textContent);

  registered._audition();
  check("audition schedules on the synth stub", registered.auditioning === true);
  registered._audition();
  check("audition toggles off", registered.auditioning === false);

  await registered._encode();
  check("encode produced air", !!registered.enc && registered.enc.airS > 20,
        registered.enc && registered.enc.airS + " s");
  check("encode enabled transmit/save/loopback",
        !registered.ui.play.disabled && !registered.ui.savewav.disabled &&
        !registered.ui.loop.disabled);

  registered._playAir();
  registered._stopEverything();
  check("stop button path runs", registered.player === null);

  registered.onDeactivate();
  check("deactivate cleans up", registered.ui === null);

  if (failures) for (const m of logs.slice(-8)) console.log("  (module log) " + m);
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nMIDI Link UI smoke passed");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
