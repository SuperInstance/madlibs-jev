#!/usr/bin/env node
// compile.mjs — template evolution: after N runs, tune nudge weights from
// which nudges correlated with high coherence, and emit template vNext.
// Append-only: v1 is never modified; the child carries parent_version +
// parent_sha; a compile receipt links the lineage into the same ledger.
//
//   node compile.mjs templates/scene-skin.json [--ledger receipts/ledger.jsonl] [--min-runs 3]
//
// Deterministic: same ledger -> byte-identical vNext (modulo the compiled_ts
// receipt field, which lives in the ledger, not the template).

import fs from "node:fs";
import {
  loadTemplate, compileTemplate, templateSha, readLedger, verifyLedger,
  appendReceipt, similarShape, bandFor,
} from "./engine.mjs";

const args = process.argv.slice(2);
const templatePath = args[0];
if (!templatePath || !fs.existsSync(templatePath)) {
  console.error("usage: node compile.mjs <template.json> [--ledger receipts/ledger.jsonl] [--min-runs 3]");
  process.exit(2);
}
const ledgerPath = (() => { const i = args.indexOf("--ledger"); return i >= 0 ? args[i + 1] : "receipts/ledger.jsonl"; })();
const minRuns = (() => { const i = args.indexOf("--min-runs"); return i >= 0 ? Number(args[i + 1]) : 3; })();

const parent = loadTemplate(JSON.parse(fs.readFileSync(templatePath, "utf8")));
const rows = readLedger(ledgerPath);
const v = verifyLedger(rows);
if (!v.ok) { console.error("COMPILE_REFUSED: ledger failed verification:", v); process.exit(1); }

const runs = rows.filter((r) => r.kind === "run" && r.template === parent.name && r.version === parent.version);
if (runs.length === 0) { console.error("COMPILE_REFUSED: no runs for", parent.name, "v" + parent.version); process.exit(1); }

const child = compileTemplate(parent, rows, { minRuns });
// strip parsed ASTs — version files carry clean cells only (the sha ignores
// them either way, so lineage shas in the ledger remain valid)
const childClean = { ...child, cells: child.cells.map(({ _ast, ...rest }) => rest) };

// learned bands per shape-class, keyed by the receipt's own shape_seed — the
// engine looks bands up by the same key it stamps into run receipts.
const bands = {};
const byShape = {};
for (const r of runs) (byShape[r.shape_seed] ??= []).push(r.coherence);
for (const [shapeSeed, cohs] of Object.entries(byShape)) bands[shapeSeed] = bandFor(cohs);

const outPath = templatePath.replace(/\.json$/, `.v${child.version}.json`);
fs.writeFileSync(outPath, JSON.stringify(childClean, null, 2) + "\n");

const receipt = appendReceipt(ledgerPath, {
  kind: "compile",
  ts: new Date().toISOString(),
  template: parent.name,
  parent_version: parent.version,
  parent_sha: templateSha(parent),
  child_version: child.version,
  child_sha: templateSha(loadTemplate(child)),
  child_path: outPath,
  runs_considered: runs.length,
  tuning: child.evolution.tuning,
  note: child.evolution.note,
  bands,
});

console.log(`compiled ${parent.name} v${parent.version} -> v${child.version} -> ${outPath}`);
console.log(`runs considered: ${runs.length}; ${child.evolution.note}`);
for (const t of child.evolution.tuning) {
  console.log(`  ${t.cell}: corr=${t.corr} weight ${t.from} -> ${t.to}`);
}
console.log(`receipt ${receipt.kind} tip=${receipt.tip}`);
