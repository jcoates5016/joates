// Answers Jon's direct question — "how accurate is this on a realistic level" — with two independent, real
// checks instead of vibes. Neither reimplements the model's math: both call the ACTUAL
// lib/probability.js `estimatePropProbability()`, the exact function that runs live every refresh.
//
// (1) A REAL historical walk-forward calibration test. Reuses scripts/backtest.js's exact walk-forward
// discipline (every input for week W built only from weeks strictly before W, same season) but instead of
// testing one factor at a time, assembles a real `factors` object per player-week-propType from real nflverse
// data and runs it through the real model. Reports Brier score, log-loss, a calibration table (predicted-
// probability buckets vs. actual hit rate), and a confidence-tier breakdown — the standard toolkit for "is this
// forecaster's 70% actually right about 70% of the time." Also runs a "zero contextual nudges" baseline (same
// market-blend math, every nudge coefficient zeroed) side by side, to see whether the nudge stack is adding
// anything over the market-anchor + own-recent-history blend alone.
//
// WHAT THIS CAN AND CAN'T PROVE — same honest caveat scripts/backtest.js already carries, worth repeating here
// because it matters even more for a headline "accuracy" number:
//   - No historical market-odds archive exists for this book tier (see backtest.js's header), so `marketProb`
//     is fixed at 0.5 for every row here, same proxy backtest.js uses. That means this measures "does the model
//     correctly call whether a player beats his OWN recent level," NOT "does the model beat a real sportsbook
//     line" — a genuinely easier question. A good score here is necessary but not sufficient evidence the live
//     model beats real markets. The results ledger (lib/grading.js) is what eventually answers the harder
//     question for real, one graded pick at a time, as the app runs live against real closing lines.
//   - Scope simplifications versus the live app, both deliberate and documented rather than silent: no
//     historical weather backfill (Open-Meteo lookups are slow and weather_run_favor/weather_pass_penalty are
//     already backtested on their own in scripts/backtest.js), no historical NGS indexing (ngs_* stay untested
//     here, same as they're untested in scripts/backtest.js), and no historical injury/practice-report/odds-
//     movement archive exists at all (tendency, secondaryInjury, frontSevenInjury, oLineInjury, practiceTrend,
//     marketMovement, selfInjury all report unavailable here, exactly as they do in scripts/backtest.js).
//   - usage/redzone-share coverage is lower here than live: computeUsageFactor's snap-count join expects an
//     exact-cased name match, which this script's simplified snap index does not guarantee the way the live
//     pipeline's full roster-resolution step does. That undercounts usage_high_snap firing rate, not counts it
//     wrong — no fabricated data is involved.
//
// (2) A separate SYNTHETIC Monte Carlo stress test of the model's log-odds-additive nudge-combination
// machinery in isolation — thousands of simulated trials with a KNOWN ground-truth probability, checking
// whether stacking several correlated-but-noisy nudges on top of a noisy real-binomial-sampled "own evidence"
// keeps the model well-calibrated or makes it overconfident. This tests statistical SOUNDNESS of the combining
// logic under controlled, known assumptions — it cannot and does not claim anything about real-world accuracy,
// since every input is simulated.
//
// Usage: node scripts/validate-model.js [season ...]   (defaults to the last 2 complete calendar years)
import { fetchMultiSeasonStats, fetchSchedule, fetchSnapCounts, fetchPlayByPlay } from "../lib/fetchers/nflverse.js";
import { buildGameLogIndex } from "../lib/identity.js";
import { buildTeamSeasonIndex } from "../lib/factors/teamStats.js";
import { computeDefenseVsPosition, computeVenueSplit, computeUsageFactor, computeFormFactor, statValueFn, PROP_TYPES } from "../lib/factors/playerSplits.js";
import { computeMatchupEdge, computeScoringEnvironment, computePlayerRedZoneShare } from "../lib/factors/playerPbp.js";
import { computeScheduleFactor, computeStarterChangeFactor } from "../lib/factors/schedule.js";
import { computeRefereeFactor } from "../lib/factors/referee.js";
import { computePressureFactor } from "../lib/factors/pressure.js";
import { BIG_SPREAD_THRESHOLD } from "../lib/factors/index.js";
import { RUN_PROPS, PASS_PROPS, estimatePropProbability } from "../lib/probability.js";
import { normTeam } from "../lib/teamCodes.js";
import { clipProb } from "../lib/oddsMath.js";
import { MODEL_COEFFS } from "../lib/modelCoeffs.js";

