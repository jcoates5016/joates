import { americanToImpliedProb, americanToDecimal, decimalToAmerican } from "./oddsMath.js";
import { getPrice, PARLAY_BOOKS, BOOKS } from "./analyze.js";

const PARLAY_STAKE = 100;

export const RISK_TIERS = [
  { key: "low", label: "Low Risk", maxLegs: 3, minProb: 0.60, desc: "3 or fewer legs, every leg a real favorite with backing." },
  { key: "medium", label: "Medium Risk", maxLegs: 5, minProb: 0.50, desc: "Up to 5 legs, moderate per-leg confidence, bigger payout." },
  { key: "high", label: "High Risk", minLegs: 5, maxLegs: 7, minProb: 0.0, requireSupport: true, desc: "5+ legs for a substantial payout — every leg still has to carry real edge or factor support." },
  { key: "mega", label: "Mega Risk", minLegs: 3, maxLegs: 8, minProb: 0.0, requireSupport: true, desc: "Go-for-broke payout. Real longshots allowed, but every leg still needs a real edge or supporting factor." }
];

function legConviction(leg) {
  let score = (leg.edge || 0) * 100;
  let hasSupport = leg.edge > 0;
  if (leg.kind === "line" && leg.row.arb) { score += 20; hasSupport = true; }
  if (leg.kind === "prop") {
    const f = leg.row.factors || {};
    if (f.form?.available && f.form.n_last3 >= 3 && f.form.rate_last3 >= 0.66) { score += 7; hasSupport = true; }
    if (f.form?.available && f.form.n_vsOpp >= 2 && f.form.rate_vsOpp >= 0.66) { score += 6; hasSupport = true; }
    if (f.tendency?.available) { score += 5; hasSupport = true; }
    if (f.usage?.available && f.usage.snapPct >= 0.75) { score += 5; hasSupport = true; }
    if (f.redZone?.available && f.redZone.redZoneShare >= 0.3) { score += 6; hasSupport = true; }
    if (f.defense?.available && f.defense.rank <= Math.ceil((f.defense.ofTeams || 32) * 0.35)) { score += 6; hasSupport = true; }
    if (f.matchupEdge?.available && f.matchupEdge.edge > 0.05) { score += 7; hasSupport = true; }
    if (f.scoringEnvironment?.available && f.scoringEnvironment.combinedEpaPerPlay > 0.1) { score += 6; hasSupport = true; }
    if (f.oLineInjury?.available && f.oLineInjury.count >= 2) score -= 6;
    if (f.selfInjury && ["out", "doubtful"].includes((f.selfInjury.status || "").toLowerCase())) { score -= 60; hasSupport = false; }
  }
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

function buildParlayForBookAndTier(book, tier, gameLines, propRows) {
  const pool = buildLegPool(book, gameLines, propRows)
    .filter(l => l.edge > -0.01 || l.hasSupport)
    .filter(l => !tier.requireSupport || l.hasSupport)
    .filter(l => l.prob >= (tier.minProb || 0))
    .sort((a, b) => b.conviction - a.conviction);

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

export function buildAllParlays(gameLines, propRows) {
  return RISK_TIERS.map(tier => {
    const candidates = PARLAY_BOOKS.map(b => buildParlayForBookAndTier(b, tier, gameLines, propRows));
    const valid = candidates.filter(c => c.ok);
    if (!valid.length) return candidates[0];
    valid.sort((a, b) => (b.legs.reduce((s, l) => s + l.conviction, 0) / b.legs.length) - (a.legs.reduce((s, l) => s + l.conviction, 0) / a.legs.length));
    return valid[0];
  });
}
