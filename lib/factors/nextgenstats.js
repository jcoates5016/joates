// Next Gen Stats-derived player efficiency: real, tracking-data-computed numbers the NFL/nflverse itself
// publishes (not something this app derives or estimates), isolating a player's OWN skill from the team-level
// numbers already covered elsewhere (computeMatchupEdge/computeScoringEnvironment are offense-vs-defense EPA;
// these three are specifically "how well is THIS player performing the specific skill his position lives on,"
// independent of his teammates or scheme). Jon's top-priority pick of this round's "deep stats" build.
function normName(raw) { return String(raw || "").toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim(); }
function avg(a) { const v = a.filter(x => x != null && !isNaN(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; }

// One index per stat type, keyed the same way lib/identity.js's buildGameLogIndex keys stat_player_week rows
// (normalized full display name) — NGS's `player_display_name` column uses the identical "Patrick Mahomes"
// full-name spelling stats_player_week does, confirmed on a live pull, so no PBP-style short-name bridging is
// needed here the way lib/factors/playerPbp.js needs for play-by-play's "P.Mahomes" spelling.
export function buildNgsIndex(rows) {
  const byName = new Map();
  (rows || []).forEach(r => {
    const key = normName(r.player_display_name);
    if (!key) return;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(r);
  });
  for (const list of byName.values()) list.sort((a, b) => Number(a.week) - Number(b.week));
  return byName;
}

const MIN_SAMPLE_GAMES = 2;

// CPOE (completion percentage over expectation) — the NFL's own real model for how much more (or less)
// accurate a QB is than expected given each throw's depth/coverage/pressure, straight off the tracking data.
// Isolates ball-placement skill from the team's overall passing efficiency (already covered by
// computeMatchupEdge/computeScoringEnvironment). Trailing last-3-games average, same recency window
// computeUsageFactor already uses elsewhere.
export function computeNgsPassing(player, ngsPassingIndex) {
  if (player.position !== "QB") return { available: false };
  const rows = (ngsPassingIndex?.get(player._logKey) || []).slice(-3).filter(r => (r.attempts || 0) >= 10);
  if (rows.length < MIN_SAMPLE_GAMES) return { available: false };
  const cpoe = avg(rows.map(r => r.completion_percentage_above_expectation));
  if (cpoe == null) return { available: false };
  return {
    available: true, sampleGames: rows.length, cpoe,
    timeToThrow: avg(rows.map(r => r.avg_time_to_throw)),
    aggressiveness: avg(rows.map(r => r.aggressiveness)),
    intendedAirYards: avg(rows.map(r => r.avg_intended_air_yards))
  };
}

// Rush yards over expected, per attempt — nflverse's own model for how many yards a given carry "should" gain
// given the blocking/box count/defenders in the hole, so the per-attempt delta isolates the BACK's own vision
// and explosiveness from his offensive line's run-blocking (a separate, already-computed team-level number).
export function computeNgsRushing(player, ngsRushingIndex) {
  if (!["RB", "QB", "WR"].includes(player.position)) return { available: false };
  const rows = (ngsRushingIndex?.get(player._logKey) || []).slice(-3).filter(r => (r.rush_attempts || 0) >= 3);
  if (rows.length < MIN_SAMPLE_GAMES) return { available: false };
  const ryoePerAtt = avg(rows.map(r => r.rush_yards_over_expected_per_att));
  if (ryoePerAtt == null) return { available: false };
  return { available: true, sampleGames: rows.length, ryoePerAtt, efficiency: avg(rows.map(r => r.efficiency)) };
}

// Average separation at the catch point plus yards-after-catch over expectation — two more of nflverse's real,
// tracking-derived numbers, isolating a receiver's own route-running/after-catch ability from the team's
// overall passing-game efficiency.
export function computeNgsReceiving(player, ngsReceivingIndex) {
  if (!["WR", "TE", "RB"].includes(player.position)) return { available: false };
  const rows = (ngsReceivingIndex?.get(player._logKey) || []).slice(-3).filter(r => (r.targets || 0) >= 2);
  if (rows.length < MIN_SAMPLE_GAMES) return { available: false };
  const avgSeparation = avg(rows.map(r => r.avg_separation));
  const yacOverExpected = avg(rows.map(r => r.avg_yac_above_expectation));
  if (avgSeparation == null && yacOverExpected == null) return { available: false };
  return { available: true, sampleGames: rows.length, avgSeparation, yacOverExpected };
}
