// The missing feedback loop. Every prior version of this app built a "confidence" number and never once checked
// it against what actually happened — this module is what closes that loop. Each refresh: (1) take last week's
// (and any older ungraded week's) saved picks, (2) for any whose games are done, look up the real final stat
// from freshly fetched nflverse data and mark hit/miss, (3) fold newly-graded picks into a running, all-time
// calibration ledger bucketed by confidence tier and by edge size. That ledger is the only honest answer to "is
// any of this actually working" — a model that claims "medium confidence, 6% edge" either does or doesn't hit
// meaningfully more than its market probability implies, and this is what would show it either way.
//
// Prop-only now that game lines have been removed entirely (see analyze.js/probability.js/pipeline.js) — every
// saved pick is a prop pick.
import { americanToImpliedProb } from "./oddsMath.js";
import { MAX_CALIBRATION_SAMPLE, fitPlattScaling } from "./calibration.js";

const GRADE_DELAY_HOURS = 20; // give games (and nflverse's weekly stat file) time to actually post before trying

const STAT_FNS = {
  td_pass: r => r.passing_tds || 0, td_rush: r => r.rushing_tds || 0, td_rec: r => r.receiving_tds || 0,
  td: r => (r.rushing_tds || 0) + (r.receiving_tds || 0),
  pass_yds: r => r.passing_yards || 0, rush_yds: r => r.rushing_yards || 0,
  rec_yds: r => r.receiving_yards || 0, receptions: r => r.receptions || 0
};

function actualStatFor(pick, gameLogIndex) {
  const rows = gameLogIndex.get((pick.playerKey || pick.player || "").toLowerCase()) || [];
  const row = rows.find(r => Number(r.week) === Number(pick.week) && Number(r.season) === Number(pick.season));
  if (!row) return null;
  const statFor = STAT_FNS[pick.propType];
  return statFor ? statFor(row) : null;
}

// Mutates and returns `picks` (the caller saves it back). Returns the subset newly graded this call, since
// that's what the ledger needs folded in — re-grading an already-graded pick would double count it.
// `priceHistory` is that pick's own week's rolling price series (lib/store.js's loadPriceHistory) — used only to
// compute closing-line value (CLV) below, entirely separate from whether the pick itself graded hit/miss.
export function gradeCompletedPicks(picks, gameLogIndex, priceHistory = {}, now = new Date()) {
  const graded = [];
  for (const pick of picks) {
    if (pick.graded || pick.kind !== "prop") continue;
    if (!pick.kickoff || pick.line == null || pick.modelProb == null) continue;
    const kickoffTime = new Date(pick.kickoff).getTime();
    if (isNaN(kickoffTime) || now.getTime() - kickoffTime < GRADE_DELAY_HOURS * 3600 * 1000) continue;
    const actualValue = actualStatFor(pick, gameLogIndex);
    if (actualValue == null) continue; // no stat row yet (postponed, DNP, or just hasn't posted) — retried next refresh
    const hit = (pick.side || "").toLowerCase() === "under" ? actualValue < pick.line : actualValue > pick.line;
    pick.graded = true; pick.hit = hit; pick.actualValue = actualValue; pick.gradedAt = now.toISOString();

    // Closing-line value: did the price move in our favor (positive CLV, real evidence the pick was sharp
    // independent of whether it actually hit) or against us, between when the pick was first captured
    // (pick.pickPrice/pickBook — captured once in pipeline.js's buildGradablePicks and never overwritten on
    // refresh) and the last point-in-time price this app has on record for that same oddID+book this week — the
    // closest proxy available to a real closing line without a dedicated closing-odds fetch. Left null (not 0)
    // whenever there's no real closing price to compare against, so "no CLV data" is never confused with "CLV
    // was exactly zero."
    if (pick.pickPrice != null && pick.pickBook) {
      const series = priceHistory[`${pick.oddID}|${pick.pickBook}`];
      const closing = series?.length ? series[series.length - 1] : null;
      if (closing?.price != null) {
        pick.closingPrice = closing.price;
        pick.closingBook = pick.pickBook;
        pick.clv = +(americanToImpliedProb(closing.price) - americanToImpliedProb(pick.pickPrice)).toFixed(4);
      }
    }
    graded.push(pick);
  }
  return graded;
}

function emptyBucket() { return { attempts: 0, hits: 0, sumModelProb: 0, sumMarketProb: 0, brierSum: 0, clvCount: 0, sumClv: 0 }; }
function fold(bucket, pick) {
  bucket.attempts += 1;
  if (pick.hit) bucket.hits += 1;
  bucket.sumModelProb += pick.modelProb;
  bucket.sumMarketProb += pick.marketProb;
  const err = (pick.hit ? 1 : 0) - pick.modelProb;
  bucket.brierSum += err * err;
  // CLV folds separately from the other sums since not every graded pick has a closing price on record (see
  // gradeCompletedPicks) — clvCount, not attempts, is the right denominator for avgClv below.
  if (pick.clv != null) { bucket.clvCount += 1; bucket.sumClv += pick.clv; }
}

