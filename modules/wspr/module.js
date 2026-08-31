/* ============================================================
   Ham Radio Web Studio — WSPR transmitter
   K1JT's Weak Signal Propagation Reporter: your callsign, grid
   and power packed into 50 bits, armored by a K=32 rate-1/2
   convolutional code, and whispered as 4-FSK tones 1.46 Hz
   apart for 110.6 seconds — decodable 28 dB below the noise.
   Transmissions begin one second into an even UTC minute; the
   world's WSPR receivers do the rest and wsprnet.org draws the
   map of where your watt went.
   ============================================================ */
"use strict";
(function () {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  /* WSPRDSP-BEGIN */
  const SYNC = [1,1,0,0,0,0,0,0,1,0,0,0,1,1,1,0,0,0,1,0,0,1,0,1,1,1,1,0,0,0,0,0,
    0,0,1,0,0,1,0,1,0,0,0,0,0,0,1,0,1,1,0,0,1,1,0,1,0,0,0,1,1,0,1,0,0,0,0,1,1,0,
    1,0,1,0,1,0,1,0,0,1,0,0,1,0,1,1,0,0,0,1,1,0,1,0,1,0,0,0,1,0,0,0,0,0,1,0,0,1,
    0,0,1,1,1,0,1,1,0,0,1,1,0,1,0,0,0,1,1,1,0,0,0,0,0,1,0,1,0,0,1,1,0,0,0,0,0,0,
    0,1,1,0,1,0,1,1,0,0,0,1,1,0,0,0];
  const cval = (c) => c === " " ? 36 : (c >= "0" && c <= "9" ? c.charCodeAt(0) - 48 : c.charCodeAt(0) - 55);
  const lval = (c) => c === " " ? 26 : c.charCodeAt(0) - 65;
  function packCall(call) {
    call = call.toUpperCase().trim();
    if (!/[0-9]/.test(call[2] || "")) call = " " + call;     // 3rd char must be the digit
    call = (call + "      ").slice(0, 6);
    let n = cval(call[0]);
    n = n * 36 + cval(call[1]);
    n = n * 10 + (call.charCodeAt(2) - 48);
    n = n * 27 + lval(call[3]);
    n = n * 27 + lval(call[4]);
    n = n * 27 + lval(call[5]);
    return n;                                                 // < 2^28
  }
  function packGridPwr(grid, dbm) {
    grid = (grid.toUpperCase() + "AA00").slice(0, 4);
    const ng = (179 - 10 * (grid.charCodeAt(0) - 65) - (grid.charCodeAt(2) - 48)) * 180 +
               10 * (grid.charCodeAt(1) - 65) + (grid.charCodeAt(3) - 48);
    return ng * 128 + clamp(dbm, 0, 60) + 64;                 // 22 bits
  }
  const par = (x) => { x ^= x >>> 16; x ^= x >>> 8; x ^= x >>> 4; x ^= x >>> 2; x ^= x >>> 1; return x & 1; };
  function wsprSymbols(call, grid, dbm) {
    const N = packCall(call), M = packGridPwr(grid, dbm);
    const bits = new Uint8Array(81);                          // 50 data + 31 zero tail
    for (let i = 0; i < 28; i++) bits[i] = (N >>> (27 - i)) & 1;
    for (let i = 0; i < 22; i++) bits[28 + i] = (M >>> (21 - i)) & 1;
    let reg = 0;
    const conv = new Uint8Array(162);
    for (let i = 0; i < 81; i++) {
      reg = ((reg << 1) | bits[i]) >>> 0;
      conv[2 * i]     = par((reg & 0xF2D05351) >>> 0);
      conv[2 * i + 1] = par((reg & 0xE4613C47) >>> 0);
    }
    const inter = new Uint8Array(162);
    let i2 = 0;
    for (let k = 0; k < 256 && i2 < 162; k++) {
      let r = 0;
      for (let b = 0; b < 8; b++) if (k & (1 << b)) r |= 128 >> b;
      if (r < 162) inter[r] = conv[i2++];
    }
    const sym = new Uint8Array(162);
    for (let n = 0; n < 162; n++) sym[n] = SYNC[n] + 2 * inter[n];
    return sym;
  }
  function wsprRender(sym, f0) {                              // native 12000 Hz
    const fs = 12000, spS = 8192, dHz = fs / spS;             // 1.46484375 Hz
    const y = new Float32Array(162 * spS);
    let ph = 0;
    for (let s = 0; s < 162; s++) {
      const f = f0 + (sym[s] - 1.5) * dHz;
      const w = 2 * Math.PI * f / fs;
      for (let i = 0; i < spS; i++) { ph += w; y[s * spS + i] = 0.8 * Math.sin(ph); }
    }
    const edge = 240;                                          // 20 ms ends
    for (let i = 0; i < edge; i++) {
      const r = 0.5 - 0.5 * Math.cos(Math.PI * i / edge);
      y[i] *= r; y[y.length - 1 - i] *= r;
    }
    return y;
  }
  /* WSPRDSP-END */
  function wav16(y, rate) {
    const n = y.length, dv = new DataView(new ArrayBuffer(44 + n * 2));
    const ws = (p, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(p + i, s.charCodeAt(i)); };
    ws(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); ws(8, "WAVE"); ws(12, "fmt ");
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true);
    dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); ws(36, "data");
    dv.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.round(clamp(y[i], -1, 1) * 32767), true);
    return dv.buffer;
  }
  const PWRS = [0, 3, 7, 10, 13, 17, 20, 23, 27, 30, 33, 37, 40, 43, 47, 50, 53, 57, 60];
  const def = {
    id: "wspr",
    init(ctx) {
      this.ctx = ctx; this.ui = null; this.armed = false; this.lastSlot = -1;
      this.timer = setInterval(() => this._tick(), 250);
      ctx.log("WSPR ready — 110.6 seconds of whisper, timed to the even minute.");
    },
    _tick() {
      const now = new Date();
      if (this.ui) {
        const s = 120 - ((now.getUTCMinutes() % 2) * 60 + now.getUTCSeconds());
        this.ui.next.textContent = this.armed ? `next window in ${s % 120}s` : "disarmed";
      }
      if (!this.armed) return;
      const slot = Math.floor(now.getTime() / 120000);
      if (now.getUTCMinutes() % 2 === 0 && now.getUTCSeconds() === 1 && slot !== this.lastSlot) {
        const every = parseInt(this.ui.every.value, 10);
        if (slot % every === 0) { this.lastSlot = slot; this._fire(); }
      }
    },
    _msg() {
      const s = this.ctx.settings();
      return { call: (this.ui && this.ui.call.value || s.callsign || "N0CALL").toUpperCase(),
               grid: (this.ui && this.ui.grid.value || s.grid || "AA00").toUpperCase().slice(0, 4),
               dbm: parseInt(this.ui ? this.ui.pwr.value : 37, 10),
               f0: clamp(parseInt(this.ui ? this.ui.f0.value : 1500, 10) || 1500, 1400, 1600) };
    },
    async _fire() {
      const m = this._msg();
      const y = wsprRender(wsprSymbols(m.call, m.grid, m.dbm), m.f0);
      this.ctx.log(`WSPR firing: ${m.call} ${m.grid} ${m.dbm} dBm at ${m.f0} Hz (110.6 s).`);
      if (this.ui) this.ui.tag.textContent = "TRANSMITTING";
      await this.ctx.audio.playPCM(y, 12000);
      if (this.ui) this.ui.tag.textContent = this.armed ? "armed" : "idle";
    },
    createPanel(el) {
      const s = this.ctx.settings();
      el.innerHTML = `
      <div class="mod-layout"><div class="mod-main"><div class="card">
        <header class="card-head"><h3>WSPR beacon</h3><span class="card-tag mono" id="ws-tag">idle</span></header>
        <div class="card-body">
          <div class="mod-controls">
            <label class="field"><span>Callsign</span><input type="text" id="ws-call" class="mono" maxlength="6" value="${(s.callsign || "N0CALL").toUpperCase()}" style="width:90px"></label>
            <label class="field"><span>Grid</span><input type="text" id="ws-grid" class="mono" maxlength="4" value="${(s.grid || "FN03").toUpperCase().slice(0, 4)}" style="width:70px"></label>
            <label class="field"><span>Power</span><select id="ws-pwr">${PWRS.map(p => `<option${p === 37 ? " selected" : ""}>${p}</option>`).join("")}</select><span class="mono muted" style="font-size:11px">dBm</span></label>
            <label class="field"><span>Audio (Hz)</span><input type="number" id="ws-f0" value="1500" min="1400" max="1600" step="1" style="width:80px"></label>
            <label class="field"><span>Every</span><select id="ws-every"><option value="1">slot (2 min)</option><option value="2" selected>2nd slot</option><option value="5">5th slot</option></select></label>
          </div>
          <div class="mod-controls" style="margin-top:8px">
            <label class="field"><span>&nbsp;</span><button class="btn btn-accent" id="ws-arm">Arm beacon</button></label>
            <label class="field"><span>&nbsp;</span><button class="btn" id="ws-now">Send now (untimed)</button></label>
            <label class="field"><span>&nbsp;</span><button class="btn btn-danger" id="ws-stop">Stop</button></label>
            <label class="field"><span>&nbsp;</span><button class="btn" id="ws-wav">Save WAV</button></label>
          </div>
          <div class="mono muted" id="ws-info" style="font-size:12px;margin-top:8px"></div>
          <div class="mono" id="ws-next" style="font-size:12px;color:var(--amber,#ffb454)">disarmed</div>
          <footer class="card-foot mono muted">Armed, it fires 1 s into the chosen even UTC minutes — set your rig VOX or key it for 111 s. Dial standards: 7.0386, 10.1387, 14.0956 MHz USB (audio 1400–1600). Watch yourself surface on wsprnet.org; WSJT-X decoding this audio is the definitive check.</footer>
        </div></div></div></div>`;
      const q = (id) => el.querySelector("#" + id);
      const ui = this.ui = { tag: q("ws-tag"), call: q("ws-call"), grid: q("ws-grid"),
        pwr: q("ws-pwr"), f0: q("ws-f0"), every: q("ws-every"), arm: q("ws-arm"),
        now: q("ws-now"), stop: q("ws-stop"), wav: q("ws-wav"), info: q("ws-info"), next: q("ws-next") };
      const info = () => {
        const m = this._msg();
        try {
          const sym = wsprSymbols(m.call, m.grid, m.dbm);
          ui.info.textContent = `${m.call} ${m.grid} ${m.dbm} dBm → 50 bits → 162 symbols · ` +
            `4-FSK ±2.9 Hz around ${m.f0} Hz · 110.6 s`;
          return sym;
        } catch (e) { ui.info.textContent = "message error: " + e.message; return null; }
      };
      ["ws-call", "ws-grid", "ws-pwr", "ws-f0"].forEach(id => q(id).addEventListener("input", info));
      info();
      ui.arm.addEventListener("click", () => {
        this.armed = !this.armed;
        ui.arm.textContent = this.armed ? "Disarm" : "Arm beacon";
        ui.arm.classList.toggle("btn-accent", !this.armed);
        ui.tag.textContent = this.armed ? "armed" : "idle";
      });
      ui.now.addEventListener("click", () => this._fire());
      ui.stop.addEventListener("click", () => { this.ctx.audio.stopTX();
        ui.tag.textContent = this.armed ? "armed" : "idle"; });
      ui.wav.addEventListener("click", () => {
        const m = this._msg();
        const y = wsprRender(wsprSymbols(m.call, m.grid, m.dbm), m.f0);
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([wav16(y, 12000)], { type: "audio/wav" }));
        a.download = `wspr_${m.call}_${m.grid}_${m.dbm}dBm.wav`; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      });
    },
    onActivate() {}, onDeactivate() { this.armed = false; this.ui = null; }
  };
  HRWS.registerModule(def);
})();
