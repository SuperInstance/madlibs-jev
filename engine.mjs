#!/usr/bin/env node
// engine.mjs — madlibs-jev: the JEV substrate is the first-class citizen;
// LLMs are last-mile word-smiths. (wave-67, lane 67-a)
//
// Lineage:
//   discovery-mad-libs  -> madlib templates as JSON, sessions, rewind
//   madlibs-gan         -> producer/filler/critic + JEV vote; env-key LLM dispatch
//   madlibs-gan-turbovec-> paradigm memory via embedding + similarity search
//   erised-exocortex    -> the deadband law: compiled autoplayer, zero
//                          thought-tokens inside the band, full wake outside
//   jev-garden          -> JEV: a non-parametric field + tiny head;
//                          understanding through distribution
//
// The madlib is NOT a prompt string. It is a SHEET of typed cells:
//   situation cells  — spoken slots the human/agent fills
//   structure cells  — deterministic formulas over slots (the unspoken skeleton)
//   nudge cells      — JEV vector accumulators (dice draws, resonance terms)
//   wordsmith cells  — the ONLY cells allowed to call an LLM; they receive the
//                      accumulated unspoken state and produce the final words
//
// Three laws (README expands):
//   1. STRUCTURE FIRST  — formulas and nudges evaluate deterministically,
//                         before any word exists.
//   2. LAST-MILE WORDS  — the LLM sees the unspoken state as soft guidance;
//                         it stretches skin over the drum, it is not the drum.
//   3. DEADBAND REPLAY  — same template version + similar fill-shape +
//                         coherence inside the learned band => SKIP the LLM,
//                         replay prior words with a light morph. Surprise
//                         outside the band re-opens the word-smith.
//
// Everything receipts to an append-only sha256-chained JSONL ledger.
// Zero dependencies beyond node builtins (crypto/fs/https/path).

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import https from "node:https";

// ------------------------------------------------------------------ hashing
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
// FNV-1a 64 — same offset/prime constants as madlibs-gan/madlibs.py.
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
export function fnv1a64(str) {
  let h = FNV_OFFSET;
  for (const b of Buffer.from(str, "utf8")) {
    h ^= BigInt(b);
    h = (h * FNV_PRIME) & 0xffffffffffffffffn;
  }
  return h;
}
// hash01: string -> [0,1). Deterministic, distribution-rough, no deps.
export const hash01 = (s) => Number(fnv1a64(String(s)) % 1000000007n) / 1000000007;

// stable canonical json (sorted keys) — receipts and evolution must re-derive
export const canon = (o) => {
  if (o === null || typeof o !== "object") return JSON.stringify(o);
  if (Array.isArray(o)) return "[" + o.map(canon).join(",") + "]";
  return "{" + Object.keys(o).sort()
    .map((k) => JSON.stringify(k) + ":" + canon(o[k])).join(",") + "}";
};
export const round4 = (x) => Math.round(x * 10000) / 10000;

// ------------------------------------------------------- micro formula DSL
// A tiny recursive-descent evaluator. NO eval, NO Function, NO network.
// Deterministic, fail-closed on unknown names.

const FUNCS = {
  len: (s) => String(s).length,
  min: (...a) => Math.min(...a.map(Number)),
  max: (...a) => Math.max(...a.map(Number)),
  abs: (x) => Math.abs(Number(x)),
  clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v))),
  round: (x, n = 0) => { const p = 10 ** Number(n); return Math.round(Number(x) * p) / p; },
  pow: (a, b) => Number(a) ** Number(b),
  hash01: (s) => hash01(s),                       // string -> [0,1)
  sway: (x) => {                                  // [0,1] -> [-1,1]; strings hash first
    const u = typeof x === "number" ? Math.min(1, Math.max(0, x)) : hash01(x);
    return u * 2 - 1;
  },
  pick: (list, seed) => {                         // "a|b|c" + seed -> one element
    const opts = String(list).split("|");
    return opts[Math.floor(hash01(seed) * opts.length) % opts.length];
  },
};

