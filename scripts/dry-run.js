// Runs the full pipeline against the demo dataset — no API keys needed. Confirms every factor category at
// least runs without throwing, and prints a self-check summary. Player-props only now — game lines/moneylines
// were removed from this build entirely (see analyze.js/probability.js/parlays.js/README).
import { runPipeline, buildEdgeBoardHistory } from "../lib/pipeline.js";
import { estimatePropProbability } from "../lib/probability.js";
import { MODEL_COEFFS } from "../lib/modelCoeffs.js";
import { gradeCompletedPicks, foldIntoLedger, summarizeLedger } from "../lib/grading.js";
import { buildRosterIndex, buildDepthChartIndex, resolvePlayer } from "../lib/identity.js";
import { findKeyTeammate, computeGameScript } from "../lib/factors/index.js";
import { computeOpposingFrontSevenInjury, computeInjuryEscalations } from "../lib/factors/injury.js";
import { computeTeammateOutTendency } from "../lib/factors/playerSplits.js";
import { computeRefereeFactor } from "../lib/factors/referee.js";
import { computeNgsPassing, computeNgsRushing, computeNgsReceiving, buildNgsIndex } from "../lib/factors/nextgenstats.js";
import { computePressureFactor } from "../lib/factors/pressure.js";
import { computeQbrTrend, buildQbrIndex, QBR_ELITE_THRESHOLD, QBR_POOR_THRESHOLD } from "../lib/factors/qbr.js";
import { computeBestAcrossBooks, extractGameContext } from "../lib/analyze.js";
import { buildDemoData } from "../lib/demoData.js";
import { fetchNFLEvents } from "../lib/fetchers/odds.js";
import { annotatePropsWithAI, annotateScoutingTakes, selectAiEligible, roundForHash, createSpendGuard, estimateCostUsd } from "../lib/ai.js";
import { classifyKickoffWindow, summarizeEvents, buildAllParlays, buildSameGameParlays, buildSlateParlays, RISK_TIERS, MIN_LEG_PROBABILITY, MEGA_TARGET_DECIMAL, MEGA_MIN_LEGS, NUKE_LEGS } from "../lib/parlays.js";
import { americanToDecimal } from "../lib/oddsMath.js";
import { buildTopPicks, pickTopReasons, pickBlurb, PICK_CATEGORIES } from "../lib/topPicks.js";

const SEASON = 2026;

const snapshot = await runPipeline({
  demo: true, currentSeason: SEASON, historySeasons: [SEASON, SEASON - 1, SEASON - 2],
  selectedWeek: 5, situationalNotes: [], aiOn: false, scoutOn: false
});

console.log("=== STATS ===");
console.log(JSON.stringify(snapshot.stats, null, 2));

console.log("\n=== SAMPLE PROP (full factor dump) ===");
console.log(JSON.stringify(snapshot.propRows[0], null, 2));

console.log("\n=== MISPRICED COUNT ===", snapshot.mispriced.length);
console.log("\n=== PARLAYS ===");
snapshot.parlays.forEach(p => console.log(`${p.tier.label} -> ${p.ok ? `${p.legs.length} legs, ${p.combinedAmerican}` : p.reason}`));

console.log("\n=== LOGS ===");
snapshot.logs.forEach(l => console.log(l.msg));

const factorKeys = Object.keys(snapshot.propRows[0].factors || {});
const expected = ["form", "tendency", "venue", "weatherHistorical", "weatherForecast", "birthday",
  "usage", "redZone", "twoMinute", "defense", "matchupEdge", "scoringEnvironment", "secondaryInjury", "schedule",
  "starterChange", "selfInjury", "oLineInjury", "practiceTrend", "marketMovement", "situationalNote",
  "referee", "ngsPassing", "ngsRushing", "ngsReceiving", "pressure", "qbr"];
const missing = expected.filter(k => !factorKeys.includes(k));

console.log("\n=== SELF-CHECK ===");
const anyMismatch = snapshot.propRows.some(r => r.teamMismatch);
const anyRealFactor = snapshot.propRows.some(r => Object.values(r.factors).some(f => f && (f.available || (Array.isArray(f) && f.length))));
const anyRedZone = snapshot.propRows.some(r => r.factors.redZone?.available);
const anyDefense = snapshot.propRows.some(r => r.factors.defense?.available);
const anyMatchupEdge = snapshot.propRows.some(r => r.factors.matchupEdge?.available);
const anyScoringEnv = snapshot.propRows.some(r => r.factors.scoringEnvironment?.available);

// Regression guard for the real bug caught on a live Rookie-tier refresh: SportsGameOdds publishes the
// combined "touchdowns" stat under two different market shapes at once — a real yes/no market and a broken
// synthetic over/under-0.5 duplicate whose book prices don't match its own fairOdds. classifyProp's betTypeID
// gate must keep only the yes/no ("yn") row and reject the "ou" duplicate outright.
const anytimeTdRows = snapshot.propRows.filter(r => r.propType === "td");
const anyAnytimeTd = anytimeTdRows.length > 0;
const anytimeTdKeptOnlyYesNo = anytimeTdRows.every(r => r.betTypeID === "yn");
console.log("Anytime TD (yes/no market) resolved at least once (should be true):", anyAnytimeTd);
console.log("The broken synthetic over/under duplicate of Anytime TD is excluded (should be true):", anytimeTdKeptOnlyYesNo, anytimeTdRows.map(r => r.betTypeID));

// Regression guard for the second live bug: a QB's own Anytime TD hit rate must only count him rushing/
// receiving for a score, never a touchdown pass he threw to someone else.
const mahomesTd = anytimeTdRows.find(r => r.player === "Patrick Mahomes");
const mahomesTdHitRateIsZero = mahomesTd ? mahomesTd.factors?.form?.rate_last3 === 0 : false;
console.log("QB's own Anytime TD hit rate excludes his passing TDs (should be true):", mahomesTdHitRateIsZero, mahomesTd?.factors?.form);

// Regression guard for the third live bug: a yardage/reception prop's "hit rate" must be graded against the
// bet's ACTUAL line, not "recorded any stat > 0" (which is nearly always true and was silently inflating every
// hit rate on the board). Demo Receiver's receiving yards over his last 3 demo weeks are 40, 78, 40 against a
// 59.5-yard line — exactly 1 of those 3 clears it, so rate_last3 must be 1/3, never 3/3.
const wrRecYdsRow = snapshot.propRows.find(r => r.propType === "rec_yds" && r.player === "Demo Receiver");
const recYdsRateIsCorrect = wrRecYdsRow ? Math.abs((wrRecYdsRow.factors?.form?.rate_last3 ?? -1) - (1 / 3)) < 0.001 : false;
console.log("Yardage prop hit rate is graded against the real line, not '> 0' (should be true):", recYdsRateIsCorrect, wrRecYdsRow?.line, wrRecYdsRow?.factors?.form);

// Regression guard for a real live bug (caught by Jon reading his own card): Passing/Rushing/Receiving TD props
// are real Over/Under markets with an actual posted line ("Passing TDs over 1.5"), not the same thing as
// Anytime TD's true yes/no "did it happen at all" market — thresholdFor in playerSplits.js used to lump all
// four TD-flavored prop types together and grade every one of them against a hardcoded 0 ("at least 1")
// regardless of the real line, so a QB posted at "over 1.5" who threw exactly 1 TD a given week was counted as
// having HIT that week. Mahomes's demo passing-TD line is 1.5; weeks 1-2 have him at exactly 1 TD (must be a
// miss) and weeks 3-7 at 2 TDs (a real hit) — this only passes if the threshold is really 1.5, not 0.
const mahomesPassTd = snapshot.propRows.find(r => r.propType === "td_pass" && r.player === "Patrick Mahomes");
const passTdForm = mahomesPassTd?.factors?.form;
const week1Game = passTdForm?.gameLog?.find(g => g.season === SEASON && g.week === 1);
const week3Game = passTdForm?.gameLog?.find(g => g.season === SEASON && g.week === 3);
const tdPropGradesAgainstRealLine = passTdForm?.line === 1.5 && week1Game?.statValue === 1 && week1Game?.hit === false &&
  week3Game?.statValue === 2 && week3Game?.hit === true;
console.log("Passing TDs prop is graded against its real 1.5 line, not a hardcoded 'at least 1' (should be true):", tdPropGradesAgainstRealLine, passTdForm?.line, week1Game, week3Game);

// Regression guard for the fourth live request: an ACCURATE, verifiable last-10-games breakdown, not just a
// trust-me percentage — and it must survive a season boundary. Demo Receiver has 5 current-season games plus
// 10 prior-season 999-yard marker games pushed into statRows AFTER them (matching how a real multi-season fetch
// concatenates). If buildGameLogIndex didn't sort chronologically, or computeFormFactor's last-10 window wasn't
// a real 10-game cap, this would silently pass anyway — so check the actual numbers, not just availability.
const form = wrRecYdsRow?.factors?.form;
const gameLog = form?.gameLog || [];
// Exactly 10 games, most recent first: all 5 current-season weeks (5 down to 1), then the 5 *newest* of the
// 10 prior-season marker games (weeks 10 down to 6) — the 5 oldest prior-season games (weeks 1-5) must be cut.
const expectedLast10 = [
  { season: SEASON, week: 5 }, { season: SEASON, week: 4 }, { season: SEASON, week: 3 },
  { season: SEASON, week: 2 }, { season: SEASON, week: 1 },
  { season: SEASON - 1, week: 10 }, { season: SEASON - 1, week: 9 }, { season: SEASON - 1, week: 8 },
  { season: SEASON - 1, week: 7 }, { season: SEASON - 1, week: 6 }
];
const last10ShapeIsCorrect = gameLog.length === 10 &&
  expectedLast10.every((e, i) => gameLog[i]?.season === e.season && gameLog[i]?.week === e.week);
// Last-3 must be purely current-season (weeks 3,4,5) — a year-old 999-yard marker game must never leak in just
// because it was pushed into statRows later than these rows. gameLog is most-recent-first, so "last 3" is its
// first 3 entries.
const last3Rows = gameLog.slice(0, 3);
const last3IsCurrentSeasonOnly = last3Rows.length === 3 && last3Rows.every(g => g.season === SEASON);
// rate_last10: 5 current-season hits at weeks 2,4 (40/78 alternating pattern, hit=w%2===0) = 2 hits, plus the
// 5 included prior-season marker games (999 yards, always a hit) = 7 of 10.
const rate10IsCorrect = form ? Math.abs((form.rate_last10 ?? -1) - 0.7) < 0.001 : false;
console.log("Last-10-games gameLog has the right games in the right order (should be true):", last10ShapeIsCorrect, gameLog.map(g => `${g.season}wk${g.week}`));
console.log("Last-3-games never crosses into a prior season (should be true):", last3IsCurrentSeasonOnly, last3Rows.map(g => `${g.season}wk${g.week}`));
console.log("Last-10 hit rate correctly caps at 10 games, not all games on record (should be true):", rate10IsCorrect, form?.rate_last10, form?.n_season);

// Regression guard for the newest live request: a starting QB's stats must never be explained by his own
// backup's presence/absence — the two never share the field while the starter is healthy, so "without him,
// numbers jump" is a data artifact, not a signal. Demo Backup Qb is a real, resolvable candidate on KC's roster
// (with his own thin game log) specifically so this proves findKeyTeammate is explicitly excluding QBs, not
// just failing to find anyone.
const mahomesTendencyIsSkipped = mahomesTd ? mahomesTd.factors?.tendency?.available === false : false;
console.log("QB prop rows never carry backup-QB 'teammate out' tendency talk (should be true):", mahomesTendencyIsSkipped, mahomesTd?.factors?.tendency);

// Regression guard for the newest live request: parlay tiers must offer real shuffle-able alternates, not just
// a single locked-in build per tier thrown together from whichever book scored highest.
const okTiers = snapshot.parlays.filter(p => p.ok);
const anyParlayHasAlternates = okTiers.some(p => (p.alternates || []).length >= 1);
console.log("At least one parlay tier offers a real shuffle alternate (should be true):", anyParlayHasAlternates, okTiers.map(p => `${p.tier.key}:${(p.alternates || []).length}`));

// Regression guard for widened book coverage: FanDuel is deliberately the best number on Mahomes's passing-TDs
// market in demoData, so this proves BOOKS/BOOK_IDS being widened past draftkings/espnbet actually flows through
// collectAutoPrices -> computeBestAcrossBooks, not just sitting unused in the payload. (mahomesPassTd itself is
// declared earlier, alongside the TD-prop-line regression test.)
const widerBookCoverageWorks = mahomesPassTd?.bestBook === "fanduel";
console.log("A non-DK/theScore-Bet book (FanDuel) can win best price now that more books are tracked (should be true):", widerBookCoverageWorks, mahomesPassTd?.bestBook, mahomesPassTd?.prices);

