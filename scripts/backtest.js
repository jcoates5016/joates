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

  const [statRowsAll, scheduleRaw] = await Promise.all([fetchMultiSeasonStats(SEASONS, log), fetchSchedule(log)]);
  const hasGameType = scheduleRaw.some(r => "game_type" in r);
  const schedule = hasGameType ? scheduleRaw.filter(r => r.game_type === "REG") : scheduleRaw;
  const weatherCache = await buildWeatherCache(schedule, SEASONS, log);

  const pbpBySeason = {}, snapsBySeason = {};
  for (const season of SEASONS) {
    pbpBySeason[season] = await fetchPlayByPlay(season, log);
    snapsBySeason[season] = await fetchSnapCounts(season, log);
  }

  const buckets = Object.fromEntries(BACKTESTED_KEYS.map(k => [k, newBucket()]));
  let overallHit = 0, overallN = 0;

  for (const season of SEASONS) {
    const seasonStatRows = statRowsAll.filter(r => Number(r.season) === season && (!r.season_type || r.season_type === "REG"));
    const weeks = [...new Set(seasonStatRows.map(r => Number(r.week)))].filter(w => !isNaN(w)).sort((a, b) => a - b);
    const seasonSchedule = schedule.filter(s => Number(s.season) === season);
    const seasonPbp = pbpBySeason[season] || [];
    const seasonSnaps = snapsBySeason[season] || [];
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
  for (const key of BACKTESTED_KEYS) {
    const b = buckets[key];
    const hitRateWith = b.withN ? b.withHit / b.withN : null;
    const hitRateWithout = b.withoutN ? b.withoutHit / b.withoutN : null;
    const lift = (hitRateWith != null && hitRateWithout != null) ? hitRateWith - hitRateWithout : null;
    const rawLogit = (hitRateWith != null && hitRateWithout != null) ? logit(hitRateWith) - logit(hitRateWithout) : 0;
    const shrunk = Math.max(-MAX_COEFF, Math.min(MAX_COEFF, rawLogit * (b.withN / (b.withN + REG_K))));
    const verdict = b.withN < 20 ? "not enough data — kept at prior default"
      : Math.abs(lift) >= 0.03 ? "real signal" : "weak/no signal — coefficient shrunk toward 0";
    results[key] = { ...b, hitRateWith, hitRateWithout, lift, rawLogit, shrunk, verdict };
  }

  log("\nFactor                 withN  withoutN  hitRate(with)  hitRate(without)   lift    coeff(old -> new)   verdict");
  for (const key of BACKTESTED_KEYS) {
    const r = results[key];
    const pct = (v) => v == null ? "  n/a" : (v * 100).toFixed(1).padStart(5);
    const newCoeff = r.withN < 20 ? PREV_COEFFS[key] : +r.shrunk.toFixed(3);
    log(`${key.padEnd(22)} ${String(r.withN).padStart(5)}  ${String(r.withoutN).padStart(8)}     ${pct(r.hitRateWith)}%        ${pct(r.hitRateWithout)}%      ` +
      `${r.lift == null ? " n/a" : (r.lift * 100).toFixed(1).padStart(5) + "%"}   ${PREV_COEFFS[key].toFixed(2)} -> ${newCoeff.toFixed(3)}      ${r.verdict}`);
  }

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
const METADATA_KEYS = ["marketPriorWeight", "generatedAt", "source", "_backtestSeasons", "_backtestSampleSizes"];

function writeCoeffsFile(c) {
  // A backtested key gets no trailing comment (matches the original convention for form_hot etc.); a hand-set
  // key gets its reason from HAND_SET_NOTES, computed fresh each run rather than frozen in a string — so a key
  // that migrates from hand-set to backtested (as weather_run_favor/weather_pass_penalty/venue_edge just did)
  // automatically loses its "not backtestable" comment instead of it silently going stale.
  const line = (key) => {
    const note = !BACKTESTED_KEYS.includes(key) && HAND_SET_NOTES[key] ? ` // ${HAND_SET_NOTES[key]}` : "";
    return `  ${key}: ${c[key]},${note}`;
  };
  const categorized = new Set([...CORE_KEYS, ...WEATHER_VENUE_KEYS, ...GAME_SCRIPT_KEYS, ...REFEREE_KEYS, ...NGS_PRESSURE_KEYS, ...METADATA_KEYS]);
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
${uncategorizedBlock}
  generatedAt: ${JSON.stringify(c.generatedAt)},
  source: "backtest",
  _backtestSeasons: ${JSON.stringify(c._backtestSeasons)},
  _backtestSampleSizes: ${JSON.stringify(c._backtestSampleSizes, null, 2)}
};
`;
  fs.writeFileSync(new URL("../lib/modelCoeffs.js", import.meta.url), body);
}

main().catch(e => { console.error(e); process.exit(1); });
