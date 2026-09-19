// Orchestrates one full refresh: fetch -> analyze -> factor engine (every computed factor) -> AI annotation ->
// parlays -> snapshot. Runs from both the scheduled background function and the manual "Refresh Now" trigger
// (both background functions now, see netlify/functions/ — a lesson learned the hard way earlier: this
// pipeline is too slow for Netlify's ~30s normal function budget).
import { fetchMultiSeasonStats, fetchSchedule, fetchRoster, fetchSnapCounts, fetchPlayByPlay, fetchDepthCharts, fetchNextGenStats } from "./fetchers/nflverse.js";
import { fetchNFLEvents } from "./fetchers/odds.js";
import { fetchInjuries } from "./fetchers/injuries.js";
import { fetchForecast } from "./fetchers/weather.js";
import { buildGameLogIndex, buildRosterIndex, buildSnapsIndex, buildDepthChartIndex } from "./identity.js";
import { analyzePlayerProps, BOOK_IDS, SUSPECT_EDGE_THRESHOLD, getPrice, extractGameContext } from "./analyze.js";
import { createFactorEngine } from "./factors/index.js";
import { computeInjuryEscalations } from "./factors/injury.js";
import { estimatePropProbability } from "./probability.js";
import { gradeCompletedPicks, foldIntoLedger, summarizeLedger } from "./grading.js";
import { findScheduleRow } from "./factors/schedule.js";
import { buildAllParlays, buildSameGameParlays, buildSlateParlays } from "./parlays.js";
import { buildTopPicks } from "./topPicks.js";
import { annotatePropsWithAI, annotateScoutingTakes, annotateParlaysWithAI, pruneAiCache, selectAiEligible, AI_NOTE_LIMIT, createSpendGuard } from "./ai.js";
import { buildDemoData } from "./demoData.js";
import { STADIUMS } from "./stadiums.js";
import { normTeam } from "./teamCodes.js";
import { fetchHistoricalWeather } from "./fetchers/weather.js";
import {
  appendInjurySnapshot, loadInjuryHistory, appendPriceSnapshots, loadPriceHistory, loadAiCache, saveAiCache,
  loadWeeklyPicks, saveWeeklyPicks, loadCalibrationLedger, saveCalibrationLedger,
  loadHistoricalWeatherCache, saveHistoricalWeatherCache, loadSpendLedger, saveSpendLedger
} from "./store.js";

// A pick counts as having actually been on the Edge Board the moment it's first saved — same threshold
// buildAllParlays/the frontend's Mispriced Bets tab use (see the `mispriced` filter further down), just without
// its top-20 display cap (that cap is a UI convenience, not the real definition of "this was a flagged edge").
// Hoisted to module scope because buildGradablePicks needs it below, before the `mispriced` list itself is built.
const MIN_TRUE_EDGE = 0.03;

function indexSchedule(rows) {
  return rows.map(r => ({
    season: r.season, week: r.week, home: r.home_team || r.home, away: r.away_team || r.away,
    home_team: r.home_team, away_team: r.away_team, date: r.gameday || r.game_date || r.date, roof: r.roof,
    location: r.location, stadium: r.stadium,
    // referee/total/total_line: real historical fields for the referee-tendency factor (lib/factors/referee.js)
    // — blank for any game that hasn't been played yet, which is exactly why that factor reports itself
    // unavailable until an assignment shows up in a later refresh, rather than guessing.
    referee: r.referee, total: r.total, total_line: r.total_line,
    away_rest: r.away_rest, home_rest: r.home_rest, away_qb_name: r.away_qb_name, home_qb_name: r.home_qb_name
  }));
}

// Best-effort: figures out which single week's games this refresh is looking at, so the per-week Blobs
// history keys (injury snapshots, price snapshots) stay consistent across refreshes. Falls back to a stable
// generic bucket if it can't tell — history just won't span a week boundary cleanly in that edge case.
function inferWeek(events, schedule, currentSeason) {
  for (const evt of events) {
    const home = normTeam(evt.teams?.home?.names?.short || evt.homeTeam);
    const away = normTeam(evt.teams?.away?.names?.short || evt.awayTeam);
    const row = findScheduleRow(schedule, currentSeason, home, away);
    if (row) return Number(row.week);
  }
  return "unknown";
}

