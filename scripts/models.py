"""Models behind the site's projections, waiver radar, weather and power ratings.

Everything here uses only the Python standard library so the daily GitHub Actions job
needs nothing installed. Each model is refit on every run from nflverse data, and the
site shows only effects that hold up statistically.
"""
import json
import math
import urllib.parse
import urllib.request
from collections import defaultdict

FIX = {"LA": "LAR", "WAS": "WSH"}


def t(code):
    return FIX.get(code, code)


def f(x):
    try:
        return float(x) if x not in ("", "NA", None) else 0.0
    except ValueError:
        return 0.0


def mean(v):
    v = list(v)
    return sum(v) / len(v) if v else 0.0


# ---------------------------------------------------------------- linear algebra
def solve(A, b):
    n = len(A)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for c in range(n):
        piv = max(range(c, n), key=lambda r: abs(M[r][c]))
        M[c], M[piv] = M[piv], M[c]
        if abs(M[c][c]) < 1e-12:
            continue
        for r in range(n):
            if r != c:
                k = M[r][c] / M[c][c]
                if k:
                    M[r] = [a - k * bb for a, bb in zip(M[r], M[c])]
    return [M[i][n] / M[i][i] if abs(M[i][i]) > 1e-12 else 0.0 for i in range(n)]


def ols(X, Y, ridge=0.0, ridge_skip=(0,)):
    """Least squares (optionally ridge, not applied to columns in ridge_skip). Returns coef, se, p."""
    k = len(X[0])
    XtX = [[sum(r[i] * r[j] for r in X) for j in range(k)] for i in range(k)]
    if ridge:
        for i in range(k):
            if i not in ridge_skip:
                XtX[i][i] += ridge
    XtY = [sum(r[i] * y for r, y in zip(X, Y)) for i in range(k)]
    b = solve(XtX, XtY)
    res = [y - sum(bi * xi for bi, xi in zip(b, r)) for r, y in zip(X, Y)]
    dof = max(1, len(X) - k)
    s2 = sum(e * e for e in res) / dof
    se, p = [], []
    for i in range(k):
        col = solve(XtX, [1.0 if j == i else 0.0 for j in range(k)])
        s = math.sqrt(max(s2 * col[i], 1e-12))
        se.append(s)
        z = abs(b[i] / s)
        p.append(2 * (1 - 0.5 * (1 + math.erf(z / math.sqrt(2)))))
    return b, se, p


# ---------------------------------------------------------------- game helpers
def implied_total(g, team_raw):
    """Vegas implied points for a team (raw nflverse code). nflverse spread_line > 0 means home favored."""
    if g["total_line"] in ("", "NA") or g["spread_line"] in ("", "NA"):
        return None
    T, s = f(g["total_line"]), f(g["spread_line"])
    return (T + s) / 2 if team_raw == g["home_team"] else (T - s) / 2


OUTDOOR_AVG_WIND = 9.0


def game_wind(g):
    """Wind in mph that players actually faced: 0 indoors, the recorded value outdoors, a typical value when unrecorded."""
    if g["roof"] in ("dome", "closed"):
        return 0.0
    if g["wind"] in ("", "NA"):
        return OUTDOOR_AVG_WIND
    return f(g["wind"])


# ---------------------------------------------------------------- projections
PROJ_POS = ("QB", "RB", "WR", "TE")
FEATURES = ["Season average", "Last 3 vs season", "Team total vs 22.5", "Wind (mph)"]


def projection_samples(stats_rows, games_by_id, min_prior=2):
    """One sample per player-game: what was known before the game, and the PPR points scored."""
    by = defaultdict(list)
    for r in stats_rows:
        if r["season_type"] == "REG" and r["position"] in PROJ_POS:
            by[(r["season"], r["player_id"])].append(r)
    out = defaultdict(list)
    for ws in by.values():
        ws.sort(key=lambda r: int(r["week"]))
        for i in range(min_prior, len(ws)):
            r = ws[i]
            g = games_by_id.get(r["game_id"])
            if not g:
                continue
            it = implied_total(g, r["team"])
            if it is None:
                continue
            pts = [f(x["fantasy_points_ppr"]) for x in ws[:i]]
            per, l3 = mean(pts), mean(pts[-3:])
            out[r["position"]].append([per, l3 - per, it - 22.5, game_wind(g), f(r["fantasy_points_ppr"])])
    return out


def fit_projection(samples):
    model = {}
    for pos, rows in samples.items():
        X = [[1.0] + r[:4] for r in rows]
        Y = [r[4] for r in rows]
        b, se, p = ols(X, Y)
        model[pos] = {"n": len(rows), "coef": [round(x, 4) for x in b], "p": [round(x, 4) for x in p]}
    return model


def project(model, pos, per, l3, it, wind):
    m = model.get(pos)
    if not m or it is None:
        return per
    c = m["coef"]
    return max(0.0, c[0] + c[1] * per + c[2] * (l3 - per) + c[3] * (it - 22.5) + c[4] * wind)


