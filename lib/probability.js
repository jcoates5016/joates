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
//      so several independent small signals combine by addition instead of double-counting each other — capped
//      in total (NUDGE_CAP, below) so several REAL but CORRELATED nudges can't compound past what any one of
//      them, or the joint fit that measured them, actually justifies.
//   4. Hard-override to near-zero when the player himself is out/doubtful — no amount of favorable context makes
//      a bet on a player who might not play a good one.
//
// The output is `{ modelProb, marketProb, edge, confidence, effectiveN, contributors, contributorDetails,
// nudgeCapped, rawNudgeSum }`. `nudgeCapped`/`rawNudgeSum` exist purely for diagnostics — did this specific pick
// hit the cap in step 3, and what was the uncapped total — so a future analysis (or scripts/refit-live-ledger.js)
// can check whether capped picks actually needed capping, empirically, instead of leaving that untestable.
// `contributorDetails` mirrors `contributors` one-for-one but as `{key, weight, label}` — see lib/topPicks.js
// for the one real consumer (ranking "most relevant reasons" by actual measured impact). `edge = modelProb -
// marketProb` is the number to actually rank bets on — positive means the model thinks this hits more than the
// market is pricing it to, which is what "statistically likely AND good value" both collapse into. `confidence`
// exists so a two-game fluke can't outrank a real, well-supported trend just because the raw edge number happens
// to be bigger — see README's "Probability model" section for the full reasoning and the backtest script that
// calibrates MODEL_COEFFS against real history instead of leaving them as hand-picked defaults forever.
import { logit, sigmoid, clipProb } from "./oddsMath.js";
import { MODEL_COEFFS } from "./modelCoeffs.js";
import { ELEVATED_PRESSURE_THRESHOLD, CLEAN_POCKET_THRESHOLD } from "./factors/pressure.js";
import { QBR_ELITE_THRESHOLD, QBR_POOR_THRESHOLD } from "./factors/qbr.js";

