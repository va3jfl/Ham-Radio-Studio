/* ============================================================
   Ham Radio Web Studio — Help module
   The operator's manual, one tab away: getting started, a tour
   of the screen, every mode explained control by control, fixes
   for common problems, and the credits owed to the people whose
   work this studio stands on.
   ============================================================ */
"use strict";

(function () {

  const SECTIONS = [

  /* ==================== GETTING STARTED ==================== */
  { id: "welcome", group: "Getting started", icon: "👋", title: "Welcome", tag: "start here", html: `
    <p>This is a complete amateur-radio digital-modes station that runs right here in your
    browser. Nothing to install, nothing to download — every mode you see in the sidebar is
    ready to transmit and receive the moment you open its tab.</p>
    <p>You can use it three ways: <b>with a real radio</b> (two audio cables or a USB interface
    turn any rig into a full digital station), <b>with a friend over the internet</b> (the
    🌐 Online Link connects two people so anything one transmits, the other decodes — pictures,
    Morse, files, voice), or <b>completely alone</b> (every mode has a loopback that feeds your
    own transmission back into your own decoder, through a simulated noisy band if you like).
    You can learn and play for hours without owning a radio or holding a license.</p>
    <p>Everything happens on your own machine. Your station settings — callsign, grid, location — live in your own browser's storage: on a shared public server, every visiting ham keeps their own, and nothing you type can override anyone else's. Your audio isn't uploaded anywhere — even when
    you're linked with a friend, the sound travels directly between your two browsers.</p>` },

  { id: "quick", group: "Getting started", icon: "▶", title: "Quick start", tag: "2 minutes", html: `
    <ol class="hlp-steps">
      <li><b>Tell the studio who you are.</b> Click the gear (top right) and enter your callsign
      and location — your Maidenhead grid square if you know it, or press <i>Use my location</i>
      and it's worked out for you. No callsign yet? Anything works for practicing; you only need
      a real one when a real transmitter is involved.</li>
      <li><b>Press “Start audio”</b> in the sidebar. Your browser will ask permission to use the
      microphone — click <b>Allow</b>. The RX light comes on, the level meter moves, and the
      waterfall at the bottom starts painting whatever your chosen input hears.</li>
      <li><b>Pick your input and output</b> in the sidebar's Audio card if the defaults aren't
      right — a line-in from a radio, a USB interface, or one of the special entries:
      <b>🌐 Online link</b> (your friend's audio) and <b>🧪 Conditions loopback</b> (your own
      transmissions, fed back to you).</li>
      <li><b>Open a mode tab</b> from the Modules list and you're on the air — or on the wire,
      or just talking to yourself, which in this hobby is called <i>testing</i>.</li>
    </ol>
    <p class="muted">The studio remembers your settings and open tabs for next time.</p>` },

  { id: "screen", group: "Getting started", icon: "🗔", title: "Around the screen", tag: "the tour", html: `
    <h4>Top bar</h4>
    <p><b>RX</b> glows while the studio is listening, <b>TX</b> while it's transmitting, and
    <b>LINK</b> when you're connected to a friend online. Your callsign and grid sit next to the
    settings gear.</p>
    <h4>Sidebar — Audio</h4>
    <p>Input and output pickers, the <i>Start audio</i> button, a receive level meter, and the
    <b>TX gain</b> slider — the master volume of everything the studio transmits. If a radio is
    connected, set it so the rig's ALC meter barely moves (more on that in the radio section).</p>
    <h4>Sidebar — Modules</h4>
    <p>Click a mode to open or close its tab. You can keep several open at once; they all listen
    to the same audio, so three decoders can chew on the same signal side by side.</p>
    <h4>The waterfall (bottom of the screen)</h4>
    <p>A live picture of everything your input hears — time scrolls, frequency runs left to
    right, brightness is signal strength. <b>Click anywhere on it to tune</b>: the open mode's
    decoder jumps to that exact spot, and each mode draws a small colored <b>marker</b> showing
    where it's listening or transmitting. The readout shows the frequency you clicked; the
    palette menu is purely a matter of taste.</p>
    <h4>Dashboard</h4>
    <p>The home tab: your station card, live <b>solar &amp; geomagnetic numbers</b> from NOAA
    (sun activity decides which shortwave bands are open), a plain-language <b>band conditions</b>
    table, the <b>grayline map</b> showing where on Earth it's day and night right now (long-haul
    contacts love that twilight line), world clocks (UTC first, as is proper), and the
    <b>Log</b> — where every mode narrates what it's doing. When anything seems odd, read the
    Log first; it usually tells you exactly what happened.</p>` },

  { id: "radio", group: "Getting started", icon: "🔌", title: "Using it with a real radio", tag: "optional", html: `
    <p>No radio needed for anything on this site — but if you have one, two connections turn it
    into a full digital station. A USB soundcard interface (Digirig, SignaLink and friends) does
    both in one cable and shows up as an ordinary input/output device:</p>
    <ul>
      <li><b>Radio into computer:</b> the rig's speaker or line-out into your line-in or mic.
      Pick that device as the studio's input. Keep the level modest — if the meter slams, turn
      it down; overloaded audio is the number-one reason decoders print garbage.</li>
      <li><b>Computer into radio:</b> your audio out into the rig's mic or data jack. Start with
      TX gain low and bring it up until the rig's ALC just barely flickers, then stop.
      Digital modes want <i>clean</i>, not loud — too hot and your signal splatters across the
      band and everybody knows who it was.</li>
      <li><b>Keying the transmitter:</b> the studio makes audio; your rig still needs to be told
      to transmit. Use the rig's <b>VOX</b> (voice-operated switch — it keys when audio appears),
      a data interface with built-in VOX, or press PTT yourself.</li>
    </ul>
    <p>Once cabled, every mode here works on the air exactly as it does online. Identify per
    your regulations — more in <i>On the air</i> below.</p>` },

  /* ==================== THE MODES ==================== */
  { id: "shared", group: "The modes", icon: "🧭", title: "Things every mode shares", tag: "read once", html: `
    <p>The tabs all speak the same body language, so here it is once:</p>
    <ul>
      <li><b>Decoders follow the waterfall.</b> Click the waterfall on a signal and the open
      mode tunes to it. Watch for the mode's marker to land on the trace.</li>
      <li><b>Transmit goes everywhere it should.</b> Whatever a tab transmits comes out of your
      selected output — and, if you're the TX side of an Online Link, down the wire to your
      friend too. The TX light tells you the studio is making sound.</li>
      <li><b>Save WAV / decode WAV.</b> The picture, file and voice modes can save any
      transmission as a WAV file (play it from your phone into a rig at the park, email it,
      archive it) and most can decode from a WAV you upload or drop in.</li>
      <li><b>Listen / ARM RX (VOX).</b> Modes with framed transmissions have an armed-listening
      button: the decoder sits quietly and springs to life the moment a signal starts, so you
      can leave it watching a frequency. A threshold slider sets how loud "a signal" is.</li>
      <li><b>Loopback &amp; self-test.</b> Nearly every mode has a <i>Loopback</i> or
      <i>Self-test</i> button that transmits into its own decoder — no cables, no friend, no
      radio. It's the fastest way to learn what a mode looks and sounds like, and the first
      thing to try when something misbehaves. Several loopback labs let you roughen up the
      practice channel to see how much noise the mode survives.</li>
    </ul>` },

  { id: "cw", group: "The modes", icon: "𝄒𝄐", title: "CW / Morse", tag: "the original", html: `
    <p>Morse code — the oldest digital mode and still the best watts-per-word deal in radio. A
    single tone switching on and off; that's the whole trick, and it punches through noise that
    silences everything else.</p>
    <h4>The controls</h4>
    <ul>
      <li><b>Tone</b> (Receive card) — the pitch the decoder listens on. Click the waterfall on
      a CW signal and this follows automatically.</li>
      <li><b>Start decoder / Clear</b> — begins live decoding into the text window; Clear wipes it.
      The <b>Decoder state</b> card shows what it's up to — it spends the first few characters
      learning the sender's speed, then follows along even when the sending is human and wobbly.</li>
      <li><b>Speed</b> — your sending speed, 5 to 60 words per minute. Start at 15–20.</li>
      <li><b>Pitch</b> — the tone of your transmitted signal.</li>
      <li><b>Send / Abort</b> — transmits the text box (pre-filled with a classic CQ call using
      your callsign) as beautifully clean, click-free Morse; Abort stops mid-message. Prosigns
      go in angle brackets: <span class="mono">&lt;AR&gt; &lt;SK&gt; &lt;BT&gt; &lt;KN&gt;</span>.</li>
      <li><b>Straight key</b> — the fun card: hold the key button (or the <b>Ctrl</b> key) and
      send by hand. Run the decoder at the same time and it grades your fist with complete
      honesty.</li>
    </ul>
    <p><b>Tip:</b> learning code? Set 20&nbsp;WPM and let the studio send to you — hearing
    <i>good</i> Morse is half the battle.</p>` },

  { id: "rtty", group: "The modes", icon: "⌨", title: "RTTY", tag: "radioteletype", html: `
    <p>The teleprinter gone wireless — ninety years old and still the sound of a contest
    weekend. Two tones alternate to carry letters; that warbling "diddle" on the bands is RTTY
    idling between words.</p>
    <h4>The controls</h4>
    <ul>
      <li><b>Mark</b> — the higher of the two tones, where the decoder centers. Click the
      waterfall so your marker sits on the signal's twin rails.</li>
      <li><b>Shift</b> — the spacing between the two tones: <b>170&nbsp;Hz</b> is the amateur
      standard (leave it there unless you know why not); 425 and 850 exist for commercial-style
      signals.</li>
      <li><b>Reverse</b> — swaps mark and space. If a strong signal decodes as alphabet soup,
      this checkbox is almost always the cure — the other station is simply "upside down".</li>
      <li><b>USOS</b> — a politeness rule from the mechanical era: after every space, assume
      letters again. Leave it on; it prevents one noise hit from turning a whole line into
      numbers and symbols.</li>
      <li><b>Start decoder / Clear</b> — live text in, wipe.</li>
      <li><b>Send / Abort</b> and <b>Insert RYRY test</b> — send your text (uppercase only;
      RTTY's 1930s alphabet has no lowercase), or insert the traditional
      <span class="mono">RYRYRY</span> test string — R and Y alternate every single bit, which
      is exactly why old-timers use it to check a link.</li>
    </ul>
    <p><b>Tip:</b> RTTY is fussier about tuning than CW. Nudge your click until both rails
    straddle the marker and the text snaps from gibberish to English.</p>` },

  { id: "psk31", group: "The modes", icon: "◒", title: "PSK31", tag: "keyboard-to-keyboard", html: `
    <p>The ragchewer's mode: text at a comfortable typing pace in a signal so narrow that dozens
    of conversations fit where one voice signal would sit. A few watts routinely works the
    world.</p>
    <h4>The controls</h4>
    <ul>
      <li><b>Center</b> — the frequency the decoder watches. PSK31 is <i>very</i> narrow, so
      click the waterfall precisely on the trace; being off by the width of a pencil line
      matters.</li>
      <li><b>Start decoder / Clear</b> — live text and the wipe button.</li>
      <li><b>Vector scope</b> — the round display is your tuning eye: when you're exactly on a
      PSK31 signal it shows a crisp flipping line; a rotating blur means "nudge your click".</li>
      <li><b>Send / Abort</b> — type and go. Notice the signal keeps humming between your
      characters — that steady idle is part of the mode; it's what lets the far side stay
      locked while you sip coffee mid-sentence.</li>
    </ul>
    <p><b>Tip:</b> the receive side is young and happiest on clean, strong signals — perfect
    over the Online Link and the loopback; weak-signal toughening is on the to-do list.</p>` },

  { id: "fax", group: "The modes", icon: "📠", title: "Fax", tag: "weather charts by radio", html: `
    <p>Coastal stations still transmit <b>weather charts on HF</b> the way they have since the
    1950s: an FM subcarrier — black at 1500&nbsp;Hz, white at 2300 — at 120 lines per minute.
    Tune a radio in <b>USB, 1.9&nbsp;kHz below</b> the listed frequency, feed the audio in, and
    a synoptic chart prints line by line for ten minutes. In <b>auto</b> mode the printer arms
    itself on the start tone and rests on the stop tone.</p>
    <p>Fax free-runs between phasing pulses, so two honest knobs matter: <b>Slant</b> corrects
    your soundcard's parts-per-million clock error (leaning charts = wrong slant), and the
    <b>Phase</b> nudges slide the image left/right onto the paper. The <b>G1 phone fax</b>
    preset reads the analog office fax of the pre-modem era (ITU T.2, 1300/2100&nbsp;Hz,
    180&nbsp;LPM), and the wideband preset is for wire-to-wire play between two studios.
    <b>Self-test</b> prints the built-in test page through the real demodulator — gradients,
    bars and diagonals, everything a slant error loves to expose.</p>` },

  { id: "d2", group: "The modes", icon: "🌅", title: "HRWS-D2", tag: "sharpens as long as you listen", html: `
    <p>Where D1 sends stripes, D2 sends the picture <b>coarse-to-fine</b>: a recognizable
    thumbnail lands in the first second, and every further second is pure sharpening — a
    wavelet pyramid arriving layer by layer. The radical part is what's <i>missing</i>: there
    is <b>no error correction on purpose</b>. A lost packet was going to be a patch of fine
    detail; without it that patch is slightly softer, never garbled. Digital that degrades
    like analog — the argument the Help tab's philosophy section has been having, settled in
    hardware.</p>
    <p><b>Encode</b> a photo (or the built-in scene), <b>Transmit</b>, and on the far side
    <b>Listen</b> and watch it sharpen live. <b>Stop anytime — you keep everything.</b> The
    loopback button proves the point brutally: it cuts transmission at 30 % of airtime and
    shows you the perfectly watchable picture you'd have kept.</p>` },

  { id: "d3", group: "The modes", icon: "📽", title: "HRWS-D3", tag: "the pictures move", html: `
    <p>NBTV's great-grandchild: <b>digital moving television through a voice channel</b>.
    Where D1 sends a still as protected stripes, D3 sends — each frame — only the 16×16
    blocks that <i>changed</i>, either INTRA (complete, self-contained) or DELTA (the
    difference against the picture both ends already share). Same modem, same Viterbi
    armour, same CRC verdicts: noise drops a whole frame packet, never smears one, and a
    walking INTRA refresh keeps repainting the oldest blocks so a loss heals by itself
    within one sweep. That trick — conditional replenishment with forced updating — is how
    1988's H.261 videophones survived on 64 kbit/s. Here it runs on 0.5.</p>
    <p><b>Go live</b> with the webcam, a looping video file, or the moving test card. The
    TX preview flashes each block as it's chosen — amber for INTRA, cyan for DELTA — so you
    can literally watch the engine think. On the far side, <b>Listen (live TV)</b>: the
    monitor paints as packets verify, the <b>freshness map</b> beside it shows every
    block's age (cyan is seconds old, ember is waiting for the refresh to come around),
    and <b>Replay RX</b> plays what arrived back at its received pace. A session header
    repeats every 5 s, so tuning in mid-programme just works.</p>
    <p>Expect about 1 fps of soft webcam at 64×48 (two to three blocks a frame) and
    ~1.5 fps in the 2 fps setting; a busy scene makes the frame rate float down rather
    than the picture break — the target is a target, the physics are the physics. Mono is
    faster (no chroma), Low quality buys the most motion. WAV render and decode work from
    recordings, and the loopback lab and self-test roughen the channel on purpose to prove
    the healing. Both ends need this studio; the freshness map is the honest ledger —
    what you see is exactly as old as it says it is.</p>` },

  { id: "midi", group: "The modes", icon: "🎼", title: "MIDI Link (HRWS-M1)", tag: "the drunk orchestra", html: `
    <p>Live MIDI over a voice channel. The score flies in 5- or 10-second <b>bars</b>; the
    receiver buffers one bar (latency ≈ bar + 1.5 s) and plays a seamless reconstruction on
    a hand-rolled browser GM synth — fourteen timbre families across all 128 programs plus
    a drum kit, honestly 1993, gloriously offline.</p>
    <p>The interesting part is the failure mode, chosen on purpose. The <b>skeleton</b> —
    bar headers carrying the timing and the program table — rides the D1 Viterbi chain.
    The <b>notes</b> are fixed-width 5-byte records with <b>no error correction</b>: a bit
    error is trapped inside one field of one note, so noise gives you a wrong pitch, a
    wrong beat, a wrong instrument — <i>the drunk orchestra</i> — never silence, never
    desync. Measured on the bench: sober down to 0 dB SNR, slurring at −2, properly drunk
    at −4 with every header still standing, plastered at −6, lights out at −8.
    <b>Armour</b> mode sends the same notes through full FEC instead: damaged bars drop
    cleanly and nothing ever plays wrong — for about half the notes (≈ 20 vs ≈ 11
    notes/s). The D2 philosophy argument, scored for ensemble.</p>
    <p>Load any .mid (or the built-in demo band), <b>Encode → Transmit</b>; the TX roll
    shows what will fly, dimming what honest thinning had to cut (loudest notes win). On
    the far side <b>Listen</b>: the RX roll paints as bars verify, amber rings mark notes
    that arrived drunk, and <b>Save RX .mid</b> keeps exactly what you heard — slurs
    included; that's the point. Practical use: none. We are hams, it is interesting, and
    nobody gets hurt except the tuba player's dignity.</p>` },

  { id: "hell", group: "The modes", icon: "𝌆", title: "Hellschreiber", tag: "read by eye", html: `
    <p>Rudolf Hell's 1929 masterpiece and the original "fuzzy mode": text is sent as
    <b>literal pixels</b>, one column at a time, and printed on a scrolling paper strip —
    <b>your eyes are the decoder</b>. There are no bits to get wrong, so a weak signal prints
    faint and snowy instead of turning to garbage. Machines from the 1930s and this tab speak
    the same 245 pixels per second.</p>
    <h4>Receiving</h4>
    <ul>
      <li><b>Start decoder</b>, then click the waterfall on a Hell signal (they look like
      dotted stitching about 300&nbsp;Hz wide). The <b>Tone</b> box follows your click.</li>
      <li>Text prints <b>twice, stacked</b> — that's the mode's famous trick: with no
      synchronization at all, one of the two copies is always aligned for your eye. Read
      whichever looks right; if the text drifts slowly up or down, that's two soundcards
      politely disagreeing about time, and the second line has you covered.</li>
      <li><b>Contrast</b> darkens the ink on weak signals; <b>Clear paper</b> starts a fresh
      strip; <b>invert scan</b> flips the column direction if a signal prints upside-down.</li>
    </ul>
    <h4>Transmitting</h4>
    <p>Type and <b>Send</b> — 2.5 characters a second, about as fast as careful handwriting.
    <b>Edges</b> picks soft (clean spectrum, kind to neighbours) or hard (the classic clicky
    sound). <b>Stop</b> kills it mid-word, and <b>Self-test</b> prints "HELL 73" straight onto
    your own paper through simulated noise — no audio involved, the fastest way to see what
    the mode looks like.</p>
    <p><b>Tip:</b> Hell shines exactly where coded modes quit — try the Online Link's Manual
    conditions at brutal SNR and watch text stay human-readable long after it "should" be gone.</p>` },

  { id: "ft8", group: "The modes", icon: "⏱", title: "FT8", tag: "band watcher (beta)", html: `
    <p>The mode that ate the bands: everyone transmits in strict 15-second turns, synchronized
    by the clock, and contacts happen at signal levels you can't even hear. This tab is a
    <b>band watcher</b> — it finds FT8 signals and shows you the band waking up; turning each
    one into readable callsigns is the part still marked "beta" and honestly labelled in the
    panel.</p>
    <h4>The controls</h4>
    <ul>
      <li><b>Slot clock</b> — the 15-second heartbeat, locked to real time. FT8 lives and dies
      by the clock: if your computer's time is off by more than a second or so, nothing lines up.</li>
      <li><b>Start monitoring</b> — begins capturing; each finished slot paints the
      <b>slot spectrogram</b> (the 200–2500&nbsp;Hz window where all FT8 lives) and the
      <b>Sync candidates</b> list fills with every FT8 signal found: its audio frequency, how
      early or late it started, and how strong the lock is.</li>
      <li><b>Tune (1500&nbsp;Hz, 5&nbsp;s)</b> — a steady test tone for setting your radio's
      audio levels without transmitting anything meaningful.</li>
      <li><b>Send loopback test signal / Abort TX</b> — transmits a proper FT8-shaped signal so
      you can watch your own carrier appear in the next slot's candidate list.</li>
    </ul>
    <p><b>Use it to:</b> check whether a band is open at a glance (point it at 14.074&nbsp;MHz
    on a decent evening and watch the candidates pour in), verify your audio path, and watch
    propagation shift slot by slot as the sun moves.</p>` },

  { id: "olivia", group: "The modes", icon: "🎐", title: "Olivia", tag: "hears under the noise", html: `
    <p>The weak-signal text mode that <b>sounds like wind chimes</b> and decodes below where
    your ear gives up. Each character is spread as a Walsh pattern across a whole 64-symbol
    block of MFSK tones — noise can eat half the beeps and the correlation still lands on the
    right letter. Pick a flavor (<b>32/1000</b> is the common one, 8/250 the narrow slow
    survivor), click the waterfall on the warble, and <b>Start decoder</b>: lock takes about a
    block (~2&nbsp;s), then letters arrive a few at a time — the code decides per block, not
    per beep.</p>
    <p><b>Self-test</b> runs a message through <b>−4&nbsp;dB in-band SNR</b> — more noise than
    signal — and prints the clean copy, pure math. Try the same stunt live through the Online
    Link's Manual conditions and watch text keep flowing where PSK31 quit long ago.</p>` },

  { id: "sstv", group: "The modes", icon: "🖼", title: "SSTV", tag: "pictures by radio", html: `
    <p>Slow-scan television — pictures sent as sound, one line at a time, in about a minute or
    two. The warbling you've heard from the space station is this. This tab speaks the six
    classic modes everyone uses, plus a party trick of its own: <b>time-compressed SSTV</b> that
    sends the same picture 2–8× faster (both sides need this studio for that; at 1× it talks to
    every normal SSTV program on Earth).</p>
    <h4>Sending a picture</h4>
    <ul>
      <li><b>Source</b> — <i>Test pattern</i>, <i>Uploaded image</i> (drop in any photo), or
      <i>Webcam snapshot</i> with the <b>Snap webcam</b> button.</li>
      <li><b>SSTV mode</b> — <b>Martin M1</b> and <b>Scottie S1</b> are the everyday standards
      (~2 minutes, best quality); <b>M2/S2</b> are their one-minute halves; <b>Robot 36/72</b>
      are the quick color modes (36 seconds!); and the <b>PD family (50/90/120/160/180)</b> sends
      two picture lines per sync for bigger, sharper images — <b>PD 120 is what the
      International Space Station transmits</b>: during an ARISS event, tune any FM radio to
      145.800 MHz, feed the audio in, press Listen, and print a 640×496 picture from orbit.
      When in doubt terrestrially: Scottie S1.</li>
      <li><b>Compression</b> and <b>Method</b> — the speed multiplier (1× = normal SSTV) and how
      it's done: <b>FM turbo</b> keeps the signal inside a normal voice channel, so it works
      over any SSB radio; <b>Resample</b> is a straight speed-up for wideband paths — FM radios,
      cables, and the Online Link.</li>
      <li><b>Encode</b>, then <b>Transmit (play on air)</b> — or <b>Save WAV → download</b> to
      keep the transmission as a file. <b>Loopback test</b> sends it straight into your own
      decoder through a practice channel you can roughen up.</li>
    </ul>
    <h4>Receiving</h4>
    <ul>
      <li><b>Listen (VOX)</b> arms the receiver; the <b>VOX threshold</b> sets how loud a signal
      wakes it. Every SSTV picture announces its own mode in a digital header, so detection is
      automatic — compressed pictures are recognized too, speed and all. The image paints line
      by line with automatic slant correction as it arrives.</li>
      <li><b>Cleanup</b> — after decode: <b>Denoise</b> (Off / Normal / Strong) washes the
      static out of a rough copy remarkably well, and <b>Save image</b> keeps the result. The
      <b>On-air scope</b> shows the raw signal while it comes in.</li>
    </ul>
    <p><b>Tip:</b> first time? Loopback a test pattern in Robot 36 — thirty-six seconds later
    you'll understand the whole mode.</p>` },

  { id: "dsstv", group: "The modes", icon: "🛰", title: "Digital SSTV (HRWS-D1)", tag: "pixel-perfect", html: `
    <p>This studio's own digital picture mode. Where classic SSTV degrades into snow, HRWS-D1
    delivers the picture <b>pixel-perfect or clearly marked missing</b> — it sends the image in
    small protected chunks, each checked on arrival, painting live as they land. It fits through
    an ordinary voice channel. Both sides use this studio (it's an open, documented format —
    that's what the D1 stands for: our first digital image mode).</p>
    <h4>Sending</h4>
    <ul>
      <li><b>Source</b> — test pattern, uploaded image, or webcam (with <b>Snap webcam</b>).</li>
      <li><b>Size</b> and <b>Quality</b> (Low/Medium/High) — together they set how long the
      transmission takes. Low quality is astonishingly usable and fast; High is for keepers.</li>
      <li><b>Passes (repeats)</b> — 1, 2 or 3. On a rough channel, send it twice: the receiver
      keeps whichever copy of each chunk arrived intact, so two noisy passes often add up to one
      perfect picture. This is the mode's superpower.</li>
      <li><b>Encode → Transmit (play on air)</b>, or <b>Save WAV → download</b>.
      <b>Loopback test</b> practices against a channel you can roughen.</li>
    </ul>
    <h4>Receiving</h4>
    <ul>
      <li><b>Listen (VOX)</b> with its threshold slider arms the receiver. Chunks paint the
      moment they verify; damaged ones stay visibly flagged so you can ask for another pass.
      The scope shows the signal; the Log narrates every chunk's verdict.</li>
    </ul>
    <p><b>Analog SSTV or this?</b> SSTV talks to the whole world and fails gracefully into
    snow. HRWS-D1 talks to other studio users and fails honestly into "send that bit again."
    Different philosophies — try both on the same noisy loopback and you'll see.</p>
    <p>D1 carries one more cargo besides pictures: <b>Audio Postcards</b> —
    sound pressed into a playable vinyl record. They have their own chapter,
    right after this one.</p>` },

  { id: "postcard", group: "The modes", icon: "📀", title: "Audio Postcards (VREC)", tag: "the groove IS the audio", html: `
    <p>Press up to fifteen seconds of sound into a picture of a record — and
    the picture <i>plays</i>. The groove is a spiral of pixels whose
    brightness is the audio itself (\u03bc-law, one sample per groove pixel),
    and a <b>header ring</b> just outside the groove makes every disc
    self-describing. This is the VREC format: pressings made here play in the
    desktop VREC Studio and vice versa. Practical use: marginal. Charm:
    enormous.</p>
    <p>The flow is numbered on the card. <b>\u2460 Load audio\u2026</b> (any
    file your browser can decode — music files never touch the microphone) or
    <b>\u2460 Record mic</b>. <b>\u2461 Fidelity</b> trades bandwidth for
    playtime: the disc holds about 26,000 samples, so 4.8 kHz sings for
    ~5.5 s and 1.75 kHz mumbles for ~15 s. <b>\u2462 Press disc \u2192
    TX</b> cuts the record; <b>Audition on deck</b> plays exactly what the
    far end will hear; <b>Save disc PNG</b> exports a circular pressing with
    transparent corners — they carry nothing, so they weigh nothing.</p>
    <p>On the air, honesty pays: only the <b>12-byte header and the raw
    groove bytes</b> ever fly — never pixels. The receiver paints a blank
    pressing at once and the needle <b>starts playing while the chunks are
    still landing</b>; watch silence turn to signal in the under-the-stylus
    strip. Passes work like picture passes. A received postcard offers
    <b>\u25b6 Play on deck</b> and <b>Save image</b> (a real pressing you can
    send to anyone).</p>
    <p>The turntable is a <b>live optical pickup</b>: every output sample is
    read from the pixel under the stylus at that instant — no hidden buffer.
    The arm tracks the groove inward like a real side. Drag the arm to cue,
    drag the disc to scratch, park past the edge to stop, use START/STOP on
    the plinth. Loading auto-drops the needle. <b>Eject</b> clears the
    platter but keeps the bench. Playback is <b>VREC-transparent by
    default</b> — 48 kHz out through a proper reconstruction filter
    (interpolation images buried \u2265 28 dB, measured); the vintage hiss
    and pops are the opt-in <b>Surface noise</b> checkbox, off unless you ask.
    Doubt your speakers? <b>Save side WAV</b> renders the mathematical ground
    truth of the disc on the platter — if the file is clean and the room
    isn't, the problem is downstream of this studio.</p>
    <p>And the lossless secret: <b>Load disc PNG\u2026</b> accepts <i>any</i>
    real VREC pressing — any size, any pitch or step, v1 \u03bc-law or
    <b>v2 16-bit PCM</b>. Records cut by the desktop VREC Studio (4096 px,
    16-bit, 44.1 kHz — genuinely CD-grade, ~97 s a side) play here natively.
    Over HF air the format stays v1 \u03bc-law \u2264 4.8 kHz — the physics
    of a voice channel — so music <i>on the air</i> is proudly AM-grade;
    music <i>on the platter</i> can be perfect.</p>` },

  { id: "nbtv", group: "The modes", icon: "📺", title: "NBTV", tag: "1920s television", html: `
    <p>Narrow-band television — <i>mechanical</i> TV, the 1920s kind: a few dozen lines, moving
    pictures narrow enough to fit through a voice channel. This is the most delightfully
    pointless-in-the-best-way mode in the studio, and watching your own face at 32 lines is an
    experience everyone should have once.</p>
    <h4>The controls</h4>
    <ul>
      <li><b>Standard</b> — pick your decade: <b>NBTV Club 32</b> (the modern hobbyist standard
      — start here), <b>Baird 30</b> (1920s, tall skinny picture, pure history),
      <b>Experimental 24</b>, <b>Club 48</b>, <b>1931-era 60</b>, <b>90-line</b>,
      <b>Mid-30s 120</b>, and <b>X96 wideband</b>. More lines = sharper = needs more
      bandwidth.</li>
      <li><b>Colour</b> — <i>Monochrome</i>; <i>Frame-sequential</i> and <i>Line-sequential</i>
      (red, green and blue take turns); or <b>Stereo Y/C</b> — a clever scheme where the left
      audio channel carries the brightness and the right carries the color, so someone receiving
      in mono still gets a clean black-and-white picture.</li>
      <li><b>Source</b> and <b>Fit</b> — test patterns, an uploaded still,
      <b>a video file or animated GIF</b> (plays over the air on a loop, clipped to two
      minutes), or <b>live webcam</b>; cropped to fill or letterboxed.</li>
      <li><b>Sound — AM subcarrier:</b> proper talkies. A video's own audio track — or any
      soundtrack file loaded with <b>Load soundtrack</b>, paired with whatever picture you
      like — rides an AM subcarrier placed television-style: the picture is band-limited below the carrier (≈9&nbsp;kHz on wide filters) and the carrier sits above it (≈16.6&nbsp;kHz for Club&nbsp;32), so picture detail can't grind over the soundtrack. Use the same mode and output-filter setting on both ends; QR file TX skips the guard to keep its bandwidth. The output filter shapes the <i>video</i> only — the carrier stays near the top of the band with full sound quality at every setting. The sound is raw AM: your soundtrack's level is the modulation depth, nothing rides the gain. <b>Live mic commentary</b> works too (press <i>Start audio</i>
      first). The status line under the selector always says exactly what will ride the
      carrier; tick <b>decode AM sound on RX</b> to hear it on the receive side — the picture
      notch at the carrier frequency is always on, so the image stays clean either way. A carrier squelch keeps the
      speaker silent unless a real subcarrier is present and the picture is locked —
      pictures without sound, noise, and other modes' audio never reach your ears.</li>
      <li><b>▶ Loopback — watch TX→RX live:</b> the button to press first. It runs a real
      transmission straight into the receiver <i>inside the page</i> — nothing on the air, no
      microphone, no cables — at true speed: the TX monitor shows what's being scanned, the RX
      monitor shows what a receiver makes of it, and the soundtrack plays if sound decode is
      on. Every control stays live while it runs: drag <b>Sync level</b>, swap the
      <b>Output filter</b>, change <b>Standard</b> or <b>Colour</b> (the run restarts itself)
      and watch the consequences. It's the whole studio as a bench.</li>
      <li><b>TX start (on air) / Stop</b> — the same thing, but into your actual audio output.
      <b>Sync level</b> and <b>Output filter</b> fine-tune the signal; <b>Sample rate</b>
      offers wideband options (96/192&nbsp;kHz) for the high-line-count standards over
      cables. <b>Quick self-test</b> is the silent five-frame sanity check.</li>
      <li><b>Render WAV → download</b> with a chosen length and bit depth — and the
      <b>WAV file</b> card decodes recordings, including ones made by vintage-style NBTV
      software.</li>
      <li><b>File link — QR over video:</b> the party trick's party trick. <b>Send file</b>
      turns any file into a slideshow of QR codes riding the TV signal; <b>Arm file RX</b> on
      the other side reads them off the screen and reassembles the file, checked for errors.
      <b>EC</b> sets how ruggedly the codes are drawn (L = biggest chunks, Q = most robust) and
      <b>Repeat</b> loops the carousel for rough channels. Yes: files, through a 1920s
      television signal, through a voice channel. Because we can.</li>
    </ul>` },

  { id: "qamlink", group: "The modes", icon: "⬡", title: "QAM File Link", tag: "file transfer", html: `
    <p>A serious file-transfer modem: send any file as sound, receive it verified on the other
    end. It uses the same family of techniques as DSL internet, packed into radio audio — and it
    tells you honestly, on a live display, how good your channel really is. <i>Measured through the Online Link's Opus stream (320 kb/s):</i> profiles up to <b>WBFM 15 kHz</b> decode perfectly — 64-QAM is the sweet spot (~26 kb/s of verified file data; still clean if the stream drops to 192 kb/s). The 18–21 kHz profiles don't survive Opus: the codec brick-walls at 20 kHz and couples stereo channels, so those carriers are removed, not merely noised. At the other end, SSB QPSK gets files through a stream as thin as 48 kb/s.</p>
    <h4>The controls</h4>
    <ul>
      <li><b>Profile</b> — matched to your path, narrowest to widest: <b>SSB narrow
      500&nbsp;Hz</b> (through a CW filter), <b>HF SSB 2.4&nbsp;kHz</b> (a normal shortwave voice
      channel — it even corrects a slightly mistuned radio), <b>FM voice 3&nbsp;kHz</b> (any
      VHF/UHF FM rig — HTs and mobiles), <b>FM data 6.5&nbsp;kHz</b> (the 9k6 packet jack),
      <b>FM flat 10&nbsp;kHz</b> (link radios and wider data jacks), <b>WBFM 15&nbsp;kHz</b>,
      <b>Cable 18&nbsp;kHz</b> (stereo wire, bonding doubles speed), <b>Full audio 21&nbsp;kHz</b>
      (everything one 48&nbsp;k soundcard channel carries — FM-ATV sound subcarriers, video
      senders), <b>Microwave FM 40&nbsp;kHz</b> (wide-baseband gear on 10&nbsp;GHz-style links),
      <b>HiFi 96&nbsp;k</b>, <b>SDR/IF 80&nbsp;kHz</b> and <b>Ultra 192&nbsp;k</b>. The three
      widest need a matching wideband soundcard for <i>live</i> play — Save WAV and the
      loopback lab work on any machine.</li>
      <li><b>Constellation</b> — the speed ladder, from bulletproof QPSK up through 16, 64, 256,
      1024 to 4096-QAM. Higher is faster and needs a cleaner channel. The <b>constellation
      display</b> is your honest advisor: tight dots mean you can climb a rung; a fuzzy cloud
      means come back down.</li>
      <li><b>Passes (repeats)</b> — 1–3; like Digital SSTV, repeated passes patch each other's
      holes.</li>
      <li><b>Beacon ▶ (callsign)</b> — sends a short identifying frame; the receiving side locks
      on and reports who you are and how good the link is <i>before</i> you commit to a big
      file. Beacon first, agree on a rung, then send.</li>
      <li><b>SEND FILE / Save TX WAV</b> — transmit live or save the whole transfer as audio.</li>
      <li><b>ARM RX ▶ / Reset RX session / Download file</b> — the receiving side: arm, watch
      blocks verify as they land, download when complete.</li>
      <li><b>Loopback lab</b> — practice transfers against an adjustable channel, plus a
      <b>Self-test</b>.</li>
    </ul>
    <p><b>Tip:</b> start on a low rung. Climbing from a working QPSK beats starting at 4096-QAM
    and wondering why nothing arrives. And two things that are <i>normal</i>, not broken: the
    transmission sounds like harsh grinding static (that's simply what dense multicarrier data
    sounds like — dial-up was the same song), and the brief ticks of silence between bursts are
    the guard gaps separating frames — beacon, file info, each data segment, and the end marker
    all travel as their own burst.</p>` },

  { id: "chanlab", group: "The modes", icon: "🛰️", title: "Channel Lab", tag: "see the sky's echo", html: `
    <p>An <b>ionosonde in a browser tab</b>. One station sends the 1-second chirp; the other
    arms the receiver — the matched filter compresses that whole sweep into microseconds of
    arrival, and the channel's <b>impulse response</b> appears: one orange needle per
    propagation path. Two skywave hops draw two needles milliseconds apart (that spacing is
    the sky's geometry); a direct wire draws one clean spike; flutter smears them live. The
    <b>RMS delay spread</b> readout is the number that quietly decides which QAM profile
    survives a path. <b>Loopback test</b> synthesizes a textbook two-path channel at your
    chosen SNR through the real correlator — and pointing the sounder through the 🧪
    conditions simulator lets you finally <i>see</i> what it's been doing to every other
    mode.</p>` },

  { id: "oracle", group: "The modes", icon: "🔮", title: "Prop Oracle", tag: "antennas beat prophecy", html: `
    <p>The dashboard's band table is a <i>heuristic</i>; this tab is a <b>measurement</b>. Park
    your rig on a band's FT8 frequency, tell the Oracle which band, press <b>Start metering</b>,
    and every 15-second slot becomes one data point: coherent-tone energy standing above the
    noise median — a band full of stations lights it up whether or not anything decodes.
    Sparklines build per band through the day, the live solar numbers ride alongside, and the
    verdict line flags the interesting moments: <b>"measuring OPEN — solar says Poor"</b> is
    sporadic-E, grayline, or the ionosphere writing its own weather report. Trust the
    antenna.</p>` },

  { id: "wspr", group: "The modes", icon: "🌱", title: "WSPR TX", tag: "the two-watt whisper", html: `
    <p>WSPR packs your <b>callsign, grid and power into 50 bits</b>, wraps them in heavy
    forward error correction, and whispers them as four tones just 1.46&nbsp;Hz apart for
    110.6 seconds — decodable <b>28 dB below the noise floor</b>. Fill in the fields,
    <b>Arm beacon</b>, and it fires one second into the chosen even UTC minutes; key your rig
    (or VOX) on the dial standards like 14.0956&nbsp;MHz USB and watch
    <b>wsprnet.org</b> draw the map of everywhere your watt reached. <b>Send now</b> tests
    untimed, <b>Save WAV</b> exports the exact 12&nbsp;kHz audio, and the definitive check is
    WSJT-X decoding it — this transmitter is built to the published format, so it should.</p>` },

  { id: "aprs", group: "The modes", icon: "📍", title: "APRS", tag: "packet & position", html: `
    <p>The Automatic Packet Reporting System — ham radio's live map. Stations beacon their
    position, status and short messages in quick data bursts; in North America it all happens
    around 144.390&nbsp;MHz FM. This tab is a complete stand-alone APRS station: cable it to an
    FM radio and your neighbourhood scrolls in.</p>
    <h4>My station</h4>
    <ul>
      <li><b>Latitude / Longitude</b> — pre-filled from your settings; edit freely.</li>
      <li><b>Symbol</b> — how you appear on everyone's map: house, car, motorcycle, person,
      bicycle, and the rest of the traditional set. <b>SSID</b> is the number after your
      callsign that tells the world which of your stations this is (<span class="mono">-7</span>
      is conventionally a handheld, <span class="mono">-9</span> a car).</li>
      <li><b>Comment</b> — the short free-text that rides your beacon. <b>Path</b> — the relay
      request (the default is right for almost everyone).</li>
      <li><b>Send position</b> — one beacon now. <b>Auto ▶</b> — beacon on a timer at your
      chosen interval. <b>Status</b> — sends a status text instead of a position.</li>
    </ul>
    <h4>Messages</h4>
    <p>Fill <b>To</b> with a callsign-SSID (like <span class="mono">VE3ABC-7</span>), type, and
    <b>Send message</b>. Delivery is confirmed: the other station's radio acknowledges
    automatically, and this station ACKs incoming messages for you too.</p>
    <h4>Receiving</h4>
    <p><b>ARM RX ▶</b> starts the decoder; heard stations stack up in the monitor with their
    position, symbol, distance and what they said — <b>Clear stations</b> empties the list.
    It reads all the common beacon dialects, including the compressed ones. <b>Save beacon
    WAV</b> keeps your beacon as an audio file, and the <b>Loopback lab</b> lets you decode
    yourself and <b>Self-test</b> the whole chain without a radio.</p>` },

  { id: "digivoice", group: "The modes", icon: "🎙", title: "Digital Voice", tag: "HRWS-DV + FreeDV", html: `
    <p>Talk — as data. Your voice is compressed to a trickle of bits, wrapped in error
    protection, and sent as sound a radio (or the Online Link) can carry. Digital voice doesn't
    hiss and fade like SSB; it's clear right down to the edge, then gone — the sync indicator is
    your new S-meter.</p>
    <h4>The controls</h4>
    <ul>
      <li><b>Digital voice mode</b> — the studio's own open modes: <b>DV-1600</b> (fits any
      voice radio — the safe default), <b>DV-2600</b> (better-sounding on quiet channels), and
      <b>DV-3200F</b> (best quality, for the data jack of an FM rig). Below them sit the
      <b>FreeDV</b> modes — <b>1600, 700C, 700D, 700E</b> — powered by the genuine FreeDV voice
      engine, so this tab talks to real FreeDV stations on the air. 700D/E are the famous
      weak-signal ones: voice from signals you can barely see.</li>
      <li><b>PTT</b> — hold to talk, like any radio. <b>LOCK</b> keeps it keyed hands-free;
      <b>VOX</b> keys automatically when you speak. Receive mutes while you transmit —
      half-duplex, one direction at a time, just like the real thing.</li>
      <li><b>ARM RX ▶</b> — listen; when a digital voice signal appears the decoder locks and
      speech comes out of your output device.</li>
      <li><b>Save demo-talker DV WAV</b> — a ready-made digital-voice transmission as a file,
      perfect for testing a link. <b>Run loopback (demo talker)</b> plays it through the
      practice channel into the decoder, and <b>Self-test (all modes)</b> checks every mode
      end-to-end in one go.</li>
    </ul>
    <p><b>Tip:</b> a headset beats speaker-and-mic — otherwise the decoder hears its own output
    and VOX chases its tail.</p>` },

  { id: "vlf", group: "The modes", icon: "🧲", title: "VLF Radio", tag: "soundcard SDR", html: `
    <p>Down in the basement of the spectrum — below about 24&nbsp;kHz — your soundcard isn't
    <i>connected to</i> a radio, it <b>is</b> one: it samples actual radio frequencies. Plug a
    coil of wire into line-in and you're receiving. This tab is a full VLF transceiver built on
    that fact.</p>
    <h4>Receiving</h4>
    <ul>
      <li><b>The spectrum &amp; waterfall</b> show everything your input hears, 0&nbsp;Hz to the
      soundcard's ceiling. <b>Click anywhere to tune</b>; the amber band marks your passband.
      Green ticks are the <b>station guide</b> — tap an entry in the side list and the receiver
      jumps there with the right mode and bandwidth: the Alpha navigation trio, the big MSK
      stations (NAA, DHO38, GQD and friends), and on scheduled heritage days <b>SAQ
      Grimeton</b> at 17.2&nbsp;kHz — a 1920s alternator you can hear on a coil and a laptop.</li>
      <li><b>Mode and bandwidth</b> — CW (with a pitch slider — it's your BFO), USB, LSB and AM,
      from 50&nbsp;Hz to 6&nbsp;kHz wide. Narrow CW for carriers and time signals; wide AM or USB
      with the lights off for <b>sferics</b> (lightning crackle from continents away) and, with
      luck, the falling whistle of a <b>whistler</b>.</li>
      <li><b>Hum comb</b> — the VLF survival tool. One filter notches <i>every</i> harmonic of
      your mains (50 or 60&nbsp;Hz) at once, which is the difference between a wall of buzz and
      a listenable band. Coils love hum; this unloves it.</li>
      <li><b>Time-station decoder</b> — point it at DCF77, MSF or WWVB and the module reads
      the one-bit-per-second amplitude code, prints the broadcast time and date after one full
      minute, and tells you how far your PC clock is from a national atomic standard — measured
      through a coil of wire. The <b>Self-test</b> button decodes two synthetic DCF77 minutes
      through the real machinery, no antenna or wideband card needed.</li>
      <li><b>Natural radio logger</b> — the storm channel: every <b>sferic</b> click is a
      lightning stroke, often from another continent; <b>tweeks</b> are strokes that rang the
      Earth-ionosphere waveguide; and a <b>whistler</b> is a stroke that rode the magnetosphere
      out past the Van Allen belts and back — high notes arrive first, and the log records the
      fall time. Start it, leave it running after dark, and Save log keeps your observatory's
      night. Self-test synthesizes all three species through the real detector.</li>
      <li><b>QRSS grabber</b> — the slow-Morse culture's telescope: sub-hertz bins integrate
      minutes of signal into one picture, so a keyed carrier too slow and too weak to hear
      draws its callsign across the screen. Pick a center (8.97 kHz is the meeting spot),
      choose a 5–30 minute window, and <b>auto-grab</b> saves a UTC-stamped PNG each pass —
      the artifact grabber pages have traded for decades. It pairs with this tab's own QRSS
      transmitter: key across the shack, read yourself on the grabber.</li>
      <li><b>Device rate</b> — a normal 48&nbsp;k card hears to ~24&nbsp;kHz. Pick 96 or
      192&nbsp;kHz (and reload) on a card that supports it and the ceiling lifts to where the
      <b>time stations</b> live: JJY&nbsp;40, MSF/WWVB at 60, DCF77 at 77.5&nbsp;kHz.</li>
    </ul>
    <h4>Transmitting</h4>
    <p>The same coil, driven by your output, is a <b>magnetic-induction transmitter</b>. Key a
    steady <b>Carrier</b>, send <b>CW</b> from the text box, or go proper-VLF with <b>QRSS</b> —
    Morse with 1-to-60-second dots, the mode of choice when every fraction of a decibel counts.
    Honest physics: near-field falls off as 1/r³, so a bare soundcard reaches across the room;
    an audio amplifier and a serious tuned loop reach hundreds of metres, and the dedicated have
    bridged a couple of kilometres. Below 9&nbsp;kHz the spectrum is internationally unallocated
    (the "Dreamer's Band" lives at 8.97) — check your local rules — and put a resistor in series
    with the coil; soundcards resent driving raw copper.</p>` },

  { id: "online", group: "The modes", icon: "🌐", title: "Online Link", tag: "two studios, one band", html: `
    <p>Connect your studio to a friend's, anywhere on the internet. Whatever one side transmits
    — Morse, pictures, files, voice, television — the other side's decoders receive, in high
    quality, directly between your two browsers. And between you sits a <b>channel you
    control</b>: crystal clear, deliberately noisy, or governed by real radio physics.</p>
    <h4>Connecting</h4>
    <ul>
      <li><b>Create link</b> makes a private link and a URL — <b>Copy</b> it and send it to your
      friend any way you like. They open it and their studio joins automatically (or they paste
      the code and press <b>Join</b>). <b>Hang up</b> ends it. Keep both tabs open while
      linked.</li>
      <li><b>My side is RX / TX</b> — pick who's talking. The RX side's input switches to
      <b>🌐 Online link</b> by itself (that's the <i>auto-route</i> checkbox; <b>Route link →
      decoders</b> does it manually), so every open mode tab hears your friend. Better yet,
      with auto-route on you rarely touch these buttons at all: <b>press transmit in any
      mode tab and the link flips your side to TX for you</b>, then drops back to listening a
      moment after the transmission ends — CW keying, an SSTV send, live NBTV, a QAM burst,
      they all just go down the wire. Manual clicks always win if you want to hold a role.
      What you hear locally from a decoder (Digital Voice playback and friends) is
      speaker-only and never echoes back down the link.</li>
      <li><b>Monitor friend</b> — how loudly you hear them in your speakers, separate from what
      the decoders get. It ducks itself automatically while the link is routed into the
      decoders, so a friend's modem tones and TV buzz go to the software, not your ears —
      the slider is still yours if you want the raw feed louder. A <b>chat</b> strip underneath is your coordination channel, and the
      status line shows the connection quality.</li>
    </ul>
    <h4>Conditions — the channel between you</h4>
    <ul>
      <li><b>Direct patch</b> — a clean pipe. The "just works" button.</li>
      <li><b>Manual</b> — you play weather god: an <b>SNR</b> slider sets how deep in the noise
      the signal sits, <b>QSB depth/rate</b> add the slow fading real skywave has (plus a
      <b>flutter</b> checkbox for storm-shimmer), <b>QRN crashes/min</b> throws lightning
      static, <b>Hum</b> adds mains buzz (50 or 60&nbsp;Hz — pick your continent), and the
      <b>RX filter</b> narrows the channel like a real rig. <b>Presets</b> jump from <i>Quiet
      band</i> to <i>Brutal</i>. This answers the eternal question: how much abuse does each
      mode really survive? (Try SSTV vs. Digital SSTV on the same setting.)</li>
      <li><b>Full simulation</b> — the game. Each of you dials a <b>virtual rig</b>: spin the
      big frequency display digit by digit (scroll your mouse wheel on a digit), pick a band
      from 160&nbsp;m to 23&nbsp;cm, set your <b>mode</b>, <b>power</b> (from 1&nbsp;milliwatt
      to a gloriously silly 10&nbsp;megawatts — the badge tells you when you've left reality),
      <b>antenna</b> gain and height. The studio takes your two real locations plus <b>live
      space-weather data</b> and works out, every second, whether that signal actually makes
      the trip — the S-meter reads the result, the noise you hear matches it, and the notes
      explain <i>why</i> ("this path wants darkness — try after sunset") and <i>what it would
      take</i> ("for S9 you'd need about 4&nbsp;kW"). You must also find each other on
      frequency — off-frequency means no copy, just like the real thing. It's the whole
      band-chasing hobby, playable.</li>
      <li><b>Hear my own conditioned TX</b> — the TX side can monitor what the channel is doing
      to their signal.</li>
    </ul>
    <h4>No friend online?</h4>
    <p>Two solo toys: the virtual rig accepts a made-up <b>Station B</b> so you can plan paths
    ("could 5 watts from here reach Portugal tonight?"), and the input picker's
    <b>🧪 Conditions loopback</b> feeds your own transmissions through the simulated band and
    back into your own decoders. Transmit an SSTV picture from one tab; watch it arrive snowy
    in the same tab. The whole learning loop, population: you.</p>` },

  /* ==================== GOOD TO KNOW ==================== */
  { id: "trouble", group: "Good to know", icon: "🩺", title: "When something's off", tag: "fixes", html: `
    <ul class="hlp-faq">
      <li><b>The browser never asked for the microphone, or I clicked Block.</b> Click the
      padlock/permissions icon next to the address bar, set Microphone to Allow, and press
      <i>Start audio</i> again.</li>
      <li><b>A decoder prints garbage.</b> Nine times in ten it's tuning or volume. Click the
      waterfall <i>precisely</i> on the signal (PSK31 especially), and back the input level off —
      a meter that slams means clipping, and clipping is what digital modes hate most. On RTTY,
      also try the <b>Reverse</b> box.</li>
      <li><b>My transmission sounds rough on the other end.</b> Too loud somewhere. Lower TX
      gain until the rig's ALC barely moves. Clean beats loud, every time.</li>
      <li><b>SSTV pictures lean sideways.</b> A little slant is normal (soundcard clocks
      disagree) and mostly auto-corrected; the Cleanup tools press out the rest.</li>
      <li><b>FT8 finds nothing on a band I know is busy.</b> Your computer clock. The 15-second
      slots run on real time — a couple of seconds of error and nothing lines up. Sync the
      clock, try again.</li>
      <li><b>The Online Link sticks at "negotiating".</b> Rare, but some networks (usually
      office or heavily-shared connections) won't let two browsers meet directly. One of you
      switching networks — a phone hotspot proves it in a minute — gets you through.</li>
      <li><b>Linked, but silence and frozen meters.</b> Browsers keep sound asleep until you
      interact — click anything in the panel. And both sides need audio started.</li>
      <li><b>It ignores my clicks / behaves oddly.</b> Check the dashboard <b>Log</b> — the
      studio narrates its problems plainly there — and when in doubt, a mode's
      <b>Self-test</b> button will tell you in seconds whether the mode itself is healthy.</li>
    </ul>
    <p><b>The turntable talks when it hurts.</b> Any playback problem prints
    on the deck's own info line — <span class="mono">deck fault: \u2026</span>
    with the exact cause (and the full detail in the browser console). If it
    says audio is suspended, the cure is the <b>Start audio</b> button, top
    right.</p>` },

  { id: "air", group: "Good to know", icon: "⚖", title: "On the air", tag: "rules & manners", html: `
    <p>Everything on this site that stays online — the Online Link, the loopbacks, the
    simulator — needs no license at all. That's the point: learn freely.</p>
    <p>The moment this studio's audio keys a real transmitter, you're a radio station and the
    normal rules apply: <b>hold the license your country requires, identify the way your
    regulations say, and stay in the parts of the bands your license allows</b> — band plans
    put digital modes in agreed segments so everyone coexists. The studio's own modes (HRWS-D1/D2/D3, HRWS-M1,
    HRWS-DV, the QAM link, compressed SSTV) are openly documented, unencrypted formats — but
    rules on digital transmissions differ by country, so know yours. House manners: listen
    before transmitting, start with low power, and make the stranger who stumbles on your weird
    experimental signal curious rather than annoyed. 73!</p>` },

  { id: "credits", group: "Good to know", icon: "🏆", title: "Credits & thanks", tag: "giants, shoulders", html: `
    <p>This studio exists because radio amateurs share their work. These are the people and
    projects it stands on:</p>
    <div class="hlp-cred">
      <div><b>VA3JFL</b><span>Author of the studio — and of the original Python projects three
      modes are direct ports of: <b>Experimental SSTV Studio</b> (the SSTV tab, including its
      time-compression scheme), <b>NBTV Studio</b> (the NBTV tab — the two decode each other's
      pictures and files), and <b>audiomodem</b> (the QAM File Link's entire signal engine).
      The HRWS-D1 and HRWS-DV mode designs are his as well.</span></div>
      <div><b>David Rowe VK5DGR &amp; the Codec&nbsp;2 team</b><span>Creators of Codec&nbsp;2
      and FreeDV, the open digital-voice project. Their genuine voice engine is built into the
      Digital Voice tab's FreeDV modes, and FreeDV's design is the declared inspiration for
      HRWS-DV. Open digital voice exists because of them.</span></div>
      <div><b>Peter Martinez G3PLX</b><span>Invented PSK31 and its clever character code — the
      PSK31 tab implements his design as he published it.</span></div>
      <div><b>Alex Shovkoplyas VE3NEA</b><span>The SSTV Cleanup denoiser is inspired by his
      published work on restoring noisy SSTV images.</span></div>
      <div><b>Martin Emmerson G3OQD · Eddie Murphy GM3SBC · Robot Research</b><span>Designers of
      the Martin, Scottie and Robot picture modes the SSTV tab speaks.</span></div>
      <div><b>Joe Taylor K1JT, Steve Franke K9AN &amp; the WSJT-X team</b><span>Creators of FT8,
      the protocol the FT8 tab listens for.</span></div>
      <div><b>Bob Bruninga WB4APR (SK)</b><span>Father of APRS — the APRS tab implements the
      system he gave the hobby.</span></div>
      <div><b>Kazuhiko Arase &amp; the jsQR project</b><span>The QR codes in NBTV's file link
      are drawn by Arase's <b>qrcode-generator</b> and read by <b>jsQR</b> — both open source,
      both bundled so the studio works offline. "QR Code" is a registered trademark of DENSO
      WAVE INCORPORATED.</span></div>
      <div><b>NOAA Space Weather Prediction Center</b><span>The live solar and geomagnetic data
      behind the dashboard and the propagation simulator — public science, cached politely.</span></div>
      <div><b>Natural Earth</b><span>The coastlines on the grayline map.</span></div>
      <div><b>Google &amp; Twilio</b><span>Public connection-finding (STUN) servers that help
      two browsers meet for the Online Link's direct audio.</span></div>
      <div><b>Google Fonts</b><span>Chakra Petch, IBM Plex Mono and Inter — the studio's
      typefaces, all openly licensed.</span></div>
    </div>
    <p class="muted">The studio itself is free and open source. If your work appears here
    uncredited, that's a mistake — please say so and it will be fixed.</p>` }
  ];

  /* ------------------------------------------------------------ */
  const def = {
    id: "help",

    init(ctx) {
      this.ctx = ctx;
      this._io = null;
    },

    createPanel(el) {
      const groups = [];
      for (const s of SECTIONS) {
        let g = groups.find(x => x.name === s.group);
        if (!g) { g = { name: s.group, items: [] }; groups.push(g); }
        g.items.push(s);
      }

      el.innerHTML = `
      <style>
        .hlp-layout { display:flex; gap:16px; align-items:flex-start; }
        .hlp-main { flex:1; min-width:0; }
        .hlp-side { width:238px; flex:none; position:sticky; top:10px; }
        @media (max-width: 900px) { .hlp-layout{flex-direction:column-reverse} .hlp-side{width:100%; position:static} }
        .hlp-search { width:100%; box-sizing:border-box; background:var(--bg1,#121722); border:1px solid var(--line,rgba(96,114,150,.22));
          color:var(--text,#d9dfea); padding:7px 10px; border-radius:7px; font-family:var(--font-mono); font-size:12px; margin-bottom:8px; }
        .hlp-toc { font-family:var(--font-mono); font-size:12px; }
        .hlp-toc .g { color:var(--muted,#8b95a7); text-transform:uppercase; letter-spacing:.08em; font-size:10px; margin:10px 0 4px; }
        .hlp-toc a { display:flex; gap:7px; align-items:baseline; color:var(--text,#d9dfea); text-decoration:none;
          padding:4px 7px; border-radius:6px; border-left:2px solid transparent; }
        .hlp-toc a:hover { background:rgba(255,255,255,.04); }
        .hlp-toc a.on { border-left-color:var(--amber,#ffb454); color:var(--amber,#ffb454); background:rgba(255,180,84,.06); }
        .hlp-toc a.dim { opacity:.3; }
        .hlp-toc .i { width:16px; text-align:center; flex:none; }
        .hlp-sec { scroll-margin-top:12px; }
        .hlp-sec .card-body { font-size:13.5px; line-height:1.62; color:var(--text,#d9dfea); }
        .hlp-sec .card-body p { margin:0 0 10px; }
        .hlp-sec .card-body p:last-child { margin-bottom:0; }
        .hlp-sec h4 { margin:14px 0 6px; font-size:12px; letter-spacing:.07em; text-transform:uppercase;
          color:var(--amber,#ffb454); font-family:var(--font-mono); font-weight:600; }
        .hlp-sec ul, .hlp-sec ol { margin:6px 0 10px; padding-left:20px; }
        .hlp-sec li { margin:0 0 8px; }
        .hlp-steps li { margin-bottom:10px; }
        .hlp-faq li { margin-bottom:10px; }
        .hlp-cred div { display:grid; grid-template-columns:220px 1fr; gap:4px 14px; padding:9px 0;
          border-bottom:1px dashed var(--line,rgba(96,114,150,.22)); }
        .hlp-cred div:last-child { border-bottom:none; }
        .hlp-cred b { color:var(--amber,#ffb454); font-family:var(--font-mono); font-size:12.5px; font-weight:600; }
        .hlp-cred span { color:var(--text,#d9dfea); font-size:13px; line-height:1.55; }
        @media (max-width: 700px) { .hlp-cred div { grid-template-columns:1fr; } }
        .hlp-none { display:none !important; }
        .hlp-count { font-size:11px; color:var(--muted,#8b95a7); font-family:var(--font-mono); margin:-2px 0 8px; }
      </style>
      <div class="hlp-layout">
        <div class="hlp-main" id="hlp-main">
          ${SECTIONS.map(s => `
          <div class="card hlp-sec" id="hlp-${s.id}" data-hlp="${s.id}">
            <header class="card-head"><h3>${s.icon} ${s.title}</h3><span class="card-tag mono">${s.tag}</span></header>
            <div class="card-body">${s.html}</div>
          </div>`).join("")}
        </div>
        <div class="hlp-side">
          <div class="card">
            <header class="card-head"><h3>Manual</h3><span class="card-tag mono">📖</span></header>
            <div class="card-body">
              <input type="text" class="hlp-search" id="hlp-search" placeholder="search the manual…">
              <div class="hlp-count" id="hlp-count"></div>
              <nav class="hlp-toc" id="hlp-toc">
                ${groups.map(g => `<div class="g">${g.name}</div>` +
                  g.items.map(s => `<a href="#" data-goto="${s.id}"><span class="i">${s.icon}</span>${s.title}</a>`).join("")
                ).join("")}
              </nav>
            </div>
            <footer class="card-foot mono muted">Stuck? The dashboard Log narrates everything the studio does — it's this manual's live appendix.</footer>
          </div>
        </div>
      </div>`;

      const toc = el.querySelector("#hlp-toc");
      const search = el.querySelector("#hlp-search");
      const count = el.querySelector("#hlp-count");
      const cards = Array.from(el.querySelectorAll(".hlp-sec"));
      const links = Array.from(toc.querySelectorAll("a[data-goto]"));

      /* TOC navigation */
      toc.addEventListener("click", (e) => {
        const a = e.target.closest("a[data-goto]");
        if (!a) return;
        e.preventDefault();
        const card = el.querySelector("#hlp-" + a.dataset.goto);
        if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
      });

      /* scroll spy */
      try {
        this._io = new IntersectionObserver((entries) => {
          for (const en of entries) {
            if (!en.isIntersecting) continue;
            const id = en.target.dataset.hlp;
            links.forEach(l => l.classList.toggle("on", l.dataset.goto === id));
            break;
          }
        }, { rootMargin: "-8% 0px -78% 0px", threshold: 0 });
        cards.forEach(c => this._io.observe(c));
      } catch (e) { /* cosmetic only */ }

      /* search filter */
      const texts = cards.map(c => c.textContent.toLowerCase());
      search.addEventListener("input", () => {
        const q = search.value.trim().toLowerCase();
        let shown = 0;
        cards.forEach((c, i) => {
          const hit = !q || texts[i].includes(q);
          c.classList.toggle("hlp-none", !hit);
          if (hit) shown++;
          const link = links.find(l => l.dataset.goto === c.dataset.hlp);
          if (link) link.classList.toggle("dim", !hit);
        });
        count.textContent = q ? `${shown} of ${cards.length} sections match` : "";
      });
      search.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { search.value = ""; search.dispatchEvent(new Event("input")); }
      });
    },

    onActivate() {},
    onDeactivate() {
      if (this._io) { try { this._io.disconnect(); } catch (e) {} this._io = null; }
    }
  };

  HRWS.registerModule(def);
})();
