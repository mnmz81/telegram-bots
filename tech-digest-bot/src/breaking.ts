import type { Api } from 'grammy';
import { cluster } from './cluster';
import { CONFIG, type Env } from './config';
import { hoursAgo, israelNow } from './dates';
import { activeMutes, alertsSince, isMuted, recentItems, saveDigest, sentTitles, type NewDigestItem } from './db';
import { toCandidates, type Candidate } from './digest';
import { askJson } from './gemini';
import { alertText, cardKeyboard, sourcesLabel } from './messages';
import { CATEGORIES, type Category } from './sources';

const ALERT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title_he: { type: 'STRING' },
    summary_he: { type: 'STRING' },
    category: { type: 'STRING', enum: CATEGORIES },
    tags: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['title_he', 'summary_he', 'category', 'tags'],
};

export const isBreaking = (c: Candidate) => c.coverage >= CONFIG.breaking.minSources || c.points >= CONFIG.breaking.hnPoints;

// the hottest story not sent yet: ≥3 sources within the last 3h, or a Hacker News story past 600 points
export async function findBreaking(env: Env, now: Date): Promise<Candidate | null> {
  const b = CONFIG.breaking;
  const [windowRows, dayRows, mutes, seen] = await Promise.all([
    recentItems(env.DB, hoursAgo(now, b.windowHours), hoursAgo(now, 24)),
    recentItems(env.DB, hoursAgo(now, 24), hoursAgo(now, 24)),
    activeMutes(env.DB, now.toISOString()),
    sentTitles(env.DB, hoursAgo(now, 48)),
  ]);
  const ids = new Set(windowRows.map((r) => r.id));
  const rows = [...windowRows, ...dayRows.filter((r) => !ids.has(r.id) && (r.points ?? 0) >= b.hnPoints)].filter(
    (r) => !isMuted(`${r.title} ${r.snippet}`, mutes),
  );
  return toCandidates(cluster(rows, seen)).find(isBreaking) ?? null;
}

export async function runBreaking(env: Env, api: Api, now: Date): Promise<void> {
  const { hour } = israelNow(now);
  const b = CONFIG.breaking;
  if (hour >= b.quietFrom || hour < b.quietUntil) return;
  if ((await alertsSince(env.DB, hoursAgo(now, 24))) >= b.maxPerDay) return;
  const c = await findBreaking(env, now);
  if (!c) return;

  let ai: { title_he: string; summary_he: string; category: string; tags: string[] } | null = null;
  try {
    ai = await askJson(
      env,
      [
        'Breaking tech news. Write in Hebrew: title_he (up to ~12 words) and summary_he (1-2 sentences: what happened and why it matters).',
        'Keep product, company and technology names in English. category: ai | dev | products | industry. tags: 1-3 English keywords from the story.',
        `Sources: ${c.sources.join(', ')}`,
        `Title: ${c.lead.title}`,
        c.lead.snippet ? `Snippet: ${c.lead.snippet}` : '',
      ].join('\n'),
      ALERT_SCHEMA,
      'scheduled',
    );
  } catch (err) {
    // no English alert: the story is still unsent, so the next :50 run tries again
    console.error('gemini alert failed', err);
    return;
  }
  const item: NewDigestItem = {
    url: c.lead.url,
    title: c.lead.title,
    snippet: c.lead.snippet,
    sources: sourcesLabel(c.sources),
    coverage: c.coverage,
    titleHe: ai?.title_he?.trim() || c.lead.title,
    summaryHe: ai?.summary_he?.trim() || c.lead.snippet.slice(0, 200),
    category: ai && (CATEGORIES as string[]).includes(ai.category) ? (ai.category as Category) : c.category,
    tags: (ai?.tags ?? []).filter((t) => typeof t === 'string').slice(0, 3),
    importance: 5,
  };
  const [saved] = await saveDigest(env.DB, 'alert', [item], now.toISOString());
  await api.sendMessage(env.OWNER_ID, alertText(saved), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: cardKeyboard(saved, 0, false, false),
  });
}