export function tokenizeFormula(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] || ""))) {
      let j = i; while (j < src.length && /[0-9.]/.test(src[j])) j++;
      toks.push({ t: "num", v: parseFloat(src.slice(i, j)) }); i = j; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1, s = "";
      while (j < src.length && src[j] !== c) { s += src[j]; j++; }
      if (j >= src.length) throw new Error("FORMULA_UNTERMINATED_STRING");
      toks.push({ t: "str", v: s }); i = j + 1; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i; while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ t: "ident", v: src.slice(i, j) }); i = j; continue;
    }
    const three = src.slice(i, i + 3);
    if (three === "===" || three === "!==") { toks.push({ t: "op", v: three === "===" ? "==" : "!=" }); i += 3; continue; }
    const two = src.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) {
      toks.push({ t: "op", v: two }); i += 2; continue;
    }
    if ("+-*/%<>():?!,.".includes(c)) { toks.push({ t: "op", v: c }); i++; continue; }
    throw new Error(`FORMULA_BAD_CHAR:${c}`);
  }
  return toks;
}

export function parseFormula(src) {
  const toks = tokenizeFormula(src);
  let p = 0;
  const peek = () => toks[p];
  const eat = (v) => {
    const t = toks[p];
    if (!t || t.t !== "op" || t.v !== v) throw new Error(`FORMULA_EXPECTED:${v}`);
    p++; return t;
  };
  function primary() {
    const t = peek();
    if (!t) throw new Error("FORMULA_EOF");
    if (t.t === "num") { p++; return { k: "num", v: t.v }; }
    if (t.t === "str") { p++; return { k: "str", v: t.v }; }
    if (t.t === "ident") {
      p++;
      if (peek() && peek().t === "op" && peek().v === "(") {
        eat("("); const args = [];
        if (!(peek() && peek().t === "op" && peek().v === ")")) {
          args.push(ternary());
          while (peek() && peek().t === "op" && peek().v === ",") { eat(","); args.push(ternary()); }
        }
        eat(")");
        return { k: "call", f: t.v, args };
      }
      return { k: "ident", v: t.v };
    }
    if (t.t === "op" && t.v === "(") { eat("("); const e = ternary(); eat(")"); return e; }
    if (t.t === "op" && t.v === "-") { eat("-"); return { k: "neg", a: unary() }; }
    if (t.t === "op" && t.v === "!") { eat("!"); return { k: "not", a: unary() }; }
    throw new Error(`FORMULA_UNEXPECTED:${t.v}`);
  }
  function unary() { return primary(); }
  function mul() {
    let a = unary();
    while (peek() && peek().t === "op" && ["*", "/", "%"].includes(peek().v)) {
      const op = toks[p++].v; a = { k: "bin", op, a, b: unary() };
    }
    return a;
  }
  function add() {
    let a = mul();
    while (peek() && peek().t === "op" && ["+", "-"].includes(peek().v)) {
      const op = toks[p++].v; a = { k: "bin", op, a, b: mul() };
    }
    return a;
  }
  function cmp() {
    let a = add();
    while (peek() && peek().t === "op" && ["<", "<=", ">", ">="].includes(peek().v)) {
      const op = toks[p++].v; a = { k: "bin", op, a, b: add() };
    }
    return a;
  }
  function eq() {
    let a = cmp();
    while (peek() && peek().t === "op" && ["==", "!="].includes(peek().v)) {
      const op = toks[p++].v; a = { k: "bin", op, a, b: cmp() };
    }
    return a;
  }
  function land() {
    let a = eq();
    while (peek() && peek().t === "op" && peek().v === "&&") { p++; a = { k: "and", a, b: eq() }; }
    return a;
  }
  function lor() {
    let a = land();
    while (peek() && peek().t === "op" && peek().v === "||") { p++; a = { k: "or", a, b: land() }; }
    return a;
  }
  function ternary() {
    const a = lor();
    if (peek() && peek().t === "op" && peek().v === "?") {
      p++; const b = ternary(); eat(":"); const c = ternary();
      return { k: "cond", a, b, c };
    }
    return a;
  }
  const ast = ternary();
  if (p !== toks.length) throw new Error("FORMULA_TRAILING_TOKENS");
  return ast;
}

