// tests/engine.test.mjs — node:test battery for madlibs-jev. NO NETWORK:
// the word-smith is always a mock or the deterministic fallback.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadTemplate, Sheet, templateSha, parseFormula, evalFormula, collectIdents,
  accumulateNudges, similarShape, bandFor, lightMorph, fallbackWordsmith,
  runSheet, readLedger, verifyLedger, compileTemplate, learnedBands,
  pearson, hash01, canon,
} from "../engine.mjs";

const T = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), "utf8"));
const sceneV1 = () => T("../templates/scene-skin.json");
const discV1 = () => T("../templates/discovery-skin.json");

function tmpLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mjev-"));
  return path.join(dir, "ledger.jsonl");
}

const mockLLM = () => {
  let n = 0;
  const fn = async () => {
    n += 1;
    return { text: `MOCK-WORDS-${n}`, path: "mock", model: "mock-1", llm: true,
             usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, ms: 1 };
  };
  fn.count = () => n;
  return fn;
};

// ------------------------------------------------------------- 1. parsing
test("template parsing: valid sheets load with all four cell kinds", () => {
  for (const t of [sceneV1(), discV1()]) {
    const lt = loadTemplate(t);
    assert.equal(lt.name, t.name);
    assert.equal(lt.version, t.version);
    const kinds = new Set(lt.cells.map((c) => c.kind));
    for (const k of ["situation", "structure", "nudge", "wordsmith"]) assert.ok(kinds.has(k), k);
  }
});

test("template parsing: invalid sheets fail-closed with named errors", () => {
  assert.throws(() => loadTemplate({ name: "x" }), /TEMPLATE_INVALID/);
  assert.throws(() => loadTemplate({ name: "x", version: 1, cells: [] }), /needs at least one wordsmith/);
  assert.throws(() => loadTemplate({ name: "x", version: 1, cells: [
    { id: "z", kind: "quantum", expr: "1" },
    { id: "w", kind: "wordsmith", instruction: "hi" },
  ]}), /bad kind quantum/);
  assert.throws(() => loadTemplate({ name: "x", version: 1, cells: [
    { id: "n", kind: "nudge", weight: 1, expr: "nope * 2" },
    { id: "w", kind: "wordsmith", instruction: "hi" },
  ]}), /unknown name 'nope'/);
  // forward reference is also illegal (unspoken skeleton flows one way)
  assert.throws(() => loadTemplate({ name: "x", version: 1, cells: [
    { id: "a", kind: "nudge", weight: 1, expr: "b + 1" },
    { id: "b", kind: "structure", expr: "1" },
    { id: "w", kind: "wordsmith", instruction: "hi" },
  ]}), /unknown name 'b'/);
});

test("template parsing: choice slots must come from options", () => {
  const s = new Sheet(sceneV1());
  assert.throws(() => s.fill("place", "a casino"), /BAD_CHOICE/);
  assert.throws(() => s.fill("not_a_slot", "x"), /NOT_A_SLOT/);
});

// ------------------------------------------------- 2. formula determinism
test("formula DSL: arithmetic, strings, ternary, functions", () => {
  const env = { a: 2, s: "ferry" };
  const ev = (src, e = env) => evalFormula(parseFormula(src), e);
  assert.equal(ev("1 + 2 * 3"), 7);
  assert.equal(ev("(1 + 2) * 3"), 9);
  assert.equal(ev("a * 4 - 1"), 7);
  assert.equal(ev("\"night \" + s"), "night ferry");
  assert.equal(ev("len(s)"), 5);
  assert.equal(ev("s == \"ferry\" ? 10 : 20"), 10);
  assert.equal(ev("clamp(5, 0, 1)"), 1);
  assert.equal(ev("sway(1)"), 1);
  assert.equal(ev("sway(0)"), -1);
  assert.equal(ev("sway(\"x\") === sway(\"x\") ? 1 : 0"), 1);
  assert.ok(ev("hash01(\"dread|x\")") >= 0 && ev("hash01(\"dread|x\")") <= 1);
  assert.equal(ev("pick(\"a|b|c\", \"seed\")"), evalFormula(parseFormula("pick(\"a|b|c\", \"seed\")"), env));
  assert.throws(() => ev("mystery + 1"), /UNKNOWN_NAME:mystery/);
  assert.throws(() => ev("nosuch(1)"), /UNKNOWN_FUNC/);
});

test("formula DSL: same source parses to identical AST shapes (determinism)", () => {
  const a = collectIdents(parseFormula("clamp(len(figure) / 24, 0, 1)"));
  const b = collectIdents(parseFormula("clamp(len(figure) / 24, 0, 1)"));
  assert.deepEqual([...a].sort(), [...b].sort());
  assert.deepEqual([...a], ["figure"]);
});

