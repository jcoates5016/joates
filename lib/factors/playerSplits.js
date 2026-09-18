// Weekly-stats-derived splits: opponent-vs-position defense rank, teammate-out usage tendency, dome/outdoor +
// venue-specific performance, wet/dry weather split (historical, from completed games), proximity to a
// player's birthday, and season/last-3/vs-opponent hit-rate "form". These all key off the same weekly stats
// file (`stats_player_week_<season>.csv`) and the schedule, independent of the new play-by-play-derived stuff.
import { normTeam } from "../teamCodes.js";

// The full set of prop types this app grades a real per-game stat against (excludes things like game lines that
// have no single "player stat" to check). Shared with scripts/backtest.js so it tests exactly the props the
// live app actually offers.
export const PROP_TYPES = ["td_pass", "td_rush", "td_rec", "td", "pass_yds", "rush_yds", "rec_yds", "receptions"];

function avg(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null; }

// How much this position tends to produce against this specific opponent, ranked league-wide. Built from
// every player's game logs at that position, grouped by opponent faced — a real, computed defensive signal
// (not guessed), and a first-class part of how this build grades a matchup.
export function computeDefenseVsPosition(opponentTeam, position, gameLogIndex) {
  if (!opponentTeam || !position) return { available: false };
  const byTeam = {};
  for (const rows of gameLogIndex.values()) {
    rows.forEach(r => {
      if ((r.position || r.position_group) !== position) return;
      const team = normTeam(r.opponent_team || r.opponent);
      if (!team) return;
      (byTeam[team] = byTeam[team] || []).push(r);
    });
  }
  const statFor = (r) => (r.receiving_yards || 0) + (r.rushing_yards || 0) + (r.passing_yards || 0) * 0.25;
  const teamAvgs = Object.entries(byTeam).map(([team, rows]) => ({ team, avg: avg(rows.map(statFor)), n: rows.length }))
    .filter(t => t.n >= 2);
  if (!teamAvgs.length) return { available: false };
  const sorted = [...teamAvgs].sort((a, b) => b.avg - a.avg);
  const rank = sorted.findIndex(t => t.team === opponentTeam) + 1;
  const target = teamAvgs.find(t => t.team === opponentTeam);
  if (!target || !rank) return { available: false };
  const leagueAvg = avg(teamAvgs.map(t => t.avg));
  return { available: true, teamAvg: target.avg, leagueAvg, rank, ofTeams: sorted.length, sampleGames: target.n };
}

// Every split below used to hard-code `(receiving_yards||0)+(rushing_yards||0)` as "the stat," regardless of
// which prop it was actually being computed for — meaning a QB's passing-yards venue split was really measuring
// his (near-zero) rushing+receiving yards, silently useless for the exact question it exists to answer ("does
// this QB throw for more indoors than outdoors?"). `statFor` below is the same per-propType stat picker
// computeFormFactor already uses, threaded through here too — a real fix, not a new factor, and it's what makes
// "this QB throws X more yards/TDs indoor vs outdoor" (the granular splits asked for) an actual computed number
// instead of a coincidentally-always-near-zero one. Falls back to the old receiving+rushing combo only when no
// propType is given or it isn't one of the eight tracked prop stats (keeps every existing caller working).
function splitStatFor(propType) {
  return statValueFn(propType) || ((r) => (r.receiving_yards || 0) + (r.rushing_yards || 0));
}

export function computeTeammateOutTendency(player, teammateName, injuriesByTeam, gameLogIndex, propType) {
  if (!teammateName) return { available: false };
  const rows = gameLogIndex.get(player._logKey) || [];
  if (rows.length < 3) return { available: false };
  // Needs a per-game flag for "was the teammate active"; approximate using the teammate's own game log
  // presence for that week (if the teammate has no row that week, treat them as out).
  const teammateRows = new Map();
  for (const [key, rs] of gameLogIndex.entries()) {
    if (key === teammateName.toLowerCase()) rs.forEach(r => teammateRows.set(r.week, r));
  }
  const statVal = splitStatFor(propType);
  const withTeammate = [], withoutTeammate = [];
  rows.forEach(r => {
    (teammateRows.has(r.week) ? withTeammate : withoutTeammate).push(statVal(r));
  });
  if (withoutTeammate.length < 1) return { available: false };
  return { available: true, statLabel: statLabelFor(propType), teammateName, withAvg: avg(withTeammate), withN: withTeammate.length, withoutAvg: avg(withoutTeammate), withoutN: withoutTeammate.length };
}

