// Benchmark dialog + background job. Asks every chosen model the same question a few times and stores
// how long it took and whether it answered. Runs here, or on the selected remote PC when the phone
// cannot reach the servers itself.
import { state, emit, bus } from '../core/state.js';
import { h, toast, modal } from '../util/dom.js';
import { fmt } from '../util/misc.js';
import { BENCH_DEFAULTS, runBench, benchable } from '../agent/bench.js';
import * as R from '../core/remote.js';
import { remoteTarget } from './remote.js';
import { setModelMeta } from './models.js';
import { serverLabel } from './servers.js';

const PREF = 'oc2.bench';
const pref = () => { try { return { ...BENCH_DEFAULTS, ...(JSON.parse(localStorage.getItem(PREF) || 'null') || {}) }; } catch { return { ...BENCH_DEFAULTS }; } };
const savePref = p => { try { localStorage.setItem(PREF, JSON.stringify(p)); } catch { /* ignore */ } };

/** The running (or last finished) job: { total, done, lines, ctrl, remote, host, finished } or null. */
let job = null;
export const benchJob = () => job;
const changed = () => emit('bench');

/** Mutable meta store of a server entry (state.servers[i] or the connected server). */
const keyOf = (conn, name) => conn.id + '|' + name;

async function reloadMeta(srvs) {
  for (const s of srvs) {
    try {
      const fresh = await state.store.listModelMeta(s.conn.url);
      for (const [k, v] of Object.entries(fresh)) s.meta[k] = { ...(s.meta[k] || {}), ...v };
    } catch { /* ignore */ }
  }
  emit('model-meta');
}

/** items: [{ name, _srv? }] → groups by server. */
function toGroups(items) {
  const map = new Map();
  for (const m of items) {
    const srv = m._srv || state.servers.find(s => s.conn.id === state.conn?.id) || null;
    const conn = srv?.conn || state.conn;
    if (!conn) continue;
    if (!map.has(conn.id)) map.set(conn.id, { conn, srv: m._srv || null, models: [] });
    map.get(conn.id).models.push(m.name);
  }
  return [...map.values()];
}

function stopJob() {
  if (!job || job.finished) return;
  job.ctrl.abort();
  if (job.remote) R.sendCommand({ host: job.host, type: 'stop', session: 'bench' }).catch(() => {});
  job.lines.push('■ Stopping…');
  changed();
}

function finish(text) {
  job.finished = true;
  job.lines.push(text);
  changed();
  toast(text, 5000);
}

async function startLocal(groups, opts) {
  const total = groups.reduce((n, g) => n + g.models.length, 0);
  job = { total, done: 0, lines: [], ctrl: new AbortController(), remote: false, finished: false, running: new Set() };
  changed();
  const srvOf = new Map(groups.map(g => [g.conn.id, g.srv]));
  await runBench(groups.map(g => ({ conn: g.conn, models: g.models })), opts, {
    signal: job.ctrl.signal,
    save: (conn, name, res) => setModelMeta(name, res, srvOf.get(conn.id)),
    onStart: (conn, name) => { job.running.add(keyOf(conn, name)); job.current = `${name} on ${serverLabel(conn)}`; changed(); },
    onAttempt: (conn, name, r, i) => { job.current = `${name}: try ${i + 1}/${opts.attempts} ${r.ok ? '✓ ' + fmt.dur(r.ms) : '✗ ' + (r.error || '')}`; changed(); },
    onDone: (conn, name, res) => {
      job.running.delete(keyOf(conn, name));
      job.done++;
      if (res) job.lines.push(`${res.benchOk === res.benchN ? '✓' : res.benchOk ? '◐' : '✗'} ${name} · ${res.benchOk}/${res.benchN}${res.benchOk ? ' · ' + fmt.dur(res.benchMs) : ' · ' + (res.benchErr || 'failed')}`);
      changed();
    },
  });
  finish(job.ctrl.signal.aborted ? `Benchmark stopped (${job.done}/${job.total} models done)` : `✓ Benchmark finished: ${job.done} models`);
}

