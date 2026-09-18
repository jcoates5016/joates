// AI reasoning layers, server-side only — the Anthropic key lives in a Netlify environment variable.
// Two distinct buckets, and they're never allowed to blur together:
//   1. Analytical notes (annotatePropsWithAI / annotateParlaysWithAI): cite only the real, computed numbers
//      this pipeline actually produced (EPA matchup edge, opponent-vs-position rank, red-zone share, starter
//      changes, etc.) — the prompt explicitly forbids inventing anything. Defensive matchup numbers are real,
//      computed inputs here, not something withheld from the AI.
//   2. Scouting takes (annotateScoutingTakes): the one place genuinely speculative color lives — coverage
//      scheme tendencies, personnel-package guesses, revenge-game/contract-year narrative. Nflverse's own
//      participation dataset (which would make personnel/blitz-package data real) was confirmed dead for
//      in-season use before this was built, so these stay explicitly hedged, never presented as computed.
import crypto from "node:crypto";
import { getPrice, BOOKS } from "./analyze.js";

// Switched from Sonnet to Haiku for cost: every one of these calls is a mechanical "cite the real numbers
// you're given in a sentence or two" task, never deep reasoning, and Haiku is priced far below Sonnet for the
// same tokens. This was the single biggest lever in a real cost review — see the AI_NOTE_LIMIT/CONCURRENCY/
// roundForHash comments below for the other three (fewer rows get notes at all, fewer refreshes regenerate
// them, and the cache holds up better across trivial data noise).
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

async function callClaude(apiKey, systemPrompt, userPrompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 4500, system: systemPrompt, messages: [{ role: "user", content: userPrompt }] })
  });
  if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error(`Anthropic ${res.status}: ${t.slice(0, 200)}`); }
  const json = await res.json();
  const text = json.content?.map(c => c.text).join("") || "";
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("Could not find JSON array in Claude's response");
  // `usage` is what makes the spend cap below possible — Anthropic's own accounting of exactly how many input/
  // output tokens this specific call actually cost, straight from the response, not a guess based on payload size.
  return { data: JSON.parse(match[0]), usage: json.usage || null };
}
function hashContent(obj) { return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex"); }

// Per-million-token API pricing — checked against docs.claude.com/en/docs/about-claude/pricing on 2026-09-18.
// Matched by substring rather than an exact dated model string so this doesn't silently go stale the next time
// ANTHROPIC_MODEL is bumped to a newer snapshot of the same model family. An unrecognized model falls back to a
// deliberately pessimistic (higher) Sonnet-tier estimate — better to have the spend cap trigger a little early
// on an unrecognized model than to silently undercount real spend and blow past it.
const MODEL_PRICING = [
  { match: "haiku", input: 1, output: 5 },
  { match: "opus", input: 5, output: 25 },
  { match: "sonnet", input: 2, output: 10 }
];
const UNKNOWN_MODEL_PRICING = { input: 3, output: 15 };
export function estimateCostUsd(model, usage) {
  if (!usage) return 0;
  const m = (model || "").toLowerCase();
  const pricing = MODEL_PRICING.find(p => m.includes(p.match)) || UNKNOWN_MODEL_PRICING;
  const inTok = usage.input_tokens || 0, outTok = usage.output_tokens || 0;
  return (inTok / 1e6) * pricing.input + (outTok / 1e6) * pricing.output;
}

// Daily Anthropic spend governor — see README's "Anthropic cost controls" section for the full reasoning.
// `ledgerFromStore` is whatever lib/store.js's loadSpendLedger() returned; this rolls it onto today (UTC
// calendar day) if it's stale, archiving the finished day into a short rolling `history` for the frontend to
// show a real trend rather than just today's number. Every annotate* call below shares ONE guard instance per
// refresh (pipeline.js creates it once and threads it through), so spend accumulated by, say, prop notes is
// immediately visible to the parlay-note call running concurrently right after it.
//
// Important limit, stated plainly rather than glossed over: this can only refuse to START a new batch of calls
// once it already knows it's over budget — it can't know a batch's real cost until Anthropic's response comes
// back with the token counts. With up to CONCURRENCY batches in flight at once, actual spend can overshoot the
// cap by at most one wave of concurrent batches before the guard catches up and stops the next one. That's a
// bounded, small overshoot (typically well under a dollar at Haiku pricing), not an unlimited one — a hard,
// zero-overshoot cap isn't possible without knowing the future, but this stops real runaway spend, which is
// what a $30+/day surprise bill actually looks like.
export function createSpendGuard(ledgerFromStore, capUsd) {
  const today = new Date().toISOString().slice(0, 10);
  let ledger = ledgerFromStore;
  if (ledger.date !== today) {
    const history = ledger.date
      ? [...(ledger.history || []), { date: ledger.date, spentUsd: +ledger.spentUsd.toFixed(4), callCount: ledger.callCount }].slice(-30)
      : (ledger.history || []);
    ledger = { date: today, spentUsd: 0, callCount: 0, history };
  }
  return {
    get exhausted() { return ledger.spentUsd >= capUsd; },
    record(costUsd) { ledger.spentUsd += costUsd; ledger.callCount += 1; },
    snapshot() { return { date: ledger.date, spentUsd: +ledger.spentUsd.toFixed(4), capUsd, callCount: ledger.callCount, history: ledger.history }; },
    _ledger: ledger // what pipeline.js persists back via saveSpendLedger — the live object, already mutated by record()
  };
}

// Exported so scripts/dry-run.js can unit-test the rounding directly, the same way selectAiEligible above is.
// Cost fix: the cache key used to hash the FULL-precision content object, so a wind forecast ticking from 11mph
// to 12mph, or a price moving a single cent, invalidated the cache and forced a brand-new (paid) note for a
// change nobody would notice in the resulting sentence. This walks the same content object and rounds every
// number to a coarser grain before it's hashed — rates/probabilities/edges (values roughly in [-1.5, 1.5]) to
// the nearest 0.02, mid-size numbers to the nearest 0.5, everything else (prices, yards, wind speed, totals) to
// the nearest 5 — so trivial noise stops forcing a re-generation while a real, meaningful shift still does. Only
// used for the hash; the actual payload sent to Claude (see annotateWithCache below) still uses full precision.
export function roundForHash(value) {
  if (typeof value === "number") {
    if (!isFinite(value)) return value;
    if (Math.abs(value) <= 1.5) return Math.round(value * 50) / 50;
    // Mid-range values (point spreads, wind speed, small totals) — rounding to the nearest 2 absorbs a
    // forecast/odds source reporting the same real number a notch differently (11mph vs 12mph wind, a
    // half-point spread wobble) without erasing an actual change in conditions.
    if (Math.abs(value) <= 20) return Math.round(value / 2) * 2;
    return Math.round(value / 5) * 5;
  }
  if (Array.isArray(value)) return value.map(roundForHash);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) out[k] = roundForHash(value[k]);
    return out;
  }
  return value;
}

