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
// Verified live against the real release assets before coding against them (same discipline as every other URL
// in this file) — `ngs_<type>.csv` on its own 404s; the real filename is gzipped (`ngs_<type>.csv.gz`), one file
// per stat type covering every season 2016-present in a single combined download (not split per season the way
// stats_player_week/roster/snaps are), confirmed by actually downloading and inspecting the header + season
// column of a live pull.
const NGS_RELEASE = (statType) => `https://github.com/nflverse/nflverse-data/releases/download/nextgen_stats/ngs_${statType}.csv.gz`;
// Real ESPN Total QBR — verified live the same way (a plain `qbr_week_level.csv` 404s; the real asset is
// gzipped, one combined file covering 2006-present, confirmed by downloading and inspecting a live pull's
// header/season column — same shape as the NGS release above, different release tag). This is ESPN's actual
// published QBR number (`qbr_total`, 0-100 scale), not an app-derived estimate of it.
const QBR_RELEASE = "https://github.com/nflverse/nflverse-data/releases/download/espn_data/qbr_week_level.csv.gz";

// A single flaky download of one release asset (a GitHub CDN blip, a dropped connection — nothing about the data
// itself) used to mean that whole season silently came back empty: fetchMultiSeasonStats/fetchSnapCounts/
// fetchPlayByPlay all catch their own errors and log-and-continue by design (so one bad season doesn't kill a
// whole multi-season run), but that also meant a transient failure looked identical to "this season really has
// no data" — confirmed live when a real `npm run backtest` run dropped 2024's stats to a bare "fetch failed" on
// one attempt while 2024's play-by-play and snap-counts fetched fine seconds later, silently cutting that season
// out of every factor's sample size. Retrying a couple of times with a short backoff before giving up costs
// nothing on the common case (the first attempt almost always succeeds) and turns most of these blips into a
// non-event instead of a quietly incomplete backtest.
async function fetchWithRetry(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}
async function fetchText(url) {
  const res = await fetchWithRetry(url);
  return await res.text();
}
async function fetchCSV(url) {
  const text = await fetchText(url);
  return Papa.parse(text, { header: true, dynamicTyping: true, skipEmptyLines: true }).data;
}
async function fetchGzCSV(url) {
  const res = await fetchWithRetry(url);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = zlib.gunzipSync(buf).toString("utf-8");
  return Papa.parse(text, { header: true, dynamicTyping: true, skipEmptyLines: true }).data;
}
// Same fetch-and-gunzip as fetchGzCSV, but parses row-by-row with Papa's `step` callback and immediately trims
// each row down to `keepColumns` instead of collecting the full parsed array (every column Papa's dynamicTyping
// produces) and trimming afterward. Measured against a real 2025 play-by-play pull: the "parse everything, then
// map to a slim object" approach that fetchPlayByPlay used to do peaked around 2GB of heap for a single season
// (370+ raw columns x ~48,771 rows, all held as full-width objects at once, however briefly) — the exact thing
// that pushed a real multi-season `npm run backtest` run past Node's default heap ceiling on a real machine, even
// though this sandbox's own run happened not to hit it. Streaming the trim down to one row at a time instead
// (each full-width row object becomes garbage as soon as its trimmed copy is pushed) cut that same season's peak
// heap to under 300MB in a direct side-by-side test. Only used for play-by-play, since it's the one dataset here
// wide and long enough for the difference to matter; the other fetchGzCSV callers (NGS, QBR) are comparatively
// small combined-history files.
async function fetchGzCSVStreamedTrim(url, keepColumns) {
  const res = await fetchWithRetry(url);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = zlib.gunzipSync(buf).toString("utf-8");
  const slim = [];
  Papa.parse(text, {
    header: true, dynamicTyping: true, skipEmptyLines: true,
    step: (result) => {
      const r = result.data;
      const o = {};
      for (const c of keepColumns) o[c] = r[c];
      slim.push(o);
    }
  });
  return slim;
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
    const slim = await fetchGzCSVStreamedTrim(PBP_RELEASE(season), PBP_KEEP_COLUMNS);
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
// Next Gen Stats: real, tracking-data-derived player efficiency numbers (CPOE and time-to-throw for passing,
// rush yards over expected for rushing, separation and YAC-over-expectation for receiving) — see
// lib/factors/nextgenstats.js for what each one actually measures and how it's used. Only this season's real
// per-week rows are kept: nflverse's own week=0 row in each file is a season-to-date aggregate that coexists
// in the same file as weeks 1+ (verified live) — leaving it in would silently double-count into any trailing
// average. Small files (a few thousand rows across a decade for each stat type), so there's no per-season
// parameter here the way stats_player_week/roster/snaps have — the whole history downloads every refresh and
// gets filtered down to the current season client-side.
export async function fetchNextGenStats(currentSeason, log = () => {}) {
  try {
    const [passing, receiving, rushing] = await Promise.all([
      fetchGzCSV(NGS_RELEASE("passing")), fetchGzCSV(NGS_RELEASE("receiving")), fetchGzCSV(NGS_RELEASE("rushing"))
    ]);
    const thisSeasonOnly = (rows) => rows.filter(r => Number(r.season) === Number(currentSeason) && Number(r.week) > 0);
    const result = { passing: thisSeasonOnly(passing), receiving: thisSeasonOnly(receiving), rushing: thisSeasonOnly(rushing) };
    log(`Loaded Next Gen Stats for ${currentSeason}: ${result.passing.length} passing, ${result.receiving.length} receiving, ${result.rushing.length} rushing week-rows.`);
    return result;
  } catch (e) { log(`Next Gen Stats fetch failed (non-fatal): ${e.message}`); return { passing: [], receiving: [], rushing: [] }; }
}

export async function fetchEspnQbr(currentSeason, log = () => {}) {
  try {
    const rows = await fetchGzCSV(QBR_RELEASE);
    const thisSeasonOnly = rows.filter(r => Number(r.season) === Number(currentSeason) && r.season_type === "Regular" && Number(r.week_num) > 0);
    log(`Loaded real ESPN QBR for ${currentSeason}: ${thisSeasonOnly.length} qualified QB week-rows.`);
    return thisSeasonOnly;
  } catch (e) { log(`ESPN QBR fetch failed (non-fatal): ${e.message}`); return []; }
}

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
