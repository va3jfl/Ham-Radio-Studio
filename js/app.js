/* ============================================================
   Ham Radio Web Studio — application core
   Owns: settings, the shared audio engine, the waterfall dock,
   the tab system, the log, and the module plugin loader.

   Module contract (modules/<id>/module.js):

     HRWS.registerModule({
       id: "cw",                      // must match its folder name
       init(ctx)      { ... }         // once, right after load
       createPanel(el){ ... }         // build UI into el (each activation)
       onActivate()   { ... }         // optional
       onDeactivate() { ... }         // optional — stop RX taps here!
     });

   ctx gives a module everything it needs:
     ctx.audio      shared AudioEngine
     ctx.dsp        DSP toolkit
     ctx.log(msg)   tagged entry in the dashboard log
     ctx.settings() current station settings (callsign, grid…)
     ctx.onTune(cb) waterfall click-to-tune (fires while active)
     ctx.setMarker({freq,color,label})  tuning marker on the dock
   ============================================================ */
"use strict";

const HRWS = window.HRWS = {
  audio: new AudioEngine(),
  dsp: DSP,
  settings: {},
  modules: {},        // id -> definition (registered)
  manifests: [],      // from api/modules.php
  active: new Set(),  // ids with open tabs
  _loaded: new Set(), // ids whose script has been injected
  _tuneSubs: {},      // id -> Set(cb)
  _markers: {},       // id -> marker
  waterfall: null,

  /* ------------- logging ------------- */
  log(mod, msg) {
    const el = document.getElementById("app-log");
    const t = new Date().toISOString().slice(11, 19);
    const line = document.createElement("div");
    line.innerHTML = `<span class="log-time">${t}</span> <span class="log-mod">[${mod}]</span> ${escapeHtml(String(msg))}`;
    el.appendChild(line);
    while (el.childElementCount > 300) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  },

  /* ------------- module registration (called by module scripts) ------------- */
  registerModule(def) {
    if (!def || !def.id) { console.error("registerModule: bad definition", def); return; }
    this.modules[def.id] = def;
  },

  /* ------------- module context ------------- */
  _makeCtx(id) {
    const self = this;
    return {
      audio: self.audio,
      dsp: DSP,
      log: (msg) => self.log(id, msg),
      settings: () => self.settings,
      onTune(cb) {
        (self._tuneSubs[id] ||= new Set()).add(cb);
        return () => self._tuneSubs[id].delete(cb);
      },
      setMarker(marker) {
        if (marker) self._markers[id] = marker; else delete self._markers[id];
        self._pushMarkers();
      }
    };
  },
  _pushMarkers() {
    if (this.waterfall) this.waterfall.setMarkers(Object.values(this._markers).flat());
  },

  /* ------------- activation ------------- */
  async toggleModule(id) {
    if (this.active.has(id)) this.deactivateModule(id);
    else await this.activateModule(id);
    this._syncSidebar();
    this._persistActive();
  },

  async activateModule(id) {
    const manifest = this.manifests.find(m => m.id === id);
    if (!manifest) return;

    if (!this._loaded.has(id)) {
      try {
        await injectScript(`modules/${id}/${manifest.entry || "module.js"}`);
        this._loaded.add(id);
      } catch (e) {
        this.log("core", `Could not load module "${id}": ${e.message || e}`);
        return;
      }
    }
    const def = this.modules[id];
    if (!def) { this.log("core", `Module "${id}" loaded but never registered itself.`); return; }

    if (!def._initialized) {
      def._ctx = this._makeCtx(id);
      try { def.init && def.init(def._ctx); } catch (e) { console.error(e); }
      def._initialized = true;
    }

    // tab
    const tab = document.createElement("button");
    tab.className = "tab";
    tab.dataset.panel = id;
    tab.setAttribute("role", "tab");
    tab.innerHTML = `${escapeHtml(manifest.icon || "")} ${escapeHtml(manifest.name)} <span class="tab-close" title="Close ${escapeHtml(manifest.name)}">×</span>`;
    tab.addEventListener("click", (e) => {
      if (e.target.classList.contains("tab-close")) { this.toggleModule(id); return; }
      this.showPanel(id);
    });
    document.getElementById("tabs").appendChild(tab);

    // panel
    const panel = document.createElement("section");
    panel.className = "panel";
    panel.id = `panel-${id}`;
    panel.setAttribute("role", "tabpanel");
    document.getElementById("panels").appendChild(panel);
    try { def.createPanel(panel); } catch (e) { console.error(e); panel.textContent = "Module UI failed to build — see console."; }

    this.active.add(id);
    try { def.onActivate && def.onActivate(); } catch (e) { console.error(e); }
    this.showPanel(id);
    this.log("core", `${manifest.name} activated`);
  },

  deactivateModule(id) {
    const def = this.modules[id];
    try { def && def.onDeactivate && def.onDeactivate(); } catch (e) { console.error(e); }
    document.querySelector(`.tab[data-panel="${id}"]`)?.remove();
    document.getElementById(`panel-${id}`)?.remove();
    this.active.delete(id);
    delete this._markers[id];
    this._pushMarkers();
    this.showPanel("dashboard");
    this.log("core", `${id} deactivated`);
  },

  showPanel(id) {
    document.querySelectorAll(".tab").forEach(t => {
      const on = t.dataset.panel === id;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on);
    });
    document.querySelectorAll(".panel").forEach(p => p.classList.toggle("active", p.id === `panel-${id}`));
    this.activePanel = id;
  },

  _syncSidebar() {
    document.querySelectorAll(".module-item").forEach(li =>
      li.classList.toggle("on", this.active.has(li.dataset.id)));
  },

  _persistActive() {
    this.settings.activeModules = [...this.active];
    saveSettings(this.settings, true); // quiet save
  },

  /* ------------- module discovery ------------- */
  async loadModuleList() {
    let list = null;
    try {
      const res = await fetch("api/modules.php", { cache: "no-store" });
      if (res.ok) list = await res.json();
    } catch { /* running without PHP */ }
    if (!Array.isArray(list) || !list.length) {
      list = DEFAULT_MODULES;
      this.log("core", "Module API unavailable — using the built-in module list.");
    }
    this.manifests = list;

    const ul = document.getElementById("module-list");
    ul.innerHTML = "";
    for (const m of list) {
      const li = document.createElement("li");
      li.className = "module-item";
      li.dataset.id = m.id;
      li.title = m.description || "";
      li.innerHTML = `
        <span class="module-icon">${escapeHtml(m.icon || "▣")}</span>
        <span class="module-meta">
          <span class="module-name">${escapeHtml(m.name)}</span>
          <span class="module-desc">${escapeHtml(m.description || "")}</span>
        </span>
        <span class="module-switch" aria-hidden="true"></span>`;
      li.addEventListener("click", () => this.toggleModule(m.id));
      ul.appendChild(li);
    }
  }
};

