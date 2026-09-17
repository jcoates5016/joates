// Aggregates the current season's play-by-play into one row per team: offensive efficiency (what this team
// does with the ball) and defensive efficiency (what this team allows). This is the base layer several other
// factors build on — matchup edge, pace, red-zone share, pressure rate, turnover-luck, and the "team context"
// panel the frontend shows per game line. Both sides are tracked: defensive matchup quality is a first-class
// signal here, not a metric this build avoids.
function rate(hits, n) { return n ? hits / n : null; }

export function buildTeamSeasonIndex(pbpRows) {
  const byTeam = {}; // team -> { off: {plays,epaSum,successN,...}, def: {...} }
  const ensure = (team) => {
    if (!byTeam[team]) byTeam[team] = {
      off: { plays: 0, epaSum: 0, successN: 0, dropbacks: 0, sacksTaken: 0, hitsAllowed: 0,
        rzTrips: 0, rzTDs: 0, thirdAtt: 0, thirdConv: 0, fourthAtt: 0, fourthConv: 0,
        twoPtAtt: 0, fumblesLost: 0, ints: 0, topSecSum: 0, driveCount: 0 },
      def: { plays: 0, epaSum: 0, successN: 0, dropbacksFaced: 0, sacksMade: 0, hitsMade: 0,
        rzTrips: 0, rzTDsAllowed: 0, thirdFaced: 0, thirdAllowed: 0 },
      games: new Set()
    };
    return byTeam[team];
  };
  pbpRows.forEach(r => {
    if (r.season_type && r.season_type !== "REG") return;
    const pos = r.posteam, def = r.defteam;
    if (!pos || !def) return;
    const o = ensure(pos), d = ensure(def);
    o.games.add(r.game_id); d.games.add(r.game_id);
    const isScrimmage = r.pass_attempt === 1 || r.rush_attempt === 1 || r.sack === 1;
    if (isScrimmage) {
      o.off.plays++; d.def.plays++;
      if (r.epa != null) { o.off.epaSum += r.epa; d.def.epaSum += r.epa; }
      if (r.success != null) { o.off.successN += r.success; d.def.successN += r.success; }
    }
    if (r.pass_attempt === 1 || r.sack === 1) {
      o.off.dropbacks++; d.def.dropbacksFaced++;
      if (r.sack === 1) { o.off.sacksTaken++; d.def.sacksMade++; }
      if (r.qb_hit === 1) { o.off.hitsAllowed++; d.def.hitsMade++; }
    }
    if (r.yardline_100 != null && r.yardline_100 <= 20 && isScrimmage && r.down === 1) {
      o.off.rzTrips++; d.def.rzTrips++;
    }
    if (r.touchdown === 1 && r.yardline_100 != null && r.yardline_100 <= 20) {
      o.off.rzTDs++; d.def.rzTDsAllowed++;
    }
    if (r.down === 3) { o.off.thirdAtt++; d.def.thirdFaced++; if (r.third_down_converted === 1) { o.off.thirdConv++; d.def.thirdAllowed++; } }
    if (r.down === 4 && (r.fourth_down_converted === 1 || r.fourth_down_failed === 1)) {
      o.off.fourthAtt++; if (r.fourth_down_converted === 1) o.off.fourthConv++;
    }
    if (r.two_point_attempt === 1) o.off.twoPtAtt++;
    if (r.fumble_lost === 1) o.off.fumblesLost++;
    if (r.interception === 1) o.off.ints++;
  });

  const out = {};
  Object.entries(byTeam).forEach(([team, t]) => {
    const games = t.games.size || 1;
    out[team] = {
      games,
      offEpaPerPlay: t.off.plays ? t.off.epaSum / t.off.plays : null,
      offSuccessRate: t.off.plays ? t.off.successN / t.off.plays : null,
      defEpaPerPlayAllowed: t.def.plays ? t.def.epaSum / t.def.plays : null,
      defSuccessRateAllowed: t.def.plays ? t.def.successN / t.def.plays : null,
      pressureRateAllowed: rate(t.off.sacksTaken + t.off.hitsAllowed, t.off.dropbacks),
      pressureRateCreated: rate(t.def.sacksMade + t.def.hitsMade, t.def.dropbacksFaced),
      thirdDownRate: rate(t.off.thirdConv, t.off.thirdAtt),
      thirdDownRateAllowed: rate(t.def.thirdAllowed, t.def.thirdFaced),
      fourthDownAttPerGame: t.off.fourthAtt / games,
      fourthDownConvRate: rate(t.off.fourthConv, t.off.fourthAtt),
      twoPtAttPerGame: t.off.twoPtAtt / games,
      turnoversPerGame: (t.off.fumblesLost + t.off.ints) / games,
      redZoneTDRate: rate(t.off.rzTDs, t.off.rzTrips),
      redZoneTDRateAllowed: rate(t.def.rzTDsAllowed, t.def.rzTrips),
      playsPerGame: t.off.plays / games
    };
  });
  return out;
}
