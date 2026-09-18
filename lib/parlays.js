import { americanToImpliedProb, americanToDecimal, decimalToAmerican } from "./oddsMath.js";
import { getPrice, PARLAY_BOOKS, BOOKS } from "./analyze.js";

const PARLAY_STAKE = 100;

// Every tier targets a FIXED leg count and picks purely by the model's real hit probability ("highest odds of
// hitting" — modelProb, not trueEdge/value). This applies uniformly to cross-game parlays, Same Game Parlays,
// and the two Sunday slate parlays below — the only thing that changes between tiers is how many legs get
// stacked together. More legs still means a bigger payout and a lower combined probability (that's just how
// parlay math works), so Low->Mega remains a real risk gradient even though every leg in every tier is still
// whichever pick the board rates most likely to hit at that leg count. This replaced an earlier edge/conviction-
// driven system (Low = favorites with backing, Mega = real longshots allowed) at Jon's explicit request — Mega
// no longer means "longshot payout hunt," it means "6 of the board's best favorites stacked together."
export const RISK_TIERS = [
  { key: "low", label: "Low Risk", legs: 3, desc: "3 legs — the board's most likely plays, stacked together." },
  { key: "medium", label: "Medium Risk", legs: 4, desc: "4 legs, still every one a top pick by real probability." },
  { key: "high", label: "High Risk", legs: 5, desc: "5 legs for a bigger payout, same probability-first picks." },
  { key: "mega", label: "Mega Risk", legs: 6, desc: "6 legs — the biggest payout this tier structure supports." }
];

// A leg needs at least this much real modelProb to be eligible for ANY of these tiers — a coin-flip (or worse)
// doesn't belong in a build whose entire premise is "the safest plays on the board." A row the model couldn't
// score at all (rare) falls back to the book's own implied probability, gated at the same floor.
const MIN_LEG_PROBABILITY = 0.55;

function legHitProbability(leg) {
  const row = leg.row;
  if (row.model?.available && row.confidence !== "excluded") return row.modelProb;
  return leg.prob;
}

