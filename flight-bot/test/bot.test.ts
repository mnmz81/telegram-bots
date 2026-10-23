import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBot, isOwner } from '../src/bot';
import { addTracked, activeTracked, blockedFlights, saveOption, setBlocked, stopAll } from '../src/db';
import fixture from './fixtures/flights.json';

const e = { ...env, TELEGRAM_BOT_TOKEN: 't', OWNER_ID: '1', SERPAPI_KEY: 'k', WEBHOOK_SECRET: 's' };
const october = () => new Date('2026-10-23T09:00:00Z');
const december = () => new Date('2026-12-01T09:00:00Z');
const fetchMock = vi.fn();
const pending: Promise<unknown>[] = [];

const chat = { id: 1, type: 'private' };
const user = (id: number) => ({ id, is_bot: false, first_name: 'x' });
const command = (from: number, text: string) => ({
  update_id: 1,
  message: { message_id: 1, date: 0, chat, from: user(from), text, entities: [{ type: 'bot_command', offset: 0, length: text.length }] },
});
const tap = (from: number, data: string) => ({
  update_id: 1,
  callback_query: { id: 'c', from: user(from), chat_instance: 'x', data, message: { message_id: 1, date: 0, chat } },
});

async function send(update: object, now = october) {
  const bot = createBot(e, (p) => pending.push(p), now);
  await bot.init();
  await bot.handleUpdate(update as any);
  await Promise.all(pending.splice(0));
}
const calls = (method: string) =>
  fetchMock.mock.calls.filter(([u]) => String(u).endsWith(`/${method}`)).map(([, init]) => JSON.parse(init.body));
const sentText = () => calls('sendMessage').map((b) => b.text as string).join('\n');

beforeEach(async () => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.endsWith('/getMe')) return Response.json({ ok: true, result: { id: 9, is_bot: true, first_name: 'b', username: 'b' } });
    if (u.includes('api.telegram.org')) return Response.json({ ok: true, result: { message_id: 1 } });
    if (u.includes('account.json')) return Response.json({ total_searches_left: 200 });
    return Response.json(fixture);
  });
  await stopAll(env.DB);
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe('isOwner', () => {
  it('accepts only the configured user id', () => {
    expect(isOwner(123, '123')).toBe(true);
    expect(isOwner(456, '123')).toBe(false);
    expect(isOwner(undefined, '123')).toBe(false);
  });
});

