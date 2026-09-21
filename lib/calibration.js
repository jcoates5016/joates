// Platt scaling: a real recalibration layer fit against this app's own live graded-picks ledger (lib/grading.js),
// applied on top of the raw modelProb lib/probability.js already computes — not a replacement for it. The
// distinction matters: lib/probability.js's blend can be systematically over- or under-confident in a way that's
// consistent in DIRECTION (e.g. every "medium confidence, 60% modelProb" pick actually hits 54% of the time) even
// when every individual factor coefficient in it is itself real and correctly signed — that's a calibration
// problem, not a signal problem, and no amount of re-tuning individual nudges fixes it. Platt scaling fits a
// simple 2-parameter logistic transform, calibratedProb = sigmoid(A * logit(rawProb) + B), from real (rawProb,
// actually hit or missed) pairs pulled straight from the live results ledger — the same "does this actually work"
// feedback loop lib/grading.js exists for, just closing it one step further.
//
// Standard reference: Platt, "Probabilistic Outputs for Support Vector Machines and Comparisons to Regularized
// Likelihood Methods" (1999) — originally for SVM scores, but the same 2-parameter logistic-on-logit fit applies
// to any model score that needs recalibrating against real outcomes, which is exactly this app's situation.
//
// Reuses lib/regularizedFit.js's fitL1Logistic at lambda=0 (a single feature, no penalty) rather than writing a
// second small IRLS solver — Platt scaling IS just a 1-feature logistic regression, so this is the same math
// scripts/backtest.js's joint fit uses, only with one input column (logit(rawProb)) instead of sixteen.
import { fitL1Logistic } from "./regularizedFit.js";
import { logit, sigmoid, clipProb } from "./oddsMath.js";

// Below this many graded picks, a 2-parameter fit is genuinely unstable (a handful of picks can swing A/B
// wildly, and a small unlucky/lucky streak looks identical to a real calibration problem) — this app falls back
// to the raw, uncalibrated modelProb until the live ledger has earned enough real results to trust a
// recalibration over it. 50 is a deliberately conservative floor: it's still a small sample for a 2-parameter
// fit, but the alternative (an even higher floor) means going even longer on raw modelProb once a real
// calibration problem does exist. Revisit upward if a real run shows this floor still overfits in practice.
export const MIN_CALIBRATION_PICKS = 50;

// Every graded pick the calibration ledger keeps a raw sample of is capped (see lib/grading.js's
// foldIntoLedger) so this never needs an unbounded amount of history — a rolling window of the most recent
// results is what should decide "is the model calibrated RIGHT NOW," not every pick since the app's first week.
export const MAX_CALIBRATION_SAMPLE = 500;

// Fits A (slope in logit space) and B (intercept) from real graded picks. Returns { available: false } below
// MIN_CALIBRATION_PICKS rather than a fit nobody should trust yet.
export function fitPlattScaling(samples) {
  const usable = (samples || []).filter(s => s && typeof s.modelProb === "number" && typeof s.hit === "boolean");
  if (usable.length < MIN_CALIBRATION_PICKS) {
    return { available: false, n: usable.length, note: `only ${usable.length} graded picks on record — need ${MIN_CALIBRATION_PICKS} before recalibrating` };
  }
  const X = usable.map(s => [logit(clipProb(s.modelProb))]);
  const y = usable.map(s => (s.hit ? 1 : 0));
  const fit = fitL1Logistic(X, y, 0);
  return { available: true, n: usable.length, A: fit.beta[0], B: fit.intercept };
}

// Applies a fitted Platt transform to one raw modelProb. Falls back to the raw probability unchanged whenever
// the calibration isn't available (too few graded picks yet) — this is the "fallback to raw probability
// otherwise" half of the feature, not an error path.
export function applyPlattScaling(rawProb, calibration) {
  if (!calibration?.available || rawProb == null) return rawProb;
  return clipProb(sigmoid(calibration.A * logit(clipProb(rawProb)) + calibration.B));
}

// One global A/B correction pools every confidence tier's picks into a single fit — but a real run of this app
// showed "high confidence" running ~20 points hot (avg est. 62.4%, actual hit rate 42.0%) while "medium
// confidence" ran even further off in relative terms (avg est. 43.2%, actual 21.8%). Platt scaling only fits ONE
// logistic-shaped correction curve; a single global A/B can't fully correct two tiers that are miscalibrated by
// different amounts in the same direction. Fitting one A/B PER confidence tier (still the same 2-parameter Platt
// math, just on each tier's own slice of the ledger) lets each tier's stated probability get pulled toward its
// own actual accuracy instead of an average of everyone else's.
export const CONFIDENCE_TIERS = ["high", "medium", "low"];

export function fitPlattScalingByTier(recentForCalibrationByTier) {
  const fits = {};
  for (const tier of CONFIDENCE_TIERS) fits[tier] = fitPlattScaling(recentForCalibrationByTier?.[tier] || []);
  return fits;
}

// Applies whichever tier-specific fit is available for `tier`; falls back to `fallbackFit` (the pooled global
// fit — still better than nothing) when that specific tier hasn't accumulated MIN_CALIBRATION_PICKS yet, and
// falls back further to the raw probability unchanged if neither is available. This three-level fallback is what
// lets per-tier calibration phase in gradually as each tier's own sample grows, rather than needing every tier to
// separately clear the 50-pick floor before ANY tier gets a real correction.
export function applyTieredPlattScaling(rawProb, tier, fitsByTier, fallbackFit) {
  const tierFit = fitsByTier?.[tier];
  if (tierFit?.available) return { calibratedProb: applyPlattScaling(rawProb, tierFit), source: `tier:${tier}` };
  if (fallbackFit?.available) return { calibratedProb: applyPlattScaling(rawProb, fallbackFit), source: "global" };
  return { calibratedProb: rawProb, source: "none" };
}
