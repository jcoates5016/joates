// SportsGameOdds — same v2 events endpoint as before, sized for the free "Amateur" tier (10 req/min, 2,500
// objects/month, odds refreshed upstream about every 10 minutes, 9 bookmakers which still includes both
// DraftKings and ESPN BET — the two books this app is scoped to). One call per refresh; the object cost
// scales with events × markets returned, not with how this file is written, so the real budget-management
// lever is refresh frequency (see refresh-background.js's cron) — that's a tight monthly cap, so watch actual
// usage in the SportsGameOdds dashboard for the first week or two and tune the cron from real numbers rather
// than a guess.
//
// A 429 here almost always means the per-minute or per-month cap was hit, not a bug — retried a few times
// with backoff before giving up, so a single slow tick doesn't fail the whole refresh outright.
async function fetchWithRetry(url, opts, log, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url, opts);
    if (res.status !== 429) return res;
    const wait = 2000 * (i + 1);
    log(`SportsGameOdds rate-limited (429) — waiting ${wait}ms before retry ${i + 1}/${attempts}.`);
    await new Promise(r => setTimeout(r, wait));
  }
  return fetch(url, opts);
}

export async function fetchNFLEvents(sgoApiKey, bookIds, log = () => {}) {
  const url = new URL("https://api.sportsgameodds.com/v2/events");
  url.searchParams.set("leagueID", "NFL");
  url.searchParams.set("oddsAvailable", "true");
  url.searchParams.set("bookmakerID", bookIds.join(","));
  url.searchParams.set("includeAltLines", "false");
  url.searchParams.set("includeOpenCloseOdds", "true");
  url.searchParams.set("limit", "100");
  const res = await fetchWithRetry(url.toString(), { headers: { "X-Api-Key": sgoApiKey } }, log);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 429) throw new Error(`SportsGameOdds 429: rate limit or monthly object cap hit. ${body.slice(0, 200)}`);
    throw new Error(`SportsGameOdds ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  if (json.success === false) throw new Error("SportsGameOdds error: " + (json.error || "unknown"));
  log(`Got ${json.data ? json.data.length : 0} events.`);
  return json.data || [];
}
