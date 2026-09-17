import { americanToImpliedProb, americanToDecimal, decimalToAmerican } from "./oddsMath.js";
import { getPrice, PARLAY_BOOKS, BOOKS } from "./analyze.js";

const PARLAY_STAKE = 100;

export const RISK_TIERS = [
  { key: "low", label: "Low Risk", maxLegs: 3, minProb: 0.60, desc: "3 or fewer legs, every leg a real favorite with backing." },
  { key: "medium", label: "Medium Risk", maxLegs: 5, minProb: 0.50, desc: "Up to 5 legs, moderate per-leg confidence, bigger payout." },
  { key: "high", label: "High Risk", minLegs: 5, maxLegs: 7, minProb: 0.0, requireSupport: true, desc: "5+ legs for a substantial payout — every leg still has to carry real edge or factor support." },
  { key: "mega", label: "Mega Risk", minLegs: 3, maxLegs: 8, minProb: 0.0, requireSupport: true, desc: "Go-for-broke payout. Real longshots allowed, but every leg still needs a real edge or supporting factor." }
];

// Conviction used to mean "how many arbitrary point bonuses did this leg happen to clear" — now it's built
// directly from the same market-anchored model every other part of the app ranks on (lib/probability.js), so a
// leg that looks great in a parlay and a leg that looks great on its own card are answering the same question
// the same way. `trueEdge` (model probability minus market probability) drives the score; `confidence` gates
// whether a leg counts as genuinely supported at all, so a thin, low-confidence "edge" can't carry a parlay leg
// just because the raw number happened to be positive.
function legConviction(leg) {
  const row = leg.row;
  if (!row.model?.available) return { score: (leg.edge || 0) * 100, hasSupport: leg.edge > 0 };
  let score = (row.trueEdge || 0) * 100;
  let hasSupport = row.trueEdge > 0 && !["low", "excluded"].includes(row.confidence);
  if (leg.kind === "line" && row.arb) { score += 20; hasSupport = true; }
  // A small bonus per independent real-world reason the model actually leaned on (matchup, usage, injury, etc.)
  // — not because more reasons prove more on their own, but two well-supported factors agreeing is worth
  // something a bare edge number doesn't capture, and it's what feeds the parlay write-ups' specifics.
  if (Array.isArray(row.modelContributors) && row.modelContributors.length) score += row.modelContributors.length * 1.5;
  if (row.confidence === "excluded") { score -= 60; hasSupport = false; }
  return { score, hasSupport };
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
    const c = legConviction(leg);
    leg.conviction = c.score; leg.hasSupport = c.hasSupport;
    legs.push(leg);
  });
  propRows.forEach(row => {
    if (row.teamMismatch || row.suspect) return;
    const price = getPrice(row, book);
    if (price == null || row.refProb == null) return;
    const prob = americanToImpliedProb(price);
    const edge = row.refProb - prob;
    const leg = { kind: "prop", book, gameKey: row.eventId, label: `${row.player} — ${row.propLabel} ${row.side || ""} ${row.line ?? ""}`.trim(), price, prob, edge, row };
    const c = legConviction(leg);
    leg.conviction = c.score; leg.hasSupport = c.hasSupport;
    legs.push(leg);
  });
  return legs;
}

// `skipTopN` deliberately excludes the highest-conviction legs from the pool before the greedy fill — the only
// way to get a genuinely different combination out of the same deterministic sort, so "shuffle" on the frontend
// has more than one book's worth of real alternates to offer even when just one book has enough qualifying legs.
function buildParlayForBookAndTier(book, tier, gameLines, propRows, { skipTopN = 0 } = {}) {
  // `tier.minProb` is meant to answer "how big a favorite does the model actually think this is" — the book's
  // own implied probability from the price it's offering (leg.prob) answers a different question (how the price
  // is set), and would let a heavily-juiced favorite qualify even when the model itself has no real conviction.
  // Falls back to leg.prob only for the rare row with no usable model estimate at all.
  const pool = buildLegPool(book, gameLines, propRows)
    .filter(l => l.edge > -0.01 || l.hasSupport)
    .filter(l => !tier.requireSupport || l.hasSupport)
    .filter(l => (l.row.model?.available ? l.row.modelProb : l.prob) >= (tier.minProb || 0))
    .sort((a, b) => b.conviction - a.conviction)
    .slice(skipTopN);

  const legs = [];
  const usedGames = {};
  for (const leg of pool) {
    if (legs.length >= tier.maxLegs) break;
    const gameCount = usedGames[leg.gameKey] || 0;
    if (gameCount >= 2) continue;
    if (gameCount >= 1 && legs.some(l => l.gameKey === leg.gameKey && l.kind === leg.kind)) continue;
    legs.push(leg);
    usedGames[leg.gameKey] = gameCount + 1;
  }
  const minLegs = tier.minLegs || 2;
  if (legs.length < minLegs) return { tier, book, ok: false, reason: `Only ${legs.length} qualifying leg${legs.length === 1 ? "" : "s"} found on ${BOOKS[book].label} this week — not enough to responsibly build a ${tier.label.toLowerCase()} parlay.` };

  const combinedDecimal = legs.reduce((d, l) => d * americanToDecimal(l.price), 1);
  const combinedAmerican = decimalToAmerican(combinedDecimal);
  const combinedProb = legs.reduce((p, l) => p * l.prob, 1);
  const correlated = Object.values(legs.reduce((acc, l) => { acc[l.gameKey] = (acc[l.gameKey] || 0) + 1; return acc; }, {})).some(c => c > 1);
  const payout = +(PARLAY_STAKE * (combinedDecimal - 1)).toFixed(2);
  return { tier, book, ok: true, legs, combinedAmerican, combinedProb, payout, correlated };
}

function avgConviction(p) { return p.legs.reduce((s, l) => s + l.conviction, 0) / p.legs.length; }
function legsKey(p) { return p.legs.map(l => `${l.kind}:${l.label}`).sort().join("|"); }

// One tier used to mean one parlay, full stop — whichever book scored highest, everything else thrown away.
// Jon wants to be able to shuffle through alternatives rather than being stuck with a single locked-in build,
// so every tier now keeps every distinct valid combination found (across both parlay books, plus a deliberately
// different combination per book that skips the single highest-conviction leg) as `alternates` on the primary
// pick — same shape, so the frontend can swap the displayed parlay for any of them with no server round-trip.
export function buildAllParlays(gameLines, propRows) {
  return RISK_TIERS.map(tier => {
    const attempts = [];
    PARLAY_BOOKS.forEach(book => {
      attempts.push(buildParlayForBookAndTier(book, tier, gameLines, propRows));
      attempts.push(buildParlayForBookAndTier(book, tier, gameLines, propRows, { skipTopN: 1 }));
    });
    const valid = attempts.filter(c => c.ok);
    if (!valid.length) return attempts[0];

    const seen = new Set();
    const distinct = [];
    valid.sort((a, b) => avgConviction(b) - avgConviction(a));
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
