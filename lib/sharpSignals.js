// Sharp Signals: a market-wide scan (not per-player, not per-category) ranking every prop that's showing real,
// broad cross-book price movement — see lib/factors/market.js's computeSharpMoneySignal for exactly what this
// can and can't detect. Deliberate naming choice: this is "line movement," not "confirmed sharp money" — there's
// no bet-percentage/handle data behind it, only real multi-book price behavior, and every label here says so.
// Same re-ranking-only philosophy as lib/topPicks.js: no new data source, no new math beyond what
// assemblePropFactors already computed onto row.factors.sharpMoney.

// A prop needs at least half its reporting books moving the same direction before this counts as a real signal
// worth surfacing — a 2-of-5 split just isn't a "cross-book consensus," even if those two moved a lot.
const MIN_BREADTH_FOR_DISPLAY = 0.5;

function eligibleSignalRows(propRows) {
  return propRows.filter(r => {
    const s = r.factors?.sharpMoney;
    return r.model?.available && s?.available && s.direction !== 0 && s.breadth >= MIN_BREADTH_FOR_DISPLAY &&
      !r.teamMismatch && !r.suspect;
  });
}

// Pure and exported so scripts/dry-run.js can unit-test it directly against synthetic prop rows, same pattern
// buildTopPicks/buildEdgeBoardHistory already use.
export function buildSharpSignals(propRows, limit = 15) {
  const rows = eligibleSignalRows(propRows)
    .sort((a, b) => b.factors.sharpMoney.sharpScore - a.factors.sharpMoney.sharpScore)
    .slice(0, limit)
    .map(r => {
      const s = r.factors.sharpMoney;
      return {
        oddID: r.oddID, player: r.player, team: r.team, opponent: r.opponentDisp || r.opponent,
        propType: r.propType, propLabel: r.propLabel, side: r.side, line: r.line, kickoff: r.kickoff,
        direction: s.direction, breadth: s.breadth, consensusMagnitude: s.consensusMagnitude,
        velocityMultiplier: s.velocityMultiplier, sharpScore: s.sharpScore, booksMoved: s.booksMoved,
        booksWithData: s.booksWithData, label: s.label,
        modelProb: r.modelProb, marketProb: r.marketProb, edge: r.trueEdge, confidence: r.confidence,
        bestBook: r.bestBook, bestPrice: r.bestPrice
      };
    });
  return { signals: rows };
}
