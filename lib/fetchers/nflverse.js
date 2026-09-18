// nflverse fetchers. Every URL here was checked against the real, current release assets (not assumed from
// memory) — including gunzipping a live play_by_play file and printing its actual header row — before writing
// any of the parsing code below, specifically to avoid repeating the "coded against a schema that quietly
// drifted" class of bug from earlier versions of this tool.
import zlib from "node:zlib";
import Papa from "papaparse";

const STATS_RELEASE = (season) => `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv`;
const ROSTER_RELEASE = (season) => `https://github.com/nflverse/nflverse-data/releases/download/weekly_rosters/roster_weekly_${season}.csv`;
const SNAPS_RELEASE = (season) => `https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_${season}.csv`;
const SCHEDULE_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";
const PBP_RELEASE = (season) => `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${season}.csv.gz`;
const DEPTH_CHARTS_RELEASE = (season) => `https://github.com/nflverse/nflverse-data/releases/download/depth_charts/depth_charts_${season}.csv`;

async function fetchText(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}
async function fetchCSV(url) {
  const text = await fetchText(url);
  return Papa.parse(text, { header: true, dynamicTyping: true, skipEmptyLines: true }).data;
}
async function fetchGzCSV(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = zlib.gunzipSync(buf).toString("utf-8");
  return Papa.parse(text, { header: true, dynamicTyping: true, skipEmptyLines: true }).data;
}

export async function fetchMultiSeasonStats(seasons, log = () => {}) {
  let all = [];
  for (const season of seasons) {
    try {
      const rows = await fetchCSV(STATS_RELEASE(season));
      log(`Loaded ${rows.length} stat rows for ${season}`);
      all = all.concat(rows);
    } catch (e) { log(`Stats fetch failed for ${season}: ${e.message}`); }
  }
  return all;
}

export async function fetchSchedule(log = () => {}) {
  try {
    const rows = await fetchCSV(SCHEDULE_URL);
    log(`Loaded ${rows.length} schedule rows`);
    return rows;
  } catch (e) { log(`Schedule fetch failed: ${e.message}`); return []; }
}

export async function fetchRoster(season, log = () => {}) {
  try {
    const rows = await fetchCSV(ROSTER_RELEASE(season));
    log(`Loaded ${rows.length} roster rows for ${season}`);
    return rows;
  } catch (e) { log(`Roster fetch failed for ${season}: ${e.message}`); return []; }
}

export async function fetchSnapCounts(season, log = () => {}) {
  try {
    const rows = await fetchCSV(SNAPS_RELEASE(season));
    log(`Loaded ${rows.length} snap-count rows for ${season}`);
    return rows;
  } catch (e) { log(`Snap-count fetch failed for ${season}: ${e.message}`); return []; }
}

// Only the current season's play-by-play is fetched — every derived factor below (team EPA/success rate,
// red-zone/goal-line share, pressure rate, pace, third-down/turnover tendencies) is meant to describe "how is
// this team/player playing *this season*", the same current-season-only scope the rest of the app already
// uses for form/usage. A full multi-season pbp pull would be several times heavier for no factor this app
// actually needs. Columns are trimmed immediately after parsing — the raw file carries 370+ columns and only
// ~40 of them feed any factor here, so we don't hold the rest in memory for tens of thousands of rows.
const PBP_KEEP_COLUMNS = [
  "game_id", "week", "season_type", "posteam", "defteam", "home_team", "away_team", "qtr",
  "half_seconds_remaining", "down", "ydstogo", "yardline_100", "goal_to_go", "play_type",
  "pass_attempt", "rush_attempt", "complete_pass", "sack", "qb_hit", "epa", "success", "pass_oe", "xpass",
  "air_yards", "yards_after_catch", "touchdown", "pass_touchdown", "rush_touchdown",
  "passer_player_id", "passer_player_name", "rusher_player_id", "rusher_player_name",
  "receiver_player_id", "receiver_player_name", "fourth_down_converted", "fourth_down_failed",
  "third_down_converted", "third_down_failed", "two_point_attempt", "fumble_lost", "interception",
  "posteam_score", "defteam_score", "score_differential", "drive", "drive_play_count",
  "drive_time_of_possession", "roof", "surface", "temp", "wind", "div_game"
];
export async function fetchPlayByPlay(season, log = () => {}) {
  try {
    const rows = await fetchGzCSV(PBP_RELEASE(season));
    const slim = rows.map(r => {
      const o = {};
      for (const c of PBP_KEEP_COLUMNS) o[c] = r[c];
      return o;
    });
    log(`Loaded ${slim.length} play-by-play rows for ${season} (trimmed to ${PBP_KEEP_COLUMNS.length} columns).`);
    return slim;
  } catch (e) { log(`Play-by-play fetch failed for ${season}: ${e.message}`); return []; }
}

// Real, ranked depth-chart data (QB1/QB2, WR1..WR5, etc.) — something the weekly roster file's own
// `depth_chart_position` column doesn't actually give you (verified on a live pull: it's just a copy of
// `position`, never a rank). This file is a rolling archive of scrapes taken every few days since the league
// year opened — confirmed live at 180+ distinct scrape timestamps spanning the whole year, with the newest
// timestamp matching *today* — not a single current snapshot, so this trims it down to each team's single most
// recent scrape before anything else touches it (527k raw rows for one team-day's worth of real signal would be
// wasteful to carry through the rest of the pipeline for no benefit).
export async function fetchDepthCharts(season, log = () => {}) {
  try {
    const rows = await fetchCSV(DEPTH_CHARTS_RELEASE(season));
    const latestByTeam = new Map();
    for (const r of rows) {
      if (!r.team || !r.dt) continue;
      const cur = latestByTeam.get(r.team);
      if (!cur || r.dt > cur) latestByTeam.set(r.team, r.dt);
    }
    const latest = rows.filter(r => r.team && latestByTeam.get(r.team) === r.dt);
    log(`Loaded depth charts for ${latestByTeam.size} teams (most recent scrape per team, from ${rows.length} total rows on record for ${season}).`);
    return latest;
  } catch (e) { log(`Depth chart fetch failed for ${season}: ${e.message}`); return []; }
}
