// Servers screen: saved Ollama servers (URL, key, label, last model) and adding new ones.
import { state, emit, on } from '../core/state.js';
import { getActiveProxyUrl, getDisplayProxy, setUseProxy, upsertSingleProxyUrl, proxyLabel } from '../core/proxy.js';
import { $, h, toast, confirmDialog } from '../util/dom.js';
import { uid, fmt } from '../util/misc.js';
import { normalizeUrl } from '../core/ollama.js';
import { show } from './views.js';
import { loadModels, showModels } from './models.js';
import { enterWorkspace } from './workspace.js';
import { openSession } from './sessions.js';
import { openAccount } from './modals.js';
import { openProxyManager } from './proxies.js';
import { remoteTarget, loadRemoteModels, getRemoteCatalog, openRunOn, remoteSummary, remoteAvail } from './remote.js';

const host = u => { try { return new URL(u).host; } catch { return u; } };

export function initConnect() {
  $('#c-form').addEventListener('submit', onSubmit);
  $('#c-back').addEventListener('click', () => enterWorkspace());
  $('#c-account').addEventListener('click', openAccount);
  $('#c-cors').addEventListener('click', () => openCorsTester($('#c-url').value.trim() || 'http://localhost:11434', $('#c-key').value.trim(), getActiveProxyUrl()));
  $('#c-proxy').addEventListener('change', () => {
    setUseProxy($('#c-proxy').checked, $('#c-proxy-url').value.trim() || 'http://localhost:11435');
    paintProxyBox();
  });
  $('#c-proxy-url').addEventListener('change', () => {
    const val = $('#c-proxy-url').value.trim();
    if (val) upsertSingleProxyUrl(val);
  });
  $('#c-proxy-manage').addEventListener('click', openProxyManager);
  $('#c-url').addEventListener('input', paintProxyBox);
  paintProxyBox();
  on('proxy', paintProxyBox);
  on('settings', paintProxyBox);
  on('user', () => { paintAccountButton(); paintRemoteCard(); });
  on('hosts', paintRemoteCard);
  on('target', paintRemoteCard);
  setInterval(paintRemoteCard, 15000);
}

/** First-screen card: use a remote PC without reaching any Ollama server from this device. */
function paintRemoteCard() {
  const box = $('#c-remote');
  if (!box) return;
  box.hidden = !remoteAvail();
  if (box.hidden) return;
  const sum = remoteSummary();
  box.replaceChildren(
    h('div', { class: 'sec-title' }, '💻 Remote PC'),
    h('div', { class: 'dim small' }, 'Your phone cannot reach the PC’s Ollama? Let the PC (its browser tab in host mode) do the work. No direct connection to Ollama is needed here.'),
    sum ? h('div', { class: 'hcard sel' }, h('div', { class: 'hc-main' },
      h('div', { class: 'hc-top' }, h('span', { class: 'hdot ' + sum.key }), h('b', {}, sum.name), h('span', { class: 'hc-sel' }, '✓ In use')),
      h('div', { class: 'hc-status ' + sum.key }, sum.label))) : null,
    h('div', { class: 'row' },
      sum ? h('button', { class: 'btn primary', id: 'c-pc-go', type: 'button', style: { flex: '1' }, onclick: connectViaPC }, 'Continue with ' + sum.name) : null,
      h('button', { class: 'btn', type: 'button', style: sum ? {} : { flex: '1' }, onclick: () => openRunOn({ onPick: id => { if (id) connectViaPC(); } }) }, sum ? 'Change PC' : 'Choose a PC to connect')));
}

/** Open the models of the selected PC straight from its published catalog (saved server first, else the first one it lists). */
async function connectViaPC() {
  const err = $('#c-err');
  err.hidden = true;
  try {
    const cat = await getRemoteCatalog();
    const servers = cat?.servers || [];
    if (!servers.length) throw new Error('The PC has not published any server yet. Open the app on the PC, sign in with this account, and switch on "Use this device as a remote host".');
    let saved = [];
    try { saved = await state.store.listConnections(); } catch { /* ignore */ }
    const pick = [...saved].sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0)).find(c => servers.some(x => x.id === c.id || x.url === c.url))
      || { id: servers[0].id, url: servers[0].url, key: '', label: '', created: Date.now(), lastUsed: 0 };
    await connect(pick, { resume: true });
  } catch (e) {
    err.hidden = false;
    err.textContent = e.message;
  }
}

