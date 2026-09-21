// Dry-run by default; pass --apply to actually rewrite data. Fixes the wasEdgeBoard merge bug's aftermath:
// lib/pipeline.js's old merge line (`if (existing) p.wasEdgeBoard = existing.wasEdgeBoard;`) blindly copied
// `undefined` forward forever once a pick's first save never got a real true/false value, so ~95% of the
// history never got a real recommendation decision. This script recomputes wasEdgeBoard for every pick where
// it's currently null/undefined, using the two fields that ARE reliably saved — edge and confidence — against
// today's minEdgeFor() rule, then rebuilds calibrationLedger.recommended from scratch off the corrected data
// (a full rebuild, not an incremental add, so nothing double-counts).
//
// LIMITATION, same as the audit script: teamMismatch and suspect were never persisted on saved picks, so a
// small number of these recomputed "true" picks could theoretically have been correctly excluded for one of
// those two reasons at the time. There's no way to recover that after the fact. This also touches ungraded
// (still-live) picks so the current Edge Board reflects reality going forward, not just historical stats.
//
// Usage:
//   node scripts/backfill-wasedgeboard.js              (dry run — prints what would change)
//   node scripts/backfill-wasedgeboard.js --apply       (writes the fix for real)
import { getStore } from "@netlify/blobs";
import { foldIntoLedger, summarizeLedger } from "../lib/grading.js";

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
  const apply = process.argv.includes("--apply");
  const history = store("apex-edge-history");
  const { blobs: picksBlobs } = await history.list({ prefix: "picks-" });

  let touchedGraded = 0, touchedUngraded = 0, flippedTrue = 0, flippedFalse = 0;
  const allCorrectedGradedPicks = []; // every graded pick across all weeks, post-correction, for the ledger rebuild
  const updatedBlobs = [];

  for (const { key } of picksBlobs) {
    const picks = (await history.get(key, { type: "json" })) || [];
    let changedThisBlob = false;
    for (const p of picks) {
      if (p.wasEdgeBoard == null) {
        const recomputed = p.edge > minEdgeFor(p.propType) && ["medium", "high"].includes(p.confidence);
        p.wasEdgeBoard = recomputed;
        changedThisBlob = true;
        if (p.graded) touchedGraded++; else touchedUngraded++;
        if (recomputed) flippedTrue++; else flippedFalse++;
      }
      if (p.graded) allCorrectedGradedPicks.push(p);
    }
    if (changedThisBlob) updatedBlobs.push({ key, picks });
  }

  console.log(`${apply ? "APPLYING" : "DRY RUN (pass --apply to write for real)"}`);
  console.log(`\nPicks with undefined wasEdgeBoard corrected: ${touchedGraded + touchedUngraded}`);
  console.log(`  graded:   ${touchedGraded}`);
  console.log(`  ungraded (still-live, on the current board): ${touchedUngraded}`);
  console.log(`  -> recomputed true:  ${flippedTrue}`);
  console.log(`  -> recomputed false: ${flippedFalse}`);

  const recommendedGraded = allCorrectedGradedPicks.filter(p => p.wasEdgeBoard);
  const rebuiltRecommended = foldIntoLedger({}, recommendedGraded);
  const summary = summarizeLedger(rebuiltRecommended);
  console.log(`\n--- Rebuilt recommended-only track record (${recommendedGraded.length} real recommendations, all-time) ---`);
  console.log(`Overall: ${summary.totals.hits}/${summary.totals.attempts} hit (${pct(summary.totals.hits, summary.totals.attempts)}), brier ${summary.totals.brier}`);
  for (const tier of ["high", "medium", "low"]) {
    const b = summary.byConfidence[tier];
    if (b) console.log(`  ${tier} confidence: ${b.hits}/${b.attempts} (${pct(b.hits, b.attempts)})`);
  }

  if (apply) {
    for (const { key, picks } of updatedBlobs) {
      await history.setJSON(key, picks);
    }
    const calibrationLedger = (await history.get("calibration-ledger.json", { type: "json" })) || {};
    calibrationLedger.recommended = rebuiltRecommended;
    await history.setJSON("calibration-ledger.json", calibrationLedger);
    console.log(`\nAPPLIED — ${updatedBlobs.length} picks-*.json file(s) rewritten, calibration-ledger.json's recommended bucket rebuilt.`);
  } else {
    console.log(`\nDry run only — nothing written. Re-run with --apply once these numbers look right.`);
  }
}

main().catch(e => { console.error("Failed:", e); process.exit(1); });