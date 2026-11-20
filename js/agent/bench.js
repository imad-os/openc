// Model benchmark: ask every model the same question a few times, measure how long it takes and
// whether it answered (and answered correctly). Pure logic: the UI lives in ui/bench.js.
import { chatStream } from '../core/ollama.js';

export const BENCH_DEFAULTS = Object.freeze({
  prompt: 'What is 17 multiplied by 23? Reply with only the number.',
  expect: '391',
  attempts: 3,
  timeout: 90, // seconds to wait for each attempt
});

/** Strip thousands separators so "1,391" and "391" compare the way a person would. */
const norm = s => String(s || '').toLowerCase().replace(/(\d)[,\s](?=\d{3}\b)/g, '$1');

/**
 * One attempt. Resolves to { ok, ms, ttft, tps, error } and never throws (except nothing: abort => error 'stopped').
 * ok = the model answered within the timeout, and the answer contains `expect` when one is given.
 */
export async function benchAttempt(conn, model, { prompt, expect, timeout }, signal) {
  const t0 = performance.now();
  let ttft = 0;
  try {
    const out = await chatStream(
      { model, messages: [{ role: 'user', content: prompt }], options: { temperature: 0, num_predict: 1024 }, keep_alive: '10m' },
      {
        conn, signal, retries: 0,
        firstTokenTimeout: timeout * 1000, idleTimeout: Math.min(timeout, 60) * 1000,
        onChunk: (m) => { if (!ttft && (m.content || m.thinking)) ttft = performance.now() - t0; },
      });
    const ms = performance.now() - t0;
    const answer = norm(out.content);
    if (!out.content.trim()) return { ok: false, ms, ttft, error: out.thinking ? 'only thinking, no answer' : 'empty answer' };
    if (expect && !answer.includes(norm(expect))) return { ok: false, ms, ttft, error: 'wrong answer: ' + out.content.trim().slice(0, 60) };
    const st = out.stats || {};
    const tps = st.eval_count && st.eval_duration ? st.eval_count / (st.eval_duration / 1e9) : 0;
    return { ok: true, ms, ttft: ttft || ms, tps };
  } catch (e) {
    if (signal?.aborted) return { ok: false, ms: performance.now() - t0, ttft, error: 'stopped', stopped: true };
    return { ok: false, ms: performance.now() - t0, ttft, error: String(e.message || e).slice(0, 200) };
  }
}

const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/**
 * Run all attempts for one model and return the summary stored with the model's stats:
 * { benchAt, benchN, benchOk, benchMs, benchTtft, benchTps, benchErr }.
 * The first attempt includes loading the model into memory, so it is reported as `benchMs`
 * only through the average; the time-to-first-token shows the cold start clearly.
 */
export async function benchModel(conn, model, opts, { signal, onAttempt } = {}) {
  const runs = [];
  for (let i = 0; i < opts.attempts; i++) {
    if (signal?.aborted) break;
    const r = await benchAttempt(conn, model, opts, signal);
    if (r.stopped) break;
    runs.push(r);
    onAttempt?.(r, i, runs);
    // A model that fails its first two tries will not recover: do not make the user wait for the rest.
    if (i === 1 && runs.every(x => !x.ok)) break;
  }
  if (!runs.length) return null;
  const good = runs.filter(r => r.ok);
  const lastErr = [...runs].reverse().find(r => !r.ok)?.error || '';
  return {
    benchAt: Date.now(), benchN: runs.length, benchOk: good.length,
    benchMs: Math.round(avg(good.map(r => r.ms))), benchTtft: Math.round(avg(good.map(r => r.ttft))), benchTps: +avg(good.filter(r => r.tps).map(r => r.tps)).toFixed(1),
    benchErr: lastErr.slice(0, 200),
  };
}

/** Skip models that cannot chat. */
export const benchable = m => !(m.caps || []).includes('embedding');

/**
 * Benchmark many models. groups: [{ conn, models: [name, ...] }]. One server runs one model at a time
 * (a GPU runs one model at a time); different servers run side by side.
 * save(conn, name, summary) stores the result; onStart/onDone report progress.
 */
export async function runBench(groups, opts, { signal, save, onStart, onAttempt, onDone } = {}) {
  await Promise.all(groups.map(async g => {
    for (const name of g.models) {
      if (signal?.aborted) return;
      onStart?.(g.conn, name);
      let res = null;
      try { res = await benchModel(g.conn, name, opts, { signal, onAttempt: (r, i) => onAttempt?.(g.conn, name, r, i) }); }
      catch (e) { res = { benchAt: Date.now(), benchN: 1, benchOk: 0, benchMs: 0, benchTtft: 0, benchTps: 0, benchErr: String(e.message || e).slice(0, 200) }; }
      if (res) { try { await save?.(g.conn, name, res); } catch (e) { console.warn('bench not saved', e); } }
      onDone?.(g.conn, name, res);
    }
  }));
}
