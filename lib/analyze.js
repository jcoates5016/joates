import { americanToImpliedProb, computeRefProb } from "./oddsMath.js";
import { normTeam } from "./teamCodes.js";
import { resolvePlayer } from "./identity.js";

// Widened from the original 2-book scope (DraftKings + theScore Bet only) once it was confirmed the
// SportsGameOdds Rookie tier actually includes 77 bookmakers, not the ~9 the code's original comments assumed
// (that number was carried over from the free Amateur tier this build started on). Comparing against a real
// spread of books is what makes a "best price" or "mispriced" claim meaningful — two books rarely disagree
// enough to prove anything. This is a curated 8 (well, 7 now — see below), not all 77: object cost on this API
// scales with events × markets in a way the docs don't fully specify, and there's no confirmation it's free to
// add more bookmakerIDs to the same call — see the odds budget note in README before adding more. `label` is
// what shows in the AI prompt payload and the parlay write-up text; `short` is the pill badge on every card.
//
// Fanatics removed: a real live refresh on this account's Rookie tier failed outright with
// `{"error":"The bookmakerID fanatics is unavailable at your current subscription tier. Upgrade to unlock"}` —
// so despite the 77-bookmaker figure above, not every one of them is actually included at every tier. A single
// unavailable bookmakerID failed the ENTIRE request (all books, all events), not just that one book's prices —
// see fetchNFLEvents in fetchers/odds.js for the added resilience against this happening again with a
// different book if the account's tier or SGO's own catalog changes later.
export const BOOKS = {
  draftkings: { label: "DraftKings", short: "DK" },
  fanduel: { label: "FanDuel", short: "FD" },
  betmgm: { label: "BetMGM", short: "MGM" },
  caesars: { label: "Caesars", short: "CZR" },
  espnbet: { label: "theScore Bet", short: "SB" }, // provider key may still say espnbet post-rebrand
  betrivers: { label: "BetRivers", short: "BR" },
  pointsbet: { label: "PointsBet", short: "PB" }
};
export const BOOK_IDS = Object.keys(BOOKS);
export const BOOK_FALLBACKS = { espnbet: ["espnbet", "thescorebet", "theScoreBet"] };
// A parlay just needs every leg placeable on one shared book — it doesn't need to be limited to exactly 2.
// These four are the ones most bettors can actually open an account and place a same-slip parlay on; the other
// four tracked books still feed best-price/mispricing detection, they just never get selected as a parlay book.
export const PARLAY_BOOKS = ["draftkings", "fanduel", "betmgm", "espnbet"];

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
// Per-book open-vs-current price movement, straight from the odds API's own openOdds field — every tracked
// bookmaker that has one, not just DraftKings. Exported (and kept on the row as row.allBookMovement, see below)
// because this is exactly the raw ingredient lib/factors/sharpMoney.js needs to detect real cross-book steam —
// whether several books moved the same way, not just whether one representative book did. `openPoint`/
// `currentPoint` come back identical across every book in a given call (the API only reports the line itself once
// per market, not once per bookmaker), so they're carried along for display/context but the per-book comparison
// that actually matters here is each book's own price.
export function collectMovement(evt, oddsObj) {
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
export function getPrice(row, bookId) { return row.prices[bookId] ?? null; }

// A genuine sharp mispricing rarely turns up an edge this big — a real gap against the field is usually a
// couple points. Past this threshold, something's off, but it can mean two very different things: (1) a
// mismatched side/price somewhere in the pipeline — a real data error, or (2) one specific book just hasn't
// caught up yet while the rest of the panel already agrees with the consensus — real, bettable stale-line
// value. Those two used to be treated identically: one flat `suspect` flag that excluded BOTH from Mispriced
// Bets, AI commentary and parlay legs — which meant the single biggest real edges this app could ever surface
// were exactly the ones it threw away automatically, alongside genuine data errors. Now they're told apart:
// when at least 2 other books exist and a clear majority of them sit tight against the consensus (within
// CORROBORATION_TOLERANCE), the outlier is `staleValue` — surfaced with a visible flag, not excluded. Only a
// price with no real corroboration (fewer than 2 other books) or genuine disagreement across the panel itself
// stays `suspect` and gets excluded, on the theory that a shared data problem can affect more than one book.
export const SUSPECT_EDGE_THRESHOLD = 0.08;
const CORROBORATION_TOLERANCE = 0.04;

export function computeBestAcrossBooks(row, refProb) {
  let bestBook = null, bestEdge = -99, bestPrice = null;
  const impliedByBook = {};
  BOOK_IDS.forEach(bid => {
    const price = getPrice(row, bid);
    if (price == null) return;
    const p = americanToImpliedProb(price);
    if (p == null || refProb == null) return;
    impliedByBook[bid] = p;
    const edge = refProb - p;
    if (edge > bestEdge) { bestEdge = edge; bestBook = bid; bestPrice = price; }
  });
  const overThreshold = bestBook ? bestEdge > SUSPECT_EDGE_THRESHOLD : false;
  let suspect = false, staleValue = false;
  if (overThreshold) {
    const others = Object.entries(impliedByBook).filter(([b]) => b !== bestBook).map(([, p]) => p);
    const agreeingOthers = others.filter(p => Math.abs(p - refProb) <= CORROBORATION_TOLERANCE);
    if (others.length >= 2 && agreeingOthers.length >= Math.ceil(others.length * 0.66)) staleValue = true;
    else suspect = true;
  }
  return { bestBook, bestEdge: bestBook ? bestEdge : null, bestPrice, suspect, staleValue };
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

// Game-level spread/total, pulled from the same event payload every prop already comes from — SportsGameOdds
// returns these under oddIDs shaped `points-home-game-sp-home` (the home team's own spread) and
// `points-all-game-ou-over` (the combined total), right alongside every prop, we just never looked at them once
// game lines stopped being a bet type here. This is NOT resurrecting them as something to bet on — it's reading
// the market's own implied game script (who's expected to win, and by how much, and how high-scoring the game
// is expected to be) purely as a contextual signal for run/pass volume: a big favorite tends to lean run-heavy
// and clock-killing late, a big underdog tends to lean pass-heavy chasing the game. See computeGameScript in
// factors/index.js for how a specific prop row turns this into a scored nudge.
export function extractGameContext(evt) {
  const odds = evt.odds || {};
  let homeSpread = null, total = null;
  for (const o of Object.values(odds)) {
    if (o.periodID && o.periodID !== "game") continue;
    // SportsGameOdds returns these as strings on a real payload (e.g. "+8.5"), never as JS numbers — confirmed
    // live when this shipped: comparisons like <=/>= silently coerce a string fine, but calling .toFixed() on
    // one directly (as the game_script_* nudges in lib/probability.js do) throws "toFixed is not a function".
    // Coercing once here, at the source, means every downstream consumer (computeGameScript, the nudges, any
    // future one) can trust these are real numbers without re-checking.
    if (o.statID === "points" && o.statEntityID === "home" && o.betTypeID === "sp" && o.sideID === "home") {
      const raw = o.bookSpread ?? o.fairSpread ?? null;
      homeSpread = raw != null ? Number(raw) : null;
    } else if (o.statID === "points" && o.statEntityID === "all" && o.betTypeID === "ou" && o.sideID === "over") {
      const raw = o.bookOverUnder ?? o.fairOverUnder ?? null;
      total = raw != null ? Number(raw) : null;
    }
  }
  if (homeSpread == null || total == null || isNaN(homeSpread) || isNaN(total)) return { available: false };
  // homeScore + awayScore = total; homeScore - awayScore = -homeSpread (a negative home spread means home is
  // favored, i.e. projected to win by -homeSpread points) — solving that system for each side's implied total.
  const homeImpliedTotal = (total - homeSpread) / 2;
  const awayImpliedTotal = (total + homeSpread) / 2;
  return { available: true, homeSpread, total, homeImpliedTotal, awayImpliedTotal };
}
function derivePlayerNameFromEntityID(statEntityID) {
  if (!statEntityID) return "";
  return statEntityID.replace(/_\d+_[A-Z]+$/, "").replace(/_/g, " ");
}

// `log` is purely diagnostic (defaults to a no-op so scripts/dry-run.js's demo-mode calls elsewhere stay
// silent) — added to answer a real live question from scratch instead of guessing: when a prop type Jon
// expects (e.g. receptions) doesn't show up in the app's type filter, was the market never sent by any tracked
// book this refresh, or did it get excluded by a filter below (period, side, missing price)? `statIdSeen` counts
// every player-level odds entry SportsGameOdds actually returned this pull, classified or not, so the two log
// lines below turn that into a direct answer in the Netlify function logs rather than a guess.
export function analyzePlayerProps(events, gameLogIndex, rosterIndex, depthChartIndex = null, log = () => {}) {
  const rows = [];
  const statIdSeen = new Map();
  events.forEach(evt => {
    const home = evt.teams?.home?.names?.short || evt.homeTeam || "HOME";
    const away = evt.teams?.away?.names?.short || evt.awayTeam || "AWAY";
    const homeDisp = evt.teams?.home?.names?.medium || evt.teams?.home?.names?.long || home;
    const awayDisp = evt.teams?.away?.names?.medium || evt.teams?.away?.names?.long || away;
    const kickoff = evt.status?.startsAt || evt.scheduled || evt.startTime || null;

    Object.values(evt.odds || {}).forEach(o => {
      if (!o.statEntityID || o.statEntityID === "home" || o.statEntityID === "away" || o.statEntityID === "all") return;
      if (o.periodID && o.periodID !== "game") return;
      if (o.statID) statIdSeen.set(o.statID, (statIdSeen.get(o.statID) || 0) + 1);
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
      const player = resolvePlayer(rawName, gameLogIndex, rosterIndex, depthChartIndex);
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
        // Surfaced straight from resolvePlayer() so the frontend can show a real "RB2 of 4"-style role chip
        // (depthChartRole/depthChartGroupSize) and flag the rare case where the weekly roster file and the
        // fresher depth-chart scrape disagree on which team a player is currently on (rosterConflict) — see
        // the rosterConflicts stat and log line in pipeline.js for the pipeline-wide count of the latter.
        depthChartRole: player.depthChartRole, depthChartGroupSize: player.depthChartGroupSize,
        rosterConflict: player.rosterConflict,
        _resolvedPlayer: player
      };
      const best = computeBestAcrossBooks(row, refProb);
      row.bestBook = best.bestBook; row.bestEdge = best.bestEdge; row.bestPrice = best.bestPrice;
      row.suspect = best.suspect; row.staleValue = best.staleValue;
      if (row.suspect || row.staleValue) row.rawDebug = { sideID: o.sideID, statID: o.statID, betTypeID: o.betTypeID, oddID: o.oddID, bookOverUnder: o.bookOverUnder, fairOverUnder: o.fairOverUnder, fairOdds: o.fairOdds };
      // Full per-book open-vs-current movement (see collectMovement's own comment above) — this used to get
      // collapsed down to one representative book (row.movement, via the now-removed summarizeMovement) and then
      // never actually read anywhere. Kept in full now so lib/factors/sharpMoney.js can detect real cross-book
      // consensus/divergence instead of one book's number standing in for the whole market.
      row.allBookMovement = collectMovement(evt, o);
      rows.push(row);
    });
  });

  const unclassified = [...statIdSeen.entries()].filter(([id]) => !classifyProp(id));
  if (unclassified.length) {
    log(`Player-prop statIDs seen this refresh that don't match any known prop type in PROP_PATTERNS (excluded, ` +
      `not mislabeled — see lib/analyze.js if one of these should actually be mapped to a real prop type): ` +
      unclassified.sort((a, b) => b[1] - a[1]).map(([id, n]) => `${id}(${n})`).join(", "));
  }
  const rowCountsByType = {};
  rows.forEach(r => { rowCountsByType[r.propType] = (rowCountsByType[r.propType] || 0) + 1; });
  log(`Player-prop rows by type this refresh: ` +
    (Object.entries(rowCountsByType).map(([k, n]) => `${k}:${n}`).join(", ") || "(none)") +
    `. A recognized statID with a 0-row type here (present in the statID list above but missing/low here) means ` +
    `it's real live data but getting filtered out downstream (wrong betTypeID variant, no price, or an ` +
    `unders-only book) — not that the market type itself is unsupported.`);

  return rows;
}
