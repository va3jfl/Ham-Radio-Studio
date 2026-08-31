# Ham-Radio-Studio
A browser-native digital modes studio for amateur radio. One page, one sound card, every mode a plugin. Think of it as the web answer to Ham Radio Deluxe's digital side plus a HamClock-style dashboard. Running on anything with a modern browser.

**Going public** — safe to host for everyone: station settings (callsign,
grid, lat/lon) are per-browser localStorage. `api/settings.php` refuses
server-side persistence unless you deliberately flip `HRWS_SINGLE_OP` to
`true` for a private single-operator install. If an older build ever ran on
your server, delete `data/settings.json` once — it may still hold a callsign
and location. The other PHP endpoints hold no user settings: `solar.php`
caches public NOAA data, `link.php` keeps transient Online-Link room blobs
with a TTL sweep, `modules.php` is read-only.

## Working Today

The following features are currently implemented and working in the browser:

### 📻 Analog & HF Digital Modes

* **CW**

  * Encode + live decode
  * Straight-key practice

* **RTTY**

  * 45.45 Bd encode + decode

* **PSK31**

  * Encode
  * Experimental decode with vector scope

* **SSTV**

  * Martin M1 / M2
  * Scottie S1
  * Proper VIS headers
  * Full SSTV studio
  * Time-compressed transmission
  * WAV render / decode for working from recordings

* **FT8 — Beta**

  * Slot clock
  * Signal capture
  * Costas synchronization detection

---

### 📺 NBTV — Mechanical Television

A full NBTV transmitter/receiver supporting **15 standards**, ranging from historical Baird systems to modern experimental formats:

* Baird 30-line through 480-line standards
* Monochrome
* Frame-sequential
* Line-sequential
* Stereo Y/C colour
* Authentic low-pass output filters
* Live webcam sources
* Video and animated-GIF sources
* AM sound-in-vision subcarrier for **true talkies**

  * Audio rides with the television signal
  * RX decodes both picture **and speaker audio**
* File transfer as a carousel of QR-code frames
* WAV render / decode
* Live TX + RX processing

---

### 🖼️ Digital SSTV — HRWS-D1

**Pixel-perfect image transmission over SSB.**

* FEC-protected image transport
* Live stripe-by-stripe reception
* Repeat-pass repair
* Progressive image reconstruction

#### Audio Postcards

15-second voice recordings are encoded into a **320 px VREC-mini virtual vinyl record**:

* μ-law audio samples represented as pixel brightness
* Samples follow a real spiral-groove geometry
* Byte-exact transmission
* Optical needle-style pixel decoding in real time
* Mini turntable playback
* Saved postcard PNGs are genuine VREC records
* VREC Studio can play saved postcards directly

---

### 🎞️ Digital Moving Television — HRWS-D3

Delta-coded moving television built on the HRWS-D1 transport:

* 1–2 FPS
* Delta-coded D1 stripes
* 4-FSK / 500 Bd
* K=7 Viterbi decoding
* Only changed **16×16 blocks** are transmitted
* INTRA and DELTA frames
* Shared-picture delta reference
* Walking INTRA refresh for self-healing after losses
* Live webcam input
* Looping video
* Moving test-card sources
* Per-block TX send flashes
* Live RX per-block freshness map
* Replay at received pace
* Session headers every 5 seconds for late joiners
* WAV input / output
* Channel-simulation loopback laboratory

---

### 🎹 MIDI Link — HRWS-M1

Live MIDI transmission over SSB using 5- and 10-second bars.

* Receiver buffers one bar
* Seamless reconstructed playback
* Hand-built browser General MIDI synthesizer
* 14 instrument families
* All 128 MIDI programs
* Drum kit
* Bar headers transmitted through the Viterbi chain
* Fixed-width MIDI records
* **No FEC on note records by design**

The result is intentionally different from conventional error correction: noise can make the music **slur, drift and misbehave** rather than simply disappearing — the **"drunk orchestra"** effect.

Bench-tested levels:

* **0 dB:** sober
* **−4 dB:** drunk
* **−8 dB:** lights-out

#### Armour Mode

An alternate error strategy:

* Drops corrupted notes rather than slurring them
* Approximately half the notes survive under heavy impairment

