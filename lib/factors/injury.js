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

const FRONT_SEVEN_POSITIONS = new Set(["DE", "DT", "NT", "DL", "LB", "ILB", "OLB", "EDGE"]);

// The run-game mirror of computeOpposingSecondaryInjury above — same logic, same generic (not player-specific)
// scope, same reasoning for why it stops at "how many are out" rather than claiming a specific gap-fit matchup:
// a hurt defensive line/linebacker corps is a real, well-known tailwind for the OPPOSING team's rushing props,
// and there was no equivalent to the pass-game version until this was added (an asymmetry caught while reviewing
// what else could benefit the model — the pass side had this signal, the run side didn't, for no real reason).
export function computeOpposingFrontSevenInjury(opponentTeam, injuriesByTeam) {
  const list = injuriesByTeam[opponentTeam] || [];
  if (!list.length) return { available: false };
  const out = list.filter(x => FRONT_SEVEN_POSITIONS.has((x.position || "").toUpperCase()) &&
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

// Status-escalation watch: every player whose EARLIEST-seen status this week (across the rolling snapshots
// lib/store.js has been saving on every refresh) was Questionable, but whose status as of THIS refresh has
// worsened to Doubtful or Out. This is a different question from computePracticeTrend above — that's a
// per-player factor scored into one player's own model probability; this is a standalone, whole-slate watch list
// (every team, every player) meant to be its own view, not folded into a single card, per Jon's ask: "add a
// separate tab for players that were questionable upon earlier runs, but are now listed doubtful or out."
// `injuryHistory` already includes this refresh's own just-appended snapshot as its last entry (see
// lib/store.js's appendInjurySnapshot + loadInjuryHistory, called back-to-back in lib/pipeline.js) — walking it
// oldest-first (the array's natural push order) finds the real first-seen status without needing a second,
// separately-passed "current" snapshot.
const ESCALATION_RANK = { questionable: 1, doubtful: 2, out: 3 };
function escalationRank(status) {
  return ESCALATION_RANK[(status || "").toLowerCase()] ?? null;
}

export function computeInjuryEscalations(injuryHistory) {
  if (!injuryHistory?.length) return [];
  const out = [];
  const seen = new Set();
  for (const snap of injuryHistory) {
    for (const [team, list] of Object.entries(snap.byTeam || {})) {
      for (const p of list) {
        const key = `${team}|${p.name}`;
        if (seen.has(key)) continue;
        // First snapshot this player appears in at all — this IS his earliest-seen status this week.
        const firstRank = escalationRank(p.status);
        if (firstRank !== 1) { seen.add(key); continue; } // only "started Questionable" is the case we're watching
        seen.add(key);
        // Now find his LATEST status: the most recent snapshot (scanning back from the end) that lists him.
        let currentStatus = p.status, currentDetail = p.detail || null;
        for (let i = injuryHistory.length - 1; i >= 0; i--) {
          const row = (injuryHistory[i].byTeam?.[team] || []).find(x => x.name === p.name);
          if (row) { currentStatus = row.status; currentDetail = row.detail || null; break; }
        }
        const currentRank = escalationRank(currentStatus);
        if (currentRank != null && currentRank > firstRank) {
          out.push({ name: p.name, team, position: p.position || null, firstStatus: p.status, currentStatus, detail: currentDetail });
        }
      }
    }
  }
  return out;
}
