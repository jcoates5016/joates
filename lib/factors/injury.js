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
  return { available: true, trend: collapsed.join(" → "), pointsSeen: statuses.length, current: statuses[statuses.length - 1] };
}
