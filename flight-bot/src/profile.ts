import type { Env } from './config';

export type Profile = { origin: string; adults: number; infantsOnLap: number; favorites: { code: string; name: string }[] };

export class ConfigError extends Error {}

const IATA = /^[A-Z]{3}$/;

// Trip details (home airport, passengers, favorite destinations) live in the PROFILE Worker secret, not in the repo.
export function getProfile(env: Env): Profile {
  let raw: any;
  try {
    raw = JSON.parse(env.PROFILE);
  } catch {
    throw new ConfigError('PROFILE secret is missing or is not valid JSON');
  }
  if (!IATA.test(raw?.origin)) throw new ConfigError('PROFILE.origin must be a 3-letter uppercase airport code');
  const adults = raw.adults ?? 1;
  const infantsOnLap = raw.infantsOnLap ?? 0;
  if (!Number.isInteger(adults) || adults < 1) throw new ConfigError('PROFILE.adults must be an integer of at least 1');
  if (!Number.isInteger(infantsOnLap) || infantsOnLap < 0) throw new ConfigError('PROFILE.infantsOnLap must be an integer of at least 0');
  const favorites = (Array.isArray(raw.favorites) ? raw.favorites : []).filter(
    (f: any) => IATA.test(f?.code) && typeof f?.name === 'string' && f.name,
  );
  return { origin: raw.origin, adults, infantsOnLap, favorites };
}
