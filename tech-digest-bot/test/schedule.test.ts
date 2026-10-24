import { env } from 'cloudflare:test';
import { Api } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runBreaking } from '../src/breaking';
import { dueSources, runFetch } from '../src/collect';
import { israelNow } from '../src/dates';
import { allSources, insertItems, kvGet, kvSet, seedSources } from '../src/db';
import { runScheduled } from '../src/schedule';
import { RSS, callsTo, e, geminiAnswer, mockFetch, resetDb, telegram } from './helpers';

beforeEach(resetDb);
afterEach(() => vi.unstubAllGlobals());
const api = () => new Api('t');

describe('israelNow', () => {
  it('follows daylight saving time', () => {
    expect(israelNow(new Date('2026-07-01T05:00:00Z')).hour).toBe(8); // UTC+3
    expect(israelNow(new Date('2026-12-04T06:00:00Z'))).toEqual({ date: '2026-12-04', hour: 8, weekday: 'Fri' }); // UTC+2
  });
});

describe('runScheduled', () => {
  const gemini = (u: string) => (u.includes('generativelanguage') ? geminiAnswer({ picks: [{ id: 1, title_he: 'א', summary_he: 'ב', category: 'ai', tags: [], importance: 3 }], trends_he: 'מגמה' }) : undefined);
  beforeEach(async () => {
    mockFetch();
    await seedSources(env.DB);
    const [s] = await allSources(env.DB);
    await insertItems(env.DB, s.id, [{ url: 'https://a.test/1', title: 'Story one', snippet: '', publishedAt: null }], '2026-12-04T04:00:00.000Z');
  });

  it('sends a digest at 08:00 and 20:00 Israel time only', async () => {
    const f = mockFetch(gemini);
    await runScheduled(e, api(), new Date('2026-12-03T07:00:00Z')); // 09:00 Thursday: nothing
    expect(telegram(f, 'sendMessage')).toHaveLength(0);
    await kvSet(env.DB, 'last_digest', '2026-12-04T00:00:00.000Z');
    await runScheduled(e, api(), new Date('2026-12-04T06:00:00Z')); // 08:00
    expect(telegram(f, 'sendMessage')[0].text).toContain('סקירת בוקר');
  });

  it('emails the weekly summary on Friday 09:00 Israel time', async () => {
    const f = mockFetch(gemini, (u) => (u.includes('resend.com') ? Response.json({ id: 'x' }) : undefined));
    await runScheduled(e, api(), new Date('2026-12-04T07:00:00Z'));
    const [mail] = callsTo(f, 'resend.com');
    expect(mail.body.to).toEqual(['me@example.com']);
    expect(mail.body.html).toContain('dir="rtl"');
  });

  it('tells the owner when the weekly email fails', async () => {
    const f = mockFetch(gemini, (u) => (u.includes('resend.com') ? new Response('nope', { status: 403 }) : undefined));
    await runScheduled(e, api(), new Date('2026-12-04T07:00:00Z'));
    expect(telegram(f, 'sendMessage')[0].text).toContain('המייל השבועי נכשל');
  });
});

