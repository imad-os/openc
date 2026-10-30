// Workspace chrome: top bar (model switcher, permissions), agent pills, status line, sidebar footer.
import { state, on, primaryAgents, subagents, currentAgent, modelCaps, modelInfo, saveSettings } from '../core/state.js';
import { $, h, popover, toast } from '../util/dom.js';
import { fmt } from '../util/misc.js';
import { show } from './views.js';
import { showModels, pickModel, starsEl, capTag, meta, statsText, strengthEl, sortModels } from './models.js';
import { paintSessions, renderSession, draftSession, newSession } from './sessions.js';
import { refreshFiles } from './files.js';
import { openSettings, openAgents, openAccount } from './modals.js';
import { showConnect } from './connect.js';

let lastStats = null;

export function initWorkspace() {
  $('#mchip').addEventListener('click', e => openModelPicker(e.currentTarget));
  $('#perm').addEventListener('change', e => { state.settings.perm = e.target.value; saveSettings(); });
  $('#t-left').addEventListener('click', () => $('#left').classList.toggle('open'));
  $('#t-right').addEventListener('click', () => $('#right').classList.toggle('open'));
  $('#chat').addEventListener('click', () => $('#left').classList.remove('open'));
  $('#scrim').addEventListener('click', () => { $('#left').classList.remove('open'); $('#right').classList.remove('open'); });
  const syncScrim = () => $('#scrim').classList.toggle('on', $('#left').classList.contains('open') || $('#right').classList.contains('open'));
  for (const id of ['#left', '#right']) new MutationObserver(syncScrim).observe($(id), { attributes: true, attributeFilter: ['class'] });
  $('#b-new').addEventListener('click', newSession);
  $('#b-models').addEventListener('click', showModels);
  $('#b-servers').addEventListener('click', () => { if (state.busy) return toast('Stop the agent first'); showConnect(); });
  $('#b-agents').addEventListener('click', openAgents);
  $('#b-set').addEventListener('click', () => openSettings());
  $('#b-display').addEventListener('click', () => openSettings('display'));
  $('#acct').addEventListener('click', openAccount);
  on('settings', () => { $('#perm').value = state.settings.perm; updateStatus(); });
  on('model', updateTop);
  on('models', updateTop);
  on('model-meta', updateTop);
  on('agents', () => { paintAgents(); updateStatus(); });
  on('llm-stats', s => { lastStats = s; updateStatus(); });
  on('busy', updateStatus);
  on('user', paintAccount);
}

export function enterWorkspace() {
  show('ws');
  $('#srv').textContent = (state.conn.label ? state.conn.label + ' · ' : '') + state.conn.url;
  if (!state.session) state.session = draftSession();
  lastStats = null;
  paintAgents();
  paintSessions();
  renderSession();
  updateTop();
  refreshFiles();
  paintAccount();
  setTimeout(() => $('#inp').focus());
}

export function setAgent(id) {
  if (!primaryAgents().some(a => a.id === id)) return;
  state.agentId = id;
  try { localStorage.setItem('oc2.agent', id); } catch { /* ignore */ }
  paintAgents();
  updateStatus();
}

export function cycleAgent() {
  const list = primaryAgents();
  const i = list.findIndex(a => a.id === state.agentId);
  setAgent(list[(i + 1) % list.length].id);
}

export function paintAgents() {
  const box = $('#pills');
  box.innerHTML = '';
  primaryAgents().forEach(a => box.append(h('button', {
    class: 'pill' + (a.id === state.agentId ? ' on' : ''), type: 'button', title: a.desc, onclick: () => setAgent(a.id),
  }, a.name)));
  const subs = subagents().map(a => a.name).join(', ');
  box.append(h('span', { class: 'dim small' }, subs ? 'subagents: ' + subs : ''));
}

