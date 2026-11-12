// Models screen: capability tags, strength score, your rating, favorites, measured speed, sorting & filters.
import { state, emit, on, visibleModels, visibleOf } from '../core/state.js';
import { loadServers, serverLabel, adoptActive } from './servers.js';
import { $, h, toast } from '../util/dom.js';
import { fmt, tps } from '../util/misc.js';
import { listModels, showModel } from '../core/ollama.js';
import { strength, paramBillions } from '../core/strength.js';
import { show, current } from './views.js';
import { enterWorkspace, updateTop } from './workspace.js';
import { persistConn, showConnect } from './connect.js';
import { remoteTarget, loadRemoteModels } from './remote.js';

const CAP_COLORS = { completion: '#8b98a8', vision: '#b794f6', tools: '#4ade80', thinking: '#fbbf24', audio: '#f472b6', embedding: '#2dd4bf', insert: '#8b98a8' };
const COUNTERS = ['runs', 'requests', 'evalTokens', 'evalNs', 'promptTokens', 'toolCalls', 'toolErrors', 'fails'];
const view = { q: '', server: '', filters: new Set(), sort: localStorage.getItem('oc2.msort') || 'smart' };

/** srv = one entry of state.servers (merged view); without it: the connected server. */
const metaOf = srv => (srv ? srv.meta : state.modelMeta);
export const meta = (name, srv) => metaOf(srv)[name] || {};
export const capTag = (c, mini) => h('span', { class: 'tag' + (mini ? ' mini' : ''), style: `color:${CAP_COLORS[c] || '#8b98a8'}` }, c);
export const modelStrength = (name, srv) => strength((srv ? srv.models : state.models).find(m => m.name === name), meta(name, srv));

/** Merged view: every saved server's models, each tagged with its server (_srv). */
export const isMerged = () => state.servers.length > 1;
export function pickerItems() {
  if (!isMerged()) return visibleModels();
  const out = [];
  for (const srv of state.servers) if (srv.status === 'ok') for (const m of visibleOf(srv.models)) out.push({ ...m, _srv: srv });
  return out;
}

export function initModels() {
  $('#m-q').addEventListener('input', e => { view.q = e.target.value; paintModels(); });
  $('#m-sort').value = view.sort;
  $('#m-sort').addEventListener('change', e => { view.sort = e.target.value; try { localStorage.setItem('oc2.msort', view.sort); } catch { /* ignore */ } paintModels(); });
  $('#m-refresh').addEventListener('click', async () => {
    try {
      if (state.conn) { await loadModels(); adoptActive(); }
      await loadServers({ force: true });
      paintModels();
      toast('Models refreshed');
    } catch (e) { toast(e.message); }
  });
  $('#m-back').addEventListener('click', () => enterWorkspace());
  $('#m-servers').addEventListener('click', showConnect);
  on('model-meta', () => { if (current() === 'models') paintModels(); });
  on('settings', paintModels);
  on('servers', paintModels);
}

export async function loadModels() {
  if (remoteTarget()) return loadRemoteModels(state.conn); // the phone cannot reach the PC's localhost: use the PC's list
  const { models, running } = await listModels(state.conn);
  state.running = running;
  state.models = models.map(m => ({ ...m, name: m.name || m.model, caps: Array.isArray(m.capabilities) ? m.capabilities : null }));
  detectCapabilities();
}

