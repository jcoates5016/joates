// One-off maintenance script: retroactively separates real pregame-captured picks/parlays from ones that were
// only ever captured after their game had already kicked off — see lib/pipeline.js's filterPregameEvents and
// README's "Pregame-only filtering" section for the live-line bug this cleans up after.
//
// Two ways a pick/parlay can prove it was captured pregame, checked in order:
//
// 1. `capturedAt` (added in v4.8.2, right after this script was first written) — if it's present at all, the
//    pick/parlay was saved by a pipeline run that had already been through filterPregameEvents, full stop, no
//    heuristic needed. This is the reliable, permanent signal going forward.
//
// 2. For anything saved BEFORE that field existed, there's nothing on record that says "was this captured
//    pregame or live" directly. So this falls back to reconstructing the answer from the one signal that IS on
//    record: lib/store.js's rolling per-week price-history series (appendPriceSnapshots), which runs over every
//    prop present in propRows on EVERY refresh, not just newly-saved picks. If that series has even one entry
//    timestamped before a pick's own kickoff, the prop must already have been present — and therefore already
//    saved, at that same price, by buildGradablePicks/buildGradableParlays, which run over the exact same
//    propRows list every refresh — during a real pregame refresh. That means its captured price genuinely
//    reflects a pregame market. If the series has NO entry before kickoff at all, the very first time this app
//    ever saw that prop was already mid-game or later, and its captured line/price can't be trusted.
//
//    This fallback can't be perfect: the price-history series is capped at 12 points per (oddID, book) — a prop
//    refreshed more than 12 times before its own kickoff could have its real pregame entries pushed out before
//    this check ever runs, which would make it look contaminated when it wasn't. That's a narrow case (12+
//    refreshes of the same still-not-kicked-off prop inside one week) and it errs toward being too strict, not
//    too lenient — the goal here is a track record you can actually trust, not squeezing out every last real
//    data point.
//
// A parlay is only kept whole if EVERY leg passes this check — one live leg means the whole parlay's math was
// built on a corrupted number, not just that one leg.
//
// SAFE BY DEFAULT: run with no flags to see exactly what this would do — a dry run, writes nothing. Add --apply
// to actually rewrite the stored picks/parlays and rebuild calibration-ledger.json from the survivors.
//
// Needs NETLIFY_SITE_ID / NETLIFY_BLOBS_TOKEN in the environment — same two values GitHub Actions already uses
// for the real refresh (see README's "Environment variables & secrets"). NETLIFY_SITE_ID is visible any time in
// Netlify's site settings; NETLIFY_BLOBS_TOKEN is a personal access token — reuse the one you already generated,
// or make a fresh one in Netlify's user settings just for this one run.
//
// Run it like:
//   NETLIFY_SITE_ID=... NETLIFY_BLOBS_TOKEN=... node scripts/clean-live-line-contamination.js
//   NETLIFY_SITE_ID=... NETLIFY_BLOBS_TOKEN=... node scripts/clean-live-line-contamination.js --apply
import { getStore } from "@netlify/blobs";
import { foldIntoLedger, summarizeLedger } from "../lib/grading.js";

const APPLY = process.argv.includes("--apply");

function store(name) {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  if (!siteID || !token) throw new Error("Missing NETLIFY_SITE_ID / NETLIFY_BLOBS_TOKEN in the environment.");
  return getStore({ name, siteID, token });
}

// `pt.t` on a price-history entry is an ISO timestamp of when that snapshot was recorded (see
// lib/store.js's appendPriceSnapshots) — strictly before the pick's own recorded kickoff is the whole test.
// Only used as a fallback for picks/parlays with no capturedAt (see the header comment) — anything with a
// capturedAt is proven pregame directly and never reaches this function.
function wasCapturedPregame(oddID, book, kickoff, priceHistory) {
  if (!oddID || !book || !kickoff) return false; // can't prove it pregame — same "don't guess in its favor" rule this app already uses for suspect data
  const series = priceHistory[`${oddID}|${book}`];
  if (!series || !series.length) return false;
  const kickoffTime = new Date(kickoff).getTime();
  return series.some(pt => pt.t && new Date(pt.t).getTime() < kickoffTime);
}

function weekSuffixFromKey(key, prefix) {
  return key.replace(new RegExp(`^${prefix}`), "").replace(/\.json$/, ""); // "picks-2026-w3.json" -> "2026-w3"
}

