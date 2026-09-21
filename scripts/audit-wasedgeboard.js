// Read-only: measures how many saved picks in the ENTIRE history have wasEdgeBoard sitting as undefined —
// neither true nor false — which happens when a pick's very first save never got a real value for that field,
// and lib/pipeline.js's merge logic (`if (existing) p.wasEdgeBoard = existing.wasEdgeBoard;`) then blindly
// copies that undefined forward on every later refresh forever, regardless of what the fresh calculation would
// say. Since the Edge Board only ever shows picks where wasEdgeBoard is truthy, an undefined pick behaves
// exactly like a rejected one even if it should have been a real recommendation.
//
// For every undefined pick, this script also recomputes what wasEdgeBoard WOULD be today using the two fields
// that ARE saved (edge, confidence) and the current minEdgeFor() rule — it can't recover teamMismatch/suspect
// since those were never persisted, so this recomputation is an approximation, not a guaranteed-accurate
// backfill. It's here to size the problem, not to silently fix it.
//
// Usage:
//   NETLIFY_SITE_ID=... NETLIFY_BLOBS_TOKEN=... node scripts/audit-wasedgeboard.js
import { getStore } from "@netlify/blobs";

function store(name) {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  if (!siteID || !token) throw new Error("Missing NETLIFY_SITE_ID / NETLIFY_BLOBS_TOKEN in the environment.");
  return getStore({ name, siteID, token });
}

const MIN_TRUE_EDGE = 0.03;
const MIN_TRUE_EDGE_TD = 0.15;
function minEdgeFor(propType) { return propType === "td" ? MIN_TRUE_EDGE_TD : MIN_TRUE_EDGE; }

function pct(n, d) { return d ? `${(100 * n / d).toFixed(1)}%` : "n/a"; }

async function main() {
  const history = store("apex-edge-history");
  const { blobs: picksBlobs } = await history.list({ prefix: "picks-" });

  let total = 0, wasTrue = 0, wasFalse = 0, wasUndefined = 0;
  const undefinedButShouldBeTrue = [];

  for (const { key } of picksBlobs) {
    const picks = (await history.get(key, { type: "json" })) || [];
    for (const p of picks) {
      if (!p.graded) continue; // only count picks that actually resolved
      total++;
      if (p.wasEdgeBoard === true) wasTrue++;
      else if (p.wasEdgeBoard === false) wasFalse++;
      else {
        wasUndefined++;
        const recomputed = p.edge > minEdgeFor(p.propType) && ["medium", "high"].includes(p.confidence);
        if (recomputed) {
          undefinedButShouldBeTrue.push(p);
        }
      }
    }
  }

  console.log(`Total graded picks in history: ${total}`);
  console.log(`  wasEdgeBoard === true:      ${wasTrue} (${pct(wasTrue, total)})`);
  console.log(`  wasEdgeBoard === false:     ${wasFalse} (${pct(wasFalse, total)})`);
  console.log(`  wasEdgeBoard === undefined: ${wasUndefined} (${pct(wasUndefined, total)})  <- the bug's blast radius`);

  console.log(`\nOf the ${wasUndefined} undefined picks, ${undefinedButShouldBeTrue.length} would recompute as a real recommendation`);
  console.log(`today (edge clears minEdgeFor for their prop type AND confidence is medium/high) — these are the`);
  console.log(`likely-missed real recommendations. NOTE: can't check teamMismatch/suspect since those were never`);
  console.log(`saved, so a small number of these could still have been correctly excluded for other reasons.`);

  if (undefinedButShouldBeTrue.length) {
    const hits = undefinedButShouldBeTrue.filter(p => p.hit).length;
    console.log(`\nOf those likely-missed recommendations: ${hits}/${undefinedButShouldBeTrue.length} hit (${pct(hits, undefinedButShouldBeTrue.length)}).`);
    console.log(`\nSample (up to 15):`);
    for (const p of undefinedButShouldBeTrue.slice(0, 15)) {
      console.log(`  ${p.hit ? "HIT " : "MISS"} ${p.player} — ${p.propType} ${p.propLabel} — edge ${(p.edge * 100).toFixed(1)}pt, confidence ${p.confidence}`);
    }
  }
}

main().catch(e => { console.error("Failed:", e); process.exit(1); });