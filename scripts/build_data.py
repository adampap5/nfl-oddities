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
import sys
import urllib.request
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import models as M  # noqa: E402

BASE = "https://github.com/nflverse/nflverse-data/releases/download"
FIX = {"LA": "LAR", "WAS": "WSH"}  # match ESPN-style codes used across the site
OFFENSE = {"QB", "RB", "WR", "TE", "FB"}

# Neutral-site stadiums: nflverse stadium name fragment -> site code in data/stadiums.json
NEUTRAL = [("Ford Field", "DET"), ("Corinthians", "SAO"), ("Deutsche Bank", "FRA"), ("Allianz", "MUN"), ("Melbourne", "MEL"), ("Maracana", "RIO"), ("Tottenham", "LON"), ("Wembley", "LON"),
           ("Stade de France", "PAR"), ("Bernabeu", "MAD"), ("Munich", "MUN"), ("Banorte", "MEX"),
           ("Azteca", "MEX"), ("Croke", "DUB"), ("Berlin", "BER"), ("Olympiastadion", "BER")]


# 2025's international games carry the home team's own stadium name in nflverse, so they're mapped by home team.
NEUTRAL_2025 = {"LAC": "SAO", "PIT": "DUB", "CLE": "LON", "NYJ": "LON", "JAX": "LON", "IND": "BER", "MIA": "MAD"}
FATIGUE_SEASONS = range(2022, 2027)
CITY = {"SAO": "Sao Paulo", "FRA": "Frankfurt", "MEL": "Melbourne", "RIO": "Rio de Janeiro", "LON": "London", "PAR": "Paris", "MAD": "Madrid", "MUN": "Munich",
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


# ---- fatigue: the same scoring the site explains on its Fatigue & travel page
def dst_end(year):
    d = dt.date(year, 11, 1)
    return d + dt.timedelta(days=(6 - d.weekday()) % 7)  # first Sunday of November


def site_offset(site, code, day):
    off = site["HoursFromET"]
    if code == "ARI" and day < dst_end(day.year):
        off = -3  # Arizona skips daylight saving time
    return off


def miles(a, b):
    from math import radians, sin, cos, asin, sqrt
    dlat, dlon = radians(b["Lat"] - a["Lat"]), radians(b["Lon"] - a["Lon"])
    q = sin(dlat / 2) ** 2 + cos(radians(a["Lat"])) * cos(radians(b["Lat"])) * sin(dlon / 2) ** 2
    return 3959 * 2 * asin(sqrt(q))


def fatigue_rows(all_games, stadiums):
    site = {x["Site"]: x for x in stadiums}
    out = []
    for g in all_games:
        season = int(g["season"])
        if g["game_type"] != "REG" or season not in FATIGUE_SEASONS:
            continue
        away, home = t(g["away_team"]), t(g["home_team"])
        venue = home
        if g["location"] != "Home":
            venue = None
            if season == 2025:
                venue = NEUTRAL_2025.get(home)
            else:
                for frag, code in NEUTRAL:
                    if frag.lower() in g["stadium"].lower():
                        venue = code
                        break
            if not venue or venue not in site:
                continue
        day = dt.date.fromisoformat(g["gameday"])
        hh, mm = map(int, g["gametime"].split(":"))
        final = g["home_score"] not in ("", "NA")
        spread = f(g["spread_line"]) if g["spread_line"] not in ("", "NA") else None
        sides = []
        for team, opp, is_away, rest in [(away, home, True, g["away_rest"]), (home, away, False, g["home_rest"])]:
            if team not in site:
                break
            rest = int(f(rest)) or None
            h_site, v_site = site[team], site[venue]
            mi = round(miles(h_site, v_site))
            home_off = site_offset(h_site, team, day)
            zones = site_offset(v_site, venue, day) - home_off
            body = hh + mm / 60 + home_off
            score, flags = 0, []
            if not rest or rest >= 10:
                score -= 2; flags.append("Off a bye")
            elif rest <= 4:
                score += 3; flags.append("Short week")
            elif rest <= 6:
                score += 1; flags.append("Six days or less")
            score += mi // 1000
            if abs(zones) >= 5:
                score += 3; flags.append("Overseas")
            elif abs(zones) >= 2:
                score += abs(zones) - 1; flags.append(f"{abs(zones)} time zones")
            if body < 11.5:
                score += 2; flags.append("Early body clock")
            if v_site["ElevationFt"] >= 5000 and venue != team:
                score += 1; flags.append("Altitude")
            pf = int(g["away_score" if is_away else "home_score"]) if final else None
            pa = int(g["home_score" if is_away else "away_score"]) if final else None
            # nflverse spread_line: positive = home favored by that many
            line = None if spread is None else (spread if is_away else -spread)  # points this team gets (+) or gives (-)
            covered = None
            if final and line is not None:
                m = pf - pa + line
                covered = 1 if m > 0 else 0 if m < 0 else 0.5
            sides.append({"Season": season, "Week": int(g["week"]), "Date": g["gameday"], "Team": team, "Opp": opp,
                          "Site": "Away" if is_away and venue == opp else "Home" if venue == team else "Neutral", "Venue": venue,
                          "RestDays": rest, "Miles": mi, "TimeZones": zones, "BodyClock": round(body, 2), "Score": score,
                          "Flags": " · ".join(flags) or "None", "PF": pf, "PA": pa, "Line": line, "Covered": covered,
                          "Status": "Final" if final else "Upcoming"})
        if len(sides) == 2:
            sides[0]["OppScore"], sides[1]["OppScore"] = sides[1]["Score"], sides[0]["Score"]
            for x in sides:
                x["Edge"] = x["OppScore"] - x["Score"]  # positive = this team is fresher
                if x["PF"] is not None:
                    x["Margin"] = x["PF"] - x["PA"]
                    x["Win"] = 1 if x["Margin"] > 0 else 0 if x["Margin"] < 0 else 0.5
            out.extend(sides)
    return out


# ---- rest & travel model: which factors move the final margin, after home field?
FACTORS = [
    ("ExtraRest", "Extra rest (off a bye, 10+ days)", lambda x: 1 if (not x["RestDays"] or x["RestDays"] >= 10) else 0),
    ("SixDays", "Short rest (5-6 days)", lambda x: 1 if x["RestDays"] and 5 <= x["RestDays"] <= 6 else 0),
    ("Altitude", "Visiting at altitude (Denver, Mexico City)", lambda x: 1 if "Altitude" in x["Flags"] else 0),
    ("TimeZones", "Crossing 2+ time zones", lambda x: 1 if "time zones" in x["Flags"] and "Overseas" not in x["Flags"] else 0),
    ("EarlyClock", "Early kickoff on the body clock", lambda x: 1 if "Early body" in x["Flags"] and "Overseas" not in x["Flags"] else 0),
    ("Miles", "Distance traveled (per 1,000 miles)", lambda x: x["Miles"] / 1000 if "Overseas" not in x["Flags"] else 0),
]
KEEP_P = 0.10  # a factor counts toward the rest edge only with this much evidence


def _solve(A, b):
    n = len(A)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for c in range(n):
        piv = max(range(c, n), key=lambda r: abs(M[r][c]))
        M[c], M[piv] = M[piv], M[c]
        for r in range(n):
            if r != c and M[c][c]:
                k = M[r][c] / M[c][c]
                M[r] = [a - k * bb for a, bb in zip(M[r], M[c])]
    return [M[i][n] / M[i][i] for i in range(n)]


def _ols(X, Y):
    """Least squares with standard errors and two-sided normal p-values, standard library only."""
    import math
    k = len(X[0])
    XtX = [[sum(r[i] * r[j] for r in X) for j in range(k)] for i in range(k)]
    XtY = [sum(r[i] * y for r, y in zip(X, Y)) for i in range(k)]
    b = _solve(XtX, XtY)
    res = [y - sum(bi * xi for bi, xi in zip(b, r)) for r, y in zip(X, Y)]
    s2 = sum(e * e for e in res) / (len(X) - k)
    inv = [_solve(XtX, [1 if i == j else 0 for i in range(k)]) for j in range(k)]
    se = [math.sqrt(max(s2 * inv[i][i], 1e-12)) for i in range(k)]
    p = [2 * (1 - 0.5 * (1 + math.erf(abs(bi / si) / math.sqrt(2)))) for bi, si in zip(b, se)]
    return b, se, p


def rest_model(rows):
    games = {}
    for x in rows:
        if x["Status"] == "Final":
            games.setdefault((x["Season"], x["Week"], tuple(sorted([x["Team"], x["Opp"]]))), []).append(x)
    X, Y, XA, YA = [], [], [], []
    for pair in games.values():
        if len(pair) != 2:
            continue
        a, b = sorted(pair, key=lambda r: r["Team"])
        home = 1 if a["Site"] == "Home" else -1 if a["Site"] == "Away" else 0
        row = [home] + [f(a) - f(b) for _, _, f in FACTORS]
        X.append(row); Y.append(a["Margin"])
        if a["Line"] is not None:
            XA.append(row); YA.append(a["Margin"] + a["Line"])
    b, se, p = _ols(X, Y)
    ba, _, pa = _ols(XA, YA)
    out = [{"Factor": "Home", "Label": "Home field", "Games": len(X), "Effect": round(b[0], 1), "P": round(p[0], 3),
            "VsSpread": round(ba[0], 1), "VsSpreadP": round(pa[0], 3), "Used": False}]
    for i, (key, label, _) in enumerate(FACTORS, start=1):
        n = sum(1 for r in X if r[i] != 0)
        out.append({"Factor": key, "Label": label, "Games": n, "Effect": round(b[i], 1), "P": round(p[i], 3),
                    "VsSpread": round(ba[i], 1), "VsSpreadP": round(pa[i], 3), "Used": p[i] < KEEP_P and n >= 20})
    return out


def apply_model(rows, model):
    used = {m["Factor"]: m["Effect"] for m in model if m["Used"]}
    fns = {key: f for key, _, f in FACTORS}
    for x in rows:
        x["Impact"] = round(sum(eff * fns[k](x) for k, eff in used.items()), 1)
        x["Reasons"] = [lbl for k, lbl, f in FACTORS if k in used and f(x)]
    imp = {(x["Season"], x["Week"], x["Team"]): x["Impact"] for x in rows}
    for x in rows:
        x["EdgePts"] = round(x["Impact"] - imp.get((x["Season"], x["Week"], x["Opp"]), 0), 1)
        for k in ("Score", "OppScore", "Edge"):
            x.pop(k, None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--cache")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data"))
    a = ap.parse_args()
    season = a.season

    stats = [r for r in rows(fetch(f"stats_player/stats_player_week_{season}.csv", a.cache)) if r["season_type"] == "REG"]
    all_games = rows(fetch("schedules/games.csv", a.cache))
    sched = [g for g in all_games if g["season"] == str(season) and g["game_type"] == "REG"]
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

    stadiums = json.load(open(os.path.join(a.out, "stadiums.json"), encoding="utf-8"))
    fatigue = fatigue_rows(all_games, stadiums)
    model = rest_model(fatigue)
    apply_model(fatigue, model)


    # ================================================================ models
    raw_code = {"LAR": "LA", "WSH": "WAS"}
    games_by_id = {g["game_id"]: g for g in all_games}
    raw_by_key = {(int(g["week"]), t(g["away_team"]), t(g["home_team"])): g for g in sched}
    site = {x["Site"]: x for x in stadiums}
    upcoming_weeks = [g["Week"] for g in games if g["Status"] == "Upcoming"]
    next_week = min(upcoming_weeks) if upcoming_weeks else None
    name_of = {p["Id"]: p["Player"] for p in players}
    pos_of = {p["Id"]: p["Pos"] for p in players}

    def snap_map(year):
        try:
            data = rows(fetch(f"snap_counts/snap_counts_{year}.csv", a.cache))
        except Exception as e:
            print("snap counts unavailable for", year, e)
            return {}
        return {(r["player"], t(r["team"]), int(r["week"])): f(r["offense_pct"]) for r in data if r["game_type"] == "REG"}

    snaps_now, snaps_prev = snap_map(season), snap_map(season - 1)
    for w in weekly:
        if pos_of.get(w["Id"]) in ("QB", "RB", "WR", "TE"):
            sp = snaps_now.get((name_of[w["Id"]], w["Team"], w["Week"]))
            if sp is not None:
                w["SnapPct"] = round(sp * 100)
    weekly_by = defaultdict(list)
    for w in weekly:
        weekly_by[w["Id"]].append(w)

    prior_stats = []
    for yr in (season - 2, season - 1):
        prior_stats += rows(fetch(f"stats_player/stats_player_week_{yr}.csv", a.cache))

    # ---- weather: forecast for next week's outdoor games, and what wind/temperature have done historically
    wmodel = M.weather_model(all_games)
    weather = []
    if next_week:
        for g in [x for x in games if x["Week"] == next_week]:
            raw = raw_by_key.get((g["Week"], g["Away"], g["Home"]))
            roof = raw["roof"] if raw else ""
            indoor = roof in ("dome", "closed") or (roof == "" and g["Venue"] in M.INDOOR_SITES)
            st = site.get(g["Venue"])
            fc = None
            if not indoor and st and raw:
                fc = M.fetch_forecast(st["Lat"], st["Lon"], g["Date"], int(raw["gametime"].split(":")[0]))
            wind = (fc or {}).get("WindMph")
            row = {"GameId": g["GameId"], "Week": g["Week"], "Away": g["Away"], "Home": g["Home"], "Day": g["Day"], "Kickoff": g["Kickoff"],
                   "City": st["City"] if st else "", "Indoors": indoor, "Total": g["Total"], **(fc or {})}
            if wind is not None and not indoor:
                row["TotalShift"] = round(wmodel["WindPerMph"] * (wind - M.OUTDOOR_AVG_WIND), 1)
                row["VsLineShift"] = round(wmodel["WindVsLinePerMph"] * (wind - M.OUTDOOR_AVG_WIND), 1)
            weather.append(row)
    wx_by_team = {}
    for wrow in weather:
        wx_by_team[wrow["Away"]] = wx_by_team[wrow["Home"]] = wrow

    # ---- projections: fit on the two previous seasons, apply to next week
    proj_model = M.fit_projection(M.projection_samples(prior_stats, games_by_id))
    pos_avg = {pos: M.mean(p["PPRPerGame"] for p in players if p["Pos"] == pos and p["GP"] >= 3) for pos in ("K", "DST")}

    def project_player(p, week, wind_for):
        ws = [w for w in weekly_by[p["Id"]] if w["Week"] < week]
        if len(ws) < 2:
            return None
        pts = [w["PPR"] for w in ws]
        per, l3 = M.mean(pts), M.mean(pts[-3:])
        g = next((x for x in games if x["Week"] == week and p["Team"] in (x["Away"], x["Home"])), None)
        if not g:
            return {"bye": True}
        raw = raw_by_key.get((g["Week"], g["Away"], g["Home"]))
        it = M.implied_total(raw, raw_code.get(p["Team"], p["Team"])) if raw else None
        opp = g["Home"] if g["Away"] == p["Team"] else g["Away"]
        opp_it = M.implied_total(raw, raw_code.get(opp, opp)) if raw else None
        wind = wind_for(g, raw)
        pos = p["Pos"]
        if pos in M.PROJ_POS:
            est = M.project(proj_model, pos, per, l3, it, wind)
        elif pos == "K":
            est = 0.6 * per + 0.4 * pos_avg["K"] + (0.15 * (it - 22.5) if it is not None else 0)
        else:
            est = 0.6 * per + 0.4 * pos_avg["DST"] - (0.25 * (opp_it - 22.5) if opp_it is not None else 0)
        rec_pg = M.mean(w.get("Rec", 0) for w in ws)
        return {"est": max(0.0, est), "estHalf": max(0.0, est - 0.5 * rec_pg), "per": per, "l3": l3, "it": it, "oppIt": opp_it, "wind": wind,
                "lastWeek": ws[-1]["Week"], "g": g, "opp": opp}

    def wind_forecast(g, raw):
        w = wx_by_team.get(g["Home"])
        if w and w["Indoors"]:
            return 0.0
        if w and w.get("WindMph") is not None:
            return w["WindMph"]
        return M.game_wind(raw) if raw else M.OUTDOOR_AVG_WIND

    projections = []
    if next_week:
        for p in players:
            r = project_player(p, next_week, wind_forecast)
            if r is None:
                continue
            row = {"Id": p["Id"], "Pos": p["Pos"], "Team": p["Team"]}
            if r.get("bye"):
                row.update({"Bye": True, "Tags": [["bad", "On bye"]]})
            else:
                tags = []
                pos = p["Pos"]
                if pos in ("QB", "RB") and r["it"] is not None:
                    if r["it"] >= 26: tags.append(["good", f"High team total ({r['it']:.1f})"])
                    elif r["it"] <= 19: tags.append(["bad", f"Low team total ({r['it']:.1f})"])
                if pos == "DST" and r["oppIt"] is not None:
                    if r["oppIt"] <= 19: tags.append(["good", f"Opponent projected for {r['oppIt']:.1f}"])
                    elif r["oppIt"] >= 26: tags.append(["bad", f"Opponent projected for {r['oppIt']:.1f}"])
                if pos in ("QB", "WR", "TE", "K") and r["wind"] >= 15:
                    tags.append(["bad", f"Windy ({r['wind']:.0f} mph)"])
                if through - r["lastWeek"] >= 2:
                    tags.append(["bad", f"Hasn't played since Week {r['lastWeek']}"])
                if p["GP"] < 3:
                    tags.append(["muted", f"Only {p['GP']} games played"])
                row.update({"EstPPR": round(r["est"], 1), "EstHalf": round(r["estHalf"], 1), "TeamTotal": None if r["it"] is None else round(r["it"], 1),
                            "Wind": round(r["wind"]), "Opp": r["opp"], "Tags": tags})
            projections.append(row)
        M.rank_and_verdict(projections, "EstPPR")
        M.rank_and_verdict(projections, "EstHalf")

    # ---- track record: the same model, applied week by week to this season's games it never saw
    track = []
    for wk in range(3, through + 1):
        week_rows = []
        for p in players:
            if p["Pos"] not in M.PROJ_POS:
                continue
            actual = next((w for w in weekly_by[p["Id"]] if w["Week"] == wk), None)
            if not actual:
                continue
            r = project_player(p, wk, lambda g, raw: M.game_wind(raw) if raw else M.OUTDOOR_AVG_WIND)
            if not r or r.get("bye") or r["it"] is None:
                continue
            week_rows.append({"Id": p["Id"], "Pos": p["Pos"], "Week": wk, "EstPPR": round(r["est"], 1), "Base": round(r["per"], 1), "Actual": actual["PPR"]})
        M.rank_and_verdict(week_rows, "EstPPR")
        track.extend(week_rows)
    track_summary = {}
    if track:
        mae = lambda k: M.mean(abs(x[k] - x["Actual"]) for x in track)
        track_summary = {"Weeks": f"3-{through}", "Projections": len(track), "ModelMiss": round(mae("EstPPR"), 2), "AverageMiss": round(mae("Base"), 2),
                         "ByVerdict": [{"Verdict": v, "Players": len(xs), "AvgActual": round(M.mean(x["Actual"] for x in xs), 1)}
                                       for v in ("Must start", "Start", "Flex / borderline", "Bench")
                                       for xs in [[x for x in track if x["VerdictEstPPR"] == v]] if xs]}
        better = 0; n = 0
        by_wk = defaultdict(list)
        for x in track:
            by_wk[(x["Week"], x["Pos"])].append(x)
        for lst in by_wk.values():  # within each week and position: did the higher projection score more?
            lst.sort(key=lambda x: -x["EstPPR"])
            for i in range(0, len(lst) - 1, 2):
                a_, b_ = lst[i], lst[i + 1]
                if a_["Actual"] != b_["Actual"]:
                    n += 1; better += a_["Actual"] > b_["Actual"]
        track_summary["CloseCalls"] = {"Pairs": n, "HigherWonPct": round(100 * better / n, 1) if n else None}

    # ---- waiver radar: fit on last season, apply to this season's fringe players
    rX, rY = M.radar_samples(rows(fetch(f"stats_player/stats_player_week_{season - 1}.csv", a.cache)), snaps_prev)
    radar_model = {}
    radar = []
    if len(rX) > 50:
        rb, _, rp = M.ols(rX, rY)
        radar_model = {"n": len(rX), "coef": [round(x, 4) for x in rb], "p": [round(x, 5) for x in rp],
                       "Features": ["Constant", "Season average", "Touches change (last 2 vs season)", "Snap share change (last 2 vs season)"]}
        rostered = {"RB": 36, "WR": 48, "TE": 14}
        for pos, cut in rostered.items():
            pool = sorted([p for p in players if p["Pos"] == pos and p["GP"] >= 3], key=lambda p: -p["PPRPerGame"])
            for rank, p in enumerate(pool, start=1):
                if rank <= cut:
                    continue
                ws = weekly_by[p["Id"]]
                sn = [w["SnapPct"] / 100 for w in ws if "SnapPct" in w]
                if len(ws) < 4 or len(sn) < 4:
                    continue
                touches = [w.get("Targets", 0) + w.get("Carries", 0) for w in ws]
                per = p["PPRPerGame"]
                x = [1.0, per, M.mean(touches[-2:]) - M.mean(touches), M.mean(sn[-2:]) - M.mean(sn)]
                proj3 = sum(c * v for c, v in zip(rb, x))
                reasons = []
                if x[3] >= 0.10:
                    reasons.append(f"Snaps {M.mean(sn[:-2]) * 100:.0f}% → {M.mean(sn[-2:]) * 100:.0f}%")
                if x[2] >= 2:
                    reasons.append(f"Touches {M.mean(touches[:-2]):.1f} → {M.mean(touches[-2:]):.1f} a game")
                radar.append({"Id": p["Id"], "Player": p["Player"], "Team": p["Team"], "Pos": pos, "PosRank": rank, "PerGame": per,
                              "Proj3": round(proj3, 1), "Gain": round(proj3 - per, 1), "SnapNow": round(M.mean(sn[-2:]) * 100), "SnapBefore": round(M.mean(sn[:-2]) * 100),
                              "TouchNow": round(M.mean(touches[-2:]), 1), "Reasons": reasons})
        # rising (projects 0.5+ above his average) and playable in a 12-team league (5.5+ PPR a game next three weeks)
        radar = sorted([r for r in radar if r["Gain"] >= 0.5 and r["Proj3"] >= 5.5], key=lambda r: -r["Proj3"])[:30]

    # ---- power ratings
    ratings, hfa, mk_hfa = M.power_ratings(games, [x["Team"] for x in teams])

    models_doc = {"Projection": {**proj_model, "Features": M.FEATURES, "TrainedOn": f"{season - 2}-{season - 1}"}, "Track": track_summary,
                  "Radar": radar_model, "Weather": wmodel, "Ratings": {"HomeField": hfa, "MarketHomeField": mk_hfa}, "NextWeek": next_week}

    os.makedirs(a.out, exist_ok=True)
    fatigue_now = [x for x in fatigue if x["Season"] == season]  # history is only needed to fit the model
    for name, data in [("fatigue", fatigue_now), ("rest_model", model), ("players", players), ("weekly", weekly), ("teams", teams), ("games", games), ("standings", standings), ("meta", [meta]),
                       ("projections", projections), ("track", track), ("radar", radar), ("weather", weather), ("ratings", ratings), ("models", [models_doc])]:
        with open(os.path.join(a.out, f"{name}.json"), "w", encoding="utf-8") as fh:
            json.dump(data, fh, separators=(",", ":"))
        print(f"{name}.json: {len(data)} rows")


if __name__ == "__main__":
    main()