export function collectIdents(ast, acc = new Set()) {
  if (!ast || typeof ast !== "object") return acc;
  if (ast.k === "ident") acc.add(ast.v);
  if (ast.k === "call") ast.args.forEach((a) => collectIdents(a, acc));
  if (ast.k === "bin") { collectIdents(ast.a, acc); collectIdents(ast.b, acc); }
  if (ast.k === "and" || ast.k === "or") { collectIdents(ast.a, acc); collectIdents(ast.b, acc); }
  if (ast.k === "cond") { collectIdents(ast.a, acc); collectIdents(ast.b, acc); collectIdents(ast.c, acc); }
  if (ast.k === "neg" || ast.k === "not") collectIdents(ast.a, acc);
  return acc;
}

export function evalFormula(ast, env) {
  const ev = (n) => {
    switch (n.k) {
      case "num": return n.v;
      case "str": return n.v;
      case "ident": {
        if (!(n.v in env)) throw new Error(`UNKNOWN_NAME:${n.v}`);
        return env[n.v];
      }
      case "call": {
        const f = FUNCS[n.f];
        if (!f) throw new Error(`UNKNOWN_FUNC:${n.f}`);
        return f(...n.args.map(ev));
      }
      case "neg": return -Number(ev(n.a));
      case "not": return ev(n.a) ? 0 : 1;
      case "bin": {
        const a = ev(n.a), b = ev(n.b);
        switch (n.op) {
          case "+": return typeof a === "string" || typeof b === "string"
            ? String(a) + String(b) : a + b;
          case "-": return a - b;
          case "*": return a * b;
          case "/": return a / b;
          case "%": return a % b;
          case "<": return a < b ? 1 : 0;
          case "<=": return a <= b ? 1 : 0;
          case ">": return a > b ? 1 : 0;
          case ">=": return a >= b ? 1 : 0;
          case "==": return a === b ? 1 : 0;
          case "!=": return a !== b ? 1 : 0;
        }
        throw new Error(`FORMULA_BAD_OP:${n.op}`);
      }
      case "and": return ev(n.a) && ev(n.b) ? 1 : 0;
      case "or": return ev(n.a) || ev(n.b) ? 1 : 0;
      case "cond": return ev(n.a) ? ev(n.b) : ev(n.c);
    }
    throw new Error("FORMULA_BAD_NODE");
  };
  return ev(ast);
}

// ------------------------------------------------------------------ template
// Cell kinds: situation | structure | nudge | wordsmith
export const CELL_KINDS = ["situation", "structure", "nudge", "wordsmith"];

export function loadTemplate(json) {
  const t = typeof json === "string" ? JSON.parse(json) : json;
  const errs = [];
  if (!t || typeof t !== "object") errs.push("template must be an object");
  if (t && typeof t.name !== "string") errs.push("missing name");
  if (t && !Number.isInteger(t.version)) errs.push("missing integer version");
  const cells = t && t.cells;
  if (!Array.isArray(cells) || cells.length === 0) errs.push("missing cells[]");
  const seen = new Set();
  const situation = [], structure = [], nudges = [], wordsmiths = [];
  const known = new Set(); // identifiers legal so far (slots + earlier cells)
  if (Array.isArray(cells)) {
    for (const c of cells) {
      if (!c || typeof c.id !== "string" || !c.id) { errs.push("cell missing id"); continue; }
      if (seen.has(c.id)) errs.push(`duplicate cell id: ${c.id}`);
      seen.add(c.id);
      if (!CELL_KINDS.includes(c.kind)) { errs.push(`cell ${c.id}: bad kind ${c.kind}`); continue; }
      // static name-resolution check (fail-closed at load, not mid-run)
      const exprSrc = c.kind === "structure" || c.kind === "nudge" ? c.expr : null;
      if (exprSrc !== null && typeof exprSrc !== "string") errs.push(`cell ${c.id}: expr required`);
      if (typeof exprSrc === "string") {
        let idents;
        try { idents = collectIdents(parseFormula(exprSrc)); }
        catch (e) { errs.push(`cell ${c.id}: ${e.message}`); idents = new Set(); }
        for (const id of idents) {
          if (id === "shape" || id === "seed" || FUNCS[id]) continue;
          if (!known.has(id)) errs.push(`cell ${c.id}: unknown name '${id}' (refs must be slots or earlier cells)`);
        }
      }
      if (c.kind === "situation") {
        if (c.type !== "choice" && c.type !== "text") errs.push(`cell ${c.id}: situation type must be choice|text`);
        if (c.type === "choice" && (!Array.isArray(c.options) || c.options.length === 0))
          errs.push(`cell ${c.id}: choice needs options[]`);
        situation.push(c);
      }
      if (c.kind === "structure") structure.push(c);
      if (c.kind === "nudge") {
        if (typeof c.weight !== "number") errs.push(`cell ${c.id}: nudge needs numeric weight`);
        nudges.push(c);
      }
      if (c.kind === "wordsmith") {
        if (typeof c.instruction !== "string") errs.push(`cell ${c.id}: wordsmith needs instruction`);
        wordsmiths.push(c);
      }
      known.add(c.id);
    }
    if (wordsmiths.length === 0) errs.push("template needs at least one wordsmith cell (the last mile)");
  }
  if (errs.length) {
    const e = new Error("TEMPLATE_INVALID: " + errs.join("; "));
    e.errors = errs;
    throw e;
  }
  // cells carry their parsed AST so every consumer (run, nudge accumulation,
  // demo port) sees the same deterministic skeleton
  const cellsOut = cells.map((c) => ({ ...c, _ast: typeof c.expr === "string" ? parseFormula(c.expr) : null }));
  return { ...t, cells: cellsOut, _parsed: new Map(cellsOut.map((c) => [c.id, c])) };
}

