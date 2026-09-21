// Read-only: the full-universe version of analyze-yesterday.js — every graded prop from a given day's games,
// hit or miss, Anytime TD included, not just the ones that cleared the real edge bar. Breaks it down by prop
// type, confidence tier, edge size, and modelProb decile, the same buckets scripts/diagnose-accuracy.js uses
// across all-time history, just scoped to one real day so you can see what a single slate actually looked like.
//
// IMPORTANT LIMITATION, read before drawing conclusions: this can group hits/misses by prop type, confidence,
// edge size, and modelProb — but NOT by which of lib/probability.js's real nudges (red-zone share, matchup edge,
// weather, etc.) fired on each pick, because that detail was never saved to the results ledger until the
// `firedFactors` field was added (lib/pipeline.js's buildGradablePicks, right after pickPrice/pickBook). Any
// pick saved BEFORE that change — which includes everything from yesterday's games — has no `firedFactors` on
// it, so a true per-factor breakdown isn't possible yet for this specific day. This script still reports
// firedFactors breakdowns for whatever picks DO have it (going forward, real weeks will), so re-run this again
// after a few weeks pass and it'll actually have something to show there.
//
// Also a real, honest caveat: one day is a small, single, correlated sample (players in the same games share a
// lot of the same context — weather, pace, blowout-or-not) — useful for a first look, not for concluding a
// factor combination "works." scripts/backtest.js's 3-season walk-forward fit is still the statistically
// rigorous version of "which factors actually predict something real."
//
// Usage:
//   NETLIFY_SITE_ID=... NETLIFY_BLOBS_TOKEN=... node scripts/reverse-engineer-yesterday.js [YYYY-MM-DD]
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
  const targetDateStr = process.argv[2] || new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const history = store("apex-edge-history");
  const { blobs: picksBlobs } = await history.list({ prefix: "picks-" });

  const picksForDay = [];
  for (const { key } of picksBlobs) {
    const weekSuffix = weekSuffixFromKey(key, "picks-");
    const picks = (await history.get(key, { type: "json" })) || [];
    const priceHistory = (await history.get(`prices-${weekSuffix}.json`, { type: "json" })) || {};
    for (const p of picks) {
      if (!p.graded || !p.kickoff) continue;
      if (p.kickoff.slice(0, 10) !== targetDateStr) continue;
      // Same pregame-contamination safety check as the other diagnostics — filters out anything that might
      // have been captured after its game already kicked off, under the pre-v4.8.1 behavior.
      if (p.capturedAt || wasCapturedPregame(p.oddID, p.pickBook, p.kickoff, priceHistory)) picksForDay.push(p);
    }
  }

  console.log(`Analyzing ALL graded props (not just recommendations) for ${targetDateStr}: ${picksForDay.length} real, pregame-captured pick(s).`);
  console.log(`Overall: ${picksForDay.filter(p => p.hit).length}/${picksForDay.length} hit (${pct(picksForDay.filter(p => p.hit).length, picksForDay.length)})`);

  const withFactors = picksForDay.filter(p => Array.isArray(p.firedFactors) && p.firedFactors.length);
  console.log(`\n${withFactors.length} of these ${picksForDay.length} picks have a recorded firedFactors list (the new field) — real per-factor breakdown needs picks saved AFTER that field existed.`);

  printTable("By prop type", bucketBy(picksForDay, p => p.propType || "unknown"), "propType");
  printTable("By confidence tier", bucketBy(picksForDay, p => p.confidence || "unknown"), "confidence");
  printTable("By edge size", bucketBy(picksForDay, p => {
    const pct5 = Math.round((p.edge || 0) * 100);
    if (pct5 < 3) return "0-3pt"; if (pct5 < 6) return "3-6pt"; if (pct5 < 10) return "6-10pt";
    if (pct5 < 15) return "10-15pt"; return "15pt+";
  }), "edge bucket");
  printTable("By modelProb decile", bucketBy(picksForDay, p => {
    const d = Math.floor((p.modelProb || 0) * 10) * 10;
    return `${d}-${d + 10}%`;
  }), "modelProb");
  printTable("By market's own implied probability decile (was the MARKET well-calibrated yesterday?)",
    bucketBy(picksForDay, p => {
      const d = Math.floor((p.marketProb || 0) * 10) * 10;
      return `${d}-${d + 10}%`;
    }), "marketProb");

  if (withFactors.length) {
    console.log("\n--- Per-factor breakdown (only picks with a recorded firedFactors list) ---");
    const factorKeys = new Set(withFactors.flatMap(p => p.firedFactors));
    const rows = [...factorKeys].map(key => {
      const withIt = withFactors.filter(p => p.firedFactors.includes(key));
      const withoutIt = withFactors.filter(p => !p.firedFactors.includes(key));
      return {
        key,
        withN: withIt.length, withHits: withIt.filter(p => p.hit).length,
        withoutN: withoutIt.length, withoutHits: withoutIt.filter(p => p.hit).length
      };
    });
    for (const r of rows.sort((a, b) => b.withN - a.withN)) {
      console.log(`  ${r.key.padEnd(24)} with: ${r.withHits}/${r.withN} (${pct(r.withHits, r.withN)})   without: ${r.withoutHits}/${r.withoutN} (${pct(r.withoutHits, r.withoutN)})`);
    }
  }
}

main().catch(e => { console.error("Failed:", e); process.exit(1); });
