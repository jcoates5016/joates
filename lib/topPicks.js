// Top Picks: a quick-glance "best 5" board per prop category (Anytime TD, receiving/rushing/passing yards,
// passing TDs) — the sharpest, most mispriced, most-likely-to-hit prop in each bucket, each with a short,
// real-reasons write-up. Everything here is a re-ranking/re-presentation of numbers the rest of the app already
// computes (row.trueEdge, row.confidence, row.modelContributorDetails) — no new data source, no new math, same
// honesty rule as every other view: if it's shown as a reason, it's a real computed factor that actually moved
// the grade %, never an invented-sounding one.
//
// PICK_CATEGORIES intentionally maps 1:1 onto propType keys the model already scores (see
// lib/probability.js's RUN_PROPS/PASS_PROPS and scripts/backtest.js's TD_PROP_TYPES) — "td" is Anytime TD.
export const PICK_CATEGORIES = [
  { key: "td", label: "Anytime TD" },
  { key: "rec_yds", label: "Receiving Yards" },
  { key: "rush_yds", label: "Rushing Yards" },
  { key: "pass_yds", label: "Passing Yards" },
  { key: "td_pass", label: "Passing TDs" }
];

// Same quality bar the Edge Board/Mispriced Bets tab already enforces (lib/pipeline.js's minEdgeFor) — a Top
// Pick is worthless as a "quick view of the sharpest plays" if it's allowed to include a real edge too thin to
// be more than market noise. Kept as its own copy (not imported) since pipeline.js doesn't export it and
// pipeline.js is what imports THIS file (circular import otherwise) — same values, same reasoning, see
// pipeline.js's own comment on minEdgeFor/MIN_TRUE_EDGE_TD for why Anytime TD needs a much higher bar (real
// diagnostic data: 13.5% real hit rate against the model's own 18.8% average confidence on it).
const MIN_TRUE_EDGE = 0.03;
const MIN_TRUE_EDGE_TD = 0.15;
function minEdgeFor(propType) { return propType === "td" ? MIN_TRUE_EDGE_TD : MIN_TRUE_EDGE; }

// Turns a real computed factor into a short, standalone reason fragment — used only to fill in when a pick's
// own fired nudges (contributorDetails) don't reach the 3-reason minimum on their own. Every one of these reads
// straight off already-computed, already-displayed numbers (the same ones factorChipsHTML shows) — never a
// guess, never phrased more confidently than the underlying sample supports.
function fallbackReasons(row) {
  const f = row.factors || {};
  const out = [];
  if (f.defense?.available) {
    out.push({ tag: "matchup", text: `opponent ranks ${f.defense.rank} of ${f.defense.ofTeams || 32} vs. ${row.position || "this position"}` });
  }
  if (f.form?.available && f.form.n_last10 >= 3) {
    const hits = Math.round(f.form.rate_last10 * f.form.n_last10);
    out.push({ tag: "form", text: `${hits} of his last ${f.form.n_last10} clear this line` });
  }
  if (f.redZone?.available && f.redZone.redZoneShare != null) {
    out.push({ tag: "usage", text: `${Math.round(f.redZone.redZoneShare * 100)}% share of his team's red-zone looks` });
  }
  if (f.usage?.available && f.usage.snapPct != null) {
    out.push({ tag: "usage", text: `${Math.round(f.usage.snapPct * 100)}% offensive snap share` });
  }
  if (row.trueEdge != null) {
    out.push({ tag: "market", text: `grades ${Math.round(row.trueEdge * 100)} points above the market's own price` });
  }
  return out;
}

// Picks the 3+ most relevant reasons for a row: real fired nudges first (contributorDetails), ranked by the
// actual measured coefficient (so a nudge whose backtested effect turned out negative, e.g. matchup_edge at
// -0.027 in the current lib/modelCoeffs.js, is correctly excluded rather than touted just because its label
// sounds positive) — then, only if that's not enough to reach `min`, real computed facts as filler, skipping any
// that overlap a tag already covered. Capped at 5 so a card never turns into a wall of bullets.
export function pickTopReasons(row, min = 3, max = 5) {
  const details = (row.modelContributorDetails || []).filter(c => c.weight > 0).sort((a, b) => b.weight - a.weight);
  const seenTags = new Set();
  const reasons = [];
  for (const d of details) {
    reasons.push(d.label);
    if (reasons.length >= max) return reasons;
  }
  if (reasons.length < min) {
    for (const fb of fallbackReasons(row)) {
      if (seenTags.has(fb.tag)) continue;
      seenTags.add(fb.tag);
      reasons.push(fb.text);
      if (reasons.length >= min || reasons.length >= max) break;
    }
  }
  return reasons;
}

// The 2-3 sentence quick-take: a headline sentence (who/what/the real numbers), then the reasons woven into one
// sentence, then an optional third sentence only when there's something worth flagging (thin sample). Never more
// than 3 sentences — the point of this view is a fast read, the full case already lives on the card in
// Edge Board / Player Props (propReasoning in public/index.html).
export function pickBlurb(row, reasons) {
  const market = row.line != null ? `${row.propLabel} ${row.side || ""} ${row.line}`.trim() : row.propLabel;
  const pct = n => `${Math.round((n ?? 0) * 100)}%`;
  const s1 = `${row.player}'s ${market} grades ${pct(row.modelProb)} against a ${pct(row.marketProb)} market price` +
    ` — a ${Math.round((row.trueEdge || 0) * 100)}-point edge.`;
  const s2 = reasons.length
    ? `Backed by ${reasons.slice(0, 3).join(", ")}${reasons.length > 3 ? ", among other things" : ""}.`
    : "";
  const s3 = row.confidence === "low"
    ? "Real edge, but on a thinner sample — worth sizing accordingly."
    : "";
  return [s1, s2, s3].filter(Boolean).join(" ");
}

// One category's board: every eligible row for that propType, sharpest edge first (ties broken by confidence),
// capped at `limit`. Same eligibility bar as the Edge Board (real model, above the noise-floor edge, medium/high
// confidence, no data-quality flags) — a "top 5" that let a suspect or team-mismatched row through wouldn't be
// the sharp, accurate list this was asked for.
function categoryPicks(propRows, propTypeKey, limit) {
  const confRank = { high: 2, medium: 1, low: 0 };
  return propRows
    .filter(r => r.propType === propTypeKey && r.model?.available && r.trueEdge > minEdgeFor(r.propType) &&
      ["medium", "high"].includes(r.confidence) && !r.teamMismatch && !r.suspect)
    .sort((a, b) => (b.trueEdge - a.trueEdge) || ((confRank[b.confidence] || 0) - (confRank[a.confidence] || 0)))
    .slice(0, limit)
    .map(r => {
      const reasons = pickTopReasons(r);
      return {
        oddID: r.oddID, player: r.player, team: r.team, opponent: r.opponentDisp || r.opponent,
        propType: r.propType, propLabel: r.propLabel, side: r.side, line: r.line, kickoff: r.kickoff,
        modelProb: r.modelProb, marketProb: r.marketProb, edge: r.trueEdge, confidence: r.confidence,
        bestBook: r.bestBook, bestPrice: r.bestPrice, reasons, blurb: pickBlurb(r, reasons)
      };
    });
}

// Pure and exported so scripts/dry-run.js can unit-test it directly against synthetic prop rows, the same
// pattern buildEdgeBoardHistory (lib/pipeline.js) already uses.
export function buildTopPicks(propRows, limit = 5) {
  return {
    categories: PICK_CATEGORIES.map(c => ({ key: c.key, label: c.label, picks: categoryPicks(propRows, c.key, limit) }))
  };
}
