// tests/sealed-compile.test.mjs — the compile loop is a self-modification
// step, so it runs the full chain: (a) expectation hash spec_sha, (b) config,
// (c) result. NO network. CRITICAL DISCIPLINE: the campaign ledger of record
// (receipts/ledger.jsonl) is NEVER touched — every compile here runs against
// a temp copy (mkdtemp), and the battery-guard test at the bottom pins the
// ledger of record byte-identical across the whole file.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { canon, sha256, readLedger, verifyLedger, loadTemplate, compileTemplate, appendReceipt } from "../engine.mjs";
import { compileOnce, loadSpec, evaluateInvariants } from "../compile.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const LEDGER_OF_RECORD = path.join(ROOT, "receipts", "ledger.jsonl");
const SPEC_PATH = path.join(ROOT, "spec", "invariants.json");
const HEX64 = /^[0-9a-f]{64}$/;

const run = promisify(execFile);
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "sealed-"));
const specOf = () => JSON.parse(fs.readFileSync(SPEC_PATH, "utf8"));
const specShaOf = () => sha256(canon(specOf()));

// battery guard: hash the ledger of record + every template file once,
// before any test runs. (Found the hard way while writing this battery: a
// compile pointed at the real templates/discovery-skin.json writes its vNext
// to templates/discovery-skin.v2.json IN THE REPO — the pre-existing outPath
// rule. So the backward-compat test below compiles a temp COPY of the file.)
const hashTree = () => {
  const files = [LEDGER_OF_RECORD,
    ...fs.readdirSync(path.join(ROOT, "templates")).map((f) => path.join(ROOT, "templates", f))];
  return sha256(files.map((f) => sha256(fs.readFileSync(f))).join("|"));
};
const TREE_SHA_BEFORE = hashTree();

// --------------------------------------------------------------- test rig
// same shape as receipts/ledger.jsonl rows — only the fields compileTemplate
// and the invariants actually read are populated
const mkRun = (version, shapeSeed, novelty, parsimony, coherence, i) => ({
  kind: "run",
  run_id: `sealed-skin.v${version}.run${i}`,
  ts: new Date(1700000000000 + i).toISOString(),
  template: "sealed-skin",
  version,
  template_sha: "deadbeefdeadbeef",
  seed: `seed-${i}`,
  shape_seed: shapeSeed,
  fills: { q: `question ${i}` },
  nudge_vector: {
    novelty: { value: novelty, weight: 1, contrib: novelty },
    parsimony: { value: parsimony, weight: 0.5, contrib: 0.5 * parsimony },
  },
  coherence,
  structure: {},
  deadband: {},
  wordsmith_calls: [],
  words: {},
  words_text: "",
});

const parentTemplate = {
  name: "sealed-skin", version: 2, parent_version: 1,
  description: "sealed-compile test rig: v2 with a healthy v1 parent rung",
  cells: [
    { id: "q", kind: "situation", type: "text", prompt: "q" },
    { id: "novelty", kind: "nudge", weight: 1.0, expr: 'sway("novelty|" + shape)' },
    { id: "parsimony", kind: "nudge", weight: 0.5, expr: 'sway("parsimony|" + shape) * clamp(len(q) / 40, 0, 1)' },
    { id: "w", kind: "wordsmith", instruction: "say it" },
  ],
};

// parent rung: 3 v1 runs, novelty values with healthy dispersion (0.6549)
const rungRows = [0, 1, 2].map((i) =>
  mkRun(1, `rung-sh-${i}`, [0.8, -0.8, 0.1][i], 0.1, 0.5 + 0.1 * i, i));
// healthy evidence: 3 v2 runs, distinct shapes, novelty stdev 0.4546 >= 0.5 x 0.6549
const healthyRows = [0, 1, 2].map((i) =>
  mkRun(2, `ev-sh-${i}`, [0.6, -0.5, 0.2][i], [0.1, 0.4, 0.8][i], [0.5, 0.7, 0.9][i], 10 + i));
// homogenized evidence: same shape seed -> identical novelty value -> stdev 0
const collapsedRows = [0, 1, 2].map((i) =>
  mkRun(2, "one-shape", 0.3, [0.1, 0.4, 0.8][i], [0.4, 0.6, 0.8][i], 20 + i));

function rig(dir, rows) {
  const tplPath = path.join(dir, "sealed-skin.json");
  fs.writeFileSync(tplPath, JSON.stringify(parentTemplate, null, 2) + "\n");
  // build the temp ledger through the engine's own appendReceipt so the rows
  // form a valid sha chain (compileOnce verifies the chain before compiling)
  const ledgerPath = path.join(dir, "ledger.jsonl");
  for (const r of rows) appendReceipt(ledgerPath, r);
  return { tplPath, ledgerPath };
}