// The odds fetch (fetchNFLEvents) has no date/week parameter of its own — it just asks for up to 100 events
// with odds available, which on a real feed returns the whole rest of the season, not "this week." Without a
// week filter downstream, every one of those shows up as if it were part of the current slate (this is exactly
// what produced "100 games this week" and a pile of props from games weeks away, on a live Rookie-tier run).
// The filtering block below already existed for an explicitly-passed `selectedWeek`, but nothing ever passed
// one in production (doRefresh/scripts/refresh.js always call with `{}`), so it silently never ran. This picks
// the current week automatically from the schedule's own dates when the caller hasn't specified one: the
// earliest week for `currentSeason` that hasn't fully finished yet (its last game is still today or later),
// falling back to the season's last week if every game has already been played.
function inferCurrentWeekFromSchedule(schedule, currentSeason, now = new Date()) {
  const byWeek = new Map();
  schedule.forEach(s => {
    if (s.season !== currentSeason || !s.week || !s.date) return;
    const d = new Date(s.date);
    if (isNaN(d.getTime())) return;
    const w = Number(s.week);
    if (!byWeek.has(w)) byWeek.set(w, { min: d, max: d });
    else { const r = byWeek.get(w); if (d < r.min) r.min = d; if (d > r.max) r.max = d; }
  });
  if (!byWeek.size) return null;
  const weeks = [...byWeek.keys()].sort((a, b) => a - b);
  const cutoff = new Date(now.getTime() - 18 * 3600 * 1000); // a week isn't "over" until ~18h after its last kickoff
  for (const w of weeks) {
    if (byWeek.get(w).max >= cutoff) return w;
  }
  return weeks[weeks.length - 1];
}

// Backfills `_wasWetGame` onto historical game-log rows for players actually on this week's board — the flag
// computeWeatherSplitHistorical (lib/factors/playerSplits.js) reads to build a player's personal wet/dry split.
// Nothing ever set this before (caught while wiring up backtesting for the weather nudge, which made the dead
// code path obvious), so that "personal history first" branch of the weather nudge could never actually fire —
// it always fell through to the generic positional fallback. Only looks up games strictly needed by this week's
// players (not the whole league's history), skips indoor games outright (never wet, no lookup needed), and
// checks the permanent Blobs cache before ever hitting Open-Meteo's archive API — a game's weather never
// changes once it's played, so this is a one-time cost per game, not a per-refresh one.
async function backfillHistoricalWeather(propRows, gameLogIndex, schedule, log) {
  const neededGames = new Map(); // gameKey -> { lat, lon, date }
  const rowsByGameKey = new Map(); // gameKey -> [gameLogRow, ...] to mutate once the answer is known
  const seenPlayers = new Set();
  for (const propRow of propRows) {
    const player = propRow._resolvedPlayer;
    if (!player?._logKey || seenPlayers.has(player._logKey)) continue;
    seenPlayers.add(player._logKey);
    const rows = (gameLogIndex.get(player._logKey) || []).slice(-10); // matches how the split itself is used (last-10-ish)
    for (const row of rows) {
      if (row._wasWetGame != null) continue;
      // Same schedule-matching approach computeVenueSplit/computeWeatherSplitHistorical already use elsewhere —
      // matched by (season, week) plus the player's current team, for consistency with those factors.
      const g = schedule.find(s => s.season === row.season && Number(s.week) === Number(row.week) &&
        (normTeam(s.home) === player.team || normTeam(s.away) === player.team));
      if (!g || !g.date) continue;
      const roof = (g.roof || "").toLowerCase();
      if (roof.includes("dome") || roof === "closed") { row._wasWetGame = false; continue; }
      const homeTeam = normTeam(g.home);
      const venue = STADIUMS[homeTeam];
      if (!venue) continue;
      const gameKey = `${homeTeam}|${row.season}|${row.week}`;
      neededGames.set(gameKey, { lat: venue.lat, lon: venue.lon, date: g.date });
      if (!rowsByGameKey.has(gameKey)) rowsByGameKey.set(gameKey, []);
      rowsByGameKey.get(gameKey).push(row);
    }
  }
  if (!neededGames.size) return;
  let cache = {};
  try { cache = await loadHistoricalWeatherCache(); } catch (e) { log(`Historical weather cache load failed (non-fatal): ${e.message}`); }
  const misses = [...neededGames.entries()].filter(([key]) => !(key in cache));
  if (misses.length) {
    log(`Backfilling historical weather for ${misses.length} game(s) not yet cached (cached permanently once fetched — this cost shouldn't repeat).`);
    const CONCURRENCY = 5;
    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const group = misses.slice(i, i + CONCURRENCY);
      await Promise.all(group.map(async ([key, g]) => {
        const result = await fetchHistoricalWeather(g.lat, g.lon, g.date, log);
        cache[key] = { wasWet: result?.available ? result.wasWet : null, fetchedAt: new Date().toISOString() };
      }));
    }
    try { await saveHistoricalWeatherCache(cache); } catch (e) { log(`Historical weather cache save failed (non-fatal): ${e.message}`); }
  }
  for (const [key, rows] of rowsByGameKey.entries()) {
    const entry = cache[key];
    if (entry && entry.wasWet != null) rows.forEach(row => { row._wasWetGame = entry.wasWet; });
  }
}