// Regression guard for the opposing-secondary-injury factor: BUF (this event's opponent for every KC player)
// has 2 demo CB/S injuries on record. Both a passing-yards prop and a receiving-yards prop against BUF should
// see it; a rushing prop never should (gated out entirely in factors/index.js).
const mahomesPassYds = snapshot.propRows.find(r => r.propType === "pass_yds" && r.player === "Patrick Mahomes");
const secondaryInjuryWorks = mahomesPassTd?.factors?.secondaryInjury?.available === true && mahomesPassTd.factors.secondaryInjury.count === 2 &&
  wrRecYdsRow?.factors?.secondaryInjury?.available === true && wrRecYdsRow.factors.secondaryInjury.count === 2;
console.log("Opposing-secondary-injury factor resolves for passing/receiving props (should be true):", secondaryInjuryWorks, mahomesPassTd?.factors?.secondaryInjury, wrRecYdsRow?.factors?.secondaryInjury);

// Regression guard for generalizing the venue split to the real per-prop stat: before this fix, computeVenueSplit
// always measured (receiving+rushing yards) regardless of prop, so a QB's indoor/outdoor split on a passing-yards
// prop was measuring the wrong stat entirely (near-zero either way). Mahomes's demo dome games (weeks 1-4, avg
// 245 passing yards) vs. his outdoor games (weeks 5-7, avg 330) should show a real, correctly-labeled gap now.
const mahomesVenue = mahomesPassYds?.factors?.venue;
const venueSplitIsRealStat = mahomesVenue?.available === true && mahomesVenue.statLabel === "passing yards" &&
  mahomesVenue.outdoorN >= 2 && mahomesVenue.domeN >= 2 && mahomesVenue.outdoorAvg > mahomesVenue.domeAvg + 50;
console.log("Venue split uses the real per-prop stat, not always receiving+rushing yards (should be true):", venueSplitIsRealStat, mahomesVenue);

// New regression guard, from wiring the venue split into an actual scored nudge (lib/probability.js): this
// week's real game (week 5, KC @ BUF) is outdoors, and Mahomes's outdoor passing-yards average already beats
// his dome average (the split above) — so the venue_edge nudge should actually fire on his passing-yards row,
// not just sit computed-but-unused the way it did before this rebuild.
const venueNudgeFiresOnRealRow = (mahomesPassYds?.modelContributors || []).some(c => /performs better outdoors/.test(c));
console.log("Venue-vs-roof nudge actually fires on a real prop row when the split and this week's roof agree (should be true):", venueNudgeFiresOnRealRow, mahomesPassYds?.modelContributors);

// Regression guard for the name-format bug scripts/backtest.js caught: nflverse's play-by-play spells names
// "X.Surname" ("D.Receiver"), never the full "Demo Receiver" every other source uses. Before identity.js's
// pbpShortKey/shortForm fix, computePlayerRedZoneShare compared the two directly and never matched anyone,
// silently returning a real-looking but always-~0 share. Demo Receiver has 10 team red-zone plays on record,
// 10 of them his own touches (6 explicit rushes + 4 default-receiver filler plays) — a real share, not a
// coincidental one, so this only passes if the short-form match actually works.
const wrRedZone = wrRecYdsRow?.factors?.redZone;
const redZoneShareIsReal = wrRedZone?.available === true && (wrRedZone.redZoneShare ?? 0) > 0.5;
console.log("Red-zone share resolves a real, nonzero share via short-form PBP name matching (should be true):", redZoneShareIsReal, wrRedZone);

// --- Probability model (lib/probability.js) ---
// Regression guard for the point-score -> real-probability rework: every prop with a usable market number gets
// a modelProb in [0,1], and trueEdge is exactly modelProb - marketProb, not some other derived quantity.
const propsWithModel = snapshot.propRows.filter(r => r.model?.available);
const modelShapeIsSane = propsWithModel.length > 0 && propsWithModel.every(r =>
  r.modelProb >= 0 && r.modelProb <= 1 && Math.abs(r.trueEdge - (r.modelProb - r.marketProb)) < 0.0001 &&
  ["low", "medium", "high", "excluded"].includes(r.confidence));
console.log("Every prop with a market number gets a sane modelProb/trueEdge/confidence (should be true):", modelShapeIsSane, propsWithModel.length);

// A hard override (player out/doubtful) must collapse the estimate near 0 regardless of how favorable every
// other factor looks — no amount of context should make a bet on a player who might not play a good one. This
// mirrors the old computeMispricedScore's -60 kill switch, just expressed as a probability instead of a point
// penalty.
const outOverrideResult = estimatePropProbability(
  { selfInjury: { status: "Out" }, form: { available: true, n_last10: 10, rate_last10: 0.9, n_vsOpp: 3, rate_vsOpp: 0.9 } }, 0.55
);
const outOverrideWorks = outOverrideResult.available && outOverrideResult.modelProb <= 0.05 && outOverrideResult.confidence === "excluded";
console.log("Self-injury OUT/doubtful hard-overrides the model near zero regardless of other factors (should be true):", outOverrideWorks, outOverrideResult);

// A thin sample (a hot streak on just 2 games) must barely move the estimate away from the market's own
// number — the whole point of anchoring to the market instead of building a probability from scratch. This is
// what replaces the old system's flat +7-for-clearing-a-threshold bonus, which gave a 2-game fluke the exact
// same weight as a real, deep trend.
const thinSampleResult = estimatePropProbability({ form: { available: true, n_last10: 2, rate_last10: 1.0, n_vsOpp: 0, rate_vsOpp: 0 } }, 0.50);
const deepSampleResult = estimatePropProbability({ form: { available: true, n_last10: 10, rate_last10: 0.9, n_vsOpp: 3, rate_vsOpp: 0.9 } }, 0.50);
const thinSampleStaysNearMarket = thinSampleResult.available && Math.abs(thinSampleResult.edge) < 0.08 && thinSampleResult.confidence === "low";
const deepSampleMovesFurther = deepSampleResult.available && deepSampleResult.edge > thinSampleResult.edge;
console.log("A 2-game hot streak barely moves off the market number and is flagged low-confidence (should be true):", thinSampleStaysNearMarket, thinSampleResult);
console.log("A real 10+3-game trend moves the estimate further than a 2-game fluke (should be true):", deepSampleMovesFurther, deepSampleResult.edge, thinSampleResult.edge);

// --- New factor nudges (lib/probability.js) — unit-tested directly with synthetic factors, since the demo
// pipeline can't exercise weather (gated `!demo`) or practice trend (injuryHistory stays [] in demo mode). ---
const baseline = estimatePropProbability({ form: { available: true, n_last10: 5, rate_last10: 0.5, n_vsOpp: 0, rate_vsOpp: 0 } }, 0.55).modelProb;

// Weather: personal history wins when there's enough of it (2+ real wet games), even when it points the
// OPPOSITE way from the generic positional read — a rushing prop whose own player actually does WORSE in bad
// weather must get penalized, not boosted just because he's a runner.
const weatherPersonalBoost = estimatePropProbability({
  propType: "rush_yds", weatherForecast: { precipProb: 70, windMph: 5 },
  weatherHistorical: { available: true, wetN: 3, wetAvg: 90, dryAvg: 60 },
  form: { available: true, n_last10: 5, rate_last10: 0.5, n_vsOpp: 0, rate_vsOpp: 0 }
}, 0.55);
const weatherPersonalPenalty = estimatePropProbability({
  propType: "rush_yds", weatherForecast: { precipProb: 70, windMph: 5 },
  weatherHistorical: { available: true, wetN: 3, wetAvg: 40, dryAvg: 60 },
  form: { available: true, n_last10: 5, rate_last10: 0.5, n_vsOpp: 0, rate_vsOpp: 0 }
}, 0.55);
const weatherRunFavor = estimatePropProbability({
  propType: "rush_yds", weatherForecast: { precipProb: 70, windMph: 5 },
  form: { available: true, n_last10: 5, rate_last10: 0.5, n_vsOpp: 0, rate_vsOpp: 0 }
}, 0.55);
const weatherPassPenalty = estimatePropProbability({
  propType: "pass_yds", weatherForecast: { precipProb: 70, windMph: 5 },
  form: { available: true, n_last10: 5, rate_last10: 0.5, n_vsOpp: 0, rate_vsOpp: 0 }
}, 0.55);
const goodWeatherNoNudge = estimatePropProbability({
  propType: "pass_yds", weatherForecast: { precipProb: 10, windMph: 3 },
  form: { available: true, n_last10: 5, rate_last10: 0.5, n_vsOpp: 0, rate_vsOpp: 0 }
}, 0.55);
const weatherNudgesWork = weatherPersonalBoost.modelProb > baseline && weatherPersonalPenalty.modelProb < baseline &&
  weatherRunFavor.modelProb > baseline && weatherPassPenalty.modelProb < baseline &&
  Math.abs(goodWeatherNoNudge.modelProb - baseline) < 0.0001 &&
  weatherPersonalBoost.contributors.some(c => /personal history/.test(c)) &&
  weatherRunFavor.contributors.some(c => /favors the run/.test(c)) &&
  weatherPassPenalty.contributors.some(c => /against the passing/.test(c));
console.log("Weather nudge: personal history wins when available, else falls back to the positional read, and never fires in good weather (should be true):", weatherNudgesWork,
  { baseline, boost: weatherPersonalBoost.modelProb, penalty: weatherPersonalPenalty.modelProb, runFavor: weatherRunFavor.modelProb, passPenalty: weatherPassPenalty.modelProb, goodWeather: goodWeatherNoNudge.modelProb });

// Venue: only fires when the split is real (2+ games each way) AND cross-referenced against THIS week's actual
// roof — a QB who's better in a dome gets no boost from that history in an outdoor game.
const venueMatch = estimatePropProbability({
  propType: "pass_yds", roof: "dome", venue: { available: true, domeN: 4, outdoorN: 3, domeAvg: 300, outdoorAvg: 220 },
  form: { available: true, n_last10: 5, rate_last10: 0.5, n_vsOpp: 0, rate_vsOpp: 0 }
}, 0.55);
const venueMismatch = estimatePropProbability({
  propType: "pass_yds", roof: "outdoors", venue: { available: true, domeN: 4, outdoorN: 3, domeAvg: 300, outdoorAvg: 220 },
  form: { available: true, n_last10: 5, rate_last10: 0.5, n_vsOpp: 0, rate_vsOpp: 0 }
}, 0.55);
const venueThinSample = estimatePropProbability({
  propType: "pass_yds", roof: "dome", venue: { available: true, domeN: 1, outdoorN: 1, domeAvg: 300, outdoorAvg: 220 },
  form: { available: true, n_last10: 5, rate_last10: 0.5, n_vsOpp: 0, rate_vsOpp: 0 }
}, 0.55);
const venueNudgeWorks = venueMatch.modelProb > baseline && Math.abs(venueMismatch.modelProb - baseline) < 0.0001 &&
  Math.abs(venueThinSample.modelProb - baseline) < 0.0001;
console.log("Venue nudge only fires when the split is real AND matches this week's actual roof (should be true):", venueNudgeWorks,
  { baseline, match: venueMatch.modelProb, mismatch: venueMismatch.modelProb, thinSample: venueThinSample.modelProb });

// Practice trend: direction matters, not just availability — worsening penalizes, improving helps, no real
// change (or an unrecognized status string) does nothing.
const trendDown = estimatePropProbability({ practiceTrend: { available: true, first: "Full", current: "Did Not Participate", trend: "Full -> DNP" }, form: { available: true, n_last10: 5, rate_last10: 0.5, n_vsOpp: 0, rate_vsOpp: 0 } }, 0.55);
const trendUp = estimatePropProbability({ practiceTrend: { available: true, first: "Did Not Participate", current: "Full", trend: "DNP -> Full" }, form: { available: true, n_last10: 5, rate_last10: 0.5, n_vsOpp: 0, rate_vsOpp: 0 } }, 0.55);
const trendFlat = estimatePropProbability({ practiceTrend: { available: true, first: "Limited", current: "Limited", trend: "no change" }, form: { available: true, n_last10: 5, rate_last10: 0.5, n_vsOpp: 0, rate_vsOpp: 0 } }, 0.55);
const practiceTrendWorks = trendDown.modelProb < baseline && trendUp.modelProb > baseline && Math.abs(trendFlat.modelProb - baseline) < 0.0001;
console.log("Practice-trend nudge scores direction (worsening penalizes, improving helps, flat does nothing) (should be true):", practiceTrendWorks,
  { baseline, down: trendDown.modelProb, up: trendUp.modelProb, flat: trendFlat.modelProb });

