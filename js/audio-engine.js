/* ============================================================
   Ham Radio Web Studio — Audio Engine
   One shared Web Audio pipeline for every mode module:

     line-in / mic ──► analyser ──► waterfall + spectrum
                   └─► sample tap ──► decoder modules

     encoder modules ──► playPCM() ──► TX gain ──► speakers/rig

   Synthesis is done into Float32 buffers at whatever sample
   rate the mode likes (the browser resamples on playback), so
   FSK/PSK/FM stay phase-continuous and cheap to generate.
   ============================================================ */
"use strict";

/* Output stage trim for the streaming pipes (openTXStream /
   openMonitorStream): one static \u22122.5 dB, constant from the first
   sample \u2014 see the note inside push(). Referenced there; born
   undefined in the refactor that removed the per-chunk peak ratchet,
   which took every streaming mode down with a ReferenceError on the
   very first pushed block. The engine smoke test now locks both the
   existence and the value. */
const OUT_TRIM = Math.pow(10, -2.5 / 20);

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.preferredRate = null;   // optional AudioContext sample rate
    this.analyser = null;
    this.mediaStream = null;
    this._ownsStream = false;    // did WE open the stream (mic) or borrow it?
    this.txBus = null;           // unity pre-gain TX rail (tap point)
    this.virtualInputs = {};     // id -> {label, provider()} — see registerVirtualInput
    this.inputId = "";
    this.sourceNode = null;
    this.tapNode = null;
    this.txGainNode = null;
    this.currentTx = null;

    this.rxActive = false;
    this.txActive = false;
    this.level = 0;              // RX RMS, 0..1

    this._sampleSubs = new Set(); // cb(ch0 Float32Array, sampleRate, ch1 Float32Array)
    this._events = {};            // tiny emitter
    this.txGain = 0.8;
  }

  /* ---------------- tiny event emitter ---------------- */
  on(evt, cb) { (this._events[evt] ||= new Set()).add(cb); return () => this._events[evt].delete(cb); }
  emit(evt, data) { (this._events[evt] || []).forEach(cb => { try { cb(data); } catch (e) { console.error(e); } }); }

  /* ---------------- context ---------------- */
  ensureContext() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      try {
        this.ctx = this.preferredRate ? new AC({ sampleRate: this.preferredRate }) : new AC();
      } catch (e) {
        this.ctx = new AC();     // device refused the rate — use default
      }
      if (this.preferredSink && typeof this.ctx.setSinkId === "function")
        this.ctx.setSinkId(this.preferredSink).catch(() => {});
      // txBus is the rail every encoder feeds; taps (the Online Link
      // module, recorders…) hang off this node. Every mode used to
      // master at digital full scale, which leaves 0 dB of headroom for
      // the OS mixer / DAC and reads as "everything is overdriven" —
      // so the bus carries one flat −3 dB pad. Pure volume, applied to
      // the whole studio in one place; the waveform is never shaped.
      this.txBus = this.ctx.createGain();
      this.txBus.gain.value = 0.7;
      this.txSafe = this.txBus;    // tap point for links/recorders
      this.txGainNode = this.ctx.createGain();
      this.txGainNode.gain.value = this.txGain;
      this.txBus.connect(this.txGainNode);
      this.txGainNode.connect(this.ctx.destination);
      /* monitorBus: local-ears-only playback (decoded voice, demodulated
         subcarriers…). Straight to the speakers — never onto the TX rail,
         so links and recorders tapping txBus can't pick up what a decoder
         is merely playing back, and monitors never light the TX system. */
      this.monitorBus = this.ctx.createGain();
      this.monitorBus.gain.value = 0.9;
      this.monitorBus.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  }

  get sampleRate() { return this.ctx ? this.ctx.sampleRate : 48000; }

  setTxGain(v) {
    this.txGain = v;
    if (this.txGainNode) this.txGainNode.gain.value = v;
  }

  /* Ask for a specific AudioContext rate (96 k / 192 k for wideband
     experiments). Takes effect when the context is first created; if
     one already exists at a different rate, a page reload applies it. */
  setPreferredRate(rate) {
    this.preferredRate = rate || null;
    return this.ctx ? this.ctx.sampleRate : null;
  }

  /* ---------------- virtual inputs ----------------
     Modules can register a stream provider that shows up in the
     input picker exactly like a sound card ("Online link", the
     conditions-simulator loopback…). provider() returns a
     MediaStream, a promise of one, or null when not ready. */
  registerVirtualInput(id, label, provider) {
    this.virtualInputs[id] = { label, provider };
    this.emit("virtual-inputs", Object.keys(this.virtualInputs));
  }
  unregisterVirtualInput(id) {
    if (!this.virtualInputs[id]) return;
    delete this.virtualInputs[id];
    this.emit("virtual-inputs", Object.keys(this.virtualInputs));
  }

  /* ---------------- RX chain ---------------- */
  async startRX(deviceId) {
    this.ensureContext();
    this.stopRX();

    const virt = deviceId ? this.virtualInputs[deviceId] : null;
    if (virt) {
      const stream = await virt.provider();
      if (!stream) throw new Error(`${virt.label} has no audio yet — connect it first`);
      this.mediaStream = stream;
      this._ownsStream = false;      // the provider keeps its tracks alive
    } else {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        // Browsers only expose microphone capture on http://localhost or
        // https:// pages — a rule baked into Chrome/Firefox/Safari, not this
        // app. Everything that doesn't need the mic (TX, the Online Link,
        // the 🧪 loopback) still works fine on plain http over a LAN.
        throw new Error("this browser blocks microphone capture on plain http:// addresses " +
          "(only localhost or https are allowed — a browser rule, not ours). " +
          "TX and the Online/loopback virtual inputs still work; for real radio-audio RX, " +
          "open the site as http://localhost on the server machine, or see the README for LAN options.");
      }
      const constraints = {
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { ideal: 2 },   // stereo when the device offers it
          ...(deviceId ? { deviceId: { exact: deviceId } } : {})
        }
      };
      this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      this._ownsStream = true;
    }
    this.inputId = deviceId || "";
    this.sourceNode = this.ctx.createMediaStreamSource(this.mediaStream);

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 8192;
    this.analyser.smoothingTimeConstant = 0.55;
    this.analyser.minDecibels = -110;
    this.analyser.maxDecibels = -20;
    this.sourceNode.connect(this.analyser);

    // The tap hands RX samples to the decoders. An AudioWorklet does
    // this on the AUDIO thread, so a busy page (waterfalls, armed
    // decoders, big paints) can no longer glitch the context's output —
    // transmissions and monitored audio stay seamless even while the
    // UI sweats; the decoders just catch up a beat later. Browsers
    // without worklets fall back to the old ScriptProcessor.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    mute.connect(this.ctx.destination);
    const worklet = await this._ensureTapWorklet();
    if (worklet) {
      this.tapNode = new AudioWorkletNode(this.ctx, "hrws-tap",
        { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      this.tapNode.port.onmessage = (e) => this._consumeBlock(e.data.a, e.data.b);
      this.sourceNode.connect(this.tapNode);
      this.tapNode.connect(mute);
    } else {
      this.tapNode = this.ctx.createScriptProcessor(4096, 2, 1);
      this.sourceNode.connect(this.tapNode);
      this.tapNode.connect(mute);
      this.tapNode.onaudioprocess = (e) => {
        const i0 = e.inputBuffer.getChannelData(0);
        const i1 = e.inputBuffer.numberOfChannels > 1
          ? e.inputBuffer.getChannelData(1) : i0;
        this._consumeBlock(new Float32Array(i0), new Float32Array(i1));
      };
    }

    this.rxActive = true;
    this.emit("rx-start");
  }

  /* Shared RX-block consumer (owned arrays): level meter + decoder
     fan-out. Runs on the main thread as an ordinary task, decoupled
     from audio deadlines. */
  _consumeBlock(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i += 4) sum += a[i] * a[i];
    this.level = Math.sqrt(sum / (a.length / 4));
    if (this._sampleSubs.size) {
      const sr = this.ctx.sampleRate;
      this._sampleSubs.forEach(cb => { try { cb(a, sr, b); } catch (err) { console.error(err); } });
    }
  }

  /* Register the tiny tap processor from a Blob so no extra file or
     fetch is needed. Resolves true when the worklet route is usable. */
  _ensureTapWorklet() {
    if (this._tapWorkletP !== undefined) return this._tapWorkletP;
    if (!this.ctx.audioWorklet || typeof AudioWorkletNode === "undefined") {
      this._tapWorkletP = Promise.resolve(false);
      return this._tapWorkletP;
    }
    const code =
      'class HrwsTap extends AudioWorkletProcessor{' +
      'constructor(){super();this.n=4096;this.a=new Float32Array(this.n);this.b=new Float32Array(this.n);this.p=0;}' +
      'process(inputs){const inp=inputs[0];const c0=inp&&inp[0];if(!c0)return true;const c1=inp[1]||c0;let i=0;' +
      'while(i<c0.length){const take=Math.min(this.n-this.p,c0.length-i);' +
      'this.a.set(c0.subarray(i,i+take),this.p);this.b.set(c1.subarray(i,i+take),this.p);this.p+=take;i+=take;' +
      'if(this.p===this.n){const A=this.a,B=this.b;this.port.postMessage({a:A,b:B},[A.buffer,B.buffer]);' +
      'this.a=new Float32Array(this.n);this.b=new Float32Array(this.n);this.p=0;}}' +
      'return true;}}' +
      'registerProcessor("hrws-tap",HrwsTap);';
    const url = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
    this._tapWorkletP = this.ctx.audioWorklet.addModule(url)
      .then(() => true)
      .catch(() => false)
      .finally(() => URL.revokeObjectURL(url));
    return this._tapWorkletP;
  }

  stopRX() {
    if (this.tapNode) {
      try { this.tapNode.disconnect(); } catch (e) {}
      if (this.tapNode.port) this.tapNode.port.onmessage = null;
      if ("onaudioprocess" in this.tapNode) this.tapNode.onaudioprocess = null;
      this.tapNode = null;
    }
    if (this.sourceNode) { this.sourceNode.disconnect(); this.sourceNode = null; }
    if (this.mediaStream) {
      if (this._ownsStream) this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }
    if (this.rxActive) { this.rxActive = false; this.emit("rx-stop"); }
    this.level = 0;
  }

  onSamples(cb) { this._sampleSubs.add(cb); return () => this._sampleSubs.delete(cb); }

  async listInputs() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      return devs.filter(d => d.kind === "audioinput");
    } catch { return []; }
  }

  async listOutputs() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      return devs.filter(d => d.kind === "audiooutput");
    } catch { return []; }
  }

  /* route TX to a specific output device (rig audio-in). Uses
     AudioContext.setSinkId where the browser supports it. */
  async setOutput(deviceId) {
    this.preferredSink = deviceId || "";
    this.ensureContext();
    if (typeof this.ctx.setSinkId !== "function")
      throw new Error("this browser cannot switch audio outputs (needs Chrome/Edge 110+)");
    await this.ctx.setSinkId(this.preferredSink);
  }

  /* ---------------- TX ---------------- */
  /* Play a Float32Array at the given sample rate. Returns a promise
     that resolves when playback finishes or is aborted. */
  playPCM(samples, sampleRate, samplesRight) {
    return this._playBuf(samples, sampleRate, samplesRight, null, true);
  }

  /* Local monitor playback: identical fidelity path, but into the
     monitor bus — no TX events, no txActive, never down a link. */
  playMonitor(samples, sampleRate, samplesRight) {
    return this._playBuf(samples, sampleRate, samplesRight, null, false);
  }

  _playBuf(samples, sampleRate, samplesRight, _bus, isTx) {
    this.ensureContext();
    if (isTx) this.stopTX();
    const bus = _bus || (isTx ? this.txBus : this.monitorBus);
    return new Promise((resolve) => {
      const nch = samplesRight ? 2 : 1;
      const ctxRate = this.ctx.sampleRate;
      // Browsers resample AudioBuffers with LINEAR interpolation when
      // the buffer rate ≠ the context rate — audibly gritty on pure
      // tones (FSK/FM) and speech. Do it properly ourselves so every
      // buffer we hand the context is already native-rate.
      let L = samples, R = samplesRight;
      if (sampleRate !== ctxRate) {
        L = AudioEngine._resampleOnce(samples, sampleRate, ctxRate);
        if (R) R = AudioEngine._resampleOnce(samplesRight, sampleRate, ctxRate);
      }
      // Overflow trim ONLY: multicarrier buffers (OFDM/QAM, multitone
      // voice) can sum past ±1.0, which the pipe cannot carry — a value
      // beyond full scale isn't a level choice, it's arithmetic
      // overflow. If, and only if, a buffer exceeds ±1.0, one linear
      // volume factor is applied to the whole transmission (waveform
      // shape and constellation linearity untouched). Everything else
      // passes through bit-for-bit; the flat −3 dB pad on the TX bus
      // supplies the everyday headroom.
      let peak = 0;
      for (let i = 0; i < L.length; i++) { const v = L[i] < 0 ? -L[i] : L[i]; if (v > peak) peak = v; }
      if (R) for (let i = 0; i < R.length; i++) { const v = R[i] < 0 ? -R[i] : R[i]; if (v > peak) peak = v; }
      const scale = peak > 1 ? 1 / peak : 1;
      const buf = this.ctx.createBuffer(nch, L.length, ctxRate);
      const c0 = buf.getChannelData(0);
      c0.set(L);
      if (scale < 1) for (let i = 0; i < c0.length; i++) c0[i] *= scale;
      if (R) {
        const c1 = buf.getChannelData(1);
        c1.set(R);
        if (scale < 1) for (let i = 0; i < c1.length; i++) c1[i] *= scale;
      }
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(bus);
      src.onended = () => {
        if (isTx && this.currentTx === src) {
          this.currentTx = null;
          this.txActive = false;
          this.emit("tx-end");
        }
        resolve();
      };
      if (isTx) {
        this.currentTx = src;
        this.txActive = true;
        this.emit("tx-start", { duration: samples.length / sampleRate });
      }
      src.start();
    });
  }

  stopTX() {
    if (this._txStream) {
      const st = this._txStream;
      this._txStream = null;
      st.closed = true;
      st.srcs.forEach(s => { try { s.stop(); } catch (e) {} });
      st.srcs.clear();
      this.txActive = false;
      this.emit("tx-end");
    }
    if (this.currentTx) {
      try { this.currentTx.stop(); } catch { /* already stopped */ }
      this.currentTx = null;
      this.txActive = false;
      this.emit("tx-end");
    }
  }

  /* Gapless streaming TX for LIVE modes (digital voice, live TV…).
     Chunks are scheduled back-to-back on the audio clock with a small
     lookahead, so a main-thread hiccup shifts latency by a few ms
     instead of tearing a hole in the signal. push() chunks as they're
     made; close() lets the tail drain naturally. */
  openTXStream(sampleRate, lookahead = 0.22) {
    return this._openStream(sampleRate, lookahead, true);
  }

  /* Gapless local monitor stream — decoded live voice and other
     hear-it-now audio. Same scheduler, monitor bus, no TX side effects. */
  openMonitorStream(sampleRate, lookahead = 0.22) {
    return this._openStream(sampleRate, lookahead, false);
  }

  _openStream(sampleRate, lookahead, isTx) {
    this.ensureContext();
    if (isTx) this.stopTX();
    const eng = this, ctx = this.ctx;
    const bus = isTx ? this.txBus : this.monitorBus;
    const st = {
      rate: sampleRate,
      when: 0, lead: lookahead,
      srcs: new Set(),
      closed: false,
      
      _rsL: null, _rsR: null,
      /* Stateful cubic conversion to the context rate: carries a
         3-sample history + fractional phase across chunks, so chunk
         boundaries are seamless (per-chunk browser resampling would
         tick at every joint) and long streams never drift. */
      _cvt(chunk, which) {
        if (sampleRate === ctx.sampleRate || !chunk || chunk.length < 4) return chunk;
        const key = which === "R" ? "_rsR" : "_rsL";
        let r = st[key];
        if (!r) r = st[key] = { h: new Float32Array(3), pos: 2, primed: false };
        if (!r.primed) { r.h.fill(chunk[0]); r.primed = true; }
        const N = chunk.length, total = 3 + N;
        const step = sampleRate / ctx.sampleRate;
        const V = (i) => i < 3 ? r.h[i] : chunk[i - 3];
        const out = new Float32Array(Math.ceil((total - 2 - r.pos) / step) + 1);
        let k = 0, pos = r.pos;
        while (pos < total - 2 - 1e-9) {
          const i = Math.floor(pos), f = pos - i;
          const p0 = V(i - 1 < 0 ? 0 : i - 1), p1 = V(i), p2 = V(i + 1),
                p3 = V(i + 2 > total - 1 ? total - 1 : i + 2);
          out[k++] = p1 + 0.5 * f * (p2 - p0 +
            f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)));
          pos += step;
        }
        r.h[0] = V(total - 3); r.h[1] = V(total - 2); r.h[2] = V(total - 1);
        r.pos = pos - (total - 3);
        return out.subarray(0, k);
      },
      push(L, R) {
        if (st.closed || !L || !L.length) return;
        L = st._cvt(L, "L");
        if (R) R = st._cvt(R, "R");
        if (!L.length) return;
        // Overflow trim, downward-latching: if a live modem's samples
        // exceed ±1.0 (arithmetic overflow for the pipe), pick ONE
        // linear factor and keep it for the rest of the stream — the
        // level never pumps and the waveform is never shaped.
        /* RAW OUTPUT: one static −2.5 dB trim, constant from the first
           sample — never a mid-stream gain change. (The old per-chunk
           peak ratchet stepped the level down whenever a hot chunk
           arrived: an audible slip + click on decoded voice. Gone.)
           Values past ±1 after the trim are arithmetic overflow the
           pipe can't carry; they get clamped, nothing gets ridden. */
        L = new Float32Array(L);
        for (let i = 0; i < L.length; i++) {
          const v = L[i] * OUT_TRIM;
          L[i] = v > 1 ? 1 : v < -1 ? -1 : v;
        }
        if (R) {
          R = new Float32Array(R);
          for (let i = 0; i < R.length; i++) {
            const v = R[i] * OUT_TRIM;
            R[i] = v > 1 ? 1 : v < -1 ? -1 : v;
          }
        }
        const buf = ctx.createBuffer(R ? 2 : 1, L.length, ctx.sampleRate);
        buf.getChannelData(0).set(L);
        if (R) buf.getChannelData(1).set(R);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(bus);
        const now = ctx.currentTime;
        if (st.when < now + 0.03) {
          /* first chunk, or a late main-thread tick drained the cushion —
             re-prime a little deeper each time so one busy paint doesn't
             become rhythmic dropouts */
          st.when = now + st.lead;
          st.lead = Math.min(0.45, st.lead + 0.05);
        }
        src.onended = () => {
          st.srcs.delete(src);
          try { src.disconnect(); } catch (e) {}
          if (st.closed && !st.srcs.size) st._done();
        };
        st.srcs.add(src);
        src.start(st.when);
        st.when += L.length / ctx.sampleRate;
      },
      close() {
        if (st.closed) return;
        st.closed = true;
        if (!st.srcs.size) st._done();
      },
      stop() {
        st.closed = true;
        st.srcs.forEach(s => { try { s.stop(); } catch (e) {} });
        st.srcs.clear();
        st._done();
      },
      _done() {
        if (isTx && eng._txStream === st) {
          eng._txStream = null;
          eng.txActive = false;
          eng.emit("tx-end");
        }
      }
    };
    if (isTx) {
      this._txStream = st;
      this.txActive = true;
      this.emit("tx-start", { stream: true });
    }
    return st;
  }

  /* One-shot Catmull-Rom cubic resampler for rendered buffers —
     far cleaner than the linear interpolation browsers apply to
     rate-mismatched AudioBuffers. Edge-padded; caller normalizes. */
  static _resampleOnce(src, from, to) {
    if (from === to || src.length < 4) return src;
    const ratio = from / to;
    const N = src.length;
    const outLen = Math.max(1, Math.round(N * to / from));
    const out = new Float32Array(outLen);
    for (let k = 0; k < outLen; k++) {
      const pos = k * ratio;
      const i = Math.floor(pos), f = pos - i;
      const p0 = src[i - 1 < 0 ? 0 : i - 1];
      const p1 = src[i >= N ? N - 1 : i];
      const p2 = src[i + 1 >= N ? N - 1 : i + 1];
      const p3 = src[i + 2 >= N ? N - 1 : i + 2];
      out[k] = p1 + 0.5 * f * (p2 - p0 +
        f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)));
    }
    return out;
  }


  /* Live keyer for straight-key CW practice: an always-running
     oscillator gated by a click-free gain ramp. */
  makeKeyer(freq = 700, ramp = 0.005) {
    this.ensureContext();
    const osc = this.ctx.createOscillator();
    const gate = this.ctx.createGain();
    gate.gain.value = 0;
    osc.frequency.value = freq;
    osc.connect(gate);
    gate.connect(this.txBus);
    osc.start();
    const self = this;
    return {
      setFreq(f) { osc.frequency.value = f; },
      down() {
        const t = self.ctx.currentTime;
        gate.gain.cancelScheduledValues(t);
        gate.gain.setValueAtTime(gate.gain.value, t);
        gate.gain.linearRampToValueAtTime(1, t + ramp);
        self.txActive = true; self.emit("tx-start", { live: true });
      },
      up() {
        const t = self.ctx.currentTime;
        gate.gain.cancelScheduledValues(t);
        gate.gain.setValueAtTime(gate.gain.value, t);
        gate.gain.linearRampToValueAtTime(0, t + ramp);
        self.txActive = false; self.emit("tx-end");
      },
      dispose() { try { osc.stop(); } catch {} osc.disconnect(); gate.disconnect(); }
    };
  }
}

