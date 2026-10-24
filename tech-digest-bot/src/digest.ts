import type { Api } from 'grammy';
import { cluster } from './cluster';
import { CONFIG, type Env } from './config';
import { hoursAgo, israelNow, shortDate } from './dates';
import {
  activeMutes, isMuted, kvGet, kvSet, recentItems, saveDigest, sentTitles, tasteProfile,
  type DigestItem, type ItemRow, type NewDigestItem,
} from './db';
import { askJson } from './gemini';
import { digestKeyboard, displayOrder, formatDigest, sourcesLabel } from './messages';
import { CATEGORIES, type Category } from './sources';

export type Candidate = { key: number; lead: ItemRow; sources: string[]; coverage: number; points: number; category: Category };

const score = (c: Omit<Candidate, 'key'>) => c.coverage * 3 + Math.min(c.points, 1000) / 100;

// one candidate per story, best first; key is the 1-based id Gemini sees
export function toCandidates(groups: ItemRow[][]): Candidate[] {
  return groups
    .map((items) => {
      const sources = [...new Set(items.map((i) => i.source))];
      const lead = items.find((i) => i.snippet) ?? items[0];
      return { lead, sources, coverage: sources.length, points: Math.max(0, ...items.map((i) => i.points ?? 0)), category: lead.category };
    })
    .sort((a, b) => score(b) - score(a))
    .map((c, i) => ({ ...c, key: i + 1 }));
}

type Pick = { id: number; merge?: number[]; title_he: string; summary_he: string; category: string; tags: string[]; importance: number };

export const DIGEST_SCHEMA = {
  type: 'OBJECT',
  properties: {
    picks: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'INTEGER' },
          merge: { type: 'ARRAY', items: { type: 'INTEGER' } },
          title_he: { type: 'STRING' },
          summary_he: { type: 'STRING' },
          category: { type: 'STRING', enum: CATEGORIES },
          tags: { type: 'ARRAY', items: { type: 'STRING' } },
          importance: { type: 'INTEGER' },
        },
        required: ['id', 'title_he', 'summary_he', 'category', 'tags', 'importance'],
      },
    },
  },
  required: ['picks'],
};