Also includes:

* Piano-roll TX/RX views
* Drunk-note visual rings
* Loudest-win thinning
* Save-what-you-heard `.mid` export
* WAV input / output
* Loopback laboratory

---

### 📡 QAM File Link

One-way OFDM/QAM file transfer based on a port of the **audiomodem DMT engine**.

An 8-profile modulation ladder supports everything from extremely narrow CW-filter channels to high-bandwidth stereo cable links:

| Profile               |       Approx. Throughput |
| --------------------- | -----------------------: |
| 500 Hz CW-filter mode |              ~0.5 kbit/s |
| HF SSB 2.4 kHz        |                        — |
| NBFM voice            |                        — |
| 9k6-jack FM           |                        — |
| WBFM 15 kHz           |               ~54 kbit/s |
| Stereo-bonded cable   |              ~179 kbit/s |
| 96 kHz                |              ~422 kbit/s |
| 192 kHz / 4096-QAM    | **~1.3 Mbit/s measured** |

Features:

* OFDM/QAM file transfer
* 8-profile rate ladder
* RS(255,223) FEC
* Callsign beacon lock
* Live constellation display
* Live segment map
* Repeat-pass repair

---

### 🗺️ APRS Soundcard Station

Full browser-based AFSK APRS station:

* 1200-baud AFSK
* Position beacons
* Custom symbol
* Comment field
* Automatic beaconing
* Messaging
* Automatic ACK
* Status packets

RX decoding supports:

* Plain APRS
* Compressed position
* Mic-E
* Object reports

Decoded stations appear in:

* Station table
* Radar plot
* Distance / bearing display relative to your coordinates

---

### 🎙️ Digital Voice

Three native **HRWS-DV** modes plus real FreeDV interoperability.

#### HRWS-DV Native Modes

* LPC vocoder

  * 1600 bit/s
  * 2600 bit/s
  * 3200 bit/s
* Golay protection for critical bits
* 22-carrier DQPSK / D8PSK

  * Designed for SSB or FM voice channels
  * ±10 Hz tuning tolerance
* 4FSK / 2000 Bd

  * Designed for the 9k6 data jack

#### REAL FreeDV Compatibility

Uses the actual **libcodec2 1.2.0** compiled to WebAssembly:

* 700D
* 700E
* 1600
* 700C
* Encode + decode
* Interoperability with FreeDV GUI stations on the air

#### Unified Voice Controls

All voice modes operate behind a single PTT interface:

* Large unified PTT
* PTT LOCK
* VOX
* Adjustable VOX threshold
* 700 ms VOX hang
* Half-duplex switching
* FreeDV SNR squelch
* Voice WAV → DV WAV
* DV WAV decode
* Loopback laboratory
* Built-in self-test

---

### 🌐 Online Link

Connect two browser-based studios **browser-to-browser** using hi-fi stereo Opus.

Any supported mode can be transmitted through the online link:

* Transmit from any browser tab
* TX automatically follows the active studio
* Decoded playback remains local
* RX audio never echoes back through the link
* Audio flows peer-to-peer rather than through the server

#### Channel Simulation

Includes a complete simulated radio channel:

* Noise
* QSB
* QRN
* Hum
* Virtual-rig propagation mode
* Live NOAA solar-data-driven conditions
* Solo loopback mode for simulated-band practice

---

### 🌎 Radio Tools & Instrumentation

* Grayline map
* NOAA solar / geomagnetic panel
* Band-condition estimates
* World clocks
* Maidenhead grid tools
* Live spectrum analyzer
* Live waterfall
* Click-to-tune

---

## Architecture

**All DSP runs directly in the browser** using the Web Audio API.

The server side is intentionally minimal.

PHP is used for exactly **four** functions:

1. **Module/plugin discovery**
2. **Settings persistence**
3. **NOAA data proxy/cache**
4. **Online Link connection handshake relay**

The actual Online Link audio does **not** pass through the PHP server — once the connection is established, audio flows **peer-to-peer** between the browsers.

> **Browser does the radio. PHP just handles the glue.**

## Quick start (Windows + XAMPP)

