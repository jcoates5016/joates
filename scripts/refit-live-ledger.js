// Read-only: tests every backtested-or-hand-set factor against the ONE thing that actually matters and that
// scripts/backtest.js structurally CANNOT test — did it predict beating the real market price, not just beating
// a player's own trailing average.
//
// scripts/backtest.js's walk-forward loop is a genuinely useful, real backtest, but it's built on a proxy target
// forced by a real data limitation: SportsGameOdds' Rookie tier has no historical odds archive, so there is no
// way to backtest against real historical market lines. It measures "did the player beat his own trailing
// average," which is a different, EASIER question than "did this beat the market" — a factor can genuinely
// predict a player will beat his own recent average while adding zero real edge over the market, because the
// market may have already priced that exact trend in. Every coefficient in lib/modelCoeffs.js has, until now,
// only ever been tested on the easier question.
//
// This script closes that gap using data that didn't exist when backtest.js was built: this app's own live
// results ledger (lib/grading.js) now has real graded picks — real market probability, real model probability,
// which of lib/probability.js's nudges actually fired (`firedFactors`, added to every saved pick), and the real
// outcome. That's exactly the (X, y) pair needed to ask the real question directly: controlling for the market's
// own price, does a given factor add real incremental probability of actually hitting?
//
// Method: the same joint logistic fit + Wald significance test scripts/backtest.js's own joint fit uses
// (lib/regularizedFit.js's fitJointLogisticWithWaldTest) — one feature per candidate factor (did it fire on this
// pick, 0/1) PLUS one continuous feature for the market's own logit(marketProb), so every factor's coefficient is
// estimated GIVEN the market's price already in the model, not instead of it. y = the real hit/miss outcome.
//
// HONEST LIMITATION: this app's live ledger is still young — every week adds more real graded picks, but right
// now the total sample is small relative to ~20 candidate factors, so most or all coefficients below will likely
// NOT clear real significance yet. That's not a bug in the method, it's an honest reflection of how little real
// data exists so far. Treat this as a growing diagnostic to re-run every few weeks, not a one-time verdict — and
// don't hand-edit lib/modelCoeffs.js off a single run of this script the way scripts/backtest.js's multi-season,
// tens-of-thousands-of-rows fit can be trusted more readily.
//
// Usage:
//   NETLIFY_SITE_ID=... NETLIFY_BLOBS_TOKEN=... node scripts/refit-live-ledger.js
import { getStore } from "@netlify/blobs";
import { logit } from "../lib/oddsMath.js";
import { fitJointLogisticWithWaldTest } from "../lib/regularizedFit.js";
import { MODEL_COEFFS } from "../lib/modelCoeffs.js";

function store(name) {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  if (!siteID || !token) throw new Error("Missing NETLIFY_SITE_ID / NETLIFY_BLOBS_TOKEN in the environment.");
  return getStore({ name, siteID, token });
}

// Same "was this actually captured before kickoff" test scripts/diagnose-accuracy.js and
// scripts/clean-live-line-contamination.js already use — a pick whose price/model estimate was only ever
// captured after the game started isn't a real pregame prediction, and including it here would test the model
// against a leaked, already-partly-known outcome.
function wasCapturedPregame(pick, priceHistory) {
  if (pick.capturedAt) return true; // reliable going forward — see clean-live-line-contamination.js's header
  if (!pick.oddID || !pick.pickBook || !pick.kickoff) return false;
  const series = priceHistory[`${pick.oddID}|${pick.pickBook}`];
  if (!series?.length) return false;
  const kickoffTime = new Date(pick.kickoff).getTime();
  return series.some(pt => pt.t && new Date(pt.t).getTime() < kickoffTime);
}

const METADATA_KEYS = new Set(["marketPriorWeight", "generatedAt", "source", "_backtestSeasons", "_backtestSampleSizes", "_backtestVerdicts"]);
const MIN_FIRED_TO_TEST = 15; // a factor that fired on fewer than this many real graded picks gets no fit column — a coefficient off <15 real outcomes isn't worth reporting even as a diagnostic.

function weekSuffixFromKey(key, prefix) { return key.replace(new RegExp(`^${prefix}`), "").replace(/\.json$/, ""); }

