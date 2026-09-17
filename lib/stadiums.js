// Static venue metadata — lat/long (for the weather forecast call), altitude in feet (for the altitude/
// conditioning flag), and IANA timezone (for the travel/time-zone-change factor). Roof type and surface are
// NOT duplicated here — nflverse's schedule/play-by-play already carries `roof`/`surface` per game, and that's
// the more reliable source since a stadium's surface can change (e.g. a team re-turfing) without this file
// being updated. This file only holds things that are genuinely static.
//
// Coordinates are the stadium's public address / well-known location — accurate to city/site level, which is
// all the weather forecast and haversine-distance math below need. Not surveyed to rooftop precision.
export const STADIUMS = {
  ARI: { lat: 33.5276, lon: -112.2626, altitudeFt: 1100, tz: "America/Phoenix" },
  ATL: { lat: 33.7554, lon: -84.4008, altitudeFt: 1050, tz: "America/New_York" },
  BAL: { lat: 39.2780, lon: -76.6227, altitudeFt: 20, tz: "America/New_York" },
  BUF: { lat: 42.7738, lon: -78.7870, altitudeFt: 600, tz: "America/New_York" },
  CAR: { lat: 35.2258, lon: -80.8528, altitudeFt: 750, tz: "America/New_York" },
  CHI: { lat: 41.8623, lon: -87.6167, altitudeFt: 595, tz: "America/Chicago" },
  CIN: { lat: 39.0955, lon: -84.5160, altitudeFt: 490, tz: "America/New_York" },
  CLE: { lat: 41.5061, lon: -81.6995, altitudeFt: 590, tz: "America/New_York" },
  DAL: { lat: 32.7473, lon: -97.0945, altitudeFt: 550, tz: "America/Chicago" },
  DEN: { lat: 39.7439, lon: -105.0201, altitudeFt: 5280, tz: "America/Denver" },
  DET: { lat: 42.3400, lon: -83.0456, altitudeFt: 600, tz: "America/New_York" },
  GB: { lat: 44.5013, lon: -88.0622, altitudeFt: 640, tz: "America/Chicago" },
  HOU: { lat: 29.6847, lon: -95.4107, altitudeFt: 50, tz: "America/Chicago" },
  IND: { lat: 39.7601, lon: -86.1639, altitudeFt: 715, tz: "America/New_York" },
  JAX: { lat: 30.3239, lon: -81.6373, altitudeFt: 20, tz: "America/New_York" },
  KC: { lat: 39.0489, lon: -94.4839, altitudeFt: 750, tz: "America/Chicago" },
  LA: { lat: 33.9535, lon: -118.3392, altitudeFt: 125, tz: "America/Los_Angeles" },
  LAC: { lat: 33.9535, lon: -118.3392, altitudeFt: 125, tz: "America/Los_Angeles" },
  LV: { lat: 36.0909, lon: -115.1833, altitudeFt: 2030, tz: "America/Los_Angeles" },
  MIA: { lat: 25.9580, lon: -80.2389, altitudeFt: 10, tz: "America/New_York" },
  MIN: { lat: 44.9737, lon: -93.2577, altitudeFt: 830, tz: "America/Chicago" },
  NE: { lat: 42.0909, lon: -71.2643, altitudeFt: 200, tz: "America/New_York" },
  NO: { lat: 29.9509, lon: -90.0815, altitudeFt: 10, tz: "America/Chicago" },
  NYG: { lat: 40.8135, lon: -74.0745, altitudeFt: 10, tz: "America/New_York" },
  NYJ: { lat: 40.8135, lon: -74.0745, altitudeFt: 10, tz: "America/New_York" },
  PHI: { lat: 39.9008, lon: -75.1675, altitudeFt: 40, tz: "America/New_York" },
  PIT: { lat: 40.4468, lon: -80.0158, altitudeFt: 730, tz: "America/New_York" },
  SEA: { lat: 47.5952, lon: -122.3316, altitudeFt: 20, tz: "America/Los_Angeles" },
  SF: { lat: 37.4030, lon: -121.9700, altitudeFt: 30, tz: "America/Los_Angeles" },
  TB: { lat: 27.9759, lon: -82.5033, altitudeFt: 15, tz: "America/New_York" },
  TEN: { lat: 36.1665, lon: -86.7713, altitudeFt: 440, tz: "America/Chicago" },
  WAS: { lat: 38.9076, lon: -76.8645, altitudeFt: 180, tz: "America/New_York" },
  // International venues used for London/Germany/Spain/Brazil games. Keyed separately since these aren't
  // "home" venues for any team — the schedule fetcher maps a game's `game_stadium` / `location` to one of
  // these when it doesn't match either team's own stadium.
  LON_TOTTENHAM: { lat: 51.6043, lon: -0.0665, altitudeFt: 100, tz: "Europe/London" },
  LON_WEMBLEY: { lat: 51.5560, lon: -0.2795, altitudeFt: 130, tz: "Europe/London" },
  MUNICH: { lat: 48.2188, lon: 11.6247, altitudeFt: 1700, tz: "Europe/Berlin" },
  FRANKFURT: { lat: 50.0686, lon: 8.6455, altitudeFt: 360, tz: "Europe/Berlin" },
  MADRID: { lat: 40.4362, lon: -3.5995, altitudeFt: 2100, tz: "Europe/Madrid" },
  SAO_PAULO: { lat: -23.5449, lon: -46.4732, altitudeFt: 2600, tz: "America/Sao_Paulo" }
};

// A stadium counts as "high altitude" past this threshold — Denver (5,280ft) is the only regular NFL venue
// that clears it by a wide margin; Mexico City (historically used for international games, ~7,350ft) would
// too if it's on the slate. Everything else in the league is close enough to sea level that altitude isn't a
// meaningful factor.
export const HIGH_ALTITUDE_FT = 3000;

export function haversineMiles(a, b) {
  if (!a || !b) return null;
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// Rough time-zone offset bucket by longitude band, used only to flag "meaningful time-zone change" for the
// travel factor — not meant to be a precise tz database (Intl.DateTimeFormat with the IANA name above is used
// wherever an exact offset actually matters).
export function tzHoursDiff(tzA, tzB) {
  if (!tzA || !tzB || tzA === tzB) return 0;
  try {
    const now = new Date();
    const offset = (tz) => {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(now);
      const raw = parts.find(p => p.type === "timeZoneName")?.value || "GMT+0";
      const m = raw.match(/GMT([+-]\d+)/);
      return m ? Number(m[1]) : 0;
    };
    return offset(tzA) - offset(tzB);
  } catch { return 0; }
}
