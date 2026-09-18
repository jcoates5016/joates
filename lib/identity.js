// Player identity resolution happens once, here — every factor function takes an already-resolved player
// record rather than doing its own ad hoc name lookup, which is how schema drift and mismatched-player bugs
// kept sneaking in under the old architecture.
import { normTeam } from "./teamCodes.js";

function normName(raw) {
  if (!raw) return "";
  return String(raw).toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
}
// "T.Hill" / "Tyreek Hill" both need to resolve the same way the odds feed happens to spell a name.
function shortForm(name) {
  const parts = normName(name).split(" ");
  if (parts.length < 2) return normName(name);
  return `${parts[0][0]} ${parts[parts.length - 1]}`;
}

export function buildGameLogIndex(statRows) {
  const byName = new Map();
  statRows.forEach(r => {
    const name = r.player_display_name || r.player_name || r.player;
    if (!name) return;
    const key = normName(name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(r);
  });
  return byName;
}

export function buildRosterIndex(rosterRows) {
  const byName = new Map();
  rosterRows.forEach(r => {
    const name = r.full_name || r.player_name;
    if (!name) return;
    byName.set(normName(name), {
      playerId: r.gsis_id || r.player_id, team: normTeam(r.team), position: r.position,
      birthDate: r.birth_date || r.birthdate || null
    });
  });
  return byName;
}

export function buildSnapsIndex(snapRows) {
  const byKey = new Map();
  snapRows.forEach(r => {
    const name = r.player || r.pfr_player_name;
    if (!name) return;
    const key = `${normName(name)}|${r.week}`;
    byKey.set(key, { offensePct: r.offense_pct, team: normTeam(r.team) });
  });
  return byKey;
}

export function resolvePlayer(rawName, gameLogIndex, rosterIndex) {
  const key = normName(rawName);
  let roster = rosterIndex.get(key);
  let logKey = key;
  if (!roster) {
    // Try short-form match (odds feed sometimes abbreviates first names) against the roster index.
    const short = shortForm(rawName);
    for (const [rk, rv] of rosterIndex.entries()) {
      if (shortForm(rk) === short) { roster = rv; logKey = rk; break; }
    }
  }
  return {
    name: rawName, playerId: roster?.playerId || null, team: roster?.team || null,
    position: roster?.position || null, birthDate: roster?.birthDate || null, _logKey: logKey
  };
}

export function playerGameLogs(player, gameLogIndex) {
  return gameLogIndex.get(player._logKey) || gameLogIndex.get(normName(player.name)) || [];
}
