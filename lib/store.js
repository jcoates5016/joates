// Netlify Blobs wrapper. Deployed through Netlify (data.js, notes.js) it works automatically — Netlify injects
// the site/token context, so `getStore(name)` alone is enough. But the refresh pipeline itself no longer runs
// as a Netlify Function at all (see README — Background Functions turned out to require a paid Pro plan, so
// the refresh moved to a scheduled GitHub Actions job instead). A plain Node script outside Netlify's runtime
// has no auto-injected context, so when NETLIFY_SITE_ID + NETLIFY_BLOBS_TOKEN are present (set as GitHub
// Actions secrets) this switches to @netlify/blobs' documented "manual configuration" mode — same store, same
// data, just reached with an explicit site ID + personal access token instead of Netlify's runtime magic.
//
// Beyond the snapshot/notes store the old version had, this now also keeps two small rolling histories that
// several new factors depend on:
//   - injury snapshots per (season, week): lets the injury factor compare "today's" practice status against
//     what it was a day or two ago (DNP -> limited -> full, or the reverse), instead of only ever seeing one
//     point-in-time status.
//   - price snapshots per (season, week): lets the market factor plot how a price has moved across the whole
//     week, not just "open vs. current" from a single book's own openOdds field.
// Both are capped so they can't grow unbounded across a season.
import { getStore } from "@netlify/blobs";

const SNAPSHOT_KEY = "latest-snapshot.json";
const NOTES_KEY = "notes.json";
const MAX_HISTORY_POINTS = 12;

function store(name) {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  if (siteID && token) return getStore({ name, siteID, token }); // running outside Netlify (GitHub Actions)
  return getStore(name); // running inside a deployed Netlify Function — context auto-injected
}

export async function saveSnapshot(snapshot) {
  await store("apex-edge").setJSON(SNAPSHOT_KEY, snapshot);
}
export async function loadSnapshot() {
  return await store("apex-edge").get(SNAPSHOT_KEY, { type: "json" }).catch(() => null);
}

export async function saveNotes(notes) {
  await store("apex-edge").setJSON(NOTES_KEY, notes);
}
export async function loadNotes() {
  const notes = await store("apex-edge").get(NOTES_KEY, { type: "json" }).catch(() => null);
  return Array.isArray(notes) ? notes : [];
}

function weekKey(season, week) { return `${season}-w${week ?? "na"}`; }

export async function appendInjurySnapshot(season, week, byTeam) {
  const key = `injuries-${weekKey(season, week)}.json`;
  const s = store("apex-edge-history");
  const existing = (await s.get(key, { type: "json" }).catch(() => null)) || [];
  existing.push({ t: new Date().toISOString(), byTeam });
  await s.setJSON(key, existing.slice(-MAX_HISTORY_POINTS));
}
export async function loadInjuryHistory(season, week) {
  const key = `injuries-${weekKey(season, week)}.json`;
  return (await store("apex-edge-history").get(key, { type: "json" }).catch(() => null)) || [];
}

// priceEntries: [{ oddID, book, price, point }] for the current refresh — merged onto each oddID's own
// rolling series so the market factor can see the shape of movement across the week, per book.
export async function appendPriceSnapshots(season, week, priceEntries) {
  const key = `prices-${weekKey(season, week)}.json`;
  const s = store("apex-edge-history");
  const existing = (await s.get(key, { type: "json" }).catch(() => null)) || {};
  const t = new Date().toISOString();
  for (const e of priceEntries) {
    const seriesKey = `${e.oddID}|${e.book}`;
    const series = existing[seriesKey] || [];
    series.push({ t, price: e.price, point: e.point ?? null });
    existing[seriesKey] = series.slice(-MAX_HISTORY_POINTS);
  }
  await s.setJSON(key, existing);
}
export async function loadPriceHistory(season, week) {
  const key = `prices-${weekKey(season, week)}.json`;
  return (await store("apex-edge-history").get(key, { type: "json" }).catch(() => null)) || {};
}

