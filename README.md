# APEX Edge (v6 — player-props-only, graded-parlay-tier rebuild)

NFL sharp-line finder. Markets are scoped to **offensive player prop Overs only — no Moneyline, no Spread, no
game totals, no defensive player props** (tackles, sacks, interceptions by a defender aren't bet types here,
and totals/game lines were deliberately removed from this build so every ounce of model and UI effort goes into
grading individual props). That's a market-scope choice, not a data gap: **this build fully tracks and scores
defensive matchup quality** — opponent-vs-position rank, EPA matchup edge (this offense vs. that defense), full
team defensive stats — because a real edge on a player prop depends on how good the opponent's defense actually
is, not just how good the offense is in a vacuum. Every factor here is either a real computed number (backed by
a verified free data source) or an explicitly-labeled AI "scouting take" when no free in-season data exists for
it — nothing is silently faked or guessed as if it were computed.

Ranking now runs on an actual probability estimate, not a point score — see "Probability model" below for how
`lib/probability.js` turns all of this into `modelProb`/`marketProb`/`edge`/`confidence` per prop, how
`scripts/backtest.js` checks each contextual factor against real history, and how the live results ledger grades
real picks against real outcomes over time — including closing-line value, so a pick can be checked against
where the market ended up, not just whether it hit.

Price comparison and mispricing detection now run across 7 books (DraftKings, FanDuel, BetMGM, Caesars, theScore
Bet, BetRivers, PointsBet) — the SportsGameOdds Rookie tier's docs claim 77 bookmakers are included, but that
isn't uniformly true: a live refresh on this account 400'd the *entire* request (every book, every event) because
Fanatics specifically turned out to be unavailable at this tier, so it's been dropped from the tracked set. See
"Odds-fetch resilience" below for how a future case of this (a different book, or this tier changing again) no
longer takes the whole refresh down. Parlays still only ever combine legs from one shared book, so every parlay
stays placeable as one slip — from 4 candidate books (DraftKings, FanDuel, BetMGM, theScore Bet).

### Odds-fetch resilience

`fetchNFLEvents` (`lib/fetchers/odds.js`) requests all tracked bookmakerIDs in a single SportsGameOdds call.
Before this fix, if even one of them was rejected as unavailable at the account's subscription tier, SportsGameOdds
400'd the whole request — not just that one book's prices, the entire event/odds slate for that refresh. It now
recognizes that specific error shape (`"The bookmakerID <id> is unavailable at your current subscription tier"`),
drops just the offending ID, and retries with the rest, logging which one it dropped so it can be removed from
`lib/analyze.js`'s `BOOKS` permanently once confirmed (which is exactly how Fanatics was found and removed above).

The frontend leads with an **Edge Board**: a ranked feed of the sharpest player-prop edges, each with a
plain-English paragraph explaining *why* it's an edge (the matchup, the usage, the form, the weather, the venue,
the practice-participation trend — whatever actually drove the number), not just a table of raw stat chips.
Every card still has a "Full breakdown" expander underneath with every computed factor, for anyone who wants the
raw numbers.

## Probability model — how picks are actually ranked

Every prior version of this build ranked picks with `computeMispricedScore`: a hand-tuned point total (+7 if
last-3 hit rate cleared 66%, +6 for a favorable defensive matchup, and so on) that was never checked against
what actually happened. A score of 19 didn't mean anything more than "a 19 last time too" — which is the honest
reason the board could feel like it was handing out random-ish picks even though every individual factor sounded
reasonable on its own. `lib/probability.js` replaces that with one real number per bet: an estimated probability
the pick actually hits, built and ranked the way a real quant shop would do it, not a plausibility score.

**The core idea.** A sportsbook's own de-vigged consensus price (`row.refProb`, from the odds feed's `fairOdds`
across dozens of books) is already a strong estimate — books are in the business of pricing a line close to
accurate. So instead of building a probability from scratch, the model starts at the market's own number and
only moves away from it when there's real, sized evidence to justify the move:

