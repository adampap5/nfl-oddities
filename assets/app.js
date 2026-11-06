/* NFL Oddities — static site app. Loads data/*.json, computes the analysis, renders the current page. */
(function () {
  'use strict';
  const FILES = ['meta', 'players', 'weekly', 'teams', 'games', 'standings', 'fourth_downs', 'referees', 'referee_notes', 'stadiums'];
  const D = {};
  const X = {}; // derived data
  const state = {
    route: 'home', playerId: null,
    scoring: load('scoring') || 'PPR',
    cat: 'fantasy', q: '', pos: '', team: '',
    roster: (load('roster') || '').split(',').filter(Boolean), myq: '',
  };
  const fmtN = d3.format(',');
  const COLORS = ['#c96442', '#3f7cac', '#6a9a4f', '#a3639e', '#d39a2c', '#4a9a96'];

  function load(k) { try { return localStorage.getItem('nfl-' + k); } catch (e) { return null; } }
  function save(k, v) { try { localStorage.setItem('nfl-' + k, v); } catch (e) { /* ignore */ } }

  // ---------- small DOM helpers ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  }
  const $ = (id) => document.getElementById(id);
  const show = (v, f) => (v === null || v === undefined || v === '' || Number.isNaN(v) ? '—' : f ? f(v) : String(v));
  const signed = (v) => (v > 0 ? '+' : '') + v;
  const one = (v) => (typeof v === 'number' ? (Math.round(v * 10) / 10).toFixed(1) : v);

  // ---------- team colors ----------
  function lum(hex) {
    const c = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const teamColor = (t) => (X.team[t] ? X.team[t].Color : '#888888');
  const inkOn = (hex) => (lum(hex) > 0.4 ? '#111111' : '#ffffff');
  function chip(t) {
    if (!t) return '—';
    const c = teamColor(t);
    return h('span', { class: 'nfl-chip', style: { background: c, color: inkOn(c) }, title: X.team[t] ? X.team[t].Name : t }, t);
  }
  const plink = (r) => h('a', { class: 'nfl-plink', href: '#player/' + encodeURIComponent(r.Id) }, r.Player);
  const pts = () => state.scoring; // 'PPR' | 'Half'
  const ppg = () => (state.scoring === 'PPR' ? 'PPRPerGame' : 'HalfPerGame');

  // ---------- table ----------
  // cols: {k, h, f(fmt), cls(v,r), r(render node), l(left), s(sortable, default true), sm(hide on small)}
  function table(host, rows, cols, opts = {}) {
    const st = host._sort || (host._sort = { k: opts.sort, dir: opts.dir || -1 });
    let data = rows;
    if (st.k) {
      const col = cols.find((c) => c.k === st.k);
      const val = (r) => (col && col.v ? col.v(r) : r[st.k]);
      data = [...rows].sort((a, b) => {
        const x = val(a), y = val(b);
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        return typeof x === 'number' || typeof y === 'number' ? st.dir * (x - y) : st.dir * String(x).localeCompare(String(y));
      });
    }
    if (opts.limit) data = data.slice(0, opts.limit);
    const thead = h('thead', null, h('tr', null, (opts.rank ? [h('th', { class: 'l' }, '#')] : []).concat(cols.map((c) => {
      const th = h('th', { class: [c.l ? 'l' : '', c.sm ? 'nfl-hide-sm' : ''].join(' ') });
      if (opts.sortable === false || c.s === false) th.append(c.h);
      else {
        if (st.k === c.k) th.setAttribute('aria-sort', st.dir > 0 ? 'ascending' : 'descending');
        th.append(h('button', { class: 'nfl-sort', onclick: () => { st.dir = st.k === c.k ? -st.dir : (c.l ? 1 : -1); st.k = c.k; table(host, rows, cols, opts); } }, c.h));
      }
      return th;
    }))));
    const tbody = h('tbody');
    let lastGroup = null;
    data.forEach((r, i) => {
      if (opts.group) {
        const g = opts.group(r);
        if (g !== lastGroup) { tbody.append(h('tr', { class: 'divrow' }, h('td', { colspan: cols.length + (opts.rank ? 1 : 0) }, g))); lastGroup = g; }
      }
      const tr = h('tr');
      if (opts.rank) tr.append(h('td', { class: 'rank l' }, i + 1));
      cols.forEach((c) => {
        const v = r[c.k];
        const td = h('td', { class: [c.l ? 'l' : '', c.sm ? 'nfl-hide-sm' : '', c.cls ? c.cls(v, r) : ''].join(' ') });
        td.append(c.r ? c.r(r) : show(v, c.f));
        tr.append(td);
      });
      tbody.append(tr);
    });
    if (!data.length) tbody.append(h('tr', null, h('td', { colspan: cols.length, class: 'l nfl-empty' }, opts.empty || 'Nothing to show.')));
    host.replaceChildren(h('table', { class: 'nfl-table' }, thead, tbody));
  }
  const C = {
    player: { k: 'Player', h: 'Player', l: true, r: plink },
    team: { k: 'Team', h: 'Team', l: true, r: (r) => chip(r.Team) },
    pos: { k: 'Pos', h: 'Pos', l: true },
  };

  // ---------- tooltip ----------
  function tip(box) {
    const t = h('div', { class: 'nfl-tip', hidden: true });
    box.append(t);
    return {
      show(ev, title, lines) {
        t.replaceChildren(h('div', { class: 't' }, title), ...[].concat(lines).map((l) => h('div', null, l)));
        t.hidden = false;
        const r = box.getBoundingClientRect();
        let x = ev.clientX - r.left + 12, y = ev.clientY - r.top + 12;
        x = Math.min(x, r.width - t.offsetWidth - 4);
        y = Math.min(y, r.height - t.offsetHeight - 4);
        t.style.left = Math.max(4, x) + 'px';
        t.style.top = Math.max(4, y) + 'px';
      },
      hide() { t.hidden = true; },
    };
  }
  const textW = (svg, s) => { const t = svg.append('text').style('font-size', 'var(--cds-font-size-caption)').text(s); const w = t.node().getComputedTextLength(); t.remove(); return w; };

  // ---------- derived data ----------
  function derive() {
    X.team = Object.fromEntries(D.teams.map((t) => [t.Team, t]));
    X.player = Object.fromEntries(D.players.map((p) => [p.Id, p]));
    X.weekly = d3.group(D.weekly, (w) => w.Id);
    X.site = Object.fromEntries(D.stadiums.map((s) => [s.Site, s]));
    const finals = D.games.filter((g) => g.Status === 'Final');
    const upcoming = D.games.filter((g) => g.Status === 'Upcoming');
    X.through = d3.max(finals, (g) => g.Week) || 0;
    X.next = upcoming.length ? d3.min(upcoming, (g) => g.Week) : null;
    X.gameOf = new Map(); // `${team}|${week}` -> game
    D.games.forEach((g) => { X.gameOf.set(g.Away + '|' + g.Week, g); X.gameOf.set(g.Home + '|' + g.Week, g); });

    // positional ranks for both scorings
    for (const sc of ['PPR', 'Half']) {
      d3.group(D.players, (p) => p.Pos).forEach((list) => {
        [...list].sort((a, b) => b[sc] - a[sc]).forEach((p, i) => { p['Rank' + sc] = i + 1; });
      });
    }

    // fourth downs
    const fd = new Map(D.fourth_downs.map((r) => [r.Team, r]));
    const shown = D.fourth_downs.map((r) => ({ apg: r.Attempts / r.Games, pct: +r.ConvPct }));
    const avgA = d3.mean(shown, (d) => d.apg), avgP = d3.mean(shown, (d) => d.pct);
    X.courage = D.standings.map((s) => {
      const r = fd.get(s.Team);
      if (!r) return { Team: s.Team, Name: s.Name, Attempts: null, Conversions: null, AttPerGame: null, ConvPct: null, Record: `${s.W}-${s.L}${s.T ? '-' + s.T : ''}`, WinPct: s.WinPct, Style: 'Under 8 attempts' };
      const apg = Math.round((r.Attempts / r.Games) * 100) / 100, pct = +r.ConvPct;
      const bold = apg >= avgA, good = pct >= avgP;
      return { Team: s.Team, Name: s.Name, Attempts: r.Attempts, Conversions: r.Conversions, AttPerGame: apg, ConvPct: pct, Record: `${s.W}-${s.L}${s.T ? '-' + s.T : ''}`, WinPct: s.WinPct,
        Style: bold && good ? 'Bold and it works' : bold ? 'Bold, not paying off' : good ? 'Picks spots well' : 'Cautious and shaky' };
    }).sort((a, b) => (b.AttPerGame ?? -1) - (a.AttPerGame ?? -1));
    X.courageAvg = { avgA, avgP };

    // referee crews
    X.crews = D.referees.map((r) => ({ Referee: r.Referee, Games: r.Games, PenPerGame: r.PenPerGame, PenPerGame2025: r.PenPerGame2025,
      Change: Math.round((r.PenPerGame - r.PenPerGame2025) * 100) / 100, YdsPerGame: r.YdsPerGame, HomeLean: Math.round((r.HomePerGame - r.AwayPerGame) * 100) / 100 }))
      .sort((a, b) => b.PenPerGame - a.PenPerGame);

    // travel
    const rad = (d) => (d * Math.PI) / 180;
    const miles = (a, b) => {
      const dLat = rad(b.Lat - a.Lat), dLon = rad(b.Lon - a.Lon);
      const q = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.Lat)) * Math.cos(rad(b.Lat)) * Math.sin(dLon / 2) ** 2;
      return 3959 * 2 * Math.asin(Math.sqrt(q));
    };
    const hour = (k) => { const [hm, ap] = k.split(' '); const [hh, mm] = hm.split(':').map(Number); return (hh % 12) + (ap === 'PM' ? 12 : 0) + mm / 60; };
    const clock = (x) => { const hh = Math.floor(((x % 24) + 24) % 24), mm = Math.round((x - Math.floor(x)) * 60); return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`; };
    const fat = [];
    D.games.filter((g) => g.Week === X.next).forEach((g) => {
      [[g.Away, g.Home, true, g.AwayRest], [g.Home, g.Away, false, g.HomeRest]].forEach(([team, opp, away, rest]) => {
        const home = X.site[team], venue = X.site[g.Venue] || X.site[g.Home];
        const mi = Math.round(miles(home, venue));
        const zones = venue.HoursFromET - home.HoursFromET;
        const body = hour(g.Kickoff) + home.HoursFromET;
        const flags = []; let score = 0;
        if (!rest || rest >= 10) { flags.push('Off a bye'); score -= 2; }
        else if (rest <= 4) { flags.push('Short week'); score += 3; }
        else if (rest <= 6) { flags.push('Six days or less'); score += 1; }
        score += Math.floor(mi / 1000);
        if (Math.abs(zones) >= 5) { flags.push('Overseas'); score += 3; }
        else if (Math.abs(zones) >= 2) { flags.push(`${Math.abs(zones)} time zones`); score += Math.abs(zones) - 1; }
        if (body < 11.5) { flags.push('Early body clock'); score += 2; }
        if (venue.ElevationFt >= 5000 && g.Venue !== team) { flags.push('Altitude'); score += 1; }
        fat.push({ Team: team, Opp: opp, GameId: g.GameId, Where: (away ? '@ ' : 'vs ') + opp + (g.Venue !== g.Home ? ' (' + venue.City.split(',')[0] + ')' : ''),
          Day: g.Day.split(' ')[0], Kickoff: g.Kickoff, RestDays: rest, Miles: mi, TimeZones: zones, BodyClock: clock(body), Score: score, Flags: flags.join(' · ') || 'None' });
      });
    });
    X.fatigue = fat.sort((a, b) => b.Score - a.Score || b.Miles - a.Miles);
    const fby = new Map(X.fatigue.map((r) => [r.Team, r]));
    X.fatigueGames = D.games.filter((g) => g.Week === X.next).map((g) => {
      const a = fby.get(g.Away).Score, hs = fby.get(g.Home).Score, d = a - hs;
      return { GameId: g.GameId, Away: g.Away, Home: g.Home, Kickoff: g.Day.split(' ')[0] + ' ' + g.Kickoff, AwayScore: a, HomeScore: hs, Diff: Math.abs(d), Edge: d === 0 ? null : d > 0 ? g.Home : g.Away };
    }).sort((x, y) => y.Diff - x.Diff);
    X.fatigueBy = fby;
    const trav = new Map(D.teams.map((t) => [t.Team, { Team: t.Team, Done: 0, Left: 0, Trips: 0 }]));
    D.games.forEach((g) => {
      const venue = X.site[g.Venue] || X.site[g.Home];
      [g.Away, g.Home].forEach((team) => {
        if (g.Venue === team) return;
        const rt = 2 * miles(X.site[team], venue);
        const r = trav.get(team);
        r[g.Status === 'Final' ? 'Done' : 'Left'] += rt;
        r.Trips += 1;
      });
    });
    X.travel = [...trav.values()].map((r) => ({ ...r, Done: Math.round(r.Done), Left: Math.round(r.Left), Total: Math.round(r.Done + r.Left) })).sort((a, b) => b.Total - a.Total);

    // touchdown luck, usage, sacks
    const sk = D.players.filter((p) => p.Pos !== 'DST' && p.Pos !== 'K');
    const rushers = sk.filter((p) => p.Carries >= 30), catchers = sk.filter((p) => p.Rec >= 15);
    const rr = d3.sum(rushers, (p) => p.RushTD) / d3.sum(rushers, (p) => p.Carries);
    const cr = d3.sum(catchers, (p) => p.RecTD) / d3.sum(catchers, (p) => p.Rec);
    const luck = (p, kind, n, td, rate) => { const e = Math.round(n * rate * 10) / 10; return { Id: p.Id, Player: p.Player, Team: p.Team, Pos: p.Pos, Kind: kind, Touches: n, TD: td, ExpectedTD: e, Gap: Math.round((td - e) * 10) / 10 }; };
    X.tdLuck = [...rushers.map((p) => luck(p, 'Rushing', p.Carries, p.RushTD, rr)), ...catchers.map((p) => luck(p, 'Receiving', p.Rec, p.RecTD, cr))].sort((a, b) => b.Gap - a.Gap);
    X.usage = sk.filter((p) => p.Pos !== 'QB' && (p.Carries + p.Targets) / p.GP >= 10).map((p) => ({ Id: p.Id, Player: p.Player, Team: p.Team, Pos: p.Pos,
      OppPerGame: Math.round(((p.Carries + p.Targets) / p.GP) * 10) / 10, PtsPerTouch: Math.round((p.Half / (p.Carries + p.Targets)) * 100) / 100, PerGame: p.HalfPerGame })).sort((a, b) => a.PtsPerTouch - b.PtsPerTouch);
    X.sacks = sk.filter((p) => p.Att >= 100).map((p) => ({ Id: p.Id, Player: p.Player, Team: p.Team, Dropbacks: p.Att + p.Sacks, Sacks: p.Sacks, SackRate: Math.round((p.Sacks / (p.Att + p.Sacks)) * 1000) / 10 })).sort((a, b) => b.SackRate - a.SackRate);
  }

  // ---------- header ----------
  function renderHeader() {
    const m = D.meta[0];
    $('asof').textContent = `${m.Season} season · through Week ${X.through}`;
    const first = D.games.filter((g) => g.Week === X.next)[0];
    const tired = X.fatigue[0];
    const crew = X.crews[0];
    const take = $('takeaway');
    take.replaceChildren();
    if (first) take.append('Week ', h('b', null, X.next), ' starts with ', h('b', null, `${first.Away} at ${first.Home}`), ` (${first.Day}, ${first.Kickoff}). `);
    if (tired) take.append('The most travel-worn team this week is ', h('b', null, X.team[tired.Team].Name), ` (${tired.Flags.toLowerCase()}), and `);
    if (crew) take.append(h('b', null, crew.Referee), "'s crew is throwing the most flags in the league.");
    $('built').textContent = `Stats updated ${d3.utcFormat('%b %-d, %Y')(new Date(m.BuiltAt))} · ${fmtN(m.Players)} players tracked · Built with Claude.`;
    document.querySelectorAll('.nfl-scoring button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.scoring === state.scoring)));
  }

  // ---------- HOME ----------
  function renderHome() {
    const top = (k, f) => d3.greatest(D.players.filter(f || (() => true)), (p) => p[k]);
    const p = top('PassYds'), r = top('RushYds'), c = top('RecYds'), f = top(pts());
    const bold = X.courage[0], crew = X.crews[0];
    const tile = (lbl, big, who, team) => h('div', { class: 'nfl-tile', style: team ? { '--tc': teamColor(team) } : null }, h('div', { class: 'lbl' }, lbl), h('div', { class: 'big' }, big), h('div', { class: 'who' }, who));
    $('home-tiles').replaceChildren(
      tile('Passing yards leader', fmtN(p.PassYds), plink(p), p.Team),
      tile('Rushing yards leader', fmtN(r.RushYds), plink(r), r.Team),
      tile('Receiving yards leader', fmtN(c.RecYds), plink(c), c.Team),
      tile(`Top fantasy scorer (${state.scoring === 'PPR' ? 'PPR' : 'half-PPR'})`, one(f[pts()]), plink(f), f.Team),
      tile('Most 4th-down tries per game', show(bold.AttPerGame), bold.Name, bold.Team),
      tile('Flag-happiest crew (per game)', show(crew.PenPerGame), crew.Referee),
    );
    $('this-week-title').textContent = `Week ${X.next} games`;
    $('last-week-title').textContent = `Week ${X.through} results`;
    const line = (g) => (g.Favorite ? (g.Favorite === 'Pick' ? 'Pick' : `${g.Favorite} −${g.Spread}`) : null);
    const favCls = (side) => (v, g) => (v !== null && v > (side === 'a' ? g.HomeWinProb : g.AwayWinProb) ? 'nfl-good' : '');
    table($('upcoming'), D.games.filter((g) => g.Week === X.next), [
      { k: 'Day', h: 'Day', l: true }, { k: 'Kickoff', h: 'Time' },
      { k: 'Away', h: 'Away', l: true, r: (g) => chip(g.Away) }, { k: 'AwayWinProb', h: 'Win %', cls: favCls('a') },
      { k: 'Home', h: 'Home', l: true, r: (g) => chip(g.Home) }, { k: 'HomeWinProb', h: 'Win %', cls: favCls('h') },
      { k: 'Spread', h: 'Line', r: (g) => show(line(g)), sm: true }, { k: 'Total', h: 'O/U', sm: true }, { k: 'Window', h: 'Slot', l: true, sm: true },
    ], { sortable: false });
    const won = (side) => (v, g) => ((side === 'a' ? g.AwayScore > g.HomeScore : g.HomeScore > g.AwayScore) ? 'nfl-good' : '');
    table($('results'), D.games.filter((g) => g.Week === X.through), [
      { k: 'Away', h: 'Away', l: true, r: (g) => chip(g.Away) }, { k: 'AwayScore', h: 'Pts', cls: won('a') },
      { k: 'Home', h: 'Home', l: true, r: (g) => chip(g.Home) }, { k: 'HomeScore', h: 'Pts', cls: won('h') },
      { k: 'Spread', h: 'Line', r: (g) => show(line(g)), sm: true }, { k: 'Window', h: 'Slot', l: true, sm: true },
    ], { sortable: false });
    const lead = (id, k, extra) => table($(id), D.players, [C.player, C.team, { k, h: 'Yds', f: fmtN }, extra], { sort: k, limit: 5, sortable: false, rank: true });
    lead('lead-pass', 'PassYds', { k: 'PassTD', h: 'TD' });
    lead('lead-rush', 'RushYds', { k: 'RushTD', h: 'TD' });
    lead('lead-rec', 'RecYds', { k: 'RecTD', h: 'TD' });
    $('lead-fan-note').textContent = `${state.scoring === 'PPR' ? 'Full PPR' : 'Half-PPR'} season points, top 5.`;
    table($('lead-fan'), D.players, [C.player, C.pos, { k: pts(), h: 'Pts', f: one }, { k: ppg(), h: 'Per game', f: one }], { sort: pts(), limit: 5, sortable: false, rank: true });
    ['AFC', 'NFC'].forEach((conf) => {
      const rows = D.standings.filter((s) => s.Conf === conf).sort((a, b) => a.Division.localeCompare(b.Division) || b.WinPct - a.WinPct || b.Diff - a.Diff);
      table($(conf.toLowerCase()), rows, [
        { k: 'Team', h: 'Team', l: true, r: (s) => h('span', null, chip(s.Team), ' ', h('span', { class: 'nfl-hide-sm' }, X.team[s.Team].Nick)) },
        { k: 'W', h: 'W' }, { k: 'L', h: 'L' }, { k: 'WinPct', h: 'Pct', f: (v) => v.toFixed(3).replace(/^0/, '') },
        { k: 'PF', h: 'PF', sm: true }, { k: 'PA', h: 'PA', sm: true }, { k: 'Diff', h: 'Diff', f: signed, cls: (v) => (v > 0 ? 'nfl-good' : v < 0 ? 'nfl-bad' : '') },
        { k: 'Streak', h: 'Strk' },
      ], { sortable: false, group: (s) => s.Division.replace(/^(AFC|NFC) /, '') });
    });
  }

  // ---------- PLAYERS ----------
  const CATS = {
    fantasy: { title: () => `Fantasy points (${state.scoring === 'PPR' ? 'full PPR' : 'half-PPR'})`, note: 'Every player with fantasy points this season. Click any name for his weekly trends and game log.', filter: () => true, sort: () => pts(),
      cols: () => [C.player, C.team, C.pos, { k: 'GP', h: 'GP' }, { k: pts(), h: 'Pts', f: one }, { k: ppg(), h: 'Per game', f: one }, { k: 'Rank' + pts(), h: 'Pos rank', r: (p) => p.Pos + p['Rank' + pts()], v: (p) => -p['Rank' + pts()], sm: true },
        { k: 'PassYds', h: 'Pass yds', f: fmtN, sm: true }, { k: 'RushYds', h: 'Rush yds', f: fmtN, sm: true }, { k: 'Rec', h: 'Rec', sm: true }, { k: 'RecYds', h: 'Rec yds', f: fmtN, sm: true },
        { k: 'TD', h: 'TD', v: (p) => (p.PassTD || 0) + (p.RushTD || 0) + (p.RecTD || 0), r: (p) => (p.Pos === 'DST' ? show(p.DefTD) : (p.PassTD || 0) + (p.RushTD || 0) + (p.RecTD || 0)), sm: true }] },
    passing: { title: () => 'Passing', note: 'Everyone with a pass attempt, sorted by yards. Rating-style efficiency: completion rate and yards per attempt.', filter: (p) => p.Att > 0, sort: () => 'PassYds',
      cols: () => [C.player, C.team, { k: 'GP', h: 'GP' }, { k: 'Cmp', h: 'Cmp' }, { k: 'Att', h: 'Att' }, { k: 'CmpPct', h: 'Cmp %', f: one }, { k: 'PassYds', h: 'Yds', f: fmtN }, { k: 'YPA', h: 'Y/A', f: one }, { k: 'PassTD', h: 'TD' }, { k: 'Int', h: 'INT' }, { k: 'Sacks', h: 'Sacked' }, { k: 'RushYds', h: 'Rush yds', sm: true }, { k: pts(), h: 'Pts', f: one }] },
    rushing: { title: () => 'Rushing', note: 'Everyone with a carry, sorted by yards.', filter: (p) => p.Carries > 0, sort: () => 'RushYds',
      cols: () => [C.player, C.team, C.pos, { k: 'GP', h: 'GP' }, { k: 'Carries', h: 'Att' }, { k: 'RushYds', h: 'Yds', f: fmtN }, { k: 'YPC', h: 'Y/C', f: one }, { k: 'RushTD', h: 'TD' }, { k: 'Targets', h: 'Tgt', sm: true }, { k: 'Rec', h: 'Rec', sm: true }, { k: 'RecYds', h: 'Rec yds', sm: true }, { k: 'FumLost', h: 'Fum lost', sm: true }, { k: pts(), h: 'Pts', f: one }] },
    receiving: { title: () => 'Receiving', note: 'Everyone with a target, sorted by yards. Target share is the average share of his team’s targets per game.', filter: (p) => p.Targets > 0, sort: () => 'RecYds',
      cols: () => [C.player, C.team, C.pos, { k: 'GP', h: 'GP' }, { k: 'Targets', h: 'Tgt' }, { k: 'Rec', h: 'Rec' }, { k: 'RecYds', h: 'Yds', f: fmtN }, { k: 'YPR', h: 'Y/R', f: one }, { k: 'RecTD', h: 'TD' }, { k: 'TgtShare', h: 'Tgt share %', f: one }, { k: 'RushYds', h: 'Rush yds', sm: true }, { k: pts(), h: 'Pts', f: one }] },
    kicking: { title: () => 'Kicking', note: 'Field goals and extra points. Points: 3 for 0–39 yards, 4 for 40–49, 5 for 50+, 1 per extra point, −1 per miss.', filter: (p) => p.Pos === 'K', sort: () => 'PPR',
      cols: () => [C.player, C.team, { k: 'GP', h: 'GP' }, { k: 'FGM', h: 'FGM' }, { k: 'FGA', h: 'FGA' }, { k: 'FGPct', h: 'FG %', v: (p) => (p.FGA ? p.FGM / p.FGA : null), r: (p) => (p.FGA ? Math.round((p.FGM / p.FGA) * 100) + '%' : '—') }, { k: 'XPM', h: 'XPM' }, { k: 'XPA', h: 'XPA' }, { k: 'PPR', h: 'Pts', f: one }, { k: 'PPRPerGame', h: 'Per game', f: one }] },
    defense: { title: () => 'Team defense (D/ST)', note: 'Sacks 1, takeaways 2, safeties and blocked kicks 2, defensive and return TDs 6, plus points-allowed tiers from +5 (shutout) to −5 (46+).', filter: (p) => p.Pos === 'DST', sort: () => 'PPR',
      cols: () => [C.player, C.team, { k: 'GP', h: 'GP' }, { k: 'PtsAllowedPerGame', h: 'Pts allowed/g', f: one }, { k: 'DefSacks', h: 'Sacks', f: one }, { k: 'DefInt', h: 'INT' }, { k: 'FumRec', h: 'Fum rec' }, { k: 'DefTD', h: 'TD' }, { k: 'PPR', h: 'Pts', f: one }, { k: 'PPRPerGame', h: 'Per game', f: one }] },
  };
  function renderPlayers() {
    const cat = CATS[state.cat];
    $('cat-title').textContent = cat.title();
    $('cat-note').textContent = cat.note;
    document.querySelectorAll('#cat-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cat === state.cat)));
    const q = state.q.toLowerCase();
    const rows = D.players.filter((p) => cat.filter(p) && (!state.pos || p.Pos === state.pos) && (!state.team || p.Team === state.team) && (!q || p.Player.toLowerCase().includes(q)));
    const host = $('player-table');
    if (host._cat !== state.cat + state.scoring) { host._sort = null; host._cat = state.cat + state.scoring; }
    table(host, rows, cat.cols(), { sort: cat.sort(), rank: true, empty: 'No players match these filters.' });
    // quick results
    const res = $('search-results');
    if (!q) { res.hidden = true; return; }
    const hits = D.players.filter((p) => p.Player.toLowerCase().includes(q)).slice(0, 12);
    res.hidden = false;
    res.replaceChildren(hits.length
      ? h('ul', null, hits.map((p) => h('li', null, h('a', { href: '#player/' + encodeURIComponent(p.Id) }, chip(p.Team), h('span', { class: 'nfl-plink' }, p.Player), h('span', { class: 'meta' }, `${p.Pos} · ${one(p[ppg()])} per game`)))))
      : h('p', { class: 'nfl-empty' }, 'No player matches that search.'));
  }


  // ---------- MY TEAM ----------
  const POS_ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];
  const START_LINE = { QB: 12, RB: 24, WR: 30, TE: 12, K: 12, DST: 12 };
  function saveRoster() { state.roster = [...new Set(state.roster)].filter((id) => X.player[id]); save('roster', state.roster.join(',')); }
  function implied(g, team) {
    if (!g || g.Total === null || g.Spread === null || !g.Favorite) return null;
    const fav = g.Favorite === team ? 1 : g.Favorite === 'Pick' ? 0 : -1;
    return Math.round(((g.Total + fav * g.Spread) / 2) * 10) / 10;
  }
  function outlook(p) {
    const sc = pts();
    const weeks = X.weekly.get(p.Id) || [];
    const per = p[sc] / p.GP;
    const l3w = weeks.slice(-3);
    const l3 = l3w.length ? d3.mean(l3w, (w) => w[sc]) : null;
    const g = D.games.find((x) => x.Week === X.next && (x.Away === p.Team || x.Home === p.Team));
    const tags = [];
    let adj = 0;
    const tag = (cls, text, w) => { tags.push([cls, text]); adj += w; };
    if (!g) return { p, g: null, per, l3, tags: [['bad', 'On bye']], verdict: 'On bye', rank: null, it: null, fat: null, sortKey: -1 };
    const it = implied(g, p.Team);
    const wp = g.Away === p.Team ? g.AwayWinProb : g.HomeWinProb;
    const fat = X.fatigueBy.get(p.Team);
    if (it !== null && p.Pos !== 'DST') {
      if (it >= 26) tag('good', `High team total (${it})`, 1);
      else if (it <= 19) tag('bad', `Low team total (${it})`, -1);
    }
    if (p.Pos === 'DST' && it !== null) {
      const oppTotal = Math.round((g.Total - it) * 10) / 10;
      if (oppTotal <= 19) tag('good', `Opponent projected for ${oppTotal}`, 1);
      else if (oppTotal >= 26) tag('bad', `Opponent projected for ${oppTotal}`, -1);
    }
    if (wp !== null && wp !== undefined) {
      if (wp >= 70 && (p.Pos === 'RB' || p.Pos === 'DST' || p.Pos === 'K')) tag('good', 'Big favorite', 1);
      if (wp <= 30 && p.Pos === 'RB') tag('warn', 'Likely trailing', -1);
      if (wp <= 30 && (p.Pos === 'WR' || p.Pos === 'TE' || p.Pos === 'QB')) tag('muted', 'Likely throwing late', 0);
    }
    if (fat) {
      if (fat.Score >= 4) tag('warn', 'Tough travel spot', -1);
      else if (fat.Score <= -2) tag('good', 'Rested', 0.5);
      if (/Short week/.test(fat.Flags)) tag('warn', 'Short week', -0.5);
    }
    if (l3 !== null && weeks.length >= 4) {
      if (l3 >= per * 1.2) tag('good', 'Hot lately', 0.5);
      else if (l3 <= per * 0.8) tag('warn', 'Cooling off', -0.5);
    }
    if (p.Pos !== 'K' && p.Pos !== 'DST' && weeks.length >= 4) {
      const touches = (w) => (w.Targets || 0) + (w.Carries || 0) + (p.Pos === 'QB' ? 0 : 0);
      if (p.Pos !== 'QB') {
        const u3 = d3.mean(l3w, touches), uAll = d3.mean(weeks, touches);
        if (uAll >= 4 && u3 >= uAll * 1.2) tag('good', 'Usage rising', 0.5);
        else if (uAll >= 4 && u3 <= uAll * 0.75) tag('bad', 'Usage falling', -0.5);
      }
    }
    const luck = X.tdLuck.filter((r) => r.Id === p.Id);
    const gap = d3.sum(luck, (r) => r.Gap);
    if (gap >= 2.5) tag('warn', 'TD-lucky so far', 0);
    else if (gap <= -2) tag('good', 'Due for TDs', 0.5);
    // rank by per-game points at his position (3+ games), then nudge by the signals
    const pool = D.players.filter((q) => q.Pos === p.Pos && q.GP >= 3).sort((a, b) => b[ppg()] - a[ppg()]);
    const rank = pool.findIndex((q) => q.Id === p.Id) + 1 || pool.length;
    const line = START_LINE[p.Pos] || 12;
    const eff = rank - adj * (line / 6);
    const verdict = eff <= line * 0.4 ? 'Must start' : eff <= line ? 'Start' : eff <= line * 1.4 ? 'Flex / borderline' : 'Bench';
    return { p, g, per, l3, tags, verdict, rank, it, fat, sortKey: eff };
  }
  function renderMyTeam() {
    saveRoster();
    const res = $('my-results');
    const q = state.myq.toLowerCase();
    if (q) {
      const hits = D.players.filter((p) => p.Player.toLowerCase().includes(q)).slice(0, 12);
      res.hidden = false;
      res.replaceChildren(hits.length ? h('ul', null, hits.map((p) => {
        const on = state.roster.includes(p.Id);
        return h('li', null, h('a', { href: '#myteam', onclick: (e) => { e.preventDefault(); if (!on) state.roster.push(p.Id); state.myq = ''; $('my-search').value = ''; renderMyTeam(); $('my-search').focus(); } },
          chip(p.Team), h('span', { class: 'nfl-plink' }, p.Player), h('span', { class: 'meta' }, on ? 'On your team' : `${p.Pos} · ${one(p[ppg()])}/g`)));
      })) : h('p', { class: 'nfl-empty' }, 'No player matches that search.'));
    } else res.hidden = true;

    const body = $('my-body');
    if (!state.roster.length) {
      body.replaceChildren(h('div', { class: 'nfl-card' }, h('h3', null, 'Your roster is empty'), h('p', { class: 'nfl-note' }, 'Add your players above. Each one gets a start/sit lean for this week built from his scoring pace, the betting outlook for his team, rest and travel, recent form, usage trend and touchdown luck.')));
      return;
    }
    const rows = state.roster.map((id) => outlook(X.player[id])).sort((a, b) => POS_ORDER.indexOf(a.p.Pos) - POS_ORDER.indexOf(b.p.Pos) || a.sortKey - b.sortKey);
    const byes = rows.filter((r) => !r.g);
    const hot = d3.greatest(rows.filter((r) => r.l3 !== null), (r) => r.l3 - r.per);
    const total = d3.sum(rows, (r) => r.per);
    const tile = (lbl, big, who, team) => h('div', { class: 'nfl-tile', style: team ? { '--tc': teamColor(team) } : null }, h('div', { class: 'lbl' }, lbl), h('div', { class: 'big' }, big), h('div', { class: 'who' }, who));
    const verdictCls = (v) => ({ 'Must start': 'nfl-good', Start: 'nfl-good', 'Flex / borderline': 'nfl-warn', Bench: 'nfl-bad', 'On bye': 'nfl-bad' }[v]);
    const nextTxt = (r) => {
      if (!r.g) return 'BYE';
      const away = r.g.Away === r.p.Team;
      return `${away ? '@' : 'vs'} ${away ? r.g.Home : r.g.Away} · ${r.g.Day.split(' ')[0]} ${r.g.Kickoff}`;
    };
    const tbl = h('div', { class: 'nfl-scroll tall' });
    body.replaceChildren(
      h('div', { class: 'nfl-tiles' },
        tile('Players on your team', rows.length, `${POS_ORDER.map((ps) => [ps, rows.filter((r) => r.p.Pos === ps).length]).filter(([, n]) => n).map(([ps, n]) => n + ' ' + ps).join(' · ')}`),
        tile(`On bye in Week ${X.next}`, byes.length, byes.length ? byes.map((r) => r.p.Player).join(', ') : 'Nobody'),
        hot ? tile('Hottest player (last 3 vs season)', signed(Math.round((hot.l3 - hot.per) * 10) / 10), plink(hot.p), hot.p.Team) : null,
        tile(`Roster points per game (${state.scoring === 'PPR' ? 'PPR' : 'half'})`, one(total), 'Sum of every player’s season average')),
      h('div', { class: 'nfl-card' }, h('h3', null, `Week ${X.next} start/sit leans`), h('p', { class: 'nfl-note' }, 'Grouped by position, best lean first. The lean starts from his per-game rank at his position and moves with the signals. It’s a guide, not a projection.'), tbl));
    table(tbl, rows.map((r) => ({ ...r, Id: r.p.Id, Player: r.p.Player, Team: r.p.Team, Pos: r.p.Pos, PerGame: Math.round(r.per * 10) / 10, L3: r.l3 === null ? null : Math.round(r.l3 * 10) / 10, Rank: r.rank, Next: nextTxt(r), Verdict: r.verdict, Fat: r.fat ? r.fat.Score : null })), [
      { k: 'Player', h: 'Player', l: true, r: (r) => plink(r) }, C.team, C.pos,
      { k: 'Next', h: `Week ${X.next}`, l: true },
      { k: 'Verdict', h: 'Lean', l: true, cls: (v) => 'nfl-verdict ' + verdictCls(v) },
      { k: 'PerGame', h: 'Per game', f: one }, { k: 'L3', h: 'Last 3', f: one, cls: (v, r) => (v === null ? '' : v >= r.PerGame * 1.2 ? 'nfl-good' : v <= r.PerGame * 0.8 ? 'nfl-bad' : '') },
      { k: 'Rank', h: 'Pos rank', r: (r) => (r.Rank ? r.Pos + r.Rank : '—'), sm: true },
      { k: 'it', h: 'Team total', f: one, sm: true }, { k: 'Fat', h: 'Fatigue', f: signed, sm: true },
      { k: 'tags', h: 'Signals', l: true, s: false, r: (r) => h('span', null, r.tags.length ? r.tags.map(([c, t]) => h('span', { class: 'nfl-tag ' + c }, t)) : h('span', { class: 'nfl-note' }, 'Nothing unusual')), cls: () => 'wrap' },
      { k: 'x', h: '', s: false, r: (r) => h('button', { class: 'nfl-x', title: 'Remove from my team', 'aria-label': 'Remove ' + r.Player, onclick: () => { state.roster = state.roster.filter((id) => id !== r.Id); renderMyTeam(); } }, '×') },
    ], { sortable: false, group: (r) => ({ QB: 'Quarterbacks', RB: 'Running backs', WR: 'Wide receivers', TE: 'Tight ends', K: 'Kickers', DST: 'Defenses' }[r.Pos]) });
  }

  // ---------- PLAYER PAGE ----------
  function renderPlayer() {
    const body = $('player-body');
    const p = X.player[state.playerId];
    if (!p) { body.replaceChildren(h('p', { class: 'nfl-empty' }, 'That player isn’t in this season’s data.')); return; }
    document.title = `${p.Player} · NFL Oddities`;
    const tm = X.team[p.Team] || { Color: '#555555', Color2: '#999999', Name: p.Team };
    const ink = inkOn(tm.Color);
    const weeks = X.weekly.get(p.Id) || [];
    const byWeek = new Map(weeks.map((w) => [w.Week, w]));
    const sc = pts();
    const last3 = weeks.slice(-3);
    const l3 = last3.length ? d3.mean(last3, (w) => w[sc]) : null;
    const per = p[sc] / p.GP;
    const nextG = D.games.find((g) => g.Status === 'Upcoming' && (g.Away === p.Team || g.Home === p.Team));
    const nextTxt = nextG ? (() => {
      const away = nextG.Away === p.Team, opp = away ? nextG.Home : nextG.Away;
      const f = nextG.Week === X.next ? X.fatigueBy.get(p.Team) : null;
      const ln = nextG.Favorite ? (nextG.Favorite === 'Pick' ? 'pick’em' : `${nextG.Favorite} −${nextG.Spread}`) : null;
      return `Next: Week ${nextG.Week} ${away ? '@' : 'vs'} ${opp} · ${nextG.Day}, ${nextG.Kickoff}${ln ? ' · ' + ln : ''}${nextG.Total ? ', O/U ' + nextG.Total : ''}${f ? ' · fatigue ' + signed(f.Score) : ''}`;
    })() : 'No games left on the schedule.';
    const trend = l3 === null ? '' : l3 > per * 1.15 ? '▲ trending up' : l3 < per * 0.85 ? '▼ trending down' : 'steady';
    body.replaceChildren(
      h('div', { class: 'nfl-phead', style: { background: `linear-gradient(120deg, ${tm.Color} 0%, ${tm.Color} 60%, ${tm.Color2} 140%)`, color: ink } },
        h('div', null, h('div', { class: 'name' }, p.Player), h('div', { class: 'sub' }, `${p.Pos === 'DST' ? 'Team defense' : p.Pos} · ${tm.Name} · ${p.GP} games`), h('div', { class: 'next' }, nextTxt)),
        h('div', { class: 'nums' },
          h('div', null, h('div', { class: 'k' }, state.scoring === 'PPR' ? 'PPR points' : 'Half-PPR points'), h('div', { class: 'v' }, one(p[sc]))),
          h('div', null, h('div', { class: 'k' }, 'Per game'), h('div', { class: 'v' }, one(per))),
          h('div', null, h('div', { class: 'k' }, 'Last 3 avg'), h('div', { class: 'v' }, l3 === null ? '—' : one(l3)), h('div', { class: 'k' }, trend)),
          h('div', null, h('div', { class: 'k' }, 'Position rank'), h('div', { class: 'v' }, p.Pos + p['Rank' + sc])))),
      h('div', { class: 'nfl-card', style: { marginBottom: 'var(--cds-gap-md)' } }, h('h3', null, 'Season line'), h('div', { class: 'nfl-statgrid', style: { marginTop: '8px' } }, statTiles(p))),
      h('div', { class: 'nfl-grid wide' },
        h('div', { class: 'nfl-card' }, h('h3', null, 'Fantasy points by week'), h('p', { class: 'nfl-note' }, 'Dashed line is his season average. Hover a bar for that game’s stat line.'), h('div', { class: 'nfl-chart auto', id: 'p-points' })),
        h('div', { class: 'nfl-card' }, h('h3', null, usageTitle(p)), h('p', { class: 'nfl-note' }, usageNote(p)), h('div', { class: 'nfl-chart auto', id: 'p-usage' }))),
      h('div', { class: 'nfl-card' }, h('h3', null, 'Game log'), h('div', { class: 'nfl-scroll', id: 'p-log' })),
    );
    // charts
    const allWeeks = d3.range(1, X.through + 1);
    const rows = allWeeks.map((wk) => {
      const g = X.gameOf.get(p.Team + '|' + wk);
      const w = byWeek.get(wk);
      const opp = g ? (g.Away === p.Team ? '@' + g.Home : g.Home) : 'BYE';
      return { wk, opp, w, bye: !g, val: w ? w[sc] : null, g };
    });
    barChart($('p-points'), rows, (r) => r.val, { color: tm.Color, avg: per, label: (r) => one(r.val), tipLines: (r) => tipLines(p, r) });
    const series = usageSeries(p);
    stackChart($('p-usage'), rows, series, { colors: [tm.Color, tm.Color2 && tm.Color2 !== '#000000' ? tm.Color2 : '#9a978e'] });
    // log
    const logRows = rows.filter((r) => r.w).map((r) => ({ ...r.w, Opp: r.opp, Result: result(p.Team, r.g) })).reverse();
    table($('p-log'), logRows, logCols(p), { sortable: false });
  }
  function result(team, g) {
    if (!g || g.Status !== 'Final') return '—';
    const mine = g.Away === team ? g.AwayScore : g.HomeScore, theirs = g.Away === team ? g.HomeScore : g.AwayScore;
    return `${mine > theirs ? 'W' : mine < theirs ? 'L' : 'T'} ${mine}-${theirs}`;
  }
  function statTiles(p) {
    const t = (k, v) => h('div', null, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
    if (p.Pos === 'DST') return [t('Pts allowed / game', one(p.PtsAllowedPerGame)), t('Sacks', one(p.DefSacks)), t('Interceptions', p.DefInt), t('Fumble recoveries', p.FumRec), t('Touchdowns', p.DefTD)];
    if (p.Pos === 'K') return [t('Field goals', `${p.FGM}/${p.FGA}`), t('FG %', p.FGA ? Math.round((p.FGM / p.FGA) * 100) + '%' : '—'), t('Extra points', `${p.XPM}/${p.XPA}`)];
    const out = [];
    if (p.Att) out.push(t('Pass yards', fmtN(p.PassYds)), t('Pass TD / INT', `${p.PassTD} / ${p.Int}`), t('Completion %', show(p.CmpPct, one)), t('Yards / attempt', show(p.YPA, one)), t('Sacked', p.Sacks));
    if (p.Carries) out.push(t('Carries', p.Carries), t('Rush yards', fmtN(p.RushYds)), t('Yards / carry', show(p.YPC, one)), t('Rush TD', p.RushTD));
    if (p.Targets) out.push(t('Targets', p.Targets), t('Catches', p.Rec), t('Rec yards', fmtN(p.RecYds)), t('Rec TD', p.RecTD), t('Target share', one(p.TgtShare) + '%'));
    if (p.FumLost) out.push(t('Fumbles lost', p.FumLost));
    return out;
  }
  function usageTitle(p) {
    return { QB: 'Dropbacks and runs by week', K: 'Kicks by week', DST: 'Points allowed by week' }[p.Pos] || 'Touches by week';
  }
  function usageNote(p) {
    return { QB: 'Pass attempts plus designed runs and scrambles.', K: 'Field-goal attempts and extra-point attempts.', DST: 'Points the defense gave up each week; lower is better for fantasy.' }[p.Pos]
      || 'Targets and carries. Volume is the stickiest fantasy stat, so a rising bar often comes before the points do.';
  }
  function usageSeries(p) {
    if (p.Pos === 'QB') return [{ name: 'Pass att', v: (w) => w.Att || 0 }, { name: 'Carries', v: (w) => w.Carries || 0 }];
    if (p.Pos === 'K') return [{ name: 'FG att', v: (w) => w.FGA || 0 }, { name: 'XP att', v: (w) => w.XPA || 0 }];
    if (p.Pos === 'DST') return [{ name: 'Pts allowed', v: (w) => w.PtsAllowed || 0 }];
    return [{ name: 'Targets', v: (w) => w.Targets || 0 }, { name: 'Carries', v: (w) => w.Carries || 0 }];
  }
  function tipLines(p, r) {
    if (!r.w) return [r.bye ? 'Bye week' : 'Did not play'];
    const w = r.w, out = [`${one(w[pts()])} pts · ${result(p.Team, r.g)}`];
    if (p.Pos === 'DST') out.push(`${w.PtsAllowed} allowed · ${w.DefSacks || 0} sacks · ${(w.DefInt || 0) + (w.FumRec || 0)} takeaways`);
    else if (p.Pos === 'K') out.push(`FG ${w.FGM || 0}/${w.FGA || 0} · XP ${w.XPM || 0}/${w.XPA || 0}`);
    else {
      if (w.Att) out.push(`${w.Cmp || 0}/${w.Att} · ${w.PassYds || 0} yds · ${w.PassTD || 0} TD · ${w.Int || 0} INT`);
      if (w.Carries) out.push(`${w.Carries} car · ${w.RushYds || 0} yds · ${w.RushTD || 0} TD`);
      if (w.Targets) out.push(`${w.Rec || 0}/${w.Targets} · ${w.RecYds || 0} yds · ${w.RecTD || 0} TD`);
    }
    return out;
  }
  function logCols(p) {
    const base = [{ k: 'Week', h: 'Wk', l: true }, { k: 'Opp', h: 'Opp', l: true }, { k: 'Result', h: 'Result', l: true }];
    const z = (k, hd, sm) => ({ k, h: hd, r: (w) => show(w[k] || 0), sm });
    const ptsCol = { k: pts(), h: 'Pts', f: one, cls: () => 'nfl-strong' };
    if (p.Pos === 'DST') return base.concat([z('PtsAllowed', 'Allowed'), z('DefSacks', 'Sacks'), z('DefInt', 'INT'), z('FumRec', 'FR'), z('DefTD', 'TD'), ptsCol]);
    if (p.Pos === 'K') return base.concat([z('FGM', 'FGM'), z('FGA', 'FGA'), z('XPM', 'XPM'), z('XPA', 'XPA'), ptsCol]);
    if (p.Pos === 'QB') return base.concat([{ k: 'Att', h: 'C/A', r: (w) => `${w.Cmp || 0}/${w.Att || 0}` }, z('PassYds', 'Yds'), z('PassTD', 'TD'), z('Int', 'INT'), z('Carries', 'Car', true), z('RushYds', 'Rush yds', true), z('RushTD', 'Rush TD', true), ptsCol]);
    if (p.Pos === 'RB') return base.concat([z('Carries', 'Car'), z('RushYds', 'Rush yds'), z('RushTD', 'TD'), z('Targets', 'Tgt', true), z('Rec', 'Rec'), z('RecYds', 'Rec yds'), z('RecTD', 'Rec TD', true), ptsCol]);
    return base.concat([z('Targets', 'Tgt'), z('Rec', 'Rec'), z('RecYds', 'Yds'), z('RecTD', 'TD'), { k: 'TgtShare', h: 'Tgt %', r: (w) => show(w.TgtShare, one), sm: true }, z('Carries', 'Car', true), z('RushYds', 'Rush yds', true), ptsCol]);
  }

  // ---------- charts ----------
  function weekAxis(g, rows, x, y0) {
    rows.forEach((r) => {
      const cx = x(r.wk) + x.bandwidth() / 2;
      g.append('text').attr('x', cx).attr('y', y0 + 14).attr('text-anchor', 'middle').attr('fill', 'var(--color-fg-muted)').text('W' + r.wk);
      g.append('text').attr('x', cx).attr('y', y0 + 27).attr('text-anchor', 'middle').attr('fill', r.bye ? 'var(--cds-chart-muted)' : 'var(--color-fg)').style('font-size', '10.5px').text(r.opp);
    });
  }
  function barChart(el, rows, val, o) {
    el.replaceChildren();
    const W = el.clientWidth || 600, H = 220, m = { t: 18, r: 8, b: 34, l: 30 };
    const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).style('display', 'block');
    const x = d3.scaleBand(rows.map((r) => r.wk), [m.l, W - m.r]).padding(0.25);
    const hi = Math.max(5, d3.max(rows, (r) => val(r) || 0));
    const lo = Math.min(0, d3.min(rows, (r) => val(r) || 0));
    const y = d3.scaleLinear([lo, hi], [H - m.b, m.t]).nice();
    const g = svg.append('g').style('font-size', 'var(--cds-font-size-caption)');
    y.ticks(4).forEach((v) => { g.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(v)).attr('y2', y(v)).attr('stroke', 'var(--cds-chart-grid)'); g.append('text').attr('x', m.l - 6).attr('y', y(v)).attr('dy', '0.32em').attr('text-anchor', 'end').attr('fill', 'var(--color-fg-muted)').text(v); });
    const tp = tip(el);
    rows.forEach((r) => {
      const v = val(r);
      if (v === null) return;
      const top = y(Math.max(0, v)), bot = y(Math.min(0, v));
      g.append('rect').attr('x', x(r.wk)).attr('width', x.bandwidth()).attr('y', top).attr('height', Math.max(1, bot - top)).attr('rx', 3).attr('fill', o.color)
        .on('pointermove', (ev) => tp.show(ev, `Week ${r.wk} · ${r.opp}`, o.tipLines(r))).on('pointerleave', () => tp.hide());
      if (x.bandwidth() > 18) g.append('text').attr('x', x(r.wk) + x.bandwidth() / 2).attr('y', top - 4).attr('text-anchor', 'middle').attr('fill', 'var(--color-fg-muted)').style('font-size', '10.5px').text(o.label(r));
    });
    if (o.avg !== undefined) g.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(o.avg)).attr('y2', y(o.avg)).attr('stroke', 'var(--cds-chart-reference)').attr('stroke-dasharray', '4 4');
    weekAxis(g, rows, x, H - m.b);
  }
  function stackChart(el, rows, series, o) {
    el.replaceChildren();
    const W = el.clientWidth || 600, H = 220, m = { t: 26, r: 8, b: 34, l: 30 };
    const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).style('display', 'block');
    const x = d3.scaleBand(rows.map((r) => r.wk), [m.l, W - m.r]).padding(0.25);
    const tot = (r) => (r.w ? d3.sum(series, (s) => s.v(r.w)) : 0);
    const y = d3.scaleLinear([0, Math.max(4, d3.max(rows, tot))], [H - m.b, m.t]).nice();
    const g = svg.append('g').style('font-size', 'var(--cds-font-size-caption)');
    y.ticks(4).forEach((v) => { g.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(v)).attr('y2', y(v)).attr('stroke', 'var(--cds-chart-grid)'); g.append('text').attr('x', m.l - 6).attr('y', y(v)).attr('dy', '0.32em').attr('text-anchor', 'end').attr('fill', 'var(--color-fg-muted)').text(v); });
    const tp = tip(el);
    rows.forEach((r) => {
      if (!r.w) return;
      let base = 0;
      series.forEach((s, i) => {
        const v = s.v(r.w);
        if (!v) return;
        g.append('rect').attr('x', x(r.wk)).attr('width', x.bandwidth()).attr('y', y(base + v)).attr('height', y(base) - y(base + v)).attr('fill', o.colors[i]).attr('fill-opacity', i ? 0.55 : 1)
          .on('pointermove', (ev) => tp.show(ev, `Week ${r.wk} · ${r.opp}`, series.map((q) => `${q.name}: ${q.v(r.w)}`))).on('pointerleave', () => tp.hide());
        base += v;
      });
    });
    // legend
    let lx = m.l;
    series.forEach((s, i) => {
      g.append('rect').attr('x', lx).attr('y', 4).attr('width', 10).attr('height', 10).attr('rx', 2).attr('fill', o.colors[i]).attr('fill-opacity', i ? 0.55 : 1);
      const t = g.append('text').attr('x', lx + 14).attr('y', 9).attr('dy', '0.32em').attr('fill', 'var(--color-fg-muted)').text(s.name);
      lx += 14 + t.node().getComputedTextLength() + 14;
    });
    weekAxis(g, rows, x, H - m.b);
  }

  // ---------- COURAGE ----------
  function renderCourage() {
    const el = $('courage-chart');
    el.replaceChildren();
    const pts = X.courage.filter((d) => d.AttPerGame !== null);
    const W = el.clientWidth || 600, H = 340, m = { t: 12, r: 18, b: 40, l: 44 };
    const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).style('display', 'block').style('overflow', 'visible');
    const x = d3.scaleLinear(d3.extent(pts, (d) => d.AttPerGame), [m.l, W - m.r]).nice();
    const y = d3.scaleLinear([0, 100], [H - m.b, m.t]);
    const g = svg.append('g').style('font-size', 'var(--cds-font-size-caption)');
    y.ticks(5).forEach((v) => { g.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(v)).attr('y2', y(v)).attr('stroke', 'var(--cds-chart-grid)'); g.append('text').attr('x', m.l - 6).attr('y', y(v)).attr('dy', '0.32em').attr('text-anchor', 'end').attr('fill', 'var(--color-fg-muted)').text(v + '%'); });
    x.ticks(Math.max(3, Math.floor(W / 90))).forEach((v) => g.append('text').attr('x', x(v)).attr('y', H - m.b + 16).attr('text-anchor', 'middle').attr('fill', 'var(--color-fg-muted)').text(v.toFixed(1)));
    g.append('text').attr('x', (m.l + W - m.r) / 2).attr('y', H - 4).attr('text-anchor', 'middle').attr('fill', 'var(--color-fg-muted)').text('Fourth-down attempts per game');
    const { avgA, avgP } = X.courageAvg;
    g.append('line').attr('x1', x(avgA)).attr('x2', x(avgA)).attr('y1', m.t).attr('y2', H - m.b).attr('stroke', 'var(--cds-chart-reference)').attr('stroke-dasharray', '4 4');
    g.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(avgP)).attr('y2', y(avgP)).attr('stroke', 'var(--cds-chart-reference)').attr('stroke-dasharray', '4 4');
    const tp = tip(el);
    const nodes = g.selectAll('g.pt').data(pts).join('g').attr('transform', (d) => `translate(${x(d.AttPerGame)},${y(d.ConvPct)})`);
    nodes.append('circle').attr('r', 7).attr('fill', (d) => teamColor(d.Team)).attr('stroke', 'var(--color-panel)').attr('stroke-width', 1.5);
    nodes.append('text').attr('x', 10).attr('dy', '0.32em').attr('fill', 'var(--color-fg)').text((d) => d.Team);
    nodes.on('pointermove', (ev, d) => tp.show(ev, d.Name, [`${d.AttPerGame} tries per game · ${d.ConvPct}% converted`, `${d.Record} · ${d.Style}`])).on('pointerleave', () => tp.hide());
    const sty = (v) => (v === 'Bold and it works' ? 'nfl-good' : v === 'Bold, not paying off' ? 'nfl-bad' : '');
    table($('courage-table'), X.courage, [C.team, { k: 'Attempts', h: 'Att' }, { k: 'Conversions', h: 'Conv' }, { k: 'AttPerGame', h: 'Per game' }, { k: 'ConvPct', h: 'Conv %' }, { k: 'Record', h: 'Record', s: false }, { k: 'Style', h: 'Profile', l: true, cls: sty }], { sort: 'AttPerGame' });
  }

  // ---------- TRAVEL ----------
  function renderTravel() {
    $('fatigue-title').textContent = `Fatigue score, Week ${X.next}`;
    // fatigue bars
    const el = $('fatigue-chart');
    el.replaceChildren();
    const r = X.fatigue;
    const W = el.clientWidth || 600, bh = 17, gap = 5, m = { t: 4, r: 28, b: 4, l: 48 };
    const H = m.t + m.b + r.length * (bh + gap);
    const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).style('display', 'block');
    const x = d3.scaleLinear([Math.min(0, d3.min(r, (d) => d.Score)), Math.max(1, d3.max(r, (d) => d.Score))], [m.l, W - m.r]);
    const g = svg.append('g').style('font-size', 'var(--cds-font-size-caption)');
    g.append('line').attr('x1', x(0)).attr('x2', x(0)).attr('y1', m.t).attr('y2', H - m.b).attr('stroke', 'var(--cds-chart-axis)');
    const tp = tip(el);
    const row = g.selectAll('g.r').data(r).join('g').attr('transform', (d, i) => `translate(0,${m.t + i * (bh + gap)})`);
    row.append('text').attr('x', m.l - 8).attr('y', bh / 2).attr('dy', '0.32em').attr('text-anchor', 'end').attr('fill', 'var(--color-fg)').text((d) => d.Team);
    row.append('rect').attr('x', (d) => x(Math.min(0, d.Score))).attr('width', (d) => Math.max(2, Math.abs(x(d.Score) - x(0)))).attr('height', bh).attr('rx', 3).attr('fill', (d) => teamColor(d.Team));
    row.append('text').attr('x', (d) => (d.Score >= 0 ? x(d.Score) + 6 : x(0) + 6)).attr('y', bh / 2).attr('dy', '0.32em').attr('fill', 'var(--color-fg-muted)').text((d) => d.Score);
    row.on('pointermove', (ev, d) => tp.show(ev, `${d.Team} ${d.Where}`, [d.Flags, `${d.RestDays ?? '—'} days rest · ${fmtN(d.Miles)} miles`])).on('pointerleave', () => tp.hide());
    table($('fatigue-games'), X.fatigueGames, [
      { k: 'Away', h: 'Away', l: true, r: (d) => chip(d.Away) }, { k: 'Home', h: 'Home', l: true, r: (d) => chip(d.Home) }, { k: 'Kickoff', h: 'When', l: true },
      { k: 'AwayScore', h: 'Away score' }, { k: 'HomeScore', h: 'Home score' },
      { k: 'Diff', h: 'Edge', l: true, r: (d) => (d.Edge ? h('span', { class: 'nfl-good' }, `${d.Edge} by ${d.Diff}`) : 'Even') },
    ], { sortable: false });
    table($('fatigue-table'), X.fatigue, [C.team, { k: 'Where', h: 'Game', l: true }, { k: 'Day', h: 'Day', l: true }, { k: 'RestDays', h: 'Rest days' }, { k: 'Miles', h: 'Miles', f: fmtN }, { k: 'TimeZones', h: 'Zones', f: signed }, { k: 'BodyClock', h: 'Body clock' },
      { k: 'Score', h: 'Score', cls: (v) => (v >= 4 ? 'nfl-bad' : v < 0 ? 'nfl-good' : '') }, { k: 'Flags', h: 'Flags', l: true }], { sort: 'Score' });
    // season miles
    const tv = $('travel-chart');
    tv.replaceChildren();
    const rows = X.travel;
    const W2 = tv.clientWidth || 600, bh2 = 14, gap2 = 4, m2 = { t: 4, r: 64, b: 4, l: 48 };
    const H2 = m2.t + m2.b + rows.length * (bh2 + gap2);
    const s2 = d3.select(tv).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W2} ${H2}`).style('display', 'block');
    const x2 = d3.scaleLinear([0, d3.max(rows, (d) => d.Total)], [m2.l, W2 - m2.r]);
    const g2 = s2.append('g').style('font-size', 'var(--cds-font-size-caption)');
    const tp2 = tip(tv);
    const rr = g2.selectAll('g.r').data(rows).join('g').attr('transform', (d, i) => `translate(0,${m2.t + i * (bh2 + gap2)})`);
    rr.append('text').attr('x', m2.l - 8).attr('y', bh2 / 2).attr('dy', '0.32em').attr('text-anchor', 'end').attr('fill', 'var(--color-fg)').text((d) => d.Team);
    rr.append('rect').attr('x', m2.l).attr('width', (d) => x2(d.Done) - m2.l).attr('height', bh2).attr('rx', 2).attr('fill', (d) => teamColor(d.Team));
    rr.append('rect').attr('x', (d) => x2(d.Done)).attr('width', (d) => x2(d.Total) - x2(d.Done)).attr('height', bh2).attr('rx', 2).attr('fill', (d) => teamColor(d.Team)).attr('fill-opacity', 0.3);
    rr.append('text').attr('x', (d) => x2(d.Total) + 6).attr('y', bh2 / 2).attr('dy', '0.32em').attr('fill', 'var(--color-fg-muted)').text((d) => fmtN(d.Total));
    rr.on('pointermove', (ev, d) => tp2.show(ev, X.team[d.Team].Name, [`${fmtN(d.Done)} miles so far`, `${fmtN(d.Left)} still to come`, `${d.Trips} road trips`])).on('pointerleave', () => tp2.hide());
  }

  // ---------- REFS ----------
  function renderRefs() {
    const el = $('ref-chart');
    el.replaceChildren();
    const r = X.crews;
    const W = el.clientWidth || 600, rh = 22, m = { t: 22, r: 30, b: 8 };
    const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${m.t + m.b + r.length * rh}`).style('display', 'block');
    const lw = d3.max(r, (d) => textW(svg, d.Referee)) + 10;
    const x = d3.scaleLinear([Math.floor(d3.min(r, (d) => Math.min(d.PenPerGame, d.PenPerGame2025))) - 0.5, Math.ceil(d3.max(r, (d) => Math.max(d.PenPerGame, d.PenPerGame2025))) + 0.5], [lw, W - m.r]);
    const g = svg.append('g').style('font-size', 'var(--cds-font-size-caption)');
    x.ticks(Math.max(3, Math.floor((W - lw) / 70))).forEach((v) => { g.append('line').attr('x1', x(v)).attr('x2', x(v)).attr('y1', m.t - 4).attr('y2', m.t + r.length * rh).attr('stroke', 'var(--cds-chart-grid)'); g.append('text').attr('x', x(v)).attr('y', 12).attr('text-anchor', 'middle').attr('fill', 'var(--color-fg-muted)').text(v); });
    const tp = tip(el);
    const row = g.selectAll('g.r').data(r).join('g').attr('transform', (d, i) => `translate(0,${m.t + i * rh + rh / 2})`);
    row.append('text').attr('x', lw - 10).attr('dy', '0.32em').attr('text-anchor', 'end').attr('fill', 'var(--color-fg)').text((d) => d.Referee);
    row.append('line').attr('x1', (d) => x(d.PenPerGame2025)).attr('x2', (d) => x(d.PenPerGame)).attr('stroke', 'var(--cds-chart-muted)').attr('stroke-width', 2);
    row.append('circle').attr('cx', (d) => x(d.PenPerGame2025)).attr('r', 4.5).attr('fill', 'var(--cds-chart-muted)');
    row.append('circle').attr('cx', (d) => x(d.PenPerGame)).attr('r', 5.5).attr('fill', (d) => (d.Change >= 3 ? 'var(--cds-chart-status-critical)' : COLORS[1]));
    row.on('pointermove', (ev, d) => tp.show(ev, d.Referee, `${d.PenPerGame2025} in 2025 → ${d.PenPerGame} in 2026 (${signed(d.Change)})`)).on('pointerleave', () => tp.hide());
    table($('ref-table'), X.crews, [{ k: 'Referee', h: 'Referee', l: true }, { k: 'Games', h: 'Games' }, { k: 'PenPerGame', h: 'Per game' }, { k: 'PenPerGame2025', h: '2025' },
      { k: 'Change', h: 'Change', f: signed, cls: (v) => (v >= 3 ? 'nfl-bad' : v < 0 ? 'nfl-good' : '') }, { k: 'YdsPerGame', h: 'Yds/g' }, { k: 'HomeLean', h: 'Home lean', f: signed }], { sort: 'PenPerGame' });
    table($('ref-notes'), D.referee_notes, [{ k: 'Referee', h: 'Referee', l: true }, { k: 'HomeATS', h: 'Home vs spread', l: true }, { k: 'Tendency', h: 'Tendency', l: true }, { k: 'LastWeekGame', h: 'Last week', l: true }], { sortable: false });
  }

  // ---------- WILD ----------
  function renderWild() {
    const el = $('td-chart');
    el.replaceChildren();
    const pick = [...X.tdLuck.slice(0, 6), ...X.tdLuck.slice(-6)];
    const W = el.clientWidth || 600, rh = 20, m = { t: 6, r: 36, b: 6 };
    const H = m.t + m.b + pick.length * rh;
    const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).style('display', 'block');
    const lw = Math.min(W * 0.4, d3.max(pick, (d) => textW(svg, d.Player)) + 12);
    const ext = d3.max(pick, (d) => Math.abs(d.Gap)) || 1;
    const x = d3.scaleLinear([-ext, ext], [lw, W - m.r]);
    const g = svg.append('g').style('font-size', 'var(--cds-font-size-caption)');
    g.append('line').attr('x1', x(0)).attr('x2', x(0)).attr('y1', 0).attr('y2', H).attr('stroke', 'var(--cds-chart-axis)');
    const tp = tip(el);
    const row = g.selectAll('g.r').data(pick).join('g').attr('transform', (d, i) => `translate(0,${m.t + i * rh})`).style('cursor', 'pointer').on('click', (ev, d) => { location.hash = 'player/' + encodeURIComponent(d.Id); });
    row.append('text').attr('x', lw - 8).attr('y', rh / 2).attr('dy', '0.32em').attr('text-anchor', 'end').attr('fill', 'var(--color-fg)').text((d) => d.Player);
    row.append('rect').attr('x', (d) => x(Math.min(0, d.Gap))).attr('y', 3).attr('height', rh - 6).attr('rx', 3).attr('width', (d) => Math.max(2, Math.abs(x(d.Gap) - x(0)))).attr('fill', (d) => teamColor(d.Team));
    row.append('text').attr('x', (d) => (d.Gap >= 0 ? x(d.Gap) + 4 : x(0) + 4)).attr('y', rh / 2).attr('dy', '0.32em').attr('fill', 'var(--color-fg-muted)').text((d) => signed(d.Gap));
    row.on('pointermove', (ev, d) => tp.show(ev, `${d.Player} · ${d.Kind}`, `${d.TD} TD vs ${d.ExpectedTD} expected on ${d.Touches} touches`)).on('pointerleave', () => tp.hide());
    table($('td-table'), X.tdLuck, [C.player, { k: 'Kind', h: 'Type', l: true }, C.team, { k: 'Touches', h: 'Touches' }, { k: 'TD', h: 'TD' }, { k: 'ExpectedTD', h: 'Expected' },
      { k: 'Gap', h: 'Gap', f: signed, cls: (v) => (v >= 2 ? 'nfl-bad' : v <= -2 ? 'nfl-good' : '') }], { sort: 'Gap' });
    table($('usage-table'), X.usage, [C.player, C.team, C.pos, { k: 'OppPerGame', h: 'Touches/g', f: one }, { k: 'PtsPerTouch', h: 'Pts/touch' }, { k: 'PerGame', h: 'Half-PPR/g', f: one }], { sort: 'PtsPerTouch', dir: 1 });
    table($('sack-table'), X.sacks, [C.player, C.team, { k: 'Dropbacks', h: 'Dropbacks' }, { k: 'Sacks', h: 'Sacks' }, { k: 'SackRate', h: 'Sack %', f: one, cls: (v) => (v >= 9 ? 'nfl-bad' : '') }], { sort: 'SackRate' });
  }

  // ---------- routing ----------
  const PAGES = { home: renderHome, myteam: renderMyTeam, players: renderPlayers, player: renderPlayer, courage: renderCourage, travel: renderTravel, refs: renderRefs, wild: renderWild };
  function route() {
    const hash = decodeURIComponent(location.hash.slice(1));
    if (hash.startsWith('player/')) { state.route = 'player'; state.playerId = hash.slice(7); }
    else if (hash.startsWith('myteam/')) {
      const ids = hash.slice(7).split(',').filter((id) => X.player[id]);
      if (ids.length) { state.roster = [...new Set([...state.roster, ...ids])]; saveRoster(); }
      history.replaceState(null, '', '#myteam');
      state.route = 'myteam';
    }
    else state.route = PAGES[hash] ? hash : 'home';
    if (state.route !== 'player') document.title = 'NFL Oddities';
    document.querySelectorAll('.nfl-page').forEach((p) => { p.hidden = p.id !== state.route; });
    document.querySelectorAll('.nfl-tab').forEach((a) => {
      const on = a.dataset.tab === state.route || (state.route === 'player' && a.dataset.tab === 'players');
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    render();
    if (state.route === 'player') window.scrollTo(0, 0);
  }
  function render() {
    if (!X.team) return;
    renderHeader();
    try { PAGES[state.route](); } catch (e) { console.error(e); }
  }

  function wire() {
    window.addEventListener('hashchange', route);
    let w = window.innerWidth, t;
    window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => { if (window.innerWidth !== w) { w = window.innerWidth; render(); } }, 150); });
    document.querySelectorAll('.nfl-scoring button').forEach((b) => b.addEventListener('click', () => { state.scoring = b.dataset.scoring; save('scoring', state.scoring); render(); }));
    document.querySelectorAll('#cat-seg button').forEach((b) => b.addEventListener('click', () => {
      state.cat = b.dataset.cat;
      const autoPos = { kicking: 'K', defense: 'DST' }[state.cat];
      if (autoPos || ['K', 'DST'].includes(state.pos)) { state.pos = autoPos || ''; $('pos-filter').value = state.pos; }
      render();
    }));
    $('search').addEventListener('input', (e) => { state.q = e.target.value.trim(); render(); });
    $('pos-filter').addEventListener('change', (e) => { state.pos = e.target.value; if (state.pos === 'K') state.cat = 'kicking'; else if (state.pos === 'DST') state.cat = 'defense'; else if (['kicking', 'defense'].includes(state.cat)) state.cat = 'fantasy'; render(); });
    $('team-filter').addEventListener('change', (e) => { state.team = e.target.value; render(); });
    $('my-search').addEventListener('input', (e) => { state.myq = e.target.value.trim(); renderMyTeam(); });
    $('my-clear').addEventListener('click', () => { if (confirm('Remove every player from your team?')) { state.roster = []; renderMyTeam(); } });
    $('my-copy').addEventListener('click', async () => {
      const url = location.href.split('#')[0] + '#myteam/' + state.roster.join(',');
      let ok = false;
      try { await navigator.clipboard.writeText(url); ok = true; } catch (e) { /* fall back below */ }
      $('my-msg').textContent = ok ? 'Link copied. Open it on another device to load this roster.' : url;
    });
    const tf = $('team-filter');
    D.teams.forEach((t) => tf.append(h('option', { value: t.Team }, `${t.Team} · ${t.Name}`)));
  }

  Promise.all(FILES.map((f) => fetch(`data/${f}.json`, { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error(f + ': ' + r.status); return r.json(); }).then((j) => { D[f] = j; })))
    .then(() => { derive(); wire(); route(); })
    .catch((e) => { console.error(e); $('asof').textContent = 'Couldn’t load the data. Try refreshing.'; });
})();
