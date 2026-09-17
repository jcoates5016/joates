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

// Spreads and totals cluster around 3, 7, and 10 in the NFL far more than a smooth distribution would predict
// (field goals and touchdowns are worth exactly that many points) — a line sitting ON or just past one of
// those numbers is worth flagging, since a single point of movement across one is worth disproportionately
// more than the same point of movement elsewhere.
const KEY_NUMBERS = [3, 7, 10, 6, 4];
export function keyNumberProximity(point) {
  if (point == null) return { available: false };
  const abs = Math.abs(point);
  const nearest = KEY_NUMBERS.reduce((best, k) => Math.abs(abs - k) < Math.abs(abs - best) ? k : best, KEY_NUMBERS[0]);
  const distance = +(abs - nearest).toFixed(1);
  return { available: true, nearestKeyNumber: nearest, distance, onKeyNumber: distance === 0 };
}