// Pure and exported so scripts/dry-run.js can unit-test it directly with synthetic picks — the real call site
// only ever runs live (gated `!demo` below, same as CLV/grading), the same reason those are unit-tested
// directly against gradeCompletedPicks rather than through a full demo pipeline run. Picks from any number of
// weeks in, already-graded or not — the caller decides which weeks' saved picks to combine.
export function buildEdgeBoardHistory(picks, limit = 40) {
  const historyPicks = picks
    .filter(p => p.wasEdgeBoard && p.graded)
    .sort((a, b) => new Date(b.kickoff) - new Date(a.kickoff))
    .slice(0, limit);
  return { picks: historyPicks, hits: historyPicks.filter(p => p.hit).length, total: historyPicks.length };
}

// The saveable, gradeable shape of a prop pick — deliberately only the fields lib/grading.js needs to later
// check what actually happened (player identity + the exact threshold graded against) plus the model's estimate
// at prediction time. `factors.form.line` (not row.line) is the real threshold graded on — for Anytime-TD-style
// props row.line is null and the real cutoff is 0, and computeFormFactor already resolved that; using row.line
// directly here would silently drop every TD prop from the ledger.
// `pickPrice`/`pickBook` are captured HERE, once, at the moment this pick first gets saved — the price/book this
// bet would actually have been placed at. The merge loop in runPipeline below is what keeps these from being
// silently overwritten by a fresher price on every later refresh (which would make CLV always read ~0, since
// "opening" and "current" would always be the same snapshot). `closingPrice`/`closingBook`/`clv` start null and
// only get filled in by gradeCompletedPicks once the game is over.
function buildGradablePicks(propRows, season, week) {
  return propRows
    .filter(r => r.model?.available && r.factors?.form?.available && r._resolvedPlayer?._logKey)
    .map(r => ({
      oddID: r.oddID, kind: "prop", player: r.player, playerKey: r._resolvedPlayer._logKey,
      propType: r.propType, propLabel: r.propLabel, line: r.factors.form.line, side: r.side,
      opponent: r.opponent, kickoff: r.kickoff, season, week,
      modelProb: r.modelProb, marketProb: r.marketProb, edge: r.trueEdge, confidence: r.confidence,
      pickPrice: r.bestPrice ?? null, pickBook: r.bestBook ?? null,
      closingPrice: null, closingBook: null, clv: null,
      // Captured once, same "never overwritten on a later refresh" treatment as pickPrice/pickBook below — the
      // point of the Edge Board history panel is "of what was actually flagged as an edge when it was first
      // surfaced, what hit," not "of whatever still qualifies by kickoff" (a pick's edge can shrink or vanish
      // entirely as the model updates through the week even though it was a real edge when first shown).
      wasEdgeBoard: r.trueEdge > MIN_TRUE_EDGE && ["medium", "high"].includes(r.confidence) && !r.teamMismatch && !r.suspect,
      graded: false, hit: null, actualValue: null, gradedAt: null
    }));
}