export function templateSha(t) {
  // sha over the CLEAN template (never over the parsed _ast field)
  return sha256(canon({
    name: t.name, version: t.version,
    cells: t.cells.map(({ _ast, ...rest }) => rest),
  }));
}

// ------------------------------------------------------------------- fills
export class Sheet {
  constructor(template) {
    this.t = loadTemplate(template);
    this.fills = {};
    this.seedOverride = null;
  }
  fill(slot, value) {
    const cell = this.t._parsed.get(slot);
    if (!cell || cell.kind !== "situation") throw new Error(`NOT_A_SLOT:${slot}`);
    if (cell.type === "choice" && !cell.options.includes(value))
      throw new Error(`BAD_CHOICE:${slot}=${JSON.stringify(value)}`);
    this.fills[slot] = String(value);
    return this;
  }
  setSeed(s) { this.seedOverride = s; return this; }
  // choice signature seeds the dice; text drift does not re-roll fate
  choicesKey() {
    return canon(Object.fromEntries(this.t.cells
      .filter((c) => c.kind === "situation" && c.type === "choice")
      .map((c) => [c.id, this.fills[c.id] ?? null])));
  }
  fillShape() { return canon(this.fills); }
}

export const tokens = (s) =>
  String(s).toLowerCase().normalize("NFKC").split(/[^a-z0-9']+/).filter(Boolean);

// "similar fill-shape": identical choice signature AND text-slot token
// Jaccard >= minSim. Deterministic, no embeddings — honest shape, cheap.
export function similarShape(t, fillsA, fillsB, minSim = 0.6) {
  const choices = t.cells.filter((c) => c.kind === "situation" && c.type === "choice");
  for (const c of choices) if ((fillsA[c.id] ?? null) !== (fillsB[c.id] ?? null)) return false;
  const texts = t.cells.filter((c) => c.kind === "situation" && c.type === "text");
  let sim = 1;
  if (texts.length) {
    const bags = [fillsA, fillsB].map((f) => {
      const s = new Set();
      for (const c of texts) for (const w of tokens(f[c.id] ?? "")) s.add(w);
      return s;
    });
    const inter = [...bags[0]].filter((w) => bags[1].has(w)).length;
    const union = new Set([...bags[0], ...bags[1]]).size;
    sim = union === 0 ? 1 : inter / union;
  }
  return sim >= minSim;
}

// ------------------------------------------------------------- nudge layer
// resonance vector + coherence: the unspoken state.
export function accumulateNudges(t, env, seed) {
  const vec = {};    // id -> { value, weight, contrib, clamped }
  let clampedAny = false;
  for (const c of t.cells.filter((c) => c.kind === "nudge")) {
    let v = evalFormula(c._ast, env);
    if (v < -1 || v > 1) { v = Math.max(-1, Math.min(1, v)); clampedAny = true; }
    const w = c.weight;
    vec[c.id] = { value: round4(v), weight: round4(w), contrib: round4(w * v) };
    env[c.id] = v; // later nudges may resonate off earlier ones
  }
  void seed;
  // coherence: agreement (low dispersion) times resolve (mean direction).
  // sigma in [0,1] for values in [-1,1]; multiply a small resolve factor so a
  // field of zeros is coherent but weightless.
  const ws = Object.values(vec);
  const W = ws.reduce((a, x) => a + x.weight, 0) || 1;
  const mu = ws.reduce((a, x) => a + x.weight * x.value, 0) / W;
  const sigma = Math.sqrt(ws.reduce((a, x) => a + x.weight * (x.value - mu) ** 2, 0) / W);
  const coherence = round4(Math.max(0, Math.min(1, (1 - sigma) * (0.7 + 0.3 * Math.abs(mu)))));
  return { vec, coherence, clampedAny, mu: round4(mu), sigma: round4(sigma) };
}

// ------------------------------------------------------------- deadband law
// band for a shape-class: learned from receipts (compile step), else a priori
// margin around the prior run's coherence.
export function bandFor(priorCoherences, learned) {
  if (learned && Number.isFinite(learned.lo) && Number.isFinite(learned.hi)) return { ...learned, learned: true };
  const n = priorCoherences.length;
  if (n === 0) return null;
  const mean = priorCoherences.reduce((a, b) => a + b, 0) / n;
  if (n >= 2) {
    const sd = Math.sqrt(priorCoherences.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    const half = Math.max(0.05, 2 * sd);
    return { lo: round4(Math.max(0, mean - half)), hi: round4(Math.min(1, mean + half)), learned: false };
  }
  return { lo: round4(Math.max(0, mean - 0.15)), hi: round4(Math.min(1, mean + 0.15)), learned: false };
}

// --------------------------------------------------------------- word-smith
// deterministic fallback: stretch a skeleton over the drum with a lexicon,
// seeded by the run. No network, always receipts. llm=false, honestly.
const MORPH_LEX = {
  slow: "unhurried", bright: "luminous", dark: "shadowed", said: "voiced",
  cold: "frore", quiet: "hushed", sharp: "keen", warm: "mild",
  small: "slender", big: "broad", old: "weathered", new: "fresh",
};
const ADJ_POS = ["luminous", "keen", "warm", "quick", "bright", "tender"];
const ADJ_NEG = ["shadowed", "slow", "cold", "brittle", "dim", "heavy"];
const ADJ_FLAT = ["still", "quiet", "level", "even", "muted"];

export function fallbackWordsmith(cell, env, seed, nudges) {
  let shape = cell.fallback_shape ?? "{adj}.";
  const dom = Object.values(nudges).sort((a, b) => Math.abs(b.contrib) - Math.abs(a.contrib))[0];
  const dir = !dom ? "flat" : dom.contrib > 0.08 ? "pos" : dom.contrib < -0.08 ? "neg" : "flat";
  const pool = dir === "pos" ? ADJ_POS : dir === "neg" ? ADJ_NEG : ADJ_FLAT;
  const adj = pool[Math.floor(hash01(`${seed}|${cell.id}|adj`) * pool.length) % pool.length];
  shape = shape.replace(/\{adj\}/g, adj);
  shape = shape.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    if (name in env) return String(env[name]);
    return `{?${name}}`;
  });
  return shape;
}

// light morph: mechanical replay is allowed to dress differently, never to
// think. At most 2 whole-word synonym swaps, seeded — deterministic.
export function lightMorph(text, seed) {
  const words = String(text).split(/(\s+)/); // keep whitespace
  const hits = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i].toLowerCase().replace(/[^a-z']/g, "");
    if (MORPH_LEX[w]) hits.push(i);
  }
  let swaps = 0;
  for (const i of hits) {
    if (swaps >= 2) break;
    const w = words[i].toLowerCase().replace(/[^a-z']/g, "");
    if (hash01(`${seed}|morph|${w}`) < 0.5) continue; // seeded coin: not all hits
    words[i] = words[i].replace(new RegExp(w, "i"), MORPH_LEX[w]);
    swaps++;
  }
  return { text: words.join(""), swaps };
}

// ------------------------------------------------------------- LLM dispatch
// last-mile dispatcher, the madlibs-gan pattern in Node:
//   1) DeepInfra (cheap Qwen)  2) Groq (llama)  3) deterministic fallback.
// Keys come from env (loadEnvKeys reads /home/z/my-project/.env.keys once).
// Values are NEVER logged, NEVER returned, NEVER written anywhere.
export function loadEnvKeys(envPath = "/home/z/my-project/.env.keys") {
  if (!fs.existsSync(envPath)) return { loaded: [], exists: false };
  const out = [];
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    if (!(m[1] in process.env) || !process.env[m[1]]) {
      process.env[m[1]] = m[2].trim();
      out.push(m[1]);
    }
  }
  return { loaded: out, exists: true };
}

function httpsPostJson(url, headers, body, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers },
      timeout: timeoutMs,
    }, (res) => {
      let buf = "";
      res.on("data", (d) => (buf += d));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`LLM_HTTP_${res.statusCode}`);
          err.status = res.statusCode;
          return reject(err);
        }
        try { resolve(JSON.parse(buf)); } catch { reject(new Error("LLM_BAD_JSON")); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("LLM_TIMEOUT")));
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

