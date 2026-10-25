import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Api } from 'grammy';
import { addMute, insertItems, kvGet, kvSet, seedSources, allSources } from '../src/db';
import { buildDigest, runDigest, toCandidates, validatePicks } from '../src/digest';
import { formatDigest } from '../src/messages';
import { e, geminiAnswer, mockFetch, resetDb, telegram, callsTo } from './helpers';

const NOW = new Date('2026-10-24T05:00:00Z'); // 08:00 Israel
const FETCHED = '2026-10-24T03:00:00.000Z';

async function seedItems() {
  await seedSources(env.DB);
  const src = await allSources(env.DB);
  const id = (name: string) => src.find((s) => s.name === name)!.id;
  await insertItems(env.DB, id('The Verge'), [
    { url: 'https://verge.test/gpt6', title: 'OpenAI releases GPT-6 model', snippet: 'A new model', publishedAt: FETCHED },
    { url: 'https://verge.test/ipad', title: 'Apple announces new iPad Pro', snippet: 'Tablet', publishedAt: FETCHED },
    { url: 'https://verge.test/crypto', title: 'Bitcoin hits record high', snippet: 'Crypto', publishedAt: FETCHED },
    { url: 'https://verge.test/old', title: 'Ancient story from last month', snippet: '', publishedAt: '2026-09-01T00:00:00.000Z' },
  ], FETCHED);
  await insertItems(env.DB, id('TechCrunch'), [
    { url: 'https://tc.test/gpt6?utm_source=rss', title: 'OpenAI releases GPT-6 model today', snippet: '', publishedAt: FETCHED },
  ], FETCHED);
}

const picksFor = (ids: number[]) => ({
  picks: ids.map((id, i) => ({ id, title_he: `כותרת ${id}`, summary_he: `תקציר ${id}`, category: i === 0 ? 'products' : 'ai', tags: ['OpenAI'], importance: 5 - i })),
});

let fetchMock: ReturnType<typeof mockFetch>;
beforeEach(resetDb);
afterEach(() => vi.unstubAllGlobals());

describe('candidates', () => {
  it('merges the same story from two sources and drops too-old items', async () => {
    fetchMock = mockFetch();
    await seedItems();
    await kvSet(env.DB, 'last_digest', '2026-10-23T00:00:00.000Z');
    fetchMock = mockFetch((u, init) => {
      if (!u.includes('generativelanguage')) return;
      const prompt = JSON.parse(String(init!.body)).contents[0].parts[0].text as string;
      expect(prompt).toContain('[1] sources: The Verge, TechCrunch');
      expect(prompt).not.toContain('Ancient story');
      return geminiAnswer(picksFor([1, 2]));
    });
    const d = await buildDigest(e, NOW, 'scheduled');
    expect(d!.items).toHaveLength(2);
    // display order: ai before products, numbers follow it
    expect(d!.items.map((i) => [i.pos, i.category, i.sources])).toEqual([[0, 'ai', 'The Verge'], [1, 'products', 'The Verge +1']]);
  });
});