// Every one of these annotation passes used to hard-cap at a small slice (25, 35 rows) purely to keep a single
// Anthropic call's payload small — with a normal week's slate that meant most cards on the board never got an
// AI note at all, which read as "AI analysis is decent for some picks but doesn't show on all." Removing that
// cap (see the SAFETY_CAPs below, which only guard against a data anomaly) fixed coverage, but multiplied the
// Anthropic spend per refresh — most of a board's factors don't actually change between one 30-minute refresh
// and the next, so most of those calls were paying to regenerate a note that would say the same thing.
//
// `cache` (one of aiCache.props/lines/scouting from store.js, loaded once per refresh in pipeline.js) is what
// fixes that: it's a plain `{ [oddID]: { hash, result, updatedAt } }` map, one hash per row content actually
// sent to Claude last time. A row whose computed content hashes the same as last refresh reuses the stored
// result and never goes over the wire again; only genuinely new or changed rows get batched up and sent.
// `keyFor(row)` returns the row's stable cache key (its oddID) or null to opt a row out of caching entirely.
async function annotateWithCache(rows, apiKey, batchSize, keyFor, buildContent, applyResult, systemPrompt, cache, log, label, { cacheOnly = false, spendGuard = null } = {}) {
  const toSend = [];
  let reused = 0;
  for (const row of rows) {
    const cacheKey = keyFor(row);
    const content = buildContent(row);
    const hash = hashContent(roundForHash(content));
    const cached = cacheKey != null ? cache[cacheKey] : null;
    if (cached && cached.hash === hash && cached.result) {
      applyResult(row, cached.result);
      reused++;
    } else {
      toSend.push({ row, content, hash, cacheKey });
    }
  }
  if (reused) log(`${label}: reused ${reused} unchanged note(s) from cache, sending ${toSend.length} for a fresh one.`);
  // Throttling (currently only scouting takes — see annotateScoutingTakes): this refresh isn't due for a full
  // regeneration, so anything not already sitting in cache just stays unset rather than costing an Anthropic
  // call. Rows that DID hit cache above were already applied, so nothing about their note is lost by throttling.
  if (cacheOnly) {
    if (toSend.length) log(`${label}: throttled — skipping ${toSend.length} row(s) that would need a fresh call until the next scheduled full run.`);
    return;
  }
  // Daily spend cap: if today's Anthropic spend already cleared the cap before this pass even started, skip
  // every row that would need a fresh call — exactly like the cacheOnly throttle above, just triggered by
  // dollars instead of a clock. Rows already served from cache above are unaffected either way.
  if (spendGuard?.exhausted) {
    if (toSend.length) log(`${label}: skipped ${toSend.length} row(s) — today's Anthropic spend cap is already reached. They'll get a note once the cap resets or is raised.`);
    return;
  }
  const batches = [];
  for (let start = 0; start < toSend.length; start += batchSize) batches.push(toSend.slice(start, start + batchSize));

  async function runBatch(batch, batchIndex) {
    const payload = batch.map((b, i) => ({ id: i, ...b.content }));
    try {
      const { data: results, usage } = await callClaude(apiKey, systemPrompt, JSON.stringify(payload));
      if (spendGuard) spendGuard.record(estimateCostUsd(ANTHROPIC_MODEL, usage));
      results.forEach(r => {
        const b = batch[r.id];
        if (!b) return;
        applyResult(b.row, r);
        if (b.cacheKey != null) cache[b.cacheKey] = { hash: b.hash, result: r, updatedAt: new Date().toISOString() };
      });
    } catch (e) {
      log(`${label} annotation failed for batch ${batchIndex + 1} (${batch.length} rows): ${e.message}`);
    }
  }

  // Real incident: right after the probability-model rebuild, EVERY row's content hash changed at once (the
  // cache key is a hash of what actually gets sent to Claude, and that shape changed), so a completely cold
  // cache sent every batch, across every annotation pass, one at a time — a live refresh took 13+ minutes and
  // was still going, most of it just waiting on sequential Anthropic round-trips. Any factor change that shifts
  // enough rows' content will cause the same full-cache-miss again, so this can't be a one-time patch-and-forget
  // — batches now run CONCURRENCY at a time instead of strictly one after another. Capped (not fully parallel)
  // to stay well under Anthropic's own per-minute rate limit rather than trading a slow refresh for a 429 storm.
  const CONCURRENCY = 4;
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    // Re-checked before every wave, not just once at the top — a big toSend list spans several waves, and spend
    // from an earlier wave (or a concurrently-running annotate* call sharing this same guard) can cross the cap
    // partway through. Once it does, every remaining wave is skipped rather than sent.
    if (spendGuard?.exhausted) {
      const remaining = batches.length - i;
      log(`${label}: stopping after wave ${i / CONCURRENCY} — today's Anthropic spend cap was reached mid-run. ${remaining} batch(es) left unsent.`);
      break;
    }
    const group = batches.slice(i, i + CONCURRENCY);
    await Promise.all(group.map((b, j) => runBatch(b, i + j)));
  }
}
// Drops any cache entry for an oddID that isn't in this refresh's rows anymore (a finished game, a line that
// stopped being offered) so the cache doesn't grow across an entire season. Call once per note "kind" after
// annotation, right before saving.
export function pruneAiCache(cache, rows, keyFor) {
  const validKeys = new Set(rows.map(keyFor).filter(k => k != null));
  Object.keys(cache).forEach(k => { if (!validKeys.has(k)) delete cache[k]; });
}