export function updateTop() {
  const chip = $('#mchip');
  const m = modelInfo();
  chip.replaceChildren(...[
    meta(state.model).fav ? h('span', { class: 'favdot' }, '♥') : null,
    h('b', {}, state.model || 'Choose a model'),
    state.model ? strengthEl(state.model, { bar: false }) : null,
    ...(m?.caps || []).filter(c => c !== 'completion').map(c => capTag(c, true)),
    h('span', { class: 'caret' }, '▾'),
  ].filter(Boolean));
  $('#perm').value = state.settings.perm;
  $('#b-att').hidden = !modelCaps().includes('vision');
  updateStatus();
}

export function updateStatus() {
  if (!state.conn) return;
  const caps = modelCaps();
  const agent = currentAgent();
  const left = [h('b', {}, agent?.name || ''), ' · ' + (state.model || 'no model')];
  if (caps.length && !caps.includes('tools') && agent?.tools?.length) left.push(h('span', { class: 'warn' }, ' · model has no tool calling (chat only)'));
  if (state.busy) left.push(' · working… (Esc to stop)');
  $('#st-l').replaceChildren(...left);

  const right = [];
  if (lastStats) {
    if (lastStats.tps) right.push(lastStats.tps.toFixed(1) + ' tok/s');
    const used = lastStats.prompt + lastStats.output;
    right.push(h('span', { class: used / state.settings.num_ctx > 0.8 ? 'warn' : '' }, `ctx ${fmt.num(used)} / ${fmt.num(state.settings.num_ctx)}`));
  } else right.push(`ctx limit ${fmt.num(state.settings.num_ctx)}`);
  if (state.session?.summary) right.push('compacted');
  $('#st-r').replaceChildren(...right.flatMap((x, i) => (i ? [' · ', x] : [x])));
}

export function paintAccount() {
  const el = $('#acct');
  const u = state.user;
  el.replaceChildren(
    h('span', { class: 'avatar' }, u?.photoURL ? h('img', { src: u.photoURL, alt: '', referrerpolicy: 'no-referrer' }) : (u?.email || 'L')[0].toUpperCase()),
    h('span', { class: 'ellipsis small' }, u ? (u.email || u.displayName || 'Signed in') : 'Local mode · sign in to sync'));
}

function openModelPicker(anchor) {
  if (!state.models.length) return showModels();
  popover(anchor, (el, close) => {
    const q = h('input', { placeholder: 'Search models…' });
    const list = h('div', { class: 'pop-list' });
    const row = m => h('div', {
      class: 'pop-row' + (m.name === state.model ? ' on' : ''),
      onclick: () => { close(); if (state.busy) return toast('Stop the agent before switching models'); pickModel(m.name, { stay: true }); },
    },
    h('div', { class: 'pr-main' }, h('span', { class: 'pr-name' }, m.name), ...(m.caps || []).filter(c => c !== 'completion').map(c => capTag(c, true))),
    h('div', { class: 'pr-sub' }, strengthEl(m.name), starsEl(m.name, { readonly: true }), h('span', { class: 'dim small' }, statsText(m.name, true))));
    const paint = () => {
      list.innerHTML = '';
      const term = q.value.toLowerCase();
      const ms = state.models.filter(m => !term || m.name.toLowerCase().includes(term));
      const favs = sortModels(ms.filter(m => meta(m.name).fav), 'rating');
      const recent = sortModels(ms.filter(m => !meta(m.name).fav && meta(m.name).lastUsed), 'recent').slice(0, 5);
      const shown = new Set([...favs, ...recent]);
      const rest = sortModels(ms.filter(m => !shown.has(m)), 'strength');
      const section = (title, arr) => { if (arr.length) { list.append(h('div', { class: 'pop-sec' }, title)); arr.forEach(m => list.append(row(m))); } };
      section('♥ Favorites', favs);
      section('Recently used', recent);
      section('All models · strongest first', rest);
      if (!ms.length) list.append(h('div', { class: 'dim pad' }, 'No models match.'));
    };
    q.addEventListener('input', paint);
    el.append(q, list, h('button', { class: 'btn sm ghost wide', type: 'button', onclick: () => { close(); showModels(); } }, 'All models, ratings and stats →'));
    paint();
    setTimeout(() => q.focus());
  });
}
