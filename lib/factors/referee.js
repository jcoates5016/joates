// Referee tendency, computed from real historical data — nflverse's schedule file carries the assigned
// referee's name plus the actual final total and the closing total_line for every past game, which is enough
// to compute a genuine historical over/under bias per referee across however many seasons of history this
// pipeline has loaded. This is NOT the AI-speculative "scouting take" bucket; it's a real number, though it's
// only ever as good as the sample size, so `gamesCalled` is always surfaced alongside it. Assignment for an
// upcoming game often isn't known until close to kickoff — when the schedule row has no referee yet, this
// just reports unavailable rather than guessing.
export function computeRefereeFactor(refereeName, schedule) {
  if (!refereeName) return { available: false };
  const games = schedule.filter(s => s.referee === refereeName && s.total != null && s.total_line != null);
  if (games.length < 8) return { available: false, note: "not enough historical games for this referee", gamesCalled: games.length };
  const overs = games.filter(g => Number(g.total) > Number(g.total_line)).length;
  const avgTotal = games.reduce((s, g) => s + Number(g.total), 0) / games.length;
  const avgLine = games.reduce((s, g) => s + Number(g.total_line), 0) / games.length;
  return {
    available: true, refereeName, gamesCalled: games.length,
    overRate: overs / games.length, avgTotal, avgLine, avgDiffVsLine: avgTotal - avgLine
  };
}