// ------------------------------------------- 3. nudge accumulation determinism
test("nudge accumulation is byte-deterministic for identical situation facts", async () => {
  const fills = { place: "a night ferry", arrival: "in fog", figure: "the ferryman", object: "a brass key" };
  const r1 = await runSheet(sceneV1(), fills, { llm: mockLLM(), now: 1700000000000, dryBand: true });
  const r2 = await runSheet(sceneV1(), fills, { llm: mockLLM(), now: 1700000000001, dryBand: true });
  assert.deepEqual(r1.row.nudge_vector, r2.row.nudge_vector);
  assert.equal(r1.row.coherence, r2.row.coherence);
  assert.deepEqual(r1.row.structure, r2.row.structure);
  // and word-for-word identical mock words (mock counts internal state, so compare shape)
  assert.equal(typeof r1.row.words.scene, "string");
});

const nudgeSheet = (exprs) => ({
  cells: exprs.map((e, i) => ({ id: "n" + i, kind: "nudge", weight: 1, expr: e, _ast: parseFormula(e) })),
});

test("coherence: agreement resonates, conflict collapses", () => {
  const agree = accumulateNudges(nudgeSheet(["x", "x"]), { x: 0.8 }, "seed");
  const conflict = accumulateNudges(nudgeSheet(["x", "-x"]), { x: 0.8 }, "seed");
  assert.ok(agree.coherence > 0.9, `agree ${agree.coherence}`);
  assert.ok(conflict.coherence < 0.5, `conflict ${conflict.coherence}`);
});

test("nudge values outside [-1,1] clamp and flag", () => {
  const st = accumulateNudges(nudgeSheet(["x"]), { x: 5 }, "seed");
  assert.equal(st.vec.n0.value, 1);
  assert.equal(st.clampedAny, true);
});

// --------------------------------------------------------- 4. deadband law
test("deadband: live -> replay(skipped, tokens saved) -> new shape live", async () => {
  const ledger = tmpLedger();
  const fills1 = { place: "a night ferry", arrival: "in fog", figure: "the ferryman", object: "a brass key" };
  // run 2 = same choices (same dice), lightly different figure text
  // (same choices => same dice; "the old ferryman" keeps token-Jaccard >= 0.6
  //  with "the ferryman", and scene v1's coherence never reads the figure text)
  const fills2 = { place: "a night ferry", arrival: "in fog", figure: "the old ferryman", object: "a brass key" };
  const fills3 = { place: "the observatory", arrival: "in fog", figure: "the ferryman", object: "a brass key" };

  const llm1 = mockLLM();
  const r1 = await runSheet(sceneV1(), fills1, { llm: llm1, ledgerPath: ledger, now: 1700000000000 });
  assert.equal(r1.row.deadband.mode, "live");
  assert.equal(llm1.count(), 1);

  const llm2 = mockLLM();
  const r2 = await runSheet(sceneV1(), fills2, { llm: llm2, ledgerPath: ledger, now: 1700000000001 });
  assert.equal(r2.row.deadband.mode, "replay", r2.row.deadband.reason);
  assert.equal(llm2.count(), 0, "word-smith must NOT wake inside the band");
  assert.ok(r2.row.deadband.tokens_saved > 0);
  assert.equal(r2.row.wordsmith_calls[0].path, "replay");
  assert.equal(r2.row.wordsmith_calls[0].llm, false);
  assert.equal(r2.row.wordsmith_calls[0].replay_of, r1.row.run_id);
  // the replay is a LIGHT MORPH of the recorded words, never new thought
  const expected = lightMorph(r1.row.words.scene, `${r2.row.seed}|scene`).text;
  assert.equal(r2.row.words.scene, expected);

  const llm3 = mockLLM();
  const r3 = await runSheet(sceneV1(), fills3, { llm: llm3, ledgerPath: ledger, now: 1700000000002 });
  assert.equal(r3.row.deadband.mode, "live", "a different situation fact is a different shape");
  assert.equal(llm3.count(), 1);
});

