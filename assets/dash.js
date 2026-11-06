// A small stand-in for the Claude dashboard runtime, so the page runs as a plain static site.
// It loads every dataset from data/<id>.json, runs the page's calculations, and redraws on change.
(function () {
  const DATASETS = ['passing', 'rushing', 'receiving', 'standings', 'games', 'fourth_downs', 'referees', 'referee_notes', 'stadiums'];
  const store = new Map(); // id -> {status, data, columns}
  const calcs = new Map(); // id -> {inputs, fn}
  const draws = new Map(); // name -> fn
  const onDataFns = [];
  let loaded = false;

  const result = (id) => store.get(id) || { status: loaded ? 'missing' : 'loading', data: [], columns: [], meta: [] };

  function runCalcs() {
    const done = new Set(DATASETS.filter((d) => store.has(d)));
    let progress = true;
    while (progress) {
      progress = false;
      for (const [id, c] of calcs) {
        if (done.has(id)) continue;
        if (!c.inputs.every((i) => done.has(i))) continue;
        const inputs = c.inputs.map((i) => store.get(i));
        if (inputs.some((r) => r.status !== 'ok')) { store.set(id, { status: 'error', data: [], columns: [], meta: [] }); }
        else {
          try {
            const out = c.fn(...inputs.map((r) => r.data));
            const rows = Array.isArray(out) ? out : [out];
            store.set(id, { status: 'ok', data: rows, columns: rows[0] ? Object.keys(rows[0]) : [], meta: [] });
          } catch (e) {
            console.error('calc failed', id, e);
            store.set(id, { status: 'error', data: [], columns: [], meta: [], message: String(e) });
          }
        }
        done.add(id);
        progress = true;
      }
    }
  }

  function runDraw(name) {
    const fn = draws.get(name);
    if (!fn) return;
    document.querySelectorAll(`[data-draw="${CSS.escape(name)}"]`).forEach((el) => {
      if (el.closest('[hidden]')) return;
      try { fn(el); } catch (e) { console.error('draw failed', name, e); }
    });
  }
  function redrawAll() {
    onDataFns.forEach((f) => { try { f(); } catch (e) { console.error(e); } });
    draws.forEach((_, name) => runDraw(name));
  }

  window.dash = {
    colors: ['#c96442', '#3f7cac', '#6a9a4f', '#a3639e', '#d39a2c', '#4a9a96', '#8a6d5a', '#7a7fc0'],
    data: result,
    calc(id, spec) { calcs.set(id, { inputs: spec.inputs, fn: spec.fn }); },
    loader() {},
    draw(name, fn) {
      if (typeof fn === 'function') draws.set(name, fn);
      runDraw(name);
    },
    onData(fn) { onDataFns.push(fn); try { fn(); } catch (e) { console.error(e); } },
    params() { return {}; },
    setParams() {},
    resetParams() {},
    refresh() { load(); },
    setLink(name) { try { history.replaceState(null, '', '#' + name); } catch (e) { /* ignore */ } },
  };

  async function load() {
    await Promise.all(DATASETS.map(async (id) => {
      try {
        const res = await fetch(`data/${id}.json`, { cache: 'no-cache' });
        if (!res.ok) throw new Error(res.status);
        const rows = await res.json();
        store.set(id, { status: 'ok', data: rows, columns: rows[0] ? Object.keys(rows[0]) : [], meta: [] });
      } catch (e) {
        store.set(id, { status: 'error', data: [], columns: [], meta: [], message: String(e) });
      }
    }));
    for (const id of calcs.keys()) store.delete(id);
    loaded = true;
    runCalcs();
    redrawAll();
  }

  // Redraw when a tab or card is shown (its hidden attribute removed) and when the width changes.
  document.addEventListener('DOMContentLoaded', () => {
    new MutationObserver((muts) => {
      if (muts.some((m) => m.attributeName === 'hidden' && !m.target.hidden)) redrawAll();
    }).observe(document.getElementById('dash-root'), { attributes: true, subtree: true, attributeFilter: ['hidden'] });
    let w = window.innerWidth, t;
    window.addEventListener('resize', () => {
      clearTimeout(t);
      t = setTimeout(() => { if (window.innerWidth !== w) { w = window.innerWidth; redrawAll(); } }, 150);
    });
    load();
  });
})();
