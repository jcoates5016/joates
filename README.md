# APEX Edge (v6 — player-props-only, graded-parlay-tier rebuild)

NFL sharp-line finder. Markets are scoped to **offensive player prop Overs only — no Moneyline, no Spread, no
game totals, no defensive player props** (tackles, sacks, interceptions by a defender aren't bet types here,
and totals/game lines were deliberately removed from this build so every ounce of model and UI effort goes into
grading individual props). That's a market-scope choice, not a data gap: **this build fully tracks and scores
defensive matchup quality** — opponent-vs-position rank, EPA matchup edge (this offense vs. that defense), full
team defensive stats — because a real edge on a player prop depends on how good the opponent's defense actually
is, not just how good the offense is in a vacuum. Every factor here is a real computed number, backed by a
verified free data source — nothing is silently faked or guessed as if it were computed, and there's no AI/LLM
layer anywhere in this build filling gaps with narrative in place of a real number (see "No AI layer" below).

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

## Interface

`public/index.html`'s visual design was redone from scratch around an Apple Stocks-app-style language: system
fonts (`-apple-system`, no external font fetch — one less network dependency for the page to load), a true-black
surface with Apple's own dark-mode system accent colors (systemGreen/systemRed/systemBlue/systemOrange), hairline
separators and soft shadows instead of heavy borders, larger rounded corners, pill-shaped buttons and a
segmented-control nav bar, and tabular-numeral monospace for anything that reads like a live figure (a grade %, a
price, an edge). Every existing element id/class name was kept as-is — this was a styling pass, not a rebuild —
so no JS wiring changed. **Top Picks** (above) is the new default landing tab, ahead of the Edge Board, since it's
meant to be the fastest "what should I actually look at this week" read.

### Injury Watch

A separate tab (`lib/factors/injury.js`'s `computeInjuryEscalations`, rendered in `#view-watch`) tracking a
specific, narrow event: a player whose EARLIEST-seen status on a refresh this week was Questionable, but whose
status as of the latest refresh has worsened to Doubtful or Out. This is deliberately not "who's hurt right
now" (every player's own card already shows that) — it's "who got *worse* since an earlier look this week,"
built from the same rolling `injuryHistory` snapshots `computePracticeTrend` already uses, just read across
every team at once instead of folded into one player's own reasoning. Empty most of the time (a real escalation
is a genuinely uncommon event, and it's always empty right after a fresh deploy or in demo mode — there's no
multi-refresh history yet to compare against) — that's the correct, honest state, not a bug.

### Teammate-out usage tendency now gates on CURRENT injury status

`computeTeammateOutTendency` (`lib/factors/playerSplits.js`) took an `injuriesByTeam` parameter from day one but
never actually read it — "without the teammate" was decided purely from whether the teammate's own game log had
a row for that week at all (a bye, a benching, a trade, an old injury — any absence counted the same), with zero
connection to whether he's actually playing *this week*. That produced real, confusing live output: a writeup
reading "Without Omarion Hampton on the field, his numbers jump to X" for a game where Hampton was active and
expected to play, just because some unrelated week in the log happened to be missing him. It now checks the
teammate's live status from this refresh's own ESPN injury pull and only fires when he's currently listed Out,
Doubtful, or **Questionable** — Questionable counts as "not fully expected to play" here, the same bar
`computeOLineInjuryFlag` already used. The historical with/without split itself (the actual games-log math) is
unchanged; only the gate on whether it's even worth showing changed.

### Odds-fetch resilience

`fetchNFLEvents` (`lib/fetchers/odds.js`) requests all tracked bookmakerIDs in a single SportsGameOdds call.
Before this fix, if even one of them was rejected as unavailable at the account's subscription tier, SportsGameOdds
400'd the whole request — not just that one book's prices, the entire event/odds slate for that refresh. It now
recognizes that specific error shape (`"The bookmakerID <id> is unavailable at your current subscription tier"`),
drops just the offending ID, and retries with the rest, logging which one it dropped so it can be removed from
`lib/analyze.js`'s `BOOKS` permanently once confirmed (which is exactly how Fanatics was found and removed above).

### Pregame-only filtering

Real live bug, confirmed from an actual bad result: a refresh run mid-game pulled SportsGameOdds' current
odds for a game already underway, and the pipeline treated that as a fresh pregame edge. Once a game kicks off,
a book's own "line" for a player prop is no longer a fixed pregame market — it's continuously adjusted against
what the player has already produced in the game so far, and can move well away from where it opened
(SportsGameOdds keeps serving it as long as the book still has it up). Reading that as a sharp edge, or —worse —
letting it be the number a pick gets graded against, compares the model's pregame read to a completely different,
in-play question and drags the whole track record down with noise that has nothing to do with whether the model
is actually any good.

`filterPregameEvents` (`lib/pipeline.js`) fixes this at the source: every refresh drops any event whose kickoff
isn't still in the future, before a single prop row gets built from it — a game simply disappears from the board
the moment it kicks off, live or after. An event with no resolvable kickoff time is dropped too, not kept; "can't
confirm this is still pregame" fails exactly the same way "confirmed already started" does. This only runs live
(`!demo` — demo mode's fixture events use fixed future dates and have no "live" state to filter). Because a
pick's `line`/`pickPrice` is captured once, the first time that `oddID` is ever saved (see "The results ledger"
below), this bug could permanently bake a live number into a graded pick before this fix existed — if your
season-to-date track record looks worse than expected, some of it may be picks that were only ever captured
mid-game under the old behavior.

Every pick/parlay saved from this fix onward also carries a `capturedAt` timestamp (`buildGradablePicks` /
`buildGradableParlays`, both in `lib/pipeline.js`), set once and preserved forever by the same merge logic that
protects `pickPrice`/`pickBook`. Its presence alone proves the pick was built from an event that had already
passed `filterPregameEvents` — permanent, no heuristic needed for anything saved going forward. See "Cleaning up
live-line contamination in old data" below for how to deal with what was already saved before this fix existed.

### Cleaning up live-line contamination in old data