/** Older servers don't list capabilities in /api/tags; ask /api/show for each model. */
async function detectCapabilities() {
  const todo = state.models.filter(m => !m.caps);
  if (!todo.length) return;
  let i = 0, lastPaint = 0;
  const worker = async () => {
    while (i < todo.length) {
      const m = todo[i++];
      try {
        const j = await showModel(m.name);
        m.caps = j.capabilities || [];
        if (!m.details?.context_length && j.model_info) {
          const k = Object.keys(j.model_info).find(x => x.endsWith('.context_length'));
          if (k) m.details = { ...(m.details || {}), context_length: j.model_info[k] };
        }
      } catch { m.caps = []; }
      if (Date.now() - lastPaint > 300) { lastPaint = Date.now(); paintModels(); }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  paintModels();
  emit('models');
}

export function showModels() {
  show('models');
  const c = state.conn;
  $('#m-srv').textContent = isMerged() ? `${state.servers.length} servers` + (c ? ` · connected: ${serverLabel(c)}` : '') : c ? (c.label ? `${c.label} · ${c.url}` : c.url) : '';
  $('#m-back').hidden = !state.model;
  paintModels();
  loadServers();
}

export function setModelMeta(name, patch, srv = null) {
  const conn = srv ? srv.conn : state.conn;
  const store = metaOf(srv);
  store[name] = { url: conn.url, model: name, ...(store[name] || {}), ...patch };
  state.store.updateModelMeta(conn.url, name, patch).catch(e => toast('Could not save: ' + e.message));
  emit('model-meta', name);
}

export function recordModelStats(name, inc, conn = state.conn) {
  if (!conn) return;
  const same = conn.url === state.conn?.url;
  const store = same ? state.modelMeta : state.servers.find(x => x.conn.id === conn.id || x.conn.url === conn.url)?.meta;
  const m = store ? (store[name] ||= { url: conn.url, model: name }) : { url: conn.url, model: name };
  const counters = {};
  for (const k of COUNTERS) if (inc[k]) { counters[k] = inc[k]; m[k] = (m[k] || 0) + inc[k]; }
  m.lastUsed = Date.now();
  const patch = { lastUsed: m.lastUsed };
  if (inc.lastFail) { patch.lastFail = inc.lastFail; m.lastFail = inc.lastFail; }
  state.store.updateModelMeta(conn.url, name, patch, counters).catch(e => console.warn('stats not saved', e));
  emit('model-meta', name);
}

export function starsEl(name, { readonly = false, srv = null } = {}) {
  const r = meta(name, srv).rating || 0;
  const el = h('span', { class: 'stars' + (readonly ? ' ro' : ''), title: r ? `Your rating: ${r}/5` : readonly ? 'Not rated' : 'Rate this model' });
  for (let i = 1; i <= 5; i++) {
    el.append(h(readonly ? 'span' : 'button', {
      class: 'star' + (i <= r ? ' on' : ''), type: readonly ? null : 'button',
      onclick: readonly ? null : e => { e.stopPropagation(); setModelMeta(name, { rating: i === r ? 0 : i }, srv); },
    }, '★'));
  }
  return el;
}

export function favEl(name, srv = null) {
  const f = !!meta(name, srv).fav;
  return h('button', {
    class: 'fav' + (f ? ' on' : ''), type: 'button', title: f ? 'Remove from favorites' : 'Add to favorites',
    onclick: e => { e.stopPropagation(); setModelMeta(name, { fav: !f }, srv); },
  }, f ? '♥' : '♡');
}

const TIER_COLOR = { S: '#c084fc', A: '#4ade80', B: '#6cb6ff', C: '#fbbf24', D: '#94a3b8' };
export function strengthEl(name, { bar = true, srv = null } = {}) {
  const s = modelStrength(name, srv);
  const tip = `Estimated strength for agentic coding: ${s.score}/100 (tier ${s.tier})\n` +
    s.parts.map(([label, pts]) => `${pts >= 0 ? '+' : ''}${pts.toFixed(0)}  ${label}`).join('\n');
  return h('span', { class: 'strength', title: tip },
    h('b', { class: 'tier-' + s.tier }, s.tier),
    bar ? h('span', { class: 'sbar' }, h('i', { style: { width: s.score + '%', background: TIER_COLOR[s.tier] } })) : null,
    h('span', { class: 'dim' }, String(s.score)));
}

/** "7/10": failed (red) of all model requests (white). Shown only once there is something to count. */
export function reliabilityEl(name, srv = null) {
  const m = meta(name, srv);
  const fails = m.fails || 0, total = (m.requests || 0) + fails;
  if (!total) return null;
  const tip = `${fails} of ${total} model requests failed (connection cut / EOF, out of memory, stalls, server errors).` +
    (m.lastFail ? `\nLast error: ${m.lastFail}` : '') + '\nLower is better.';
  return h('span', { class: 'failrate' + (fails ? ' bad' : ''), title: tip }, h('b', { class: 'f' }, String(fails)), '/', h('span', { class: 't' }, String(total)));
}

export function statsText(name, short = false, srv = null) {
  const m = meta(name, srv), parts = [];
  const speed = tps(m);
  if (speed) parts.push(speed.toFixed(1) + ' tok/s');
  if (m.runs) parts.push(`${m.runs} run${m.runs > 1 ? 's' : ''}`);
  if (m.toolCalls) parts.push(`${Math.round(100 * (1 - (m.toolErrors || 0) / m.toolCalls))}% tool success`);
  if (!short && m.lastUsed) parts.push('used ' + fmt.ago(m.lastUsed));
  return parts.join(' · ');
}

const SORTS = {
  smart: (a, b) => (+!!meta(b.name, b._srv).fav - +!!meta(a.name, a._srv).fav) || ((meta(b.name, b._srv).rating || 0) - (meta(a.name, a._srv).rating || 0)) ||
    (modelStrength(b.name, b._srv).score - modelStrength(a.name, a._srv).score),
  strength: (a, b) => modelStrength(b.name, b._srv).score - modelStrength(a.name, a._srv).score,
  speed: (a, b) => (tps(meta(b.name, b._srv)) - tps(meta(a.name, a._srv))) || (paramBillions(a) - paramBillions(b)),
  rating: (a, b) => ((meta(b.name, b._srv).rating || 0) - (meta(a.name, a._srv).rating || 0)) || (modelStrength(b.name, b._srv).score - modelStrength(a.name, a._srv).score),
  recent: (a, b) => (meta(b.name, b._srv).lastUsed || 0) - (meta(a.name, a._srv).lastUsed || 0),
  newest: (a, b) => new Date(b.modified_at || 0) - new Date(a.modified_at || 0),
  name: (a, b) => a.name.localeCompare(b.name),
  size: (a, b) => (a.size || 0) - (b.size || 0),
  sizedesc: (a, b) => (b.size || 0) - (a.size || 0),
};
export const sortModels = (list, mode) => [...list].sort(SORTS[mode] || SORTS.smart);

const FILTERS = {
  fav: { label: '♥ Favorites', test: m => !!meta(m.name, m._srv).fav },
  rated: { label: '★ Rated', test: m => !!meta(m.name, m._srv).rating },
  used: { label: 'Used before', test: m => !!meta(m.name, m._srv).runs },
  strong: { label: 'Tier A or S', test: m => ['S', 'A'].includes(modelStrength(m.name, m._srv).tier) },
};

function paintModels() {
  if (current() !== 'models') return;
  const merged = isMerged();
  const pool = merged ? pickerItems() : visibleModels();
  const all = merged && view.server ? pool.filter(m => m._srv.conn.id === view.server) : pool;
  $('#m-count').textContent = `${all.length} model${all.length === 1 ? '' : 's'}`;

  const chips = $('#m-chips');
  chips.innerHTML = '';
  if (merged) {
    const sc = (id, label, n, srv) => h('button', {
      class: 'chip srvchip' + (view.server === id ? ' on' : ''), type: 'button',
      title: srv?.status === 'error' ? srv.error : '',
      onclick: () => { view.server = id; paintModels(); },
    }, srv ? h('span', { class: 'sdot ' + srv.status }) : null, `${label} · ${n}`);
    chips.append(sc('', 'All servers', pool.length));
    for (const srv of state.servers) {
      const n = pool.filter(m => m._srv === srv).length;
      chips.append(sc(srv.conn.id, serverLabel(srv.conn), srv.status === 'loading' ? '…' : srv.status === 'error' ? '✕' : n, srv));
    }
  }
  const chip = (key, label, count) => h('button', {
    class: 'chip' + (view.filters.has(key) ? ' on' : ''), type: 'button',
    onclick: () => { view.filters.has(key) ? view.filters.delete(key) : view.filters.add(key); paintModels(); },
  }, `${label} · ${count}`);
  for (const [key, f] of Object.entries(FILTERS)) { const n = all.filter(f.test).length; if (n) chips.append(chip(key, f.label, n)); }
  const capCounts = {};
  all.forEach(m => (m.caps || []).forEach(c => { capCounts[c] = (capCounts[c] || 0) + 1; }));
  Object.keys(capCounts).sort().forEach(c => chips.append(chip('cap:' + c, c, capCounts[c])));

  const q = view.q.toLowerCase();
  const list = sortModels(all.filter(m =>
    (!q || m.name.toLowerCase().includes(q) || JSON.stringify(m.details || {}).toLowerCase().includes(q)) &&
    [...view.filters].every(f => (f.startsWith('cap:') ? (m.caps || []).includes(f.slice(4)) : FILTERS[f].test(m)))), view.sort);

  const grid = $('#m-grid');
  grid.innerHTML = '';
  if (!list.length) grid.append(h('div', { class: 'dim' }, 'No models match.'));
  for (const m of list) {
    const d = m.details || {}, srv = m._srv || null;
    const stats = statsText(m.name, false, srv);
    const sel = m.name === state.model && (!srv || srv.conn.id === state.conn?.id);
    const running = (srv ? srv.running : state.running)[m.name];
    grid.append(h('div', { class: 'mcard' + (sel ? ' sel' : ''), onclick: () => pickModel(m.name, { srv }) },
      h('div', { class: 'mtop' }, h('span', { class: 'mname' }, m.name), favEl(m.name, srv)),
      srv ? h('div', { class: 'tags' }, h('span', { class: 'tag srvtag', title: srv.conn.url }, '🖥 ' + serverLabel(srv.conn))) : null,
      h('div', { class: 'tags' }, m.caps ? (m.caps.length ? m.caps.map(c => capTag(c)) : h('span', { class: 'tag unk' }, 'unknown')) : h('span', { class: 'tag unk' }, 'detecting…')),
      h('div', { class: 'meta' }, [d.parameter_size, d.quantization_level, m.size ? fmt.gb(m.size) : null, d.context_length ? fmt.ctx(d.context_length) + ' ctx' : null, d.family]
        .filter(Boolean).map(x => h('span', {}, x))),
      h('div', { class: 'mfoot' }, strengthEl(m.name, { srv }), starsEl(m.name, { srv }), reliabilityEl(m.name, srv), running ? h('span', { class: 'run', title: 'Loaded in memory' }, '● loaded') : null),
      stats ? h('div', { class: 'dim small' }, stats) : null));
  }
}

/** Select a model. stay=true when switching from inside the workspace. */
export function pickModel(name, { stay = false, srv = null } = {}) {
  if (srv && srv.conn.id !== state.conn?.id) {
    state.conn = srv.conn; state.models = srv.models; state.modelMeta = srv.meta; state.running = srv.running;
    emit('conn');
  }
  state.model = name;
  state.conn.lastModel = name;
  persistConn(state.conn, { quiet: true });
  setModelMeta(name, { lastUsed: Date.now() });
  const caps = state.models.find(m => m.name === name)?.caps;
  if (caps?.length && !caps.includes('tools')) toast(`${name} has no tool calling: coding agents will run in chat-only mode. The "chat" agent works fine.`, 4500);
  emit('model');
  if (stay) updateTop(); else enterWorkspace();
}