describe('runFetch', () => {
  it('rotates RSS sources by hour but fetches Hacker News every hour', async () => {
    mockFetch();
    await seedSources(env.DB);
    const sources = await allSources(env.DB);
    const covered = new Set([0, 1, 2].flatMap((h) => dueSources(sources, h).map((s) => s.id)));
    expect(covered.size).toBe(sources.length);
    for (const h of [0, 1, 2]) expect(dueSources(sources, h).some((s) => s.kind === 'hn')).toBe(true);
  });

  it('stores feed items, splits a TLDR issue once, and warns after three failures in a row', async () => {
    const now = new Date('2026-10-24T05:50:00Z');
    let tldrPages = 0;
    const f = mockFetch((u) => {
      const list = /^https:\/\/tldr\.tech\/api\/rss\/(\w+)$/.exec(u)?.[1];
      if (list) return new Response(RSS([{ title: 'Issue', link: `https://tldr.tech/${list}/2026-10-23`, date: 'Fri, 23 Oct 2026 00:00:00 GMT' }]));
      if (u.startsWith('https://tldr.tech/ai/')) {
        tldrPages++;
        return new Response('<article class="mt-3"><a class="font-bold" href="https://n.test/1"><h3>Story (2 minute read)</h3></a><div class="newsletter-html">x</div></article>');
      }
      if (u.includes('hn.algolia.com')) return Response.json({ hits: [{ objectID: '1', title: 'HN hit', url: 'https://hn.test/1', points: 300 }] });
      if (u.includes('theverge.com')) return new Response('down', { status: 500 });
      return new Response(RSS([{ title: `Item from ${u}`, link: `${u}/post` }]));
    });
    // three days x three consecutive hours: every slice is fetched once a day, so each source is fetched three times
    for (let day = 0; day < 3; day++) {
      for (let h = 0; h < 3; h++) await runFetch(e, api(), new Date(now.getTime() + day * 86_400_000 + h * 3_600_000));
    }
    const titles = (await env.DB.prepare('SELECT title FROM items').all<{ title: string }>()).results.map((r) => r.title);
    expect(titles).toEqual(expect.arrayContaining(['HN hit', 'Story']));
    expect(tldrPages).toBe(1);
    expect(await kvGet(env.DB, 'tldr:https://tldr.tech/ai/2026-10-23')).not.toBeNull();
    const verge = (await allSources(env.DB)).find((s) => s.name === 'The Verge')!;
    expect(verge.failCount).toBe(3);
    expect(telegram(f, 'sendMessage').filter((m) => m.text.includes('The Verge'))).toHaveLength(1);
  });
});

describe('runBreaking', () => {
  const NOW = new Date('2026-10-24T09:50:00Z'); // 12:50 Israel
  async function hotStory(at = NOW) {
    await seedSources(env.DB);
    const src = await allSources(env.DB);
    for (const name of ['The Verge', 'TechCrunch', 'Engadget']) {
      await insertItems(env.DB, src.find((s) => s.name === name)!.id, [
        { url: `https://${name.replace(/\s/g, '')}.test/x`, title: 'Apple unveils foldable iPhone', snippet: 'Fold', publishedAt: at.toISOString() },
      ], new Date(at.getTime() - 3_600_000).toISOString());
    }
  }
  const gemini = (u: string) =>
    u.includes('generativelanguage') ? geminiAnswer({ title_he: 'אפל חושפת אייפון מתקפל', summary_he: 'סיכום', category: 'products', tags: ['Apple'] }) : undefined;

  it('alerts once when three sources cover a story within 3 hours', async () => {
    const f = mockFetch(gemini);
    await hotStory();
    await runBreaking(e, api(), NOW);
    await runBreaking(e, api(), new Date(NOW.getTime() + 3_600_000));
    const sent = telegram(f, 'sendMessage');
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('🚨 <b>אפל חושפת אייפון מתקפל</b>');
    expect(sent[0].text).toContain('The Verge +2');
  });

  it('stays quiet at night', async () => {
    const night = new Date('2026-10-24T21:00:00Z'); // 00:00 Israel
    const f = mockFetch(gemini);
    await hotStory(night);
    await runBreaking(e, api(), night);
    expect(telegram(f, 'sendMessage')).toHaveLength(0);
  });

  it('sends at most two alerts a day', async () => {
    const f = mockFetch(gemini);
    await seedSources(env.DB);
    const src = await allSources(env.DB);
    const hn = src.find((s) => s.kind === 'hn')!;
    await insertItems(env.DB, hn.id, ['Rust 3.0 released', 'Linux kernel drops x86', 'Postgres 20 is out'].map((title, i) => ({
      url: `https://hn.test/${i}`, title, snippet: '', publishedAt: NOW.toISOString(), points: 900,
    })), NOW.toISOString());
    for (let i = 0; i < 3; i++) await runBreaking(e, api(), new Date(NOW.getTime() + i * 60_000));
    expect(telegram(f, 'sendMessage')).toHaveLength(2);
  });
});
