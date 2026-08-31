#!/usr/bin/env node
/* Help coverage — the documentation contract. Two guarantees:
     1. Every module the studio registers has a Help section.
     2. Every major feature keyword appears somewhere in the manual.
   A new module or feature that ships without documentation fails the suite,
   which is how the Audio Postcard arc went entirely unwritten once and
   never will again.
   Run:  node run_help_coverage.js   (plain node, no dependencies) */
"use strict";
const fs = require("fs");
const path = require("path");

let failures = 0;
function check(name, ok, extra) {
  if (ok) console.log("  ok  " + name);
  else { console.log("FAIL  " + name + (extra ? " — " + extra : "")); failures++; }
}

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "js", "app.js"), "utf8");
const help = fs.readFileSync(path.join(root, "modules", "help", "module.js"), "utf8");

/* 1 — every registered module has a section */
const modIds = [...app.matchAll(/\{ id: "([a-z0-9]+)",\s+name:/g)].map(m => m[1])
  .filter(id => id !== "help");
const helpIds = new Set([...help.matchAll(/\{ id: "([a-z0-9]+)", group:/g)].map(m => m[1]));
console.log(`[coverage] ${modIds.length} modules vs ${helpIds.size} help sections`);
const missing = modIds.filter(id => !helpIds.has(id));
check("every module has a help section", missing.length === 0, missing.join(", "));

/* 2 — the feature-keyword contract (case-insensitive) */
const KEYWORDS = [
  /* audio postcards / VREC deck */
  "postcard", "VREC", "header ring", "optical pickup", "turntable",
  "Load audio", "Load disc PNG", "Play on deck", "Save side WAV",
  "Surface noise", "16-bit", "reconstruction filter", "transparent corners",
  /* moving TV + midi */
  "drunk orchestra", "delta", "walking INTRA refresh",
  /* deck self-diagnosis in troubleshooting */
  "deck fault",
  /* multi-operator privacy promise */
  "own browser"
];
const hay = help.toLowerCase();
for (const kw of KEYWORDS)
  check(`manual mentions "${kw}"`, hay.includes(kw.toLowerCase()));

console.log(failures ? `\n${failures} FAILURE(S)` : "\nhelp coverage passed");
process.exit(failures ? 1 : 0);