// Anthropic spend control: only the AI_NOTE_LIMIT rows most likely to actually hit (highest real modelProb —
// "most likely to hit," a different question from trueEdge/value) get an AI note at all. This replaced "every
// non-suspect card on the board gets a note," which was the single biggest driver of Anthropic cost per refresh
// once the original per-card cap was removed — most of a normal week's slate was paying for commentary on picks
// nobody was going to bet on anyway. Mutates the winning rows in place with `_aiSelected = true`, which is what
// annotatePropsWithAI/annotateScoutingTakes below actually gate on.
export const AI_NOTE_LIMIT = 50;
export function selectAiEligible(propRows, limit = AI_NOTE_LIMIT) {
  const selected = propRows
    .filter(r => !r.suspect && !r.teamMismatch && r.model?.available)
    .sort((a, b) => (b.modelProb ?? 0) - (a.modelProb ?? 0))
    .slice(0, limit);
  selected.forEach(r => { r._aiSelected = true; });
  return selected;
}

export async function annotatePropsWithAI(rows, apiKey, cache = {}, log = () => {}, spendGuard = null) {
  // Cost fix: only pipeline.js's `_aiSelected` rows (top AI_NOTE_LIMIT props by real modelProb) get sent.
  // SAFETY_CAP is just a guard, not the real cap.
  const SAFETY_CAP = 400;
  const candidates = rows.filter(r => r._aiSelected && !r.teamMismatch && !r.suspect).slice(0, SAFETY_CAP);
  if (!candidates.length) return;
  await annotateWithCache(candidates, apiKey, 30,
    r => r.oddID ?? null,
    r => {
      const f = r.factors || {};
      return {
        player: r.player, team: r.team, opponent: r.opponentDisp || r.opponent, prop: r.propLabel, side: r.side, line: r.line,
        bestBook: BOOKS[r.bestBook]?.label, bestPrice: r.bestPrice,
        defense_vs_position: f.defense?.available ? f.defense : null,
        matchup_epa_edge: f.matchupEdge?.available ? f.matchupEdge : null,
        scoring_environment: f.scoringEnvironment?.available ? f.scoringEnvironment : null,
        recent_form: f.form?.available ? { season_hit_rate: f.form.rate_season, last3_hit_rate: f.form.rate_last3, last10_hit_rate: f.form.rate_last10, vs_opp_hit_rate: f.form.rate_vsOpp, vs_opp_games: f.form.n_vsOpp } : null,
        usage_without_teammate: f.tendency?.available ? f.tendency : null,
        red_zone_share: f.redZone?.available ? f.redZone : null,
        two_minute_share: f.twoMinute?.available ? f.twoMinute : null,
        venue: f.venue?.available ? f.venue : null,
        weather_forecast: f.weatherForecast || null,
        weather_historical_split: f.weatherHistorical?.available ? f.weatherHistorical : null,
        birthday: f.birthday?.available ? f.birthday : null,
        usage: f.usage?.available ? f.usage : null,
        injury_flags: null, self_injury_status: f.selfInjury ? `${f.selfInjury.status}${f.selfInjury.detail ? ": " + f.selfInjury.detail : ""}` : null,
        o_line_injuries: f.oLineInjury?.available ? f.oLineInjury : null,
        opposing_secondary_injuries: f.secondaryInjury?.available ? f.secondaryInjury : null,
        opposing_front_seven_injuries: f.frontSevenInjury?.available ? f.frontSevenInjury : null,
        game_script: f.gameScript?.available ? { team_spread: f.gameScript.teamSpread, team_implied_total: f.gameScript.teamImpliedTotal, big_favorite: f.gameScript.isBigFavorite, big_underdog: f.gameScript.isBigUnderdog } : null,
        practice_trend: f.practiceTrend?.available ? f.practiceTrend : null,
        starter_change: f.starterChange?.available && f.starterChange.changed ? f.starterChange : null,
        rest_and_travel: f.schedule?.available ? f.schedule : null,
        line_movement: f.marketMovement?.available ? f.marketMovement : null,
        situational_note: f.situationalNote || null
      };
    },
    (r, result) => { r.ai = result; },
    `You are a sharp NFL player-props analyst, evaluating Over-only offensive props (passing/rushing/receiving yards and touchdowns, ` +
    `receptions). You're given real computed numbers: how this opponent ranks league-wide against this position (defense_vs_position), ` +
    `this player's team's EPA/play against this specific opponent's defense (matchup_epa_edge), red-zone/two-minute usage share, recent ` +
    `form (season/last-3/last-10/vs-opponent hit rates), a combined offense-vs-offense scoring-environment number, rest/travel, weather ` +
    `forecast/history, venue splits, practice-participation trend, starter changes, line movement, injuries (including opposing_secondary_injuries — count of the OPPONENT's own out/doubtful ` +
    `cornerbacks/safeties, relevant only to passing-game props, and opposing_front_seven_injuries — the same idea for the OPPONENT's out/doubtful ` +
    `defensive line/linebackers, relevant only to rushing props), and game_script (the market's own implied spread/total, read as context: ` +
    `big_favorite means their team is expected to win comfortably and lean run-heavy late; big_underdog means the opposite, leaning pass-heavy ` +
    `chasing the game — never treat this as a bet on the spread/total themselves, this app doesn't offer those). Some rows will have little or no real signal available — that's expected, not an ` +
    `error. Return a JSON array, one object per id: {"id":<int>,"tag":"lean-over"|"thin","note":"<two to four sentence plain-English ` +
    `take, citing real numbers including the defensive matchup when it's meaningful, flagging small samples (under 3 games); if almost ` +
    `nothing resolved for this row, say so plainly in one sentence rather than padding — never invent a fact not given>"}. Only output ` +
    `the JSON array.`,
    cache, log, "AI prop", { spendGuard });
}

