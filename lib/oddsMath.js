// Standard American-odds math. No sportsbook-specific quirks here — this is the same de-vig/implied-probability
// arithmetic every book's own pricing engine runs, just applied to the numbers the odds feed gives us.
export function americanToImpliedProb(a) {
  if (a == null || isNaN(a)) return null;
  const n = Number(a);
  return n > 0 ? 100 / (n + 100) : -n / (-n + 100);
}
export function americanToDecimal(a) {
  if (a == null || isNaN(a)) return null;
  const n = Number(a);
  return n > 0 ? 1 + n / 100 : 1 + 100 / -n;
}
export function decimalToAmerican(d) {
  if (d == null || isNaN(d) || d <= 1) return null;
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}

// The odds feed's own `fairOdds` (its de-vigged consensus across a much wider book panel than just the two we
// display) is the best available reference probability. When it's missing for a given side, fall back to a
// naive average of whatever book prices we do have — worse, but better than nothing, and callers can see
// `refProbSource` to know which they got.
export function computeRefProb(fairOdds, prices) {
  if (fairOdds != null) {
    const p = americanToImpliedProb(fairOdds);
    if (p != null) return { refProb: p, refProbSource: "fairOdds" };
  }
  const vals = Object.values(prices || {}).map(americanToImpliedProb).filter(v => v != null);
  if (!vals.length) return { refProb: null, refProbSource: null };
  return { refProb: vals.reduce((a, b) => a + b, 0) / vals.length, refProbSource: "book_average" };
}
