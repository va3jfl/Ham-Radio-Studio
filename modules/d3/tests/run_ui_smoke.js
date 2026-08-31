#!/usr/bin/env node
/* UI smoke for HRWS-D3 — builds the actual panel in a headless DOM and runs
   a full loopback through the UI's own RX callbacks (paint, freshness map,
   replay ring). Catches panel wiring bugs the engine suite can't see.
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
global.ImageData = function (data, w, h) { return { data, width: w, height: h }; };

let registered = null;
global.HRWS = { registerModule: d => { registered = d; } };

const logs = [];
const ctx = {
  audio: {
    ctx: null, monitorBus: null,
    onSamples() {}, ensureContext() { return { sampleRate: 48000, currentTime: 0 }; },
    startRX: async () => {}, rxActive: false,
    playPCM() {}, stopTX() {},
    openTXStream() { return { push() {}, close() {}, stop() {} }; }
  },
  log: m => logs.push(String(m)),
  settings: () => ({ callsign: "VA3TST" })
};

(async () => {
  console.log("[ui smoke: HRWS-D3]");
  require(path.join(__dirname, "..", "module.js"));
  check("module registered with the host", !!registered && registered.id === "d3");

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

  const fire = (el, type) => el.dispatchEvent(new win.Event(type, { bubbles: true }));
  registered.ui.size.value = "1"; fire(registered.ui.size, "change");
  registered.ui.colour.value = "colour"; fire(registered.ui.colour, "change");
  registered.ui.quality.value = "high"; fire(registered.ui.quality, "change");
  registered.ui.fps.value = "2"; fire(registered.ui.fps, "change");
  registered.ui.refresh.value = "2"; fire(registered.ui.refresh, "change");
  check("link info reflects settings",
        /budget/.test(registered.ui.linkinfo.textContent),
        registered.ui.linkinfo.textContent);
  check("TX canvas resized with size", registered.ui.tx.width === 96);

  /* full loopback through the panel's own RX callbacks */
  registered.ui.fps.value = "1"; fire(registered.ui.fps, "change");
  await registered._loopback();
  check("loopback decoded frames into the panel",
        registered.rxFrames.length >= 8, registered.rxFrames.length + " frames");
  check("stage is not an error", !/error/i.test(registered.ui.stage.textContent),
        registered.ui.stage.textContent);
  check("save/replay unlocked",
        !registered.ui.saveimg.disabled && !registered.ui.replay.disabled);

  registered.onDeactivate();
  check("deactivate cleans up", registered.ui === null);

  if (failures) for (const m of logs.slice(-8)) console.log("  (module log) " + m);
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nHRWS-D3 UI smoke passed");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