// Market steam: scaled by magnitude now, not a flat bump for any move at all — a bigger shortening must move the
// estimate further than a small one, and the scaling must actually cap out (not blow up) on an extreme move.
const steamSmall = estimatePropProbability({ marketMovement: { available: true, priceMove: -5 }, form: { available: true, n_last10: 5, rate_last10: 0.5, n_vsOpp: 0, rate_vsOpp: 0 } }, 0.55);
const steamBig = estimatePropProbability({ marketMovement: { available: true, priceMove: -20 }, form: { available: true, n_last10: 5, rate_last10: 0.5, n_vsOpp: 0, rate_vsOpp: 0 } }, 0.55);
const steamExtreme = estimatePropProbability({ marketMovement: { available: true, priceMove: -400 }, form: { available: true, n_last10: 5, rate_last10: 0.5, n_vsOpp: 0, rate_vsOpp: 0 } }, 0.55);
const steamCapMatch = estimatePropProbability({ marketMovement: { available: true, priceMove: -40 }, form: { available: true, n_last10: 5, rate_last10: 0.5, n_vsOpp: 0, rate_vsOpp: 0 } }, 0.55);
const steamMagnitudeScalingWorks = steamSmall.modelProb > baseline && steamBig.modelProb > steamSmall.modelProb &&
  Math.abs(steamExtreme.modelProb - steamCapMatch.modelProb) < 0.0001; // both past the 2x cap -> identical result
console.log("Market steam is scaled by magnitude and caps out rather than blowing up on an extreme move (should be true):", steamMagnitudeScalingWorks,
  { baseline, small: steamSmall.modelProb, big: steamBig.modelProb, extreme: steamExtreme.modelProb, capMatch: steamCapMatch.modelProb });

// --- Opposing front-seven injury (lib/factors/injury.js, run-game mirror of secondary_injury) ---
// The raw factor function must count only real DL/LB-family positions that are actually out/doubtful — a CB/S
// (secondary, already covered by its own factor) shouldn't count, and "Questionable" isn't the same as being
// realistically out.
const frontSevenInjuries = {
  BUF: [
    { name: "Demo Bills Corner", position: "CB", status: "Out" }, // secondary, not front seven
    { name: "Demo Bills Edge", position: "EDGE", status: "Out" },
    { name: "Demo Bills Lb", position: "LB", status: "Doubtful" },
    { name: "Demo Bills Dt", position: "DT", status: "Questionable" } // questionable doesn't count as out
  ]
};
const frontSevenResult = computeOpposingFrontSevenInjury("BUF", frontSevenInjuries);
const frontSevenInjuryFactorWorks = frontSevenResult.available === true && frontSevenResult.count === 2 &&
  frontSevenResult.names.some(n => /Edge/.test(n)) && frontSevenResult.names.some(n => /Lb/.test(n)) &&
  !frontSevenResult.names.some(n => /Corner|Dt/.test(n));
console.log("Opposing front-seven-injury factor counts only real DL/LB out/doubtful players, not CB/S or questionable ones (should be true):", frontSevenInjuryFactorWorks, frontSevenResult);

const frontSevenNudge = estimatePropProbability({
  propType: "rush_yds", frontSevenInjury: { available: true, count: 1 },
  form: { available: true, n_last10: 5, rate_last10: 0.5, n_vsOpp: 0, rate_vsOpp: 0 }
}, 0.55);
const frontSevenNudgeFires = frontSevenNudge.modelProb > baseline && frontSevenNudge.contributors.some(c => /front seven hurt/.test(c));
console.log("Front-seven-injury nudge fires on a rushing prop when the opponent has a real DL/LB injury on record (should be true):", frontSevenNudgeFires, { baseline, nudge: frontSevenNudge.modelProb });

// --- Vegas game-script context (lib/analyze.js's extractGameContext, lib/factors/index.js's computeGameScript) ---
// A game with a real spread/total (read via SportsGameOdds' own oddID shape: points-home-game-sp-home for the
// spread, points-all-game-ou-over for the total) resolves to correct per-team implied totals, and a spread past
// BIG_SPREAD_THRESHOLD flags the right side as a big favorite/big underdog.
const gameScriptEvt = {
  odds: {
    homeSpread: { periodID: "game", statID: "points", statEntityID: "home", betTypeID: "sp", sideID: "home", bookSpread: -7.5 },
    gameTotal: { periodID: "game", statID: "points", statEntityID: "all", betTypeID: "ou", sideID: "over", bookOverUnder: 44.5 }
  }
};
const gameContext = extractGameContext(gameScriptEvt);
const gameContextIsCorrect = gameContext.available === true && gameContext.homeSpread === -7.5 && gameContext.total === 44.5 &&
  Math.abs(gameContext.homeImpliedTotal - 26) < 0.001 && Math.abs(gameContext.awayImpliedTotal - 18.5) < 0.001;
console.log("extractGameContext reads a real spread/total into correct per-team implied totals (should be true):", gameContextIsCorrect, gameContext);

const noOddsContextWorks = extractGameContext({ odds: {} }).available === false;
console.log("extractGameContext reports unavailable with no spread/total odds present (should be true):", noOddsContextWorks);

// Regression guard for a real live incident: SportsGameOdds' actual payload returns bookSpread/bookOverUnder as
// STRINGS (e.g. "+8.5"), never JS numbers — the fixture above used numeric literals, which is exactly how this
// slipped past dry-run and only broke on a live refresh ("f.gameScript.teamSpread.toFixed is not a function").
// Specifically the HOME team's own row: computeGameScript passes homeSpread straight through with no coercion
// for isHome (`teamSpread = gameContext.homeSpread`), unlike the away side, where the unary minus
// (`-gameContext.homeSpread`) happens to coerce a string to a number as a side effect and masks the bug — so
// this fixture deliberately makes the HOME team (KC) the big underdog, the exact path that actually crashed.
// Comparisons like <=/>= silently coerce a string fine, so computeGameScript's isBigUnderdog flag looked correct
// even without the fix; only calling .toFixed() on the still-string value in lib/probability.js's nudge text
// actually threw. extractGameContext must coerce to a real Number so nothing downstream can hit this again.
const stringPayloadContext = extractGameContext({
  odds: {
    // Home team (KC) is getting +8.5 -> KC (home) is the big underdog, the uncoerced-string code path.
    homeSpread: { periodID: "game", statID: "points", statEntityID: "home", betTypeID: "sp", sideID: "home", bookSpread: "+8.5" },
    gameTotal: { periodID: "game", statID: "points", statEntityID: "all", betTypeID: "ou", sideID: "over", bookOverUnder: "44.5" }
  }
});
const stringGameScript = computeGameScript({ team: "KC", home: "KC", away: "BUF" }, stringPayloadContext);
let stringPayloadNudgeWorks = false, stringPayloadNudgeText = null;
try {
  const nudgeResult = estimatePropProbability({
    propType: "rec_yds", gameScript: stringGameScript,
    form: { available: true, n_last10: 5, rate_last10: 0.5, n_vsOpp: 0, rate_vsOpp: 0 }
  }, 0.55);
  stringPayloadNudgeText = nudgeResult.contributors.find(c => /game script read/.test(c));
  stringPayloadNudgeWorks = typeof stringPayloadContext.homeSpread === "number" && !isNaN(stringPayloadContext.homeSpread) &&
    stringGameScript.isBigUnderdog === true && !!stringPayloadNudgeText;
} catch (e) {
  stringPayloadNudgeText = `THREW: ${e.message}`;
}
console.log("A string-typed spread/total from the real odds payload is coerced to a real number and never crashes the game-script nudge (should be true):", stringPayloadNudgeWorks, stringPayloadContext.homeSpread, typeof stringPayloadContext.homeSpread, stringPayloadNudgeText);

const homeRow = { team: "KC", home: "KC", away: "BUF" }; // home team getting a -7.5 spread -> big favorite
const awayRow = { team: "BUF", home: "KC", away: "BUF" }; // away team getting a +7.5 spread -> big underdog
const gameScriptHome = computeGameScript(homeRow, gameContext);
const gameScriptAway = computeGameScript(awayRow, gameContext);
const gameScriptWorks = gameScriptHome.available && gameScriptHome.isBigFavorite === true && gameScriptHome.isBigUnderdog === false &&
  Math.abs(gameScriptHome.teamSpread - (-7.5)) < 0.001 &&
  gameScriptAway.available && gameScriptAway.isBigUnderdog === true && gameScriptAway.isBigFavorite === false &&
  Math.abs(gameScriptAway.teamSpread - 7.5) < 0.001 &&
  computeGameScript({ team: "MIA", home: "KC", away: "BUF" }, gameContext).available === false;
console.log("computeGameScript flags the home team as a big favorite and the away team as a big underdog off the same spread, and skips a row belonging to neither team (should be true):", gameScriptWorks, { home: gameScriptHome, away: gameScriptAway });

// The nudges themselves (lib/probability.js), checked against MODEL_COEFFS's real, currently-backtested values —
// NOT the original hand-set intuition. Real walk-forward backtesting (scripts/backtest.js) found
// game_script_run_favor has no statistically real effect (pruned to exactly 0 — a big favorite's rushing prop
// does NOT reliably move) while game_script_pass_favor has a real effect in the OPPOSITE direction of the
// original "garbage-time volume helps" intuition (a real, negative coefficient). So the correct real-world
// expectation is: the run nudge fires (the code path executes, contributors mentions it) but genuinely doesn't
// move the estimate at all; the pass nudge fires and genuinely moves the estimate DOWN, not up; and neither
// fires on a normal, non-lopsided spread. This test intentionally tracks whatever MODEL_COEFFS currently says,
// since that's the actual live behavior — if a future backtest re-measures either coefficient as significant and
// positive again, this test's direction should be revisited to match, not hand-reverted.
const gameScriptRunNudge = estimatePropProbability({ propType: "rush_yds", gameScript: gameScriptHome, form: { available: true, n_last10: 5, rate_last10: 0.5, n_vsOpp: 0, rate_vsOpp: 0 } }, 0.55);
const gameScriptPassNudge = estimatePropProbability({ propType: "rec_yds", gameScript: gameScriptAway, form: { available: true, n_last10: 5, rate_last10: 0.5, n_vsOpp: 0, rate_vsOpp: 0 } }, 0.55);
const closeSpreadContext = computeGameScript(homeRow, { available: true, homeSpread: -3, total: 44.5, homeImpliedTotal: 23.75, awayImpliedTotal: 20.75 });
const gameScriptNoFireOnCloseSpread = estimatePropProbability({ propType: "rush_yds", gameScript: closeSpreadContext, form: { available: true, n_last10: 5, rate_last10: 0.5, n_vsOpp: 0, rate_vsOpp: 0 } }, 0.55);
const expectRunDirection = MODEL_COEFFS.game_script_run_favor > 0 ? "up" : MODEL_COEFFS.game_script_run_favor < 0 ? "down" : "flat";
const expectPassDirection = MODEL_COEFFS.game_script_pass_favor > 0 ? "up" : MODEL_COEFFS.game_script_pass_favor < 0 ? "down" : "flat";
const matchesDirection = (v, base, dir) => dir === "up" ? v > base : dir === "down" ? v < base : Math.abs(v - base) < 0.0001;
const gameScriptNudgesWork = matchesDirection(gameScriptRunNudge.modelProb, baseline, expectRunDirection) &&
  matchesDirection(gameScriptPassNudge.modelProb, baseline, expectPassDirection) &&
  Math.abs(gameScriptNoFireOnCloseSpread.modelProb - baseline) < 0.0001 &&
  gameScriptRunNudge.contributors.some(c => /game script read/.test(c)) &&
  gameScriptPassNudge.contributors.some(c => /game script read/.test(c));
console.log(`Game-script nudge moves each estimate in whatever direction MODEL_COEFFS' real backtested values currently say (run: ${expectRunDirection}, pass: ${expectPassDirection}), fires with a neutral non-directional label either way, and stays silent on a close spread (should be true):`, gameScriptNudgesWork,
  { baseline, run: gameScriptRunNudge.modelProb, pass: gameScriptPassNudge.modelProb, close: gameScriptNoFireOnCloseSpread.modelProb });

// --- Suspect vs. stale-line value (lib/analyze.js) ---
// A big outlier edge with real corroboration from the rest of the panel (>=2 other books, most agreeing with
// consensus) is real, bettable stale-line value — surfaced, not thrown away. The same size outlier with NO real
// corroboration (every other book also disagrees, or too few other books exist to tell) stays `suspect` and gets
// excluded, on the theory that a shared data problem can affect more than one book.
const refProb = 0.55;
const staleValueRow = { prices: { draftkings: 250, fanduel: -122, betmgm: -125, caesars: -128, espnbet: -120 } }; // draftkings is the lone stale outlier; the other 4 tightly agree with refProb
const staleValueResult = computeBestAcrossBooks(staleValueRow, refProb);
const suspectRow = { prices: { draftkings: 250, fanduel: 180, betmgm: -125 } }; // fanduel also disagrees wildly -> no real corroboration
const suspectResult = computeBestAcrossBooks(suspectRow, refProb);
const staleVsSuspectWorks = staleValueResult.staleValue === true && staleValueResult.suspect === false &&
  suspectResult.suspect === true && suspectResult.staleValue === false;
