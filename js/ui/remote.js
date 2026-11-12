// Remote control UI.
//  * Phone side: "Run on" picker, sending a message to a PC, a live view of the conversation
//    (messages, todos, status bar with Stop / approvals), model list taken from the PC.
//  * Host side: this browser tab keeps running agents for your other devices.
// All traffic goes through Firestore (see core/remote.js), so the phone can be closed meanwhile.
import { state, emit, on, bus, primaryAgents, currentAgent } from '../core/state.js';
import { $, h, toast, popover, modal, confirmDialog, promptDialog } from '../util/dom.js';
import { uid, fmt, firstLine } from '../util/misc.js';
import * as R from '../core/remote.js';
import { listModels, showModel } from '../core/ollama.js';
import { threadView, renderThread } from './chat.js';
import { runs, describe, setRemoteBar } from './runs.js';
import { persistSession, paintSessions, renderTodos } from './sessions.js';
import { runTurn } from './composer.js';
import { maxConfig } from '../agent/max.js';

/* =====================================================================
 *  Phone side
 * ===================================================================== */
const TARGET_KEY = 'oc2.runOn';
let target = (() => { try { return localStorage.getItem(TARGET_KEY) || ''; } catch { return ''; } })();
let hosts = [];           // known hosts (refreshed when the picker opens)
let live = null;          // live status of the visible conversation
let unsub = [];           // listeners for the visible conversation
let sessionsUnsub = null; // listener for the conversation list
let lastToast = 0;
let hostsUnsub = null;
let beat = 0;

/** Host id agents should run on, or '' to run on this device. */
export const remoteTarget = () => (target && R.remoteAvailable() ? target : '');
const fresh = l => !!l && Date.now() - (l.updated || 0) < 90000;
/** The visible conversation is running on the PC right now. */
export const remoteRunning = () => !!remoteTarget() && live?.state === 'running' && fresh(live);

function setTarget(id) {
  target = id || '';
  try { if (target) localStorage.setItem(TARGET_KEY, target); else localStorage.removeItem(TARGET_KEY); } catch { /* ignore */ }
  attach();
  paintRunOn();
  toast(target ? `Agents now run on ${hostName(target)}` : 'Agents run on this device');
}
const hostName = id => hosts.find(x => x.id === id)?.name || 'the PC';

function detach() {
  unsub.forEach(f => f());
  unsub = [];
  sessionsUnsub?.();
  sessionsUnsub = null;
  live = null;
  emit('runs');
}

function attach() {
  detach();
  if (!remoteTarget()) return;
  sessionsUnsub = R.watchSessions(list => { state.sessions = list; paintSessions(); }, e => console.warn('sessions', e));
  watchCurrent();
}

/** Follow the visible conversation: stored messages, title/todos and the PC's live status. */
function watchCurrent() {
  unsub.forEach(f => f());
  unsub = [];
  live = null;
  const s = state.session;
  if (!remoteTarget() || !s || s._draft) { emit('runs'); return; }
  unsub.push(R.watchLive(s.id, d => {
    const was = live;
    live = d;
    if (d?.state === 'idle' && was?.state === 'running' && Date.now() - lastToast > 3000) {
      lastToast = Date.now();
      toast(`${d.phase || 'Done'} on ${d.hostName || 'the PC'}${d.detail ? ': ' + d.detail.slice(0, 120) : ''}`, 6000);
    }
    emit('runs');
  }, e => console.warn('live', e)));
  unsub.push(R.watchMessages(s.id, (msgs, sig) => applyMessages(s, msgs, sig), e => toast('Live view failed: ' + e.message)));
  unsub.push(R.watchSessionDoc(s.id, meta => {
    if (!meta || state.session?.id !== s.id) return;
    if (meta.title && meta.title !== s.title) { s.title = meta.title; $('#title').textContent = s.title; }
    s.todos = meta.todos || [];
    renderTodos();
  }, () => {}));
  emit('runs');
}

