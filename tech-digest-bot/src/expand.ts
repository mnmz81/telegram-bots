import { CONFIG, type Env } from './config';
import { setExpanded, type DigestItem } from './db';
import { plainText } from './feeds';
import { askText } from './gemini';

// readable text of an article page; '' when it cannot be fetched (paywall, bot block, timeout)
export async function articleText(url: string): Promise<string> {
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; tech-digest-bot)' }, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return '';
    // shortcut: only the first 300KB is read, enough for the article body on news sites; raise it if long reads come back cut
    const html = (await res.text()).slice(0, 300_000).replace(/<(script|style|noscript|svg|nav|header|footer)\b[\s\S]*?<\/\1>/gi, ' ');
    const article = /<article\b[\s\S]*?<\/article>/i.exec(html)?.[0] ?? html;
    return plainText(article).slice(0, CONFIG.expandChars);
  } catch {
    return '';
  }
}

export const expandPrompt = (it: DigestItem, text: string) =>
  [
    'Summarize this tech news story in Hebrew, 5-6 short lines: what happened, the key details and numbers, and why it matters to a software developer.',
    'Keep product, company and technology names in English. Plain text, no markdown.',
    `Title: ${it.title}`,
    text.length > 300 ? `Article:\n${text}` : `Only a short description is available: ${it.snippet || it.summaryHe}`,
  ].join('\n');

// cached per item, so a second tap costs no Gemini call
export async function expandItem(env: Env, it: DigestItem): Promise<string> {
  if (it.expanded) return it.expanded;
  const text = (await askText(env, expandPrompt(it, await articleText(it.url)))).replace(/[*#_`]/g, '').trim();
  await setExpanded(env.DB, it.id, text);
  return text;
}
