import { CONFIG, type Env } from './config';

export class GeminiError extends Error {}

// statuses where another model may still work: quota, unknown model, server trouble
const TRY_NEXT = new Set([404, 429, 500, 502, 503, 504]);

async function generate<T>(env: Env, prompt: string, schema: object | undefined, parse: (text: string) => T): Promise<T> {
  let last: unknown = new GeminiError('no model configured');
  for (const model of CONFIG.models) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, ...(schema && { responseMimeType: 'application/json', responseSchema: schema }) },
      }),
    });
    if (!res.ok) {
      last = new GeminiError(`${model}: HTTP ${res.status}`);
      if (TRY_NEXT.has(res.status)) continue;
      break; // 400/401/403: the key or request is wrong, every model would fail the same way
    }
    const data = await res.json<{ candidates?: { content?: { parts?: { text?: string }[] } }[] }>();
    const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
    try {
      if (!text) throw new GeminiError(`${model}: empty answer`);
      return parse(text);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

export const askJson = <T>(env: Env, prompt: string, schema: object) => generate<T>(env, prompt, schema, (t) => JSON.parse(t) as T);
export const askText = (env: Env, prompt: string) => generate(env, prompt, undefined, (t) => t);
