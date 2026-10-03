#!/usr/bin/env node
// compile.mjs — template evolution: after N runs, tune nudge weights from
// which nudges correlated with high coherence, and emit template vNext.
// Append-only: v1 is never modified; the child carries parent_version +
// parent_sha; a compile receipt links the lineage into the same ledger.
//
// SEALED COMPILES (spec/invariants.json — committed before this code): the
// compile is a self-modification step, so every canonization runs the full
// chain: (a) expectation hash — spec_sha = sha256(canon(spec)); (b) config —
// the parent template + its evidence run set; (c) result — the child, whose
// receipt carries the evaluated invariants and the verdict.
//   * missing / malformed spec -> COMPILE_REFUSED, exit 1, and NOTHING
//     happens: no receipt, no vNext file (a receipt of nothing is noise).
//   * invariant breach -> receipt appended with verdict INDETERMINATE, the
//     vNext file is NOT written, exit 1. The refusal is receipted history
//     (append-only); the refused child is identified by child_sha but never
//     materialized.
//
//   node compile.mjs <template.json> [--ledger receipts/ledger.jsonl]
//        [--min-runs 3] [--spec spec/invariants.json]
//
// Deterministic: same ledger -> byte-identical vNext (modulo the compiled_ts
// receipt field, which lives in the ledger, not the template).

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  loadTemplate, compileTemplate, templateSha, readLedger, verifyLedger,
  appendReceipt, bandFor, canon, sha256, round4,
} from "./engine.mjs";

const SPEC_NAME = "madlibs-jev.compile.invariants";
const KNOWN_INVARIANTS = ["novelty-dispersion", "tuning-weight-bounds", "band-nondegeneracy"];

// ------------------------------------------------------------- spec loading
export function loadSpec(specPath) {
  if (!fs.existsSync(specPath)) {
    throw Object.assign(
      new Error(`NO INVARIANT SPEC — PRE-REGISTRATION IS MANDATORY (${specPath} missing)`),
      { code: "SPEC_MISSING" });
  }
  let spec;
  try { spec = JSON.parse(fs.readFileSync(specPath, "utf8")); }
  catch (e) {
    throw Object.assign(new Error(`INVARIANT SPEC MALFORMED (${specPath}): ${e.message}`),
      { code: "SPEC_MALFORMED" });
  }
  const bad = (msg) => Object.assign(
    new Error(`INVARIANT SPEC MALFORMED (${specPath}): ${msg}`), { code: "SPEC_MALFORMED" });
  if (!spec || spec.spec !== SPEC_NAME || !Number.isInteger(spec.version) ||
      !Array.isArray(spec.invariants) || spec.invariants.length === 0)
    throw bad(`expected {"spec":"${SPEC_NAME}","version":N,"invariants":[...]}`);
  const seen = new Set();
  for (const inv of spec.invariants) {
    if (!inv || typeof inv.id !== "string" || !inv.id) throw bad("invariant missing id");
    if (typeof inv.derivation !== "string" || !inv.derivation)
      throw bad(`invariant ${inv.id}: derivation required (metric + floor provenance, no vibes)`);
    if (seen.has(inv.id)) throw bad(`duplicate invariant id: ${inv.id}`);
    seen.add(inv.id);
  }
  return spec;
}

// ------------------------------------------------------------- measurements
const stdevPop = (xs) => {
  const n = xs.length;
  if (!n) return null;
  const m = xs.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / n);
};
// the novelty axis value of a run receipt, wherever the cell kind put it
const noveltyValue = (r, id) => r.nudge_vector?.[id]?.value ?? r.structure?.[id] ?? null;

