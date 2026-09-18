import { americanToImpliedProb, americanToDecimal, decimalToAmerican } from "./oddsMath.js";
import { getPrice, PARLAY_BOOKS, BOOKS } from "./analyze.js";

const PARLAY_STAKE = 100;

// Fixed, ABSOLUTE probability bands — not pool-relative quartiles — so a leg's tier is a property of the leg
// itself ("this play is a real ~80% shot") rather than of which other legs happened to be on the board that
// week. This is what makes "all four tiers, and if the Low Risk leg doesn't hit it doesn't ruin the others"
// actually true: the same leg can never appear in more than one tier's parlay within one parlay group, because
// each leg belongs to exactly one band. Low is "almost guaranteed" in real terms (75%+ true hit probability, not
// just "the best of whatever's left"); Mega is the 55% floor (MIN_LEG_PROBABILITY below) — still a real,
// stats-backed play, just the riskiest one this build will ever include in a parlay. Rejected an earlier
// pool-relative-quartile design: on a single game's Same Game Parlay pool, that would need ~18 distinct
// qualifying legs just to fill all four tiers without overlap, which no single game realistically offers.
export const RISK_TIERS = [
  { key: "low", label: "Low Risk", minProb: 0.75, maxProb: 1.01, legs: 3,
    desc: "3 legs, each a real 75%+ shot by our model — the closest thing this board has to a sure thing." },
  { key: "medium", label: "Medium Risk", minProb: 0.65, maxProb: 0.75, legs: 4,
    desc: "4 legs in the 65-75% range — still real favorites, just not the board's absolute safest plays." },
  { key: "high", label: "High Risk", minProb: 0.60, maxProb: 0.65, legs: 4,
    desc: "4 legs in the 60-65% range — a bigger payout, still every leg backed by real stats." },
  { key: "mega", label: "Mega Risk", minProb: 0.55, maxProb: 0.60, legs: 4,
    desc: "4 legs right at the 55-60% floor, picked for the biggest payout in that range — real edges, real risk." }
];

// A leg needs at least this much real modelProb to be eligible for ANY of these tiers — a coin-flip (or worse)
// doesn't belong in a build whose entire premise is "backed by real stats and facts." This is also the floor of
// the Mega band above, so MIN_LEG_PROBABILITY and RISK_TIERS stay in lockstep by construction. A row the model
// couldn't score at all (rare) falls back to the book's own implied probability, gated at the same floor.
export const MIN_LEG_PROBABILITY = 0.55;

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

// Splits one book's full leg pool into the four fixed bands, each sorted the way that tier actually wants its
// legs ranked: Low/Medium/High sort safest-first (highest real hit probability) since their whole point is
// "almost guaranteed" -> "still a real favorite" -> "bigger payout, same probability-first picks." Mega
// deliberately sorts by payout (lowest decimal odds = biggest underdog price within the floor band) first,
// since its explicit job is "high ROI, obviously riskier" within that band — not just "whatever's left."
function bandedPools(book, propRows) {
  const pool = buildLegPool(book, propRows).filter(l => l.hitProbability >= MIN_LEG_PROBABILITY);
  const byTier = {};
  for (const tier of RISK_TIERS) {
    const inBand = pool.filter(l => l.hitProbability >= tier.minProb && l.hitProbability < tier.maxProb);
    byTier[tier.key] = tier.key === "mega"
      ? inBand.slice().sort((a, b) => americanToDecimal(b.price) - americanToDecimal(a.price))
      : inBand.slice().sort((a, b) => b.hitProbability - a.hitProbability);
  }
  return byTier;
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
    const reason = band.length < tier.legs
      ? `Only ${band.length} leg${band.length === 1 ? "" : "s"} on ${BOOKS[book].label} fall in the ${Math.round(tier.minProb * 100)}-${Math.round(tier.maxProb * 100)}% range this week — not enough to build a ${tier.label.toLowerCase()} (${tier.legs}-leg) parlay.`
      : `${band.length} legs are in range on ${BOOKS[book].label}, but at most ${maxPerGame} per game keeps this to ${legs.length} usable leg${legs.length === 1 ? "" : "s"} — not enough to build a ${tier.label.toLowerCase()} (${tier.legs}-leg) parlay this week.`;
    return { tier, book, ok: false, reason };
  }
  const combinedDecimal = legs.reduce((d, l) => d * americanToDecimal(l.price), 1);
  const combinedAmerican = decimalToAmerican(combinedDecimal);
  const combinedProb = legs.reduce((p, l) => p * l.prob, 1);
  const correlated = Object.values(legs.reduce((acc, l) => { acc[l.gameKey] = (acc[l.gameKey] || 0) + 1; return acc; }, {})).some(c => c > 1);
  const payout = +(PARLAY_STAKE * (combinedDecimal - 1)).toFixed(2);
  return { tier, book, ok: true, legs, combinedAmerican, combinedProb, payout, correlated };
}

// Shared by every parlay grouping below (cross-game, one per Same Game Parlay, one per slate window): tries
// every parlay book against each tier's own fixed band, plus a shifted attempt per book (skips the band's
// first leg) so the shuffle UI has more than one book's worth of real alternates — same shape either way, so the
// frontend can swap the displayed parlay for any of them with no server round-trip. Because each tier only ever
// draws from its own probability band, no leg can appear in more than one tier's primary parlay at once.
function buildTierSet(propRows, { maxPerGame = 2 } = {}) {
  return RISK_TIERS.map(tier => {
    const attempts = [];
    PARLAY_BOOKS.forEach(book => {
      const band = bandedPools(book, propRows)[tier.key];
      attempts.push(priceTierResult(tier, book, fillTierFromBand(band, tier, maxPerGame, 0), band, maxPerGame));
      attempts.push(priceTierResult(tier, book, fillTierFromBand(band, tier, maxPerGame, 1), band, maxPerGame));
    });
    const valid = attempts.filter(c => c.ok);
    if (!valid.length) return attempts[0];

    const rank = tier.key === "mega"
      ? (p) => -p.payout // biggest payout first, matching bandedPools' own Mega sort intent
      : (p) => -(p.legs.reduce((s, l) => s + l.hitProbability, 0) / p.legs.length); // safest-first
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
  });
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

// One Low/Medium/High/Mega tier set PER GAME, built only from that game's own legs — no extra diversity cap or
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

// One Low/Medium/High/Mega tier set per Sunday kickoff window, pooling legs across every game in that window.
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