function applyMessages(s, msgs, sig) {
  if (state.session?.id !== s.id || runs.has(s.id) || s._remoteSig === sig) return;
  s._remoteSig = sig;
  s.messages = msgs;
  s._synced = msgs.length;
  const view = threadView(s);
  view.clear();
  if (msgs.length) renderThread(view, msgs);
  view.rendered = true;
  if (s._optimistic) {
    // keep showing what you just sent until the PC has stored it
    if (msgs.slice(-4).some(m => m.role === 'user' && m.content === s._optimistic)) s._optimistic = '';
    else view.user({ role: 'user', content: s._optimistic });
  }
  view.scroll();
}

/** Send a message to the PC instead of running the agent here. */
export async function sendRemote(text, hostId) {
  const inp = $('#inp');
  const s = state.session;
  if (remoteRunning()) { inp.value = text; return toast('This conversation is already running on the PC. Stop it first.'); }
  if (!state.conn) { inp.value = text; return toast('Pick a server first'); }
  let host = null;
  try { host = await R.getHost(hostId); } catch (e) { inp.value = text; return toast('Could not reach Firebase: ' + e.message); }
  if (!host) { inp.value = text; return toast('That PC is not registered any more. Pick another one.'); }
  if (!R.isOnline(host) && !(await confirmDialog(`${host.name} looks offline (last seen ${fmt.ago(host.lastSeen)}). Queue the message anyway? It runs as soon as that PC's browser is back online.`, 'Queue it'))) {
    inp.value = text;
    return;
  }
  const agent = currentAgent();
  if (s.title === 'New session') s.title = text.replace(/\s+/g, ' ').slice(0, 60);
  s.agent = agent.id;
  s.model = state.model;
  s.url = state.conn.url;
  $('#title').textContent = s.title;
  const view = threadView(s);
  view.rendered = true;
  if (!s.messages.length) view.clear();
  view.user({ role: 'user', content: text });
  s._optimistic = text;
  await persistSession(s); // creates the conversation document the PC loads
  try {
    const mx = maxConfig();
    await R.sendCommand({ host: hostId, type: 'send', session: s.id, text, conn: state.conn.id, model: state.model, agent: agent.id, ...(mx.on ? { max: JSON.stringify(mx).slice(0, 3900) } : {}) });
    toast(`✓ Sent to ${host.name}${R.isOnline(host) ? '' : ' (queued)'}. You can close this page.`, 4500);
  } catch (e) {
    s._optimistic = '';
    inp.value = text;
    return toast('Could not send: ' + e.message, 6000);
  }
  watchCurrent();
}

export async function stopRemote() {
  const s = state.session;
  if (!s || !remoteTarget()) return;
  try { await R.sendCommand({ host: live?.host || target, type: 'stop', session: s.id }); toast('Stop sent to the PC'); }
  catch (e) { toast('Could not send: ' + e.message); }
}

async function answerRemote(id, answer) {
  try { await R.sendCommand({ host: live?.host || target, type: 'answer', session: state.session.id, pending: id, answer: String(answer).slice(0, 20000) }); toast('Answer sent'); }
  catch (e) { toast('Could not send: ' + e.message); }
}

/** The PC's list of all servers and their models (for the merged models view). */
export const getRemoteCatalog = () => R.getCatalog(remoteTarget());

/** Models of a server as the PC sees them (the phone cannot reach the PC's localhost). */
export async function loadRemoteModels(conn, { wait = false } = {}) {
  const host = remoteTarget();
  const t0 = Date.now();
  if (wait) {
    try { await R.sendCommand({ host, type: 'refresh', conn: conn.id }); } catch (e) { throw new Error('Could not ask the PC: ' + e.message); }
  }
  for (;;) {
    const cat = await R.getCatalog(host);
    const srv = cat?.servers?.find(x => x.id === conn.id || x.url === conn.url);
    if (srv && (!wait || (cat.updated || 0) >= t0 - 2000)) {
      if (srv.error) throw new Error(`${hostName(host)} cannot reach ${srv.url}: ${srv.error}`);
      state.running = {};
      state.models = (srv.models || []).map(m => ({ ...m }));
      return;
    }
    if (!wait || Date.now() - t0 > 25000) {
      throw new Error(srv ? 'The PC did not answer in time.' : `${hostName(host)} has not listed this server yet. Is its browser open in host mode?`);
    }
    await new Promise(r => setTimeout(r, 1500));
  }
}