// The explicitly-speculative bucket. Nothing here is computed — it's Claude's general football knowledge
// applied to a matchup, clearly hedged, never presented as a real number. Nflverse's own participation dataset
// (which would make real personnel/blitz-package counts possible) was confirmed discontinued for in-season
// release before this was built, so coverage-scheme and personnel-package content stays here, speculative and
// clearly labeled, rather than being computed or omitted outright.
// Cost fix, two parts: (1) scoped to `_aiSelected` rows only, same as the two annotate* functions above — no
// point speculating about a player's coverage matchup on a card that isn't even getting a real analytical note.
// (2) throttled by pipeline.js via `cacheOnly` — it passes true whenever this hasn't been due for a full
// regeneration yet (see SCOUTING_THROTTLE_HOURS in pipeline.js), so a call that would need a fresh Anthropic
// request just waits instead of spending on a take that barely changes week to week anyway.
export async function annotateScoutingTakes(rows, apiKey, cache = {}, log = () => {}, { cacheOnly = false, spendGuard = null } = {}) {
  const SAFETY_CAP = 300;
  const candidates = rows.filter(r => r._aiSelected && !r.teamMismatch && !r.suspect && ["rec_yds", "td", "td_rush", "td_rec", "rush_yds"].includes(r.propType)).slice(0, SAFETY_CAP);
  if (!candidates.length) return;
  // This one's payload (player/team/opponent/prop) barely ever changes week to week the way a props note's
  // computed factors do, so caching here saves the most calls per dollar — a repeat matchup for the same prop
  // essentially always hits.
  await annotateWithCache(candidates, apiKey, 30,
    r => r.oddID ?? null,
    r => ({ player: r.player, team: r.team, opponent: r.opponentDisp || r.opponent, prop: r.propLabel }),
    (r, result) => { r.scouting = result; },
    `You are giving a "scouting take" using your general football knowledge — NOT stats computed by the tool. Speculate on things no ` +
    `free stats feed covers this season: the opponent's likely coverage scheme or personnel-package tendencies against this position, ` +
    `revenge-game or contract-year storylines for this player, and anything else a sharp scout would flag from general football ` +
    `knowledge. Say plainly when nothing genuinely applies rather than inventing a stretch. Return a JSON array: {"id":<int>, ` +
    `"note":"<one or two sentences, hedge appropriately, never state as verified fact>"}. Only output the JSON array.`,
    cache, log, "Scouting take", { cacheOnly, spendGuard });
}

