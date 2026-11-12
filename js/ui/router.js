// URL routing: the address bar follows where you are (#/connect, #/models, #/chat, #/chat/<conversation>),
// the Back button works, and a refresh returns to the same screen and conversation.
// The last server and model are remembered in this browser (the URL only holds screen + conversation).
import { state, emit, on } from '../core/state.js';
import { show, current } from './views.js';
import { showConnect, connect } from './connect.js';
import { showModels } from './models.js';
import { enterWorkspace } from './workspace.js';
import { openSession, newSession } from './sessions.js';

const LAST_KEY = 'oc2.last';
let applying = false;

const readLast = () => { try { return JSON.parse(localStorage.getItem(LAST_KEY) || 'null') || {}; } catch { return {}; } };
const writeLast = patch => { try { localStorage.setItem(LAST_KEY, JSON.stringify({ ...readLast(), ...patch })); } catch { /* ignore */ } };

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
    if (r.view === 'chat' && state.conn && state.model) {
      if (current() !== 'ws') enterWorkspace();
      if (r.session) await openSession(r.session);
      else if (state.session && !state.session._draft) newSession();
    } else if (r.view === 'models' && state.conn) showModels();
    else await showConnect();
  } finally { applying = false; sync(true); }
}

/** After sign-in / local start: go back to where the address says, else to the servers screen. */
export async function restore() {
  const r = parseHash();
  const last = readLast();
  if (!r.view || r.view === 'connect' || !last.conn) return showConnect();
  applying = true;
  try {
    let conn = null;
    try { conn = (await state.store.listConnections()).find(c => c.id === last.conn); } catch { /* ignore */ }
    if (!conn) return await showConnect();
    await showConnect();
    await connect(conn, { resume: false, restore: { to: r.view, model: last.model, session: r.session } });
  } finally { applying = false; sync(true); }
}

export function initRouter() {
  on('view', () => sync());
  on('session', () => sync());
  on('route', () => sync(true));
  on('conn', () => { if (state.conn?.id) writeLast({ conn: state.conn.id }); });
  on('model', () => { if (state.model) writeLast({ model: state.model }); });
  window.addEventListener('popstate', onPop);
}
