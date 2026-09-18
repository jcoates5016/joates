// AI reasoning layers, server-side only — the Anthropic key lives in a Netlify environment variable.
// Two distinct buckets, and they're never allowed to blur together:
//   1. Analytical notes (annotateGameLinesWithAI / annotatePropsWithAI / annotateParlaysWithAI): cite only the
//      real, computed numbers this pipeline actually produced (EPA matchup edge, opponent-vs-position rank,
//      red-zone share, referee history, starter changes, etc.) — the prompt explicitly forbids inventing
//      anything. Defensive matchup numbers are real, computed inputs here, not something withheld from the AI.
//   2. Scouting takes (annotateScoutingTakes): the one place genuinely speculative color lives — coverage
//      scheme tendencies, personnel-package guesses, revenge-game/contract-year narrative. Nflverse's own
//      participation dataset (which would make personnel/blitz-package data real) was confirmed dead for
//      in-season use before this was built, so these stay explicitly hedged, never presented as computed.
import { getPrice, BOOKS } from "./analyze.js";

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";

async function callClaude(apiKey, systemPrompt, userPrompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 4500, system: systemPrompt, messages: [{ role: "user", content: userPrompt }] })
  });
  if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error(`Anthropic ${res.status}: ${t.slice(0, 200)}`); }
  const json = await res.json();
  const text = json.content?.map(c => c.text).join("") || "";
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("Could not find JSON array in Claude's response");
  return JSON.parse(match[0]);
}

export async function annotateGameLinesWithAI(rows, apiKey, log = () => {}) {
  const candidates = rows.filter(r => !r.suspect && (r.bestEdge > 0.01 || r.arb)).slice(0, 25);
  if (!candidates.length) return;
  const payload = candidates.map((r, i) => ({
    id: i, matchup: r.matchup, market: r.market, side: r.side, bestBook: BOOKS[r.bestBook]?.label,
    bestPrice: r.bestPrice, arb: !!r.arb, arbMargin: r.arbMargin || null,
    allPrices: Object.fromEntries(Object.keys(BOOKS).map(b => [BOOKS[b].label, getPrice(r, b)]).filter(([, v]) => v != null)),
    keyNumber: r.factors?.keyNumber?.available ? r.factors.keyNumber : null,
    homeTeamOffense: r.factors?.teamContext?.home, awayTeamOffense: r.factors?.teamContext?.away,
    matchupEdge: r.factors?.matchupEdge || null,
    scoringEnvironment: r.factors?.scoringEnvironment?.available ? r.factors.scoringEnvironment : null,
    referee: r.factors?.referee?.available ? r.factors.referee : null,
    restAndTravel: r.factors?.schedule
  }));
  try {
    const results = await callClaude(apiKey,
      `You are a sharp sports betting analyst. This build tracks NFL Total (Over) game lines. Given price comparisons across ` +
      `DraftKings and theScore Bet, plus real computed context (each team's own offensive and defensive EPA/play and pace, a ` +
      `home-offense-vs-away-defense and away-offense-vs-home-defense matchup edge, a combined scoring-environment number, referee ` +
      `over/under history, rest/travel), return a JSON array, one object per input id: {"id":<int>,"tag":"value"|"pass"|"arb", ` +
      `"note":"<one or two sentence rationale, cite the actual numbers given including the defensive matchup edge when it's meaningful, ` +
      `name the best book, never invent a fact not given>"}. Only output the JSON array.`,
      JSON.stringify(payload));
    results.forEach(r => { if (candidates[r.id]) candidates[r.id].ai = r; });
  } catch (e) { log("AI game-line annotation failed: " + e.message); }
}