1. **Blend in the player's own evidence.** The player's real last-10-games hit rate against *this exact line*
   (already computed correctly per-prop by `computeFormFactor`, using the real game log and the real threshold)
   gets blended toward the market number using a Bayesian-style shrinkage estimator — `marketPriorWeight` "games"
   of trust behind the market's own number, so a 2-game hot streak barely moves the estimate while a real
   10-game trend can move it a lot. This is the single biggest fix: the old system gave a 2-game fluke the exact
   same flat +7 bonus as a real, deep trend. The new one can't.
2. **Apply small, named contextual nudges** (favorable matchup, high snap share, heavy red-zone share, opponent
   secondary hurt, short week, and so on) in log-odds space, so several independent small signals add together
   instead of double-counting each other. Each nudge's size lives in `lib/modelCoeffs.js`. Four of these nudges
   are specifically about the conditions a prop is actually played under, not just the player's own numbers:
   - **Weather** — prefers the player's own personal wet/windy-weather history (`weatherHistorical`) when there's
     enough of it; falls back to a positional read (rushing props get a bump, passing/receiving props get a
     penalty) when this week's forecast (`isBadWeather`: ≥50% precip chance or ≥15 mph wind) is bad and the
     player doesn't have enough personal weather-split history to trust on its own.
   - **Venue** — cross-references the player's own dome-vs-outdoor career split against **this week's actual
     stadium roof**, not just "does he have a split" — a QB with a real dome-passing edge only gets the nudge
     the weeks he's actually playing in one.
   - **Practice-participation trend** — scores the *direction* of a player's practice-report trend across the
     week (worsening from Full → Limited → DNP penalizes, improving the other way helps), not just whether he's
     listed at all.
   - **Market steam** — magnitude-scaled now, not a flat boolean: a price that's moved 20 cents gets a bigger
     nudge than one that's moved 2 cents, capped so a single huge move can't dominate every other signal.
3. **Hard-override to near-zero** when the player himself is out or doubtful — no amount of favorable context
   makes a bet on someone who might not play a good one.

The result is `{ modelProb, marketProb, edge, confidence }` on every prop row. **`edge` (exposed as
`row.trueEdge`) is model probability minus market probability — the number to actually rank on**, and it is a
genuinely different question from `row.bestEdge` (how much better one book's price is than the field's
consensus — a "shop around" number, not a statistical one). A pick can have a great `bestEdge` and a mediocre
`trueEdge`, or the reverse; the Edge Board and Mispriced Bets rank on `trueEdge`, gated by `confidence`
(`low`/`medium`/`high`/`excluded`) so a thin sample with a lucky-looking edge number can't outrank a
well-supported one. The parlay builder (see "Parlays" below) asks a different question on purpose — "how likely
is this to actually hit," i.e. `modelProb` itself, not `modelProb` minus the market's own number — since a
parlay's whole premise is stacking the board's safest plays, not its most mispriced ones. Every card in the UI
shows both the model/market probabilities (labeled "Grade" and "Market" on the card) and which confidence tier
backs them, plus the specific factors that moved the number (`row.modelContributors`).

### Backtesting the contextual nudges

`npm run backtest` (`scripts/backtest.js`) checks whether each contextual nudge actually predicts anything,
against real multi-season nflverse history, and overwrites `lib/modelCoeffs.js` with measured, sample-size-
shrunk values. **What it can and can't prove:** SportsGameOdds' Rookie tier has no historical odds archive, so
there is no way to backtest against real historical market lines. Instead it walks forward through each season
week by week (using only data from weeks strictly before the one being tested — no lookahead) and checks whether
a player beat his *own trailing average* for that stat, a reasonable stand-in for "the market already prices in
a player's normal level" but a genuinely easier question than "beat the real closing line." A run against
2023-2025 found real signal in recency (`form_hot`), snap share, and red-zone share (each a 6-7 point lift in
hit rate) and essentially no signal in the single-season defense-vs-position rank or team EPA matchup edge (both
correctly shrunk toward ~0) — which lines up with the general finding that usage metrics are stickier week to
week than matchup-quality metrics are predictive. Coefficients with no historical feed at all (opponent secondary
injuries, O-line injuries, a teammate-out usage bump, market steam — none of which nflverse or this odds tier
publishes historically) are left at hand-set defaults and reported as untested, not disproven. Re-run it
periodically as more seasons of data accumulate; it takes under a minute per season of history.

