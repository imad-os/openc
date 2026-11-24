// Workspace chrome: top bar (model switcher, permissions, mobile more menu), mode + thinking dropdowns, status line, sidebar footer.
import { state, bus, emit, on, primaryAgents, subagents, currentAgent, modelCaps, modelInfo, saveSettings, isCloudModel, THINK_OPTIONS, thinkLabel, saveSessionThink } from '../core/state.js';
import { $, h, popover, toast } from '../util/dom.js';
import { fmt } from '../util/misc.js';
import { show } from './views.js';
import { showModels, loadModels, pickModel, starsEl, capTag, meta, statsText, strengthEl, sortModels, reliabilityEl, pickerItems, isMerged } from './models.js';
import { loadServers, serverLabel, adoptActive } from './servers.js';
import { paintSessions, renderSession, draftSession, newSession, openSession, saveSessionMeta } from './sessions.js';
import { refreshFiles } from './files.js';
import { openSettings, openAgents, openAccount } from './modals.js';
import { showConnect } from './connect.js';
import { openRunningList, isRunning } from './runs.js';
import { display, setDisplay } from './display.js';
import { initProxies, openProxyPicker, paintProxyControls } from './proxies.js';
import { getActiveProxy, proxyLabel } from '../core/proxy.js';
import { maxConfig, clampN } from '../agent/max.js';
import { openMax } from './max.js';
import { remoteAvail, openRunOn } from './remote.js';

let lastStats = null;

export function initWorkspace() {
  $('#mchip').addEventListener('click', e => openModelPicker(e.currentTarget));
  $('#perm').addEventListener('change', e => { state.settings.perm = e.target.value; saveSettings(); });
  $('#t-left').addEventListener('click', () => $('#left').classList.toggle('open'));
  $('#t-right').addEventListener('click', () => { $('#right').classList.toggle('open'); $('#t-right').classList.remove('has-new'); $('#t-more')?.classList.remove('has-new'); });
  $('#t-more')?.addEventListener('click', e => openMoreMenu(e.currentTarget));
  const toggleFiles = () => { setDisplay({ showFiles: !display.showFiles }); paintFilesBtn(); };
  $('#t-files').addEventListener('click', toggleFiles);
  document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === '.') { e.preventDefault(); toggleFiles(); } });
  on('display', paintFilesBtn);
  on('fs-changed', () => {
    if (!display.showFiles) $('#t-files').classList.add('has-new');
    if (!$('#right').classList.contains('open')) {
      $('#t-right').classList.add('has-new');
      $('#t-more')?.classList.add('has-new');
    }
  });
  paintFilesBtn();
  $('#chat').addEventListener('click', () => $('#left').classList.remove('open'));
  $('#scrim').addEventListener('click', () => { $('#left').classList.remove('open'); $('#right').classList.remove('open'); });
  const syncScrim = () => $('#scrim').classList.toggle('on', $('#left').classList.contains('open') || $('#right').classList.contains('open'));
  for (const id of ['#left', '#right']) new MutationObserver(syncScrim).observe($(id), { attributes: true, attributeFilter: ['class'] });
  $('#b-new').addEventListener('click', newSession);
  $('#b-models').addEventListener('click', showModels);
  $('#b-servers').addEventListener('click', showConnect);
  $('#running').addEventListener('click', e => openRunningList(e.currentTarget, openSession));
  $('#b-agents').addEventListener('click', openAgents);
  $('#b-set').addEventListener('click', () => openSettings());
  $('#b-display').addEventListener('click', () => openSettings('display'));
  $('#acct').addEventListener('click', openAccount);
  $('#proxybtn').addEventListener('click', e => openProxyPicker(e.currentTarget));
  $('#srv-proxy').addEventListener('click', e => openProxyPicker(e.currentTarget));
  initProxies();
  paintProxyControls();
  on('settings', () => { $('#perm').value = state.settings.perm; paintAgents(); updateStatus(); });
  on('conn', () => { paintServer(); updateTop(); });
  on('model', updateTop);
  on('models', updateTop);
  on('servers', updateTop);
  on('model-meta', updateTop);
  on('agents', () => { paintAgents(); updateStatus(); });
  on('think', () => { paintAgents(); updateStatus(); });
  on('llm-stats', s => { lastStats = s; updateStatus(); });
  on('session', s => { lastStats = s?._lastStats || null; paintAgents(); updateStatus(); });
  on('busy', updateStatus);
  on('user', paintAccount);
}