export const LLM_ROUTES = [
  { path: "deepinfra", envKey: "DEEPINFRA_API_KEY", url: "https://api.deepinfra.com/v1/openai/chat/completions", model: "Qwen/Qwen3-30B-A3B-Instruct-2507" },
  { path: "groq", envKey: "GROQ_API_KEY", url: "https://api.groq.com/openai/v1/chat/completions", model: "llama-3.3-70b-versatile" },
];

// returns { text, path, model, usage, ms, llm:true } or null (both routes failed)
export async function dispatchLLM(messages, opts = {}) {
  const routes = opts.routes ?? LLM_ROUTES;
  for (const r of routes) {
    const key = process.env[r.envKey];
    if (!key) continue;
    const t0 = Date.now();
    try {
      const res = await httpsPostJson(r.url, { Authorization: `Bearer ${key}` }, {
        model: r.model, messages, max_tokens: opts.max_tokens ?? 500, temperature: opts.temperature ?? 0.8,
      });
      const choice = res.choices?.[0]?.message?.content;
      if (typeof choice !== "string") throw new Error("LLM_NO_CHOICE");
      return { text: choice.trim(), path: r.path, model: r.model, usage: res.usage ?? null, ms: Date.now() - t0, llm: true };
    } catch {
      // fall through to next route; receipt records only the final path used
    }
  }
  return null;
}