/* Fallback list so the studio still works when opened without PHP
   (file:// or a plain static host). Keep in sync with modules/. */
const DEFAULT_MODULES = [
  { id: "online", name: "Online Link", icon: "🌐", description: "Share-a-URL Opus link between two studios: conditions simulator + virtual-rig propagation", entry: "module.js" },
  { id: "cw",    name: "CW / Morse", icon: "𝄒𝄐", description: "Keyer, encoder and live decoder", entry: "module.js" },
  { id: "rtty",  name: "RTTY",       icon: "⌨",  description: "45.45 Bd Baudot FSK, TX + RX",     entry: "module.js" },
  { id: "psk31", name: "PSK31",      icon: "◒",  description: "Varicode BPSK narrowband text",    entry: "module.js" },
  { id: "hell",  name: "Hellschreiber", icon: "𝌆", description: "Feld Hell: text as pixels, decoded by eye — 1929's fuzzy mode", entry: "module.js" },
  { id: "olivia", name: "Olivia",   icon: "🎐", description: "Weak-signal MFSK/Walsh text — decodes under the noise", entry: "module.js" },
  { id: "sstv",  name: "SSTV",       icon: "🖼",  description: "SSTV studio: 11 modes incl. ISS PD 120, time-compressed",        entry: "module.js" },
  { id: "fax",   name: "Fax",        icon: "📠", description: "WEFAX weather charts + G1 phone fax, RX and TX", entry: "module.js" },
  { id: "dsstv", name: "Digital SSTV", icon: "🛰", description: "HRWS-D1: pixel-perfect images, FEC + live stripes", entry: "module.js" },
  { id: "d2",    name: "HRWS-D2",   icon: "🌅", description: "Progressive images — thumbnail in a second, sharpens forever", entry: "module.js" },
  { id: "d3",    name: "HRWS-D3",   icon: "📽", description: "Moving pictures over SSB — delta-coded D1 stripes at 1–2 fps", entry: "module.js" },
  { id: "midi",  name: "MIDI Link", icon: "🎼", description: "HRWS-M1: live MIDI in 10 s bars — noise makes a drunk orchestra, not silence", entry: "module.js" },
  { id: "ft8",   name: "FT8",        icon: "⏱",  description: "15 s cycles, sync detector (beta)", entry: "module.js" },
  { id: "qamlink", name: "QAM File Link", icon: "⬡", description: "OFDM file transfer: SSB/FM/WBFM/cable profiles, beacon lock", entry: "module.js" },
  { id: "chanlab", name: "Channel Lab", icon: "🛰️", description: "Chirp sounder — see the channel impulse response", entry: "module.js" },
  { id: "oracle", name: "Prop Oracle", icon: "🔮", description: "Measured band openings vs solar heuristics, per 15-s slot", entry: "module.js" },
  { id: "aprs", name: "APRS", icon: "📍", description: "AFSK 1200 packet: beacons, messages, station radar", entry: "module.js" },
  { id: "digivoice", name: "Digital Voice", icon: "🎙️", description: "HRWS-DV: vocoder + PSK/4FSK voice with PTT, lock and VOX", entry: "module.js" },
  { id: "wspr",  name: "WSPR TX",   icon: "🌱", description: "Even-minute propagation whisper — 50 bits, 110.6 s", entry: "module.js" },
  { id: "nbtv",  name: "NBTV",       icon: "📺", description: "Mechanical television, TX + RX (experimental)", entry: "module.js" },
  { id: "vlf",   name: "VLF Radio",  icon: "🧲", description: "Soundcard SDR for the basement of the spectrum: coil RX, hum comb, QRSS TX", entry: "module.js" },
  { id: "help",  name: "Help",       icon: "📖", description: "The manual: setup, every mode explained, troubleshooting, credits", entry: "module.js" }
];

