#!/usr/bin/env node
// run.mjs — run a madlibs-jev sheet for real.
//
//   node run.mjs templates/scene-skin.json --fill place="a night ferry" \
//        --fill arrival="in fog" --fill figure="the ferryman" --fill object="a brass key"
//   node run.mjs templates/scene-skin.json --fills fills.json [--ledger receipts/ledger.jsonl]
//
// Keys are loaded from /home/z/my-project/.env.keys (or .env.keys beside the repo).
// Values are never printed. The receipt records which word-smith path ran:
// deepinfra | groq | fallback (deterministic) | replay (deadband, zero tokens).

import fs from "node:fs";
import { loadEnvKeys, runSheet } from "./engine.mjs";

const args = process.argv.slice(2);
const templatePath = args[0];
if (!templatePath || !fs.existsSync(templatePath)) {
  console.error("usage: node run.mjs <template.json> [--fill k=v ...] [--fills fills.json] [--ledger receipts/ledger.jsonl]");
  process.exit(2);
}
const ledger = (() => {
  const i = args.indexOf("--ledger");
  return i >= 0 ? args[i + 1] : "receipts/ledger.jsonl";
})();

const fills = {};
const fj = args.indexOf("--fills");
if (fj >= 0) Object.assign(fills, JSON.parse(fs.readFileSync(args[fj + 1], "utf8")));
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--fill") {
    const kv = args[i + 1];
    const eq = kv.indexOf("=");
    fills[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
}

loadEnvKeys(process.env.MADLIBS_JEV_KEYS ?? "/home/z/my-project/.env.keys");

try {
  const { row, tip } = await runSheet(templatePath, fills, { ledgerPath: ledger });
  console.log(`run    ${row.run_id}`);
  console.log(`mode   ${row.deadband.mode}${row.deadband.prior_run ? " (prior " + row.deadband.prior_run + ")" : ""}`);
  console.log(`vector ${JSON.stringify(Object.fromEntries(Object.entries(row.nudge_vector).map(([k, v]) => [k, v.contrib])))}`);
  console.log(`cohere ${row.coherence}`);
  for (const c of row.wordsmith_calls) {
    console.log(`smith  ${c.cell}: ${c.path}${c.model ? " (" + c.model + ")" : ""}${c.usage ? " tokens=" + c.usage.total_tokens : ""}${c.path === "replay" ? " saved=" + row.deadband.tokens_saved : ""}`);
  }
  console.log(`tip    ${tip}`);
  console.log("--- words ---");
  console.log(row.words_text);
} catch (e) {
  console.error("RUN_FAILED:", e.message);
  if (e.errors) console.error(e.errors.join("\n"));
  process.exit(1);
}
