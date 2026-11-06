# NFL Oddities

A static NFL dashboard for the 2026 season: stats and fantasy points (PPR or half-PPR) for every player, kicker and team defense, a page per player with weekly trends and game logs, plus fourth-down aggressiveness, rest and travel fatigue, referee crew tendencies and touchdown-luck outliers. Teams show in their own colors.

Live at https://adampap5.github.io/nfl-oddities

## How it works

- `index.html` plus `assets/` is the whole site; it reads the JSON files in `data/`.
- `scripts/build_data.py` rebuilds `players`, `weekly`, `teams`, `games`, `standings` and `meta` from [nflverse](https://github.com/nflverse/nflverse-data) open data. It uses only the Python standard library.
- `.github/workflows/pages.yml` runs that script every morning, commits any changes and redeploys GitHub Pages. You can also run it by hand from the Actions tab ("Run workflow").
- `fourth_downs`, `referees` and `referee_notes` come from StatMuse, NFL Penalty Tracker and Sharp Football Analysis and are refreshed weekly by a scheduled Claude task.
- `stadiums.json` is fixed reference data (coordinates, time zones, elevation) used for travel and fatigue.
