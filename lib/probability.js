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
// The output is `{ modelProb, marketProb, edge, confidence, effectiveN, contributors, contributorDetails }`.
// `contributorDetails` mirrors `contributors` one-for-one but as `{key, weight, label}` — see lib/topPicks.js
// for the one real consumer (ranking "most relevant reasons" by actual measured impact). `edge = modelProb -
// marketProb` is the number to actually rank bets on — positive means the model thinks this hits more than the
// market is pricing it to, which is what "statistically likely AND good value" both collapse into. `confidence`
// exists so a two-game fluke can't outrank a real, well-supported trend just because the raw edge number happens
// to be bigger — see README's "Probability model" section for the full reasoning and the backtest script that
// calibrates MODEL_COEFFS against real history instead of leaving them as hand-picked defaults forever.
import { logit, sigmoid, clipProb } from "./oddsMath.js";
import { MODEL_COEFFS } from "./modelCoeffs.js";

function isOut(status) { return ["out", "doubtful"].includes((status || "").toLowerCase()); }

// Ranks a practice-participation status onto a 0-2 scale so computePracticeTrend's "first" vs "current" strings
// (raw ESPN practice-report text: "Did Not Participate" / "Limited" / "Full") can actually be compared for
// direction, not just displayed as a string. Unranked/unrecognized text (a rare wording variant) returns null so
// the nudge below only ever fires on a real, checkable comparison.
function practiceRank(status) {
  const s = (status || "").toLowerCase();
  if (s.includes("full")) return 2;
  if (s.includes("limited")) return 1;
  if (s.includes("did not") || s.includes("dnp") || s === "out") return 0;
  return null;
}

