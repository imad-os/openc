// Servers screen: saved Ollama servers (URL, key, label, last model) and adding new ones.
import { state, emit, on } from '../core/state.js';
import { $, h, toast, confirmDialog } from '../util/dom.js';
import { uid, fmt } from '../util/misc.js';
import { normalizeUrl } from '../core/ollama.js';
import { show } from './views.js';
import { loadModels, showModels } from './models.js';
import { enterWorkspace } from './workspace.js';
import { openAccount } from './modals.js';

const host = u => { try { return new URL(u).host; } catch { return u; } };

export function initConnect() {
  $('#c-form').addEventListener('submit', onSubmit);
  $('#c-account').addEventListener('click', openAccount);
  $('#c-cors').addEventListener('click', () => openCorsTester($('#c-url').value.trim() || 'http://localhost:11434', $('#c-key').value.trim(), $('#c-proxy').checked ? $('#c-proxy-url').value.trim() : ''));
  $('#c-proxy').addEventListener('change', paintProxyBox);
  $('#c-url').addEventListener('input', paintProxyBox);
  paintProxyBox();
  on('user', paintAccountButton);
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
  paintAccountButton();
  $('#c-err').hidden = true;
  await paintSaved();
}

async function paintSaved() {
  const box = $('#c-saved');
  box.innerHTML = '';
  let list = [];
  try { list = await state.store.listConnections(); }
  catch (e) { box.append(h('div', { class: 'msgbox err' }, 'Could not load saved servers: ' + e.message)); }
  if (!list.length) { setTimeout(() => $('#c-url').focus()); return; }
  box.append(h('div', { class: 'sec-title' }, 'Your servers'));
  for (const c of list) {
    box.append(h('div', { class: 'conn' },
      h('button', { class: 'conn-main', type: 'button', title: c.lastModel ? `Connect and continue with ${c.lastModel}` : 'Connect', onclick: () => connect(c, { resume: true }) },
        h('b', {}, c.label || host(c.url)),
        h('span', { class: 'dim small' }, c.url + (c.key ? ' · 🔑 key saved' : '') + (c.proxy ? ` · via proxy ${c.proxyUrl}` : '')),
        h('span', { class: 'dim small' }, (c.lastModel ? '▸ ' + c.lastModel : 'No model chosen yet') + (c.lastUsed ? ' · ' + fmt.ago(c.lastUsed) : ''))),
      h('div', { class: 'conn-act' },
        h('button', { class: 'btn sm', type: 'button', onclick: () => connect(c, { resume: false }) }, 'Models'),
        h('button', { class: 'btn sm ghost', type: 'button', title: 'Test CORS / connection in a new tab', onclick: () => openCorsTester(c.url, c.key, c.proxy ? c.proxyUrl : '') }, '🩺'),
        h('button', { class: 'btn sm ghost', type: 'button', title: 'Edit', onclick: () => fillForm(c) }, '✎'),
        h('button', { class: 'btn sm ghost danger', type: 'button', title: 'Remove', onclick: () => removeConn(c) }, '×'))));
  }
}

/** Show the proxy URL field and the exact command to start the proxy for the entered server. */
function paintProxyBox() {
  const on = $('#c-proxy').checked;
  $('#c-proxy-box').hidden = !on;
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
  $('#c-proxy').checked = !!c.proxy;
  if (c.proxyUrl) $('#c-proxy-url').value = c.proxyUrl;
  paintProxyBox();
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
  const proxy = $('#c-proxy').checked;
  const proxyUrl = $('#c-proxy-url').value.trim() || 'http://localhost:11435';
  const conn = { ...(existing || {}), id: existing?.id || uid(), url, key, label: label || existing?.label || '', created: existing?.created || Date.now(), proxy, proxyUrl: proxy ? proxyUrl : (existing?.proxyUrl || '') };
  if (!$('#c-savekey').checked) conn._noKey = true;
  connect(conn, { resume: false });
}

/** Save a server (without the key if the user opted out). */
export async function persistConn(c) {
  const data = { ...c };
  if (c._noKey) data.key = '';
  delete data._noKey;
  try { await state.store.saveConnection(data); } catch (e) { toast('Could not save server: ' + e.message); }
}

export async function connect(conn, { resume }) {
  const err = $('#c-err');
  const buttons = [...document.querySelectorAll('#v-connect button')];
  err.hidden = true;
  buttons.forEach(b => { b.disabled = true; });
  $('#c-go').textContent = 'Connecting…';
  try {
    state.conn = conn;
    state.model = null;
    await loadModels();
    conn.lastUsed = Date.now();
    await persistConn(conn);
    try { state.modelMeta = await state.store.listModelMeta(conn.url); } catch { state.modelMeta = {}; }
    emit('conn');
    if (resume && conn.lastModel && state.models.some(m => m.name === conn.lastModel)) {
      state.model = conn.lastModel;
      emit('model');
      enterWorkspace();
    } else showModels();
  } catch (e) {
    state.conn = null;
    err.hidden = false;
    err.replaceChildren();
    err.append(`Could not connect to ${conn.url}: ${e.message}\n\nChecklist:\n• Is Ollama running and reachable from this browser?\n• CORS: start Ollama with OLLAMA_ORIGINS="*" (or this site's origin)\n• If this page is https, the API must be https too (browsers block mixed content)\n• If the server needs an API key, enter it\n\n`,
      h('button', { class: 'btn sm primary', type: 'button', onclick: () => openCorsTester(conn.url, conn.key, conn.proxy ? conn.proxyUrl : '') }, '🩺 Diagnose with the CORS tester ↗'),
      conn.proxy ? '' : h('button', { class: 'btn sm', type: 'button', style: { marginLeft: '6px' }, onclick: () => { fillForm(conn); $('#c-proxy').checked = true; paintProxyBox(); $('#c-proxy-box').scrollIntoView({ block: 'center' }); } }, 'Use CORS proxy instead'));
  } finally {
    buttons.forEach(b => { b.disabled = false; });
    $('#c-go').textContent = 'Connect';
  }
}
