// Injury-derived factors. `injuriesByTeam` is this refresh's fresh ESPN pull; `injuryHistory` is the rolling
// set of snapshots lib/store.js has been saving across recent refreshes this week, which is what makes the
// practice-participation *trend* (not just today's single status) possible.
const OL_POSITIONS = new Set(["T", "G", "C", "OT", "OG", "LT", "RT", "LG", "RG"]);

export function computeSelfInjury(player, injuriesByTeam) {
  const list = injuriesByTeam[player.team] || [];
  const mine = list.find(x => x.name === player.name);
  if (!mine) return null;
  return { status: mine.status, detail: mine.detail };
}

export function computeOLineInjuryFlag(team, injuriesByTeam) {
  const list = injuriesByTeam[team] || [];
  const olHurt = list.filter(x => OL_POSITIONS.has((x.position || "").toUpperCase()) &&
    /out|doubtful|questionable/i.test(x.status || ""));
  if (!list.length) return { available: false };
  return { available: true, count: olHurt.length, names: olHurt.map(x => `${x.name} (${x.status})`) };
}

const SECONDARY_POSITIONS = new Set(["CB", "S", "FS", "SS", "DB", "NB"]);

// A cornerback or safety being out doesn't just cost the DEFENSE's own numbers — it's a real, computable
// tailwind for the OPPOSING team's passing game, which is exactly the kind of cross-team effect that got asked
// for by name ("if a cornerback from the Saints is out, that boosts the WRs for the opposing team"). This is
// deliberately generic (every opposing pass-catcher on this game gets the same signal), not a specific
// "this WR's man corner is out" matchup claim — nflverse's own participation/coverage-assignment dataset (the
// only thing that could make a real 1-on-1 matchup computable) was confirmed discontinued for in-season release
// before this app was built (see README's speculative-bucket note), so pretending to know which receiver a
// specific injured corner would have covered would be exactly the kind of invented precision this app avoids
// everywhere else. What's real and computable: how many of the opponent's own secondary are out/doubtful right
// now, straight from the same ESPN injury pull every other injury factor here already uses.
export function computeOpposingSecondaryInjury(opponentTeam, injuriesByTeam) {
  const list = injuriesByTeam[opponentTeam] || [];
  if (!list.length) return { available: false };
  const out = list.filter(x => SECONDARY_POSITIONS.has((x.position || "").toUpperCase()) &&
    /out|doubtful/i.test(x.status || ""));
  return { available: true, count: out.length, names: out.map(x => `${x.name} (${x.status})`) };
}

// Builds a simple ordered trend string like "Out -> Limited -> Full" (or "no change: Questionable") from the
// last few snapshots stored for this player this week.
export function computePracticeTrend(player, injuryHistory) {
  if (!injuryHistory?.length) return { available: false };
  const statuses = injuryHistory.map(snap => {
    const list = snap.byTeam?.[player.team] || [];
    const mine = list.find(x => x.name === player.name);
    return mine?.status || null;
  }).filter(Boolean);
  if (statuses.length < 2) return { available: false };
  const collapsed = statuses.filter((s, i) => i === 0 || s !== statuses[i - 1]);
  // `first`/`current` (added alongside the existing display-only `trend` string) are what let
  // lib/probability.js actually score a direction — worsening vs. improving — instead of just showing the
  // trend as text on the card and never scoring it.
  return { available: true, trend: collapsed.join(" → "), pointsSeen: statuses.length, first: statuses[0], current: statuses[statuses.length - 1] };
}
