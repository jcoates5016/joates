// Read-only: looks up every saved prop for one or more named players on a given date, across ALL prop types
// (not just recommendations), and shows the full picture of why each one was or wasn't an Edge Board
// recommendation. Useful for "player X had a good matchup, why wasn't he flagged" questions.
//
// Note on what this CAN'T show: lib/pipeline.js's buildGradablePicks computes wasEdgeBoard from trueEdge,
// confidence, teamMismatch, and suspect — but only trueEdge/confidence get saved to the ledger. teamMismatch
// and suspect are checked in memory and then thrown away, so if a prop was excluded specifically because of
// one of those two flags, this script can't see that directly. It also can't show anything for a player whose
// prop never made it into the ledger at all that day (missing trailing-form data, unresolved player identity,
// or the model marking it unavailable) — those props never reach buildGradablePicks in the first place, so
// there's no saved row to find. If a name you search for prints nothing at all, that's the likely explanation,
// not a bug in this script.
//
// Usage:
//   NETLIFY_SITE_ID=... NETLIFY_BLOBS_TOKEN=... node scripts/lookup-players.js [YYYY-MM-DD] "Player Name" ["Other Player"...]
import { getStore } from "@netlify/blobs";

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
function pctv(n) { return n == null ? "n/a" : `${(n * 100).toFixed(1)}%`; }

async function main() {
  const args = process.argv.slice(2);
  let targetDateStr = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  if (args[0] && /^\d{4}-\d{2}-\d{2}$/.test(args[0])) targetDateStr = args.shift();
  const names = args.map(n => n.toLowerCase());
  if (!names.length) {
    console.error('Usage: node scripts/lookup-players.js [YYYY-MM-DD] "Player Name" ["Other Player"...]');
    process.exit(1);
  }

  const history = store("apex-edge-history");
  const { blobs: picksBlobs } = await history.list({ prefix: "picks-" });

  const found = [];
  for (const { key } of picksBlobs) {
    const picks = (await history.get(key, { type: "json" })) || [];
    for (const p of picks) {
      if (!p.kickoff || p.kickoff.slice(0, 10) !== targetDateStr) continue;
      const nameLower = (p.player || "").toLowerCase();
      if (names.some(n => nameLower.includes(n))) found.push(p);
    }
  }

  console.log(`Searching ${targetDateStr} for: ${names.join(", ")}`);
  console.log(`Found ${found.length} saved prop row(s) across all prop types (not just recommendations).\n`);

  if (!found.length) {
    console.log("None found. Most likely explanation: their props never made it into the saved ledger that day —");
    console.log("buildGradablePicks only saves a row when the model had usable data, trailing-form stats were");
    console.log("available, AND the player's identity resolved cleanly. If any of those failed, there's no row to");
    console.log("show, regardless of whether the matchup looked favorable on paper.");
    return;
  }

  const byPlayer = new Map();
  for (const p of found) {
    if (!byPlayer.has(p.player)) byPlayer.set(p.player, []);
    byPlayer.get(p.player).push(p);
  }

  for (const [player, rows] of byPlayer) {
    console.log(`=== ${player} ===`);
    for (const p of rows) {
      console.log(
        `  ${p.propType} — ${p.propLabel} ${p.side || ""} ${p.line ?? ""} vs ${p.opponent || "?"}\n` +
        `    modelProb: ${pctv(p.modelProb)}   marketProb: ${pctv(p.marketProb)}   edge: ${p.edge != null ? (p.edge * 100).toFixed(1) + "pt" : "n/a"}   confidence: ${p.confidence || "unknown"}\n` +
        `    wasEdgeBoard: ${p.wasEdgeBoard}   price: ${fmtOdds(p.pickPrice)} (${p.pickBook || "?"})   graded: ${p.graded}   hit: ${p.hit}`
      );
    }
    console.log("");
  }
}

main().catch(e => { console.error("Failed:", e); process.exit(1); });