function paintServer() {
  const el = $('#srv');
  if (!el) return;
  el.textContent = state.conn ? (state.conn.label ? state.conn.label + ' · ' : '') + state.conn.url : 'No server selected';
}

function paintFilesBtn() {
  const b = $('#t-files');
  b.classList.toggle('on', display.showFiles);
  b.textContent = display.showFiles ? 'Hide files' : 'Files';
  if (display.showFiles) b.classList.remove('has-new');
}

export function enterWorkspace() {
  show('ws');
  paintServer();
  if (!state.session) state.session = draftSession();
  lastStats = null;
  paintAgents();
  paintSessions();
  renderSession();
  updateTop();
  refreshFiles();
  paintAccount();
  paintProxyControls();
  setTimeout(() => $('#inp').focus());
}

export function setAgent(id, { syncSession = true } = {}) {
  if (!primaryAgents().some(a => a.id === id)) return;
  state.agentId = id;
  try { sessionStorage.setItem('oc2.agent', id); } catch { /* ignore */ }
  emit('agent', id);
  if (syncSession && state.session) {
    state.session.agent = id;
    saveSessionMeta(state.session);
  }
  paintAgents();
  updateStatus();
}

export function setThink(level, { syncSession = true, save = true } = {}) {
  const valid = THINK_OPTIONS.some(([k]) => k === level) ? level : 'auto';
  state.think = valid;
  try { sessionStorage.setItem('oc2.think', valid); } catch { /* ignore */ }
  emit('think', valid);
  if (syncSession && state.session) {
    state.session.think = valid;
    saveSessionThink(state.session.id, valid);
  }
  state.settings.think = valid;
  if (save && state.store) saveSettings();
  paintAgents();
  updateStatus();
}

export function cycleAgent() {
  const list = primaryAgents();
  const i = list.findIndex(a => a.id === state.agentId);
  setAgent(list[(i + 1) % list.length].id);
}

function openAgentMenu(anchor) {
  popover(anchor, (el, close) => {
    const list = h('div', { class: 'pop-list' });
    list.append(h('div', { class: 'pop-sec' }, 'Mode'));
    for (const a of primaryAgents()) {
      const onNow = a.id === state.agentId;
      list.append(h('div', {
        class: 'pop-row' + (onNow ? ' on' : ''),
        onclick: () => { close(); setAgent(a.id); },
      },
      h('div', { class: 'pr-main' }, h('span', { class: 'pr-name' }, a.name), onNow ? h('span', { class: 'dim small', style: { marginLeft: 'auto' } }, '✓') : null),
      a.desc ? h('div', { class: 'dim small' }, a.desc) : null));
    }
    el.append(list);
  });
}

function openThinkMenu(anchor) {
  const cur = state.think || 'auto';
  popover(anchor, (el, close) => {
    const list = h('div', { class: 'pop-list' });
    list.append(h('div', { class: 'pop-sec' }, 'Thinking level'));
    for (const [val, label, desc] of THINK_OPTIONS) {
      const onNow = val === cur;
      list.append(h('div', {
        class: 'pop-row' + (onNow ? ' on' : ''),
        onclick: () => { close(); setThink(val); },
      },
      h('div', { class: 'pr-main' }, h('span', { class: 'pr-name' }, label), onNow ? h('span', { class: 'dim small', style: { marginLeft: 'auto' } }, '✓') : null),
      h('div', { class: 'dim small' }, desc)));
    }
    el.append(list);
  });
}