/* ============================================================
   ToneWriter — phase-continuous synthesis into a growable buffer.
   Everything from CW to SSTV is "write this frequency for this
   long"; keeping one running phase accumulator means no clicks
   and no spectral splatter between segments.
   ============================================================ */
class ToneWriter {
  constructor(sampleRate = 24000) {
    this.sr = sampleRate;
    this.phase = 0;
    this.buf = new Float32Array(sampleRate * 4);
    this.len = 0;
  }
  _ensure(extra) {
    if (this.len + extra <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + extra) cap *= 2;
    const nb = new Float32Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  }
  /* Constant tone. amp 0 writes shaped silence (phase keeps running). */
  tone(freq, durSec, amp = 1) {
    const n = Math.round(durSec * this.sr);
    this._ensure(n);
    const step = 2 * Math.PI * freq / this.sr;
    for (let i = 0; i < n; i++) {
      this.buf[this.len++] = amp * Math.sin(this.phase);
      this.phase += step;
    }
    this.phase %= 2 * Math.PI;
  }
  /* Keyed tone with raised-cosine attack/release — CW that is
     kind to adjacent frequencies. */
  keyedTone(freq, durSec, rampSec = 0.005) {
    const n = Math.round(durSec * this.sr);
    const r = Math.min(Math.round(rampSec * this.sr), n >> 1);
    this._ensure(n);
    const step = 2 * Math.PI * freq / this.sr;
    for (let i = 0; i < n; i++) {
      let a = 1;
      if (i < r) a = 0.5 - 0.5 * Math.cos(Math.PI * i / r);
      else if (i >= n - r) a = 0.5 - 0.5 * Math.cos(Math.PI * (n - 1 - i) / r);
      this.buf[this.len++] = a * Math.sin(this.phase);
      this.phase += step;
    }
    this.phase %= 2 * Math.PI;
  }
  silence(durSec) {
    const n = Math.round(durSec * this.sr);
    this._ensure(n);
    this.len += n; // Float32Array is zero-filled
  }
  /* Frequency-modulated segment: freqFn(t01) returns Hz for the
     normalized position within the segment. Used by SSTV scanlines. */
  fm(durSec, freqFn, amp = 1) {
    const n = Math.round(durSec * this.sr);
    this._ensure(n);
    const twoPiOverSr = 2 * Math.PI / this.sr;
    for (let i = 0; i < n; i++) {
      this.buf[this.len++] = amp * Math.sin(this.phase);
      this.phase += twoPiOverSr * freqFn(i / n);
    }
    this.phase %= 2 * Math.PI;
  }
  /* One symbol of continuous-phase FSK. */
  fskSymbol(freq, symbolSec, amp = 1) { this.tone(freq, symbolSec, amp); }
  /* Amplitude-modulated segment: ampFn(t01) may return negative values,
     which flips the carrier phase — exactly what shaped BPSK needs. */
  am(freq, durSec, ampFn) {
    const n = Math.round(durSec * this.sr);
    this._ensure(n);
    const step = 2 * Math.PI * freq / this.sr;
    for (let i = 0; i < n; i++) {
      this.buf[this.len++] = ampFn(i / n) * Math.sin(this.phase);
      this.phase += step;
    }
    this.phase %= 2 * Math.PI;
  }
  result() { return this.buf.slice(0, this.len); }
  get seconds() { return this.len / this.sr; }
}

