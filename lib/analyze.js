import { americanToImpliedProb, computeRefProb } from "./oddsMath.js";
import { normTeam } from "./teamCodes.js";
import { resolvePlayer } from "./identity.js";

// Scoped to DraftKings & theScore Bet only — every parlay stays placeable as one slip.
export const BOOKS = {
  draftkings: { label: "DraftKings", short: "DK" },
  espnbet: { label: "theScore Bet", short: "SB" } // provider key may still say espnbet post-rebrand
};
export const BOOK_IDS = Object.keys(BOOKS);
export const BOOK_FALLBACKS = { espnbet: ["espnbet", "thescorebet", "theScoreBet"] };
export const PARLAY_BOOKS = ["draftkings", "espnbet"];

export function rowKey(prefix, ids) { return prefix + "|" + ids.join("|"); }

function bookKeyForEvent(evt, wantedKey) {
  const candidates = BOOK_FALLBACKS[wantedKey] || [wantedKey];
  for (const c of candidates) {
    for (const oid in (evt.odds || {})) {
      if (evt.odds[oid].byBookmaker && evt.odds[oid].byBookmaker[c]) return c;
    }
  }
  return wantedKey;
}
function collectAutoPrices(evt, oddsObj) {
  const prices = {};
  BOOK_IDS.forEach(bid => {
    const key = bid === "espnbet" ? bookKeyForEvent(evt, "espnbet") : bid;
    const entry = oddsObj.byBookmaker?.[key];
    if (entry) prices[bid] = entry.odds;
  });
  return prices;
}
function collectMovement(evt, oddsObj) {
  const out = {};
  BOOK_IDS.forEach(bid => {
    const key = bid === "espnbet" ? bookKeyForEvent(evt, "espnbet") : bid;
    const entry = oddsObj.byBookmaker?.[key];
    if (!entry) return;
    const openPrice = entry.openOdds ?? null;
    const openPoint = oddsObj.openSpread ?? oddsObj.openOverUnder ?? null;
    const currentPoint = oddsObj.bookSpread ?? oddsObj.bookOverUnder ?? null;
    if (openPrice == null && openPoint == null) return;
    out[bid] = { openPrice, currentPrice: entry.odds, openPoint, currentPoint };
  });
  return out;
}
function summarizeMovement(movement) {
  const bid = movement.draftkings ? "draftkings" : Object.keys(movement)[0];
  if (!bid) return null;
  const m = movement[bid];
  const priceDelta = (m.openPrice != null && m.currentPrice != null) ? m.currentPrice - m.openPrice : null;
  const pointDelta = (m.openPoint != null && m.currentPoint != null) ? +(m.currentPoint - m.openPoint).toFixed(1) : null;
  if (priceDelta == null && !pointDelta) return null;
  return { book: bid, openPrice: m.openPrice, currentPrice: m.currentPrice, priceDelta, openPoint: m.openPoint, currentPoint: m.currentPoint, pointDelta };
}
export function getPrice(row, bookId) { return row.prices[bookId] ?? null; }

// Shopping only two books for a genuine sharp mispricing rarely turns up an edge this big — a real two-book
// gap is usually a couple points. Past this threshold, a mismatched side/price somewhere in the pipeline is
// far more likely than a real -230-quality price sitting at +180. Flag it instead of trusting it blindly:
// `suspect` rows are excluded from Mispriced Bets, AI commentary and parlay legs, and get a visible warning in
// the UI. Raise or remove this once the feed's exact field shape has been confirmed against enough live runs.
export const SUSPECT_EDGE_THRESHOLD = 0.08;

export function computeBestAcrossBooks(row, refProb) {
  let bestBook = null, bestEdge = -99, bestPrice = null;
  BOOK_IDS.forEach(bid => {
    const price = getPrice(row, bid);
    if (price == null) return;
    const p = americanToImpliedProb(price);
    if (p == null || refProb == null) return;
    const edge = refProb - p;
    if (edge > bestEdge) { bestEdge = edge; bestBook = bid; bestPrice = price; }
  });
  const suspect = bestBook ? bestEdge > SUSPECT_EDGE_THRESHOLD : false;
  return { bestBook, bestEdge: bestBook ? bestEdge : null, bestPrice, suspect };
}

