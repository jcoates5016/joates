// Wires every factor module into one engine. `assemblePropFactors(row)` and `assembleGameLineFactors(row)` are
// what pipeline.js calls per row; `computeMispricedScore(row)` folds the resulting factors into one ranking
// number for the Mispriced Bets tab.
import { normTeam } from "../teamCodes.js";
import { buildTeamSeasonIndex } from "./teamStats.js";
import {
  computeTeammateOutTendency, computeVenueSplit, computeDefenseVsPosition,
  computeWeatherSplitHistorical, computeBirthdaySplit, computeUsageFactor, computeFormFactor
} from "./playerSplits.js";
import { computePlayerRedZoneShare, computePlayerTwoMinuteShare, computeScoringEnvironment, computeMatchupEdge } from "./playerPbp.js";
import { findScheduleRow, computeScheduleFactor, computeStarterChangeFactor } from "./schedule.js";
import { computeRefereeFactor } from "./referee.js";
import { computeSelfInjury, computeOLineInjuryFlag, computePracticeTrend } from "./injury.js";
import { computeLineMovementSeries, keyNumberProximity } from "./market.js";

function findKeyTeammate(player, rosterIndex, gameLogIndex) {
  if (!player.team || !player.position) return null;
  const group = ["WR", "TE"].includes(player.position) ? ["WR", "TE"] : [player.position];
  let best = null, bestVal = -1;
  for (const [name, r] of rosterIndex.entries()) {
    if (r.team !== player.team || !group.includes(r.position) || name === (player._logKey || "")) continue;
    const rows = gameLogIndex.get(name) || [];
    const val = rows.reduce((s, row) => s + (row.targets || row.carries || 0), 0) / (rows.length || 1);
    if (val > bestVal) { bestVal = val; best = name; }
  }
  return best;
}

