// MAX mode button + settings dialog (strategy, models, number of agents, judge / planner / reviewer).
import { state, on, visibleModels } from '../core/state.js';
import { $, h, modal, toast } from '../util/dom.js';
import { saveSettings } from '../core/state.js';
import { maxConfig, clampN, MAX_DEFAULTS } from '../agent/max.js';

export function initMax() {
  $('#maxbtn').addEventListener('click', openMax);
  on('settings', paintMax);
  on('models', paintMax);
  paintMax();
}

export function paintMax() {
  const b = $('#maxbtn');
  if (!b) return;
  const c = maxConfig();
  b.classList.toggle('on', !!c.on);
  b.textContent = c.on ? `MAX ×${clampN(c.n)}` : 'MAX';
  b.title = c.on
    ? `MAX mode is ON: ${c.strategy === 'team' ? 'team of up to' : 'best of'} ${clampN(c.n)} agents. Click to change.`
    : 'MAX mode: let several agents / models work together for a better result';
}

export function toggleMax() {
  const c = maxConfig();
  state.settings.max = { ...c, on: !c.on };
  saveSettings();
  toast(state.settings.max.on ? `MAX mode on (${c.strategy === 'team' ? 'team' : 'best of ' + clampN(c.n)})` : 'MAX mode off');
}

function openMax() {
  modal((box, close) => {
    const c = maxConfig();
    const shown = visibleModels();
    const names = shown.map(m => m.name);
    const chosen = new Set((c.models || []).filter(m => names.includes(m)));
    let strategy = c.strategy === 'team' ? 'team' : 'best';

    const on = h('input', { type: 'checkbox', checked: !!c.on });
    const n = h('input', { type: 'number', min: '1', max: '8', value: String(clampN(c.n)) });
    const par = h('select', {}, [['0', 'One after another (safer for one GPU)'], ['1', 'At the same time (needs a strong server)']].map(([v, t]) => h('option', { value: v, selected: v === (c.parallel ? '1' : '0') }, t)));
    const modelSel = (cur, first) => h('select', {}, [h('option', { value: '' }, first), ...names.map(m => h('option', { value: m, selected: m === cur }, m))]);
    const judge = modelSel(c.judge, 'Same as the first chosen model');
    const planner = modelSel(c.planner, 'Same as the first chosen model');
    const reviewer = modelSel(c.reviewer, 'Same as the first chosen model');

    const cards = h('div', { class: 'hosts' });
    const rows = h('div', { class: 'maxmodels' });
    const nlabel = h('label', { class: 'dim small' });
    const roles = h('div', { class: 'maxroles' });
    const cost = h('div', { class: 'dim small' });

    const paint = () => {
      const card = (key, title, desc) => h('div', { class: 'hcard' + (strategy === key ? ' sel' : '') },
        h('div', { class: 'hc-main', onclick: () => { strategy = key; paint(); } },
          h('div', { class: 'hc-top' }, h('b', {}, title), strategy === key ? h('span', { class: 'hc-sel' }, '✓ Selected') : null),
          h('div', { class: 'dim small' }, desc)));
      cards.replaceChildren(
        card('best', '🏁 Best of N + judge', 'Several agents solve the whole task separately, each in its own temporary workspace. A judge model compares them and the winner’s files are copied into your workspace. Good when the answer can be checked (code that runs).'),
        card('team', '👥 Team: planner, workers, reviewer', 'A planner splits the task, workers build the parts in your workspace, a reviewer checks everything and fixes problems. Usually cheaper and better for bigger builds.'));
      nlabel.textContent = strategy === 'team' ? 'Maximum number of workers (1–8)' : 'Number of attempts (1–8)';
      roles.replaceChildren(...(strategy === 'team'
        ? [h('label', { class: 'dim small' }, 'Planner model'), planner, h('label', { class: 'dim small' }, 'Reviewer model'), reviewer]
        : [h('label', { class: 'dim small' }, 'Judge model'), judge]));
      const k = Math.max(1, chosen.size);
      const cnt = clampN(n.value);
      cost.textContent = strategy === 'team'
        ? `Takes roughly the planner time + the slowest worker${par.value === '1' ? '' : 's added together'} + a review. Models are used round-robin: ${k} chosen.`
        : `About ${cnt}× the time of a normal run${par.value === '1' ? ' if your server can run them at once' : ''}, plus the judge. Models are used round-robin: ${k} chosen.`;
    };
    n.addEventListener('input', paint);
    par.addEventListener('change', paint);

    for (const m of shown) {
      const cb = h('input', { type: 'checkbox', checked: chosen.has(m.name) });
      cb.addEventListener('change', () => { if (cb.checked) chosen.add(m.name); else chosen.delete(m.name); paint(); });
      rows.append(h('label', { class: 'maxrow' }, cb, h('span', { class: 'ellipsis' }, m.name), h('span', { class: 'dim small' }, (m.caps || []).filter(x => x !== 'completion').join(' · '))));
    }
    if (!shown.length) rows.append(h('div', { class: 'dim small' }, 'Connect to a server first to see its models.'));

    box.append(
      h('h3', {}, 'MAX mode'),
      h('div', { class: 'dim small' }, 'Let several agents and models work on one request for a better result. It uses more time and computing power.'),
      h('label', { class: 'maxrow' }, on, h('b', {}, 'Use MAX mode for my messages')),
      cards,
      h('div', { class: 'sec-title' }, 'Models to use'),
      h('div', { class: 'dim small' }, 'Tick one or more. Nothing ticked = the model selected at the top. With several, they take turns (agent 1 uses the first, agent 2 the second, …).'),
      rows,
      nlabel, n,
      h('label', { class: 'dim small' }, 'Run order'), par,
      roles, cost,
      h('div', { class: 'row end' },
        h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => {
          state.settings.max = {
            ...MAX_DEFAULTS, on: on.checked, strategy, models: [...chosen], n: clampN(n.value), parallel: par.value === '1',
            judge: judge.value, planner: planner.value, reviewer: reviewer.value,
          };
          saveSettings();
          toast(on.checked ? '✓ MAX mode is on' : 'MAX settings saved (mode is off)');
          close();
        } }, 'Save')));
    paint();
  });
}
