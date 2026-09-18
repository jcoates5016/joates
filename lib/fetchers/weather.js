// Forecast weather for outdoor games via Open-Meteo — free, no API key, no request cap that matters at this
// scale. (Note: this specific call couldn't be live-verified from the dev sandbox this was built in — its
// outbound network policy blocked api.open-meteo.com entirely, unrelated to the API itself. Netlify's own
// runtime has normal internet access, so check the refresh-background function log after your first deploy
// to confirm real forecasts are coming back, the same way we tracked down the SportsGameOdds issues earlier.)
//
// Only called for outdoor/retractable-open venues — a dome game has no weather factor worth computing.
export async function fetchForecast(lat, lon, isoDate, log = () => {}) {
  try {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", lat);
    url.searchParams.set("longitude", lon);
    url.searchParams.set("hourly", "temperature_2m,precipitation_probability,windspeed_10m,winddirection_10m");
    url.searchParams.set("temperature_unit", "fahrenheit");
    url.searchParams.set("windspeed_unit", "mph");
    url.searchParams.set("forecast_days", "16");
    url.searchParams.set("timezone", "auto");
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.hourly?.time?.length) return null;

    // Pick the forecast hour closest to kickoff.
    const target = new Date(isoDate).getTime();
    let bestIdx = 0, bestDiff = Infinity;
    json.hourly.time.forEach((t, i) => {
      const diff = Math.abs(new Date(t).getTime() - target);
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
    });
    // Forecasts past ~16 days out don't exist yet — if the closest hour we got back is more than a day away
    // from kickoff, treat it as "no usable forecast yet" rather than silently showing a meaningless number.
    if (bestDiff > 24 * 60 * 60 * 1000) return null;

    return {
      tempF: json.hourly.temperature_2m?.[bestIdx] ?? null,
      precipProb: json.hourly.precipitation_probability?.[bestIdx] ?? null,
      windMph: json.hourly.windspeed_10m?.[bestIdx] ?? null,
      windDir: json.hourly.winddirection_10m?.[bestIdx] ?? null,
      forecastHour: json.hourly.time[bestIdx]
    };
  } catch (e) {
    log(`Weather forecast failed for (${lat},${lon}) @ ${isoDate}: ${e.message}`);
    return null;
  }
}

// Historical weather for a game that already happened — Open-Meteo's free archive API, no key. This is what
// `computeWeatherSplitHistorical` (lib/factors/playerSplits.js) needs to actually work: that function reads a
// `_wasWetGame` flag off each historical game-log row, but until this existed nothing in the pipeline ever set
// that flag, so the "personal history first" branch of the weather nudge (lib/probability.js) silently never
// fired for anyone — it always fell through to the generic positional fallback. Caught while wiring up
// backtesting for the weather nudges (scripts/backtest.js), which made the dead code path obvious: there was no
// historical wet/dry data anywhere to test against.
// Returns a plain boolean read (not a probability, since this is an observed historical fact, not a forecast):
// wasWet = true if the archive shows measurable precipitation or sustained wind at/above the same 15mph
// threshold `isBadWeather` uses live. Callers should skip this entirely for dome/closed-roof games (weather
// can't matter indoors) — the caller decides that from the schedule's own `roof` field, not this function.
export async function fetchHistoricalWeather(lat, lon, isoDate, log = () => {}) {
  try {
    const dateOnly = String(isoDate).slice(0, 10);
    const url = new URL("https://archive-api.open-meteo.com/v1/archive");
    url.searchParams.set("latitude", lat);
    url.searchParams.set("longitude", lon);
    url.searchParams.set("start_date", dateOnly);
    url.searchParams.set("end_date", dateOnly);
    url.searchParams.set("daily", "precipitation_sum,windspeed_10m_max");
    url.searchParams.set("temperature_unit", "fahrenheit");
    url.searchParams.set("windspeed_unit", "mph");
    url.searchParams.set("precipitation_unit", "inch");
    url.searchParams.set("timezone", "auto");
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const precip = json.daily?.precipitation_sum?.[0];
    const windMax = json.daily?.windspeed_10m_max?.[0];
    if (precip == null && windMax == null) return null;
    // 0.04in (~1mm) is a light-but-real threshold — enough to register as an actual wet game, not sensor noise.
    return { available: true, wasWet: (precip ?? 0) >= 0.04 || (windMax ?? 0) >= 15, precipIn: precip ?? null, windMaxMph: windMax ?? null };
  } catch (e) {
    log(`Historical weather lookup failed for (${lat},${lon}) @ ${isoDate}: ${e.message}`);
    return null;
  }
}
