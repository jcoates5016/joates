import { runPipeline } from "./pipeline.js";
import { saveSnapshot, loadNotes } from "./store.js";

const CURRENT_SEASON = Number(process.env.CURRENT_SEASON || 2026);
const HISTORY_SEASONS = [CURRENT_SEASON, CURRENT_SEASON - 1, CURRENT_SEASON - 2];

export async function doRefresh({ selectedWeek } = {}) {
  const situationalNotes = await loadNotes();
  const snapshot = await runPipeline({
    demo: false,
    sgoApiKey: process.env.SPORTSGAMEODDS_API_KEY,
    currentSeason: CURRENT_SEASON,
    historySeasons: HISTORY_SEASONS,
    selectedWeek: selectedWeek || null,
    situationalNotes
  });
  await saveSnapshot(snapshot);
  return snapshot;
}
