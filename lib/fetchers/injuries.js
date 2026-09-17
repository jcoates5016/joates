// ESPN's (unofficial, undocumented) team injuries endpoint — same source as before for current status. What's
// new: the caller (pipeline.js) also snapshots this into a rolling history via lib/store.js, so the injury
// factor can see a *trend* (DNP -> limited -> full participation across the week, or the reverse) instead of
// only ever seeing one point-in-time status. This file just fetches the current snapshot; the trend logic
// lives in factors/injury.js.
export async function fetchInjuries(teams, log = () => {}) {
  const out = {};
  await Promise.all(teams.map(async (team) => {
    try {
      const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${team.toLowerCase()}/injuries`);
      if (!res.ok) return;
      const json = await res.json();
      out[team] = (json.injuries || json.items || []).map(x => ({
        name: x.athlete?.displayName || x.displayName,
        position: x.athlete?.position?.abbreviation,
        status: x.status || x.type?.description,
        detail: x.details?.detail || x.shortComment
      }));
    } catch (e) { log(`Injury fetch failed for ${team}: ${e.message}`); }
  }));
  return out;
}
