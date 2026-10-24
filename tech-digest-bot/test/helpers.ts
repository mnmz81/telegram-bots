import { env } from 'cloudflare:test';
import { vi } from 'vitest';
import type { Env } from '../src/config';

export const e: Env = { ...env, TELEGRAM_BOT_TOKEN: 't', OWNER_ID: '1', WEBHOOK_SECRET: 's', GEMINI_API_KEY: 'g', RESEND_API_KEY: 'r', OWNER_EMAIL: 'me@example.com' };

export async function resetDb() {
  for (const t of ['feedback', 'saved', 'digest_items', 'digests', 'items', 'sources', 'mutes', 'chat_messages', 'kv']) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
}

export const RSS = (items: { title: string; link: string; date?: string; desc?: string }[], title = 'Test Feed') =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><link>https://x.test</link>` +
  items
    .map((i) => `<item><title><![CDATA[${i.title}]]></title><link>${i.link}</link><pubDate>${i.date ?? 'Sat, 24 Oct 2026 06:00:00 GMT'}</pubDate><description><![CDATA[<p>${i.desc ?? ''}</p>]]></description></item>`)
    .join('') +
  `</channel></rss>`;

export const geminiAnswer = (obj: unknown) =>
  Response.json({ candidates: [{ content: { parts: [{ text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] } }] });

type Route = (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;

// one fetch mock for every outside service; tests add routes, Telegram always answers ok with a fresh message id
export function mockFetch(...routes: Route[]) {
  let messageId = 100;
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    for (const r of routes) {
      const res = await r(url, init);
      if (res) return res;
    }
    if (url.endsWith('/getMe')) return Response.json({ ok: true, result: { id: 9, is_bot: true, first_name: 'b', username: 'b' } });
    if (url.includes('api.telegram.org')) return Response.json({ ok: true, result: { message_id: ++messageId, date: 0, chat: { id: 1, type: 'private' } } });
    return new Response('not mocked', { status: 404 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

export const callsTo = (fn: ReturnType<typeof mockFetch>, needle: string) =>
  fn.mock.calls.filter(([u]) => String(u).includes(needle)).map(([u, init]) => ({ url: String(u), body: init?.body ? JSON.parse(String(init.body)) : null }));

export const telegram = (fn: ReturnType<typeof mockFetch>, method: string) => callsTo(fn, `/${method}`).map((c) => c.body);
