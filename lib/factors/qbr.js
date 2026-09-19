// Real ESPN Total QBR (lib/fetchers/nflverse.js's fetchEspnQbr, nflverse's own espn_data release) — ESPN's
// actual published overall-efficiency number for a QB, not an app-derived estimate. Distinct from the NGS CPOE
// nudge (lib/factors/nextgenstats.js), which isolates ball-placement accuracy specifically: QBR folds in
// scrambles, sacks, turnovers, and game situation into one 0-100 "how well did this QB actually play" number —
// the closest real, freely-available equivalent to "QBR for a position" this app can pull for the QB spot
// itself. There's no equivalent single ESPN-published efficiency metric for RB/WR/TE — that's what the NGS
// RYOE/separation/YAC-over-expected factors already cover for those positions.
function normName(raw) { return String(raw || "").toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim(); }
function avg(a) { const v = a.filter(x => x != null && !isNaN(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; }

// ESPN's `name_display` column ("Josh Allen") uses the identical full-name spelling stats_player_week and NGS
// both do — confirmed on a live pull, same as nextgenstats.js's own index-keying note — so no name-bridging is
// needed here either.
export function buildQbrIndex(rows) {
  const byName = new Map();
  (rows || []).forEach(r => {
    const key = normName(r.name_display);
    if (!key) return;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(r);
  });
  for (const list of byName.values()) list.sort((a, b) => Number(a.week_num) - Number(b.week_num));
  return byName;
}

const MIN_SAMPLE_GAMES = 2;
// ESPN's own commonly-cited QBR scale benchmarks (real, checkable, not arbitrary round numbers picked for this
// app): roughly 50 is a league-average performance by ESPN's own published scale, 75+ is the range ESPN's own
// broadcast/analytics team labels "elite" (MVP-caliber stretches), 35 and below is replacement-level/poor.
export const QBR_ELITE_THRESHOLD = 75, QBR_POOR_THRESHOLD = 35;

// Trailing last-3-games average, same recency window computeUsageFactor/NGS factors already use elsewhere —
// QB position only (this is a QB-specific published metric), and only once ESPN has actually rated at least 2
// of his real games this season (a single-game read is too volatile off this metric to trust as a trend).
export function computeQbrTrend(player, qbrIndex) {
  if (player.position !== "QB") return { available: false };
  const rows = (qbrIndex?.get(player._logKey) || []).slice(-3);
  if (rows.length < MIN_SAMPLE_GAMES) return { available: false };
  const avgQbr = avg(rows.map(r => Number(r.qbr_total)));
  if (avgQbr == null) return { available: false };
  return { available: true, sampleGames: rows.length, avgQbr };
}
