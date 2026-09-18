// AI reasoning layers, server-side only — the Anthropic key lives in a Netlify environment variable.
// Two distinct buckets, and they're never allowed to blur together:
//   1. Analytical notes (annotateGameLinesWithAI / annotatePropsWithAI / annotateParlaysWithAI): cite only the
//      real, computed numbers this pipeline actually produced (EPA matchup edge, opponent-vs-position rank,
//      red-zone share, referee history, starter changes, etc.) — the prompt explicitly forbids inventing
//      anything. Defensive matchup numbers are real, computed inputs here, not something withheld from the AI.
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
  return JSON.parse(match[0]);
}
function hashContent(obj) { return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex"); }

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
async function annotateWithCache(rows, apiKey, batchSize, keyFor, buildContent, applyResult, systemPrompt, cache, log, label, { cacheOnly = false } = {}) {
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
  const batches = [];
  for (let start = 0; start < toSend.length; start += batchSize) batches.push(toSend.slice(start, start + batchSize));

  async function runBatch(batch, batchIndex) {
    const payload = batch.map((b, i) => ({ id: i, ...b.content }));
    try {
      const results = await callClaude(apiKey, systemPrompt, JSON.stringify(payload));
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
// "most likely to hit," a different question from trueEdge/value) get an AI note at all, ranked across game
// lines AND props together since they draw from the same fixed budget. This replaced "every non-suspect card
// on the board gets a note," which was the single biggest driver of Anthropic cost per refresh once the
// original per-card cap was removed — most of a normal week's slate was paying for commentary on picks nobody
// was going to bet on anyway. Mutates the winning rows in place with `_aiSelected = true`, which is what
// annotateGameLinesWithAI/annotatePropsWithAI/annotateScoutingTakes below actually gate on.
export const AI_NOTE_LIMIT = 50;
export function selectAiEligible(gameLines, propRows, limit = AI_NOTE_LIMIT) {
  const selected = [...gameLines, ...propRows]
    .filter(r => !r.suspect && !r.teamMismatch && r.model?.available)
    .sort((a, b) => (b.modelProb ?? 0) - (a.modelProb ?? 0))
    .slice(0, limit);
  selected.forEach(r => { r._aiSelected = true; });
  return selected;
}

// Cost fix: candidates used to be every non-suspect row showing any edge/arb at all — now it's only rows
// pipeline.js already marked `_aiSelected` (the AI_NOTE_LIMIT rows, across game lines AND props together, with
// the highest real modelProb — "most likely to hit"). A card that isn't in that top slice just shows its
// computed factors with no AI note, same as any row the model couldn't score at all.
export async function annotateGameLinesWithAI(rows, apiKey, cache = {}, log = () => {}) {
  const SAFETY_CAP = 150; // guards against _aiSelected ever being mis-set on more rows than intended, not a real cap
  const candidates = rows.filter(r => r._aiSelected && !r.suspect).slice(0, SAFETY_CAP);
  if (!candidates.length) return;
  await annotateWithCache(candidates, apiKey, 20,
    r => r.oddID ?? null,
    r => ({
      matchup: r.matchup, market: r.market, side: r.side, bestBook: BOOKS[r.bestBook]?.label,
      bestPrice: r.bestPrice, arb: !!r.arb, arbMargin: r.arbMargin || null,
      allPrices: Object.fromEntries(Object.keys(BOOKS).map(b => [BOOKS[b].label, getPrice(r, b)]).filter(([, v]) => v != null)),
      keyNumber: r.factors?.keyNumber?.available ? r.factors.keyNumber : null,
      homeTeamOffense: r.factors?.teamContext?.home, awayTeamOffense: r.factors?.teamContext?.away,
      matchupEdge: r.factors?.matchupEdge || null,
      scoringEnvironment: r.factors?.scoringEnvironment?.available ? r.factors.scoringEnvironment : null,
      referee: r.factors?.referee?.available ? r.factors.referee : null,
      restAndTravel: r.factors?.schedule
    }),
    (r, result) => { r.ai = result; },
    `You are a sharp sports betting analyst. This build tracks NFL Total (Over) game lines. Given price comparisons across ` +
    `several sportsbooks, plus real computed context (each team's own offensive and defensive EPA/play and pace, a ` +
    `home-offense-vs-away-defense and away-offense-vs-home-defense matchup edge, a combined scoring-environment number, referee ` +
    `over/under history, rest/travel), return a JSON array, one object per input id: {"id":<int>,"tag":"value"|"pass"|"arb", ` +
    `"note":"<one or two sentence rationale, cite the actual numbers given including the defensive matchup edge when it's meaningful, ` +
    `name the best book, never invent a fact not given>"}. Only output the JSON array.`,
    cache, log, "AI game-line");
}

export async function annotatePropsWithAI(rows, apiKey, cache = {}, log = () => {}) {
  // Cost fix: only pipeline.js's `_aiSelected` rows (top AI_NOTE_LIMIT by real modelProb, shared with game
  // lines) get sent — see the comment above annotateGameLinesWithAI. SAFETY_CAP is just a guard, not the real cap.
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
        practice_trend: f.practiceTrend?.available ? f.practiceTrend : null,
        starter_change: f.starterChange?.available && f.starterChange.changed ? f.starterChange : null,
        rest_and_travel: f.schedule?.available ? f.schedule : null,
        referee_history: f.referee?.available ? f.referee : null,
        line_movement: f.marketMovement?.available ? f.marketMovement : null,
        situational_note: f.situationalNote || null
      };
    },
    (r, result) => { r.ai = result; },
    `You are a sharp NFL player-props analyst, evaluating Over-only offensive props (passing/rushing/receiving yards and touchdowns, ` +
    `receptions). You're given real computed numbers: how this opponent ranks league-wide against this position (defense_vs_position), ` +
    `this player's team's EPA/play against this specific opponent's defense (matchup_epa_edge), red-zone/two-minute usage share, recent ` +
    `form (season/last-3/last-10/vs-opponent hit rates), a combined offense-vs-offense scoring-environment number, rest/travel, referee ` +
    `history, starter changes, line movement, injuries (including opposing_secondary_injuries — count of the OPPONENT's own out/doubtful ` +
    `cornerbacks/safeties, relevant only to passing-game props). Some rows will have little or no real signal available — that's expected, not an ` +
    `error. Return a JSON array, one object per id: {"id":<int>,"tag":"lean-over"|"thin","note":"<two to four sentence plain-English ` +
    `take, citing real numbers including the defensive matchup when it's meaningful, flagging small samples (under 3 games); if almost ` +
    `nothing resolved for this row, say so plainly in one sentence rather than padding — never invent a fact not given>"}. Only output ` +
    `the JSON array.`,
    cache, log, "AI prop");
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
export async function annotateScoutingTakes(rows, apiKey, cache = {}, log = () => {}, { cacheOnly = false } = {}) {
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
    cache, log, "Scouting take", { cacheOnly });
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
export async function annotateParlaysWithAI(parlays, apiKey, cache = {}, log = () => {}) {
  const valid = parlays.filter(p => p.ok);
  if (!valid.length) return;
  await annotateWithCache(valid, apiKey, 20,
    p => p._cacheKey ?? null,
    p => ({
      context: p._contextLabel || null, tier: p.tier.label, book: BOOKS[p.book].label,
      combinedOdds: p.combinedAmerican, combinedImpliedProbability: p.combinedProb,
      legs: p.legs.map(l => ({ label: l.label, price: l.price, hitProbability: l.hitProbability, supportingFactors: l.kind === "prop" ? Object.entries(l.row.factors || {}).filter(([, v]) => v && (v.available || (Array.isArray(v) && v.length))).map(([k]) => k) : (l.row.arb ? ["arbitrage"] : []) }))
    }),
    (p, result) => { p.ai = result; },
    `You are writing a short rationale for pre-built NFL parlays. Each has a "context" (which game, or which kickoff-time slate, it's ` +
    `built from) and legs already selected as the board's most likely plays to hit. Return one object per id: {"id":<int>,"note":"<two ` +
    `to three sentences: name the context and tier's intent, reference 1-2 strongest legs and what backs them, flag any shared-game ` +
    `correlation — never invent a fact>"}. Only output the JSON array.`,
    cache, log, "Parlay");
}