START_LINE = {"QB": 12, "RB": 24, "WR": 30, "TE": 12, "K": 12, "DST": 12}


def verdict(rank, pos):
    line = START_LINE.get(pos, 12)
    if rank is None:
        return "On bye"
    return "Must start" if rank <= line * 0.4 else "Start" if rank <= line else "Flex / borderline" if rank <= line * 1.4 else "Bench"


def rank_and_verdict(rows, key):
    """rows: dicts with Pos and key; adds Rank<key> and Verdict<key> within each position."""
    by = defaultdict(list)
    for r in rows:
        if r.get(key) is not None:
            by[r["Pos"]].append(r)
    for pos, lst in by.items():
        lst.sort(key=lambda r: -r[key])
        for i, r in enumerate(lst):
            r["Rank" + key] = i + 1
            r["Verdict" + key] = verdict(i + 1, pos)


# ---------------------------------------------------------------- waiver radar
def radar_samples(stats_rows, snaps):
    """Fringe RB/WR/TE (under 9 PPR a game so far): does a rising snap share predict the next three weeks?"""
    by = defaultdict(list)
    for r in stats_rows:
        if r["season_type"] == "REG" and r["position"] in ("RB", "WR", "TE"):
            wk = int(r["week"])
            by[r["player_id"]].append((wk, f(r["fantasy_points_ppr"]), f(r["targets"]) + f(r["carries"]),
                                       snaps.get((r["player_display_name"], r["team"], wk))))
    X, Y = [], []
    for ws in by.values():
        ws.sort()
        for i in range(4, len(ws) - 2):
            prev, nxt = ws[:i], ws[i:i + 3]
            per = mean(p for _, p, _, _ in prev)
            sn = [s for *_, s in prev if s is not None]
            if per >= 9 or len(sn) < 4:
                continue
            u_all, u2 = mean(o for _, _, o, _ in prev), mean(o for _, _, o, _ in prev[-2:])
            X.append([1.0, per, u2 - u_all, mean(sn[-2:]) - mean(sn)])
            Y.append(mean(p for _, p, _, _ in nxt))
    return X, Y


# ---------------------------------------------------------------- weather
INDOOR_SITES = {"ARI", "ATL", "DAL", "DET", "HOU", "IND", "LV", "LAR", "LAC", "MIN", "NO"}


def weather_model(all_games):
    rows = [g for g in all_games if g["game_type"] == "REG" and g["season"] >= "2018" and g["roof"] in ("outdoors", "open")
            and g["wind"] not in ("", "NA") and g["temp"] not in ("", "NA") and g["total"] not in ("", "NA") and g["total_line"] not in ("", "NA")]
    X = [[1.0, f(g["wind"]), f(g["temp"])] for g in rows]
    tot = [f(g["total"]) for g in rows]
    vs = [f(g["total"]) - f(g["total_line"]) for g in rows]
    b, _, p = ols(X, tot)
    bl, _, pl = ols(X, vs)
    bins = []
    for lo, hi, label in [(0, 10, "Under 10 mph"), (10, 15, "10-14 mph"), (15, 20, "15-19 mph"), (20, 99, "20+ mph")]:
        sel = [(t_, v) for g, t_, v in zip(rows, tot, vs) if lo <= f(g["wind"]) < hi]
        if sel:
            bins.append({"Bin": label, "Kind": "Wind", "Games": len(sel), "AvgTotal": round(mean(a for a, _ in sel), 1),
                         "VsLine": round(mean(v for _, v in sel), 1), "UnderPct": round(100 * mean(1 if v < 0 else 0 for _, v in sel), 1)})
    for lo, hi, label in [(-99, 32, "Below freezing"), (32, 50, "32-49°F"), (50, 80, "50-79°F"), (80, 200, "80°F+")]:
        sel = [(t_, v) for g, t_, v in zip(rows, tot, vs) if lo <= f(g["temp"]) < hi]
        if sel:
            bins.append({"Bin": label, "Kind": "Temperature", "Games": len(sel), "AvgTotal": round(mean(a for a, _ in sel), 1),
                         "VsLine": round(mean(v for _, v in sel), 1), "UnderPct": round(100 * mean(1 if v < 0 else 0 for _, v in sel), 1)})
    return {"Games": len(rows), "Since": 2018,
            "WindPerMph": round(b[1], 3), "WindP": round(p[1], 4), "TempPerDeg": round(b[2], 3), "TempP": round(p[2], 4),
            "WindVsLinePerMph": round(bl[1], 3), "WindVsLineP": round(pl[1], 4), "TempVsLinePerDeg": round(bl[2], 3), "TempVsLineP": round(pl[2], 4),
            "Bins": bins}


