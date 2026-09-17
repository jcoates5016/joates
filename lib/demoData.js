// Synthetic dataset for `npm run dry-run` — exercises every factor category (including the new play-by-play,
// schedule/rest/travel, referee, and injury-trend ones) without needing any API keys. Not meant to look like a
// real week's slate, just enough shape in every table for the pipeline to touch every code path.
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

function pbpPlay(gameId, week, pos, def, overrides = {}) {
  return {
    game_id: gameId, week, season_type: "REG", posteam: pos, defteam: def,
    qtr: 2, half_seconds_remaining: 400, down: 1, ydstogo: 10, yardline_100: 55, goal_to_go: 0,
    play_type: "pass", pass_attempt: 1, rush_attempt: 0, complete_pass: 1, sack: 0, qb_hit: 0,
    epa: 0.3, success: 1, pass_oe: 0.05, xpass: 0.5, air_yards: 8, yards_after_catch: 4,
    touchdown: 0, pass_touchdown: 0, rush_touchdown: 0,
    passer_player_name: "Patrick Mahomes", rusher_player_name: null, receiver_player_name: "Demo Receiver",
    fourth_down_converted: 0, fourth_down_failed: 0, third_down_converted: 0, third_down_failed: 0,
    two_point_attempt: 0, fumble_lost: 0, interception: 0,
    posteam_score: 10, defteam_score: 7, score_differential: 3, drive: 3, drive_play_count: 6,
    drive_time_of_possession: "2:30", roof: "outdoors", surface: "grass", temp: 60, wind: 5, div_game: 0,
    ...overrides
  };
}

export function buildDemoData(currentSeason, historySeasons) {
  const events = [{
    eventID: "demo-1",
    teams: {
      home: { names: { short: "BUF", medium: "Buffalo Bills", long: "Buffalo Bills" } },
      away: { names: { short: "KC", medium: "Kansas City Chiefs", long: "Kansas City Chiefs" } }
    },
    status: { startsAt: new Date(Date.now() + 3 * 86400000).toISOString() },
    // Only Total (Over) game lines — no Moneyline, no Spread, matching the build's Totals-Overs-only scope.
    odds: {
      tot_over: { betTypeID: "ou", periodID: "game", statID: "total_points", sideID: "over", bookOverUnder: 47.5, fairOverUnder: 47.5, oddID: "tot_over", fairOdds: -110, byBookmaker: { draftkings: { odds: -108, openOdds: -112 }, espnbet: { odds: -112 } }, bookOverUnder: 47.5, openOverUnder: 48 },
      tot_under: { betTypeID: "ou", periodID: "game", statID: "total_points", sideID: "under", bookOverUnder: 47.5, oddID: "tot_under", byBookmaker: { draftkings: { odds: -112 }, espnbet: { odds: -108 } } },
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
      mahomes_anytime_td_yn: { betTypeID: "yn", periodID: "game", statID: "touchdowns", statEntityID: "mahomes_1_KC", playerName: "Patrick Mahomes", sideID: "yes", oddID: "touchdowns-mahomes_1_KC-game-yn-yes", fairOdds: 550, byBookmaker: { draftkings: { odds: 500 }, espnbet: { odds: 575 } } }
    }
  }];

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
  // Filler games so the referee factor has enough sample size, and so rest/travel lookups have real rows.
  let refereeNames = ["Demo Ref", "Demo Ref", "Demo Ref", "Demo Ref", "Demo Ref", "Demo Ref", "Demo Ref", "Demo Ref", "Demo Ref"];
  for (let w = 1; w <= 4; w++) {
    schedRows.push({
      season: currentSeason, week: w, home_team: "KC", away_team: "DEN", gameday: `2026-09-${(w * 7).toString().padStart(2, "0")}`,
      roof: "dome", location: "Home", referee: refereeNames[w], stadium: "GEHA Field at Arrowhead Stadium",
      total: 45 + w, total_line: 44.5, away_rest: 7, home_rest: 7, away_qb_name: "Bo Nix", home_qb_name: "Patrick Mahomes"
    });
    schedRows.push({
      season: currentSeason, week: w, home_team: "BUF", away_team: "MIA", gameday: `2026-09-${(w * 7).toString().padStart(2, "0")}`,
      roof: "outdoors", location: "Home", referee: refereeNames[w + 1], stadium: "Highmark Stadium",
      total: 41 + w, total_line: 43, away_rest: 7, home_rest: 7, away_qb_name: "Tua Tagovailoa", home_qb_name: "Josh Allen"
    });
  }
  schedRows.push({
    season: currentSeason, week: 5, home_team: "BUF", away_team: "KC", gameday: "2026-10-05",
    roof: "outdoors", location: "Home", referee: "Demo Ref", stadium: "Highmark Stadium",
    total: null, total_line: 47.5, away_rest: 7, home_rest: 10, away_qb_name: "Patrick Mahomes", home_qb_name: "Josh Allen"
  });
  // Weeks 6-7: KC on the road at MIA, both outdoors — pairs with the two extra Mahomes stat rows above so
  // computeVenueSplit has a real outdoor sample (n=3: weeks 5,6,7) to compare against the dome sample (n=4).
  ["2026-10-12", "2026-10-19"].forEach((date, i) => {
    schedRows.push({
      season: currentSeason, week: 6 + i, home_team: "MIA", away_team: "KC", gameday: date,
      roof: "outdoors", location: "Home", referee: "Demo Ref", stadium: "Hard Rock Stadium",
      total: 45, total_line: 44, away_rest: 7, home_rest: 7, away_qb_name: "Patrick Mahomes", home_qb_name: "Demo Dolphins Qb"
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
    { full_name: "Demo Backup Qb", gsis_id: "backupqb1", team: "KC", position: "QB", birth_date: "1999-03-10" }
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
    pbpRows.push(pbpPlay(`${currentSeason}_01_KC_DEN`, 1, "KC", "DEN", { yardline_100: 3, goal_to_go: 1, touchdown: i === 2 ? 1 : 0, rush_attempt: 1, pass_attempt: 0, rusher_player_name: "Demo Receiver", receiver_player_name: null }));
  }
  // BUF appears on both sides of the ball too (as offense vs. MIA, and as defense against MIA), so the KC-vs-BUF
  // matchup-edge factor has a real `BUF` entry in the team-season index to compare KC's offense against.
  for (let i = 0; i < 15; i++) {
    pbpRows.push(pbpPlay(`${currentSeason}_01_BUF_MIA`, 1, "BUF", "MIA", { yardline_100: i < 3 ? 15 : 55, passer_player_name: "Josh Allen", receiver_player_name: "Demo Bills Wr" }));
    pbpRows.push(pbpPlay(`${currentSeason}_01_MIA_BUF`, 1, "MIA", "BUF", { yardline_100: 55, passer_player_name: "Demo Dolphins Qb", receiver_player_name: "Demo Dolphins Wr", epa: -0.1, success: 0 }));
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

  return { events, statRows, schedRows, rosterRows, snapRows, pbpRows, injuriesByTeam };
}
