import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

const e = { ...env, TELEGRAM_BOT_TOKEN: 't', OWNER_ID: '1', SERPAPI_KEY: 'k', WEBHOOK_SECRET: 's' };
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const fetchMock = vi.fn();
const post = (headers: Record<string, string>, body = '{}'): any =>
  new Request('https://x/', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation(async (url: string) =>
    Response.json(String(url).endsWith('/getMe')
      ? { ok: true, result: { id: 9, is_bot: true, first_name: 'b', username: 'b' } }
      : { ok: true, result: { message_id: 1 } }),
  );
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe('webhook', () => {
  it('rejects a request without the secret header', async () => {
    const res = await worker.fetch(post({}), e, ctx);
    expect(res.status).toBe(403);
  });
  it('rejects a request with the wrong secret', async () => {
    const res = await worker.fetch(post({ 'X-Telegram-Bot-Api-Secret-Token': 'wrong' }), e, ctx);
    expect(res.status).toBe(403);
  });
  it('rejects everything when no secret is configured', async () => {
    const res = await worker.fetch(post({}), { ...e, WEBHOOK_SECRET: '' }, ctx);
    expect(res.status).toBe(403);
  });
  it('accepts the right secret and stays silent for a stranger', async () => {
    const update = JSON.stringify({
      update_id: 1,
      message: { message_id: 1, date: 0, chat: { id: 2, type: 'private' }, from: { id: 2, is_bot: false, first_name: 'x' }, text: '/search', entities: [{ type: 'bot_command', offset: 0, length: 7 }] },
    });
    const res = await worker.fetch(post({ 'X-Telegram-Bot-Api-Secret-Token': 's' }, update), e, ctx);
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/sendMessage'))).toBe(false);
  });
});