async function main() {
  const history = store("apex-edge-history");
  const { blobs: picksBlobs } = await history.list({ prefix: "picks-" });

  const rows = [];
  for (const { key } of picksBlobs) {
    const weekSuffix = weekSuffixFromKey(key, "picks-");
    const picks = (await history.get(key, { type: "json" })) || [];
    const priceHistory = (await history.get(`prices-${weekSuffix}.json`, { type: "json" })) || {};
    for (const p of picks) {
      if (!p.graded || p.modelProb == null || p.marketProb == null) continue;
      if (!Array.isArray(p.firedFactors)) continue; // saved before firedFactors existed — can't use it here
      if (!wasCapturedPregame(p, priceHistory)) continue;
      rows.push(p);
    }
  }

  console.log(`Found ${rows.length} real, pregame-captured, graded pick(s) with a recorded firedFactors list.`);
  if (rows.length < 50) {
    console.log(`\nThat's below a reasonable floor to fit ANYTHING jointly (need real volume for a ~20-feature`);
    console.log(`logistic fit to mean something) — re-run this again in a few weeks once more real games have`);
    console.log(`graded. Nothing below should be treated as a verdict yet.`);
  }

  // Candidate factor keys: every real coefficient key in MODEL_COEFFS, minus metadata and the hand-set
  // marketPriorWeight (that's a blending parameter, not a fired/not-fired nudge).
  const allKeys = Object.keys(MODEL_COEFFS).filter(k => !METADATA_KEYS.has(k));
  const firedCounts = {};
  for (const k of allKeys) firedCounts[k] = 0;
  for (const p of rows) for (const k of p.firedFactors) if (firedCounts[k] != null) firedCounts[k]++;

  const testableKeys = allKeys.filter(k => firedCounts[k] >= MIN_FIRED_TO_TEST);
  const skippedKeys = allKeys.filter(k => firedCounts[k] < MIN_FIRED_TO_TEST);
  console.log(`\n${testableKeys.length} of ${allKeys.length} factors fired on at least ${MIN_FIRED_TO_TEST} real graded picks and get a real fit below.`);
  if (skippedKeys.length) {
    console.log(`Not enough real occurrences yet (< ${MIN_FIRED_TO_TEST} picks): ${skippedKeys.map(k => `${k} (${firedCounts[k]})`).join(", ")}`);
  }

  if (rows.length < 20 || !testableKeys.length) {
    console.log("\nNot enough real data yet to run the joint fit at all. Re-run once more weeks have graded.");
    return;
  }

  // Feature 0 is the market's own logit(marketProb) — every factor's coefficient is estimated GIVEN this is
  // already in the model, so a "significant" factor here means real incremental edge over the market's own
  // price, not just correlation with the outcome (which the market's own price already explains a lot of).
  const keys = ["__market_logit", ...testableKeys];
  const X = rows.map(p => [logit(p.marketProb), ...testableKeys.map(k => (p.firedFactors.includes(k) ? 1 : 0))]);
  const y = rows.map(p => (p.hit ? 1 : 0));

  const fit = fitJointLogisticWithWaldTest(X, y, keys);

  console.log("\n=== Joint fit against the REAL live ledger — does each factor beat the market, not just a player's own average? ===");
  console.log(`(n=${rows.length} real graded picks; market's own logit(marketProb) held in the model as a control column)\n`);
  console.log("Factor                 firedN   coeff(real ledger)   p-value   vs. current MODEL_COEFFS value           verdict");
  for (const key of testableKeys) {
    const r = fit.byKey[key];
    const current = MODEL_COEFFS[key];
    const agrees = current === 0
      ? (r.significant ? "current is PRUNED to 0 — this fit finds a real signal, worth another look" : "current is 0 — agrees, still no real signal")
      : Math.sign(current) === Math.sign(r.rawBeta)
        ? (r.significant ? "same direction as current — corroborates it" : "same direction, not yet significant at this sample size")
        : (r.significant ? "OPPOSITE direction from current, and significant — real disagreement, worth investigating" : "opposite direction but not significant — likely just noise at this sample size");
    const verdict = r.significant ? "REAL signal vs. the market (p<0.05)" : "not significant yet";
    console.log(
      `${key.padEnd(22)} ${String(firedCounts[key]).padEnd(8)} ${r.rawBeta.toFixed(3).padEnd(21)} ${r.p.toFixed(3).padEnd(9)} ` +
      `${String(current).padEnd(6)} → ${agrees}`
    );
    console.log(`  ${" ".repeat(0)}${verdict}`);
  }

  const marketRow = fit.byKey.__market_logit;
  console.log(`\nMarket control column (__market_logit): coeff=${marketRow.rawBeta.toFixed(3)}, p=${marketRow.p.toFixed(3)}.`);
  console.log(`This should be strongly significant and positive (close to 1.0 in a well-calibrated system) — the`);
  console.log(`market's own price is real information the model should never fully wash out. A coefficient far`);
  console.log(`from 1.0 here is itself a real finding about how much the rest of the model is over- or under-`);
  console.log(`riding the market's own number.`);

  // Real overconfidence check, independent of the joint fit above: does a HIGHER modelProb decile actually mean
  // a higher real hit rate? This is the single most direct "is the stated number honest" question, and doesn't
  // depend on picking the right factor list or having enough data for 20 features — just enough picks per decile.
  console.log("\n=== Calibration check: modelProb decile vs. real hit rate (should climb left to right) ===");
  const deciles = new Map();
  for (const p of rows) {
    const d = Math.min(9, Math.floor((p.modelProb || 0) * 10));
    if (!deciles.has(d)) deciles.set(d, { attempts: 0, hits: 0 });
    const b = deciles.get(d);
    b.attempts++; if (p.hit) b.hits++;
  }
  for (const d of [...deciles.keys()].sort((a, b) => a - b)) {
    const b = deciles.get(d);
    const rate = b.attempts ? (100 * b.hits / b.attempts).toFixed(1) : "n/a";
    console.log(`  modelProb ${d * 10}-${d * 10 + 10}%: ${b.hits}/${b.attempts} real hit rate = ${rate}%`);
  }
}

main().catch(e => { console.error("Failed:", e); process.exit(1); });
