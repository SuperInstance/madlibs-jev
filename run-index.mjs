#!/usr/bin/env node
// run-index.mjs — Bridge 1 receipt: the quantized shape index must produce
// the SAME deadband decisions as the full Jaccard scan (it only shortlists),
// while making the index cheap enough to hold in memory at fleet scale.
// A/B over every shape in the existing ledger, decisions compared, mismatches
// are failures (not warnings) — the gate is honest, the accelerator is silent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSheet, loadTemplate, readLedger } from "./engine.mjs";
import { ShapeMemory, embedShape } from "./shape-memory.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ledgerPath = path.join(HERE, "receipts", "ledger.jsonl");
const rows = readLedger(ledgerPath).filter((r) => r.kind === "run");

// build the memory from past runs (the production flow: index once)
const memory = new ShapeMemory();
const templates = {};
for (const r of rows) {
  const key = `${r.template}.v${r.version}`;
  templates[key] ??= loadTemplate(`./templates/${r.template}${r.version > 1 ? ".v" + r.version : ""}.json`);
  memory.add(templates[key], r.fills, r);
}
const stats = memory.compressionStats();

// A/B: for every past shape, re-decide the deadband with and without index.
// Appends go to a TEMP COPY of the ledger — the campaign ledger of record
// is never touched by this experiment (learned the hard way: the first draft
// polluted it with 76 replay rows; reverted from git before any push).
const tmpA = path.join(HERE, "receipts", ".ab-a.jsonl");
const tmpB = path.join(HERE, "receipts", ".ab-b.jsonl");
const decisions = [];
let mismatches = 0;
for (const r of rows) {
  const t = templates[`${r.template}.v${r.version}`];
  // each arm gets a PRISTINE copy PER ITERATION — a shared or
  // once-copied ledger let earlier iterations' appended rows contaminate
  // the scan ("newest match wins" then depends on append order, not the
  // campaign of record). Receipted so the next keeper doesn't re-derive it.
  fs.copyFileSync(ledgerPath, tmpA);
  fs.copyFileSync(ledgerPath, tmpB);
  const common = { seed: r.seed, now: new Date(r.ts).getTime() };
  const without = await runSheet(structuredClone(t), r.fills, { ...common, ledgerPath: tmpA });
  const withIdx = await runSheet(structuredClone(t), r.fills, { ...common, ledgerPath: tmpB, shapeMemory: memory });
  const a = { mode: without.row.deadband.mode, prior: without.row.deadband.prior_run };
  const b = { mode: withIdx.row.deadband.mode, prior: withIdx.row.deadband.prior_run };
  const same = a.mode === b.mode && a.prior === b.prior;
  if (!same) mismatches++;
  decisions.push({
    template: r.template, version: r.version, seed: r.seed,
    without: a, with: b, same,
  });
}

fs.rmSync(tmpA, { force: true }); fs.rmSync(tmpB, { force: true });
console.log(`indexed ${stats.cells} shapes; decisions compared: ${decisions.length}; mismatches: ${mismatches}`);
const d = decisions.filter((x) => !x.same);
if (d.length) { console.log(JSON.stringify(d, null, 1)); process.exit(1); }
console.log("index is decision-identical to the full scan — accelerator receipted, gate unchanged");
