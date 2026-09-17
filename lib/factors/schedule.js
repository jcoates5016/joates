// Rest, travel, kickoff-context, and starter-change factors. Verified against a live pull of nflverse's
// games.csv before writing this: it already carries `away_rest`/`home_rest` (nflverse's own computed rest
// days per team per game — used directly instead of hand-diffing dates), `location` ("Home" vs "Neutral",
// which is exactly the international/neutral-site flag), and `away_qb_name`/`home_qb_name` (the actual
// starting QB per game, which is what makes real starter-change detection possible instead of guessing from
// injury reports).
import { normTeam } from "../teamCodes.js";
import { STADIUMS, HIGH_ALTITUDE_FT, haversineMiles, tzHoursDiff } from "../stadiums.js";

// Two teams meet at most once as this specific home/away pairing in a regular season, so season+home+away is
// enough to find the one game — no need to already know the week number going in.
export function findScheduleRow(schedule, season, homeTeam, awayTeam) {
  return schedule.find(s => s.season === season &&
    normTeam(s.home_team || s.home) === homeTeam && normTeam(s.away_team || s.away) === awayTeam) || null;
}

function venueKeyFromStadiumText(stadiumText) {
  if (!stadiumText) return null;
  const t = stadiumText.toLowerCase();
  if (t.includes("tottenham")) return "LON_TOTTENHAM";
  if (t.includes("wembley")) return "LON_WEMBLEY";
  if (t.includes("munich") || t.includes("allianz")) return "MUNICH";
  if (t.includes("frankfurt") || t.includes("deutsche bank")) return "FRANKFURT";
  if (t.includes("madrid") || t.includes("bernab")) return "MADRID";
  if (t.includes("sao paulo") || t.includes("são paulo") || t.includes("corinthians")) return "SAO_PAULO";
  return null;
}

export function computeScheduleFactor({ team, opponentTeam, homeTeam, kickoffISO, gameRow }) {
  if (!gameRow) return { available: false };
  const isHome = team === homeTeam;
  const restDays = isHome ? gameRow.home_rest : gameRow.away_rest;
  const neutral = (gameRow.location || "").toLowerCase() === "neutral";
  const venueKey = neutral ? (venueKeyFromStadiumText(gameRow.stadium) || null) : homeTeam;
  const homeStadium = STADIUMS[team], venue = venueKey ? STADIUMS[venueKey] : STADIUMS[homeTeam];

  let tzShiftHours = 0, travelMiles = 0, localHour = null, highAltitude = false;
  if (venue && homeStadium) {
    travelMiles = isHome && !neutral ? 0 : Math.round(haversineMiles(homeStadium, venue) || 0);
    tzShiftHours = isHome && !neutral ? 0 : tzHoursDiff(venue.tz, homeStadium.tz);
    highAltitude = venue.altitudeFt >= HIGH_ALTITUDE_FT;
    try { localHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: venue.tz, hour: "numeric", hour12: false }).format(new Date(kickoffISO))); } catch { /* leave null */ }
  }
  return {
    available: true,
    restDays: restDays ?? null, shortWeek: restDays != null ? restDays <= 4 : null, bye: restDays != null ? restDays >= 12 : null,
    isHome, neutralSite: neutral, travelMiles, tzShiftHours, highAltitude,
    primetime: localHour != null ? localHour >= 19 : null
  };
}

// Compares this week's listed starting QB (from the schedule row) to whichever QB has started the most games
// for that team so far this season (from the same schedule rows, since every past game row also carries the
// starter's name) — a real, data-backed "different starter than usual" flag rather than an injury-status guess.
export function computeStarterChangeFactor(team, season, week, thisWeekStarterName, schedule) {
  if (!thisWeekStarterName || week == null) return { available: false };
  const priorGames = schedule.filter(s => s.season === season && Number(s.week) < Number(week) &&
    (normTeam(s.home_team || s.home) === team || normTeam(s.away_team || s.away) === team));
  if (priorGames.length < 2) return { available: false };
  const counts = {};
  priorGames.forEach(s => {
    const name = normTeam(s.home_team || s.home) === team ? s.home_qb_name : s.away_qb_name;
    if (name) counts[name] = (counts[name] || 0) + 1;
  });
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return { available: false };
  const [usualStarter, usualCount] = entries[0];
  return {
    available: true, usualStarter, usualStarterGames: usualCount, gamesConsidered: priorGames.length,
    thisWeekStarter: thisWeekStarterName, changed: usualStarter !== thisWeekStarterName
  };
}