console.log("A corroborated outlier is flagged staleValue (surfaced), an uncorroborated one stays suspect (excluded) (should be true):", staleVsSuspectWorks, staleValueResult, suspectResult);

// Regression guard for the real live prop-row wiring: analyzePlayerProps must actually set row.suspect/
// row.staleValue from computeBestAcrossBooks, not just compute-and-discard them.
const anySuspectOrStaleFieldPresent = snapshot.propRows.every(r => typeof r.suspect === "boolean" && typeof r.staleValue === "boolean");
console.log("Every prop row carries real suspect/staleValue boolean fields (should be true):", anySuspectOrStaleFieldPresent);

// Regression guard: Mispriced Bets must be ranked by real statistical edge (model vs. market probability), not
// the old flat point score — and every entry must actually clear the real minimum edge and confidence bar.
const mispricedSortedByTrueEdge = snapshot.mispriced.every((r, i) => i === 0 || snapshot.mispriced[i - 1].trueEdge >= r.trueEdge);
const mispricedAllClearBar = snapshot.mispriced.every(r => r.trueEdge > 0.03 && ["medium", "high"].includes(r.confidence));
console.log("Mispriced Bets is sorted by real trueEdge, highest first (should be true):", mispricedSortedByTrueEdge, snapshot.mispriced.map(r => r.trueEdge));
console.log("Every Mispriced Bets entry clears the real edge + confidence bar (should be true):", mispricedAllClearBar);

// --- Results ledger (lib/grading.js) — unit-tested directly since demo mode has no Blobs store to round-trip through ---
const now = new Date("2026-10-10T12:00:00Z");
const syntheticGameLog = new Map([["demo grader", [{ season: 2026, week: 5, receiving_yards: 90, receptions: 6 }]]]);
const syntheticPicks = [
  { oddID: "hit-1", kind: "prop", player: "Demo Grader", playerKey: "demo grader", propType: "rec_yds", line: 59.5, side: "over",
    kickoff: "2026-10-05T17:00:00Z", season: 2026, week: 5, modelProb: 0.65, marketProb: 0.52, edge: 0.13, confidence: "high",
    pickPrice: -120, pickBook: "draftkings", closingPrice: null, closingBook: null, clv: null,
    graded: false, hit: null, actualValue: null, gradedAt: null },
  { oddID: "miss-1", kind: "prop", player: "Demo Grader", playerKey: "demo grader", propType: "receptions", line: 7.5, side: "over",
    kickoff: "2026-10-05T17:00:00Z", season: 2026, week: 5, modelProb: 0.58, marketProb: 0.50, edge: 0.08, confidence: "medium",
    pickPrice: -110, pickBook: "draftkings", closingPrice: null, closingBook: null, clv: null,
    graded: false, hit: null, actualValue: null, gradedAt: null },
  { oddID: "too-soon-1", kind: "prop", player: "Demo Grader", playerKey: "demo grader", propType: "rec_yds", line: 59.5, side: "over",
    kickoff: "2026-10-10T06:00:00Z", season: 2026, week: 5, modelProb: 0.6, marketProb: 0.5, edge: 0.1, confidence: "medium",
    pickPrice: -115, pickBook: "draftkings", closingPrice: null, closingBook: null, clv: null,
    graded: false, hit: null, actualValue: null, gradedAt: null }
];
// CLV fixture: "hit-1" was picked at -120 (54.5% implied) and the price on record moved to -140 (58.3% implied)
// by the time this grades — real positive closing-line value, independent of whether the pick itself hit.
// "miss-1" shares an oddID with no price-history entry at all, so its CLV must stay null, not silently 0.
const syntheticPriceHistory = { "hit-1|draftkings": [{ t: "2026-10-01T00:00:00Z", price: -120 }, { t: "2026-10-04T00:00:00Z", price: -140 }] };
const gradedNow = gradeCompletedPicks(syntheticPicks, syntheticGameLog, syntheticPriceHistory, now);
const gradingWorks = gradedNow.length === 2 && // the too-soon pick (kicked off 6h before `now`, under the 20h delay) must stay ungraded
  syntheticPicks.find(p => p.oddID === "hit-1")?.hit === true && syntheticPicks.find(p => p.oddID === "hit-1")?.actualValue === 90 &&
  syntheticPicks.find(p => p.oddID === "miss-1")?.hit === false &&
  syntheticPicks.find(p => p.oddID === "too-soon-1")?.graded !== true;
console.log("Grading correctly marks a real hit and a real miss, and leaves a too-recent game ungraded (should be true):", gradingWorks, syntheticPicks);

const hitPick = syntheticPicks.find(p => p.oddID === "hit-1");
const missPick = syntheticPicks.find(p => p.oddID === "miss-1");
const clvWorks = hitPick?.closingPrice === -140 && hitPick?.closingBook === "draftkings" &&
  Math.abs(hitPick.clv - (140 / 240 - 120 / 220)) < 0.001 && // americanToImpliedProb(-140) - americanToImpliedProb(-120)
  hitPick.clv > 0 && missPick?.clv === null && missPick?.closingPrice === null;
console.log("CLV computes from the captured pick price vs. the last known price on record, and stays null with no history (should be true):", clvWorks, hitPick?.clv, hitPick?.closingPrice, missPick?.clv);

const ledger = {};
foldIntoLedger(ledger, gradedNow);
const summary = summarizeLedger(ledger);
const ledgerMathIsCorrect = summary.hasData && summary.totals.attempts === 2 && summary.totals.hits === 1 &&
  Math.abs(summary.totals.hitRate - 0.5) < 0.0001 && summary.byConfidence.high?.attempts === 1 && summary.byConfidence.medium?.attempts === 1;
console.log("Calibration ledger folds graded picks into correct totals + confidence buckets (should be true):", ledgerMathIsCorrect, summary);
// CLV should fold only from the one graded pick that actually has a closing price (hit-1) — miss-1's null CLV
// must not corrupt the average or be miscounted as a real zero.
const ledgerClvIsCorrect = summary.totals.clvCount === 1 && summary.totals.avgClv != null && Math.abs(summary.totals.avgClv - hitPick.clv) < 0.001;
console.log("Calibration ledger folds CLV only from picks that actually have one on record (should be true):", ledgerClvIsCorrect, summary.totals);
// Re-folding the same graded picks a second time must never happen in the live pipeline (gradeCompletedPicks
// skips anything already marked graded) — proving that guard actually holds, since a double-fold would silently
// double-count every historical result.
const regradedNow = gradeCompletedPicks(syntheticPicks, syntheticGameLog, syntheticPriceHistory, now);
const regradeGuardWorks = regradedNow.length === 0;
console.log("Already-graded picks are never re-graded on a later pass (should be true):", regradeGuardWorks);

// --- Edge Board history (lib/pipeline.js's buildEdgeBoardHistory) ---
// Only picks that were actually flagged as an Edge Board pick the moment they were first surfaced (the
// "capture-once" `wasEdgeBoard` field, never overwritten on later refreshes) AND have since graded count toward
// the history — a pick that never qualified, or one that qualified but hasn't kicked off/graded yet, must not
// show up as a phantom hit or a premature miss. Sorted most-recent-kickoff-first.
const edgeBoardFixture = [
  { oddID: "eb-hit", wasEdgeBoard: true, graded: true, hit: true, kickoff: "2026-10-05T17:00:00Z" },
  { oddID: "eb-miss", wasEdgeBoard: true, graded: true, hit: false, kickoff: "2026-10-12T17:00:00Z" },
  { oddID: "eb-ungraded", wasEdgeBoard: true, graded: false, hit: null, kickoff: "2026-10-19T17:00:00Z" }, // not final yet -> excluded
  { oddID: "not-eb", wasEdgeBoard: false, graded: true, hit: true, kickoff: "2026-10-12T18:00:00Z" } // never flagged as an edge -> excluded
];
const edgeBoardHistoryResult = buildEdgeBoardHistory(edgeBoardFixture);
const edgeBoardHistoryWorks = edgeBoardHistoryResult.total === 2 && edgeBoardHistoryResult.hits === 1 &&
  edgeBoardHistoryResult.picks.length === 2 && edgeBoardHistoryResult.picks[0].oddID === "eb-miss" && // most recent kickoff first
  edgeBoardHistoryResult.picks[1].oddID === "eb-hit" &&
  !edgeBoardHistoryResult.picks.some(p => p.oddID === "eb-ungraded" || p.oddID === "not-eb");
console.log("buildEdgeBoardHistory only counts graded, actually-flagged Edge Board picks, sorted most-recent-first (should be true):", edgeBoardHistoryWorks, edgeBoardHistoryResult);

// The `limit` param must actually cap the returned list to the most recent N, not just be decorative.
const manyEdgeBoardPicks = Array.from({ length: 10 }, (_, i) => ({
  oddID: `eb-${i}`, wasEdgeBoard: true, graded: true, hit: i % 2 === 0, kickoff: new Date(2026, 9, i + 1).toISOString()
}));
const limitedHistory = buildEdgeBoardHistory(manyEdgeBoardPicks, 3);
const edgeBoardLimitWorks = limitedHistory.picks.length === 3 && limitedHistory.total === 3 && limitedHistory.picks[0].oddID === "eb-9";
console.log("buildEdgeBoardHistory's limit caps the returned list to the most recent N picks (should be true):", edgeBoardLimitWorks, limitedHistory.picks.map(p => p.oddID));

// --- Top Picks (lib/topPicks.js) ---
// Category grouping, the quality bar (same as Edge Board's), sort-by-edge, and the limit cap — all in one
// synthetic "rush_yds" slate with deliberate disqualifiers mixed in (low confidence, suspect, team mismatch,
// below the noise-floor edge) so a bug in any single exclusion doesn't slip through unnoticed.
function fakeTopPickRow(over) {
  return {
    oddID: "tp-x", propType: "rush_yds", propLabel: "Rushing Yards", side: "over", line: 55.5,
    player: "Test Back", team: "KC", opponent: "BUF", opponentDisp: "BUF", position: "RB", kickoff: "2026-10-05T17:00:00Z",
    model: { available: true }, modelProb: 0.6, marketProb: 0.5, trueEdge: 0.1, confidence: "high",
    teamMismatch: false, suspect: false, bestBook: "draftkings", bestPrice: -110,
    modelContributorDetails: [], factors: {}, ...over
  };
}
const topPickCandidates = [
  fakeTopPickRow({ oddID: "tp-1", trueEdge: 0.15 }),
  fakeTopPickRow({ oddID: "tp-2", trueEdge: 0.12 }),
  fakeTopPickRow({ oddID: "tp-3", trueEdge: 0.09 }),
  fakeTopPickRow({ oddID: "tp-4", trueEdge: 0.08 }),
  fakeTopPickRow({ oddID: "tp-5", trueEdge: 0.07 }),
  fakeTopPickRow({ oddID: "tp-6", trueEdge: 0.06 }), // 6th real candidate -> should be cut by the limit=5 default
  fakeTopPickRow({ oddID: "tp-low-edge", trueEdge: 0.01 }), // below MIN_TRUE_EDGE -> excluded
  fakeTopPickRow({ oddID: "tp-low-conf", trueEdge: 0.2, confidence: "low" }), // real edge, but too thin a sample -> excluded
  fakeTopPickRow({ oddID: "tp-suspect", trueEdge: 0.2, suspect: true }), // implausible/unverified -> excluded
  fakeTopPickRow({ oddID: "tp-mismatch", trueEdge: 0.2, teamMismatch: true }) // unresolved team -> excluded
];
const topPicksResult = buildTopPicks(topPickCandidates);
const rushCategory = topPicksResult.categories.find(c => c.key === "rush_yds");
const topPicksBasicsWork = topPicksResult.categories.length === PICK_CATEGORIES.length &&
  rushCategory.picks.length === 5 &&
  rushCategory.picks.map(p => p.oddID).join(",") === "tp-1,tp-2,tp-3,tp-4,tp-5" && // sharpest edge first, capped at 5
  !rushCategory.picks.some(p => ["tp-6", "tp-low-edge", "tp-low-conf", "tp-suspect", "tp-mismatch"].includes(p.oddID));
console.log("buildTopPicks groups by every category, ranks by real edge, and holds the same quality bar as the Edge Board (should be true):",
  topPicksBasicsWork, rushCategory.picks.map(p => p.oddID));

// An empty slate for a category (nothing qualifies) must return an empty picks array, never throw or drop the
// category entirely — a bye week for every player in a bucket is a real state, not an error.
const emptyTopPicks = buildTopPicks([fakeTopPickRow({ oddID: "only-one", propType: "td_pass", trueEdge: 0.01 })]);
const emptyCategoryHandledCleanly = emptyTopPicks.categories.every(c => Array.isArray(c.picks)) &&
  emptyTopPicks.categories.find(c => c.key === "rush_yds").picks.length === 0 &&
  emptyTopPicks.categories.find(c => c.key === "td_pass").picks.length === 0; // the one candidate's edge was below the bar
