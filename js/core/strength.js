// Estimated model strength for agentic coding (0–100 + tier).
// A heuristic from the model's metadata, refined by what this app measures
// (tool-call success) and by your own star rating. Shown as "estimated" in the UI.

const QUANT = [
  [/^(f32|f16|bf16)/i, 1.0], [/^q8/i, 0.99], [/^q6/i, 0.97], [/^q5/i, 0.95],
  [/^(q4|iq4|mxfp4)/i, 0.92], [/^(q3|iq3)/i, 0.84], [/^(q2|iq2|iq1)/i, 0.72],
];

// Rough model-generation bonus by family / name (newer generations are much stronger per parameter).
const GENERATION = [
  [/qwen3\.[5-9]|qwen35|gemma4|nemotron.?3|laguna|gpt-oss|deepseek-?v3|kimi|glm-?4\.[5-9]|lfm2\.5|devstral|qwen3-?coder/i, 12],
  [/qwen3|gemma3n?|llama4|phi4|mistral-?(small|medium)|command-?a|olmo2|lfm2/i, 6],
  [/qwen2\.5|llama3\.[1-3]|gemma2|cohere2|command-?r|aya/i, 2],
];

const SPECIALIST = /ocr|embed|med|guard|vision-only|math/i;
const DETUNED = /uncensored|abliterated|rude|dolphin/i;

export function paramBillions(m) {
  const s = String(m?.details?.parameter_size || '');
  const v = parseFloat(s);
  if (!isNaN(v)) return /m$/i.test(s) ? v / 1000 : v;
  const fromName = String(m?.name || '').match(/(\d+(?:\.\d+)?)b\b/i);
  return fromName ? parseFloat(fromName[1]) : 0;
}

/** Returns { score, tier, parts: [[label, points], ...] } */
export function strength(model, meta = {}) {
  const parts = [];
  const name = `${model?.name || ''} ${model?.details?.family || ''}`;
  const caps = model?.caps || [];
  const p = paramBillions(model);

  // Size: log scale, 70B ≈ 62 pts, 27B ≈ 48, 8B ≈ 32, 1B ≈ 10
  let score = p ? Math.min(66, 62 * Math.log(p + 1) / Math.log(71)) : 25;
  parts.push([`${p ? p + 'B' : 'unknown'} parameters`, score]);

  const q = String(model?.details?.quantization_level || '');
  const qf = (QUANT.find(([re]) => re.test(q)) || [null, 0.93])[1];
  if (qf !== 1) { const d = score * (qf - 1); score += d; parts.push([`${q || 'unknown'} quantization`, d]); }

  const gen = (GENERATION.find(([re]) => re.test(name)) || [null, 0])[1];
  if (gen) { score += gen; parts.push(['model generation', gen]); }

  if (caps.includes('tools')) { score += 10; parts.push(['tool calling', 10]); } else if (caps.length) { score -= 15; parts.push(['no tool calling', -15]); }
  if (caps.includes('thinking')) { score += 7; parts.push(['reasoning', 7]); }
  if (caps.includes('vision')) { score += 2; parts.push(['vision', 2]); }

  const ctx = model?.details?.context_length || 0;
  if (ctx >= 131072) { score += 3; parts.push(['long context', 3]); } else if (ctx && ctx < 16384) { score -= 4; parts.push(['short context', -4]); }

  if (SPECIALIST.test(name)) { score -= 18; parts.push(['specialist model', -18]); }
  if (DETUNED.test(name)) { score -= 5; parts.push(['fine-tuned for chat/uncensored', -5]); }

  // Measured: tool-call reliability in this app (needs a few calls to count)
  if ((meta.toolCalls || 0) >= 5) {
    const ok = 1 - (meta.toolErrors || 0) / meta.toolCalls;
    const d = Math.max(-12, Math.min(8, (ok - 0.85) * 40));
    score += d; parts.push([`measured tool success ${Math.round(ok * 100)}%`, d]);
  }

  score = Math.max(0, Math.min(100, score));

  // Your rating pulls the estimate 35% toward it
  if (meta.rating) {
    const blended = score * 0.65 + meta.rating * 20 * 0.35;
    parts.push([`your rating ${meta.rating}★`, blended - score]);
    score = blended;
  }

  score = Math.round(score);
  const tier = score >= 85 ? 'S' : score >= 70 ? 'A' : score >= 55 ? 'B' : score >= 40 ? 'C' : 'D';
  return { score, tier, parts };
}
