import { CONFIG, type Env } from './config';
import { isClosed, israelNow, type DatePair } from './dates';
import { kvGet, kvSet } from './db';
import { getProfile, type Profile } from './profile';

export type Leg = { airline: string; flightNumber: string; departAt: string; arriveAt: string };
export type Option = { leg: Leg; price: number; bagExtra: boolean; departureToken?: string };
export type SearchResult = { options: Option[]; googleUrl: string };

export class SearchClosedError extends Error {}
export class SerpApiError extends Error {}

const BASE = 'https://serpapi.com';
const BAG_FEE_TEXT = 'Checked baggage for a fee';
// SerpApi reports an empty result as an error; for us it is just "no flights"
const NO_RESULTS = /hasn't returned any results/i;

export const legKey = (leg: Leg): string => `${leg.flightNumber}|${leg.departAt}`;

export function buildParams(profile: Profile, dest: string, pair: DatePair, departureToken?: string): URLSearchParams {
  const p = new URLSearchParams({
    engine: 'google_flights',
    departure_id: profile.origin,
    arrival_id: dest,
    outbound_date: pair.out,
    return_date: pair.ret,
    type: '1',
    adults: String(profile.adults),
    infants_on_lap: String(profile.infantsOnLap),
    stops: '1',
    currency: CONFIG.currency,
    gl: CONFIG.gl,
    hl: CONFIG.hl,
    sort_by: '2',
    outbound_times: CONFIG.timesParam,
    return_times: CONFIG.timesParam,
  });
  if (departureToken) p.set('departure_token', departureToken);
  return p;
}

const timeOf = (stamp: string) => stamp.slice(-5);

export function parseOptions(json: any): Option[] {
  const itineraries: any[] = [...(json?.best_flights ?? []), ...(json?.other_flights ?? [])];
  const options: Option[] = [];
  for (const it of itineraries) {
    if (it.flights?.length !== 1 || typeof it.price !== 'number') continue;
    const seg = it.flights[0];
    const departAt: string = seg.departure_airport?.time;
    const arriveAt: string = seg.arrival_airport?.time;
    if (!departAt || !arriveAt) continue;
    if (timeOf(departAt) < CONFIG.earliestDepart || timeOf(arriveAt) > CONFIG.latestArrive) continue;
    const notes: string[] = [...(seg.extensions ?? []), ...(it.extensions ?? [])];
    options.push({
      leg: { airline: seg.airline, flightNumber: seg.flight_number, departAt, arriveAt },
      price: it.price,
      bagExtra:
        notes.some((n) => n.includes(BAG_FEE_TEXT)) ||
        (CONFIG.lowCostAirlines as readonly string[]).includes(seg.airline),
      departureToken: it.departure_token,
    });
  }
  return options.sort((a, b) => a.price - b.price);
}

const usedKey = (now: Date) => `used:${israelNow(now).date.slice(0, 7)}`;

// our own tally of searches per Israel calendar month; counts cache hits too, so it can only overstate
export async function searchesUsed(env: Env, now = new Date()): Promise<number> {
  return Number((await kvGet(env.DB, usedKey(now))) ?? 0);
}

async function serpFetch(env: Env, path: string, params: URLSearchParams, now: Date): Promise<any> {
  if (isClosed(now)) throw new SearchClosedError('searching is closed');
  params.set('api_key', env.SERPAPI_KEY);
  const json: any = await (await fetch(`${BASE}${path}?${params}`)).json();
  if (json?.error) {
    if (NO_RESULTS.test(String(json.error))) return {};
    throw new SerpApiError(String(json.error));
  }
  if (path === '/search.json') await kvSet(env.DB, usedKey(now), String((await searchesUsed(env, now)) + 1));
  return json;
}

async function search(env: Env, dest: string, pair: DatePair, now: Date, token?: string): Promise<SearchResult> {
  const json = await serpFetch(env, '/search.json', buildParams(getProfile(env), dest, pair, token), now);
  return { options: parseOptions(json), googleUrl: json.search_metadata?.google_flights_url ?? '' };
}

export const searchPair = (env: Env, dest: string, pair: DatePair, now = new Date()) =>
  search(env, dest, pair, now);

export const searchReturns = (env: Env, dest: string, pair: DatePair, departureToken: string, now = new Date()) =>
  search(env, dest, pair, now, departureToken);

export async function searchPairs(
  env: Env,
  dest: string,
  pairs: DatePair[],
  now = new Date(),
): Promise<(SearchResult | null)[]> {
  const settled = await Promise.allSettled(pairs.map((p) => searchPair(env, dest, p, now)));
  // every search failing means a systemic cause (quota, key, limit): surface it instead of N "failed" rows
  const failures = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failures.length === settled.length && failures.length > 0) throw failures[0].reason;
  return settled.map((r) => {
    if (r.status === 'fulfilled') return r.value;
    // a closed search must reach the caller; one-off failures become null so the other rows still show
    if (r.reason instanceof SearchClosedError) throw r.reason;
    return null;
  });
}

export async function searchesLeft(env: Env, now = new Date()): Promise<number> {
  try {
    const left = Number((await serpFetch(env, '/account.json', new URLSearchParams(), now)).total_searches_left);
    if (Number.isFinite(left)) return left;
  } catch (err) {
    // closed and API errors are real answers; only an unreachable or odd account.json falls back to our own count
    if (err instanceof SearchClosedError || err instanceof SerpApiError) throw err;
  }
  return CONFIG.monthlySearches - (await searchesUsed(env, now));
}
