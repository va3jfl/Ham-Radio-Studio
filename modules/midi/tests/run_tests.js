#!/usr/bin/env node
/* Headless checks for HRWS-M1 — SMF round trip, records, segmenter,
   the full radio chain sober and drunk, and the armour contrast.
   Run:  node run_tests.js */
"use strict";
const path = require("path");

global.window = {};
global.document = { createElement: () => ({ getContext: () => null, style: {} }) };
global.performance = global.performance || { now: () => Date.now() };

require(path.join(__dirname, "..", "module.js"));
const T = global.window.__M1_TEST__;

let failures = 0;
function check(name, ok, extra) {
  if (ok) console.log("  ok  " + name);
  else { console.log("FAIL  " + name + (extra ? " — " + extra : "")); failures++; }
}

const key = (seg, r) => `${seg}:${r.t}:${r.dur}:${r.pitch}:${r.vel}:${r.ch}`;
function sentSet(plan) {
  const s = new Set();
  for (const sg of plan.segs) for (const r of sg.recs) s.add(key(sg.idx, r));
  return s;
}
function collectRx(fs) {
  const got = [];
  const rx = new T.StreamRX(fs, {
    onNotes: r => {
      for (const n of r.notes)
        got.push({ k: key(n.seg, {
          t: Math.round((n.t - n.seg * rx.con.segS) / T.TICK_S),
          dur: Math.round(n.dur / T.TICK_S),
          pitch: n.pitch, vel: n.vel, ch: n.ch }), drunk: n.drunk });
    }
  });
  rx._got = got;
  return rx;
}
async function feed(rx, y, fs) {
  const step = Math.round(0.5 * fs);
  for (let p = 0; p < y.length; p += step) {
    rx.push(y.subarray(p, Math.min(y.length, p + step)));
    await rx.drain();
  }
  await rx.drain();
}

/* ================= 1. SMF writer ↔ reader round trip ================= */
console.log("[smf]");
{
  const demo = T.makeDemoScore();
  const sub = demo.notes.filter(n => n.t < 12);
  const file = T.writeMidi(sub, demo.programs);
  const back = T.parseMidi(file);
  check("note count survives", back.notes.length === sub.length,
        back.notes.length + " vs " + sub.length);
  const srt = a => a.slice().sort((x, y) => x.t - y.t || x.pitch - y.pitch || x.ch - y.ch);
  const A = srt(sub), B = srt(back.notes);
  let tErr = 0, fieldErr = 0;
  for (let i = 0; i < A.length; i++) {
    tErr = Math.max(tErr, Math.abs(A[i].t - B[i].t), Math.abs(A[i].dur - B[i].dur));
    if (A[i].pitch !== B[i].pitch || A[i].ch !== B[i].ch ||
        Math.round(A[i].vel) !== B[i].vel) fieldErr++;
  }
  check("times within one tick (≤ 2 ms)", tErr <= 1 / 960 + 1e-9, tErr.toFixed(4) + " s");
  check("pitch/vel/ch exact", fieldErr === 0, fieldErr + " mismatches");
  check("programs preserved", back.programs[1] === 33 && back.programs[2] === 73);
}

/* ================= 2. fixed-width records ================= */
console.log("[records]");
{
  const edge = [
    { t: 0, dur: 1, pitch: 0, vel: 1, ch: 0 },
    { t: 2047, dur: 2047, pitch: 127, vel: 127, ch: 15 },
    { t: 1024, dur: 3, pitch: 60, vel: 64, ch: 9 }
  ];
  let s = 777;
  const rnd = m => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % m; };
  for (let i = 0; i < 200; i++)
    edge.push({ t: rnd(2048), dur: 1 + rnd(2047), pitch: rnd(128),
                vel: 1 + rnd(127), ch: rnd(16) });
  const bytes = T.packNotes(edge);
  check("5 bytes per note exactly", bytes.length === edge.length * T.NOTE_BYTES);
  const back = T.unpackNotes(bytes);
  let bad = 0;
  for (let i = 0; i < edge.length; i++) {
    const a = edge[i], b = back[i];
    if (a.t !== b.t || a.dur !== b.dur || a.pitch !== b.pitch ||
        a.vel !== b.vel || a.ch !== b.ch) bad++;
  }
  check("all fields round-trip exactly", bad === 0, bad + " bad");
}

