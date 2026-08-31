#!/usr/bin/env node
/* Headless checks for HRWS-D3 — the moving-picture frame engine and the
   full radio chain. Run:  node run_tests.js */
"use strict";
const path = require("path");

global.window = {};
global.document = { createElement: () => ({ getContext: () => null, style: {} }) };
global.performance = global.performance || { now: () => Date.now() };

require(path.join(__dirname, "..", "module.js"));
const T = global.window.__D3_TEST__;

let failures = 0;
function check(name, ok, extra) {
  if (ok) console.log("  ok  " + name);
  else { console.log("FAIL  " + name + (extra ? " — " + extra : "")); failures++; }
}

const frameAt = (w, h) => (i, t) => T.rgbToPlanes(T.motionPattern(w, h, t));
async function feed(rx, y, fs) {
  const step = Math.round(0.5 * fs);
  for (let p = 0; p < y.length; p += step) {
    rx.push(y.subarray(p, Math.min(y.length, p + step)));
    await rx.drain();
  }
  await rx.drain();
}

/* ================= 1. test card actually moves ================= */
console.log("[test card]");
{
  const a = T.motionPattern(64, 48, 0.0);
  const b = T.motionPattern(64, 48, 1.0);
  const a2 = T.motionPattern(64, 48, 0.0);
  let diff = 0, same = 0;
  for (let i = 0; i < a.r.length; i++) {
    if (Math.abs(a.r[i] - b.r[i]) > 1) diff++;
    if (a.r[i] === a2.r[i]) same++;
  }
  check("moves between seconds", diff > 100, diff + " px changed");
  check("deterministic at equal t", same === a.r.length);
}

/* ================= 2. block codec round trips ================= */
console.log("[block codec]");
{
  const qt = T.quantTable(T.QLUMA, 45);
  const vals = new Float64Array(64);
  let s = 12345;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 64; i++) vals[i] = rnd() * 200 - 100;
  const q = T.quantizeBlock(vals, qt);
  const bw = new T.BitWriter();
  T.writeQBlock(bw, q, { dc: 0 });
  const br = new T.BitReader(bw.finish());
  const q2 = T.readQBlock(br, { dc: 0 });
  let eq = true;
  for (let i = 0; i < 64; i++) if (q[i] !== q2[i]) eq = false;
  check("quantized coefficients survive entropy coding exactly", eq);
  const ra = new Float64Array(64), rb = new Float64Array(64);
  T.reconFromQ(q, qt, ra);
  T.reconFromQ(q2, qt, rb);
  let md = 0;
  for (let i = 0; i < 64; i++) md = Math.max(md, Math.abs(ra[i] - rb[i]));
  check("reconstructions bit-identical", md === 0, "maxdiff " + md);
}

