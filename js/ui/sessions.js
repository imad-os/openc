// Conversations: sidebar list, open/new/rename/delete, incremental persistence, todos panel.
import { state, on, emit } from '../core/state.js';
import { $, h, toast, confirmDialog, promptDialog } from '../util/dom.js';
import { uid } from '../util/misc.js';
import { threadView, showThread, dropThread, renderThread } from './chat.js';
import { setAgent, updateTop, updateStatus } from './workspace.js';
import { runs, isRunning } from './runs.js';
import { refreshFiles, removeSessionFiles } from './files.js';

export function initSessions() {
  $('#sess-q').addEventListener('input', paintSessions);
  on('user', () => { state.session = null; });
  on('runs', paintSessions);
}

/** Make `s` the visible conversation. Views of idle conversations are dropped when you leave them. */
function display(s) {
  const prev = state.session;
  if (prev && prev !== s && !isRunning(prev.id)) dropThread(prev.id);
  state.session = s;
  renderSession();
  paintSessions();
  emit('session', s);
  refreshFiles();
}

export const draftSession = () => ({
  id: uid(), title: 'New session', created: Date.now(), updated: Date.now(),
  url: state.conn?.url || '', model: state.model || '', agent: state.agentId,
  files: state.settings.defaultFiles === 'shared' ? 'shared' : 'session',
  todos: [], summary: '', summaryUpto: 0, messages: [], _synced: 0, _draft: true,
});

const metaOf = s => ({
  id: s.id, title: s.title, created: s.created, updated: s.updated, url: s.url || '', model: s.model || '', agent: s.agent || '',
  todos: s.todos || [], summary: s.summary || '', summaryUpto: s.summaryUpto || 0, count: s.messages.length,
  files: s.files || 'shared',
});

/** Images are not synced (too large); keep a count instead. */
const forStorage = m => {
  if (!m.images) return m;
  const { images, ...rest } = m;
  return { ...rest, _n: images.length };
};

let chain = Promise.resolve();
let warned = false;

/** Save metadata + messages not yet saved. Calls are serialized. */
export function persistSession(s = state.session) {
  if (!s || !state.store) return chain;
  s._draft = false;
  s.updated = Date.now();
  if (!s.url && state.conn) s.url = state.conn.url;
  if (!s.model && state.model) s.model = state.model;
  chain = chain.then(async () => {
    const from = s._synced || 0;
    const msgs = s.messages.slice(from).map(forStorage);
    const meta = metaOf(s);
    await state.store.saveSession(meta, msgs, from);
    s._synced = from + msgs.length;
    state.sessions = [meta, ...state.sessions.filter(x => x.id !== meta.id)];
    paintSessions();
  }).catch(e => {
    console.error('persistSession', e);
    if (!warned) { warned = true; toast('Could not save the conversation: ' + e.message, 6000); }
  });
  return chain;
}

/** Re-save from message index i on the next persist (after editing a saved message). */
export const markDirty = (s, i) => { s._synced = Math.min(s._synced || 0, i); };

export async function loadSessions() {
  try { state.sessions = await state.store.listSessions(); }
  catch (e) { state.sessions = []; toast('Could not load conversations: ' + e.message, 5000); }
  paintSessions();
}

export async function openSession(id) {
  $('#left').classList.remove('open');
  if (state.session?.id === id) return;
  let s = runs.get(id)?.session; // running: use the live object, it is still being written
  if (!s) {
    const meta = state.sessions.find(x => x.id === id);
    if (!meta) return;
    let messages;
    try { messages = await state.store.loadMessages(id); } catch (e) { return toast('Could not load: ' + e.message); }
    s = { ...meta, messages, _synced: messages.length };
  }
  if (s.model && s.model !== state.model && state.models.some(m => m.name === s.model)) { state.model = s.model; updateTop(); }
  if (s.agent) setAgent(s.agent);
  display(s);
}

export function newSession() {
  display(draftSession());
  $('#inp').focus();
}

