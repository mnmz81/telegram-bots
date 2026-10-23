import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addTracked, activeTracked, stopAll, kvGet } from '../src/db';
import { needsConfirm } from '../src/quota';
import { compare, runTracking, shouldRunNow } from '../src/tracking';
import fixture from './fixtures/flights.json';

describe('needsConfirm', () => {
  it('lets a search through when the reserve stays intact', () => {
    expect(needsConfirm(184, 10)).toBe(false);
    expect(needsConfirm(70, 10)).toBe(false);
  });
  it('asks when the search would dip under the reserve', () => {
    expect(needsConfirm(65, 10)).toBe(true);
  });
});

const c = (chosen: number | null, cheapest: number | null) => ({
  chosenPrice: chosen, cheapestPrice: cheapest, cheapestLabel: 'Wizz Air 14:30',
});

describe('compare', () => {
  it('reports a chosen-flight drop', () => {
    expect(compare(c(1900, 1200), c(1800, 1200), 'L')).toEqual([{ kind: 'chosen_drop', price: 1800, was: 1900, label: 'L' }]);
  });
  it('reports a cheapest drop with the cheapest flight label', () => {
    expect(compare(c(1900, 1200), c(1950, 1100), 'L')).toEqual([
      { kind: 'cheapest_drop', price: 1100, was: 1200, label: 'Wizz Air 14:30' },
    ]);
  });
  it('is silent on equal prices and rises', () => {
    expect(compare(c(1900, 1200), c(1900, 1200), 'L')).toEqual([]);
    expect(compare(c(1900, 1200), c(2000, 1300), 'L')).toEqual([]);
  });
  it('reports a vanished chosen flight once', () => {
    expect(compare(c(1900, 1200), c(null, 1200), 'L')).toEqual([{ kind: 'chosen_gone', label: 'L' }]);
    expect(compare(c(null, 1200), c(null, 1200), 'L')).toEqual([]);
  });
});

describe('shouldRunNow', () => {
  it('runs at 11 with any active item, at 20 only with exactly one', () => {
    expect(shouldRunNow(11, 2)).toBe(true);
    expect(shouldRunNow(20, 1)).toBe(true);
    expect(shouldRunNow(20, 2)).toBe(false);
    expect(shouldRunNow(11, 0)).toBe(false);
    expect(shouldRunNow(10, 1)).toBe(false);
  });
});

describe('runTracking', () => {
  const e = { ...env, TELEGRAM_BOT_TOKEN: 't', OWNER_ID: '1', SERPAPI_KEY: 'k', WEBHOOK_SECRET: 's' };
  const item = { dest: 'BBB', out: '2026-12-03', ret: '2026-12-07', outKey: 'OS 858|2026-12-03 10:15', retKey: 'OS 859|2026-12-07 12:00', label: '3–7.12' };
  const baseline = { chosenPrice: 1900, cheapestPrice: 1200, cheapestLabel: 'Wizz Air 14:30' };
  const returns = {
    best_flights: [{
      flights: [{ departure_airport: { time: '2026-12-07 12:00' }, arrival_airport: { time: '2026-12-07 14:30' }, airline: 'Austrian', flight_number: 'OS 859', extensions: [] }],
      price: 1700,
    }],
  };
  const eleven = new Date('2026-12-01T09:00:00Z'); // 11:00 Israel
  const fetchMock = vi.fn();
  const telegramTexts = () =>
    fetchMock.mock.calls.filter(([u]) => String(u).includes('api.telegram.org')).map(([, init]) => JSON.parse(init.body).text as string);

  beforeEach(async () => {
    vi.stubGlobal('fetch', fetchMock);
    await stopAll(env.DB);
    await addTracked(env.DB, item, baseline, '2026-11-01T08:00:00Z');
  });
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });
  const route = (left: number) =>
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('api.telegram.org')) return Response.json({ ok: true, result: { message_id: 1 } });
      if (u.includes('account.json')) return Response.json({ total_searches_left: left });
      return Response.json(u.includes('departure_token') ? returns : fixture);
    });

  it('pauses with one message while the reserve is low, without searching', async () => {
    route(40);
    await runTracking(e, eleven);
    await runTracking(e, eleven);
    expect(telegramTexts()).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('search.json'))).toBe(false);
  });
  it('notifies a chosen-flight drop and stores the new price', async () => {
    route(200);
    await runTracking(e, eleven);
    expect(telegramTexts()).toHaveLength(1);
    expect(telegramTexts()[0]).toContain('₪1,700');
  });
  it('tells the owner once when the quota lookup fails', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('api.telegram.org')
        ? Response.json({ ok: true, result: { message_id: 1 } })
        : Response.json({ error: 'Invalid API key.' }));
    await runTracking(e, eleven);
    await runTracking(e, eleven);
    expect(telegramTexts()).toHaveLength(1);
    expect(telegramTexts()[0]).toContain('Invalid API key.');
  });
  it('tells the owner once when a price check fails', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('api.telegram.org')) return Response.json({ ok: true, result: { message_id: 1 } });
      if (u.includes('account.json')) return Response.json({ total_searches_left: 200 });
      return Response.json({ error: 'Rate limit hit.' });
    });
    await runTracking(e, eleven);
    await runTracking(e, eleven);
    expect(telegramTexts()).toHaveLength(1);
    expect(telegramTexts()[0]).toContain('Rate limit hit.');
  });
  it('does nothing outside the check hours', async () => {
    route(200);
    await runTracking(e, new Date('2026-12-01T10:00:00Z'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('does nothing after the search end date', async () => {
    route(200);
    await runTracking(e, new Date('2027-01-02T09:00:00Z'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('stops items on their outbound date before checking', async () => {
    route(200);
    await runTracking(e, new Date('2026-12-03T09:00:00Z'));
    expect(await activeTracked(env.DB)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await kvGet(env.DB, 'pause_notified')).toBeNull();
  });
});