console.log("Every category is always present, even empty, and never throws on a slate with nothing that qualifies (should be true):", emptyCategoryHandledCleanly);

// --- Top Picks reasons + write-up (pickTopReasons/pickBlurb) ---
// A nudge whose real, currently-backtested coefficient is negative (matchup_edge sits at -0.027 in the live
// lib/modelCoeffs.js despite its positive-sounding label) must never be touted as a reason to like the pick —
// this is the whole point of carrying signed weight through contributorDetails instead of just label strings.
const mixedContributorRow = fakeTopPickRow({
  modelContributorDetails: [
    { key: "form_hot", weight: 0.283, label: "hot last 3 games" },
    { key: "matchup_edge", weight: -0.027, label: "team matchup edge" }, // real backtested effect is negative -> must be excluded
    { key: "usage_high_snap", weight: 0.293, label: "high snap share" },
    { key: "redzone_share", weight: 0.233, label: "heavy red-zone share" }
  ]
});
const mixedReasons = pickTopReasons(mixedContributorRow);
// Positive weights only, ranked highest-first: usage_high_snap (0.293) > form_hot (0.283) > redzone_share (0.233);
// matchup_edge (-0.027) is excluded outright despite its positive-sounding label.
const negativeContributorExcludedAndRankedByWeight = !mixedReasons.includes("team matchup edge") &&
  mixedReasons[0] === "high snap share" && mixedReasons[1] === "hot last 3 games" && mixedReasons[2] === "heavy red-zone share";
console.log("pickTopReasons excludes a nudge with a real negative measured effect and ranks the rest by actual weight (should be true):", negativeContributorExcludedAndRankedByWeight, mixedReasons);

// With fewer than 3 real fired nudges, real computed facts (matchup rank, form rate, edge itself, ...) fill the
// gap rather than leaving a card with only 1-2 reasons — every filler is grounded in a real number on the row,
// never invented, and duplicate-tagged fillers (e.g. two usage-flavored facts) are skipped in favor of variety.
const thinContributorRow = fakeTopPickRow({
  modelContributorDetails: [{ key: "form_hot", weight: 0.283, label: "hot last 3 games" }],
  factors: {
    defense: { available: true, rank: 4, ofTeams: 32 },
    form: { available: true, n_last10: 8, rate_last10: 0.75 },
    redZone: { available: true, redZoneShare: 0.4 }
  }
});
const thinReasons = pickTopReasons(thinContributorRow);
const fallbackFillsToMinimum = thinReasons.length >= 3 && thinReasons[0] === "hot last 3 games" &&
  thinReasons.some(r => /ranks 4 of 32/.test(r));
console.log("pickTopReasons fills in with real computed facts when fired nudges alone don't reach 3 (should be true):", fallbackFillsToMinimum, thinReasons);

// The write-up itself: 2-3 sentences, names the player, states the real model/market numbers and edge, and
// weaves in the chosen reasons — never a wall of bullet fragments.
const blurb = pickBlurb(mixedContributorRow, mixedReasons);
const blurbSentenceCount = blurb.split(/(?<=[.!?])\s+/).filter(Boolean).length;
const blurbIsWellFormed = blurb.includes("Test Back") && /\d+-point edge/.test(blurb) && blurbSentenceCount >= 2 && blurbSentenceCount <= 3;
console.log("pickBlurb reads as a real 2-3 sentence write-up naming the player and the actual edge (should be true):", blurbIsWellFormed, blurb);

// --- Teammate-out tendency now gates on CURRENT injury status (lib/factors/playerSplits.js) ---
// The real bug Jon reported live: a writeup reading "Without Omarion Hampton on the field..." for a game where
// Hampton was actually active — because the old version never looked at `injuriesByTeam` at all, just historical
// game-log gaps (any absence, any reason). Same synthetic game log (3 games with the teammate, 2 without, a real
// usage bump in the "without" games) run through three different current-status states for the teammate.
const teammateGameLogIndex = new Map([
  ["test rb1", [
    { week: 1, rushing_yards: 60 }, { week: 2, rushing_yards: 100 }, { week: 3, rushing_yards: 55 },
    { week: 4, rushing_yards: 95 }, { week: 5, rushing_yards: 58 }
  ]],
  ["test rb2", [ // the "teammate" — active weeks 1, 3, 5; absent (any reason) weeks 2 and 4
    { week: 1, rushing_yards: 40 }, { week: 3, rushing_yards: 35 }, { week: 5, rushing_yards: 45 }
  ]]
]);
const teammatePlayer = { _logKey: "test rb1", team: "KC" };
const activeTendency = computeTeammateOutTendency(teammatePlayer, "Test RB2",
  { KC: [{ name: "Test RB2", status: "Active" }] }, teammateGameLogIndex, "rush_yds");
const noEntryTendency = computeTeammateOutTendency(teammatePlayer, "Test RB2", { KC: [] }, teammateGameLogIndex, "rush_yds");
const questionableTendency = computeTeammateOutTendency(teammatePlayer, "Test RB2",
  { KC: [{ name: "Test RB2", status: "Questionable" }] }, teammateGameLogIndex, "rush_yds");
const outTendency = computeTeammateOutTendency(teammatePlayer, "Test RB2",
  { KC: [{ name: "Test RB2", status: "Out" }] }, teammateGameLogIndex, "rush_yds");
const teammateTendencyGatesOnCurrentStatus = activeTendency.available === false && noEntryTendency.available === false &&
  questionableTendency.available === true && outTendency.available === true &&
  outTendency.teammateStatus === "Out" && outTendency.withoutAvg === 97.5 && Math.abs(outTendency.withAvg - 57.6667) < 0.01;
console.log("computeTeammateOutTendency only fires when the teammate is CURRENTLY Out/Doubtful/Questionable, never on stale historical absence alone (should be true):",
  teammateTendencyGatesOnCurrentStatus, { activeTendency, noEntryTendency, questionableAvailable: questionableTendency.available, outTendency });

// --- Injury status-escalation watch (lib/factors/injury.js) ---
// Jon's explicit ask: a separate tracker for players who were Questionable on an earlier refresh this week but
// have since worsened to Doubtful or Out. Four players across two snapshots exercise every case that must be
// told apart: a real Questionable->Doubtful escalation (include), Out staying Out (already worst, not an
// "escalation" — exclude), Questionable staying Questionable (no change — exclude), and Doubtful->Out (a real
// worsening, but doesn't START at Questionable, so it's out of scope for THIS tracker per Jon's exact wording).
const escalationHistory = [
  { t: "2026-09-17T12:00:00Z", byTeam: { KC: [
    { name: "Player Q2D", status: "Questionable", position: "WR", detail: "ankle" },
    { name: "Player OutStays", status: "Out", position: "RB" },
    { name: "Player QStays", status: "Questionable", position: "TE" },
    { name: "Player DtoOut", status: "Doubtful", position: "CB" }
  ] } },
  { t: "2026-09-18T12:00:00Z", byTeam: { KC: [
    { name: "Player Q2D", status: "Doubtful", position: "WR", detail: "ankle" },
    { name: "Player OutStays", status: "Out", position: "RB" },
    { name: "Player QStays", status: "Questionable", position: "TE" },
    { name: "Player DtoOut", status: "Out", position: "CB" }
  ] } }
];
const escalations = computeInjuryEscalations(escalationHistory);
const escalationWatchWorksCorrectly = escalations.length === 1 && escalations[0].name === "Player Q2D" &&
  escalations[0].firstStatus === "Questionable" && escalations[0].currentStatus === "Doubtful" &&
  !escalations.some(e => ["Player OutStays", "Player QStays", "Player DtoOut"].includes(e.name));
console.log("computeInjuryEscalations flags only a real Questionable -> Doubtful/Out worsening, not an already-Out player or a same-status repeat (should be true):",
  escalationWatchWorksCorrectly, escalations);
const emptyEscalationsOnNoHistory = computeInjuryEscalations([]).length === 0 && computeInjuryEscalations(undefined).length === 0;
console.log("computeInjuryEscalations returns a clean empty list with no/empty history rather than throwing (should be true):", emptyEscalationsOnNoHistory);

// --- Referee tendency, revived as a non-bettable context factor (lib/factors/referee.js) ---
// 10 synthetic games for "Test Ref": 7 overs, 3 unders, clears the gamesCalled>=8 floor. A second referee with
// only 3 games on record proves the sample-size gate actually excludes a too-thin history instead of reporting
// a number anyway.
const refereeSchedule = [
  ...Array.from({ length: 7 }, (_, i) => ({ referee: "Test Ref", total: 50 + i, total_line: 44 })), // all clear the line -> overs
  ...Array.from({ length: 3 }, (_, i) => ({ referee: "Test Ref", total: 30 + i, total_line: 44 })), // all under the line
  { referee: "Thin Sample Ref", total: 40, total_line: 40 }, { referee: "Thin Sample Ref", total: 41, total_line: 40 }, { referee: "Thin Sample Ref", total: 39, total_line: 40 }
];
const testRefFactor = computeRefereeFactor("Test Ref", refereeSchedule);
const thinRefFactor = computeRefereeFactor("Thin Sample Ref", refereeSchedule);
const noRefFactor = computeRefereeFactor(null, refereeSchedule);
const refereeFactorWorks = testRefFactor.available === true && testRefFactor.gamesCalled === 10 &&
  Math.abs(testRefFactor.overRate - 0.7) < 0.001 && thinRefFactor.available === false && noRefFactor.available === false;
console.log("computeRefereeFactor computes a real over-rate once the sample clears the floor, and reports unavailable below it or with no assignment (should be true):",
  refereeFactorWorks, { testRefFactor, thinRefFactor });

// --- Next Gen Stats player efficiency (lib/factors/nextgenstats.js) ---
// Real NGS-shaped rows for a hot-CPOE QB, a below-expected rusher, and a receiver who consistently gets open —
// each gated on real position/sample-size checks, never firing for the wrong position or a too-thin sample.
const ngsPassingIdx = buildNgsIndex([
  { player_display_name: "Test Qb", week: 1, attempts: 32, completion_percentage_above_expectation: 5.1, avg_time_to_throw: 2.6, aggressiveness: 15, avg_intended_air_yards: 8.1 },
  { player_display_name: "Test Qb", week: 2, attempts: 35, completion_percentage_above_expectation: 4.4, avg_time_to_throw: 2.5, aggressiveness: 14, avg_intended_air_yards: 7.9 },
  { player_display_name: "Test Qb", week: 3, attempts: 3, completion_percentage_above_expectation: 40, avg_time_to_throw: 2.0, aggressiveness: 20, avg_intended_air_yards: 10 } // too few attempts -> filtered out
]);
const ngsRushingIdx = buildNgsIndex([
  { player_display_name: "Test Rb", week: 1, rush_attempts: 18, rush_yards_over_expected_per_att: -0.8, efficiency: 3.1 },
  { player_display_name: "Test Rb", week: 2, rush_attempts: 20, rush_yards_over_expected_per_att: -0.6, efficiency: 3.0 }
]);
const ngsReceivingIdx = buildNgsIndex([
  { player_display_name: "Test Wr", week: 1, targets: 8, avg_separation: 3.4, avg_yac_above_expectation: 0.8 },
  { player_display_name: "Test Wr", week: 2, targets: 9, avg_separation: 3.2, avg_yac_above_expectation: 1.1 }
]);
const testQb = { position: "QB", _logKey: "test qb" };
const testRb = { position: "RB", _logKey: "test rb" };
const testWr = { position: "WR", _logKey: "test wr" };
const ngsPassingResult = computeNgsPassing(testQb, ngsPassingIdx);
const ngsRushingResult = computeNgsRushing(testRb, ngsRushingIdx);
const ngsReceivingResult = computeNgsReceiving(testWr, ngsReceivingIdx);
const ngsWrongPositionStaysUnavailable = computeNgsPassing(testRb, ngsPassingIdx).available === false &&
  computeNgsRushing(testWr, ngsRushingIdx).available === false;
const ngsFactorsWork = ngsPassingResult.available === true && ngsPassingResult.sampleGames === 2 && Math.abs(ngsPassingResult.cpoe - 4.75) < 0.01 &&
  ngsRushingResult.available === true && Math.abs(ngsRushingResult.ryoePerAtt - (-0.7)) < 0.01 &&
  ngsReceivingResult.available === true && Math.abs(ngsReceivingResult.avgSeparation - 3.3) < 0.01 &&
  ngsWrongPositionStaysUnavailable;
console.log("computeNgsPassing/Rushing/Receiving compute real trailing efficiency numbers, gated on position and a real sample-size/attempt floor (should be true):",
  ngsFactorsWork, { ngsPassingResult, ngsRushingResult, ngsReceivingResult });