// ------------------------------------------------------------- 1. the spec
test("pre-registered spec: schema holds and spec_sha binds the canon form", () => {
  const spec = loadSpec(SPEC_PATH); // throws if malformed
  assert.equal(spec.spec, "madlibs-jev.compile.invariants");
  assert.equal(spec.version, 1);
  const ids = spec.invariants.map((i) => i.id);
  assert.deepEqual([...ids].sort(), ["band-nondegeneracy", "novelty-dispersion", "tuning-weight-bounds"]);
  for (const inv of spec.invariants) {
    assert.ok(inv.derivation.length > 80, `${inv.id} needs a real derivation`);
    assert.ok(typeof inv.metric === "string" && inv.metric.length > 20);
    assert.ok(typeof inv.floor === "string" && inv.floor.length > 20);
  }
  // value edits move the hash; whitespace/key-order edits do not
  const sha = specShaOf();
  assert.match(sha, HEX64);
  const minified = JSON.parse(JSON.stringify({ spec_sha_note: spec.spec_sha_note, invariants: spec.invariants, version: spec.version, spec: spec.spec }));
  assert.equal(sha256(canon(minified)), sha, "canon must be order/whitespace insensitive");
  const tampered = structuredClone(spec);
  tampered.invariants[1].floor = "0.0 <= w <= 999 (sketch, not the true bound)";
  assert.notEqual(sha256(canon(tampered)), sha, "a value edit must move spec_sha");
});

// ------------------------------------------------------- 2. happy path
test("sealed compile, all invariants green: CANONIZED receipt + spec_sha + vNext written", () => {
  const dir = tmpDir();
  const { tplPath, ledgerPath } = rig(dir, [...rungRows, ...healthyRows]);
  const out = compileOnce({ templatePath: tplPath, ledgerPath, specPath: SPEC_PATH, now: 1700000200000 });

  assert.equal(out.verdict, "CANONIZED");
  assert.equal(out.receipt.verdict, "CANONIZED");
  assert.match(out.receipt.spec_sha, HEX64);
  assert.equal(out.receipt.spec_sha, specShaOf(), "receipt carries the expectation hash of the committed spec");
  assert.equal(out.receipt.spec_path, SPEC_PATH);
  assert.equal(out.receipt.invariants.length, 3);
  for (const inv of out.receipt.invariants) {
    assert.equal(inv.pass, true, `${inv.id} must pass: ${inv.reason ?? ""}`);
    assert.ok(["PASS", "SKIP"].includes(inv.status));
    assert.ok("measured" in inv && "floor" in inv);
  }
  const disp = out.receipt.invariants.find((i) => i.id === "novelty-dispersion");
  assert.equal(disp.status, "PASS");
  assert.equal(disp.measured.evidence_stdev, 0.4546);
  assert.equal(disp.floor, 0.3274, "floor = 0.5 x parent-rung stdev (0.6549)");
  assert.equal(disp.measured.identity.equal, true, "child novelty formula identical to parent's");
  // vNext materialized, chain still verifies
  assert.equal(fs.existsSync(out.outPath), true);
  const child = JSON.parse(fs.readFileSync(out.outPath, "utf8"));
  assert.equal(child.version, 3);
  assert.equal(child.parent_version, 2);
  const rows = readLedger(ledgerPath);
  assert.equal(rows.length, 7); // 6 runs + 1 compile
  assert.equal(verifyLedger(rows).ok, true);
  assert.equal(rows[6].kind, "compile");
  // relative-floor semantics: an unchanged parent rung stays the control
  assert.equal(disp.measured.rung_stdev, 0.6549);
});

// ---------------------------------------------------------- 3. breach
test("novelty-dispersion breach: INDETERMINATE receipt, vNext ABSENT, exit-1 semantics", () => {
  const dir = tmpDir();
  const { tplPath, ledgerPath } = rig(dir, [...rungRows, ...collapsedRows]);
  const before = fs.readFileSync(ledgerPath, "utf8");

  const out = compileOnce({ templatePath: tplPath, ledgerPath, specPath: SPEC_PATH, now: 1700000300000 });

  assert.equal(out.verdict, "INDETERMINATE");
  assert.equal(out.receipt.verdict, "INDETERMINATE");
  const fail = out.receipt.invariants.find((i) => i.id === "novelty-dispersion");
  assert.equal(fail.pass, false);
  assert.equal(fail.status, "FAIL");
  assert.equal(fail.measured.evidence_stdev, 0, "same shape seed -> identical novelty values -> zero dispersion");
  assert.ok(fail.reason.includes("flattened run set"));
  // the refusal is receipted history, append-only; child identified, not materialized
  assert.match(out.receipt.child_sha, HEX64, "refused child identified by sha");
  assert.equal(out.receipt.child_path, null, "refused child NOT materialized");
  assert.ok(out.receipt.note.includes("INDETERMINATE"));
  assert.equal(fs.existsSync(out.outPath), false, "vNext file must be ABSENT on breach");
  const rows = readLedger(ledgerPath);
  assert.equal(rows.length, 7);
  assert.equal(verifyLedger(rows).ok, true, "the receipt chain stays valid across a refusal");
  // the other two invariants still evaluated and receipted
  assert.equal(out.receipt.invariants.find((i) => i.id === "tuning-weight-bounds").status, "PASS");
  assert.equal(out.receipt.invariants.find((i) => i.id === "band-nondegeneracy").status, "PASS");
  void before;
});

