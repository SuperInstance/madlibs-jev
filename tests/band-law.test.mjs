// tests/band-law.test.mjs — WP-12: the unified band mechanism must reproduce
// the engine's deadband decisions on the REAL ledger, branch-for-branch.
// The law is one comparator (decide) over a region; this battery proves the
// madlibs-jev surface instantiates it exactly, and that the purpose-loops
// value-floor region is the same comparator with a different region.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  loadTemplate, bandFor, learnedBands, similarShape, hash01, round4,
  readLedger,
} from "../engine.mjs";
import {
  regionTwoSided, regionOneSided, decide, escalation, explain, SURFACES,
} from "../band-law.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const T = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), "utf8"));
const ledgerRows = () => readLedger(new URL("../receipts/ledger.jsonl", import.meta.url).pathname);

// ---------------------------------------------------------------- regions

test("regionTwoSided mirrors bandFor branch-for-branch (property, 200 seeded cases)", () => {
  for (let i = 0; i < 200; i++) {
    const n = Math.floor(hash01(`n|${i}`) * 6); // 0..5 priors
    const priors = Array.from({ length: n }, (_, j) => round4(hash01(`p|${i}|${j}`)));
    const learned = hash01(`l|${i}`) < 0.2
      ? { lo: round4(hash01(`ll|${i}`)), hi: round4(0.5 + hash01(`lh|${i}`) / 2) }
      : undefined;
    const expected = bandFor(priors, learned);
    const got = regionTwoSided(priors, { learned });
    if (expected === null) {
      assert.equal(got, null, `n=0 case ${i} must be null`);
      continue;
    }
    assert.equal(got.kind, "two-sided");
    assert.equal(got.learned, !!expected.learned, `learned flag case ${i}`);
    assert.equal(Math.round(got.lo * 10000) / 10000, expected.lo, `lo case ${i} priors=${priors}`);
    assert.equal(Math.round(got.hi * 10000) / 10000, expected.hi, `hi case ${i} priors=${priors}`);
  }
});

test("regionTwoSided knobs: k, floor, singleHalf are pre-registerable", () => {
  const wide = regionTwoSided([0.5, 0.5, 0.5], { k: 4 });
  const tight = regionTwoSided([0.5, 0.5, 0.5], { k: 1, floor: 0.01 });
  assert.ok(wide.hi - wide.lo > tight.hi - tight.lo, "k widens the band");
  const floored = regionTwoSided([0.5, 0.5, 0.50001], { floor: 0.2, k: 1 });
  assert.ok(floored.hi - floored.lo >= 0.4 - 1e-9, "floor keeps a minimum halfwidth");
  const single = regionTwoSided([0.6], { singleHalf: 0.05 });
  assert.ok(Math.abs(single.hi - single.lo - 0.1) < 1e-9, "singleHalf governs the n=1 band");
});

test("regionOneSided: the purpose surface's value floor", () => {
  const R = regionOneSided(0.005);
  assert.equal(R.kind, "value-floor");
  assert.equal(R.hiInclusive, false, "marginal == deadband already spends");
  assert.equal(decide(0.0, R), "REST", "zero marginal -> pause (rest)");
  assert.equal(decide(0.004, R), "REST", "under deadband -> pause");
  assert.equal(decide(0.005, R), "ESCALATE", "at deadband -> spend (purpose.plan: marginal < deadband pauses, == goes)");
  assert.equal(decide(1.0, R), "ESCALATE");
});

// ---------------------------------------------------------------- decision

test("decide is OPEN with no region, REST inside, ESCALATE outside (inclusive ends)", () => {
  assert.equal(decide(0.5, null), "OPEN");
  const R = { lo: 0.2, hi: 0.8, kind: "two-sided" };
  assert.equal(decide(0.2, R), "REST");
  assert.equal(decide(0.8, R), "REST");
  assert.equal(decide(0.1999, R), "ESCALATE");
  assert.equal(decide(0.8001, R), "ESCALATE");
});

// ------------------------------------------------- ledger equivalence (A)

test("LAW PROOF surface A: decide reproduces engine deadband on every real ledger row", () => {
  const rows = ledgerRows();
  const runRows = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.kind === "run");
  assert.ok(runRows.length >= 10, "ledger of record carries the wave-67 runs");
  const templates = new Map();
  let checked = 0;
  for (const { r, i } of runRows) {
    const tkey = `${r.template}|${r.version}`;
    if (!templates.has(tkey)) {
      templates.set(tkey, loadTemplate(T(`../templates/${r.template}${r.version > 1 ? ".v" + r.version : ""}.json`)));
    }
    const t = templates.get(tkey);
    // rebuild the band EXACTLY as engine.mjs does at append time: priors are
    // the rows BEFORE this one (the ledger as this run saw it)
    const history = rows.slice(0, i);
    const priorCoherences = [];
    let prior = null;
    for (const h of history) {
      if (h.kind !== "run" || h.template !== r.template || h.version !== r.version) continue;
      if (!similarShape(t, h.fills, r.fills)) continue;
      priorCoherences.push(h.coherence);
      prior = h; // newest match wins
    }
    const learned = learnedBands(history, r.template, r.version)[r.shape_seed];
    const region = regionTwoSided(priorCoherences, { learned });
    const d = decide(r.coherence, region);
    const inBand = !!(region && r.coherence >= region.lo && r.coherence <= region.hi);
    assert.equal(d === "REST", inBand, `run ${r.run_id}: comparator must equal engine in_band`);
    if (r.deadband.band) {
      assert.equal(Math.round(region.lo * 10000) / 10000, r.deadband.band.lo, `band lo receipted ${r.run_id}`);
      assert.equal(Math.round(region.hi * 10000) / 10000, r.deadband.band.hi, `band hi receipted ${r.run_id}`);
    }
    // surface semantics: the law rests; the surface supplies the rest-action
    if (r.deadband.mode === "replay") {
      assert.equal(d, "REST", `replay must be REST ${r.run_id}`);
      assert.ok(prior, "replay requires a prior (the surface precondition)");
    }
    if (r.deadband.mode === "breach") assert.equal(d, "ESCALATE", `breach must be ESCALATE ${r.run_id}`);
    if (r.deadband.mode === "live") {
      assert.ok(d === "OPEN" || d === "ESCALATE", `live is OPEN (no band) or a coherence breach ${r.run_id}`);
    }
    checked++;
  }
  assert.ok(checked >= 10, `checked ${checked} real decisions against the law`);
});

