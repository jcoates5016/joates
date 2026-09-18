// Player identity resolution happens once, here — every factor function takes an already-resolved player
// record rather than doing its own ad hoc name lookup, which is how schema drift and mismatched-player bugs
// kept sneaking in under the old architecture.
import { normTeam } from "./teamCodes.js";

function normName(raw) {
  if (!raw) return "";
  return String(raw).toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
}
// "T.Hill" / "Tyreek Hill" both need to resolve the same way the odds feed happens to spell a name. Exported —
// also used to bridge stats_player_week's full names ("Patrick Mahomes") against play-by-play's abbreviated
// ones ("P.Mahomes"); see pbpShortKey below, which is the PBP-side half of that same match.
export function shortForm(name) {
  const parts = normName(name).split(" ");
  if (parts.length < 2) return normName(name);
  return `${parts[0][0]} ${parts[parts.length - 1]}`;
}

// nflverse's play-by-play carries passer/rusher/receiver names in "X.Surname" form — a different spelling
// convention from every other source this app uses, not just an abbreviation of it. Comparing a full name
// straight against `receiver_player_name`/`rusher_player_name` (what lib/factors/playerPbp.js's red-zone and
// two-minute share factors did until this was caught by scripts/backtest.js reporting zero real-zone-share
// matches across an entire season of data) silently never matches anyone — those factors were computing a
// real-looking number that was actually always ~0. Normalizing PBP's "P.Mahomes" down to the same "p mahomes"
// shape shortForm() produces from "Patrick Mahomes" is what makes the two sides comparable.
export function pbpShortKey(pbpName) {
  return normName(String(pbpName || "").replace(".", " "));
}

