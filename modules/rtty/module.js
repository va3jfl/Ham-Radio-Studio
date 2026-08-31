/* ============================================================
   Ham Radio Web Studio — RTTY module
   The classic: 45.45 baud, 5-bit Baudot, 170 Hz shift.
   TX: phase-continuous AFSK from a Baudot bitstream
   RX: mark/space Goertzel pair → software UART → ITA2 decode
   ============================================================ */
"use strict";

(function () {

  // ITA2 / US-TTY tables, index = 5-bit code value
  const LTRS = ["\0","E","\n","A"," ","S","I","U","\r","D","R","J","N","F","C","K",
                "T","Z","L","W","H","Y","P","Q","O","B","G","\x0e","M","X","V","\x0f"];
  const FIGS = ["\0","3","\n","-"," ","\x07","8","7","\r","$","4","'",",","!",":","(",
                "5","\"",")","2","#","6","0","1","9","?","&","\x0e",".","/",";","\x0f"];
  const CODE_FIGS = 27, CODE_LTRS = 31;

  // build encode map: char -> {code, shift:"L"|"F"|"both"}
  const ENC = {};
  LTRS.forEach((ch, i) => { if (ch >= " " || ch === "\n" || ch === "\r") ENC[ch] = { code: i, shift: "L" }; });
  FIGS.forEach((ch, i) => {
    if (ch < " " && ch !== "\n" && ch !== "\r") return;
    if (ENC[ch] && LTRS[ENC[ch].code] === ch && FIGS[i] === ch) ENC[ch].shift = "both";
    else if (!ENC[ch]) ENC[ch] = { code: i, shift: "F" };
  });

  const def = {
    id: "rtty",

    init(ctx) {
      this.ctx = ctx;
      this.baud = 45.45;
      this.mark = 2125;
      this.shift = 170;
      this.reverse = false;
      this.usos = true;
      this.decoding = false;
      this.unsub = null;
    },

    get space() { return this.mark + this.shift; },

    createPanel(el) {
      el.innerHTML = `
        <div class="mod-layout">
          <div class="mod-main">
            <div class="card">
              <header class="card-head"><h3>Receive</h3>
                <span class="card-tag mono" id="rtty-stat">decoder off</span></header>
              <div class="rx-screen" id="rtty-rx"></div>
              <div class="card-foot mod-controls">
                <button class="btn btn-accent" id="rtty-toggle">Start decoder</button>
                <label class="field"><span>Mark <em id="rtty-mark-val">2125 Hz</em></span>
                  <input type="range" id="rtty-mark" min="800" max="2600" value="2125" step="5"></label>
                <label class="field"><span>Shift</span>
                  <select id="rtty-shift"><option>170</option><option>425</option><option>850</option></select></label>
                <label class="dock-field"><input type="checkbox" id="rtty-rev"> Reverse</label>
                <label class="dock-field"><input type="checkbox" id="rtty-usos" checked> USOS</label>
                <button class="btn btn-mini" id="rtty-clear">Clear</button>
              </div>
            </div>
            <div class="card">
              <header class="card-head"><h3>Transmit</h3></header>
              <div class="card-foot" style="border-top:none">
                <textarea class="tx-area mono" id="rtty-text" placeholder="RYRYRY DE ${this._call()} ..."></textarea>
                <div class="mod-controls" style="margin-top:10px">
                  <button class="btn btn-accent" id="rtty-send">Send</button>
                  <button class="btn btn-danger" id="rtty-abort" disabled>Abort</button>
                  <button class="btn" id="rtty-ry">Insert RYRY test</button>
                  <span class="mod-status" id="rtty-txstat"></span>
                </div>
              </div>
            </div>
          </div>
          <div class="mod-side">
            <div class="card">
              <header class="card-head"><h3>Channel</h3></header>
              <ul class="kv-list" style="padding:10px 14px">
                <li><span class="k">Mark / Space</span><span id="rtty-ms">2125 / 2295 Hz</span></li>
                <li><span class="k">Baud</span><span>45.45</span></li>
                <li><span class="k">Shift state</span><span id="rtty-shiftstate">LTRS</span></li>
                <li><span class="k">Frames ok / bad</span><span id="rtty-frames">0 / 0</span></li>
              </ul>
            </div>
            <p class="mod-note">Loop it back: press Send with the decoder running and a lead from headphone out to mic in (or just let the speakers talk to the microphone). Click the waterfall to move the mark tone onto a signal.</p>
          </div>
        </div>`;

      const $ = (id) => el.querySelector("#" + id);
      this.ui = {
        rx: $("rtty-rx"), stat: $("rtty-stat"), toggle: $("rtty-toggle"),
        ms: $("rtty-ms"), shiftstate: $("rtty-shiftstate"), frames: $("rtty-frames"),
        txstat: $("rtty-txstat"), abort: $("rtty-abort")
      };

      $("rtty-mark").addEventListener("input", (e) => this.setMark(+e.target.value));
      $("rtty-shift").addEventListener("change", (e) => { this.shift = +e.target.value; this._retune(); });
      $("rtty-rev").addEventListener("change", (e) => { this.reverse = e.target.checked; });
      $("rtty-usos").addEventListener("change", (e) => { this.usos = e.target.checked; });
      $("rtty-clear").addEventListener("click", () => { this.ui.rx.textContent = ""; });
      this.ui.toggle.addEventListener("click", () => this.decoding ? this.stopDecoder() : this.startDecoder());
      $("rtty-send").addEventListener("click", () => this.send($("rtty-text").value));
      $("rtty-ry").addEventListener("click", () => { $("rtty-text").value = "RYRYRYRYRYRYRYRYRYRY DE " + this._call(); });
      this.ui.abort.addEventListener("click", () => this.ctx.audio.stopTX());
    },

    _call() { return (this.ctx.settings().callsign || "N0CALL").toUpperCase(); },

    onActivate() {
      this._retune();
      this._offTune = this.ctx.onTune((f) => {
        this.setMark(Math.max(800, Math.min(2600, f)));
        const s = document.querySelector("#panel-rtty #rtty-mark");
        if (s) s.value = this.mark;
      });
      this.ctx.audio.on("tx-start", () => { if (this.ui) this.ui.abort.disabled = false; });
      this.ctx.audio.on("tx-end", () => { if (this.ui) { this.ui.abort.disabled = true; this.ui.txstat.textContent = ""; } });
    },

    onDeactivate() {
      this.stopDecoder();
      if (this._offTune) this._offTune();
      this.ctx.setMarker(null);
    },

    setMark(f) {
      this.mark = Math.round(f);
      this._retune();
    },
    _retune() {
      const lbl = document.querySelector("#panel-rtty #rtty-mark-val");
      if (lbl) lbl.textContent = `${this.mark} Hz`;
      if (this.ui) this.ui.ms.textContent = `${this.mark} / ${this.space} Hz`;
      if (this.gMark) { this.gMark.setFreq(this.mark); this.gSpace.setFreq(this.space); }
      this.ctx.setMarker([
        { freq: this.mark, color: "#45c7d6", label: "M" },
        { freq: this.space, color: "#ff9d5d", label: "S" }
      ]);
    },

    /* ---------------- TX ---------------- */
    encodeBits(text) {
      // returns array of frames, each = [b0..b4] LSB-first data bits
      const frames = [];
      let shift = null; // unknown → force LTRS first
      const pushCode = (code) => frames.push([0,1,2,3,4].map(i => (code >> i) & 1));
      pushCode(CODE_LTRS); pushCode(CODE_LTRS); shift = "L";

      for (let ch of text.toUpperCase()) {
        if (ch === "\t") ch = " ";
        const e = ENC[ch];
        if (!e) continue;
        if (e.shift !== "both" && e.shift !== shift) {
          pushCode(e.shift === "F" ? CODE_FIGS : CODE_LTRS);
          shift = e.shift;
        }
        pushCode(e.code);
        if (this.usos && ch === " ") shift = "L"; // unshift on space
        if (ch === "\n") pushCode(ENC["\r"] ? ENC["\r"].code : 8); // CR after LF for old iron
      }
      pushCode(CODE_LTRS);
      return frames;
    },

    async send(text) {
      if (!text.trim()) return;
      const bitDur = 1 / this.baud;
      const sr = 12000;
      const tw = new ToneWriter(sr);
      const [fMark, fSpace] = this.reverse ? [this.space, this.mark] : [this.mark, this.space];
      tw.tone(fMark, 0.3); // steady mark lead-in (diddle-ish)
      for (const bits of this.encodeBits(text)) {
        tw.tone(fSpace, bitDur);                 // start
        for (const b of bits) tw.tone(b ? fMark : fSpace, bitDur);
        tw.tone(fMark, bitDur * 1.5);            // stop
      }
      tw.tone(fMark, 0.25);
      this.ui.txstat.textContent = `sending ${tw.seconds.toFixed(1)} s…`;
      this.ctx.log(`TX ${text.trim().length} chars (${tw.seconds.toFixed(1)} s)`);
      await this.ctx.audio.playPCM(tw.result(), sr);
    },

    /* ---------------- RX ---------------- */
    startDecoder() {
      if (!this.ctx.audio.rxActive) {
        this.ctx.log("Start audio first (top bar), then the decoder.");
        return;
      }
      const sr = this.ctx.audio.sampleRate;
      const blockSize = Math.round(sr * 0.005);      // 5 ms → ~4.4 samples per bit
      this.blockDur = blockSize / sr;
      this.gMark = new DSP.Goertzel(this.mark, sr, blockSize);
      this.gSpace = new DSP.Goertzel(this.space, sr, blockSize);
      this._magM = 0; this._magS = 0; this._pair = 0;

      this.bitDur = 1 / this.baud;
      this.uart = { state: "idle", t: 0, next: 0, bits: [], ok: 0, bad: 0 };
      this.shiftState = "L";

      this.unsub = this.ctx.audio.onSamples((samples) => {
        // run both detectors over the same samples; blocks stay in step
        this.gMark.process(samples, (m) => { this._magM = m; this._pair |= 1; this._maybeBit(); });
        this.gSpace.process(samples, (m) => { this._magS = m; this._pair |= 2; this._maybeBit(); });
      });

      this.decoding = true;
      this.ui.toggle.textContent = "Stop decoder";
      this.ui.stat.textContent = "listening";
      this.ctx.log(`Decoder on, mark ${this.mark} Hz / space ${this.space} Hz`);
    },

    stopDecoder() {
      if (this.unsub) { this.unsub(); this.unsub = null; }
      this.decoding = false;
      if (this.ui) { this.ui.toggle.textContent = "Start decoder"; this.ui.stat.textContent = "decoder off"; }
    },

    _maybeBit() {
      if (this._pair !== 3) return;
      this._pair = 0;
      let bit = this._magM > this._magS ? 1 : 0; // 1 = mark
      if (this.reverse) bit = 1 - bit;
      this._uartTick(bit);
    },

    /* software UART clocked by Goertzel blocks */
    _uartTick(bit) {
      const u = this.uart;
      if (u.state === "idle") {
        if (bit === 0) {                          // mark→space edge: start bit
          u.state = "frame";
          u.t = 0;
          u.next = 0.5 * this.bitDur;             // first check: mid start bit
          u.bits = [];
        }
        return;
      }
      u.t += this.blockDur;
      while (u.t >= u.next) {
        const idx = u.bits.length;
        if (idx === 0) {
          if (bit !== 0) { u.state = "idle"; u.bad++; this._frames(); return; } // false start
          u.bits.push("start");
          u.next += this.bitDur;
        } else if (idx <= 5) {
          u.bits.push(bit);
          u.next += this.bitDur;                 // next data bit, or the stop-bit center
        } else {
          // stop bit sample
          if (bit === 1) {
            const code = u.bits[1] | (u.bits[2] << 1) | (u.bits[3] << 2) | (u.bits[4] << 3) | (u.bits[5] << 4);
            u.ok++;
            this._emitCode(code);
          } else {
            u.bad++;
          }
          u.state = "idle";
          this._frames();
          return;
        }
      }
    },

    _frames() {
      if (this.ui) this.ui.frames.textContent = `${this.uart.ok} / ${this.uart.bad}`;
    },

    _emitCode(code) {
      if (code === CODE_LTRS) { this.shiftState = "L"; }
      else if (code === CODE_FIGS) { this.shiftState = "F"; }
      else {
        let ch = (this.shiftState === "L" ? LTRS : FIGS)[code] || "";
        if (ch === "\r" || ch === "\0" || ch === "\x07") ch = "";
        if (ch) {
          this.ui.rx.textContent += ch;
          if (this.ui.rx.textContent.length > 4000)
            this.ui.rx.textContent = this.ui.rx.textContent.slice(-3000);
          this.ui.rx.scrollTop = this.ui.rx.scrollHeight;
        }
        if (this.usos && ch === " ") this.shiftState = "L";
      }
      this.ui.shiftstate.textContent = this.shiftState === "L" ? "LTRS" : "FIGS";
    }
  };

  HRWS.registerModule(def);
})();
