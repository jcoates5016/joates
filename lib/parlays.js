import { americanToImpliedProb, americanToDecimal, decimalToAmerican } from "./oddsMath.js";
import { getPrice, PARLAY_BOOKS, BOOKS } from "./analyze.js";

const PARLAY_STAKE = 100;

// Fixed, ABSOLUTE probability bands — not pool-relative quartiles — so a leg's tier is a property of the leg
// itself ("this play is a real ~70% shot") rather than of which other legs happened to be on the board that
// week. Reworked to Jon's own odds-based framing (a -200 ceiling for Low, "closer to +money" for High) rather
// than the original round-number probability cutoffs — expressed here as the equivalent real probabilities via
// americanToImpliedProb so the underlying mechanism (a fixed absolute band on modelProb) doesn't change, just
// where the lines are drawn. High's floor is exactly MIN_LEG_PROBABILITY (55%) by construction, same as before
// this rework — see that constant's own comment for why that floor is non-negotiable everywhere, including
// Mega/Nuke below. Rejected an earlier pool-relative-quartile design: on a single game's Same Game Parlay pool,
// that would need many distinct qualifying legs just to fill every tier without overlap, which no single game
// realistically offers.
const impliedFromAmerican = (american) => americanToImpliedProb(american);
// IMPORTANT, easy to misread: the "-200"/"-150" language below describes our MODEL's own real-probability
// estimate for a leg, converted to an odds-equivalent purely so it reads in bettor-familiar terms — it is NOT a
// promise that the book's own displayed price on that leg will be anywhere near -200. A leg can land in Low Risk
// with a book price of -109 if our model independently rates it a 66.7%+ real favorite regardless of what the
// book charges for it; that gap between our estimate and the book's own number is precisely the value this whole
// app exists to find, not a mismatch between the tier description and the leg shown under it. Each tier's `desc`
// is worded to say "our model" explicitly for exactly this reason — see the frontend's per-leg model-vs-book
// display (parlayCardHTML/parlayWriteupHTML in public/index.html) for where that gap is actually shown.
export const RISK_TIERS = [
  { key: "low", label: "Low Risk", minProb: impliedFromAmerican(-200), maxProb: 1.01, legs: 3,
    desc: "3 legs our model rates -200-or-safer real favorites (66.7%+ true probability) — the closest thing this board has to a sure thing. The book's own price per leg often runs closer to even; that gap is the value, not an error." },
  { key: "medium", label: "Medium Risk", minProb: impliedFromAmerican(-150), maxProb: impliedFromAmerican(-200), legs: 4,
    desc: "4 legs our model puts in the -150-to--200 real-probability range — still real favorites by our numbers, just not the board's absolute safest plays. See each leg's own model-vs-book note for how that compares to its actual price." },
  { key: "high", label: "High Risk", minProb: 0.55, maxProb: impliedFromAmerican(-150), legs: 4,
    desc: "4 legs down at the board's real floor (55%+ true probability by our model) — the riskiest legs this app will still call a real play, closest to plus money without ever crossing the 55% line." }
];

// A leg needs at least this much real modelProb to be eligible for ANY tier, Mega and Nuke included — a
// coin-flip (or worse) doesn't belong in a build whose entire premise is "backed by real stats and facts," and
// that stays true no matter how big a payout Mega/Nuke are chasing (confirmed with Jon directly: Mega/Nuke
// reach their bigger numbers by stacking MORE real legs together, never by including an actual longshot leg).
// This is also High's own band floor above, so MIN_LEG_PROBABILITY and RISK_TIERS stay in lockstep by
// construction. A row the model couldn't score at all (rare) falls back to the book's own implied probability,
// gated at the same floor.
export const MIN_LEG_PROBABILITY = 0.55;

// Mega Risk: no longer its own probability band. Jon's own framing ("the +2500 or more bets") is a real
// bettor's way of describing a PARLAY'S combined payout, not a single leg's odds — and a genuine +2500 single
// leg would be roughly a 4% real shot, which the 55% floor above already rules out everywhere. So Mega instead
// draws from the FULL real pool (every leg >=55%, same floor as every other tier) and stacks as many of the
// riskiest still-real legs as it takes to cross a real +2500 combined payout — the size of the parlay does the
// work a single longshot leg used to. MEGA_MIN_LEGS keeps a thin, 1-2-leg "Mega" from technically qualifying
// just because two juicy-but-real legs happened to multiply past the target; MEGA_MAX_LEGS is a sanity ceiling
// so a genuinely thin week doesn't chase the target into an absurd 20-leg slip — it just honestly reports it
// couldn't reach +2500 this week instead.
export const MEGA_TARGET_DECIMAL = 26; // +2500 American, in decimal-odds terms (2500/100 + 1)
export const MEGA_MIN_LEGS = 4;
export const MEGA_MAX_LEGS = 12;
export const MEGA_TIER = {
  key: "mega", label: "Mega Risk",
  desc: `A real combined payout of +2500 or better, built by stacking as many genuine 55%+ legs as it takes to get there — every leg still a graded, real play; the leg count is what does the work, not a longshot.`
};

