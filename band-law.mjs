// band-law.mjs — the unified band mechanism (WP-12): ONE decision function,
// three derived surfaces. Wave-68 lane 68-b2.
//
// The fleet derived the same mechanism three times without noticing:
//   Surface A (madlibs-jev, WP-03):  REST while observed coherence stays
//     inside a band learned from prior runs (replay, zero LLM ops); spend
//     (wake the word-smith) on breach.
//   Surface B (purpose-loops, WP-08): REST while predicted marginal
//     purpose-per-op stays under the deadband (pause at gate, zero loop
//     ops); spend (run the iteration) when value appears.
//   Surface C (reflex-router, atlas round 22, receipted in the atlas
//     lane): breaches compound — consecutive outside-band observations
//     escalate severity instead of re-waking from zero.
//
// The law, stated once:
//
//     decide(x, R) = (x in R) ? REST : ESCALATE
//
//     REST  — the observation is unsurprising *for this surface*: continue
//             mechanically (replay) or stop paying (pause). Zero thought-ops.
//     ESCALATE — the expensive path opens (word-smith / iteration / wake).
//
// The surfaces differ only in what x encodes and what R covers:
//   deviation-band surface: R = [mean − k·sd, mean + k·sd] around priors
//     ("the world matches what I have seen — rest inside it").
//   value-floor surface:    R = [0, deadband) ("there is nothing worth
//     thought here — rest inside it; spend when value appears").
// Both are regions; both use the same comparator; both must be PRE-REGISTERED
// or learned from receipts with a flat control rung (see spec/invariants.json
// lanes: the band's expectation half is the spec_sha discipline).
//
// This module is the canonical copy. purpose-loops vendors it byte-for-byte
// with a pinned sha256 (tests/vendor.test.mjs) so the two surfaces cannot
// drift. stdlib-only, deterministic, no I/O.

// ---------------------------------------------------------------- regions

// Deviation band around prior observations — mirrors engine.mjs bandFor
// branch-for-branch (property-tested against it in tests/band-law.test.mjs):
//   n === 0            -> null (no priors: the surface must OPEN, not rest)
//   n === 1            -> mean ± singleHalf (default 0.15)
//   n >= 2             -> mean ± max(floor, k·sd)   (floor 0.05, k 2)
// `learned` (a pre-registered/compiled band) overrides the a-priori form.
export function regionTwoSided(priors, opts = {}) {
  const learned = opts.learned;
  if (learned && Number.isFinite(learned.lo) && Number.isFinite(learned.hi)) {
    return { lo: learned.lo, hi: learned.hi, kind: "two-sided", learned: true };
  }
  const k = opts.k ?? 2, floor = opts.floor ?? 0.05, singleHalf = opts.singleHalf ?? 0.15;
  const n = priors.length;
  if (n === 0) return null;
  const mean = priors.reduce((a, b) => a + b, 0) / n;
  let half;
  if (n >= 2) {
    const sd = Math.sqrt(priors.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    half = Math.max(floor, k * sd);
  } else {
    half = singleHalf;
  }
  return {
    lo: Math.max(0, mean - half),
    hi: Math.min(1, mean + half),
    kind: "two-sided",
    learned: false,
    hiInclusive: true, // bandFor semantics: coherence == hi is still in-band
  };
}

// Value-floor region: rest while x is UNDER the deadband (nothing worth
// thought), spend once value per op reaches it. The upper end is EXCLUSIVE
// (marginal === deadband already spends — purpose.plan pauses only when
// marginal < deadband). hiInclusive: false is the region declaring its own
// boundary convention; decide() honors it. One comparator, two conventions,
// each declared by the region, not hardcoded per surface.
export function regionOneSided(deadband, { lo = 0 } = {}) {
  return { lo, hi: deadband, hiInclusive: false, kind: "value-floor", deadband };
}

// ---------------------------------------------------------------- decision

// The ONE comparator. REST iff x is inside the region's declared bounds:
// two-sided regions are inclusive both ends (bandFor semantics); value-floor
// regions are inclusive-lo, exclusive-hi (marginal == deadband spends).
// Region-null means the surface has no priors yet -> OPEN.
export function decide(x, region) {
  if (!region) return "OPEN"; // no region yet: the surface has no priors —
                              // it must observe (live run / first attempt)
  const inHi = region.hiInclusive === false ? x < region.hi : x <= region.hi;
  return x >= region.lo && inHi ? "REST" : "ESCALATE";
}

// Surface adapter map — how the two receipted surfaces instantiate the law.
// Kept as DATA so the paper's claim is checkable against code.
export const SURFACES = {
  "madlibs-jev": {
    x: "run coherence (unspoken nudge agreement)",
    region: "two-sided band around prior same-shape coherences (learned bands override)",
    rest: "mechanical replay of the prior words (light morph), zero LLM ops",
    escalate: "word-smith re-opens (live dispatch)",
    precondition: "a similar prior must exist; without one there is nothing to replay (OPEN -> live)",
    receipt: "deadband.mode: replay | breach | live",
  },
  "purpose-loops": {
    x: "predicted marginal purpose-per-op (units / last observed ops)",
    region: "value-floor [0, deadband)",
    rest: "pause at the gate, zero loop ops (the pause is a receipt, not an exception)",
    escalate: "iteration runs (spend ops on the attempt)",
    precondition: "stop condition not already met (met = REST with the loop closed)",
    receipt: "purpose.pause | iteration.begin",
  },
  "reflex-router": {
    x: "escalation score of the triggering observation",
    region: "per-band thresholds; consecutive breaches compound (hysteresis)",
    rest: "stay in the current band's mechanical policy",
    escalate: "band-escalation (round 22: 28/28 decisions at 38% cost, atlas lane receipt)",
    precondition: "cited surface — receipted in the atlas lane, proven here only as the escalation() extension below",
    receipt: "band escalation events",
  },
};

// ------------------------------------------------------------- escalation
// Surface C's contribution, as an opt-in state wrapper around decide().
// REST resets the breach streak; ESCALATE compounds it. `after` breaches in
// a row raise the level (1-based). This is hysteresis: a single stray breach
// does not throw the system into full wake, but a run of them escalates and
// the level persists until a REST resets it.
export function escalation(state = { breaches: 0, level: 0 }, x, region, { after = 2 } = {}) {
  const d = decide(x, region);
  if (d === "REST") return { decision: d, breaches: 0, level: 0, state: { breaches: 0, level: 0 } };
  const breaches = state.breaches + 1;
  const level = Math.min(state.level + (breaches >= after ? 1 : 0), 3);
  return { decision: d, breaches, level, state: { breaches, level } };
}

// ------------------------------------------------------------------ audit
// Explain a decision the way receipts should state it — the reason string
// template both surfaces' ledgers can share (madlibs deadband.reason and
// purpose pause `why` are this function's per-surface dialects).
export function explain(x, region, decision) {
  if (decision === "OPEN") return "no region yet — no priors, the surface observes";
  if (decision === "REST") {
    return region.kind === "value-floor"
      ? `marginal ${x} under deadband ${region.deadband} — no surprise, no spend`
      : `x ${x} inside [${region.lo}, ${region.hi}] — rest`;
  }
  return region.kind === "value-floor"
    ? `marginal ${x} at or above deadband ${region.deadband} — value worth ops`
    : `x ${x} outside [${region.lo}, ${region.hi}] — surprise, spend`;
}