test("deadband: surprise outside the band re-opens the word-smith", async () => {
  const ledger = tmpLedger();
  const breacher = {
    name: "breach", version: 1,
    cells: [
      { id: "bag", kind: "situation", type: "text", prompt: "x" },
      { id: "n", kind: "nudge", weight: 1.0, expr: "bag == \"alpha beta gamma delta epsilon\" ? 1 : 0" },
      { id: "w", kind: "wordsmith", instruction: "say it", fallback_shape: "{bag} {adj}" },
    ],
  };
  const a = { bag: "alpha beta gamma delta epsilon" };
  const b = { bag: "alpha beta gamma delta zeta" };   // similar tokens, flipped hash
  const r1 = await runSheet(breacher, a, { llm: mockLLM(), ledgerPath: ledger, now: 1 });
  assert.equal(r1.row.deadband.mode, "live");
  const r2 = await runSheet(breacher, b, { llm: mockLLM(), ledgerPath: ledger, now: 2 });
  assert.ok(similarShape(loadTemplate(breacher), a, b), "texts are token-similar");
  assert.equal(r2.row.deadband.mode, "breach", r2.row.deadband.reason);
  assert.equal(r2.row.wordsmith_calls[0].llm, true, "breach wakes full thought");
});

test("deadband: learned band from a compile receipt overrides the a-priori margin", async () => {
  const rows = [
    { kind: "compile", template: "t", parent_version: 1, bands: { seed1: { lo: 0.9, hi: 1.0 } } },
  ];
  const b = learnedBands(rows, "t", 1);
  assert.deepEqual(bandFor([0.5], b.seed1), { lo: 0.9, hi: 1.0, learned: true });
  const fallback = bandFor([0.5], undefined);
  assert.deepEqual(fallback, { lo: 0.35, hi: 0.65, learned: false });
  const two = bandFor([0.5, 0.6], undefined);
  assert.equal(two.learned, false);
  assert.ok(two.lo <= 0.5 && two.hi >= 0.6);
});

// ------------------------------------------------------ 5. receipts ledger
test("receipts: append-only sha256 chain verifies and detects tamper", async () => {
  const ledger = tmpLedger();
  await runSheet(sceneV1(), { place: "a night ferry", arrival: "in fog", figure: "a", object: "b" },
    { llm: mockLLM(), ledgerPath: ledger, now: 1 });
  await runSheet(sceneV1(), { place: "the observatory", arrival: "at dusk", figure: "a", object: "b" },
    { llm: mockLLM(), ledgerPath: ledger, now: 2 });
  const rows = readLedger(ledger);
  assert.equal(rows.length, 2);
  const v = verifyLedger(rows);
  assert.equal(v.ok, true);
  assert.equal(rows[0].prev_tip, "genesis");
  assert.equal(rows[1].prev_tip, rows[0].tip);
  // tamper: rewrite a coherence, chain must break
  const tampered = JSON.parse(JSON.stringify(rows));
  tampered[1].coherence = 0.01;
  assert.equal(verifyLedger(tampered).ok, false);
  // receipt records which word-smith path was used
  assert.equal(rows[0].wordsmith_calls[0].path, "mock");
  assert.equal(rows[0].wordsmith_calls[0].llm, true);
});

test("receipts: fallback path is honest (llm=false) and deterministic", async () => {
  const ledger = tmpLedger();
  const r = await runSheet(sceneV1(),
    { place: "a flooded library", arrival: "under a power failure", figure: "the night librarian", object: "a card catalogue drawer" },
    { llm: async () => null, ledgerPath: ledger, now: 3 }); // both routes "failed"
  const row = readLedger(ledger)[0];
  assert.equal(row.wordsmith_calls[0].path, "fallback");
  assert.equal(row.wordsmith_calls[0].llm, false);
  const again = fallbackWordsmith(sceneV1().cells.find((c) => c.id === "scene"),
    { figure: "the night librarian", place: "a flooded library", arrival: "under a power failure",
      object: "a card catalogue drawer" },
    row.seed, row.nudge_vector);
  assert.equal(again, row.words.scene);
});

test("receipts: every run carries template identity + version link", async () => {
  const t = sceneV1();
  const ledger = tmpLedger();
  const r = await runSheet(t, { place: "a night ferry", arrival: "at dusk", figure: "a", object: "b" },
    { llm: mockLLM(), ledgerPath: ledger, now: 4 });
  assert.equal(r.row.template, "scene-skin");
  assert.equal(r.row.version, 1);
  assert.equal(r.row.template_sha, templateSha(loadTemplate(t)));
});

