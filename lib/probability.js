// Turns the factor engine's raw signals into one real number per bet: how likely is this side to actually hit.
// This replaces computeMispricedScore's flat point bonuses (+7 for this, +6 for that, never checked against
// anything real) with a market-anchored logistic blend — the same basic approach real quant betting shops use:
//
//   1. Start at the market's own number. A sportsbook's de-vigged consensus price (row.refProb, sourced from the
//      odds feed's `fairOdds` across dozens of books) is already a strong estimate — books are in the business of
//      pricing a line close to accurate, and are wrong far less often than any one factor list guesses they are.
//   2. Blend in the player's own real, sample-size-weighted evidence (last-10-games hit rate against THIS exact
//      line, plus a smaller weight for the head-to-head history vs this opponent) using a shrinkage estimator —
//      a 2-game sample barely moves the number, a 10-game trend can move it a lot.
//   3. Apply small, named contextual nudges (matchup quality, injuries, schedule, market steam) in log-odds space
//      so several independent small signals combine by addition instead of double-counting each other.
//   4. Hard-override to near-zero when the player himself is out/doubtful — no amount of favorable context makes
//      a bet on a player who might not play a good one.
//
// The output is `{ modelProb, marketProb, edge, confidence, effectiveN, contributors }`. `edge = modelProb -
// marketProb` is the number to actually rank bets on — positive means the model thinks this hits more than the
// market is pricing it to, which is what "statistically likely AND good value" both collapse into. `confidence`
// exists so a two-game fluke can't outrank a real, well-supported trend just because the raw edge number happens
// to be bigger — see README's "Probability model" section for the full reasoning and the backtest script that
// calibrates MODEL_COEFFS against real history instead of leaving them as hand-picked defaults forever.
import { logit, sigmoid, clipProb } from "./oddsMath.js";
import { MODEL_COEFFS } from "./modelCoeffs.js";

function isOut(status) { return ["out", "doubtful"].includes((status || "").toLowerCase()); }

// Player's own weighted hit-rate estimate: last-10 games carries the primary weight (capped so an unusually
// long game log doesn't dominate the market prior entirely), head-to-head vs this week's opponent adds a
// smaller, capped weight of its own since it's the most matchup-specific evidence available but also the
// noisiest (often just 1-3 games). Returns null when there's no real per-prop form data to work with at all.
function ownEvidence(form) {
  if (!form?.available) return null;
  const n10 = Math.min(form.n_last10 || 0, 10);
  const nOpp = Math.min(form.n_vsOpp || 0, 4);
  const w10 = n10, wOpp = nOpp * 0.75;
  const effectiveN = w10 + wOpp;
  if (effectiveN <= 0) return null;
  const rate10 = form.rate_last10 ?? 0, rateOpp = form.rate_vsOpp ?? 0;
  const ownProb = (rate10 * w10 + rateOpp * wOpp) / effectiveN;
  return { ownProb, effectiveN };
}

// Bayesian-style shrinkage: the market prior counts as `marketPriorWeight` "games" of evidence, so a thin own
// sample barely moves the estimate and a deep one can move it a lot. With zero own evidence this returns the
// market's own number exactly — the honest answer when there's nothing more specific to say.
function blendTowardMarket(marketProb, evidence, marketPriorWeight) {
  if (!evidence) return { blendedProb: marketProb, effectiveN: 0 };
  const { ownProb, effectiveN } = evidence;
  const blendedProb = (marketProb * marketPriorWeight + ownProb * effectiveN) / (marketPriorWeight + effectiveN);
  return { blendedProb, effectiveN };
}

function confidenceTier(effectiveN, hasMatchupData) {
  if (effectiveN >= 8 && hasMatchupData) return "high";
  if (effectiveN >= 3) return "medium";
  return "low";
}

