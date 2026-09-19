// Answers a question the app never asked itself before: does each contextual factor in the probability model
// (lib/probability.js) actually predict anything, checked against real multi-season nflverse history — rather
// than being trusted just because it sounds plausible, the way the old point-scoring system's +6/+7 bonuses
// were. Overwrites lib/modelCoeffs.js with measured, sample-size-shrunk coefficients when it's done.
//
// WHAT THIS CAN AND CAN'T PROVE: SportsGameOdds' Rookie tier has no historical odds archive, so there is no way
// to backtest against real historical market lines. Instead, this walks forward through each season week by
// week and checks whether a player beat his OWN trailing average for that stat — a reasonable stand-in for "the
// market already prices in a player's normal level" (a repeat starter's line usually tracks his rolling
// average), but it is genuinely a different, easier question than "did this beat the real closing line." Every
// number below answers "does this factor predict beating the player's own recent level," not "does this factor
// beat the market." The live results ledger (lib/grading.js, README's "Probability model" section) is what
// eventually answers the harder question, one real graded pick at a time as the app runs live.
//
// Factors with no historical feed available at all — opponent secondary injuries, O-line injuries, a
// teammate-out usage bump, and market steam (all of which need either a historical injury-report archive or a
// historical odds-movement archive, neither of which exists here) — are left at their hand-set defaults and
// reported as untested, not disproven.
//
// Walk-forward discipline: for a game in week W, every input (trailing stat average, defense-vs-position rank,
// team EPA, snap share, red-zone share, starter continuity, rest/travel) is built only from weeks strictly
// before W within that same season — never from W itself or later — so a factor can't get credit for
// "predicting" something it was actually computed from.
//
// Usage: node scripts/backtest.js [season ...]   (defaults to the last 3 calendar years)
import fs from "node:fs";
import { fetchMultiSeasonStats, fetchSchedule, fetchSnapCounts, fetchPlayByPlay } from "../lib/fetchers/nflverse.js";
import { buildGameLogIndex, shortForm, pbpShortKey } from "../lib/identity.js";
import { buildTeamSeasonIndex } from "../lib/factors/teamStats.js";
import { computeDefenseVsPosition, computeVenueSplit, statValueFn, PROP_TYPES } from "../lib/factors/playerSplits.js";
import { computeMatchupEdge, computeScoringEnvironment } from "../lib/factors/playerPbp.js";
import { computeScheduleFactor, computeStarterChangeFactor } from "../lib/factors/schedule.js";
import { BIG_SPREAD_THRESHOLD } from "../lib/factors/index.js";
import { RUN_PROPS, PASS_PROPS } from "../lib/probability.js";
import { fetchHistoricalWeather } from "../lib/fetchers/weather.js";
import { STADIUMS } from "../lib/stadiums.js";
import { normTeam } from "../lib/teamCodes.js";
import { logit } from "../lib/oddsMath.js";
import { MODEL_COEFFS as PREV_COEFFS } from "../lib/modelCoeffs.js";
import { computeRefereeFactor } from "../lib/factors/referee.js";

const log = (msg) => console.log(msg);

const argSeasons = process.argv.slice(2).map(Number).filter(n => !isNaN(n));
const SEASONS = argSeasons.length ? argSeasons : [1, 2, 3].map(n => new Date().getFullYear() - n);
const MIN_TRAILING_GAMES = 3;
const REG_K = 30;       // shrinkage anchor, in "games" — fewer supporting games pulls the coefficient hard toward 0
const MAX_COEFF = 0.35; // cap so a noisy factor can't swing the model further than any hand-set default did

// Factors this script has real historical data for. Anything in MODEL_COEFFS not listed here is left untouched
// (see HAND_SET_NOTES below for why each of those is still hand-set, and writeCoeffsFile for how it now refuses
// to silently drop a coefficient it doesn't recognize).
const BACKTESTED_KEYS = [
  "form_hot", "weak_defense", "matchup_edge", "high_scoring_env",
  "usage_high_snap", "redzone_share", "starter_change", "short_week_penalty", "travel_penalty",
  // Added alongside opposing-front-seven-injury and Vegas game-script (see lib/modelCoeffs.js's own comments):
  // weather_run_favor/weather_pass_penalty now measure against real historical weather (Open-Meteo's archive
  // API, the same source lib/pipeline.js's live backfill uses) instead of staying hand-set forever; venue_edge
  // measures against the schedule's own roof column, already being fetched; game_script_run_favor/
  // game_script_pass_favor measure against nflverse's own historical spread_line/total_line columns. Personal
  // weather history (weather_personal_boost/penalty) and front_seven_injury stay hand-set — see HAND_SET_NOTES.
  "weather_run_favor", "weather_pass_penalty", "venue_edge", "game_script_run_favor", "game_script_pass_favor",
  // Referee tendency, revived as a non-bettable context factor (lib/factors/referee.js) — measured walk-forward
  // against nflverse's own historical referee/total/total_line schedule columns, using only games that referee
  // had already called strictly before the one being tested (see refereeFactorAsOf below). ngs_*/pressure_*
  // coefficients stay hand-set for now (see lib/modelCoeffs.js's own comment on those).
  "referee_over_lean", "referee_under_lean"
];

