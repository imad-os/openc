// LocalStore: same interface as CloudStore, persisted in this browser's localStorage.
import { uid } from '../../util/misc.js';

const P = 'oc2.';
const get = (k, d) => { try { const v = localStorage.getItem(P + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const set = (k, v) => {
  try { localStorage.setItem(P + k, JSON.stringify(v)); }
  catch (e) { throw new Error('Browser storage is full (' + e.name + '). Delete old conversations.'); }
};
const del = k => { try { localStorage.removeItem(P + k); } catch { /* ignore */ } };
const byRecent = key => (a, b) => (b[key] || 0) - (a[key] || 0);

/** One-time import of data saved by the first single-file version (oc.* keys). */
function migrateV1() {
  if (get('migrated', false)) return;
  const old = k => { try { return JSON.parse(localStorage.getItem('oc.' + k) || 'null'); } catch { return null; } };
  try {
    const urls = old('urls') || [];
    if (urls.length && !get('conns', null)) {
      set('conns', urls.map(u => ({ id: uid(), url: u.url, key: u.key || '', label: '', created: u.t || Date.now(), lastUsed: u.t || 0 })));
    }
    const sessions = old('sessions') || [];
    if (sessions.length && !get('sessions', null)) {
      const metas = [];
      for (const s of sessions) {
        const msgs = s.messages || [];
        set('msgs.' + s.id, msgs);
        metas.push({ id: s.id, title: s.title || 'Imported', created: s.created || Date.now(), updated: s.created || Date.now(), url: '', model: '', agent: '', todos: s.todos || [], summary: '', summaryUpto: 0, count: msgs.length });
      }
      set('sessions', metas);
    }
    const agents = old('agents');
    if (agents?.length && !get('agents', null)) set('agents', agents);
    const settings = old('settings');
    if (settings && !get('settings', null)) set('settings', settings);
  } catch (e) { console.warn('v1 migration skipped', e); }
  set('migrated', true);
}

export class LocalStore {
  constructor() { this.kind = 'local'; }
  async init() { migrateV1(); }

  async getSettings() { return get('settings', {}); }
  async saveSettings(s) { set('settings', s); }

  async listConnections() { return get('conns', []).sort(byRecent('lastUsed')); }
  async saveConnection(c) { set('conns', [...get('conns', []).filter(x => x.id !== c.id), c]); }
  async deleteConnection(id) { set('conns', get('conns', []).filter(x => x.id !== id)); }

  async listModelMeta(url) {
    const out = {};
    for (const m of Object.values(get('mmeta', {}))) if (m.url === url) out[m.model] = m;
    return out;
  }
  /** patch: fields to set; inc: numeric fields to add to */
  async updateModelMeta(url, model, patch = {}, inc = {}) {
    const all = get('mmeta', {});
    const id = url + '|' + model;
    const m = all[id] || (all[id] = { url, model });
    Object.assign(m, patch);
    for (const [k, v] of Object.entries(inc)) m[k] = (m[k] || 0) + v;
    m.updated = Date.now();
    set('mmeta', all);
  }

  async listAgents() { return get('agents', []); }
  async saveAgent(a) { set('agents', [...get('agents', []).filter(x => x.id !== a.id), a]); }
  async deleteAgent(id) { set('agents', get('agents', []).filter(x => x.id !== id)); }

  async listSessions() { return get('sessions', []).sort(byRecent('updated')); }
  async loadMessages(id) { return get('msgs.' + id, []); }
  /** Save metadata and messages[from..]. */
  async saveSession(meta, msgs, from) {
    const all = get('msgs.' + meta.id, []);
    all.length = Math.min(all.length, from);
    all.push(...msgs);
    set('msgs.' + meta.id, all);
    set('sessions', [...get('sessions', []).filter(s => s.id !== meta.id), meta]);
  }
  async deleteSession(id) {
    del('msgs.' + id);
    set('sessions', get('sessions', []).filter(s => s.id !== id));
  }

  hasData() { return get('conns', []).length + get('sessions', []).length + Object.keys(get('mmeta', {})).length + get('agents', []).length > 0; }
  async exportAll() {
    return {
      conns: get('conns', []),
      models: Object.values(get('mmeta', {})),
      agents: get('agents', []),
      sessions: get('sessions', []).map(meta => ({ meta, messages: get('msgs.' + meta.id, []) })),
    };
  }
}