// unspoken state -> soft guidance block injected into every wordsmith prompt
export function unspokenPrompt(t, fills, nudgeState, structureSummary) {
  const vec = Object.fromEntries(Object.entries(nudgeState.vec)
    .map(([k, v]) => [k, { value: v.value, weight: v.weight, contrib: v.contrib }]));
  return [
    "UNSPOKEN STATE (soft guidance — honor its direction, do not recite it):",
    JSON.stringify({
      nudge_vector: vec,
      coherence: nudgeState.coherence,
      structure: structureSummary,
    }),
    "The words must fit the situation facts and the unspoken state above.",
  ].join("\n");
}

// ------------------------------------------------------------------ receipts
export function receiptTip(row) {
  const { tip, ...rest } = row;
  void tip;
  return sha256(canon(rest));
}
export function appendReceipt(ledgerPath, row) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const prev = lastTip(ledgerPath);
  const full = { ...row, prev_tip: prev };
  full.tip = receiptTip(full);
  fs.appendFileSync(ledgerPath, JSON.stringify(full) + "\n");
  return full;
}
export function readLedger(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return [];
  return fs.readFileSync(ledgerPath, "utf8").split("\n").filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return { _corrupt: true, raw: l.slice(0, 80) }; } });
}
export function lastTip(ledgerPath) {
  const rows = readLedger(ledgerPath);
  return rows.length ? rows[rows.length - 1].tip : "genesis";
}
export function verifyLedger(rows) {
  let prev = "genesis";
  for (const r of rows) {
    if (r._corrupt) return { ok: false, error: "LEDGER_CORRUPT_ROW" };
    const want = receiptTip(r);
    if (r.prev_tip !== prev) return { ok: false, error: "CUSTODY_GAP", run_id: r.run_id };
    if (r.tip !== want) return { ok: false, error: "RECEIPT_HASH_MISMATCH", run_id: r.run_id };
    prev = r.tip;
  }
  return { ok: true, rows: rows.length, tip: prev };
}

