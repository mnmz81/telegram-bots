import type { Api } from 'grammy';
import { CONFIG, type Env } from './config';
import { israelNow } from './dates';
import { allSources, insertItems, kvGet, kvSet, recordFetch, seedSources, type Source } from './db';
import { parseFeed, parseHn, parseTldrIssue, type FeedItem } from './feeds';
import { esc } from './messages';

const HEADERS = { 'user-agent': 'Mozilla/5.0 (compatible; tech-digest-bot)', accept: '*/*' };

async function get(url: string): Promise<Response> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

// TLDR's feed has one item per issue with no content: each new issue page is fetched once and split into stories
async function fetchTldr(db: D1Database, source: Source, now: Date): Promise<FeedItem[]> {
  const issues = parseFeed(await (await get(source.url)).text(), 3).filter(
    (i) => !i.publishedAt || now.getTime() - Date.parse(i.publishedAt) < 2 * 86_400_000,
  );
  const out: FeedItem[] = [];
  for (const issue of issues) {
    const key = `tldr:${issue.url}`;
    if (await kvGet(db, key)) continue;
    out.push(...parseTldrIssue(await (await get(issue.url)).text(), issue.publishedAt));
    await kvSet(db, key, now.toISOString());
  }
  return out;
}

export async function fetchSource(db: D1Database, source: Source, now: Date): Promise<FeedItem[]> {
  if (source.kind === 'hn') return parseHn(await (await get(source.url)).json(), CONFIG.hnMinPoints);
  if (source.kind === 'tldr') return fetchTldr(db, source, now);
  return parseFeed(await (await get(source.url)).text(), CONFIG.itemsPerFeed);
}

// which sources this hour's run fetches: Hacker News every hour (its points drive breaking alerts), the rest in rotating slices
export const dueSources = (sources: Source[], hour: number) =>
  sources.filter((s) => s.enabled && (s.kind === 'hn' || s.id % CONFIG.feedSlices === hour % CONFIG.feedSlices));

export async function runFetch(env: Env, api: Api, now: Date = new Date()): Promise<void> {
  await seedSources(env.DB);
  const due = dueSources(await allSources(env.DB), israelNow(now).hour);
  const at = now.toISOString();
  const results = await Promise.allSettled(due.map((s) => fetchSource(env.DB, s, now)));
  for (const [i, r] of results.entries()) {
    const s = due[i];
    if (r.status === 'fulfilled') await insertItems(env.DB, s.id, r.value, at);
    else console.error('fetch failed', s.name, r.reason);
    const fails = await recordFetch(env.DB, s.id, r.status === 'fulfilled');
    if (fails === CONFIG.feedFailAlertAfter) {
      await api
        .sendMessage(env.OWNER_ID, `⚠️ המקור <b>${esc(s.name)}</b> נכשל ${fails} פעמים ברצף (${esc(String((r as PromiseRejectedResult).reason))}). אפשר לכבות אותו ב-/sources.`, { parse_mode: 'HTML' })
        .catch(() => {});
    }
  }
}
