// Standalone entry point for the real (non-demo) refresh pipeline, meant to be run by the GitHub Actions
// workflow (.github/workflows/refresh.yml) rather than a Netlify Function — see README for why: Netlify
// Background Functions (the thing that gave the old design its ~15-minute budget) turned out to require a
// paid Pro plan. GitHub Actions has no such per-run time limit on this scale and is free for this workload, so
// the whole pipeline moved here. This script needs real credentials in its environment (SPORTSGAMEODDS_API_KEY,
// ANTHROPIC_API_KEY, NETLIFY_SITE_ID, NETLIFY_BLOBS_TOKEN) — set as GitHub repo secrets, never committed.
import { doRefresh } from "../lib/doRefresh.js";

try {
  const snapshot = await doRefresh({});
  console.log(`Refresh complete: ${snapshot.stats.propsScanned} props, ${snapshot.stats.propsWithFactor} with a real factor, ${snapshot.stats.suspectFlags} flagged as suspect data.`);
  snapshot.logs?.forEach(l => console.log(`[pipeline] ${l.t} ${l.msg}`));
  process.exit(0);
} catch (e) {
  console.error("Refresh failed:", e);
  process.exit(1); // non-zero exit surfaces as a failed run in the GitHub Actions UI
}