// Why each coefficient NOT in BACKTESTED_KEYS is still hand-set — used by writeCoeffsFile to annotate the
// generated file so the reason travels with the number instead of living only in this script's memory.
const HAND_SET_NOTES = {
  tendency_usage_bump: "not backtestable — no historical injury-report feed",
  secondary_injury: "not backtestable — no historical injury-report feed",
  oline_injury_penalty: "not backtestable — no historical injury-report feed",
  steam_move: "not backtestable — no historical odds-movement archive",
  weather_personal_boost: "not backtestable — no historical weather-forecast archive",
  weather_personal_penalty: "not backtestable — no historical weather-forecast archive",
  practice_trend_down: "not backtestable — no day-by-day historical practice-report archive",
  practice_trend_up: "not backtestable — no day-by-day historical practice-report archive",
  front_seven_injury: "not backtestable — no historical injury-report feed (mirrors secondary_injury)"
};

// Statistical pruning: before this, a factor's coefficient was shrunk only by SAMPLE SIZE (REG_K below) — a
// factor with a tiny, meaningless lift but a huge N (thousands of rows) barely got shrunk at all, meaning noise
// could sit in the combined logit stack right alongside real signal, diluting it. That's a real, measured
// contributor to why the full model's real walk-forward Brier score came out statistically tied with a flat 50%
// baseline (see scripts/validate-model.js and README's "How accurate is the model, really?" section) — several
// factors were very likely adding noise, not signal. Fixed here with a real two-proportion z-test: a factor only
// keeps a nonzero coefficient when its with/without hit-rate gap is large enough, relative to its own sample
// size, to be statistically distinguishable from chance at the conventional p<0.05 bar. A factor that fails that
// bar is pruned to exactly 0 (not softly shrunk) — it stops contributing to every scored prop until a future,
// larger backtest sample gives it a fair chance to prove itself again.
function erf(x) {
  // Abramowitz & Stegun 7.1.26 approximation — accurate to ~1.5e-7, plenty for a p-value used as a keep/prune
  // gate rather than a published statistic.
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
function normalCDF(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }
// Two-proportion z-test on hitRateWith vs hitRateWithout, pooled under the null hypothesis that the factor makes
// no real difference. Returns a two-tailed p-value — the probability of seeing a gap this large (or larger) by
// pure chance if the factor actually did nothing. Small n1/n2 or a small real gap both push p toward 1 (can't
// distinguish from noise); a real, well-supported gap pushes p toward 0.
function twoProportionZTest(p1, n1, p2, n2) {
  if (!n1 || !n2) return { z: 0, p: 1 };
  const pooled = (p1 * n1 + p2 * n2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (se === 0) return { z: 0, p: 1 };
  const z = (p1 - p2) / se;
  return { z, p: 2 * (1 - normalCDF(Math.abs(z))) };
}
const SIGNIFICANCE_P = 0.05;

function normName(raw) { return String(raw || "").toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim(); }
function avg(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null; }
function newBucket() { return { withHit: 0, withN: 0, withoutHit: 0, withoutN: 0 }; }
function record(bucket, present, hit) {
  if (present) { bucket.withN++; if (hit) bucket.withHit++; } else { bucket.withoutN++; if (hit) bucket.withoutHit++; }
}
// Grouping red-zone plays by team once per week (instead of re-filtering the whole prior-play log for every
// single player) is what keeps a multi-season backtest running in minutes instead of hours — by week 17 the
// "prior plays" set is a full season's worth, and this function used to get called once per skill player.
function groupRedZonePlaysByTeam(priorPbp) {
  const byTeam = new Map();
  for (const r of priorPbp) {
    if (r.yardline_100 == null || r.yardline_100 > 20) continue;
    if (r.pass_attempt !== 1 && r.rush_attempt !== 1) continue;
    if (!byTeam.has(r.posteam)) byTeam.set(r.posteam, []);
    byTeam.get(r.posteam).push(r);
  }
  return byTeam;
}
const TD_PROP_TYPES = ["td", "td_pass", "td_rush", "td_rec"];
// This backtest has no real per-game market line to test against for a past season, only a trailing average —
// so for every TD-flavored prop it deliberately grades against a fixed "did it happen at all" (0) threshold
// instead, purely as a research stand-in. That's a different, DELIBERATE simplification from the live app's own
// grading, not a claim that it matches it: the live app's real Passing/Rushing/Receiving TD props are genuine
// Over/Under markets with an actual posted line (thresholdFor in playerSplits.js grades those against the real
// line, same as a yardage/reception prop) — only Anytime TD ("td") is truly a 0-threshold yes/no market there.
// The reason this fixed 0 still matters here: a low-mean counting stat clears its own trailing MEAN well under
// half the time by construction (Poisson-shaped — mostly 0s, occasionally 1), which showed up as an
// artificially low ~37% baseline hit rate before TD props were split out from the trailing-average approach.
// Yardage/reception props have no such fixed threshold in real markets, so the trailing average remains the
// least-bad available stand-in for "about where the market has this player projected."
function backtestThreshold(propType, trailingAvg) {
  return TD_PROP_TYPES.includes(propType) ? 0 : trailingAvg;
}

function trailingRedZoneShare(rzPlaysByTeam, team, playerKey) {
  const teamPlays = rzPlaysByTeam.get(team);
  if (!teamPlays || teamPlays.length < 4) return null;
  const touches = teamPlays.filter(r => pbpShortKey(r.receiver_player_name) === playerKey || pbpShortKey(r.rusher_player_name) === playerKey);
  return touches.length / teamPlays.length;
}

// One historical-weather lookup per game (not per player), reusing the exact same Open-Meteo archive API and
// wet/windy threshold the live pipeline's backfillHistoricalWeather (lib/pipeline.js) uses, so a "does the
// weather nudge predict anything" answer here means the same thing it would live. Cached in-memory only — this
// is a standalone script run, not the live app, so there's no Blobs store to persist it in between runs, and
// re-running the backtest is expected to refetch it.
async function buildWeatherCache(schedule, seasons, log) {
  const cache = new Map();
  const jobs = [];
  const seen = new Set();
  for (const g of schedule) {
    const season = Number(g.season);
    if (!seasons.includes(season)) continue;
    const home = normTeam(g.home_team || g.home);
    const week = Number(g.week);
    if (!home || isNaN(week)) continue;
    const key = `${home}|${season}|${week}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const roof = (g.roof || "").toLowerCase();
    if (roof.includes("dome") || roof === "closed") { cache.set(key, false); continue; } // no API call needed for a roofed game
    const venue = STADIUMS[home];
    const date = g.gameday || g.game_date;
    if (!venue || !date) continue; // leave uncached -> treated as unknown, not "good weather"
    jobs.push({ key, lat: venue.lat, lon: venue.lon, date });
  }
  log(`Backfilling historical weather for ${jobs.length} past outdoor games via Open-Meteo (this is the slow part — expect several minutes, not cached between runs)...`);
  const CONCURRENCY = 5;
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const group = jobs.slice(i, i + CONCURRENCY);
    await Promise.all(group.map(async (j) => {
      const result = await fetchHistoricalWeather(j.lat, j.lon, j.date, log);
      cache.set(j.key, result?.available ? result.wasWet : null);
    }));
  }
  return cache;
}

// nflverse's games.csv spread_line is CONFIRMED the opposite sign convention from a standard sportsbook board:
// positive spread_line means the HOME team is favored (see nfldata/DATASETS.md), whereas the live pipeline's own
// extractGameContext (lib/analyze.js) assumes the standard book convention (negative = home favored). Negating
// here is what makes this backtest's "big favorite/big underdog" reads mean the same thing computeGameScript
// means live — get this wrong and the whole game_script_* backtest would be silently measuring the opposite of
// what the live nudge does.
// Walk-forward-safe wrapper around lib/factors/referee.js's computeRefereeFactor: the live function happily
// reads the WHOLE schedule file (safe live, since a future/unplayed game always has a blank referee/total
// anyway), but a backtest replaying a past season needs the same discipline every other factor in this loop
// follows — only games that referee had ACTUALLY called strictly before `cutoffDate` count, or a 2024 test row
// could silently learn from that same referee's games later in that same season.
function refereeFactorAsOf(refereeName, cutoffDate, fullSchedule) {
  if (!refereeName || !cutoffDate) return { available: false };
  const cutoff = new Date(cutoffDate);
  const priorGames = fullSchedule.filter(s => {
    const d = s.gameday || s.game_date;
    return d && new Date(d) < cutoff;
  });
  return computeRefereeFactor(refereeName, priorGames);
}

function scheduleGameScript(gameRow, team, homeTeam) {
  const spreadLineRaw = Number(gameRow.spread_line);
  const totalLineRaw = Number(gameRow.total_line);
  if (isNaN(spreadLineRaw) || isNaN(totalLineRaw) || !homeTeam) return { available: false };
  const homeSpread = -spreadLineRaw; // flip nflverse's home-favored-positive into the live pipeline's home-favored-negative
  const teamSpread = team === homeTeam ? homeSpread : -homeSpread;
  return { available: true, teamSpread, isBigFavorite: teamSpread <= -BIG_SPREAD_THRESHOLD, isBigUnderdog: teamSpread >= BIG_SPREAD_THRESHOLD };
}

async function main() {
  log(`Backtesting factor signal strength against seasons: ${SEASONS.join(", ")}`);
  log(`(This fetches multiple seasons of full play-by-play, plus a historical-weather backfill for the new`);
  log(`weather_run_favor/weather_pass_penalty keys — it can take several minutes now, not just a few.)`);

  const scheduleRaw = await fetchSchedule(log);
  const hasGameType = scheduleRaw.some(r => "game_type" in r);
  const schedule = hasGameType ? scheduleRaw.filter(r => r.game_type === "REG") : scheduleRaw;
  const weatherCache = await buildWeatherCache(schedule, SEASONS, log);

  const buckets = Object.fromEntries(BACKTESTED_KEYS.map(k => [k, newBucket()]));
  let overallHit = 0, overallN = 0;

  // Everything below fetches ONE season's stats/play-by-play/snap-counts at a time, right before that season is
  // walked, instead of pre-loading every season's raw rows into a statRowsAll/pbpBySeason/snapsBySeason object up
  // front. Full play-by-play in particular is parsed from CSV at 370+ raw columns before being trimmed (see
  // fetchPlayByPlay) — holding that for every season in SEASONS simultaneously, on top of full-season stat and
  // snap-count rows, is what pushed a real run past Node's default heap ceiling on a lower-RAM machine (this
  // sandbox's own run happened not to hit it, but a `FATAL ERROR: Reached heap limit` on a real machine is a real
  // bug in this script, not a fluke of that machine). Fetching one season, walking it, then letting its raw rows
  // fall out of scope before the next season's fetch starts keeps peak memory to roughly one season's worth
  // instead of SEASONS.length seasons' worth. package.json's "backtest" script also now raises Node's heap
  // ceiling directly (--max-old-space-size) as a second, independent safety margin.
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
      const priorSnapsByPlayer = new Map();
      seasonSnaps.filter(s => Number(s.week) < week).forEach(s => {
        const key = normName(s.player || s.pfr_player_name || "");
        if (!key) return;
        (priorSnapsByPlayer.get(key) || priorSnapsByPlayer.set(key, []).get(key)).push(s.offense_pct);
      });
      const defCache = new Map(); // (opponent|position) -> computeDefenseVsPosition result, shared across every player facing that matchup this week
      const rzPlaysByTeam = groupRedZonePlaysByTeam(priorPbp);

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

        // Factors that don't depend on which prop is being tested — computed once per player-week, not once
        // per prop type, both for speed and because the underlying real-world fact is the same either way.
        const defKey = `${opponent}|${position}`;
        if (!defCache.has(defKey)) defCache.set(defKey, computeDefenseVsPosition(opponent, position, priorGameLogIndex));
        const def = defCache.get(defKey);
        const weakDefense = def.available && def.rank <= Math.ceil((def.ofTeams || 32) * 0.35);

        const matchup = computeMatchupEdge(team, opponent, teamSeasonIndex);
        const matchupEdgeHigh = matchup.available && matchup.edge > 0.05;
        const scoring = computeScoringEnvironment(team, opponent, teamSeasonIndex);
        const highScoringEnv = scoring.available && scoring.combinedEpaPerPlay > 0.1;

        const snapPct = avg((priorSnapsByPlayer.get(logKey) || []).slice(-3).filter(v => v != null));
        const highSnap = snapPct != null && snapPct >= 0.75;
        const rz = trailingRedZoneShare(rzPlaysByTeam, team, shortForm(name));
        const heavyRedZone = rz != null && rz >= 0.3;

        let shortWeek = false, longTravel = false, starterChanged = false;
        // gameWasWet: null = unknown (no roof/venue/date to look up), true/false = a real Open-Meteo answer.
        // roofRaw/roofKnown feed the venue_edge check below (mirrors probability.js's own venue nudge gating).
        // gameScript: the Vegas-implied favorite/underdog read for THIS row's team, from nflverse's own
        // historical spread_line/total_line (see scheduleGameScript's sign-convention note above).
        let gameWasWet = null, roofRaw = null, roofKnown = false;
        let gameScript = { available: false };
        let refFactor = { available: false };
        const gameRow = seasonSchedule.find(s => Number(s.week) === week &&
          (normTeam(s.home_team || s.home) === team || normTeam(s.away_team || s.away) === team));
        if (gameRow) {
          const homeTeam = normTeam(gameRow.home_team || gameRow.home);
          const sched = computeScheduleFactor({
            team, opponentTeam: opponent, homeTeam, kickoffISO: gameRow.gameday || gameRow.game_date, gameRow
          });
          shortWeek = sched.available && !!sched.shortWeek;
          longTravel = sched.available && sched.travelMiles > 1500;
          const thisWeekStarter = homeTeam === team ? gameRow.home_qb_name : gameRow.away_qb_name;
          const starter = computeStarterChangeFactor(team, season, week, thisWeekStarter, seasonSchedule);
          starterChanged = starter.available && starter.changed;
          roofRaw = (gameRow.roof || "").toLowerCase();
          roofKnown = !!roofRaw;
          const cached = weatherCache.get(`${homeTeam}|${season}|${week}`);
          gameWasWet = cached === undefined ? null : cached;
          gameScript = scheduleGameScript(gameRow, team, homeTeam);
          refFactor = refereeFactorAsOf(gameRow.referee, gameRow.gameday || gameRow.game_date, schedule);
        }

        for (const propType of PROP_TYPES) {
          const statFor = statValueFn(propType);
          const trailingVals = priorPlayerRows.slice(-10).map(statFor);
          const trailingAvg = avg(trailingVals);
          const threshold = backtestThreshold(propType, trailingAvg);
          const actual = statFor(row);
          if (threshold == null || actual === threshold) continue;
          const hit = actual > threshold;
          overallHit += hit ? 1 : 0; overallN++;

          const last3 = priorPlayerRows.slice(-3).map(statFor);
          const formHot = last3.length === 3 && last3.filter(v => v > threshold).length / 3 >= 0.66;

          record(buckets.form_hot, formHot, hit);
          record(buckets.weak_defense, weakDefense, hit);
          record(buckets.matchup_edge, matchupEdgeHigh, hit);
          record(buckets.high_scoring_env, highScoringEnv, hit);
          record(buckets.usage_high_snap, highSnap, hit);
          record(buckets.redzone_share, heavyRedZone, hit);
          record(buckets.starter_change, starterChanged, hit);
          record(buckets.short_week_penalty, shortWeek, hit);
          record(buckets.travel_penalty, longTravel, hit);
          // Ungated, same as the nine factors above — referee tendency is read as a general scoring-environment
          // tailwind/headwind, not a run- or pass-specific one (see lib/probability.js's own comment on why).
          if (refFactor.available) {
            record(buckets.referee_over_lean, refFactor.overRate >= 0.6, hit);
            record(buckets.referee_under_lean, refFactor.overRate <= 0.4, hit);
          }

          // These five are gated to the same prop types the live nudges themselves are scoped to (RUN_PROPS/
          // PASS_PROPS from lib/probability.js) — recording them against every prop type regardless, the way the
          // nine factors above do, would mean asking "does bad weather predict a QB's own passing yards beating
          // HIS OWN trailing average" using rows where the nudge could never have fired live in the first place.
          if (RUN_PROPS.has(propType)) {
            if (gameWasWet != null) record(buckets.weather_run_favor, gameWasWet === true, hit);
            if (gameScript.available) record(buckets.game_script_run_favor, gameScript.isBigFavorite, hit);
          } else if (PASS_PROPS.has(propType)) {
            if (gameWasWet != null) record(buckets.weather_pass_penalty, gameWasWet === true, hit);
            if (gameScript.available) record(buckets.game_script_pass_favor, gameScript.isBigUnderdog, hit);

            // venue_edge: only means something once a real dome-vs-outdoor split (2+ games each way) is
            // cross-referenced against which one THIS week's game actually is — same gating as the live nudge in
            // lib/probability.js. Built from priorGameLogIndex only (never this week's own row), so this is a
            // real walk-forward measurement, not the player's full-season split leaking into its own test.
            const venue = computeVenueSplit({ _logKey: logKey, team }, opponent, priorGameLogIndex, seasonSchedule, propType);
            if (venue.available && roofKnown && venue.domeN >= 2 && venue.outdoorN >= 2) {
              const isDomeGame = roofRaw !== "outdoors";
              const domeBetter = venue.domeAvg > venue.outdoorAvg;
              record(buckets.venue_edge, (isDomeGame && domeBetter) || (!isDomeGame && !domeBetter), hit);
            }
          }
        }
      }
    }
    log(`${season}: walked weeks ${weeks.filter(w => w >= MIN_TRAILING_GAMES + 1).join(", ") || "(none — season too short)"}.`);
  }

  log(`\nBaseline: beat own trailing average ${overallHit}/${overallN} times (${overallN ? (100 * overallHit / overallN).toFixed(1) : "?"}%). ` +
    `Should sit fairly close to 50% by construction — a big departure means the "beat your own trailing average" proxy is skewed (e.g. rookies/breakouts trending up all season) more than it means every factor is broken.`);

  const results = {};
  let prunedCount = 0, keptCount = 0;
  for (const key of BACKTESTED_KEYS) {
    const b = buckets[key];
    const hitRateWith = b.withN ? b.withHit / b.withN : null;
    const hitRateWithout = b.withoutN ? b.withoutHit / b.withoutN : null;
    const lift = (hitRateWith != null && hitRateWithout != null) ? hitRateWith - hitRateWithout : null;
    const rawLogit = (hitRateWith != null && hitRateWithout != null) ? logit(hitRateWith) - logit(hitRateWithout) : 0;
    const ztest = (hitRateWith != null && hitRateWithout != null)
      ? twoProportionZTest(hitRateWith, b.withN, hitRateWithout, b.withoutN) : { z: 0, p: 1 };
    const significant = b.withN >= 20 && ztest.p < SIGNIFICANCE_P;
    // A factor that fails the significance test is pruned to exactly 0, not softly shrunk by sample size alone —
    // see the comment above twoProportionZTest for why the old sample-size-only shrinkage let noisy-but-frequent
    // factors keep meaningful weight. A significant factor still goes through the existing REG_K sample-size
    // shrinkage on top, so a factor that's real but thin-sampled still gets pulled partway toward 0.
    const shrunk = significant ? Math.max(-MAX_COEFF, Math.min(MAX_COEFF, rawLogit * (b.withN / (b.withN + REG_K)))) : 0;
    const verdict = b.withN < 20 ? "not enough data — kept at prior default"
      : significant ? `real signal (p=${ztest.p.toFixed(3)}) — kept`
      : `no significant signal (p=${ztest.p.toFixed(3)}) — PRUNED to 0`;
    if (b.withN >= 20) { if (significant) keptCount++; else prunedCount++; }
    results[key] = { ...b, hitRateWith, hitRateWithout, lift, rawLogit, ztest, significant, shrunk, verdict };
  }

  log("\nFactor                 withN  withoutN  hitRate(with)  hitRate(without)   lift    p-value  coeff(old -> new)   verdict");
  for (const key of BACKTESTED_KEYS) {
    const r = results[key];
    const pct = (v) => v == null ? "  n/a" : (v * 100).toFixed(1).padStart(5);
    const newCoeff = r.withN < 20 ? PREV_COEFFS[key] : +r.shrunk.toFixed(3);
    log(`${key.padEnd(22)} ${String(r.withN).padStart(5)}  ${String(r.withoutN).padStart(8)}     ${pct(r.hitRateWith)}%        ${pct(r.hitRateWithout)}%      ` +
      `${r.lift == null ? " n/a" : (r.lift * 100).toFixed(1).padStart(5) + "%"}   ${r.ztest.p.toFixed(3).padStart(6)}   ${PREV_COEFFS[key].toFixed(2)} -> ${newCoeff.toFixed(3)}      ${r.verdict}`);
  }
  log(`\nOf ${keptCount + prunedCount} factors with enough data to test (p<${SIGNIFICANCE_P} bar): ${keptCount} kept a real, statistically distinguishable signal; ${prunedCount} were pruned to exactly 0 as statistically indistinguishable from noise at this sample size. A pruned factor isn't necessarily fake — it may just need more games than are available yet — but it stops contributing to every scored prop until a future, larger backtest gives it another chance.`);

  const untested = Object.keys(PREV_COEFFS).filter(k => !BACKTESTED_KEYS.includes(k) && typeof PREV_COEFFS[k] === "number");
  log(`\nNot backtestable with data on hand (left at hand-set defaults): ${untested.join(", ")}.`);

  const newCoeffs = { ...PREV_COEFFS };
  for (const key of BACKTESTED_KEYS) {
    const r = results[key];
    newCoeffs[key] = r.withN < 20 ? PREV_COEFFS[key] : +r.shrunk.toFixed(3);
  }
  newCoeffs.generatedAt = new Date().toISOString();
  newCoeffs.source = "backtest";
  newCoeffs._backtestSeasons = SEASONS;
  newCoeffs._backtestSampleSizes = Object.fromEntries(BACKTESTED_KEYS.map(k => [k, { withN: buckets[k].withN, withoutN: buckets[k].withoutN }]));
  // Auditable record of which factors actually earned their coefficient this run vs. got pruned to 0 for lacking
  // a statistically real signal — so anyone reading the generated file (or a future backtest diffing against it)
  // can see the reasoning, not just the final numbers. See twoProportionZTest's own comment above for why this
  // replaced pure sample-size shrinkage.
  newCoeffs._backtestVerdicts = Object.fromEntries(BACKTESTED_KEYS.map(k => [k, results[k].verdict]));

  writeCoeffsFile(newCoeffs);
  log(`\nWrote lib/modelCoeffs.js with measured coefficients from ${SEASONS.join(", ")}.`);
}

// Cosmetic grouping only, for the generated file's section headers/blank lines — a coefficient left out of every
// group below still gets written by the "uncategorized" fallback in writeCoeffsFile, just without a header. This
// is the actual fix for a real latent bug: the old version of this function had a hardcoded per-key template
// that didn't know about the weather/venue/practice-trend/front-seven/game-script coefficients a prior session
// added to lib/modelCoeffs.js by hand — meaning running `npm run backtest` would have silently ERASED all of
// them on the very next regeneration. Now every key in the merged coefficient object gets written somewhere.
const CORE_KEYS = ["form_hot", "tendency_usage_bump", "usage_high_snap", "redzone_share", "weak_defense",
  "matchup_edge", "high_scoring_env", "starter_change", "secondary_injury", "oline_injury_penalty",
  "short_week_penalty", "travel_penalty", "steam_move"];
const WEATHER_VENUE_KEYS = ["weather_personal_boost", "weather_personal_penalty", "weather_run_favor",
  "weather_pass_penalty", "venue_edge", "practice_trend_down", "practice_trend_up"];
const GAME_SCRIPT_KEYS = ["front_seven_injury", "game_script_run_favor", "game_script_pass_favor"];
const REFEREE_KEYS = ["referee_over_lean", "referee_under_lean"];
const NGS_PRESSURE_KEYS = ["ngs_cpoe_hot", "ngs_cpoe_cold", "ngs_ryoe_hot", "ngs_ryoe_cold", "ngs_separation_hot", "pressure_risk_penalty", "clean_pocket_boost"];
const QBR_TREND_KEYS = ["qbr_trend_elite", "qbr_trend_poor"];
const METADATA_KEYS = ["marketPriorWeight", "generatedAt", "source", "_backtestSeasons", "_backtestSampleSizes", "_backtestVerdicts"];

function writeCoeffsFile(c) {
  // A backtested key gets its real verdict from this run (kept/pruned, with the p-value) right on its own line —
  // so a 0 sitting next to "pruned to 0" reads as a deliberate, tested finding, not a mistake or an omission. A
  // hand-set key still gets its reason from HAND_SET_NOTES, computed fresh each run rather than frozen in a
  // string — so a key that migrates from hand-set to backtested automatically loses its "not backtestable"
  // comment instead of it silently going stale.
  const line = (key) => {
    const note = BACKTESTED_KEYS.includes(key) ? (c._backtestVerdicts?.[key] ? ` // ${c._backtestVerdicts[key]}` : "")
      : HAND_SET_NOTES[key] ? ` // ${HAND_SET_NOTES[key]}` : "";
    return `  ${key}: ${c[key]},${note}`;
  };
  const categorized = new Set([...CORE_KEYS, ...WEATHER_VENUE_KEYS, ...GAME_SCRIPT_KEYS, ...REFEREE_KEYS, ...NGS_PRESSURE_KEYS, ...QBR_TREND_KEYS, ...METADATA_KEYS]);
  const uncategorized = Object.keys(c).filter(k => !categorized.has(k));
  const uncategorizedBlock = uncategorized.length
    ? `\n  // Added to lib/modelCoeffs.js without a matching entry in scripts/backtest.js's CORE_KEYS/
  // WEATHER_VENUE_KEYS/GAME_SCRIPT_KEYS section lists — still written out here (never silently dropped), but
  // add it to one of those lists so it gets a proper section header and, if it's backtestable, real coverage.
${uncategorized.map(line).join("\n")}\n`
    : "";

  const body = `// Coefficients for lib/probability.js's logistic blend — GENERATED by scripts/backtest.js on ${c.generatedAt}
// against seasons ${JSON.stringify(c._backtestSeasons)}. Re-run that script to refresh these against more recent
// history; don't hand-edit the backtested values below without re-running it, or this comment will start lying.
// See scripts/backtest.js's header for exactly what this backtest can and can't prove, and README's
// "Probability model" section for the plain-language version.
export const MODEL_COEFFS = {
  // Not backtested (scripts/backtest.js only touches the named factor coefficients below) — hand-set at 12
  // "games" of trust behind the market's own number after checking it against dry-run's thin-vs-deep-sample
  // regression test: at 6, a bare 2-game 100% streak alone moved the estimate over 12 points off the market,
  // almost as aggressively as a real 10+3-game trend — exactly the kind of small-sample overreaction the old
  // point-scoring system was built on. At 12, the same 2-game streak moves it ~7 points while a real deep trend
  // still moves it ~20.
  marketPriorWeight: ${c.marketPriorWeight},

${CORE_KEYS.map(line).join("\n")}

  // Weather/venue/practice-trend nudges: weather_run_favor, weather_pass_penalty, and venue_edge are now
  // backtested — the first two against Open-Meteo's historical archive (the same source lib/pipeline.js's live
  // backfill uses), venue_edge against the schedule's own roof column, both already being fetched. Personal
  // weather history (weather_personal_boost/penalty) and practice_trend_down/up stay hand-set: there's no
  // per-player historical forecast archive or day-by-day practice-report history to replay them against.
${WEATHER_VENUE_KEYS.map(line).join("\n")}

  // Opposing front-seven injuries (run-game mirror of secondary_injury above) and game-script (Vegas's own
  // implied spread/total, read as context rather than a bet — see factors/index.js's computeGameScript).
  // game_script_run_favor/game_script_pass_favor are backtested against nflverse's own historical
  // spread_line/total_line columns; front_seven_injury stays hand-set for the same reason secondary_injury does
  // — no historical injury-report archive exists to replay it against.
${GAME_SCRIPT_KEYS.map(line).join("\n")}

  // Referee tendency, revived as a non-bettable context factor after this build dropped its Totals market (see
  // lib/factors/referee.js) — backtested walk-forward against nflverse's own historical referee/total/total_line
  // schedule columns, using only each referee's games strictly before the one being tested.
${REFEREE_KEYS.map(line).join("\n")}

  // Next Gen Stats player efficiency (CPOE, rush yards over expected, separation) and pass-protection/pressure —
  // real full-history nflverse/play-by-play archives exist for both, making them genuine future backtest
  // candidates, but neither is wired into this script's walk-forward loop yet — hand-set for now.
${NGS_PRESSURE_KEYS.map(line).join("\n")}

  // Real ESPN Total QBR trend (lib/factors/qbr.js) — nflverse's own espn_data release covers 2006-present, a
  // genuine full-history archive, so this is a real future backtest candidate the same way ngs_*/pressure_*
  // above are — not wired into this script's walk-forward loop yet, hand-set for now.
${QBR_TREND_KEYS.map(line).join("\n")}
${uncategorizedBlock}
  generatedAt: ${JSON.stringify(c.generatedAt)},
  source: "backtest",
  _backtestSeasons: ${JSON.stringify(c._backtestSeasons)},
  _backtestSampleSizes: ${JSON.stringify(c._backtestSampleSizes, null, 2)},
  _backtestVerdicts: ${JSON.stringify(c._backtestVerdicts, null, 2)}
};
`;
  fs.writeFileSync(new URL("../lib/modelCoeffs.js", import.meta.url), body);
}

main().catch(e => { console.error(e); process.exit(1); });