function openMoreMenu(anchor) {
  popover(anchor, (el, close) => {
    const px = state.settings.useProxy ? getActiveProxy() : null;
    const mx = maxConfig();
    const permSel = h('select', {},
      h('option', { value: 'ask', selected: state.settings.perm === 'ask' }, 'Ask before changes'),
      h('option', { value: 'edits', selected: state.settings.perm === 'edits' }, 'Auto-accept edits'),
      h('option', { value: 'auto', selected: state.settings.perm === 'auto' }, 'Auto-accept all'));
    permSel.addEventListener('change', () => {
      state.settings.perm = permSel.value;
      $('#perm').value = permSel.value;
      saveSettings();
    });
    const hasNew = $('#t-right')?.classList.contains('has-new');
    const row = (label, right, onclick) => h('button', { class: 'pop-row', type: 'button', onclick },
      h('span', { class: 'pr-name' }, label),
      right ? h('span', { class: 'dim small' }, right) : null);
    el.append(h('div', { class: 'more-menu' },
      row('📁 Files & Todos', hasNew ? 'new ●' : 'Open panel', () => {
        close();
        $('#right').classList.add('open');
        $('#t-right')?.classList.remove('has-new');
        $('#t-more')?.classList.remove('has-new');
      }),
      row('⚡ CORS Proxy', px ? proxyLabel(px) : 'Off (Direct)', () => {
        close();
        openProxyPicker(anchor);
      }),
      row('✦ MAX mode', mx.on ? `ON ×${clampN(mx.n)}` : 'Off', () => {
        close();
        openMax();
      }),
      h('label', { class: 'fld', style: { marginTop: '2px' } }, 'Permissions', permSel),
      h('div', { class: 'row', style: { marginTop: '4px' } },
        h('button', { class: 'btn sm', type: 'button', style: { flex: '1' }, onclick: () => { close(); showConnect(); } }, 'Servers'),
        h('button', { class: 'btn sm', type: 'button', style: { flex: '1' }, onclick: () => { close(); openAgents(); } }, 'Agents'),
        h('button', { class: 'btn sm', type: 'button', style: { flex: '1' }, onclick: () => { close(); openSettings(); } }, 'Settings'))));
  });
}

export function paintAgents() {
  const box = $('#pills');
  if (!box) return;
  box.innerHTML = '';
  const agent = currentAgent();
  if (agent) {
    box.append(h('button', {
      class: 'pill pill-dd on', type: 'button', title: (agent.desc ? agent.desc + '\n' : '') + 'Switch mode (Tab)',
      onclick: e => openAgentMenu(e.currentTarget),
    }, agent.name, h('span', { class: 'caret' }, '▾')));
  }
  const tk = state.think || 'auto';
  box.append(h('button', {
    class: 'pill pill-dd' + (tk !== 'auto' ? ' on' : ''), type: 'button', title: 'Thinking level for model reasoning',
    onclick: e => openThinkMenu(e.currentTarget),
  }, `Think: ${thinkLabel(tk)}`, h('span', { class: 'caret' }, '▾')));
  const subs = subagents().map(a => a.name).join(', ');
  if (subs) box.append(h('span', { class: 'dim small sub-hint' }, 'subagents: ' + subs));
}

export function updateTop() {
  const chip = $('#mchip');
  const m = modelInfo();
  const placeholder = state.conn || state.servers.length ? 'Choose a model' : 'Add server / model';
  chip.replaceChildren(...[
    meta(state.model).fav ? h('span', { class: 'favdot' }, '♥') : null,
    h('b', {}, state.model || placeholder),
    state.model && state.conn && state.servers.length > 1 ? h('span', { class: 'tag srvtag' }, '🖥 ' + serverLabel(state.conn)) : null,
    state.model ? strengthEl(state.model, { bar: false }) : null,
    ...(m?.caps || []).filter(c => c !== 'completion').map(c => capTag(c, true)),
    h('span', { class: 'caret' }, '▾'),
  ].filter(Boolean));
  $('#perm').value = state.settings.perm;
  $('#b-att').hidden = !modelCaps().includes('vision');
  updateStatus();
}

