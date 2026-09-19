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
//
// Cohort pooling: the floor below (8 games) is itself thin — a truly coin-flip-neutral referee can easily show a
// 65%+ over-rate across just 8-12 games by pure chance, so trusting that raw rate directly against
// lib/probability.js's >=0.6/<=0.4 read thresholds risks flagging a lot of pure noise as a real tendency. Rather
// than a single hard cutoff deciding everything, every referee's raw rate is pooled toward the LEAGUE-WIDE
// over-rate across every OTHER referee in this same schedule (the real cohort of "similar officials," not a
// hand-picked constant), weighted by REFEREE_POOL_K "games" of trust behind that league baseline — the same
// shrinkage idea scripts/backtest.js's REG_K and lib/probability.js's marketPriorWeight already use elsewhere. A
// referee with a real, large, well-supported tendency still shows it once his own sample outweighs the pool
// constant; one right at the 8-game floor gets pulled back hard toward league-normal instead of reading as a
// strong lean off what's likely a handful of lucky/unlucky results.
export const REFEREE_POOL_K = 20;
export function computeRefereeFactor(refereeName, schedule) {
  if (!refereeName) return { available: false };
  const allGames = (schedule || []).filter(s => s.total != null && s.total_line != null);
  const games = allGames.filter(s => s.referee === refereeName);
  if (games.length < 8) return { available: false, note: "not enough historical games for this referee", gamesCalled: games.length };
  const overs = games.filter(g => Number(g.total) > Number(g.total_line)).length;
  const avgTotal = games.reduce((s, g) => s + Number(g.total), 0) / games.length;
  const avgLine = games.reduce((s, g) => s + Number(g.total_line), 0) / games.length;
  const othersGames = allGames.filter(s => s.referee !== refereeName);
  const leagueOverRate = othersGames.length
    ? othersGames.filter(g => Number(g.total) > Number(g.total_line)).length / othersGames.length
    : 0.5; // no other referees on record at all (e.g. a tiny synthetic/demo schedule) — a neutral 50% is the honest fallback
  const rawOverRate = overs / games.length;
  const pooledOverRate = (overs + REFEREE_POOL_K * leagueOverRate) / (games.length + REFEREE_POOL_K);
  return {
    available: true, refereeName, gamesCalled: games.length,
    overRate: pooledOverRate, rawOverRate, leagueOverRate,
    avgTotal, avgLine, avgDiffVsLine: avgTotal - avgLine
  };
}