/* ============================================================
   Waterfall + spectrum renderer for the dock (and reusable by
   modules that want their own zoomed view).
   ============================================================ */
class Waterfall {
  constructor(engine, { spectrumCanvas, waterfallCanvas, maxFreq = 3000, onHover, onClick }) {
    this.engine = engine;
    this.spec = spectrumCanvas;
    this.wf = waterfallCanvas;
    this.maxFreq = maxFreq;
    this.paused = false;
    this.palette = "phosphor";
    this._lut = this._makeLut("phosphor");
    this._raf = null;
    this._markers = []; // {freq,color,label}
    this.onHover = onHover;
    this.onClick = onClick;

    const hover = (e) => {
      const rect = this.wf.getBoundingClientRect();
      const f = (e.clientX - rect.left) / rect.width * this.maxFreq;
      if (this.onHover) this.onHover(f);
    };
    this.wf.addEventListener("mousemove", hover);
    this.spec.addEventListener("mousemove", hover);
    const click = (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const f = (e.clientX - rect.left) / rect.width * this.maxFreq;
      if (this.onClick) this.onClick(Math.round(f));
    };
    this.wf.addEventListener("click", click);
    this.spec.addEventListener("click", click);

    this._resize = () => this.resize();
    window.addEventListener("resize", this._resize);
    this.resize();
  }