### The results ledger — closing the feedback loop

None of the above matters if nobody ever checks whether it works. `lib/grading.js` + `lib/store.js`
(`saveWeeklyPicks`/`loadWeeklyPicks`, `loadCalibrationLedger`/`saveCalibrationLedger`) close that loop: every
refresh saves that week's prop picks (identity + the model's estimate at prediction time), and every refresh
also checks whether last week's (or this week's early) picks have finished — about 20 hours after kickoff, once
nflverse's stat file has actually posted — and grades them hit/miss against the real final stat. Graded picks
fold into an all-time calibration ledger, bucketed by confidence tier and by edge size, tracking hit rate and
Brier score (mean squared error between the stated probability and the outcome — lower is better calibrated;
0.25 is what an uninformative flat 50% guess scores). The Edge Board's track-record panel reads this ledger
directly. It starts empty on a fresh deploy — that's correct, not a bug, since it takes real games finishing
before there's anything to grade — and is the only honest answer to "is any of this actually working": if
"high confidence" picks don't hit more than "medium" or "low" ones do after a few real weeks, the tiers aren't
earning their name, and that will show up here rather than staying a permanent unknown.

### Closing-line value (CLV)

A pick's `pickPrice`/`pickBook` are captured once, the moment the pick is first saved, and never overwritten by
a later refresh (the merge step in `lib/pipeline.js` explicitly preserves them across the week) — this is what
makes it possible to answer "did the market move toward or away from this pick after it was made," a real,
independent signal from whether the pick itself hit or missed. At grading time, `lib/grading.js` looks up that
same market's last recorded price for the week from the rolling price-history series and stores it as
`closingPrice`/`closingBook`, then computes `clv = impliedProb(closingPrice) − impliedProb(pickPrice)` — a
positive number means the market moved toward this side after the pick was made (a good sign independent of the
outcome; a pick can lose and still have had real CLV, or hit with none at all). Graded picks with no recorded
closing price (a market that stopped updating, or a pick made after the last snapshot of the week) are left with
`clv: null` rather than a fabricated zero, and the calibration ledger's `avgClv` is averaged only over picks that
actually have one (`clvCount`), never silently diluted by picks with no data.

## What this build computes

- **EPA matchup edge** — this offense's EPA/play minus what the specific opponent's defense allows. The core
  "is this a good matchup" number, computed per player-prop matchup in whichever direction the prop's own player
  plays (his team's offense vs. the specific opponent's defense).
- **Opponent-vs-position rank** — how this opponent ranks league-wide in what it allows to a given position
  (e.g. "12th of 32 vs. WR"), computed from every player's game logs grouped by opponent faced.
- **Team offense AND defense efficiency** — EPA per play, success rate, pressure rate created/allowed,
  third/fourth-down rate, red-zone TD rate (both sides), pace (plays/game), turnovers/game — aggregated from
  this season's play-by-play, for both what a team does on offense and what it allows on defense.
- **Scoring environment** — both teams' own offensive EPA/play and pace, added together. A secondary read on
  game environment, independent of either side's defense — two efficient, fast-paced offenses tends to mean a
  higher-scoring game where player-prop overs run hot, on top of whatever the direct matchup edge above says.
- **Red-zone / goal-line share** — the specific player's share of their team's red-zone and goal-line touches,
  computed from play-by-play (not something the weekly stats file can give you on its own). Matches players by
  the same short-name form nflverse's play-by-play actually uses ("P.Mahomes", never "Patrick Mahomes") — an
  earlier version compared full names directly against that field and silently never matched anyone, which
  `scripts/backtest.js` caught by reporting zero real red-zone-share detections across a full season of data.