/* ---------- status bar ---------- */
let barSig = '', barTime = null;
function paintRemoteBar(bar) {
  const l = remoteTarget() && live;
  if (!l || l.state !== 'running') { barSig = ''; return false; }
  const stale = !fresh(l);
  const sig = [l.phase, l.detail, l.step, l.askId, stale].join('|');
  const elapsed = () => `step ${l.step || 1}/${l.maxSteps || '?'} · ${fmt.dur(Date.now() - (l.started || l.since || Date.now()))}`;
  if (sig === barSig && barTime?.isConnected) { barTime.textContent = ' · ' + elapsed(); bar.hidden = false; return true; }
  barSig = sig;
  barTime = h('span', { class: 'dim' }, ' · ' + elapsed());
  const send = (id, a) => answerRemote(id, a);
  const ask = l.askId ? h('div', { class: 'rb-hint rb-ask' },
    h('div', { class: 'rb-asktext' }, (l.askKind === 'approval' ? '✋ Approval needed:\n' : '❓ ') + (l.askText || '')),
    h('div', { class: 'rb-act' }, ...(l.askKind === 'approval'
      ? [h('button', { class: 'btn ok sm', type: 'button', onclick: () => send(l.askId, 'allow') }, 'Allow'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => send(l.askId, 'always') }, 'Always'),
        h('button', { class: 'btn danger sm', type: 'button', onclick: () => send(l.askId, 'deny') }, 'Deny')]
      : [...(l.askOptions || []).map(o => h('button', { class: 'btn sm', type: 'button', onclick: () => send(l.askId, o) }, o)),
        h('button', { class: 'btn primary sm', type: 'button', onclick: async () => { const a = await promptDialog(l.askText || 'Answer', ''); if (a) send(l.askId, a); } }, 'Type answer…')]))) : null;
  bar.hidden = false;
  bar.className = 'runbar ' + (stale ? 'stalled' : l.askId ? 'you' : l.health || 'ok');
  bar.replaceChildren(...[
    h('div', { class: 'rb-main' }, h('span', { class: 'rb-dot' }),
      h('b', {}, `💻 ${l.hostName || 'PC'} · ${l.phase || 'Running'}${l.detail ? ': ' + l.detail : ''}`), barTime),
    stale ? h('div', { class: 'rb-hint' }, 'The PC has not reported for a while. It may be asleep, offline, or its browser tab was closed.') : null,
    ask,
    h('div', { class: 'rb-act' }, h('button', { class: 'btn sm danger', type: 'button', onclick: stopRemote }, '■ Stop')),
  ].filter(Boolean));
  return true;
}

/* ---------- "Run on" pill in the top bar + picker ---------- */
/** ready | busy | off for a host document */
function hostState(x) {
  if (!R.isOnline(x)) return { key: 'off', label: `Offline · last seen ${fmt.ago(x.lastSeen)}` };
  if (x.busy) return { key: 'busy', label: `Online · ${x.busy} agent${x.busy > 1 ? 's' : ''} running` };
  return { key: 'ready', label: 'Online · ready' };
}
const dot = key => h('span', { class: 'hdot ' + key });

