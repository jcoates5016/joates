// Orchestrates one full refresh: fetch -> analyze -> factor engine (every computed factor) -> AI annotation ->
// parlays -> snapshot. Runs from both the scheduled background function and the manual "Refresh Now" trigger
// (both background functions now, see netlify/functions/ — a lesson learned the hard way earlier: this
// pipeline is too slow for Netlify's ~30s normal function budget).
import { fetchMultiSeasonStats, fetchSchedule, fetchRoster, fetchSnapCounts, fetchPlayByPlay, fetchDepthCharts } from "./fetchers/nflverse.js";
import { fetchNFLEvents } from "./fetchers/odds.js";
import { fetchInjuries } from "./fetchers/injuries.js";
import { fetchForecast } from "./fetchers/weather.js";
import { buildGameLogIndex, buildRosterIndex, buildSnapsIndex, buildDepthChartIndex } from "./identity.js";
import { analyzePlayerProps, BOOK_IDS, SUSPECT_EDGE_THRESHOLD, getPrice } from "./analyze.js";
import { createFactorEngine } from "./factors/index.js";
import { estimatePropProbability } from "./probability.js";
import { gradeCompletedPicks, foldIntoLedger, summarizeLedger } from "./grading.js";
import { findScheduleRow } from "./factors/schedule.js";
import { buildAllParlays, buildSameGameParlays, buildSlateParlays } from "./parlays.js";
import { annotatePropsWithAI, annotateScoutingTakes, annotateParlaysWithAI, pruneAiCache, selectAiEligible, AI_NOTE_LIMIT } from "./ai.js";
import { buildDemoData } from "./demoData.js";
import { STADIUMS } from "./stadiums.js";
import { normTeam } from "./teamCodes.js";
import {
  appendInjurySnapshot, loadInjuryHistory, appendPriceSnapshots, loadPriceHistory, loadAiCache, saveAiCache,
  loadWeeklyPicks, saveWeeklyPicks, loadCalibrationLedger, saveCalibrationLedger
} from "./store.js";

function indexSchedule(rows) {
  return rows.map(r => ({
    season: r.season, week: r.week, home: r.home_team || r.home, away: r.away_team || r.away,
    home_team: r.home_team, away_team: r.away_team, date: r.gameday || r.game_date || r.date, roof: r.roof,
    location: r.location, stadium: r.stadium,
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
  if (demo) {
    ({ events, statRows, schedRows, rosterRows, snapRows, pbpRows, depthChartRows, injuriesByTeam: demoInjuriesByTeam } = buildDemoData(currentSeason, historySeasons));
    log("Built demo dataset.");
  } else {
    if (!sgoApiKey) throw new Error("Missing SPORTSGAMEODDS_API_KEY environment variable.");
    [events, statRows, schedRows, rosterRows, snapRows, pbpRows, depthChartRows] = await Promise.all([
      fetchNFLEvents(sgoApiKey, BOOK_IDS, log),
      fetchMultiSeasonStats(historySeasons, log),
      fetchSchedule(log),
      fetchRoster(currentSeason, log),
      fetchSnapCounts(currentSeason, log),
      fetchPlayByPlay(currentSeason, log),
      fetchDepthCharts(currentSeason, log)
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

  const factorEngine = createFactorEngine({
    currentSeason, gameLogIndex, rosterIndex, depthChartIndex, snapsByKey, schedule, pbpRows,
    injuriesByTeam, injuryHistory, priceHistory, situationalNotes, weatherByGame
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

  if ((aiOn || scoutOn) && anthropicApiKey && !demo) {
    let aiCache = { props: {}, scouting: {}, parlays: {} };
    try { aiCache = await loadAiCache(currentSeason, week); } catch (e) { log(`AI cache load failed (non-fatal, notes will regenerate): ${e.message}`); }
    aiCache.props ||= {}; aiCache.scouting ||= {}; aiCache.parlays ||= {};

    if (aiOn) {
      await Promise.all([
        annotatePropsWithAI(propRows, anthropicApiKey, aiCache.props, log),
        annotateParlaysWithAI(allParlayAttempts, anthropicApiKey, aiCache.parlays, log)
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
      await annotateScoutingTakes(propRows, anthropicApiKey, aiCache.scouting, log, { cacheOnly: !scoutingDue });
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
        annotatePropsWithAI(propRows, anthropicApiKey, {}, log),
        annotateParlaysWithAI(allParlayAttempts, anthropicApiKey, {}, log)
      ]);
    }
    if (scoutOn) await annotateScoutingTakes(propRows, anthropicApiKey, {}, log);
  }

  // Ranked by trueEdge (model probability minus the market's own implied probability) now, not the old flat
  // point score — and gated on confidence so a 2-game fluke with a big raw edge number can't outrank a real,
  // well-supported trend. MIN_TRUE_EDGE is a real threshold in probability terms: below ~3 points of edge, the
  // model isn't saying anything the market doesn't already know.
  const MIN_TRUE_EDGE = 0.03;
  const mispriced = propRows.filter(r => r.model?.available && r.trueEdge > MIN_TRUE_EDGE &&
    ["medium", "high"].includes(r.confidence) && !r.teamMismatch && !r.suspect)
    .sort((a, b) => b.trueEdge - a.trueEdge).slice(0, 20);

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
    propRows, mispriced, parlays, sameGameParlays, slateParlays, trackRecord, logs
  };
}