// Bad-weather thresholds: 50%+ precip chance or 15+ mph sustained wind is the point past which real NFL
// coaching staffs start talking publicly about leaning on the run and shortening the passing game — not an
// arbitrary round number, just the common broadcast/beat-reporter framing for "weather game."
function isBadWeather(forecast) {
  return !!forecast && (forecast.precipProb >= 50 || forecast.windMph >= 15);
}
// Exported so scripts/backtest.js can test the game-script/weather nudges against the exact same prop-type
// gating the live nudges use, instead of maintaining a second copy that could quietly drift out of sync.
export const RUN_PROPS = new Set(["rush_yds", "td_rush"]);
export const PASS_PROPS = new Set(["pass_yds", "td_pass", "rec_yds", "receptions", "td_rec"]);

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
      confidence: "excluded", effectiveN: 0, contributors: [`${f.selfInjury.status} — player status voids this bet`],
      contributorDetails: []
    };
  }

  const clippedMarket = clipProb(marketProb);
  const evidence = ownEvidence(f.form);
  const { blendedProb, effectiveN } = blendTowardMarket(clippedMarket, evidence, coeffs.marketPriorWeight);

  let x = logit(blendedProb);
  const contributors = [];
  // Same data as `contributors` (kept as plain label strings for backward compatibility — scripts/dry-run.js
  // and the frontend's modelSummaryHTML both match against those strings directly), but paired with the actual
  // coefficient that fired, signed. This is what lets a consumer (buildTopPicks in lib/topPicks.js) rank "the
  // most relevant reasons" by the model's own measured impact instead of guessing — and, just as important,
  // filter OUT a nudge whose real backtested effect is negative (e.g. matchup_edge measured at -0.027) even
  // though its label reads like a positive. Never invented: every weight here is a real coefficient already
  // driving the live grade %, just exposed instead of thrown away after `x` is computed.
  const contributorDetails = [];
  const nudge = (cond, key, label) => {
    if (!cond) return;
    const weight = coeffs[key] || 0;
    x += weight;
    contributors.push(label);
    contributorDetails.push({ key, weight, label });
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
  nudge(f.frontSevenInjury?.available && f.frontSevenInjury.count >= 1, "front_seven_injury", "opponent front seven hurt");
  nudge(f.oLineInjury?.available && f.oLineInjury.count >= 2, "oline_injury_penalty", "O-line injuries");
  nudge(f.schedule?.available && f.schedule.shortWeek, "short_week_penalty", "short week");
  nudge(f.schedule?.available && f.schedule.travelMiles > 1500, "travel_penalty", "long travel");

  // Live weather forecast (lib/fetchers/weather.js, outdoor/retractable-open venues only). Personal history —
  // does THIS player's own game log actually show him doing better or worse in wet/windy games? — wins whenever
  // there's enough of it (2+ real wet games on record) since it's the most specific evidence available. With no
  // personal sample, fall back to the generic positional read that started this whole nudge: a rushing prop
  // benefits from a run-heavier gameplan in bad weather, a passing/receiving prop (including the QB throwing to
  // them) works against the same gameplan shift. A player with no real position fit either way (e.g. a kicker,
  // or a TD-only prop with no clean run/pass bucket) gets no nudge rather than a guessed one.
  if (isBadWeather(f.weatherForecast)) {
    const hist = f.weatherHistorical;
    const personalDir = hist?.available && hist.wetN >= 2 && hist.wetAvg != null && hist.dryAvg != null
      ? (hist.wetAvg > hist.dryAvg ? "boost" : hist.wetAvg < hist.dryAvg ? "penalize" : null)
      : null;
    if (personalDir === "boost") nudge(true, "weather_personal_boost", `personal history: performs better in wet/windy games (${hist.wetN} tracked)`);
    else if (personalDir === "penalize") nudge(true, "weather_personal_penalty", `personal history: performs worse in wet/windy games (${hist.wetN} tracked)`);
    else if (RUN_PROPS.has(f.propType)) nudge(true, "weather_run_favor", "bad-weather forecast favors the run game");
    else if (PASS_PROPS.has(f.propType)) nudge(true, "weather_pass_penalty", "bad-weather forecast works against the passing game");
  }

  // Dome-vs-outdoor split (lib/factors/playerSplits.js's computeVenueSplit) only means something once it's
  // cross-referenced against which one THIS week's game is actually being played in (f.roof, from the
  // schedule) — a QB who's genuinely better in a dome gets no boost from that history in an outdoor game. Scoped
  // to passing/receiving props, the ones a stadium roof plausibly affects; a rushing prop doesn't meaningfully
  // change because the game is indoors.
  if (f.venue?.available && f.roof && PASS_PROPS.has(f.propType) && f.venue.domeN >= 2 && f.venue.outdoorN >= 2) {
    const isDomeGame = f.roof !== "outdoors";
    const domeBetter = f.venue.domeAvg > f.venue.outdoorAvg;
    if (isDomeGame && domeBetter) nudge(true, "venue_edge", "personal history: performs better in a dome, and this game is in one");
    else if (!isDomeGame && !domeBetter) nudge(true, "venue_edge", "personal history: performs better outdoors, and this game is outdoors");
  }

  // Practice-participation direction (lib/factors/injury.js's computePracticeTrend), not just the fact that a
  // trend exists — trending DOWN across the week (Full -> Limited -> DNP) is a real signal even for a player
  // who's ultimately still listed as expected to play; trending UP (DNP -> Limited -> Full) is the opposite.
  if (f.practiceTrend?.available) {
    const r1 = practiceRank(f.practiceTrend.first), r2 = practiceRank(f.practiceTrend.current);
    if (r1 != null && r2 != null && r2 < r1) nudge(true, "practice_trend_down", `practice trend worsening this week (${f.practiceTrend.trend})`);
    else if (r1 != null && r2 != null && r2 > r1) nudge(true, "practice_trend_up", `practice trend improving this week (${f.practiceTrend.trend})`);
  }

  // Vegas's own implied game script (factors/index.js's computeGameScript, from the odds feed's spread/total —
  // not a bet type here anymore, just read as context the same way weather or a defensive matchup is). A team
  // favored by a touchdown or more tends toward a run-heavy, clock-killing gameplan late; a team getting a
  // touchdown or more tends toward more pass attempts playing catch-up. Scoped to the prop types that plausibly
  // move with game script — a kicker or a defense doesn't have a "run prop," and this app doesn't offer either,
  // but the same RUN_PROPS/PASS_PROPS sets the weather nudge above already uses are reused here for consistency.
  if (f.gameScript?.available) {
    if (f.gameScript.isBigFavorite && RUN_PROPS.has(f.propType)) nudge(true, "game_script_run_favor", `big favorite (market has them favored by ${Math.abs(f.gameScript.teamSpread).toFixed(1)}) — game script favors the run`);
    else if (f.gameScript.isBigUnderdog && PASS_PROPS.has(f.propType)) nudge(true, "game_script_pass_favor", `big underdog (market has them getting ${f.gameScript.teamSpread.toFixed(1)}) — game script favors garbage-time passing volume`);
  }

  // Market steam, scaled by how far the price has actually moved instead of a flat bump for any move at all — a
  // line that shortened 3 cents and one that shortened 40 cents were being treated identically before. 20 cents
  // of American-odds movement is treated as "one full unit" of steam (e.g. -110 -> -130), capped at 2x so one
  // outlier book/point-in-time spike can't dominate the whole estimate.
  if (f.marketMovement?.available && f.marketMovement.priceMove < 0) {
    const magnitude = Math.min(Math.abs(f.marketMovement.priceMove) / 20, 2);
    const weight = (coeffs.steam_move || 0) * magnitude;
    const label = `market steaming this way (${f.marketMovement.priceMove} pts)`;
    x += weight;
    contributors.push(label);
    contributorDetails.push({ key: "steam_move", weight, label });
  }

  const modelProb = clipProb(sigmoid(x));
  return {
    available: true, modelProb, marketProb: clippedMarket, edge: +(modelProb - clippedMarket).toFixed(4),
    confidence: confidenceTier(effectiveN, f.defense?.available), effectiveN, blendedProb, contributors, contributorDetails
  };
}
