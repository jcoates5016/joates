// Synthetic dataset for `npm run dry-run` — exercises every factor category (play-by-play, schedule/rest/
// travel, weather/venue, and injury-trend ones) without needing any API keys. Not meant to look like a real
// week's slate, just enough shape in every table for the pipeline to touch every code path.
const SEASON = (s) => s;

function weeklyStatRow(season, week, name, team, opp, over) {
  return {
    season, week, player_display_name: name, player_name: name, recent_team: team, team, opponent_team: opp,
    position: "QB", passing_tds: over ? 2 : 1, passing_yards: over ? 280 : 210, rushing_tds: 0, rushing_yards: 5,
    receiving_tds: 0, receiving_yards: 0, receptions: 0, targets: 0, target_share: null, air_yards: null, air_yards_share: null
  };
}
function wrStatRow(season, week, name, team, opp, hit) {
  return {
    season, week, player_display_name: name, player_name: name, recent_team: team, team, opponent_team: opp,
    position: "WR", passing_tds: 0, passing_yards: 0, rushing_tds: 0, rushing_yards: 0,
    receiving_tds: hit ? 1 : 0, receiving_yards: hit ? 78 : 40, receptions: hit ? 6 : 3, targets: hit ? 9 : 5,
    target_share: 0.24, air_yards: 95, air_yards_share: 0.22
  };
}
// Marker row for the prior season — always 999 receiving yards, an unmistakably different value from anything
// in the current-season rows above, so a test can immediately tell whether a given game log entry came from
// "last season" or "this season."
function wrOldStatRow(season, week, name, team, opp) {
  return {
    season, week, player_display_name: name, player_name: name, recent_team: team, team, opponent_team: opp,
    position: "WR", passing_tds: 0, passing_yards: 0, rushing_tds: 0, rushing_yards: 0,
    receiving_tds: 1, receiving_yards: 999, receptions: 8, targets: 10,
    target_share: 0.3, air_yards: 110, air_yards_share: 0.28
  };
}

// nflverse's real play-by-play spells names "X.Surname" (e.g. "P.Mahomes"), never the full "Patrick Mahomes"
// every other source in this app uses — see identity.js's pbpShortKey. These fixtures use that same short form
// on purpose, so the dry-run actually exercises the real name-matching path instead of a full-name coincidence
// that would silently mask a regression in computePlayerRedZoneShare/computePlayerTwoMinuteShare.
function pbpPlay(gameId, week, pos, def, overrides = {}) {
  return {
    game_id: gameId, week, season_type: "REG", posteam: pos, defteam: def,
    qtr: 2, half_seconds_remaining: 400, down: 1, ydstogo: 10, yardline_100: 55, goal_to_go: 0,
    play_type: "pass", pass_attempt: 1, rush_attempt: 0, complete_pass: 1, sack: 0, qb_hit: 0,
    epa: 0.3, success: 1, pass_oe: 0.05, xpass: 0.5, air_yards: 8, yards_after_catch: 4,
    touchdown: 0, pass_touchdown: 0, rush_touchdown: 0,
    passer_player_name: "P.Mahomes", rusher_player_name: null, receiver_player_name: "D.Receiver",
    fourth_down_converted: 0, fourth_down_failed: 0, third_down_converted: 0, third_down_failed: 0,
    two_point_attempt: 0, fumble_lost: 0, interception: 0,
    posteam_score: 10, defteam_score: 7, score_differential: 3, drive: 3, drive_play_count: 6,
    drive_time_of_possession: "2:30", roof: "outdoors", surface: "grass", temp: 60, wind: 5, div_game: 0,
    ...overrides
  };
}

// Builds one Overs prop entry with a caller-chosen American price on both `fairOdds` and every book — precise
// control over where this leg's modelProb lands, since a thin/no-history filler player has no real own-evidence
// sample (ownEvidence returns null in probability.js), so the market-anchored blend collapses to exactly the
// market's own number with no nudge pulling it off that. That's what makes it possible to deliberately place
// legs into each of parlays.js's fixed probability bands instead of leaving band coverage to chance.
function fillerProp(eventID, keySuffix, statID, entityId, playerName, line, americanOdds) {
  return {
    betTypeID: "ou", periodID: "game", statID, statEntityID: entityId, playerName, sideID: "over",
    bookOverUnder: line, fairOverUnder: line, oddID: `${eventID}_${keySuffix}_over`, fairOdds: americanOdds,
    byBookmaker: { draftkings: { odds: americanOdds }, fanduel: { odds: americanOdds + 5 }, espnbet: { odds: americanOdds - 5 } }
  };
}

