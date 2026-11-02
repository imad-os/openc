// Dialogs: Settings, Agents editor, Account.
import { state, emit, saveSettings, DEFAULT_SETTINGS } from '../core/state.js';
import { h, modal, toast, confirmDialog } from '../util/dom.js';
import { chime, ensureNotifyPermission } from '../util/sound.js';
import { ALL_TOOLS, BUILTIN_AGENTS, rebuildAgents } from '../agent/agents.js';
import { getFirebaseConfig, getFirebaseOverrideText, setFirebaseOverride, signOut, resendVerification, authErrorText } from '../core/auth.js';
import { LocalStore } from '../core/storage/local.js';
import { loadSessions } from './sessions.js';
import { display, setDisplay, resetDisplay } from './display.js';
import { showAuth } from './auth.js';
import { abortAll } from './runs.js';
import { webFetch, webSearch } from '../agent/web.js';

const field = (label, el) => h('label', { class: 'fld' }, label, el);
const check = (el, label) => h('label', { class: 'check' }, el, label);
const section = t => h('div', { class: 'sec-title' }, t);

/* ---------------- Display (applies live, saved per device) ---------------- */
function displayPane() {
  const pane = h('div', { class: 'stack' });
  const paint = () => {
    const d = display;
    const seg = (key, opts) => h('div', { class: 'seg' }, opts.map(([v, t]) =>
      h('button', { type: 'button', class: d[key] === v ? 'on' : '', onclick: () => { setDisplay({ [key]: v }); paint(); } }, t)));
    const slider = (key, min, max, step, unit) => {
      const out = h('b', {}, d[key] + unit);
      const r = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(d[key]) });
      r.addEventListener('input', () => { out.textContent = r.value + unit; setDisplay({ [key]: +r.value }); });
      return h('div', { class: 'row slider' },
        h('button', { class: 'btn sm', type: 'button', title: 'Smaller', onclick: () => { setDisplay({ [key]: Math.max(min, +(d[key] - step).toFixed(2)) }); paint(); } }, 'A−'),
        r,
        h('button', { class: 'btn sm', type: 'button', title: 'Larger', onclick: () => { setDisplay({ [key]: Math.min(max, +(d[key] + step).toFixed(2)) }); paint(); } }, 'A+'),
        out);
    };
    const toggle = (key, label) => {
      const c = h('input', { type: 'checkbox', checked: !!d[key] });
      c.addEventListener('change', () => setDisplay({ [key]: c.checked }));
      return check(c, label);
    };
    pane.replaceChildren(
      h('div', { class: 'dim small' }, 'Changes apply immediately and are saved on this device, so your phone and computer can differ.'),
      section('Theme'), seg('theme', [['dark', 'Dark'], ['light', 'Light'], ['auto', 'System']]),
      section('Text size'), slider('fontSize', 11, 22, 1, 'px'),
      section('Code size'), slider('codeSize', 10, 20, 0.5, 'px'),
      h('div', { class: 'preview-box' },
        h('div', {}, 'The quick brown fox jumps over the lazy dog.'),
        h('pre', {}, 'const answer = 42; // code preview')),
      section('Layout'),
      h('div', { class: 'grid2' },
        h('div', { class: 'fld' }, 'Density', seg('density', [['normal', 'Comfortable'], ['compact', 'Compact']])),
        h('div', { class: 'fld' }, 'Chat width', seg('chatWidth', [['normal', 'Normal'], ['wide', 'Wide'], ['full', 'Full']]))),
      section('Model thinking'),
      seg('thinking', [['collapsed', 'Hidden (tap to show)'], ['live', 'Show while thinking'], ['expanded', 'Always shown']]),
      section('Panels'),
      toggle('showFiles', 'Show the files panel (also: "Files" button in the top bar, Ctrl+.)'),
      section('Code blocks'),
      toggle('lineNumbers', 'Show line numbers'),
      toggle('wrapCode', 'Wrap long lines'),
      h('div', { class: 'fld' }, 'Max height of a code block', seg('codeMaxHeight', [[320, 'Short'], [520, 'Medium'], [900, 'Tall'], [0, 'Unlimited']])),
      h('div', { class: 'row end' }, h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { resetDisplay(); paint(); } }, 'Reset display')));
  };
  paint();
  return pane;
}

