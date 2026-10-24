import { CONFIG, type Env } from './config';

export class GeminiError extends Error {}

// statuses where another model may still work: quota, unknown model, server trouble
const TRY_NEXT = new Set([404, 429, 500, 502, 503, 504]);

// Google's own reason ('RESOURCE_EXHAUSTED Quota exceeded…'), short enough for a Telegram message
async function reason(res: Response): Promise<string> {
  const body = await res.text();
  let detail = body;
  try {
    const e = JSON.parse(body).error;
    detail = `${e?.status ?? ''} ${e?.message ?? ''}`;
  } catch {}
  return detail.replace(/\s+/g, ' ').trim().slice(0, 160);
}

export type Patience = 'tap' | 'scheduled';

async function generate<T>(env: Env, prompt: string, schema: object | undefined, parse: (text: string) => T, patience: Patience): Promise<T> {
  // every model's failure, not just the last one: the last fallback's error alone hides why the better models failed
  const errors: string[] = [];
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, ...(schema && { responseMimeType: 'application/json', responseSchema: schema }) },
  });
  const call = (model: string) =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body,
    });
  const started = Date.now();
  const outOfTime = (extra = 0) => patience !== 'scheduled' && Date.now() - started + extra > CONFIG.tapBudgetMs;
  for (const model of CONFIG.models) {
    if (outOfTime()) {
      errors.push(`${model}: skipped, out of time`);
      break;
    }
    let res = await call(model);
    for (const wait of CONFIG.geminiRetryMs[patience]) {
      if (res.status !== 503 || outOfTime(wait)) break;
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, wait));
      res = await call(model);
    }
    if (!res.ok) {
      errors.push(`${model}: HTTP ${res.status} ${await reason(res)}`);
      if (TRY_NEXT.has(res.status)) continue;
      break; // 400/401/403: the key or request is wrong, every model would fail the same way
    }
    const data = await res.json<{ candidates?: { content?: { parts?: { text?: string }[] } }[] }>();
    const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
    try {
      if (!text) throw new Error('empty answer');
      return parse(text);
    } catch (err) {
      errors.push(`${model}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.error('gemini failed', errors);
  throw new GeminiError(errors.join('\n') || 'no model configured');
}

export const askJson = <T>(env: Env, prompt: string, schema: object, patience: Patience = 'tap') =>
  generate<T>(env, prompt, schema, (t) => JSON.parse(t) as T, patience);
export const askText = (env: Env, prompt: string) => generate(env, prompt, undefined, (t) => t, 'tap');