// Same idea, but DraftKings is deliberately given a different, plus-money price than the fair line/other books
// — a real, checkable "stale-line value" leg (see README's Data-quality gate section): the consensus (fairOdds,
// echoed by fanduel/espnbet) says this side is a real ~55-60% shot, but DraftKings hasn't updated and is still
// paying out like an underdog. `computeBestAcrossBooks` corroborates this as `staleValue` (kept), not `suspect`
// (excluded), since fanduel/espnbet both agree with the fair line within CORROBORATION_TOLERANCE. This is what
// makes it possible to deliberately place a real leg into Nuke's pool (lib/parlays.js: book price>0 AND
// modelProb still clearing the 55% floor) on DraftKings specifically, instead of leaving Nuke coverage to
// chance the way a plain fillerProp (whose book price and modelProb are the same number) never can.
function fillerPropValue(eventID, keySuffix, statID, entityId, playerName, line, fairAmericanOdds, dkAmericanOdds) {
  return {
    betTypeID: "ou", periodID: "game", statID, statEntityID: entityId, playerName, sideID: "over",
    bookOverUnder: line, fairOverUnder: line, oddID: `${eventID}_${keySuffix}_over`, fairOdds: fairAmericanOdds,
    byBookmaker: { draftkings: { odds: dkAmericanOdds }, fanduel: { odds: fairAmericanOdds + 3 }, espnbet: { odds: fairAmericanOdds - 3 } }
  };
}

// Lightweight "filler" games — deliberately simple (no game-log/factor depth, since that's already covered by
// the main BUF@KC fixture below) that exist purely to give the parlay/SGP/slate logic more than one real game
// to work with, AND to deliberately spread real legs across all three of parlays.js's fixed probability bands
// (Low -200-or-safer, Medium -150-to--200, High 55%-floor-to--150) on FOUR new, roster-only players per game
// (two WR/RB pairs, both pairs priced identically per band) — two legs per band per game, PLUS a fourth pair
// priced as a real stale-line-value leg (see fillerPropValue above) so Nuke has real, checkable coverage too,
// not just Low/Medium/High. No single game needs to fill every band on its own (a real NFL slate rarely offers
// legs spanning every band in one game either — see the design note on RISK_TIERS in parlays.js), but two of
// these games pooled into the same Sunday slate window give that window 4 real legs per band — exactly enough
// to fill every tier (Low needs 3, Medium/High need 4) while still leaving each INDIVIDUAL game's own Same Game
// Parlay honestly short on Low/Medium/High (only 2 real legs per band) — a deliberate, checkable demonstration
// of why this tier structure is pool-size-dependent. Kickoffs are fixed, real calendar timestamps — not "N days
// from now" — specifically so classifyKickoffWindow's Sunday 1:00pm/4:00pm ET bucketing can be tested
// deterministically; Nov 1, 2026 is a real Sunday, safely past that year's November daylight-saving change, so
// the Eastern-time conversion itself is actually exercised.
function fillerGame({ eventID, home, away, kickoffISO, wr1Name, rb1Name, wr2Name, rb2Name, wrRecYdsOdds, wrRecOdds, rbRushOdds, rbRecFairOdds, rbRecDkOdds }) {
  return {
    eventID,
    teams: {
      home: { names: { short: home, medium: home, long: home } },
      away: { names: { short: away, medium: away, long: away } }
    },
    status: { startsAt: kickoffISO },
    odds: {
      wr1_rec_yds: fillerProp(eventID, "wr1_rec_yds", "receiving_yards", `${eventID}_wr1`, wr1Name, 49.5, wrRecYdsOdds),
      wr1_receptions: fillerProp(eventID, "wr1_receptions", "receptions", `${eventID}_wr1`, wr1Name, 3.5, wrRecOdds),
      rb1_rush_yds: fillerProp(eventID, "rb1_rush_yds", "rushing_yards", `${eventID}_rb1`, rb1Name, 39.5, rbRushOdds),
      rb1_receptions: fillerPropValue(eventID, "rb1_receptions", "receptions", `${eventID}_rb1`, rb1Name, 1.5, rbRecFairOdds, rbRecDkOdds),
      wr2_rec_yds: fillerProp(eventID, "wr2_rec_yds", "receiving_yards", `${eventID}_wr2`, wr2Name, 49.5, wrRecYdsOdds),
      wr2_receptions: fillerProp(eventID, "wr2_receptions", "receptions", `${eventID}_wr2`, wr2Name, 3.5, wrRecOdds),
      rb2_rush_yds: fillerProp(eventID, "rb2_rush_yds", "rushing_yards", `${eventID}_rb2`, rb2Name, 39.5, rbRushOdds),
      rb2_receptions: fillerPropValue(eventID, "rb2_receptions", "receptions", `${eventID}_rb2`, rb2Name, 1.5, rbRecFairOdds, rbRecDkOdds)
    }
  };
}