export async function runPipeline(opts) {
  const {
    demo = false, sgoApiKey, anthropicApiKey, currentSeason, historySeasons,
    selectedWeek = null, situationalNotes = [], aiOn = true, scoutOn = true
  } = opts;
  const logs = [];
  const log = (msg) => logs.push({ t: new Date().toISOString(), msg });

  let events, statRows, schedRows, rosterRows, snapRows, pbpRows, depthChartRows, demoInjuriesByTeam;
  // Next Gen Stats: demo mode gets an empty index (see lib/factors/index.js — every computeNgs* function
  // already handles that cleanly), never fetched live — no dry-run fixture built for it, unlike the injury/
  // depth-chart data demo mode does synthesize, since the compute functions are unit-tested directly instead
  // (see scripts/dry-run.js).
  let ngsData = { passing: [], receiving: [], rushing: [] };
  if (demo) {
    ({ events, statRows, schedRows, rosterRows, snapRows, pbpRows, depthChartRows, injuriesByTeam: demoInjuriesByTeam } = buildDemoData(currentSeason, historySeasons));
    log("Built demo dataset.");
  } else {
    if (!sgoApiKey) throw new Error("Missing SPORTSGAMEODDS_API_KEY environment variable.");
    [events, statRows, schedRows, rosterRows, snapRows, pbpRows, depthChartRows, ngsData] = await Promise.all([
      fetchNFLEvents(sgoApiKey, BOOK_IDS, log),
      fetchMultiSeasonStats(historySeasons, log),
      fetchSchedule(log),
      fetchRoster(currentSeason, log),
      fetchSnapCounts(currentSeason, log),
      fetchPlayByPlay(currentSeason, log),
      fetchDepthCharts(currentSeason, log),
      fetchNextGenStats(currentSeason, log)
    ]);
  }

  const gameLogIndex = buildGameLogIndex(statRows);
  const rosterIndex = buildRosterIndex(rosterRows);
  const depthChartIndex = buildDepthChartIndex(depthChartRows || []);
  const snapsByKey = buildSnapsIndex(snapRows);
  const schedule = indexSchedule(schedRows);

  const effectiveWeek = demo ? null : (selectedWeek || inferCurrentWeekFromSchedule(schedule, currentSeason));
  if (!demo && effectiveWeek) {
    const pairs = new Set();
    schedule.forEach(s => {
      if (s.season === currentSeason && Number(s.week) === Number(effectiveWeek) && s.home && s.away) {
        pairs.add(s.home + "|" + s.away); pairs.add(s.away + "|" + s.home);
      }
    });
    if (pairs.size) {
      const before = events.length;
      events = events.filter(evt => {
        const home = evt.teams?.home?.names?.short || evt.homeTeam;
        const away = evt.teams?.away?.names?.short || evt.awayTeam;
        return home && away && pairs.has(home + "|" + away);
      });
      log(`Filtered to Week ${effectiveWeek}${selectedWeek ? "" : " (auto-detected)"}: ${events.length}/${before} events kept.`);
    } else {
      log(`Could not verify Week ${effectiveWeek} against the schedule — showing every event the odds feed returned.`);
    }
  }

  const teams = [...new Set(events.flatMap(e => [e.teams?.home?.names?.short, e.teams?.away?.names?.short]).filter(Boolean))];
  const injuriesByTeam = demo ? (demoInjuriesByTeam || {}) : await fetchInjuries(teams, log);
  const week = demo ? (selectedWeek || 1) : (effectiveWeek || inferWeek(events, schedule, currentSeason));

  let injuryHistory = [], priceHistory = {};
  if (!demo) {
    try {
      await appendInjurySnapshot(currentSeason, week, injuriesByTeam);
      injuryHistory = await loadInjuryHistory(currentSeason, week);
    } catch (e) { log(`Injury history store failed (non-fatal): ${e.message}`); }
    try { priceHistory = await loadPriceHistory(currentSeason, week); }
    catch (e) { log(`Price history load failed (non-fatal): ${e.message}`); }
  }

  const propRows = analyzePlayerProps(events, gameLogIndex, rosterIndex, depthChartIndex);

  // Data-quality visibility for the same reason suspect price edges get flagged: a player whose weekly-roster
  // team and today's depth-chart team disagree (a trade the roster file hasn't caught up to yet, most likely)
  // has his opponent/team-based factors computed against a team he may not actually be on right now. resolvePlayer
  // already prefers the depth chart's fresher team when this happens; this just makes it visible instead of
  // silently picking one and moving on.
  const rosterConflicts = propRows.filter(r => r._resolvedPlayer?.rosterConflict);
  if (rosterConflicts.length) {
    log(`${rosterConflicts.length} player(s) have a weekly-roster team that disagrees with today's depth chart ` +
      `(using the depth chart's fresher team): ${rosterConflicts.map(r => `${r.player} (roster: ${r._resolvedPlayer.rosterTeam}, depth chart: ${r._resolvedPlayer.depthChartTeam})`).join(", ")}`);
  }

  // Weather forecast — only for outdoor games, one call per event (not per prop), matched by the schedule's
  // own `roof` field so a dome game never wastes a call.
  const weatherByGame = new Map();
  if (!demo) {
    await Promise.all(events.map(async (evt) => {
      const eventId = evt.eventID || evt.id;
      const home = normTeam(evt.teams?.home?.names?.short || evt.homeTeam);
      const away = normTeam(evt.teams?.away?.names?.short || evt.awayTeam);
      const gameRow = findScheduleRow(schedule, currentSeason, home, away);
      const kickoff = evt.status?.startsAt || evt.scheduled || evt.startTime || null;
      if (!gameRow || !kickoff) return;
      if ((gameRow.roof || "").toLowerCase().includes("dome") || (gameRow.roof || "").toLowerCase() === "closed") return;
      const venue = STADIUMS[home];
      if (!venue) return;
      const forecast = await fetchForecast(venue.lat, venue.lon, kickoff, log);
      if (forecast) weatherByGame.set(eventId, forecast);
    }));
  }

  // Read once from the same event payload every prop already comes from — see analyze.js's extractGameContext
  // for why this isn't a bet type here, just a contextual read of the market's own implied game script.
  const gameContextByEvent = new Map();
  if (!demo) {
    let loggedSample = false;
    events.forEach(evt => {
      const ctx = extractGameContext(evt);
      if (!ctx.available) return;
      gameContextByEvent.set(evt.eventID || evt.id, ctx);
      // One-time sanity-check log per refresh: the home-team-favored-means-negative-spread assumption in
      // extractGameContext couldn't be verified against a real live payload while this was built (see that
      // function's comment) — this makes it trivially checkable against a real sportsbook board on the very
      // first live refresh instead of trusting it silently.
      if (!loggedSample) {
        const home = evt.teams?.home?.names?.short || evt.homeTeam;
        const favored = ctx.homeSpread < 0 ? home : (evt.teams?.away?.names?.short || evt.awayTeam);
        log(`Game-script check: ${home} spread ${ctx.homeSpread > 0 ? "+" : ""}${ctx.homeSpread}, total ${ctx.total} — reading ${favored} as favored. Verify this against a real sportsbook board once; flip the sign in analyze.js's extractGameContext if it's backwards.`);
        loggedSample = true;
      }
    });
  }
  if (!demo) {
    try { await backfillHistoricalWeather(propRows, gameLogIndex, schedule, log); }
    catch (e) { log(`Historical weather backfill failed (non-fatal, personal weather splits will stay unavailable): ${e.message}`); }
  }

  const factorEngine = createFactorEngine({
    currentSeason, gameLogIndex, rosterIndex, depthChartIndex, snapsByKey, schedule, pbpRows,
    injuriesByTeam, injuryHistory, priceHistory, situationalNotes, weatherByGame, gameContextByEvent, ngsData
  });
  for (const row of propRows) {
    row.factors = await factorEngine.assemblePropFactors(row);
    // Legacy/debug only — kept so older snapshots/UI reading it don't break, but nothing ranks on this anymore.
    // See lib/probability.js for the real, market-anchored estimate that replaced it.
    row.mispricedScore = factorEngine.computeMispricedScore(row);
    const model = estimatePropProbability(row.factors, row.refProb);
    row.model = model;
    if (model.available) {
      row.modelProb = model.modelProb; row.marketProb = model.marketProb;
      // `trueEdge` (model vs. market probability) is a different question from `bestEdge` (one book's price vs.
      // consensus) — the former is "is this more likely than the market thinks," the latter is "which book pays
      // the most for the same bet." Both matter; only trueEdge is a statistical edge.
      row.trueEdge = model.edge; row.confidence = model.confidence; row.modelContributors = model.contributors;
      row.modelContributorDetails = model.contributorDetails;
    }
  }
  // Anthropic spend control: only the AI_NOTE_LIMIT rows most likely to actually hit get an AI note at all —
  // see selectAiEligible in lib/ai.js for the ranking logic and why this was the single biggest driver of
  // Anthropic cost per refresh before it existed.
  selectAiEligible(propRows, AI_NOTE_LIMIT);

  if (!demo) {
    try {
      const priceEntries = propRows.flatMap(r => BOOK_IDS.map(b => {
        const price = getPrice(r, b);
        return price == null ? null : { oddID: r.oddID, book: b, price, point: r.line ?? null };
      })).filter(Boolean);
      await appendPriceSnapshots(currentSeason, week, priceEntries);
    } catch (e) { log(`Price history save failed (non-fatal): ${e.message}`); }
  }

  // The results ledger (lib/grading.js): grade whatever from last time has finished, fold that into the
  // all-time calibration ledger, then save this run's fresh picks so a future refresh can grade them in turn.
  // Both this week's and the prior week's saved picks are checked — most games grade while still "this week"
  // (the current-week window stays open until ~18h after that week's last kickoff), but the last day or two of
  // a week's games only become gradeable after the pipeline has already rolled over to the next week.
  let trackRecord = summarizeLedger({});
  // "Of what actually showed up as a flagged edge, what hit?" — separate from trackRecord's aggregate
  // calibration stats above, this is the literal pick-by-pick list the Edge Board history panel renders.
  // Combines the previous week (the normal case) with any already-graded picks still sitting in the current
  // week's own saved list (an early Thursday-night game that finished before the rest of the week's board even
  // loaded) — sorted most recent first and capped so the payload can't grow unbounded across a long season.
  let edgeBoardHistory = { picks: [], hits: 0, total: 0 };
  if (!demo) {
    try {
      const numericWeek = Number(week);
      const hasPrevWeek = !isNaN(numericWeek) && numericWeek > 1;
      const [oldCurrentWeekPicks, oldPrevWeekPicks, prevWeekPriceHistory] = await Promise.all([
        loadWeeklyPicks(currentSeason, week),
        hasPrevWeek ? loadWeeklyPicks(currentSeason, numericWeek - 1) : Promise.resolve([]),
        hasPrevWeek ? loadPriceHistory(currentSeason, numericWeek - 1).catch(() => ({})) : Promise.resolve({})
      ]);
      // `priceHistory` here is this week's own rolling series, already loaded above (for the market-movement
      // factor) — reused as-is for CLV on this week's grades; the previous week needs its own series loaded
      // separately since a rolled-over week's price history lives under its own (season, week) key.
      const gradedCurrent = gradeCompletedPicks(oldCurrentWeekPicks, gameLogIndex, priceHistory);
      const gradedPrev = hasPrevWeek ? gradeCompletedPicks(oldPrevWeekPicks, gameLogIndex, prevWeekPriceHistory) : [];

      const freshPicks = buildGradablePicks(propRows, currentSeason, week);
      const byOddId = new Map(oldCurrentWeekPicks.map(p => [p.oddID, p]));
      for (const p of freshPicks) {
        const existing = byOddId.get(p.oddID);
        if (existing?.graded) continue; // never let a fresh, ungraded snapshot clobber a real result
        // Capture pickPrice/pickBook ONCE — a fresh refresh's current price is not "the price this bet was
        // placed at" for CLV purposes. Once an ungraded pick already has a captured price, every later refresh
        // keeps it, even as everything else about the row (modelProb, factors, etc.) stays current.
        if (existing?.pickPrice != null) { p.pickPrice = existing.pickPrice; p.pickBook = existing.pickBook; }
        if (existing) p.wasEdgeBoard = existing.wasEdgeBoard;
        byOddId.set(p.oddID, p);
      }
      await saveWeeklyPicks(currentSeason, week, [...byOddId.values()]);
      if (hasPrevWeek) await saveWeeklyPicks(currentSeason, numericWeek - 1, oldPrevWeekPicks);

      const newlyGraded = [...gradedCurrent, ...gradedPrev];
      const ledger = await loadCalibrationLedger();
      if (newlyGraded.length) {
        foldIntoLedger(ledger, newlyGraded);
        await saveCalibrationLedger(ledger);
        log(`Graded ${newlyGraded.length} completed pick(s) against real results.`);
      }
      trackRecord = summarizeLedger(ledger);
      edgeBoardHistory = buildEdgeBoardHistory([...oldPrevWeekPicks, ...oldCurrentWeekPicks]);
    } catch (e) { log(`Results ledger update failed (non-fatal): ${e.message}`); }
  }

  // Built before the AI block below since none of these three depend on a row's own AI note (only on
  // modelProb/confidence, already computed above) — but their AI rationale (annotateParlaysWithAI) has to run
  // inside that block so it shares the same cache load/save/prune as everything else.
  const parlays = buildAllParlays(propRows);
  const sameGameParlays = buildSameGameParlays(propRows);
  const slateParlays = buildSlateParlays(propRows);
  // Every tier attempt (ok or not) from all three groupings, flattened into one list with a stable `_cacheKey`
  // (independent of which book happens to win best price week to week — see annotateParlaysWithAI in ai.js) and
  // a `_contextLabel` (which game or slate it's from, since e.g. every game's SGP reuses the same "Low Risk"
  // tier label). Mutating these objects in place means the AI annotation below lands directly on the same
  // objects sitting inside `parlays`/`sameGameParlays`/`slateParlays` — no reassembly needed afterward.
  const allParlayAttempts = [
    ...parlays.map(p => Object.assign(p, { _cacheKey: `cross:${p.tier.key}`, _contextLabel: "Cross-game" })),
    ...sameGameParlays.flatMap(g => g.tiers.map(t => Object.assign(t, { _cacheKey: `sgp:${g.eventId}:${t.tier.key}`, _contextLabel: g.matchup }))),
    ...slateParlays.flatMap(s => s.tiers.map(t => Object.assign(t, { _cacheKey: `slate:${s.window}:${t.tier.key}`, _contextLabel: s.label })))
  ];

  // Daily Anthropic spend cap — see README's "Anthropic cost controls" and lib/ai.js's createSpendGuard for the
  // full reasoning. Defaults to $5/day; override with the ANTHROPIC_DAILY_CAP_USD env var (GitHub Actions
  // secret) if that's ever too tight or too loose. Loaded/saved once per refresh regardless of demo mode so the
  // guard object always exists for the `anthropicSpend` field in the returned snapshot — demo mode just never
  // persists it back to Blobs (nothing here should touch a real site's spend ledger from a sanity-check run).
  const ANTHROPIC_DAILY_CAP_USD = Number(process.env.ANTHROPIC_DAILY_CAP_USD) || 5;
  let spendLedger = { date: null, spentUsd: 0, callCount: 0, history: [] };
  if (!demo) {
    try { spendLedger = await loadSpendLedger(); } catch (e) { log(`Spend ledger load failed (non-fatal, cap resets this run): ${e.message}`); }
  }
  const spendGuard = createSpendGuard(spendLedger, ANTHROPIC_DAILY_CAP_USD);
  if (spendGuard.exhausted) {
    log(`Anthropic spend cap already reached today ($${spendGuard.snapshot().spentUsd.toFixed(2)} / $${ANTHROPIC_DAILY_CAP_USD}) — skipping all AI notes this refresh. Raise ANTHROPIC_DAILY_CAP_USD or wait for the daily reset (UTC midnight) if this refresh needed fresh notes.`);
  }

  if ((aiOn || scoutOn) && anthropicApiKey && !demo) {
    let aiCache = { props: {}, scouting: {}, parlays: {} };
    try { aiCache = await loadAiCache(currentSeason, week); } catch (e) { log(`AI cache load failed (non-fatal, notes will regenerate): ${e.message}`); }
    aiCache.props ||= {}; aiCache.scouting ||= {}; aiCache.parlays ||= {};

    if (aiOn) {
      await Promise.all([
        annotatePropsWithAI(propRows, anthropicApiKey, aiCache.props, log, spendGuard),
        annotateParlaysWithAI(allParlayAttempts, anthropicApiKey, aiCache.parlays, log, spendGuard)
      ]);
    }
    if (scoutOn) {
      // Cost control: scouting takes are the purely speculative bucket, and their content barely changes
      // week to week — no reason to pay for a fresh regeneration on every single refresh, whether that refresh
      // is on a schedule or triggered manually. `scoutingMeta` is a sibling field on the aiCache object (not
      // inside aiCache.scouting's own oddID-keyed map, which pruneAiCache below would delete it from every
      // refresh since it isn't a real oddID). When still within the throttle window, annotateScoutingTakes
      // runs in cache-only mode: rows whose content hasn't changed still get their existing note reapplied for
      // free, everything else just waits until this comes due again.
      const SCOUTING_THROTTLE_HOURS = 24;
      aiCache.scoutingMeta ||= { lastFullRunAt: null };
      const hoursSinceLastScouting = aiCache.scoutingMeta.lastFullRunAt
        ? (Date.now() - new Date(aiCache.scoutingMeta.lastFullRunAt).getTime()) / 3600000
        : Infinity;
      const scoutingDue = hoursSinceLastScouting >= SCOUTING_THROTTLE_HOURS;
      await annotateScoutingTakes(propRows, anthropicApiKey, aiCache.scouting, log, { cacheOnly: !scoutingDue, spendGuard });
      if (scoutingDue) aiCache.scoutingMeta.lastFullRunAt = new Date().toISOString();
      else log(`Scouting takes: throttled (last full run ${hoursSinceLastScouting.toFixed(1)}h ago, due at ${SCOUTING_THROTTLE_HOURS}h).`);
    }

    try {
      pruneAiCache(aiCache.props, propRows, r => r.oddID ?? null);
      pruneAiCache(aiCache.scouting, propRows, r => r.oddID ?? null);
      pruneAiCache(aiCache.parlays, allParlayAttempts.filter(p => p.ok), p => p._cacheKey ?? null);
      await saveAiCache(currentSeason, week, aiCache);
    } catch (e) { log(`AI cache save failed (non-fatal): ${e.message}`); }
  } else if (anthropicApiKey) {
    // Demo mode: still exercise the AI code paths when asked (aiOn/scoutOn), just without touching Blobs —
    // dry-run has no site to read/write and shouldn't need one to prove the annotation logic itself works.
    if (aiOn) {
      await Promise.all([
        annotatePropsWithAI(propRows, anthropicApiKey, {}, log, spendGuard),
        annotateParlaysWithAI(allParlayAttempts, anthropicApiKey, {}, log, spendGuard)
      ]);
    }
    if (scoutOn) await annotateScoutingTakes(propRows, anthropicApiKey, {}, log, { spendGuard });
  }
  if (!demo) {
    try { await saveSpendLedger(spendGuard._ledger); } catch (e) { log(`Spend ledger save failed (non-fatal): ${e.message}`); }
  }
  const anthropicSpend = spendGuard.snapshot();

  // Ranked by trueEdge (model probability minus the market's own implied probability) now, not the old flat
  // point score — and gated on confidence so a 2-game fluke with a big raw edge number can't outrank a real,
  // well-supported trend. MIN_TRUE_EDGE is a real threshold in probability terms: below ~3 points of edge, the
  // model isn't saying anything the market doesn't already know.
  const MIN_TRUE_EDGE = 0.03;
  const mispriced = propRows.filter(r => r.model?.available && r.trueEdge > MIN_TRUE_EDGE &&
    ["medium", "high"].includes(r.confidence) && !r.teamMismatch && !r.suspect)
    .sort((a, b) => b.trueEdge - a.trueEdge).slice(0, 20);

  // Top Picks: the same quality bar as above, sliced per prop category instead of pooled across all of them —
  // see lib/topPicks.js for the ranking/reasons logic.
  const topPicks = buildTopPicks(propRows);

  // Status-escalation watch (lib/factors/injury.js's computeInjuryEscalations): who was merely Questionable on
  // an earlier refresh this week but has since worsened to Doubtful or Out. Empty in demo mode (buildDemoData
  // only ever produces one single snapshot, not a rolling multi-refresh history) and, honestly, empty most of
  // the time live too — that's correct, not a bug, since it only fires on a real in-week escalation.
  const injuryEscalations = computeInjuryEscalations(injuryHistory);

  const suspectProps = propRows.filter(r => r.suspect);
  const staleValueProps = propRows.filter(r => r.staleValue);
  if (suspectProps.length || staleValueProps.length) {
    log(`Flagged ${suspectProps.length} prop(s) as suspect (excluded from Mispriced Bets, AI notes and parlays) and ` +
      `${staleValueProps.length} as real stale-line value (surfaced, with a badge) — both crossed the ` +
      `${Math.round(SUSPECT_EDGE_THRESHOLD * 100)}% edge threshold; see analyze.js's corroboration check for how they're told apart. ` +
      `Raw fields for review: ${JSON.stringify([...suspectProps, ...staleValueProps].slice(0, 10).map(r => ({
        row: `${r.player} — ${r.propLabel}`, edge: r.bestEdge, price: r.bestPrice, book: r.bestBook, ...r.rawDebug
      })))}`);
  }

  return {
    generatedAt: new Date().toISOString(),
    mode: demo ? "demo" : "live",
    week,
    stats: {
      gamesThisWeek: events.length,
      propsScanned: propRows.length,
      propsWithFactor: propRows.filter(r => r.factors && Object.values(r.factors).some(f => f && (f.available || (Array.isArray(f) && f.length)))).length,
      propValueEdges: propRows.filter(r => (r.bestEdge ?? 0) > 0.02).length,
      // trueEdgeProps: real statistical edge (model prob vs. market prob), independent of propValueEdges above
      // which is just "some book pays more than consensus" — see the trueEdge/bestEdge comment in pipeline.js.
      trueEdgeProps: propRows.filter(r => (r.trueEdge ?? 0) > 0.03 && ["medium", "high"].includes(r.confidence)).length,
      suspectFlags: suspectProps.length,
      staleValueFlags: staleValueProps.length,
      // A player whose weekly-roster file team disagrees with today's depth-chart scrape — usually a recent
      // trade the roster file hasn't caught up to yet. See the rosterConflicts log line above and
      // resolvePlayer() in identity.js for how the depth chart's team wins as the fresher signal.
      rosterConflicts: rosterConflicts.length
    },
    propRows, mispriced, topPicks, injuryEscalations, parlays, sameGameParlays, slateParlays, trackRecord, edgeBoardHistory, anthropicSpend, logs
  };
}