// --- Pass-protection/pressure matchup (lib/factors/pressure.js) ---
// Real team-level numbers already computed by teamStats.js: a team with a leaky O-line (high pressureRateAllowed)
// facing a defense with an elite pass rush (high pressureRateCreated) should read out a real elevated combined
// risk number — and stay unavailable when either side has no play-by-play sample to compute from yet.
const pressureTeamIndex = {
  KC: { pressureRateAllowed: 0.42 },
  BUF: { pressureRateCreated: 0.38 },
  NOSAMPLE: { pressureRateAllowed: null, pressureRateCreated: null }
};
const pressureResult = computePressureFactor("KC", "BUF", pressureTeamIndex);
const pressureUnavailableWithoutSample = computePressureFactor("KC", "NOSAMPLE", pressureTeamIndex).available === false;
const pressureFactorWorks = pressureResult.available === true && Math.abs(pressureResult.combinedPressureRisk - 0.4) < 0.001 && pressureUnavailableWithoutSample;
console.log("computePressureFactor combines the offense's own pass-block rate with the opposing defense's pass-rush rate, real numbers only (should be true):",
  pressureFactorWorks, pressureResult);

// --- Real ESPN Total QBR trend (lib/factors/qbr.js) ---
// An elite-trending QB (avg well above QBR_ELITE_THRESHOLD), a poor-trending one (avg below QBR_POOR_THRESHOLD),
// a non-QB who should never get a QBR read regardless of how the data is shaped, and a too-thin single-game
// sample that should stay unavailable rather than trusting one QBR reading.
const qbrIdx = buildQbrIndex([
  { name_display: "Test Qb", week_num: 1, qbr_total: 82.5 },
  { name_display: "Test Qb", week_num: 2, qbr_total: 79.1 },
  { name_display: "Poor Qb", week_num: 1, qbr_total: 22.0 },
  { name_display: "Poor Qb", week_num: 2, qbr_total: 28.4 },
  { name_display: "Thin Qb", week_num: 1, qbr_total: 95.0 }
]);
const eliteQbrResult = computeQbrTrend({ position: "QB", _logKey: "test qb" }, qbrIdx);
const poorQbrResult = computeQbrTrend({ position: "QB", _logKey: "poor qb" }, qbrIdx);
const thinQbrStaysUnavailable = computeQbrTrend({ position: "QB", _logKey: "thin qb" }, qbrIdx).available === false;
const nonQbStaysUnavailable = computeQbrTrend({ position: "WR", _logKey: "test qb" }, qbrIdx).available === false;
const qbrFactorWorks = eliteQbrResult.available === true && eliteQbrResult.avgQbr >= QBR_ELITE_THRESHOLD &&
  poorQbrResult.available === true && poorQbrResult.avgQbr <= QBR_POOR_THRESHOLD &&
  thinQbrStaysUnavailable && nonQbStaysUnavailable;
console.log("computeQbrTrend reads real ESPN QBR trailing averages, gated on QB position and a real 2-game floor (should be true):",
  qbrFactorWorks, { eliteQbrResult, poorQbrResult });

// --- Roster/depth-chart accuracy pass (lib/identity.js, lib/factors/index.js) ---
// Unit-tested directly against the same fixtures buildDemoData feeds the pipeline, the same pattern already
// used above for lib/probability.js and lib/grading.js — these fixtures don't have their own odds/props in
// demoData's events, so there's nothing for a full pipeline run to surface them through.
const demoRaw = buildDemoData(SEASON, [SEASON, SEASON - 1, SEASON - 2]);
const rosterIdx = buildRosterIndex(demoRaw.rosterRows);
const depthChartIdx = buildDepthChartIndex(demoRaw.depthChartRows);

// Regression guard for the roster-index bug: roster_weekly_<season>.csv is one row per player PER WEEK, and a
// traded player has one row per team. Building the index in raw (non-chronological) file order let whichever
// row happened to land last win, not necessarily his current team. Demo Traded Wr's fixture is deliberately
// scrambled and ends with a bogus postseason row — the only correct resolution is his real latest REG week (5, KC).
const tradedRoster = rosterIdx.get("demo traded wr");
const rosterIndexPicksLatestWeek = tradedRoster?.team === "KC" && tradedRoster?.asOfWeek === 5;
console.log("Roster index resolves a traded player to his latest REG week's team, not raw file order (should be true):", rosterIndexPicksLatestWeek, tradedRoster);

// Regression guard for the new depth-chart index: a real ranked WR2 resolves with the correct team, rank, and
// group size (4 WRs on KC's demo depth chart: Demo Receiver, Demo Teammate Wr, Demo Traded Wr, Demo Fresh Trade Wr).
const teammateDepthChart = depthChartIdx.get("demo teammate wr");
const depthChartIndexWorks = teammateDepthChart?.team === "KC" && teammateDepthChart?.posRank === 2 && teammateDepthChart?.groupSize === 4;
console.log("Depth-chart index resolves a real ranked WR2 with the correct group size (should be true):", depthChartIndexWorks, teammateDepthChart);

// Regression guard for resolvePlayer's new conflict handling: Demo Fresh Trade Wr's weekly-roster row still
// says DEN (the roster file's own weekly cadence lags a real trade), but the depth-chart fixture — standing in
// for a scrape taken today — already shows him on KC. The fresher depth-chart source must win the team, and
// the disagreement must be flagged so the pipeline can log it and the frontend can show it.
const freshTradeResolved = resolvePlayer("Demo Fresh Trade Wr", new Map(), rosterIdx, depthChartIdx);
const resolvePlayerPrefersDepthChartOnConflict = freshTradeResolved.team === "KC" && freshTradeResolved.rosterTeam === "DEN" &&
  freshTradeResolved.depthChartTeam === "KC" && freshTradeResolved.rosterConflict === true;
console.log("resolvePlayer prefers the fresher depth-chart team and flags the conflict (should be true):", resolvePlayerPrefersDepthChartOnConflict, freshTradeResolved);

// Once the roster-index fix is in place, Demo Traded Wr's roster team (KC, from his latest week) and his
// depth-chart team (also KC) agree — this must NOT be flagged as a conflict just because two different data
// sources were consulted.
const tradedResolved = resolvePlayer("Demo Traded Wr", new Map(), rosterIdx, depthChartIdx);
const noConflictWhenBothSourcesAgree = tradedResolved.team === "KC" && tradedResolved.rosterConflict === false;
console.log("No false roster-conflict flag once both sources agree on the same team (should be true):", noConflictWhenBothSourcesAgree, tradedResolved);

// Regression guard for findKeyTeammate's new depth-chart-first behavior: Demo Receiver is the depth chart's own
// WR1 on KC. The old volume-based heuristic can't even see him vs. Demo Teammate Wr (no game log for the
// latter), but the real bug this closes is structural — a naive "must be rank 1" read would find nothing once
// the player himself occupies that slot. The correct "key teammate" is the depth chart's real WR2.
const demoReceiverPlayer = { team: "KC", position: "WR", _logKey: "demo receiver" };
const keyTeammateUsesDepthChartRank = findKeyTeammate(demoReceiverPlayer, rosterIdx, new Map(), depthChartIdx) === "demo teammate wr";
console.log("findKeyTeammate picks the depth chart's real WR2, not 'no result' (should be true):", keyTeammateUsesDepthChartRank);
// And the existing QB exclusion still holds even with a depth chart available (Mahomes is depth-chart QB1 with
// a real QB2 behind him — this must still return null, not surface a QB \"teammate out\" comparison that can't
// happen on the field).
const mahomesPlayer = { team: "KC", position: "QB", _logKey: "patrick mahomes" };
const keyTeammateStillSkipsQb = findKeyTeammate(mahomesPlayer, rosterIdx, new Map(), depthChartIdx) === null;
console.log("findKeyTeammate still returns null for QBs even with depth-chart data available (should be true):", keyTeammateStillSkipsQb);

// Regression guard for the pipeline-level wiring: propRows carry the resolved depth-chart role fields, and the
// pipeline's stats object counts real roster/depth-chart conflicts (0 expected in demo data — no prop in this
// slate's events belongs to a fixture player with a genuine conflict).
const anyPropHasDepthChartRole = snapshot.propRows.some(r => r.depthChartRole);
const rosterConflictsStatIsPresent = typeof snapshot.stats.rosterConflicts === "number";
console.log("At least one prop row carries a resolved depth-chart role (should be true):", anyPropHasDepthChartRole, snapshot.propRows.map(r => r.depthChartRole));
console.log("Pipeline stats report a rosterConflicts count (should be true):", rosterConflictsStatIsPresent, snapshot.stats.rosterConflicts);

// --- Odds-fetch resilience (lib/fetchers/odds.js) ---
// Regression guard for a real live failure: SportsGameOdds 400s the ENTIRE request when even ONE requested
// bookmakerID is unavailable at the account's subscription tier (confirmed live — "fanatics" tripped this
// despite the tier's docs claiming 77 bookmakers are included, taking down every book/event in one shot, not
// just that book's prices). fetchNFLEvents must detect that specific error shape, drop only the offending
// bookmakerID, and retry with the rest — never fail the whole refresh over one bad book.
const realFetch = globalThis.fetch;
let oddsFetchCallCount = 0;
globalThis.fetch = async (url) => {
  oddsFetchCallCount++;
  const requestedBooks = new URL(url).searchParams.get("bookmakerID").split(",");
  if (requestedBooks.includes("brokenbook")) {
    return { ok: false, status: 400, text: async () => JSON.stringify({ success: false, error: "The bookmakerID brokenbook is unavailable at your current subscription tier. Upgrade to unlock" }) };
  }
  return { ok: true, status: 200, json: async () => ({ success: true, data: [{ eventID: "e1" }] }) };
};
const oddsResult = await fetchNFLEvents("fake-key", ["draftkings", "brokenbook", "fanduel"], () => {});
globalThis.fetch = realFetch;
const oddsResilienceWorks = oddsFetchCallCount === 2 && oddsResult.length === 1 && oddsResult[0].eventID === "e1";
console.log("A single unavailable bookmakerID is dropped and the request retried, not a total failure (should be true):", oddsResilienceWorks, `calls=${oddsFetchCallCount}`);

// --- AI annotation concurrency (lib/ai.js) ---
// Regression guard for a real live incident: right after this session's probability-model rebuild, every row's
// AI-note cache hash changed at once (the hash is of the content actually sent to Claude, and that shape
// changed), so a fully cold cache sent every batch, across every annotation pass, strictly one after another —
// a live refresh ran past 13 minutes still waiting on sequential Anthropic round-trips. Any future change that
// shifts enough rows' content causes the same full-cache-miss again, so batches must run several at a time
// (bounded, not unlimited) rather than one at a time.
const realAiFetch = globalThis.fetch;
let aiCallsInFlight = 0, aiMaxConcurrent = 0, aiCallCount = 0;
globalThis.fetch = async (url) => {
  if (!String(url).includes("api.anthropic.com")) return realAiFetch(url);
  aiCallCount++;
  aiCallsInFlight++;
  aiMaxConcurrent = Math.max(aiMaxConcurrent, aiCallsInFlight);
  await new Promise(r => setTimeout(r, 30));
  aiCallsInFlight--;
  const fakeResults = Array.from({ length: 30 }, (_, i) => ({ id: i, tag: "lean-over", note: "synthetic test note" }));
  return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify(fakeResults) }] }) };
};
// 65 rows at annotatePropsWithAI's batch size of 30 makes 3 batches — enough to prove they overlap.
// `_aiSelected: true` stands in for pipeline.js's real top-AI_NOTE_LIMIT-by-modelProb selection (see the cost
// controls test below) — annotatePropsWithAI only considers rows already marked this way.
const syntheticProps = Array.from({ length: 65 }, (_, i) => ({
  oddID: `p-${i}`, player: `Demo Player ${i}`, team: "KC", opponent: "BUF", propLabel: "Receiving yards", side: "over", line: 49.5,
  bestBook: "draftkings", bestPrice: -110, suspect: false, teamMismatch: false, factors: {}, _aiSelected: true
}));
await annotatePropsWithAI(syntheticProps, "fake-key", {}, () => {});
globalThis.fetch = realAiFetch;
const aiConcurrencyWorks = aiCallCount === 3 && aiMaxConcurrent >= 2;
console.log("AI annotation batches run concurrently, not strictly one-at-a-time (should be true):", aiConcurrencyWorks, `calls=${aiCallCount} maxConcurrent=${aiMaxConcurrent}`);