// Scoped to Totals only (no Moneyline, no Spread) — this build is specifically about the sharpest NFL Overs,
// and Moneyline/Spread are bets on which team wins or covers, which is inseparable from how good the other
// team's defense is. A team total or game total, by contrast, is squarely about scoring output — you can grade
// it from both teams' own offensive numbers without ever touching what either defense does.
export function analyzeGameLines(events) {
  const rows = [];
  events.forEach(evt => {
    const home = evt.teams?.home?.names?.short || evt.homeTeam || "HOME";
    const away = evt.teams?.away?.names?.short || evt.awayTeam || "AWAY";
    const homeDisp = evt.teams?.home?.names?.medium || evt.teams?.home?.names?.long || home;
    const awayDisp = evt.teams?.away?.names?.medium || evt.teams?.away?.names?.long || away;
    const kickoff = evt.status?.startsAt || evt.scheduled || evt.startTime || null;

    Object.values(evt.odds || {}).forEach(o => {
      const isTotal = o.betTypeID === "ou" && o.periodID === "game" &&
        (o.statID === "points" || o.statID === "total_points");
      if (!isTotal) return;
      if ((o.sideID || "").toLowerCase() === "under") return; // Overs only
      const prices = collectAutoPrices(evt, o);
      if (!Object.keys(prices).length) return;

      const marketLabel = "Total";
      const sideLabel = `${o.sideID} ${o.bookOverUnder ?? o.fairOverUnder ?? ""}`;

      const { refProb, refProbSource } = computeRefProb(o.fairOdds, prices);
      const row = {
        _key: rowKey("line", [evt.eventID || evt.id, o.oddID]),
        eventId: evt.eventID || evt.id, matchup: `${awayDisp} @ ${homeDisp}`, home: normTeam(home), away: normTeam(away), kickoff,
        market: marketLabel, side: sideLabel, oddID: o.oddID, prices, refProb, refProbSource,
        statID: o.statID, betTypeID: o.betTypeID, periodID: o.periodID
      };
      const best = computeBestAcrossBooks(row, refProb);
      row.bestBook = best.bestBook; row.bestEdge = best.bestEdge; row.bestPrice = best.bestPrice;
      row.suspect = best.suspect;
      if (row.suspect) row.rawDebug = { sideID: o.sideID, statID: o.statID, betTypeID: o.betTypeID, oddID: o.oddID, bookOverUnder: o.bookOverUnder, fairOverUnder: o.fairOverUnder, fairOdds: o.fairOdds };
      row.movement = summarizeMovement(collectMovement(evt, o));
      rows.push(row);
    });
  });

  const byGroup = {};
  rows.forEach(r => {
    const key = r.eventId + "|" + r.market + "|" + (r.side || "").replace(/^(over|under|home|away|yes|no)\s*/i, "");
    (byGroup[key] = byGroup[key] || []).push(r);
  });
  Object.values(byGroup).forEach(group => {
    if (group.length < 2) return;
    const [a, b] = group;
    if (a.suspect || b.suspect) return;
    const aProb = a.bestPrice != null ? americanToImpliedProb(a.bestPrice) : null;
    const bProb = b.bestPrice != null ? americanToImpliedProb(b.bestPrice) : null;
    if (aProb != null && bProb != null && (aProb + bProb) < 0.995) {
      a.arb = b.arb = true;
      a.arbMargin = b.arbMargin = (1 - (aProb + bProb));
    }
  });
  return rows;
}

// Anchored (^...$), not a loose substring test. SportsGameOdds has separate, much-longer-odds markets —
// firstTouchdown, lastTouchdown, and likely a 2+/multi-touchdown market — that all contain the substring
// "touchdown" too. An unanchored /touchdown/i test on statID matches those right along with the real combined
// any-touchdown stat, silently mislabeling a First/Last-Touchdown-Scorer price as "Anytime TD". Anchoring means
// an unrecognized touchdown-flavored market is simply excluded (propType stays null) rather than mislabeled.
//
// Separately — and this was the actual cause of the wrong prices a live Rookie-tier refresh showed (confirmed
// by dumping the full raw odds object): SportsGameOdds publishes the combined "touchdowns" (anytime-TD) stat
// under TWO different oddIDs at once — a real, correctly-priced yes/no market (betTypeID "yn", sideID "yes":
// fairOdds and every book's price all agree, e.g. Amon-Ra St. Brown around +105/+119) AND a second, seemingly
// synthetic over/under-0.5 encoding of the same bet (betTypeID "ou", sideID "over") whose book prices are
// nonsense (fairOdds looked normal but the book price was wildly different, e.g. +700 for the same player at
// the same time). This code never checked betTypeID, so it kept BOTH as separate rows, and the broken one is
// what showed up in the app. `betTypeID` below pins each prop type to the one market shape that's actually
// reliable for it — confirmed live for "td" (must be "yn"); the yardage/count props have only ever shown up
// as "ou" with no evidence of a duplicate encoding, so they keep requiring that.
const PROP_PATTERNS = [
  { key: "td_pass", label: "Passing TDs", test: /^passing.?touchdowns?$/i, betTypeID: "ou" },
  { key: "td_rush", label: "Rushing TDs", test: /^rushing.?touchdowns?$/i, betTypeID: "ou" },
  { key: "td_rec", label: "Receiving TDs", test: /^receiving.?touchdowns?$/i, betTypeID: "ou" },
  { key: "td", label: "Anytime TD", test: /^touchdowns?$/i, betTypeID: "yn" },
  { key: "pass_yds", label: "Passing yards", test: /^passing.?yards?$/i, betTypeID: "ou" },
  { key: "rush_yds", label: "Rushing yards", test: /^rushing.?yards?$/i, betTypeID: "ou" },
  { key: "rec_yds", label: "Receiving yards", test: /^receiving.?yards?$/i, betTypeID: "ou" },
  { key: "receptions", label: "Receptions", test: /^receptions?$/i, betTypeID: "ou" }
];
export function classifyProp(statID) { for (const p of PROP_PATTERNS) { if (p.test.test(statID)) return p; } return null; }
function derivePlayerNameFromEntityID(statEntityID) {
  if (!statEntityID) return "";
  return statEntityID.replace(/_\d+_[A-Z]+$/, "").replace(/_/g, " ");
}

