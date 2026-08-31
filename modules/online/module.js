/* ============================================================
   Ham Radio Web Studio — Online Link module
   ------------------------------------------------------------
   Connects two studios over the internet with a lossless-grade
   Opus stream (WebRTC, peer-to-peer; api/link.php only relays
   the handshake). Whatever one side transmits — CW, SSTV, QAM,
   DigiVoice, anything — comes out of the other side's RX chain,
   because the link taps the shared txBus and registers itself
   as a virtual input device.

   Three ways to run the "channel" between you:
     • Direct patch   — bit-perfect-ish passthrough, no games
     • Manual         — you inject noise / QSB / QRN / hum and
                        see how redundant each mode really is
     • Full simulation— a virtual rig on each end (band, freq,
                        power, antenna, location) + live NOAA
                        solar data decide the path loss. Tune,
                        add power, wait for darkness… until S9.

   A "Conditions loopback" virtual input also lets a *solo*
   station TX any mode through the simulator into its own
   decoders — the whole learning loop with nobody else online.
   ============================================================ */
"use strict";

(function () {

  /* ================= tiny helpers ================= */
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const dbToLin = (db) => Math.pow(10, db / 20);
  const esc = (s) => String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function fmtHz(fHz) {
    const mhz = Math.floor(fHz / 1e6);
    const khz = Math.floor((fHz % 1e6) / 1e3);
    const hz = Math.floor(fHz % 1e3);
    return `${mhz}.${String(khz).padStart(3, "0")}.${String(hz).padStart(3, "0").slice(0, 2)}`;
  }
  function fmtW(w) {
    if (w < 1) return (w * 1000).toFixed(0) + " mW";
    if (w < 1000) return (w >= 100 ? w.toFixed(0) : w.toFixed(1)) + " W";
    if (w < 1e6) return (w / 1000).toFixed(w < 1e4 ? 2 : 1) + " kW";
    return (w / 1e6).toFixed(2) + " MW";
  }
  function fmtKm(km) {
    return km < 10 ? km.toFixed(2) + " km" : km < 100 ? km.toFixed(1) + " km" : Math.round(km) + " km";
  }
  function fmtBits(bps) {
    if (!isFinite(bps) || bps <= 0) return "—";
    return bps >= 1e6 ? (bps / 1e6).toFixed(2) + " Mb/s" : (bps / 1e3).toFixed(0) + " kb/s";
  }

  /* ============================================================
     PROP-BEGIN — propagation & link-budget model
     Deliberately a *teaching* model, not VOACAP: it reacts the
     right way to the right knobs (frequency vs MUF, D-layer by
     day, Kp storms, distance/hops, antennas, power, VHF radio
     horizon) with numbers in the plausible range. Both stations
     compute the same result because everything is a pure
     function of (both rigs, solar data, UTC time).
     ============================================================ */

  const OL_BANDS = [
    { id: "160m", lo: 1.8,    hi: 2.0,    def: 1.840 },
    { id: "80m",  lo: 3.5,    hi: 4.0,    def: 3.573 },
    { id: "40m",  lo: 7.0,    hi: 7.3,    def: 7.074 },
    { id: "30m",  lo: 10.1,   hi: 10.15,  def: 10.136 },
    { id: "20m",  lo: 14.0,   hi: 14.35,  def: 14.074 },
    { id: "17m",  lo: 18.068, hi: 18.168, def: 18.100 },
    { id: "15m",  lo: 21.0,   hi: 21.45,  def: 21.074 },
    { id: "12m",  lo: 24.89,  hi: 24.99,  def: 24.915 },
    { id: "10m",  lo: 28.0,   hi: 29.7,   def: 28.074 },
    { id: "6m",   lo: 50.0,   hi: 54.0,   def: 50.313 },
    { id: "2m",   lo: 144.0,  hi: 148.0,  def: 144.174 },
    { id: "70cm", lo: 420.0,  hi: 450.0,  def: 432.174 },
    { id: "23cm", lo: 1240,   hi: 1300,   def: 1296.174 }
  ];
  function olBandOf(fMHz) {
    return OL_BANDS.find(b => fMHz >= b.lo && fMHz <= b.hi) || null;
  }

  /* Occupied bandwidth + the audio-passband filter each mode implies */
  const OL_MODES = {
    CW:  { bw: 500,   hp: 450, lp: 950,  label: "CW 500 Hz" },
    DIG: { bw: 2700,  hp: 100, lp: 2800, label: "Data / SSB 2.7 kHz" },
    SSB: { bw: 2700,  hp: 150, lp: 2850, label: "SSB 2.7 kHz" },
    AM:  { bw: 6000,  hp: 60,  lp: 4500, label: "AM 6 kHz" },
    FM:  { bw: 12000, hp: 50,  lp: 5500, label: "FM 12 kHz" }
  };

  function olHaversine(a, b) {
    const R = 6371, d = Math.PI / 180;
    const dLat = (b.lat - a.lat) * d, dLon = (b.lon - a.lon) * d;
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * d) * Math.cos(b.lat * d) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function olBearing(a, b) {
    const d = Math.PI / 180;
    const y = Math.sin((b.lon - a.lon) * d) * Math.cos(b.lat * d);
    const x = Math.cos(a.lat * d) * Math.sin(b.lat * d) -
      Math.sin(a.lat * d) * Math.cos(b.lat * d) * Math.cos((b.lon - a.lon) * d);
    return (Math.atan2(y, x) / d + 360) % 360;
  }
  function olMidpoint(a, b) {
    // fine for path-illumination purposes
    let lon1 = a.lon, lon2 = b.lon;
    if (Math.abs(lon2 - lon1) > 180) { if (lon2 > lon1) lon1 += 360; else lon2 += 360; }
    let lon = (lon1 + lon2) / 2; if (lon > 180) lon -= 360;
    return { lat: (a.lat + b.lat) / 2, lon };
  }

  /* Solar elevation (degrees) at lat/lon — declination + equation
     of time approximation, the same recipe the grayline map uses. */
  function olSunElev(lat, lon, dateMs) {
    const d = new Date(dateMs);
    const start = Date.UTC(d.getUTCFullYear(), 0, 0);
    const doy = (dateMs - start) / 86400000;
    const decl = -23.44 * Math.cos(2 * Math.PI / 365 * (doy + 10));
    const B = 2 * Math.PI * (doy - 81) / 364;
    const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B); // minutes
    const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
    const solarMin = utcMin + eot + lon * 4;
    const ha = (solarMin / 4 - 180) * Math.PI / 180;       // hour angle
    const rl = lat * Math.PI / 180, rd = decl * Math.PI / 180;
    const sinEl = Math.sin(rl) * Math.sin(rd) + Math.cos(rl) * Math.cos(rd) * Math.cos(ha);
    return Math.asin(clamp(sinEl, -1, 1)) * 180 / Math.PI;
  }

  function olMulberry(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function olHashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  /* "Conditions of the day": a deterministic per-UTC-day, per-band
     wobble both ends compute identically — some days the band is
     just better. Also rolls the sporadic-E dice for 6 m / 2 m. */
  function olDayVar(bandId, fMHz, dateMs) {
    const day = new Date(dateMs).toISOString().slice(0, 10);
    const rng = olMulberry(olHashStr(day + "|" + (bandId || Math.round(fMHz))));
    const bias = (rng() - 0.5) * 8;                        // ±4 dB day quality
    const esRoll = rng();
    const esOpen = (bandId === "6m" && esRoll < 0.09) || (bandId === "2m" && esRoll < 0.015);
    // slow intra-day ripple, 10-minute quantised so both sides agree
    const slot = Math.floor(dateMs / 600000);
    const ripple = Math.sin(slot * 0.9 + rng() * 6.28) * 2.5;
    return { bias: bias + ripple, esOpen };
  }

  /* Ambient noise floor at the RX in dBm for a given bandwidth.
     ITU-flavoured man-made noise: strong on the low bands, falls
     ~27.7 dB/decade, bottoms out near-galactic on VHF/UHF. */
  function olNoiseFloor(fMHz, bwHz) {
    const fa = Math.max(6, 68 - 27.7 * Math.log10(Math.max(0.5, fMHz)));
    return -174 + fa + 10 * Math.log10(Math.max(50, bwHz));
  }

  function olSMeter(prxDbm) {
    // S9 = −73 dBm, 6 dB per S-unit (HF convention — close enough everywhere here)
    const s = 9 + (prxDbm + 73) / 6;
    let text;
    if (prxDbm > -73) text = "S9+" + Math.round(prxDbm + 73) + " dB";
    else if (s < 0.5) text = "S0";
    else text = "S" + Math.max(1, Math.round(s));
    return { sVal: s, over: Math.max(0, prxDbm + 73), text };
  }

  /* The main event. tx / rx rigs: {fHz, mode, powW, antDbi, antH, lat, lon}
     solar: {sfi, kp, xray}. Returns everything the UI + simulator need. */
  function olComputeLink(tx, rx, solar, dateMs) {
    const notes = [];
    if (!isFinite(tx.lat) || !isFinite(tx.lon) || !isFinite(rx.lat) || !isFinite(rx.lon)) {
      return { ok: false, state: "nolocation",
        notes: ["Both stations need a location (grid square or lat/lon) before the path can be computed."] };
    }
    const f = tx.fHz / 1e6;
    const band = olBandOf(f);
    const dKm = Math.max(0.02, olHaversine(tx, rx));
    const brg = olBearing(tx, rx);
    const mid = olMidpoint(tx, rx);
    const sunEl = olSunElev(mid.lat, mid.lon, dateMs);
    const cosChi = clamp(Math.sin(sunEl * Math.PI / 180), 0, 1);  // path illumination
    const dv = olDayVar(band ? band.id : null, f, dateMs);
    const sfi = clamp(solar.sfi || 120, 60, 320);
    const kp = clamp(solar.kp == null ? 2.5 : solar.kp, 0, 9);
    const R = Math.max(0, 1.14 * (sfi - 63.7));           // effective sunspot number

    /* ---- are the two VFOs even on the same channel? ---- */
    const txM = OL_MODES[tx.mode] || OL_MODES.DIG;
    const rxM = OL_MODES[rx.mode] || OL_MODES.DIG;
    const dfHz = Math.abs(tx.fHz - rx.fHz);
    if (dfHz > (txM.bw + rxM.bw) / 2) {
      return { ok: true, state: "offfreq", dKm, brg, f, dfHz,
        snrDb: -60, prxDbm: -160, noiseDbm: olNoiseFloor(f, rxM.bw),
        sm: olSMeter(-160), lossDb: null, foF2: null, muf: null, nHops: 0, mech: "—",
        esOpen: false,
        notes: [`Your friend's VFO is ${(dfHz / 1000).toFixed(dfHz < 10000 ? 2 : 1)} kHz away — ` +
          `you're transmitting past each other. Zero-beat those dials!`] };
    } else if (dfHz > Math.min(txM.bw, rxM.bw) / 4) {
      notes.push(`VFOs are ${(dfHz / 1000).toFixed(2)} kHz apart — inside the passband, but decoders may need retuning.`);
    }

    /* ---- ionosphere state (needed for HF, shown for everyone) ---- */
    const nightF = 2.6 + R * 0.012;
    const dayF = 5.2 + R * 0.045;
    const dayness = Math.pow(cosChi, 0.5);
    const foF2 = nightF + (dayF - nightF) * dayness;

    let loss, nHops = 0, mech, muf = null;

    if (f >= 40) {
      /* ================= VHF / UHF: line of sight ================= */
      mech = "line of sight";
      const h1 = clamp(tx.antH || 10, 1, 500), h2 = clamp(rx.antH || 10, 1, 500);
      const horizon = 4.12 * (Math.sqrt(h1) + Math.sqrt(h2));
      const fspl = 32.45 + 20 * Math.log10(f) + 20 * Math.log10(dKm);
      loss = fspl + 8 + dv.bias;                           // typical clutter/terrain excess
      if (dKm > horizon) {
        const over = dKm - horizon;
        const slope = 0.85 + (f / 1000) * 0.35;            // dB/km past the horizon
        loss += Math.min(95, over * slope) + 25 * Math.log10(1 + over / 40);
        mech = "diffraction / troposcatter";
        const needH = Math.pow(dKm / 8.24, 2);
        notes.push(`${Math.round(over)} km beyond the radio horizon (${Math.round(horizon)} km with these antennas). ` +
          `Matching ~${Math.ceil(needH)} m masts on both ends would see over — or brute-force it with dB.`);
      } else {
        notes.push(`Inside the ${Math.round(horizon)} km radio horizon — mostly free-space path.`);
      }
      if (dv.esOpen && f < 200) {
        loss -= 42;
        mech = "sporadic-E!";
        notes.push("🎆 Sporadic-E opening on this band today — the sky is doing you a favour.");
      }
    } else {
      /* ================= HF: skywave (with groundwave fallback) ================= */
      const hF2 = 320;                                     // virtual layer height, km
      const maxHop = 3600;
      nHops = Math.max(1, Math.ceil(dKm / maxHop));
      const hopD = dKm / nHops;
      const M = Math.min(3.8, Math.sqrt(1 + Math.pow(hopD / 864, 2)));
      muf = foF2 * M;
      const slantHop = 2 * Math.sqrt(Math.pow(hopD / 2, 2) + hF2 * hF2);
      const slant = nHops * slantHop;
      const fspl = 32.45 + 20 * Math.log10(f) + 20 * Math.log10(slant);

      // D-layer absorption per hop — the daytime low-band killer
      let flareAdd = 0;
      const xc = (solar.xray || "").toString().toUpperCase();
      if (xc.startsWith("M")) flareAdd = 6; else if (xc.startsWith("X")) flareAdd = 20;
      const aD = (430 * (1 + 0.005 * R) * Math.pow(cosChi, 0.75)) / Math.pow(f + 0.6, 1.85) +
        flareAdd * cosChi;

      // MUF window: gorgeous just below, dead just above
      const r = f / muf;
      let fPen = 0;
      if (r > 1) fPen = (r - 1) * 180;
      else if (r > 0.85) fPen = (r - 0.85) / 0.15 * 8;

      // skip zone: only exists once f is above vertical-incidence foF2
      let skipPen = 0;
      if (f > foF2) {
        const hopMin = 864 * Math.sqrt(Math.pow(f / foF2, 2) - 1);
        if (dKm < hopMin * 0.85) {
          skipPen = 15 + 30 * (1 - dKm / (hopMin * 0.85));
          notes.push(`You're inside the skip zone — the first hop lands ~${Math.round(hopMin)} km out, right over your friend's head. ` +
            `Drop below foF2 (${foF2.toFixed(1)} MHz) for NVIS, or accept scatter.`);
        }
      }

      const kpPen = kp * 1.1 * nHops * (Math.abs(mid.lat) > 55 ? 1.9 : 1);
      const refl = 1.5 * (nHops - 1);
      const sky = fspl + nHops * aD + fPen + skipPen + kpPen + refl + dv.bias;

      // short-haul groundwave alternative on the low bands
      let gw = Infinity;
      if (dKm < 800) {
        gw = 32.45 + 20 * Math.log10(f) + 20 * Math.log10(dKm) + dKm * (0.3 + f * 0.12);
      }
      if (gw < sky) { loss = gw; mech = "groundwave"; }
      else {
        loss = sky;
        mech = `skywave · ${nHops} hop${nHops > 1 ? "s" : ""}`;
        if (r > 1) notes.push(`${f.toFixed(3)} MHz is ${Math.round((r - 1) * 100)}% above the path MUF ` +
          `(${muf.toFixed(1)} MHz right now) — the ionosphere won't bend this back down. QSY lower.`);
        else if (r > 0.85) notes.push(`Riding just under the MUF (${muf.toFixed(1)} MHz) — maximum DX zone, expect deep, slow QSB.`);
        if (aD * nHops > 20 && cosChi > 0.15)
          notes.push(`D-layer absorption is eating ~${Math.round(aD * nHops)} dB — this path wants darkness. ` +
            `Path-midpoint sun is ${Math.round(sunEl)}° up; try again after sunset or QSY higher.`);
        if (kp >= 5) notes.push(`Kp ${kp.toFixed(1)} geomagnetic storm — expect flutter and another ${Math.round(kpPen)} dB gone.`);
      }
      if (dv.esOpen) notes.push("Seeded day-roll says sporadic-E is about (mostly a 6 m/10 m treat).");
    }

    /* ---- link budget ---- */
    const ptx = 10 * Math.log10(clamp(tx.powW, 0.001, 2e7) * 1000);   // dBm
    const gains = (tx.antDbi || 0) + (rx.antDbi || 0) - 2;            // 1 dB feedline each end
    const prx = ptx + gains - loss;
    const noise = olNoiseFloor(f, rxM.bw);
    const snr = prx - noise;
    const sm = olSMeter(prx);

    let state = "open";
    if (snr < -2) state = "closed";
    else if (snr < 8) state = "marginal";

    // "what would it take" — the fun homework numbers
    const needS9 = tx.powW * Math.pow(10, (-73 - prx) / 10);
    const needCopy = tx.powW * Math.pow(10, (noise + 10 - prx) / 10);
    if (state === "open") {
      notes.unshift(`Path open via ${mech} — ${sm.text}, ${snr.toFixed(0)} dB SNR in ${rxM.bw >= 1000 ? (rxM.bw / 1000) + " kHz" : rxM.bw + " Hz"}.`);
    } else if (state === "marginal") {
      notes.unshift(`Marginal (${snr.toFixed(0)} dB SNR) — the robust modes (CW, FT8-style) will still make it; SSTV will be snowy.`);
    } else {
      notes.unshift(`Band closed on this path right now (${snr.toFixed(0)} dB SNR).`);
    }
    if (needS9 > tx.powW * 1.3 && isFinite(needS9)) {
      notes.push(needS9 <= 2e7
        ? `For S9 at the far end you'd need ~${fmtW(needS9)} — or ${Math.ceil(10 * Math.log10(needS9 / tx.powW))} dB more antenna between you.`
        : `S9 here would take ${fmtW(needS9)} — beyond even the fantasy amplifier. Change the physics: band, time, or distance.`);
    } else if (needCopy > tx.powW && state === "closed" && needCopy <= 2e7) {
      notes.push(`~${fmtW(needCopy)} would get you a workable 10 dB SNR. Or just wait for the ionosphere.`);
    }

    return { ok: true, state, dKm, brg, f, band: band ? band.id : null, dfHz,
      foF2, muf, nHops, mech, lossDb: loss, prxDbm: prx, noiseDbm: noise,
      snrDb: snr, sm, esOpen: dv.esOpen, sunEl, kp, sfi,
      needS9W: isFinite(needS9) ? needS9 : null, notes };
  }
  /* PROP-END */

  /* ============================================================
     Channel-conditions simulator — one Web Audio graph that the
     TX audio flows through before it leaves for the peer (and,
     always, into the "Conditions loopback" virtual input).

       txBus ─┬─ direct ────────────────────────┐
              └─ sig → fade → HP → LP → chainGate ┤→ sum ─┬→ linkGate → (WebRTC)
        noise loop → HP' → LP' → noiseGain ───────┘        ├→ loopback stream
        hum oscillators → humGain ────────────────┘        └→ self-monitor
        QRN bursts → 4 kHz LP ────────────────────┘
     ============================================================ */
  class OLChannelSim {
    constructor(engine) {
      this.engine = engine;
      const ctx = this.ctx = engine.ensureContext();

      this.input = ctx.createGain();
      this.anIn = ctx.createAnalyser(); this.anIn.fftSize = 2048;
      this.sig = ctx.createGain();
      this.fade = ctx.createGain();
      this.hp = ctx.createBiquadFilter(); this.hp.type = "highpass"; this.hp.frequency.value = 100;
      this.lp = ctx.createBiquadFilter(); this.lp.type = "lowpass"; this.lp.frequency.value = 2800;
      this.chainGate = ctx.createGain(); this.chainGate.gain.value = 0;
      this.direct = ctx.createGain(); this.direct.gain.value = 1;
      this.sum = ctx.createGain();

      (engine.txSafe || engine.txBus).connect(this.input);
      this.input.connect(this.anIn);
      this.input.connect(this.sig);
      this.sig.connect(this.fade);
      this.fade.connect(this.hp); this.hp.connect(this.lp);
      this.lp.connect(this.chainGate); this.chainGate.connect(this.sum);
      this.input.connect(this.direct); this.direct.connect(this.sum);

      /* band-limited white noise bed */
      this.noiseBuf = this._noiseBuffer(4);
      this.nSrc = ctx.createBufferSource(); this.nSrc.buffer = this.noiseBuf; this.nSrc.loop = true;
      this.nHp = ctx.createBiquadFilter(); this.nHp.type = "highpass"; this.nHp.frequency.value = 100;
      this.nLp = ctx.createBiquadFilter(); this.nLp.type = "lowpass"; this.nLp.frequency.value = 2800;
      this.anNoise = ctx.createAnalyser(); this.anNoise.fftSize = 2048;
      this.noise = ctx.createGain(); this.noise.gain.value = 0;
      this.nSrc.connect(this.nHp); this.nHp.connect(this.nLp);
      this.nLp.connect(this.anNoise);
      this.nLp.connect(this.noise); this.noise.connect(this.sum);
      this.nSrc.start();

      /* mains hum (fundamental + 3rd harmonic) */
      this.hum1 = ctx.createOscillator(); this.hum1.frequency.value = 60;
      this.hum3 = ctx.createOscillator(); this.hum3.frequency.value = 180;
      this.hum3g = ctx.createGain(); this.hum3g.gain.value = 0.4;
      this.humG = ctx.createGain(); this.humG.gain.value = 0;
      this.hum1.connect(this.humG); this.hum3.connect(this.hum3g); this.hum3g.connect(this.humG);
      this.humG.connect(this.sum);
      this.hum1.start(); this.hum3.start();

      /* QRN static-crash bus */
      this.qrnLp = ctx.createBiquadFilter(); this.qrnLp.type = "lowpass"; this.qrnLp.frequency.value = 4000;
      this.qrnLp.connect(this.sum);

      /* outputs */
      this.linkGate = ctx.createGain(); this.linkGate.gain.value = 0;
      this.sum.connect(this.linkGate);
      this.loopDest = ctx.createMediaStreamDestination();
      this.sum.connect(this.loopDest);
      this.mon = ctx.createGain(); this.mon.gain.value = 0;
      this.sum.connect(this.mon); this.mon.connect(ctx.destination);

      this.mode = "direct";
      this.p = { snr: 25, fadeDepth: 6, fadeRate: 0.18, flutter: false,
                 qrnPerMin: 6, qrnLevel: 0.5, humLevel: 0, humBase: 60,
                 hpHz: 100, lpHz: 2800 };
      this._sigHold = -18;      // slow-tracked TX level, dBFS
      this._noiseRef = -20;     // measured unity noise level, dBFS
      this._ph1 = Math.random() * 6.28; this._ph2 = Math.random() * 6.28; this._ph3 = 0;
      this.meter = { inDb: -120, sigDb: -120, noiseDb: -120, snr: this.p.snr };
      this._buf = new Float32Array(2048);
      this._tick = setInterval(() => this._loop(), 100);
    }

    _noiseBuffer(sec) {
      const sr = this.ctx.sampleRate;
      const b = this.ctx.createBuffer(1, Math.floor(sr * sec), sr);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.5;
      return b;
    }
    _rms(analyser) {
      analyser.getFloatTimeDomainData(this._buf);
      let s = 0;
      for (let i = 0; i < this._buf.length; i += 2) s += this._buf[i] * this._buf[i];
      const r = Math.sqrt(s / (this._buf.length / 2));
      return r > 1e-7 ? 20 * Math.log10(r) : -140;
    }
    _ramp(param, value, tau = 0.08) {
      param.setTargetAtTime(value, this.ctx.currentTime, tau);
    }

    setMode(m) {
      this.mode = m;
      const on = m !== "direct";
      this._ramp(this.direct.gain, on ? 0 : 1, 0.05);
      this._ramp(this.chainGate.gain, on ? 1 : 0, 0.05);
      if (!on) {
        this._ramp(this.noise.gain, 0, 0.05);
        this._ramp(this.humG.gain, 0, 0.05);
      } else {
        this.setHum(this.p.humLevel, this.p.humBase);
      }
    }
    setFilter(hpHz, lpHz) {
      this.p.hpHz = hpHz; this.p.lpHz = lpHz;
      this._ramp(this.hp.frequency, hpHz, 0.03); this._ramp(this.lp.frequency, lpHz, 0.03);
      this._ramp(this.nHp.frequency, hpHz, 0.03); this._ramp(this.nLp.frequency, lpHz, 0.03);
    }
    setSNR(db) { this.p.snr = clamp(db, -40, 50); }
    setFade(depthDb, rateHz, flutter) {
      this.p.fadeDepth = clamp(depthDb, 0, 40);
      this.p.fadeRate = clamp(rateHz, 0.02, 3);
      this.p.flutter = !!flutter;
    }
    setQRN(perMin, level) { this.p.qrnPerMin = clamp(perMin, 0, 120); this.p.qrnLevel = clamp(level, 0, 1); }
    setHum(level, baseHz) {
      this.p.humLevel = clamp(level, 0, 1); this.p.humBase = baseHz;
      this.hum1.frequency.value = baseHz; this.hum3.frequency.value = baseHz * 3;
      if (this.mode !== "direct") this._ramp(this.humG.gain, this.p.humLevel * 0.12, 0.1);
    }
    setLinkOpen(open) { this._ramp(this.linkGate.gain, open ? 1 : 0, 0.03); }
    setMonitor(on) { this._ramp(this.mon.gain, on ? 0.9 : 0, 0.05); }

    _burst() {
      const ctx = this.ctx;
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      const dur = 0.025 + Math.random() * 0.11;
      const g = ctx.createGain();
      const peak = this.p.qrnLevel * (0.35 + Math.random() * 0.8);
      const t = ctx.currentTime;
      g.gain.setValueAtTime(peak, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      src.connect(g); g.connect(this.qrnLp);
      src.start(t, Math.random() * 3, dur + 0.05);
      src.onended = () => { try { src.disconnect(); g.disconnect(); } catch (e) {} };
    }

    _loop() {
      const inDb = this._rms(this.anIn);
      if (inDb > -55) this._sigHold = Math.max(inDb, this._sigHold - 0.12);
      const nRef = this._rms(this.anNoise);
      if (nRef > -80) this._noiseRef = this._noiseRef * 0.9 + nRef * 0.1;

      this.meter.inDb = inDb;
      if (this.mode === "direct") { this.meter.sigDb = inDb; this.meter.noiseDb = -120; this.meter.snr = 99; return; }

      /* placement law: keep a fixed −30 dBFS "band noise" reference and
         park the signal snr dB above it, never louder than −4 dBFS. */
      const snr = this.p.snr;
      let sigT = Math.min(-4, -30 + snr);
      let noiT = sigT - snr;
      if (snr <= -38) sigT = -120;

      const sigGainDb = clamp(sigT - this._sigHold, -80, 42);
      this._ramp(this.sig.gain, dbToLin(sigGainDb), 0.2);
      this._ramp(this.noise.gain, dbToLin(clamp(noiT - this._noiseRef, -90, 10)), 0.25);

      /* QSB: two incommensurate sinusoids + optional 9 Hz flutter */
      const dt = 0.1;
      this._ph1 += 2 * Math.PI * this.p.fadeRate * dt;
      this._ph2 += 2 * Math.PI * this.p.fadeRate * 1.618 * dt;
      let fadeDb = -this.p.fadeDepth * (0.5 + 0.5 * Math.sin(this._ph1)) * (0.55 + 0.45 * Math.sin(this._ph2 + 1.3));
      if (this.p.flutter) { this._ph3 += 2 * Math.PI * 9 * dt; fadeDb += -3 * (0.5 + 0.5 * Math.sin(this._ph3)); }
      this._ramp(this.fade.gain, dbToLin(clamp(fadeDb, -70, 0)), 0.05);

      if (this.p.qrnPerMin > 0 && Math.random() < this.p.qrnPerMin / 600) this._burst();

      this.meter.sigDb = sigT + fadeDb;
      this.meter.noiseDb = noiT;
      this.meter.snr = snr + fadeDb;
    }
  }

  /* ============================================================
     Link client — signaling over api/link.php, audio over a
     direct browser-to-browser Opus stream (tuned to 320 kb/s
     stereo, FEC on, DTX off: data modes survive intact).
     ============================================================ */
  class OLLink {
    constructor() {
      this._ev = {};
      this.state = "idle";       // idle|hosting|joining|connecting|connected
      this.room = null; this.peer = null; this.token = null;
      this.cursor = 0; this.polling = false; this.pollTimer = null;
      this.pc = null; this.dc = null;
      this.outStream = null;     // set by the module before host()/join()
      this.remoteStream = null;
      this.peers = {};
      this.stats = { up: 0, down: 0, rtt: null };
      this._last = {}; this._statsT = null; this._restarted = false;
    }
    on(e, cb) { (this._ev[e] ||= new Set()).add(cb); }
    emit(e, d) { (this._ev[e] || []).forEach(cb => { try { cb(d); } catch (err) { console.error(err); } }); }

    async api(action, params = {}, body = null) {
      const q = new URLSearchParams({ action, ...params });
      const opts = body
        ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : { method: (action === "poll" || action === "info") ? "GET" : "POST" };
      const res = await fetch("api/link.php?" + q.toString(), opts);
      let j; try { j = await res.json(); } catch { throw new Error("link API returned garbage — is PHP running?"); }
      if (j && j.error) throw new Error(j.error);
      return j;
    }

    async host() {
      const j = await this.api("create");
      this.room = j.room; this.peer = "a"; this.token = j.token; this.cursor = 0;
      this.state = "hosting"; this.emit("state"); this._startPoll();
      return j.room;
    }
    async join(code) {
      const info = await this.api("info", { room: code });
      if (!info.exists) throw new Error("that link code doesn't exist (or it expired)");
      const j = await this.api("join", { room: code });
      this.room = code; this.peer = "b"; this.token = j.token; this.cursor = 0;
      this.state = "joining"; this.emit("state"); this._startPoll();
    }

    _startPoll() {
      this.polling = true;
      const loop = async () => {
        if (!this.polling) return;
        let delay = this.state === "connected" ? 4000 : 900;
        try {
          const j = await this.api("poll", { room: this.room, peer: this.peer, token: this.token, cursor: this.cursor });
          this.cursor = j.cursor; this.peers = j.peers || {};
          for (const m of (j.msgs || [])) await this._onSignal(m.data);
        } catch (e) {
          this.emit("log", "signaling: " + e.message);
          if (/no such link/i.test(e.message)) { this.hangup("link expired on the server"); return; }
          delay = 3000;
        }
        this.pollTimer = setTimeout(loop, delay);
      };
      loop();
    }
    async _signal(data) {
      try { await this.api("send", { room: this.room, peer: this.peer, token: this.token }, data); }
      catch (e) { this.emit("log", "signaling send failed: " + e.message); }
    }

    async _onSignal(d) {
      if (!d || !d.type) return;
      switch (d.type) {
        case "join":
          if (this.peer === "a") { this.emit("log", "friend joined — negotiating…"); await this._makePeer(true); }
          break;
        case "sdp": {
          if (!this.pc) await this._makePeer(false);
          try {
            await this.pc.setRemoteDescription(d.sdp);
            if (d.sdp.type === "offer") {
              const ans = await this.pc.createAnswer();
              ans.sdp = this._opus(ans.sdp);
              await this.pc.setLocalDescription(ans);
              this._signal({ type: "sdp", sdp: { type: ans.type, sdp: ans.sdp } });
            }
          } catch (e) { this.emit("log", "SDP exchange failed: " + e.message); }
          break;
        }
        case "ice":
          if (this.pc) { try { await this.pc.addIceCandidate(d.c || undefined); } catch (e) { /* late/dup candidates are fine */ } }
          break;
        case "bye": this.peerLeft("your friend left the link"); break;
      }
    }

    async _makePeer(offerer) {
      this._teardownPeer(true);
      const pc = this.pc = new RTCPeerConnection({
        iceServers: [
          { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
          { urls: "stun:global.stun.twilio.com:3478" }
        ]
      });
      if (this.outStream) {
        for (const t of this.outStream.getAudioTracks()) {
          try { t.contentHint = "music"; } catch (e) {}
          pc.addTrack(t, this.outStream);
        }
      }
      pc.onicecandidate = (e) => this._signal({ type: "ice", c: e.candidate ? e.candidate.toJSON() : null });
      pc.ontrack = (e) => {
        this.remoteStream = (e.streams && e.streams[0]) || new MediaStream([e.track]);
        this.emit("remote", this.remoteStream);
      };
      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        this.emit("log", "link " + s);
        if (s === "connected") { this.state = "connected"; this._restarted = false; this.emit("state"); this._statsLoop(); }
        else if (s === "failed") this._tryRestart();
        else if (s === "disconnected") setTimeout(() => { if (pc.connectionState === "disconnected") this._tryRestart(); }, 4000);
      };
      if (offerer) {
        this._wireDc(pc.createDataChannel("hrws"));
        const off = await pc.createOffer();
        off.sdp = this._opus(off.sdp);
        await pc.setLocalDescription(off);
        this._signal({ type: "sdp", sdp: { type: off.type, sdp: off.sdp } });
      } else {
        pc.ondatachannel = (e) => this._wireDc(e.channel);
      }
      this.state = "connecting"; this.emit("state");
    }

    async _tryRestart() {
      if (!this.pc) return;
      if (this.peer !== "a") { this.emit("log", "connection dropped — waiting for the host to restart ICE…"); return; }
      if (this._restarted) { this.emit("log", "ICE restart already tried — check both networks."); return; }
      this._restarted = true;
      this.emit("log", "trying an ICE restart…");
      try {
        const off = await this.pc.createOffer({ iceRestart: true });
        off.sdp = this._opus(off.sdp);
        await this.pc.setLocalDescription(off);
        this._signal({ type: "sdp", sdp: { type: off.type, sdp: off.sdp } });
      } catch (e) { this.emit("log", "ICE restart failed: " + e.message); }
    }

    _wireDc(dc) {
      this.dc = dc;
      dc.onopen = () => this.emit("dc-open");
      dc.onmessage = (e) => { try { this.emit("msg", JSON.parse(e.data)); } catch (err) {} };
    }
    send(obj) {
      if (this.dc && this.dc.readyState === "open") {
        try { this.dc.send(JSON.stringify(obj)); return true; } catch (e) {}
      }
      return false;
    }

    /* pin Opus at its hi-fi ceiling — this is what keeps SSTV pixels
       and QAM constellations intact across the internet */
    _opus(sdp) {
      const m = sdp.match(/a=rtpmap:(\d+) opus\/48000/i);
      if (!m) return sdp;
      const pt = m[1];
      const extra = "stereo=1;sprop-stereo=1;maxaveragebitrate=320000;maxplaybackrate=48000;useinbandfec=1;usedtx=0;cbr=0";
      const re = new RegExp("a=fmtp:" + pt + " ([^\\r\\n]*)");
      if (re.test(sdp)) return sdp.replace(re, (l, params) => "a=fmtp:" + pt + " " + params + ";" + extra);
      return sdp.replace(new RegExp("(a=rtpmap:" + pt + " [^\\r\\n]*\\r?\\n)"), "$1a=fmtp:" + pt + " " + extra + "\r\n");
    }

    _statsLoop() {
      clearInterval(this._statsT);
      this._statsT = setInterval(async () => {
        if (!this.pc || this.pc.connectionState !== "connected") { clearInterval(this._statsT); return; }
        try {
          const rep = await this.pc.getStats();
          const now = performance.now();
          const dt = Math.max(0.4, (now - (this._last.t || now - 2000)) / 1000);
          let up = 0, down = 0, rtt = this.stats.rtt;
          rep.forEach(s => {
            if (s.type === "outbound-rtp" && s.kind === "audio") {
              up = Math.max(0, (s.bytesSent - (this._last.out ?? s.bytesSent)) * 8 / dt);
              this._last.out = s.bytesSent;
            }
            if (s.type === "inbound-rtp" && s.kind === "audio") {
              down = Math.max(0, (s.bytesReceived - (this._last.in ?? s.bytesReceived)) * 8 / dt);
              this._last.in = s.bytesReceived;
            }
            if (s.type === "candidate-pair" && s.state === "succeeded" && s.currentRoundTripTime != null)
              rtt = s.currentRoundTripTime * 1000;
          });
          this._last.t = now;
          this.stats = { up, down, rtt };
          this.emit("stats");
        } catch (e) {}
      }, 2000);
    }

    peerLeft(msg) {
      this.emit("log", msg || "peer left");
      this._teardownPeer();
      if (this.peer === "a" && this.polling) { this.state = "hosting"; }
      else { this.state = "idle"; this.polling = false; clearTimeout(this.pollTimer); this.room = this.token = null; }
      this.emit("state");
    }
    _teardownPeer(quiet) {
      clearInterval(this._statsT);
      if (this.dc) { try { this.dc.close(); } catch (e) {} this.dc = null; }
      if (this.pc) { try { this.pc.close(); } catch (e) {} this.pc = null; }
      this._last = {}; this.stats = { up: 0, down: 0, rtt: null };
      this.remoteStream = null;
      if (!quiet) this.emit("remote", null);
    }
    async hangup(reason) {
      this.polling = false; clearTimeout(this.pollTimer);
      if (this.dc && this.dc.readyState === "open") this.send({ type: "bye" });
      if (this.room && this.token) this.api("leave", { room: this.room, peer: this.peer, token: this.token }).catch(() => {});
      this._teardownPeer();
      this.room = this.token = null; this.state = "idle";
      this.emit("state");
      if (reason) this.emit("log", "link closed: " + reason);
    }
  }

  /* ============================================================
     The module
     ============================================================ */
  const def = {
    id: "online",

    init(ctx) {
      this.ctx = ctx;
      this.link = new OLLink();
      this.sim = null;             // built lazily (needs an AudioContext)
      this.msDest = null;
      this.role = "rx";
      this.peerRole = null;
      this.peerInfo = null;        // {call, grid}
      this.peerRig = null;
      this.peerCalc = null;
      this.condMode = "direct";    // direct | manual | sim
      this.autoRoute = true;
      this.solar = { sfi: 120, kp: 2.5, xray: null, src: "defaults" };
      this.ui = null;
      this._uiTimers = [];
      this._pendingJoin = null;
      this._monGain = null;
      this._remoteSrc = null;
      this._remoteEl = null;
      this._prevInput = undefined;

      const saved = (ctx.settings().online || {});
      this.rig = Object.assign({ fHz: 14074000, mode: "DIG", powW: 100, antDbi: 2.15, antH: 10, grid: "" }, saved.rig || {});
      this.planB = Object.assign({ fHz: 14074000, mode: "DIG", powW: 100, antDbi: 2.15, antH: 10, grid: "" }, saved.planB || {});
      this.cond = Object.assign({ snr: 20, fadeDepth: 6, fadeRate: 0.18, flutter: false,
        qrnPerMin: 6, qrnLevel: 0.5, humLevel: 0, humBase: 60, filter: "DIG" }, saved.cond || {});
      if (saved.condMode) this.condMode = saved.condMode;
      if (saved.autoRoute === false) this.autoRoute = false;

      /* virtual inputs — these show up in the sidebar Input picker */
      const audio = ctx.audio;
      audio.registerVirtualInput("__online-link__", "🌐 Online link (remote studio)",
        () => this.link.remoteStream);
      audio.registerVirtualInput("__online-loopback__", "🧪 Conditions loopback (my TX through the simulator)",
        () => { this._ensureAudio(); return this.sim.loopDest.stream; });

      /* a LINK led next to RX/TX in the top bar */
      const leds = document.querySelector(".topbar .leds");
      if (leds && !document.getElementById("led-link")) {
        const led = document.createElement("span");
        led.className = "led"; led.id = "led-link";
        led.title = "Online link connected";
        led.innerHTML = "<i></i>LINK";
        leds.appendChild(led);
      }

      /* link events (UI parts are guarded — the tab may be closed) */
      this.link.on("log", (m) => ctx.log(m));
      this.link.on("state", () => {
        const s = this.link.state;
        document.getElementById("led-link")?.classList.toggle("on", s === "connected");
        if (s === "connected") { this._sendHello(); }
        if (s !== "connected") { this.peerRole = null; this.peerCalc = null; if (s === "idle" || s === "hosting") { this.peerRig = null; this.peerInfo = null; } }
        this._applyGates();
        this._refreshLinkUI();
        this._refreshRigUI();
      });
      this.link.on("dc-open", () => this._sendHello());
      this.link.on("remote", (stream) => this._onRemoteStream(stream));
      this.link.on("msg", (m) => this._onMsg(m));
      this.link.on("stats", () => this._refreshStats());

      /* follow the studio's TX state so every mode "just works" over
         the link without a trip back to this tab */
      this._autoTx = false;
      this._txDropT = null;
      audio.on("tx-start", () => this._txFollow(true));
      audio.on("tx-end", () => this._txFollow(false));

      /* duck the raw friend-monitor while the link is what the decoders
         are listening to — modem tones and TV buzz are for the decoders,
         not the speakers; the demodulated results speak for themselves */
      this._monBase = 0.85;
      audio.on("rx-start", () => this._updateMonGain());
      audio.on("rx-stop", () => this._updateMonGain());

      /* solar data — same proxy the dashboard uses */
      this._fetchSolar();
      this._solarT = setInterval(() => this._fetchSolar(), 10 * 60 * 1000);

      ctx.log("Online Link ready — create a link and send the URL to a friend, or use the 🧪 loopback solo.");
    },

    /* -------------- audio plumbing -------------- */
    _ensureAudio() {
      const engine = this.ctx.audio;
      const actx = engine.ensureContext();
      if (!this.sim) {
        this.sim = new OLChannelSim(engine);
        this.msDest = actx.createMediaStreamDestination();
        this.sim.linkGate.connect(this.msDest);
        this._monGain = actx.createGain();
        this._monGain.gain.value = this._monBase;
        this._monGain.connect(actx.destination);
        this._updateMonGain();
        this.sim.setMode(this.condMode);
        this._pushCondToSim();
        this.link.outStream = this.msDest.stream;
      }
      return actx;
    },

    _onRemoteStream(stream) {
      const actx = this._ensureAudio();
      if (this._remoteSrc) { try { this._remoteSrc.disconnect(); } catch (e) {} this._remoteSrc = null; }
      if (this._remoteEl) { try { this._remoteEl.srcObject = null; } catch (e) {} this._remoteEl = null; }
      if (!stream) { this._refreshLinkUI(); return; }
      /* Chrome quirk: a remote WebRTC stream stays silent in Web Audio
         until it's attached to a media element — a muted one will do. */
      const el = this._remoteEl = new Audio();
      el.muted = true; el.autoplay = true; el.playsInline = true;
      el.srcObject = stream;
      el.play().catch(() => {});
      this._remoteSrc = actx.createMediaStreamSource(stream);
      this._remoteSrc.connect(this._monGain);
      this.ctx.log("Remote audio flowing — monitor it here, and pick “🌐 Online link” as the Input to feed every decoder.");
      if (this.autoRoute && this.role === "rx") this._routeLinkToDecoders(true);
      this._refreshLinkUI();
    },

    async _routeLinkToDecoders(auto) {
      const engine = this.ctx.audio;
      if (!this.link.remoteStream) { if (!auto) this.ctx.log("No remote audio yet — connect the link first."); return; }
      if (engine.inputId === "__online-link__" && engine.rxActive) return;
      try {
        if (this._prevInput === undefined) this._prevInput = engine.rxActive ? engine.inputId : undefined;
        const sel = document.getElementById("sel-input");
        if (sel) sel.value = "__online-link__";
        if (engine.rxActive) await engine.startRX("__online-link__");
        else document.getElementById("btn-audio")?.click();
        this.ctx.log("RX input switched to the online link — every open decoder now hears your friend.");
        this._updateMonGain();
      } catch (e) { this.ctx.log("Couldn't route the link to the decoders: " + (e.message || e)); }
    },

    /* role switching, callable from the buttons AND the TX auto-follow */
    _setRole(r) {
      if (this.role === r) return;
      this.role = r;
      if (this.ui) {
        this.ui.roleRx.classList.toggle("btn-accent", r === "rx");
        this.ui.roleTx.classList.toggle("btn-accent", r === "tx");
      }
      this._applyGates();
      this.link.send({ type: "role", role: r });
      if (r === "rx") {
        if (this.autoRoute) this._routeLinkToDecoders(true);
      } else {
        const engine = this.ctx.audio;
        if (engine.inputId === "__online-link__" && this._prevInput !== undefined && this.autoRoute) {
          const prev = this._prevInput; this._prevInput = undefined;
          engine.startRX(prev || undefined).then(() => {
            const sel = document.getElementById("sel-input"); if (sel) sel.value = prev || "";
            this.ctx.log("Back on your local input for TX.");
          }).catch(() => {});
        }
        this.ctx.log("You are TX — fire away from any mode tab. It all goes down the link.");
      }
      this._refreshLinkUI();
    },

    /* TX auto-follow: any module keying up (CW paddle, SSTV send, NBTV
       stream, a QAM burst…) flips this side to TX so the audio actually
       leaves through the link gate — the silent-death case where you
       transmit into a closed gate is gone. Drops back to RX a moment
       after the transmission ends (debounced: keyed CW emits start/stop
       per element). Manual role clicks always win; honors Auto route. */
    _txFollow(on) {
      if (!this.autoRoute || this.link.state !== "connected") return;
      clearTimeout(this._txDropT);
      if (on) {
        if (this.role !== "tx") {
          this._autoTx = true;
          this.ctx.log("TX detected — link switched to TX for you (Auto route).");
          this._setRole("tx");
        }
      } else if (this._autoTx) {
        this._txDropT = setTimeout(() => {
          if (!this.ctx.audio.txActive && this._autoTx) {
            this._autoTx = false;
            this.ctx.log("Transmission over — link back to RX.");
            this._setRole("rx");
          }
        }, 1500);
      }
    },

    _updateMonGain() {
      if (!this._monGain) return;
      const eng = this.ctx.audio;
      const ducked = eng.rxActive && eng.inputId === "__online-link__";
      this._monGain.gain.setTargetAtTime(this._monBase * (ducked ? 0.12 : 1),
        eng.ctx.currentTime, 0.05);
      if (this.ui && this.ui.monVal)
        this.ui.monVal.textContent = Math.round(this._monBase * 100) + "%" +
          (ducked ? " · auto-ducked while decoding" : "");
    },

    _applyGates() {
      if (!this.sim) return;
      const txOpen = this.role === "tx" && this.link.state === "connected";
      this.sim.setLinkOpen(txOpen);
      if (this.link.pc) {
        for (const s of this.link.pc.getSenders()) {
          if (s.track) s.track.enabled = txOpen;
        }
      }
    },

    /* -------------- data-channel protocol -------------- */
    _sendHello() {
      const st = this.ctx.settings();
      this.link.send({ type: "hello", call: st.callsign || "N0CALL", grid: st.grid || "", ver: 1 });
      this.link.send({ type: "role", role: this.role });
      this._sendRig();
      this._sendCond();
    },
    _sendRig() {
      const r = this._myRigResolved();
      this.link.send({ type: "rig", rig: { fHz: r.fHz, mode: r.mode, powW: r.powW, antDbi: r.antDbi, antH: r.antH, grid: r.gridShown, lat: r.lat, lon: r.lon } });
    },
    _sendCond() {
      this.link.send({ type: "cond", mode: this.condMode, p: this.condMode === "manual" ? this.cond : null });
    },
    _onMsg(m) {
      if (!m || !m.type) return;
      switch (m.type) {
        case "hello": this.peerInfo = { call: m.call, grid: m.grid }; this.ctx.log(`Connected to ${m.call || "a friend"}${m.grid ? " in " + m.grid : ""} — 73!`); this._refreshLinkUI(); break;
        case "role": this.peerRole = m.role; this._refreshLinkUI(); break;
        case "rig": this.peerRig = m.rig; this._refreshRigUI(); break;
        case "cond": this.peerCond = m; this._refreshCondUI(); break;
        case "calc": this.peerCalc = m.res; this._refreshPathUI(); break;
        case "chat": this._chatLine(this.peerInfo?.call || "friend", m.text); break;
        case "ping": this.link.send({ type: "pong", t: m.t }); break;
        case "pong": break;
        case "bye": this.link.peerLeft("your friend hung up"); break;
      }
    },
    _chatLine(who, text) {
      const log = this.ui?.chatLog; if (!log) return;
      const div = document.createElement("div");
      div.innerHTML = `<span class="ol-chat-who">${esc(who)}</span> ${esc(text)}`;
      log.appendChild(div);
      while (log.childElementCount > 120) log.removeChild(log.firstChild);
      log.scrollTop = log.scrollHeight;
    },

    /* -------------- solar -------------- */
    async _fetchSolar() {
      try {
        const res = await fetch("api/solar.php", { cache: "no-store" });
        if (!res.ok) throw new Error("http " + res.status);
        const j = await res.json();
        this.solar = {
          sfi: (typeof j.sfi === "number" ? j.sfi : 120),
          kp: (typeof j.kp === "number" ? j.kp : 2.5),
          xray: j.xray_class || null,
          src: "NOAA " + new Date().toISOString().slice(11, 16) + "z"
        };
      } catch (e) {
        this.solar.src = "defaults (solar API offline)";
      }
      this._refreshPathUI();
    },

    /* -------------- rig helpers -------------- */
    _stationLL() {
      const st = this.ctx.settings();
      if (isFinite(parseFloat(st.lat)) && isFinite(parseFloat(st.lon)))
        return { lat: parseFloat(st.lat), lon: parseFloat(st.lon), grid: st.grid || DSP.latLonToGrid(parseFloat(st.lat), parseFloat(st.lon)) };
      if (st.grid) { const ll = DSP.gridToLatLon(st.grid); if (ll) return { lat: ll.lat, lon: ll.lon, grid: st.grid }; }
      return null;
    },
    _myRigResolved() {
      const r = Object.assign({}, this.rig);
      let ll = null, gridShown = "";
      if (r.grid) { ll = DSP.gridToLatLon(r.grid); gridShown = r.grid.toUpperCase(); }
      if (!ll) { const s = this._stationLL(); if (s) { ll = s; gridShown = (s.grid || "").toUpperCase(); } }
      r.lat = ll ? ll.lat : NaN; r.lon = ll ? ll.lon : NaN; r.gridShown = gridShown;
      return r;
    },
    _rxRigResolved() {
      if (this.peerRig) {
        const p = Object.assign({}, this.peerRig);
        if ((!isFinite(p.lat) || !isFinite(p.lon)) && p.grid) {
          const ll = DSP.gridToLatLon(p.grid); if (ll) { p.lat = ll.lat; p.lon = ll.lon; }
        }
        p._who = "peer";
        return p;
      }
      const b = Object.assign({}, this.planB);
      const ll = b.grid ? DSP.gridToLatLon(b.grid) : null;
      b.lat = ll ? ll.lat : NaN; b.lon = ll ? ll.lon : NaN; b._who = "plan";
      return b;
    },

    _saveSoon() {
      clearTimeout(this._saveT);
      this._saveT = setTimeout(() => {
        const st = this.ctx.settings();
        st.online = { rig: this.rig, planB: this.planB, cond: this.cond,
                      condMode: this.condMode, autoRoute: this.autoRoute };
        if (window.saveSettings) window.saveSettings(st, true);
      }, 800);
    },

    /* ============================================================
       UI
       ============================================================ */
    createPanel(el) {
      el.innerHTML = `
      <style>
        .ol-share { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
        .ol-share input[type=text] { flex:1; min-width:200px; background:var(--bg1,#0a0e14); border:1px solid var(--line,#20293a);
          color:var(--text,#dde3ee); padding:7px 9px; border-radius:6px; font-family:var(--font-mono); font-size:12px; }
        .ol-status { display:flex; gap:10px; align-items:center; margin-top:10px; font-family:var(--font-mono); font-size:12px; flex-wrap:wrap; }
        .ol-dot { width:9px; height:9px; border-radius:50%; background:#39424f; box-shadow:0 0 6px rgba(0,0,0,.4); }
        .ol-dot.wait { background:#ffd166; box-shadow:0 0 8px rgba(255,209,102,.7); }
        .ol-dot.on { background:#5dd39e; box-shadow:0 0 8px rgba(93,211,158,.8); }
        .ol-seg { display:inline-flex; gap:0; border:1px solid var(--line,#20293a); border-radius:8px; overflow:hidden; }
        .ol-seg .btn { border:none; border-radius:0; margin:0; }
        .ol-vfo { display:flex; align-items:baseline; gap:2px; font-family:var(--font-mono); font-size:34px; letter-spacing:1px;
          color:var(--amber,#ffb454); text-shadow:0 0 14px rgba(255,180,84,.45); user-select:none; padding:6px 2px; }
        .ol-vfo .d { cursor:ns-resize; padding:0 1px; border-radius:4px; }
        .ol-vfo .d:hover { background:rgba(255,180,84,.16); }
        .ol-vfo .dim { opacity:.28; }
        .ol-vfo .u { font-size:14px; color:var(--muted,#8b95a7); margin-left:8px; text-shadow:none; }
        .ol-bands { display:flex; flex-wrap:wrap; gap:5px; margin:6px 0 2px; }
        .ol-path { display:grid; grid-template-columns:repeat(auto-fit,minmax(118px,1fr)); gap:8px; margin-top:10px; }
        .ol-cell { background:rgba(255,255,255,.02); border:1px solid var(--line,#20293a); border-radius:8px; padding:8px 10px; }
        .ol-cell b { display:block; font-family:var(--font-mono); font-size:15px; color:var(--text,#dde3ee); margin-bottom:2px; font-weight:600; }
        .ol-cell span { font-size:10px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted,#8b95a7); }
        .ol-notes { margin-top:10px; font-size:12.5px; line-height:1.55; color:var(--text,#c9d2e2); }
        .ol-notes div::before { content:"▸ "; color:var(--amber,#ffb454); }
        .ol-chat-log { height:96px; overflow-y:auto; background:var(--bg1,#0a0e14); border:1px solid var(--line,#20293a);
          border-radius:6px; padding:6px 8px; font-family:var(--font-mono); font-size:12px; margin-bottom:6px; }
        .ol-chat-who { color:var(--amber,#ffb454); }
        .ol-chat-row { display:flex; gap:6px; }
        .ol-chat-row input { flex:1; background:var(--bg1,#0a0e14); border:1px solid var(--line,#20293a); color:var(--text,#dde3ee);
          padding:6px 8px; border-radius:6px; font-family:var(--font-mono); font-size:12px; }
        .ol-smeter { width:100%; height:46px; display:block; }
        .ol-chip { display:inline-block; padding:2px 8px; border:1px solid var(--line,#20293a); border-radius:10px;
          font-family:var(--font-mono); font-size:11px; color:var(--muted,#8b95a7); margin:2px 4px 2px 0; }
        .ol-chip em { color:var(--amber,#ffb454); font-style:normal; }
        .ol-badge { font-family:var(--font-mono); font-size:11px; padding:2px 7px; border-radius:9px; margin-left:8px; }
        .ol-badge.qrp { background:rgba(93,211,158,.15); color:#5dd39e; }
        .ol-badge.legal { background:rgba(255,180,84,.15); color:var(--amber,#ffb454); }
        .ol-badge.fantasy { background:rgba(255,93,93,.16); color:#ff7d7d; }
        .ol-peerline { font-family:var(--font-mono); font-size:12px; color:var(--muted,#8b95a7); margin-top:8px; }
        .ol-peerline em { color:var(--amber,#ffb454); font-style:normal; }
        .ol-oob { color:#ff7d7d; font-family:var(--font-mono); font-size:11px; margin-left:8px; }
      </style>

      <div class="mod-layout">
        <div class="mod-main">

          <!-- ================= LINK ================= -->
          <div class="card">
            <header class="card-head"><h3>Online link</h3>
              <span class="card-tag mono" id="ol-room-tag">no link</span></header>
            <div class="card-body">
              <div class="ol-share">
                <button class="btn btn-accent" id="ol-create">Create link</button>
                <input type="text" id="ol-url" readonly placeholder="…create a link, then send this URL to your friend">
                <button class="btn" id="ol-copy" disabled>Copy</button>
              </div>
              <div class="ol-share" style="margin-top:8px">
                <input type="text" id="ol-code" placeholder="…or paste a code / URL from a friend" style="max-width:340px">
                <button class="btn" id="ol-join">Join</button>
                <button class="btn btn-danger" id="ol-hang" disabled>Hang up</button>
              </div>
              <div class="ol-status">
                <span class="ol-dot" id="ol-dot"></span>
                <span id="ol-state">idle</span>
                <span class="muted" id="ol-peer-presence"></span>
                <span class="muted" id="ol-stats"></span>
              </div>
              <div class="mod-controls" style="margin-top:12px">
                <label class="field"><span>My side is</span>
                  <span class="ol-seg">
                    <button class="btn btn-accent" id="ol-role-rx">RX — listen</button>
                    <button class="btn" id="ol-role-tx">TX — transmit</button>
                  </span></label>
                <label class="field"><span>Monitor friend <em id="ol-mon-val">85%</em></span>
                  <input type="range" id="ol-mon" min="0" max="100" value="85"></label>
                <button class="btn" id="ol-route" title="Set the sidebar Input to the online link so every decoder hears your friend">Route link → decoders</button>
                <label class="mono muted" style="font-size:12px;align-self:flex-end"><input type="checkbox" id="ol-autoroute" checked> auto-route (RX in · TX out)</label>
              </div>
              <div class="ol-peerline" id="ol-peerline">Nobody on the other end yet.</div>
              <div style="margin-top:10px">
                <div class="ol-chat-log" id="ol-chat-log"></div>
                <div class="ol-chat-row">
                  <input type="text" id="ol-chat-in" placeholder="chat with your friend (coordination channel)…" maxlength="300">
                  <button class="btn btn-mini" id="ol-chat-send">Send</button>
                </div>
              </div>
            </div>
          </div>

          <!-- ================= CONDITIONS ================= -->
          <div class="card">
            <header class="card-head"><h3>Conditions — channel simulator</h3>
              <span class="card-tag mono" id="ol-cond-tag">direct patch</span></header>
            <div class="card-body">
              <div class="mod-controls">
                <label class="field"><span>Channel</span>
                  <span class="ol-seg">
                    <button class="btn btn-accent" id="ol-cm-direct" title="Bit-perfect pass-through — pure internet link">Direct patch</button>
                    <button class="btn" id="ol-cm-manual" title="You control the noise, fading, static and hum">Manual</button>
                    <button class="btn" id="ol-cm-sim" title="The virtual rigs + real solar data decide">Full simulation</button>
                  </span></label>
                <label class="field"><span>Preset</span>
                  <select id="ol-preset">
                    <option value="">— pick —</option>
                    <option value="clean">Quiet band</option>
                    <option value="summer">Summer QRN (80 m evening)</option>
                    <option value="qsb">Deep slow QSB</option>
                    <option value="storm">Geomagnetic flutter</option>
                    <option value="pileup">Noisy city lot</option>
                    <option value="brutal">Brutal — barely there</option>
                  </select></label>
                <label class="field"><span>RX filter</span>
                  <select id="ol-filter">
                    <option value="CW">CW 500 Hz</option>
                    <option value="DIG" selected>Data / SSB 2.7 kHz</option>
                    <option value="AM">AM 6 kHz</option>
                    <option value="FM">FM wide</option>
                  </select></label>
                <label class="mono muted" style="font-size:12px;align-self:flex-end"><input type="checkbox" id="ol-selfmon"> hear my own conditioned TX</label>
              </div>
              <div class="mod-controls" id="ol-manual-row" style="margin-top:10px">
                <label class="field"><span>SNR <em id="ol-snr-val">20 dB</em></span>
                  <input type="range" id="ol-snr" min="-35" max="45" value="20"></label>
                <label class="field"><span>QSB depth <em id="ol-qsbd-val">6 dB</em></span>
                  <input type="range" id="ol-qsbd" min="0" max="35" value="6"></label>
                <label class="field"><span>QSB rate <em id="ol-qsbr-val">0.18 Hz</em></span>
                  <input type="range" id="ol-qsbr" min="2" max="200" value="18"></label>
                <label class="mono muted" style="font-size:12px;align-self:flex-end"><input type="checkbox" id="ol-flutter"> flutter</label>
                <label class="field"><span>QRN crashes/min <em id="ol-qrn-val">6</em></span>
                  <input type="range" id="ol-qrn" min="0" max="80" value="6"></label>
                <label class="field"><span>Hum <em id="ol-hum-val">off</em></span>
                  <input type="range" id="ol-hum" min="0" max="100" value="0"></label>
                <label class="field"><span>Mains</span>
                  <select id="ol-hum-base"><option value="60">60 Hz</option><option value="50">50 Hz</option></select></label>
              </div>
              <div class="mod-status" id="ol-cond-meter" style="margin-top:8px"></div>
              <footer class="card-foot mono muted">Solo? Set the sidebar Input to <b>🧪 Conditions loopback</b>, TX from any mode tab, and decode yourself through the muck. No band was harmed.</footer>
            </div>
          </div>

          <!-- ================= VIRTUAL RIG ================= -->
          <div class="card">
            <header class="card-head"><h3>Virtual rig &amp; propagation</h3>
              <span class="card-tag mono" id="ol-solar-tag">solar: …</span></header>
            <div class="card-body">
              <div class="ol-vfo" id="ol-vfo" title="Scroll a digit to tune"></div>
              <div class="ol-bands" id="ol-bands"></div>
              <div class="mod-controls" style="margin-top:8px">
                <label class="field"><span>Mode</span>
                  <select id="ol-rig-mode">
                    <option value="CW">CW</option><option value="DIG" selected>DATA</option>
                    <option value="SSB">SSB</option><option value="AM">AM</option><option value="FM">FM</option>
                  </select></label>
                <label class="field" style="min-width:220px"><span>TX power <em id="ol-pow-val">100 W</em><span class="ol-badge legal" id="ol-pow-badge">100 W class</span></span>
                  <input type="range" id="ol-pow" min="0" max="1000" value="500"></label>
                <label class="field"><span>Antenna <em id="ol-ant-val">2.15 dBi</em></span>
                  <input type="range" id="ol-ant" min="0" max="300" value="21"></label>
                <label class="field"><span>Ant height <em id="ol-anth-val">10 m</em></span>
                  <input type="range" id="ol-anth" min="1" max="200" value="10"></label>
                <label class="field"><span>My grid <em class="muted" style="font-size:10px">(blank = station settings)</em></span>
                  <input type="text" id="ol-grid" class="mono" placeholder="FN06ge" maxlength="8" style="width:110px"></label>
              </div>
              <div class="ol-peerline" id="ol-planb-wrap">
                <span id="ol-planb-label">No friend connected — plan a path against a fictional <em>Station B</em>:</span>
                <div class="mod-controls" style="margin-top:6px" id="ol-planb-row">
                  <label class="field"><span>B grid</span><input type="text" id="ol-b-grid" class="mono" placeholder="JO01" maxlength="8" style="width:100px"></label>
                  <label class="field"><span>B power <em id="ol-b-pow-val">100 W</em></span>
                    <input type="range" id="ol-b-pow" min="0" max="1000" value="500"></label>
                  <label class="field"><span>B antenna <em id="ol-b-ant-val">2.15 dBi</em></span>
                    <input type="range" id="ol-b-ant" min="0" max="300" value="21"></label>
                  <label class="field"><span>B ant height <em id="ol-b-anth-val">10 m</em></span>
                    <input type="range" id="ol-b-anth" min="1" max="200" value="10"></label>
                </div>
              </div>
              <div class="ol-path" id="ol-path"></div>
              <div class="ol-notes" id="ol-notes"></div>
              <footer class="card-foot mono muted" id="ol-solar-foot">A teaching model, not VOACAP — it reacts to the right knobs with plausible numbers. Your ears still win.</footer>
            </div>
          </div>

        </div>
        <div class="mod-side">

          <div class="card">
            <header class="card-head"><h3>S-meter</h3><span class="card-tag mono" id="ol-s-tag">—</span></header>
            <div class="card-body">
              <canvas class="ol-smeter" id="ol-smeter" width="290" height="46"></canvas>
              <div class="mono" id="ol-s-read" style="margin-top:8px; font-size:13px; color:var(--amber,#ffb454)">—</div>
              <div class="mono muted" id="ol-s-sub" style="font-size:11px; margin-top:3px"></div>
            </div>
          </div>

          <div class="card">
            <header class="card-head"><h3>Space weather</h3></header>
            <div class="card-body" id="ol-solar-chips"><span class="muted mono" style="font-size:12px">loading…</span></div>
          </div>

          <div class="card">
            <header class="card-head"><h3>How this works</h3></header>
            <div class="card-body mono muted" style="font-size:12px; line-height:1.6">
              <b>1.</b> Create a link, send the URL. Friend opens it, clicks Join.<br>
              <b>2.</b> One side picks TX, the other RX — anything you transmit from any mode tab travels as hi-fi Opus, straight browser-to-browser.<br>
              <b>3.</b> RX side sets Input to <b>🌐 Online link</b> (auto by default) and decodes with any module.<br>
              <b>4.</b> <b>Direct patch</b> = clean pipe. <b>Manual</b> = you pour in noise. <b>Full simulation</b> = both virtual rigs + live NOAA data decide — tune, add power, wait for grayline… chase that S9.<br>
              Swap TX/RX any time. QSY together — off-frequency means no copy, just like the real thing.
            </div>
          </div>

        </div>
      </div>`;

      /* ---------- gather refs ---------- */
      const q = (id) => el.querySelector("#" + id);
      const ui = this.ui = {
        el,
        roomTag: q("ol-room-tag"), url: q("ol-url"), copy: q("ol-copy"),
        create: q("ol-create"), code: q("ol-code"), join: q("ol-join"), hang: q("ol-hang"),
        dot: q("ol-dot"), state: q("ol-state"), presence: q("ol-peer-presence"), stats: q("ol-stats"),
        roleRx: q("ol-role-rx"), roleTx: q("ol-role-tx"),
        mon: q("ol-mon"), monVal: q("ol-mon-val"), route: q("ol-route"), autoroute: q("ol-autoroute"),
        peerline: q("ol-peerline"), chatLog: q("ol-chat-log"), chatIn: q("ol-chat-in"), chatSend: q("ol-chat-send"),
        condTag: q("ol-cond-tag"), cmDirect: q("ol-cm-direct"), cmManual: q("ol-cm-manual"), cmSim: q("ol-cm-sim"),
        preset: q("ol-preset"), filter: q("ol-filter"), selfmon: q("ol-selfmon"),
        manualRow: q("ol-manual-row"),
        snr: q("ol-snr"), snrVal: q("ol-snr-val"), qsbd: q("ol-qsbd"), qsbdVal: q("ol-qsbd-val"),
        qsbr: q("ol-qsbr"), qsbrVal: q("ol-qsbr-val"), flutter: q("ol-flutter"),
        qrn: q("ol-qrn"), qrnVal: q("ol-qrn-val"), hum: q("ol-hum"), humVal: q("ol-hum-val"), humBase: q("ol-hum-base"),
        condMeter: q("ol-cond-meter"),
        vfo: q("ol-vfo"), bands: q("ol-bands"), rigMode: q("ol-rig-mode"),
        pow: q("ol-pow"), powVal: q("ol-pow-val"), powBadge: q("ol-pow-badge"),
        ant: q("ol-ant"), antVal: q("ol-ant-val"), anth: q("ol-anth"), anthVal: q("ol-anth-val"),
        grid: q("ol-grid"),
        planbWrap: q("ol-planb-wrap"), planbLabel: q("ol-planb-label"), planbRow: q("ol-planb-row"),
        bGrid: q("ol-b-grid"), bPow: q("ol-b-pow"), bPowVal: q("ol-b-pow-val"),
        bAnt: q("ol-b-ant"), bAntVal: q("ol-b-ant-val"), bAnth: q("ol-b-anth"), bAnthVal: q("ol-b-anth-val"),
        path: q("ol-path"), notes: q("ol-notes"),
        solarTag: q("ol-solar-tag"), solarChips: q("ol-solar-chips"), solarFoot: q("ol-solar-foot"),
        smeter: q("ol-smeter"), sTag: q("ol-s-tag"), sRead: q("ol-s-read"), sSub: q("ol-s-sub")
      };

      /* resume the audio context on first interaction with the panel */
      el.addEventListener("pointerdown", () => { try { this._ensureAudio(); } catch (e) {} }, { once: true });

      /* ---------- link controls ---------- */
      ui.create.addEventListener("click", async () => {
        try {
          ui.create.disabled = true;
          this._ensureAudio();
          if (this.link.state !== "idle") await this.link.hangup("starting a fresh link");
          const room = await this.link.host();
          const base = location.origin + location.pathname;
          ui.url.value = `${base}?join=${room}`;
          ui.copy.disabled = false;
          this.ctx.log(`Link ${room} created — send the URL to your friend and leave this tab open.`);
        } catch (e) { this.ctx.log("Create failed: " + (e.message || e)); }
        finally { ui.create.disabled = false; this._refreshLinkUI(); }
      });
      ui.copy.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(ui.url.value); ui.copy.textContent = "Copied!"; }
        catch { ui.url.select(); document.execCommand("copy"); ui.copy.textContent = "Copied!"; }
        setTimeout(() => { ui.copy.textContent = "Copy"; }, 1400);
      });
      ui.join.addEventListener("click", () => this._joinFromInput());
      ui.code.addEventListener("keydown", (e) => { if (e.key === "Enter") this._joinFromInput(); });
      ui.hang.addEventListener("click", () => this.link.hangup("hung up"));

      const setRoleUI = () => {
        ui.roleRx.classList.toggle("btn-accent", this.role === "rx");
        ui.roleTx.classList.toggle("btn-accent", this.role === "tx");
      };
      const roleClick = (r) => {
        this._autoTx = false;              // manual choice wins over auto-follow
        this._setRole(r);
      };
      ui.roleRx.addEventListener("click", () => roleClick("rx"));
      ui.roleTx.addEventListener("click", () => roleClick("tx"));
      setRoleUI();

      ui.mon.addEventListener("input", () => {
        this._monBase = ui.mon.value / 100;
        ui.monVal.textContent = ui.mon.value + "%";
        this._updateMonGain();
      });
      ui.route.addEventListener("click", () => this._routeLinkToDecoders(false));
      ui.autoroute.checked = this.autoRoute;
      ui.autoroute.addEventListener("change", () => { this.autoRoute = ui.autoroute.checked; this._saveSoon(); });

      const sendChat = () => {
        const t = ui.chatIn.value.trim(); if (!t) return;
        if (this.link.send({ type: "chat", text: t })) {
          this._chatLine(this.ctx.settings().callsign || "me", t);
          ui.chatIn.value = "";
        } else this.ctx.log("Chat needs a connected link.");
      };
      ui.chatSend.addEventListener("click", sendChat);
      ui.chatIn.addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

      /* ---------- conditions controls ---------- */
      const setCondMode = (m) => {
        this.condMode = m;
        ui.cmDirect.classList.toggle("btn-accent", m === "direct");
        ui.cmManual.classList.toggle("btn-accent", m === "manual");
        ui.cmSim.classList.toggle("btn-accent", m === "sim");
        ui.condTag.textContent = m === "direct" ? "direct patch" : m === "manual" ? "manual conditions" : "full simulation";
        ui.manualRow.style.opacity = m === "manual" ? 1 : 0.45;
        if (this.sim) { this.sim.setMode(m); this._pushCondToSim(); }
        else if (m !== "direct") { this._ensureAudio(); }
        this._sendCond();
        this._saveSoon();
      };
      ui.cmDirect.addEventListener("click", () => setCondMode("direct"));
      ui.cmManual.addEventListener("click", () => setCondMode("manual"));
      ui.cmSim.addEventListener("click", () => setCondMode("sim"));

      const PRESETS = {
        clean:  { snr: 30, fadeDepth: 3,  fadeRate: 0.08, flutter: false, qrnPerMin: 1,  qrnLevel: 0.3, humLevel: 0 },
        summer: { snr: 14, fadeDepth: 8,  fadeRate: 0.15, flutter: false, qrnPerMin: 40, qrnLevel: 0.8, humLevel: 0 },
        qsb:    { snr: 16, fadeDepth: 22, fadeRate: 0.07, flutter: false, qrnPerMin: 3,  qrnLevel: 0.4, humLevel: 0 },
        storm:  { snr: 8,  fadeDepth: 14, fadeRate: 0.5,  flutter: true,  qrnPerMin: 10, qrnLevel: 0.5, humLevel: 0 },
        pileup: { snr: 10, fadeDepth: 5,  fadeRate: 0.2,  flutter: false, qrnPerMin: 15, qrnLevel: 0.6, humLevel: 0.5 },
        brutal: { snr: -4, fadeDepth: 18, fadeRate: 0.25, flutter: true,  qrnPerMin: 30, qrnLevel: 0.9, humLevel: 0.2 }
      };
      ui.preset.addEventListener("change", () => {
        const p = PRESETS[ui.preset.value]; if (!p) return;
        Object.assign(this.cond, p);
        this._condToInputs();
        if (this.condMode === "direct") setCondMode("manual");
        this._pushCondToSim(); this._sendCond(); this._saveSoon();
      });

      const condInput = () => {
        this.cond.snr = parseInt(ui.snr.value, 10);
        this.cond.fadeDepth = parseInt(ui.qsbd.value, 10);
        this.cond.fadeRate = parseInt(ui.qsbr.value, 10) / 100;
        this.cond.flutter = ui.flutter.checked;
        this.cond.qrnPerMin = parseInt(ui.qrn.value, 10);
        this.cond.qrnLevel = Math.max(0.25, Math.min(1, parseInt(ui.qrn.value, 10) / 60 + 0.3));
        this.cond.humLevel = parseInt(ui.hum.value, 10) / 100;
        this.cond.humBase = parseInt(ui.humBase.value, 10);
        this._condLabels();
        this._pushCondToSim(); this._sendCond(); this._saveSoon();
      };
      for (const c of [ui.snr, ui.qsbd, ui.qsbr, ui.qrn, ui.hum]) c.addEventListener("input", condInput);
      ui.flutter.addEventListener("change", condInput);
      ui.humBase.addEventListener("change", condInput);
      ui.filter.value = this.cond.filter || "DIG";
      ui.filter.addEventListener("change", () => {
        this.cond.filter = ui.filter.value;
        this._pushCondToSim(); this._saveSoon();
      });
      ui.selfmon.addEventListener("change", () => {
        this._ensureAudio();
        this.sim.setMonitor(ui.selfmon.checked);
      });

      /* ---------- virtual rig controls ---------- */
      this._buildBands();
      this._renderVFO();
      ui.rigMode.value = this.rig.mode;
      ui.rigMode.addEventListener("change", () => { this.rig.mode = ui.rigMode.value; this._rigChanged(); });
      ui.pow.value = this._wToSlider(this.rig.powW);
      ui.pow.addEventListener("input", () => { this.rig.powW = this._sliderToW(ui.pow.value); this._rigChanged(); });
      ui.ant.value = Math.round(this.rig.antDbi * 10);
      ui.ant.addEventListener("input", () => { this.rig.antDbi = parseInt(ui.ant.value, 10) / 10; this._rigChanged(); });
      ui.anth.value = this.rig.antH;
      ui.anth.addEventListener("input", () => { this.rig.antH = parseInt(ui.anth.value, 10); this._rigChanged(); });
      ui.grid.value = this.rig.grid || "";
      ui.grid.addEventListener("change", () => { this.rig.grid = ui.grid.value.trim(); this._rigChanged(); });

      ui.bGrid.value = this.planB.grid || "";
      ui.bGrid.addEventListener("change", () => { this.planB.grid = ui.bGrid.value.trim(); this._saveSoon(); this._refreshPathUI(); });
      ui.bPow.value = this._wToSlider(this.planB.powW);
      ui.bPow.addEventListener("input", () => { this.planB.powW = this._sliderToW(ui.bPow.value); this._planBLabels(); this._saveSoon(); this._refreshPathUI(); });
      ui.bAnt.value = Math.round(this.planB.antDbi * 10);
      ui.bAnt.addEventListener("input", () => { this.planB.antDbi = parseInt(ui.bAnt.value, 10) / 10; this._planBLabels(); this._saveSoon(); this._refreshPathUI(); });
      ui.bAnth.value = this.planB.antH;
      ui.bAnth.addEventListener("input", () => { this.planB.antH = parseInt(ui.bAnth.value, 10); this._planBLabels(); this._saveSoon(); this._refreshPathUI(); });

      /* ---------- initial paint ---------- */
      this._condToInputs();
      setCondMode(this.condMode);
      this._rigLabels(); this._planBLabels();
      this._refreshLinkUI(); this._refreshRigUI(); this._refreshPathUI(); this._refreshCondUI();
    },

    onActivate() {
      /* a ?join=CODE deep link lands here */
      const p = new URLSearchParams(location.search);
      let code = p.get("join") || (location.hash.match(/join=([A-Za-z0-9]+)/) || [])[1];
      if (code) {
        history.replaceState(null, "", location.pathname);   // don't rejoin a stale room on refresh
        if (this.ui) { this.ui.code.value = code.toUpperCase(); }
        this._pendingJoin = code.toUpperCase();
        setTimeout(() => { if (this._pendingJoin) this._joinFromInput(this._pendingJoin); }, 400);
      }
      const t1 = setInterval(() => { this._refreshCondUI(); this._refreshStats(); }, 400);
      const t2 = setInterval(() => this._calcTick(), 1000);
      this._uiTimers = [t1, t2];
      this._calcTick();
    },

    onDeactivate() {
      this._uiTimers.forEach(clearInterval);
      this._uiTimers = [];
      this.ui = null;
      if (this.link.state !== "idle") this.link.hangup("module tab closed");
      /* the simulator + loopback stay alive so the 🧪 input keeps working */
    },

    /* -------------- join helper -------------- */
    async _joinFromInput(codeArg) {
      const ui = this.ui;
      let raw = codeArg || (ui ? ui.code.value.trim() : "");
      this._pendingJoin = null;
      if (!raw) return;
      const m = raw.match(/join=([A-Za-z0-9]+)/);
      const code = (m ? m[1] : raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!code) return;
      try {
        this._ensureAudio();
        if (this.link.state !== "idle") await this.link.hangup("joining a different link");
        if (ui) ui.join.disabled = true;
        await this.link.join(code);
        this.ctx.log(`Joined link ${code} — waiting for the host's offer…`);
      } catch (e) { this.ctx.log("Join failed: " + (e.message || e)); }
      finally { if (ui) ui.join.disabled = false; this._refreshLinkUI(); }
    },

    /* -------------- rig UI internals -------------- */
    _wToSlider(w) { return Math.round(clamp((Math.log10(clamp(w, 0.001, 1e7)) + 3) / 10, 0, 1) * 1000); },
    _sliderToW(v) { return Math.pow(10, (v / 1000) * 10 - 3); },

    _buildBands() {
      const ui = this.ui;
      ui.bands.innerHTML = "";
      for (const b of OL_BANDS) {
        const btn = document.createElement("button");
        btn.className = "btn btn-mini";
        btn.textContent = b.id;
        btn.title = `${b.lo}–${b.hi} MHz`;
        btn.dataset.band = b.id;
        btn.addEventListener("click", () => { this.rig.fHz = Math.round(b.def * 1e6); this._rigChanged(); });
        ui.bands.appendChild(btn);
      }
    },
    _renderVFO() {
      const ui = this.ui; if (!ui) return;
      const f = clamp(this.rig.fHz, 30000, 1300e6);
      this.rig.fHz = f;
      const txt = fmtHz(f);                       // "14.074.00"
      const places = [];
      const mhzDigits = txt.split(".")[0].length;
      for (let i = 0; i < mhzDigits; i++) places.push(Math.pow(10, 6 + mhzDigits - 1 - i));
      places.push(null, 1e5, 1e4, 1e3, null, 1e2, 1e1);
      let html = "", pi = 0, seenNonZero = false;
      for (const ch of txt) {
        if (ch === ".") { html += `<span class="d dim">.</span>`; pi++; continue; }
        const place = places[pi++];
        if (ch !== "0") seenNonZero = true;
        const dim = !seenNonZero && place >= 1e6 && ch === "0";
        html += `<span class="d${dim ? " dim" : ""}" data-place="${place}">${ch}</span>`;
      }
      html += `<span class="u">MHz</span>`;
      const band = olBandOf(f / 1e6);
      if (!band) html += `<span class="ol-oob">OUT OF BAND</span>`;
      ui.vfo.innerHTML = html;
      ui.vfo.querySelectorAll(".d[data-place]").forEach(d => {
        d.addEventListener("wheel", (e) => {
          e.preventDefault();
          const step = parseFloat(d.dataset.place);
          this.rig.fHz = clamp(this.rig.fHz + (e.deltaY < 0 ? step : -step), 30000, 1300e6);
          this._rigChanged();
        }, { passive: false });
      });
      ui.bands.querySelectorAll(".btn").forEach(b =>
        b.classList.toggle("btn-accent", band && b.dataset.band === band.id));
    },
    _rigLabels() {
      const ui = this.ui; if (!ui) return;
      ui.powVal.textContent = fmtW(this.rig.powW);
      const w = this.rig.powW;
      const badge = ui.powBadge;
      if (w <= 5) { badge.textContent = "QRP"; badge.className = "ol-badge qrp"; }
      else if (w <= 1500) { badge.textContent = w <= 150 ? "barefoot" : "legal limit"; badge.className = "ol-badge legal"; }
      else { badge.textContent = "FANTASY 🔥"; badge.className = "ol-badge fantasy"; }
      ui.antVal.textContent = this.rig.antDbi.toFixed(1) + " dBi";
      ui.anthVal.textContent = this.rig.antH + " m";
    },
    _planBLabels() {
      const ui = this.ui; if (!ui) return;
      ui.bPowVal.textContent = fmtW(this.planB.powW);
      ui.bAntVal.textContent = this.planB.antDbi.toFixed(1) + " dBi";
      ui.bAnthVal.textContent = this.planB.antH + " m";
    },
    _rigChanged() {
      this._renderVFO();
      this._rigLabels();
      this._sendRig();
      this._saveSoon();
      this._refreshPathUI();
    },

    _condToInputs() {
      const ui = this.ui, c = this.cond; if (!ui) return;
      ui.snr.value = c.snr; ui.qsbd.value = c.fadeDepth; ui.qsbr.value = Math.round(c.fadeRate * 100);
      ui.flutter.checked = !!c.flutter; ui.qrn.value = c.qrnPerMin;
      ui.hum.value = Math.round(c.humLevel * 100); ui.humBase.value = String(c.humBase);
      this._condLabels();
    },
    _condLabels() {
      const ui = this.ui, c = this.cond; if (!ui) return;
      ui.snrVal.textContent = c.snr + " dB";
      ui.qsbdVal.textContent = c.fadeDepth + " dB";
      ui.qsbrVal.textContent = c.fadeRate.toFixed(2) + " Hz";
      ui.qrnVal.textContent = String(c.qrnPerMin);
      ui.humVal.textContent = c.humLevel > 0 ? Math.round(c.humLevel * 100) + "%" : "off";
    },
    _pushCondToSim() {
      if (!this.sim) return;
      const f = OL_MODES[this.cond.filter] || OL_MODES.DIG;
      this.sim.setFilter(f.hp, f.lp);
      if (this.condMode === "manual") {
        this.sim.setSNR(this.cond.snr);
        this.sim.setFade(this.cond.fadeDepth, this.cond.fadeRate, this.cond.flutter);
        this.sim.setQRN(this.cond.qrnPerMin, this.cond.qrnLevel);
        this.sim.setHum(this.cond.humLevel, this.cond.humBase);
      }
      /* sim mode gets its numbers from _calcTick */
    },

    /* -------------- the once-a-second brain -------------- */
    _calcTick() {
      const tx = this._myRigResolved();
      const rx = this._rxRigResolved();
      if (this.role === "rx" && this.peerRig) {
        // when I'm listening, the interesting direction is friend → me
        this.lastCalc = olComputeLink(rx, tx, this.solar, Date.now());
      } else {
        this.lastCalc = olComputeLink(tx, rx, this.solar, Date.now());
      }
      const res = this.lastCalc;

      if (this.condMode === "sim" && this.sim && res && res.ok && res.state !== "nolocation") {
        const snr = clamp(res.snrDb, -40, 45);
        this.sim.setSNR(snr);
        const kp = this.solar.kp || 2;
        const hops = res.nHops || 0;
        const depth = clamp(3 + kp * 1.3 + hops * 1.2 + (res.muf && res.f / res.muf > 0.85 ? 6 : 0), 2, 26);
        this.sim.setFade(depth, 0.06 + kp * 0.02, kp >= 5 || res.mech === "sporadic-E!");
        const band = res.band;
        const qrnTable = { "160m": 22, "80m": 16, "40m": 9, "30m": 6, "20m": 4, "17m": 3, "15m": 3, "12m": 2, "10m": 2 };
        this.sim.setQRN(qrnTable[band] ?? 1, 0.6);
        const modeF = OL_MODES[this.rig.mode] || OL_MODES.DIG;
        this.sim.setFilter(modeF.hp, modeF.lp);
      }

      if (this.link.state === "connected" && this.role === "tx" && this.condMode === "sim" && res && res.ok) {
        this.link.send({ type: "calc", res: {
          state: res.state, snrDb: res.snrDb, sm: res.sm, dKm: res.dKm, mech: res.mech,
          lossDb: res.lossDb, prxDbm: res.prxDbm, f: res.f } });
      }
      this._refreshPathUI();
    },

    /* -------------- UI refreshers -------------- */
    _refreshLinkUI() {
      const ui = this.ui; if (!ui) return;
      const s = this.link.state;
      ui.roomTag.textContent = this.link.room ? `link ${this.link.room} · you are ${this.link.peer === "a" ? "host" : "guest"}` : "no link";
      ui.dot.className = "ol-dot" + (s === "connected" ? " on" : (s === "idle" ? "" : " wait"));
      ui.state.textContent = ({
        idle: "idle — create or join a link",
        hosting: "waiting for your friend to open the URL…",
        joining: "joining…",
        connecting: "negotiating the audio path…",
        connected: "CONNECTED — audio is flowing peer-to-peer"
      })[s] || s;
      ui.hang.disabled = s === "idle";
      if (s === "idle") { ui.url.value = ""; ui.copy.disabled = true; }
      const pi = this.peerInfo;
      let pl;
      if (s !== "connected") pl = "Nobody on the other end yet.";
      else {
        pl = `Friend: <em>${esc(pi?.call || "unknown")}</em>${pi?.grid ? " · " + esc(pi.grid) : ""}`;
        pl += this.peerRole ? ` · they are <em>${this.peerRole.toUpperCase()}</em>` : "";
        if (this.peerRole === "tx" && this.role === "tx") pl += ` · <span style="color:#ff7d7d">⚠ you're BOTH transmitting</span>`;
        if (this.peerRole === "rx" && this.role === "rx") pl += ` · <span class="muted">…and you're both listening. Somebody key up!</span>`;
      }
      ui.peerline.innerHTML = pl;
      this._applyGates();
    },
    _refreshStats() {
      const ui = this.ui; if (!ui) return;
      const st = this.link.stats;
      ui.stats.textContent = this.link.state === "connected"
        ? `↑ ${fmtBits(st.up)} · ↓ ${fmtBits(st.down)}${st.rtt != null ? " · " + Math.round(st.rtt) + " ms RTT" : ""}`
        : "";
      const pres = this.link.peers || {};
      if (this.link.state === "hosting")
        ui.presence.textContent = pres.b == null ? "" : "guest last seen " + pres.b + "s ago";
      else ui.presence.textContent = "";
    },
    _refreshRigUI() {
      const ui = this.ui; if (!ui) return;
      if (this.peerRig) {
        const p = this.peerRig;
        ui.planbLabel.innerHTML = `Friend's rig (live): <em>${fmtHz(p.fHz)} MHz</em> · ${esc(p.mode || "?")} · ${fmtW(p.powW || 0)} · ${(p.antDbi || 0).toFixed(1)} dBi @ ${p.antH || "?"} m · ${esc(p.grid || "no grid!")}`;
        ui.planbRow.style.display = "none";
      } else {
        ui.planbLabel.innerHTML = `No friend connected — plan a path against a fictional <em>Station B</em>:`;
        ui.planbRow.style.display = "";
      }
      this._refreshPathUI();
    },
    _refreshCondUI() {
      const ui = this.ui; if (!ui) return;
      if (this.sim) {
        const m = this.sim.meter;
        if (this.condMode === "direct") ui.condMeter.textContent = `direct patch · TX level ${m.inDb > -100 ? m.inDb.toFixed(0) + " dBFS" : "silent"}`;
        else ui.condMeter.textContent =
          `applied SNR ${m.snr.toFixed(1)} dB · signal ${m.sigDb.toFixed(0)} dBFS · noise ${m.noiseDb.toFixed(0)} dBFS` +
          (this.peerCond && this.peerCond.mode && this.link.state === "connected" ? ` · friend's channel: ${this.peerCond.mode}` : "");
      } else ui.condMeter.textContent = "simulator wakes up on first use";
      this._drawSMeter();
    },
    _refreshPathUI() {
      const ui = this.ui; if (!ui) return;
      /* solar chips */
      const s = this.solar;
      ui.solarTag.textContent = `solar: ${s.src}`;
      ui.solarChips.innerHTML =
        `<span class="ol-chip">SFI <em>${Math.round(s.sfi)}</em></span>` +
        `<span class="ol-chip">Kp <em>${(+s.kp).toFixed(1)}</em></span>` +
        (s.xray ? `<span class="ol-chip">X-ray <em>${esc(s.xray)}</em></span>` : "") +
        `<span class="ol-chip">${new Date().toISOString().slice(11, 16)}z</span>`;

      const res = (this.role === "rx" && this.peerRole === "tx" && this.peerCalc && this.link.state === "connected" && this.condMode === "sim")
        ? Object.assign({ notes: [], ok: true, fromPeer: true }, this.peerCalc)
        : this.lastCalc;
      if (!res) return;

      if (!res.ok || res.state === "nolocation") {
        ui.path.innerHTML = "";
        ui.notes.innerHTML = `<div>${esc(res.notes ? res.notes[0] : "Set both locations to compute the path.")}</div>`;
        this._drawSMeter();
        return;
      }
      const cells = [
        [fmtKm(res.dKm), "distance"],
        [Math.round(res.brg || 0) + "°", "bearing"],
        [res.lossDb != null ? Math.round(res.lossDb) + " dB" : "—", "path loss"],
        [res.prxDbm != null ? res.prxDbm.toFixed(0) + " dBm" : "—", "rx power"],
        [(res.snrDb != null ? res.snrDb.toFixed(0) : "—") + " dB", "snr"],
        [esc(res.mech || "—"), "mechanism"]
      ];
      if (res.muf) cells.push([res.muf.toFixed(1) + " MHz", "path MUF"]);
      if (res.foF2) cells.push([res.foF2.toFixed(1) + " MHz", "foF2 (midpoint)"]);
      ui.path.innerHTML = cells.map(c => `<div class="ol-cell"><b>${c[0]}</b><span>${c[1]}</span></div>`).join("");
      ui.notes.innerHTML = (res.notes || []).map(n => `<div>${esc(n)}</div>`).join("") +
        (res.fromPeer ? `<div class="muted">numbers computed by the TX side and mirrored here</div>` : "");
      this._drawSMeter();
    },

    _drawSMeter() {
      const ui = this.ui; if (!ui) return;
      const cv = ui.smeter, c = cv.getContext("2d");
      const W = cv.width, H = cv.height;
      c.clearRect(0, 0, W, H);

      let sVal = 0, text = "—", sub = "";
      const usingSim = this.condMode === "sim";
      const res = (this.role === "rx" && this.peerCalc && this.link.state === "connected" && usingSim) ?
        Object.assign({ sm: this.peerCalc.sm, snrDb: this.peerCalc.snrDb, state: this.peerCalc.state }, {}) : this.lastCalc;
      if (usingSim && res && res.sm) {
        sVal = clamp(res.sm.sVal, 0, 19);
        text = res.sm.text;
        sub = `SNR ${res.snrDb != null ? res.snrDb.toFixed(0) : "—"} dB · ${res.state || ""}`;
        const simIsLive = this.sim && this.sim.mode !== "direct" &&
          (this.role === "tx" || this.link.state !== "connected");
        if (simIsLive) sVal = clamp(sVal + (this.sim.meter.snr - (res.snrDb ?? 0)) / 6, 0, 19);
      } else if (this.condMode === "manual" && this.sim) {
        const snr = this.sim.meter.snr;
        sVal = clamp(4 + snr / 6, 0, 19);
        text = "manual channel";
        sub = `live SNR ${snr.toFixed(0)} dB in the ${((OL_MODES[this.cond.filter] || OL_MODES.DIG).label)}`;
      } else {
        sVal = this.link.state === "connected" ? 19 : 0;
        text = this.link.state === "connected" ? "direct patch" : "no signal";
        sub = this.link.state === "connected" ? "internet-clean — no simulated channel" : "";
      }

      const segs = 15, gap = 3;
      const segW = (W - gap * (segs - 1)) / segs;
      for (let i = 0; i < segs; i++) {
        const lit = sVal >= (i + 1) * (19 / segs) - 0.4;
        const isRed = i >= 9;
        c.fillStyle = lit ? (isRed ? "#ff5d5d" : "#ffb454") : "rgba(255,255,255,0.06)";
        c.fillRect(i * (segW + gap), 6, segW, H - 20);
        if (lit) { c.fillStyle = isRed ? "rgba(255,93,93,.35)" : "rgba(255,180,84,.35)"; c.fillRect(i * (segW + gap), 4, segW, 2); }
      }
      c.fillStyle = "rgba(139,149,167,0.85)";
      c.font = "9px 'IBM Plex Mono', monospace";
      const marks = ["1", "3", "5", "7", "9", "+20", "+40", "+60"];
      const at = [0, 2, 4, 6, 8, 10, 12, 14];
      marks.forEach((m, i) => c.fillText(m, at[i] * (segW + gap) + 1, H - 3));
      ui.sRead.textContent = text;
      ui.sSub.textContent = sub;
      ui.sTag.textContent = usingSim ? "simulated path" : (this.condMode === "manual" ? "manual channel" : "direct");
    }
  };

  HRWS.registerModule(def);
})();