test("LAW PROOF surface B: the value-floor comparator reproduces purpose-loops gate decisions", () => {
  // purpose receipts are the other repo's; the DEMO DATA of record for this
  // proof lives in purpose-loops/demo/receipts. Here we prove the comparator
  // semantics the vendored test will exercise against real receipts: pause
  // rows are REST, go rows are ESCALATE, at the SAME deadband the loop
  // receipted. (The cross-repo byte-identity of the module is pinned in
  // purpose-loops tests/vendor.test.mjs.)
  const deadband = 0.005; // receipted in purpose-loops main.jsonl loop.open
  const R = regionOneSided(deadband);
  const receipted = [
    { kind: "iteration.begin", marginal: 1 },                    // main it.1: go (cold, assumed 1 op)
    { kind: "iteration.begin", marginal: 0.010101010101010102 }, // main it.2: go
    { kind: "iteration.begin", marginal: 0.014925373134328358 }, // main it.3: go
    { kind: "purpose.pause", marginal: 0 },                      // main it.4: paused at gate (stopmet already recorded)
    { kind: "iteration.begin", marginal: 0.010101010101010102 }, // control it.2-3: go (flat 99 cost curve, units still come)
  ];
  for (const row of receipted) {
    const d = decide(row.marginal, R);
    if (row.kind === "purpose.pause") assert.equal(d, "REST", `pause must be REST at marginal ${row.marginal}`);
    else assert.equal(d, "ESCALATE", `go must be ESCALATE at marginal ${row.marginal}`);
  }
});

// -------------------------------------------------------------- escalation

test("escalation: hysteresis compounds breaches, REST resets, level caps at 3", () => {
  const R = { lo: 0.4, hi: 0.6, kind: "two-sided" };
  let s = { breaches: 0, level: 0 };
  ({ state: s } = escalation(s, 0.5, R, { after: 2 }));
  assert.equal(s.level, 0, "rest keeps level 0");
  ({ state: s } = escalation(s, 0.9, R, { after: 2 }));
  assert.equal(s.level, 0, "first breach: escalate but no level yet");
  ({ state: s } = escalation(s, 0.9, R, { after: 2 }));
  assert.equal(s.level, 1, "second consecutive breach raises level");
  ({ state: s } = escalation(s, 0.5, R, { after: 2 }));
  assert.equal(s.breaches, 0, "rest resets the streak");
  assert.equal(s.level, 0, "rest resets level");
  for (let i = 0; i < 10; i++) ({ state: s } = escalation(s, 0.9, R, { after: 2 }));
  assert.equal(s.level, 3, "level caps at 3");
});

// ------------------------------------------------------------------- misc

test("explain() speaks both surface dialects", () => {
  assert.match(explain(0, regionOneSided(0.005), "REST"), /no surprise, no spend/);
  assert.match(explain(0.4, { lo: 0.2, hi: 0.6, kind: "two-sided" }, "REST"), /inside/);
  assert.match(explain(0.9, { lo: 0.2, hi: 0.6, kind: "two-sided" }, "ESCALATE"), /surprise/);
  assert.match(explain(0.5, null, "OPEN"), /no region yet/);
});

test("SURFACES: the three derivations are declared and checkable", () => {
  for (const k of ["madlibs-jev", "purpose-loops", "reflex-router"]) {
    assert.ok(SURFACES[k], `${k} surface declared`);
    assert.ok(SURFACES[k].x && SURFACES[k].region && SURFACES[k].receipt, `${k} surface self-describes`);
  }
});

// ------------------------------------------------- band integrity (seal)

test("INDETERMINATE compile receipts do not feed learned bands (refused canonization)", () => {
  const rows = [
    { kind: "compile", template: "t", parent_version: 1, verdict: "INDETERMINATE", bands: { aaa: { lo: 0.1, hi: 0.2 } } },
    { kind: "compile", template: "t", parent_version: 1, bands: { bbb: { lo: 0.3, hi: 0.4 } } }, // pre-seal history
    { kind: "compile", template: "t", parent_version: 1, verdict: "CANONIZED", bands: { ccc: { lo: 0.5, hi: 0.6 } } },
  ];
  const learned = learnedBands(rows, "t", 1);
  assert.deepEqual(learned, { ccc: { lo: 0.5, hi: 0.6 } },
    "newest admissible compile wins; the INDETERMINATE receipt is skipped, not deleted");
  // refusal at the TIP removes the learned bands entirely (fall back to a priori bandFor)
  const refusedOnly = [
    { kind: "compile", template: "t", parent_version: 1, verdict: "INDETERMINATE", bands: { aaa: { lo: 0.1, hi: 0.2 } } },
  ];
  assert.deepEqual(learnedBands(refusedOnly, "t", 1), {}, "a refused compile leaves no learned bands");
});