const log = (msg) => console.log(msg);

const argSeasons = process.argv.slice(2).map(Number).filter(n => !isNaN(n));
const SEASONS = argSeasons.length ? argSeasons : [1, 2].map(n => new Date().getFullYear() - n);
const MIN_TRAILING_GAMES = 3;

function normName(raw) { return String(raw || "").toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim(); }
function avg(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null; }

// Same fixed-0-threshold research stand-in scripts/backtest.js uses for TD-flavored props, and for the same
// reason: a low-mean counting stat clears its own trailing MEAN well under half the time by construction, which
// would otherwise silently drag the "beat your own trailing average" baseline down without meaning any factor
// is broken. See scripts/backtest.js's own comment on backtestThreshold for the full explanation.
const TD_PROP_TYPES = ["td", "td_pass", "td_rush", "td_rec"];
function backtestThreshold(propType, trailingAvg) {
  return TD_PROP_TYPES.includes(propType) ? 0 : trailingAvg;
}

// Every named nudge coefficient zeroed, marketPriorWeight left untouched — isolates "market anchor + player's
// own recent-history blend" from "...plus every contextual nudge." Not a guess at which nudges matter: the real
// nudge() function in lib/probability.js multiplies each coefficient by 0 as soon as it's zeroed, so a nudge
// that fires still contributes exactly nothing to `x`, the same as if the condition never fired at all.
function makeZeroNudgeCoeffs(coeffs) {
  const zeroed = { ...coeffs };
  for (const key of Object.keys(zeroed)) {
    if (key === "marketPriorWeight" || typeof zeroed[key] !== "number") continue;
    zeroed[key] = 0;
  }
  return zeroed;
}
const ZERO_NUDGE_COEFFS = makeZeroNudgeCoeffs(MODEL_COEFFS);

function brierScore(records) {
  if (!records.length) return null;
  return records.reduce((s, r) => s + (r.p - (r.hit ? 1 : 0)) ** 2, 0) / records.length;
}
function logLossScore(records) {
  if (!records.length) return null;
  const eps = 1e-6;
  const total = records.reduce((s, r) => {
    const p = Math.min(1 - eps, Math.max(eps, r.p));
    return s + (r.hit ? Math.log(p) : Math.log(1 - p));
  }, 0);
  return -total / records.length;
}
function calibrationTable(records, buckets = 10) {
  const rows = Array.from({ length: buckets }, (_, i) => ({ lo: i / buckets, hi: (i + 1) / buckets, n: 0, hitSum: 0, pSum: 0 }));
  records.forEach(r => {
    const idx = Math.min(buckets - 1, Math.max(0, Math.floor(r.p * buckets)));
    rows[idx].n++; rows[idx].hitSum += r.hit ? 1 : 0; rows[idx].pSum += r.p;
  });
  return rows.map(r => ({
    range: `${Math.round(r.lo * 100)}-${Math.round(r.hi * 100)}%`, n: r.n,
    avgPredicted: r.n ? r.pSum / r.n : null, actualHitRate: r.n ? r.hitSum / r.n : null
  }));
}
function tierBreakdown(records) {
  return ["low", "medium", "high"].map(tier => {
    const rs = records.filter(r => r.tier === tier);
    return {
      tier, n: rs.length,
      avgPredicted: rs.length ? avg(rs.map(r => r.p)) : null,
      actualHitRate: rs.length ? avg(rs.map(r => r.hit ? 1 : 0)) : null,
      brier: brierScore(rs)
    };
  });
}

// Walk-forward-safe wrapper around lib/factors/referee.js's computeRefereeFactor, identical to
// scripts/backtest.js's own copy of this function (kept as its own small copy rather than shared, matching how
// backtest.js is already a standalone script — see that file for the full reasoning on why "strictly before
// cutoffDate" matters here).
function refereeFactorAsOf(refereeName, cutoffDate, fullSchedule) {
  if (!refereeName || !cutoffDate) return { available: false };
  const cutoff = new Date(cutoffDate);
  const priorGames = fullSchedule.filter(s => { const d = s.gameday || s.game_date; return d && new Date(d) < cutoff; });
  return computeRefereeFactor(refereeName, priorGames);
}

