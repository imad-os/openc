// URL routing: the address bar follows where you are (#/connect, #/models, #/chat, #/chat/<conversation>),
// the Back button works, and a refresh returns to the same screen and conversation.
// Each browser window/tab keeps its own selected server, model, mode, and thinking level in sessionStorage.
import { state, emit, on } from '../core/state.js';
import { current } from './views.js';
import { showConnect } from './connect.js';
import { showModels, loadModels } from './models.js';
import { enterWorkspace, setAgent, setThink, updateTop } from './workspace.js';
import { openSession, newSession } from './sessions.js';
import { loadServers, adoptActive } from './servers.js';
import { remoteTarget, getRemoteCatalog } from './remote.js';

const LAST_KEY = 'oc2.last';
let applying = false;

const readLast = () => {
  try {
    const win = sessionStorage.getItem(LAST_KEY);
    if (win) return JSON.parse(win) || {};
    const shared = JSON.parse(localStorage.getItem(LAST_KEY) || 'null') || {};
    // New window starts with default chat/auto mode & inherits last server/model hint only once into sessionStorage.
    return shared.conn ? { conn: shared.conn, model: shared.model || '' } : {};
  } catch { return {}; }
};
const writeLast = patch => {
  try {
    const next = { ...readLast(), ...patch };
    sessionStorage.setItem(LAST_KEY, JSON.stringify(next));
    if (patch.conn || patch.model) {
      const shared = JSON.parse(localStorage.getItem(LAST_KEY) || 'null') || {};
      localStorage.setItem(LAST_KEY, JSON.stringify({ ...shared, ...(patch.conn ? { conn: patch.conn } : {}), ...(patch.model ? { model: patch.model } : {}) }));
    }
  } catch { /* ignore */ }
};

function parseHash(h = location.hash) {
  const m = /^#\/(connect|models|chat)(?:\/([^/?#]+))?/.exec(h || '');
  return m ? { view: m[1], session: m[2] ? decodeURIComponent(m[2]) : '' } : { view: '', session: '' };
}

function hashNow() {
  switch (current()) {
    case 'connect': return '#/connect';
    case 'models': return '#/models';
    case 'ws': return '#/chat' + (state.session && !state.session._draft ? '/' + encodeURIComponent(state.session.id) : '');
    default: return null; // sign-in screen: leave the address alone
  }
}

/** Write the current location to the address bar (push = new history entry, otherwise replace). */
function sync(replace = false) {
  const h = hashNow();
  if (!h || h === location.hash) return;
  if (applying || replace) history.replaceState(null, '', h);
  else history.pushState(null, '', h);
}

/** Back / forward: show what the address says. */
async function onPop() {
  if (!state.store || applying) return;
  const r = parseHash();
  applying = true;
  try {
    if (r.view === 'connect') await showConnect();
    else if (r.view === 'models') showModels();
    else {
      if (current() !== 'ws') enterWorkspace();
      if (r.session) await openSession(r.session);
      else if (state.session && !state.session._draft) newSession();
    }
  } finally { applying = false; sync(true); }
}

/** Connect to the last/first saved server (or remote PC catalog) in the background without leaving chat. */
async function restoreConnection(last) {
  let conns = [];
  try { conns = await state.store.listConnections(); } catch { /* ignore */ }
  const sessUrl = state.session && !state.session._draft ? state.session.url : '';
  let conn = (sessUrl && conns.find(c => c.url === sessUrl))
    || (last.conn && conns.find(c => c.id === last.conn))
    || conns[0]
    || null;
  if (!conn && remoteTarget()) {
    try {
      const cat = await getRemoteCatalog();
      const s = (sessUrl && cat?.servers?.find(x => x.url === sessUrl)) || cat?.servers?.[0];
      if (s) conn = { id: s.id, url: s.url, key: '', label: '', created: Date.now() };
    } catch { /* ignore */ }
  }
  if (!conn) {
    loadServers();
    return;
  }
  state.conn = conn;
  const preferred = (state.session && !state.session._draft && state.session.model) || last.model || conn.lastModel || '';
  if (preferred && !state.model) {
    state.model = preferred;
    emit('model');
  }
  emit('conn');
  try { state.modelMeta = await state.store.listModelMeta(conn.url); } catch { state.modelMeta = {}; }
  try {
    await loadModels();
    adoptActive();
    const pick = (state.model && state.models.some(m => m.name === state.model) && state.model)
      || (preferred && state.models.some(m => m.name === preferred) && preferred)
      || (conn.lastModel && state.models.some(m => m.name === conn.lastModel) && conn.lastModel)
      || state.models[0]?.name
      || '';
    if (pick !== (state.model || '')) {
      state.model = pick || null;
      emit('model');
    }
    emit('models');
    updateTop();
  } catch (e) {
    console.warn('Initial server connection failed:', e);
    emit('models');
    updateTop();
  }
  loadServers();
}

/** After sign-in / local start: open the chat UI immediately (unless URL explicitly asks for #/connect). */
export async function restore() {
  const r = parseHash();
  const last = readLast();
  if (r.view === 'connect') return showConnect();
  applying = true;
  try {
    if (r.view === 'models') {
      showModels();
      await restoreConnection(last);
      return;
    }
    if (!r.session) {
      if (last.agent) setAgent(last.agent, { syncSession: false });
      if (last.think) setThink(last.think, { syncSession: false, save: false });
      if (last.model) state.model = last.model;
    }
    enterWorkspace();
    if (r.session) await openSession(r.session);
    await restoreConnection(last);
  } finally { applying = false; sync(true); }
}

export function initRouter() {
  on('view', () => sync());
  on('session', () => sync());
  on('route', () => sync(true));
  on('conn', () => { if (state.conn?.id) writeLast({ conn: state.conn.id }); });
  on('model', () => { if (state.model) writeLast({ model: state.model }); });
  on('agent', id => { if (id) writeLast({ agent: id }); });
  on('think', v => { if (v) writeLast({ think: v }); });
  window.addEventListener('popstate', onPop);
}
