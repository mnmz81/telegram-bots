import { CONFIG, type Env } from './config';
import { hoursAgo, shortDate } from './dates';
import { savedItems, toDigestItem, type DigestItem } from './db';
import { askJson } from './gemini';
import { CATEGORY_LABEL, esc } from './messages';

export class EmailError extends Error {}

// the week's sent items, ranked by Gemini's importance, the owner's 👍/👎 and how many sources covered them
export async function weekTop(db: D1Database, now: Date): Promise<DigestItem[]> {
  const { results } = await db
    .prepare(
      `SELECT di.* FROM digest_items di JOIN digests d ON d.id = di.digest_id LEFT JOIN feedback f ON f.di_id = di.id
       WHERE d.at > ? AND COALESCE(f.vote, 0) >= 0
       ORDER BY di.importance * 2 + COALESCE(f.vote, 0) * 3 + di.coverage DESC, di.id DESC LIMIT ?`,
    )
    .bind(hoursAgo(now, 7 * 24), CONFIG.weeklyTop)
    .all<Record<string, any>>();
  return results.map(toDigestItem);
}

async function trends(env: Env, items: DigestItem[]): Promise<string> {
  if (!items.length) return '';
  try {
    const r = await askJson<{ trends_he: string }>(
      env,
      [
        'These are the top tech stories of the week. In Hebrew, write one short paragraph (3-5 sentences) on the main trends and what to watch next week.',
        'Keep product, company and technology names in English. Plain text.',
        ...items.map((it) => `- ${it.titleHe}: ${it.summaryHe}`),
      ].join('\n'),
      { type: 'OBJECT', properties: { trends_he: { type: 'STRING' } }, required: ['trends_he'] },
    );
    return r.trends_he?.trim() ?? '';
  } catch (err) {
    console.error('gemini weekly failed', err);
    return '';
  }
}

const li = (it: DigestItem) =>
  `<li style="margin-bottom:12px"><a href="${esc(it.url)}" style="font-weight:bold;color:#1a56db">${esc(it.titleHe)}</a>` +
  `<br><span>${esc(it.summaryHe)}</span> <span style="color:#777">· ${esc(CATEGORY_LABEL[it.category])} · ${esc(it.sources)}</span></li>`;

export function weeklyHtml(top: DigestItem[], saved: DigestItem[], trendsText: string): string {
  return `<!doctype html><html lang="he" dir="rtl"><body style="font-family:Arial,sans-serif;direction:rtl;text-align:right;line-height:1.5;max-width:640px;margin:auto">
<h2>🗞 סיכום שבועי</h2>
${trendsText ? `<h3>מגמות השבוע</h3><p>${esc(trendsText)}</p>` : ''}
<h3>הסיפורים החשובים</h3>
${top.length ? `<ol>${top.map(li).join('')}</ol>` : '<p>לא נשלחו סקירות השבוע.</p>'}
${saved.length ? `<h3>📌 שמרת לקריאה</h3><ul>${saved.map(li).join('')}</ul>` : ''}
</body></html>`;
}

export async function sendWeekly(env: Env, now: Date): Promise<void> {
  const [top, saved] = await Promise.all([weekTop(env.DB, now), savedItems(env.DB)]);
  const html = weeklyHtml(top, saved, await trends(env, top));
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    // onboarding@resend.dev can only send to the Resend account's own address: fine for an owner-only bot, no domain needed
    body: JSON.stringify({ from: 'Tech Digest <onboarding@resend.dev>', to: [env.OWNER_EMAIL], subject: `סיכום טכנולוגיה שבועי · ${shortDate(now)}`, html }),
  });
  if (!res.ok) throw new EmailError(`Resend HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