// --------------------------------------------------------------- invariant
// Each evaluator returns { id, status: "PASS"|"SKIP"|"FAIL", measured, floor,
// pass, reason? }. SKIP is receipted indeterminacy with a stated reason —
// never a silent pass, never a fail.
function checkNoveltyDispersion(specInv, parent, child, runs, rows) {
  const id = specInv.target ?? "novelty";
  const parentCell = parent.cells.find((c) => c.id === id);
  const skip = (reason, measured = {}) => ({
    id: specInv.id, status: "SKIP", measured, floor: specInv.floor, pass: true, reason,
  });
  if (!parentCell)
    return skip(`template has no '${id}' cell — invariant target absent`);
  // sub-check B — structural identity: compileTemplate retunes weights only
  // and cannot move formulas, so a child-side drift means a hand edit, and
  // it fails here even if the dispersion floor would pass.
  const childCell = child.cells.find((c) => c.id === id);
  const identity = {
    parent_expr: parentCell.expr, child_expr: childCell ? childCell.expr : null,
    parent_kind: parentCell.kind, child_kind: childCell ? childCell.kind : null,
    equal: !!childCell && childCell.expr === parentCell.expr && childCell.kind === parentCell.kind,
  };
  // sub-check A — dispersion floor, relative to the parent-version rung
  const rungVersion = parent.parent_version ?? null;
  const rungRuns = rungVersion == null ? [] : rows.filter((r) =>
    r.kind === "run" && r.template === parent.name && r.version === rungVersion);
  const evidenceVals = runs.map((r) => noveltyValue(r, id));
  const rungVals = rungRuns.map((r) => noveltyValue(r, id));
  const evidenceStdev = (evidenceVals.length && evidenceVals.every((v) => v != null))
    ? round4(stdevPop(evidenceVals)) : null;
  const rungStdev = (rungVals.length && rungVals.every((v) => v != null))
    ? round4(stdevPop(rungVals)) : null;
  const floorValue = rungStdev == null ? null : round4(0.5 * stdevPop(rungVals));
  const measured = {
    identity,
    evidence_runs: runs.length, rung_version: rungVersion, rung_runs: rungRuns.length,
    evidence_stdev: evidenceStdev, rung_stdev: rungStdev,
  };
  if (!identity.equal)
    return {
      id: specInv.id, status: "FAIL", measured, floor: specInv.floor, pass: false,
      reason: "structural identity broken: child's novelty cell was edited outside the compile loop (compileTemplate only retunes weights)",
    };
  if (rungVersion == null)
    return skip("no parent version rung (genesis template) — relative floor undefined", measured);
  if (runs.length < 3)
    return skip(`fewer than 3 evidence runs (${runs.length})`, measured);
  if (rungRuns.length < 3)
    return skip(`parent rung v${rungVersion} has fewer than 3 runs (${rungRuns.length})`, measured);
  if (evidenceStdev == null || rungStdev == null)
    return skip("run receipts missing a novelty value on the measured axis", measured);
  return {
    id: specInv.id, status: evidenceStdev >= floorValue ? "PASS" : "FAIL",
    measured, floor: floorValue, pass: evidenceStdev >= floorValue,
    ...(evidenceStdev >= floorValue ? {} : {
      reason: `novelty dispersion collapsed: evidence stdev ${evidenceStdev} < 0.5 x parent-rung stdev ${rungStdev} (floor ${floorValue}) — refusing to canonize evolution built on a flattened run set`,
    }),
  };
}

function checkTuningWeightBounds(specInv, parent, child) {
  const EPS = 1e-4; // round4 decimal tolerance on the closure edges
  const byCell = new Map((child.evolution?.tuning ?? []).map((t) => [t.cell, t]));
  const violations = [];
  let checked = 0;
  const weights = [];
  for (const c of child.cells.filter((c) => c.kind === "nudge")) {
    const p = parent.cells.find((x) => x.id === c.id);
    const w0 = p ? p.weight : null, w1 = c.weight;
    weights.push(w1);
    const entry = byCell.get(c.id);
    const tuned = !!(entry && entry.to !== entry.from);
    if (w0 == null) { violations.push({ cell: c.id, from: w0, to: w1, why: "nudge cell absent from parent" }); continue; }
    if (!tuned) {
      if (w1 !== w0) violations.push({ cell: c.id, from: w0, to: w1, why: "weight moved without a tuning entry" });
      else checked++;
      continue;
    }
    const hi = Math.max(0.2, 2 * w0); // engine clamp closure over corr in [-1,1]
    if (!(w1 >= 0.2 - EPS && w1 <= hi + EPS))
      violations.push({ cell: c.id, from: w0, to: w1, closure: [0.2, hi], why: "tuned weight outside the pre-registered clamp closure [0.2, max(0.2, 2 x parent weight)]" });
    else checked++;
  }
  return {
    id: specInv.id, status: violations.length ? "FAIL" : "PASS",
    measured: {
      nudge_cells: checked + violations.length,
      min_weight: weights.length ? Math.min(...weights) : null,
      max_weight: weights.length ? Math.max(...weights) : null,
      violations,
    },
    floor: specInv.floor, pass: violations.length === 0,
    ...(violations.length ? { reason: violations.map((v) => `${v.cell}: ${v.why} (${v.from} -> ${v.to})`).join("; ") } : {}),
  };
}

