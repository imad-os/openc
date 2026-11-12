// All saved servers at once: their models, your ratings/stats per server and whether each answers.
// The models screen and the model switcher merge them and tag every model with its server, so you
// can spread work over several machines. The "active" server (state.conn) is still the one used for a chat.
import { state, emit, on } from '../core/state.js';
import { listModels, showModel } from '../core/ollama.js';
import { remoteTarget, getRemoteCatalog } from './remote.js';

const TTL = 60000;
let loading = null;

const hostOf = u => { try { return new URL(u).host; } catch { return u || ''; } };
export const serverLabel = c => c?.label || hostOf(c?.url);
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
const toModel = m => ({ ...m, name: m.name || m.model, caps: Array.isArray(m.capabilities) ? m.capabilities : (Array.isArray(m.caps) ? m.caps : null) });

/** Keep the entry of the connected server in step with state.models / state.modelMeta. */
export function adoptActive() {
  const c = state.conn;
  if (!c) return;
  let s = state.servers.find(x => x.conn.id === c.id);
  if (!s) { s = { conn: c, models: [], meta: {}, running: {}, status: 'ok', error: '', t: 0 }; state.servers.push(s); }
  Object.assign(s, { conn: c, models: state.models, meta: state.modelMeta, running: state.running, status: 'ok', error: '', t: Date.now() });
  emit('servers');
}

async function detectCaps(s) {
  const todo = s.models.filter(m => !m.caps);
  await Promise.all([0, 1, 2].map(async () => {
    while (todo.length) {
      const m = todo.shift();
      try { m.caps = (await showModel(m.name, s.conn)).capabilities || []; } catch { m.caps = []; }
    }
  }));
}

async function refreshOne(s, force, catalog) {
  if (s.conn.id === state.conn?.id) return; // the connected one is kept fresh by connect() / Refresh
  if (!force && s.status === 'ok' && Date.now() - s.t < TTL) return;
  if (!s.t) s.status = 'loading';
  try {
    if (catalog !== undefined) {
      const srv = catalog?.servers?.find(x => x.id === s.conn.id || x.url === s.conn.url);
      if (!srv) throw new Error('the PC has not listed this server yet');
      if (srv.error) throw new Error(srv.error);
      s.models = (srv.models || []).map(toModel);
      s.running = {};
    } else {
      const { models, running } = await withTimeout(listModels(s.conn), 12000, 'no answer within 12 s');
      s.running = running || {};
      s.models = models.map(toModel);
      await detectCaps(s);
    }
    try { s.meta = await state.store.listModelMeta(s.conn.url); } catch { s.meta = s.meta || {}; }
    s.status = 'ok';
    s.error = '';
    s.t = Date.now();
  } catch (e) {
    s.status = 'error';
    s.error = String(e.message || e);
  }
  emit('servers');
}

/** (Re)load every saved server in parallel. Safe to call often: results are cached for a minute. */
export function loadServers({ force = false } = {}) {
  if (loading) return loading;
  loading = (async () => {
    let conns = [];
    try { conns = await state.store.listConnections(); } catch { /* keep what we have */ }
    const old = new Map(state.servers.map(s => [s.conn.id, s]));
    state.servers = conns.map(c => {
      const o = old.get(c.id);
      if (o) { if (o.conn.id !== state.conn?.id) o.conn = c; return o; }
      return { conn: c, models: [], meta: {}, running: {}, status: 'loading', error: '', t: 0 };
    });
    adoptActive();
    emit('servers');
    let catalog;
    if (remoteTarget()) { try { catalog = await getRemoteCatalog(); } catch { catalog = null; } }
    await Promise.all(state.servers.map(s => refreshOne(s, force, catalog)));
  })().finally(() => { loading = null; });
  return loading;
}

export function initServers() {
  on('conn', adoptActive);
  on('user', () => { state.servers = []; });
}

/** Resolver for MAX: id -> { conn, models, label } of a saved server (loads it when needed). */
export async function getServer(id) {
  if (!state.servers.length) await loadServers();
  let s = state.servers.find(x => x.conn.id === id);
  if (s && s.status !== 'ok') { await refreshOne(s, true); }
  if (!s || s.status !== 'ok' || !s.models.length) return null;
  return { conn: s.conn, models: s.models, label: serverLabel(s.conn) };
}