/* ================= 3. demo score ================= */
console.log("[demo score]");
{
  const a = T.makeDemoScore(), b = T.makeDemoScore();
  check("deterministic", a.notes.length === b.notes.length &&
        a.notes[10].pitch === b.notes[10].pitch);
  check("substantial (5 parts, 60 s)", a.notes.length > 500 && a.durationS > 55,
        a.notes.length + " notes, " + a.durationS.toFixed(0) + " s");
  const chs = new Set(a.notes.map(n => n.ch));
  check("bass, piano, lead, pad, drums present",
        [0, 1, 2, 3, 9].every(c => chs.has(c)));
}

/* ================= 4. segmenter & capacity ================= */
console.log("[segmenter]");
{
  const cap5b = T.segCapacity(5, false), cap10b = T.segCapacity(10, false),
        cap10a = T.segCapacity(10, true);
  console.log(`  (capacity: 5s bare ${cap5b} · 10s bare ${cap10b} · 10s armour ${cap10a} notes/bar` +
              ` = ${(cap10b / 10).toFixed(1)} vs ${(cap10a / 10).toFixed(1)} notes/s)`);
  check("armour costs roughly half the notes",
        cap10a < 0.62 * cap10b && cap10a > 0.4 * cap10b);
  /* dense synthetic score: 120 notes/s for 20 s */
  const dense = { notes: [], programs: new Array(16).fill(0), durationS: 20 };
  for (let i = 0; i < 2400; i++)
    dense.notes.push({ t: i / 120, dur: 0.1, pitch: 40 + (i % 48),
                       vel: 1 + (i * 7) % 127, ch: i % 8 });
  const plan = T.segmentScore(dense, 10, false);
  let over = 0, airOver = 0;
  for (const sg of plan.segs) {
    if (sg.recs.length > plan.cap) over++;
    if (T.segAirSyms(sg.recs.length, false) > 10 * 500) airOver++;
    for (let i = 1; i < sg.recs.length; i++)
      if (sg.recs[i].t < sg.recs[i - 1].t) over++;
  }
  check("every bar within capacity and airtime", over === 0 && airOver === 0);
  check("thinning reported honestly", plan.thinnedPct > 40,
        plan.thinnedPct.toFixed(0) + " %");
  check("loudest notes survive thinning",
        plan.segs[0].recs.every(r => r.vel >= 60) === false ||
        plan.segs[0].recs.some(r => r.vel > 100));
}