// Nuke: Jon's own new category — "a combo of the 6+ highest +money bets that are MOST LIKELY TO HIT." The
// resolution that keeps this consistent with the 55% floor: `leg.price` (the BOOK's own posted American odds)
// and `leg.hitProbability` (the MODEL's own real probability estimate) are two independent numbers already
// tracked per leg — a leg can genuinely have plus-money book odds (the market prices it as an underdog) while
// the model still rates it a real 55%+ shot. That combination IS a real, mispriced value play, exactly this
// app's whole premise, just one the book happens to pay out like a longshot. Nuke pulls only from that
// intersection (book price > 0 AND modelProb >= the same 55% floor as everywhere else), sorted safest-first
// among that pool (Jon's own words: "most likely to hit"), never by payout the way Mega is.
export const NUKE_LEGS = 6;
export const NUKE_TIER = {
  key: "nuke", label: "Nuke", legs: NUKE_LEGS,
  desc: `${NUKE_LEGS}+ legs the market itself prices at plus money, picked from the ones our model still rates a real 55%+ shot, safest-first — real value plays that happen to pay out like underdogs.`
};

function legHitProbability(leg) {
  const row = leg.row;
  if (row.model?.available && row.confidence !== "excluded") return row.modelProb;
  return leg.prob;
}

// Player props only — game lines/moneylines were removed from this build entirely (see analyze.js/README).
function buildLegPool(book, propRows) {
  const legs = [];
  propRows.forEach(row => {
    if (row.teamMismatch || row.suspect) return;
    const price = getPrice(row, book);
    if (price == null || row.refProb == null) return;
    const prob = americanToImpliedProb(price);
    const edge = row.refProb - prob;
    const leg = { kind: "prop", book, gameKey: row.eventId, label: `${row.player} — ${row.propLabel} ${row.side || ""} ${row.line ?? ""}`.trim(), price, prob, edge, row };
    leg.hitProbability = legHitProbability(leg);
    legs.push(leg);
  });
  return legs;
}

// Splits one book's full leg pool into the three fixed probability bands (Low/Medium/High — Mega and Nuke are
// no longer probability bands, see their own pool builders below), each sorted safest-first (highest real hit
// probability) since the whole point of these three is "almost guaranteed" -> "still a real favorite" ->
// "riskiest still-real play."
function bandedPools(book, propRows) {
  const pool = buildLegPool(book, propRows).filter(l => l.hitProbability >= MIN_LEG_PROBABILITY);
  const byTier = {};
  for (const tier of RISK_TIERS) {
    const inBand = pool.filter(l => l.hitProbability >= tier.minProb && l.hitProbability < tier.maxProb);
    byTier[tier.key] = inBand.slice().sort((a, b) => b.hitProbability - a.hitProbability);
  }
  return byTier;
}

// Nuke's pool: the market's own plus-money legs (book price > 0) that the model still rates a real 55%+ shot —
// see NUKE_TIER's own comment above for why this is the right, floor-respecting reading of "highest +money
// bets." Sorted safest-first (Jon's own words: "most likely to hit"), reusing fillTierFromBand/priceTierResult
// exactly like Low/Medium/High do, since NUKE_TIER.legs gives it the same fixed-count shape those already have.
function nukePool(book, propRows) {
  return buildLegPool(book, propRows)
    .filter(l => l.hitProbability >= MIN_LEG_PROBABILITY && l.price > 0)
    .sort((a, b) => b.hitProbability - a.hitProbability);
}