export function paintRunOn() {
  const b = $('#runon');
  if (!b) return;
  const avail = R.remoteAvailable();
  b.hidden = !avail;
  if (!avail) return;
  const t = remoteTarget();
  b.classList.toggle('on', !!t || !!host);
  if (t) {
    const x = hosts.find(y => y.id === t);
    const st = x ? hostState(x) : { key: 'off', label: 'Not found' };
    b.replaceChildren(dot(st.key), h('span', { class: 'rl' }, x?.name || 'PC'));
    b.title = `Agents run on ${x?.name || 'a remote PC'} (${st.label}). Click to change.`;
  } else if (host) {
    b.replaceChildren(dot('ready'), h('span', { class: 'rl' }, `Hosting · ${host.name}`));
    b.title = 'This browser is a remote host for your other devices. Click for details.';
  } else {
    b.replaceChildren(h('span', { class: 'rl' }, '▶ This device'));
    b.title = 'Agents run in this browser. Click to run them on a remote PC instead.';
  }
}

/** Full list of machines: live status, platform, select / remove. */
function openRunOn() {
  let off = () => {};
  modal((box, close) => {
    const list = h('div', { class: 'hosts' });
    const paint = () => {
      const t = remoteTarget();
      const others = hosts.filter(x => x.id !== R.hostId());
      const me = hosts.find(x => x.id === R.hostId());
      const card = ({ key, title, sub, status, selected, onPick, onRemove, badge }) => h('div', { class: 'hcard' + (selected ? ' sel' : '') + (key === 'off' ? ' offline' : '') },
        h('div', { class: 'hc-main', onclick: onPick },
          h('div', { class: 'hc-top' }, dot(key), h('b', {}, title), badge ? h('span', { class: 'tag mini' }, badge) : null, selected ? h('span', { class: 'hc-sel' }, '✓ In use') : null),
          h('div', { class: 'dim small' }, sub),
          status ? h('div', { class: 'hc-status ' + key }, status) : null),
        onRemove ? h('button', { class: 'btn sm ghost danger', type: 'button', title: 'Forget this machine', onclick: onRemove }, '×') : null);
      list.replaceChildren(
        card({ key: 'local', title: '▶ This device', sub: `${R.platformInfo().text} · agents run in this browser and stop when you close it`, selected: !t, onPick: () => { close(); setTarget(''); } }),
        ...others.map(x => {
          const st = hostState(x);
          return card({
            key: st.key, title: x.name, sub: x.platform || 'Unknown platform', status: st.label, selected: t === x.id,
            onPick: () => { close(); setTarget(x.id); },
            onRemove: st.key === 'off' ? async e => { e.stopPropagation(); if (await confirmDialog(`Forget ${x.name}?`, 'Forget')) { try { await R.removeHostById(x.id); } catch (err) { toast(err.message); } } } : null,
          });
        }),
        !others.length ? h('div', { class: 'msgbox' }, 'No other machine is connected yet. On your PC: open this app, sign in with this account, tap the top-bar button and choose "Use this device as a remote host".') : null,
        me ? h('div', { class: 'dim small pad' }, `This device is hosting as "${me.name}".`) : null);
    };
    box.append(
      h('h3', {}, 'Run agents on'),
      h('div', { class: 'dim small' }, 'Pick the machine that should run your agents. A remote machine keeps working when this phone is closed.'),
      list,
      h('div', { class: 'row end' },
        h('button', { class: 'btn', type: 'button', onclick: () => { close(); openHostModal(); } }, host ? '● This device is a host' : '＋ Use this device as a host'),
        h('button', { class: 'btn', type: 'button', onclick: close }, 'Close')));
    paint();
    const onHosts = () => paint();
    bus.addEventListener('hosts', onHosts);
    const tick = setInterval(paint, 15000); // "last seen" and online state age even when nothing changes
    off = () => { bus.removeEventListener('hosts', onHosts); clearInterval(tick); };
  }, { onClose: () => off() });
}

/* =====================================================================
 *  Host side: this tab runs agents for other devices
 * ===================================================================== */
const HOST_PREF = 'oc2.host';
const hostPref = () => { try { return JSON.parse(localStorage.getItem(HOST_PREF) || 'null') || { on: false, name: '' }; } catch { return { on: false, name: '' }; } };
const saveHostPref = p => { try { localStorage.setItem(HOST_PREF, JSON.stringify(p)); } catch { /* ignore */ } };