function checkBandNondegeneracy(specInv, bands) {
  const degenerate = [];
  const entries = Object.entries(bands ?? {});
  for (const [shapeSeed, band] of entries) {
    if (!band || !Number.isFinite(band.lo) || !Number.isFinite(band.hi) || !(band.hi > band.lo))
      degenerate.push({ shape_seed: shapeSeed, band: band ?? null });
  }
  return {
    id: specInv.id, status: degenerate.length ? "FAIL" : "PASS",
    measured: { bands: entries.length, degenerate },
    floor: specInv.floor, pass: degenerate.length === 0,
    ...(degenerate.length ? { reason: `degenerate band(s): ${degenerate.map((d) => d.shape_seed).join(", ")} — the muffled-drum failure mode` } : {}),
  };
}

export function evaluateInvariants(spec, parent, child, runs, rows, bands) {
  const results = [];
  for (const inv of spec.invariants) {
    if (!KNOWN_INVARIANTS.includes(inv.id)) {
      throw Object.assign(
        new Error(`UNEVALUABLE INVARIANT IN SPEC: ${inv.id} — the spec names a check this compile does not implement; implement it first, then bump the spec (pre-registration runs ahead of code, never behind)`),
        { code: "SPEC_UNEVALUABLE" });
    }
    if (inv.id === "novelty-dispersion") results.push(checkNoveltyDispersion(inv, parent, child, runs, rows));
    else if (inv.id === "tuning-weight-bounds") results.push(checkTuningWeightBounds(inv, parent, child));
    else results.push(checkBandNondegeneracy(inv, bands));
  }
  return results;
}