/* ------------- small helpers ------------- */
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function injectScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("script failed to load"));
    document.head.appendChild(s);
  });
}

/* ------------- settings ------------- */
/* Settings live in THIS browser (localStorage): every visiting ham keeps
   their own callsign, grid and location, and nothing anyone types can
   override anyone else. The server is consulted only when this browser
   has nothing yet AND api/settings.php has explicitly opted in
   (HRWS_SINGLE_OP — private single-operator shack installs). A server
   value can never override a local one. */
async function loadSettings() {
  let local = null;
  try { local = JSON.parse(localStorage.getItem("hrws-settings") || "null"); } catch { local = null; }
  if (local && typeof local === "object") return local;   // the browser wins, always
  try {
    const res = await fetch("api/settings.php", { cache: "no-store" });
    if (res.ok) {
      const s = await res.json();
      if (s && typeof s === "object" && !s.error && s.enabled !== false) return s;
    }
  } catch { /* no PHP — fine */ }
  return {};
}
async function saveSettings(s, quiet) {
  try { localStorage.setItem("hrws-settings", JSON.stringify(s)); } catch {}
  try {                       // mirrored only where the server opted in;
                              // a public site answers 403 and life goes on
    await fetch("api/settings.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(s)
    });
  } catch { /* localStorage already has it */ }
  if (!quiet) HRWS.log("core", "Settings saved");
}