// learned bands come from the newest compile receipt per template+version
export function learnedBands(rows, name, version) {
  const compiles = rows.filter((r) => r.kind === "compile" && r.template === name && r.parent_version === version);
  if (!compiles.length) return {};
  return compiles[compiles.length - 1].bands ?? {};
}

// ----------------------------------------------------------------- the run
// opts: { seed, llm (async mock or null=>real dispatch), ledgerPath, now,
//         temperature, max_tokens, routes, dryBand (skip lookup, tests) }
export async function runSheet(template, fills, opts = {}) {
  const t = loadTemplate(template);
  const seed = opts.seed ?? sha256(`${t.name}|v${t.version}|${canon(fills)}`).slice(0, 12);
  const shapeSeed = sha256(`${t.name}|v${t.version}|` +
    canon(Object.fromEntries(t.cells.filter((c) => c.kind === "situation" && c.type === "choice")
      .map((c) => [c.id, fills[c.id] ?? null])))).slice(0, 12);

  // 1. STRUCTURE FIRST — deterministic skeleton + nudge accumulation
  const env = { ...fills, shape: shapeSeed, seed };
  const structureSummary = {};
  for (const c of t.cells.filter((c) => c.kind === "structure")) {
    const v = evalFormula(c._ast, env);
    env[c.id] = v;
    structureSummary[c.id] = v;
  }
  const nudgeState = accumulateNudges(t, env, seed);

  // 2. DEADBAND — same version + similar shape + coherence in band => replay
  const ledgerPath = opts.ledgerPath ?? null;
  const rows = ledgerPath ? readLedger(ledgerPath) : [];
  let prior = null;
  if (ledgerPath && !opts.dryBand) {
    for (const r of rows) {
      if (r.kind !== "run" || r.template !== t.name || r.version !== t.version) continue;
      if (similarShape(t, r.fills, fills)) prior = r; // newest match wins
    }
  }
  const bands = ledgerPath ? learnedBands(rows, t.name, t.version) : {};
  const priorCoherences = [];
  if (ledgerPath && !opts.dryBand) {
    for (const r of rows) {
      if (r.kind !== "run" || r.template !== t.name || r.version !== t.version) continue;
      if (similarShape(t, r.fills, fills)) priorCoherences.push(r.coherence);
    }
  }
  const band = priorCoherences.length
    ? bandFor(priorCoherences, bands[shapeSeed])
    : null;
  const inBand = !!(band && nudgeState.coherence >= band.lo && nudgeState.coherence <= band.hi);
  const skip = !!(prior && inBand);

  // 3. LAST-MILE WORDS
  const words = {};
  const calls = [];
  let tokensSaved = 0;
  const guidance = unspokenPrompt(t, fills, nudgeState, structureSummary);
  for (const c of t.cells.filter((c) => c.kind === "wordsmith")) {
    if (skip) {
      const prevText = prior.words?.[c.id];
      if (typeof prevText === "string") {
        const m = lightMorph(prevText, `${seed}|${c.id}`);
        words[c.id] = m.text;
        const saved = prior.wordsmith_calls?.find((x) => x.cell === c.id)?.usage;
        tokensSaved += saved ? (saved.total_tokens ?? 0) : 320;
        calls.push({ cell: c.id, path: "replay", llm: false, morphs: m.swaps, replay_of: prior.run_id });
        continue;
      }
      // prior receipt had no words for this cell -> live fallthrough
    }
    let result = null;
    const prompt = [
      c.instruction,
      "",
      guidance,
      "",
      `SITUATION FACTS (spoken): ${JSON.stringify(fills)}`,
      c.shape ? `SHAPE NOTE: ${c.shape}` : "",
      "Reply with ONLY the final words. No preamble, no quotes, no explanation.",
    ].filter(Boolean).join("\n");
    if (typeof opts.llm === "function") {
      result = await opts.llm({ cell: c.id, messages: [{ role: "user", content: prompt }], temperature: c.temperature ?? 0.8, max_tokens: c.max_tokens ?? 500 });
    } else {
      result = await dispatchLLM([{ role: "user", content: prompt }], {
        temperature: c.temperature ?? 0.8, max_tokens: c.max_tokens ?? 500, routes: opts.routes,
      });
    }
    if (result && result.text) {
      words[c.id] = result.text;
      calls.push({
        cell: c.id, path: result.path ?? "mock", model: result.model ?? "mock-model",
        llm: result.llm !== false, usage: result.usage ?? null, ms: result.ms ?? null,
      });
    } else {
      words[c.id] = fallbackWordsmith(c, env, seed, nudgeState.vec);
      calls.push({ cell: c.id, path: "fallback", llm: false, usage: null });
    }
  }

  // 4. RECEIPT — append-only, sha-chained
  const wordsText = t.cells.filter((c) => c.kind === "wordsmith").map((c) => words[c.id]).join("\n\n");
  const row = {
    kind: "run",
    run_id: `${t.name}.v${t.version}.${new Date(opts.now ?? Date.now()).toISOString()}.${sha256(seed + shapeSeed).slice(0, 6)}`,
    ts: new Date(opts.now ?? Date.now()).toISOString(),
    template: t.name,
    version: t.version,
    template_sha: templateSha(t),
    seed,
    shape_seed: shapeSeed,
    fills,
    nudge_vector: Object.fromEntries(Object.entries(nudgeState.vec)
      .map(([k, v]) => [k, { value: v.value, weight: v.weight, contrib: v.contrib }])),
    coherence: nudgeState.coherence,
    structure: Object.fromEntries(Object.entries(structureSummary)
      .map(([k, v]) => [k, typeof v === "number" ? round4(v) : v])),
    deadband: {
      prior_run: prior ? prior.run_id : null,
      band: band,
      in_band: inBand,
      mode: skip ? "replay" : prior ? "breach" : "live",
      reason: !prior ? "no similar prior"
        : skip ? "coherence inside band — mechanical replay"
        : `coherence ${nudgeState.coherence} outside [${band?.lo}, ${band?.hi}] — word-smith re-opened`,
      tokens_saved: skip ? tokensSaved : 0,
    },
    wordsmith_calls: calls,
    words,
    words_text: wordsText,
  };
  if (!ledgerPath) return { row, tip: receiptTip({ ...row, prev_tip: "genesis" }) };
  const full = appendReceipt(ledgerPath, row);
  return { row: full, tip: full.tip };
}