test("structural identity: a hand-edited child novelty formula FAILS even with healthy dispersion", () => {
  const parent = loadTemplate(structuredClone(parentTemplate));
  const raw = compileTemplate(parent, healthyRows, { now: 1700000100000 });
  const child = structuredClone(raw);
  child.cells.find((c) => c.id === "novelty").expr = 'sway("tampered|" + shape)';
  const spec = loadSpec(SPEC_PATH);
  const rows = [...rungRows, ...healthyRows];
  const res = evaluateInvariants(spec, parent, child, healthyRows, rows, {});
  const disp = res.find((r) => r.id === "novelty-dispersion");
  assert.equal(disp.status, "FAIL");
  assert.equal(disp.measured.identity.equal, false);
  assert.ok(disp.reason.includes("hand-edited") || disp.reason.includes("edited outside the compile loop"));
});

// ------------------------------------- 4. CLI contracts (child processes)
test("missing spec via spawn: exit 1 + PRE-REGISTRATION on stderr + byte-identical ledger", async () => {
  const dir = tmpDir();
  const { tplPath, ledgerPath } = rig(dir, [...rungRows, ...healthyRows]);
  const before = fs.readFileSync(ledgerPath);
  await assert.rejects(
    run(process.execPath, [path.join(ROOT, "compile.mjs"), tplPath,
      "--ledger", ledgerPath, "--spec", path.join(dir, "nope.json")]),
    (e) => {
      assert.equal(e.code, 1);
      assert.ok(e.stderr.includes("PRE-REGISTRATION"), `stderr must name PRE-REGISTRATION, got: ${e.stderr}`);
      return true;
    });
  assert.deepEqual(fs.readFileSync(ledgerPath), before, "nothing happened: the ledger must not be touched");
});

test("breach via spawn: CLI exits 1, stderr names the breach, vNext absent", async () => {
  const dir = tmpDir();
  const { tplPath, ledgerPath } = rig(dir, [...rungRows, ...collapsedRows]);
  await assert.rejects(
    run(process.execPath, [path.join(ROOT, "compile.mjs"), tplPath,
      "--ledger", ledgerPath, "--spec", SPEC_PATH]),
    (e) => {
      assert.equal(e.code, 1);
      assert.ok(e.stderr.includes("INDETERMINATE"), e.stderr);
      assert.ok(e.stderr.includes("novelty-dispersion"), e.stderr);
      return true;
    });
  assert.equal(fs.existsSync(tplPath.replace(/\.json$/, ".v3.json")), false);
});

// ------------------------------------------------- 5. backward compatibility
test("today's ledger of record still compiles under the seal (temp copies, SKIPs receipted)", () => {
  const dir = tmpDir();
  const ledgerCopy = path.join(dir, "ledger.jsonl");
  fs.copyFileSync(LEDGER_OF_RECORD, ledgerCopy);
  // the template file is compiled from a temp COPY: outPath is derived from
  // templatePath, and compiling v1 again targets the v2 filename in situ
  const discCopy = path.join(dir, "discovery-skin.json");
  fs.copyFileSync(path.join(ROOT, "templates", "discovery-skin.json"), discCopy);
  const out = compileOnce({
    templatePath: discCopy,
    ledgerPath: ledgerCopy, specPath: SPEC_PATH, now: 1700000400000,
  });
  assert.equal(out.verdict, "CANONIZED", JSON.stringify(out.invariants));
  const disp = out.receipt.invariants.find((i) => i.id === "novelty-dispersion");
  assert.equal(disp.status, "SKIP", "discovery-skin v1 is a genesis compile: no parent rung");
  assert.ok(disp.reason.includes("genesis"));
  assert.equal(disp.measured.identity.equal, true, "v2 keeps the novelty formula byte-identical");
  // and the scene-skin family: no novelty cell at all -> target-absent SKIP
  const sceneCopy = path.join(dir, "scene-skin.json");
  fs.copyFileSync(path.join(ROOT, "templates", "scene-skin.json"), sceneCopy);
  const out2 = compileOnce({
    templatePath: sceneCopy,
    ledgerPath: ledgerCopy, specPath: SPEC_PATH, now: 1700000400001,
  });
  assert.equal(out2.verdict, "CANONIZED");
  assert.equal(out2.receipt.invariants.find((i) => i.id === "novelty-dispersion").status, "SKIP");
});

// ------------------------------------------------- 6. battery guard: the
// ledger of record + the template family are byte-identical after the whole
// battery above
test("ledger of record + templates are byte-identical after the battery (no compile touched them)", () => {
  assert.equal(hashTree(), TREE_SHA_BEFORE, "the ledger of record and templates must never be a test's scratch space");
});