// `maxPerGame` caps how many legs from a single game can land in one parlay — meaningful for cross-game and
// slate builds (keeps a board-wide or slate-wide parlay from quietly becoming one team's SGP). Same Game Parlays
// pass Infinity since every leg is deliberately from one game already. `skip` lets the shuffle UI ask for a
// different combination out of the same band (skip the first `skip` legs already used by an earlier attempt)
// without ever reaching into a different tier's band — the disjoint-tiers guarantee holds no matter how many
// times a tier gets reshuffled.
function fillTierFromBand(band, tier, maxPerGame, skip = 0) {
  const legs = [];
  const usedGames = {};
  for (const leg of band.slice(skip)) {
    if (legs.length >= tier.legs) break;
    const gameCount = usedGames[leg.gameKey] || 0;
    if (gameCount >= maxPerGame) continue;
    legs.push(leg);
    usedGames[leg.gameKey] = gameCount + 1;
  }
  return legs;
}

function priceTierResult(tier, book, legs, band, maxPerGame) {
  if (legs.length < tier.legs) {
    // Nuke has no minProb/maxProb (its pool is a plus-money filter, not a probability band — see nukePool),
    // so its shortfall reason describes the actual filter instead of a percentage range.
    const rangeDesc = tier.key === "nuke"
      ? "priced at plus money by the book while still clearing our real 55%+ floor"
      : `in the ${Math.round(tier.minProb * 100)}-${Math.round(tier.maxProb * 100)}% range`;
    const reason = band.length < tier.legs
      ? `Only ${band.length} leg${band.length === 1 ? "" : "s"} on ${BOOKS[book].label} are ${rangeDesc} this week — not enough to build a ${tier.label.toLowerCase()} (${tier.legs}-leg) parlay.`
      : `${band.length} legs qualify on ${BOOKS[book].label}, but at most ${maxPerGame} per game keeps this to ${legs.length} usable leg${legs.length === 1 ? "" : "s"} — not enough to build a ${tier.label.toLowerCase()} (${tier.legs}-leg) parlay this week.`;
    return { tier, book, ok: false, reason };
  }
  const combinedDecimal = legs.reduce((d, l) => d * americanToDecimal(l.price), 1);
  const combinedAmerican = decimalToAmerican(combinedDecimal);
  const combinedProb = legs.reduce((p, l) => p * l.prob, 1);
  const correlated = Object.values(legs.reduce((acc, l) => { acc[l.gameKey] = (acc[l.gameKey] || 0) + 1; return acc; }, {})).some(c => c > 1);
  const payout = +(PARLAY_STAKE * (combinedDecimal - 1)).toFixed(2);
  return { tier, book, ok: true, legs, combinedAmerican, combinedProb, payout, correlated };
}

// Shared by every fixed-band tier (Low/Medium/High and Nuke — all four have a real `tier.legs` count and draw
// from a precomputed, pre-sorted pool): tries every parlay book against that pool, plus a shifted attempt per
// book (skips the pool's first leg) so the shuffle UI has more than one book's worth of real alternates — same
// shape either way, so the frontend can swap the displayed parlay for any of them with no server round-trip.
// `poolFn(book, propRows)` supplies the tier's own pool (bandedPools()[tier.key] for Low/Medium/High, nukePool
// for Nuke) so this one function serves both without needing to know which kind of pool it was handed.
function buildFixedBandTierResult(tier, propRows, maxPerGame, poolFn) {
  const attempts = [];
  PARLAY_BOOKS.forEach(book => {
    const band = poolFn(book, propRows);
    attempts.push(priceTierResult(tier, book, fillTierFromBand(band, tier, maxPerGame, 0), band, maxPerGame));
    attempts.push(priceTierResult(tier, book, fillTierFromBand(band, tier, maxPerGame, 1), band, maxPerGame));
  });
  const valid = attempts.filter(c => c.ok);
  if (!valid.length) return attempts[0];

  // Safest-first for every fixed-band tier, Nuke included (Jon's own "most likely to hit" framing for Nuke is
  // the same ranking Low/Medium/High already use) — only Mega (handled separately below) ranks by payout.
  const rank = (p) => -(p.legs.reduce((s, l) => s + l.hitProbability, 0) / p.legs.length);
  const seen = new Set();
  const distinct = [];
  valid.sort((a, b) => rank(a) - rank(b));
  for (const p of valid) {
    const key = p.legs.map(l => `${l.kind}:${l.label}`).sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(p);
  }
  const [primary, ...alternates] = distinct;
  return { ...primary, alternates };
}

