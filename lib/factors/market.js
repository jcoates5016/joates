// Market/pricing factors that don't need any new external data — just more use of what the odds feed and the
// rolling price-history store (lib/store.js) already give us.
export function computeLineMovementSeries(oddID, book, priceHistory) {
  const series = priceHistory?.[`${oddID}|${book}`];
  if (!series || series.length < 2) return { available: false };
  const first = series[0], last = series[series.length - 1];
  return {
    available: true, points: series.length,
    priceMove: (last.price != null && first.price != null) ? last.price - first.price : null,
    pointMove: (last.point != null && first.point != null) ? +(last.point - first.point).toFixed(1) : null,
    series
  };
}

// --- Sharp-money signal ---------------------------------------------------------------------------------------
// Real "sharp money" in the classic sense (line moving against the public's bet %) needs bet-percentage/handle
// data this app doesn't have — SportsGameOdds gives prices and line movement, not who bet what. What it DOES
// give, for every one of the 7 tracked books every refresh, is real open-vs-current pricing (lib/analyze.js's
// collectMovement, off the API's own openOdds field) — so what this can honestly detect is cross-book PRICE
// MOVEMENT: whether several independent books shortened the same side (consensus/steam), whether that move is
// broad or concentrated in just one or two books, and — using this app's own rolling price-history snapshots —
// whether it happened in one late burst or drifted evenly across the week. None of that proves who bet it; it
// only proves the market itself moved, and by how much, across how many books. Label copy below says exactly
// that ("line movement"), never "sharp money confirmed."
const SHARP_NOISE_PRICE_CENTS = 3; // a book's price moving less than this is vig noise, not a real move
const SHARP_PRICE_REFERENCE_UNIT = 20; // same "20 cents of American-odds movement = one full unit" scale the
// original single-book steam_move nudge used — kept so the coefficient in lib/modelCoeffs.js still means
// roughly the same thing per unit of input as before, just now averaged across a real panel of books.
const SHARP_MAGNITUDE_CAP = 2; // one outlier book's price can't dominate the whole per-book magnitude
const MIN_BOOKS_FOR_SIGNAL = 3; // fewer than 3 books reporting real open/current data isn't a real "panel" —
// there's nothing honest to say about breadth/consensus off 1-2 books, so this returns unavailable instead.
const VELOCITY_MIN_SNAPSHOTS = 3; // need at least this many of our OWN price-history snapshots for a book before
// trusting its within-week timing at all
const VELOCITY_RECENT_WINDOW_FRACTION = 0.25; // the final quarter of tracked time before kickoff counts as "recent"
const VELOCITY_NEUTRAL_FRACTION = 0.25; // deliberately equal to the window fraction above: a move spread exactly
// evenly across the tracked period lands exactly on "recent share == window share" and scores a neutral 1.0x
const VELOCITY_MULTIPLIER_RANGE = 0.6; // total swing width around neutral (see computeVelocityMultiplier)

// One book's raw open/current price pair -> a signed magnitude on the shared scale above. Returns null when this
// book has no usable price pair at all (not "no movement" — genuinely no data), 0 when it has real data but the
// move is within the noise floor, and a capped positive/negative number otherwise. Positive = this book's price
// moved TOWARD this side actually hitting (e.g. -110 -> -130); negative = moved away from it.
function bookSignedMagnitude(m) {
  if (!m || m.openPrice == null || m.currentPrice == null) return null;
  const priceDelta = m.currentPrice - m.openPrice;
  if (Math.abs(priceDelta) < SHARP_NOISE_PRICE_CENTS) return 0;
  const raw = -priceDelta / SHARP_PRICE_REFERENCE_UNIT;
  return Math.max(-SHARP_MAGNITUDE_CAP, Math.min(SHARP_MAGNITUDE_CAP, raw));
}

