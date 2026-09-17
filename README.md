# APEX Edge (v5 — full matchup rebuild, redesigned frontend)

NFL sharp-line finder. Markets are scoped to **Total (Over) game lines and offensive player prop Overs only —
no Moneyline, no Spread, no defensive player props** (tackles, sacks, interceptions by a defender aren't bet
types here). That's a market-scope choice, not a data gap: **this build fully tracks and scores defensive
matchup quality** — opponent-vs-position rank, EPA matchup edge (this offense vs. that defense), full team
defensive stats — because a real edge on a total or an offensive prop depends on how good the opponent's
defense actually is, not just how good the offense is in a vacuum. Every factor here is either a real computed
number (backed by a verified free data source) or an explicitly-labeled AI "scouting take" when no free
in-season data exists for it — nothing is silently faked or guessed as if it were computed.

Price comparison and mispricing detection now run across 8 books (DraftKings, FanDuel, BetMGM, Caesars, theScore
Bet, Fanatics, BetRivers, PointsBet) — the SportsGameOdds Rookie tier actually includes 77 bookmakers, not the
~9 this build's original comments assumed (that number was left over from the free Amateur tier it started on).
Parlays still only ever combine legs from one shared book, so every parlay stays placeable as one slip — just
from 4 candidate books now (DraftKings, FanDuel, BetMGM, theScore Bet) instead of 2.

The frontend leads with an **Edge Board**: a ranked feed of the sharpest game-line and player-prop edges, each
with a plain-English paragraph explaining *why* it's an edge (the matchup, the usage, the form, the weather,
the referee — whatever actually drove the number), not just a table of raw stat chips. Every card still has a
"Full breakdown" expander underneath with every computed factor, for anyone who wants the raw numbers.

## What this build computes

- **EPA matchup edge** — this offense's EPA/play minus what the specific opponent's defense allows. The core
  "is this a good matchup" number, computed per player-prop matchup and per game line (both directions: home
  offense vs. away defense, and away offense vs. home defense).
- **Opponent-vs-position rank** — how this opponent ranks league-wide in what it allows to a given position
  (e.g. "12th of 32 vs. WR"), computed from every player's game logs grouped by opponent faced.
- **Team offense AND defense efficiency** — EPA per play, success rate, pressure rate created/allowed,
  third/fourth-down rate, red-zone TD rate (both sides), pace (plays/game), turnovers/game — aggregated from
  this season's play-by-play, for both what a team does on offense and what it allows on defense.
- **Scoring environment** — both teams' own offensive EPA/play and pace, added together. A secondary read on
  game environment, independent of either side's defense — two efficient, fast-paced offenses tends to mean a
  game where totals and player-prop overs run hot, on top of whatever the direct matchup edge above says.
- **Red-zone / goal-line share** — the specific player's share of their team's red-zone and goal-line touches,
  computed from play-by-play (not something the weekly stats file can give you on its own).
