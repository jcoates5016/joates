// Pass-protection/pressure matchup — real data this app was already fetching and computing (play-by-play's
// sack/qb_hit columns, rolled up per team in lib/factors/teamStats.js's pressureRateAllowed/pressureRateCreated)
// but never actually wired into anything that could move a grade. No new external data source needed: a true
// PFF/ESPN-style "pass rush win rate" or "blitz rate" is proprietary/paywalled and not freely buildable, but a
// real sack+hit-rate proxy from already-fetched play-by-play is, and that's what teamStats.js already computes.
//
// Combines the OFFENSE's own pass-block rate (their sacks+hits allowed per dropback — lower is a stouter O-line)
// with the DEFENSE's own pass-rush rate (their sacks+hits created per opponent dropback — higher is a nastier
// pass rush this week's QB will actually face this game). Thresholds below (0.34 "elevated," 0.22 "clean") are a
// starting, hand-set read against a typical NFL team's sack+hit-per-dropback rate (roughly 20-40% league-wide
// depending on team) — real numbers, not backtested yet; scripts/backtest.js could measure these against
// historical play-by-play the same way weather/game-script were once someone runs it with this factor wired in.
export function computePressureFactor(offenseTeam, defenseTeam, teamSeasonIndex) {
  const off = teamSeasonIndex[offenseTeam], def = teamSeasonIndex[defenseTeam];
  if (!off || !def || off.pressureRateAllowed == null || def.pressureRateCreated == null) return { available: false };
  const combinedPressureRisk = (off.pressureRateAllowed + def.pressureRateCreated) / 2;
  return { available: true, offPressureRateAllowed: off.pressureRateAllowed, defPressureRateCreated: def.pressureRateCreated, combinedPressureRisk };
}
export const ELEVATED_PRESSURE_THRESHOLD = 0.34;
export const CLEAN_POCKET_THRESHOLD = 0.22;