// Of the books moving with the consensus direction, how much of each one's OWN total move (per this app's own
// weekly price-history snapshots, not the API's single open/current pair) happened in the final stretch before
// kickoff versus drifting evenly across the week. Averaged across whichever consensus books have enough of our
// own snapshots to say anything; books with too few snapshots yet are simply skipped, and a totally empty result
// (too early in the week for enough of our own snapshots anywhere) returns a neutral 1.0 rather than guessing.
function computeVelocityMultiplier(consensusBooks, oddID, priceHistory, kickoffISO) {
  if (!priceHistory || !kickoffISO) return 1;
  const kickoffMs = new Date(kickoffISO).getTime();
  if (!Number.isFinite(kickoffMs)) return 1;
  const fractions = [];
  for (const b of consensusBooks) {
    const series = priceHistory[`${oddID}|${b.book}`];
    if (!series || series.length < VELOCITY_MIN_SNAPSHOTS) continue;
    const withTimes = series
      .filter(pt => pt.t && pt.price != null)
      .map(pt => ({ t: new Date(pt.t).getTime(), price: pt.price }))
      .filter(pt => Number.isFinite(pt.t));
    if (withTimes.length < VELOCITY_MIN_SNAPSHOTS) continue;
    const first = withTimes[0], last = withTimes[withTimes.length - 1];
    const totalMove = Math.abs(last.price - first.price);
    const totalSpanMs = kickoffMs - first.t;
    if (totalMove === 0 || totalSpanMs <= 0) continue;
    const recentWindowStart = kickoffMs - VELOCITY_RECENT_WINDOW_FRACTION * totalSpanMs;
    const beforeWindow = [...withTimes].reverse().find(pt => pt.t <= recentWindowStart) || first;
    const recentMove = Math.abs(last.price - beforeWindow.price);
    fractions.push(Math.max(0, Math.min(1, recentMove / totalMove)));
  }
  if (!fractions.length) return 1;
  const avgFraction = fractions.reduce((s, f) => s + f, 0) / fractions.length;
  return +(1 + (avgFraction - VELOCITY_NEUTRAL_FRACTION) * VELOCITY_MULTIPLIER_RANGE).toFixed(3);
}

function buildSharpLabel({ direction, consensusBooks, totalBooks, velocityMultiplier }) {
  const avgCents = Math.round(consensusBooks.reduce((s, b) => s + Math.abs(b.priceDelta), 0) / consensusBooks.length);
  const sideText = direction === 1 ? "toward this side" : "away from this side";
  const recency = velocityMultiplier >= 1.15 ? ", mostly in the final stretch before kickoff"
    : velocityMultiplier <= 0.9 ? ", though most of that move happened earlier and has since leveled off"
    : "";
  return `${consensusBooks.length} of ${totalBooks} tracked books moved ${sideText}, averaging ${avgCents}¢${recency}.`;
}

// allBookMovement: row.allBookMovement (lib/analyze.js's collectMovement output) — every tracked book's real
// open-vs-current price pair for this exact prop. priceHistory/oddID/kickoffISO are only used for the optional
// within-week velocity read; a missing/thin priceHistory just falls back to a neutral multiplier, never blocks
// the rest of the signal.
export function computeSharpMoneySignal(allBookMovement, oddID, priceHistory, kickoffISO) {
  if (!allBookMovement || typeof allBookMovement !== "object") return { available: false };
  const perBook = [];
  for (const [bookId, m] of Object.entries(allBookMovement)) {
    const magnitude = bookSignedMagnitude(m);
    if (magnitude == null) continue;
    perBook.push({ book: bookId, priceDelta: m.currentPrice - m.openPrice, magnitude });
  }
  if (perBook.length < MIN_BOOKS_FOR_SIGNAL) return { available: false, booksWithData: perBook.length };

  const moved = perBook.filter(b => b.magnitude !== 0);
  if (!moved.length) {
    return {
      available: true, direction: 0, breadth: 0, consensusMagnitude: 0, velocityMultiplier: 1, sharpScore: 0,
      booksMoved: [], booksWithData: perBook.length,
      label: `No real cross-book movement yet this week (${perBook.length} books reporting, all within noise).`
    };
  }
  const positive = moved.filter(b => b.magnitude > 0), negative = moved.filter(b => b.magnitude < 0);
  const direction = positive.length >= negative.length ? 1 : -1;
  const consensusBooks = direction === 1 ? positive : negative;
  const breadth = consensusBooks.length / perBook.length;
  const consensusMagnitude = consensusBooks.reduce((s, b) => s + Math.abs(b.magnitude), 0) / consensusBooks.length;
  const velocityMultiplier = computeVelocityMultiplier(consensusBooks, oddID, priceHistory, kickoffISO);
  const sharpScore = Math.min(SHARP_MAGNITUDE_CAP, +(breadth * consensusMagnitude * velocityMultiplier).toFixed(4));
  const label = buildSharpLabel({ direction, consensusBooks, totalBooks: perBook.length, velocityMultiplier });
  return {
    available: true, direction, breadth: +breadth.toFixed(3), consensusMagnitude: +consensusMagnitude.toFixed(3),
    velocityMultiplier, sharpScore, booksMoved: consensusBooks.map(b => b.book), booksWithData: perBook.length, label
  };
}