// Mega's leg-picking: greedily stack the biggest real payouts (highest decimal odds among every leg that still
// clears the 55% floor, no probability ceiling) until the combined price crosses MEGA_TARGET_DECIMAL (+2500) or
// MEGA_MAX_LEGS is hit — whichever comes first. `skip` mirrors fillTierFromBand's own shuffle mechanism (skip
// the pool's biggest-payout leg so the shuffle UI has a real alternate build).
function buildMegaLegs(book, propRows, maxPerGame, skip = 0) {
  const pool = buildLegPool(book, propRows)
    .filter(l => l.hitProbability >= MIN_LEG_PROBABILITY)
    .sort((a, b) => americanToDecimal(b.price) - americanToDecimal(a.price));
  const legs = [];
  const usedGames = {};
  let combinedDecimal = 1;
  for (const leg of pool.slice(skip)) {
    if (legs.length >= MEGA_MAX_LEGS) break;
    if (combinedDecimal >= MEGA_TARGET_DECIMAL && legs.length >= MEGA_MIN_LEGS) break;
    const gameCount = usedGames[leg.gameKey] || 0;
    if (gameCount >= maxPerGame) continue;
    legs.push(leg);
    usedGames[leg.gameKey] = gameCount + 1;
    combinedDecimal *= americanToDecimal(leg.price);
  }
  return { legs, combinedDecimal, poolSize: pool.length };
}

function priceMegaResult(book, legs, poolSize, combinedDecimal) {
  const reachedTarget = combinedDecimal >= MEGA_TARGET_DECIMAL && legs.length >= MEGA_MIN_LEGS;
  if (!reachedTarget) {
    const reason = !poolSize
      ? `No legs on ${BOOKS[book].label} clear the real 55%+ floor this week — nothing to build a Mega parlay from.`
      : `Stacking the ${legs.length} best-payout real legs on ${BOOKS[book].label} (every one still 55%+ by our model) only reaches ${fmtAmerican(decimalToAmerican(combinedDecimal))} combined — not enough real value on the board this week to clear the +2500 Mega target.`;
    return { tier: MEGA_TIER, book, ok: false, reason };
  }
  const combinedAmerican = decimalToAmerican(combinedDecimal);
  const combinedProb = legs.reduce((p, l) => p * l.prob, 1);
  const correlated = Object.values(legs.reduce((acc, l) => { acc[l.gameKey] = (acc[l.gameKey] || 0) + 1; return acc; }, {})).some(c => c > 1);
  const payout = +(PARLAY_STAKE * (combinedDecimal - 1)).toFixed(2);
  return { tier: MEGA_TIER, book, ok: true, legs, combinedAmerican, combinedProb, payout, correlated };
}
function fmtAmerican(n) { return n == null ? "n/a" : n > 0 ? `+${n}` : `${n}`; }

function buildMegaTierResult(propRows, maxPerGame) {
  const attempts = [];
  PARLAY_BOOKS.forEach(book => {
    const a0 = buildMegaLegs(book, propRows, maxPerGame, 0);
    attempts.push(priceMegaResult(book, a0.legs, a0.poolSize, a0.combinedDecimal));
    const a1 = buildMegaLegs(book, propRows, maxPerGame, 1);
    attempts.push(priceMegaResult(book, a1.legs, a1.poolSize, a1.combinedDecimal));
  });
  const valid = attempts.filter(c => c.ok);
  if (!valid.length) return attempts[0];
  // Prefer whichever real build needed the FEWEST legs to clear the target (closest to the +2500 floor rather
  // than an artificially bloated slip), ties broken by the bigger payout.
  const seen = new Set();
  const distinct = [];
  valid.sort((a, b) => a.legs.length - b.legs.length || b.payout - a.payout);
  for (const p of valid) {
    const key = p.legs.map(l => `${l.kind}:${l.label}`).sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(p);
  }
  const [primary, ...alternates] = distinct;
  return { ...primary, alternates };
}

// Composes all five tiers in display order: Low, Medium, High (fixed probability bands, no overlap between
// them by construction), Mega (a combined-payout target built from the whole real pool), and Nuke (the
// plus-money-priced subset of that same real pool). Mega and Nuke are deliberately allowed to reuse a leg that
// also appears in Low/Medium/High — they're cross-cutting "best of" categories layered on top of the base
// ladder, not additional slices of it, so a leg qualifying for more than one is expected, not a bug.
function buildTierSet(propRows, { maxPerGame = 2 } = {}) {
  const bandedResults = RISK_TIERS.map(tier =>
    buildFixedBandTierResult(tier, propRows, maxPerGame, (book, rows) => bandedPools(book, rows)[tier.key]));
  const megaResult = buildMegaTierResult(propRows, maxPerGame);
  const nukeResult = buildFixedBandTierResult(NUKE_TIER, propRows, maxPerGame, nukePool);
  return [...bandedResults, megaResult, nukeResult];
}