/* ---------------- Settings ---------------- */
export function openSettings(tab = 'general') {
  modal((box, close) => {
    const s = state.settings;
    const num = (v, attrs) => h('input', { type: 'number', value: String(v), ...attrs });
    const sel = (v, opts) => h('select', {}, opts.map(([val, text]) => h('option', { value: val, selected: val === v }, text)));
    const cb = v => h('input', { type: 'checkbox', checked: !!v });

    const temp = num(s.temperature, { step: '0.1', min: '0', max: '2' });
    const ctx = num(s.num_ctx, { step: '1024', min: '2048' });
    const steps = num(s.maxSteps, { min: '1', max: '200' });
    const think = sel(s.think, [['auto', 'Model default'], ['on', 'On'], ['off', 'Off'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]);
    const perm = sel(s.perm, [['ask', 'Ask before changes'], ['edits', 'Auto-accept file edits'], ['auto', 'Auto-accept everything']]);
    const autoC = cb(s.autoContinue), autoK = cb(s.autoCompact), sound = cb(s.sound), desk = cb(s.desktopNotify);
    const vol = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(s.volume) });
    const web = cb(s.webEnabled), retry = cb(s.autoRetryStall);
    const defFiles = sel(s.defaultFiles || 'session', [['session', 'Own private files (per conversation)'], ['shared', 'Shared workspace']]);
    const toolMode = sel(s.toolMode, [['stream', 'Streamed (recommended, live progress)'], ['native', 'Native Ollama tool calling']]);
    const provider = sel(s.searchProvider, [['auto', 'Automatic (best available)'], ['ollama', 'Ollama web search (key)'], ['jina', 'Jina search (key)'], ['searxng', 'SearXNG (your instance)'], ['duckduckgo', 'DuckDuckGo (free, via Jina Reader)'], ['wikipedia', 'Wikipedia only']]);
    const secret = (v, ph) => h('input', { type: 'password', value: v || '', placeholder: ph, autocomplete: 'off' });
    const okey = secret(s.ollamaKey, 'ollama.com → Settings → Keys'), jkey = secret(s.jinaKey, 'optional: jina.ai API key');
    const proxy = h('input', { value: s.proxyUrl || '', placeholder: 'optional: https://your-proxy.workers.dev/?url={url}' });
    const searx = h('input', { value: s.searxngUrl || '', placeholder: 'optional: https://searx.example.org' });
    const first = num(s.firstTokenTimeout, { min: '10', max: '3600' }), idle = num(s.idleTimeout, { min: '10', max: '1800' });
    const testOut = h('pre', { class: 'small', hidden: true, style: { whiteSpace: 'pre-wrap', margin: 0 } });
    const testWeb = async btn => {
      const saved = { ...state.settings };
      Object.assign(state.settings, { searchProvider: provider.value, ollamaKey: okey.value.trim(), jinaKey: jkey.value.trim(), proxyUrl: proxy.value.trim(), searxngUrl: searx.value.trim() });
      btn.disabled = true; testOut.hidden = false; testOut.textContent = 'Testing…';
      const lines = [];
      try { const r = await webSearch('ollama api documentation', 3); lines.push(`✓ search works via ${r.provider}: ${r.results[0]?.title || ''}`); } catch (e) { lines.push('✗ search: ' + e.message); }
      try { const r = await webFetch('https://github.com/ollama/ollama/blob/main/docs/api.md'); lines.push(`✓ fetch works via ${r.via} (${r.content.length} chars)`); } catch (e) { lines.push('✗ fetch: ' + e.message); }
      Object.assign(state.settings, saved);
      testOut.textContent = lines.join('\n'); btn.disabled = false;
    };
    const fb = h('textarea', { rows: 4, placeholder: 'Paste a Firebase web config here to override js/config.js (JSON or the JS object from the console). Leave empty to use the built-in one.' });
    fb.value = getFirebaseOverrideText();

    const general = h('div', { class: 'stack' });
    const displayTab = displayPane();
    const tabs = h('div', { class: 'seg tabs-seg' });
    const showTab = t => {
      general.hidden = t !== 'general';
      displayTab.hidden = t !== 'display';
      tabs.replaceChildren(...[['general', 'General'], ['display', 'Display & text']].map(([v, l]) =>
        h('button', { type: 'button', class: v === t ? 'on' : '', onclick: () => showTab(v) }, l)));
    };
    box.append(h('h3', {}, 'Settings'), tabs, general, displayTab);
    showTab(tab);

    general.append(
      section('Model'),
      h('div', { class: 'grid2' }, field('Temperature', temp), field('Context window (num_ctx tokens)', ctx)),
      h('div', { class: 'grid2' }, field('Thinking (models that support it)', think), field('Max agent steps per message', steps)),
      section('Agent'),
      field('Permissions', perm),
      field('Files for new conversations', defFiles),
      field('Tool calls', toolMode),
      h('div', { class: 'dim small' }, 'Streamed: tools are described in the prompt and calls are written as text, so you see progress live (e.g. a file being written) and it works with any model. Native: Ollama tool API; tool calls arrive only when complete, so long files mean long silence.'),
      check(autoC, 'Auto-continue when the agent stops with unfinished todos'),
      check(autoK, 'Auto-compact old messages when the context window fills up'),
      section('Internet (web_search, web_fetch)'),
      check(web, 'Let agents search the web and read pages (docs, SDK references)'),
      field('Search provider', provider),
      h('div', { class: 'grid2' }, field('Ollama API key (best search + fetch)', okey), field('Jina API key', jkey)),
      h('div', { class: 'grid2' }, field('CORS proxy (optional)', proxy), field('SearXNG URL (optional)', searx)),
      h('div', { class: 'dim small' }, 'Pages are read directly when the site allows it, otherwise through Jina Reader (free, no key) or your proxy. Without keys, search uses DuckDuckGo through Jina Reader. Keys are stored with your settings (only you can read them).'),
      h('div', { class: 'row' }, h('button', { class: 'btn sm', type: 'button', onclick: e => testWeb(e.currentTarget) }, 'Test internet access')), testOut,
      section('Stall detection'),
      h('div', { class: 'grid2' }, field('Max wait for the first token (seconds)', first), field('Max silence between tokens (seconds)', idle)),
      check(retry, 'Retry a stalled step automatically once'),
      section('Notifications'),
      check(sound, 'Play a sound when the agent finishes, fails or needs you'),
      h('div', { class: 'row' }, h('span', { class: 'dim small' }, 'Volume'), vol,
        h('button', { class: 'btn sm', type: 'button', onclick: () => chime('done', +vol.value) }, 'Test')),
      check(desk, 'Desktop notification when this tab is in the background'),
      section('Cloud sync (Firebase)'),
      h('div', { class: 'dim small' }, getFirebaseConfig() ? `Using project "${getFirebaseConfig().projectId}".` : 'Not configured: local mode only.'),
      fb,
      h('div', { class: 'row-between' },
        h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { Object.assign(state.settings, DEFAULT_SETTINGS); saveSettings(); close(); toast('Settings reset'); } }, 'Reset to defaults'),
        h('div', { class: 'row' },
          h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'),
          h('button', {
            class: 'btn primary', type: 'button', onclick: async () => {
              Object.assign(s, {
                temperature: Math.min(2, Math.max(0, +temp.value || 0)),
                num_ctx: Math.max(2048, +ctx.value || DEFAULT_SETTINGS.num_ctx),
                maxSteps: Math.min(200, Math.max(1, +steps.value || DEFAULT_SETTINGS.maxSteps)),
                think: think.value, perm: perm.value,
                autoContinue: autoC.checked, autoCompact: autoK.checked,
                sound: sound.checked, volume: +vol.value, desktopNotify: desk.checked,
                webEnabled: web.checked, searchProvider: provider.value, ollamaKey: okey.value.trim(), jinaKey: jkey.value.trim(),
                proxyUrl: proxy.value.trim(), searxngUrl: searx.value.trim(),
                firstTokenTimeout: Math.min(3600, Math.max(10, +first.value || DEFAULT_SETTINGS.firstTokenTimeout)),
                idleTimeout: Math.min(1800, Math.max(10, +idle.value || DEFAULT_SETTINGS.idleTimeout)),
                autoRetryStall: retry.checked,
                toolMode: toolMode.value,
                defaultFiles: defFiles.value,
              });
              if (s.desktopNotify && !(await ensureNotifyPermission())) { s.desktopNotify = false; toast('Notifications are blocked in this browser'); }
              saveSettings();
              if (!applyFirebaseOverride(fb.value.trim())) return;
              close();
            },
          }, 'Save'))),
    );
  });
}