// Historical weather, one entry per (home team, season, week) — unlike everything else in this file, this
// never needs trimming or a TTL: the weather a game was actually played in never changes once it's happened, so
// a game fetched once from Open-Meteo's archive (see fetchHistoricalWeather) is cached forever and never
// re-fetched. Kept as one flat object (not per-week like the histories above) since it accumulates slowly (at
// most ~285 entries/season) and every caller wants to check "have we already got this specific game" regardless
// of which week's refresh is asking.
const HISTORICAL_WEATHER_KEY = "historical-weather-cache.json";
export async function loadHistoricalWeatherCache() {
  const cache = await store("apex-edge-history").get(HISTORICAL_WEATHER_KEY, { type: "json" }).catch(() => null);
  return cache && typeof cache === "object" ? cache : {};
}
export async function saveHistoricalWeatherCache(cache) {
  await store("apex-edge-history").setJSON(HISTORICAL_WEATHER_KEY, cache);
}

// The results ledger (see lib/grading.js). Each week's own predictions are saved verbatim right after the
// probability model runs — kind, player/propType/line/side, kickoff, modelProb/marketProb/edge/confidence — so
// a later refresh (once those games are over) can look back, check what actually happened, and mark each one
// hit/miss. `saveWeeklyPicks` overwrites the whole week's array each refresh (new props get added, prices/
// factors on existing ones get refreshed) but preserves any `graded`/`hit`/`actualValue` already written onto a
// pick by merging on `oddID`, so a pick already graded never loses its result just because the week's odds
// feed still lists it.
export async function loadWeeklyPicks(season, week) {
  const key = `picks-${weekKey(season, week)}.json`;
  const picks = await store("apex-edge-history").get(key, { type: "json" }).catch(() => null);
  return Array.isArray(picks) ? picks : [];
}
export async function saveWeeklyPicks(season, week, picks) {
  const key = `picks-${weekKey(season, week)}.json`;
  await store("apex-edge-history").setJSON(key, picks);
}

// Same shape of thing as the weekly picks ledger just above, but for parlays instead of single prop picks — see
// lib/grading.js's gradeCompletedParlays and lib/pipeline.js's buildGradableParlays. Each entry is one saved
// parlay attempt (one risk tier, from cross-game/SGP/slate — see the `key` comment in buildGradableParlays for
// how that's kept stable and unique) with its own list of legs, each leg gradable the same way an individual
// prop pick is. `saveWeeklyParlays` overwrites the whole week's array each refresh the same way saveWeeklyPicks
// does, and the merge-preserving-already-graded-results logic lives in pipeline.js, not here.
export async function loadWeeklyParlays(season, week) {
  const key = `parlays-${weekKey(season, week)}.json`;
  const parlays = await store("apex-edge-history").get(key, { type: "json" }).catch(() => null);
  return Array.isArray(parlays) ? parlays : [];
}
export async function saveWeeklyParlays(season, week, parlays) {
  const key = `parlays-${weekKey(season, week)}.json`;
  await store("apex-edge-history").setJSON(key, parlays);
}

// One running, all-time ledger (not per-week) — attempts/hits/probability sums, bucketed by confidence tier and
// by edge size, that lib/grading.js folds newly-graded picks into and lib/pipeline.js summarizes for the
// frontend's track-record panel. Deliberately stores only raw counters (never a pre-divided hit rate) so folding
// in more graded picks later is a plain addition, not a read-modify-recompute-average dance.
const CALIBRATION_KEY = "calibration-ledger.json";
export async function loadCalibrationLedger() {
  const ledger = await store("apex-edge-history").get(CALIBRATION_KEY, { type: "json" }).catch(() => null);
  return ledger && typeof ledger === "object" ? ledger : {};
}
export async function saveCalibrationLedger(ledger) {
  await store("apex-edge-history").setJSON(CALIBRATION_KEY, ledger);
}
