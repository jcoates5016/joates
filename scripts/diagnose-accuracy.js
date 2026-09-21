// Read-only diagnostic: breaks the real, surviving (non-live-contaminated) graded picks down every way that
// might explain why the all-time hit rate is far below what a market-anchored model should produce. Writes
// NOTHING — this is purely for reading the real numbers behind the summary clean-live-line-contamination.js
// prints, one level deeper.
//
// Same "was this captured pregame" test as clean-live-line-contamination.js (capturedAt, falling back to the
// price-history heuristic for older data) — see that script's header comment for the full reasoning. This
// script doesn't repeat the keep/drop printout; it assumes you've already run that one and are past the "is
// this just live-line noise" question. This is "given only the real pregame picks, WHERE is the model actually
// failing" — by prop type, by confidence tier (and what modelProb each tier really contains), by how big the
// claimed edge was, and by week (is it getting better, worse, or flat over time).
//
// Run it exactly like clean-live-line-contamination.js's dry run:
//   NETLIFY_SITE_ID=... NETLIFY_BLOBS_TOKEN=... node scripts/diagnose-accuracy.js
import { getStore } from "@netlify/blobs";

function store(name) {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  if (!siteID || !token) throw new Error("Missing NETLIFY_SITE_ID / NETLIFY_BLOBS_TOKEN in the environment.");
  return getStore({ name, siteID, token });
}

function wasCapturedPregame(oddID, book, kickoff, priceHistory) {
  if (!oddID || !book || !kickoff) return false;
  const series = priceHistory[`${oddID}|${book}`];
  if (!series || !series.length) return false;
  const kickoffTime = new Date(kickoff).getTime();
  return series.some(pt => pt.t && new Date(pt.t).getTime() < kickoffTime);
}

function weekSuffixFromKey(key, prefix) {
  return key.replace(new RegExp(`^${prefix}`), "").replace(/\.json$/, "");
}

function pct(n, d) { return d ? `${(100 * n / d).toFixed(1)}%` : "n/a"; }
function avg(nums) { const v = nums.filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }

function printTable(title, rows, keyLabel) {
  console.log(`\n--- ${title} ---`);
  const sorted = rows.sort((a, b) => b.attempts - a.attempts);
  console.log(`${keyLabel.padEnd(20)} attempts  hits  hitRate   avgModelProb  avgEdge`);
  for (const r of sorted) {
    console.log(
      `${String(r.key).padEnd(20)} ${String(r.attempts).padEnd(9)} ${String(r.hits).padEnd(5)} ${pct(r.hits, r.attempts).padEnd(9)} ` +
      `${(r.avgModelProb != null ? (r.avgModelProb * 100).toFixed(1) + "%" : "n/a").padEnd(13)} ${r.avgEdge != null ? (r.avgEdge * 100).toFixed(1) + "pt" : "n/a"}`
    );
  }
}

function bucketBy(picks, keyFn) {
  const buckets = new Map();
  for (const p of picks) {
    const key = keyFn(p);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(p);
  }
  return [...buckets.entries()].map(([key, ps]) => ({
    key, attempts: ps.length, hits: ps.filter(p => p.hit).length,
    avgModelProb: avg(ps.map(p => p.modelProb)), avgEdge: avg(ps.map(p => p.edge))
  }));
}

async function main() {
  const history = store("apex-edge-history");
  const { blobs: picksBlobs } = await history.list({ prefix: "picks-" });

  const survivors = [];
  for (const { key } of picksBlobs) {
    const weekSuffix = weekSuffixFromKey(key, "picks-");
    const picks = (await history.get(key, { type: "json" })) || [];
    const priceHistory = (await history.get(`prices-${weekSuffix}.json`, { type: "json" })) || {};
    for (const p of picks) {
      if (!p.graded) continue;
      if (p.capturedAt || wasCapturedPregame(p.oddID, p.pickBook, p.kickoff, priceHistory)) {
        survivors.push({ ...p, weekSuffix });
      }
    }
  }

  console.log(`Analyzing ${survivors.length} real, pregame-captured, graded pick(s).`);
  console.log(`Overall (EVERY prop the app ever evaluated, not just recommended ones): ${survivors.filter(p => p.hit).length}/${survivors.length} hit (${pct(survivors.filter(p => p.hit).length, survivors.length)})`);

  // buildGradablePicks (lib/pipeline.js) saves EVERY prop with a model estimate, for ledger/history completeness
  // — not just the ones that cleared the real edge bar. wasEdgeBoard is the flag for "this specific prop was
  // actually flagged as a real edge and recommended" (see pipeline.js's wasEdgeBoard line: trueEdge > MIN_TRUE_EDGE
  // && confidence in [medium,high] && no team mismatch/suspect flag). The overall number above blends in a lot of
  // props the app itself never told you to bet — this is the real question: of what it actually recommended, how
  // did THAT do.
  const recommended = survivors.filter(p => p.wasEdgeBoard);
  const notRecommended = survivors.filter(p => !p.wasEdgeBoard);
  console.log(`\nOf those, ${recommended.length} were actually flagged as a real Edge Board recommendation (wasEdgeBoard=true):`);
  console.log(`  Recommended picks only: ${recommended.filter(p => p.hit).length}/${recommended.length} hit (${pct(recommended.filter(p => p.hit).length, recommended.length)})`);
  console.log(`  Everything else (never recommended, just tracked): ${notRecommended.filter(p => p.hit).length}/${notRecommended.length} hit (${pct(notRecommended.filter(p => p.hit).length, notRecommended.length)})`);

  console.log("\n=== Breakdown of RECOMMENDED picks only (wasEdgeBoard=true) ===");
  printTable("By prop type (recommended only)", bucketBy(recommended, p => p.propType || "unknown"), "propType");
  printTable("By confidence tier (recommended only)", bucketBy(recommended, p => p.confidence || "unknown"), "confidence");

  console.log("\n=== Breakdown of the FULL universe (everything the app evaluated) ===");
  printTable("By prop type", bucketBy(survivors, p => p.propType || "unknown"), "propType");
  printTable("By confidence tier", bucketBy(survivors, p => p.confidence || "unknown"), "confidence");
  printTable("By week", bucketBy(survivors, p => p.weekSuffix), "week");
  printTable("By edge size", bucketBy(survivors, p => {
    const pct5 = Math.round((p.edge || 0) * 100);
    if (pct5 < 3) return "0-3pt"; if (pct5 < 6) return "3-6pt"; if (pct5 < 10) return "6-10pt";
    if (pct5 < 15) return "10-15pt"; return "15pt+";
  }), "edge bucket");
  printTable("By modelProb decile", bucketBy(survivors, p => {
    const d = Math.floor((p.modelProb || 0) * 10) * 10;
    return `${d}-${d + 10}%`;
  }), "modelProb");

  // Calibration sanity check: does the model's OWN stated probability track its OWN actual hit rate at all,
  // regardless of confidence-tier label? If a higher modelProb bucket doesn't hit more often than a lower one,
  // the model's probability output itself isn't predictive — a different (and more fundamental) problem than
  // mislabeled confidence tiers.
  console.log("\n--- Calibration check: modelProb decile vs real hit rate (should trend upward, left to right) ---");
  const deciles = bucketBy(survivors, p => Math.floor((p.modelProb || 0) * 10)).sort((a, b) => a.key - b.key);
  for (const d of deciles) {
    console.log(`  modelProb ${d.key * 10}-${d.key * 10 + 10}%: ${d.hits}/${d.attempts} real hit rate = ${pct(d.hits, d.attempts)}`);
  }
}

main().catch(e => { console.error("Failed:", e); process.exit(1); });
