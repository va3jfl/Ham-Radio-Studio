/* ============================================================
   Ham Radio Web Studio — CW / Morse module
   TX: text → shaped, phase-clean keyed tone (5–60 WPM)
   RX: Goertzel tone detector → adaptive dit-length classifier
   Extras: straight-key practice (hold the key button or Ctrl)
   ============================================================ */
"use strict";

(function () {

  const MORSE = {
    A: ".-", B: "-...", C: "-.-.", D: "-..", E: ".", F: "..-.", G: "--.", H: "....",
    I: "..", J: ".---", K: "-.-", L: ".-..", M: "--", N: "-.", O: "---", P: ".--.",
    Q: "--.-", R: ".-.", S: "...", T: "-", U: "..-", V: "...-", W: ".--", X: "-..-",
    Y: "-.--", Z: "--..",
    0: "-----", 1: ".----", 2: "..---", 3: "...--", 4: "....-",
    5: ".....", 6: "-....", 7: "--...", 8: "---..", 9: "----.",
    ".": ".-.-.-", ",": "--..--", "?": "..--..", "/": "-..-.", "=": "-...-",
    "+": ".-.-.", "-": "-....-", "@": ".--.-.", "'": ".----.", "!": "-.-.--",
    "(": "-.--.", ")": "-.--.-", "&": ".-...", ":": "---...", ";": "-.-.-.",
    '"': ".-..-.", "$": "...-..-"
  };
  const PROSIGNS = { AR: ".-.-.", SK: "...-.-", BT: "-...-", KN: "-.--.", AS: ".-..." };
  const REVERSE = {};
  for (const [ch, code] of Object.entries(MORSE)) REVERSE[code] = ch;
  REVERSE["...-.-"] = "<SK>"; REVERSE[".-..."] = "<AS>";

  const def = {
    id: "cw",

    init(ctx) {
      this.ctx = ctx;
      this.wpm = 20;
      this.pitch = 700;
      this.rxFreq = 700;
      this.decoding = false;
      this.unsubSamples = null;
      this.keyer = null;
      this._keyHandlerDown = null;
      this._keyHandlerUp = null;
    },

    /* ---------------- UI ---------------- */
    createPanel(el) {
      el.innerHTML = `
        <div class="mod-layout">
          <div class="mod-main">
            <div class="card">
              <header class="card-head"><h3>Receive</h3>
                <span class="card-tag mono" id="cw-rx-stat">decoder off</span></header>
              <div class="rx-screen" id="cw-rx"></div>
              <div class="card-foot mod-controls">
                <button class="btn btn-accent" id="cw-rx-toggle">Start decoder</button>
                <label class="field"><span>Tone <em id="cw-rxfreq-val">700 Hz</em></span>
                  <input type="range" id="cw-rxfreq" min="300" max="1200" value="700"></label>
                <button class="btn btn-mini" id="cw-rx-clear">Clear</button>
                <span class="mod-status" id="cw-rx-meta"></span>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>Transmit</h3></header>
              <div class="card-foot" style="border-top:none">
                <textarea class="tx-area mono" id="cw-tx-text" placeholder="CQ CQ CQ DE ${this._call()} ${this._call()} K"></textarea>
                <div class="mod-controls" style="margin-top:10px">
                  <button class="btn btn-accent" id="cw-send">Send</button>
                  <button class="btn btn-danger" id="cw-abort" disabled>Abort</button>
                  <label class="field"><span>Speed <em id="cw-wpm-val">20 WPM</em></span>
                    <input type="range" id="cw-wpm" min="5" max="45" value="20"></label>
                  <label class="field"><span>Pitch <em id="cw-pitch-val">700 Hz</em></span>
                    <input type="range" id="cw-pitch" min="400" max="1000" value="700" step="10"></label>
                  <span class="mod-status" id="cw-tx-stat"></span>
                </div>
              </div>
            </div>
          </div>
          <div class="mod-side">
            <div class="card">
              <header class="card-head"><h3>Straight key</h3></header>
              <div class="card-foot" style="border-top:none">
                <button class="btn btn-accent" id="cw-key" style="width:100%;padding:22px 0;font-size:15px">
                  KEY&nbsp;&nbsp;·&nbsp;&nbsp;hold me (or hold Ctrl)
                </button>
                <p class="mod-note" style="margin-top:10px">Practice sending with the decoder running and read your own fist back. Aim the RX tone at your pitch first.</p>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>Decoder state</h3></header>
              <ul class="kv-list" style="padding:10px 14px">
                <li><span class="k">Estimated speed</span><span id="cw-est-wpm">—</span></li>
                <li><span class="k">Signal</span><span id="cw-sig">—</span></li>
                <li><span class="k">Element buffer</span><span id="cw-buf" class="vfd vfd-small">&nbsp;</span></li>
              </ul>
            </div>
            <p class="mod-note">Click the waterfall on any CW trace to drop the decoder right on it. Prosigns: type &lt;AR&gt; &lt;SK&gt; &lt;BT&gt; &lt;KN&gt; &lt;AS&gt;.</p>
          </div>
        </div>`;

      const $ = (id) => el.querySelector("#" + id);
      this.ui = {
        rx: $("cw-rx"), rxStat: $("cw-rx-stat"), rxMeta: $("cw-rx-meta"),
        estWpm: $("cw-est-wpm"), sig: $("cw-sig"), buf: $("cw-buf"),
        txStat: $("cw-tx-stat"), abort: $("cw-abort"), send: $("cw-send"),
        rxToggle: $("cw-rx-toggle")
      };

      $("cw-wpm").addEventListener("input", (e) => {
        this.wpm = +e.target.value;
        $("cw-wpm-val").textContent = `${this.wpm} WPM`;
      });
      $("cw-pitch").addEventListener("input", (e) => {
        this.pitch = +e.target.value;
        $("cw-pitch-val").textContent = `${this.pitch} Hz`;
        if (this.keyer) this.keyer.setFreq(this.pitch);
      });
      $("cw-rxfreq").addEventListener("input", (e) => this.setRxFreq(+e.target.value));
      $("cw-rx-clear").addEventListener("click", () => { this.ui.rx.textContent = ""; });
      this.ui.rxToggle.addEventListener("click", () => this.decoding ? this.stopDecoder() : this.startDecoder());
      this.ui.send.addEventListener("click", () => this.send($("cw-tx-text").value));
      this.ui.abort.addEventListener("click", () => this.ctx.audio.stopTX());

      // straight key: pointer + keyboard (Ctrl)
      const keyBtn = $("cw-key");
      const down = (e) => { e.preventDefault(); this._keyDown(); };
      const up = () => this._keyUp();
      keyBtn.addEventListener("pointerdown", down);
      keyBtn.addEventListener("pointerup", up);
      keyBtn.addEventListener("pointerleave", up);
      this._keyHandlerDown = (e) => {
        if (e.code === "ControlLeft" && !e.repeat && HRWS.activePanel === "cw") this._keyDown();
      };
      this._keyHandlerUp = (e) => { if (e.code === "ControlLeft") this._keyUp(); };
    },

    _call() { return (this.ctx.settings().callsign || "N0CALL").toUpperCase(); },

    onActivate() {
      this.ctx.setMarker({ freq: this.rxFreq, color: "#7bd88f", label: "CW" });
      this._offTune = this.ctx.onTune((f) => {
        this.setRxFreq(Math.max(300, Math.min(1200, f)));
        const slider = document.querySelector("#panel-cw #cw-rxfreq");
        if (slider) slider.value = this.rxFreq;
      });
      document.addEventListener("keydown", this._keyHandlerDown);
      document.addEventListener("keyup", this._keyHandlerUp);
      this.ctx.audio.on("tx-start", this._txLed = () => { this.ui.abort.disabled = false; });
      this.ctx.audio.on("tx-end", this._txLedOff = () => {
        this.ui.abort.disabled = true; this.ui.txStat.textContent = "";
      });
    },

    onDeactivate() {
      this.stopDecoder();
      if (this.keyer) { this.keyer.dispose(); this.keyer = null; }
      if (this._offTune) this._offTune();
      this.ctx.setMarker(null);
      document.removeEventListener("keydown", this._keyHandlerDown);
      document.removeEventListener("keyup", this._keyHandlerUp);
    },

    /* ---------------- straight key ---------------- */
    _keyDown() {
      if (!this.keyer) this.keyer = this.ctx.audio.makeKeyer(this.pitch);
      this.keyer.down();
    },
    _keyUp() { if (this.keyer) this.keyer.up(); },

    /* ---------------- TX ---------------- */
    textToPattern(text) {
      // returns [{on:bool, durUnits:n}] in dit units
      const out = [];
      const push = (on, units) => out.push({ on, units });
      const words = text.trim().toUpperCase().split(/\s+/);
      words.forEach((word, wi) => {
        // prosigns in angle brackets are sent without inter-char gaps
        const chars = word.match(/<[A-Z]{2}>|./g) || [];
        chars.forEach((ch, ci) => {
          let code;
          if (ch.startsWith("<")) code = PROSIGNS[ch.slice(1, -1)];
          else code = MORSE[ch];
          if (!code) return;
          for (let i = 0; i < code.length; i++) {
            push(true, code[i] === "." ? 1 : 3);
            if (i < code.length - 1) push(false, 1);
          }
          if (ci < chars.length - 1) push(false, 3);
        });
        if (wi < words.length - 1) push(false, 7);
      });
      return out;
    },

    async send(text) {
      if (!text.trim()) return;
      const dit = 1.2 / this.wpm;
      const pattern = this.textToPattern(text);
      const sr = 12000;
      const tw = new ToneWriter(sr);
      tw.silence(0.15);
      for (const p of pattern) {
        if (p.on) tw.keyedTone(this.pitch, p.units * dit, 0.005);
        else tw.silence(p.units * dit);
      }
      tw.silence(0.15);
      this.ui.txStat.textContent = `sending ${tw.seconds.toFixed(1)} s @ ${this.wpm} WPM…`;
      this.ctx.log(`TX: "${text.trim().slice(0, 60)}" (${tw.seconds.toFixed(1)} s)`);
      await this.ctx.audio.playPCM(tw.result(), sr);
    },

    /* ---------------- RX ---------------- */
    setRxFreq(f) {
      this.rxFreq = Math.round(f);
      const lbl = document.querySelector("#panel-cw #cw-rxfreq-val");
      if (lbl) lbl.textContent = `${this.rxFreq} Hz`;
      if (this.goertzel) this.goertzel.setFreq(this.rxFreq);
      this.ctx.setMarker({ freq: this.rxFreq, color: "#7bd88f", label: "CW" });
    },

    startDecoder() {
      if (!this.ctx.audio.rxActive) {
        this.ctx.log("Start audio first (button in the top bar), then start the decoder.");
        return;
      }
      const sr = this.ctx.audio.sampleRate;
      const blockSize = Math.round(sr * 0.004); // ~4 ms envelope resolution
      this.blockDur = blockSize / sr;
      this.goertzel = new DSP.Goertzel(this.rxFreq, sr, blockSize);
      this.gate = new DSP.EnvelopeGate();
      this.magSmooth = new DSP.EMA(0.4);
      this.state = false;
      this.stateBlocks = 0;
      this.ditSec = 1.2 / 20;
      this.symbols = "";
      this.flushedIdle = true;

      this.unsubSamples = this.ctx.audio.onSamples((samples) => {
        this.goertzel.process(samples, (mag) => this._onEnvelope(this.magSmooth.push(mag)));
      });
      this.decoding = true;
      this.ui.rxToggle.textContent = "Stop decoder";
      this.ui.rxStat.textContent = "listening";
      this.ctx.log(`Decoder on @ ${this.rxFreq} Hz`);
    },

    stopDecoder() {
      if (this.unsubSamples) { this.unsubSamples(); this.unsubSamples = null; }
      this.decoding = false;
      if (this.ui) {
        this.ui.rxToggle.textContent = "Start decoder";
        this.ui.rxStat.textContent = "decoder off";
      }
    },

    _onEnvelope(mag) {
      const on = this.gate.push(mag);
      this.stateBlocks++;

      if (on !== this.state) {
        const dur = this.stateBlocks * this.blockDur;
        if (this.state) this._mark(dur); else this._space(dur);
        this.state = on;
        this.stateBlocks = 0;
        this.flushedIdle = false;
      } else if (!this.state && !this.flushedIdle) {
        // long idle with no transition: flush pending character + word gap
        const idle = this.stateBlocks * this.blockDur;
        if (idle > this.ditSec * 7) {
          this._flushChar();
          this._emit(" ");
          this.flushedIdle = true;
        }
      }

      // occasional meta refresh
      if ((this._metaTick = (this._metaTick || 0) + 1) % 25 === 0) {
        const snr = this.gate.peak / Math.max(this.gate.floor, 1e-9);
        this.ui.sig.textContent = snr > 3 ? `${(20 * Math.log10(snr)).toFixed(0)} dB` : "noise";
        this.ui.estWpm.textContent = `${Math.round(1.2 / this.ditSec)} WPM`;
        this.ui.buf.textContent = this.symbols || " ";
      }
    },

    _mark(dur) {
      if (dur < this.ditSec * 0.3) return; // glitch
      if (dur < this.ditSec * 1.9) {
        this.symbols += ".";
        this.ditSec = clamp(this.ditSec * 0.8 + dur * 0.2, 0.02, 0.35);
      } else {
        this.symbols += "-";
        this.ditSec = clamp(this.ditSec * 0.8 + (dur / 3) * 0.2, 0.02, 0.35);
      }
      if (this.symbols.length > 8) this.symbols = this.symbols.slice(-8);
    },

    _space(dur) {
      if (dur < this.ditSec * 1.8) return;      // element gap
      this._flushChar();                         // character gap
      if (dur > this.ditSec * 4.5) this._emit(" "); // word gap
    },

    _flushChar() {
      if (!this.symbols) return;
      this._emit(REVERSE[this.symbols] || "▮");
      this.symbols = "";
    },

    _emit(ch) {
      this.ui.rx.textContent += ch;
      if (this.ui.rx.textContent.length > 4000)
        this.ui.rx.textContent = this.ui.rx.textContent.slice(-3000);
      this.ui.rx.scrollTop = this.ui.rx.scrollHeight;
    }
  };

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  HRWS.registerModule(def);
})();
