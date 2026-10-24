// RSS / Atom / TLDR / Hacker News parsing with plain regexes: no XML dependency and little CPU (free plan = 10ms per run)
export type FeedItem = { url: string; title: string; snippet: string; publishedAt: string | null; points?: number };

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// CDATA unwrapped, entities decoded, tags removed (twice: feeds often escape their HTML), whitespace collapsed
export function plainText(s: string): string {
  const unwrapped = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  const once = decodeEntities(unwrapped.replace(/<[^>]*>/g, ' '));
  return decodeEntities(once.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(block);
  return m ? m[1] : null;
}

function atomLink(block: string): string | null {
  for (const m of block.matchAll(/<link\b([^>]*)>/g)) {
    const attrs = m[1];
    const href = /href="([^"]+)"/.exec(attrs)?.[1];
    const rel = /rel="([^"]+)"/.exec(attrs)?.[1];
    if (href && (!rel || rel === 'alternate')) return decodeEntities(href);
  }
  return null;
}

const toIso = (s: string | null): string | null => {
  if (!s) return null;
  const t = Date.parse(plainText(s));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

const snippetOf = (raw: string | null) => (raw ? plainText(raw.slice(0, 3000)).slice(0, 400) : '');

export function feedTitle(xml: string): string | null {
  const head = xml.split(/<(?:item|entry)\b/)[0];
  const t = tag(head, 'title');
  return t ? plainText(t) : null;
}

export function parseFeed(xml: string, max: number): FeedItem[] {
  const items: FeedItem[] = [];
  for (const m of xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/g)) {
    if (items.length >= max) break;
    const block = m[0];
    const title = plainText(tag(block, 'title') ?? '');
    const rssLink = tag(block, 'link');
    const url = (rssLink && plainText(rssLink)) || atomLink(block) || plainText(tag(block, 'guid') ?? '');
    if (!title || !/^https?:\/\//.test(url)) continue;
    items.push({
      url,
      title,
      snippet: snippetOf(tag(block, 'description') ?? tag(block, 'summary') ?? tag(block, 'content:encoded') ?? tag(block, 'content')),
      publishedAt: toIso(tag(block, 'pubDate') ?? tag(block, 'published') ?? tag(block, 'updated') ?? tag(block, 'dc:date')),
    });
  }
  return items;
}

// a TLDR issue page: one <article> per story; sponsor blocks are skipped
export function parseTldrIssue(html: string, publishedAt: string | null): FeedItem[] {
  const items: FeedItem[] = [];
  const re = /<article\b[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>\s*<h3>([\s\S]*?)<\/h3>\s*<\/a>\s*<div class="newsletter-html">([\s\S]*?)<\/div>/g;
  for (const m of html.matchAll(re)) {
    const title = plainText(m[2]);
    if (/\((?:sponsor|sponsored)\)\s*$/i.test(title)) continue;
    items.push({
      url: decodeEntities(m[1]),
      title: title.replace(/\s*\(\d+ minute read\)\s*$/i, '').replace(/\s*\(GitHub Repo\)\s*$/i, ''),
      snippet: plainText(m[3]).slice(0, 400),
      publishedAt,
    });
  }
  return items;
}

type HnHit = { title?: string; url?: string | null; objectID: string; points?: number; created_at?: string };

export function parseHn(json: { hits?: HnHit[] }, minPoints: number): FeedItem[] {
  return (json.hits ?? [])
    .filter((h) => h.title && (h.points ?? 0) >= minPoints)
    .map((h) => ({
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      title: h.title!,
      snippet: '',
      publishedAt: h.created_at ?? null,
      points: h.points,
    }));
}

const TRACKING = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|ref_src$|source$|reflink$|st$|sp$)/i;

// same article from two feeds => same key: no scheme, no www, no tracking params, no fragment, no trailing slash
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    u.searchParams.sort();
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    const q = u.searchParams.toString();
    return `${host}${path}${q ? `?${q}` : ''}`;
  } catch {
    return raw.trim();
  }
}