def fetch_forecast(lat, lon, date, hour):
    """Open-Meteo hourly forecast at kickoff (hour in Eastern time). Returns dict or None on any failure."""
    q = urllib.parse.urlencode({"latitude": lat, "longitude": lon, "hourly": "temperature_2m,precipitation_probability,wind_speed_10m,wind_gusts_10m",
                                "temperature_unit": "fahrenheit", "wind_speed_unit": "mph", "timezone": "America/New_York",
                                "start_date": date, "end_date": date})
    try:
        req = urllib.request.Request("https://api.open-meteo.com/v1/forecast?" + q, headers={"User-Agent": "nfl-oddities-site"})
        with urllib.request.urlopen(req, timeout=30) as r:
            d = json.loads(r.read().decode("utf-8"))
        hrs = d["hourly"]
        idx = next(i for i, ts in enumerate(hrs["time"]) if int(ts[11:13]) == hour)
        pick = lambda k: hrs[k][idx] if hrs.get(k) and hrs[k][idx] is not None else None
        return {"TempF": pick("temperature_2m"), "WindMph": pick("wind_speed_10m"), "GustMph": pick("wind_gusts_10m"), "PrecipPct": pick("precipitation_probability")}
    except Exception as e:  # network trouble, no forecast yet for that date, or an unexpected shape
        print("forecast unavailable:", type(e).__name__, e)
        return None


# ---------------------------------------------------------------- power ratings
def power_ratings(games, teams, lam=3.0):
    """games: site games rows (codes already ESPN-style). Ratings are points better than an average team on a neutral field."""
    idx = {tm: i for i, tm in enumerate(teams)}
    n = len(teams)
    finals = [g for g in games if g["Status"] == "Final"]

    def fit(rows, ycol, lam_):
        X, Y = [], []
        for g in rows:
            x = [0.0] * (n + 1)
            x[0] = 0.0 if g["Venue"] not in (g["Home"],) else 1.0
            x[1 + idx[g["Home"]]] += 1
            x[1 + idx[g["Away"]]] -= 1
            X.append(x)
            Y.append(ycol(g))
        b, _, _ = ols(X, Y, ridge=lam_, ridge_skip=(0,))
        r = b[1:]
        m = mean(r)
        return b[0], [x - m for x in r]

    hfa, rating = fit(finals, lambda g: g["HomeScore"] - g["AwayScore"], lam)
    lined = [g for g in games if g["Spread"] is not None and g["Favorite"]]
    mk_hfa, market = fit(lined, lambda g: (g["Spread"] if g["Favorite"] == g["Home"] else -g["Spread"] if g["Favorite"] == g["Away"] else 0.0), 1.0)

    # offense / defense: points = mu + home + off[team] - def[opp]
    X, Y = [], []
    for g in finals:
        for team, opp, pts, home in [(g["Home"], g["Away"], g["HomeScore"], 1.0 if g["Venue"] == g["Home"] else 0.0),
                                     (g["Away"], g["Home"], g["AwayScore"], 0.0)]:
            x = [1.0, home] + [0.0] * (2 * n)
            x[2 + idx[team]] = 1.0
            x[2 + n + idx[opp]] = -1.0
            X.append(x)
            Y.append(pts)
    b, _, _ = ols(X, Y, ridge=lam, ridge_skip=(0, 1))
    off = b[2:2 + n]
    dfn = b[2 + n:]
    mo, md = mean(off), mean(dfn)
    off, dfn = [x - mo for x in off], [x - md for x in dfn]

    out = []
    for tm in teams:
        mine = [g for g in finals if tm in (g["Home"], g["Away"])]
        pf = sum(g["HomeScore"] if g["Home"] == tm else g["AwayScore"] for g in mine)
        pa = sum(g["AwayScore"] if g["Home"] == tm else g["HomeScore"] for g in mine)
        w = sum(1 for g in mine if (g["HomeScore"] - g["AwayScore"]) * (1 if g["Home"] == tm else -1) > 0)
        tie = sum(1 for g in mine if g["HomeScore"] == g["AwayScore"])
        l = len(mine) - w - tie
        pyth = (pf ** 2.37 / (pf ** 2.37 + pa ** 2.37)) * len(mine) if pf + pa else 0
        opp_played = [g["Away"] if g["Home"] == tm else g["Home"] for g in mine]
        left = [g["Away"] if g["Home"] == tm else g["Home"] for g in games if g["Status"] == "Upcoming" and tm in (g["Home"], g["Away"])]
        out.append({"Team": tm, "Rating": round(rating[idx[tm]], 1), "Off": round(off[idx[tm]], 1), "Def": round(dfn[idx[tm]], 1),
                    "Market": round(market[idx[tm]], 1), "W": w, "L": l, "T": tie, "PythW": round(pyth, 1), "Luck": round(w + 0.5 * tie - pyth, 1),
                    "SOSPlayed": round(mean(rating[idx[o]] for o in opp_played), 1), "SOSLeft": round(mean(rating[idx[o]] for o in left), 1) if left else None,
                    "GamesLeft": len(left)})
    out.sort(key=lambda r: -r["Rating"])
    for i, r in enumerate(out):
        r["Rank"] = i + 1
    return out, round(hfa, 1), round(mk_hfa, 1)