let host = null; // { name, timers, unsub, release, answers, wl, wlHandler }
export const hostActive = () => !!host;

function takeLock() {
  return new Promise((resolve, reject) => {
    if (!navigator.locks) return resolve(() => {});
    navigator.locks.request('oc2-host', { ifAvailable: true }, lock => {
      if (!lock) { reject(new Error('Another tab of this browser is already the host. Close it first.')); return undefined; }
      return new Promise(release => resolve(release));
    });
  });
}

async function keepAwake(h0) {
  if (!navigator.wakeLock) return;
  const get = async () => { try { h0.wl = await navigator.wakeLock.request('screen'); } catch { /* denied or hidden */ } };
  h0.wlHandler = () => { if (document.visibilityState === 'visible' && host === h0) get(); };
  document.addEventListener('visibilitychange', h0.wlHandler);
  get();
}

export async function startHost(name) {
  if (!R.remoteAvailable()) throw new Error('Sign in first');
  if (host) await stopHost();
  const release = await takeLock();
  const h0 = { name: (name || R.defaultHostName()).trim().slice(0, 60) || R.defaultHostName(), release, timers: [], unsub: null, answers: new Map(), wl: null, wlHandler: null };
  try { await R.writeHost(h0.name, 0); } catch (e) { release(); throw e; }
  host = h0;
  h0.timers.push(setInterval(() => R.writeHost(h0.name, runs.size).catch(() => {}), 30000));
  h0.timers.push(setInterval(() => refreshCatalog().catch(() => {}), 10 * 60000));
  h0.unsub = R.watchCommands(R.hostId(), cmd => onCommand(h0, cmd), e => console.warn('commands', e));
  keepAwake(h0);
  refreshCatalog().catch(e => console.warn('catalog', e));
  paintRunOn();
}

export async function stopHost() {
  const h0 = host;
  if (!h0) return;
  host = null;
  h0.timers.forEach(clearInterval);
  h0.unsub?.();
  if (h0.wlHandler) document.removeEventListener('visibilitychange', h0.wlHandler);
  try { await h0.wl?.release(); } catch { /* ignore */ }
  try { await R.removeHost(); } catch { /* ignore */ }
  h0.release();
  paintRunOn();
}

const modelCache = new Map(); // conn id -> { t, list }
async function modelsFor(conn, force = false) {
  const c = modelCache.get(conn.id);
  if (!force && c && Date.now() - c.t < 300000) return c.list;
  const { models } = await listModels(conn);
  const list = models.map(m => ({ ...m, name: m.name || m.model, caps: Array.isArray(m.capabilities) ? m.capabilities : null }));
  await Promise.all(list.filter(m => !m.caps).map(async m => {
    try { m.caps = (await showModel(m.name, conn)).capabilities || []; } catch { m.caps = []; }
  }));
  modelCache.set(conn.id, { t: Date.now(), list });
  return list;
}

const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

/** Publish what each saved server offers, as seen from this PC (phones cannot reach its localhost). */
async function refreshCatalog() {
  if (!host || !state.store) return;
  const conns = await state.store.listConnections();
  const servers = await Promise.all(conns.map(async c => {
    try {
      const list = await withTimeout(modelsFor(c, true), 20000, 'timed out');
      return { id: c.id, url: c.url, models: list.map(m => ({ name: m.name, caps: m.caps || [], size: m.size || 0, details: m.details || {} })) };
    } catch (e) { return { id: c.id, url: c.url, models: [], error: String(e.message || e).slice(0, 300) }; }
  }));
  await R.writeCatalog(servers);
}