export function buildGameLogIndex(statRows) {
  const byName = new Map();
  statRows.forEach(r => {
    const name = r.player_display_name || r.player_name || r.player;
    if (!name) return;
    const key = normName(name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(r);
  });
  // Rows land here in whatever order the source arrays happened to build them in — real fetches concatenate
  // one full season at a time (current season first, then each earlier season appended after it), and a
  // player can easily have fewer games so far this season than the slice size a "last N games" lookup wants.
  // Every factor in this codebase that does rows.slice(-3) (or the new last-10 breakdown) depends on the END
  // of this array meaning "most recently played" — so sort each player's own log chronologically once, here,
  // rather than trusting fetch order. Without this, a player early in a new season could have a year-old game
  // silently mixed into what's reported as his "last 3" or "last 10."
  for (const rows of byName.values()) {
    rows.sort((a, b) => (Number(a.season) - Number(b.season)) || (Number(a.week) - Number(b.week)));
  }
  return byName;
}

// `roster_weekly_<season>.csv` is one row per player PER WEEK, not one row per player — a player who was traded
// mid-season has multiple rows with different `team` values (confirmed live: Joe Flacco CIN->CLE, Darius Slay
// PIT->BUF, Adam Thielen MIN->PIT all show up with 2+ teams on record in the same season file). This used to
// build the index in raw file order, so `.set()` just kept overwriting with whatever row happened to come last
// in the CSV — not necessarily his current team. Sorting by week first (REG season only; post-season rows can
// trail the file in whatever order and aren't "this week" anyway) means the final overwrite for each player is
// always his most recent week on record, matching the same discipline buildGameLogIndex already uses.
export function buildRosterIndex(rosterRows) {
  const byName = new Map();
  const sorted = [...rosterRows].filter(r => !r.game_type || r.game_type === "REG")
    .sort((a, b) => Number(a.week) - Number(b.week));
  sorted.forEach(r => {
    const name = r.full_name || r.player_name;
    if (!name) return;
    byName.set(normName(name), {
      playerId: r.gsis_id || r.player_id, team: normTeam(r.team), position: r.position,
      birthDate: r.birth_date || r.birthdate || null, status: r.status || null, asOfWeek: r.week ?? null
    });
  });
  return byName;
}

// nflverse's separate depth-chart scrape (lib/fetchers/nflverse.js's fetchDepthCharts) is a rolling archive of
// scrapes taken every few days, not a per-season snapshot — the fetcher already trims it to each team's single
// most recent scrape before this ever sees it, so "most recent row per player" here is really just "resolve one
// row per player" (ties broken by whichever the fetcher kept, which is the same scrape date for every row of a
// given team). `posRank` is the real depth-chart order within that position group (1 = starter), and `groupSize`
// (filled in below) is how many players share that same team+position slot, so "RB2 of 4" is a real, checkable
// claim rather than a guess built off a handful of recent touches — see findKeyTeammate in factors/index.js.
export function buildDepthChartIndex(depthChartRows) {
  const byName = new Map();
  const groupCounts = new Map(); // `${team}|${posAbb}` -> count, filled in a first pass so groupSize is accurate
  depthChartRows.forEach(r => {
    const team = normTeam(r.team);
    if (!team || !r.pos_abb) return;
    const groupKey = `${team}|${r.pos_abb}`;
    groupCounts.set(groupKey, (groupCounts.get(groupKey) || 0) + 1);
  });
  depthChartRows.forEach(r => {
    const name = r.player_name;
    const team = normTeam(r.team);
    if (!name || !team || !r.pos_abb) return;
    const groupKey = `${team}|${r.pos_abb}`;
    byName.set(normName(name), {
      team, posAbb: r.pos_abb, posRank: Number(r.pos_rank) || null,
      groupSize: groupCounts.get(groupKey) || 1, scrapedAt: r.dt || null
    });
  });
  return byName;
}

export function buildSnapsIndex(snapRows) {
  const byKey = new Map();
  snapRows.forEach(r => {
    const name = r.player || r.pfr_player_name;
    if (!name) return;
    const key = `${normName(name)}|${r.week}`;
    byKey.set(key, { offensePct: r.offense_pct, team: normTeam(r.team) });
  });
  return byKey;
}

export function resolvePlayer(rawName, gameLogIndex, rosterIndex, depthChartIndex = null) {
  const key = normName(rawName);
  let roster = rosterIndex.get(key);
  let logKey = key;
  if (!roster) {
    // Try short-form match (odds feed sometimes abbreviates first names) against the roster index.
    const short = shortForm(rawName);
    for (const [rk, rv] of rosterIndex.entries()) {
      if (shortForm(rk) === short) { roster = rv; logKey = rk; break; }
    }
  }
  // The depth-chart scrape (fetchDepthCharts) runs continuously and reflects same-day moves; the weekly roster
  // file only updates on its own weekly cadence and can lag a real trade by a few days. When both resolve the
  // player, the depth chart's team wins as the fresher signal — `rosterConflict` records when they disagreed,
  // for the pipeline to log and the frontend to flag rather than silently picking one and moving on.
  let depthChart = depthChartIndex?.get(key) || null;
  if (!depthChart && depthChartIndex) {
    const short = shortForm(rawName);
    for (const [dk, dv] of depthChartIndex.entries()) {
      if (shortForm(dk) === short) { depthChart = dv; break; }
    }
  }
  const rosterTeam = roster?.team || null;
  const depthChartTeam = depthChart?.team || null;
  const team = depthChartTeam || rosterTeam;
  const rosterConflict = !!(rosterTeam && depthChartTeam && rosterTeam !== depthChartTeam);
  return {
    name: rawName, playerId: roster?.playerId || null, team,
    position: roster?.position || null, birthDate: roster?.birthDate || null, _logKey: logKey,
    depthChartRole: depthChart ? `${depthChart.posAbb}${depthChart.posRank}` : null,
    depthChartGroupSize: depthChart?.groupSize ?? null,
    rosterTeam, depthChartTeam, rosterConflict
  };
}

export function playerGameLogs(player, gameLogIndex) {
  return gameLogIndex.get(player._logKey) || gameLogIndex.get(normName(player.name)) || [];
}