- **Two-minute-drill share** — how much of a player's usage comes in two-minute situations.
- **Form, usage, venue, weather-historical, birthday** — season/last-3/last-10/vs-opponent hit rate (with a
  literal per-game breakdown, not just the summarized rate), snap%/target share/aDOT, dome-vs-outdoor +
  venue-specific splits, wet/dry historical splits, proximity to a player's birthday — all from the player's own
  game logs, and all graded on the *actual stat this specific prop is about* (a QB's passing yards, not his
  near-zero rushing+receiving yards — every one of these splits used to hard-code the latter regardless of prop,
  which silently made a QB's own venue/weather splits meaningless).
- **Opposing-secondary injury** — how many of the opponent's own cornerbacks/safeties are out or doubtful,
  applied to that opponent's passing-game props (receiving/passing yards, receptions, receiving/passing TDs).
  Deliberately generic (every pass-catcher in the game sees the same signal) rather than a specific "this WR's
  man corner is hurt" claim — nflverse's participation/coverage-assignment data, the only thing that could make
  a real 1-on-1 matchup computable, was confirmed discontinued for in-season release (see the speculative-bucket
  note below).
- **Schedule/travel** — rest days, short week, bye, travel distance, time-zone shift, altitude, neutral-site/
  international games, primetime — pulled directly from nflverse's schedule file.
- **Starter-QB-change detection** — compares this week's listed starter to whichever QB has started most of a
  team's games this season, both from the same real schedule feed.
- **Referee tendency** — real historical over/under bias per referee, computed from nflverse's own `referee` +
  `total`/`total_line` columns. Requires at least 8 historical games for that referee before it shows anything.
- **Injury trend** — a practice-participation trend line (e.g. "Out → Limited → Full") built from a rolling
  history of ESPN injury pulls, plus an O-line-injury-count flag.
- **Live weather forecast** — wind/precipitation/temperature at kickoff for outdoor games, via Open-Meteo.
- **Line movement** — price/point movement across the week, from a rolling history of odds snapshots.
- **Key-number proximity** — how close a total sits to 3, 7, 10, 6, or 4.

### The one speculative bucket

Nflverse's participation dataset (which would make real personnel groupings and pass-rush counts computable)
was confirmed discontinued for in-season release partway through 2023, so coverage-scheme and personnel-package
content can't be computed — it lives only in the explicitly-labeled AI "scouting take," alongside revenge-game
and contract-year narrative. This is genuinely speculative, never scored, never treated as computed. The UI
renders it in a visually distinct dashed amber box labeled "Speculative scouting take — not computed, general
football knowledge only," separate from every other factor.

## Architecture

The refresh pipeline runs on **GitHub Actions**, not as a Netlify function. Netlify was the original plan —
via a Background Function, which gets roughly a 15-minute budget instead of a normal function's ~10-26
seconds, and this pipeline (odds + several nflverse files including full play-by-play + a weather forecast per
outdoor game + multiple sequential Claude calls) needs that room. But Background Functions turned out to
require a paid Netlify Pro plan (confirmed by hitting a 403 on the free plan, and by Netlify's own support
forum: https://answers.netlify.com/t/netlify-docs-say-level-0-supports-background-functions-this-error-says-nope/88326),
so the pipeline moved to GitHub Actions instead, which has no comparable per-run time limit at this scale and
is free for this workload.

- **`.github/workflows/refresh.yml`** — a scheduled GitHub Actions workflow (every 30 minutes, matched to the
  odds budget below) plus `workflow_dispatch` for on-demand runs. It checks out the repo, installs dependencies, and
  runs `scripts/refresh.js`, which is `lib/doRefresh.js` (the exact same pipeline code, unchanged) called as a
  standalone script instead of from inside a Netlify function.
- **Netlify Blobs**, still the single source of truth for the latest snapshot, situational notes, and the
  rolling per-week injury/price histories. The twist: a plain Node script running in GitHub Actions has no
  Netlify runtime to auto-inject blob-store credentials, so `lib/store.js` switches to `@netlify/blobs`'
  documented "manual configuration" mode (an explicit site ID + personal access token, both passed as GitHub
  secrets) whenever it detects it's not running inside a deployed Netlify function. Same store, same data,
  either way.
- **Netlify** now only does three small things: serves the static frontend, `netlify/functions/data.js` reads
  the latest snapshot straight from Blobs, and `netlify/functions/notes.js` loads/saves situational notes —
  both comfortably normal, fast functions.
- **`netlify/functions/trigger-refresh.js`** — what the "Refresh Now" button actually calls. It's a small, fast
  Netlify function whose only job is firing a GitHub Actions `workflow_dispatch` via the GitHub API and
  returning immediately (GitHub's API doesn't hand back a run ID synchronously, so this is a fire-and-confirm,
  not a fire-and-track). The frontend then polls `/data` the same way it always did, watching for a new
  `generatedAt` timestamp — same UX as before, just triggering a GitHub Actions run under the hood instead of
  a Netlify Background Function.

## Data sources

| Source | What it provides | Cost |
|---|---|---|
| SportsGameOdds (Rookie tier) | Odds across 8 tracked books (DraftKings, FanDuel, BetMGM, Caesars, theScore Bet, Fanatics, BetRivers, PointsBet) — see `lib/analyze.js`'s `BOOKS` | $99/month |
| nflverse (GitHub releases) | weekly player stats, rosters, snap counts, full schedule, full play-by-play | Free |
| ESPN | injury reports | Free |
| Open-Meteo | weather forecast | Free, no key |
| Anthropic API | AI analytical notes + scouting takes | Pay-as-you-go |

### Odds budget

Running on SportsGameOdds's Rookie tier: 100,000 objects/month, 50 requests/minute, upstream odds refreshed
about every 3 minutes, 77 bookmakers available (this build tracks a curated 8 of them, see `lib/analyze.js`'s
`BOOKS` — widened from the original 2-book scope once it was confirmed the tier actually supports far more than
the ~9 the code's original comments assumed). The shipped schedule (`.github/workflows/refresh.yml`,
`schedule: "*/30 * * * *"` — every 30 minutes) is sized for the original 2-book budget with real headroom to
spare; object cost scales with events × markets per call, and whether it also scales with the number of
bookmakerIDs requested per call isn't confirmed anywhere in SGO's own docs (checked before widening past 2
books). Check the SportsGameOdds dashboard closely for the first week after this change and back off either the
cron (e.g. hourly) or the book list in `BOOKS` if usage runs hotter than expected. `lib/fetchers/odds.js` still
retries a 429 a few times with backoff and logs rather than crashing on failure, which costs nothing to leave in
place even though it should be rare at this tier.

One side effect of tracking more books worth knowing about: `SUSPECT_EDGE_THRESHOLD` (an 8% edge flags a row
`suspect` — see the data-quality gate below) can't tell a genuine data error apart from a book that's simply
slower to move its line than the rest of the field, which is real, bettable value, not a bug. Both look
identical past that threshold. The raw fields stay visible on every flagged row specifically so this can be
told apart by eye.

### AI note caching

Every prop, game line, and scouting take gets an AI note on every refresh — no more top-N slice — which raised
the natural question of Anthropic spend per refresh. `lib/store.js`'s `loadAiCache`/`saveAiCache` keep a small
per-(season, week) cache in Blobs: a content hash of exactly what got sent to Claude for each row (keyed by its
market `oddID`), plus the note that came back. A row whose real inputs haven't changed since the last refresh —
which is most of the board, most half-hours — reuses the stored note instead of spending another API call; only
rows with genuinely new or changed factors get sent. Stale entries (a finished game, a line no longer offered)
are pruned from the cache every refresh so it can't grow unbounded across a season. Each refresh's log line
reports how many notes were reused vs. freshly generated.

## Environment variables & secrets

Split across two places now, since two different systems run this.

**GitHub repo → Settings → Secrets and variables → Actions → New repository secret:**

- `SPORTSGAMEODDS_API_KEY` — required for live data.
- `ANTHROPIC_API_KEY` — required for AI analytical notes, scouting takes, and parlay rationale. Without it,
  everything still computes; you just won't get AI commentary.
- `CURRENT_SEASON` — optional, defaults to 2026.
- `ANTHROPIC_MODEL` — optional, defaults to `claude-sonnet-4-5-20250929`.
- `NETLIFY_SITE_ID` — your Netlify site's ID (Site configuration → General → Site details → Site ID).
- `NETLIFY_BLOBS_TOKEN` — a Netlify personal access token (User settings → Applications → New access token).
  This is what lets the GitHub Actions job write into the same Blobs store your Netlify site reads from.

**Netlify site → Site configuration → Environment variables:**

- `GH_PAT` — a GitHub personal access token (classic, `repo` + `workflow` scopes, or a fine-grained token with
  "Actions: read and write" on this repo) — lets `trigger-refresh.js` fire the workflow when someone clicks
  "Refresh Now".
- `GH_OWNER` — your GitHub username or org.
- `GH_REPO` — this repo's name.
- `GH_WORKFLOW_FILE` — optional, defaults to `refresh.yml`.
- `GH_BRANCH` — optional, defaults to `main`.

## Deploying

1. Push this project to a GitHub repo.
2. In Netlify: New site from Git → pick the repo. Build command `npm install`, publish directory `public`,
   functions directory `netlify/functions` (all already set in `netlify.toml`, so the defaults should just
   work).
3. Add the four `GH_*` environment variables above in Netlify's Site configuration → Environment variables,
   then redeploy (Deploys → Trigger deploy) so the functions pick them up.
4. Add the six secrets above in the GitHub repo's Settings → Secrets and variables → Actions.
5. Kick off a first run manually: GitHub repo → Actions tab → "Refresh APEX Edge data" workflow → Run workflow.
   Watch it in the Actions tab — a green check means it wrote a snapshot to Blobs; a red X will show you
   exactly which step failed and why.
6. Open the Netlify site, go to the Setup tab to confirm the factor list and env vars, then click **Refresh
   Now** to confirm the button-triggered path works too (it should show up as a new run in the GitHub Actions
   tab within a few seconds).
7. From here on, the 30-minute schedule in `.github/workflows/refresh.yml` keeps data fresh automatically, and
   "Refresh Now" is there for anything off-cycle.

## Local sanity check (no API keys needed)

```
npm install
npm run dry-run
```

Runs the full pipeline against a small synthetic dataset and prints a self-check confirming every factor
category actually resolves at least once (not just that the code runs without throwing) — including
defense-vs-position, EPA-matchup-edge, opposing-secondary-injury, and the per-prop-stat venue split — that a
non-DraftKings/theScore-Bet book can win best price now that more books are tracked, and that every game line
is a Total (never a Moneyline or Spread row).

## Data-quality gate

A real sharp mispricing against the field rarely turns up an edge bigger than a couple of points. If a row's
edge exceeds 8%, it's flagged `suspect` — almost certainly a side/price mismatch somewhere in the feed rather
than a real price — and excluded from Mispriced Bets, AI commentary, and parlay legs. It still shows in Game
Lines/Player Props with a struck-through red "⚠ unverified" badge so you can review the raw fields (also
logged) rather than the row just silently disappearing. Worth re-reading alongside the odds-budget note above:
past this threshold, this gate can't distinguish a data error from a book that's just slow to move its line.

## Project structure

```
lib/
  fetchers/        nflverse (stats, roster, snaps, schedule, play-by-play), odds, weather, injuries
  factors/         every computed-factor module, wired together in factors/index.js
  analyze.js       price comparison, best-book selection, arb detection, prop classification
  parlays.js       risk-tiered parlay builder
  ai.js            two AI buckets: real-number analytical notes, and speculative scouting takes
  pipeline.js      orchestrates one full refresh end to end
  doRefresh.js     wires env vars + notes into runPipeline, saves the resulting snapshot
  store.js         Netlify Blobs wrapper (snapshot, notes, injury history, price history, AI note cache) — works both from
                   inside a deployed Netlify function and standalone (GitHub Actions)
netlify/functions/
  data.js          serves the latest snapshot
  notes.js         load/save situational notes
  trigger-refresh.js   fires the GitHub Actions workflow_dispatch when "Refresh Now" is clicked
.github/workflows/refresh.yml   the real refresh entry point (scheduled + manual dispatch)
scripts/
  refresh.js       runs the real pipeline (used by the GitHub Actions workflow)
  dry-run.js       runs the pipeline against synthetic demo data with a self-check (no keys needed)
public/index.html  the entire frontend
```

Not betting advice.