describe('buildDigest', () => {
  beforeEach(async () => {
    mockFetch();
    await seedItems();
    await kvSet(env.DB, 'last_digest', '2026-10-23T00:00:00.000Z');
  });

  it('falls through to the next model on 429 and uses its answer', async () => {
    fetchMock = mockFetch((u) => {
      if (u.includes('gemini-3.8-flash')) return new Response('quota', { status: 429 });
      if (u.includes('gemini-3.6-flash')) return geminiAnswer(picksFor([1, 2, 3]));
    });
    const d = await buildDigest(e, NOW, 'scheduled');
    expect(d!.items).toHaveLength(3);
    expect(callsTo(fetchMock, 'generativelanguage').map((c) => c.url.match(/models\/([^:]+)/)![1])).toEqual(['gemini-3.8-flash', 'gemini-3.6-flash']);
  });

  it('retries a model once on 503 before falling back', async () => {
    let first = true;
    fetchMock = mockFetch((u) => {
      if (!u.includes('generativelanguage')) return;
      if (u.includes('gemini-3.8-flash') && first) {
        first = false;
        return new Response('high demand', { status: 503 });
      }
      return geminiAnswer(picksFor([1]));
    });
    expect((await buildDigest(e, NOW, 'scheduled'))!.items).toHaveLength(1);
    expect(callsTo(fetchMock, 'generativelanguage').map((c) => c.url.match(/models\/([^:]+)/)![1])).toEqual(['gemini-3.8-flash', 'gemini-3.8-flash']);
  });

  it('scheduled digests retry a busy model longer than a tap does', async () => {
    const tries = async (kind: 'scheduled' | 'now') => {
      await kvSet(env.DB, 'last_digest', '2026-10-23T00:00:00.000Z');
      await env.DB.prepare('DELETE FROM digest_items').run();
      fetchMock = mockFetch((u) => (u.includes('generativelanguage') ? new Response('high demand', { status: 503 }) : undefined));
      await buildDigest(e, NOW, kind).catch(() => {});
      return callsTo(fetchMock, 'gemini-3.8-flash').length;
    };
    expect(await tries('scheduled')).toBe(4);
    expect(await tries('now')).toBe(2);
  });

  it('a send-now tap stops retrying near the time limit', async () => {
    let t = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => t);
    fetchMock = mockFetch((u) => {
      if (!u.includes('generativelanguage')) return;
      t += 30_000; // this call took past the tap budget
      return new Response('high demand', { status: 503 });
    });
    await expect(buildDigest(e, NOW, 'now')).rejects.toThrow('out of time');
    expect(callsTo(fetchMock, 'generativelanguage')).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it('never saves English titles when every model fails, and keeps the stories for the next try', async () => {
    fetchMock = mockFetch((u) => (u.includes('generativelanguage') ? new Response('down', { status: 503 }) : undefined));
    await expect(buildDigest(e, NOW, 'scheduled')).rejects.toThrow('HTTP 503');
    expect(await env.DB.prepare('SELECT count(*) n FROM digest_items').first('n')).toBe(0);
    expect(await kvGet(env.DB, 'last_digest')).toBe('2026-10-23T00:00:00.000Z');
  });

  it('fails on unparsable JSON', async () => {
    mockFetch((u) => (u.includes('generativelanguage') ? geminiAnswer('not json {') : undefined));
    await expect(buildDigest(e, NOW, 'scheduled')).rejects.toThrow('gemini-3.5-flash-lite');
  });

  it('stops at a bad key instead of trying every model', async () => {
    fetchMock = mockFetch((u) => (u.includes('generativelanguage') ? new Response('bad key', { status: 403 }) : undefined));
    await expect(buildDigest(e, NOW, 'scheduled')).rejects.toThrow('HTTP 403');
    expect(callsTo(fetchMock, 'generativelanguage')).toHaveLength(1);
  });

  it('leaves muted topics out', async () => {
    await addMute(env.DB, 'Bitcoin', null);
    mockFetch((u, init) => {
      if (!u.includes('generativelanguage')) return;
      const prompt = String(init!.body);
      expect(prompt).not.toContain('Bitcoin hits');
      expect(prompt).toContain('Never pick stories about: bitcoin');
      return geminiAnswer(picksFor([1]));
    });
    await buildDigest(e, NOW, 'scheduled');
  });

  it('never sends a story twice and returns null when nothing is new', async () => {
    mockFetch((u) => (u.includes('generativelanguage') ? geminiAnswer(picksFor([1, 2, 3])) : undefined));
    await buildDigest(e, NOW, 'scheduled');
    expect(await buildDigest(e, new Date(NOW.getTime() + 3_600_000), 'now')).toBeNull();
    // the same story arriving later from a new source is recognised as already sent
    const src = await allSources(env.DB);
    await insertItems(env.DB, src.find((s) => s.name === 'Engadget')!.id, [
      { url: 'https://eng.test/gpt6', title: 'OpenAI releases GPT-6 model', snippet: '', publishedAt: NOW.toISOString() },
    ], new Date(NOW.getTime() + 1000).toISOString());
    expect(await buildDigest(e, new Date(NOW.getTime() + 7_200_000), 'now')).toBeNull();
  });
});

describe('validatePicks', () => {
  const cands = toCandidates([
    [{ id: 1, url: 'https://a.test', title: 'A', snippet: '', publishedAt: null, points: null, source: 'S1', category: 'dev' }],
    [{ id: 2, url: 'https://b.test', title: 'B', snippet: '', publishedAt: null, points: null, source: 'S2', category: 'dev' }],
  ]);

  it('drops unknown ids, repeats and empty titles; merges duplicates', () => {
    const out = validatePicks(
      {
        picks: [
          { id: 99, title_he: 'x', summary_he: 'x', category: 'ai', tags: [], importance: 3 },
          { id: 1, merge: [2], title_he: ' א ', summary_he: 'ב', category: 'weird', tags: ['A', 5 as any, 'B', 'C', 'D'], importance: 9 },
          { id: 2, title_he: 'dup', summary_he: '', category: 'ai', tags: [], importance: 3 },
          { id: 1, title_he: '', summary_he: '', category: 'ai', tags: [], importance: 3 },
        ],
      },
      cands,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ titleHe: 'א', category: 'dev', tags: ['A', 'B', 'C'], importance: 5, sources: 'S1 +1', coverage: 2 });
  });

  it('survives a null answer', () => {
    expect(validatePicks(null, cands)).toEqual([]);
  });
});

describe('formatDigest', () => {
  it('splits only between items when the text passes Telegram\'s limit', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      id: i, digestId: 1, pos: i, url: 'https://a.test/<x>', title: 't', snippet: '', sources: 'S & T', coverage: 1,
      titleHe: `כותרת ${i}`, summaryHe: 'א'.repeat(500), category: 'ai' as const, tags: [], importance: 3, expanded: null,
    }));
    const chunks = formatDigest(items, 'header');
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThan(4096);
    expect(chunks.join('')).toContain('https://a.test/&lt;x&gt;');
    expect(chunks.join('')).toContain('S &amp; T');
    expect(chunks.join('').match(/<b>🤖 AI<\/b>/g)).toHaveLength(1);
  });
});

describe('runDigest', () => {
  it('sends the digest with number buttons on the last message', async () => {
    fetchMock = mockFetch((u) => (u.includes('generativelanguage') ? geminiAnswer(picksFor([1, 2])) : undefined));
    await seedItems();
    expect(await runDigest(e, new Api('t'), NOW, 'scheduled')).toBe(true);
    const [msg] = telegram(fetchMock, 'sendMessage');
    expect(msg.text).toContain('סקירת בוקר · 24.10');
    expect(msg.reply_markup.inline_keyboard.flat().map((b: any) => b.text)).toEqual(['1', '2', '🏠 תפריט']);
  });
});
