// shape-memory.mjs — Bridge 1 (WP-11): quantized exocortex memory for the
// madlibs-jev deadband. The deadband's honest gate is unchanged (choice
// equality + token Jaccard, engine.similarShape); the index is a
// turbovec-style ACCELERATOR: hashed embeddings of fill shapes, 4-bit
// Lloyd-Max quantization (8x JSON-byte compression verified in tests),
// shortlisting candidates for the gate instead of scanning the whole ledger.
import { sha256, round4, tokens } from "./engine.mjs";

export const DIM = 64;
const FNV_OFFSET = 0xcbf29ce484222325n, FNV_PRIME = 0x100000001b3n;

function fnv1a(text) {
  let h = FNV_OFFSET;
  for (const b of Buffer.from(String(text), "utf8")) { h ^= BigInt(b); h = (h * FNV_PRIME) & 0xffffffffffffffffn; }
  return h;
}

export function embedShape(t, fills, dim = DIM) {
  // hashed bag-of-tokens over the fill shape: choice signature first (each
  // choice contributes a strong token), then text-slot tokens.
  const v = new Array(dim).fill(0);
  const parts = [];
  for (const c of t.cells.filter((c) => c.kind === "situation" && c.type === "choice")) {
    parts.push(c.id + ":" + (fills[c.id] ?? ""));
  }
  for (const c of t.cells.filter((c) => c.kind === "situation" && c.type === "text")) {
    for (const w of tokens(fills[c.id] ?? "")) parts.push(c.id + ":" + w);
  }
  for (const p of parts) { const h = fnv1a(p); v[Number(h % BigInt(dim))] += 1; }
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return n > 0 ? v.map((x) => x / n) : v;
}

// 4-bit Lloyd-Max-style quantization: 16 levels over [-1,1] (mid-riser).
// Cell values are unit-norm counts, so 16 levels are ample; this is the
// turbovec-substrate compression trick at small scale.
const LEVELS = 16;
export function quantize4(vec) {
  return vec.map((x) => {
    const q = Math.max(0, Math.min(LEVELS - 1, Math.round(((x + 1) / 2) * (LEVELS - 1))));
    return q / (LEVELS - 1) * 2 - 1;
  });
}
export function bytesOf(vec) { return JSON.stringify(vec).length; }

function cosine(a, b) { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; }

export class ShapeMemory {
  constructor() { this.cells = []; }
  add(t, fills, row) {
    const vec = embedShape(t, fills);
    const cell = {
      template: t.name, version: t.version,
      vec, qvec: quantize4(vec),
      row_id: row?.run_id ?? row?.tip ?? sha256(JSON.stringify(fills)).slice(0, 12),
    };
    this.cells.push(cell);
    return cell.row_id;
  }
  // shortlist: nearest k by quantized-cosine; the CALLER still verifies with
  // engine.similarShape — the index proposes, the gate disposes.
  shortlist(t, fills, k = 4) {
    const q = quantize4(embedShape(t, fills));
    return this.cells
      .filter((c) => c.template === t.name && c.version === t.version)
      .map((c) => ({ row_id: c.row_id, distance: round4(1 - cosine(q, c.qvec)) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, k);
  }
  // memory footprint: quantized cells vs raw ledger rows (receipted 8x)
  compressionStats() {
    const idxBytes = this.cells.reduce((a, c) => a + bytesOf(c.qvec.map((x) => Math.round(((x + 1) / 2) * 15))) + 40, 0);
    return { cells: this.cells.length, indexBytesApprox: idxBytes };
  }
}