function paintAccountButton() {
  $('#c-account').textContent = state.user ? (state.user.email || state.user.displayName || 'Account') : 'Local mode · Account';
}

/** Open the standalone CORS tester (cors-test.html) in a new tab. The key is handed over via localStorage, never the URL. */
export function openCorsTester(url, key = '', proxy = '') {
  try { if (key) localStorage.setItem('oc2.corsKey', key); } catch { /* ignore */ }
  window.open(`cors-test.html?url=${encodeURIComponent(normalizeUrl(url))}${proxy ? '&proxy=' + encodeURIComponent(proxy) : ''}`, '_blank');
}

export async function showConnect() {
  show('connect');
  $('#c-back').hidden = !state.store;
  paintAccountButton();
  paintRemoteCard();
  paintProxyBox();
  $('#c-err').hidden = true;
  await paintSaved();
  const body = $('.connect-body');
  if (body) body.scrollTop = 0;
}

async function paintSaved() {
  const box = $('#c-saved');
  box.innerHTML = '';
  let list = [];
  try { list = await state.store.listConnections(); }
  catch (e) { box.append(h('div', { class: 'msgbox err' }, 'Could not load saved servers: ' + e.message)); }
  if (!list.length) { setTimeout(() => $('#c-url').focus()); return; }
  box.append(h('div', { class: 'sec-title' }, 'Your servers'));
  const scroller = h('div', { class: 'saved-list' });
  for (const c of list) {
    scroller.append(h('div', { class: 'conn' },
      h('button', { class: 'conn-main', type: 'button', title: c.lastModel ? `Connect and continue with ${c.lastModel}` : 'Connect', onclick: () => connect(c, { resume: true }) },
        h('b', {}, c.label || host(c.url)),
        h('span', { class: 'dim small' }, c.url + (c.key ? ' · 🔑 key saved' : '')),
        h('span', { class: 'dim small' }, (c.lastModel ? '▸ ' + c.lastModel : 'No model chosen yet') + (c.lastUsed ? ' · ' + fmt.ago(c.lastUsed) : ''))),
      h('div', { class: 'conn-act' },
        h('button', { class: 'btn sm', type: 'button', onclick: () => connect(c, { resume: false }) }, 'Models'),
        h('button', { class: 'btn sm ghost', type: 'button', title: 'Test CORS / connection in a new tab', onclick: () => openCorsTester(c.url, c.key, getActiveProxyUrl()) }, '🩺'),
        h('button', { class: 'btn sm ghost', type: 'button', title: 'Edit', onclick: () => fillForm(c) }, '✎'),
        h('button', { class: 'btn sm ghost danger', type: 'button', title: 'Remove', onclick: () => removeConn(c) }, '×'))));
  }
  box.append(scroller);
}

/** Show the global proxy URL field and the exact command to start the proxy for the entered server. */
function paintProxyBox() {
  const cb = $('#c-proxy');
  const box = $('#c-proxy-box');
  const urlEl = $('#c-proxy-url');
  const nameEl = $('#c-proxy-name');
  if (!cb || !box) return;
  const on = !!state.settings.useProxy;
  cb.checked = on;
  box.hidden = !on;
  const cur = getDisplayProxy();
  if (document.activeElement !== urlEl) {
    urlEl.value = cur?.url || 'http://localhost:11435';
  }
  if (nameEl) nameEl.textContent = cur?.label ? `(${proxyLabel(cur)})` : '';
  if (!on) return;
  let target = 'http://127.0.0.1:11434';
  try { target = normalizeUrl($('#c-url').value || target); } catch { /* keep default */ }
  const script = new URL('proxy/ollama-cors-proxy.mjs', location.href).href;
  const isDefault = /^http:\/\/(localhost|127\.0\.0\.1):11434$/.test(target);
  $('#c-proxy-cmd').textContent = `curl -fsSLO ${script}\nnode ollama-cors-proxy.mjs${isDefault ? '' : ' --target ' + target}`;
}

function fillForm(c) {
  $('#c-url').value = c.url;
  $('#c-key').value = c.key || '';
  $('#c-label').value = c.label || '';
  $('#c-url').focus();
}

