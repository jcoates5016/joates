// The missing feedback loop. Every prior version of this app built a "confidence" number and never once checked
// it against what actually happened — this module is what closes that loop. Each refresh: (1) take last week's
// (and any older ungraded week's) saved picks, (2) for any whose games are done, look up the real final stat
// from freshly fetched nflverse data and mark hit/miss, (3) fold newly-graded picks into a running, all-time
// calibration ledger bucketed by confidence tier and by edge size. That ledger is the only honest answer to "is
// any of this actually working" — a model that claims "medium confidence, 6% edge" either does or doesn't hit
// meaningfully more than its market probability implies, and this is what would show it either way.
//
// Only prop picks are graded for now. Game-line picks in this build are Totals-Overs (see analyze.js) and
// grading those needs each game's final combined score, which isn't fetched anywhere in the pipeline yet —
// rather than guess at it, line picks are saved (so they still show up on cards) but skipped here until a real
// final-score fetch is added. See README's "Probability model" section.
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
export function gradeCompletedPicks(picks, gameLogIndex, now = new Date()) {
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
    graded.push(pick);
  }
  return graded;
}

function emptyBucket() { return { attempts: 0, hits: 0, sumModelProb: 0, sumMarketProb: 0, brierSum: 0 }; }
function fold(bucket, pick) {
  bucket.attempts += 1;
  if (pick.hit) bucket.hits += 1;
  bucket.sumModelProb += pick.modelProb;
  bucket.sumMarketProb += pick.marketProb;
  const err = (pick.hit ? 1 : 0) - pick.modelProb;
  bucket.brierSum += err * err;
}

// Mutates `ledger` in place with raw counters only (see store.js's comment on why) — this is what gets
// persisted. Call summarizeLedger() separately to get human/UI-facing rates out of it.
export function foldIntoLedger(ledger, gradedPicks) {
  ledger.totals ||= emptyBucket();
  ledger.byConfidence ||= {};
  ledger.byEdgeBucket ||= {};
  for (const pick of gradedPicks) {
    fold(ledger.totals, pick);
    ledger.byConfidence[pick.confidence] ||= emptyBucket();
    fold(ledger.byConfidence[pick.confidence], pick);
    const key = edgeBucketKey(pick.edge);
    ledger.byEdgeBucket[key] ||= emptyBucket();
    fold(ledger.byEdgeBucket[key], pick);
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
  if (!bucket || !bucket.attempts) return { attempts: 0, hits: 0, hitRate: null, avgModelProb: null, avgMarketProb: null, brier: null };
  return {
    attempts: bucket.attempts, hits: bucket.hits,
    hitRate: +(bucket.hits / bucket.attempts).toFixed(4),
    avgModelProb: +(bucket.sumModelProb / bucket.attempts).toFixed(4),
    avgMarketProb: +(bucket.sumMarketProb / bucket.attempts).toFixed(4),
    // Brier score: mean squared error between predicted probability and the 0/1 outcome. Lower is better
    // calibrated; 0.25 is what a flat, uninformative 50% guess scores against a 50/50 true rate.
    brier: +(bucket.brierSum / bucket.attempts).toFixed(4)
  };
}

// Read-only view for the frontend/snapshot — never persisted, always recomputed from the raw ledger.
export function summarizeLedger(ledger) {
  if (!ledger || !ledger.totals?.attempts) {
    return { hasData: false, totals: finalizeBucket(null), byConfidence: {}, byEdgeBucket: {} };
  }
  const byConfidence = {};
  for (const [k, v] of Object.entries(ledger.byConfidence || {})) byConfidence[k] = finalizeBucket(v);
  const byEdgeBucket = {};
  for (const [k, v] of Object.entries(ledger.byEdgeBucket || {})) byEdgeBucket[k] = finalizeBucket(v);
  return { hasData: true, updatedAt: ledger.updatedAt, totals: finalizeBucket(ledger.totals), byConfidence, byEdgeBucket };
}
