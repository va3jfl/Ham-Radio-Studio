/* ============================================================
   Ham Radio Web Studio — Dashboard
   Clocks, grayline map, NOAA solar data, band-condition
   estimates and the Maidenhead grid tool.
   ============================================================ */
"use strict";

const Dashboard = (() => {

  let settings = {};
  let landPolys = null;    // array of polygons, each an array of rings [[lon,lat],...]
  let landIsFallback = true;
  let baseMap = null;      // offscreen canvas with land rendered

  /* ============ CLOCKS ============ */
  function two(n) { return String(n).padStart(2, "0"); }

  function tickClocks() {
    const now = new Date();
    const utc = `${two(now.getUTCHours())}:${two(now.getUTCMinutes())}:${two(now.getUTCSeconds())}`;
    const loc = `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`;
    document.getElementById("clock-utc").textContent = utc;
    document.getElementById("clock-local").textContent = loc;

    // world clocks
    const ul = document.getElementById("world-clocks");
    const zones = (settings.zones && settings.zones.length ? settings.zones
      : [Intl.DateTimeFormat().resolvedOptions().timeZone, "Europe/London", "Asia/Tokyo", "Australia/Sydney"]);
    if (ul.childElementCount !== zones.length) {
      ul.innerHTML = zones.map(z =>
        `<li><span class="wc-zone">${z.replace(/_/g, " ")}</span><span class="wc-time vfd" data-zone="${z}">--:--</span></li>`).join("");
    }
    ul.querySelectorAll(".wc-time").forEach(el => {
      try {
        el.textContent = new Intl.DateTimeFormat("en-GB", {
          timeZone: el.dataset.zone, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
        }).format(now);
      } catch { el.textContent = "??"; }
    });
  }

  /* ============ GRAYLINE MAP ============ */

  // Compact stylized continents — the offline fallback when the
  // higher-resolution world-atlas data can't be fetched.
  const FALLBACK_LAND = [
    // North America
    [[-165,65],[-153,58],[-132,56],[-125,49],[-124,40],[-117,32],[-105,22],[-97,16],[-90,15],[-83,9],[-77,8],[-81,25],[-76,35],[-70,42],[-66,45],[-60,47],[-65,60],[-78,62],[-95,66],[-110,68],[-130,70],[-155,71]],
    // Greenland
    [[-45,60],[-52,64],[-55,70],[-60,76],[-45,83],[-25,83],[-20,76],[-22,70],[-32,65]],
    // South America
    [[-77,8],[-70,12],[-62,10],[-52,4],[-44,-3],[-35,-8],[-39,-15],[-48,-25],[-53,-34],[-58,-39],[-65,-41],[-65,-47],[-68,-52],[-71,-54],[-73,-46],[-71,-37],[-70,-30],[-70,-18],[-77,-12],[-81,-5],[-79,1]],
    // Africa
    [[-6,35],[10,37],[19,33],[32,31],[34,24],[37,15],[43,11],[51,12],[46,2],[40,-3],[40,-11],[35,-20],[33,-27],[27,-34],[19,-35],[16,-28],[12,-18],[9,-8],[9,0],[6,4],[-8,4],[-13,9],[-17,15],[-16,22],[-10,30]],
    // Eurasia
    [[-9,43],[-9,37],[0,38],[10,44],[15,40],[19,40],[23,36],[27,36],[36,36],[35,29],[39,21],[43,12],[52,13],[55,17],[57,25],[52,28],[57,27],[65,25],[67,24],[72,20],[73,15],[77,8],[80,13],[86,21],[91,22],[97,17],[98,8],[103,1],[105,10],[109,12],[107,20],[113,22],[121,30],[122,37],[125,40],[131,43],[135,49],[141,53],[156,51],[162,56],[160,60],[170,66],[178,69],[170,71],[140,73],[110,77],[90,76],[70,73],[60,70],[45,68],[28,71],[15,68],[5,61],[6,58],[10,55],[4,52],[0,49],[-2,48]],
    // British Isles
    [[-5,50],[-6,54],[-3,58],[0,53],[1,51]],
    // Japan
    [[130,31],[132,34],[137,35],[140,36],[141,40],[142,44],[140,42],[136,36],[132,33]],
    // Australia
    [[114,-22],[113,-26],[115,-34],[124,-33],[130,-32],[137,-35],[140,-38],[147,-38],[150,-37],[153,-30],[153,-25],[146,-19],[142,-11],[136,-12],[132,-11],[126,-14],[122,-18]],
    // New Guinea
    [[131,-1],[141,-3],[147,-6],[143,-8],[135,-4]],
    // Madagascar
    [[44,-16],[47,-15],[50,-16],[47,-25],[44,-20]],
    // New Zealand
    [[167,-46],[171,-44],[174,-41],[173,-35],[175,-37],[174,-40],[172,-43]]
  ];

  /* Try to upgrade to real coastlines from the world-atlas package
     (free, MIT/ODbL data via jsDelivr). Falls back silently. */
  async function loadLand() {
    try {
      await loadScript("https://cdn.jsdelivr.net/npm/topojson-client@3/dist/topojson-client.min.js");
      const res = await fetch("https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json");
      if (!res.ok) throw new Error("fetch failed");
      const topo = await res.json();
      const geo = window.topojson.feature(topo, topo.objects.land);
      const polys = [];
      for (const f of (geo.features || [geo])) {
        const g = f.geometry;
        if (!g) continue;
        const pp = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
        for (const poly of pp) polys.push(poly);   // keep outer ring + holes together
      }
      landPolys = polys;
      landIsFallback = false;
      HRWS.log("dashboard", "Grayline map: world-atlas coastlines loaded");
    } catch {
      landPolys = FALLBACK_LAND.map(r => [r]);     // one-ring polygons
      landIsFallback = true;
      HRWS.log("dashboard", "Grayline map: offline fallback coastlines in use");
    }
    baseMap = null; // force re-render of the land layer
    drawMap();
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function projX(lon, w) { return (lon + 180) / 360 * w; }
  function projY(lat, h) { return (90 - lat) / 180 * h; }

  function renderBaseMap(w, h) {
    baseMap = document.createElement("canvas");
    baseMap.width = w; baseMap.height = h;
    const ctx = baseMap.getContext("2d");
    ctx.fillStyle = "#0a1420";                 // ocean
    ctx.fillRect(0, 0, w, h);
    // faint lat/lon graticule every 30°
    ctx.strokeStyle = "rgba(96,114,150,0.14)";
    ctx.beginPath();
    for (let lon = -150; lon <= 150; lon += 30) { const x = projX(lon, w); ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (let lat = -60; lat <= 60; lat += 30) { const y = projY(lat, h); ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
    // equator slightly stronger
    ctx.strokeStyle = "rgba(96,114,150,0.3)";
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    // land — drawn with care at the map edges:
    //  · longitudes are unwrapped along each ring, so a coastline that
    //    crosses ±180° (Chukotka, Wrangel Island, Fiji) no longer draws
    //    a chord across the whole map (the "tear" at Bering latitudes)
    //  · a ring that encircles a pole (Antarctica) is closed via the
    //    pole so it fills as a polar cap instead of leaking
    //  · each polygon is drawn at −360°/0°/+360° so the unwrapped parts
    //    land on the correct side of the seam; holes fill as holes
    ctx.fillStyle = "#28405a";
    const polys = landPolys || FALLBACK_LAND.map(r => [r]);
    for (const poly of polys) {
      /* unwrap every ring once */
      const rings = poly.map(ring => {
        const pts = [];
        let off = 0, prev = null;
        for (const [lon0, lat] of ring) {
          let lon = lon0 + off;
          if (prev !== null) {
            while (lon - prev > 180) { lon -= 360; off -= 360; }
            while (lon - prev < -180) { lon += 360; off += 360; }
          }
          pts.push([lon, lat]);
          prev = lon;
        }
        if (pts.length > 1 && Math.abs(pts[pts.length - 1][0] - pts[0][0]) > 180) {
          let mean = 0;
          for (const p of pts) mean += p[1];
          const pole = mean / pts.length < 0 ? -90 : 90;
          pts.push([pts[pts.length - 1][0], pole], [pts[0][0], pole]);
        }
        return pts;
      });
      /* one fill per offset copy: holes cancel inside their copy via
         even-odd, and copies never share a path, so abutting copies of
         a pole-closed ring can't cancel each other at the seam */
      for (const shift of [-360, 0, 360]) {
        let minX = Infinity, maxX = -Infinity;
        for (const pts of rings) for (const [lon] of pts) {
          const x = projX(lon + shift, w);
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
        if (maxX < 0 || minX > w) continue;        // this copy is off-canvas
        ctx.beginPath();
        for (const pts of rings) {
          pts.forEach(([lon, lat], i) => {
            const x = projX(lon + shift, w), y = projY(lat, h);
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
          });
          ctx.closePath();
        }
        ctx.fill("evenodd");
      }
    }
    // stylized Antarctica only for the offline fallback set (the real
    // dataset now fills its own polar cap correctly)
    if (landIsFallback) {
      ctx.fillRect(0, projY(-63, h), w, h - projY(-63, h));
    }
  }

  /* Subsolar point: declination + equation of time approximation. */
  function subsolarPoint(date) {
    const start = Date.UTC(date.getUTCFullYear(), 0, 0);
    const n = (date.getTime() - start) / 86400000;          // day of year (fractional)
    const decl = -23.44 * Math.cos(2 * Math.PI * (n + 10) / 365.25);
    const B = 2 * Math.PI * (n - 81) / 364;
    const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B); // minutes
    const utcH = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
    let lon = -15 * (utcH + eot / 60 - 12);
    if (lon > 180) lon -= 360; if (lon < -180) lon += 360;
    return { lat: decl, lon };
  }

  function drawMap() {
    const canvas = document.getElementById("grayline");
    if (!canvas) return;
    const w = 1024, h = 512;
    if (canvas.width !== w) { canvas.width = w; canvas.height = h; }
    if (!baseMap) renderBaseMap(w, h);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(baseMap, 0, 0);

    const now = new Date();
    const sun = subsolarPoint(now);
    const sinD = Math.sin(sun.lat * Math.PI / 180);
    const cosD = Math.cos(sun.lat * Math.PI / 180);

    // Night + twilight shading on a coarse grid: sun elevation per
    // cell, alpha stepped through civil / nautical / night bands.
    const cell = 4; // px
    ctx.save();
    for (let gy = 0; gy < h; gy += cell) {
      const lat = 90 - (gy + cell / 2) / h * 180;
      const sinL = Math.sin(lat * Math.PI / 180);
      const cosL = Math.cos(lat * Math.PI / 180);
      for (let gx = 0; gx < w; gx += cell) {
        const lon = (gx + cell / 2) / w * 360 - 180;
        const H = (lon - sun.lon) * Math.PI / 180;
        const sinElev = sinD * sinL + cosD * cosL * Math.cos(H);
        if (sinElev < 0) {
          const elev = Math.asin(sinElev) * 180 / Math.PI;
          const alpha = elev < -12 ? 0.62 : elev < -6 ? 0.45 : 0.26;
          ctx.fillStyle = `rgba(2,4,9,${alpha})`;
          ctx.fillRect(gx, gy, cell, cell);
        }
      }
    }
    ctx.restore();

    // Subsolar marker
    const sx = projX(sun.lon, w), sy = projY(sun.lat, h);
    const grad = ctx.createRadialGradient(sx, sy, 2, sx, sy, 20);
    grad.addColorStop(0, "rgba(255,220,130,0.95)");
    grad.addColorStop(1, "rgba(255,180,84,0)");
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(sx, sy, 20, 0, 7); ctx.fill();
    ctx.fillStyle = "#ffd98a";
    ctx.beginPath(); ctx.arc(sx, sy, 4, 0, 7); ctx.fill();

    // Station marker from settings
    const st = stationLatLon();
    if (st) {
      const x = projX(st.lon, w), y = projY(st.lat, h);
      ctx.strokeStyle = "#45c7d6"; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(x, y, 5.5, 0, 7); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - 9, y); ctx.lineTo(x + 9, y); ctx.moveTo(x, y - 9); ctx.lineTo(x, y + 9); ctx.stroke();
    }

    document.getElementById("map-subsolar").textContent =
      `sun ${sun.lat.toFixed(1)}°, ${sun.lon.toFixed(1)}°`;
  }

  function stationLatLon() {
    if (isFinite(parseFloat(settings.lat)) && isFinite(parseFloat(settings.lon)))
      return { lat: parseFloat(settings.lat), lon: parseFloat(settings.lon) };
    if (settings.grid) return DSP.gridToLatLon(settings.grid);
    return null;
  }

  /* ============ SOLAR DATA ============ */
  async function refreshSolar() {
    const upd = document.getElementById("solar-updated");
    upd.textContent = "loading…";
    let data = null;
    try {
      const res = await fetch("api/solar.php", { cache: "no-store" });
      if (res.ok) data = await res.json();
    } catch { /* PHP not available */ }

    if (!data || data.error) {
      // Direct-to-NOAA fallback (their endpoints allow cross-origin reads)
      data = await solarDirect();
    }
    renderSolar(data);
  }

  /* Tolerant tabular reader — SWPC feeds come as array-of-objects or as
     header-row array-of-arrays with string values; normalise both. */
  function swpcTab(j) {
    if (!Array.isArray(j) || !j.length) return [];
    const first = j[0];
    if (first && !Array.isArray(first) && typeof first === "object") {
      return j.map(r => {
        const o = {};
        for (const k in r) o[k.toLowerCase()] = r[k];
        return o;
      });
    }
    if (Array.isArray(first)) {
      const hdr = first.map(h => String(h).trim().toLowerCase());
      return j.slice(1).map(r => {
        const o = {};
        hdr.forEach((name, i) => { o[name] = r[i]; });
        return o;
      });
    }
    return [];
  }
  function swpcLastNum(rows, col) {
    for (let i = rows.length - 1; i >= 0; i--) {
      const v = rows[i][col];
      if (v !== null && v !== undefined && v !== "" && isFinite(parseFloat(v)))
        return parseFloat(v);
    }
    return null;
  }

  async function solarDirect() {
    const out = {};
    const grab = async (url) => {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) throw new Error("bad response");
      return r.json();
    };
    try {
      const rows = swpcTab(await grab("https://services.swpc.noaa.gov/products/10cm-flux-30-day.json"));
      let v = swpcLastNum(rows, "flux");
      if (v === null && rows.length)
        for (const k in rows[rows.length - 1])
          if (k.includes("flux")) { v = swpcLastNum(rows, k); break; }
      if (v !== null) out.sfi = v;
    } catch {}
    try {
      const rows = swpcTab(await grab("https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json"));
      const kp = swpcLastNum(rows, "kp");
      if (kp !== null) out.kp = kp;
      const a = swpcLastNum(rows, "a_running");
      if (a !== null) out.a_est = a;
      const hist = rows.map(r => parseFloat(r.kp)).filter(v => isFinite(v));
      if (hist.length) out.kp_history = hist.slice(-8);
    } catch {}
    try {
      const rows = swpcTab(await grab("https://services.swpc.noaa.gov/products/solar-wind/plasma-2-hour.json"));
      const v = swpcLastNum(rows, "speed");
      if (v !== null) out.wind_speed = v;
    } catch {}
    try {
      const rows = swpcTab(await grab("https://services.swpc.noaa.gov/products/solar-wind/mag-2-hour.json"));
      let v = swpcLastNum(rows, "bz_gsm");
      if (v === null) v = swpcLastNum(rows, "bz");
      if (v !== null) out.bz = v;
    } catch {}
    out.source = "NOAA SWPC (direct)";
    return out;
  }

  const KP_TO_A = [0, 2, 3, 4, 5, 6, 7, 9, 12, 15, 18, 22, 27, 32, 39, 48, 56, 67, 80, 94, 111, 132, 154, 179, 207, 236, 300, 400];

  function renderSolar(d) {
    d = d || {};
    const set = (id, val, cls) => {
      const el = document.getElementById(id);
      el.textContent = (val === null || val === undefined || Number.isNaN(val)) ? "—" : val;
      el.classList.remove("good", "warn", "bad");
      if (cls) el.classList.add(cls);
    };
    const sfi = d.sfi, kp = d.kp;

    set("sv-sfi", sfi != null ? Math.round(sfi) : null, sfi >= 120 ? "good" : null);
    set("sv-ssn", d.ssn != null ? Math.round(d.ssn) : null);
    set("sv-kp", kp != null ? kp.toFixed(1) : null, kp == null ? null : kp < 3 ? "good" : kp < 5 ? "warn" : "bad");

    let a = d.a_est;
    if (a == null && Array.isArray(d.kp_history) && d.kp_history.length) {
      const sum = d.kp_history.reduce((s, k) => s + KP_TO_A[Math.min(27, Math.round(k * 3))], 0);
      a = Math.round(sum / d.kp_history.length);
    }
    set("sv-a", a != null ? a : null, a == null ? null : a < 15 ? "good" : a < 30 ? "warn" : "bad");
    set("sv-wind", d.wind_speed != null ? Math.round(d.wind_speed) : null,
      d.wind_speed == null ? null : d.wind_speed < 450 ? "good" : d.wind_speed < 600 ? "warn" : "bad");
    set("sv-bz", d.bz != null ? d.bz.toFixed(1) : null,
      d.bz == null ? null : d.bz > -2 ? "good" : d.bz > -6 ? "warn" : "bad");

    document.getElementById("sv-xray").textContent =
      "X-ray: " + (d.xray_class ? d.xray_class : "—");
    const any = [sfi, kp, d.ssn, d.wind_speed, d.bz, a].some(v => v != null);
    document.getElementById("solar-updated").textContent =
      any ? new Date().toUTCString().slice(17, 25) + "z" : "unavailable";

    renderBands(d);
  }

  function renderBands(d) {
    const body = document.getElementById("band-body");
    let sfi = d.sfi, kp = d.kp, note = "";
    if (sfi == null && d.ssn != null) {
      // classic SSN→SFI approximation when the flux feed is down
      sfi = 63.7 + 0.727 * d.ssn + 8.95e-4 * d.ssn * d.ssn;
      note = ` <tr><td colspan="3" class="muted">SFI ≈ ${Math.round(sfi)} estimated from SSN ${Math.round(d.ssn)}</td></tr>`;
    }
    if (sfi == null && kp == null) {
      body.innerHTML = `<tr><td colspan="3" class="muted">No solar data — check the API or your connection.</td></tr>`;
      return;
    }
    const s = sfi ?? 100, k = kp ?? 2;
    const geoPen = k >= 6 ? 2 : k >= 4 ? 1 : 0;
    const rows = [
      ["80m–40m", 1 - (k >= 5 ? 1 : 0),                 2 - geoPen],
      ["30m–20m", (s >= 95 ? 2 : 1) - geoPen,           (s >= 100 ? 2 : 1) - geoPen],
      ["17m–15m", (s >= 115 ? 2 : s >= 90 ? 1 : 0) - geoPen, (s >= 140 ? 1 : 0)],
      ["12m–10m", (s >= 140 ? 2 : s >= 110 ? 1 : 0) - geoPen, (s >= 180 ? 1 : 0)]
    ];
    const cell = (v) => {
      const lbl = v >= 2 ? "Good" : v >= 1 ? "Fair" : "Poor";
      const cls = v >= 2 ? "cond-good" : v >= 1 ? "cond-fair" : "cond-poor";
      return `<td class="cond ${cls}">${lbl}</td>`;
    };
    body.innerHTML = rows.map(([b, dd, n]) => `<tr><td>${b}</td>${cell(dd)}${cell(n)}</tr>`).join("") + note;
  }

  /* ============ GRID TOOL ============ */
  function wireGridTool() {
    const out = document.getElementById("grid-out");
    document.getElementById("btn-latlon2grid").addEventListener("click", () => {
      const lat = parseFloat(document.getElementById("grid-lat").value);
      const lon = parseFloat(document.getElementById("grid-lon").value);
      if (!isFinite(lat) || !isFinite(lon)) { out.textContent = "Enter numeric lat/lon first."; return; }
      const g = DSP.latLonToGrid(lat, lon);
      document.getElementById("grid-loc").value = g;
      out.textContent = `${lat.toFixed(4)}, ${lon.toFixed(4)} → ${g}`;
    });
    document.getElementById("btn-grid2latlon").addEventListener("click", () => {
      const g = document.getElementById("grid-loc").value;
      const ll = DSP.gridToLatLon(g);
      if (!ll) { out.textContent = "Grid must look like FN06 or FN06ge."; return; }
      document.getElementById("grid-lat").value = ll.lat.toFixed(4);
      document.getElementById("grid-lon").value = ll.lon.toFixed(4);
      out.textContent = `${g.toUpperCase()} → ${ll.lat.toFixed(4)}, ${ll.lon.toFixed(4)} (square center)`;
    });
    document.getElementById("btn-geoloc").addEventListener("click", () => {
      if (!navigator.geolocation) { out.textContent = "Geolocation not available in this browser."; return; }
      out.textContent = "Asking the browser for your position…";
      navigator.geolocation.getCurrentPosition(pos => {
        const { latitude: lat, longitude: lon } = pos.coords;
        document.getElementById("grid-lat").value = lat.toFixed(4);
        document.getElementById("grid-lon").value = lon.toFixed(4);
        const g = DSP.latLonToGrid(lat, lon);
        document.getElementById("grid-loc").value = g;
        out.textContent = `You are in ${g}`;
      }, err => { out.textContent = "Position unavailable: " + err.message; });
    });
  }

  /* ============ PUBLIC ============ */
  function applySettings(s) {
    settings = s || {};
    const cs = (settings.callsign || "N0CALL").toUpperCase();
    document.getElementById("st-callsign").textContent = cs;
    document.getElementById("side-callsign").textContent = cs;
    const grid = settings.grid ? settings.grid.toUpperCase() : (stationLatLon() ? DSP.latLonToGrid(stationLatLon().lat, stationLatLon().lon) : "—");
    document.getElementById("st-grid").textContent = grid;
    document.getElementById("side-grid").textContent = grid === "—" ? "grid not set" : grid;
    baseMap && drawMap();
  }

  function init(initialSettings) {
    applySettings(initialSettings);
    tickClocks();
    setInterval(tickClocks, 1000);
    loadLand();
    setInterval(drawMap, 60 * 1000);
    refreshSolar();
    setInterval(refreshSolar, 15 * 60 * 1000);
    wireGridTool();
  }

  return { init, applySettings, refreshSolar };
})();
