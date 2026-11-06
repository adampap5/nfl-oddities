#!/usr/bin/env python3
"""Build the site's data files from nflverse.

Downloads weekly player stats, the season schedule (with results and betting lines) and
team colors from the nflverse-data releases on GitHub, then writes:

  data/players.json    season totals and fantasy points for every offensive player, kicker and team defense
  data/weekly.json     one row per player per week (game logs and trends)
  data/teams.json      names, divisions and colors
  data/games.json      the full season schedule with scores, win odds from the moneyline, spread and total
  data/standings.json  records computed from the schedule

Usage: python3 scripts/build_data.py [--season 2026] [--cache DIR]
Only the standard library is used, so it runs anywhere Python 3.9+ does.
"""
import argparse
import csv
import datetime as dt
import io
import json
import os
import urllib.request
from collections import defaultdict

BASE = "https://github.com/nflverse/nflverse-data/releases/download"
FIX = {"LA": "LAR", "WAS": "WSH"}  # match ESPN-style codes used across the site
OFFENSE = {"QB", "RB", "WR", "TE", "FB"}

# Neutral-site stadiums: nflverse stadium name fragment -> site code in data/stadiums.json
NEUTRAL = [("Melbourne", "MEL"), ("Maracana", "RIO"), ("Tottenham", "LON"), ("Wembley", "LON"),
           ("Stade de France", "PAR"), ("Bernabeu", "MAD"), ("Munich", "MUN"), ("Banorte", "MEX"),
           ("Azteca", "MEX"), ("Croke", "DUB"), ("Berlin", "BER"), ("Olympiastadion", "BER")]


CITY = {"MEL": "Melbourne", "RIO": "Rio de Janeiro", "LON": "London", "PAR": "Paris", "MAD": "Madrid", "MUN": "Munich",
        "MEX": "Mexico City", "DUB": "Dublin", "BER": "Berlin"}


def t(code):
    return FIX.get(code, code)


def fetch(name, cache):
    if cache:
        path = os.path.join(cache, os.path.basename(name))
        if os.path.exists(path):
            return open(path, encoding="utf-8").read()
    req = urllib.request.Request(f"{BASE}/{name}", headers={"User-Agent": "nfl-oddities-site"})
    with urllib.request.urlopen(req, timeout=120) as r:
        text = r.read().decode("utf-8")
    if cache:
        os.makedirs(cache, exist_ok=True)
        open(os.path.join(cache, os.path.basename(name)), "w", encoding="utf-8").write(text)
    return text


def rows(text):
    return list(csv.DictReader(io.StringIO(text)))


def f(x):
    try:
        return float(x) if x not in ("", "NA", None) else 0.0
    except ValueError:
        return 0.0


def r1(x):
    return round(x + 0.0, 1)


def clock(hhmm):
    h, m = map(int, hhmm.split(":"))
    return f"{(h + 11) % 12 + 1}:{m:02d} {'AM' if h < 12 else 'PM'}"


def implied(ml_a, ml_h):
    def p(ml):
        ml = f(ml)
        if ml == 0:
            return None
        return 100 / (ml + 100) if ml > 0 else -ml / (-ml + 100)
    a, h = p(ml_a), p(ml_h)
    if a is None or h is None:
        return None, None
    s = a + h
    return round(a / s * 100, 1), round(h / s * 100, 1)


def kicker_points(r):
    # ESPN standard kicking: FG 0-39 = 3, 40-49 = 4, 50+ = 5, PAT = 1, missed FG or PAT = -1
    pts = (f(r["fg_made_0_19"]) + f(r["fg_made_20_29"]) + f(r["fg_made_30_39"])) * 3
    pts += f(r["fg_made_40_49"]) * 4 + (f(r["fg_made_50_59"]) + f(r["fg_made_60_"])) * 5
    pts += f(r["pat_made"]) - f(r["fg_missed"]) - f(r["pat_missed"])
    return pts