export function computeVenueSplit(player, opponentTeam, gameLogIndex, schedule, propType) {
  const rows = gameLogIndex.get(player._logKey) || [];
  if (!rows.length || !schedule.length) return { available: false };
  const statVal = splitStatFor(propType);
  const withRoof = rows.map(r => {
    const g = schedule.find(s => s.season === r.season && Number(s.week) === Number(r.week) && (normTeam(s.home) === player.team || normTeam(s.away) === player.team));
    return { val: statVal(r), roof: g?.roof, opp: normTeam(g?.home) === player.team ? normTeam(g?.away) : normTeam(g?.home) };
  }).filter(x => x.roof);
  if (!withRoof.length) return { available: false };
  const outdoor = withRoof.filter(x => x.roof === "outdoors").map(x => x.val);
  const dome = withRoof.filter(x => x.roof !== "outdoors").map(x => x.val);
  const atThisVenue = withRoof.filter(x => x.opp === opponentTeam).map(x => x.val);
  return { available: true, statLabel: statLabelFor(propType), outdoorAvg: avg(outdoor), outdoorN: outdoor.length, domeAvg: avg(dome), domeN: dome.length, venueAvg: avg(atThisVenue), venueN: atThisVenue.length };
}

export function computeWeatherSplitHistorical(player, gameLogIndex, schedule, propType) {
  const rows = gameLogIndex.get(player._logKey) || [];
  if (!rows.length || !schedule.length) return { available: false };
  const statVal = splitStatFor(propType);
  // nfldata's games.csv doesn't carry weather for future games (that's the live forecast's job) but does for
  // completed ones via nflverse pbp's temp/wind columns joined in at the pipeline level; this split works off
  // whatever wet/dry flag the caller has already attached to each historical game row.
  const withFlag = rows.map(r => ({ val: statVal(r), wet: r._wasWetGame })).filter(x => x.wet != null);
  const wet = withFlag.filter(x => x.wet).map(x => x.val);
  const dry = withFlag.filter(x => !x.wet).map(x => x.val);
  if (wet.length < 2) return { available: false, note: "not enough rain/snow games on record" };
  return { available: true, statLabel: statLabelFor(propType), wetAvg: avg(wet), wetN: wet.length, dryAvg: avg(dry), dryN: dry.length };
}

export function computeBirthdaySplit(player, gameDateStr, gameLogIndex, schedule, propType) {
  const bd = player.birthDate;
  if (!bd || !gameDateStr) return { available: false };
  const gameDate = new Date(gameDateStr);
  const birth = new Date(bd);
  const nearBirthday = Math.abs(daysBetweenAnnual(gameDate, birth)) <= 3;
  const rows = gameLogIndex.get(player._logKey) || [];
  if (!rows.length) return { available: true, nearBirthday, birthdayGamesN: 0, birthdayAvg: null, seasonAvg: null };
  const statVal = splitStatFor(propType);
  const withDates = rows.map(r => {
    const g = schedule.find(s => s.season === r.season && Number(s.week) === Number(r.week));
    return { val: statVal(r), date: g?.date ? new Date(g.date) : null };
  }).filter(x => x.date);
  const birthdayGames = withDates.filter(x => Math.abs(daysBetweenAnnual(x.date, birth)) <= 3).map(x => x.val);
  return { available: true, statLabel: statLabelFor(propType), nearBirthday, birthdayGamesN: birthdayGames.length, birthdayAvg: avg(birthdayGames), seasonAvg: avg(rows.map(statVal)) };
}
function daysBetweenAnnual(a, b) {
  const aMD = a.getMonth() * 31 + a.getDate(), bMD = b.getMonth() * 31 + b.getDate();
  return Math.min(Math.abs(aMD - bMD), 372 - Math.abs(aMD - bMD));
}

export function computeUsageFactor(player, gameLogIndex, snapsByKey) {
  const rows = (gameLogIndex.get(player._logKey) || []).slice(-3);
  if (!rows.length) return { available: false };
  const targetShare = avg(rows.map(r => r.target_share).filter(v => v != null));
  const aDOT = avg(rows.map(r => r.air_yards_share != null && r.targets ? r.air_yards / (r.targets || 1) : null).filter(v => v != null));
  const snapPct = avg(rows.map(r => snapsByKey.get(`${player.name.toLowerCase()}|${r.week}`)?.offensePct).filter(v => v != null));
  return { available: targetShare != null || aDOT != null || snapPct != null, targetShare, aDOT, snapPct, sampleGames: rows.length };
}

