// Global CORS proxy state & management (applies to all Ollama servers).
import { state, emit, saveSettings } from './state.js';
import { uid } from '../util/misc.js';

const hostOf = u => { try { return new URL(u).host; } catch { return u || ''; } };

export function normalizeProxyUrl(u) {
  u = String(u || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  return u.includes('{url}') ? u : u.replace(/\/+$/, '');
}

export const proxyLabel = p => (p?.label && p.label.trim()) || hostOf(p?.url) || 'Proxy';

export const getProxies = () => (Array.isArray(state.settings.proxies) ? state.settings.proxies : []);

export function getDefaultProxy() {
  const list = getProxies();
  return list.find(p => p.id === state.settings.defaultProxyId) || null;
}

export function getActiveProxy() {
  if (!state.settings.useProxy) return null;
  const list = getProxies();
  return list.find(p => p.id === state.settings.activeProxyId)
    || getDefaultProxy()
    || list[0]
    || null;
}

export function getDisplayProxy() {
  const list = getProxies();
  return list.find(p => p.id === state.settings.activeProxyId)
    || getDefaultProxy()
    || list[0]
    || null;
}

export function getActiveProxyUrl() {
  return String(getActiveProxy()?.url || '').trim();
}

function commitProxyChange() {
  emit('proxy');
  return saveSettings();
}

export function setUseProxy(enabled, fallbackUrl = 'http://localhost:11435') {
  const on = !!enabled;
  state.settings.useProxy = on;
  if (on) {
    const list = getProxies();
    let target = list.find(p => p.id === state.settings.activeProxyId) || getDefaultProxy() || list[0];
    if (!target) {
      const clean = normalizeProxyUrl(fallbackUrl);
      if (clean) {
        target = { id: uid(), label: '', url: clean };
        state.settings.proxies = [target];
        state.settings.defaultProxyId = target.id;
      }
    }
    state.settings.activeProxyId = target?.id || '';
  }
  return commitProxyChange();
}

export function selectProxy(id) {
  if (!id) {
    state.settings.useProxy = false;
    state.settings.activeProxyId = '';
  } else {
    const exists = getProxies().find(p => p.id === id);
    if (!exists) return Promise.resolve();
    state.settings.useProxy = true;
    state.settings.activeProxyId = id;
  }
  return commitProxyChange();
}

export function setDefaultProxy(id) {
  if (!id) {
    state.settings.defaultProxyId = '';
    state.settings.activeProxyId = '';
    state.settings.useProxy = false;
  } else {
    const exists = getProxies().find(p => p.id === id);
    if (!exists) return Promise.resolve();
    state.settings.defaultProxyId = id;
    state.settings.activeProxyId = id;
    state.settings.useProxy = true;
  }
  return commitProxyChange();
}

export function upsertSingleProxyUrl(rawUrl) {
  const url = normalizeProxyUrl(rawUrl);
  if (!url) return Promise.resolve(null);
  const list = [...getProxies()];
  const cur = list.find(p => p.id === state.settings.activeProxyId) || getDefaultProxy() || list[0] || null;
  let updated;
  if (cur) {
    updated = { ...cur, url };
    state.settings.proxies = list.map(p => (p.id === cur.id ? updated : p));
    state.settings.activeProxyId = cur.id;
    if (!state.settings.defaultProxyId) state.settings.defaultProxyId = cur.id;
  } else {
    updated = { id: uid(), label: '', url };
    state.settings.proxies = [updated];
    state.settings.defaultProxyId = updated.id;
    state.settings.activeProxyId = updated.id;
  }
  commitProxyChange();
  return updated;
}

export function saveProxyItem({ id = '', label = '', url, makeDefault = false }) {
  const cleanUrl = normalizeProxyUrl(url);
  if (!cleanUrl) throw new Error('Proxy URL is required');
  try { new URL(cleanUrl.replace('{url}', 'http://localhost:11434')); }
  catch { throw new Error('Enter a valid proxy URL'); }
  const cleanLabel = String(label || '').trim().slice(0, 80);
  const list = [...getProxies()];
  let item;
  if (id && list.some(p => p.id === id)) {
    item = { id, label: cleanLabel, url: cleanUrl };
    state.settings.proxies = list.map(p => (p.id === id ? item : p));
  } else {
    item = { id: uid(), label: cleanLabel, url: cleanUrl };
    state.settings.proxies = [...list, item];
  }
  if (makeDefault || (!state.settings.defaultProxyId && state.settings.proxies.length === 1)) {
    state.settings.defaultProxyId = item.id;
    state.settings.activeProxyId = item.id;
    state.settings.useProxy = true;
  }
  commitProxyChange();
  return item;
}

export function deleteProxyItem(id) {
  const list = getProxies().filter(p => p.id !== id);
  state.settings.proxies = list;
  if (state.settings.defaultProxyId === id) {
    state.settings.defaultProxyId = list[0]?.id || '';
  }
  if (state.settings.activeProxyId === id) {
    state.settings.activeProxyId = state.settings.defaultProxyId || list[0]?.id || '';
    if (!state.settings.activeProxyId) state.settings.useProxy = false;
  }
  return commitProxyChange();
}

/** One-time migration from legacy per-server conn.proxy / conn.proxyUrl to global proxies. */
export async function migrateLegacyProxies() {
  if (getProxies().length || state.settings.useProxy) return;
  let conns = [];
  try { conns = await state.store?.listConnections() || []; } catch { return; }
  const seen = new Map();
  let activeUrl = '';
  for (const c of conns) {
    const u = normalizeProxyUrl(c.proxyUrl);
    if (!u) continue;
    if (!seen.has(u)) seen.set(u, { id: uid(), label: '', url: u });
    if (c.proxy && !activeUrl) activeUrl = u;
  }
  if (!seen.size) return;
  state.settings.proxies = [...seen.values()];
  const chosen = (activeUrl && seen.get(activeUrl)) || state.settings.proxies[0];
  state.settings.defaultProxyId = chosen.id;
  if (activeUrl) {
    state.settings.activeProxyId = chosen.id;
    state.settings.useProxy = true;
  }
  await commitProxyChange();
}