  resize() {
    for (const c of [this.spec, this.wf]) {
      const w = Math.max(300, Math.floor(c.clientWidth));
      if (c.width !== w) {
        // keep waterfall history by copying the old image scaled
        if (c === this.wf && c.width > 0) {
          const tmp = document.createElement("canvas");
          tmp.width = c.width; tmp.height = c.height;
          tmp.getContext("2d").drawImage(c, 0, 0);
          c.width = w;
          c.getContext("2d").drawImage(tmp, 0, 0, w, c.height);
        } else {
          c.width = w;
        }
      }
    }
  }

  setPalette(name) { this.palette = name; this._lut = this._makeLut(name); }
  setMaxFreq(f) { this.maxFreq = f; }
  setMarkers(markers) { this._markers = markers || []; }

  _makeLut(name) {
    const lut = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let r, g, b;
      if (name === "classic") {
        // black → deep blue → cyan → white
        r = t < 0.6 ? 0 : (t - 0.6) / 0.4 * 255;
        g = t < 0.3 ? 0 : Math.min(255, (t - 0.3) / 0.5 * 255);
        b = Math.min(255, t / 0.55 * 255);
        if (t > 0.85) { r = 255; g = 255; }
      } else if (name === "mono") {
        // black → amber
        r = Math.min(255, t * 1.35 * 255);
        g = Math.min(255, t * 0.75 * 255);
        b = t * 0.28 * 255;
      } else {
        // "phosphor": night blue → cyan → amber → white
        if (t < 0.45) { const u = t / 0.45; r = 6 + u * 10; g = 10 + u * 90; b = 22 + u * 130; }
        else if (t < 0.75) { const u = (t - 0.45) / 0.3; r = 16 + u * 239; g = 100 + u * 80; b = 152 - u * 90; }
        else { const u = (t - 0.75) / 0.25; r = 255; g = 180 + u * 75; b = 62 + u * 193; }
      }
      lut[i * 3] = r; lut[i * 3 + 1] = g; lut[i * 3 + 2] = b;
    }
    return lut;
  }

  start() {
    if (this._raf) return;
    const loop = () => { this._raf = requestAnimationFrame(loop); this.draw(); };
    loop();
  }
  stop() { if (this._raf) cancelAnimationFrame(this._raf); this._raf = null; }

  draw() {
    const an = this.engine.analyser;
    const sctx = this.spec.getContext("2d");
    const wctx = this.wf.getContext("2d");
    const W = this.wf.width, WH = this.wf.height, SH = this.spec.height;

    if (!an || !this.engine.rxActive) {
      sctx.fillStyle = "#05070b"; sctx.fillRect(0, 0, W, SH);
      sctx.fillStyle = "rgba(139,149,167,0.6)";
      sctx.font = "12px 'IBM Plex Mono', monospace";
      sctx.fillText("Start audio to see the spectrum", 14, SH / 2 + 4);
      return;
    }

    const bins = an.frequencyBinCount;
    const data = new Float32Array(bins);
    an.getFloatFrequencyData(data);
    const nyquist = this.engine.sampleRate / 2;
    const maxBin = Math.min(bins - 1, Math.floor(this.maxFreq / nyquist * bins));
    const dbMin = an.minDecibels, dbMax = an.maxDecibels;

    /* ---- spectrum ---- */
    sctx.fillStyle = "#05070b";
    sctx.fillRect(0, 0, W, SH);
    // frequency gridlines every 500 Hz
    sctx.strokeStyle = "rgba(96,114,150,0.18)";
    sctx.fillStyle = "rgba(139,149,167,0.75)";
    sctx.font = "10px 'IBM Plex Mono', monospace";
    sctx.beginPath();
    for (let f = 500; f < this.maxFreq; f += 500) {
      const x = f / this.maxFreq * W;
      sctx.moveTo(x, 0); sctx.lineTo(x, SH);
      sctx.fillText(f >= 1000 ? (f / 1000) + "k" : f, x + 3, 11);
    }
    sctx.stroke();
    // trace
    sctx.strokeStyle = "#45c7d6";
    sctx.lineWidth = 1.2;
    sctx.beginPath();
    for (let x = 0; x < W; x++) {
      const bin = Math.floor(x / W * maxBin);
      const v = (data[bin] - dbMin) / (dbMax - dbMin);
      const y = SH - Math.max(0, Math.min(1, v)) * (SH - 4) - 2;
      x === 0 ? sctx.moveTo(x, y) : sctx.lineTo(x, y);
    }
    sctx.stroke();
    // markers (module tuning indicators)
    for (const m of this._markers) {
      const x = m.freq / this.maxFreq * W;
      sctx.strokeStyle = m.color || "#ffb454";
      sctx.setLineDash([4, 3]);
      sctx.beginPath(); sctx.moveTo(x, 0); sctx.lineTo(x, SH); sctx.stroke();
      sctx.setLineDash([]);
      if (m.label) { sctx.fillStyle = m.color || "#ffb454"; sctx.fillText(m.label, x + 4, SH - 5); }
    }

    /* ---- waterfall ---- */
    if (this.paused) return;
    wctx.drawImage(this.wf, 0, 0, W, WH - 1, 0, 1, W, WH - 1); // scroll down
    const row = wctx.createImageData(W, 1);
    const px = row.data;
    const lut = this._lut;
    for (let x = 0; x < W; x++) {
      const bin = Math.floor(x / W * maxBin);
      let v = (data[bin] - dbMin) / (dbMax - dbMin);
      v = Math.max(0, Math.min(1, v));
      const idx = Math.floor(v * 255) * 3;
      const o = x * 4;
      px[o] = lut[idx]; px[o + 1] = lut[idx + 1]; px[o + 2] = lut[idx + 2]; px[o + 3] = 255;
    }
    wctx.putImageData(row, 0, 0);
    // marker ticks on the newest row
    for (const m of this._markers) {
      const x = Math.floor(m.freq / this.maxFreq * W);
      wctx.fillStyle = m.color || "#ffb454";
      wctx.fillRect(x, 0, 1, 3);
    }
  }
}
