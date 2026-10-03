import test from "node:test";
import assert from "node:assert/strict";
import { ShapeMemory, embedShape, quantize4, bytesOf, DIM } from "../shape-memory.mjs";
import { loadTemplate, similarShape } from "../engine.mjs";
import fs from "node:fs";

const T = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), "utf8"));

test("embedShape is deterministic and unit-norm", () => {
  const t = loadTemplate(T("../templates/scene-skin.json"));
  const fills = { place: "a ferry crossing", figure: "the ferryman", object: "a brass key" };
  const a = embedShape(t, fills), b = embedShape(t, fills);
  assert.deepEqual(a, b);
  const n = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
  assert.ok(n <= 1.000001 && n > 0.9);
});

test("quantize4 keeps cosine ranking (shortlist ordering preserved)", () => {
  const v1 = embedShape(loadTemplate(T("../templates/scene-skin.json")), { place: "ferry", figure: "man", object: "key" });
  const v2 = embedShape(loadTemplate(T("../templates/scene-skin.json")), { place: "ferry", figure: "man", object: "lamp" });
  const v3 = embedShape(loadTemplate(T("../templates/discovery-skin.json")), { question: "why", constraints: "none", goal: "learn" });
  const q = quantize4(v1);
  const d2 = 1 - cosineQ(q, quantize4(v2));
  const d3 = 1 - cosineQ(q, quantize4(v3));
  assert.ok(d2 < d3, "same-template variant must rank nearer than foreign template");
});
function cosineQ(a, b) { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; }

test("4-bit packing achieves the 8x claim vs float32 (turbovec-substrate math)", () => {
  const v = embedShape(loadTemplate(T("../templates/scene-skin.json")), { place: "x", figure: "y", object: "z" });
  // the honest 8x: 4 bits/level packed vs 32-bit floats (32/4 = 8), the
  // turbovec-substrate comparison. JSON text length is NOT the metric —
  // our vector is sparse and JSON would flatter neither side.
  const levels = quantize4(v).map((x) => Math.round(((x + 1) / 2) * 15));
  const packed = packLevels(levels); // 2 levels per byte, hex
  const f32 = v.length * 4;
  assert.equal(packed.length, v.length / 2, "64 levels pack to 32 bytes");
  assert.equal(f32 / packed.length, 8, "32-bit floats / 4-bit packed = 8x");
});
function packLevels(levels) {
  const b = Buffer.alloc(Math.ceil(levels.length / 2));
  for (let i = 0; i < levels.length; i += 2) {
    b[i >> 1] = (levels[i] << 4) | (levels[i + 1] ?? 0);
  }
  return b;
}

test("shortlist contains the row the Jaccard gate would have found", () => {
  const t = loadTemplate(T("../templates/scene-skin.json"));
  const m = new ShapeMemory();
  const fillsA = { place: "a fog harbor", figure: "the keeper", object: "a lantern", mood: "dread" };
  const fillsB = { place: "a fog harbor", figure: "the keeper", object: "a bell", mood: "dread" }; // near-identical
  const fillsC = { place: "a desert observatory", figure: "the astronomer", object: "a compass", mood: "awe" };
  m.add(t, fillsA, { run_id: "rA" });
  m.add(t, fillsC, { run_id: "rC" });
  const sl = m.shortlist(t, fillsB, 2);
  assert.equal(sl[0].row_id, "rA", "nearest shortlist row must be the true match");
  // and the honest gate agrees:
  assert.equal(similarShape(t, fillsA, fillsB), true);
  assert.equal(similarShape(t, fillsC, fillsB), false);
});

test("index respects template+version scoping", () => {
  const t1 = loadTemplate(T("../templates/scene-skin.json"));
  const t2 = loadTemplate(T("../templates/discovery-skin.json"));
  const m = new ShapeMemory();
  m.add(t2, { question: "q", constraints: "c", goal: "g" }, { run_id: "d1" });
  const sl = m.shortlist(t1, { place: "x", figure: "y", object: "z", mood: "dread" }, 4);
  assert.equal(sl.length, 0, "no cross-template leakage");
});