def pa_points(pa):
    for limit, pts in [(0, 5), (6, 4), (13, 3), (17, 1), (27, 0), (34, -1), (45, -3)]:
        if pa <= limit:
            return pts
    return -5


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--cache")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data"))
    a = ap.parse_args()
    season = a.season

    stats = [r for r in rows(fetch(f"stats_player/stats_player_week_{season}.csv", a.cache)) if r["season_type"] == "REG"]
    sched = [g for g in rows(fetch("schedules/games.csv", a.cache)) if g["season"] == str(season) and g["game_type"] == "REG"]
    teams_raw = rows(fetch("teams/teams_colors_logos.csv", a.cache))

    # ---- teams
    current = {"ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC",
               "LA", "LAC", "LV", "MIA", "MIN", "NE", "NO", "NYG", "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS"}
    teams = [{"Team": t(x["team_abbr"]), "Name": x["team_name"], "Nick": x["team_nick"], "Conf": x["team_conf"],
              "Division": x["team_division"], "Color": x["team_color"], "Color2": x["team_color2"]}
             for x in teams_raw if x["team_abbr"] in current]
    teams.sort(key=lambda x: x["Team"])
    nick = {x["Team"]: x["Nick"] for x in teams}

    # ---- games
    games = []
    for g in sched:
        away, home = t(g["away_team"]), t(g["home_team"])
        final = g["home_score"] not in ("", "NA")
        venue = home
        window = ""
        if g["location"] != "Home":
            for frag, code in NEUTRAL:
                if frag.lower() in g["stadium"].lower():
                    venue = code
                    break
            window = CITY.get(venue, g["stadium"])
        day = dt.date.fromisoformat(g["gameday"])
        hh = int(g["gametime"].split(":")[0])
        if not window:
            window = {"Thursday": "TNF", "Monday": "MNF"}.get(g["weekday"], "SNF" if g["weekday"] == "Sunday" and hh >= 20 else "")
        pa, ph = implied(g["away_moneyline"], g["home_moneyline"])
        spread = f(g["spread_line"])
        games.append({
            "GameId": f"W{int(g['week'])}-{away}@{home}", "Week": int(g["week"]), "Date": g["gameday"],
            "Day": day.strftime("%a %b ") + str(day.day), "Kickoff": clock(g["gametime"]), "Away": away, "Home": home,
            "Venue": venue, "AwayScore": int(g["away_score"]) if final else None, "HomeScore": int(g["home_score"]) if final else None,
            "AwayWinProb": pa, "HomeWinProb": ph,
            "Favorite": "" if g["spread_line"] in ("", "NA") else (home if spread > 0 else away if spread < 0 else "Pick"),
            "Spread": abs(spread) if g["spread_line"] not in ("", "NA") else None,
            "Total": f(g["total_line"]) or None,
            "AwayRest": int(f(g["away_rest"])) or None, "HomeRest": int(f(g["home_rest"])) or None,
            "AwayCoach": g["away_coach"], "HomeCoach": g["home_coach"], "Roof": g["roof"],
            "Window": window, "Status": "Final" if final else "Upcoming",
        })
    games.sort(key=lambda x: (x["Week"], x["Date"], x["Kickoff"][-2:], x["Kickoff"]))

    # ---- standings
    rec = {x["Team"]: {"W": 0, "L": 0, "T": 0, "PF": 0, "PA": 0, "results": []} for x in teams}
    for g in games:
        if g["Status"] != "Final":
            continue
        for side, opp, pts, opp_pts in [(g["Away"], g["Home"], g["AwayScore"], g["HomeScore"]), (g["Home"], g["Away"], g["HomeScore"], g["AwayScore"])]:
            r = rec[side]
            r["PF"] += pts
            r["PA"] += opp_pts
            res = "W" if pts > opp_pts else "L" if pts < opp_pts else "T"
            r[res] += 1
            r["results"].append(res)
    standings = []
    for x in teams:
        r = rec[x["Team"]]
        gp = r["W"] + r["L"] + r["T"]
        streak = ""
        if r["results"]:
            last = r["results"][-1]
            n = 0
            for res in reversed(r["results"]):
                if res != last:
                    break
                n += 1
            streak = f"{last}{n}"
        standings.append({"Team": x["Team"], "Name": x["Name"], "W": r["W"], "L": r["L"], "T": r["T"],
                          "WinPct": round((r["W"] + 0.5 * r["T"]) / gp, 3) if gp else 0, "PF": r["PF"], "PA": r["PA"],
                          "Diff": r["PF"] - r["PA"], "Streak": streak, "Conf": x["Conf"], "Division": x["Division"]})

    # ---- players: offense and kickers
    weekly = []
    tot = {}
    for r in stats:
        pos = r["position"]
        if pos not in OFFENSE and pos != "K":
            continue
        team, opp = t(r["team"]), t(r["opponent_team"])
        if pos == "K":
            ppr = half = std = kicker_points(r)
        else:
            std, ppr = f(r["fantasy_points"]), f(r["fantasy_points_ppr"])
            half = std + 0.5 * f(r["receptions"])
        w = {"Id": r["player_id"], "Week": int(r["week"]), "Team": team, "Opp": opp,
             "PPR": r1(ppr), "Half": r1(half), "Std": r1(std),
             "Cmp": int(f(r["completions"])), "Att": int(f(r["attempts"])), "PassYds": int(f(r["passing_yards"])),
             "PassTD": int(f(r["passing_tds"])), "Int": int(f(r["passing_interceptions"])), "Sacks": int(f(r["sacks_suffered"])),
             "Carries": int(f(r["carries"])), "RushYds": int(f(r["rushing_yards"])), "RushTD": int(f(r["rushing_tds"])),
             "Targets": int(f(r["targets"])), "Rec": int(f(r["receptions"])), "RecYds": int(f(r["receiving_yards"])),
             "RecTD": int(f(r["receiving_tds"])), "TgtShare": r1(f(r["target_share"]) * 100),
             "AirShare": r1(f(r["air_yards_share"]) * 100), "FumLost": int(f(r["fumbles_lost_total"])),
             "FGM": int(f(r["fg_made"])), "FGA": int(f(r["fg_att"])), "XPM": int(f(r["pat_made"])), "XPA": int(f(r["pat_att"]))}
        weekly.append(w)
        p = tot.setdefault(r["player_id"], {"Id": r["player_id"], "Player": r["player_display_name"], "Pos": "RB" if pos == "FB" else pos,
                                            "Team": team, "lastWeek": 0, "GP": 0})
        if w["Week"] >= p["lastWeek"]:
            p["Team"], p["lastWeek"] = team, w["Week"]
        p["GP"] += 1
        for k in ["PPR", "Half", "Std", "Cmp", "Att", "PassYds", "PassTD", "Int", "Sacks", "Carries", "RushYds", "RushTD",
                  "Targets", "Rec", "RecYds", "RecTD", "FumLost", "FGM", "FGA", "XPM", "XPA"]:
            p[k] = p.get(k, 0) + w[k]
        p["_tgt"] = p.get("_tgt", 0) + w["TgtShare"]

    # ---- team defenses (ESPN-style: sack 1, INT 2, fumble recovery 2, TD 6, safety 2, blocked kick 2, points-allowed tiers)
    dst = defaultdict(lambda: {"Sacks": 0, "DefInt": 0, "FumRec": 0, "DefTD": 0, "Safety": 0, "Blocks": 0, "Opp": ""})
    for r in stats:
        if r["position"] in OFFENSE or r["position"] in ("K", "P", "LS", "OT", "G", "C", ""):
            continue
        key = (t(r["team"]), int(r["week"]))
        d = dst[key]
        d["Opp"] = t(r["opponent_team"])
        d["Sacks"] += f(r["def_sacks"])
        d["DefInt"] += f(r["def_interceptions"])
        d["FumRec"] += f(r["fumble_recovery_opp"])
        d["DefTD"] += f(r["def_tds"]) + f(r["fumble_recovery_tds"])
        d["Safety"] += f(r["def_safeties"])
        d["Blocks"] += f(r["def_fg_blocks"]) + f(r["def_punt_blocks"]) + f(r["def_pat_blocks"])
    for r in stats:  # return touchdowns by anyone on the team
        if f(r["special_teams_tds"]):
            dst[(t(r["team"]), int(r["week"]))]["DefTD"] += f(r["special_teams_tds"])
    allowed = {}
    for g in games:
        if g["Status"] == "Final":
            allowed[(g["Away"], g["Week"])] = g["HomeScore"]
            allowed[(g["Home"], g["Week"])] = g["AwayScore"]
    for (team, week), d in sorted(dst.items()):
        if (team, week) not in allowed:
            continue
        pa = allowed[(team, week)]
        pts = d["Sacks"] + 2 * (d["DefInt"] + d["FumRec"] + d["Safety"] + d["Blocks"]) + 6 * d["DefTD"] + pa_points(pa)
        pid = f"DST-{team}"
        w = {"Id": pid, "Week": week, "Team": team, "Opp": d["Opp"], "PPR": r1(pts), "Half": r1(pts), "Std": r1(pts),
             "PtsAllowed": pa, "DefSacks": r1(d["Sacks"]), "DefInt": int(d["DefInt"]), "FumRec": int(d["FumRec"]), "DefTD": int(d["DefTD"])}
        weekly.append(w)
        p = tot.setdefault(pid, {"Id": pid, "Player": f"{nick.get(team, team)} D/ST", "Pos": "DST", "Team": team, "GP": 0, "lastWeek": week})
        p["GP"] += 1
        for k in ["PPR", "Half", "Std", "PtsAllowed", "DefSacks", "DefInt", "FumRec", "DefTD"]:
            p[k] = p.get(k, 0) + w[k]

    players = []
    for p in tot.values():
        if p["PPR"] == 0 and p.get("Targets", 0) == 0 and p.get("Carries", 0) == 0 and p.get("Att", 0) == 0 and p["Pos"] not in ("K", "DST"):
            continue
        out = {"Id": p["Id"], "Player": p["Player"], "Pos": p["Pos"], "Team": p["Team"], "GP": p["GP"],
               "PPR": r1(p["PPR"]), "PPRPerGame": r1(p["PPR"] / p["GP"]), "Half": r1(p["Half"]), "HalfPerGame": r1(p["Half"] / p["GP"]),
               "Std": r1(p["Std"])}
        if p["Pos"] == "DST":
            out.update({"PtsAllowed": p["PtsAllowed"], "PtsAllowedPerGame": r1(p["PtsAllowed"] / p["GP"]), "DefSacks": r1(p["DefSacks"]),
                        "DefInt": p["DefInt"], "FumRec": p["FumRec"], "DefTD": p["DefTD"]})
        else:
            for k in ["Cmp", "Att", "PassYds", "PassTD", "Int", "Sacks", "Carries", "RushYds", "RushTD", "Targets", "Rec", "RecYds", "RecTD",
                      "FumLost", "FGM", "FGA", "XPM", "XPA"]:
                out[k] = int(p.get(k, 0))
            out["TgtShare"] = r1(p.get("_tgt", 0) / p["GP"])
            out["CmpPct"] = r1(out["Cmp"] / out["Att"] * 100) if out["Att"] else None
            out["YPA"] = r1(out["PassYds"] / out["Att"]) if out["Att"] else None
            out["YPC"] = r1(out["RushYds"] / out["Carries"]) if out["Carries"] else None
            out["YPR"] = r1(out["RecYds"] / out["Rec"]) if out["Rec"] else None
        players.append(out)
    players.sort(key=lambda x: -x["PPR"])
    keep = {p["Id"] for p in players}
    base = {"Id", "Week", "Team", "Opp", "PPR", "Half", "Std"}
    weekly = [{k: v for k, v in w.items() if k in base or v} for w in weekly if w["Id"] in keep]
    weekly.sort(key=lambda w: (w["Id"], w["Week"]))

    through = max([g["Week"] for g in games if g["Status"] == "Final"], default=0)
    meta = {"Season": season, "ThroughWeek": through, "BuiltAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "Players": len(players)}

    os.makedirs(a.out, exist_ok=True)
    for name, data in [("players", players), ("weekly", weekly), ("teams", teams), ("games", games), ("standings", standings), ("meta", [meta])]:
        with open(os.path.join(a.out, f"{name}.json"), "w", encoding="utf-8") as fh:
            json.dump(data, fh, separators=(",", ":"))
        print(f"{name}.json: {len(data)} rows")


if __name__ == "__main__":
    main()