export function updateStatus() {
  const caps = modelCaps();
  const agent = currentAgent();
  const left = [
    h('b', {}, agent?.name || ''),
    ' · ' + (state.model || (state.conn ? 'no model' : 'no server')),
    ` · think: ${thinkLabel(state.think || 'auto').toLowerCase()}`,
  ];
  if (caps.length && !caps.includes('tools') && agent?.tools?.length) left.push(h('span', { class: 'warn' }, ' · model has no tool calling (chat only)'));
  if (isRunning(state.session?.id)) left.push(' · running (Esc to stop)');
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

export function openModelPicker(anchor) {
  popover(anchor, (el, close) => {
    const q = h('input', { placeholder: 'Search models…' });
    const list = h('div', { class: 'pop-list' });
    const row = m => h('div', {
      class: 'pop-row' + (m.name === state.model && (!m._srv || m._srv.conn.id === state.conn?.id) ? ' on' : ''),
      onclick: () => { close(); pickModel(m.name, { stay: true, srv: m._srv || null }); },
    },
    h('div', { class: 'pr-main' }, h('span', { class: 'pr-name' }, m.name), m._srv ? h('span', { class: 'tag srvtag' }, '🖥 ' + serverLabel(m._srv.conn)) : null, ...(m.caps || []).filter(c => c !== 'completion').map(c => capTag(c, true))),
    h('div', { class: 'pr-sub' }, strengthEl(m.name, { srv: m._srv }), starsEl(m.name, { readonly: true, srv: m._srv }), reliabilityEl(m.name, m._srv), h('span', { class: 'dim small' }, statsText(m.name, true, m._srv))));
    const cloudBtn = h('button', { class: 'chip', type: 'button', title: 'Hide models with :cloud in their name (also in Settings)', onclick: () => {
      state.settings.hideCloud = !state.settings.hideCloud;
      saveSettings();
      paint();
    } });
    const allBtn = h('button', { class: 'btn sm ghost wide', type: 'button', onclick: () => { close(); showModels(); } }, 'All models, ratings and stats →');
    const srvBtn = h('button', { class: 'btn sm ghost wide', type: 'button', onclick: () => { close(); showConnect(); } }, 'Servers / Add server…');
    const paint = () => {
      if (!el.isConnected) { bus.removeEventListener('servers', paint); bus.removeEventListener('models', paint); return; }
      const items = pickerItems();
      const allNames = (isMerged() ? state.servers.flatMap(x => (x.status === 'ok' ? x.models : [])) : state.models).map(m => m.name);
      const cloudN = allNames.filter(isCloudModel).length;
      cloudBtn.hidden = !(cloudN || state.settings.hideCloud);
      cloudBtn.textContent = `☁ Hide :cloud · ${cloudN}`;
      cloudBtn.classList.toggle('on', !!state.settings.hideCloud);
      q.hidden = !items.length;
      allBtn.hidden = !items.length;
      list.innerHTML = '';
      if (!items.length) {
        if (state.servers.some(s => s.status === 'loading')) {
          list.append(h('div', { class: 'dim pad small' }, 'Loading models from your servers…'));
        } else if (!state.conn && !state.servers.length) {
          list.append(
            h('div', { class: 'dim pad small' }, 'No Ollama server added yet. Add a server to pick a model.'),
            h('div', { class: 'stack pad-x' },
              h('button', { class: 'btn primary sm wide', type: 'button', onclick: () => { close(); showConnect(); } }, '+ Add a server'),
              remoteAvail() ? h('button', { class: 'btn sm wide', type: 'button', onclick: () => { close(); openRunOn(); } }, '💻 Choose a Remote PC') : null));
        } else {
          list.append(
            h('div', { class: 'dim pad small' }, 'No models loaded from your server yet.'),
            h('div', { class: 'row pad-x' },
              h('button', { class: 'btn sm', type: 'button', onclick: async e => {
                const b = e.currentTarget; b.disabled = true; b.textContent = 'Refreshing…';
                try {
                  if (state.conn) { await loadModels(); adoptActive(); }
                  await loadServers({ force: true });
                  paint();
                } catch (err) { toast(err.message); }
                finally { b.disabled = false; b.textContent = 'Refresh'; }
              } }, 'Refresh'),
              h('button', { class: 'btn sm primary', type: 'button', onclick: () => { close(); showConnect(); } }, 'Check servers')));
        }
        return;
      }
      const term = q.value.toLowerCase();
      const ms = items.filter(m => !term || m.name.toLowerCase().includes(term));
      const favs = sortModels(ms.filter(m => meta(m.name, m._srv).fav), 'rating');
      const recent = sortModels(ms.filter(m => !meta(m.name, m._srv).fav && meta(m.name, m._srv).lastUsed), 'recent').slice(0, 5);
      const shown = new Set([...favs, ...recent]);
      const rest = sortModels(ms.filter(m => !shown.has(m)), 'strength');
      const section = (title, arr) => { if (arr.length) { list.append(h('div', { class: 'pop-sec' }, title)); arr.forEach(m => list.append(row(m))); } };
      section('♥ Favorites', favs);
      section('Recently used', recent);
      section('All models · strongest first', rest);
      if (!ms.length) list.append(h('div', { class: 'dim pad' }, 'No models match.'));
    };
    q.addEventListener('input', paint);
    el.append(q, cloudBtn, list, allBtn, srvBtn);
    paint();
    if (!state.servers.length) loadServers();
    bus.addEventListener('servers', paint);
    bus.addEventListener('models', paint);
    if (!q.hidden) setTimeout(() => q.focus());
  });
}
