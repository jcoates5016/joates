// Runs the full pipeline against the demo dataset — no API keys needed. Confirms every factor category at
// least runs without throwing, and prints a self-check summary.
import { runPipeline } from "../lib/pipeline.js";

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

console.log("Any team mismatch in demo data (should be false):", anyMismatch);
console.log("At least one prop resolved a real factor (should be true):", anyRealFactor);
console.log("Every expected factor key present on a prop row (should be true):", missing.length === 0, missing.length ? `MISSING: ${missing.join(", ")}` : "");
console.log("Red-zone share factor computed at least once (should be true):", anyRedZone);
console.log("Defense-vs-position factor computed at least once (should be true):", anyDefense);
console.log("EPA matchup-edge factor computed at least once on a prop (should be true):", anyMatchupEdge);
console.log("EPA matchup-edge factor computed at least once on a game line (should be true):", anyGameLineMatchupEdge);
console.log("Scoring-environment factor computed at least once (should be true):", anyScoringEnv);
console.log("Every game line is a Total (no Moneyline/Spread) (should be true):", !anyGameLineIsNotTotal);

if (anyMismatch || !anyRealFactor || missing.length || !anyRedZone || !anyDefense || !anyMatchupEdge || !anyGameLineMatchupEdge || !anyScoringEnv || anyGameLineIsNotTotal || !anyAnytimeTd || !anytimeTdKeptOnlyYesNo || !mahomesTdHitRateIsZero || !recYdsRateIsCorrect || !last10ShapeIsCorrect || !last3IsCurrentSeasonOnly || !rate10IsCorrect || !mahomesTendencyIsSkipped || !anyParlayHasAlternates || !widerBookCoverageWorks || !secondaryInjuryWorks || !venueSplitIsRealStat) {
  console.log("\nFAILED — see above.");
  process.exit(1);
} else {
  console.log("\nOK — pipeline logic checks out: full offensive + defensive matchup analytics, Totals-Overs + player-prop-Overs scope confirmed.");
}
