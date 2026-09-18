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