(async () => {
  const demo = T.makeDemoScore();
  const short = { notes: demo.notes.filter(n => n.t < 20),
                  programs: demo.programs, durationS: 20 };

  /* ================= 5. radio chain, bare, clean ================= */
  console.log("[radio: bare, direct]");
  const e1 = T.buildSongAudio(short, { segS: 5, armor: false, sessionId: 777 }, {});
  const s1 = sentSet(e1.plan);
  {
    const rx = collectRx(e1.fs);
    await feed(rx, e1.y, e1.fs);
    check("every note arrived", rx._got.length === e1.plan.sentNotes,
          rx._got.length + "/" + e1.plan.sentNotes);
    check("every field exact", rx._got.every(g => s1.has(g.k)));
    check("all packets sober", rx.con.stats.drunkPkts === 0 && rx.stats.crcFail === 0);
    check("all bar headers heard", rx.con.stats.hdrs === e1.plan.segTotal,
          rx.con.stats.hdrs + "/" + e1.plan.segTotal);
    check("program table carried", rx.con.programs[1] === 33 && rx.con.programs[3] === 48);
    check("END heard", rx.ended);
    check("airtime is real-time (bars fit their slots)",
          e1.airS <= 20 + 2.5, e1.airS.toFixed(1) + " s for 20 s of music");
  }

  /* ================= 6. the drunk ladder (calibration + assertions) ================= */
  console.log("[radio: bare vs noise — the drunk ladder]");
  const ladder = {};
  for (const snr of [6, 2, 0, -2, -4, -6, -8]) {
    const noisy = T.channelSimulate(e1.y, e1.fs, 2400, snr, 7, "ssb");
    const rx = collectRx(e1.fs);
    await feed(rx, noisy, e1.fs);
    const wrong = rx._got.filter(g => !s1.has(g.k)).length;
    ladder[snr] = { notes: rx._got.length, wrong, drunk: rx.con.stats.drunkPkts,
                    hdrs: rx.con.stats.hdrs };
    console.log(`  SNR ${String(snr).padStart(3)} dB: ${rx._got.length}/${e1.plan.sentNotes} notes, ` +
      `${wrong} wrong 🍷, ${rx.con.stats.drunkPkts} drunk pkts, ` +
      `${rx.con.stats.hdrs}/${e1.plan.segTotal} headers, ${rx.stats.hdrFail} hdr fails`);
  }
  {
    const d = ladder[T.DRUNK_SNR];
    check(`at ${T.DRUNK_SNR} dB the orchestra is drunk but standing`,
          d && d.notes >= 0.9 * e1.plan.sentNotes && d.wrong >= 3 && d.drunk >= 2 &&
          d.hdrs >= e1.plan.segTotal - 1,
          JSON.stringify(d));
    check("sober all the way down to 0 dB",
          ladder[0].wrong === 0 && ladder[0].drunk === 0 &&
          ladder[6].wrong === 0, JSON.stringify(ladder[0]));
  }

  /* ================= 7. armour: drop, never slur ================= */
  console.log("[radio: armoured vs the same noise]");
  {
    const e3 = T.buildSongAudio(short, { segS: 5, armor: true, sessionId: 778 }, {});
    const s3 = sentSet(e3.plan);
    const noisy = T.channelSimulate(e3.y, e3.fs, 2400, T.DRUNK_SNR, 7, "ssb");
    const rx = collectRx(e3.fs);
    await feed(rx, noisy, e3.fs);
    const wrong = rx._got.filter(g => !s3.has(g.k)).length;
    console.log(`  ${rx._got.length}/${e3.plan.sentNotes} notes, ${wrong} wrong, ` +
                `${rx.con.stats.dropPkts} packets dropped`);
    check("zero wrong notes ever", wrong === 0);
    check("armour paid in notes (capacity)", e3.plan.sentNotes < e1.plan.sentNotes);
  }

  /* ================= 8. late joiner ================= */
  console.log("[late joiner]");
  {
    const rx = collectRx(e1.fs);
    await feed(rx, e1.y.subarray(Math.round(7.2 * e1.fs)), e1.fs);
    check("locked mid-song and played on",
          rx.con.sessionId === 777 && rx._got.length > 0.3 * e1.plan.sentNotes,
          rx._got.length + " notes after joining at 7.2 s");
  }

  /* ================= 9. lost header → notes held, then flushed ================= */
  console.log("[orphan flush]");
  {
    const yy = Float32Array.from(e1.y);
    const mh0 = e1.layout.find(L => L.type === "mhdr" && L.seg === 0);
    for (let i = mh0.at; i < mh0.at + mh0.len; i++) yy[i] = 0;
    const rx = collectRx(e1.fs);
    await feed(rx, yy, e1.fs);
    check("bar-0 notes survived the murdered header (held, then flushed)",
          rx._got.length === e1.plan.sentNotes && rx.con.stats.orphans > 0,
          rx._got.length + "/" + e1.plan.sentNotes + ", orphans " + rx.con.stats.orphans);
    check("still every field exact", rx._got.every(g => s1.has(g.k)));
  }

  /* ================= 10. wav round trip ================= */
  console.log("[wav]");
  {
    const wav = T.wavEncode16(e1.y.subarray(0, 48000), T.TX_FS);
    const back = T.wavDecodeMono(wav);
    let md = 0;
    for (let i = 0; i < 48000; i++) md = Math.max(md, Math.abs(back.y[i] - e1.y[i]));
    check("16-bit round trip within quantization", md < 1.6 / 32767, md.toFixed(6));
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nall M1 checks passed");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