export async function annotatePropsWithAI(rows, apiKey, log = () => {}) {
  const candidates = rows.filter(r => !r.teamMismatch && !r.suspect && ((r.bestEdge > 0.02) || (r.factors && Object.values(r.factors).some(f => f && f.available))))
    .sort((a, b) => (b.bestEdge ?? -1) - (a.bestEdge ?? -1)).slice(0, 35);
  if (!candidates.length) return;
  const payload = candidates.map((r, i) => {
    const f = r.factors || {};
    return {
      id: i, player: r.player, team: r.team, opponent: r.opponentDisp || r.opponent, prop: r.propLabel, side: r.side, line: r.line,
      bestBook: BOOKS[r.bestBook]?.label, bestPrice: r.bestPrice,
      defense_vs_position: f.defense?.available ? f.defense : null,
      matchup_epa_edge: f.matchupEdge?.available ? f.matchupEdge : null,
      scoring_environment: f.scoringEnvironment?.available ? f.scoringEnvironment : null,
      recent_form: f.form?.available ? { season_hit_rate: f.form.rate_season, last3_hit_rate: f.form.rate_last3, vs_opp_hit_rate: f.form.rate_vsOpp, vs_opp_games: f.form.n_vsOpp } : null,
      usage_without_teammate: f.tendency?.available ? f.tendency : null,
      red_zone_share: f.redZone?.available ? f.redZone : null,
      two_minute_share: f.twoMinute?.available ? f.twoMinute : null,
      venue: f.venue?.available ? f.venue : null,
      weather_forecast: f.weatherForecast || null,
      weather_historical_split: f.weatherHistorical?.available ? f.weatherHistorical : null,
      birthday: f.birthday?.available ? f.birthday : null,
      usage: f.usage?.available ? f.usage : null,
      injury_flags: null, self_injury_status: f.selfInjury ? `${f.selfInjury.status}${f.selfInjury.detail ? ": " + f.selfInjury.detail : ""}` : null,
      o_line_injuries: f.oLineInjury?.available ? f.oLineInjury : null,
      practice_trend: f.practiceTrend?.available ? f.practiceTrend : null,
      starter_change: f.starterChange?.available && f.starterChange.changed ? f.starterChange : null,
      rest_and_travel: f.schedule?.available ? f.schedule : null,
      referee_history: f.referee?.available ? f.referee : null,
      line_movement: f.marketMovement?.available ? f.marketMovement : null,
      situational_note: f.situationalNote || null
    };
  });
  try {
    const results = await callClaude(apiKey,
      `You are a sharp NFL player-props analyst, evaluating Over-only offensive props (passing/rushing/receiving yards and touchdowns, ` +
      `receptions). You're given real computed numbers: how this opponent ranks league-wide against this position (defense_vs_position), ` +
      `this player's team's EPA/play against this specific opponent's defense (matchup_epa_edge), red-zone/two-minute usage share, recent ` +
      `form, a combined offense-vs-offense scoring-environment number, rest/travel, referee history, starter changes, line movement, ` +
      `injuries. Return a JSON array, one object per id: {"id":<int>,"tag":"lean-over"|"thin","note":"<two to four sentence plain-English ` +
      `take, citing real numbers including the defensive matchup when it's meaningful, flagging small samples (under 3 games), never ` +
      `inventing a fact not given>"}. Only output the JSON array.`,
      JSON.stringify(payload));
    results.forEach(r => { if (candidates[r.id]) candidates[r.id].ai = r; });
  } catch (e) { log("AI prop annotation failed: " + e.message); }
}

// The explicitly-speculative bucket. Nothing here is computed — it's Claude's general football knowledge
// applied to a matchup, clearly hedged, never presented as a real number. Nflverse's own participation dataset
// (which would make real personnel/blitz-package counts possible) was confirmed discontinued for in-season
// release before this was built, so coverage-scheme and personnel-package content stays here, speculative and
// clearly labeled, rather than being computed or omitted outright.
export async function annotateScoutingTakes(rows, apiKey, log = () => {}) {
  const candidates = rows.filter(r => !r.teamMismatch && !r.suspect && ["rec_yds", "td", "td_rush", "td_rec", "rush_yds"].includes(r.propType)).slice(0, 25);
  if (!candidates.length) return;
  const payload = candidates.map((r, i) => ({ id: i, player: r.player, team: r.team, opponent: r.opponentDisp || r.opponent, prop: r.propLabel }));
  try {
    const results = await callClaude(apiKey,
      `You are giving a "scouting take" using your general football knowledge — NOT stats computed by the tool. Speculate on things no ` +
      `free stats feed covers this season: the opponent's likely coverage scheme or personnel-package tendencies against this position, ` +
      `revenge-game or contract-year storylines for this player, and anything else a sharp scout would flag from general football ` +
      `knowledge. Say plainly when nothing genuinely applies rather than inventing a stretch. Return a JSON array: {"id":<int>, ` +
      `"note":"<one or two sentences, hedge appropriately, never state as verified fact>"}. Only output the JSON array.`,
      JSON.stringify(payload));
    results.forEach(r => { if (candidates[r.id]) candidates[r.id].scouting = r; });
  } catch (e) { log("Scouting-take annotation failed: " + e.message); }
}

export async function annotateParlaysWithAI(parlays, apiKey, log = () => {}) {
  const valid = parlays.filter(p => p.ok);
  if (!valid.length) return;
  const payload = valid.map((p, i) => ({
    id: i, tier: p.tier.label, book: BOOKS[p.book].label, combinedOdds: p.combinedAmerican, combinedImpliedProbability: p.combinedProb,
    legs: p.legs.map(l => ({ label: l.label, price: l.price, edge: l.edge, supportingFactors: l.kind === "prop" ? Object.entries(l.row.factors || {}).filter(([, v]) => v && (v.available || (Array.isArray(v) && v.length))).map(([k]) => k) : (l.row.arb ? ["arbitrage"] : []) }))
  }));
  try {
    const results = await callClaude(apiKey,
      `You are writing a short rationale for pre-built NFL parlays. Return one object per id: {"id":<int>,"note":"<two to three ` +
      `sentences: name the tier's intent, reference 1-2 strongest legs and what backs them, flag any shared-game correlation — never invent a fact>"}. ` +
      `Only output the JSON array.`,
      JSON.stringify(payload));
    results.forEach(r => { if (valid[r.id]) valid[r.id].ai = r; });
  } catch (e) { log("Parlay AI annotation failed: " + e.message); }
}