/* ================= 3. closed loop: decoder === encoder ref ================= */
console.log("[closed loop]");
async function closedLoop(cfg, nFrames, label) {
  const enc = new T.D3Encoder(cfg);
  const dec = new T.D3Decoder();
  dec.applyVhdr(enc.vhdrPayload());
  const prov = frameAt(cfg.w, cfg.h);
  let maxDiff = 0, budgetOK = true, totBlk = 0, overruns = 0;
  const budget = T.frameByteBudget(cfg.fps);
  for (let i = 0; i < nFrames; i++) {
    const fr = enc.encodeFrame(prov(i, i / cfg.fps));
    if (fr.bytes > budget && !(fr.overrun && fr.sent.length === 1)) budgetOK = false;
    if (fr.overrun) overruns++;
    totBlk += fr.sent.length;
    const r = dec.applyVfrm(fr.payload, i / cfg.fps);
    if (!r || r.corrupt) { maxDiff = 999; break; }
    maxDiff = Math.max(maxDiff, T.planesMaxDiff(dec.P, enc.ref, cfg.mono));
  }
  check(`${label}: decoder tracks encoder exactly over ${nFrames} frames`,
        maxDiff < 1e-9, "maxdiff " + maxDiff);
  check(`${label}: budget respected (overruns only as single cheapest block)`, budgetOK);
  check(`${label}: at least a block per frame flows`, totBlk >= nFrames,
        totBlk + " blocks, " + overruns + " overrun frames");
  return { enc, dec };
}
(async () => {
  await closedLoop({ w: 64, h: 48, mono: true, quality: 45, fps: 1, refresh: 1, streamId: 7 },
                   14, "64×48 mono 1 fps");
  await closedLoop({ w: 96, h: 64, mono: false, quality: 45, fps: 1, refresh: 1, streamId: 8 },
                   10, "96×64 colour 1 fps");
  await closedLoop({ w: 64, h: 48, mono: true, quality: 30, fps: 2, refresh: 1, streamId: 9 },
                   16, "64×48 mono 2 fps");

  /* ================= 4. full radio chain, clean channel ================= */
  console.log("[radio: direct]");
  const cfg = { w: 64, h: 48, mono: true, quality: 45, fps: 1, refresh: 1, streamId: 4242 };
  const nFrames = 10;
  const built = T.buildStreamAudio(cfg, frameAt(64, 48), nFrames, {});
  {
    const rx = new T.StreamRX(built.fs, {});
    await feed(rx, built.y, built.fs);
    check("all frame packets decoded", rx.dec.frames === nFrames,
          rx.dec.frames + "/" + nFrames);
    check("no CRC losses on a clean channel", rx.stats.crcFail === 0,
          rx.stats.crcFail + " lost");
    check("END packet seen", rx.ended);
    check("RX picture bit-exact with encoder reference",
          T.planesMaxDiff(rx.dec.P, built.enc.ref, true) < 1e-9);
    check("fps estimate near target", Math.abs(rx.dec.fpsEma - 1) < 0.25,
          rx.dec.fpsEma.toFixed(2));
    check("geometry from VHDR", rx.dec.cfg.w === 64 && rx.dec.cfg.h === 48 && rx.dec.cfg.mono);
  }

  /* ================= 5. static scene: fidelity converges ================= */
  console.log("[static fidelity]");
  {
    const cfgS = { w: 64, h: 48, mono: true, quality: 45, fps: 1, refresh: 1, streamId: 21 };
    const N = 16;
    const still = (i, t) => T.rgbToPlanes(T.motionPattern(64, 48, 1.0));
    const b = T.buildStreamAudio(cfgS, still, N, {});
    const rx = new T.StreamRX(b.fs, {});
    await feed(rx, b.y, b.fs);
    let unpainted = 0;
    for (let i = 0; i < rx.dec.g.nMB; i++) if (rx.dec.age[i] < 0) unpainted++;
    check("every block painted within " + N + " frames", unpainted === 0,
          unpainted + " blocks never arrived");
    const src = T.rgbToPlanes(T.motionPattern(64, 48, 1.0));
    const p = T.psnrY(rx.dec.P, src);
    check("codec-limited PSNR vs source ≥ 22 dB", p >= 22, p.toFixed(1) + " dB");
    check("still bit-exact with encoder", T.planesMaxDiff(rx.dec.P, b.enc.ref, true) < 1e-9);
  }

  /* ================= 6. SSB 2.4 kHz at 10 dB SNR ================= */
  console.log("[radio: SSB 2.4 kHz, SNR 10 dB]");
  {
    const noisy = T.channelSimulate(built.y, built.fs, 2400, 10, 7, "ssb");
    const rx = new T.StreamRX(built.fs, {});
    await feed(rx, noisy, built.fs);
    check("≥ 8/10 frames survive 10 dB", rx.dec.frames >= 8,
          rx.dec.frames + "/10, " + rx.stats.crcFail + " lost");
    if (rx.stats.crcFail === 0 && rx.dec.frames === nFrames)
      check("FEC held everything → still bit-exact",
            T.planesMaxDiff(rx.dec.P, built.enc.ref, true) < 1e-9);
    else
      console.log("  (frames were lost at 10 dB — legal, refresh covers it)");
  }

  /* ================= 7. loss + walking refresh heals ================= */
  console.log("[healing]");
  {
    /* the ball settles at t=4; murder the packet that carried its final
       position, then watch the loss appear and the refresh repaint it */
    const cfgH = { w: 64, h: 48, mono: true, quality: 45, fps: 1, refresh: 2, streamId: 99 };
    const N = 20;                                 // 12 blocks / 2 per frame sweep
    const prov = (i, t) => T.rgbToPlanes(T.motionPattern(64, 48, Math.min(t, 4)));
    const b2 = T.buildStreamAudio(cfgH, prov, N, {});
    const victim = b2.layout.filter(L => L.type === "vfrm")[4];   // frame 4 = t 4
    check("victim carried blocks", victim.mbs > 0, victim.mbs + " blocks");
    const yLoss = Float32Array.from(b2.y);
    for (let i = victim.at; i < victim.at + victim.len; i++) yLoss[i] = 0;
    let everDiverged = false;
    const rx = new T.StreamRX(b2.fs, {
      onFrame: (r, rx2) => {
        if (T.planesMaxDiff(rx2.dec.P, b2.enc.ref, true) > 1e-9) everDiverged = true;
      }
    });
    await feed(rx, yLoss, b2.fs);
    check("the murdered packet was actually missed",
          rx.dec.frames === N - 1, rx.dec.frames + "/" + N);
    check("its loss showed on screen (stale blocks)", everDiverged);
    const md = T.planesMaxDiff(rx.dec.P, b2.enc.ref, true);
    check("refresh sweep healed it back to bit-exact", md < 1e-9, "maxdiff " + md.toFixed(3));
  }

  /* ================= 8. late joiner locks via repeated VHDR ================= */
  console.log("[late joiner]");
  {
    const cfgL = { w: 64, h: 48, mono: true, quality: 45, fps: 1, refresh: 2, streamId: 55 };
    const N = 14;
    const b3 = T.buildStreamAudio(cfgL, frameAt(64, 48), N, {});
    const joinAt = Math.round(6.2 * b3.fs);        // miss the opening headers
    const rx = new T.StreamRX(b3.fs, {});
    await feed(rx, b3.y.subarray(joinAt), b3.fs);
    check("joined mid-programme and still decoded frames",
          rx.dec.cfg !== null && rx.dec.frames >= 4,
          (rx.dec.cfg ? rx.dec.frames : 0) + " frames after joining at 6.2 s");
  }

  /* ================= 9. WAV round trip ================= */
  console.log("[wav]");
  {
    const wav = T.wavEncode16(built.y, built.fs);
    const back = T.wavDecodeMono(wav);
    check("rate preserved", back.rate === built.fs);
    let md = 0;
    for (let i = 0; i < built.y.length; i++)
      md = Math.max(md, Math.abs(back.y[i] - built.y[i]));
    check("16-bit round trip within quantization", md < 1.6 / 32767, md.toFixed(6));
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nall D3 checks passed");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
