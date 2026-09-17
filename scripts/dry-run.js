// Runs the full pipeline against the demo dataset — no API keys needed. Confirms every factor category at
// least runs without throwing, and prints a self-check summary.
import { runPipeline } from "../lib/pipeline.js";
import { estimatePropProbability } from "../lib/probability.js";
import { gradeCompletedPicks, foldIntoLedger, summarizeLedger } from "../lib/grading.js";
import { buildRosterIndex, buildDepthChartIndex, resolvePlayer } from "../lib/identity.js";
import { findKeyTeammate } from "../lib/factors/index.js";
import { buildDemoData } from "../lib/demoData.js";
import { fetchNFLEvents } from "../lib/fetchers/odds.js";
import { annotateGameLinesWithAI } from "../lib/ai.js";

const SEASON = 2026;

const snapshot = await runPipeline({
  demo: true, currentSeason: SEASON, historySeasons: [SEASON, SEASON - 1, SEASON - 2],
  selectedWeek: 5, situationalNotes: [], aiOn: false, scoutOn: false
});

console.log("=== STATS ===");
console.log(JSON.stringify(snapshot.stats, null, 2));

console.log("\n=== SAMPLE PROP (full factor dump) ===");
console.log(JSON.stringify(snapshot.propRows[0], null, 2));

console.log("\n=== SAMPLE GAME LINE (full factor dump) ===");
console.log(JSON.stringify(snapshot.gameLines[0], null, 2));

console.log("\n=== MISPRICED COUNT ===", snapshot.mispriced.length);
console.log("\n=== PARLAYS ===");
snapshot.parlays.forEach(p => console.log(`${p.tier.label} -> ${p.ok ? `${p.legs.length} legs, ${p.combinedAmerican}` : p.reason}`));

console.log("\n=== LOGS ===");
snapshot.logs.forEach(l => console.log(l.msg));

const factorKeys = Object.keys(snapshot.propRows[0].factors || {});
const expected = ["form", "tendency", "venue", "weatherHistorical", "weatherForecast", "birthday",
  "usage", "redZone", "twoMinute", "defense", "matchupEdge", "scoringEnvironment", "secondaryInjury", "schedule",
  "starterChange", "referee", "selfInjury", "oLineInjury", "practiceTrend", "marketMovement", "situationalNote"];
const missing = expected.filter(k => !factorKeys.includes(k));
const anyGameLineIsNotTotal = snapshot.gameLines.some(r => r.market !== "Total");

console.log("\n=== SELF-CHECK ===");
const anyMismatch = snapshot.propRows.some(r => r.teamMismatch);
const anyRealFactor = snapshot.propRows.some(r => Object.values(r.factors).some(f => f && (f.available || (Array.isArray(f) && f.length))));
const anyRedZone = snapshot.propRows.some(r => r.factors.redZone?.available);
const anyDefense = snapshot.propRows.some(r => r.factors.defense?.available);
const anyMatchupEdge = snapshot.propRows.some(r => r.factors.matchupEdge?.available);
const anyScoringEnv = snapshot.propRows.some(r => r.factors.scoringEnvironment?.available);
const anyGameLineMatchupEdge = snapshot.gameLines.some(r => r.factors?.matchupEdge?.homeOffVsAwayDef?.available || r.factors?.matchupEdge?.awayOffVsHomeDef?.available);

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
const wrRecYdsRow = snapshot.propRows.find(r => r.propType === "rec_yds");
const recYdsRateIsCorrect = wrRecYdsRow ? Math.abs((wrRecYdsRow.factors?.form?.rate_last3 ?? -1) - (1 / 3)) < 0.001 : false;
console.log("Yardage prop hit rate is graded against the real line, not '> 0' (should be true):", recYdsRateIsCorrect, wrRecYdsRow?.line, wrRecYdsRow?.factors?.form);

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
// collectAutoPrices -> computeBestAcrossBooks, not just sitting unused in the payload.
const mahomesPassTd = snapshot.propRows.find(r => r.propType === "td_pass" && r.player === "Patrick Mahomes");
const widerBookCoverageWorks = mahomesPassTd?.bestBook === "fanduel";
console.log("A non-DK/theScore-Bet book (FanDuel) can win best price now that more books are tracked (should be true):", widerBookCoverageWorks, mahomesPassTd?.bestBook, mahomesPassTd?.prices);