async function removeConn(c) {
  if (!(await confirmDialog(`Remove ${c.label || c.url}? Model ratings for it are kept.`, 'Remove'))) return;
  try { await state.store.deleteConnection(c.id); } catch (e) { return toast(e.message); }
  paintSaved();
}

async function onSubmit(e) {
  e.preventDefault();
  const url = normalizeUrl($('#c-url').value);
  const key = $('#c-key').value.trim();
  const label = $('#c-label').value.trim();
  let list = [];
  try { list = await state.store.listConnections(); } catch { /* ignore */ }
  const existing = list.find(c => c.url === url);
  if ($('#c-proxy').checked) {
    const pUrl = $('#c-proxy-url').value.trim() || 'http://localhost:11435';
    upsertSingleProxyUrl(pUrl);
  }
  const conn = { ...(existing || {}), id: existing?.id || uid(), url, key, label: label || existing?.label || '', created: existing?.created || Date.now() };
  delete conn.proxy;
  delete conn.proxyUrl;
  if (!$('#c-savekey').checked) conn._noKey = true;
  connect(conn, { resume: false });
}

/** Save a server (without the key if the user opted out). */
export async function persistConn(c, { quiet = false } = {}) {
  const data = { ...c };
  if (c._noKey) data.key = '';
  delete data._noKey;
  try {
    await state.store.saveConnection(data);
    if (!quiet) toast(state.store.kind === 'cloud' ? '✓ Server saved to your Firebase account' : '✓ Server saved in this browser (sign in to sync it to Firebase)', 3500);
    return true;
  } catch (e) {
    toast('✗ Could not save server: ' + e.message, 7000);
    return false;
  }
}

export async function connect(conn, { resume, restore = null }) {
  const err = $('#c-err');
  const buttons = [...document.querySelectorAll('#v-connect button')];
  err.hidden = true;
  buttons.forEach(b => { b.disabled = true; });
  $('#c-go').textContent = 'Connecting…';
  try {
    state.conn = conn;
    state.model = null;
    if (remoteTarget()) {
      // Remote PC mode: save first, then ask the PC to list the server's models.
      conn.lastUsed = Date.now();
      await persistConn(conn);
      await loadRemoteModels(conn, { wait: true });
    } else {
      await loadModels();
      conn.lastUsed = Date.now();
      await persistConn(conn);
    }
    try { state.modelMeta = await state.store.listModelMeta(conn.url); } catch { state.modelMeta = {}; }
    emit('conn');
    if (restore) {
      // coming back after a refresh: return to the screen / conversation from the address
      if (restore.to === 'chat' && restore.model && state.models.some(m => m.name === restore.model)) {
        state.model = restore.model;
        emit('model');
        enterWorkspace();
        if (restore.session) await openSession(restore.session);
      } else showModels();
    } else if (resume && conn.lastModel && state.models.some(m => m.name === conn.lastModel)) {
      state.model = conn.lastModel;
      emit('model');
      enterWorkspace();
    } else showModels();
  } catch (e) {
    state.conn = null;
    err.hidden = false;
    err.replaceChildren();
    const activeProxy = getActiveProxyUrl();
    err.append(`Could not connect to ${conn.url}: ${e.message}\n\nChecklist:\n• Is Ollama running and reachable from this browser?\n• CORS: start Ollama with OLLAMA_ORIGINS="*" (or this site's origin)\n• If this page is https, the API must be https too (browsers block mixed content)\n• If the server needs an API key, enter it\n\n`,
      h('button', { class: 'btn sm primary', type: 'button', onclick: () => openCorsTester(conn.url, conn.key, activeProxy) }, '🩺 Diagnose with the CORS tester ↗'),
      activeProxy ? '' : h('button', { class: 'btn sm', type: 'button', style: { marginLeft: '6px' }, onclick: () => { setUseProxy(true, $('#c-proxy-url').value.trim() || 'http://localhost:11435'); paintProxyBox(); $('#c-proxy-box').scrollIntoView({ block: 'center' }); } }, 'Use CORS proxy instead'));
  } finally {
    buttons.forEach(b => { b.disabled = false; });
    $('#c-go').textContent = 'Connect';
  }
}