async function startRemote(groups, opts) {
  const host = remoteTarget();
  const models = groups.flatMap(g => g.models.map(n => ({ c: g.conn.id, n })));
  const total = models.length;
  job = { total, done: 0, lines: [], ctrl: new AbortController(), remote: true, host, finished: false };
  changed();
  const srvs = groups.map(g => g.srv || state.servers.find(s => s.conn.id === g.conn.id)).filter(Boolean);
  let unsub = () => {};
  let poll = 0;
  const end = text => { unsub(); clearInterval(poll); finish(text); };
  try {
    await R.sendCommand({ host, type: 'bench', text: JSON.stringify({ opts, models }).slice(0, 99000) });
  } catch (e) { job = null; changed(); throw e; }
  job.lines.push('Sent to the PC. You can close this page: results are saved to your account.');
  const t0 = Date.now();
  let seen = false;
  unsub = R.watchLive('bench-' + host, d => {
    if (!d || !job || job.finished) return;
    if ((d.updated || 0) < t0 - 60000) return; // an older run
    seen = true;
    job.done = d.step || 0;
    job.current = d.detail || '';
    if (d.state === 'idle') { reloadMeta(srvs).then(() => end(d.phase || '✓ Benchmark finished on the PC')); return; }
    changed();
  }, () => {});
  poll = setInterval(() => {
    if (job?.finished) return clearInterval(poll);
    reloadMeta(srvs);
    if (!seen && Date.now() - t0 > 90000) end('The PC did not start the benchmark. Is its browser open in host mode?');
  }, 6000);
  job.ctrl.signal.addEventListener('abort', () => { /* stop command already sent by stopJob */ });
}

export async function startBench(items, opts) {
  const groups = toGroups(items.filter(benchable));
  if (!groups.length) return toast('No models to benchmark');
  savePref(opts);
  if (job && !job.finished) return toast('A benchmark is already running');
  try {
    if (remoteTarget()) await startRemote(groups, opts); else await startLocal(groups, opts);
  } catch (e) { toast('Benchmark failed: ' + e.message, 6000); }
}

/** One-line state for the button in the models header. */
export function benchLabel() {
  if (job && !job.finished) return `⏱ ${job.done}/${job.total}`;
  return '⏱ Benchmark';
}

export function openBench({ shown, pool }) {
  let off = () => {};
  modal((box, close) => {
    const p = pref();
    const q = h('textarea', { rows: '2', maxlength: '2000' }, p.prompt);
    const expect = h('input', { value: p.expect || '', placeholder: 'e.g. 391 (leave empty: any answer counts)' });
    const attempts = h('input', { type: 'number', min: '1', max: '5', value: String(p.attempts), style: { width: '70px' } });
    const timeout = h('input', { type: 'number', min: '10', max: '900', value: String(p.timeout), style: { width: '90px' } });
    const nb = list => list.filter(benchable);
    const scope = h('select', {},
      h('option', { value: 'shown' }, `Models shown now (${nb(shown).length})`),
      h('option', { value: 'new' }, `Not benchmarked yet (${nb(pool).filter(m => !(m._srv ? m._srv.meta : state.modelMeta)[m.name]?.benchAt).length})`),
      h('option', { value: 'all' }, `All models (${nb(pool).length})`));
    const status = h('div', { class: 'bench-status' });
    const log = h('pre', { class: 'bench-log' });
    const go = h('button', { class: 'btn primary', type: 'button' }, '▶ Start benchmark');
    const stop = h('button', { class: 'btn danger', type: 'button', onclick: stopJob }, '■ Stop');
    const form = h('div', { class: 'bench-form' },
      h('label', { class: 'dim small' }, 'Question every model gets'), q,
      h('label', { class: 'dim small' }, 'The answer must contain'), expect,
      h('div', { class: 'row' },
        h('label', { class: 'dim small' }, 'Tries per model'), attempts,
        h('label', { class: 'dim small' }, 'Wait per try (s)'), timeout),
      h('label', { class: 'dim small' }, 'Which models'), scope);

    const paint = () => {
      const running = job && !job.finished;
      form.hidden = !!running;
      go.hidden = !!running;
      stop.hidden = !running;
      status.textContent = job ? `${job.remote ? '💻 On the PC · ' : ''}${job.done}/${job.total} models${job.current ? ' · ' + job.current : ''}` : '';
      log.textContent = job ? job.lines.slice(-14).join('\n') : '';
      log.hidden = !job;
    };
    go.addEventListener('click', () => {
      const pick = scope.value === 'shown' ? shown : scope.value === 'new' ? pool.filter(m => !(m._srv ? m._srv.meta : state.modelMeta)[m.name]?.benchAt) : pool;
      const opts = {
        prompt: q.value.trim() || BENCH_DEFAULTS.prompt, expect: expect.value.trim(),
        attempts: Math.min(5, Math.max(1, parseInt(attempts.value, 10) || 3)), timeout: Math.min(900, Math.max(10, parseInt(timeout.value, 10) || 90)),
      };
      startBench(pick, opts);
    });
    const onBench = () => paint();
    bus.addEventListener('bench', onBench);
    box.append(
      h('h3', {}, '⏱ Benchmark models'),
      h('div', { class: 'dim small' }, 'Every model gets the same question several times. For each one the app saves whether it answered, how long it took, the time to the first token and the speed. Servers run side by side, but each server runs one model at a time. Results appear on the model cards and in the filters.' + (remoteTarget() ? ' The PC will run it, so you can close this page.' : '')),
      form, status, log,
      h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Close'), stop, go));
    paint();
    off = () => bus.removeEventListener('bench', onBench);
  }, { onClose: () => off() });
}