// Same caching engine as the three annotators above — this used to be one uncached call covering every parlay,
// full stop, which was fine back when there were only 4 (the cross-game Risk Tiers). Once Same Game Parlays (one
// tier set per game) and the two slate parlays joined the board, that one-shot call could both balloon well past
// a single response's token budget and re-pay for dozens of parlays' rationale every refresh even when nothing
// about them changed. `annotateWithCache` fixes both: it batches (so the payload/response size per Anthropic
// call stays bounded) and reuses a cached note whenever a parlay's legs/odds haven't changed. Every parlay
// object passed in needs a stable `_cacheKey` (independent of which book happens to win best price week to
// week) and a `_contextLabel` (which game or slate it's from, since multiple parlays share the same tier label)
// — pipeline.js attaches both before calling this.
export async function annotateParlaysWithAI(parlays, apiKey, cache = {}, log = () => {}, spendGuard = null) {
  const valid = parlays.filter(p => p.ok);
  if (!valid.length) return;
  await annotateWithCache(valid, apiKey, 20,
    p => p._cacheKey ?? null,
    p => ({
      context: p._contextLabel || null, tier: p.tier.label, book: BOOKS[p.book].label,
      combinedOdds: p.combinedAmerican, combinedImpliedProbability: p.combinedProb,
      legs: p.legs.map(l => ({ label: l.label, price: l.price, hitProbability: l.hitProbability, supportingFactors: Object.entries(l.row.factors || {}).filter(([, v]) => v && (v.available || (Array.isArray(v) && v.length))).map(([k]) => k) }))
    }),
    (p, result) => { p.ai = result; },
    `You are writing a short rationale for pre-built NFL parlays. Each has a "context" (which game, or which kickoff-time slate, it's ` +
    `built from) and legs already selected as the board's most likely plays to hit. Return one object per id: {"id":<int>,"note":"<two ` +
    `to three sentences: name the context and tier's intent, reference 1-2 strongest legs and what backs them, flag any shared-game ` +
    `correlation — never invent a fact>"}. Only output the JSON array.`,
    cache, log, "Parlay", { spendGuard });
}