// --- Anthropic cost controls (lib/ai.js) ---
// Regression guard for a real cost review: AI notes used to go out for every non-suspect card on the board,
// on a schedule running every 30 minutes, with the AI model itself set to the most expensive tier — a genuine
// spend problem. selectAiEligible must pick only the real top AI_NOTE_LIMIT props by modelProb ("most likely to
// hit"), and must still exclude a suspect/mismatched/unscored row even if its raw modelProb would otherwise put
// it in the top slice.
const manyProps = Array.from({ length: 60 }, (_, i) => ({
  oddID: `p-${i}`, suspect: false, teamMismatch: false, model: { available: true }, modelProb: i / 100 // 0.00..0.59
}));
const edgeCaseProps = [
  { oddID: "p-high-suspect", suspect: true, teamMismatch: false, model: { available: true }, modelProb: 0.95 }, // high prob but suspect -> excluded
  { oddID: "p-high-mismatch", suspect: false, teamMismatch: true, model: { available: true }, modelProb: 0.93 }, // high prob but team mismatch -> excluded
  { oddID: "p-high-unscored", suspect: false, teamMismatch: false, model: { available: false }, modelProb: null } // model never resolved -> excluded
];
const selected = selectAiEligible([...manyProps, ...edgeCaseProps], 50);
const selectedIds = new Set(selected.map(r => r.oddID));
// The top 50 props by modelProb (i=59 down to i=10) — the 3 edge-case rows never qualify at all, so they can't
// take a slot away from a real, scoreable prop the way an eligible "always makes the cut" row used to.
const top50PropIds = new Set(manyProps.slice(10, 60).map(r => r.oddID));
const aiSelectionWorks = selected.length === 50 &&
  !selectedIds.has("p-high-suspect") && !selectedIds.has("p-high-mismatch") && !selectedIds.has("p-high-unscored") &&
  [...top50PropIds].every(id => selectedIds.has(id)) && !selectedIds.has("p-0") && !selectedIds.has("p-9") &&
  manyProps.filter(r => r._aiSelected).length === 50;
console.log("selectAiEligible keeps only the top AI_NOTE_LIMIT props by real modelProb, excluding suspect/mismatched/unscored regardless of their raw probability (should be true):", aiSelectionWorks, `selected=${selected.length}`);

// Regression guard for the cache-loosening fix: two content objects that differ only by noise (a price moving a
// cent, a rate drifting a fraction of a point) must hash identically via roundForHash, while a genuinely
// different value must not.
const noisyA = { price: -110, rate: 0.601, wind: 11, note: "x" };
const noisyB = { price: -111, rate: 0.609, wind: 12, note: "x" };
const realChange = { price: -110, rate: 0.75, wind: 11, note: "x" };
const cacheLoosening = JSON.stringify(roundForHash(noisyA)) === JSON.stringify(roundForHash(noisyB)) &&
  JSON.stringify(roundForHash(noisyA)) !== JSON.stringify(roundForHash(realChange));
console.log("roundForHash absorbs trivial noise but still catches a real change (should be true):", cacheLoosening, roundForHash(noisyA), roundForHash(realChange));

// Regression guard for the new daily Anthropic spend cap: real, current per-million-token pricing (Haiku 4.5
// $1/$5, Sonnet 5 $2/$10, Opus 5 $5/$25) computed from the API's own token-usage response, never a payload-size
// guess — and an unrecognized future model name still gets a conservative estimate rather than silently costing $0.
const millionTokUsage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
const costEstimatesAreCorrect =
  Math.abs(estimateCostUsd("claude-haiku-4-5-20251001", millionTokUsage) - 6) < 0.0001 &&
  Math.abs(estimateCostUsd("claude-sonnet-5-20250929", millionTokUsage) - 12) < 0.0001 &&
  Math.abs(estimateCostUsd("claude-opus-5-20250915", millionTokUsage) - 30) < 0.0001 &&
  estimateCostUsd("some-future-model", millionTokUsage) > 0 &&
  estimateCostUsd("claude-haiku-4-5", null) === 0;
console.log("estimateCostUsd prices Haiku/Sonnet/Opus correctly from real token usage, estimates conservatively for an unknown model, and costs $0 with no usage (should be true):", costEstimatesAreCorrect);

// The spend guard must actually flip to exhausted once today's recorded spend reaches the cap (a best-effort
// stop point checked between waves of concurrent AI calls, not a mid-batch kill switch — it can overshoot by
// one in-flight wave, which is a documented, deliberate tradeoff, not a bug), and must roll over to a fresh $0
// ledger on a new UTC calendar day, archiving the prior day's total into history rather than discarding it.
const freshGuard = createSpendGuard({ date: null, spentUsd: 0, callCount: 0, history: [] }, 5);
const notExhaustedBelowCap = freshGuard.exhausted === false;
freshGuard.record(3);
freshGuard.record(2.5);
const spendGuardCapWorks = notExhaustedBelowCap && freshGuard.exhausted === true &&
  freshGuard.snapshot().callCount === 2 && Math.abs(freshGuard.snapshot().spentUsd - 5.5) < 0.001;
console.log("Spend guard stays open below the cap, then flips exhausted once recorded spend reaches it (should be true):", spendGuardCapWorks, freshGuard.snapshot());

const todayIso = new Date().toISOString().slice(0, 10);
const yesterdayLedger = { date: "2020-01-01", spentUsd: 4.87, callCount: 40, history: [] };
const rolloverGuard = createSpendGuard(yesterdayLedger, 5);
const rolloverWorks = rolloverGuard.exhausted === false && rolloverGuard.snapshot().date === todayIso &&
  rolloverGuard.snapshot().spentUsd === 0 && rolloverGuard._ledger.history.some(h => h.date === "2020-01-01" && h.spentUsd === 4.87);
console.log("A new UTC calendar day resets the spend guard to $0 and archives the prior day's total into history, rather than carrying its spend forward (should be true):", rolloverWorks, rolloverGuard.snapshot());

// Regression guard for the scouting-takes throttle: cacheOnly mode must reuse whatever's already cached (for
// free) but make ZERO fresh Anthropic calls for anything not already sitting in cache, even though those rows
// are otherwise eligible. Uncached rows just stay unset until the next full (non-throttled) run.
const realScoutFetch = globalThis.fetch;
let scoutCallCount = 0;
globalThis.fetch = async (url) => {
  if (!String(url).includes("api.anthropic.com")) return realScoutFetch(url);
  scoutCallCount++;
  return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify([{ id: 0, note: "fresh" }]) }] }) };
};
const scoutRowCached = { oddID: "sc-cached", _aiSelected: true, teamMismatch: false, suspect: false, propType: "rec_yds", player: "A", team: "KC", opponent: "BUF", propLabel: "Receiving yards" };
const scoutRowUncached = { oddID: "sc-fresh", _aiSelected: true, teamMismatch: false, suspect: false, propType: "rec_yds", player: "B", team: "KC", opponent: "BUF", propLabel: "Receiving yards" };
const scoutCache = {};
// Prime the cache for scoutRowCached by running once, uncached (cacheOnly: false), with only that row present.
await annotateScoutingTakes([scoutRowCached], "fake-key", scoutCache, () => {}, { cacheOnly: false });
const callsAfterPriming = scoutCallCount;
// Now the "throttled" run: both rows present, cacheOnly: true. The cached row should be reapplied for free;
// the new row should be skipped entirely, with no additional Anthropic call.
scoutRowCached.scouting = null; // clear so we can tell whether the cache-only pass actually re-applied it
await annotateScoutingTakes([scoutRowCached, scoutRowUncached], "fake-key", scoutCache, () => {}, { cacheOnly: true });
const scoutingThrottleWorks = scoutCallCount === callsAfterPriming && !!scoutRowCached.scouting && scoutRowUncached.scouting === undefined;
globalThis.fetch = realScoutFetch;
console.log("Scouting throttle (cacheOnly) reuses cached notes for free and skips uncached rows without a new call (should be true):", scoutingThrottleWorks, `calls=${scoutCallCount}`, scoutRowCached.scouting, scoutRowUncached.scouting);

// --- Same Game / Slate / cross-game parlays (lib/parlays.js) — fixed absolute-probability-band tiers ---
// Regression guard for the kickoff-window classifier: the real live bug this guards against is a hardcoded UTC
// offset, which would get exactly ONE of these two dates wrong. Oct 25, 2026 and Nov 1, 2026 are both real
// Sundays, and "1:00pm Eastern" lands on a DIFFERENT UTC hour on each one (17:00 UTC vs. 18:00 UTC) because the
// November daylight-saving change falls in between — so both must still classify as the 1:00 slate only if the
// classifier is doing a real Eastern-time conversion, not "always subtract N hours from UTC."
const dstSafetyWorks = classifyKickoffWindow("2026-10-25T17:00:00Z") === "sun_early" && // 1:00pm EDT (UTC-4), before the DST change
  classifyKickoffWindow("2026-11-01T18:00:00Z") === "sun_early" &&                      // 1:00pm EST (UTC-5), after it — same wall-clock time, different UTC hour
  classifyKickoffWindow("2026-11-01T21:05:00Z") === "sun_late" &&                       // 4:05pm ET
  classifyKickoffWindow("2026-10-30T00:15:00Z") === null &&                             // Thursday 8:15pm ET — outside both windows
  classifyKickoffWindow(null) === null;
console.log("Kickoff-window classification survives the November DST change (should be true):", dstSafetyWorks);

const demoEvents = summarizeEvents(snapshot.propRows);
const eventWindows = Object.fromEntries(demoEvents.map(e => [e.eventId, e.window]));
const demoEventWindowsAreCorrect = eventWindows["demo-1"] === "sun_early" && eventWindows["demo-1b"] === "sun_early" && eventWindows["demo-2"] === "sun_early" &&
  eventWindows["demo-3"] === "sun_late" && eventWindows["demo-4"] === "sun_late" && eventWindows["demo-5"] === null;
console.log("Every demo event lands in the right kickoff window (should be true):", demoEventWindowsAreCorrect, eventWindows);

// Core invariant of the Low/Medium/High rewrite, checked generically (not by hand-deriving every leg's exact
// modelProb): within ANY one parlay grouping (a cross-game tier set, one game's SGP tier set, or one slate's
// tier set), every ONE OF THOSE THREE tiers that built successfully must draw its legs ONLY from its own
// declared probability band, and no single leg (by oddID) can appear in more than one of them — the actual bug
// the original rewrite fixed (the old design let the same top legs get reused across every risk tier). Mega and
// Nuke are checked separately below (checkMegaNukeInvariants) since they're deliberately allowed to reuse a
// Low/Medium/High leg — see parlays.js's own comment on buildTierSet for why that's by design, not a bug.
function checkTierSetInvariants(tiers, label) {
  const seenAcrossTiers = new Set();
  let bandsRespected = true, noOverlap = true;
  const details = [];
  const banded = tiers.filter(t => ["low", "medium", "high"].includes(t.tier.key));
  for (const t of banded) {
    if (!t.ok) { details.push(`${label} ${t.tier.key}: not ok (${t.reason})`); continue; }
    for (const leg of t.legs) {
      if (leg.hitProbability < t.tier.minProb || leg.hitProbability >= t.tier.maxProb) {
        bandsRespected = false;
        details.push(`${label} ${t.tier.key}: leg ${leg.row.oddID} hitProbability ${leg.hitProbability} outside [${t.tier.minProb},${t.tier.maxProb})`);
      }
      if (seenAcrossTiers.has(leg.row.oddID)) { noOverlap = false; details.push(`${label} ${t.tier.key}: leg ${leg.row.oddID} reused from another tier`); }
      seenAcrossTiers.add(leg.row.oddID);
    }
  }
  return { bandsRespected, noOverlap, details };
}

// Mega's and Nuke's own real invariants, checked on whatever's actually in `tiers` (cross-game/SGP/slate all
// share this shape): a successful Mega must have every leg still clear the real 55% floor and its combined
// payout must genuinely reach the +2500 target (never faked/rounded past it); a successful Nuke must have every
// leg genuinely priced at plus money by the book AND still clear that same 55% floor, with at least NUKE_LEGS.
function checkMegaNukeInvariants(tiers, label) {
  const mega = tiers.find(t => t.tier.key === "mega");
  const nuke = tiers.find(t => t.tier.key === "nuke");
  const details = [];
  let ok = true;
  if (mega?.ok) {
    const decimal = mega.legs.reduce((d, l) => d * americanToDecimal(l.price), 1);
    if (decimal < MEGA_TARGET_DECIMAL - 1e-9) { ok = false; details.push(`${label} mega: combined decimal ${decimal.toFixed(2)} is under the +2500 target`); }
    if (mega.legs.length < MEGA_MIN_LEGS) { ok = false; details.push(`${label} mega: only ${mega.legs.length} legs, under MEGA_MIN_LEGS`); }
    if (mega.legs.some(l => l.hitProbability < MIN_LEG_PROBABILITY)) { ok = false; details.push(`${label} mega: a leg is under the 55% floor`); }
  }
  if (nuke?.ok) {
    if (nuke.legs.length < NUKE_LEGS) { ok = false; details.push(`${label} nuke: only ${nuke.legs.length} legs, expected ${NUKE_LEGS}+`); }
    if (nuke.legs.some(l => l.price <= 0 || l.hitProbability < MIN_LEG_PROBABILITY)) { ok = false; details.push(`${label} nuke: a leg isn't genuinely plus-money-and-55%+`); }
  }
  return { ok, details };
}