/* ------------- boot ------------- */
document.addEventListener("DOMContentLoaded", async () => {
  HRWS.settings = await loadSettings();
  Dashboard.init(HRWS.settings);
  HRWS.log("core", "Ham Radio Web Studio ready — 73!");

  /* waterfall dock */
  HRWS.waterfall = new Waterfall(HRWS.audio, {
    spectrumCanvas: document.getElementById("spectrum"),
    waterfallCanvas: document.getElementById("waterfall"),
    maxFreq: 3000,
    onHover: (f) => { document.getElementById("dock-freq").textContent = `${Math.round(f)} Hz`; },
    onClick: (f) => {
      const subs = HRWS._tuneSubs[HRWS.activePanel];
      if (subs && subs.size) subs.forEach(cb => cb(f));
      else HRWS.log("core", `Waterfall: ${f} Hz (open a mode tab to tune its decoder)`);
    }
  });
  HRWS.waterfall.start();

  document.getElementById("wf-palette").addEventListener("change", e => HRWS.waterfall.setPalette(e.target.value));
  document.getElementById("wf-span").addEventListener("change", e => HRWS.waterfall.setMaxFreq(parseInt(e.target.value, 10)));
  document.getElementById("wf-pause").addEventListener("change", e => { HRWS.waterfall.paused = e.target.checked; });

  /* audio start + devices */
  const btnAudio = document.getElementById("btn-audio");
  btnAudio.addEventListener("click", async () => {
    try {
      if (HRWS.audio.rxActive) {
        HRWS.audio.stopRX();
        btnAudio.textContent = "Start audio";
        return;
      }
      btnAudio.disabled = true;
      await HRWS.audio.startRX(document.getElementById("sel-input").value || undefined);
      btnAudio.textContent = "Stop audio";
      // now that we have permission, device labels are visible
      await refreshAudioDeviceLists();
      const engSr = HRWS.audio.sampleRate;
      HRWS.log("core", `RX running at ${engSr} Hz` + (engSr > 48000 ? " — wideband context (device or NBTV setting); mode renders stay at 48 kHz" : ""));
    } catch (e) {
      HRWS.log("core", "Microphone blocked: " + (e.message || e) +
        " — browsers only allow audio capture on localhost or HTTPS (see README).");
    } finally {
      btnAudio.disabled = false;
    }
  });
  document.getElementById("sel-input").addEventListener("change", async (e) => {
    if (HRWS.audio.rxActive) {
      await HRWS.audio.startRX(e.target.value || undefined);
      HRWS.log("core", "Switched input device");
    }
  });
  document.getElementById("sel-output").addEventListener("change", async (e) => {
    try {
      await HRWS.audio.setOutput(e.target.value || "");
      HRWS.log("core", "Switched output device");
    } catch (err) {
      HRWS.log("core", "Output switch failed: " + (err.message || err));
    }
  });

  /* device pickers — hardware devices plus any virtual inputs that
     modules register (the Online Link, its conditions loopback…) */
  async function refreshAudioDeviceLists() {
    const sel = document.getElementById("sel-input");
    const cur = sel.value;
    const inputs = await HRWS.audio.listInputs();
    const virt = Object.entries(HRWS.audio.virtualInputs || {});
    sel.innerHTML = `<option value="">Default input</option>` +
      virt.map(([id, v]) => `<option value="${id}">${escapeHtml(v.label)}</option>`).join("") +
      inputs.map(d => `<option value="${d.deviceId}">${escapeHtml(d.label || "Input")}</option>`).join("");
    if ([...sel.options].some(o => o.value === cur)) sel.value = cur;

    const selO = document.getElementById("sel-output");
    const curO = selO.value;
    const outputs = await HRWS.audio.listOutputs();
    selO.innerHTML = `<option value="">Default output</option>` +
      outputs.map(d => `<option value="${d.deviceId}">${escapeHtml(d.label || "Output")}</option>`).join("");
    if ([...selO.options].some(o => o.value === curO)) selO.value = curO;
  }
  HRWS.refreshAudioDeviceLists = refreshAudioDeviceLists;
  HRWS.audio.on("virtual-inputs", () => refreshAudioDeviceLists());
  refreshAudioDeviceLists();

  /* LEDs */
  HRWS.audio.on("rx-start", () => document.getElementById("led-rx").classList.add("on"));
  HRWS.audio.on("rx-stop", () => document.getElementById("led-rx").classList.remove("on"));
  HRWS.audio.on("tx-start", () => document.getElementById("led-tx").classList.add("on"));
  HRWS.audio.on("tx-end", () => document.getElementById("led-tx").classList.remove("on"));

  /* RX level meter */
  const meter = document.getElementById("rx-meter");
  const mctx = meter.getContext("2d");
  (function drawMeter() {
    requestAnimationFrame(drawMeter);
    const w = meter.width, h = meter.height;
    mctx.clearRect(0, 0, w, h);
    const lvl = Math.min(1, HRWS.audio.level * 3.2);
    mctx.fillStyle = lvl > 0.92 ? "#ff5d5d" : lvl > 0.75 ? "#ffd166" : "#45c7d6";
    mctx.fillRect(0, 0, lvl * w, h);
  })();

  /* TX gain */
  const gain = document.getElementById("tx-gain");
  gain.addEventListener("input", () => {
    HRWS.audio.setTxGain(gain.value / 100);
    document.getElementById("tx-gain-val").textContent = `${gain.value}%`;
  });
  HRWS.audio.setTxGain(gain.value / 100);

  /* settings modal */
  const modal = document.getElementById("settings-modal");
  document.getElementById("btn-settings").addEventListener("click", () => {
    document.getElementById("set-callsign").value = HRWS.settings.callsign || "";
    document.getElementById("set-grid").value = HRWS.settings.grid || "";
    document.getElementById("set-lat").value = HRWS.settings.lat ?? "";
    document.getElementById("set-lon").value = HRWS.settings.lon ?? "";
    document.getElementById("set-zones").value = (HRWS.settings.zones || []).join(", ");
    modal.showModal();
  });
  document.getElementById("btn-save-settings").addEventListener("click", () => {
    HRWS.settings.callsign = document.getElementById("set-callsign").value.trim().toUpperCase();
    HRWS.settings.grid = document.getElementById("set-grid").value.trim();
    HRWS.settings.lat = document.getElementById("set-lat").value.trim();
    HRWS.settings.lon = document.getElementById("set-lon").value.trim();
    HRWS.settings.zones = document.getElementById("set-zones").value
      .split(",").map(z => z.trim()).filter(Boolean);
    saveSettings(HRWS.settings);
    Dashboard.applySettings(HRWS.settings);
  });

  document.getElementById("btn-clearlog").addEventListener("click", () => {
    document.getElementById("app-log").innerHTML = "";
  });

  /* dashboard tab button */
  document.querySelector('.tab[data-panel="dashboard"]').addEventListener("click", () => HRWS.showPanel("dashboard"));

  /* modules */
  await HRWS.loadModuleList();
  for (const id of (HRWS.settings.activeModules || [])) {
    if (HRWS.manifests.some(m => m.id === id)) await HRWS.activateModule(id);
  }
  HRWS._syncSidebar();
  HRWS.showPanel("dashboard");

  /* deep link: a shared "?join=CODE" (or #join=CODE) URL means a friend
     invited this browser into an Online Link — open the module on it. */
  const joinCode = new URLSearchParams(location.search).get("join") ||
    (location.hash.match(/join=([A-Za-z0-9]+)/) || [])[1];
  if (joinCode && HRWS.manifests.some(m => m.id === "online")) {
    if (!HRWS.active.has("online")) await HRWS.activateModule("online");
    HRWS._syncSidebar();
    HRWS.showPanel("online");
  }
});