/** Returns false if the text is invalid. Reloads the page when the config changes. */
function applyFirebaseOverride(text) {
  if (text === getFirebaseOverrideText().trim()) return true;
  if (!text) { setFirebaseOverride(null); }
  else {
    try {
      const body = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
      let obj;
      try { obj = JSON.parse(body); } catch { obj = Function('"use strict";return (' + body + ')')(); }
      if (!obj?.apiKey || !obj?.projectId) throw new Error('apiKey and projectId are required');
      setFirebaseOverride(obj);
    } catch (e) { toast('Invalid Firebase config: ' + e.message, 5000); return false; }
  }
  toast('Reloading to apply the Firebase config…');
  setTimeout(() => location.reload(), 700);
  return true;
}

/* ---------------- Agents ---------------- */
async function reloadAgents() {
  try { rebuildAgents(await state.store.listAgents()); } catch (e) { toast(e.message); }
  emit('agents');
}

export function openAgents() {
  modal((box, close) => {
    const list = () => {
      box.innerHTML = '';
      box.append(h('h3', {}, 'Agents'),
        h('div', { class: 'dim small' }, 'Primary agents are the ones you talk to (Tab switches). Subagents are called by primary agents through the task tool. Built-in agents can be duplicated and customized.'));
      for (const a of state.agents) {
        box.append(h('div', { class: 'arow' },
          h('div', {},
            h('b', {}, a.name), ' ', h('span', { class: 'tag unk' }, a.mode), a.builtin ? [' ', h('span', { class: 'tag unk' }, 'built-in')] : null,
            h('div', { class: 'dim small' }, (a.desc || '') + ' · tools: ' + ((a.tools || []).join(', ') || 'none') + (a.model ? ' · model: ' + a.model : ''))),
          h('button', { class: 'btn sm', type: 'button', onclick: () => form(a.builtin ? { ...a, id: '', name: a.name + '-custom', builtin: false } : a) }, a.builtin ? 'Duplicate' : 'Edit')));
      }
      box.append(h('div', { class: 'row-between' },
        h('button', { class: 'btn', type: 'button', onclick: () => form(null) }, '+ New agent'),
        h('button', { class: 'btn', type: 'button', onclick: close }, 'Close')));
    };

    const form = a => {
      const isNew = !a?.id;
      a = a || { mode: 'primary', tools: ['list_files', 'read_file', 'grep'], prompt: '' };
      const name = h('input', { value: a.name || '', placeholder: 'e.g. reviewer' });
      const desc = h('input', { value: a.desc || '', placeholder: 'One line (subagent descriptions are shown to the model)' });
      const mode = h('select', {}, ['primary', 'subagent'].map(v => h('option', { value: v, selected: v === a.mode }, v)));
      const model = h('select', {}, [h('option', { value: '' }, '(use the selected model)'),
        ...state.models.map(m => h('option', { value: m.name, selected: m.name === a.model }, m.name + ((m.caps || []).includes('tools') ? '' : '  [no tools]')))]);
      const temp = h('input', { type: 'number', step: '0.1', min: '0', max: '2', value: a.temperature ?? '', placeholder: 'default' });
      const checks = ALL_TOOLS.map(n => h('label', {}, h('input', { type: 'checkbox', value: n, checked: (a.tools || []).includes(n) }), n));
      const prompt = h('textarea', { rows: 10, placeholder: 'System prompt: who the agent is, how it works, how it reports.' });
      prompt.value = a.prompt || '';
      box.innerHTML = '';
      box.append(
        h('h3', {}, isNew ? 'New agent' : 'Edit ' + a.name),
        h('div', { class: 'grid2' }, field('Name', name), field('Mode', mode)),
        field('Description', desc),
        h('div', { class: 'grid2' }, field('Model', model), field('Temperature', temp)),
        h('div', { class: 'fld' }, 'Tools', h('div', { class: 'checks' }, checks)),
        field('System prompt', prompt),
        h('div', { class: 'row-between' },
          h('div', {}, !isNew ? h('button', {
            class: 'btn danger', type: 'button', onclick: async () => {
              if (!(await confirmDialog(`Delete agent "${a.name}"?`, 'Delete'))) return;
              try { await state.store.deleteAgent(a.id); } catch (e) { return toast(e.message); }
              await reloadAgents(); list();
            },
          }, 'Delete') : null),
          h('div', { class: 'row' },
            h('button', { class: 'btn', type: 'button', onclick: list }, 'Back'),
            h('button', {
              class: 'btn primary', type: 'button', onclick: async () => {
                const nm = name.value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
                if (!nm) return toast('A name is required');
                const id = isNew ? nm : a.id;
                if (isNew && state.agents.some(x => x.id === id || x.name === nm)) return toast('An agent with that name already exists');
                if (BUILTIN_AGENTS.some(b => b.id === id)) return toast('That name is reserved for a built-in agent');
                const agent = {
                  id, name: nm, mode: mode.value, desc: desc.value.trim().slice(0, 300),
                  model: model.value || undefined, temperature: temp.value === '' ? undefined : Math.min(2, Math.max(0, +temp.value)),
                  tools: checks.filter(c => c.firstChild.checked).map(c => c.firstChild.value), prompt: prompt.value.slice(0, 20000),
                };
                try { await state.store.saveAgent(agent); } catch (e) { return toast('Could not save: ' + e.message); }
                await reloadAgents(); list();
              },
            }, 'Save'))));
    };
    list();
  });
}