describe('bot', () => {
  it('ignores a stranger completely', async () => {
    await send(command(2, '/search'));
    await send(tap(2, 'booked'));
    expect(calls('sendMessage')).toEqual([]);
    expect(calls('answerCallbackQuery')).toEqual([]);
  });
  it('offers the favorite destinations to the owner', async () => {
    await send(command(1, '/search'));
    expect(sentText()).toContain('לאן טסים');
  });
  it('refuses /search after the end date', async () => {
    await send(command(1, '/search'), () => new Date('2027-01-02T09:00:00Z'));
    expect(sentText()).toContain('סגורים');
  });
  it('tells the owner an old button expired', async () => {
    await send(tap(1, 'pair:999999'));
    expect(sentText()).toContain('פג תוקף');
  });
  it('states the search cost for a month before running it', async () => {
    await send(tap(1, 'pat:BBB:2026-12:thu'));
    expect(sentText()).toContain('5 חיפושים');
  });
  it('searches a year-crossing weekend with the January return date', async () => {
    const id = await saveOption(env.DB, { dest: 'BBB', pairs: [{ out: '2026-12-31', ret: '2027-01-04' }] }, december().toISOString());
    await send(tap(1, `go:${id}`), december);
    const searched = fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('search.json'));
    expect(searched).toHaveLength(1);
    expect(searched[0]).toContain('return_date=2027-01-04');
    expect(sentText()).toContain('31.12–4.1');
  });
  it('shows the SerpApi error text when the whole month search fails', async () => {
    const id = await saveOption(env.DB, { dest: 'BBB', pairs: [{ out: '2026-12-03', ret: '2026-12-07' }] }, december().toISOString());
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('api.telegram.org')
        ? Response.json({ ok: true, result: { message_id: 1 } })
        : Response.json({ error: 'Your account has run out of searches.' }));
    await send(tap(1, `go:${id}`), december);
    expect(sentText()).toContain('run out of searches');
  });
  it('removes the keyboard on a month search tap and ignores a second tap', async () => {
    const id = await saveOption(env.DB, { dest: 'BBB', pairs: [{ out: '2026-12-03', ret: '2026-12-07' }] }, december().toISOString());
    await send(tap(1, `go:${id}`), december);
    await send(tap(1, `go:${id}`), december);
    expect(calls('editMessageReplyMarkup')).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('search.json'))).toHaveLength(1);
    expect(sentText()).toContain('פג תוקף');
  });
  it('removes the keyboard on a tracking tap and tracks once', async () => {
    const leg = { airline: 'A', flightNumber: 'A 1', departAt: '2026-12-03 10:00', arriveAt: '2026-12-03 12:00' };
    const opt = { leg, price: 1900, bagExtra: false };
    const id = await saveOption(env.DB, { dest: 'BBB', pair: { out: '2026-12-10', ret: '2026-12-14' }, outbound: opt, ret: opt, cheapest: opt }, 't');
    await send(tap(1, `want:${id}`), december);
    await send(tap(1, `want:${id}`), december);
    expect(calls('editMessageReplyMarkup')).toHaveLength(2);
    expect(await activeTracked(env.DB)).toHaveLength(1);
  });
  it('reports used and left searches', async () => {
    await send(command(1, '/quota'));
    expect(sentText()).toContain('נשארו 200');
    expect(sentText()).toContain('נוצלו');
  });
  it('offers each listed flight for hiding', async () => {
    const leg = { airline: 'A', flightNumber: 'A 1', departAt: '2026-12-03 22:00', arriveAt: '2026-12-04 01:00' };
    const id = await saveOption(env.DB, { legs: [leg] }, 't');
    await send(tap(1, `hidemenu:${id}`), december);
    expect(JSON.stringify(calls('sendMessage'))).toContain('hide:A 1');
  });
  it('hides a flight and brings it back from /blocked', async () => {
    await send(tap(1, 'hide:A 1'), december);
    expect(await blockedFlights(env.DB)).toContain('A 1');
    await send(command(1, '/blocked'));
    expect(JSON.stringify(calls('sendMessage'))).toContain('unhide:A 1');
    await send(tap(1, 'unhide:A 1'));
    expect(await blockedFlights(env.DB)).not.toContain('A 1');
  });
  it('says when nothing is hidden', async () => {
    for (const f of await blockedFlights(env.DB)) await setBlocked(env.DB, f, false);
    await send(command(1, '/blocked'));
    expect(sentText()).toContain('אין טיסות מוסתרות');
  });
  it('refuses a third tracked item and offers to stop the others', async () => {
    const item = { dest: 'BBB', out: '2026-12-03', ret: '2026-12-07', outKey: 'a', retKey: 'b', label: '3–7.12' };
    const base = { chosenPrice: 1900, cheapestPrice: 1200, cheapestLabel: 'x' };
    await addTracked(env.DB, item, base, 't');
    await addTracked(env.DB, item, base, 't');
    const leg = { airline: 'A', flightNumber: 'A 1', departAt: '2026-12-03 10:00', arriveAt: '2026-12-03 12:00' };
    const opt = { leg, price: 1900, bagExtra: false };
    const id = await saveOption(env.DB, { dest: 'BBB', pair: { out: '2026-12-10', ret: '2026-12-14' }, outbound: opt, ret: opt, cheapest: opt }, 't');
    await send(tap(1, `want:${id}`), december);
    expect(await activeTracked(env.DB)).toHaveLength(2);
    expect(JSON.stringify(calls('sendMessage'))).toContain('stop:');
  });
  it('stops everything when the owner books', async () => {
    const item = { dest: 'BBB', out: '2026-12-03', ret: '2026-12-07', outKey: 'a', retKey: 'b', label: 'L' };
    await addTracked(env.DB, item, { chosenPrice: 1, cheapestPrice: 1, cheapestLabel: 'x' }, 't');
    await send(tap(1, 'booked'));
    expect(await activeTracked(env.DB)).toEqual([]);
  });
});