export function digestPrompt(candidates: Candidate[], taste: { liked: string[]; disliked: string[] }, muted: string[]): string {
  const lines = candidates.map(
    (c) =>
      `[${c.key}] sources: ${c.sources.join(', ')}${c.points ? ` | HN points: ${c.points}` : ''} | ${c.lead.title}${c.lead.snippet ? ` — ${c.lead.snippet.slice(0, 200)}` : ''}`,
  );
  return [
    'You edit a personal tech-news digest for an Israeli software developer.',
    'Interests: new features and hot industry news, AI and language models, software development and developer tools, gadgets and consumer products.',
    `Pick the ${CONFIG.digestMax - 2}-${CONFIG.digestMax} most important and interesting stories below (fewer if there are not enough good ones).`,
    'Prefer: real launches, new features, major releases, big industry moves, stories several sources cover. Skip: opinion pieces, listicles, deals and discounts, sponsored content, minor updates.',
    'If several candidates are the same story, pick one and put the others\' ids in "merge".',
    'For each pick, in Hebrew: title_he (short, up to ~12 words) and summary_he (1-2 sentences: what happened and why it matters). Keep product, company and technology names in English.',
    'category: ai | dev | products | industry. tags: 1-3 English keywords exactly as they appear in the story (company, product or topic), used for muting. importance: 1 (minor) to 5 (huge).',
    taste.liked.length ? `The owner liked: ${taste.liked.join(', ')}.` : '',
    taste.disliked.length ? `The owner disliked: ${taste.disliked.join(', ')}.` : '',
    muted.length ? `Never pick stories about: ${muted.join(', ')}.` : '',
    '',
    'Candidates:',
    ...lines,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

const clamp = (n: unknown) => Math.min(5, Math.max(1, Math.round(Number(n) || 3)));

// keeps only well-formed picks of real candidates, each candidate once; merged duplicates add their sources
export function validatePicks(raw: { picks?: Pick[] } | null, candidates: Candidate[]): NewDigestItem[] {
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  const used = new Set<number>();
  const out: NewDigestItem[] = [];
  for (const p of raw?.picks ?? []) {
    if (out.length >= CONFIG.digestMax) break;
    const c = byKey.get(p?.id);
    if (!c || used.has(c.key) || typeof p.title_he !== 'string' || !p.title_he.trim() || typeof p.summary_he !== 'string') continue;
    used.add(c.key);
    const merged = (Array.isArray(p.merge) ? p.merge : []).map((k) => byKey.get(k)).filter((m): m is Candidate => !!m && !used.has(m.key));
    merged.forEach((m) => used.add(m.key));
    const sources = [...new Set([c, ...merged].flatMap((m) => m.sources))];
    out.push({
      url: c.lead.url,
      title: c.lead.title,
      snippet: c.lead.snippet,
      sources: sourcesLabel(sources),
      coverage: sources.length,
      titleHe: p.title_he.trim(),
      summaryHe: p.summary_he.trim(),
      category: (CATEGORIES as string[]).includes(p.category) ? (p.category as Category) : c.category,
      tags: (Array.isArray(p.tags) ? p.tags : []).filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()).slice(0, 3),
      importance: clamp(p.importance),
    });
  }
  return out;
}

// Gemini unavailable: the best-scored stories with their original English titles
export const fallbackPicks = (candidates: Candidate[]): NewDigestItem[] =>
  candidates.slice(0, CONFIG.digestMax).map((c) => ({
    url: c.lead.url,
    title: c.lead.title,
    snippet: c.lead.snippet,
    sources: sourcesLabel(c.sources),
    coverage: c.coverage,
    titleHe: c.lead.title,
    summaryHe: c.lead.snippet.slice(0, 200),
    category: c.category,
    tags: [],
    importance: 3,
  }));

export type Digest = { items: DigestItem[]; usedAi: boolean };

// items fetched since the previous digest, muted ones dropped, stories already sent dropped, one Gemini call
export async function buildDigest(env: Env, now: Date, kind: 'scheduled' | 'now'): Promise<Digest | null> {
  const at = now.toISOString();
  const since = (await kvGet(env.DB, 'last_digest')) ?? hoursAgo(now, 24);
  const [rows, mutes, seen, taste] = await Promise.all([
    recentItems(env.DB, since, hoursAgo(now, CONFIG.maxAgeHours)),
    activeMutes(env.DB, at),
    sentTitles(env.DB, hoursAgo(now, 48)),
    tasteProfile(env.DB),
  ]);
  await kvSet(env.DB, 'last_digest', at);
  const kept = rows.filter((r) => !isMuted(`${r.title} ${r.snippet}`, mutes));
  const candidates = toCandidates(cluster(kept, seen)).slice(0, CONFIG.maxCandidates);
  if (!candidates.length) return null;

  let picks: NewDigestItem[];
  let usedAi = true;
  try {
    const prompt = digestPrompt(candidates, taste, mutes.map((m) => m.word));
    picks = validatePicks(await askJson(env, prompt, DIGEST_SCHEMA, kind === 'scheduled' ? 'scheduled' : 'tap'), candidates);
    if (!picks.length) throw new Error('no usable picks');
  } catch (err) {
    console.error('gemini digest failed', err);
    picks = fallbackPicks(candidates);
    usedAi = false;
  }
  return { items: await saveDigest(env.DB, kind, displayOrder(picks), at), usedAi };
}

export function digestHeader(now: Date, kind: 'scheduled' | 'now', usedAi: boolean): string {
  const title = kind === 'now' ? 'סקירה' : israelNow(now).hour < 15 ? 'סקירת בוקר' : 'סקירת ערב';
  return `🗞 <b>${title} · ${shortDate(now)}</b>${usedAi ? '' : '\n<i>Gemini לא זמין כרגע, הכותרות במקור</i>'}`;
}

export async function sendDigest(api: Api, env: Env, digest: Digest, header: string): Promise<void> {
  const chunks = formatDigest(digest.items, header);
  for (const [i, text] of chunks.entries()) {
    await api.sendMessage(env.OWNER_ID, text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(i === chunks.length - 1 && { reply_markup: digestKeyboard(digest.items) }),
    });
  }
}

// returns false when there was nothing new to send
export async function runDigest(env: Env, api: Api, now: Date, kind: 'scheduled' | 'now'): Promise<boolean> {
  const digest = await buildDigest(env, now, kind);
  if (!digest) return false;
  await sendDigest(api, env, digest, digestHeader(now, kind, digest.usedAi));
  return true;
}
