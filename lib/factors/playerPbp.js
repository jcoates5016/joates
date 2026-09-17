// Play-by-play-derived, per-player usage that the weekly stats file can't give you: share of a team's
// red-zone/goal-line touches that went to this specific player, and how much of their work came in
// two-minute-drill situations. Also the team-vs-team EPA matchup edge (this offense vs. that defense),
// which is a meaningfully stronger "is this a good matchup" signal than the opponent-rank-vs-position
// split alone — defensive matchup quality is a first-class signal in this build, not something it avoids.
import { pbpShortKey, shortForm } from "../identity.js";

function rate(hits, n) { return n ? hits / n : null; }

// nflverse's play-by-play spells names "P.Mahomes", never "Patrick Mahomes" — comparing `player.name` straight
// against `receiver_player_name`/`rusher_player_name` never matched anyone, which made both factors below
// silently return a real-looking but always-near-zero share for every player until scripts/backtest.js caught
// it (zero red-zone-share detections across a full season of real data). See identity.js's pbpShortKey.
function matchesPlayer(row, playerKey) {
  return pbpShortKey(row.receiver_player_name) === playerKey || pbpShortKey(row.rusher_player_name) === playerKey;
}

export function computePlayerRedZoneShare(player, pbpRows) {
  if (!player.playerId && !player.name) return { available: false };
  const playerKey = shortForm(player.name);
  const teamPlays = pbpRows.filter(r => r.posteam === player.team && r.yardline_100 != null && r.yardline_100 <= 20 &&
    (r.pass_attempt === 1 || r.rush_attempt === 1));
  if (teamPlays.length < 4) return { available: false };
  const playerTouches = teamPlays.filter(r => matchesPlayer(r, playerKey));
  const goalLine = teamPlays.filter(r => r.yardline_100 <= 5);
  const playerGoalLine = goalLine.filter(r => matchesPlayer(r, playerKey));
  return {
    available: true,
    redZoneShare: rate(playerTouches.length, teamPlays.length),
    redZoneTouches: playerTouches.length, teamRedZonePlays: teamPlays.length,
    goalLineShare: goalLine.length ? rate(playerGoalLine.length, goalLine.length) : null,
    goalLineTouches: playerGoalLine.length, teamGoalLinePlays: goalLine.length
  };
}

export function computePlayerTwoMinuteShare(player, pbpRows) {
  const playerKey = shortForm(player.name);
  const teamPlays = pbpRows.filter(r => r.posteam === player.team && r.half_seconds_remaining != null && r.half_seconds_remaining <= 120 &&
    (r.pass_attempt === 1 || r.rush_attempt === 1));
  if (teamPlays.length < 4) return { available: false };
  const playerTouches = teamPlays.filter(r => matchesPlayer(r, playerKey));
  return { available: true, share: rate(playerTouches.length, teamPlays.length), teamPlays: teamPlays.length };
}

// The core "is this a good matchup" number: this offense's EPA/play against that defense's EPA/play allowed.
// A positive edge means the offense in question grades out ahead of what this particular defense usually
// gives up — exactly the situation where team totals and offensive player props tend to run hot.
export function computeMatchupEdge(offenseTeam, defenseTeam, teamSeasonIndex) {
  const off = teamSeasonIndex[offenseTeam], def = teamSeasonIndex[defenseTeam];
  if (!off || !def || off.offEpaPerPlay == null || def.defEpaPerPlayAllowed == null) return { available: false };
  return {
    available: true,
    offEpaPerPlay: off.offEpaPerPlay, defEpaPerPlayAllowed: def.defEpaPerPlayAllowed,
    edge: off.offEpaPerPlay - def.defEpaPerPlayAllowed,
    paceOffPlaysPerGame: off.playsPerGame, paceDefPlaysAllowedPerGame: def.playsPerGame
  };
}

// Both teams' own offensive EPA/play and pace, combined — a secondary "scoring environment" read that's
// agnostic to either side's defense. Useful alongside the matchup edge above (which does look at defense),
// not a replacement for it.
export function computeScoringEnvironment(teamA, teamB, teamSeasonIndex) {
  const a = teamSeasonIndex[teamA], b = teamSeasonIndex[teamB];
  if (!a || !b || a.offEpaPerPlay == null || b.offEpaPerPlay == null) return { available: false };
  return {
    available: true,
    teamOffEpaPerPlay: a.offEpaPerPlay, teamPlaysPerGame: a.playsPerGame,
    opponentOffEpaPerPlay: b.offEpaPerPlay, opponentPlaysPerGame: b.playsPerGame,
    combinedEpaPerPlay: a.offEpaPerPlay + b.offEpaPerPlay,
    combinedPlaysPerGame: a.playsPerGame + b.playsPerGame
  };
}