// -------------------------------------------------- 6. template evolution
test("evolution: compile v1->v2 links versions, never touches v1, deterministic", () => {
  const t1 = loadTemplate(sceneV1());
  const receipts = [
    { kind: "run", template: "scene-skin", version: 1, coherence: 0.8,
      nudge_vector: { dread: { value: 0.5 }, longing: { value: 0.4 }, uncanny: { value: -0.1 }, resonance: { value: 0.3 } } },
    { kind: "run", template: "scene-skin", version: 1, coherence: 0.6,
      nudge_vector: { dread: { value: 0.1 }, longing: { value: 0.2 }, uncanny: { value: 0.2 }, resonance: { value: 0.1 } } },
    { kind: "run", template: "scene-skin", version: 1, coherence: 0.9,
      nudge_vector: { dread: { value: 0.9 }, longing: { value: 0.6 }, uncanny: { value: -0.3 }, resonance: { value: 0.5 } } },
  ];
  const shaBefore = templateSha(t1);
  const v2a = compileTemplate(t1, receipts, { now: 5 });
  const v2b = compileTemplate(t1, receipts, { now: 5 });
  assert.deepEqual(v2a, v2b, "same receipts -> byte-identical vNext");
  assert.equal(v2a.version, 2);
  assert.equal(v2a.parent_version, 1);
  assert.equal(v2a.parent_sha, shaBefore);
  assert.equal(templateSha(t1), shaBefore, "v1 must be untouched by compilation");
  // the positively-correlated nudge gains weight; the anti-correlated one loses
  const tuned = Object.fromEntries(v2a.evolution.tuning.map((x) => [x.cell, x]));
  assert.ok(tuned.dread.to > tuned.dread.from, "dread tracked high coherence");
  assert.ok(tuned.uncanny.to < tuned.uncanny.from, "uncanny anti-tracked");
  assert.ok(tuned.dread.to <= 3 * 0.9 && tuned.dread.to >= 0.2, "weights stay clamped");
  // child loads as a valid template
  assert.equal(loadTemplate(v2a).name, "scene-skin");
});

test("evolution: too few runs mints a lineage-only version (honest note)", () => {
  const t1 = loadTemplate(sceneV1());
  const v2 = compileTemplate(t1, [{ kind: "run", template: "scene-skin", version: 1, coherence: 0.5, nudge_vector: {} }], { now: 6 });
  assert.match(v2.evolution.note, /insufficient runs/);
  assert.deepEqual(v2.cells, t1.cells, "lineage-only version carries untuned cells");
});

test("pearson: sane correlation sign", () => {
  assert.ok(pearson([1, 2, 3], [2, 4, 6]) > 0.99);
  assert.ok(pearson([1, 2, 3], [6, 4, 2]) < -0.99);
  assert.equal(pearson([1, 1, 1], [1, 2, 3]), 0);
});

// --------------------------------------------------- 7. demo parity pin
test("demo core (client port) agrees with the engine on a fixed battery", async (t) => {
  const demoPath = new URL("../demo/index.html", import.meta.url);
  if (!fs.existsSync(demoPath)) return t.skip("demo not written yet");
  const html = fs.readFileSync(demoPath, "utf8");
  const m = html.match(/\/\*DEMO-CORE-START\*\/([\s\S]*?)\/\*DEMO-CORE-END\*\//);
  assert.ok(m, "demo must carry the marked DEMO-CORE block");
  const MJCORE = new Function(m[1] + "\n;return MJCORE;")();
  for (const tjson of [sceneV1(), discV1()]) {
    const lt = loadTemplate(tjson);
    const fills = Object.fromEntries(lt.cells.filter((c) => c.kind === "situation")
      .map((c) => [c.id, c.type === "choice" ? c.options[0] : "a small probe"]));
    const env = { ...fills, shape: "deadbeefcafe", seed: "1234abcd5678" };
    for (const c of lt.cells.filter((c) => c.kind === "structure")) env[c.id] = evalFormula(c._ast, env);
    const engineState = accumulateNudges(lt, { ...env }, "seed");
    const coreState = MJCORE.accumulateNudges(tjson, MJCORE.mapEnv(env));
    assert.deepEqual(coreState.vec, engineState.vec, tjson.name + " nudge vector");
    assert.equal(coreState.coherence, engineState.coherence, tjson.name + " coherence");
    // formulas agree cell-by-cell
    for (const c of lt.cells.filter((c) => c.kind === "structure")) {
      assert.equal(MJCORE.evalFormula(MJCORE.parseFormula(c.expr), MJCORE.mapEnv(env)), evalFormula(c._ast, env), c.id);
    }
  }
  // shared helpers agree
  assert.deepEqual(MJCORE.bandFor([0.5], undefined), bandFor([0.5], undefined));
  assert.equal(MJCORE.lightMorph("the bright key", "s1").text, lightMorph("the bright key", "s1").text);
  assert.equal(MJCORE.hash01("dread|x"), hash01("dread|x"));
  assert.equal(MJCORE.similarShape(sceneV1(), { place: "a" }, { place: "a" }), true);
});