// Regression guard for the opposing-secondary-injury factor: BUF (this event's opponent for every KC player)
// has 2 demo CB/S injuries on record. Both a passing-yards prop and a receiving-yards prop against BUF should
// see it; a rushing prop never should (gated out entirely in factors/index.js).
const secondaryInjuryWorks = mahomesPassTd?.factors?.secondaryInjury?.available === true && mahomesPassTd.factors.secondaryInjury.count === 2 &&
  wrRecYdsRow?.factors?.secondaryInjury?.available === true && wrRecYdsRow.factors.secondaryInjury.count === 2;
console.log("Opposing-secondary-injury factor resolves for passing/receiving props (should be true):", secondaryInjuryWorks, mahomesPassTd?.factors?.secondaryInjury, wrRecYdsRow?.factors?.secondaryInjury);

// Regression guard for generalizing the venue split to the real per-prop stat: before this fix, computeVenueSplit
// always measured (receiving+rushing yards) regardless of prop, so a QB's indoor/outdoor split on a passing-yards
// prop was measuring the wrong stat entirely (near-zero either way). Mahomes's demo dome games (weeks 1-4, avg
// 245 passing yards) vs. his outdoor games (weeks 5-7, avg 330) should show a real, correctly-labeled gap now.
const mahomesPassYds = snapshot.propRows.find(r => r.propType === "pass_yds" && r.player === "Patrick Mahomes");
const mahomesVenue = mahomesPassYds?.factors?.venue;
const venueSplitIsRealStat = mahomesVenue?.available === true && mahomesVenue.statLabel === "passing yards" &&
  mahomesVenue.outdoorN >= 2 && mahomesVenue.domeN >= 2 && mahomesVenue.outdoorAvg > mahomesVenue.domeAvg + 50;
console.log("Venue split uses the real per-prop stat, not always receiving+rushing yards (should be true):", venueSplitIsRealStat, mahomesVenue);

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
    graded: false, hit: null, actualValue: null, gradedAt: null },
  { oddID: "miss-1", kind: "prop", player: "Demo Grader", playerKey: "demo grader", propType: "receptions", line: 7.5, side: "over",
    kickoff: "2026-10-05T17:00:00Z", season: 2026, week: 5, modelProb: 0.58, marketProb: 0.50, edge: 0.08, confidence: "medium",
    graded: false, hit: null, actualValue: null, gradedAt: null },
  { oddID: "too-soon-1", kind: "prop", player: "Demo Grader", playerKey: "demo grader", propType: "rec_yds", line: 59.5, side: "over",
    kickoff: "2026-10-10T06:00:00Z", season: 2026, week: 5, modelProb: 0.6, marketProb: 0.5, edge: 0.1, confidence: "medium",
    graded: false, hit: null, actualValue: null, gradedAt: null }
];
const gradedNow = gradeCompletedPicks(syntheticPicks, syntheticGameLog, now);
const gradingWorks = gradedNow.length === 2 && // the too-soon pick (kicked off 6h before `now`, under the 20h delay) must stay ungraded
  syntheticPicks.find(p => p.oddID === "hit-1")?.hit === true && syntheticPicks.find(p => p.oddID === "hit-1")?.actualValue === 90 &&
  syntheticPicks.find(p => p.oddID === "miss-1")?.hit === false &&
  syntheticPicks.find(p => p.oddID === "too-soon-1")?.graded !== true;
console.log("Grading correctly marks a real hit and a real miss, and leaves a too-recent game ungraded (should be true):", gradingWorks, syntheticPicks);

const ledger = {};
foldIntoLedger(ledger, gradedNow);
const summary = summarizeLedger(ledger);
const ledgerMathIsCorrect = summary.hasData && summary.totals.attempts === 2 && summary.totals.hits === 1 &&
  Math.abs(summary.totals.hitRate - 0.5) < 0.0001 && summary.byConfidence.high?.attempts === 1 && summary.byConfidence.medium?.attempts === 1;
