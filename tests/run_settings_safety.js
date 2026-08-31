#!/usr/bin/env node
/* Multi-operator settings safety — the deployment contract.
   Guarantees, checked structurally on every run:
     1. api/settings.php ships with HRWS_SINGLE_OP defined FALSE — a public
        site never persists one ham's settings for everyone.
     2. Both the read and the write paths are gated behind that flag,
        BEFORE any file IO.
     3. js/app.js reads localStorage BEFORE it ever asks the server, and a
        server value cannot override a non-empty local one.
     4. No other script talks to settings.php (no bypass).
     5. Every PHP file that writes to disk is on the audited whitelist.
   Run:  node run_settings_safety.js   (plain node, no dependencies) */
"use strict";
const fs = require("fs");
const path = require("path");

let failures = 0;
function check(name, ok, extra) {
  if (ok) console.log("  ok  " + name);
  else { console.log("FAIL  " + name + (extra ? " — " + extra : "")); failures++; }
}
const root = path.join(__dirname, "..");
const read = p => fs.readFileSync(path.join(root, p), "utf8");

const php = read("api/settings.php");
check("HRWS_SINGLE_OP defaults to false",
      /define\('HRWS_SINGLE_OP',\s*false\)/.test(php));
const gate = php.indexOf("if (!HRWS_SINGLE_OP)");
const write = php.indexOf("file_put_contents");
const readOut = php.indexOf("readfile(");
check("gate exists and precedes the write path", gate >= 0 && write > gate,
      `gate@${gate} write@${write}`);
check("gate precedes the read-out path", readOut > gate, `read@${readOut}`);
check("disabled POST answers 403", /403[\s\S]{0,200}enabled/.test(php) ||
      /enabled[\s\S]{0,200}403/.test(php));

const app = read("js/app.js");
const body = app.slice(app.indexOf("async function loadSettings"),
                       app.indexOf("async function saveSettings"));
const iLocal = body.indexOf('localStorage.getItem("hrws-settings")');
const iFetch = body.indexOf('fetch("api/settings.php"');
check("loadSettings reads the browser first", iLocal >= 0 && iFetch > iLocal,
      `local@${iLocal} fetch@${iFetch}`);
check("a local value returns before the server is asked",
      /return local;/.test(body.slice(iLocal, iFetch)));
check("a disabled server is ignored", /enabled !== false/.test(body));

let bypass = [];
const walk = d => {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p);
    else if (/\.js$/.test(f.name) && !p.includes(path.join("js", "app.js")) &&
             fs.readFileSync(p, "utf8").includes("settings.php"))
      bypass.push(path.relative(root, p));
  }
};
walk(path.join(root, "js"));
walk(path.join(root, "modules"));
check("only app.js talks to settings.php", bypass.length === 0, bypass.join(", "));

const WHITELIST = new Set(["settings.php", "solar.php", "link.php"]);
const writers = fs.readdirSync(path.join(root, "api"))
  .filter(f => f.endsWith(".php"))
  .filter(f => /file_put_contents|fwrite\(/.test(read(path.join("api", f))));
const rogue = writers.filter(f => !WHITELIST.has(f));
check("every writing PHP endpoint is on the audited whitelist",
      rogue.length === 0, rogue.join(", "));

/* 6 — the settings dialog must not advertise server storage */
{
  const html = read("index.html");
  const note = (html.match(/<p class="mono muted modal-note">[\s\S]*?<\/p>/) || [""])[0];
  check("settings dialog copy is implementation-free (no PHP/server/api talk)",
        note.length > 0 && !/php|server|api\/|settings\.json|single-operator/i.test(note),
        note);
  check("dialog states the one user-relevant fact",
        /Saved in this browser/i.test(note));
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nsettings safety passed");
process.exit(failures ? 1 : 0);