// Mutates `ledger` in place with raw counters only (see store.js's comment on why) — this is what gets
// persisted. Call summarizeLedger() separately to get human/UI-facing rates out of it.
//
// The one deliberate exception to "raw counters only": `ledger.recentForCalibration`, a small, EXPLICITLY
// SIZE-CAPPED (see lib/calibration.js's MAX_CALIBRATION_SAMPLE) rolling window of each recent graded pick's
// `{modelProb, hit}` pair. Platt scaling (lib/calibration.js) structurally needs real individual (predicted
// probability, actual outcome) pairs to fit a recalibration curve — a bucket's pre-summed totals (attempts,
// hits, sumModelProb) can't be un-aggregated back into that, the same way you can't recover a scatter plot from
// its own mean and count. Capped, not unbounded, so this still respects the same "never needs to grow with the
// number of weeks" design the rest of this ledger deliberately has — a rolling window of the most recent results
// is also the more honest thing for calibration to look at anyway (is the model calibrated RIGHT NOW, not across
// its entire history including a much earlier, differently-tuned coefficient set).
export function foldIntoLedger(ledger, gradedPicks) {
  ledger.totals ||= emptyBucket();
  ledger.byConfidence ||= {};
  ledger.byEdgeBucket ||= {};
  ledger.recentForCalibration ||= [];
  for (const pick of gradedPicks) {
    fold(ledger.totals, pick);
    ledger.byConfidence[pick.confidence] ||= emptyBucket();
    fold(ledger.byConfidence[pick.confidence], pick);
    const key = edgeBucketKey(pick.edge);
    ledger.byEdgeBucket[key] ||= emptyBucket();
    fold(ledger.byEdgeBucket[key], pick);
    // `pick.rawModelProb` (pre-Platt-scaling — see lib/pipeline.js's buildGradablePicks) is what belongs here,
    // not the possibly-already-calibrated `pick.modelProb` used for display/ranking — fitting the next
    // calibration against an already-calibrated number would compound the correction on itself over time instead
    // of measuring the raw model's real calibration. Falls back to `pick.modelProb` for any pick saved before
    // this field existed, or when calibration wasn't active when it was saved (the two are identical then).
    ledger.recentForCalibration.push({ modelProb: pick.rawModelProb ?? pick.modelProb, hit: !!pick.hit });
  }
  if (ledger.recentForCalibration.length > MAX_CALIBRATION_SAMPLE) {
    ledger.recentForCalibration = ledger.recentForCalibration.slice(-MAX_CALIBRATION_SAMPLE);
  }
  ledger.updatedAt = new Date().toISOString();
  return ledger;
}

function edgeBucketKey(edge) {
  const pct = Math.round((edge || 0) * 100);
  if (pct < 3) return "0-3pt";
  if (pct < 6) return "3-6pt";
  if (pct < 10) return "6-10pt";
  if (pct < 15) return "10-15pt";
  return "15pt+";
}

function finalizeBucket(bucket) {
  if (!bucket || !bucket.attempts) return { attempts: 0, hits: 0, hitRate: null, avgModelProb: null, avgMarketProb: null, brier: null, avgClv: null, clvCount: 0 };
  return {
    attempts: bucket.attempts, hits: bucket.hits,
    hitRate: +(bucket.hits / bucket.attempts).toFixed(4),
    avgModelProb: +(bucket.sumModelProb / bucket.attempts).toFixed(4),
    avgMarketProb: +(bucket.sumMarketProb / bucket.attempts).toFixed(4),
    // Brier score: mean squared error between predicted probability and the 0/1 outcome. Lower is better
    // calibrated; 0.25 is what a flat, uninformative 50% guess scores against a 50/50 true rate.
    brier: +(bucket.brierSum / bucket.attempts).toFixed(4),
    // Positive avgClv is real evidence of catching value before the market moved further, independent of
    // whether any individual pick actually hit — see the comment on CLV in gradeCompletedPicks above.
    clvCount: bucket.clvCount || 0,
    avgClv: bucket.clvCount ? +(bucket.sumClv / bucket.clvCount).toFixed(4) : null
  };
}

// Read-only view for the frontend/snapshot — never persisted, always recomputed from the raw ledger.
// `calibration` surfaces whether lib/pipeline.js's Platt-scaling recalibration (lib/calibration.js) is actually
// active this refresh and on how much real data, purely for transparency — pipeline.js refits and applies it
// independently, this is not the only place that decision gets made.
export function summarizeLedger(ledger) {
  if (!ledger || !ledger.totals?.attempts) {
    return { hasData: false, totals: finalizeBucket(null), byConfidence: {}, byEdgeBucket: {}, calibration: fitPlattScaling([]) };
  }
  const byConfidence = {};
  for (const [k, v] of Object.entries(ledger.byConfidence || {})) byConfidence[k] = finalizeBucket(v);
  const byEdgeBucket = {};
  for (const [k, v] of Object.entries(ledger.byEdgeBucket || {})) byEdgeBucket[k] = finalizeBucket(v);
  return {
    hasData: true, updatedAt: ledger.updatedAt, totals: finalizeBucket(ledger.totals), byConfidence, byEdgeBucket,
    calibration: fitPlattScaling(ledger.recentForCalibration || [])
  };
}