console.log("Calibration ledger folds graded picks into correct totals + confidence buckets (should be true):", ledgerMathIsCorrect, summary);
// Re-folding the same graded picks a second time must never happen in the live pipeline (gradeCompletedPicks
// skips anything already marked graded) — proving that guard actually holds, since a double-fold would silently
// double-count every historical result.
const regradedNow = gradeCompletedPicks(syntheticPicks, syntheticGameLog, now);
const regradeGuardWorks = regradedNow.length === 0;
console.log("Already-graded picks are never re-graded on a later pass (should be true):", regradeGuardWorks);

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
  const fakeResults = Array.from({ length: 20 }, (_, i) => ({ id: i, tag: "pass", note: "synthetic test note" }));
  return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify(fakeResults) }] }) };
};
// 25 rows at annotateGameLinesWithAI's batch size of 20 makes exactly 2 batches — enough to prove they overlap.
const syntheticGameLines = Array.from({ length: 25 }, (_, i) => ({
  oddID: `gl-${i}`, matchup: "Demo Away @ Demo Home", market: "Total", side: "over 47.5",
  bestEdge: 0.05, bestPrice: -110, bestBook: "draftkings", prices: {}, suspect: false, factors: {}
}));
await annotateGameLinesWithAI(syntheticGameLines, "fake-key", {}, () => {});
globalThis.fetch = realAiFetch;
const aiConcurrencyWorks = aiCallCount === 2 && aiMaxConcurrent >= 2;
console.log("AI annotation batches run concurrently, not strictly one-at-a-time (should be true):", aiConcurrencyWorks, `calls=${aiCallCount} maxConcurrent=${aiMaxConcurrent}`);

console.log("Any team mismatch in demo data (should be false):", anyMismatch);
console.log("At least one prop resolved a real factor (should be true):", anyRealFactor);
console.log("Every expected factor key present on a prop row (should be true):", missing.length === 0, missing.length ? `MISSING: ${missing.join(", ")}` : "");
console.log("Red-zone share factor computed at least once (should be true):", anyRedZone);
console.log("Defense-vs-position factor computed at least once (should be true):", anyDefense);
console.log("EPA matchup-edge factor computed at least once on a prop (should be true):", anyMatchupEdge);
console.log("EPA matchup-edge factor computed at least once on a game line (should be true):", anyGameLineMatchupEdge);
console.log("Scoring-environment factor computed at least once (should be true):", anyScoringEnv);
console.log("Every game line is a Total (no Moneyline/Spread) (should be true):", !anyGameLineIsNotTotal);

if (anyMismatch || !anyRealFactor || missing.length || !anyRedZone || !anyDefense || !anyMatchupEdge || !anyGameLineMatchupEdge || !anyScoringEnv || anyGameLineIsNotTotal || !anyAnytimeTd || !anytimeTdKeptOnlyYesNo || !mahomesTdHitRateIsZero || !recYdsRateIsCorrect || !last10ShapeIsCorrect || !last3IsCurrentSeasonOnly || !rate10IsCorrect || !mahomesTendencyIsSkipped || !anyParlayHasAlternates || !widerBookCoverageWorks || !secondaryInjuryWorks || !venueSplitIsRealStat ||
  !redZoneShareIsReal || !modelShapeIsSane || !outOverrideWorks || !thinSampleStaysNearMarket || !deepSampleMovesFurther || !mispricedSortedByTrueEdge || !mispricedAllClearBar || !gradingWorks || !ledgerMathIsCorrect || !regradeGuardWorks ||
  !rosterIndexPicksLatestWeek || !depthChartIndexWorks || !resolvePlayerPrefersDepthChartOnConflict || !noConflictWhenBothSourcesAgree || !keyTeammateUsesDepthChartRank || !keyTeammateStillSkipsQb || !anyPropHasDepthChartRole || !rosterConflictsStatIsPresent || !oddsResilienceWorks || !aiConcurrencyWorks) {
  console.log("\nFAILED — see above.");
  process.exit(1);
} else {
  console.log("\nOK — pipeline logic checks out: full offensive + defensive matchup analytics, Totals-Overs + player-prop-Overs scope confirmed.");
}