export function buildAllParlays(propRows) {
  return buildTierSet(propRows, { maxPerGame: 2 });
}

// Classifies a game's kickoff into which Sunday "slate" it belongs to, using the real Eastern-time hour (via
// Intl's timezone conversion) rather than a fixed UTC offset — a hardcoded offset would silently drift by an
// hour after the November daylight-saving change, right in the middle of a season. Only the two Sunday
// multi-game windows get grouped into a shared slate parlay; Thursday, Sunday night, Monday, and early
// international Sunday kickoffs each stand alone and only ever get a Same Game Parlay.
const ET_PARTS = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false, weekday: "short" });
export function classifyKickoffWindow(kickoffISO) {
  if (!kickoffISO) return null;
  const date = new Date(kickoffISO);
  if (isNaN(date.getTime())) return null;
  const parts = ET_PARTS.formatToParts(date);
  const weekday = parts.find(p => p.type === "weekday")?.value;
  let hour = Number(parts.find(p => p.type === "hour")?.value);
  if (hour === 24) hour = 0;
  if (weekday !== "Sun") return null;
  if (hour >= 12 && hour < 15) return "sun_early"; // the ~1:00pm ET window
  if (hour >= 15 && hour < 19) return "sun_late";  // the ~4:05/4:25pm ET window
  return null; // Sunday night, or an early-morning international Sunday kickoff — SGP only
}

// One entry per event this week, with everything a per-game/slate parlay needs to label itself, built purely
// from props now that game lines are gone — each event's matchup string is composed from the props' own team
// abbreviations.
export function summarizeEvents(propRows) {
  const byId = new Map();
  propRows.forEach(row => {
    if (!byId.has(row.eventId)) byId.set(row.eventId, { eventId: row.eventId, matchup: `${row.away || "Away"} @ ${row.home || "Home"}`, kickoff: row.kickoff });
  });
  return [...byId.values()].map(e => ({ ...e, window: classifyKickoffWindow(e.kickoff) }));
}

// One Low/Medium/High/Mega/Nuke tier set PER GAME, built only from that game's own legs — no extra diversity cap or
// contradiction guard is needed here beyond maxPerGame: Infinity, since this app only ever surfaces the
// "over"/"yes" side of every prop market, so there's no opposite-side pairing possible within a single game to
// guard against.
export function buildSameGameParlays(propRows) {
  const events = summarizeEvents(propRows);
  return events.map(evt => {
    const evtProps = propRows.filter(r => r.eventId === evt.eventId);
    const tiers = buildTierSet(evtProps, { maxPerGame: Infinity });
    return { eventId: evt.eventId, matchup: evt.matchup, kickoff: evt.kickoff, tiers };
  });
}

export const SLATE_WINDOWS = [
  { key: "sun_early", label: "Sunday 1:00 PM ET Slate" },
  { key: "sun_late", label: "Sunday 4:00 PM ET Slate" }
];

// One Low/Medium/High/Mega/Nuke tier set per Sunday kickoff window, pooling legs across every game in that window.
// Diversity cap is looser than the cross-game builder's (3 per game here vs. 2) — a slate is already scoped to
// a handful of games instead of the whole board, so a slightly higher per-game allowance still requires at
// least 2 different games to fill a 4-leg tier (never a single team's SGP in disguise) while giving a two-game
// slate window realistic room to actually fill every band.
const SLATE_MAX_PER_GAME = 3;
export function buildSlateParlays(propRows) {
  const events = summarizeEvents(propRows);
  return SLATE_WINDOWS.map(w => {
    const eventIds = new Set(events.filter(e => e.window === w.key).map(e => e.eventId));
    if (!eventIds.size) {
      return { window: w.key, label: w.label, games: 0, tiers: RISK_TIERS.map(tier => ({ tier, book: null, ok: false, reason: `No games kick off in the ${w.label} this week.` })) };
    }
    const slateProps = propRows.filter(r => eventIds.has(r.eventId));
    const tiers = buildTierSet(slateProps, { maxPerGame: SLATE_MAX_PER_GAME });
    return { window: w.key, label: w.label, games: eventIds.size, tiers };
  });
}