// One prop row -> a real, market-anchored probability estimate. `factors` is the object assemblePropFactors
// already built; `marketProb` is row.refProb (the consensus implied probability for this exact side).
export function estimatePropProbability(factors, marketProb, coeffs = MODEL_COEFFS) {
  if (marketProb == null) return { available: false };
  const f = factors || {};

  if (f.selfInjury && isOut(f.selfInjury.status)) {
    return {
      available: true, modelProb: 0.02, marketProb, edge: +(0.02 - marketProb).toFixed(4),
      confidence: "excluded", effectiveN: 0, contributors: [`${f.selfInjury.status} — player status voids this bet`]
    };
  }

  const clippedMarket = clipProb(marketProb);
  const evidence = ownEvidence(f.form);
  const { blendedProb, effectiveN } = blendTowardMarket(clippedMarket, evidence, coeffs.marketPriorWeight);

  let x = logit(blendedProb);
  const contributors = [];
  const nudge = (cond, key, label) => {
    if (!cond) return;
    x += coeffs[key] || 0;
    contributors.push(label);
  };

  nudge(f.form?.available && f.form.n_last3 >= 3 && f.form.rate_last3 >= 0.66, "form_hot", "hot last 3 games");
  // `.available` alone used to be treated as "the teammate-out bump is real," which just meant the computation
  // ran — not that usage actually went up. Now it only nudges when the without-teammate average genuinely beats
  // the with-teammate average by a real margin, on at least one real game without him.
  nudge(f.tendency?.available && f.tendency.withoutN >= 1 && f.tendency.withoutAvg > (f.tendency.withAvg || 0) * 1.15,
    "tendency_usage_bump", `usage bump without ${f.tendency?.teammateName || "teammate"}`);
  nudge(f.usage?.available && f.usage.snapPct >= 0.75, "usage_high_snap", "high snap share");
  nudge(f.redZone?.available && (f.redZone.redZoneShare >= 0.3 || f.redZone.goalLineShare >= 0.3), "redzone_share", "heavy red-zone share");
  nudge(f.defense?.available && f.defense.rank <= Math.ceil((f.defense.ofTeams || 32) * 0.35), "weak_defense", "favorable defensive matchup");
  nudge(f.matchupEdge?.available && f.matchupEdge.edge > 0.05, "matchup_edge", "team matchup edge");
  nudge(f.scoringEnvironment?.available && f.scoringEnvironment.combinedEpaPerPlay > 0.1, "high_scoring_env", "high-scoring environment");
  nudge(f.starterChange?.available && f.starterChange.changed, "starter_change", "starter change this week");
  nudge(f.secondaryInjury?.available && f.secondaryInjury.count >= 1, "secondary_injury", "opponent secondary hurt");
  nudge(f.oLineInjury?.available && f.oLineInjury.count >= 2, "oline_injury_penalty", "O-line injuries");
  nudge(f.schedule?.available && f.schedule.shortWeek, "short_week_penalty", "short week");
  nudge(f.schedule?.available && f.schedule.travelMiles > 1500, "travel_penalty", "long travel");
  nudge(f.marketMovement?.available && f.marketMovement.priceMove < 0, "steam_move", "market steaming this way");

  const modelProb = clipProb(sigmoid(x));
  return {
    available: true, modelProb, marketProb: clippedMarket, edge: +(modelProb - clippedMarket).toFixed(4),
    confidence: confidenceTier(effectiveN, f.defense?.available), effectiveN, blendedProb, contributors
  };
}

// Game lines in this build are Totals-Overs only (see analyze.js) — there's no per-team "own historical hit
// rate vs this exact total" evidence anywhere in the app, so unlike props this can't blend in a real empirical
// sample. It's the market number plus the same kind of contextual nudges, honestly capped at "medium" confidence
// since there's no direct historical proof behind this specific bet type yet — see README.
export function estimateGameLineProbability(factors, marketProb, coeffs = MODEL_COEFFS) {
  if (marketProb == null) return { available: false };
  const f = factors || {};
  const clippedMarket = clipProb(marketProb);
  let x = logit(clippedMarket);
  const contributors = [];
  const nudge = (cond, key, label) => { if (!cond) return; x += coeffs[key] || 0; contributors.push(label); };

  const homeEdge = f.matchupEdge?.homeOffVsAwayDef, awayEdge = f.matchupEdge?.awayOffVsHomeDef;
  const bothOffensesFavored = homeEdge?.available && awayEdge?.available && homeEdge.edge > 0 && awayEdge.edge > 0;
  nudge(bothOffensesFavored, "matchup_edge", "both offenses favored vs. these defenses");
  nudge(f.scoringEnvironment?.available && f.scoringEnvironment.combinedEpaPerPlay > 0.1, "high_scoring_env", "high-scoring environment");
  nudge(f.schedule?.home?.available && f.schedule.home.shortWeek, "short_week_penalty", "home team on short week");
  nudge(f.schedule?.away?.available && f.schedule.away.shortWeek, "short_week_penalty", "away team on short week");
  nudge(f.marketMovement?.available && f.marketMovement.priceMove < 0, "steam_move", "market steaming toward the Over");

  const modelProb = clipProb(sigmoid(x));
  const hasMatchupData = homeEdge?.available && awayEdge?.available && f.scoringEnvironment?.available;
  return {
    available: true, modelProb, marketProb: clippedMarket, edge: +(modelProb - clippedMarket).toFixed(4),
    confidence: hasMatchupData ? "medium" : "low", effectiveN: 0, contributors
  };
}
