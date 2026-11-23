// Recover tool calls that a model wrote as text instead of using native tool calling
// (common with small or older models): [CALL]{…}[/CALL], <tool_call>{…}</tool_call>,
// [TOOL_CALLS][…], <|python_tag|>{…}, or a reply that is just a JSON tool call.

// Delimiter the app asks for in "streamed" mode. It is deliberately NOT <tool_call>: some servers
// (e.g. Ollama builds with a built-in Qwen tool parser) try to parse <tool_call> text themselves
// and abort the stream with {"error":"EOF"} when no `tools` were sent. <tool_call> is still
// recognised below for models that write it out of habit.
export const CALL_OPEN = '[CALL]';
export const CALL_CLOSE = '[/CALL]';

const CALL_START_RE = /\[CALL\]|<tool_call>/g;

/** True when `text` contains the start of a tool-call block (either delimiter). */
export const hasCallMarkup = text => /\[CALL\]|<tool_call>/.test(text || '');

/**
 * Progress of tool-call blocks being written in streamed text: where the first block starts,
 * how many blocks have started, and the text of the last (current) one. null if none yet.
 */
export function callProgress(text) {
  const starts = [...String(text || '').matchAll(CALL_START_RE)].map(m => m.index);
  if (!starts.length) return null;
  return { first: starts[0], count: starts.length, current: text.slice(starts[starts.length - 1]) };
}

/** Top-level {...} substrings, aware of JSON strings. */
function jsonObjects(s) {
  const out = [];
  let depth = 0, start = -1, inStr = false, escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { if (depth > 0) inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}' && depth > 0) { depth--; if (depth === 0) { out.push(s.slice(start, i + 1)); start = -1; } }
  }
  return out;
}

const tryParse = s => { try { return JSON.parse(s); } catch { return undefined; } };

function toCall(o, allowed) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (o.function && typeof o.function === 'object') o = o.function;
  const name = o.name || o.tool || o.tool_name || o.function;
  if (typeof name !== 'string' || !allowed.includes(name)) return null;
  let args = o.arguments ?? o.parameters ?? o.args ?? o.input ?? o.tool_input ?? {};
  if (typeof args === 'string') args = tryParse(args) ?? {};
  return { function: { name, arguments: args && typeof args === 'object' ? args : {} } };
}

function callsIn(raw, allowed) {
  const v = tryParse(String(raw).trim());
  const objs = v !== undefined ? (Array.isArray(v) ? v : [v]) : jsonObjects(String(raw)).map(tryParse).filter(Boolean);
  return objs.map(o => toCall(o, allowed)).filter(Boolean);
}

/** End index (exclusive) of the JSON object/array that starts at `from` (after whitespace), or -1. String-aware. */
function jsonEnd(s, from) {
  let i = from;
  while (i < s.length && /\s/.test(s[i])) i++;
  if (s[i] !== '{' && s[i] !== '[') return -1;
  let depth = 0, inStr = false, escaped = false;
  for (; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

/**
 * Blocks written between `open` and `close`. A block ends where the JSON inside it ends, so a close
 * marker that appears inside a string (e.g. in the content of a file being written) does not cut the
 * call short. Unterminated or malformed blocks fall back to "up to the next close marker or the end".
 */
function markedBlocks(text, open, close) {
  const out = [];
  let from = 0;
  for (;;) {
    const s = text.indexOf(open, from);
    if (s < 0) return out;
    const b = s + open.length;
    let rawEnd = jsonEnd(text, b), end;
    if (rawEnd >= 0) {
      end = rawEnd;
      const gap = text.slice(end).match(/^\s*/)[0].length;
      if (text.startsWith(close, end + gap)) end += gap + close.length;
    } else {
      const c = text.indexOf(close, b);
      rawEnd = c < 0 ? text.length : c;
      end = c < 0 ? text.length : c + close.length;
    }
    out.push({ whole: text.slice(s, end), raw: text.slice(b, rawEnd) });
    from = end;
  }
}

const MARKED = [[CALL_OPEN, CALL_CLOSE], ['<tool_call>', '</tool_call>']];

const WRAPPERS = [
  /<\|tool_call\|>\s*([\s\S]*?)(?:<\|\/tool_call\|>|$)/g,
  /<function_call>\s*([\s\S]*?)\s*(?:<\/function_call>|$)/g,
  /\[TOOL_CALLS\]\s*(\[[\s\S]*\])/g,
  /<\|python_tag\|>\s*([\s\S]*?)(?:<\|eom_id\|>|<\|eot_id\|>|$)/g,
];

/** Returns { calls, rest } or null. `rest` is the text with the tool-call markup removed. */
export function extractToolCalls(text, allowed) {
  if (!text || !allowed?.length || !/[{[]/.test(text)) return null;

  for (const [open, close] of MARKED) {
    const calls = [];
    let rest = text;
    for (const b of markedBlocks(text, open, close)) {
      const c = callsIn(b.raw, allowed);
      if (c.length) { calls.push(...c); rest = rest.replace(b.whole, ''); }
    }
    if (calls.length) return { calls, rest: rest.trim() };
  }

  for (const re of WRAPPERS) {
    const calls = [];
    let rest = text;
    for (const m of text.matchAll(re)) {
      const c = callsIn(m[1], allowed);
      if (c.length) { calls.push(...c); rest = rest.replace(m[0], ''); }
    }
    if (calls.length) return { calls, rest: rest.trim() };
  }

  // A reply that is (almost) only a JSON tool call, bare or in a code fence.
  const fenced = [...text.matchAll(/```(?:json|tool_call|tool|javascript|js)?\s*\n?([\s\S]*?)```/g)];
  const cands = fenced.length ? fenced.map(m => [m[0], m[1]]) : jsonObjects(text).map(j => [j, j]);
  const calls = [];
  let rest = text;
  for (const [whole, inner] of cands) {
    const c = callsIn(inner, allowed);
    if (c.length) { calls.push(...c); rest = rest.replace(whole, ''); }
  }
  // Only accept when little prose is left, so JSON examples inside explanations are not executed.
  if (calls.length && rest.trim().length <= 300) return { calls, rest: rest.trim() };
  return null;
}
