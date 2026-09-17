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
import { computeDefenseVsPosition, statValueFn, PROP_TYPES } from "../lib/factors/playerSplits.js";
import { computeMatchupEdge, computeScoringEnvironment } from "../lib/factors/playerPbp.js";
import { computeScheduleFactor, computeStarterChangeFactor } from "../lib/factors/schedule.js";
import { normTeam } from "../lib/teamCodes.js";
import { logit } from "../lib/oddsMath.js";
import { MODEL_COEFFS as PREV_COEFFS } from "../lib/modelCoeffs.js";

const log = (msg) => console.log(msg);

const argSeasons = process.argv.slice(2).map(Number).filter(n => !isNaN(n));
const SEASONS = argSeasons.length ? argSeasons : [1, 2, 3].map(n => new Date().getFullYear() - n);
const MIN_TRAILING_GAMES = 3;
const REG_K = 30;       // shrinkage anchor, in "games" — fewer supporting games pulls the coefficient hard toward 0
const MAX_COEFF = 0.35; // cap so a noisy factor can't swing the model further than any hand-set default did

// Factors this script has real historical data for. Anything in MODEL_COEFFS not listed here is left untouched.
const BACKTESTED_KEYS = [
  "form_hot", "weak_defense", "matchup_edge", "high_scoring_env",
  "usage_high_snap", "redzone_share", "starter_change", "short_week_penalty", "travel_penalty"
];

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
// TD-style props have a real, fixed threshold in the live app (thresholdFor returns 0 — "at least 1" is the
// whole bet) — the fixed threshold, not a trailing average, so re-deriving that here matters: a low-mean
// counting stat clears its own trailing MEAN well under half the time by construction (Poisson-shaped — mostly
// 0s, occasionally 1), which showed up as an artificially low ~37% baseline hit rate before this was split out.
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

async function main() {
  log(`Backtesting factor signal strength against seasons: ${SEASONS.join(", ")}`);
  log(`(This fetches multiple seasons of full play-by-play — it can take a few minutes.)`);

  const [statRowsAll, scheduleRaw] = await Promise.all([fetchMultiSeasonStats(SEASONS, log), fetchSchedule(log)]);
  const hasGameType = scheduleRaw.some(r => "game_type" in r);
  const schedule = hasGameType ? scheduleRaw.filter(r => r.game_type === "REG") : scheduleRaw;

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

function writeCoeffsFile(c) {
  const body = `// Coefficients for lib/probability.js's logistic blend — GENERATED by scripts/backtest.js on ${c.generatedAt}
// against seasons ${JSON.stringify(c._backtestSeasons)}. Re-run that script to refresh these against more recent
// history; don't hand-edit the backtested values below without re-running it, or this comment will start lying.
// See scripts/backtest.js's header for exactly what this backtest can and can't prove, and README's
// "Probability model" section for the plain-language version.
export const MODEL_COEFFS = {
  marketPriorWeight: ${c.marketPriorWeight},

  form_hot: ${c.form_hot},
  tendency_usage_bump: ${c.tendency_usage_bump}, // not backtestable — no historical injury-report feed
  usage_high_snap: ${c.usage_high_snap},
  redzone_share: ${c.redzone_share},
  weak_defense: ${c.weak_defense},
  matchup_edge: ${c.matchup_edge},
  high_scoring_env: ${c.high_scoring_env},
  starter_change: ${c.starter_change},
  secondary_injury: ${c.secondary_injury}, // not backtestable — no historical injury-report feed
  oline_injury_penalty: ${c.oline_injury_penalty}, // not backtestable — no historical injury-report feed
  short_week_penalty: ${c.short_week_penalty},
  travel_penalty: ${c.travel_penalty},
  steam_move: ${c.steam_move}, // not backtestable — no historical odds-movement archive

  generatedAt: ${JSON.stringify(c.generatedAt)},
  source: "backtest",
  _backtestSeasons: ${JSON.stringify(c._backtestSeasons)},
  _backtestSampleSizes: ${JSON.stringify(c._backtestSampleSizes, null, 2)}
};
`;
  fs.writeFileSync(new URL("../lib/modelCoeffs.js", import.meta.url), body);
}

main().catch(e => { console.error(e); process.exit(1); });
