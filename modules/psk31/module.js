/* ============================================================
   Ham Radio Web Studio — PSK31 module
   G3PLX varicode over 31.25 baud BPSK.
   TX: cosine-shaped reversals (narrowband, neighbours stay happy)
   RX (experimental): quadrature mixer → envelope-dip bit sync →
   differential phase detector → varicode. Works nicely on a
   loopback or a clean signal; weak-signal hardening is on the
   roadmap.
   ============================================================ */
"use strict";

(function () {

  /* G3PLX varicode: no code contains "00"; "00" separates characters. */
  const VARICODE = {
    "\n": "11101", "\r": "11111",
    " ": "1", "!": "111111111", "\"": "101011111", "#": "111110101", "$": "111011011",
    "%": "1011010101", "&": "1010111011", "'": "101111111", "(": "11111011", ")": "11110111",
    "*": "101101111", "+": "111011111", ",": "1110101", "-": "110101", ".": "1010111",
    "/": "110101111", "0": "10110111", "1": "10111101", "2": "11101101", "3": "11111111",
    "4": "101110111", "5": "101011011", "6": "101101011", "7": "110101101", "8": "110101011",
    "9": "110110111", ":": "11110101", ";": "110111101", "<": "111101101", "=": "1010101",
    ">": "111010111", "?": "1010101111", "@": "1010111101",
    "A": "1111101", "B": "11101011", "C": "10101101", "D": "10110101", "E": "1110111",
    "F": "11011011", "G": "11111101", "H": "101010101", "I": "1111111", "J": "111111101",
    "K": "101111101", "L": "11010111", "M": "10111011", "N": "11011101", "O": "10101011",
    "P": "11010101", "Q": "111011101", "R": "10101111", "S": "1101111", "T": "1101101",
    "U": "101010111", "V": "110110101", "W": "101011101", "X": "101110101", "Y": "101111011",
    "Z": "1010101101", "[": "111110111", "\\": "111101111", "]": "111111011", "^": "1010111111",
    "_": "101101101", "`": "1011011111",
    "a": "1011", "b": "1011111", "c": "101111", "d": "101101", "e": "11",
    "f": "111101", "g": "1011011", "h": "101011", "i": "1101", "j": "111101011",
    "k": "10111111", "l": "11011", "m": "111011", "n": "1111", "o": "111",
    "p": "111111", "q": "110111111", "r": "10101", "s": "10111", "t": "101",
    "u": "110111", "v": "1111011", "w": "1101011", "x": "11011111", "y": "1011101",
    "z": "111010101", "{": "1010110111", "|": "110111011", "}": "1010110101", "~": "1011010111"
  };
  const REVERSE = {};
  for (const [ch, code] of Object.entries(VARICODE)) REVERSE[code] = ch;

  const BAUD = 31.25;

  const def = {
    id: "psk31",

    init(ctx) {
      this.ctx = ctx;
      this.freq = 1000;
      this.decoding = false;
      this.unsub = null;
    },

    createPanel(el) {
      el.innerHTML = `
        <div class="mod-layout">
          <div class="mod-main">
            <div class="card">
              <header class="card-head"><h3>Receive <span class="beta-flag">experimental</span></h3>
                <span class="card-tag mono" id="psk-stat">decoder off</span></header>
              <div class="rx-screen" id="psk-rx"></div>
              <div class="card-foot mod-controls">
                <button class="btn btn-accent" id="psk-toggle">Start decoder</button>
                <label class="field"><span>Center <em id="psk-freq-val">1000 Hz</em></span>
                  <input type="range" id="psk-freq" min="400" max="2600" value="1000" step="5"></label>
                <button class="btn btn-mini" id="psk-clear">Clear</button>
                <span class="mod-status" id="psk-meta"></span>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>Transmit</h3></header>
              <div class="card-foot" style="border-top:none">
                <textarea class="tx-area mono" id="psk-text" placeholder="cq cq cq de ${this._call().toLowerCase()} ${this._call().toLowerCase()} pse k"></textarea>
                <div class="mod-controls" style="margin-top:10px">
                  <button class="btn btn-accent" id="psk-send">Send</button>
                  <button class="btn btn-danger" id="psk-abort" disabled>Abort</button>
                  <span class="mod-status" id="psk-txstat"></span>
                </div>
              </div>
            </div>
          </div>
          <div class="mod-side">
            <div class="card">
              <header class="card-head"><h3>Vector scope</h3></header>
              <canvas id="psk-scope" class="mod-canvas" width="280" height="200" style="border:none;border-radius:0"></canvas>
              <footer class="card-foot mono muted">A tuned BPSK signal draws a flipping line through the middle. A circle means you're off frequency.</footer>
            </div>
            <div class="card">
              <header class="card-head"><h3>Detector</h3></header>
              <ul class="kv-list" style="padding:10px 14px">
                <li><span class="k">AFC trim</span><span id="psk-afc">0.0 Hz</span></li>
                <li><span class="k">Signal</span><span id="psk-sig">—</span></li>
                <li><span class="k">Bit clock</span><span id="psk-clk">—</span></li>
              </ul>
            </div>
            <p class="mod-note">PSK31 is lower-case-friendly — the varicode gives common lowercase letters the shortest codes, so type like you're chatting. Click the waterfall to center on a trace.</p>
          </div>
        </div>`;

      const $ = (id) => el.querySelector("#" + id);
      this.ui = {
        rx: $("psk-rx"), stat: $("psk-stat"), meta: $("psk-meta"),
        scope: $("psk-scope"), afc: $("psk-afc"), sig: $("psk-sig"), clk: $("psk-clk"),
        toggle: $("psk-toggle"), txstat: $("psk-txstat"), abort: $("psk-abort")
      };
      $("psk-freq").addEventListener("input", (e) => this.setFreq(+e.target.value));
      $("psk-clear").addEventListener("click", () => { this.ui.rx.textContent = ""; });
      this.ui.toggle.addEventListener("click", () => this.decoding ? this.stopDecoder() : this.startDecoder());
      $("psk-send").addEventListener("click", () => this.send($("psk-text").value));
      this.ui.abort.addEventListener("click", () => this.ctx.audio.stopTX());
      this._scopeTrail = [];
    },

    _call() { return (this.ctx.settings().callsign || "N0CALL").toUpperCase(); },

    onActivate() {
      this.setFreq(this.freq);
      this._offTune = this.ctx.onTune((f) => {
        this.setFreq(Math.max(400, Math.min(2600, f)));
        const s = document.querySelector("#panel-psk31 #psk-freq");
        if (s) s.value = this.freq;
      });
      this.ctx.audio.on("tx-start", () => { if (this.ui) this.ui.abort.disabled = false; });
      this.ctx.audio.on("tx-end", () => { if (this.ui) { this.ui.abort.disabled = true; this.ui.txstat.textContent = ""; } });
    },

    onDeactivate() {
      this.stopDecoder();
      if (this._offTune) this._offTune();
      this.ctx.setMarker(null);
    },

    setFreq(f) {
      this.freq = Math.round(f);
      const lbl = document.querySelector("#panel-psk31 #psk-freq-val");
      if (lbl) lbl.textContent = `${this.freq} Hz`;
      this.ctx.setMarker({ freq: this.freq, color: "#c78bff", label: "PSK" });
      if (this.decoding) this._retuneMixer();
    },

    /* ---------------- TX ---------------- */
    send(text) {
      if (!text) return;
      const T = 1 / BAUD;
      const sr = 12000;
      const tw = new ToneWriter(sr);
      let p = 1; // current polarity

      const bit = (b) => {
        if (b === 0) { // reversal: raised-cosine flip across the bit
          const from = p;
          tw.am(this.freq, T, (t) => from * Math.cos(Math.PI * t));
          p = -p;
        } else {       // steady carrier for one bit
          tw.am(this.freq, T, () => p);
        }
      };

      for (let i = 0; i < 32; i++) bit(0);          // preamble: idle reversals
      for (const ch of text) {
        const code = VARICODE[ch] || (VARICODE[ch.toLowerCase()] ? VARICODE[ch.toLowerCase()] : null);
        if (!code) continue;
        for (const c of code) bit(c === "1" ? 1 : 0);
        bit(0); bit(0);                              // character separator
      }
      for (let i = 0; i < 32; i++) bit(1);          // postamble: steady carrier
      bit(0); // gentle key-up shape

      this.ui.txstat.textContent = `sending ${tw.seconds.toFixed(1)} s…`;
      this.ctx.log(`TX ${text.length} chars (${tw.seconds.toFixed(1)} s) @ ${this.freq} Hz`);
      return this.ctx.audio.playPCM(tw.result(), sr);
    },

    /* ---------------- RX (experimental) ---------------- */
    startDecoder() {
      if (!this.ctx.audio.rxActive) {
        this.ctx.log("Start audio first (top bar), then the decoder.");
        return;
      }
      const sr = this.ctx.audio.sampleRate;
      this.sr = sr;
      this.blockN = Math.round(sr / BAUD / 8);   // 8 blocks per bit
      this._retuneMixer();

      this.blkI = 0; this.blkQ = 0; this.blkCount = 0;
      this.blockIdx = 0;
      this.offsetScore = new Float32Array(8).fill(1);
      this.bitI = 0; this.bitQ = 0;
      this.prevPhase = null;
      this.bits = "";
      this.afcHz = 0;
      this.magAvg = new DSP.EMA(0.05);

      this.unsub = this.ctx.audio.onSamples((samples) => this._process(samples));
      this.decoding = true;
      this.ui.toggle.textContent = "Stop decoder";
      this.ui.stat.textContent = "listening";
      this.ctx.log(`Decoder on @ ${this.freq} Hz (experimental)`);
    },

    _retuneMixer() {
      this.mixPhase = 0;
      this.mixStep = 2 * Math.PI * (this.freq + (this.afcHz || 0)) / (this.sr || this.ctx.audio.sampleRate);
    },

    stopDecoder() {
      if (this.unsub) { this.unsub(); this.unsub = null; }
      this.decoding = false;
      if (this.ui) { this.ui.toggle.textContent = "Start decoder"; this.ui.stat.textContent = "decoder off"; }
    },

    _process(samples) {
      let { blkI, blkQ, blkCount, mixPhase } = this;
      const step = this.mixStep;
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        blkI += s * Math.cos(mixPhase);
        blkQ += s * Math.sin(mixPhase);
        mixPhase += step;
        if (++blkCount >= this.blockN) {
          this._onBlock(blkI / blkCount, blkQ / blkCount);
          blkI = 0; blkQ = 0; blkCount = 0;
        }
      }
      this.blkI = blkI; this.blkQ = blkQ; this.blkCount = blkCount;
      this.mixPhase = mixPhase % (2 * Math.PI);
    },

    _onBlock(I, Q) {
      const mag = Math.hypot(I, Q);
      const idx = this.blockIdx % 8;

      // envelope-dip clock recovery: shaped reversals dip to zero at
      // bit boundaries, so the phase slot with the lowest average
      // magnitude IS the bit edge.
      this.offsetScore[idx] = this.offsetScore[idx] * 0.95 + mag * 0.05;
      let boundary = 0, min = Infinity;
      for (let k = 0; k < 8; k++) if (this.offsetScore[k] < min) { min = this.offsetScore[k]; boundary = k; }

      this.bitI += I; this.bitQ += Q;
      this.blockIdx++;

      const avg = this.magAvg.push(mag);

      if (idx === boundary) {
        const phase = Math.atan2(this.bitQ, this.bitI);
        const strong = avg > 1e-4;
        if (strong && this.prevPhase !== null) {
          let d = phase - this.prevPhase;
          while (d > Math.PI) d -= 2 * Math.PI;
          while (d < -Math.PI) d += 2 * Math.PI;
          const bit = Math.abs(d) > Math.PI / 2 ? 0 : 1;
          this._pushBit(bit);
          // mild AFC: steady bits should show zero phase drift
          if (bit === 1) {
            const errHz = d / (2 * Math.PI) * BAUD;
            this.afcHz += errHz * 0.05;
            this.afcHz = Math.max(-15, Math.min(15, this.afcHz));
            this._retuneMixer();
          }
        }
        this.prevPhase = strong ? phase : null;
        if (!strong) this.bits = "";
        this._scopePoint(this.bitI, this.bitQ, avg);
        this.bitI = 0; this.bitQ = 0;
      }

      if (this.blockIdx % 40 === 0 && this.ui) {
        this.ui.afc.textContent = `${this.afcHz.toFixed(1)} Hz`;
        this.ui.sig.textContent = avg > 1e-4 ? "locked" : "idle";
        this.ui.clk.textContent = `slot ${boundary}/8`;
      }
    },

    _pushBit(b) {
      this.bits += b;
      if (this.bits.endsWith("00")) {
        const code = this.bits.slice(0, -2).replace(/^0+/, "");
        this.bits = "";
        if (code.length) {
          const ch = REVERSE[code];
          if (ch) {
            this.ui.rx.textContent += ch;
            if (this.ui.rx.textContent.length > 4000)
              this.ui.rx.textContent = this.ui.rx.textContent.slice(-3000);
            this.ui.rx.scrollTop = this.ui.rx.scrollHeight;
          }
        }
      }
      if (this.bits.length > 24) this.bits = ""; // lost sync, start over
    },

    _scopePoint(I, Q, avg) {
      const c = this.ui.scope, ctx = c.getContext("2d");
      const scale = avg > 0 ? 40 / (avg * 8 + 1e-6) : 0;
      this._scopeTrail.push([I * scale, Q * scale]);
      if (this._scopeTrail.length > 40) this._scopeTrail.shift();
      ctx.fillStyle = "#05070b";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.strokeStyle = "rgba(96,114,150,0.3)";
      ctx.beginPath();
      ctx.moveTo(c.width / 2, 0); ctx.lineTo(c.width / 2, c.height);
      ctx.moveTo(0, c.height / 2); ctx.lineTo(c.width, c.height / 2);
      ctx.stroke();
      this._scopeTrail.forEach(([x, y], i) => {
        const a = (i + 1) / this._scopeTrail.length;
        ctx.fillStyle = `rgba(199,139,255,${a})`;
        ctx.beginPath();
        ctx.arc(c.width / 2 + clampN(x, 130), c.height / 2 + clampN(y, 90), 2.4, 0, 7);
        ctx.fill();
      });
    }
  };

  function clampN(v, m) { return Math.max(-m, Math.min(m, v)); }

  HRWS.registerModule(def);
})();