function emptyState() {
  const ideas = [
    'Build a snake game in index.html with a neon look and a high-score table',
    'Create a todo app with localStorage, filters and dark mode',
    'Explain what the files in this workspace do',
    'Write a date-utils.js module and test it with run_js',
  ];
  return h('div', { class: 'empty' },
    h('h2', {}, 'What are we building?'),
    h('div', { class: 'dim' }, 'The agent reads, writes and tests files in the workspace on the right. Tab switches agent.'),
    h('div', { class: 'sugg' }, ideas.map(t => h('button', { class: 'btn', type: 'button', onclick: () => { $('#inp').value = t; $('#inp').focus(); } }, t))));
}

export function renderSession() {
  const s = state.session;
  const view = threadView(s);
  if (!view.rendered) {
    view.clear();
    if (!s.messages.length) view.root.append(emptyState());
    else renderThread(view, s.messages);
    view.rendered = true;
  }
  showThread(view);
  $('#title').textContent = s.title;
  renderTodos();
  updateStatus();
  view.scroll(true);
}

export function renderTodos() {
  const el = $('#p-todos');
  const todos = state.session?.todos || [];
  el.innerHTML = '';
  const open = todos.filter(t => t.status !== 'completed').length;
  $('#todo-count').textContent = todos.length ? `${todos.length - open}/${todos.length}` : '';
  if (!todos.length) { el.append(h('div', { class: 'dim pad' }, 'No todos yet. Agents create them for multi-step work.')); return; }
  todos.forEach(t => el.append(h('div', { class: 'todo ' + t.status }, t.status === 'completed' ? '●' : t.status === 'in_progress' ? '◐' : '○', ' ', t.content)));
}

function dayGroup(ts) {
  const d = new Date(ts), now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= start) return 'Today';
  if (ts >= start - 86400000) return 'Yesterday';
  if (ts >= start - 7 * 86400000) return 'Previous 7 days';
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function paintSessions() {
  const box = $('#sess');
  if (!box) return;
  box.innerHTML = '';
  const q = $('#sess-q').value.trim().toLowerCase();
  if (state.session?._draft && !q) box.append(h('div', { class: 'si on' }, h('div', { class: 'si-t' }, h('div', {}, 'New session'))));
  let group = '';
  for (const s of state.sessions) {
    if (q && !(s.title || '').toLowerCase().includes(q)) continue;
    const g = dayGroup(s.updated || s.created || 0);
    if (g !== group) { group = g; box.append(h('div', { class: 'sgroup' }, g)); }
    const rec = runs.get(s.id);
    const waiting = rec && ['approval', 'question'].includes(rec.run.status.phase);
    box.append(h('div', {
      class: 'si' + (s.id === state.session?.id ? ' on' : '') + (rec ? ' running' : '') + (waiting ? ' attention' : ''),
      title: rec ? 'Agent running: click to watch' : 'Double-click to rename',
      onclick: () => openSession(s.id), ondblclick: () => renameSession(s.id),
    },
    rec ? h('span', { class: 'rb-dot', title: waiting ? 'Waiting for you' : 'Running' }) : null,
    h('div', { class: 'si-t' }, h('div', {}, s.title || 'Untitled'), s.model ? h('div', { class: 'si-m' }, s.model) : null),
    h('button', { class: 'x', type: 'button', title: 'Delete', onclick: e => { e.stopPropagation(); deleteSession(s.id); } }, '×')));
  }
  if (!state.sessions.length && !state.session?._draft) box.append(h('div', { class: 'dim pad small' }, 'No conversations yet.'));
}

async function renameSession(id) {
  const meta = state.sessions.find(s => s.id === id);
  if (!meta) return;
  const title = await promptDialog('Rename conversation', meta.title);
  if (!title) return;
  meta.title = title.slice(0, 200);
  if (state.session?.id === id) { state.session.title = meta.title; $('#title').textContent = meta.title; persistSession(state.session); }
  else { try { await state.store.saveSession(meta, [], meta.count || 0); } catch (e) { toast(e.message); } }
  paintSessions();
}

async function deleteSession(id) {
  if (isRunning(id)) return toast('Stop the agent in that conversation first');
  if (!(await confirmDialog('Delete this conversation? This cannot be undone.', 'Delete'))) return;
  try { await state.store.deleteSession(id); } catch (e) { return toast('Could not delete: ' + e.message); }
  removeSessionFiles(id);
  state.sessions = state.sessions.filter(s => s.id !== id);
  if (state.session?.id === id) newSession(); else paintSessions();
}
