// SportsGameOdds v2 events endpoint, on the paid Rookie tier (50 req/min, 100,000 objects/month, odds refreshed
// upstream about every 3 minutes, 77 bookmakers available — this app tracks a curated 8 of them, see
// analyze.js's BOOKS). One call per refresh; the object cost scales with events × markets returned. Whether it
// also scales with the number of bookmakerIDs requested isn't confirmed anywhere in SGO's docs (checked before
// widening past 2 books) — so the real budget-management levers are refresh frequency (see refresh.yml's cron)
// and how many bookmakerIDs get passed here. Watch actual usage in the SportsGameOdds dashboard after any
// change to either one and tune from real numbers rather than a guess.
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

// A real live refresh failed outright with a 400 for the whole request — every book, every event — because
// exactly ONE of the 8 curated bookmakerIDs (fanatics) turned out to be unavailable at this account's actual
// subscription tier, despite the tier's docs claiming 77 bookmakers are included. SportsGameOdds' error shape
// for this is specific and parseable: `{"error":"The bookmakerID <id> is unavailable at your current
// subscription tier. Upgrade to unlock"}`. Rather than let one book silently take the whole slate down again —
// whether it's fanatics again or a different book if SGO's catalog or this account's tier changes later — this
// detects that exact error, drops just the offending bookmakerID, and retries with the rest. Bounded (stops
// once bookIds is down to nothing, or after removing this many) so a genuinely broken API key can't loop forever.
const UNAVAILABLE_BOOKMAKER_RE = /bookmakerID\s+(\S+?)\s+is unavailable/i;

export async function fetchNFLEvents(sgoApiKey, bookIds, log = () => {}, _droppedSoFar = []) {
  if (!bookIds.length) throw new Error(`SportsGameOdds: every requested bookmakerID was rejected as unavailable (dropped: ${_droppedSoFar.join(", ")}) — nothing left to request.`);
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
    const unavailableMatch = body.match(UNAVAILABLE_BOOKMAKER_RE);
    if (res.status === 400 && unavailableMatch && bookIds.includes(unavailableMatch[1])) {
      const dropped = unavailableMatch[1];
      const remaining = bookIds.filter(b => b !== dropped);
      log(`SportsGameOdds rejected bookmakerID "${dropped}" as unavailable at this account's tier — dropping it and retrying with the other ${remaining.length} book(s). Update lib/analyze.js's BOOKS to remove it permanently once confirmed.`);
      return fetchNFLEvents(sgoApiKey, remaining, log, [..._droppedSoFar, dropped]);
    }
    throw new Error(`SportsGameOdds ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  if (json.success === false) throw new Error("SportsGameOdds error: " + (json.error || "unknown"));
  log(`Got ${json.data ? json.data.length : 0} events.`);
  return json.data || [];
}
