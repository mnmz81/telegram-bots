import { DEFAULT_SOURCES, type Category, type SourceKind } from './sources';
import { normalizeUrl, type FeedItem } from './feeds';

export type Source = { id: number; name: string; url: string; kind: SourceKind; category: Category; builtin: boolean; enabled: boolean; failCount: number };
export type ItemRow = {
  id: number; url: string; title: string; snippet: string; publishedAt: string | null; points: number | null;
  source: string; category: Category;
};
export type DigestItem = {
  id: number; digestId: number; pos: number; url: string; title: string; snippet: string; sources: string; coverage: number;
  titleHe: string; summaryHe: string; category: Category; tags: string[]; importance: number; expanded: string | null;
};
export type NewDigestItem = Omit<DigestItem, 'id' | 'digestId' | 'pos' | 'expanded'>;
export type Mute = { id: number; word: string; until: string | null };

export async function kvGet(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare(`SELECT value FROM kv WHERE key = ?`).bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export const kvSet = (db: D1Database, key: string, value: string) =>
  db.prepare(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(key, value).run();

// ---- sources

const toSource = (r: Record<string, any>): Source => ({
  id: r.id, name: r.name, url: r.url, kind: r.kind, category: r.category, builtin: !!r.builtin, enabled: !!r.enabled, failCount: r.fail_count,
});

export const seedSources = (db: D1Database) =>
  db.batch(
    DEFAULT_SOURCES.map((s) =>
      db.prepare(`INSERT OR IGNORE INTO sources (name, url, kind, category, builtin) VALUES (?, ?, ?, ?, 1)`).bind(s.name, s.url, s.kind, s.category),
    ),
  );

export async function allSources(db: D1Database): Promise<Source[]> {
  const { results } = await db.prepare(`SELECT * FROM sources ORDER BY builtin DESC, id`).all<Record<string, any>>();
  return results.map(toSource);
}

export async function addSource(db: D1Database, name: string, url: string): Promise<boolean> {
  const r = await db.prepare(`INSERT OR IGNORE INTO sources (name, url) VALUES (?, ?)`).bind(name, url).run();
  return r.meta.changes > 0;
}

export const toggleSource = (db: D1Database, id: number) =>
  db.prepare(`UPDATE sources SET enabled = 1 - enabled WHERE id = ?`).bind(id).run();

// built-in sources can only be switched off, never deleted (the next seed would bring them back)
export const deleteSource = (db: D1Database, id: number) =>
  db.batch([
    db.prepare(`DELETE FROM items WHERE source_id = ? AND EXISTS (SELECT 1 FROM sources WHERE id = ? AND builtin = 0)`).bind(id, id),
    db.prepare(`DELETE FROM sources WHERE id = ? AND builtin = 0`).bind(id),
  ]);

// returns the new fail count
export async function recordFetch(db: D1Database, id: number, ok: boolean): Promise<number> {
  const row = await db
    .prepare(`UPDATE sources SET fail_count = CASE WHEN ? THEN 0 ELSE fail_count + 1 END WHERE id = ? RETURNING fail_count`)
    .bind(ok ? 1 : 0, id)
    .first<{ fail_count: number }>();
  return row?.fail_count ?? 0;
}

// ---- items

// new urls are inserted; a known url only gets its Hacker News points refreshed
export async function insertItems(db: D1Database, sourceId: number, items: FeedItem[], at: string): Promise<void> {
  if (!items.length) return;
  await db.batch(
    items.map((i) =>
      db
        .prepare(
          `INSERT INTO items (source_id, url, url_norm, title, snippet, published_at, fetched_at, points) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(url_norm) DO UPDATE SET points = excluded.points WHERE excluded.points IS NOT NULL`,
        )
        .bind(sourceId, i.url, normalizeUrl(i.url), i.title, i.snippet, i.publishedAt, at, i.points ?? null),
    ),
  );
}

// items of enabled sources fetched after `since` and published after `minPublished` (unknown publish dates pass)
export async function recentItems(db: D1Database, since: string, minPublished: string): Promise<ItemRow[]> {
  const { results } = await db
    .prepare(
      `SELECT i.id, i.url, i.title, i.snippet, i.published_at, i.points, s.name AS source, s.category
       FROM items i JOIN sources s ON s.id = i.source_id
       WHERE s.enabled = 1 AND i.fetched_at > ? AND (i.published_at IS NULL OR i.published_at > ?)
       ORDER BY i.id`,
    )
    .bind(since, minPublished)
    .all<Record<string, any>>();
  return results.map((r) => ({
    id: r.id, url: r.url, title: r.title, snippet: r.snippet, publishedAt: r.published_at, points: r.points, source: r.source, category: r.category,
  }));
}

export const pruneItems = (db: D1Database, before: string) =>
  db.prepare(`DELETE FROM items WHERE fetched_at < ?`).bind(before).run();

// ---- digests

export const toDigestItem = (r: Record<string, any>): DigestItem => ({
  id: r.id, digestId: r.digest_id, pos: r.pos, url: r.url, title: r.title, snippet: r.snippet, sources: r.sources, coverage: r.coverage,
  titleHe: r.title_he, summaryHe: r.summary_he, category: r.category, tags: JSON.parse(r.tags), importance: r.importance, expanded: r.expanded,
});

export async function saveDigest(db: D1Database, kind: 'scheduled' | 'now' | 'alert', items: NewDigestItem[], at: string): Promise<DigestItem[]> {
  const d = await db.prepare(`INSERT INTO digests (kind, at) VALUES (?, ?) RETURNING id`).bind(kind, at).first<{ id: number }>();
  const rows = await db.batch<Record<string, any>>(
    items.map((it, pos) =>
      db
        .prepare(
          `INSERT INTO digest_items (digest_id, pos, url, title, snippet, sources, coverage, title_he, summary_he, category, tags, importance)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        )
        .bind(d!.id, pos, it.url, it.title, it.snippet, it.sources, it.coverage, it.titleHe, it.summaryHe, it.category, JSON.stringify(it.tags), it.importance),
    ),
  );
  return rows.map((r) => toDigestItem(r.results[0]));
}

export async function digestItem(db: D1Database, id: number): Promise<DigestItem | null> {
  const r = await db.prepare(`SELECT * FROM digest_items WHERE id = ?`).bind(id).first<Record<string, any>>();
  return r ? toDigestItem(r) : null;
}

export const setExpanded = (db: D1Database, id: number, text: string) =>
  db.prepare(`UPDATE digest_items SET expanded = ? WHERE id = ?`).bind(text, id).run();

// original titles sent since `since` (digests and alerts), so a story is never sent twice
export async function sentTitles(db: D1Database, since: string): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT di.title FROM digest_items di JOIN digests d ON d.id = di.digest_id WHERE d.at > ?`)
    .bind(since)
    .all<{ title: string }>();
  return results.map((r) => r.title);
}

export async function alertsSince(db: D1Database, since: string): Promise<number> {
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM digests WHERE kind = 'alert' AND at > ?`).bind(since).first<{ n: number }>();
  return r?.n ?? 0;
}

// ---- feedback / saved

export async function vote(db: D1Database, id: number): Promise<number> {
  const r = await db.prepare(`SELECT vote FROM feedback WHERE di_id = ?`).bind(id).first<{ vote: number }>();
  return r?.vote ?? 0;
}

// tapping the same vote again clears it
export async function setVote(db: D1Database, id: number, v: 1 | -1, at: string): Promise<number> {
  if ((await vote(db, id)) === v) {
    await db.prepare(`DELETE FROM feedback WHERE di_id = ?`).bind(id).run();
    return 0;
  }
  await db
    .prepare(`INSERT INTO feedback (di_id, vote, at) VALUES (?, ?, ?) ON CONFLICT(di_id) DO UPDATE SET vote = excluded.vote, at = excluded.at`)
    .bind(id, v, at)
    .run();
  return v;
}

export async function isSaved(db: D1Database, id: number): Promise<boolean> {
  return !!(await db.prepare(`SELECT 1 AS x FROM saved WHERE di_id = ?`).bind(id).first());
}

export async function toggleSaved(db: D1Database, id: number, at: string): Promise<boolean> {
  if (await isSaved(db, id)) {
    await db.prepare(`DELETE FROM saved WHERE di_id = ?`).bind(id).run();
    return false;
  }
  await db.prepare(`INSERT INTO saved (di_id, at) VALUES (?, ?)`).bind(id, at).run();
  return true;
}

export async function savedItems(db: D1Database, limit = 20): Promise<DigestItem[]> {
  const { results } = await db
    .prepare(`SELECT di.* FROM saved s JOIN digest_items di ON di.id = s.di_id ORDER BY s.at DESC LIMIT ?`)
    .bind(limit)
    .all<Record<string, any>>();
  return results.map(toDigestItem);
}

// net 👍/👎 per category, source and tag, strongest first; fed to Gemini as the owner's taste
export async function tasteProfile(db: D1Database): Promise<{ liked: string[]; disliked: string[] }> {
  const { results } = await db
    .prepare(`SELECT di.category, di.sources, di.tags, f.vote FROM feedback f JOIN digest_items di ON di.id = f.di_id ORDER BY f.at DESC LIMIT 300`)
    .all<{ category: string; sources: string; tags: string; vote: number }>();
  const score = new Map<string, number>();
  const bump = (k: string, v: number) => score.set(k, (score.get(k) ?? 0) + v);
  for (const r of results) {
    bump(`category:${r.category}`, r.vote);
    bump(`source:${r.sources.replace(/ \+\d+$/, '')}`, r.vote);
    for (const t of JSON.parse(r.tags) as string[]) bump(`topic:${t}`, r.vote);
  }
  const sorted = [...score].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  return {
    liked: sorted.filter(([, v]) => v > 0).slice(0, 15).map(([k]) => k),
    disliked: sorted.filter(([, v]) => v < 0).slice(0, 15).map(([k]) => k),
  };
}

// ---- mutes

export async function activeMutes(db: D1Database, now: string): Promise<Mute[]> {
  const { results } = await db
    .prepare(`SELECT id, word, until FROM mutes WHERE until IS NULL OR until > ? ORDER BY id`)
    .bind(now)
    .all<Mute>();
  return results;
}

export const addMute = (db: D1Database, word: string, until: string | null) =>
  db
    .prepare(`INSERT INTO mutes (word, until) VALUES (?, ?) ON CONFLICT(word) DO UPDATE SET until = excluded.until`)
    .bind(word.toLowerCase().trim(), until)
    .run();

export const removeMute = (db: D1Database, id: number) => db.prepare(`DELETE FROM mutes WHERE id = ?`).bind(id).run();

export const isMuted = (text: string, mutes: Mute[]) => {
  const t = text.toLowerCase();
  return mutes.some((m) => t.includes(m.word));
};

// ---- chat log for /clear

export const logMessage = (db: D1Database, messageId: number, at: string) =>
  db.prepare(`INSERT OR IGNORE INTO chat_messages (message_id, at) VALUES (?, ?)`).bind(messageId, at).run();

export async function takeLoggedMessages(db: D1Database): Promise<{ messageId: number; at: string }[]> {
  const { results } = await db.prepare(`DELETE FROM chat_messages RETURNING message_id, at`).all<{ message_id: number; at: string }>();
  return results.map((r) => ({ messageId: r.message_id, at: r.at }));
}

export const pruneMessages = (db: D1Database, before: string) =>
  db.prepare(`DELETE FROM chat_messages WHERE at < ?`).bind(before).run();