export function buildDemoData(currentSeason, historySeasons) {
  const events = [{
    eventID: "demo-1",
    teams: {
      home: { names: { short: "BUF", medium: "Buffalo Bills", long: "Buffalo Bills" } },
      away: { names: { short: "KC", medium: "Kansas City Chiefs", long: "Kansas City Chiefs" } }
    },
    // Fixed, real Sunday-1:00pm-ET kickoff (not "N days from now") so the Same Game Parlay / slate-grouping
    // regression tests below have a deterministic window to check against.
    status: { startsAt: "2026-11-01T18:00:00Z" },
    // Player props only — game lines/moneylines were removed from this build entirely (see analyze.js/README).
    odds: {
      // FanDuel (and BetMGM on the receiving-yards market below) prove the widened BOOKS/BOOK_IDS set — beyond
      // just DraftKings/theScore Bet — actually flows through collectAutoPrices/computeBestAcrossBooks. FanDuel
      // is deliberately the best number here so the dry-run self-check can confirm a non-DK/SB book can win
      // "best price" now that more books are tracked, not just decorate the payload unused.
      mahomes_pass_td: { betTypeID: "ou", periodID: "game", statID: "passing_touchdowns", statEntityID: "mahomes_1_KC", playerName: "Patrick Mahomes", sideID: "over", bookOverUnder: 1.5, fairOverUnder: 1.5, oddID: "mahomes_pass_td_over", fairOdds: -125, byBookmaker: { draftkings: { odds: -120 }, espnbet: { odds: -130 }, fanduel: { odds: -110 } } },
      // A real passing-yards market — the exact prop the venue-split generalization test needs, since the
      // Passing TDs market above shares nothing with "how many yards does he throw for indoors vs outdoors."
      mahomes_pass_yds: { betTypeID: "ou", periodID: "game", statID: "passing_yards", statEntityID: "mahomes_1_KC", playerName: "Patrick Mahomes", sideID: "over", bookOverUnder: 259.5, fairOverUnder: 259.5, oddID: "mahomes_pass_yds_over", fairOdds: -108, byBookmaker: { draftkings: { odds: -105 }, espnbet: { odds: -112 } } },
      wr_rec_yds: { betTypeID: "ou", periodID: "game", statID: "receiving_yards", statEntityID: "demo_receiver_1_KC", playerName: "Demo Receiver", sideID: "over", bookOverUnder: 59.5, fairOverUnder: 59.5, oddID: "wr_rec_yds_over", fairOdds: -110, byBookmaker: { draftkings: { odds: -105 }, espnbet: { odds: -115 }, betmgm: { odds: -112 } } },
      // Anytime TD, modeled as BOTH a real yes/no market and a synthetic over/under-0.5 duplicate — this exact
      // duplication (confirmed against a live SportsGameOdds Rookie-tier refresh) is what caused wildly wrong
      // "Anytime TD" prices in production: the "ou" encoding's book prices don't match its own fairOdds, while
      // the "yn" encoding is internally consistent. classifyProp's betTypeID gate must keep only the "yn" row
      // here and reject the "ou" one — the dry-run self-check asserts exactly that.
      wr_anytime_td_yn: { betTypeID: "yn", periodID: "game", statID: "touchdowns", statEntityID: "demo_receiver_1_KC", playerName: "Demo Receiver", sideID: "yes", oddID: "touchdowns-demo_receiver_1_KC-game-yn-yes", fairOdds: 119, byBookmaker: { draftkings: { odds: 100 }, espnbet: { odds: 105 } } },
      wr_anytime_td_ou_broken: { betTypeID: "ou", periodID: "game", statID: "touchdowns", statEntityID: "demo_receiver_1_KC", playerName: "Demo Receiver", sideID: "over", bookOverUnder: 0.5, fairOverUnder: 0.5, oddID: "touchdowns-demo_receiver_1_KC-game-ou-over", fairOdds: 131, byBookmaker: { draftkings: { odds: 700 }, espnbet: { odds: 650 } } },
      // Mahomes throws a TD pass every week in this dataset (weeklyStatRow always sets passing_tds >= 1) but
      // never rushes for one (rushing_tds is always 0). His own Anytime TD hit rate must come out to 0%, not
      // ~100% — a real bug found live where throwing a TD pass was wrongly counted as the QB scoring one
      // himself. The dry-run self-check asserts this stays 0.
      mahomes_anytime_td_yn: { betTypeID: "yn", periodID: "game", statID: "touchdowns", statEntityID: "mahomes_1_KC", playerName: "Patrick Mahomes", sideID: "yes", oddID: "touchdowns-mahomes_1_KC-game-yn-yes", fairOdds: 550, byBookmaker: { draftkings: { odds: 500 }, espnbet: { odds: 575 } } },
      // Two more heavily-favored props on the OTHER side of this same game (Josh Allen, already a BUF roster
      // entry above) — pushes this single game's own qualifying-leg count to 6, so a Same Game Parlay on demo-1
      // alone can exercise every tier up to Mega (6 legs) without needing a second game.
      allen_pass_td: { betTypeID: "ou", periodID: "game", statID: "passing_touchdowns", statEntityID: "allen_1_BUF", playerName: "Josh Allen", sideID: "over", bookOverUnder: 1.5, fairOverUnder: 1.5, oddID: "allen_pass_td_over", fairOdds: -145, byBookmaker: { draftkings: { odds: -145 }, fanduel: { odds: -150 }, espnbet: { odds: -140 } } },
      allen_pass_yds: { betTypeID: "ou", periodID: "game", statID: "passing_yards", statEntityID: "allen_1_BUF", playerName: "Josh Allen", sideID: "over", bookOverUnder: 229.5, fairOverUnder: 229.5, oddID: "allen_pass_yds_over", fairOdds: -165, byBookmaker: { draftkings: { odds: -165 }, fanduel: { odds: -155 }, espnbet: { odds: -160 } } }
    }
  },
  // A second Sunday-1:00pm-ET filler game (alongside demo-1's real KC@BUF fixture and demo-2 below) — three
  // games in that window between them means the 1:00 slate parlay can fill every band from filler legs alone,
  // without depending on where demo-1's own (real, evidence-driven) props happen to land.
  fillerGame({ eventID: "demo-1b", home: "NYG", away: "WAS", kickoffISO: "2026-11-01T18:00:00Z", wr1Name: "Demo Giant", rb1Name: "Demo Commander", wr2Name: "Demo Giant Two", rb2Name: "Demo Commander Two",
    wrRecYdsOdds: -350, wrRecOdds: -175, rbRushOdds: -130, rbRecFairOdds: -130, rbRecDkOdds: 115 }),
  // Second Sunday-1:00pm-ET game — pairs with demo-1b (and demo-1) for the 1:00 slate parlay test. Odds chosen
  // to land cleanly inside each band — comfortably clear of both band edges so small factor nudges (defense/
  // matchup-edge, when they happen to resolve for a filler team) can't tip a leg into the wrong band.
  fillerGame({ eventID: "demo-2", home: "NYJ", away: "MIA", kickoffISO: "2026-11-01T18:00:00Z", wr1Name: "Demo Marlin", rb1Name: "Demo Gotham", wr2Name: "Demo Marlin Two", rb2Name: "Demo Gotham Two",
    wrRecYdsOdds: -360, wrRecOdds: -170, rbRushOdds: -128, rbRecFairOdds: -128, rbRecDkOdds: 120 }),
  // Two Sunday-4:05/4:25pm-ET games — pair with each other for the 4:00 slate parlay test. Odds chosen for
  // full-band coverage in this window (2 games x 2 legs/band = 4 legs/band, enough to fill every tier).
  fillerGame({ eventID: "demo-3", home: "PHI", away: "DAL", kickoffISO: "2026-11-01T21:05:00Z", wr1Name: "Demo Ranger", rb1Name: "Demo Liberty", wr2Name: "Demo Ranger Two", rb2Name: "Demo Liberty Two",
    wrRecYdsOdds: -390, wrRecOdds: -165, rbRushOdds: -135, rbRecFairOdds: -135, rbRecDkOdds: 125 }),
  fillerGame({ eventID: "demo-4", home: "LAR", away: "SEA", kickoffISO: "2026-11-01T21:25:00Z", wr1Name: "Demo Sound", rb1Name: "Demo Angeleno", wr2Name: "Demo Sound Two", rb2Name: "Demo Angeleno Two",
    wrRecYdsOdds: -410, wrRecOdds: -180, rbRushOdds: -125, rbRecFairOdds: -125, rbRecDkOdds: 110 }),
  // A Thursday-night game — outside both Sunday slate windows on purpose, so it only ever shows up via its own
  // Same Game Parlay (honestly falling short of every LOW/MEDIUM/HIGH tier, since no single band on this one
  // game ever reaches that band's own leg count on its own — see the shortfall regression test in dry-run.js).
  // Deliberately only ONE of the two receptions props here (rb1's) gets the stale-line-value Nuke treatment —
  // giving BOTH would push whichever band its fair price lands in from 2 legs to 4, which would equal
  // Medium/High's own leg count and make this "always-too-thin" fixture accidentally succeed on its own. rb2's
  // receptions leg instead stays a second, ordinary Medium-band leg — real Mega-payout material without
  // double-counting into a band this fixture is supposed to always fall short of.
  //
  // rb1's `rbRecFairOdds` is tuned to -115, not -140 like the rest of this game's props, for a reason that only
  // exists because of a later change: once lib/probability.js started using real stale-line value (this exact
  // flag) as a genuine `modelProb` nudge instead of just a cosmetic badge, rb1's OWN probability estimate moves
  // when it fires — at -140 that boost was big enough to push rb1 from the High band into the SAME Medium band
  // as wr1/wr2/rb2, handing this fixture 4 real Medium legs (exactly enough to succeed) by accident, for a
  // completely different reason than the "giving both legs the Nuke treatment" scenario already guarded against
  // above. -115 keeps rb1's post-nudge probability in the High band where it was always meant to land, while
  // still comfortably clearing the stale-value edge threshold (see the dry-run stale-line-value nudge test).
  (() => {
    const g = fillerGame({ eventID: "demo-5", home: "HOU", away: "TEN", kickoffISO: "2026-10-30T00:15:00Z", wr1Name: "Demo Volunteer", rb1Name: "Demo Astro", wr2Name: "Demo Volunteer Two", rb2Name: "Demo Astro Two",
      wrRecYdsOdds: -370, wrRecOdds: -185, rbRushOdds: -140, rbRecFairOdds: -115, rbRecDkOdds: 130 });
    g.odds.rb2_receptions = fillerProp("demo-5", "rb2_receptions", "receptions", "demo-5_rb2", "Demo Astro Two", 1.5, -175);
    return g;
  })()
  ];

  const statRows = [];
  for (let w = 1; w <= 5; w++) {
    statRows.push(weeklyStatRow(currentSeason, w, "Patrick Mahomes", "KC", w === 5 ? "BUF" : "DEN", w >= 3));
    statRows.push(wrStatRow(currentSeason, w, "Demo Receiver", "KC", w === 5 ? "BUF" : "DEN", w % 2 === 0));
  }
  // Two extra Mahomes weeks, both on the road at an outdoor stadium, with passing yards well clear of his dome
  // numbers above (245 avg across weeks 1-4) — the regression case for the generalized venue split: before this
  // fix, computeVenueSplit measured (receiving+rushing yards) for every player regardless of prop, so a QB's
  // indoor/outdoor split was always ~0 vs ~0, not a real number. This proves the fix actually keys off
  // passing_yards for a pass_yds prop.
  statRows.push({
    season: currentSeason, week: 6, player_display_name: "Patrick Mahomes", player_name: "Patrick Mahomes",
    recent_team: "KC", team: "KC", opponent_team: "MIA", position: "QB",
    passing_tds: 2, passing_yards: 350, rushing_tds: 0, rushing_yards: 5,
    receiving_tds: 0, receiving_yards: 0, receptions: 0, targets: 0, target_share: null, air_yards: null, air_yards_share: null
  });
  statRows.push({
    season: currentSeason, week: 7, player_display_name: "Patrick Mahomes", player_name: "Patrick Mahomes",
    recent_team: "KC", team: "KC", opponent_team: "MIA", position: "QB",
    passing_tds: 2, passing_yards: 360, rushing_tds: 0, rushing_yards: 5,
    receiving_tds: 0, receiving_yards: 0, receptions: 0, targets: 0, target_share: null, air_yards: null, air_yards_share: null
  });
  historySeasons.filter(s => s !== currentSeason).forEach(s => {
    statRows.push(weeklyStatRow(s, 1, "Patrick Mahomes", "KC", "BUF", true));
  });
  // Ten prior-season games for Demo Receiver, pushed into statRows AFTER his 5 current-season rows above —
  // exactly how a real multi-season fetch concatenates (current season first, earlier seasons appended after).
  // This is the regression case for two things at once: (1) buildGameLogIndex must sort each player's rows
  // chronologically, or these older-but-pushed-later rows would corrupt rate_last3 with a year-old game: proves
  // the last-3/last-10 "most recent" slice logic is trustworthy across a season boundary, not just coincidentally
  // correct because no older rows existed; (2) "last 10 games" must be a real 10-game cap — with 5 current-season
  // rows plus these 10, there are 15 total, so the 5 OLDEST of these prior-season rows (weeks 1-5) must be
  // excluded from rate_last10 while the 5 newest (weeks 6-10) are included alongside all 5 current-season rows.
  for (let w = 1; w <= 10; w++) {
    statRows.push(wrOldStatRow(currentSeason - 1, w, "Demo Receiver", "KC", w % 2 === 0 ? "DEN" : "MIA"));
  }
  // Backup QB's own thin garbage-time log — only 2 of the 5 current-season weeks, meaning he was "not active"
  // (by this pipeline's approximation) the other 3. Before the fix, that pattern was exactly what made
  // findKeyTeammate pick him as Mahomes's "key teammate" and computeTeammateOutTendency compare Mahomes's stats
  // across those two buckets — a comparison that can't reflect anything real, since the backup never plays
  // alongside a healthy starter. This must now stay unavailable for Mahomes regardless.
  statRows.push(weeklyStatRow(currentSeason, 2, "Demo Backup Qb", "KC", "DEN", false));
  statRows.push(weeklyStatRow(currentSeason, 4, "Demo Backup Qb", "KC", "DEN", false));
  // A couple more WR-position games against BUF (a different player, so this is a real league-wide sample
  // rather than one player's own history) so computeDefenseVsPosition has n>=2 games to rank BUF's
  // defense-vs-WR from — otherwise the demo slate's actual matchup (KC @ BUF) would have no sample to grade.
  statRows.push(wrStatRow(historySeasons[historySeasons.length - 1], 8, "Demo Bills Opponent Wr", "MIA", "BUF", true));
  statRows.push(wrStatRow(historySeasons[historySeasons.length - 1], 9, "Demo Bills Opponent Wr", "MIA", "BUF", false));

  const schedRows = [];
  // Filler games so rest/travel lookups have real rows.
  for (let w = 1; w <= 4; w++) {
    schedRows.push({
      season: currentSeason, week: w, home_team: "KC", away_team: "DEN", gameday: `2026-09-${(w * 7).toString().padStart(2, "0")}`,
      roof: "dome", location: "Home", stadium: "GEHA Field at Arrowhead Stadium",
      away_rest: 7, home_rest: 7, away_qb_name: "Bo Nix", home_qb_name: "Patrick Mahomes"
    });
    schedRows.push({
      season: currentSeason, week: w, home_team: "BUF", away_team: "MIA", gameday: `2026-09-${(w * 7).toString().padStart(2, "0")}`,
      roof: "outdoors", location: "Home", stadium: "Highmark Stadium",
      away_rest: 7, home_rest: 7, away_qb_name: "Tua Tagovailoa", home_qb_name: "Josh Allen"
    });
  }
  schedRows.push({
    season: currentSeason, week: 5, home_team: "BUF", away_team: "KC", gameday: "2026-10-05",
    roof: "outdoors", location: "Home", stadium: "Highmark Stadium",
    away_rest: 7, home_rest: 10, away_qb_name: "Patrick Mahomes", home_qb_name: "Josh Allen"
  });
  // Weeks 6-7: KC on the road at MIA, both outdoors — pairs with the two extra Mahomes stat rows above so
  // computeVenueSplit has a real outdoor sample (n=3: weeks 5,6,7) to compare against the dome sample (n=4).
  ["2026-10-12", "2026-10-19"].forEach((date, i) => {
    schedRows.push({
      season: currentSeason, week: 6 + i, home_team: "MIA", away_team: "KC", gameday: date,
      roof: "outdoors", location: "Home", stadium: "Hard Rock Stadium",
      away_rest: 7, home_rest: 7, away_qb_name: "Patrick Mahomes", home_qb_name: "Demo Dolphins Qb"
    });
  });

  const rosterRows = [
    { full_name: "Patrick Mahomes", gsis_id: "mahomes1", team: "KC", position: "QB", birth_date: "1995-09-17" },
    { full_name: "Demo Receiver", gsis_id: "receiver1", team: "KC", position: "WR", birth_date: "1997-01-01" },
    { full_name: "Demo Teammate Wr", gsis_id: "receiver2", team: "KC", position: "WR", birth_date: "1998-01-01" },
    { full_name: "Demo Tackle", gsis_id: "tackle1", team: "KC", position: "T", birth_date: "1994-01-01" },
    { full_name: "Josh Allen", gsis_id: "allen1", team: "BUF", position: "QB", birth_date: "1996-05-21" },
    // A real backup QB on KC's own roster, with his own (thin) game log below — exists specifically so the
    // "no teammate-out tendency talk for QBs" regression test proves the fix isn't just "no candidate existed
    // to find," but that a real one exists and is still correctly ignored (findKeyTeammate returns null for QB).
    { full_name: "Demo Backup Qb", gsis_id: "backupqb1", team: "KC", position: "QB", birth_date: "1999-03-10" },
    // Regression fixture for the roster-index week-sorting fix (see buildRosterIndex in identity.js):
    // roster_weekly_<season>.csv is one row per player PER WEEK, and a traded player has one row per team he
    // was on that season (confirmed live: Joe Flacco, Darius Slay, Adam Thielen all show 2+ teams in the same
    // season file). Listed here in deliberately scrambled, non-chronological order — real file order isn't
    // guaranteed sorted by week — so a naive "last row in the file wins" implementation would resolve to
    // whichever row happened to land last in raw order, not necessarily his current team. He was on DEN
    // through week 3, traded to KC for weeks 4-5; the only correct resolution is KC.
    { full_name: "Demo Traded Wr", gsis_id: "traded1", team: "DEN", position: "WR", birth_date: "1996-06-06", week: 2, game_type: "REG" },
    { full_name: "Demo Traded Wr", gsis_id: "traded1", team: "KC", position: "WR", birth_date: "1996-06-06", week: 5, game_type: "REG" },
    { full_name: "Demo Traded Wr", gsis_id: "traded1", team: "DEN", position: "WR", birth_date: "1996-06-06", week: 1, game_type: "REG" },
    { full_name: "Demo Traded Wr", gsis_id: "traded1", team: "KC", position: "WR", birth_date: "1996-06-06", week: 4, game_type: "REG" },
    { full_name: "Demo Traded Wr", gsis_id: "traded1", team: "DEN", position: "WR", birth_date: "1996-06-06", week: 3, game_type: "REG" },
    // A stray non-REG row with a bogus team and a week number that would sort after week 5 if the REG-only
    // filter didn't exclude it — proves postseason rows can't accidentally win the "most recent" slot.
    { full_name: "Demo Traded Wr", gsis_id: "traded1", team: "PRO", position: "WR", birth_date: "1996-06-06", week: 1, game_type: "PRO" },
    // Regression fixture for the roster/depth-chart conflict path (resolvePlayer in identity.js): his weekly
    // roster row still says DEN — nflverse's roster file only refreshes on its own weekly cadence — but the
    // depth-chart fixture below (a stand-in for a scrape taken today) already shows him on KC, standing in for
    // a same-day trade the roster file hasn't caught up to yet. The depth chart's team must win, and
    // rosterConflict must come back true.
    { full_name: "Demo Fresh Trade Wr", gsis_id: "freshtrade1", team: "DEN", position: "WR", birth_date: "1999-08-08" },
    // Roster-only entries for the filler games above (see fillerGame) — just enough for resolvePlayer to find
    // the right team and avoid a false teamMismatch; no game-log history needed since these props' modelProb
    // just anchors to the market (see estimatePropProbability) when no real evidence is available. Two WR/RB
    // pairs per filler game (see fillerGame's own comment for why), plus demo-1b's own pair for the 1:00 slate.
    { full_name: "Demo Marlin", gsis_id: "dolphinswr1", team: "MIA", position: "WR", birth_date: "1998-04-01" },
    { full_name: "Demo Marlin Two", gsis_id: "dolphinswr2", team: "MIA", position: "WR", birth_date: "1998-04-02" },
    { full_name: "Demo Gotham", gsis_id: "jetsrb1", team: "NYJ", position: "RB", birth_date: "1998-04-01" },
    { full_name: "Demo Gotham Two", gsis_id: "jetsrb2", team: "NYJ", position: "RB", birth_date: "1998-04-02" },
    { full_name: "Demo Ranger", gsis_id: "cowboyswr1", team: "DAL", position: "WR", birth_date: "1998-04-01" },
    { full_name: "Demo Ranger Two", gsis_id: "cowboyswr2", team: "DAL", position: "WR", birth_date: "1998-04-02" },
    { full_name: "Demo Liberty", gsis_id: "eaglesrb1", team: "PHI", position: "RB", birth_date: "1998-04-01" },
    { full_name: "Demo Liberty Two", gsis_id: "eaglesrb2", team: "PHI", position: "RB", birth_date: "1998-04-02" },
    { full_name: "Demo Sound", gsis_id: "seahawkswr1", team: "SEA", position: "WR", birth_date: "1998-04-01" },
    { full_name: "Demo Sound Two", gsis_id: "seahawkswr2", team: "SEA", position: "WR", birth_date: "1998-04-02" },
    { full_name: "Demo Angeleno", gsis_id: "ramsrb1", team: "LAR", position: "RB", birth_date: "1998-04-01" },
    { full_name: "Demo Angeleno Two", gsis_id: "ramsrb2", team: "LAR", position: "RB", birth_date: "1998-04-02" },
    { full_name: "Demo Volunteer", gsis_id: "titanswr1", team: "TEN", position: "WR", birth_date: "1998-04-01" },
    { full_name: "Demo Volunteer Two", gsis_id: "titanswr2", team: "TEN", position: "WR", birth_date: "1998-04-02" },
    { full_name: "Demo Astro", gsis_id: "texansrb1", team: "HOU", position: "RB", birth_date: "1998-04-01" },
    { full_name: "Demo Astro Two", gsis_id: "texansrb2", team: "HOU", position: "RB", birth_date: "1998-04-02" },
    { full_name: "Demo Giant", gsis_id: "giantswr1", team: "NYG", position: "WR", birth_date: "1998-04-01" },
    { full_name: "Demo Giant Two", gsis_id: "giantswr2", team: "NYG", position: "WR", birth_date: "1998-04-02" },
    { full_name: "Demo Commander", gsis_id: "commandersrb1", team: "WAS", position: "RB", birth_date: "1998-04-01" },
    { full_name: "Demo Commander Two", gsis_id: "commandersrb2", team: "WAS", position: "RB", birth_date: "1998-04-02" }
  ];
  const snapRows = [1, 2, 3, 4, 5].flatMap(w => [
    { player: "Patrick Mahomes", team: "KC", week: w, offense_pct: 1.0 },
    { player: "Demo Receiver", team: "KC", week: w, offense_pct: 0.82 }
  ]);

  const pbpRows = [];
  for (let i = 0; i < 20; i++) {
    pbpRows.push(pbpPlay(`${currentSeason}_01_KC_DEN`, 1, "KC", "DEN", { yardline_100: i < 4 ? 12 : 55, down: (i % 4) + 1, third_down_converted: i % 4 === 2 ? 1 : 0 }));
  }
  for (let i = 0; i < 6; i++) {
    pbpRows.push(pbpPlay(`${currentSeason}_01_KC_DEN`, 1, "KC", "DEN", { yardline_100: 3, goal_to_go: 1, touchdown: i === 2 ? 1 : 0, rush_attempt: 1, pass_attempt: 0, rusher_player_name: "D.Receiver", receiver_player_name: null }));
  }
  // BUF appears on both sides of the ball too (as offense vs. MIA, and as defense against MIA), so the KC-vs-BUF
  // matchup-edge factor has a real `BUF` entry in the team-season index to compare KC's offense against.
  for (let i = 0; i < 15; i++) {
    pbpRows.push(pbpPlay(`${currentSeason}_01_BUF_MIA`, 1, "BUF", "MIA", { yardline_100: i < 3 ? 15 : 55, passer_player_name: "J.Allen", receiver_player_name: "D.Wr" }));
    pbpRows.push(pbpPlay(`${currentSeason}_01_MIA_BUF`, 1, "MIA", "BUF", { yardline_100: 55, passer_player_name: "D.Qb", receiver_player_name: "D.Wr", epa: -0.1, success: 0 }));
  }

  // Real fixture for the opposing-secondary-injury factor: BUF is KC's week-5 opponent, so every KC passing-game
  // prop (Mahomes's passing TDs, Demo Receiver's receiving yards) should see this. `fetchInjuries` itself is
  // never called in demo mode (no network in dry-run), so this stands in for that live ESPN pull.
  const injuriesByTeam = {
    BUF: [
      { name: "Demo Bills Corner", position: "CB", status: "Out", detail: "hamstring" },
      { name: "Demo Bills Safety", position: "S", status: "Doubtful", detail: "knee" }
    ]
  };

  // Stand-in for nflverse's real depth_charts_<season>.csv (fetchDepthCharts in fetchers/nflverse.js) — a
  // ranked WR1/WR2/QB1/QB2-style list, already trimmed to "most recent scrape" the way the real fetcher does.
  const depthChartRows = [
    // KC's real depth-chart shape: Demo Receiver is the WR1, Demo Teammate Wr is the WR2 — the regression case
    // for findKeyTeammate (factors/index.js): when the player IS the WR1, the "key teammate" it should surface
    // is the next-best depth-chart WR (WR2), not "no result" (which is what a naive "must be rank 1" read
    // would produce once the player himself occupies that slot).
    { dt: "2026-09-17", team: "KC", player_name: "Demo Receiver", pos_abb: "WR", pos_rank: 1 },
    { dt: "2026-09-17", team: "KC", player_name: "Demo Teammate Wr", pos_abb: "WR", pos_rank: 2 },
    { dt: "2026-09-17", team: "KC", player_name: "Patrick Mahomes", pos_abb: "QB", pos_rank: 1 },
    { dt: "2026-09-17", team: "KC", player_name: "Demo Backup Qb", pos_abb: "QB", pos_rank: 2 },
    // Matches the roster fixture's own (correct, post-fix) resolution — no conflict here, since that fixture's
    // whole point is proving the roster index gets the right team without any depth-chart help.
    { dt: "2026-09-17", team: "KC", player_name: "Demo Traded Wr", pos_abb: "WR", pos_rank: 3 },
    // The roster/depth-chart conflict case — see the comment on the "Demo Fresh Trade Wr" roster row above.
    { dt: "2026-09-17", team: "KC", player_name: "Demo Fresh Trade Wr", pos_abb: "WR", pos_rank: 4 }
  ];

  return { events, statRows, schedRows, rosterRows, snapRows, pbpRows, depthChartRows, injuriesByTeam };
}