`scripts/clean-live-line-contamination.js` is a one-off maintenance script for exactly the situation above: old
picks/parlays saved before the `capturedAt` fix existed, where some unknown fraction may have been captured
mid-game instead of pregame. It goes through every stored `picks-*.json` / `parlays-*.json` file in the
`apex-edge-history` Blobs store and, for anything with no `capturedAt` already proving it pregame, falls back to
checking `lib/store.js`'s per-week price-history series: if a prop has at least one recorded price snapshot from
before its own kickoff, it must have already been on the board — and therefore already captured — during a real
pregame refresh, so it's kept; otherwise the first (and only) time this app ever saw it was already mid-game or
later, so it's dropped. A parlay is only kept whole if every one of its legs passes. This can't be perfect (the
price-history series only keeps the last 12 snapshots per prop, so a prop refreshed more than 12 times before its
own kickoff could look contaminated when it wasn't), but it errs toward dropping real data rather than keeping
bad data.

It's **safe by default** — run it with no flags and it only prints what it would keep/drop and the resulting
rebuilt all-time hit rate, without writing anything. Add `--apply` to actually rewrite the stored data and rebuild
`calibration-ledger.json` from the survivors, once the dry-run numbers look right. The rebuild produces BOTH
ledgers described in "The results ledger" above — the full "everything evaluated" one and, nested under it, a
`.recommended` one folded only from surviving picks where `wasEdgeBoard` was true — so the Track Record panel's
"recommended" number has real history to show immediately after deploying, rather than starting from zero.

There's a companion, also-read-only diagnostic — `scripts/diagnose-accuracy.js` — for going one level deeper once
you're past "is this just live-line noise": it breaks the surviving picks down by prop type, confidence tier,
edge size, and modelProb decile, and separates "everything the app ever evaluated" from "what was actually
flagged as an Edge Board recommendation" (the same `wasEdgeBoard` split as above). Run it the same way, no flags
needed (it never writes anything). This is what surfaced the Anytime TD problem described below.

```
NETLIFY_SITE_ID=... NETLIFY_BLOBS_TOKEN=... node scripts/clean-live-line-contamination.js
NETLIFY_SITE_ID=... NETLIFY_BLOBS_TOKEN=... node scripts/clean-live-line-contamination.js --apply
```

Same two values GitHub Actions already uses for the real refresh — `NETLIFY_SITE_ID` is visible any time in
Netlify's site settings, `NETLIFY_BLOBS_TOKEN` is a personal access token (reuse the one already generated, or
make a fresh one in Netlify's user settings just for this one run). Since `--apply` permanently rewrites the live
results ledger, always read the dry-run output first — it lists exactly which picks/parlays would be dropped and
why, plus the rebuilt hit rate broken down by confidence tier.

A third read-only diagnostic, `scripts/analyze-yesterday.js [YYYY-MM-DD] [stake]`, looks at one specific day's
games: which actual Edge Board recommendations hit, what the app's own saved parlay attempts did, and — as a
hindsight "what if" number only — what combining every recommended pick that hit into one parlay would have
paid. A fourth, `scripts/reverse-engineer-yesterday.js [YYYY-MM-DD]`, is the full-universe version of that same
day (every graded prop, Anytime TD included, not just recommendations), broken down by prop type, confidence,
edge size, and both the model's and the market's own probability deciles.

### Recording which factors actually fired on each pick (`firedFactors`)

Until this was added, the results ledger recorded WHETHER a pick hit but never WHICH of `lib/probability.js`'s
real nudges (red-zone share, matchup edge, weather, etc.) were actually behind its number — meaning no amount of
real graded history piling up could ever answer "do picks where `redzone_share` fired actually hit more than
ones where it didn't." `buildGradablePicks` (`lib/pipeline.js`) now saves `firedFactors`: just the coefficient
keys that fired for that specific pick (e.g. `["form_hot", "redzone_share"]`), not the full label/weight — the
weight each key carried at the time is always recoverable from `lib/modelCoeffs.js`'s `MODEL_COEFFS`, so keeping
this small was preferred over duplicating that. Captured once, at the same moment as `pickPrice`/`pickBook`, and
preserved the same "never overwritten by a later refresh" way (a later refresh's factor set — fresh injury news,
an updated forecast — isn't what the model saw when this pick was actually flagged). Any pick saved before this
field existed has no `firedFactors` on it; a real per-factor hit-rate breakdown against LIVE results (as opposed
to `scripts/backtest.js`'s "beat your own trailing average" historical proxy) only becomes possible for picks
saved after this shipped, and needs a real number of graded weeks before it says anything trustworthy — the same
"don't draw conclusions from one day" caveat that applies everywhere else in this README.

The frontend leads with an **Edge Board**: a ranked feed of the sharpest player-prop edges, each with a
plain-English paragraph explaining *why* it's an edge (the matchup, the usage, the form, the weather, the venue,
the practice-participation trend — whatever actually drove the number), not just a table of raw stat chips.
Every card still has a "Full breakdown" expander underneath with every computed factor, for anyone who wants the
raw numbers.

### The `wasEdgeBoard` bug — most of history never got a real recommendation decision

`lib/pipeline.js`'s merge step, on every refresh, used to carry a graded pick's `wasEdgeBoard` flag forward with
`if (existing) p.wasEdgeBoard = existing.wasEdgeBoard;` — which only checks that `existing` (the saved pick
object) is truthy, not that `existing.wasEdgeBoard` itself ever got set to a real `true`/`false`. The very first
time a pick was saved before `wasEdgeBoard` had a real value on it, that `undefined` got copied forward on every
later refresh, forever — and since the Track Record panel and Edge Board history only ever treat a truthy
`wasEdgeBoard` as a real recommendation, `undefined` behaved identically to a rejection. A full-history audit
(`scripts/audit-wasedgeboard.js`, read-only) found this had hit **531 of 559 graded picks (95%) all-time** —
meaning the "recommended-only" track record shown for most of this app's history was built from a tiny, mostly
meaningless leftover sample (14 true, 14 false) rather than the real one.

Fixed to `if (existing?.wasEdgeBoard != null) p.wasEdgeBoard = existing.wasEdgeBoard;` — only carries the flag
forward when it was actually ever resolved. `scripts/backfill-wasedgeboard.js` (dry-run/`--apply`, same pattern
as `clean-live-line-contamination.js`) then recomputed the correct `wasEdgeBoard` for every affected pick — both
graded and still-live — from its already-stored `edge`/`confidence` against the current `minEdgeFor()`, and
rebuilt `calibrationLedger.recommended` from scratch via `foldIntoLedger`/`summarizeLedger` so the ledger's totals
match the corrected per-pick flags exactly rather than accumulating on top of the old wrong ones. Run against the
real production data, this recovered **215 previously-invisible real historical recommendations**, turning the
honest all-time recommended-only track record into **229 picks, 83 hits (36.2%), Brier 0.2695** — high confidence
71/176 (40.3%), medium confidence 12/53 (22.6%). This was the first statistically coherent picture this app has
ever had of its own real recommendations (high outperforming medium, as it should) — the earlier "medium
confidence somehow worse than low" anomaly documented elsewhere in this README turned out to be fully explained
by Anytime TD contamination of the medium tier plus this bug, not a real defect in the confidence tiers
themselves. `scripts/lookup-players.js` (read-only) was added alongside these to look up exactly what a specific
player's saved props showed for a given date — useful for "why wasn't I alerted on X" questions, though it can't
recover `teamMismatch`/`suspect` (never persisted) or show anything for a prop that never entered the ledger at
all (missing trailing data, an unresolved identity, or the model marking it unavailable).

**`MIN_TRUE_EDGE_MEDIUM = 0.10`** (`lib/pipeline.js`/`lib/topPicks.js`) followed directly from this corrected
data: medium-confidence picks now need a real 10-point edge to count as a recommendation (vs. the 3-point
baseline), the same "raise the bar on the specific tier the real data flagged as weak" philosophy Anytime TD's
5x threshold already established — a gentler ~3.3x multiplier since medium confidence isn't as catastrophically
bad as Anytime TD was. This is a reasoned starting point, not itself backtested (no historical `wasEdgeBoard`
ledger existed before this fix created one) — worth revisiting once more real medium-confidence recommendation
data accumulates under it.

### Confidence tiers measure sample size, not accuracy — instrumentation laid for re-tiering

`confidenceTier(effectiveN, hasMatchupData)` sets "high" purely from `effectiveN >= 8 && hasMatchupData` and
"medium" from `effectiveN >= 3` — that's how much trailing sample the model had to work with, never how reliable
that tier has actually been. A real live check found this mislabeling in action: "high confidence" picks (82
graded) had a Brier score of 0.290 — worse than a flat uninformative 50/50 guess's 0.25 — meaning the tier calling
itself most trustworthy had, up to that point, been less reliable than a coin flip. The honest fix is to re-tier
confidence off real backtested reliability instead of raw sample size, but that can't be done retroactively:
existing historical picks were never saved with `effectiveN`, so there's no way to go back and check where the
`effectiveN >= 8` cutoff really should sit. `lib/probability.js` now returns, and `lib/pipeline.js`'s
`buildGradablePicks` now persists, `effectiveN`, `nudgeCapped`, and `rawNudgeSum` on every newly-saved pick going
forward — the groundwork for a future pass (once enough new graded data accumulates under this instrumentation)
that checks whether `effectiveN >= 8` is actually where real reliability jumps, and whether nudge-capped picks
perform differently from uncapped ones. Until that data exists, treat "high confidence" as "the model had a lot of
trailing sample to work with," not as a promise about hit rate — the per-tier Platt-scaling recalibration above and
`scripts/refit-live-ledger.js` are what correct for and measure the gap between the two in the meantime.

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
   - **Opposing front-seven injury** — the run-game mirror of the secondary-injury nudge below: how many of the
     opponent's own DL/LB-family players (`lib/factors/injury.js`'s `FRONT_SEVEN_POSITIONS` — DE/DT/NT/DL/LB/
     ILB/OLB/EDGE) are out or doubtful, applied to that opponent's rushing props. Same deliberately generic
     shape as the secondary-injury nudge, for the same reason (no play-by-play personnel/assignment data exists
     to compute a specific "this run-stopper is the one who'd have covered him" claim).
   - **Vegas game-script context** — the odds feed's own spread/total (`lib/analyze.js`'s `extractGameContext`,
     `lib/factors/index.js`'s `computeGameScript`), read purely as context for run/pass volume tilt, never as a
     bet type on its own (this build still only offers player-prop Overs). A team favored by a touchdown or more
     (`BIG_SPREAD_THRESHOLD = 6.5`) tends toward a run-heavy, clock-killing plan; a team getting a touchdown or
     more tends toward more pass volume playing catch-up. Scoped to the prop types that plausibly move with game
     script, the same `RUN_PROPS`/`PASS_PROPS` sets (now exported from `lib/probability.js`) the weather nudge
     above already uses. **A caveat worth actually verifying**: SportsGameOdds' sign convention for which side a
     spread favors couldn't be confirmed from their docs, so `extractGameContext` assumes the standard
     sportsbook-display convention (negative = home favored). Every live refresh logs a one-time sanity-check
     line ("Game-script check: ... reading X as favored") — check it against a real sportsbook board once, and
     flip the sign in `extractGameContext` if it's backwards.

     **A real bug this shipped with and then fixed within a day**: SportsGameOdds' actual payload returns
     `bookSpread`/`bookOverUnder` as strings (e.g. `"+8.5"`), not JS numbers — the dry-run fixture used numeric
     literals, so this passed every test and only broke on a live refresh (`TypeError: teamSpread.toFixed is not
     a function`, thrown from the home team's own row specifically — the away side's `-homeSpread` negation
     happens to coerce a string to a number as an accidental side effect, masking the bug there). `extractGameContext`
     now coerces both fields with `Number(...)` at the source, and `scripts/dry-run.js` has a dedicated regression
     test (`stringPayloadNudgeWorks`) that reproduces the exact crash with a string-typed fixture and fails loudly
     if this regresses.
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
against real multi-season nflverse history, and overwrites `lib/modelCoeffs.js` with measured coefficients.
**What it can and can't prove:** SportsGameOdds' Rookie tier has no historical odds archive, so there is no way
to backtest against real historical market lines. Instead it walks forward through each season week by week
(using only data from weeks strictly before the one being tested — no lookahead) and checks whether a player beat
his *own trailing average* for that stat, a reasonable stand-in for "the market already prices in a player's
normal level" but a genuinely easier question than "beat the real closing line." Coefficients with genuinely no
historical feed at all (market steam, real cross-book stale-line value, personal weather history — none of which
any source this app uses publishes historically) are left at hand-set defaults and reported as untested, not
disproven.

**Real historical injury reports now backtest four more factors.** `lib/fetchers/nflverse.js`'s
`fetchInjuryHistory` pulls nflverse's own real weekly injury-report archive
(`injuries_<season>.csv` — verified live before coding against it, same discipline every fetcher in that file
follows) — official `report_status` (Out/Doubtful/Questionable/blank) per player per week, back to 2023. The file
carries one row per practice-report day, not one per player-week, so `scripts/backtest.js`'s `buildInjuryIndex`
collapses each player's rows down to the one with the latest `date_modified` before counting anything, giving the
real final weekly designation rather than double-counting a player or reading a stale mid-week status. This
finally makes `oline_injury_penalty`, `secondary_injury`, `front_seven_injury`, and `tendency_usage_bump`
testable — all four used to sit at hand-set defaults forever with no historical injury feed to test them against.
The walk-forward measurement replicates the exact same position sets and status-regex gating the live nudges use
(`lib/factors/injury.js`'s `OL_POSITIONS`/`SECONDARY_POSITIONS`/`FRONT_SEVEN_POSITIONS`, and
`lib/factors/index.js`'s `findKeyTeammate` for the teammate-tendency bump, called the same way the live app
itself falls back — `depthChartIndex=null`, since per-week historical depth charts aren't practically available).

A real run against 2023-2025 found: `oline_injury_penalty` is a real, kept signal in the expected direction (own
team's O-line hurt is a genuine drag, though a milder one than the -0.2 hand-set default assumed — measured at
roughly -0.09). `tendency_usage_bump` (the "backup gets a bigger workload when the starter's out" intuition) has
**no statistically real signal at this sample size** and is now pruned to 0 — a real, honest answer to "does a
backup's bump actually show up in the numbers," even though it's a null one for now (1,151 real qualifying
player-weeks isn't nothing, but it's thin next to the ~35,000 rows behind the biggest factors). `secondary_injury`
and `front_seven_injury` came back real and kept, but — like `game_script_pass_favor` below — in the *opposite*
direction from their original positive hand-set intuition: an opponent's hurt secondary or front seven measures
as a real negative for the affected pass-catcher/rusher's own numbers, not a boost, plausibly the same
garbage-time-against-a-still-good-defense dynamic. Both cards' reasoning text and chip coloring
(`public/index.html`'s `propReasoning`/`factorChipsHTML`) now read the actual signed weight off
`row.modelContributorDetails` before deciding whether to call something a tailwind, a caution, or leave it out
entirely — the same "never claim a favor the real data doesn't support" rule `matchup_edge`'s and
`game_script_pass_favor`'s labels already followed, extended to the card copy itself rather than just the nudge
label. Re-run `npm run backtest` to get the current numbers; treat the specific coefficients above as a snapshot
of one real run, not a permanent verdict.

**Real stale-line value now actually moves the model, not just a badge.** `lib/analyze.js`'s
`computeBestAcrossBooks` has long told a genuinely mispriced, corroborated outlier book (`staleValue`) apart
from a likely data error (`suspect`) — see its own comment for exactly how (a majority of the tracked panel
agreeing with the consensus is what makes it real, not a shared glitch). Until now that distinction only
decided whether a prop got excluded from Mispriced Bets and parlays (`suspect` did, `staleValue`
didn't) — a real, corroborated signal that never actually influenced `modelProb`, the number every ranking and
parlay-tier decision is made on. `lib/probability.js` now applies a `stale_line_value` nudge scaled by how far
past the threshold the corroborated edge runs (same magnitude-scaling-with-a-cap discipline `steam_move`
already uses), so a genuinely stale-priced leg is now correctly rated a real, higher probability instead of
just wearing a badge that never affected its ranking. Hand-set, not backtested, for the same reason
`steam_move` is: there's no historical multi-book odds archive to replay "was this book's outlier price
actually corroborated by the rest of the panel" against.

**Statistical pruning, not just shrinkage.** Every factor's coefficient used to be shrunk only by *sample size*
(more supporting games = less shrinkage toward 0) — which meant a factor with a tiny, meaningless real-world lift
but a large sample could still keep a meaningful chunk of its coefficient, quietly adding noise to every scored
prop right alongside the factors that were actually predictive. That mattered: `scripts/validate-model.js`'s real
walk-forward validation showed the full model's calibration was statistically indistinguishable from — and
technically a hair worse than — a flat 50% guess. The backtest now runs a real two-proportion z-test on every
factor's with/without hit-rate gap, and any factor that doesn't clear a conventional p<0.05 significance bar
(given its actual sample size) gets pruned to *exactly* 0, not softly shrunk — it stops contributing to every
scored prop until a future, larger sample gives it a fair chance to prove itself again. A factor that survives
the z-test still goes through the existing sample-size shrinkage on top, so a real-but-thin-sampled effect still
gets pulled partway toward 0.

**Joint estimation, not just per-factor testing.** The two-proportion z-test above has a real blind spot: it
tests each factor completely on its own, so two correlated factors (a hot-streak player is often also a
high-snap-share player) can each look independently significant even when only one of them is doing the actual
work — the model then double-counts one real signal as two. `scripts/backtest.js` now decides its actual written
coefficients from a single joint logistic fit across every backtested factor at once, with a Wald significance
test per coefficient at this same p<0.05 bar (`lib/regularizedFit.js`'s `fitJointLogisticWithWaldTest`) — every
factor competes for credit against every other simultaneously, so a redundant factor's estimated effect (and its
statistical uncertainty) already reflect that overlap. The independent z-test is still computed and printed
alongside it purely as diagnostic context (useful for spotting exactly this kind of shared-credit situation when
the two disagree), but no longer decides what gets written. An earlier version of this used a cross-validated
lasso instead of a Wald test; that was tried against real backtest data and discarded — see
`lib/regularizedFit.js`'s own header comment for why it miscalibrated in both directions (either pruning
everything or nothing, depending which of the two standard lasso lambda-selection rules was used) and wasn't
trustworthy for a tool real money rides on.

**What a real run against 2023-2025 found, under the ORIGINAL (independent z-test) methodology** (see
`lib/modelCoeffs.js`'s own per-line comments for the exact numbers and p-values from whichever run last generated
it — re-running `npm run backtest` now will refresh these under the NEW joint-fit methodology above, and the
numbers below will change accordingly): of 13 factors with enough data to test, only 5 cleared the significance
bar — `form_hot`, `usage_high_snap`, and `redzone_share` (each a real, positive lift), plus `travel_penalty` and
`game_script_pass_favor` (both real, but *negative* — see below). The other 8 — `weak_defense`, `matchup_edge`,
`high_scoring_env`, `starter_change`, `short_week_penalty`, `game_script_run_favor`, `referee_over_lean`, and
`referee_under_lean` — were pruned to exactly 0 as statistically indistinguishable from noise at this sample
size. Pruning these actually *helped*: the full model's real Brier score improved (0.2530 → 0.2523), the nudges'
measured lift over a zero-nudge baseline grew (0.0013 → 0.0020), and — notably — the confidence-tier ordering
flipped to the direction it's supposed to be in (high-confidence picks now out-calibrate medium, where they
previously didn't). None of this gets this app close to a real, durable edge on its own — see "How accurate is
the model, really?" below for the honest full picture — but it's a genuine, measured step in the right direction
from removing noise rather than adding more signals. A sandbox smoke test of the new joint-fit methodology
against a single real season (2024 only — not the full 3-season history this app actually ships with) produced
directionally consistent results: the same four strong factors (`form_hot`, `usage_high_snap`, `redzone_share`,
`travel_penalty`) came back significant, the same core noise factors (`weak_defense`, `matchup_edge`,
`high_scoring_env`, `starter_change`, `referee_under_lean`) came back pruned, and `game_script_run_favor`
crossed into significance jointly (p=0.045) despite not clearing the bar independently (p=0.136) — a plausible
example of the exact shared-credit effect this change was built to catch, though one real season isn't enough
data to call that conclusively. **Re-run `npm run backtest` against your own real 3-season history to get the
actual current numbers** rather than trusting either of the historical runs summarized here.

**A genuinely counter-intuitive real finding:** `game_script_pass_favor` (the "a big underdog throws more in
catch-up mode, so his pass-catchers see a volume bump" intuition) came back with a real, statistically
significant effect in the *opposite* direction — a big underdog's pass-catchers beat their own trailing average
*less* often, not more, plausibly because garbage-time volume tends to come against a leading (and often better)
defense and doesn't translate to the same per-target efficiency. `game_script_run_favor` (the "big favorite runs
the ball more" intuition) had no measurable real effect at all. Both nudges' reasoning labels were reworded to be
neutral ("game script read") rather than directional, matching the same pattern `matchup_edge` already
established once *its* real backtested effect also came back negative despite its positive-sounding label (it's
now pruned to 0 outright, on this same run, rather than sitting at a small negative value) — a label should never
claim a "favor" the real data doesn't support.

**A real limitation of this particular run, worth knowing before trusting it blindly:** `weather_run_favor`,
`weather_pass_penalty`, and `venue_edge` came back as "not enough data" in the sandbox this was built in, because
that sandbox's network egress blocks Open-Meteo's historical weather API outright (confirmed via a direct `curl`
test — a `connect_rejected` from the sandbox's own egress proxy, nothing to do with Open-Meteo or nflverse).
That's an environment restriction of the dev sandbox, not a real-world data gap — Open-Meteo's historical archive
is real and free, and a real run from your own machine or GitHub Actions (which don't have that restriction)
should be able to fetch it and produce a real, tested verdict for those three instead of falling back to their
untested hand-set defaults. **Re-run `npm run backtest` yourself once to get full coverage** rather than trusting
this session's partial run for those three specific factors.

Three more nudges joined the backtestable list alongside the original nine: **`weather_run_favor`/
`weather_pass_penalty`** now measure against real historical weather (a fresh Open-Meteo archive-API backfill,
the same source `lib/pipeline.js`'s live personal-weather-history nudge uses — this closed a real dead-code bug:
nothing in the codebase actually set the `_wasWetGame` flag that nudge reads until this backfill was added, so
that branch could never fire live), **`venue_edge`** measures against the schedule's own roof column (already
being fetched, just not previously cross-referenced against a walk-forward result), and **`game_script_run_favor`/
`game_script_pass_favor`** measure against nflverse's own historical `spread_line`/`total_line` columns — with
its sign convention CONFIRMED the opposite of a standard sportsbook board (positive `spread_line` = home
favored; see `nfldata/DATASETS.md`), which `scripts/backtest.js`'s `scheduleGameScript` explicitly negates to
match the live pipeline's own convention. Because the weather backfill now hits a real external API for every
non-dome historical game across all requested seasons (not just this week's board, the way the live pipeline
scopes it), a full backtest run takes noticeably longer than it used to — expect several minutes, not "under a
minute per season."

Two more joined the backtestable list this round: **`referee_over_lean`/`referee_under_lean`** (the revived,
non-bettable referee-tendency factor) measure walk-forward against nflverse's own historical `referee`/`total`/
`total_line` schedule columns, using a dedicated `refereeFactorAsOf` helper that only counts games a given
referee had *actually already called* strictly before the one being tested (the live factor itself can safely
read the whole schedule file, since a future/unplayed game always has a blank referee — but replaying a past
season needs that same no-lookahead discipline every other nudge here already follows). The Next Gen Stats
efficiency nudges (`ngs_cpoe_hot/cold`, `ngs_ryoe_hot/cold`, `ngs_separation_hot`) and the pass-protection/
pressure nudges (`pressure_risk_penalty`, `clean_pocket_boost`) both draw on real, full-history archives too
(NGS back to 2016; every sack/`qb_hit` play-by-play column as far back as `pbp` is fetched) — genuine future
backtest candidates — but neither is wired into this script's walk-forward loop yet, so they stay hand-set.

`writeCoeffsFile` (the function that regenerates `lib/modelCoeffs.js`) used to write from a hardcoded per-key
template that predated the weather/venue/practice-trend/front-seven/game-script coefficients a later session
added by hand — meaning running `npm run backtest` would have silently **erased** every one of them on the very
next regeneration, a real latent bug caught (and fixed) during this pass. It now writes every key actually
present in the merged coefficient object, with a fallback "uncategorized" section for anything it doesn't
recognize, so a coefficient someone adds directly to `lib/modelCoeffs.js` later can no longer just vanish.
Re-run the backtest periodically as more seasons of data accumulate.

**Fixed a real out-of-memory crash.** Running `npm run backtest` against 3 real seasons on an actual machine
(rather than the dev sandbox this app is built in) crashed with `FATAL ERROR: Reached heap limit — JavaScript
heap out of memory`. Root cause, found by measuring actual heap use step by step: `fetchPlayByPlay` parsed each
season's full play-by-play CSV (370+ raw columns from nflverse, ~48,000+ rows) into full-width row objects
*before* trimming down to the ~50 columns this app actually uses — briefly needing close to 2GB of heap for a
single season, just to throw away 85% of it a moment later. On top of that, this script (and
`scripts/validate-model.js`, which had the identical pattern) pre-loaded *every* requested season's stats,
play-by-play, and snap-counts into memory before walking any of them, instead of processing one season at a
time — so a 3-season run needed roughly 3x that peak simultaneously. Fixed both: `fetchPlayByPlay` now parses
play-by-play row-by-row and trims each row immediately (never holding the full 370-column version of more than
one row at a time), and both scripts now fetch-walk-release one season before starting the next. Measured
side by side, this cut one season's play-by-play parse from ~2GB of heap to under 300MB, and let a full 3-season
backtest complete inside a 1.5GB heap ceiling in testing — comfortably under the 4GB ceiling both `npm run
backtest` and `npm run validate-model` now request via `node --max-old-space-size=4096` in `package.json`, which
serves as a second, independent safety margin on top of the real memory-footprint fix. If a future run somehow
still hits this, that flag is the first place to look — raising it further costs nothing but memory.

### The results ledger — closing the feedback loop

None of the above matters if nobody ever checks whether it works. `lib/grading.js` + `lib/store.js`
(`saveWeeklyPicks`/`loadWeeklyPicks`, `loadCalibrationLedger`/`saveCalibrationLedger`) close that loop: every
refresh saves that week's prop picks (identity + the model's estimate at prediction time), and every refresh
also checks whether last week's (or this week's early) picks have finished — about 20 hours after kickoff, once
nflverse's stat file has actually posted — and grades them hit/miss against the real final stat. Graded picks
fold into an all-time calibration ledger, bucketed by confidence tier and by edge size, tracking hit rate and
Brier score (mean squared error between the stated probability and the outcome — lower is better calibrated;
0.25 is what an uninformative flat 50% guess scores). It starts empty on a fresh deploy — that's correct, not a
bug, since it takes real games finishing before there's anything to grade.

**Two separate ledgers, not one blended number.** `buildGradablePicks` saves EVERY prop the model can score, for
ledger/history completeness — not just the ones that actually cleared the real edge bar. Early on, the Track
Record panel folded ALL of those into one all-time number, which made the model look far worse than it actually
was: the vast majority of what's tracked was never flagged as a real recommendation in the first place (a real
live check found only ~3% of everything ever evaluated had actually cleared the Edge Board bar), so blending that
enormous "background" pool in with the real recommendations buried the number that actually matters. `lib/
pipeline.js` now folds newly-graded picks into TWO buckets in the same `calibration-ledger.json` — the existing
one (`calibrationLedger`, unchanged, everything) and a nested `calibrationLedger.recommended` (only picks where
`wasEdgeBoard` was true) — and `trackRecord` is `{ all, recommended }`, both run through `summarizeLedger`
independently. The frontend leads with `recommended`: that's the one that answers "is this app worth trusting,"
since it's the only one built from picks the app actually told anyone to bet. `all` is still shown underneath,
clearly labeled, since it's real information too (mainly: is the model's probability output calibrated at all,
across everything it's ever looked at) — just not the headline number. If "high confidence" recommended picks
don't hit more than "medium" or "low" ones do after enough real weeks, the tiers aren't earning their name, and
that will show up here rather than staying a permanent unknown.

### Platt-scaling recalibration — closing the loop a second time, now fit per confidence tier

The results ledger above answers "is any of this actually working." `lib/calibration.js` is what actually DOES
something with that answer, beyond just displaying it. `lib/probability.js`'s blend can be systematically over-
or under-confident in a consistent direction — every "60% modelProb" pick actually hitting 52% of the time, say —
even when every individual factor coefficient feeding it is itself real and correctly signed (see
`scripts/backtest.js`'s joint fit above): that's a calibration problem, not a signal problem, and no amount of
re-tuning individual nudges fixes it. Standard Platt scaling (Platt, 1999) fits a small 2-parameter logistic
transform, `calibratedProb = sigmoid(A * logit(rawProb) + B)`, from real `(rawProb, actually hit or missed)` pairs
pulled from the live ledger, and `lib/pipeline.js` applies it to every prop's `modelProb`/`trueEdge` — before
anything downstream reads them (Mispriced Bets ranking, parlay tiers, Top Picks, the frontend)
— so every consumer sees the same corrected number rather than some seeing raw and others calibrated depending on
where in the pipeline they happen to read it.

**This now fits a separate correction per confidence tier, not one pooled correction for everything.** A real
live check found the pooled fit was hiding a serious problem: "high confidence" picks (82 graded, 42.0% hit rate,
Brier 0.290 — worse than a flat 50/50 guess's 0.25) and "medium confidence" picks (12 graded, 21.8% hit rate) are
wrong in different ways and by different amounts, so one global `(A, B)` correction was necessarily compromising
between two different problems instead of fixing either one. `lib/calibration.js`'s `fitPlattScalingByTier(recentForCalibrationByTier)`
fits `high`/`medium`/`low` independently from `lib/grading.js`'s `foldIntoLedger`, which now buckets every graded
pick's `(modelProb, hit)` sample into its own tier's array (`ledger.recentForCalibrationByTier.{high,medium,low}`)
in addition to the existing pooled `recentForCalibration`, each independently FIFO-capped at `MAX_CALIBRATION_SAMPLE`
(500) the same way the pooled one always was. `applyTieredPlattScaling(rawProb, tier, fitsByTier, fallbackFit)` then
picks the best available correction for each pick with a 3-level fallback: that pick's own tier's fit if it has
enough real samples yet (`source: "tier:<tier>"`), else the pooled global fit as a fallback while that tier's own
sample is still thin (`source: "global"`), else the raw probability completely unchanged if neither has enough data
yet (`source: "none"`). `lib/pipeline.js` fits both `tierCalibrations` and a `globalCalibration` fallback every
refresh and applies them this way to every prop row. The Track Record panel's per-tier rows on the dashboard now
show each tier's own `A`/`B`/`n` (or "not enough picks yet, using pooled fallback") next to its hit rate, so which
correction is actually live for a given tier is never hidden.

This needs real per-pick `(modelProb, hit)` pairs to fit, which the ledger's existing aggregate buckets
(`totals`/`byConfidence`/`byEdgeBucket`, all just running sums) structurally can't provide — you can't
reconstruct a scatter plot from its own mean and count. `ledger.recentForCalibration`/`recentForCalibrationByTier`
are the one deliberate exception to "raw counters only, never grows with the number of weeks" (see `lib/store.js`'s
own comment on that design): rolling windows of the most recent `MAX_CALIBRATION_SAMPLE` (500) graded picks' raw
`(modelProb, hit)` pairs, FIFO-trimmed so each stays a fixed, small size forever rather than accumulating an
entire season's worth. Below `MIN_CALIBRATION_PICKS` (50) real graded picks on record for a given fit, there's no
real correction from it yet — a 2-parameter fit off a handful of picks is itself unstable enough to do more harm
than good, so the fallback chain above is what keeps a thin tier from either going uncorrected or getting a wild
correction off too few points.

Two details keep this from becoming its own source of drift. First, every fit — pooled and per-tier — always fits
and folds against the RAW, pre-calibration `modelProb` (`rawModelProb`, threaded through from `lib/pipeline.js`'s
`buildGradablePicks`), never the already-calibrated display value — fitting a correction on top of an already-
corrected number would compound it refresh over refresh instead of measuring the raw model's actual calibration.
Second, each refresh applies whatever fits already existed BEFORE folding in that same refresh's newly-graded
results, so a pick's own just-graded outcome never leaks into the very fit used to score it. The aggregate
`totals`/`byConfidence`/`byEdgeBucket` aggregate buckets described above still track the CALIBRATED number,
deliberately — those exist to answer "how did what Jon actually saw and could act on perform," a different
question from "is the raw model itself calibrated."

### Nudge-magnitude cap — stopping correlated factors from compounding into false confidence

Several kept coefficients in `lib/modelCoeffs.js` are explicitly commented as sharing credit with a correlated
factor in the joint fit (`matchup_edge`, `high_scoring_env`, `starter_change`, `secondary_injury`,
`front_seven_injury`, `weather_run_favor`, `game_script_run_favor`) — they tend to co-fire on the same real pick
(the same game script, the same bad-weather game, the same injury-thinned unit), and before this change nothing
stopped 5-6 of them firing together and stacking additively in log-odds space into a confidence level none of them
individually earned. `lib/probability.js` now sums every nudge's contribution separately (`nudgeSum`) instead of
applying each one to the running logit immediately, then clamps that total to `NUDGE_CAP = 1.5` log-odds (roughly
±18 percentage points of probability swing at a 50% baseline) before applying it — generous enough that a normal,
mostly-independent combination (hot form + high snap share + red-zone role, none of them flagged as correlated)
sums to around 0.72 and passes through completely untouched, but it stops a pile of correlated same-direction
factors from pushing a pick's confidence further than the evidence actually supports. Every scored prop now reports
`nudgeCapped` (whether the cap actually fired on that pick) and `rawNudgeSum` (what the uncapped total would have
been), both persisted on every saved pick via `buildGradablePicks` for future analysis — `NUDGE_CAP = 1.5` is a
reasoned starting point, not itself backtested yet; re-run `node scripts/refit-live-ledger.js` (below) periodically
once enough capped vs. uncapped picks have graded to check whether it's set correctly.

### Refitting against the real live ledger — closing the objective-mismatch gap

`scripts/backtest.js` (above) is a genuinely real, multi-season backtest, but it's built on a proxy target forced
by a real data limitation: SportsGameOdds' Rookie tier has no historical odds archive, so there's no way to
backtest against real historical market lines. It measures "did the player beat his own trailing average" — a
different, EASIER question than "did this beat the market," which is what the live results ledger actually judges
every week. A factor can genuinely predict a player beating his own recent average while adding zero real edge
over the market, because the market may already have priced that exact trend in — until now, every coefficient in
`lib/modelCoeffs.js` had only ever been tested against the easier question.

`scripts/refit-live-ledger.js` (`npm run refit-ledger`, needs `NETLIFY_SITE_ID`/`NETLIFY_BLOBS_TOKEN` in the
environment) closes that gap using data that didn't exist when `backtest.js` was built: this app's own live
history of every saved weekly pick (`lib/store.js`'s `loadWeeklyPicks`, enumerable via
`history.list({ prefix: "picks-" })`), each one carrying its real market probability, real model probability,
which nudges actually fired (`firedFactors`), and the real graded outcome. It reuses the exact same joint logistic
fit + Wald significance test `scripts/backtest.js`'s own joint fit uses
(`lib/regularizedFit.js`'s `fitJointLogisticWithWaldTest`), with one feature per candidate factor (did it fire on
this pick, 0/1) plus one continuous feature for the market's own `logit(marketProb)` — so every factor's
coefficient is estimated GIVEN the market's price is already in the model, meaning a "significant" result there
means real incremental edge over the market's own price, not just correlation with the outcome the market's price
already explains a lot of. It also prints a plain modelProb-decile-vs-real-hit-rate table, the most direct
"is the stated number honest" check there is. Read-only — it only prints a report, it never edits
`lib/modelCoeffs.js` itself. Its own header is explicit about the honest limitation here: the live ledger is still
young, so with ~20 candidate factors most or all coefficients will likely not clear real significance yet on any
single run — that's not a bug in the method, it's an honest reflection of how little real graded data exists so
far. Treat it as a growing diagnostic to re-run every few weeks as more real games grade, not a one-time verdict,
and don't hand-edit `lib/modelCoeffs.js` off a single run of it the way `scripts/backtest.js`'s multi-season,
tens-of-thousands-of-rows fit can be trusted more readily.

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

### Edge Board history

A pick's `wasEdgeBoard` flag is captured the same "once, never overwritten" way `pickPrice`/`pickBook` are: the
moment a pick is first surfaced, `lib/pipeline.js`'s `buildGradablePicks` records whether it actually cleared the
real Edge Board bar at that instant (`trueEdge > MIN_TRUE_EDGE`, medium/high confidence, no team mismatch, not
suspect) — and the merge step preserves that answer across every later refresh of the week, even if the pick's
own edge shrinks, grows, or disappears entirely as the model updates. `buildEdgeBoardHistory` (also in
`lib/pipeline.js`, exported for direct unit testing the same way the CLV/grading logic is) then filters the full
pick history down to picks that were both `wasEdgeBoard: true` and have since graded, sorts most-recent-kickoff-
first, and reports a simple hits/total tally. This answers "of what this board actually told you was an edge
last week, what hit" — not "of whatever still looks like an edge today," which is a different and much easier
question to get a good-looking answer to. Shown on the Edge Board tab, right under the existing calibration
track-record panel; empty on a fresh deploy for the same honest reason that panel is.

### Anytime TD needs a much bigger edge

A real live diagnostic (`scripts/diagnose-accuracy.js`, run against the real results ledger right after the
live-line cleanup below) found Anytime TD props hitting at 13.5% real, against the model's own already-modest
18.8% average confidence on them — by a wide margin the single worst-performing prop type, and, on that same
data pull, over half of everything the app had ever evaluated. The reason is structural, not a bug: a touchdown
is a bursty, low-frequency event, and a player's last-10-game TD rate is mostly noise — a couple of recent scores
reads to the model like a real trend when it usually isn't. `lib/pipeline.js`'s `minEdgeFor(propType)` (module
scope, right below `MIN_TRUE_EDGE`) is the fix: every prop type needs `MIN_TRUE_EDGE` (3 points) of real edge to
count as a recommendation EXCEPT Anytime TD, which needs `MIN_TRUE_EDGE_TD` (15 points) — five times the bar.
Anytime TD still shows up everywhere (Player Props tab, browsable, tracked in the "all" ledger above) and still
CAN become a real Edge Board recommendation if the evidence is genuinely overwhelming; it just needs to clear a
much higher wall to get there. `lib/topPicks.js` keeps its own copy of the same two constants and the same
`minEdgeFor` logic (it's imported BY `pipeline.js`, so it can't import the threshold back) — keep both in sync if
either ever changes. Parlay legs (`lib/parlays.js`) aren't affected directly by this constant (they gate on a
flat `modelProb >= 55%` floor instead of `trueEdge`), but Anytime TD's real, low average modelProb (~19%) already
puts it nowhere near that floor in practice, so no separate parlay-side change was needed.

### Prop Bets history and parlay tracking

`wasEdgeBoard` and `buildEdgeBoardHistory` above answer "of what the Edge Board specifically flagged, what hit."
Two more tracking views answer two different honest questions alongside it, without deduplicating against it —
Edge Board picks are a real subset of both, and showing up in more than one panel is intentional, not a bug.

**Prop Bets history.** `lib/pipeline.js` also exports `buildPropBetsHistory(picks, limit = 60)` — the same idea
as `buildEdgeBoardHistory` just above, but WITHOUT filtering by `wasEdgeBoard`: every graded pick ever saved,
Edge Board pick or not. Exposed on the snapshot as `propBetsHistory`, rendered in a `propBetsHistoryPanel` panel
at the top of the Player Props tab.

**Parlay tracking**, built from scratch — there was no parlay-outcome tracking of any kind before this.
`lib/store.js` gained `loadWeeklyParlays`/`saveWeeklyParlays`, the same per-(season, week) Blobs-backed pattern
the existing `loadWeeklyPicks`/`saveWeeklyPicks` already used for individual picks. `lib/pipeline.js` gained
`buildGradableParlays(parlayAttempts, season, week)`, which builds the saveable/gradeable shape of a parlay from
the same `allParlayAttempts` list that already existed for parlay-building (cross-game, every game's Same Game
Parlay, and every slate's parlays), keyed by each parlay's own existing stable `_cacheKey`. `runPipeline` then
saves/grades/merges parlays the exact same "capture once, never let a fresh snapshot clobber an already-graded
result" way it already did for individual picks, exposing the result as `parlayHistory` (`{ parlays, hits, total
}`) on the snapshot. Rendered in a `parlayHistoryPanel` panel at the top of the Parlays tab, showing each graded
parlay's tier/context label, combined odds, hit/miss, and a per-leg hit/miss breakdown so a miss is checkable
down to exactly which leg broke it.

**Grading a parlay is a fail-fast design, on purpose.** `lib/grading.js` factored its existing per-pick grading
logic into a shared `gradeLeg(leg, gameLogIndex, now)` helper — wait `GRADE_DELAY_HOURS` (20h) after kickoff,
then check the real final stat against the line — and added `gradeCompletedParlays(parlays, gameLogIndex, now)`
on top of it. A parlay is graded `hit: false` the moment ANY of its legs individually grades as a miss — it does
NOT wait for every leg's game to finish first, the way a sportsbook itself would settle it early once one leg is
dead. A parlay can only be graded `hit: true` once EVERY leg's game has graded AND every leg hit. This is a
deliberate asymmetry, not an oversight: a single missed leg already tells you the parlay lost, so there's no
reason to wait on the rest of the slate to say so, but nothing short of every leg posting a real, confirmed hit
can call the whole thing a win.

### Top Picks

A quick-glance dashboard (`lib/topPicks.js`, the app's new default landing tab) — the sharpest, most mispriced
pick in each of five categories (Anytime TD, receiving/rushing/passing yards, passing TDs), instead of one pooled
Edge Board list. Same eligibility bar as the Edge Board itself (`trueEdge` above the noise floor, medium/high
confidence, no team-mismatch or suspect flag) — `buildTopPicks` just slices it per `propType` and caps each
category at 5, sharpest edge first.

The reasons shown under each pick are not a second, looser writeup — they're `lib/probability.js`'s own fired
nudges, re-surfaced. `estimatePropProbability` now returns `contributorDetails` (`{key, weight, label}`) alongside
the plain-string `contributors` it already returned (kept as-is for backward compatibility with the existing
prop-card reasoning and `scripts/dry-run.js`'s string-matching tests). `pickTopReasons` filters that list to
positive-weight nudges only, ranked by the actual measured coefficient — which matters in a very specific way:
a real backtest run has previously measured `matchup_edge`'s coefficient as negative despite its positive-
sounding label (it's since been pruned to exactly 0 as statistically insignificant — see "Backtesting the
contextual nudges" above), which is exactly the scenario this exists to guard against: a naive "just list
whatever fired" approach would tout a factor whose real, measured effect goes the other way, or that isn't real
at all. Ranking by signed weight instead of just listing labels catches that automatically.
When a pick has fewer than 3 real fired nudges, `pickTopReasons` fills the gap with real computed facts pulled
directly off the row (opponent's defensive rank, last-10 hit rate, red-zone share, the edge itself) rather than
padding with something invented — every reason on a Top Pick card is either a nudge that actually moved the grade
%, or a real number already shown elsewhere on the full card.

`pickBlurb` composes the 2-3 sentence write-up: a headline sentence with the real model/market probabilities and
the edge, then the chosen reasons woven into one sentence, plus an optional third sentence only when the sample
behind the pick is thin enough to be worth flagging. A category with nothing that clears the bar this week shows
its own honest empty state rather than being hidden or padded out with a weaker pick just to fill five slots.

### Per-game filter

The Edge Board, Player Props, and Top Picks tabs each got a "game" dropdown filter (`edgeGameFilter`,
`propGameFilter`, `picksGameFilter`), on top of whatever filters each tab already had (team/player search, prop
type, sort). It's populated from a `gameOptions()` helper in `public/index.html` that dedupes `propRows` by
`eventId` and labels each option `"{away} @ {home}"` with kickoff time.

On Top Picks specifically, selecting a game does more than filter the existing board: it switches the view from
the normal "top 5 picks per category" layout into a flat, edge-sorted list of every scored prop for that one
game, reusing the same edge-card rendering the Edge Board uses. That's necessary rather than cosmetic — the
precomputed top-5-per-category picks are drawn from the whole week's slate, so they usually won't happen to
include any one specific game at all, and a per-category filter on top of them would mostly just show empty
categories.

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
  **Cohort-pooled, not a raw ratio.** A share computed off only a handful of team red-zone plays (the floor is
  just 4) is genuinely noisy — a player who touched 2 of a team's first 4 red-zone snaps this season reads as an
  extreme 50% "share" a bigger sample would likely walk back, and `scripts/backtest.js`'s own walk-forward
  measurement of this factor is early-season, in-season-only (it can't pool across years the live app's
  multi-season history can), so this noise shows up in real backtest runs, not just in theory. The raw ratio is
  pooled toward an "equal split" baseline — what this player's share would be if the team's red-zone work were
  divided evenly among however many teammates actually recorded a touch in this same sample, a real same-team
  cohort computed from data already on hand — weighted by 6 "plays" of trust behind that baseline
  (`REDZONE_POOL_K` in `lib/factors/playerPbp.js`). `scripts/backtest.js`'s own walk-forward version of this
  factor calls the exact same pooling helper the live nudge does, so the two can never silently drift apart.
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
- **Opposing front-seven injury** — the run-game mirror of the above: how many of the opponent's own DL/LB-family
  players are out or doubtful, applied to that opponent's rushing props (`computeOpposingFrontSevenInjury` in
  `lib/factors/injury.js`). Same generic-signal, same reasoning-engine treatment as the secondary-injury factor.
- **Vegas game-script context** — the game's own spread/total, read as a non-bettable signal for run/pass volume
  tilt (a big favorite skews run-heavy, a big underdog skews pass-heavy in catch-up mode) — see "Probability
  model" above for the exact mechanics and the sign-convention caveat worth verifying against a live payload.
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
- **Next Gen Stats player efficiency** — real, tracking-data-derived numbers straight from nflverse's own
  `ngs_passing`/`ngs_rushing`/`ngs_receiving` releases (`lib/factors/nextgenstats.js`), isolating a player's OWN
  skill from his team's overall offensive numbers (already covered by the matchup/scoring-environment factors
  above): completion percentage over expectation (CPOE) and average time-to-throw for QBs, rush yards over
  expected per attempt for runners, and average separation at the catch point plus yards-after-catch over
  expectation for pass-catchers. Trailing last-3-games average, gated on a minimum sample (2+ games, with a
  per-game attempt/target floor so a garbage-time single-drop-back row can't skew it).
- **QBR trend** — real ESPN Total QBR, pulled straight from nflverse's own free, historical-and-current
  `espn_data` release (`qbr_week_level.csv.gz` — no ESPN scraping, no proprietary feed), trailing-average across
  a QB's recent games. QBR already accounts for game situation, opponent, and how a QB's own team performed
  around him, so it's a genuinely different signal from CPOE/EPA above rather than a restatement of them —
  scored as a small nudge in either direction only once it clears a real-vs-thin sample gate (`QBR_ELITE_THRESHOLD`
  / `QBR_POOR_THRESHOLD` in `lib/factors/qbr.js`), and only ever applied to QB props.
- **Pass-protection/pressure matchup** — real data this app was already fetching and computing but never actually
  wired into anything that could move a grade: `lib/factors/teamStats.js`'s `pressureRateAllowed`/
  `pressureRateCreated` (straight off play-by-play's `sack`/`qb_hit` columns) are combined in
  `lib/factors/pressure.js` into one "how much heat will this week's QB actually face" number — the offense's
  own pass-block rate plus the specific opponent's own pass-rush rate. A true PFF/ESPN-style "pass rush win rate"
  or "blitz rate" is proprietary and not freely buildable; this sack+hit-rate proxy from already-fetched
  play-by-play is real and is.
- **Referee tendency** — revived as a non-bettable context factor (`lib/factors/referee.js`) after this build
  dropped its Totals market: a real historical over/under bias per assigned referee, computed from nflverse's own
  schedule file (the actual final combined score vs. the closing total line, across however many seasons of
  history are loaded). An over-friendly crew reads as a modest tailwind for scoring generally (more plays for
  BOTH offenses), not a run- or pass-specific tilt the way weather/game-script are. Assignment for an upcoming
  game usually isn't known until close to kickoff — this reports itself unavailable rather than guessing until a
  real assignment shows up in a later-week refresh. **Cohort-pooled, not just a hard sample-size floor.** The
  8-game minimum before a referee's tendency counts at all is itself a thin bar — a genuinely coin-flip-neutral
  official can show a 65%+ over-rate across just 8-12 games by pure chance. Rather than trust that raw rate
  outright once it clears the floor, it's pooled toward the league-wide over-rate across every OTHER referee on
  record, weighted by 20 "games" of trust behind that league baseline (the same shrinkage idea `REG_K` and
  `marketPriorWeight` already use elsewhere) — a referee with a real, large, well-supported tendency still shows
  it once his own sample outweighs that constant; one right at the floor gets pulled back hard toward
  league-normal. This measurably changed backtest behavior in a sandbox smoke test: `referee_under_lean` fired on
  roughly 10% of scored rows before pooling and under 1% after, because far fewer individual referee/game
  combinations still cross the ±0.4/0.6 read thresholds once thin samples are pulled toward the middle instead of
  read at face value.
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

### The one gap this build doesn't fill

Nflverse's participation dataset (which would make real personnel groupings and pass-rush counts computable) was
confirmed discontinued for in-season release partway through 2023, so coverage-scheme and personnel-package
content isn't included in this build at all — there's no free data source to compute it from, and (see "No AI
layer" below) no AI layer left to speculate about it in its place either. Revenge-game and contract-year
narrative are gone for the same reason. This is a real, documented gap, not a bug: every factor this app does
show is a real computed number, and this one is honestly left out rather than being faked, guessed, or backed by
AI narrative standing in for missing data.

## No AI layer

This build has zero AI/LLM involvement anywhere, by the owner's explicit direction to scrap that layer entirely
— read that as "this app is AI-free now," not as "AI removed, something lost." `lib/ai.js` (which used to
generate a per-prop analytical note, the speculative "scouting take" described just above, and parlay rationale,
all via the Anthropic API) is deleted outright, along with the AI note cache, the Anthropic daily-spend guard,
and every `ANTHROPIC_*` env var. `runPipeline` no longer accepts an API key or an "AI on"/"scouting on" flag, does
no AI annotation or spend tracking of any kind, and the snapshot it returns no longer carries an `anthropicSpend`
field.

Nothing about the app's real analytical claims changes because of this: every one of them — the matchup edge, the
form/usage/venue/weather nudges, the model probability, the reasoning paragraph under every prop card
(`propReasoning` in `public/index.html`) and every parlay's write-up (`parlayWriteupHTML`) — was already a real
computed number before this change, too. The AI layer only ever added narrative flavor text on top of that math;
it never fed anything the math itself depended on. The one place removing it left an actual, honest gap is the
speculative bucket described just above — that content simply isn't shown anymore, rather than being faked,
guessed, or backed by AI standing in for missing data.

Two real features landed in the same pass this AI layer came out, both covered in their usual place above:

- **A per-game filter** on the Edge Board, Player Props, and Top Picks tabs — see "Per-game filter" above.
- **Source-tagged bet tracking** — a Prop Bets history panel and real parlay-outcome tracking (with a deliberate
  fail-fast grading rule), alongside the existing Edge Board history — see "Prop Bets history and parlay
  tracking" above.

## Parlays

`lib/parlays.js` builds three kinds of parlay group (cross-game, Same Game, and slate), each made up of five
tiers: **Low Risk, Medium, High, Mega, and Nuke**. Low/Medium/High are the base ladder — each drawing its legs
from a **fixed, non-overlapping absolute probability band** on `modelProb`, expressed in the odds terms Jon
actually thinks in rather than round percentage cutoffs:

| Tier | Probability band | Odds equivalent | Legs | Sorted by |
|---|---|---|---|---|
| Low | 66.7%+ | -200 or safer | 3 | highest `modelProb` first (safest) |
| Medium | 60–66.7% | -150 to -200 | 4 | highest `modelProb` first |
| High | 55–60% | -125-ish down to the 55% floor | 4 | highest `modelProb` first |

Every leg everywhere — Mega and Nuke included — is gated at a 55% floor (`MIN_LEG_PROBABILITY`, equal to High's
own band floor): a coin-flip or worse doesn't belong in a build whose whole premise is "graded, real plays," no
matter how big a payout a tier is chasing. Because Low/Medium/High each draw *only* from their own probability
band, a single leg can never appear in more than one of those three within the same parlay group — one leg
missing in Low Risk says nothing about whether Medium/High (drawn from an entirely different, disjoint pool of
players) hit or missed.

**The odds-equivalent bands above describe OUR MODEL's own probability estimate, not the book's displayed
price.** A leg can land in Low Risk while its book price sits at -109, if our model independently rates it a
real 66.7%+ favorite regardless of what the book charges — that gap between our number and the book's own number
IS the value this app exists to find, not an inconsistency between the tier and the leg shown under it. To make
that unmistakable rather than confusing, every leg on every parlay card shows both numbers side by side (a
`model X% real · book ~Y%` chip, plus the same comparison spelled out in that leg's full write-up sentence) —
see `parlayCardHTML`/`parlayWriteupHTML` in `public/index.html`.

Mega and Nuke sit on top of that ladder as two "best of" categories, not additional probability slices — a leg
qualifying for Mega or Nuke *and* one of Low/Medium/High is expected, not a bug:

- **Mega** — a real combined payout of **+2500 or better**. A true single leg at +2500 odds would be roughly a
  4% shot, which the 55% floor already rules out everywhere, so Mega reaches that number the only way the floor
  allows: by stacking as many genuine 55%+ legs (drawn from the *whole* real pool, no probability ceiling) as it
  takes to cross a +2500 combined payout (`MEGA_TARGET_DECIMAL`), with at least `MEGA_MIN_LEGS` (4) so a thin
  1-2-leg parlay can't technically qualify just because two juicy-but-real legs happened to multiply past the
  target. The leg count does the work a single longshot leg used to.
- **Nuke** — "the highest +money bets that are most likely to hit": the market's own plus-money legs (the
  *book's* posted price is positive — the market is pricing it as an underdog) that our model still rates a real
  55%+ shot. A book's displayed price and the model's own probability estimate are two independent numbers
  already tracked per leg, so a leg can genuinely be priced like a longshot at the book while still being a real
  favorite by our numbers — that combination is exactly this app's whole premise, just paying out better than it
  should. Nuke pulls `NUKE_LEGS` (6+) of those, safest-first, from that plus-money-and-55%+ intersection.

- **Risk Tiers** (cross-game) — the original parlay type: pools legs from every game on the board, capped at 2
  legs from any single game so a "board-wide" parlay can't quietly turn into one team's SGP, then splits that
  pool into Low/Medium/High/Mega/Nuke as described above.
- **Same Game Parlays** — one Low/Medium/High/Mega/Nuke set per game, built only from that game's own legs. A
  single game frequently won't have enough legs in every band to fill every tier — that's reported honestly (a
  tier simply doesn't appear) rather than backfilled with a leg that doesn't belong in that band. Mega is the
  one tier that can still build even when Low/Medium/High individually come up short, since it pools across
  every band inside that same game rather than needing enough legs within just one of them. No contradiction
  guard is needed: this app only ever surfaces the "over"/"yes" side of every prop market, so there's no
  opposite-side pairing possible within one game to guard against.
- **Slate parlays** — one Low/Medium/High/Mega/Nuke set per Sunday kickoff window (the "1:00 PM ET Slate" and
  "4:00 PM ET Slate"), pooling legs across every game in that window, capped at 3 legs per game — looser than
  the cross-game cap since a slate is already scoped to a handful of games. A game's window is classified by its
  real kickoff hour converted to Eastern time (`classifyKickoffWindow`), not a hardcoded UTC offset — a fixed
  offset would silently drift by an hour after the November daylight-saving change, right in the middle of a
  season. Thursday, Sunday night, Monday, and early international Sunday kickoffs sit outside both windows and
  only ever get a Same Game Parlay.

The frontend's shuffle control still works exactly as before — it just reshuffles within each tier's own
already-computed, already-disjoint leg pool, so shuffling never breaks the band guarantee.

## Architecture

The refresh pipeline runs on **GitHub Actions**, not as a Netlify function. Netlify was the original plan —
via a Background Function, which gets roughly a 15-minute budget instead of a normal function's ~10-26
seconds, and this pipeline (odds + several nflverse files including full play-by-play + a weather forecast per
outdoor game) needs that room. But Background Functions turned out to
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

### Manual-only refresh

`.github/workflows/refresh.yml` no longer has a `schedule:` trigger — only `workflow_dispatch`. Loading this page
costs nothing at all: `netlify/functions/data.js` only reads the latest saved snapshot out of Netlify Blobs, on
page load, on a page refresh, or while the page just sits open in a tab. The only thing that costs anything is
actually running the pipeline — clicking **Refresh Now**, or manually dispatching the GitHub Actions workflow,
both firing the exact same `workflow_dispatch` run — which spends a real GitHub Actions run (compute minutes) and
real usage against the SportsGameOdds monthly object budget (see "Odds budget" above). An automatic 30-minute
cadence would spend both of those whether or not anyone actually needed fresh data, "however many times a day
this ran on its own," which is why refreshes now only happen when triggered on purpose: the GitHub Actions "Run
workflow" button, or the site's **Refresh Now** button (same `workflow_dispatch` call, via
`netlify/functions/trigger-refresh.js`). Nothing runs on a schedule anymore. If that tradeoff changes later,
re-adding a `schedule:` block to that workflow file is all it takes to bring auto-refresh back.

### Securing the refresh endpoint

`netlify/functions/trigger-refresh.js` is a public URL on the open internet — Netlify functions don't get any
access control by default. Until this was caught during a real review, that meant anyone who found the URL (a
bot scanning for exposed Netlify functions, a scraper, anything) could `POST` to it directly and set off a real,
paid GitHub Actions run, with zero involvement from you — indistinguishable from a phantom auto-refresh from the
outside, and a real cost (GitHub Actions compute minutes, plus usage against the SportsGameOdds monthly object
budget) each time it happened. The endpoint now requires a `REFRESH_SECRET`
you set yourself (see the environment variables section below) sent as an `x-refresh-secret` header; a request
without the right value gets a flat 401 before it ever touches the GitHub API, and if `REFRESH_SECRET` isn't set
at all, every request is rejected outright rather than silently staying open. The site's own "Refresh Now"
button asks for this value once per browser (via a plain `prompt()`, since a static site can't hide a secret
baked into its own JS source) and remembers it in that browser's `localStorage` after that — enter it once and
you won't be asked again on that machine.

## Environment variables & secrets

Split across two places now, since two different systems run this.

**GitHub repo → Settings → Secrets and variables → Actions → New repository secret:**

- `SPORTSGAMEODDS_API_KEY` — required for live data.
- `CURRENT_SEASON` — optional, defaults to 2026.
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
- `REFRESH_SECRET` — required. A password you make up (any random string works — a password manager's generator
  is fine). Gates `trigger-refresh.js` so a random request from the open internet can't fire a paid refresh —
  see "Securing the refresh endpoint" above. The site's "Refresh Now" button will prompt you for this value
  the first time you click it on a given browser and remember it after that.

## Deploying

1. Push this project to a GitHub repo.
2. In Netlify: New site from Git → pick the repo. Build command `npm install`, publish directory `public`,
   functions directory `netlify/functions` (all already set in `netlify.toml`, so the defaults should just
   work).
3. Add the four `GH_*` environment variables plus `REFRESH_SECRET` above in Netlify's Site configuration →
   Environment variables, then redeploy (Deploys → Trigger deploy) so the functions pick them up.
4. Add the four secrets above in the GitHub repo's Settings → Secrets and variables → Actions.
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
the field, not a data error — and it's kept in Mispriced Bets and parlay legs, marked with a
blue "📈 stale-line value" badge so it's clearly called out rather than blending in with an ordinary edge.
Without that corroboration, the row is flagged `suspect` — almost certainly a side/price mismatch somewhere in
the feed — and excluded from Mispriced Bets and parlay legs. It still shows on the Edge Board
with a struck-through red "⚠ unverified" badge so you can review the raw fields (also logged) rather than the
row just silently disappearing.

## Known limitations & tracked items

Real gaps this build knows about and hasn't closed yet — logged here on purpose rather than fixed silently or
forgotten, so the reasoning behind "leave it for now" travels with the code.

### Trailing-history factors now filter by which team the player was actually on (fixed)

`computeFormFactor`, `computeUsageFactor`, and `computeTeammateOutTendency` (all in
`lib/factors/playerSplits.js`) used to pull a player's trailing game log from `gameLogIndex` keyed only by his
name — no filter for which team he was actually on for each of those games. For a player who's been on the
same roster his whole career this was a non-issue. For a player who was traded mid-history, it silently mixed
pre-trade and post-trade context into one trailing average: DJ Moore's "last 10 games" the week after a trade
would blend Panthers/Bears-era usage with whatever the new team is actually doing with him, even though the
scheme, target competition, and QB play behind those two sets of games can be completely different.
`computeTeammateOutTendency` was the worst case of the three: a traded player's OLD team's games would all get
bucketed as "games without [new teammate]," since that teammate was never on the old roster at all — not a
noisy signal, a structurally wrong one.

Fixed via `currentTeamRows` in `lib/factors/playerSplits.js`: the trailing window is now filtered to games
where the row's own `recent_team`/`team` field matches the player's CURRENT `player.team` first, falling back
to the full cross-team history only when the current-team-only sample is too thin (under
`MIN_CURRENT_TEAM_GAMES`, set to 3) to say anything on its own — a player who's been on one roster his whole
career is unaffected either way, since every row already matches. Covered by a dedicated `scripts/dry-run.js`
test (a synthetic traded WR with 2 low-volume old-team games and 3 high-volume new-team games, confirming the
old-team games no longer drag the trailing average down once there are enough new-team games to trust alone,
plus a companion test confirming a too-thin new-team sample correctly falls back to the full history instead).

`computeVenueSplit`, `computeWeatherSplitHistorical`, and `computeBirthdaySplit` were deliberately left as-is:
they measure the player's own physical tendencies (does he perform differently in a dome, in wet weather, near
his birthday) more than his team's scheme or volume, so mixing eras matters less for those — a player's
dome/outdoor split is still mostly about him, not which offense he's in.

### How accurate is the model, really? (`scripts/validate-model.js`)

`npm run backtest` (see above) measures individual factors one at a time against "did the player beat his own
trailing average." `scripts/validate-model.js` is a separate, complementary check that runs the ACTUAL
`estimatePropProbability()` end to end — the same function the live app calls every refresh — against two
seasons of real walk-forward history, then reports Brier score, log-loss, a calibration table, and a
confidence-tier breakdown, alongside a "zero contextual nudges" baseline for comparison. It also runs a
separate synthetic Monte Carlo stress test of the nudge-combination math itself (known ground-truth
probabilities, simulated noisy evidence) to check whether stacking several nudges together stays calibrated.

Run it with `node scripts/validate-model.js` (or `node scripts/validate-model.js 2024 2023` for specific
seasons). It fetches multiple seasons of real nflverse data, so expect a couple of minutes, not seconds. Read
the file's own header comment before trusting a single number out of it in isolation — same "here's exactly
what this can and can't prove" treatment `scripts/backtest.js` already gets, for the same reason: the market
proxy this uses (`marketProb = 0.5`, since there's no historical odds archive) makes this a genuinely easier
question than "does the model beat a real sportsbook line."

**Most recent real run** (24,424 graded rows, 2024-2025, against the current, statistically-pruned
`lib/modelCoeffs.js` — see "Backtesting the contextual nudges" above): full-model Brier score 0.2523, essentially
tied with — technically still a hair worse than — the 0.25 a flat 50% guess would score, but a real, measured
improvement over both the pre-pruning run (0.2530) and a zero-nudges baseline (0.2543). Confidence tiers now
order correctly (high out-calibrates medium), which they did not before pruning. Read that as "a genuine step in
the right direction from removing noise," not as "this now beats the market" — it doesn't yet. Since that run, all
three next steps named here have shipped: `scripts/backtest.js` now fits every factor jointly with a Wald
significance test instead of testing each one alone (see "Joint estimation, not just per-factor testing" above);
`redzone_share`/referee tendency now pool a thin individual sample toward a same-cohort baseline instead of
trusting it at face value (see their own entries above and in "Known limitations" below); and a Platt-scaling
recalibration layer (see "Platt-scaling recalibration" below) now corrects the live modelProb against the real
graded-picks ledger once it has enough real results on record, falling back to the raw, uncorrected estimate until
then. What's still genuinely out of reach at this odds tier: real historical odds to measure actual
closing-line value against a real market, rather than the "beat your own trailing average" proxy every backtest
number above is built on.

### Receptions props missing from a live refresh's type filter — diagnosed, not yet fixed

The live app's prop-type filter has been observed without a "Receptions" option (also missing: Rushing TDs,
Receiving TDs), even though `classifyProp` in `lib/analyze.js` already recognizes `receptions` as a real prop
type. Rather than guess why (SportsGameOdds simply not sending that market this refresh, vs. it being sent under
a statID this build doesn't recognize, vs. rows surviving classification but getting filtered out later), this
build now logs the real answer instead: `analyzePlayerProps` tracks every distinct `statID` it sees on any
player-level odds entry this refresh (classified or not) in a `statIdSeen` map, and logs two lines — every
unclassified statID with its count, and the final row count per recognized prop type — to the Netlify function
logs on the very next live refresh. That turns "where are receptions?" into a one-refresh-away answered
question instead of a guess. Once that log confirms which case it is, the actual fix is either trivial (add a
missing statID pattern to `PROP_PATTERNS`) or "SportsGameOdds isn't sending it this week" (nothing to fix here).

## Project structure

```
lib/
  fetchers/        nflverse (stats, roster, snaps, schedule, play-by-play, depth charts, Next Gen Stats), odds,
                   weather, injuries
  factors/         every computed-factor module, wired together in factors/index.js
  identity.js      player identity resolution — roster index, depth-chart index, resolvePlayer()
  analyze.js       price comparison, best-book selection, suspect-vs-stale-value classification, prop
                   classification
  probability.js   market-anchored probability model — modelProb/marketProb/edge/confidence per row
  modelCoeffs.js   the model's logit-nudge coefficients — GENERATED by scripts/backtest.js
  regularizedFit.js  joint L1-capable logistic regression (coordinate descent) + Wald significance test —
                   scripts/backtest.js's own coefficient-selection engine (see "Joint estimation" above)
  calibration.js   Platt-scaling recalibration — fits/applies a logistic correction to modelProb from the live
                   graded-picks ledger (see "Platt-scaling recalibration" above)
  grading.js       results ledger: grades completed picks AND parlays via a shared gradeLeg primitive (a parlay
                   fails fast the moment any one leg misses — see "Prop Bets history and parlay tracking" above),
                   computes closing-line value (CLV), folds graded picks into the all-time calibration ledger
  parlays.js       fixed-probability-band (Low/Medium/High) plus Mega (combined-payout target) and Nuke
                   (plus-money-and-55%+ value) parlay builder — cross-game, Same Game Parlays, and the two
                   Sunday slate windows (see "Parlays" above)
  topPicks.js      Top Picks tab: top-5-per-category ranking, reason selection, and write-up (see "Top Picks" above)
  pipeline.js      orchestrates one full refresh end to end
  doRefresh.js     wires env vars into runPipeline, saves the resulting snapshot
  store.js         Netlify Blobs wrapper (snapshot, notes, injury/price history, weekly picks, weekly parlays,
                   calibration ledger) — works both from inside a deployed Netlify function and standalone
                   (GitHub Actions)
netlify/functions/
  data.js          serves the latest snapshot
  notes.js         load/save situational notes
  trigger-refresh.js   fires the GitHub Actions workflow_dispatch when "Refresh Now" is clicked
.github/workflows/refresh.yml   the real refresh entry point (manual dispatch only, no schedule)
scripts/
  refresh.js       runs the real pipeline (used by the GitHub Actions workflow)
  dry-run.js       runs the pipeline against synthetic demo data with a self-check (no keys needed)
  backtest.js      measures each contextual factor against real multi-season history, updates modelCoeffs.js
  refit-live-ledger.js   read-only: tests every factor against the real live results ledger's "beat the market"
                   outcomes instead of backtest.js's "beat own trailing average" proxy (see "Refitting against
                   the real live ledger" above) — `npm run refit-ledger`, needs NETLIFY_SITE_ID/NETLIFY_BLOBS_TOKEN
public/index.html  the entire frontend
```

Not betting advice.
