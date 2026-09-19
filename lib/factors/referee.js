// Referee tendency, computed from real historical data — nflverse's schedule file (games.csv) carries the
// assigned referee's name plus the actual final combined score (`total`) and the closing total line
// (`total_line`) for every past game, which is enough to compute a genuine historical over/under bias per
// referee across however many seasons of history this pipeline has loaded. This is NOT the AI-speculative
// "scouting take" bucket; it's a real number, though it's only ever as good as the sample size, so `gamesCalled`
// is always surfaced alongside it.
//
// This existed in an earlier version of this app, tied to a Moneyline/Totals game-line market that has since
// been removed (see README's market-scope note) — this build only offers player props now, no game totals — so
// it comes back here as a NON-bettable context read, the same way lib/factors/index.js's computeGameScript reads
// Vegas's own spread/total as context without turning it into its own bet. A referee whose games historically run
// well over the total is a real (if modest) tailwind for offensive production generally — more scoring plays for
// BOTH offenses, not specifically a run or pass tilt the way weather/game-script are — so unlike those two this
// isn't scoped to RUN_PROPS/PASS_PROPS in lib/probability.js.
//
// Assignment for an upcoming game often isn't known until close to kickoff (verified live: nflverse's games.csv
// leaves `referee` blank for every game that hasn't been played yet) — when the schedule row has no referee
// assigned yet, this just reports unavailable rather than guessing.
export function computeRefereeFactor(refereeName, schedule) {
  if (!refereeName) return { available: false };
  const games = (schedule || []).filter(s => s.referee === refereeName && s.total != null && s.total_line != null);
  if (games.length < 8) return { available: false, note: "not enough historical games for this referee", gamesCalled: games.length };
  const overs = games.filter(g => Number(g.total) > Number(g.total_line)).length;
  const avgTotal = games.reduce((s, g) => s + Number(g.total), 0) / games.length;
  const avgLine = games.reduce((s, g) => s + Number(g.total_line), 0) / games.length;
  return {
    available: true, refereeName, gamesCalled: games.length,
    overRate: overs / games.length, avgTotal, avgLine, avgDiffVsLine: avgTotal - avgLine
  };
}
