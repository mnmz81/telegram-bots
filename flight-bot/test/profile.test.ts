import { describe, expect, it } from 'vitest';
import type { Env } from '../src/config';
import { ConfigError, getProfile } from '../src/profile';

const env = (p: unknown) => ({ PROFILE: typeof p === 'string' ? p : JSON.stringify(p) }) as unknown as Env;

describe('getProfile', () => {
  it('reads a full profile', () => {
    expect(
      getProfile(env({ origin: 'AAA', adults: 2, infantsOnLap: 1, favorites: [{ code: 'BBB', name: 'יעד' }] })),
    ).toEqual({ origin: 'AAA', adults: 2, infantsOnLap: 1, favorites: [{ code: 'BBB', name: 'יעד' }] });
  });
  it('defaults to one adult, no infant and no favorites', () => {
    expect(getProfile(env({ origin: 'AAA' }))).toEqual({ origin: 'AAA', adults: 1, infantsOnLap: 0, favorites: [] });
  });
  it('drops malformed favorites', () => {
    const p = getProfile(env({ origin: 'AAA', favorites: [{ code: 'bbb', name: 'x' }, { code: 'CCC' }, { code: 'DDD', name: 'ok' }] }));
    expect(p.favorites).toEqual([{ code: 'DDD', name: 'ok' }]);
  });
  it('throws a ConfigError for a missing or non-JSON secret', () => {
    expect(() => getProfile({} as Env)).toThrow(ConfigError);
    expect(() => getProfile(env('not json'))).toThrow(ConfigError);
  });
  it('throws a ConfigError for a bad origin, adult count or infant count', () => {
    expect(() => getProfile(env({ origin: 'tlv' }))).toThrow(ConfigError);
    expect(() => getProfile(env({ origin: 'AAA', adults: 0 }))).toThrow(ConfigError);
    expect(() => getProfile(env({ origin: 'AAA', infantsOnLap: -1 }))).toThrow(ConfigError);
  });
});
