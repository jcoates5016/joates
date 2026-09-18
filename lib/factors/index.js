// Wires every factor module into one engine. `assemblePropFactors(row)` is what pipeline.js calls per prop row
// (player props only — game lines were removed from this build entirely, see analyze.js); `computeMispricedScore
// (row)` folds the resulting factors into one ranking number for the Mispriced Bets tab.
import { normTeam } from "../teamCodes.js";
import { buildTeamSeasonIndex } from "./teamStats.js";
import {
  computeTeammateOutTendency, computeVenueSplit, computeDefenseVsPosition,
  computeWeatherSplitHistorical, computeBirthdaySplit, computeUsageFactor, computeFormFactor
} from "./playerSplits.js";
import { computePlayerRedZoneShare, computePlayerTwoMinuteShare, computeScoringEnvironment, computeMatchupEdge } from "./playerPbp.js";
import { findScheduleRow, computeScheduleFactor, computeStarterChangeFactor } from "./schedule.js";
import { computeSelfInjury, computeOLineInjuryFlag, computePracticeTrend, computeOpposingSecondaryInjury, computeOpposingFrontSevenInjury } from "./injury.js";
import { computeLineMovementSeries } from "./market.js";

// Spread threshold for "a big favorite/underdog" — 6.5 is the common one-score-plus line bettors already use
// (anything past a touchdown), not an arbitrary round number. Shared here rather than duplicated in
// scripts/backtest.js's own copy of this same threshold — both need to agree on what counts as "big" for the
// measured coefficient to mean the same thing live and in the backtest.
export const BIG_SPREAD_THRESHOLD = 6.5;

// Turns the game-level context extracted from the odds feed (analyze.js's extractGameContext) into a
// row-specific signal: which side of the game IS this player on, and does the market expect his team to be
// comfortably ahead (favors the run game late) or comfortably behind (favors garbage-time passing volume)? A
// dome/weather-style read of Vegas's own implied game script, not a bet on the total/spread themselves — those
// aren't a market this app offers anymore (see README), this is just reading them as context the way the app
// already reads weather or a defensive matchup.
export function computeGameScript(row, gameContext) {
  if (!gameContext?.available || !row.team) return { available: false };
  const isHome = row.team === row.home;
  const isAway = row.team === row.away;
  if (!isHome && !isAway) return { available: false };
  const teamSpread = isHome ? gameContext.homeSpread : -gameContext.homeSpread;
  const teamImpliedTotal = isHome ? gameContext.homeImpliedTotal : gameContext.awayImpliedTotal;
  const oppImpliedTotal = isHome ? gameContext.awayImpliedTotal : gameContext.homeImpliedTotal;
  return {
    available: true, teamSpread, teamImpliedTotal, oppImpliedTotal,
    isBigFavorite: teamSpread <= -BIG_SPREAD_THRESHOLD,
    isBigUnderdog: teamSpread >= BIG_SPREAD_THRESHOLD
  };
}

