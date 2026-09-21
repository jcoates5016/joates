// Read-only, purely for curiosity: for a given day's games (default: yesterday), shows which actual Edge Board
// recommendations hit, what the app's own saved parlay attempts did, and — as a hindsight "what if" number only,
// NOT a real strategy — what combining every recommended pick that hit into one single giant parlay would have
// paid out. Writes nothing.
//
// Why "combine everything" is the real answer to "what combination profits the most": for a fixed stake, a
// parlay's payout is the product of every leg's decimal odds. Every leg that actually hit has decimal odds > 1,
// so multiplying in one more winning leg always increases the payout — there's no subset of winners that pays
// more than ALL of them combined. The only real question is how big that number actually was, not which legs to
// pick. (Real sportsbooks may restrict combining certain correlated/same-game legs into one ticket in practice —
// this script ignores that and just does the math on every winning leg's own captured price.)
//
// Usage:
//   NETLIFY_SITE_ID=... NETLIFY_BLOBS_TOKEN=... node scripts/analyze-yesterday.js [YYYY-MM-DD] [stake]
// Defaults to yesterday (UTC date) and a $100 stake. Kickoff times are stored as UTC ISO timestamps, so a late
// Sunday-night game (~8:20pm ET) can fall on the UTC-Monday date — pass an explicit date if the default looks
// like it's missing a game you expected.
import { getStore } from "@netlify/blobs";
import { americanToDecimal, decimalToAmerican } from "../lib/oddsMath.js";

function store(name) {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  if (!siteID || !token) throw new Error("Missing NETLIFY_SITE_ID / NETLIFY_BLOBS_TOKEN in the environment.");
  return getStore({ name, siteID, token });
}

function fmtOdds(american) {
  if (american == null) return "n/a";
  return american > 0 ? `+${american}` : `${american}`;
}

async function main() {
  const dateArg = process.argv[2];
  const stakeArg = Number(process.argv[3]);
  const stake = isNaN(stakeArg) ? 100 : stakeArg;
  const targetDateStr = dateArg || new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);

  const history = store("apex-edge-history");
  const { blobs: picksBlobs } = await history.list({ prefix: "picks-" });
  const { blobs: parlaysBlobs } = await history.list({ prefix: "parlays-" });

  const picksForDay = [];
  for (const { key } of picksBlobs) {
    const picks = (await history.get(key, { type: "json" })) || [];
    for (const p of picks) {
      if (!p.graded || !p.kickoff) continue;
      if (p.kickoff.slice(0, 10) === targetDateStr) picksForDay.push(p);
    }
  }

  const parlaysForDay = [];
  for (const { key } of parlaysBlobs) {
    const parlays = (await history.get(key, { type: "json" })) || [];
    for (const p of parlays) {
      if (!p.kickoff) continue;
      if (p.kickoff.slice(0, 10) === targetDateStr) parlaysForDay.push(p);
    }
  }

  console.log(`Analyzing games on ${targetDateStr} (UTC date, from stored kickoff timestamps).`);
  console.log(`${picksForDay.length} graded prop pick(s), ${parlaysForDay.length} saved parlay attempt(s) with a leg kicking off that day.\n`);

  const recommended = picksForDay.filter(p => p.wasEdgeBoard);
  const recHits = recommended.filter(p => p.hit);

  console.log(`--- Actual Edge Board recommendations for ${targetDateStr} ---`);
  if (!recommended.length) {
    console.log("  None — no picks cleared the real edge bar for this day's games.");
  } else {
    console.log(`  ${recHits.length}/${recommended.length} hit.`);
    for (const p of recommended) {
      console.log(`  ${p.hit ? "HIT " : "MISS"} ${p.player} — ${p.propLabel} ${p.side || ""} ${p.line ?? ""} @ ${fmtOdds(p.pickPrice)} (${p.pickBook || "?"})`);
    }
  }

  console.log(`\n--- Saved parlay attempts for ${targetDateStr} ---`);
  if (!parlaysForDay.length) {
    console.log("  None.");
  } else {
    for (const p of parlaysForDay) {
      const status = p.graded ? (p.hit ? "HIT " : "MISS") : "PENDING";
      console.log(`  ${status} ${p.tierLabel} (${p.contextLabel}) — ${p.legs.length} legs, combined ${fmtOdds(p.combinedAmerican)}`);
    }
  }

  const withPrice = recHits.filter(p => p.pickPrice != null);
  console.log(`\n--- Theoretical max: every recommended pick that hit (${withPrice.length} of them had a captured price), combined into one parlay ---`);
  if (withPrice.length < 2) {
    console.log("  Not enough recommended hits with a captured price to build a meaningful combined example.");
  } else {
    const combinedDecimal = withPrice.reduce((acc, p) => acc * americanToDecimal(p.pickPrice), 1);
    const payout = stake * combinedDecimal;
    const profit = payout - stake;
    console.log(`  Combined decimal odds: ${combinedDecimal.toFixed(2)}x (~${fmtOdds(decimalToAmerican(combinedDecimal))} American)`);
    console.log(`  A $${stake} bet on all ${withPrice.length} legs together would have returned $${payout.toFixed(2)} (profit: $${profit.toFixed(2)}).`);
    console.log(`  NOTE: hindsight only — not a real strategy or a recommendation to actually parlay everything.`);
    console.log(`  Real books may restrict combining certain correlated/same-game legs into one ticket; this is pure math on the captured prices.`);
  }
}

main().catch(e => { console.error("Failed:", e); process.exit(1); });
