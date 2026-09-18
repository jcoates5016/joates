// Weekly-stats-derived splits: opponent-vs-position defense rank, teammate-out usage tendency, dome/outdoor +
// venue-specific performance, wet/dry weather split (historical, from completed games), proximity to a
// player's birthday, and season/last-3/vs-opponent hit-rate "form". These all key off the same weekly stats
// file (`stats_player_week_<season>.csv`) and the schedule, independent of the new play-by-play-derived stuff.
import { normTeam } from "../teamCodes.js";

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

export function computeTeammateOutTendency(player, teammateName, injuriesByTeam, gameLogIndex) {
  if (!teammateName) return { available: false };
  const rows = gameLogIndex.get(player._logKey) || [];
  if (rows.length < 3) return { available: false };
  // Needs a per-game flag for "was the teammate active"; approximate using the teammate's own game log
  // presence for that week (if the teammate has no row that week, treat them as out).
  const teammateRows = new Map();
  for (const [key, rs] of gameLogIndex.entries()) {
    if (key === teammateName.toLowerCase()) rs.forEach(r => teammateRows.set(r.week, r));
  }
  const withTeammate = [], withoutTeammate = [];
  rows.forEach(r => {
    const statVal = (r.receiving_yards || 0) + (r.rushing_yards || 0);
    (teammateRows.has(r.week) ? withTeammate : withoutTeammate).push(statVal);
  });
  if (withoutTeammate.length < 1) return { available: false };
  return { available: true, teammateName, withAvg: avg(withTeammate), withN: withTeammate.length, withoutAvg: avg(withoutTeammate), withoutN: withoutTeammate.length };
}

export function computeVenueSplit(player, opponentTeam, gameLogIndex, schedule) {
  const rows = gameLogIndex.get(player._logKey) || [];
  if (!rows.length || !schedule.length) return { available: false };
  const statVal = (r) => (r.receiving_yards || 0) + (r.rushing_yards || 0);
  const withRoof = rows.map(r => {
    const g = schedule.find(s => s.season === r.season && Number(s.week) === Number(r.week) && (normTeam(s.home) === player.team || normTeam(s.away) === player.team));
    return { val: statVal(r), roof: g?.roof, opp: normTeam(g?.home) === player.team ? normTeam(g?.away) : normTeam(g?.home) };
  }).filter(x => x.roof);
  if (!withRoof.length) return { available: false };
  const outdoor = withRoof.filter(x => x.roof === "outdoors").map(x => x.val);
  const dome = withRoof.filter(x => x.roof !== "outdoors").map(x => x.val);
  const atThisVenue = withRoof.filter(x => x.opp === opponentTeam).map(x => x.val);
  return { available: true, outdoorAvg: avg(outdoor), outdoorN: outdoor.length, domeAvg: avg(dome), domeN: dome.length, venueAvg: avg(atThisVenue), venueN: atThisVenue.length };
}

export function computeWeatherSplitHistorical(player, gameLogIndex, schedule) {
  const rows = gameLogIndex.get(player._logKey) || [];
  if (!rows.length || !schedule.length) return { available: false };
  const statVal = (r) => (r.receiving_yards || 0) + (r.rushing_yards || 0);
  // nfldata's games.csv doesn't carry weather for future games (that's the live forecast's job) but does for
  // completed ones via nflverse pbp's temp/wind columns joined in at the pipeline level; this split works off
  // whatever wet/dry flag the caller has already attached to each historical game row.
  const withFlag = rows.map(r => ({ val: statVal(r), wet: r._wasWetGame })).filter(x => x.wet != null);
  const wet = withFlag.filter(x => x.wet).map(x => x.val);
  const dry = withFlag.filter(x => !x.wet).map(x => x.val);
  if (wet.length < 2) return { available: false, note: "not enough rain/snow games on record" };
  return { available: true, wetAvg: avg(wet), wetN: wet.length, dryAvg: avg(dry), dryN: dry.length };
}

export function computeBirthdaySplit(player, gameDateStr, gameLogIndex, schedule) {
  const bd = player.birthDate;
  if (!bd || !gameDateStr) return { available: false };
  const gameDate = new Date(gameDateStr);
  const birth = new Date(bd);
  const nearBirthday = Math.abs(daysBetweenAnnual(gameDate, birth)) <= 3;
  const rows = gameLogIndex.get(player._logKey) || [];
  if (!rows.length) return { available: true, nearBirthday, birthdayGamesN: 0, birthdayAvg: null, seasonAvg: null };
  const statVal = (r) => (r.receiving_yards || 0) + (r.rushing_yards || 0);
  const withDates = rows.map(r => {
    const g = schedule.find(s => s.season === r.season && Number(s.week) === Number(r.week));
    return { val: statVal(r), date: g?.date ? new Date(g.date) : null };
  }).filter(x => x.date);
  const birthdayGames = withDates.filter(x => Math.abs(daysBetweenAnnual(x.date, birth)) <= 3).map(x => x.val);
  return { available: true, nearBirthday, birthdayGamesN: birthdayGames.length, birthdayAvg: avg(birthdayGames), seasonAvg: avg(rows.map(statVal)) };
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

export function computeFormFactor(player, opponentTeam, gameLogIndex, propType) {
  const rows = gameLogIndex.get(player._logKey) || [];
  if (!rows.length) return { available: false };
  const hitFn = statHitFn(propType);
  const season = rows;
  const last3 = rows.slice(-3);
  const vsOpp = rows.filter(r => normTeam(r.opponent_team || r.opponent) === opponentTeam);
  const rate = (rs) => rs.length ? rs.filter(hitFn).length / rs.length : null;
  return {
    available: true, n_season: season.length, rate_season: rate(season),
    n_last3: last3.length, rate_last3: rate(last3), n_vsOpp: vsOpp.length, rate_vsOpp: rate(vsOpp)
  };
}
function statHitFn(propType) {
  const map = {
    td_pass: r => (r.passing_tds || 0) >= 1, td_rush: r => (r.rushing_tds || 0) >= 1,
    // "td" is Anytime TD — did the PLAYER personally cross the goal line, not "was a touchdown play involved
    // with them somehow." A passing touchdown is thrown TO a teammate, not scored by the passer, so it must
    // never count here — a QB who throws a TD most weeks but rarely runs one in himself was showing up with
    // an inflated "hit rate" on his own Anytime TD prop before this excluded passing_tds.
    td_rec: r => (r.receiving_tds || 0) >= 1, td: r => (r.rushing_tds || 0) + (r.receiving_tds || 0) >= 1,
    pass_yds: r => (r.passing_yards || 0) > 0, rush_yds: r => (r.rushing_yards || 0) > 0,
    rec_yds: r => (r.receiving_yards || 0) > 0, receptions: r => (r.receptions || 0) > 0
  };
  return map[propType] || (() => false);
}