// nflverse's spread_line is confirmed the OPPOSITE sign convention from a standard sportsbook board (positive =
// home favored) — see scripts/backtest.js's own note on this. Copied here rather than shared for the same
// standalone-script reason as refereeFactorAsOf above.
function scheduleGameScript(gameRow, team, homeTeam) {
  const spreadLineRaw = Number(gameRow.spread_line);
  const totalLineRaw = Number(gameRow.total_line);
  if (isNaN(spreadLineRaw) || isNaN(totalLineRaw) || !homeTeam) return { available: false };
  const homeSpread = -spreadLineRaw;
  const teamSpread = team === homeTeam ? homeSpread : -homeSpread;
  return { available: true, teamSpread, isBigFavorite: teamSpread <= -BIG_SPREAD_THRESHOLD, isBigUnderdog: teamSpread >= BIG_SPREAD_THRESHOLD };
}

// ---------------------------------------------------------------------------------------------------------
// Part 1: real historical walk-forward calibration test
// ---------------------------------------------------------------------------------------------------------
async function runHistoricalValidation() {
  log(`\n=== Part 1: historical walk-forward calibration (seasons ${SEASONS.join(", ")}) ===`);
  log(`Fetching multi-season stats, schedule, play-by-play, and snap counts (no weather/NGS backfill this pass — see file header)...`);

  const scheduleRaw = await fetchSchedule(log);
  const hasGameType = scheduleRaw.some(r => "game_type" in r);
  const schedule = hasGameType ? scheduleRaw.filter(r => r.game_type === "REG") : scheduleRaw;

  const fullRecords = [], baseRecords = [];
  let overallHit = 0, overallN = 0;

  // Fetches one season's stats/play-by-play/snap-counts at a time, right before that season is walked, instead
  // of pre-loading every season's raw rows into a statRowsAll/pbpBySeason/snapsBySeason object up front (see
  // scripts/backtest.js's matching comment — this file had the identical pattern and the identical real risk of
  // a `FATAL ERROR: Reached heap limit` on a real machine, even though it hadn't been hit here yet).
  for (const season of SEASONS) {
    const seasonStatRowsAll = await fetchMultiSeasonStats([season], log);
    const seasonStatRows = seasonStatRowsAll.filter(r => Number(r.season) === season && (!r.season_type || r.season_type === "REG"));
    const weeks = [...new Set(seasonStatRows.map(r => Number(r.week)))].filter(w => !isNaN(w)).sort((a, b) => a - b);
    const seasonSchedule = schedule.filter(s => Number(s.season) === season);
    const seasonPbp = await fetchPlayByPlay(season, log);
    const seasonSnaps = await fetchSnapCounts(season, log);
    if (!seasonStatRows.length) { log(`${season}: no stat rows returned, skipping.`); continue; }

    for (const week of weeks) {
      if (week < MIN_TRAILING_GAMES + 1) continue;
      const priorRows = seasonStatRows.filter(r => Number(r.week) < week);
      if (priorRows.length < 50) continue;
      const priorGameLogIndex = buildGameLogIndex(priorRows);
      const priorPbp = seasonPbp.filter(r => Number(r.week) < week);
      const teamSeasonIndex = buildTeamSeasonIndex(priorPbp);
      const thisWeekRows = seasonStatRows.filter(r => Number(r.week) === week);

      // Simplified snap index: exact-cased "name|week" key (see file header's coverage caveat) — good enough to
      // measure usage_high_snap's real firing rate without needing the live pipeline's full roster-resolution
      // step just for this validation pass.
      const snapsByKey = new Map();
      seasonSnaps.filter(s => Number(s.week) < week).forEach(s => {
        const name = s.player || s.pfr_player_name;
        if (!name) return;
        snapsByKey.set(`${name.toLowerCase()}|${s.week}`, { offensePct: s.offense_pct });
      });

      const defCache = new Map();

      for (const row of thisWeekRows) {
        const name = row.player_display_name || row.player_name || row.player;
        if (!name) continue;
        const position = row.position || row.position_group;
        if (!["QB", "RB", "WR", "TE"].includes(position)) continue;
        const logKey = normName(name);
        const priorPlayerRows = priorGameLogIndex.get(logKey) || [];
        if (priorPlayerRows.length < MIN_TRAILING_GAMES) continue;
        const team = normTeam(row.recent_team || row.team);
        const opponent = normTeam(row.opponent_team || row.opponent);
        if (!team || !opponent) continue;

        const player = { name, team, position, _logKey: logKey, playerId: null, birthDate: null };

        const defKey = `${opponent}|${position}`;
        if (!defCache.has(defKey)) defCache.set(defKey, computeDefenseVsPosition(opponent, position, priorGameLogIndex));
        const defense = defCache.get(defKey);
        const matchupEdge = computeMatchupEdge(team, opponent, teamSeasonIndex);
        const scoringEnvironment = computeScoringEnvironment(team, opponent, teamSeasonIndex);

        let schedFactor = { available: false }, starterChange = { available: false }, gameScript = { available: false }, refFactor = { available: false };
        const gameRow = seasonSchedule.find(s => Number(s.week) === week &&
          (normTeam(s.home_team || s.home) === team || normTeam(s.away_team || s.away) === team));
        if (gameRow) {
          const homeTeam = normTeam(gameRow.home_team || gameRow.home);
          schedFactor = computeScheduleFactor({ team, opponentTeam: opponent, homeTeam, kickoffISO: gameRow.gameday || gameRow.game_date, gameRow });
          const thisWeekStarter = homeTeam === team ? gameRow.home_qb_name : gameRow.away_qb_name;
          starterChange = computeStarterChangeFactor(team, season, week, thisWeekStarter, seasonSchedule);
          gameScript = scheduleGameScript(gameRow, team, homeTeam);
          refFactor = refereeFactorAsOf(gameRow.referee, gameRow.gameday || gameRow.game_date, schedule);
        }

        for (const propType of PROP_TYPES) {
          const statFor = statValueFn(propType);
          const trailingAvg = avg(priorPlayerRows.slice(-10).map(statFor));
          const threshold = backtestThreshold(propType, trailingAvg);
          const actual = statFor(row);
          if (threshold == null || actual === threshold) continue;
          const hit = actual > threshold;
          overallHit += hit ? 1 : 0; overallN++;

          const factors = {
            propType, position, roof: gameRow?.roof || null,
            form: computeFormFactor(player, opponent, priorGameLogIndex, propType, threshold),
            tendency: { available: false }, weatherHistorical: { available: false }, weatherForecast: null,
            venue: computeVenueSplit(player, opponent, priorGameLogIndex, seasonSchedule, propType),
            usage: computeUsageFactor(player, priorGameLogIndex, snapsByKey),
            redZone: computePlayerRedZoneShare(player, priorPbp),
            defense, matchupEdge, scoringEnvironment,
            secondaryInjury: { available: false }, frontSevenInjury: { available: false },
            gameScript, schedule: schedFactor, starterChange,
            selfInjury: null, oLineInjury: { available: false }, practiceTrend: { available: false }, marketMovement: { available: false },
            referee: refFactor,
            ngsPassing: { available: false }, ngsRushing: { available: false }, ngsReceiving: { available: false },
            pressure: PASS_PROPS.has(propType) ? computePressureFactor(team, opponent, teamSeasonIndex) : { available: false }
          };

          const full = estimatePropProbability(factors, 0.5, MODEL_COEFFS);
          const base = estimatePropProbability(factors, 0.5, ZERO_NUDGE_COEFFS);
          if (full.available) fullRecords.push({ p: full.modelProb, hit, tier: full.confidence });
          if (base.available) baseRecords.push({ p: base.modelProb, hit });
        }
      }
    }
    log(`${season}: walked weeks ${weeks.filter(w => w >= MIN_TRAILING_GAMES + 1).join(", ") || "(none)"}. Running total: ${fullRecords.length} graded rows.`);
  }

  log(`\nBaseline "beat own trailing average" rate: ${overallHit}/${overallN} (${overallN ? (100 * overallHit / overallN).toFixed(1) : "?"}%). ` +
    `Should sit near 50% by construction (see scripts/backtest.js's own note) — a real departure means the proxy is skewed, not that the model is.`);

  log(`\n-- Full model (real MODEL_COEFFS, all nudges active) --`);
  log(`n = ${fullRecords.length}`);
  log(`Brier score: ${brierScore(fullRecords)?.toFixed(4)}  (0 = perfect, 0.25 = "always guess 50%", 1 = perfectly wrong — lower is better)`);
  log(`Log-loss:    ${logLossScore(fullRecords)?.toFixed(4)}  (0 = perfect; heavily punishes confident-and-wrong calls)`);
  log(`\nCalibration table (predicted-probability bucket vs. actual hit rate — a well-calibrated model has these two columns close):`);
  log(`range      n      avgPredicted   actualHitRate`);
  calibrationTable(fullRecords).forEach(r => {
    log(`${r.range.padEnd(10)} ${String(r.n).padStart(6)}   ${r.avgPredicted == null ? "  n/a " : (r.avgPredicted * 100).toFixed(1).padStart(6) + "%"}      ${r.actualHitRate == null ? "  n/a" : (r.actualHitRate * 100).toFixed(1).padStart(6) + "%"}`);
  });
  log(`\nConfidence-tier breakdown (does "high confidence" actually mean a higher real hit rate?):`);
  log(`tier     n       avgPredicted   actualHitRate   brier`);
  tierBreakdown(fullRecords).forEach(r => {
    log(`${r.tier.padEnd(8)} ${String(r.n).padStart(6)}   ${r.avgPredicted == null ? "  n/a " : (r.avgPredicted * 100).toFixed(1).padStart(6) + "%"}      ${r.actualHitRate == null ? "  n/a" : (r.actualHitRate * 100).toFixed(1).padStart(6) + "%"}      ${r.brier == null ? "n/a" : r.brier.toFixed(4)}`);
  });

  log(`\n-- Zero-nudges baseline (market anchor [fixed 0.5] + player's own recent-history blend only, no contextual nudges) --`);
  log(`n = ${baseRecords.length}`);
  log(`Brier score: ${brierScore(baseRecords)?.toFixed(4)}`);
  log(`Log-loss:    ${logLossScore(baseRecords)?.toFixed(4)}`);

  const fullBrier = brierScore(fullRecords), baseBrier = brierScore(baseRecords);
  if (fullBrier != null && baseBrier != null) {
    const improvement = baseBrier - fullBrier;
    log(`\nFull model vs. zero-nudges baseline: Brier score ${improvement > 0 ? "improved" : "got worse"} by ${Math.abs(improvement).toFixed(4)} ` +
      `(${improvement > 0 ? "the contextual nudges are adding real signal on top of the market+history blend" : "the contextual nudges are NOT helping in this walk-forward test — no worse than noise, at best"}).`);
  }

  return { fullRecords, baseRecords };
}