// Real, checkable CPOE/RYOE/separation thresholds — "clearly above/below the pack," not arbitrary round numbers.
// CPOE and rush-yards-over-expected are both centered near 0 league-wide by construction (an "expectation" model
// grades every player against the same baseline), so +/-3 points either way is a real, meaningfully-sized tilt,
// not noise. Average separation of 3 yards at the catch point is the commonly cited "gets open" benchmark in the
// same NFL Next Gen Stats publications this data itself comes from.
const NGS_CPOE_HOT = 3, NGS_CPOE_COLD = -3;
const NGS_RYOE_HOT = 0.5, NGS_RYOE_COLD = -0.5;
const NGS_SEPARATION_HOT = 3.0;

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
  // Every nudge below adds into `nudgeSum`, not `x` directly — the combined total gets capped (see NUDGE_CAP,
  // applied once every nudge has fired, below) so several real-but-correlated factors can't compound past what
  // any of them individually justifies. `x` itself (the market-anchored blend above) already has its own real
  // shrinkage via marketPriorWeight and is never capped — this cap is specifically about the contextual nudges
  // stacking on top of it.
  let nudgeSum = 0;
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
    nudgeSum += weight;
    contributors.push(label);
    contributorDetails.push({ key, weight, label });
  };

  nudge(f.form?.available && f.form.n_last3 >= 3 && f.form.rate_last3 >= 0.66, "form_hot", "hot last 3 games");
  // `.available` alone used to be treated as "the teammate-out bump is real," which just meant the computation
  // ran — not that usage actually went up. Now it only nudges when the without-teammate average genuinely beats
  // the with-teammate average by a real margin, on at least one real game without him.
  // `f.tendency.available` now already means the teammate is confirmed Out/Doubtful/Questionable as of this
  // refresh (see computeTeammateOutTendency) — this nudge no longer needs its own currency check, just the real
  // magnitude check that was already here.
  nudge(f.tendency?.available && f.tendency.withoutN >= 1 && f.tendency.withoutAvg > (f.tendency.withAvg || 0) * 1.15,
    "tendency_usage_bump", `usage bump with ${f.tendency?.teammateName || "teammate"} (${f.tendency?.teammateStatus || "out"}) sidelined`);
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
  // there's enough of it (2+ real wet games on record) since it's the most specific evidence available (and stays
  // hand-set — see HAND_SET_NOTES in scripts/backtest.js — there's no historical per-player forecast archive to
  // backtest it against). With no personal sample, fall back to the generic positional read that started this
  // whole nudge: a rushing prop reads one way in bad weather, a passing/receiving prop (including the QB throwing
  // to them) the other way. A player with no real position fit either way (e.g. a kicker, or a TD-only prop with
  // no clean run/pass bucket) gets no nudge rather than a guessed one.
  //
  // weather_run_favor and weather_pass_penalty are BOTH backtested (scripts/backtest.js, against Open-Meteo's
  // real historical archive) and can come back pruned to 0 or with either sign, the same way game_script_run_favor/
  // game_script_pass_favor above did — a real run confirmed `weather_run_favor` pruned to 0 (no statistically real
  // effect at that sample size) while `weather_pass_penalty` came back a real, negative signal. So both labels
  // stay factually neutral ("weather read") instead of asserting a direction that the real coefficient might not
  // back up, matching the matchup_edge/game_script precedent.
  if (isBadWeather(f.weatherForecast)) {
    const hist = f.weatherHistorical;
    const personalDir = hist?.available && hist.wetN >= 2 && hist.wetAvg != null && hist.dryAvg != null
      ? (hist.wetAvg > hist.dryAvg ? "boost" : hist.wetAvg < hist.dryAvg ? "penalize" : null)
      : null;
    if (personalDir === "boost") nudge(true, "weather_personal_boost", `personal history: performs better in wet/windy games (${hist.wetN} tracked)`);
    else if (personalDir === "penalize") nudge(true, "weather_personal_penalty", `personal history: performs worse in wet/windy games (${hist.wetN} tracked)`);
    else if (RUN_PROPS.has(f.propType)) nudge(true, "weather_run_favor", "bad-weather forecast — weather read");
    else if (PASS_PROPS.has(f.propType)) nudge(true, "weather_pass_penalty", "bad-weather forecast — weather read");
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
  // not a bet type here anymore, just read as context the same way weather or a defensive matchup is). The
  // original intuition — a team favored by a touchdown or more leans run-heavy late, a team getting a touchdown
  // or more leans pass-heavy playing catch-up — turned out to only be half-real once actually checked against
  // three seasons of real outcomes (scripts/backtest.js, walk-forward, "did the player beat his OWN trailing
  // average"): game_script_run_favor had no statistically real effect at all (p=0.085, pruned to exactly 0 — a
  // big rushing favorite's back does NOT reliably beat his own established baseline more often), and
  // game_script_pass_favor came back with a REAL effect in the OPPOSITE direction of the intuition (p=0.008,
  // -0.091) — a big underdog's pass-catchers beat their own baseline LESS often, not more, plausibly because
  // garbage-time volume tends to come against a leading, often better, defense and doesn't translate to the same
  // per-target efficiency. Labels below are worded neutrally rather than directionally for exactly this reason —
  // same pattern as matchup_edge's own label above, which stayed neutral once ITS real effect also came back
  // negative — so the label reads true regardless of which way a given coefficient measures, and never claims a
  // "favor" the data doesn't support. Scoped to the prop types that plausibly move with game script — a kicker or
  // a defense doesn't have a "run prop," and this app doesn't offer either, but the same RUN_PROPS/PASS_PROPS
  // sets the weather nudge above already uses are reused here for consistency.
  if (f.gameScript?.available) {
    if (f.gameScript.isBigFavorite && RUN_PROPS.has(f.propType)) nudge(true, "game_script_run_favor", `big favorite (market has them favored by ${Math.abs(f.gameScript.teamSpread).toFixed(1)}) — game script read`);
    else if (f.gameScript.isBigUnderdog && PASS_PROPS.has(f.propType)) nudge(true, "game_script_pass_favor", `big underdog (market has them getting ${f.gameScript.teamSpread.toFixed(1)}) — game script read`);
  }

  // Referee tendency (lib/factors/referee.js) — a non-bettable context read (this app has no Totals market
  // anymore), the same treatment computeGameScript already gets. An over-friendly crew is a real, if modest,
  // tailwind for offensive production generally (more scoring plays for BOTH offenses), so unlike the weather/
  // game-script nudges above this deliberately isn't scoped to RUN_PROPS/PASS_PROPS. Written as plain `if`
  // blocks (not the always-evaluated-arguments `nudge(cond, key, label)` shorthand) so the label string is only
  // ever built once the fields it reads are actually present — same reason the weather/venue blocks above do.
  if (f.referee?.available) {
    if (f.referee.overRate >= 0.6) nudge(true, "referee_over_lean",
      `referee ${f.referee.refereeName} has called the over in ${Math.round(f.referee.overRate * 100)}% of ${f.referee.gamesCalled} games`);
    else if (f.referee.overRate <= 0.4) nudge(true, "referee_under_lean",
      `referee ${f.referee.refereeName} has trended under (${Math.round(f.referee.overRate * 100)}% overs across ${f.referee.gamesCalled} games)`);
  }

  // Next Gen Stats player efficiency (lib/factors/nextgenstats.js) — real tracking-data numbers isolating a
  // player's own skill (ball placement, explosiveness, separation) from his team's overall offensive numbers,
  // which the matchup/scoring-environment nudges above already cover. Each only ever fires for the position it
  // actually applies to (the compute functions themselves gate on position).
  if (f.ngsPassing?.available) {
    if (f.ngsPassing.cpoe >= NGS_CPOE_HOT) nudge(true, "ngs_cpoe_hot",
      `throwing well above expected accuracy (+${f.ngsPassing.cpoe.toFixed(1)} CPOE over his last ${f.ngsPassing.sampleGames})`);
    else if (f.ngsPassing.cpoe <= NGS_CPOE_COLD) nudge(true, "ngs_cpoe_cold",
      `throwing below expected accuracy (${f.ngsPassing.cpoe.toFixed(1)} CPOE over his last ${f.ngsPassing.sampleGames})`);
  }
  if (f.ngsRushing?.available) {
    if (f.ngsRushing.ryoePerAtt >= NGS_RYOE_HOT) nudge(true, "ngs_ryoe_hot",
      `gaining well beyond expected per carry (+${f.ngsRushing.ryoePerAtt.toFixed(2)} rush yards over expected/att)`);
    else if (f.ngsRushing.ryoePerAtt <= NGS_RYOE_COLD) nudge(true, "ngs_ryoe_cold",
      `running below expected per carry (${f.ngsRushing.ryoePerAtt.toFixed(2)} rush yards over expected/att)`);
  }
  if (f.ngsReceiving?.available && f.ngsReceiving.avgSeparation != null && f.ngsReceiving.avgSeparation >= NGS_SEPARATION_HOT) {
    nudge(true, "ngs_separation_hot", `consistently getting open (${f.ngsReceiving.avgSeparation.toFixed(1)} yards of separation at the catch point)`);
  }

  // Pass-protection/pressure matchup (lib/factors/pressure.js) — only meaningful for the passing game
  // (assemblePropFactors in factors/index.js already scopes this key to pass_yds/td_pass/rec_yds/receptions/
  // td_rec, so the PASS_PROPS check here is a second, cheap belt-and-suspenders gate, not the only one).
  if (f.pressure?.available && PASS_PROPS.has(f.propType)) {
    if (f.pressure.combinedPressureRisk >= ELEVATED_PRESSURE_THRESHOLD) nudge(true, "pressure_risk_penalty",
      `elevated pass-rush pressure risk this matchup (${Math.round(f.pressure.combinedPressureRisk * 100)}% combined sack+hit rate)`);
    else if (f.pressure.combinedPressureRisk <= CLEAN_POCKET_THRESHOLD) nudge(true, "clean_pocket_boost",
      `clean-pocket matchup this week (${Math.round(f.pressure.combinedPressureRisk * 100)}% combined sack+hit rate)`);
  }

  // Real ESPN Total QBR trend (lib/factors/qbr.js) — a QB-specific overall-efficiency read distinct from the
  // NGS CPOE nudge above (ball-placement accuracy specifically): QBR folds in scrambles, sacks, turnovers, and
  // game situation into one number, so a QB can trend hot on CPOE and neutral (or the reverse) on QBR — both
  // are real, different signals worth carrying separately rather than picking one.
  if (f.qbr?.available) {
    if (f.qbr.avgQbr >= QBR_ELITE_THRESHOLD) nudge(true, "qbr_trend_elite",
      `playing elite football by ESPN's own QBR (${f.qbr.avgQbr.toFixed(1)} over his last ${f.qbr.sampleGames})`);
    else if (f.qbr.avgQbr <= QBR_POOR_THRESHOLD) nudge(true, "qbr_trend_poor",
      `trending poorly by ESPN's own QBR (${f.qbr.avgQbr.toFixed(1)} over his last ${f.qbr.sampleGames})`);
  }

  // Market steam, scaled by how far the price has actually moved instead of a flat bump for any move at all — a
  // line that shortened 3 cents and one that shortened 40 cents were being treated identically before. 20 cents
  // of American-odds movement is treated as "one full unit" of steam (e.g. -110 -> -130), capped at 2x so one
  // outlier book/point-in-time spike can't dominate the whole estimate.
  if (f.marketMovement?.available && f.marketMovement.priceMove < 0) {
    const magnitude = Math.min(Math.abs(f.marketMovement.priceMove) / 20, 2);
    const weight = (coeffs.steam_move || 0) * magnitude;
    const label = `market steaming this way (${f.marketMovement.priceMove} pts)`;
    nudgeSum += weight;
    contributors.push(label);
    contributorDetails.push({ key: "steam_move", weight, label });
  }

  // Real cross-book stale-line value (lib/analyze.js's computeBestAcrossBooks, wired through as
  // f.staleLineValue) — a price that beats the panel by a real, corroborated margin because one specific book
  // hasn't caught up yet, not a shared data error (see analyze.js's own comment on how those two are told
  // apart). This used to stop at a cosmetic "stale value" badge on the Mispriced Bets tab; it never actually
  // moved `modelProb`, the number every ranking/parlay-tier decision is made on — a real, corroborated signal
  // sitting there unused. Scaled by edge size the same way steam_move is scaled by price movement, so a book
  // that's 9 points stale counts for more than one that's barely over the threshold, capped at 2x for the same
  // one-outlier-can't-dominate reason. Hand-set, not backtested: there's no historical multi-book odds archive
  // to replay "was this book's outlier price actually corroborated by the rest of the panel" against — the
  // same category of gap as steam_move itself (no historical odds-movement archive either).
  if (f.staleLineValue?.available && f.staleLineValue.edge > 0) {
    const magnitude = Math.min(f.staleLineValue.edge / 0.08, 2);
    const weight = (coeffs.stale_line_value || 0) * magnitude;
    const label = `real stale-line value vs. the rest of the book panel (+${(f.staleLineValue.edge * 100).toFixed(1)}pt edge)`;
    nudgeSum += weight;
    contributors.push(label);
    contributorDetails.push({ key: "stale_line_value", weight, label });
  }

  // Cap the TOTAL combined nudge contribution — not the market-anchored blend above, which already has its own
  // real shrinkage via marketPriorWeight — to NUDGE_CAP in log-odds space. Several kept coefficients are
  // explicitly flagged in lib/modelCoeffs.js's own comments as "likely shares credit with a correlated factor"
  // (real in the joint fit, but the independent z-test disagrees): matchup_edge, high_scoring_env, starter_change,
  // secondary_injury, front_seven_injury. These tend to co-fire on the same pick precisely because they measure
  // overlapping situations — a favorable matchup game is often also a high-scoring one; a beat-up opposing
  // defense often shows both secondary AND front-seven injuries at once. Adding every nudge's full weight with no
  // ceiling lets several correlated-but-individually-modest signals compound into a swing bigger than any of
  // them, or the joint fit that measured them, actually justifies — a real, checkable mechanism for exactly the
  // kind of overconfidence the live results ledger has been showing (see README's calibration section).
  // NUDGE_CAP=1.5 (sigmoid(logit(0.5)+1.5) ≈ 0.82) is a conservative starting ceiling: generous enough that a
  // genuinely strong, largely-uncorrelated multi-factor case (hot form + high snap share + red-zone share — none
  // of which are in the "shares credit" group above — sums to ~0.72 combined) passes through completely
  // untouched, but it stops five or six correlated factors from ever compounding past what's plausible. This
  // number is a reasoned starting point, not itself backtested — there's no historical archive of "how often did
  // N correlated nudges fire together" to calibrate it against the way individual coefficients are; revisit it
  // once scripts/refit-live-ledger.js (which tests against REAL market outcomes, not a proxy) has enough real
  // graded volume to compare capped vs. uncapped picks' actual hit rates directly.
  const NUDGE_CAP = 1.5;
  const cappedNudgeSum = Math.max(-NUDGE_CAP, Math.min(NUDGE_CAP, nudgeSum));
  const nudgeCapped = cappedNudgeSum !== nudgeSum;
  x += cappedNudgeSum;

  const modelProb = clipProb(sigmoid(x));
  return {
    available: true, modelProb, marketProb: clippedMarket, edge: +(modelProb - clippedMarket).toFixed(4),
    confidence: confidenceTier(effectiveN, f.defense?.available), effectiveN, blendedProb, contributors, contributorDetails,
    nudgeCapped, rawNudgeSum: +nudgeSum.toFixed(4)
  };
}
