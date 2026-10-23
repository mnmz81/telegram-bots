import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/flights.json';
import {
  SearchClosedError,
  searchesUsed,
  buildParams,
  parseOptions,
  searchPair,
  searchPairs,
  searchesLeft,
} from '../src/serpapi';
import { env as cfEnv } from 'cloudflare:test';
import { getProfile } from '../src/profile';
import type { Env } from '../src/config';

const env = { ...cfEnv, SERPAPI_KEY: 'k' } as unknown as Env;
const pair = { out: '2026-12-03', ret: '2026-12-07' };
const inDecember = new Date('2026-12-01T10:00:00Z');
const fetchMock = vi.fn();

beforeEach(() => vi.stubGlobal('fetch', fetchMock));
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe('parseOptions', () => {
  it('keeps direct in-window flights (depart from 08:00, land by 21:00) sorted by price and marks bag fees', () => {
    const opts = parseOptions(fixture);
    expect(opts.map((o) => o.price)).toEqual([1200, 1500, 1900]);
    expect(opts[0].bagExtra).toBe(true); // Wizz Air
    expect(opts[1].bagExtra).toBe(true); // extension text, lands exactly 21:00
    expect(opts[2].bagExtra).toBe(false);
    expect(opts[2].departureToken).toBe('tokA');
  });
  it('returns nothing for an empty response', () => {
    expect(parseOptions({})).toEqual([]);
  });
});

describe('buildParams', () => {
  it('applies the defaults and the follow-up token', () => {
    const p = buildParams(getProfile(env), 'BBB', { out: '2026-12-31', ret: '2027-01-04' }, 'tokA');
    expect(Object.fromEntries(p)).toMatchObject({
      engine: 'google_flights', departure_id: 'AAA', arrival_id: 'BBB',
      outbound_date: '2026-12-31', return_date: '2027-01-04', type: '1', adults: '2', infants_on_lap: '1',
      stops: '1', currency: 'ILS', gl: 'il', hl: 'en', sort_by: '2',
      outbound_times: '8,23,8,20', return_times: '8,23,8,20', departure_token: 'tokA',
    });
  });
});

describe('searchPair', () => {
  it('never calls fetch after the end date', async () => {
    await expect(searchPair(env, 'BBB', pair, new Date('2027-01-02T10:00:00Z'))).rejects.toBeInstanceOf(SearchClosedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('surfaces the SerpApi error text', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'Your account has run out of searches.' }));
    await expect(searchPair(env, 'BBB', pair, inDecember)).rejects.toThrow('run out of searches');
  });
  it('returns options and the Google Flights link', async () => {
    fetchMock.mockResolvedValueOnce(Response.json(fixture));
    const r = await searchPair(env, 'BBB', pair, inDecember);
    expect(r.options).toHaveLength(3);
    expect(r.googleUrl).toContain('google.com/travel/flights');
  });
});

describe('searchPairs', () => {
  it('marks only the failed slot as null', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json(fixture))
      .mockRejectedValueOnce(new Error('net'))
      .mockResolvedValueOnce(Response.json(fixture));
    const r = await searchPairs(env, 'BBB', [pair, pair, pair], inDecember);
    expect(r[1]).toBeNull();
    expect(r[0]?.options).toHaveLength(3);
    expect(r[2]?.options).toHaveLength(3);
  });
});

describe('searchPairs failures', () => {
  it('rethrows the SerpApi reason when every search fails', async () => {
    fetchMock.mockResolvedValue(Response.json({ error: 'Your account has run out of searches.' }));
    await expect(searchPairs(env, 'BBB', [pair, pair], inDecember)).rejects.toThrow('run out of searches');
  });
});

describe('empty results', () => {
  it('treats the no-results error as an empty option list', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "Google Flights hasn't returned any results for this query." }));
    const r = await searchPair(env, 'BBB', pair, inDecember);
    expect(r.options).toEqual([]);
  });
});

describe('internal search counter', () => {
  it('counts a successful search but not a failed one', async () => {
    const before = await searchesUsed(env, inDecember);
    fetchMock.mockResolvedValueOnce(Response.json(fixture));
    await searchPair(env, 'BBB', pair, inDecember);
    expect(await searchesUsed(env, inDecember)).toBe(before + 1);
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'Rate limit hit.' }));
    await expect(searchPair(env, 'BBB', pair, inDecember)).rejects.toThrow();
    expect(await searchesUsed(env, inDecember)).toBe(before + 1);
  });
  it('does not count account lookups', async () => {
    const before = await searchesUsed(env, inDecember);
    fetchMock.mockResolvedValueOnce(Response.json({ total_searches_left: 100 }));
    await searchesLeft(env, inDecember);
    expect(await searchesUsed(env, inDecember)).toBe(before);
  });
  it('falls back to plan size minus our own count when account.json has no number', async () => {
    const used = await searchesUsed(env, inDecember);
    fetchMock.mockResolvedValueOnce(Response.json({}));
    expect(await searchesLeft(env, inDecember)).toBe(250 - used);
  });
  it('falls back when account.json cannot be reached', async () => {
    const used = await searchesUsed(env, inDecember);
    fetchMock.mockRejectedValueOnce(new Error('net'));
    expect(await searchesLeft(env, inDecember)).toBe(250 - used);
  });
  it('still surfaces a SerpApi error from account.json', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'Invalid API key.' }));
    await expect(searchesLeft(env, inDecember)).rejects.toThrow('Invalid API key.');
  });
});

describe('searchesLeft', () => {
  it('reads total_searches_left from account.json', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ total_searches_left: 184 }));
    expect(await searchesLeft(env, inDecember)).toBe(184);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/account.json');
  });
});
