// Recover tool calls that a model wrote as text instead of using native tool calling
// (common with small or older models): <tool_call>{…}</tool_call>, [TOOL_CALLS][…],
// <|python_tag|>{…}, or a reply that is just a JSON tool call.

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

const WRAPPERS = [
  /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g,
  /<\|tool_call\|>\s*([\s\S]*?)(?:<\|\/tool_call\|>|$)/g,
  /<function_call>\s*([\s\S]*?)\s*(?:<\/function_call>|$)/g,
  /\[TOOL_CALLS\]\s*(\[[\s\S]*\])/g,
  /<\|python_tag\|>\s*([\s\S]*?)(?:<\|eom_id\|>|<\|eot_id\|>|$)/g,
];

/** Returns { calls, rest } or null. `rest` is the text with the tool-call markup removed. */
export function extractToolCalls(text, allowed) {
  if (!text || !allowed?.length || !/[{[]/.test(text)) return null;

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
