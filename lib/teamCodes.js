// Canonical team codes (matches nflverse's `team`/`posteam`/`home_team` convention) plus every alias we've
// seen from the odds feed, ESPN, and schedule files, normalized to one code so a "team mismatch" never comes
// down to two sources spelling the same team differently.
export const CANONICAL_TEAMS = [
  "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX",
  "KC", "LA", "LAC", "LV", "MIA", "MIN", "NE", "NO", "NYG", "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN",
  "WAS"
];

const ALIASES = {
  ARI: ["ARZ", "ARIZONA", "CARDINALS"], ATL: ["FALCONS"], BAL: ["RAVENS"], BUF: ["BILLS"],
  CAR: ["CAROLINA", "PANTHERS"], CHI: ["BEARS"], CIN: ["BENGALS"], CLE: ["BROWNS"], DAL: ["COWBOYS"],
  DEN: ["BRONCOS"], DET: ["LIONS"], GB: ["GNB", "GREENBAY", "PACKERS"], HOU: ["TEXANS"], IND: ["COLTS"],
  JAX: ["JAC", "JAGUARS"], KC: ["KAN", "CHIEFS"], LA: ["LAR", "RAMS", "STL", "LOSANGELESRAMS"],
  LAC: ["SD", "SDG", "CHARGERS", "LOSANGELESCHARGERS"], LV: ["OAK", "RAIDERS", "LASVEGASRAIDERS"],
  MIA: ["DOLPHINS"], MIN: ["VIKINGS"], NE: ["NWE", "PATRIOTS"], NO: ["NOR", "SAINTS"],
  NYG: ["GIANTS", "NEWYORKGIANTS"], NYJ: ["JETS", "NEWYORKJETS"], PHI: ["EAGLES"], PIT: ["STEELERS"],
  SEA: ["SEAHAWKS"], SF: ["SFO", "49ERS", "SANFRANCISCO"], TB: ["TAM", "BUCCANEERS", "TAMPABAY"],
  TEN: ["OTI", "TITANS"], WAS: ["WSH", "WASHINGTON", "COMMANDERS", "REDSKINS"]
};

const LOOKUP = (() => {
  const m = {};
  CANONICAL_TEAMS.forEach(t => { m[t] = t; });
  Object.entries(ALIASES).forEach(([canon, aliases]) => aliases.forEach(a => { m[a] = canon; }));
  return m;
})();

export function normTeam(raw) {
  if (!raw) return null;
  const key = String(raw).trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return LOOKUP[key] || (CANONICAL_TEAMS.includes(key) ? key : key);
}