const crossGameCheck = checkTierSetInvariants(snapshot.parlays, "cross-game");
console.log("Cross-game Low/Medium/High tiers each stay inside their own probability band, with zero legs reused across those three (should be true):",
  crossGameCheck.bandsRespected && crossGameCheck.noOverlap, crossGameCheck.details);
const crossGameMegaNuke = checkMegaNukeInvariants(snapshot.parlays, "cross-game");
console.log("Cross-game Mega (when built) genuinely clears +2500 and Nuke (when built) is genuinely all plus-money-and-55%+ (should be true):",
  crossGameMegaNuke.ok, crossGameMegaNuke.details);

const sameGameParlays = buildSameGameParlays(snapshot.propRows);
const sgpChecks = sameGameParlays.map(g => ({ eventId: g.eventId, ...checkTierSetInvariants(g.tiers, `SGP:${g.eventId}`) }));
const allSgpRespectBandsAndDisjoint = sgpChecks.every(c => c.bandsRespected && c.noOverlap);
console.log("Every Same Game Parlay's Low/Medium/High tiers stay inside their own band with zero reuse among those three (should be true):", allSgpRespectBandsAndDisjoint, sgpChecks.flatMap(c => c.details));
const sgpMegaNukeChecks = sameGameParlays.map(g => checkMegaNukeInvariants(g.tiers, `SGP:${g.eventId}`));
const allSgpMegaNukeValid = sgpMegaNukeChecks.every(c => c.ok);
console.log("Every Same Game Parlay's Mega/Nuke (when built) are genuinely real (should be true):", allSgpMegaNukeValid, sgpMegaNukeChecks.flatMap(c => c.details));

const slateParlays = buildSlateParlays(snapshot.propRows);
const slateChecks = slateParlays.map(s => ({ window: s.window, ...checkTierSetInvariants(s.tiers, `slate:${s.window}`) }));
const allSlatesRespectBandsAndDisjoint = slateChecks.every(c => c.bandsRespected && c.noOverlap);
console.log("Every slate parlay's Low/Medium/High tiers stay inside their own band with zero reuse among those three (should be true):", allSlatesRespectBandsAndDisjoint, slateChecks.flatMap(c => c.details));
const slateMegaNukeChecks = slateParlays.map(s => checkMegaNukeInvariants(s.tiers, `slate:${s.window}`));
const allSlateMegaNukeValid = slateMegaNukeChecks.every(c => c.ok);
console.log("Every slate parlay's Mega/Nuke (when built) are genuinely real (should be true):", allSlateMegaNukeValid, slateMegaNukeChecks.flatMap(c => c.details));

// The cross-game pool draws from every demo event, each contributing real legs deliberately placed in every one
// of the four bands (see demoData.js's fillerGame) — so unlike a single game's own SGP, it should be able to
// fill EVERY tier, each with the exact leg count that tier's RISK_TIERS entry calls for.
const crossGameFillsEveryTier = RISK_TIERS.every((tier, i) => snapshot.parlays[i].ok && snapshot.parlays[i].tier.key === tier.key && snapshot.parlays[i].legs.length === tier.legs);
console.log("The cross-game pool fills every tier at its real leg count, drawing from disjoint probability bands (should be true):", crossGameFillsEveryTier,
  snapshot.parlays.map(p => p.ok ? `${p.tier.key}:${p.legs.length}` : `${p.tier.key}:fail(${p.reason})`));

// A single filler game only ever contributes 2 real legs per band (see demoData.js) — never enough on its own
// to fill a 3-4-leg Low/Medium/High tier — so every filler game's own SGP should honestly fail all three of
// those, exactly the point the design note on RISK_TIERS in parlays.js makes about single-game pools being
// unrealistic for full coverage. Mega is EXPECTED to behave differently now: it draws from the whole real pool
// across every band at once, so a game with enough total real legs (even split thin across bands) can still
// stack its way to a real Mega parlay — that's the new design working as intended, not a regression.
const demo5Sgp = sameGameParlays.find(g => g.eventId === "demo-5");
const demo5BandedTiers = demo5Sgp?.tiers.filter(t => ["low", "medium", "high"].includes(t.tier.key)) || [];
const sgpReportsShortfallHonestly = demo5BandedTiers.length === 3 &&
  demo5BandedTiers.every(t => t.ok === false && /are in the .*% range|per game keeps this/.test(t.reason));
console.log("A single filler game's SGP honestly fails Low/Medium/High rather than borrowing legs from another band (should be true):",
  sgpReportsShortfallHonestly, demo5BandedTiers.map(t => t.reason));
const demo5MegaCanPoolAcrossBands = demo5Sgp?.tiers.find(t => t.tier.key === "mega")?.ok === true;
console.log("That same filler game's Mega CAN still build by pooling real legs across every band at once (should be true, confirming the new design intent):", demo5MegaCanPoolAcrossBands);

// The Sunday slate windows pool TWO games each (demo-1b+demo-2 for 1:00pm, demo-3+demo-4 for 4:00pm), each
// contributing 2 real legs per band — 4 per band per window, exactly enough to fill every tier by drawing from
// more than one game (never a single team's SGP in disguise).
const earlySlate = slateParlays.find(s => s.window === "sun_early");
const lateSlate = slateParlays.find(s => s.window === "sun_late");
const slateGameCountsAreCorrect = earlySlate?.games === 3 && lateSlate?.games === 2; // sun_early: demo-1 + demo-1b + demo-2
const slateFillsEveryTierAcrossGames = RISK_TIERS.every(tier => {
  const t = earlySlate.tiers.find(x => x.tier.key === tier.key);
  return t?.ok && t.legs.length === tier.legs && new Set(t.legs.map(l => l.gameKey)).size >= 2;
});
const lateSlateFillsEveryTierAcrossGames = RISK_TIERS.every(tier => {
  const t = lateSlate.tiers.find(x => x.tier.key === tier.key);
  return t?.ok && t.legs.length === tier.legs && new Set(t.legs.map(l => l.gameKey)).size >= 2;
});
const thursdayGameNeverJoinsASlate = slateParlays.every(s => s.tiers.every(t => !t.ok || t.legs.every(l => l.gameKey !== "demo-5")));
console.log("Each Sunday slate window sees the right number of games (should be true):", slateGameCountsAreCorrect, `early=${earlySlate?.games} late=${lateSlate?.games}`);
console.log("The 1:00pm slate fills every tier, drawing legs from more than one game per tier (should be true):", slateFillsEveryTierAcrossGames,
  earlySlate?.tiers.map(t => t.ok ? `${t.tier.key}:${t.legs.length}(${new Set(t.legs.map(l => l.gameKey)).size} games)` : `${t.tier.key}:fail`));
console.log("The 4:00pm slate fills every tier, drawing legs from more than one game per tier (should be true):", lateSlateFillsEveryTierAcrossGames,
  lateSlate?.tiers.map(t => t.ok ? `${t.tier.key}:${t.legs.length}(${new Set(t.legs.map(l => l.gameKey)).size} games)` : `${t.tier.key}:fail`));
console.log("The Thursday-night game never gets pooled into a Sunday slate (should be true):", thursdayGameNeverJoinsASlate);

// MIN_LEG_PROBABILITY must equal High's own floor by construction — Low/Medium/High still form one continuous,
// non-overlapping range from that real floor up to "almost guaranteed." Mega/Nuke are no longer part of this
// ladder (see parlays.js's own comment on why) — checked on their own terms above instead.
const tierLadderIsContinuous = MIN_LEG_PROBABILITY === RISK_TIERS.find(t => t.key === "high").minProb &&
  RISK_TIERS.every((t, i) => i === 0 || t.maxProb === RISK_TIERS[i - 1].minProb);
console.log("Low/Medium/High form one continuous, non-overlapping probability ladder (should be true):", tierLadderIsContinuous, RISK_TIERS.map(t => `${t.key}:[${t.minProb},${t.maxProb})`));

console.log("Any team mismatch in demo data (should be false):", anyMismatch);
console.log("At least one prop resolved a real factor (should be true):", anyRealFactor);
console.log("Every expected factor key present on a prop row (should be true):", missing.length === 0, missing.length ? `MISSING: ${missing.join(", ")}` : "");
console.log("Red-zone share factor computed at least once (should be true):", anyRedZone);
console.log("Defense-vs-position factor computed at least once (should be true):", anyDefense);
console.log("EPA matchup-edge factor computed at least once on a prop (should be true):", anyMatchupEdge);
console.log("Scoring-environment factor computed at least once (should be true):", anyScoringEnv);

// New coefficients must actually be present (not just referenced) in MODEL_COEFFS — a nudge silently falling
// back to `|| 0` because the coefficient was never added would pass every test above for the wrong reason.
const newCoeffsPresent = ["weather_personal_boost", "weather_personal_penalty", "weather_run_favor", "weather_pass_penalty",
  "venue_edge", "practice_trend_down", "practice_trend_up", "front_seven_injury", "game_script_run_favor", "game_script_pass_favor",
  "referee_over_lean", "referee_under_lean", "ngs_cpoe_hot", "ngs_cpoe_cold", "ngs_ryoe_hot", "ngs_ryoe_cold",
  "ngs_separation_hot", "pressure_risk_penalty", "clean_pocket_boost", "qbr_trend_elite", "qbr_trend_poor"].every(k => typeof MODEL_COEFFS[k] === "number");
console.log("Every new hand-set coefficient is present in MODEL_COEFFS (should be true):", newCoeffsPresent);

if (anyMismatch || !anyRealFactor || missing.length || !anyRedZone || !anyDefense || !anyMatchupEdge || !anyScoringEnv || !anyAnytimeTd || !anytimeTdKeptOnlyYesNo || !mahomesTdHitRateIsZero || !recYdsRateIsCorrect || !tdPropGradesAgainstRealLine || !last10ShapeIsCorrect || !last3IsCurrentSeasonOnly || !rate10IsCorrect || !mahomesTendencyIsSkipped || !anyParlayHasAlternates || !widerBookCoverageWorks || !secondaryInjuryWorks || !venueSplitIsRealStat || !venueNudgeFiresOnRealRow ||
  !redZoneShareIsReal || !modelShapeIsSane || !outOverrideWorks || !thinSampleStaysNearMarket || !deepSampleMovesFurther || !weatherNudgesWork || !venueNudgeWorks || !practiceTrendWorks || !steamMagnitudeScalingWorks || !frontSevenInjuryFactorWorks || !frontSevenNudgeFires || !gameContextIsCorrect || !noOddsContextWorks || !stringPayloadNudgeWorks || !gameScriptWorks || !gameScriptNudgesWork || !staleVsSuspectWorks || !anySuspectOrStaleFieldPresent || !mispricedSortedByTrueEdge || !mispricedAllClearBar || !gradingWorks || !clvWorks || !ledgerMathIsCorrect || !ledgerClvIsCorrect || !regradeGuardWorks || !edgeBoardHistoryWorks || !edgeBoardLimitWorks ||
  !rosterIndexPicksLatestWeek || !depthChartIndexWorks || !resolvePlayerPrefersDepthChartOnConflict || !noConflictWhenBothSourcesAgree || !keyTeammateUsesDepthChartRank || !keyTeammateStillSkipsQb || !anyPropHasDepthChartRole || !rosterConflictsStatIsPresent || !oddsResilienceWorks || !aiConcurrencyWorks ||
  !aiSelectionWorks || !cacheLoosening || !costEstimatesAreCorrect || !spendGuardCapWorks || !rolloverWorks || !scoutingThrottleWorks || !newCoeffsPresent ||
  !dstSafetyWorks || !demoEventWindowsAreCorrect || !allSgpRespectBandsAndDisjoint || !allSlatesRespectBandsAndDisjoint || !crossGameFillsEveryTier || !sgpReportsShortfallHonestly ||
  !crossGameMegaNuke.ok || !allSgpMegaNukeValid || !allSlateMegaNukeValid || !demo5MegaCanPoolAcrossBands ||
  !slateGameCountsAreCorrect || !slateFillsEveryTierAcrossGames || !lateSlateFillsEveryTierAcrossGames || !thursdayGameNeverJoinsASlate || !tierLadderIsContinuous ||
  !topPicksBasicsWork || !emptyCategoryHandledCleanly || !negativeContributorExcludedAndRankedByWeight || !fallbackFillsToMinimum || !blurbIsWellFormed ||
  !teammateTendencyGatesOnCurrentStatus || !escalationWatchWorksCorrectly || !emptyEscalationsOnNoHistory ||
  !refereeFactorWorks || !ngsFactorsWork || !pressureFactorWorks || !qbrFactorWorks) {
  console.log("\nFAILED — see above.");
  process.exit(1);
} else {
  console.log("\nOK — pipeline logic checks out: full offensive matchup analytics, player-prop-Overs-only scope, and disjoint-probability-band parlay tiers all confirmed.");
}