1. Copy the `ham-radio-web-studio` folder into `C:\xampp\htdocs\`.
2. Start Apache in the XAMPP control panel (PHP 7.4+ — any recent XAMPP is fine).
3. Open `http://localhost/ham-radio-web-studio/` in Chrome, Edge or Firefox.
4. Click **Start audio** in the top bar and allow microphone access.
5. Toggle a module in the sidebar and play.

On Linux it's the same story: drop the folder into your web root (e.g. `/var/www/html/`), make sure `data/` is writable by the web server (`chown -R www-data data` or `chmod 775 data data/cache`), done. No database, no composer, no build step.

It even mostly works with **no server at all** — open `index.html` directly and the app falls back to a built-in module list and localStorage settings. You lose the solar proxy and hot-plug module discovery, that's it.

## The one gotcha: microphone access needs a secure context

Browsers only allow audio *capture* on `https://` pages, on `localhost`, or on pages opened **straight from disk** (`file://` — that's why single-file audio tools work with a double-click and no server at all). So:

* On the machine running XAMPP → `http://localhost/...` works out of the box.
* From your phone/tablet on the LAN → `http://192.168.x.x/...` will show the page, transmit audio, and run the dashboard, but the browser will refuse the microphone. Fixes, easiest first:
  * Enable Apache's SSL in XAMPP (it ships with a self-signed cert; accept the warning once) and use `https://192.168.x.x/...`.
  * Or, for a quick test in Chrome: `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add your URL. (Exactly what it says on the tin — test use only.)
  * Or put it behind any reverse proxy that terminates TLS.

Transmit-only use (SSTV from a tablet to a rig, say) needs no microphone and works over plain HTTP anywhere. The same goes for the whole 🌐 Online Link: its TX audio is synthesized inside the page and its RX arrives as a WebRTC track through a virtual input — no microphone anywhere in that path — so linking two studios, the conditions simulator and the 🧪 loopback all run fine on plain `http://`. The only thing that ever needs `localhost`/HTTPS is capturing *real radio audio* through a sound-card input.

## Hooking up a radio

Rig audio out → computer line-in/mic. Computer audio out → rig data/mic in (through an isolation transformer or a SignaLink-style interface if you have one). Set levels so the RX meter sits in the cyan, keep TX drive low enough that your rig's ALC barely moves. There is no CAT/PTT control yet (see roadmap) — use VOX or manual PTT for now, and mind your band plan: the FT8 module's test signal is for speaker-to-microphone loopback only, never for the air.

## Online Link — two studios over the internet (or one, in a mirror)

The 🌐 **Online Link** module connects two copies of the studio so that **anything one side transmits — CW, SSTV, QAM files, digital voice, all of it — comes out of the other side's decoders**, without either of you touching a real band.

How it actually flows: your TX audio is tapped from the shared TX bus, run through the **conditions channel** (see below), then sent to your friend as a **direct browser-to-browser WebRTC Opus stream** pinned at its hi-fi ceiling (48 kHz stereo, 320 kb/s, FEC on, DTX off — data modes survive intact). The PHP backend never carries audio; `api/link.php` only relays the few-KB connection handshake through tiny JSON files in `data/rooms/`, then gets out of the way.

**Using it:**

1. One side clicks **Create link** and sends the URL (`…/?join=ABC123`) to a friend by any means.
2. The friend opens it — the studio auto-joins. Within a few seconds the status line reads CONNECTED and audio is flowing.
3. Pick sides: one **TX**, one **RX**. The RX side's sidebar *Input* switches to **🌐 Online link** automatically (or press *Route link → decoders*), so every mode tab hears the friend. Swap roles any time; there's a chat strip for coordination.
4. Now go use the mode tabs exactly as if you were on the air.

**The channel between you** has three settings:

* **Direct patch** — clean pipe, nothing added. The "just work" button.
* **Manual** — you pour in the muck: band-noise SNR, slow two-tone QSB with optional auroral flutter, QRN static crashes, mains hum, and an RX passband (CW 500 Hz … FM wide). Presets from *Quiet band* to *Brutal*. This is the lab for answering "how much abuse does PSK31 really take vs SSTV?"
* **Full simulation** — both ends dial a **virtual rig**: a wheel-tunable VFD frequency display (160 m–23 cm), mode, TX power from 1 mW to a gloriously silly 10 MW (badged QRP / legal limit / FANTASY 🔥), antenna gain and height, and your location from Settings (grid or lat/lon, overridable per rig). The module pulls **live NOAA solar data** through the existing `api/solar.php` and computes the path once a second: distance and bearing, hops, midpoint foF2 and MUF, D-layer absorption by daylight, Kp storm losses, skip zones, VHF/UHF radio horizon with troposcatter beyond, seeded per-day band variance and sporadic-E rolls — then sets the audio channel's SNR/fading to match and drives an S-meter. Off-frequency VFOs = no copy, so zero-beating each other is part of the game.

The propagation model is a *teaching* model, not VOACAP — but it fails and opens for the correct reasons: 80 m dies at midday and opens to S9 at night, 10 m needs solar flux, 20 m has a short-skip hole, 2 m stops at the horizon until you throw fantasy kilowatts at troposcatter. The notes under the path readout tell you *why*, and what it would take ("for S9 you'd need ~4.2 kW — or wait for darkness").

**No friend online?** Two solo options: the path planner accepts a fictional *Station B*, and the sidebar Input offers **🧪 Conditions loopback** — your own TX through the simulated channel and back into your own decoders. TX an SSTV image from one tab, watch it arrive snowy in the same tab. No band was harmed.

Practical notes: the link itself has **no HTTPS requirement** — TX audio is synthesized in the page and RX arrives as a WebRTC track, so no microphone permission is involved and plain `http://` hosting works (only capturing real radio audio through a sound card hits the browser's localhost/HTTPS rule — see the gotcha section above). One thing every browser does on its own, non-optionally: WebRTC media is always carried with the browser's built-in DTLS-SRTP — that's baked into the WebRTC standard itself and applies to the internet leg only; nothing here ever transmits on the air. `data/` must be writable by PHP (it already is if settings save). The audio path is peer-to-peer via public STUN — two home connections almost always link up, but a symmetric-NAT pair (some corporate/CG-NAT setups) may fail since there is deliberately no TURN relay. Anyone with the URL can take the free slot while the room lives (rooms expire after ~6 h idle), so share it like a phone number, not a secret. And the obvious: the internet link is a practice ground, not amateur radio — when you go to a real band, all your regular license and identification rules apply.

## Architecture

```
index.html            app shell
css/studio.css        the whole look
js/dsp.js             Goertzel, FFT, resampler, grid math (pure functions)
js/audio-engine.js    AudioEngine, ToneWriter (synthesis), Waterfall
js/dashboard.js       clocks, grayline, solar, bands, grid tool
js/app.js             HRWS core: settings, tabs, module loader, log
api/modules.php       scans modules/*/manifest.json → JSON
api/settings.php      GET/POST data/settings.json
api/solar.php         NOAA SWPC aggregator with on-disk cache
api/link.php          Online Link signaling relay (rooms in data/rooms/)
modules/<id>/         one folder per mode = one plugin
data/                 settings + cache + link rooms (blocked from the web by .htaccess)
```

## Writing a module

A module is a folder in `modules/` with two files. Drop it in, reload, it appears in the sidebar — `api/modules.php` finds it automatically.

`modules/hell/manifest.json`

```json
{
  "name": "Hellschreiber",
  "icon": "𝍌",
  "description": "Feld Hell fuzzy text",
  "version": "0.1.0",
  "order": 6,
  "entry": "module.js"
}
```

`modules/hell/module.js`

```js
(function () {
  HRWS.registerModule({
    id: "hell",                       // must equal the folder name

    init(ctx) {                       // once, after script load
      this.ctx = ctx;
    },

    createPanel(el) {                 // build your UI (each activation)
      el.innerHTML = `<div class="card"><div class="card-foot">
        <button class="btn btn-accent" id="hell-beep">Beep</button>
      </div></div>`;
      el.querySelector("#hell-beep").addEventListener("click", () => {
        const tw = new ToneWriter(12000);   // phase-continuous synth
        tw.keyedTone(900, 0.3);
        this.ctx.audio.playPCM(tw.result(), 12000);
      });
    },

    onActivate() {                    // optional
      // live decoding? tap raw RX samples:
      this.unsub = this.ctx.audio.onSamples((samples, sampleRate) => {
        // feed a DSP.Goertzel, your own FFT, anything
      });
      this.ctx.setMarker({ freq: 900, color: "#7bd88f", label: "HELL" });
      this.offTune = this.ctx.onTune(f => { /* waterfall was clicked at f Hz */ });
    },

    onDeactivate() {                  // ALWAYS release your taps here
      if (this.unsub) this.unsub();
      if (this.offTune) this.offTune();
      this.ctx.setMarker(null);
    }
  });
})();
```

Everything a mode needs is handed to it in `ctx`: the shared `audio` engine (RX taps, `playPCM`, `makeKeyer`), the `dsp` toolkit, `log()`, `settings()` for callsign/grid, `onTune()` for click-to-tune, and `setMarker()` for dock markers (pass an array for multiple lines, like RTTY's mark/space pair). Build UIs from the shared classes in `studio.css` — `card`, `rx-screen`, `tx-area`, `mod-layout`, `kv-list` — and new modes automatically look like they belong.

## Module status

| Module | TX | RX | Notes |
|---|---|---|---|
| Hellschreiber | ✔ standard Feld Hell keying (2.5 chars/s, 245 half-pixels/s, shaped raised-cosine edges, original paired-half-dot 7×7 font) | ✔ quadrature envelope printer with the classic asynchronous double-line display, contrast AGC, scan invert, noisy self-test loopback | validated: timing exact to 17.500 columns/s, 94% pixel fidelity through noise in the Node harness — the remaining fuzz is the authentic Hell look |
| VLF Radio | ✔ carrier / CW / QRSS keying for magnetic-induction experiments (keyer-scheduled, any dot length, zero memory) | ✔ full-band soundcard-SDR spectrum + waterfall, click-to-tune Weaver demod (CW/USB/LSB/AM, 12th-order I/Q filtering, 55–65 dB sideband rejection), mains-hum comb, station guide from Alpha and the MSK fleet to SAQ and the 60/77.5 kHz time stations | the soundcard *is* the radio below Nyquist; 96/192 k device rates unlock the time-station band; sub-9 kHz note and induction-range honesty included |
| Help | — | — | The in-app manual: what the studio is, how the engine works, first-time setup, a detailed guide to every mode, real-radio hookup, troubleshooting, on-air rules, and full credits (VA3JFL ports, Codec 2/FreeDV, G3PLX, VE3NEA, K1JT/K9AN, WB4APR, vendored QR libs, NOAA, and friends) |
| Online Link | ✔ taps the shared TX bus, conditions it (direct / manual noise·QSB·QRN·hum / full propagation sim), streams hi-fi Opus peer-to-peer via WebRTC | ✔ registers a 🌐 virtual input so any decoder hears the remote studio; auto-routing, monitor volume, peer S-meter mirror | PHP relays only the handshake (`api/link.php`), audio never touches the server; virtual rigs (VFD tuning 160 m–23 cm, 1 mW–10 MW, antennas, locations) + live NOAA solar drive a teaching propagation model with per-day seeded variance; 🧪 loopback input = solo practice through your own simulated channel; STUN only (no TURN), rooms expire after 6 h idle |
| CW | ✔ 5–45 WPM, shaped keying, prosigns | ✔ adaptive live decoder | straight-key practice with Ctrl |
| RTTY | ✔ 45.45 Bd, 170/425/850 shift | ✔ dual-Goertzel + software UART | USOS, reverse |
| PSK31 | ✔ full varicode, shaped reversals | ◐ experimental (loopback-solid) | vector scope, mild AFC |
| SSTV | ✔ Martin M1/M2, Scottie S1/S2, Robot 36/72 with VIS, time-compression 1-8x (FM turbo SSB-safe / resample wideband), VOX keying header, callsign overlay, channel-sim loopback, WAV render | ✔ VIS detect, PLL sync tracking with slant + wander correction, factor/method auto-detect, live VOX-armed capture with level meter, WAV import at the file's own rate, jitter repair + NLM denoise + optional sharpen | port of "Experimental SSTV Studio" (Python) by VA3JFL; both ends need the scheme above 1x — at 1x it is plain SSTV; on-air spectrogram scope; self-test button |
| Digital SSTV | ✔ HRWS-D1: mini-JPEG (YCbCr 4:2:0, quality-scaled DCT) over 4-FSK 500 Bd (800–2300 Hz, 1000 bps raw), K=7 rate-½ convolutional FEC, per-packet sync + per-stripe CRC-32, 1–3 repeat passes, VOX keying header, callsign overlay, channel-sim loopback, WAV render, Audio Postcards (VREC-mini μ-law vinyl pressings sent as raw groove bytes, mini turntable with live optical pickup (per-sample pixel reads \u2014 the tonearm tracks the groove inward and an under-the-stylus strip shows the exact pixels being decoded, repainting live while a postcard is still arriving), draggable tonearm, scratching, desktop-VREC-compatible PNG export; received postcards auto-play on the deck while their chunks land, any saved disc PNG loads back onto the platter via Load disc PNG, and a Play-on-deck button appears beside every received postcard; the disc is clipped to the vinyl so only the record turns; the pickup pump is audio-clock paced, fed from both rAF and a timer, and reports any fault on the deck's own info line; the deck now runs at 48 kHz with a proper reconstruction filter (interpolation images buried \u2265 28 dB, measured), reads ANY real VREC pressing natively \u2014 any size, any pitch/step, v1 \u03bc-law or v2 16-bit PCM, so discs from the desktop VREC Studio play here lossless \u2014 and the press card gained \u2460 Load audio\u2026 so music files skip the microphone entirely; playback is VREC-transparent by default (the groove bytes and nothing else \u2014 the vintage hiss/pops/rumble are an opt-in Surface noise checkbox); saved pressings are circular PNGs with transparent corners \u2014 on the air only the 12-byte header and the raw groove bytes ever fly, never pixels) | ✔ soft-decision Viterbi, per-packet timing re-lock (immune to clock drift), live stripe-by-stripe paint, repeat passes repair lost stripes, VOX-armed live capture, WAV import at the file's own rate | experimental mode designed for this studio — both ends need it; images arrive **bit-exact** (verified through SSB 2.7 kHz at 8 dB SNR); identify per your regulations; self-test button |
| HRWS-D3 | ✔ moving TV over SSB: conditional replenishment on the D1 chain (4-FSK 500 Bd, K=7 Viterbi, per-packet sync + CRC-32), per-frame block bitmap, INTRA/DELTA per 16×16 block with a closed-loop encoder reference, walking oldest-first INTRA refresh, mono or 4:2:0 colour at 64×48 / 96×64 / 128×96, 0.5–2 fps targets with graceful overrun (rate floats before the picture breaks), live webcam / video-file / moving-test-card sources, streaming TX with 1900 Hz pacing filler, WAV render | ✔ streaming receiver (per-packet timing re-lock over a rolling buffer — drift can't accumulate), late join via 5 s session headers, per-block freshness map, fps/net meters, replay-at-received-pace, WAV decode, live listen with squelch | NBTV's great-grandchild — H.261's forced-update idea at 0.5 kbit/s; measured: ~1 fps soft webcam @ 64×48 (2–3 blk/frame), ~1.5 fps in the 2 fps setting, RX **bit-exact** with the encoder's closed loop through SSB 2.4 kHz at 6 dB SNR in tests; losses appear as stale blocks and heal in one refresh sweep; both ends need this studio; self-test button |
| MIDI Link | ✔ HRWS-M1: score → 5/10 s bars → D1 packets; protected bar headers (segment idx, program table) + fixed-width 5-byte note records (t·dur·pitch·vel·ch, 5 ms ticks) sent RAW by design — or through full K=7 FEC in Armour mode; honest capacity ≈ 20 notes/s bare / ≈ 11 armoured; loudest-win thinning; SMF 0/1 reader (tempo map, running status) + writer; built-in demo band; local audition | ✔ streaming receiver, one-bar playback buffer (latency ≈ bar + 1.5 s), late join, notes-before-header held and flushed, hand-rolled Web Audio GM synth, piano roll with drunk-note rings, save-as-.mid of exactly what was heard | the drunk-orchestra experiment: bit errors are trapped in single note fields, so the bench ladder reads sober ≥ 0 dB SNR → 15 wrong notes at −4 (headers perfect) → 94 at −6 → collapse at −8; Armour never plays a wrong note; practical use: none, gloriously; both ends need this studio; self-test button |
| QAM File Link | ✔ one-way OFDM/DMT file transfer: 8 band profiles (SSB narrow 500 Hz · HF SSB 2.4 kHz · FM voice 3 kHz · FM data 6.5 kHz · WBFM 15 kHz · cable 18 kHz stereo · HiFi 96 kHz stereo · ultra 192 kHz stereo), QPSK–4096-QAM, RS(255,223) column-interleaved FEC, MPX subband diversity, callsign beacon, 1–3 repeat passes, stereo-bond WAV render | ✔ Schmidl-Cox + quadrature matched-filter acquisition, Moose carrier-offset estimator (±47 Hz, SSB profile), per-bin equalizer with pilot phase/SFO tracking + closed-loop resampler, live constellation, SNR/drift/CFO meters, torrent-style segment map, auto file download with CRC-32 verify and image preview | port of the DSP core of "audiomodem" (Python) by VA3JFL, ARQ/IP layers replaced by a simplex beacon → voice-confirm → SEND flow; measured in tests: 0.5 kbit/s @ 500 Hz → 6.9 kbit/s FM voice 16-QAM @ 22 dB → 54 kbit/s WBFM → 179 kbit/s bonded cable → 1.3 Mbit/s ultra 4096-QAM @ 50 dB; long simplex frames (no ARQ latency cap) beat the duplex build's per-direction throughput; both ends need this studio; identify per your regulations; self-test button |
| APRS | ✔ Bell 202 AFSK 1200 Bd, AX.25 UI frames with HDLC bit-stuffing and CRC-16/X-25, position beacons (symbol, comment, digi path, auto-beacon 1–30 min), status, messages with sequence numbers and automatic ACK of incoming messages, beacon WAV render | ✔ dual-slicer demod (per-tone AGC + flat) with quadrature correlators, transition-locked DPLL bit timing at any soundcard rate, decodes plain / timestamped / compressed / Mic-E / object position reports, messages, acks and status into a station table (distance + bearing from your entered coordinates) and a range-ring radar plot, monitor log, WAV file decode, loopback lab with SNR and emphasis-twist controls | enter your latitude/longitude in the module first — they drive the beacon and the radar; no digipeating or IGate (off-grid by design); key the rig with VOX or manual PTT; survives ±9 dB twist at 12 dB SNR and ±300 ppm clock offset in tests; identify per your regulations; self-test button |
| Digital Voice | ✔ HRWS-DV native: LPC-10 vocoder (LSF quantization, pitch, mixed excitation with 4-band voicing on the top mode) at 1600 / 2600 / 3200 bit/s in 40 ms superframes, Golay(24,12) on the 12 perceptually critical bits, modems: 22-carrier + pilot differential QPSK/8PSK at 50 Bd in 600–2700 Hz (fits any SSB or FM voice channel) or 4FSK 2000 Bd for the FM 9k6 data jack; ✔ FreeDV compatibility TX: real freedv_api (libcodec2 1.2.0 WASM) for 700D / 700E / 1600 / 700C | ✔ native RX: pilot-coherence acquisition (locks in ≤160 ms), pilot-derived common-phase correction (±10 Hz mistuning), marker flywheel framing, per-frame quality gating with error concealment (FEC repair → repeat-and-fade → mute); ✔ FreeDV RX: the genuine modem + LDPC + Codec 2 decode with sync and SNR readout — decodes real hams | big PTT (hold), PTT LOCK toggle, VOX with threshold slider and 700 ms hang; half duplex (RX mutes while transmitting, TX tail flushed on key-up); voice WAV → DV WAV and DV WAV → voice decode; loopback lab with truthfully-calibrated SNR; self-test covers all 7 modes (native @ 14/20/16 dB, FreeDV 700D at 4 dB SNR); SNR squelch knob for the FreeDV modes (freedv-gui-style per-mode defaults, 700D at −2 dB, live-adjustable while armed and honored by WAV decode and loopback); the ~1.9 MB FreeDV engine loads lazily only when a compatibility mode is selected; identify per your regulations |
| FT8 | tune + loopback test only | ◐ Costas sync detector | LDPC message decode is the big roadmap item |
| NBTV | ✔ 15 standards, mono/FSC/LSC/stereo Y-C, FIR output filters, webcam, video/animated-GIF sources with soundtrack talkies over an AM sound-in-vision subcarrier (mic commentary too), QR file TX, offline WAV render | ✔ flywheel sync decoder + QR file RX with CRC32 verify, sound-in-vision RX (TV-style carrier plan: video guarded below the carrier, fractional-delay comb demod, always-on picture notch, coherence squelch), live in-page TX→RX loopback with every control adjustable while it runs, WAV import at the file's own rate | signal-, file- and WAV-compatible with NBTV Studio (Python) by VA3JFL — the sound subcarrier is an HRWS extension that leaves the picture reference-compatible; 96/192 kHz option for the wideband X-modes; self-test button |

## Roadmap

Near term: FT8 LDPC(174,91) decode + 77-bit message unpack (the hook is marked in `modules/ft8/module.js`), SSTV receive, PSK31 weak-signal hardening, WEFAX. Then: an ADIF logbook module, CAT/PTT via Web Serial (works in Chromium on the same localhost/HTTPS rule), DX cluster over a small PHP websocket bridge, Feld Hell, Olivia/Contestia — and yes, eventually a playground for inventing brand-new browser-native modes. (The moving-television entry that used to sit on this list shipped as HRWS-D3.) The plugin system is the point: each of these is a folder, not a fork.

## Credits & data sources

Solar and geomagnetic data: NOAA Space Weather Prediction Center (public feeds, cached locally out of politeness). Coastlines: `world-atlas` (Natural Earth data) via jsDelivr, with a built-in stylized fallback for offline shacks. Fonts: Chakra Petch, IBM Plex Mono and Inter (Google Fonts, all open licenses) with system fallbacks. The NBTV module is a JavaScript port of the signal format and QR file-link protocol from **NBTV Studio** (Python) by VA3JFL — the two decode each other's pictures and files. Its QR frames are encoded with **qrcode-generator** (MIT, Kazuhiko Arase) and read with **jsQR** (Apache-2.0), both vendored in `modules/nbtv/vendor/` so the shack stays offline-friendly. Everything else is hand-rolled, dependency-free JavaScript.

## License

MIT — see `LICENSE`. Use it, fork it, bring it to Field Day. 73!

## FreeDV engine — license and rebuilding

`modules/digivoice/freedv.js` embeds **libcodec2 1.2.0** — Codec 2 and the
FreeDV modems by **David Rowe VK5DGR and contributors** — compiled to
WebAssembly. libcodec2 is licensed under the **LGPL-2.1**; source:
<https://github.com/drowe67/codec2>. The rest of this studio is unaffected;
the engine ships as a separate file that is only fetched when a FreeDV
compatibility mode is selected, and can be replaced or rebuilt independently.

To rebuild `freedv.js` from source on Ubuntu 24:

```
apt install cmake clang lld wasi-libc libclang-rt-15-dev-wasm32
git clone --branch 1.2.0 https://github.com/drowe67/codec2
# toolchain file: wasm32-wasi via clang (see wasi.cmake in the repo notes)
cmake -S codec2 -B build_wasm -DCMAKE_TOOLCHAIN_FILE=wasi.cmake \
      -DCMAKE_BUILD_TYPE=Release -DUNITTEST=OFF -DBUILD_SHARED_LIBS=OFF
cmake --build build_wasm --target codec2
clang --target=wasm32-wasi -O2 -mexec-model=reactor fdv_wrapper.c \
      build_wasm/src/libcodec2.a -lm -o freedv.wasm -Wl,--export=fdv_open ...
# then base64-embed freedv.wasm into the UMD loader (freedv.js header
# documents the exports; codec2's CMake auto-builds the native
# generate_codebook when cross-compiling, so no extra steps)
```

73, and thanks to the FreeDV project for keeping digital voice open.