// `line` is the actual number on THIS bet (e.g. 72.5 rushing yards) — required for a meaningful hit rate.
// Without it, "hit" silently fell back to "recorded any stat greater than zero," which is a different,
// nearly-always-true question for a yardage/reception prop: a running back with 40 rushing yards would count
// as a "hit" on a 72.5-yard line. That's a real bug this build shipped with, caught from a live refresh
// claiming Javonte Williams had hit an Over 72.5 rushing-yards line in 2 of his last 3 games when he hadn't
// cleared it even once.
//
// Alongside the aggregated rates, this returns `gameLog` — the actual last-10-games list (most recent game
// first), each entry carrying the real stat value that game and whether it cleared the line. That's what lets
// the person reading a card verify a hit rate themselves, game by game, instead of just trusting one summarized
// percentage — the same trust problem that led to three straight wrong-reasoning bugs on this board. Every
// slice(-N) below relies on gameLogIndex rows already being in chronological order (see buildGameLogIndex).
export function computeFormFactor(player, opponentTeam, gameLogIndex, propType, line) {
  const rows = gameLogIndex.get(player._logKey) || [];
  if (!rows.length) return { available: false };
  const statFor = statValueFn(propType);
  if (!statFor) return { available: false };
  const threshold = thresholdFor(propType, line);
  if (threshold == null) return { available: false }; // no real line to grade a yardage/reception prop against
  const hitFn = r => statFor(r) > threshold;
  const season = rows;
  const last3 = rows.slice(-3);
  const last10 = rows.slice(-10);
  const vsOpp = rows.filter(r => normTeam(r.opponent_team || r.opponent) === opponentTeam);
  const rate = (rs) => rs.length ? rs.filter(hitFn).length / rs.length : null;
  const gameLog = last10.slice().reverse().map(r => ({
    season: r.season, week: r.week, opponent: normTeam(r.opponent_team || r.opponent) || null,
    statValue: statFor(r), hit: hitFn(r)
  }));
  return {
    available: true, statLabel: statLabelFor(propType), line: threshold,
    n_season: season.length, rate_season: rate(season),
    n_last3: last3.length, rate_last3: rate(last3),
    n_last10: last10.length, rate_last10: rate(last10),
    n_vsOpp: vsOpp.length, rate_vsOpp: rate(vsOpp),
    gameLog
  };
}
// The stat this prop type is actually graded on, per game row — NOT yet compared to a threshold. Exported for
// scripts/backtest.js, which needs the exact same per-propType stat picker to test factor signal strength
// against real history — duplicating this logic in the backtest would risk it quietly drifting out of sync.
export function statValueFn(propType) {
  return {
    td_pass: r => r.passing_tds || 0, td_rush: r => r.rushing_tds || 0,
    // "td" is Anytime TD — did the PLAYER personally cross the goal line, not "was a touchdown play involved
    // with them somehow." A passing touchdown is thrown TO a teammate, not scored by the passer, so it must
    // never count here — a QB who throws a TD most weeks but rarely runs one in himself was showing up with
    // an inflated "hit rate" on his own Anytime TD prop before this excluded passing_tds.
    td_rec: r => r.receiving_tds || 0, td: r => (r.rushing_tds || 0) + (r.receiving_tds || 0),
    pass_yds: r => r.passing_yards || 0, rush_yds: r => r.rushing_yards || 0,
    rec_yds: r => r.receiving_yards || 0, receptions: r => r.receptions || 0
  }[propType] || null;
}
export function statLabelFor(propType) {
  return {
    td_pass: "passing TDs", td_rush: "rushing TDs", td_rec: "receiving TDs", td: "a TD",
    pass_yds: "passing yards", rush_yds: "rushing yards", rec_yds: "receiving yards", receptions: "receptions"
  }[propType] || propType;
}
// Only "td" (Anytime TD) is a yes/no market with no numeric market line at all — "did it happen at all" is the
// whole bet, so 0 is the right (and only) threshold there. Passing/rushing/receiving TDs are NOT the same kind
// of market: they're real Over/Under lines with an actual posted number (e.g. "Passing TDs over 1.5"), exactly
// like a yardage or reception prop. This used to lump all four TD-flavored prop types in with Anytime TD and
// grade every one of them against a hardcoded 0 ("at least 1") regardless of what the real line said — a real
// live bug caught from a card claiming a QB posted at "over 1.5" had hit it by throwing exactly 1 TD, which
// clears 0 but not 1.5. Same class of bug as the yardage/receptions fix above; td_pass/td_rush/td_rec now use
// the real line the same way those props always have.
function thresholdFor(propType, line) {
  if (propType === "td") return 0;
  return line != null ? Number(line) : null;
}