async function main() {
  const history = store("apex-edge-history");

  const { blobs: picksBlobs } = await history.list({ prefix: "picks-" });
  const { blobs: parlaysBlobs } = await history.list({ prefix: "parlays-" });

  let totalPicksKept = 0, totalPicksDropped = 0;
  let totalParlaysKept = 0, totalParlaysDropped = 0;
  const survivingGradedPicks = [];

  console.log(`Found ${picksBlobs.length} weekly picks file(s), ${parlaysBlobs.length} weekly parlays file(s).\n`);

  for (const { key } of picksBlobs) {
    const weekSuffix = weekSuffixFromKey(key, "picks-");
    const picks = (await history.get(key, { type: "json" })) || [];
    const priceHistory = (await history.get(`prices-${weekSuffix}.json`, { type: "json" })) || {};
    const kept = [], dropped = [];
    for (const p of picks) {
      if (p.capturedAt || wasCapturedPregame(p.oddID, p.pickBook, p.kickoff, priceHistory)) {
        kept.push(p);
        if (p.graded) survivingGradedPicks.push(p);
      } else {
        dropped.push(p);
      }
    }
    totalPicksKept += kept.length; totalPicksDropped += dropped.length;
    console.log(`${key}: keeping ${kept.length}, dropping ${dropped.length} of ${picks.length}` +
      (dropped.length ? ` — dropped: ${dropped.map(p => `${p.player} ${p.propLabel} (${p.graded ? (p.hit ? "was a hit" : "was a miss") : "ungraded"})`).join("; ")}` : ""));
    if (APPLY) await history.setJSON(key, kept);
  }

  console.log("");
  for (const { key } of parlaysBlobs) {
    const weekSuffix = weekSuffixFromKey(key, "parlays-");
    const parlays = (await history.get(key, { type: "json" })) || [];
    const priceHistory = (await history.get(`prices-${weekSuffix}.json`, { type: "json" })) || {};
    const kept = [], dropped = [];
    for (const p of parlays) {
      const allLegsPregame = p.capturedAt || p.legs.every(l => wasCapturedPregame(l.oddID, p.book, l.kickoff, priceHistory));
      if (allLegsPregame) kept.push(p); else dropped.push(p);
    }
    totalParlaysKept += kept.length; totalParlaysDropped += dropped.length;
    console.log(`${key}: keeping ${kept.length}, dropping ${dropped.length} of ${parlays.length}` +
      (dropped.length ? ` — dropped: ${dropped.map(p => `${p.tierLabel} (${p.contextLabel})`).join("; ")}` : ""));
    if (APPLY) await history.setJSON(key, kept);
  }

  // Rebuild the all-time calibration ledger from scratch, folding in only the surviving graded picks — order
  // doesn't affect foldIntoLedger's counters, but sorting oldest-kickoff-first keeps `recentForCalibration`'s
  // rolling window meaning what it says: the actual most-recent real results, not an artifact of file-read order.
  survivingGradedPicks.sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
  const rebuiltLedger = {};
  foldIntoLedger(rebuiltLedger, survivingGradedPicks);
  // Same "recommended vs everything" split lib/pipeline.js's trackRecord now keeps live (see its own comment) —
  // nested under `.recommended` in the same object so a rebuild here matches that same shape exactly. Without
  // this, the very next deploy's Track Record panel would show a real "all props" number but an empty
  // "recommended" one, even though real recommended history already exists in what's being kept here.
  const recommendedPicks = survivingGradedPicks.filter(p => p.wasEdgeBoard);
  if (recommendedPicks.length) {
    rebuiltLedger.recommended = {};
    foldIntoLedger(rebuiltLedger.recommended, recommendedPicks);
  }
  // foldIntoLedger's own buckets are raw running sums (attempts/hits/sumModelProb/brierSum/...) — hitRate and
  // brier only get computed from those sums by summarizeLedger's finalizeBucket. Reading rebuiltLedger.totals
  // directly here (as an earlier version of this script did) silently prints undefined/NaN for both, even
  // though the underlying hits/attempts counts are correct.
  const summary = summarizeLedger(rebuiltLedger);
  const t = summary.totals;
  const recSummary = summarizeLedger(rebuiltLedger.recommended || {});

  console.log(`\n=== Summary ===`);
  console.log(`Picks:   kept ${totalPicksKept}, dropped ${totalPicksDropped}`);
  console.log(`Parlays: kept ${totalParlaysKept}, dropped ${totalParlaysDropped}`);
  console.log(`Rebuilt all-time record on surviving pregame-only picks (EVERY prop evaluated, not just recommendations): ${t.hits}/${t.attempts} hit` +
    (t.hitRate != null ? ` (${(t.hitRate * 100).toFixed(1)}%)` : "") + `, brier ${t.brier ?? "n/a"}`);
  for (const tier of ["high", "medium", "low"]) {
    const b = summary.byConfidence?.[tier];
    if (b?.attempts) console.log(`  ${tier} confidence: ${b.hits}/${b.attempts} (${(b.hitRate * 100).toFixed(1)}%)`);
  }
  if (recSummary.hasData) {
    console.log(`Of those, actual Edge Board recommendations only: ${recSummary.totals.hits}/${recSummary.totals.attempts} hit (${(recSummary.totals.hitRate * 100).toFixed(1)}%) — this is the number that actually answers "is this app worth trusting."`);
  } else {
    console.log(`No surviving picks were ever flagged as an actual Edge Board recommendation (wasEdgeBoard) — the Track Record panel's "recommended" section will start from zero after this.`);
  }

  if (APPLY) {
    await history.setJSON("calibration-ledger.json", rebuiltLedger);
    console.log("\nAPPLIED — calibration-ledger.json and every picks-*/parlays-* file above were rewritten.");
  } else {
    console.log("\nDRY RUN — nothing was written. Re-run with --apply once these numbers look right.");
  }
}

main().catch(e => { console.error("Failed:", e); process.exit(1); });