// ------------------------------------------------------- template evolution
// compile vNext: tune nudge weights from which nudges correlated with
// coherence >= threshold. Deterministic: same receipts -> byte-identical vNext.
export function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxx === 0 || syy === 0 ? 0 : sxy / Math.sqrt(sxx * syy);
}

export function compileTemplate(t, runReceipts, opts = {}) {
  const threshold = opts.coherenceThreshold ?? 0.55;
  const minRuns = opts.minRuns ?? 3;
  const runs = runReceipts.filter((r) => r.kind === "run" && r.template === t.name && r.version === t.version);
  const childVersion = t.version + 1;
  const cells = JSON.parse(JSON.stringify(t.cells)); // deep clone, v1 untouched
  const tuning = [];
  let note = "compiled";
  if (runs.length < minRuns) note = "insufficient runs — version minted for lineage only";
  if (runs.length >= minRuns) {
    const cohs = runs.map((r) => r.coherence);
    for (const c of cells) {
      if (c.kind !== "nudge") continue;
      const xs = runs.map((r) => r.nudge_vector?.[c.id]?.value ?? 0);
      const corr = round4(pearson(xs, cohs));
      const w0 = c.weight;
      const w1 = round4(Math.max(0.2, Math.min(3 * w0, w0 * (1 + corr))));
      if (w1 !== w0) { c.weight = w1; tuning.push({ cell: c.id, corr, from: w0, to: w1 }); }
      else tuning.push({ cell: c.id, corr, from: w0, to: w0, note: "no change" });
    }
  }
  const child = {
    name: t.name,
    version: childVersion,
    parent_version: t.version,
    parent_sha: templateSha(t),
    description: t.description,
    cells,
    evolution: {
      compiled_from: t.version,
      runs_considered: runs.length,
      coherence_threshold: threshold,
      tuning,
      note,
      compiled_ts: new Date(opts.now ?? Date.now()).toISOString(),
    },
  };
  return child;
}
