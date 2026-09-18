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
