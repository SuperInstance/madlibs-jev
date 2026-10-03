# madlibs-jev

> **Madlibs where the substrate is the first-class citizen and the LLM is the
> last-mile word-smith.** The blanks are not words — they are cells. The
> skeleton thinks; only the skin speaks.

Sibling of [discovery-mad-libs](https://github.com/SuperInstance/discovery-mad-libs)
(templates + sessions + rewind), [madlibs-gan](https://github.com/SuperInstance/madlibs-gan)
(paradigm games with JEV+JEPA as the peanut gallery) and
[madlibs-gan-turbovec](https://github.com/SuperInstance/madlibs-gan-turbovec)
(paradigm memory). This repo is the fleet's own angle: **the madlib sheet IS a
JEV quilt**, and the LLM is hired only for the final stretch of language.

## The three laws

1. **STRUCTURE FIRST.** A template is a typed cell sheet, not a prompt string:
   - `situation` cells — the spoken blanks a human or agent fills (choices, facts);
   - `structure` cells — pure formulas over the situation (the unspoken skeleton:
     luminance, gravity, leash, horizon...), evaluated deterministically;
   - `nudge` cells — the unspoken field: weighted values in [-1, 1] (dread,
     longing, uncanny, novelty, parsimony, risk...). Nudges may resonate off
     earlier nudges. A **coherence** score = agreement (low dispersion) ×
     resolve (mean direction), in [0, 1].
   - `wordsmith` cells — the ONLY cells allowed to call a model. They receive
     the accumulated unspoken state as soft guidance and produce the words.
2. **LAST-MILE WORDS.** Models never decide; they clothe. The situation facts,
   the structure and the nudge field are computed BEFORE any model call, and
   the prompt hands the model a shaped field, not an open question.
3. **DEADBAND REPLAY** (the exocortex law, from erised-exocortex). If the same
   template + a similar fill-shape already produced a run whose coherence lies
   inside the learned band, the engine SKIPS the model and mechanically replays
   the prior words (lightly morphed, seeded, receipted as `mode: replay`).
   Surprise outside the band re-opens the word-smith. Token economy is a
   first-class receipt field (`tokens_saved`).

## Template evolution (the loop, not the run)

After every 3 runs, `compile.mjs` correlates each nudge with coherence and
emits `vNext` with re-tuned weights — append-only, parent sha chained, never
mutating the parent. Receipts of record:

| template | v1 coherence | v2 coherence | compile tunings |
|---|---|---|---|
| scene-skin | 0.4605 | 0.5623 | 4 cells re-weighted |
| discovery-skin | 0.6017 | 0.5438 | 5 cells re-weighted (honest regression — negative correlation found on `novelty`, weight 1 → 0.2) |

The discovery-skin regression is a genuine finding kept visible: coherence is
not "higher is better" — the compile step chased agreement and flattened the
novelty axis the template was built to explore. See LIMITS.

Pre-registration, committed before any implementation: `spec/invariants.json`
is the compile loop's expected-invariant spec (novelty dispersion,
tuning-weight bounds, band non-degeneracy) — the expectation hash is what the
coming sealed-compile step will verify against before canonizing a vNext.

## Token economy (the receipted claim)

10 runs across 2 templates × 2 versions: **6 live word-smith calls, 4
mechanical deadband replays**, ~1.8k characters of avoided generation, all
recorded per-run in `receipts/ledger.jsonl` (`deadband.mode`,
`deadband.tokens_saved`). The fourth run of a shape is where the exocortex
starts paying rent.

## The unspoken layer

Nudges are vector-not-value: they are accumulated, weighted, resonant, and
used twice — once as the coherence gate for the deadband, once as soft
guidance inside the word-smith prompt ("the field says: uncanny 0.91, longing
0.25, dread −0.11; let the prose sit at that temperature"). The words are the
skin; the field is the drum-frame. No model ever sees a blank it could fill
wrong, only a drum ready for its skin.

## Layout

- `engine.mjs` — cell sheet parser (fail-closed), formula engine, nudge
  accumulation, deadband law, word-smith dispatcher (DeepInfra → Groq →
  deterministic fallback, honestly labeled), append-only ledger.
- `compile.mjs` — template evolution (correlate nudges × coherence → vNext).
- `templates/` — scene-skin + discovery-skin, v1 and v2 (v1 immutable).
- `receipts/ledger.jsonl` — append-only run + compile receipts (sha-chained
  via `prev_tip` → `tip`).
- `tests/` — 18 tests: fail-closed parsing, nudge determinism, deadband skip,
  ledger append-only, template-evolution link integrity, **demo parity** (the
  client-side core in `demo/index.html` is pinned to the engine on a fixed
  battery).
- `demo/index.html` — self-contained madlibs playground (no network, no CDN):
  fill the spoken blanks, watch the nudge field + coherence meter move, run,
  and read the bundled real receipts. Dark quilt aesthetic.
- `tools/bundle-demo.mjs` — injects current templates + receipts into the demo.

## Run it

```bash
npm test                                   # 23/23 (18 engine + 5 shape-memory)
node --test tests/*.test.mjs               # same suite, raw (no directory form: `node --test tests/` fails)
node run-index.mjs                         # Bridge-1 parity receipt: 0 mismatches (exit 1 on any)
node run.mjs templates/scene-skin.json \
     --fill place="a night ferry" \
     --fill arrival="in fog" \
     --fill figure="the ferryman" \
     --fill object="a brass key"           # one run; a deadband hit replays at 0 tokens
node compile.mjs templates/scene-skin.json # evolve vNext (appends a compile receipt)
node tools/bundle-demo.mjs                 # rebuild demo/index.html from current receipts
```

Note: there is no `--live` flag — a run hires the word-smith automatically
(DeepInfra → Groq → deterministic fallback, honestly labeled) only when the
deadband misses; `demo/index.html` replays the receipted campaign client-side
with no network.


## Bridge 1, receipted: the quantized shape index (`shape-memory.mjs`)

WP-11's first bridge is implemented additively: a turbovec-style
**ShapeMemory** (hashed fill-shape embeddings, 4-bit quantization, 8x
vs float32 verified) shortlists candidates for the deadband, and the
honest Jaccard gate still disposes — the engine's decision semantics are
untouched. Receipted by `run-index.mjs`: over all 10 campaign shapes,
**with-index decisions are identical to the full scan (0 mismatches)**,
with the shortlist provably containing the row the gate would have found
(5/5 index tests, 18/18 engine tests).

Two A/B design lessons are receipted in the code so they aren't re-derived:
a shared scratch ledger let earlier iterations' appended rows poison
"newest match wins" (fix: pristine copy per arm per iteration); the first
draft also appended into the campaign ledger of record (reverted from git
before push — the ledger of record must never be an experiment's scratch
space).

## Honest limits

- **Coherence chasing can flatten exploration.** discovery-skin v2 regressed
  (0.60 → 0.54) because the compile step rewarded agreement. Future work: a
  purpose-aware compile that trades coherence against a diversity term.
- The shape-memory GATE is still choice equality + token Jaccard; the
  turbovec-style index (shape-memory.mjs) accelerates it without changing
  its semantics. Semantic upgrades (learned embeddings) remain future work.
- Deadband bands are currently a-priori margins (mean ± max(0.05, 2·sd) once ≥2
  priors exist); learned bands arrive with more receipts.
- Word-smith fallback is deterministic and honestly labeled `llm:false` in
  receipts — the demo never needs a network, and runs never need one either.
