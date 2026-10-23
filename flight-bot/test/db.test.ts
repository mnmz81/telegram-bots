import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  activeTracked, addCheck, addTracked, history, kvGet, kvSet, lastCheck,
  blockedFlights, loadOption, pruneOptions, saveOption, setBlocked, stopAll, stopExpired, stopTracked, takeOption,
} from '../src/db';

const item = { dest: 'BBB', out: '2026-12-03', ret: '2026-12-07', outKey: 'OS 858|2026-12-03 10:15', retKey: 'OS 859|2026-12-07 12:00', label: '3–7.12' };
const first = { chosenPrice: 1900, cheapestPrice: 1200, cheapestLabel: 'Wizz Air 14:30' };
const t0 = '2026-11-01T08:00:00Z';
const t1 = '2026-11-02T08:00:00Z';

describe('tracked items and price points', () => {
  it('stores an item with its baseline and reads checks back oldest-first', async () => {
    const id = await addTracked(env.DB, item, first, t0);
    expect((await activeTracked(env.DB)).map((t) => t.id)).toEqual([id]);
    await addCheck(env.DB, id, { ...first, chosenPrice: 1800 }, t1);
    expect((await lastCheck(env.DB, id))?.chosenPrice).toBe(1800);
    expect((await history(env.DB, id)).map((h) => h.chosenPrice)).toEqual([1900, 1800]);
    await stopTracked(env.DB, id);
  });
  it('keeps a null chosen price in the history', async () => {
    const id = await addTracked(env.DB, item, first, t0);
    await addCheck(env.DB, id, { ...first, chosenPrice: null }, t1);
    expect((await lastCheck(env.DB, id))?.chosenPrice).toBeNull();
    await stopTracked(env.DB, id);
  });
  it('stops expired items on the outbound date', async () => {
    await addTracked(env.DB, item, first, t0);
    await stopExpired(env.DB, '2026-12-02');
    expect(await activeTracked(env.DB)).toHaveLength(1);
    await stopExpired(env.DB, '2026-12-03');
    expect(await activeTracked(env.DB)).toEqual([]);
  });
  it('stopAll stops every active item', async () => {
    await addTracked(env.DB, item, first, t0);
    await addTracked(env.DB, item, first, t0);
    await stopAll(env.DB);
    expect(await activeTracked(env.DB)).toEqual([]);
  });
  it('returns null for a missing last check', async () => {
    expect(await lastCheck(env.DB, 999999)).toBeNull();
  });
});

describe('cached options', () => {
  it('round-trips a payload and returns null for an unknown id', async () => {
    const id = await saveOption(env.DB, { a: 1 }, t0);
    expect(await loadOption(env.DB, id)).toEqual({ a: 1 });
    expect(await loadOption(env.DB, 999999)).toBeNull();
  });
  it('hands a payload out exactly once', async () => {
    const id = await saveOption(env.DB, { a: 1 }, t0);
    expect(await takeOption(env.DB, id)).toEqual({ a: 1 });
    expect(await takeOption(env.DB, id)).toBeNull();
    expect(await loadOption(env.DB, id)).toBeNull();
  });
  it('prunes options older than the cutoff', async () => {
    const old = await saveOption(env.DB, { a: 1 }, '2026-10-01T00:00:00Z');
    const fresh = await saveOption(env.DB, { a: 2 }, '2026-11-02T00:00:00Z');
    await pruneOptions(env.DB, '2026-11-01T00:00:00Z');
    expect(await loadOption(env.DB, old)).toBeNull();
    expect(await loadOption(env.DB, fresh)).toEqual({ a: 2 });
  });
});

describe('blocked flights', () => {
  it('adds and removes a flight number', async () => {
    await setBlocked(env.DB, 'OS 82', true);
    await setBlocked(env.DB, 'OS 82', true);
    expect((await blockedFlights(env.DB)).filter((f) => f === 'OS 82')).toHaveLength(1);
    await setBlocked(env.DB, 'OS 82', false);
    expect(await blockedFlights(env.DB)).not.toContain('OS 82');
  });
});

describe('kv', () => {
  it('sets, reads and deletes a key', async () => {
    await kvSet(env.DB, 'k', 'v');
    expect(await kvGet(env.DB, 'k')).toBe('v');
    await kvSet(env.DB, 'k', null);
    expect(await kvGet(env.DB, 'k')).toBeNull();
  });
});