/* ---------------- Account ---------------- */
const avatar = u => h('span', { class: 'avatar' }, u?.photoURL ? h('img', { src: u.photoURL, alt: '', referrerpolicy: 'no-referrer' }) : (u?.email || '?')[0].toUpperCase());

export function openAccount() {
  modal((box, close) => {
    box.append(h('h3', {}, 'Account'));
    const u = state.user;
    if (u) {
      const viaPassword = (u.providerData || []).some(p => p.providerId === 'password');
      const local = new LocalStore();
      box.append(
        h('div', { class: 'acct-card' }, avatar(u), h('div', {},
          h('b', {}, u.displayName || u.email || 'Signed in'),
          h('div', { class: 'dim small' }, (u.email || '') + ' · ' + (viaPassword ? 'email & password' : 'Google')))),
        h('div', { class: 'dim small' }, 'Your servers (including saved API keys), model ratings and stats, custom agents and conversations are stored in Firestore under your account. Security rules only allow you to read or write them.'),
        viaPassword && !u.emailVerified ? h('div', { class: 'msgbox' }, 'Your email is not verified yet. ',
          h('a', { href: '#', onclick: async e => { e.preventDefault(); try { await resendVerification(); toast('Verification email sent'); } catch (x) { toast(authErrorText(x)); } } }, 'Resend verification email')) : null,
        local.hasData() ? h('button', { class: 'btn', type: 'button', onclick: e => importLocal(e.currentTarget, local) }, "Copy this browser's local data into my account") : null,
        h('div', { class: 'row end' },
          h('button', { class: 'btn danger', type: 'button', onclick: async () => { close(); abortAll(); await signOut(); } }, 'Sign out'),
          h('button', { class: 'btn', type: 'button', onclick: close }, 'Close')));
    } else if (getFirebaseConfig()) {
      box.append(
        h('div', {}, 'You are in local mode: everything is saved in this browser only.'),
        h('div', { class: 'dim small' }, 'Sign in with Google or email to sync servers, API keys, ratings and conversations across devices. You can copy your local data into the account afterwards.'),
        h('div', { class: 'row end' },
          h('button', { class: 'btn', type: 'button', onclick: close }, 'Close'),
          h('button', { class: 'btn primary', type: 'button', onclick: () => { close(); abortAll(); showAuth(); } }, 'Sign in')));
    } else {
      box.append(
        h('div', {}, 'Local mode: everything is saved in this browser only.'),
        h('div', { class: 'dim small' }, 'To sign in and sync, add a Firebase web config in js/config.js or in Settings → Cloud sync (see README).'),
        h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Close')));
    }
  });
}

async function importLocal(btn, local) {
  btn.disabled = true;
  btn.textContent = 'Copying…';
  try {
    const data = await local.exportAll();
    for (const c of data.conns) await state.store.saveConnection(c);
    for (const m of data.models) {
      const { url, model, rating, fav, note, lastUsed, ...rest } = m;
      const inc = {};
      for (const k of ['runs', 'requests', 'evalTokens', 'evalNs', 'promptTokens', 'toolCalls', 'toolErrors']) if (rest[k]) inc[k] = rest[k];
      await state.store.updateModelMeta(url, model, { rating, fav, note, lastUsed }, inc);
    }
    for (const a of data.agents) await state.store.saveAgent(a);
    for (const { meta, messages } of data.sessions) await state.store.saveSession(meta, messages, 0);
    await reloadAgents();
    await loadSessions();
    btn.textContent = 'Copied ✓';
    toast(`Copied ${data.conns.length} servers, ${data.models.length} model ratings, ${data.agents.length} agents and ${data.sessions.length} conversations`, 5000);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "Copy this browser's local data into my account";
    toast('Copy failed: ' + e.message, 6000);
  }
}