// Exported so scripts/dry-run.js can unit-test the depth-chart-vs-volume-heuristic behavior directly, the same
// way it already unit-tests lib/probability.js and lib/grading.js — this function has no natural row-level
// output of its own (it feeds computeTeammateOutTendency, which needs the "teammate"'s own game log to say
// anything at all), so testing it through a full pipeline run would require far more fixture wiring for the
// same coverage.
export function findKeyTeammate(player, rosterIndex, gameLogIndex, depthChartIndex = null) {
  if (!player.team || !player.position) return null;
  // A starting QB has no real "teammate out" usage-redistribution signal the way a WR/TE/RB does. The only
  // other same-position player on the roster is his own backup, who by definition never takes a snap while the
  // starter is healthy — so "with backup active" vs. "without" isn't tracking a role change, it's just tracking
  // which weeks the starter himself was out (backwards causality, not a real signal). Confirmed live: this was
  // producing lines like "Without Joe Milton on the field, Dak's numbers jump to X" — a comparison that can
  // never actually happen on the field, since the two never share it. Skip QB entirely.
  if (player.position === "QB") return null;
  const group = ["WR", "TE"].includes(player.position) ? ["WR", "TE"] : [player.position];
  // Prefer the depth chart's own highest-ranked *other* player at this team+position group — a real,
  // checkable designation rather than a guess built off recent target/carry share. This is deliberately "best
  // rank excluding the player himself," not "whoever is rank 1" — when the player in question IS the WR1, the
  // depth chart's rank-1 slot is his own, so the meaningful "key teammate" to watch is the next-best (WR2),
  // not "no result." Falls back to the volume heuristic below whenever the depth-chart scrape has no entry
  // for this team/position (bye-week gaps in the scrape, a position the depth chart doesn't track cleanly).
  if (depthChartIndex) {
    let dcBest = null, dcBestRank = Infinity;
    for (const [name, d] of depthChartIndex.entries()) {
      if (d.team !== player.team || !group.includes(d.posAbb) || name === (player._logKey || "")) continue;
      if (d.posRank != null && d.posRank < dcBestRank) { dcBestRank = d.posRank; dcBest = name; }
    }
    if (dcBest) return dcBest;
  }
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
  currentSeason, gameLogIndex, rosterIndex, depthChartIndex, snapsByKey, schedule, pbpRows,
  injuriesByTeam, injuryHistory, priceHistory, situationalNotes, weatherByGame, gameContextByEvent
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
    const teammateName = findKeyTeammate(player, rosterIndex, gameLogIndex, depthChartIndex);
    const weather = weatherByGame?.get(row.eventId) || null;

    return {
      // Metadata (not a computed signal itself) that lib/probability.js's weather/venue nudges need to know
      // WHICH way a factor should cut for this specific row — a rushing prop and a passing prop react to the
      // same bad-weather forecast in opposite directions, and a dome/outdoor split only means something once
      // you know which one this week's actual game is being played in.
      propType: row.propType, position: player.position, roof: gameRow?.roof || null,
      form: computeFormFactor(player, row.opponent, gameLogIndex, row.propType, row.line),
      tendency: computeTeammateOutTendency(player, teammateName, injuriesByTeam, gameLogIndex, row.propType),
      venue: computeVenueSplit(player, row.opponent, gameLogIndex, schedule, row.propType),
      weatherHistorical: computeWeatherSplitHistorical(player, gameLogIndex, schedule, row.propType),
      weatherForecast: weather,
      birthday: computeBirthdaySplit(player, row.kickoff, gameLogIndex, schedule, row.propType),
      usage: computeUsageFactor(player, gameLogIndex, snapsByKey),
      redZone: computePlayerRedZoneShare(player, pbpRows),
      twoMinute: computePlayerTwoMinuteShare(player, pbpRows),
      defense: row.line != null ? computeDefenseVsPosition(row.opponent, player.position, gameLogIndex) : { available: false },
      matchupEdge: computeMatchupEdge(player.team, row.opponent, teamSeasonIndex),
      scoringEnvironment: computeScoringEnvironment(player.team, row.opponent, teamSeasonIndex),
      // Only meaningful for props that actually run through the opponent's pass defense — a hurt cornerback or
      // safety doesn't do anything for a rushing prop, which is a front-seven/run-fit question, not a coverage
      // one. Anytime TD is deliberately left out too: it's shared between rushing and receiving scores and this
      // app has no per-prop way to know which one is realistically in play for a given player.
      secondaryInjury: ["rec_yds", "receptions", "td_rec", "pass_yds", "td_pass"].includes(row.propType)
        ? computeOpposingSecondaryInjury(row.opponent, injuriesByTeam) : { available: false },
      // Run-game mirror of secondaryInjury above — only meaningful for props that actually run through the
      // opponent's front seven (rushing yards/TDs), the same "only compute it where it plausibly applies" rule
      // secondaryInjury already follows for the pass side.
      frontSevenInjury: ["rush_yds", "td_rush"].includes(row.propType)
        ? computeOpposingFrontSevenInjury(row.opponent, injuriesByTeam) : { available: false },
      gameScript: computeGameScript(row, gameContextByEvent?.get(row.eventId)),
      schedule: gameRow ? computeScheduleFactor({ team: player.team, opponentTeam: row.opponent, homeTeam: normTeam(gameRow.home_team || gameRow.home), kickoffISO: row.kickoff, gameRow }) : { available: false },
      starterChange: computeStarterChangeFactor(player.team, currentSeason, week, thisWeekStarterName, schedule),
      selfInjury: computeSelfInjury(player, injuriesByTeam),
      oLineInjury: computeOLineInjuryFlag(player.team, injuriesByTeam),
      practiceTrend: computePracticeTrend(player, injuryHistory),
      marketMovement: computeLineMovementSeries(row.oddID, row.bestBook, priceHistory),
      situationalNote: situationalNoteFor(player)
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
    if (f.secondaryInjury?.available && f.secondaryInjury.count >= 1) score += 4;
    if (f.frontSevenInjury?.available && f.frontSevenInjury.count >= 1) score += 4;
    if (f.gameScript?.available && f.gameScript.isBigFavorite && ["rush_yds", "td_rush"].includes(f.propType)) score += 4;
    if (f.gameScript?.available && f.gameScript.isBigUnderdog && ["rec_yds", "receptions", "td_rec", "pass_yds"].includes(f.propType)) score += 4;
    if (f.oLineInjury?.available && f.oLineInjury.count >= 2) score -= 6;
    if (f.selfInjury && ["out", "doubtful"].includes((f.selfInjury.status || "").toLowerCase())) score -= 60;
    if (f.marketMovement?.available && f.marketMovement.priceMove < 0) score += 4; // price shortened toward this side
    if (f.schedule?.available && f.schedule.shortWeek) score -= 2;
    if (f.schedule?.available && f.schedule.travelMiles > 1500) score -= 2;
    return score;
  }

  return { assemblePropFactors, computeMispricedScore, teamSeasonIndex };
}