// ---------------------------------------------------------------------------------------------------------
// Part 2: synthetic Monte Carlo stress test of the nudge-combination machinery
// ---------------------------------------------------------------------------------------------------------
function randNormal(mean = 0, sd = 1) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function binomialDraw(n, p) { let k = 0; for (let i = 0; i < n; i++) if (Math.random() < p) k++; return k; }
function bernoulli(p) { return Math.random() < p ? 1 : 0; }

function runMonteCarloStressTest(trials = 25000) {
  log(`\n=== Part 2: synthetic Monte Carlo stress test (${trials} simulated trials) ===`);
  log(`Every trial has a KNOWN ground-truth probability (p_true) the model never sees directly — it only sees a`);
  log(`noisy market price and noisy, correlated-but-imperfect "evidence" the same shape the real factors have.`);
  log(`This checks whether the model's log-odds combination logic stays honest, not whether real football works`);
  log(`this way — see the file header for the full caveat.`);

  const records = [];
  for (let i = 0; i < trials; i++) {
    // Ground truth: real player-prop probabilities cluster fairly close to a coin flip (that's how lines get
    // set in the first place) with a real spread either way — not a guessed number, just a reasonable
    // distribution shape for "how far from 50/50 does a typical prop actually sit."
    const pTrue = clipProb(0.5 + randNormal(0, 0.12));
    // The market's own price: close to pTrue but with real book-pricing noise/error, not a perfect oracle.
    const marketProb = clipProb(pTrue + randNormal(0, 0.03));

    // "Own evidence": genuine binomial draws (real sampling variance from a real finite game count), not just
    // Gaussian noise around pTrue — this is the exact shape ownEvidence() in lib/probability.js consumes.
    const n10 = 3 + Math.floor(Math.random() * 8); // 3-10 games, same range real trailing samples span
    const rate10 = binomialDraw(n10, pTrue) / n10;
    const nOpp = Math.floor(Math.random() * 5); // 0-4 games
    const rateOpp = nOpp ? binomialDraw(nOpp, pTrue) / nOpp : 0;
    const n3 = Math.min(3, n10);
    const rate3 = binomialDraw(n3, pTrue) / n3;

    // Correlated-but-noisy contextual flags: each is MORE likely to fire the direction pTrue actually leans,
    // but far from a perfect readout of it — matching the real, modest lift sizes scripts/backtest.js actually
    // measured (a few points of real lift, not a clean signal) rather than an idealized strong one.
    const lean = pTrue - 0.5;
    const weakDefense = Math.random() < clipProb(0.5 + lean * 1.5 + randNormal(0, 0.25));
    const matchupEdgeHigh = Math.random() < clipProb(0.5 + lean * 1.5 + randNormal(0, 0.25));
    const highScoringEnv = Math.random() < clipProb(0.5 + lean * 1.2 + randNormal(0, 0.3));

    const factors = {
      propType: "rec_yds",
      form: { available: true, n_last10: n10, rate_last10: rate10, n_vsOpp: nOpp, rate_vsOpp: rateOpp, n_last3: n3, rate_last3: rate3 },
      defense: { available: true, rank: weakDefense ? 5 : 20, ofTeams: 32 },
      matchupEdge: { available: true, edge: matchupEdgeHigh ? 0.08 : 0 },
      scoringEnvironment: { available: true, combinedEpaPerPlay: highScoringEnv ? 0.15 : 0 }
    };

    const result = estimatePropProbability(factors, marketProb, MODEL_COEFFS);
    if (!result.available) continue;
    records.push({ p: result.modelProb, hit: !!bernoulli(pTrue), marketProbOnly: marketProb });
  }

  const marketOnlyRecords = records.map(r => ({ p: r.marketProbOnly, hit: r.hit }));
  log(`\nn = ${records.length}`);
  log(`Model Brier score:        ${brierScore(records)?.toFixed(4)}`);
  log(`Model log-loss:           ${logLossScore(records)?.toFixed(4)}`);
  log(`Market-price-only Brier:  ${brierScore(marketOnlyRecords)?.toFixed(4)}  (using the noisy market price alone as the "prediction," for reference)`);
  log(`\nCalibration table (should track the diagonal closely under these known, well-behaved assumptions):`);
  log(`range      n      avgPredicted   actualHitRate`);
  calibrationTable(records).forEach(r => {
    log(`${r.range.padEnd(10)} ${String(r.n).padStart(6)}   ${r.avgPredicted == null ? "  n/a " : (r.avgPredicted * 100).toFixed(1).padStart(6) + "%"}      ${r.actualHitRate == null ? "  n/a" : (r.actualHitRate * 100).toFixed(1).padStart(6) + "%"}`);
  });

  // Overconfidence check: within each predicted-probability bucket, is the model's average CONFIDENCE (distance
  // of its own prediction from 50%) bigger than the real accuracy in that bucket would justify? A simple,
  // concrete version: compare Brier score against the "perfectly calibrated" Brier a forecaster with these same
  // predicted probabilities and this exact hit rate curve would get — the calibration table above already
  // shows this directly per bucket, this is just the one-number summary.
  const cal = calibrationTable(records);
  const calibrationGap = avg(cal.filter(r => r.n > 0).map(r => Math.abs(r.avgPredicted - r.actualHitRate)));
  log(`\nMean |predicted - actual| across buckets: ${calibrationGap != null ? (calibrationGap * 100).toFixed(1) + " points" : "n/a"} ` +
    `(near 0 = well-calibrated under these simulated assumptions; a large, consistently-one-directional gap would mean the log-odds stacking is overconfident).`);

  return records;
}

async function main() {
  const { fullRecords } = await runHistoricalValidation();
  runMonteCarloStressTest();
  log(`\n=== Summary ===`);
  log(`Historical walk-forward rows graded: ${fullRecords.length}. See both sections above for the real numbers —`);
  log(`this script prints honest findings, it doesn't grade itself. Re-read the file header before quoting a`);
  log(`single number out of context: Part 1 measures "beats own recent level" (proxy), not "beats the real market";`);
  log(`Part 2 measures whether the combination math is sound, not whether real football behaves this way.`);
}

main().catch(e => { console.error(e); process.exit(1); });
