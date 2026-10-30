// CloudStore: Firestore-backed storage. Everything lives under /users/{uid}/…,
// which firestore.rules restrict to the signed-in owner.
//
//   users/{uid}                         { email, created, updated, settings }
//   users/{uid}/connections/{id}        { url, key, label, created, lastUsed, lastModel }
//   users/{uid}/models/{hash(url|model)}{ url, model, rating, fav, lastUsed, runs, evalTokens, … }
//   users/{uid}/agents/{id}             { name, mode, desc, model, temperature, tools, prompt, updated }
//   users/{uid}/sessions/{id}           { title, created, updated, url, model, agent, todos, summary, summaryUpto, count }
//   users/{uid}/sessions/{id}/messages/m000042  { seq, role, json }
import { hashId } from '../../util/misc.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
let cached = null;

/** Lazily load the Firebase SDK (only when a config exists). */
export async function loadFirebase(config) {
  if (cached) return cached;
  const [appM, A, F] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]);
  const app = appM.initializeApp(config);
  const auth = A.getAuth(app);
  let db;
  try {
    db = F.initializeFirestore(app, {
      localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }),
      ignoreUndefinedProperties: true,
    });
  } catch { db = F.getFirestore(app); }
  cached = { app, auth, db, A, F };
  return cached;
}

export const CONN_FIELDS = ['url', 'key', 'label', 'created', 'lastUsed', 'lastModel'];
export const MODEL_FIELDS = ['url', 'model', 'rating', 'fav', 'note', 'lastUsed', 'updated', 'runs', 'requests', 'evalTokens', 'evalNs', 'promptTokens', 'toolCalls', 'toolErrors'];
export const AGENT_FIELDS = ['name', 'mode', 'desc', 'model', 'temperature', 'tools', 'prompt', 'updated'];
export const SESSION_FIELDS = ['title', 'created', 'updated', 'url', 'model', 'agent', 'todos', 'summary', 'summaryUpto', 'count'];

const clean = o => JSON.parse(JSON.stringify(o ?? null));
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o?.[k] !== undefined).map(k => [k, o[k]]));
const MSG_MAX = 600000; // chars per message document (Firestore doc limit is 1 MiB)

/** Keep a message under the document size limit. */
function shrink(msg) {
  let json = JSON.stringify(msg);
  if (json.length <= MSG_MAX) return json;
  const m = { ...msg, thinking: undefined };
  if (m.tool_calls) {
    m.tool_calls = m.tool_calls.map(c => {
      const a = { ...(c.function?.arguments || {}) };
      for (const k of Object.keys(a)) if (typeof a[k] === 'string' && a[k].length > 20000) a[k] = a[k].slice(0, 20000) + '…[truncated for sync]';
      return { function: { name: c.function?.name, arguments: a } };
    });
  }
  if (typeof m.content === 'string' && m.content.length > MSG_MAX / 2) m.content = m.content.slice(0, MSG_MAX / 2) + '\n…[truncated for sync]';
  json = JSON.stringify(m);
  return json.length <= MSG_MAX ? json : JSON.stringify({ role: m.role, content: '[message too large to sync]', tool_name: m.tool_name });
}

async function commitInBatches(F, db, ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const b = F.writeBatch(db);
    for (const op of ops.slice(i, i + 400)) op(b);
    await b.commit();
  }
}

export class CloudStore {
  constructor(fb, user) {
    this.kind = 'cloud';
    this.fb = fb;
    this.F = fb.F;
    this.db = fb.db;
    this.uid = user.uid;
    this.email = user.email || '';
  }
  doc(...p) { return this.F.doc(this.db, 'users', this.uid, ...p); }
  col(...p) { return this.F.collection(this.db, 'users', this.uid, ...p); }

  async init() {
    const snap = await this.F.getDoc(this.doc());
    if (!snap.exists()) await this.F.setDoc(this.doc(), { email: this.email.slice(0, 320), created: Date.now(), updated: Date.now(), settings: {} });
  }

  async getSettings() {
    const s = await this.F.getDoc(this.doc());
    return (s.exists() && s.data().settings) || {};
  }
  async saveSettings(settings) {
    await this.F.setDoc(this.doc(), { settings: clean(settings), updated: Date.now() }, { merge: true });
  }

  async listConnections() {
    const q = await this.F.getDocs(this.col('connections'));
    return q.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  }
  async saveConnection(c) { await this.F.setDoc(this.doc('connections', c.id), clean(pick(c, CONN_FIELDS))); }
  async deleteConnection(id) { await this.F.deleteDoc(this.doc('connections', id)); }

  async listModelMeta(url) {
    const q = await this.F.getDocs(this.F.query(this.col('models'), this.F.where('url', '==', url)));
    const out = {};
    q.forEach(d => { const m = d.data(); out[m.model] = m; });
    return out;
  }
  async updateModelMeta(url, model, patch = {}, inc = {}) {
    const data = { ...clean(pick(patch, MODEL_FIELDS)), url, model, updated: Date.now() };
    for (const [k, v] of Object.entries(inc)) if (MODEL_FIELDS.includes(k) && v) data[k] = this.F.increment(v);
    await this.F.setDoc(this.doc('models', hashId(url + '|' + model)), data, { merge: true });
  }

  async listAgents() {
    const q = await this.F.getDocs(this.col('agents'));
    return q.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  async saveAgent(a) { await this.F.setDoc(this.doc('agents', a.id), clean(pick({ ...a, updated: Date.now() }, AGENT_FIELDS))); }
  async deleteAgent(id) { await this.F.deleteDoc(this.doc('agents', id)); }

  async listSessions() {
    const F = this.F;
    const q = await F.getDocs(F.query(this.col('sessions'), F.orderBy('updated', 'desc'), F.limit(300)));
    return q.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  async loadMessages(id) {
    const F = this.F;
    const q = await F.getDocs(F.query(this.col('sessions', id, 'messages'), F.orderBy('seq')));
    return q.docs.map(d => { try { return JSON.parse(d.data().json); } catch { return null; } }).filter(Boolean);
  }
  /** Writes session metadata plus messages[from..] (one document per message). */
  async saveSession(meta, msgs, from) {
    const ops = [b => b.set(this.doc('sessions', meta.id), clean(pick(meta, SESSION_FIELDS)))];
    msgs.forEach((msg, i) => {
      const seq = from + i;
      ops.push(b => b.set(this.doc('sessions', meta.id, 'messages', 'm' + String(seq).padStart(6, '0')), { seq, role: msg.role, json: shrink(msg) }));
    });
    await commitInBatches(this.F, this.db, ops);
  }
  async deleteSession(id) {
    const q = await this.F.getDocs(this.col('sessions', id, 'messages'));
    await commitInBatches(this.F, this.db, q.docs.map(d => b => b.delete(d.ref)));
    await this.F.deleteDoc(this.doc('sessions', id));
  }
}