async function onCommand(h0, cmd) {
  try {
    if (host !== h0) return;
    if (Date.now() - (cmd.created || 0) > R.COMMAND_TTL) return;
    await R.updateCommand(cmd.id, { status: 'taken' });
    if (cmd.type === 'stop') runs.get(cmd.session)?.controller.abort();
    else if (cmd.type === 'answer') h0.answers.get(cmd.pending)?.(cmd.answer);
    else if (cmd.type === 'refresh') refreshCatalog().catch(() => {});
    else if (cmd.type === 'send') hostSend(h0, cmd).catch(e => hostFail(h0, cmd.session, e));
  } catch (e) {
    console.warn('command failed', e);
  } finally {
    R.deleteCommand(cmd.id).catch(() => {});
  }
}

function hostFail(h0, session, e) {
  console.warn('remote run failed', e);
  if (!session) return;
  R.writeLive(session, { host: R.hostId(), hostName: h0.name, state: 'idle', phase: '⚠ Failed', detail: String(e.message || e).slice(0, 1500), health: 'stalled' }).catch(() => {});
}

async function hostSend(h0, cmd) {
  const st = state.store;
  const sid = cmd.session;
  if (!sid) throw new Error('No conversation in the command');
  if (runs.has(sid)) throw new Error('That conversation is already running on this PC');
  const conn = (await st.listConnections()).find(c => c.id === cmd.conn);
  if (!conn) throw new Error('The server is not saved in the account');
  let s = state.session?.id === sid ? state.session : null; // the one open on this PC, so its screen stays in sync
  if (!s) {
    const meta = await st.getSession(sid);
    if (!meta) throw new Error('Conversation not found');
    const messages = await st.loadMessages(sid);
    s = { ...meta, messages, _synced: messages.length };
  }
  const models = await modelsFor(conn);
  const model = models.find(m => m.name === cmd.model)?.name || models.find(m => m.name === s.model)?.name || models[0]?.name;
  if (!model) throw new Error(`No models found on ${conn.url}`);
  const agent = state.agents.find(a => a.id === (cmd.agent || s.agent) && a.mode === 'primary') || primaryAgents()[0];
  s.agent = agent.id;
  s.model = model;
  s.url = conn.url;
  const view = threadView(s);
  if (!view.rendered) { view.clear(); if (s.messages.length) renderThread(view, s.messages); view.rendered = true; }
  const um = { role: 'user', content: String(cmd.text || '') };
  s.messages.push(um);
  view.user(um);
  const pub = makePublisher(h0, s);
  let max = null;
  try { const mx = cmd.max ? JSON.parse(cmd.max) : null; if (mx?.on) max = mx; } catch { /* ignore */ }
  let out;
  try {
    out = await runTurn(s, { agent, conn, model, models, max, remote: { ask: pub.ask }, onRun: pub.start });
  } catch (e) { out = { error: e }; }
  pub.finish(out);
}

/** Mirrors a running turn into live/{session} so other devices can show progress and answer prompts. */
function makePublisher(h0, s) {
  let rec = null, timer = 0, debounce = 0, lastSig = '', pending = null;
  const write = () => {
    if (!rec) return;
    const d = describe(rec);
    lastSig = [d.phase, d.detail, d.step, pending?.id].join('|');
    R.writeLive(s.id, {
      host: R.hostId(), hostName: h0.name, state: 'running', phase: `${d.icon} ${d.phase}`, detail: String(d.detail || '').slice(0, 1500), health: d.health,
      step: d.step || 1, maxSteps: d.maxSteps || 0, since: Date.now() - d.inPhase, started: rec.run.started, title: s.title,
      ...(pending ? { askKind: pending.kind, askText: pending.text, askOptions: pending.options, askId: pending.id } : {}),
    }).catch(e => console.warn('live', e));
  };
  const onStatus = ev => {
    if (!rec || ev.detail !== rec.run) return;
    const d = describe(rec);
    if ([d.phase, d.detail, d.step, pending?.id].join('|') === lastSig) return;
    clearTimeout(debounce);
    debounce = setTimeout(write, 500);
  };
  return {
    start(r) { rec = r; bus.addEventListener('run-status', onStatus); write(); timer = setInterval(write, 5000); },
    ask(kind, text, options) {
      const id = uid();
      pending = { id, kind, text: String(text || '').slice(0, 4000), options: (options || []).slice(0, 20).map(o => String(o).slice(0, 200)) };
      const promise = new Promise(resolve => { h0.answers.set(id, a => resolve(kind === 'approval' && !['allow', 'always'].includes(a) ? 'deny' : a)); });
      write();
      return { promise, cancel() { h0.answers.delete(id); if (pending?.id === id) pending = null; write(); } };
    },
    finish(out) {
      clearInterval(timer);
      clearTimeout(debounce);
      bus.removeEventListener('run-status', onStatus);
      rec = null;
      const e = out?.error;
      R.writeLive(s.id, {
        host: R.hostId(), hostName: h0.name, state: 'idle', phase: e ? '⚠ Failed' : out?.stopped ? '■ Stopped' : '✓ Finished',
        detail: e ? String(e.message || e).slice(0, 1500) : firstLine(out?.result?.text) || '', health: e ? 'stalled' : 'ok', title: s.title,
      }).catch(() => {});
    },
  };
}