function buildLegPool(book, gameLines, propRows) {
  const legs = [];
  gameLines.forEach(row => {
    if (row.suspect) return;
    const price = getPrice(row, book);
    if (price == null || row.refProb == null) return;
    const prob = americanToImpliedProb(price);
    const edge = row.refProb - prob;
    const leg = { kind: "line", book, gameKey: row.eventId, label: `${row.matchup} — ${row.market} ${row.side}`, price, prob, edge, row };
    leg.hitProbability = legHitProbability(leg);
    legs.push(leg);
  });
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

// `skipTopN` deliberately excludes the highest-probability legs from the pool before the greedy fill — the only
// way to get a genuinely different combination out of the same deterministic sort, so "shuffle" on the frontend
// has more than one book's worth of real alternates to offer even when just one book has enough qualifying legs.
// `maxPerGame` caps how many legs from a single game can land in one parlay — meaningful for cross-game and
// slate builds (keeps a board-wide or slate-wide parlay from quietly becoming one team's SGP). Same Game Parlays
// pass Infinity here since every leg is deliberately from one game already; no extra contradiction guard is
// needed on top of that because this app only ever surfaces the "over"/"yes" side of every market (props exclude
// under/no, game lines are Totals-only — see analyze.js), so there's no opposite-side pairing possible within a
// single game to guard against.
function buildParlayForBookAndTier(book, tier, gameLines, propRows, { skipTopN = 0, maxPerGame = 2 } = {}) {
  const eligiblePool = buildLegPool(book, gameLines, propRows).filter(l => l.hitProbability >= MIN_LEG_PROBABILITY);
  const pool = eligiblePool.slice().sort((a, b) => b.hitProbability - a.hitProbability).slice(skipTopN);

  const legs = [];
  const usedGames = {};
  for (const leg of pool) {
    if (legs.length >= tier.legs) break;
    const gameCount = usedGames[leg.gameKey] || 0;
    if (gameCount >= maxPerGame) continue;
    legs.push(leg);
    usedGames[leg.gameKey] = gameCount + 1;
  }
  if (legs.length < tier.legs) {
    // Two different reasons look identical from the outside ("not enough legs") but mean different things: not
    // enough legs cleared the probability floor at all, vs. plenty cleared it but they're too bunched into too
    // few games for maxPerGame to let them all in (e.g. a Same Game Parlay never hits this branch since it
    // passes maxPerGame: Infinity — this is a cross-game/slate-only distinction).
    const reason = eligiblePool.length < tier.legs
      ? `Only ${eligiblePool.length} leg${eligiblePool.length === 1 ? "" : "s"} on ${BOOKS[book].label} clear the ${Math.round(MIN_LEG_PROBABILITY * 100)}% probability floor this week — not enough to build a ${tier.label.toLowerCase()} (${tier.legs}-leg) parlay.`
      : `${eligiblePool.length} legs clear the floor on ${BOOKS[book].label}, but at most ${maxPerGame} per game keeps this to ${legs.length} usable leg${legs.length === 1 ? "" : "s"} — not enough to build a ${tier.label.toLowerCase()} (${tier.legs}-leg) parlay this week.`;
    return { tier, book, ok: false, reason };
  }

  const combinedDecimal = legs.reduce((d, l) => d * americanToDecimal(l.price), 1);
  const combinedAmerican = decimalToAmerican(combinedDecimal);
  const combinedProb = legs.reduce((p, l) => p * l.prob, 1);
  const correlated = Object.values(legs.reduce((acc, l) => { acc[l.gameKey] = (acc[l.gameKey] || 0) + 1; return acc; }, {})).some(c => c > 1);
  const payout = +(PARLAY_STAKE * (combinedDecimal - 1)).toFixed(2);
  return { tier, book, ok: true, legs, combinedAmerican, combinedProb, payout, correlated };
}

function avgHitProbability(p) { return p.legs.reduce((s, l) => s + l.hitProbability, 0) / p.legs.length; }
function legsKey(p) { return p.legs.map(l => `${l.kind}:${l.label}`).sort().join("|"); }

// Shared by every parlay grouping below (cross-game, one per Same Game Parlay, one per slate window): tries
// every parlay book, plus a deliberately different combination per book that skips the single highest-
// probability leg, keeps every distinct valid combination found, and exposes the rest as `alternates` on the
// primary pick — same shape either way, so the frontend can swap the displayed parlay for any of them with no
// server round-trip.
function buildTierSet(tiers, gameLines, propRows, opts = {}) {
  return tiers.map(tier => {
    const attempts = [];
    PARLAY_BOOKS.forEach(book => {
      attempts.push(buildParlayForBookAndTier(book, tier, gameLines, propRows, opts));
      attempts.push(buildParlayForBookAndTier(book, tier, gameLines, propRows, { ...opts, skipTopN: 1 }));
    });
    const valid = attempts.filter(c => c.ok);
    if (!valid.length) return attempts[0];

    const seen = new Set();
    const distinct = [];
    valid.sort((a, b) => avgHitProbability(b) - avgHitProbability(a));
    for (const p of valid) {
      const key = legsKey(p);
      if (seen.has(key)) continue;
      seen.add(key);
      distinct.push(p);
    }
    const [primary, ...alternates] = distinct;
    return { ...primary, alternates };
  });
}

export function buildAllParlays(gameLines, propRows) {
  return buildTierSet(RISK_TIERS, gameLines, propRows, { maxPerGame: 2 });
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

// One entry per event this week, with everything a per-game/slate parlay needs to label itself. Game lines
// already carry a real `matchup` string; props only carry normalized team abbreviations, so an event with props
// but no posted Total falls back to composing one from those.
export function summarizeEvents(gameLines, propRows) {
  const byId = new Map();
  gameLines.forEach(row => {
    if (!byId.has(row.eventId)) byId.set(row.eventId, { eventId: row.eventId, matchup: row.matchup, kickoff: row.kickoff });
  });
  propRows.forEach(row => {
    if (!byId.has(row.eventId)) byId.set(row.eventId, { eventId: row.eventId, matchup: `${row.away || "Away"} @ ${row.home || "Home"}`, kickoff: row.kickoff });
  });
  return [...byId.values()].map(e => ({ ...e, window: classifyKickoffWindow(e.kickoff) }));
}

// One Low/Medium/High/Mega tier set PER GAME, built only from that game's own legs — see the maxPerGame comment
// on buildParlayForBookAndTier for why no extra diversity cap or contradiction guard is needed here.
export function buildSameGameParlays(gameLines, propRows) {
  const events = summarizeEvents(gameLines, propRows);
  return events.map(evt => {
    const evtLines = gameLines.filter(r => r.eventId === evt.eventId);
    const evtProps = propRows.filter(r => r.eventId === evt.eventId);
    const tiers = buildTierSet(RISK_TIERS, evtLines, evtProps, { maxPerGame: Infinity });
    return { eventId: evt.eventId, matchup: evt.matchup, kickoff: evt.kickoff, tiers };
  });
}

export const SLATE_WINDOWS = [
  { key: "sun_early", label: "Sunday 1:00 PM ET Slate" },
  { key: "sun_late", label: "Sunday 4:00 PM ET Slate" }
];

// One Low/Medium/High/Mega tier set per Sunday kickoff window, pooling legs across every game in that window.
// Diversity cap is looser than the cross-game builder's (3 per game here vs. 2) — a slate is already scoped to
// a handful of games instead of the whole board, so a slightly higher per-game allowance still requires at
// least 2 different games to fill a 6-leg Mega parlay (never a single team's SGP in disguise) while giving a
// two-game slate window realistic room to actually reach the bigger tiers.
const SLATE_MAX_PER_GAME = 3;
export function buildSlateParlays(gameLines, propRows) {
  const events = summarizeEvents(gameLines, propRows);
  return SLATE_WINDOWS.map(w => {
    const eventIds = new Set(events.filter(e => e.window === w.key).map(e => e.eventId));
    if (!eventIds.size) {
      return { window: w.key, label: w.label, games: 0, tiers: RISK_TIERS.map(tier => ({ tier, book: null, ok: false, reason: `No games kick off in the ${w.label} this week.` })) };
    }
    const slateLines = gameLines.filter(r => eventIds.has(r.eventId));
    const slateProps = propRows.filter(r => eventIds.has(r.eventId));
    const tiers = buildTierSet(RISK_TIERS, slateLines, slateProps, { maxPerGame: SLATE_MAX_PER_GAME });
    return { window: w.key, label: w.label, games: eventIds.size, tiers };
  });
}