export function analyzePlayerProps(events, gameLogIndex, rosterIndex) {
  const rows = [];
  events.forEach(evt => {
    const home = evt.teams?.home?.names?.short || evt.homeTeam || "HOME";
    const away = evt.teams?.away?.names?.short || evt.awayTeam || "AWAY";
    const homeDisp = evt.teams?.home?.names?.medium || evt.teams?.home?.names?.long || home;
    const awayDisp = evt.teams?.away?.names?.medium || evt.teams?.away?.names?.long || away;
    const kickoff = evt.status?.startsAt || evt.scheduled || evt.startTime || null;

    Object.values(evt.odds || {}).forEach(o => {
      if (!o.statEntityID || o.statEntityID === "home" || o.statEntityID === "away" || o.statEntityID === "all") return;
      if (o.periodID && o.periodID !== "game") return;
      const propType = classifyProp(o.statID || "");
      if (!propType) return;
      // Reject whichever market-shape duplicate this prop type doesn't use (see the comment above
      // PROP_PATTERNS) — this is what actually excludes the broken synthetic "ou" encoding of Anytime TD.
      if ((o.betTypeID || "") !== propType.betTypeID) return;
      // Overs only. Excludes both "under" (the standard two-sided over/under wording) and "no" (the yes/no
      // market's rejection side) — this build only ever shows the "yes, this happens" side of a prop.
      if (["under", "no"].includes((o.sideID || "").toLowerCase())) return;
      const prices = collectAutoPrices(evt, o);
      if (!Object.keys(prices).length) return;

      const rawName = o.playerName || derivePlayerNameFromEntityID(o.statEntityID) || o.statEntityID;
      const player = resolvePlayer(rawName, gameLogIndex, rosterIndex);
      const { refProb, refProbSource } = computeRefProb(o.fairOdds, prices);
      const line = o.bookOverUnder ?? o.fairOverUnder ?? null;

      const homeN = normTeam(home), awayN = normTeam(away), playerTeamN = player.team ? normTeam(player.team) : null;
      let opponent, opponentDisp, teamMismatch = false;
      if (playerTeamN && playerTeamN === awayN) { opponent = home; opponentDisp = homeDisp; }
      else if (playerTeamN && playerTeamN === homeN) { opponent = away; opponentDisp = awayDisp; }
      else { opponent = home; opponentDisp = homeDisp; teamMismatch = true; }

      const row = {
        _key: rowKey("prop", [evt.eventID || evt.id, o.oddID]),
        eventId: evt.eventID || evt.id, kickoff, home: normTeam(home), away: normTeam(away),
        playerId: player.playerId, player: player.name, team: normTeam(player.team),
        position: player.position, opponent: normTeam(opponent), opponentDisp, teamMismatch, propType: propType.key, propLabel: propType.label,
        side: o.sideID, line, prices, refProb, refProbSource,
        statID: o.statID, betTypeID: o.betTypeID, periodID: o.periodID, oddID: o.oddID,
        _resolvedPlayer: player
      };
      const best = computeBestAcrossBooks(row, refProb);
      row.bestBook = best.bestBook; row.bestEdge = best.bestEdge; row.bestPrice = best.bestPrice;
      row.suspect = best.suspect;
      if (row.suspect) row.rawDebug = { sideID: o.sideID, statID: o.statID, betTypeID: o.betTypeID, oddID: o.oddID, bookOverUnder: o.bookOverUnder, fairOverUnder: o.fairOverUnder, fairOdds: o.fairOdds };
      row.movement = summarizeMovement(collectMovement(evt, o));
      rows.push(row);
    });
  });
  return rows;
}