/* ---------- host settings dialog ---------- */
export function openHostModal() {
  modal((box, close) => {
    const pref = hostPref();
    const name = h('input', { value: host?.name || pref.name || R.defaultHostName(), placeholder: R.defaultHostName(), maxlength: '60' });
    const status = h('div', { class: 'msgbox', hidden: true });
    box.append(
      h('h3', {}, 'Remote host'),
      h('div', {}, 'Turn this browser into the machine that runs your agents. From your phone, choose "Run on → this PC", send a request and close the phone: the agent keeps working here.'),
      h('div', { class: 'dim small' }, 'Keep this tab open and the computer awake. Ollama must be reachable from this browser at the saved server address (e.g. http://localhost:11434). Files the agent creates stay in this browser. Requires the updated Firestore rules.'),
      h('label', { class: 'dim small' }, `Name of this machine (${R.platformInfo().text})`), name, status,
      h('div', { class: 'row end' },
        h('button', { class: 'btn', type: 'button', onclick: close }, 'Close'),
        host ? h('button', { class: 'btn danger', type: 'button', onclick: async () => { saveHostPref({ on: false, name: name.value.trim() }); await stopHost(); toast('This device is no longer a host'); close(); } }, 'Stop hosting') : null,
        h('button', { class: 'btn primary', type: 'button', onclick: async e => {
          const b = e.currentTarget;
          b.disabled = true;
          status.hidden = true;
          try {
            saveHostPref({ on: true, name: name.value.trim() });
            await startHost(name.value.trim());
            toast(`✓ Hosting as "${host.name}". Keep this tab open.`, 5000);
            close();
          } catch (err) {
            b.disabled = false;
            status.hidden = false;
            status.textContent = err.message + (/permission|insufficient/i.test(err.message) ? ' (deploy the new firestore.rules first)' : '');
          }
        } }, host ? 'Save' : 'Start hosting')));
  });
}

/* =====================================================================
 *  Wiring
 * ===================================================================== */
async function onUser() {
  if (!R.remoteAvailable()) {
    hostsUnsub?.();
    hostsUnsub = null;
    hosts = [];
    if (host) await stopHost();
    detach();
    paintRunOn();
    return;
  }
  hostsUnsub?.();
  hostsUnsub = R.watchHosts(list => { hosts = list; paintRunOn(); emit('hosts'); }, e => console.warn('hosts', e));
  paintRunOn();
  attach();
  const pref = hostPref();
  if (pref.on) startHost(pref.name).catch(e => toast('Remote host: ' + e.message, 6000));
}

export function initRemote() {
  setRemoteBar(paintRemoteBar);
  $('#runon').addEventListener('click', openRunOn);
  on('runs', () => { if (host) { clearTimeout(beat); beat = setTimeout(() => R.writeHost(host?.name, runs.size).catch(() => {}), 800); } });
  setInterval(paintRunOn, 15000);
  on('session', watchCurrent);
  on('user', onUser);
}