- **Two-minute-drill share** — how much of a player's usage comes in two-minute situations.
- **Form, usage, venue, weather-historical, birthday** — season/last-3/last-10/vs-opponent hit rate (with a
  literal per-game breakdown, not just the summarized rate), snap%/target share/aDOT, dome-vs-outdoor +
  venue-specific splits, wet/dry historical splits, proximity to a player's birthday — all from the player's own
  game logs, and all graded on the *actual stat this specific prop is about* (a QB's passing yards, not his
  near-zero rushing+receiving yards — every one of these splits used to hard-code the latter regardless of prop,
  which silently made a QB's own venue/weather splits meaningless). Venue and weather aren't just displayed as
  inert context here — both are actually **scored**: venue is cross-referenced against this week's real stadium
  roof, and weather prefers the player's own personal history but falls back to a positional read when this
  week's forecast is bad and personal history is thin (see "Probability model" above for the exact mechanics).
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
- **Practice-participation trend** — a trend line (e.g. "Out → Limited → Full") built from a rolling history of
  ESPN injury pulls, plus an O-line-injury-count flag. Scored on its *direction*, not just its presence — a
  player trending Full → Limited → DNP through the week is treated differently from one trending the other way,
  even though both would show up as "Limited" on the day the pull happens to run.
- **Live weather forecast** — wind/precipitation/temperature at kickoff for outdoor games, via Open-Meteo,
  scored against each prop's own personal-history-first / positional-fallback weather nudge (see above).
- **Line movement** — price/point movement across the week, from a rolling history of odds snapshots, scored as
  a magnitude-scaled market-steam nudge rather than a flat "moved or didn't."
- **Player-team accuracy + depth-chart role** — every player is resolved against nflverse's real, continuously
  updated depth-chart scrape (`depth_charts_<season>.csv`), not just the weekly roster file. This closes two
  real accuracy gaps found during this pass: (1) `roster_weekly_<season>.csv` is one row per player *per week*,
  and a traded player has one row per team — the index used to build in raw file order, so whichever row
  happened to land last won, not necessarily his current team (live-checked against 2025's Flacco/Slay/Thielen
  trades); it's now built by sorting each player's rows by week first, so the latest one always wins. (2) the
  weekly roster file can lag a same-day trade by days, while the depth-chart scrape is refreshed every few days
  and reflects it sooner — when the two disagree, the depth chart's team wins as the fresher signal, and the
  row is flagged `rosterConflict` (logged pipeline-wide as a `rosterConflicts` count, and shown on the card as
  "⚠ team recently changed"). The depth chart also gives every prop a real, checkable role chip ("WR2 of 4"),
  and lets `findKeyTeammate` (the "teammate out" tendency factor's target) prefer the depth chart's actual
  next-ranked player at that position over the old volume/targets-carries guess, falling back to that guess only
  where the scrape has no entry for a team/position.

### The one speculative bucket

Nflverse's participation dataset (which would make real personnel groupings and pass-rush counts computable)
was confirmed discontinued for in-season release partway through 2023, so coverage-scheme and personnel-package
content can't be computed — it lives only in the explicitly-labeled AI "scouting take," alongside revenge-game
and contract-year narrative. This is genuinely speculative, never scored, never treated as computed. The UI
renders it in a visually distinct dashed amber box labeled "Speculative scouting take — not computed, general
football knowledge only," separate from every other factor.

## Parlays

`lib/parlays.js` builds three kinds of parlay, all sharing the same tier structure: **Low Risk, Medium, High, and
Mega**, each tier drawing its legs from a **fixed, non-overlapping absolute probability band** on `modelProb`
rather than a shared top-N pool:

| Tier | Probability band | Legs | Sorted by |
|---|---|---|---|
| Low | 75%+ | 3 | highest `modelProb` first (safest) |
| Medium | 65–75% | 4 | highest `modelProb` first |
| High | 60–65% | 4 | highest `modelProb` first |
| Mega | 55–60% | 4 | highest payout (decimal odds) first |

Every leg everywhere is gated at a 55% floor (`MIN_LEG_PROBABILITY`, equal to Mega's own band floor) — a
coin-flip or worse doesn't belong in a build whose whole premise is "graded, real plays," even in the riskiest
tier. Because each tier draws *only* from its own probability band, a single leg can never appear in more than
one tier of the same parlay group — this was a deliberate rebuild specifically so that one leg missing in Low
Risk says nothing about whether the Medium/High/Mega legs (drawn from an entirely different, disjoint pool of
players) hit or missed. Mega no longer means "the board's biggest longshots" — every leg in every tier is still
a real, model-backed play above the 55% floor; Mega just accepts a lower floor within that requirement in
exchange for a better payout, sorted by actual decimal odds rather than by safety.

- **Risk Tiers** (cross-game) — the original parlay type: pools legs from every game on the board, capped at 2
  legs from any single game so a "board-wide" parlay can't quietly turn into one team's SGP, then splits that
  pool into the four bands above.
- **Same Game Parlays** — one Low/Medium/High/Mega set per game, built only from that game's own legs, split
  into the same four bands. A single game frequently won't have enough legs in every band to fill every tier —
  that's reported honestly (a tier simply doesn't appear) rather than backfilled with a leg that doesn't belong
  in that band. No contradiction guard is needed: this app only ever surfaces the "over"/"yes" side of every
  prop market, so there's no opposite-side pairing possible within one game to guard against.
- **Slate parlays** — one Low/Medium/High/Mega set per Sunday kickoff window (the "1:00 PM ET Slate" and "4:00
  PM ET Slate"), pooling legs across every game in that window, capped at 3 legs per game — looser than the
  cross-game cap since a slate is already scoped to a handful of games. A game's window is classified by its
  real kickoff hour converted to Eastern time (`classifyKickoffWindow`), not a hardcoded UTC offset — a fixed
  offset would silently drift by an hour after the November daylight-saving change, right in the middle of a
  season. Thursday, Sunday night, Monday, and early international Sunday kickoffs sit outside both windows and
  only ever get a Same Game Parlay.

The frontend's shuffle control still works exactly as before — it just reshuffles within each tier's own
already-computed, already-disjoint leg pool, so shuffling never breaks the band guarantee.

Every parlay (cross-game, every game's SGP, and both slates) shares one Anthropic call for its rationale
(`annotateParlaysWithAI`), using the same caching engine as the other AI note types — a parlay's note is only
regenerated when its actual legs/odds change, not on every refresh. This mattered more once Same Game Parlays
and slate parlays joined the board: with a full week's slate that can be a couple dozen parlays in one payload
instead of the original 4, so caching keeps the added coverage from meaningfully increasing Anthropic spend.

## Architecture

The refresh pipeline runs on **GitHub Actions**, not as a Netlify function. Netlify was the original plan —
via a Background Function, which gets roughly a 15-minute budget instead of a normal function's ~10-26
seconds, and this pipeline (odds + several nflverse files including full play-by-play + a weather forecast per
outdoor game + multiple sequential Claude calls) needs that room. But Background Functions turned out to
require a paid Netlify Pro plan (confirmed by hitting a 403 on the free plan, and by Netlify's own support
forum: https://answers.netlify.com/t/netlify-docs-say-level-0-supports-background-functions-this-error-says-nope/88326),
so the pipeline moved to GitHub Actions instead, which has no comparable per-run time limit at this scale and
is free for this workload.

- **`.github/workflows/refresh.yml`** — manual-only now (`workflow_dispatch` only, no `schedule:` trigger — see
  "Manual-only refresh" below for why). It checks out the repo, installs dependencies, and runs
  `scripts/refresh.js`, which is `lib/doRefresh.js` (the exact same pipeline code, unchanged) called as a
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
| SportsGameOdds (Rookie tier) | Odds across 7 tracked books (DraftKings, FanDuel, BetMGM, Caesars, theScore Bet, BetRivers, PointsBet) — see `lib/analyze.js`'s `BOOKS` | $99/month |
| nflverse (GitHub releases) | weekly player stats, rosters, snap counts, full schedule, full play-by-play, ranked depth charts | Free |
| ESPN | injury reports | Free |
| Open-Meteo | weather forecast | Free, no key |
| Anthropic API | AI analytical notes + scouting takes | Pay-as-you-go |

### Odds budget

Running on SportsGameOdds's Rookie tier: 100,000 objects/month, 50 requests/minute, upstream odds refreshed
about every 3 minutes, 77 bookmakers claimed available (this build tracks a curated 7 of them, see
`lib/analyze.js`'s `BOOKS` — widened from the original 2-book scope once it was confirmed the tier supports far
more than the ~9 the code's original comments assumed, though not literally every one of the 77: Fanatics was
found live to 400 the whole request at this tier and was removed — see "Odds-fetch resilience" above). Refreshes
are manual-only now (see "Manual-only refresh" below), so the object budget is a non-issue in practice, but if a
`schedule:` trigger ever comes back, check the SportsGameOdds dashboard for the first week after and back off
either the cron interval or the book list in `BOOKS` if usage runs hotter than expected — object cost scales with
events × markets per call, and whether it also scales with the number of bookmakerIDs requested per call isn't
confirmed anywhere in SGO's own docs. `lib/fetchers/odds.js` still retries a 429 a few times with backoff and
logs rather than crashing on failure, which costs nothing to leave in place even though it should be rare at
this tier.

One side effect of tracking more books worth knowing about: `SUSPECT_EDGE_THRESHOLD` (an 8% edge flags a row
`suspect` — see the data-quality gate below) can't tell a genuine data error apart from a book that's simply
slower to move its line than the rest of the field, which is real, bettable value, not a bug. Both look
identical past that threshold. The raw fields stay visible on every flagged row specifically so this can be
told apart by eye.

### AI note caching

`lib/store.js`'s `loadAiCache`/`saveAiCache` keep a small per-(season, week) cache in Blobs: a content hash of
exactly what got sent to Claude for each row (keyed by its market `oddID`), plus the note that came back. A row
whose real inputs haven't changed since the last refresh reuses the stored note instead of spending another API
call; only rows with genuinely new or changed factors get sent. Stale entries (a finished game, a line no longer
offered) are pruned from the cache every refresh so it can't grow unbounded across a season. Each refresh's log
line reports how many notes were reused vs. freshly generated.

A cold cache (every row's content hash changed at once — which happens for the whole board any time the
probability model or a factor's shape changes, confirmed live right after an earlier session's model rebuild)
means every row needs a fresh note in the same refresh. Rows within the props annotation pass run several at a
time (`CONCURRENCY = 4` in `lib/ai.js`) instead of strictly one after another — a live cold-cache refresh ran
past 13 minutes before this fix, almost entirely spent waiting on sequential Anthropic round-trips. The
concurrency cap is deliberate, not laziness: fully parallel would trade a slow refresh for a burst of 429s
against Anthropic's own per-minute rate limit.

### Anthropic cost controls

A real cost review (every non-suspect card getting a note, on a 30-minute auto-refresh schedule, on the most
expensive Claude tier) led to four changes, all in `lib/ai.js` unless noted:

- **Cheaper model.** `ANTHROPIC_MODEL` now defaults to `claude-haiku-4-5-20251001` instead of a Sonnet snapshot.
  Every one of these calls (prop notes, scouting takes, parlay rationale) is a "cite the real numbers you're
  given in a sentence or two" task, never deep reasoning, so Haiku's quality is indistinguishable here for a
  fraction of the per-token cost.
- **Only the top 50 rows get a note at all.** `selectAiEligible(propRows, limit)` (called once in
  `lib/pipeline.js` right after every row's `modelProb` is computed) ranks the pool of non-suspect,
  non-mismatched, model-scored props by real `modelProb` descending — i.e. genuinely "most likely to hit," not
  best edge/value — and marks the top `AI_NOTE_LIMIT` (50 by default) rows with `_aiSelected = true`.
  `annotatePropsWithAI` only considers rows carrying that flag, so the other rows on the board simply don't get
  an AI note (they still get every non-AI factor and the model's own probability/edge numbers — nothing else
  about them is degraded). Raise or lower the cap by passing a different `limit` at that call site.
- **Looser cache matching.** `roundForHash(content)` rounds every number in a row's content before it's hashed
  for cache-comparison purposes (the full-precision content is still what's actually sent to Claude on a cache
  miss): values within ±1.5 (rates, probabilities, edges) round to the nearest 0.02, mid-range values up to ±20
  (a prop's own line, wind speed) round to the nearest 2, everything larger (prices, yardage) rounds to the
  nearest 5. A book's price ticking by a cent or a forecast's wind estimate drifting by a notch no longer forces
  a fresh Anthropic call for a note that would say the same thing anyway.
- **Scouting takes are throttled to once a day.** They're the purely speculative bucket and barely change week to
  week, so there's no reason to pay to regenerate them on every refresh. `lib/pipeline.js` tracks
  `aiCache.scoutingMeta.lastFullRunAt`; when less than `SCOUTING_THROTTLE_HOURS` (24) have passed,
  `annotateScoutingTakes` runs in `{ cacheOnly: true }` mode — rows whose content hasn't changed still get their
  existing note reapplied for free, but nothing new is sent to Claude until the throttle window is up.

### Manual-only refresh

`.github/workflows/refresh.yml` no longer has a `schedule:` trigger — only `workflow_dispatch`. Combined with
"every card gets a note," an automatic 30-minute cadence was the single biggest driver of Anthropic spend, since
it multiplied every one of the controls above by "however many times a day this ran on its own." Refreshes now
only happen when triggered on purpose: the GitHub Actions "Run workflow" button, or the site's **Refresh Now**
button (same `workflow_dispatch` call, via `netlify/functions/trigger-refresh.js`). Nothing runs on a schedule
anymore. If that tradeoff changes later, re-adding a `schedule:` block to that workflow file is all it takes to
bring auto-refresh back.

## Environment variables & secrets

Split across two places now, since two different systems run this.

**GitHub repo → Settings → Secrets and variables → Actions → New repository secret:**

- `SPORTSGAMEODDS_API_KEY` — required for live data.
- `ANTHROPIC_API_KEY` — required for AI analytical notes, scouting takes, and parlay rationale. Without it,
  everything still computes; you just won't get AI commentary.
- `CURRENT_SEASON` — optional, defaults to 2026.
- `ANTHROPIC_MODEL` — optional, defaults to `claude-haiku-4-5-20251001` (see "Anthropic cost controls" above for
  why Haiku).
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
7. From here on, refreshes are manual-only — no schedule runs on its own (see "Manual-only refresh" above).
   Trigger a new refresh either from the GitHub Actions "Run workflow" button or the site's **Refresh Now**
   button whenever you want fresh data.

## Local sanity check (no API keys needed)

```
npm install
npm run dry-run
```

Runs the full pipeline against a small synthetic dataset and prints a self-check confirming every factor
category actually resolves at least once (not just that the code runs without throwing) — including
defense-vs-position, EPA-matchup-edge, opposing-secondary-injury, and the per-prop-stat venue split — and that a
non-DraftKings/theScore-Bet book can win best price now that more books are tracked. Also checks the probability
model directly: modelProb/edge/confidence are well-formed on every scored row, a player-out override collapses
the estimate near zero regardless of other factors, a thin 2-game sample stays close to the market's own number
while a real deep trend moves further, Mispriced Bets is actually sorted by real edge, the new weather/venue/
practice-trend/market-steam nudges each move the estimate in the correct direction against a shared baseline,
and the suspect-vs-stale-value split correctly separates a corroborated outlier price from an uncorroborated
one. Also checks the results ledger (`lib/grading.js`) directly: grades a synthetic hit and miss correctly,
never double-grades an already-graded pick, computes CLV correctly from a synthetic closing price, and leaves
`clv: null` (never a fabricated zero) on a pick with no recorded closing price. Also checks the parlay builder
(`lib/parlays.js`) directly: every generated tier's legs fall entirely within that tier's own probability band,
and no leg is ever reused across two tiers of the same parlay group — checked against the cross-game pool, every
game's own Same Game Parlay, and both Sunday slate parlays. Also checks the roster/depth-chart accuracy pass
directly: the roster index resolves a traded player to his latest week's team (not raw file order), the
depth-chart index resolves real ranks/group sizes, `resolvePlayer` prefers the fresher depth-chart team and
flags a genuine conflict, and `findKeyTeammate` picks the depth chart's real next-ranked player (while still
never doing so for a QB).

```
npm run backtest [season ...]
```

Pulls real multi-season nflverse history (defaults to the last 3 calendar years) and measures whether each
contextual factor in the probability model actually predicts anything, then overwrites `lib/modelCoeffs.js` with
the results. Takes network access and a minute or so per season — see "Backtesting the contextual nudges" above
for exactly what it can and can't prove.

## Data-quality gate

A real sharp mispricing against the field rarely turns up an edge bigger than a couple of points, so
`computeBestAcrossBooks` (`lib/analyze.js`) treats any row clearing `SUSPECT_EDGE_THRESHOLD` (8%) as worth a
second look before trusting it. Rather than excluding every such row outright, it checks whether the other
tracked books *corroborate* the move: if at least 2 other books have a price for this same market and roughly
two-thirds of them agree with the field's consensus within `CORROBORATION_TOLERANCE` (4%), the outlier price is
real, bettable **stale-line value** (`row.staleValue`) — a book that's simply slower to update than the rest of
the field, not a data error — and it's kept in Mispriced Bets, AI commentary, and parlay legs, marked with a
blue "📈 stale-line value" badge so it's clearly called out rather than blending in with an ordinary edge.
Without that corroboration, the row is flagged `suspect` — almost certainly a side/price mismatch somewhere in
the feed — and excluded from Mispriced Bets, AI commentary, and parlay legs. It still shows on the Edge Board
with a struck-through red "⚠ unverified" badge so you can review the raw fields (also logged) rather than the
row just silently disappearing.

## Project structure

```
lib/
  fetchers/        nflverse (stats, roster, snaps, schedule, play-by-play, depth charts), odds, weather, injuries
  factors/         every computed-factor module, wired together in factors/index.js
  identity.js      player identity resolution — roster index, depth-chart index, resolvePlayer()
  analyze.js       price comparison, best-book selection, suspect-vs-stale-value classification, prop
                   classification
  probability.js   market-anchored probability model — modelProb/marketProb/edge/confidence per row
  modelCoeffs.js   the model's logit-nudge coefficients — GENERATED by scripts/backtest.js
  grading.js       results ledger: grades completed picks, computes closing-line value (CLV), folds both into
                   the all-time calibration ledger
  parlays.js       fixed-probability-band (Low/Medium/High/Mega), leg-disjoint parlay builder — cross-game,
                   Same Game Parlays, and the two Sunday slate windows (see "Parlays" above)
  ai.js            two AI buckets: real-number analytical notes, and speculative scouting takes (plus cached
                   parlay rationale, shared across all three parlay types above)
  pipeline.js      orchestrates one full refresh end to end
  doRefresh.js     wires env vars + notes into runPipeline, saves the resulting snapshot
  store.js         Netlify Blobs wrapper (snapshot, notes, injury/price history, AI note cache — now including
                   parlays, weekly picks, calibration ledger) — works both from inside a deployed Netlify
                   function and standalone (GitHub Actions)
netlify/functions/
  data.js          serves the latest snapshot
  notes.js         load/save situational notes
  trigger-refresh.js   fires the GitHub Actions workflow_dispatch when "Refresh Now" is clicked
.github/workflows/refresh.yml   the real refresh entry point (manual dispatch only, no schedule)
scripts/
  refresh.js       runs the real pipeline (used by the GitHub Actions workflow)
  dry-run.js       runs the pipeline against synthetic demo data with a self-check (no keys needed)
  backtest.js      measures each contextual factor against real multi-season history, updates modelCoeffs.js
public/index.html  the entire frontend
```

Not betting advice.
