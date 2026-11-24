// Remote control data layer (Firestore only). A PC browser tab acts as a "host": it keeps running
// agents. Other devices (your phone) send it commands and watch the conversation live.
//
//   users/{uid}/hosts/{hostId}      { name, lastSeen, busy }                 heartbeat of a host tab
//   users/{uid}/commands/{id}       { host, type, session, text, conn, model, agent, status, … }
//   users/{uid}/live/{sessionId}    { host, hostName, state, phase, detail, step, …, askKind, askText, … }
//
// Messages themselves travel through the normal sessions/{id}/messages documents.
import { state } from './state.js';

const HOST_KEY = 'oc2.hostId';
export const ONLINE_MS = 150000;   // a host is "online" if its heartbeat is newer than this
export const COMMAND_TTL = 12 * 3600 * 1000;

export const cloud = () => (state.store?.kind === 'cloud' ? state.store : null);
export const remoteAvailable = () => !!cloud();

/** Stable id of this browser (used when it acts as a host). */
export function hostId() {
  let id = '';
  try { id = localStorage.getItem(HOST_KEY) || ''; } catch { /* ignore */ }
  if (!id) {
    id = 'h' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    try { localStorage.setItem(HOST_KEY, id); } catch { /* ignore */ }
  }
  return id;
}

const clean = o => JSON.parse(JSON.stringify(o ?? null));
export const isOnline = h => !!h && Date.now() - (h.lastSeen || 0) < ONLINE_MS;

/** "Windows · Chrome", "Android · Chrome", … */
export function platformInfo() {
  const ua = navigator.userAgent || '';
  const os = navigator.userAgentData?.platform
    || (/Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown OS');
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return { os, text: `${os} · ${browser}` };
}
export const defaultHostName = () => `${platformInfo().os} PC`;

export async function writeHost(name, busy = 0) {
  const s = cloud();
  await s.F.setDoc(s.doc('hosts', hostId()), { name: String(name || defaultHostName()).slice(0, 60), platform: platformInfo().text.slice(0, 100), lastSeen: Date.now(), busy });
}
export async function removeHostById(id) {
  const s = cloud();
  await s.F.deleteDoc(s.doc('hosts', id));
}
/** All hosts of the account, live (heartbeats update lastSeen/busy). */
export function watchHosts(cb, onError) {
  const s = cloud();
  return s.F.onSnapshot(s.col('hosts'), snap => {
    cb(snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0)));
  }, onError);
}
export async function removeHost() {
  const s = cloud();
  if (s) await s.F.deleteDoc(s.doc('hosts', hostId()));
}
export async function listHosts() {
  const s = cloud();
  const q = await s.F.getDocs(s.col('hosts'));
  return q.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}
export async function getHost(id) {
  const s = cloud();
  const d = await s.F.getDoc(s.doc('hosts', id));
  return d.exists() ? { id: d.id, ...d.data() } : null;
}

export async function sendCommand(cmd) {
  const s = cloud();
  const ref = await s.F.addDoc(s.col('commands'), clean({ ...cmd, status: 'pending', created: Date.now() }));
  return ref.id;
}
export async function updateCommand(id, patch) {
  const s = cloud();
  await s.F.updateDoc(s.doc('commands', id), clean(patch));
}
export async function deleteCommand(id) {
  const s = cloud();
  await s.F.deleteDoc(s.doc('commands', id));
}

/** Host side: new pending commands addressed to this host. Returns an unsubscribe function. */
export function watchCommands(host, onCommand, onError) {
  const s = cloud(), F = s.F;
  const q = F.query(s.col('commands'), F.where('host', '==', host), F.where('status', '==', 'pending'));
  return F.onSnapshot(q, snap => {
    snap.docChanges().forEach(ch => { if (ch.type === 'added') onCommand({ id: ch.doc.id, ...ch.doc.data() }); });
  }, onError);
}

export async function writeLive(sessionId, data) {
  const s = cloud();
  await s.F.setDoc(s.doc('live', sessionId), clean({ ...data, updated: Date.now() }));
}

export function watchLive(sessionId, cb, onError) {
  const s = cloud();
  return s.F.onSnapshot(s.doc('live', sessionId), d => cb(d.exists() ? d.data() : null), onError);
}

function quickHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

const LIVE_MSG_MAX = 500000;
export async function writeLiveMessage(sessionId, seq, msg) {
  const s = cloud();
  if (!s) return;
  let m = { ...msg };
  let json = JSON.stringify(m);
  if (json.length > LIVE_MSG_MAX) {
    if (typeof m.content === 'string' && m.content.length > 200000) m.content = '…' + m.content.slice(-200000);
    if (typeof m.thinking === 'string' && m.thinking.length > 200000) m.thinking = '…' + m.thinking.slice(-200000);
    json = JSON.stringify(m);
    if (json.length > LIVE_MSG_MAX) json = JSON.stringify({ role: m.role || 'assistant', _agent: m._agent, _live: true, _started: m._started, thinking: String(m.thinking || '').slice(-100000), content: String(m.content || '').slice(-100000) });
  }
  await s.F.setDoc(s.doc('sessions', sessionId, 'messages', 'm' + String(seq).padStart(6, '0')), { seq, role: msg.role || 'assistant', json });
}

export async function deleteMessage(sessionId, seq) {
  const s = cloud();
  if (!s) return;
  await s.F.deleteDoc(s.doc('sessions', sessionId, 'messages', 'm' + String(seq).padStart(6, '0')));
}

/** Phone side: stored messages of a conversation, live. cb(messages, signature). */
export function watchMessages(sessionId, cb, onError) {
  const s = cloud(), F = s.F;
  return F.onSnapshot(F.query(s.col('sessions', sessionId, 'messages'), F.orderBy('seq')), snap => {
    const msgs = [];
    let sig = '';
    for (const d of snap.docs) {
      const raw = d.data().json || '';
      sig += d.id + ':' + raw.length + ':' + quickHash(raw) + ';';
      try { msgs.push(JSON.parse(raw)); } catch { /* skip */ }
    }
    cb(msgs, sig);
  }, onError);
}

export function watchSessionDoc(sessionId, cb, onError) {
  const s = cloud();
  return s.F.onSnapshot(s.doc('sessions', sessionId), d => cb(d.exists() ? { id: d.id, ...d.data() } : null), onError);
}

export function watchSessions(cb, onError) {
  const s = cloud(), F = s.F;
  return F.onSnapshot(F.query(s.col('sessions'), F.orderBy('updated', 'desc'), F.limit(300)), snap => {
    cb(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  }, onError);
}

/* ---------- model catalog: what each server offers, as seen from the PC ---------- */
export async function writeCatalog(servers) {
  const s = cloud();
  await s.F.setDoc(s.doc('catalogs', hostId()), clean({ servers, updated: Date.now() }));
}
export async function getCatalog(host) {
  const s = cloud();
  const d = await s.F.getDoc(s.doc('catalogs', host));
  return d.exists() ? d.data() : null;
}