export function createFactorEngine({
  currentSeason, gameLogIndex, rosterIndex, snapsByKey, schedule, pbpRows,
  injuriesByTeam, injuryHistory, priceHistory, situationalNotes, weatherByGame
}) {
  const teamSeasonIndex = buildTeamSeasonIndex(pbpRows);

  function situationalNoteFor(player) {
    const note = (situationalNotes || []).find(n => (n.player || "").toLowerCase() === player.name.toLowerCase() ||
      (n.text || "").toLowerCase().includes(player.name.toLowerCase()));
    return note ? (note.text || note.note || null) : null;
  }

  function assemblePropFactors(row) {
    const player = row._resolvedPlayer || { name: row.player, team: row.team, position: row.position, _logKey: row.player?.toLowerCase(), birthDate: null, playerId: row.playerId };
    const gameRow = row.home && row.away ? findScheduleRow(schedule, currentSeason, row.home, row.away) : null;
    const week = gameRow ? Number(gameRow.week) : null;
    const thisWeekStarterName = gameRow ? (row.team === normTeam(gameRow.home_team || gameRow.home) ? gameRow.home_qb_name : gameRow.away_qb_name) : null;
    const teammateName = findKeyTeammate(player, rosterIndex, gameLogIndex);
    const weather = weatherByGame?.get(row.eventId) || null;

    return {
      form: computeFormFactor(player, row.opponent, gameLogIndex, row.propType),
      tendency: computeTeammateOutTendency(player, teammateName, injuriesByTeam, gameLogIndex),
      venue: computeVenueSplit(player, row.opponent, gameLogIndex, schedule),
      weatherHistorical: computeWeatherSplitHistorical(player, gameLogIndex, schedule),
      weatherForecast: weather,
      birthday: computeBirthdaySplit(player, row.kickoff, gameLogIndex, schedule),
      usage: computeUsageFactor(player, gameLogIndex, snapsByKey),
      redZone: computePlayerRedZoneShare(player, pbpRows),
      twoMinute: computePlayerTwoMinuteShare(player, pbpRows),
      defense: row.line != null ? computeDefenseVsPosition(row.opponent, player.position, gameLogIndex) : { available: false },
      matchupEdge: computeMatchupEdge(player.team, row.opponent, teamSeasonIndex),
      scoringEnvironment: computeScoringEnvironment(player.team, row.opponent, teamSeasonIndex),
      schedule: gameRow ? computeScheduleFactor({ team: player.team, opponentTeam: row.opponent, homeTeam: normTeam(gameRow.home_team || gameRow.home), kickoffISO: row.kickoff, gameRow }) : { available: false },
      starterChange: computeStarterChangeFactor(player.team, currentSeason, week, thisWeekStarterName, schedule),
      referee: computeRefereeFactor(gameRow?.referee, schedule),
      selfInjury: computeSelfInjury(player, injuriesByTeam),
      oLineInjury: computeOLineInjuryFlag(player.team, injuriesByTeam),
      practiceTrend: computePracticeTrend(player, injuryHistory),
      marketMovement: computeLineMovementSeries(row.oddID, row.bestBook, priceHistory),
      situationalNote: situationalNoteFor(player)
    };
  }

  function assembleGameLineFactors(row) {
    const gameRow = row.home && row.away ? findScheduleRow(schedule, currentSeason, row.home, row.away) : null;
    const weather = weatherByGame?.get(row.eventId) || null;
    const pointVal = Number((row.side || "").split(" ").pop());
    return {
      teamContext: {
        home: teamSeasonIndex[row.home] || null, away: teamSeasonIndex[row.away] || null
      },
      matchupEdge: {
        homeOffVsAwayDef: computeMatchupEdge(row.home, row.away, teamSeasonIndex),
        awayOffVsHomeDef: computeMatchupEdge(row.away, row.home, teamSeasonIndex)
      },
      scoringEnvironment: computeScoringEnvironment(row.home, row.away, teamSeasonIndex),
      schedule: gameRow ? {
        home: computeScheduleFactor({ team: row.home, opponentTeam: row.away, homeTeam: row.home, kickoffISO: row.kickoff, gameRow }),
        away: computeScheduleFactor({ team: row.away, opponentTeam: row.home, homeTeam: row.home, kickoffISO: row.kickoff, gameRow })
      } : { home: { available: false }, away: { available: false } },
      referee: computeRefereeFactor(gameRow?.referee, schedule),
      weatherForecast: weather,
      keyNumber: !isNaN(pointVal) ? keyNumberProximity(pointVal) : { available: false },
      marketMovement: computeLineMovementSeries(row.oddID, row.bestBook, priceHistory)
    };
  }

  // Weighted purely toward factors that are real computed numbers, not the AI-speculative narrative bucket —
  // the scouting-take text is meant to add color in the UI, never to move a row's rank. Defensive matchup
  // quality (opponent-vs-position rank, EPA matchup edge) is scored here just like every offensive factor.
  function computeMispricedScore(row) {
    const f = row.factors;
    if (!f) return null;
    let score = (row.bestEdge || 0) * 100;
    if (f.form?.available && f.form.n_last3 >= 3 && f.form.rate_last3 >= 0.66) score += 7;
    if (f.form?.available && f.form.n_vsOpp >= 2 && f.form.rate_vsOpp >= 0.66) score += 6;
    if (f.tendency?.available) score += 5;
    if (f.usage?.available && f.usage.snapPct >= 0.75) score += 5;
    if (f.redZone?.available && f.redZone.redZoneShare >= 0.3) score += 6;
    if (f.redZone?.available && f.redZone.goalLineShare >= 0.3) score += 5;
    if (f.defense?.available && f.defense.rank <= Math.ceil((f.defense.ofTeams || 32) * 0.35)) score += 6;
    if (f.matchupEdge?.available && f.matchupEdge.edge > 0.05) score += 7;
    if (f.scoringEnvironment?.available && f.scoringEnvironment.combinedEpaPerPlay > 0.1) score += 6;
    if (f.starterChange?.available && f.starterChange.changed) score += 4;
    if (f.oLineInjury?.available && f.oLineInjury.count >= 2) score -= 6;
    if (f.selfInjury && ["out", "doubtful"].includes((f.selfInjury.status || "").toLowerCase())) score -= 60;
    if (f.marketMovement?.available && f.marketMovement.priceMove < 0) score += 4; // price shortened toward this side
    if (f.schedule?.available && f.schedule.shortWeek) score -= 2;
    if (f.schedule?.available && f.schedule.travelMiles > 1500) score -= 2;
    return score;
  }

  return { assemblePropFactors, assembleGameLineFactors, computeMispricedScore, teamSeasonIndex };
}
