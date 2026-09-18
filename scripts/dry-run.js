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
  "usage", "redZone", "twoMinute", "defense", "matchupEdge", "scoringEnvironment", "schedule", "starterChange",
  "referee", "selfInjury", "oLineInjury", "practiceTrend", "marketMovement", "situationalNote"];
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

console.log("Any team mismatch in demo data (should be false):", anyMismatch);
console.log("At least one prop resolved a real factor (should be true):", anyRealFactor);
console.log("Every expected factor key present on a prop row (should be true):", missing.length === 0, missing.length ? `MISSING: ${missing.join(", ")}` : "");
console.log("Red-zone share factor computed at least once (should be true):", anyRedZone);
console.log("Defense-vs-position factor computed at least once (should be true):", anyDefense);
console.log("EPA matchup-edge factor computed at least once on a prop (should be true):", anyMatchupEdge);
console.log("EPA matchup-edge factor computed at least once on a game line (should be true):", anyGameLineMatchupEdge);
console.log("Scoring-environment factor computed at least once (should be true):", anyScoringEnv);
console.log("Every game line is a Total (no Moneyline/Spread) (should be true):", !anyGameLineIsNotTotal);

if (anyMismatch || !anyRealFactor || missing.length || !anyRedZone || !anyDefense || !anyMatchupEdge || !anyGameLineMatchupEdge || !anyScoringEnv || anyGameLineIsNotTotal || !anyAnytimeTd || !anytimeTdKeptOnlyYesNo || !mahomesTdHitRateIsZero) {
  console.log("\nFAILED — see above.");
  process.exit(1);
} else {
  console.log("\nOK — pipeline logic checks out: full offensive + defensive matchup analytics, Totals-Overs + player-prop-Overs scope confirmed.");
}