// ------------------------------------------------------------- the compile
// opts: { templatePath, ledgerPath, minRuns, specPath, now }
// Returns { verdict: "CANONIZED"|"INDETERMINATE"|"REFUSED", receipt?, ... }.
// REFUSED means nothing happened: no receipt appended, no file written.
export function compileOnce({ templatePath, ledgerPath = "receipts/ledger.jsonl", minRuns = 3, specPath = "spec/invariants.json", now = Date.now() } = {}) {
  // 0. pre-registration gate — BEFORE reading the ledger: a compile without
  //    its invariant spec is refused and the ledger is never touched.
  const spec = loadSpec(specPath);
  const specSha = sha256(canon(spec));

  const parent = loadTemplate(JSON.parse(fs.readFileSync(templatePath, "utf8")));
  const rows = readLedger(ledgerPath);
  const v = verifyLedger(rows);
  if (!v.ok) return { ok: false, verdict: "REFUSED", reason: "ledger failed verification", detail: v, specSha };

  const runs = rows.filter((r) => r.kind === "run" && r.template === parent.name && r.version === parent.version);
  if (runs.length === 0) return { ok: false, verdict: "REFUSED", reason: `no runs for ${parent.name} v${parent.version}`, specSha };

  const child = compileTemplate(parent, rows, { minRuns, now });
  // strip parsed ASTs — version files carry clean cells only (the sha ignores
  // them either way, so lineage shas in the ledger remain valid)
  const childClean = { ...child, cells: child.cells.map(({ _ast, ...rest }) => rest) };
  const childSha = templateSha(loadTemplate(child));

  // learned bands per shape-class, keyed by the receipt's own shape_seed — the
  // engine looks bands up by the same key it stamps into run receipts.
  const bands = {};
  const byShape = {};
  for (const r of runs) (byShape[r.shape_seed] ??= []).push(r.coherence);
  for (const [shapeSeed, cohs] of Object.entries(byShape)) bands[shapeSeed] = bandFor(cohs);

  let invariants;
  try { invariants = evaluateInvariants(spec, parent, child, runs, rows, bands); }
  catch (e) {
    if (e.code === "SPEC_UNEVALUABLE") return { ok: false, verdict: "REFUSED", reason: e.message, specSha };
    throw e;
  }
  const breached = invariants.filter((i) => i.status === "FAIL");
  const outPath = templatePath.replace(/\.json$/, `.v${child.version}.json`);
  const base = {
    kind: "compile",
    ts: new Date(now).toISOString(),
    template: parent.name,
    parent_version: parent.version,
    parent_sha: templateSha(parent),
    child_version: child.version,
    child_sha: childSha,
    child_path: breached.length ? null : outPath,
    runs_considered: runs.length,
    tuning: child.evolution.tuning,
    note: breached.length
      ? `INDETERMINATE: ${breached.map((b) => `${b.id} — ${b.reason}`).join(" | ")}`
      : child.evolution.note,
    bands,
    spec_path: specPath,
    spec_sha: specSha,
    invariants,
    verdict: breached.length ? "INDETERMINATE" : "CANONIZED",
  };

  if (breached.length) {
    // the refusal IS the history: receipted, append-only; the canonization
    // does not happen and the refused child is never materialized
    const receipt = appendReceipt(ledgerPath, base);
    return { ok: false, verdict: "INDETERMINATE", receipt, child, childClean, outPath, specSha, invariants, bands, runs, breached };
  }
  fs.writeFileSync(outPath, JSON.stringify(childClean, null, 2) + "\n");
  const receipt = appendReceipt(ledgerPath, base);
  return { ok: true, verdict: "CANONIZED", receipt, child, childClean, outPath, specSha, invariants, bands, runs };
}

// ------------------------------------------------------------------- the CLI
async function main() {
  const args = process.argv.slice(2);
  const templatePath = args[0];
  if (!templatePath || !fs.existsSync(templatePath)) {
    console.error("usage: node compile.mjs <template.json> [--ledger receipts/ledger.jsonl] [--min-runs 3] [--spec spec/invariants.json]");
    process.exitCode = 2;
    return;
  }
  const flag = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
  const ledgerPath = flag("--ledger", "receipts/ledger.jsonl");
  const minRuns = Number(flag("--min-runs", 3));
  const specPath = flag("--spec", "spec/invariants.json");

  let out;
  try { out = compileOnce({ templatePath, ledgerPath, minRuns, specPath }); }
  catch (e) {
    if (e.code === "SPEC_MISSING" || e.code === "SPEC_MALFORMED" || e.code === "SPEC_UNEVALUABLE") {
      console.error("COMPILE_REFUSED:", e.message);
      process.exitCode = 1;
      return;
    }
    throw e;
  }
  if (out.verdict === "REFUSED") {
    if (out.detail) console.error("COMPILE_REFUSED: ledger failed verification:", out.detail);
    else console.error("COMPILE_REFUSED: " + out.reason); // "no runs for <name> v<version>"
    process.exitCode = 1;
    return;
  }
  if (out.verdict === "INDETERMINATE") {
    console.error(`COMPILE_INDETERMINATE: invariant breach — vNext NOT written, refusal receipted (tip=${out.receipt.tip})`);
    for (const b of out.breached) console.error(`  breach ${b.id}: ${b.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(`compiled ${out.child.name} v${out.child.parent_version} -> v${out.child.version} -> ${out.outPath}`);
  console.log(`runs considered: ${out.runs.length}; ${out.child.evolution.note}`);
  for (const t of out.child.evolution.tuning) {
    console.log(`  ${t.cell}: corr=${t.corr} weight ${t.from} -> ${t.to}`);
  }
  console.log(`spec_sha ${out.specSha}: ${out.invariants.map((i) => `${i.id}=${i.status}`).join(" ")}`);
  console.log(`receipt ${out.receipt.kind} tip=${out.receipt.tip} verdict=${out.receipt.verdict}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
