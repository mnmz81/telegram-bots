import { InlineKeyboard, Keyboard } from 'grammy';
import type { DigestItem, ItemState, Mute, Source } from './db';
import { CATEGORIES, type Category } from './sources';

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const CATEGORY_LABEL: Record<Category, string> = { ai: '🤖 AI', dev: '🛠 פיתוח', products: '📱 מוצרים', industry: '🚀 תעשייה' };
export const BACK = '⬅️ חזרה';
// Telegram's limit is 4096; headroom for the HTML entities count
const MAX_MESSAGE = 3900;

export const sourcesLabel = (names: string[]) => (names.length > 1 ? `${names[0]} +${names.length - 1}` : (names[0] ?? ''));

// category order first, then importance: the stored pos follows this order, so the numbers match the buttons
export const displayOrder = <T extends { category: Category; importance: number }>(items: T[]) =>
  [...items].sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || b.importance - a.importance);

const itemLine = (it: DigestItem) =>
  `${it.pos + 1}. <a href="${esc(it.url)}"><b>${esc(it.titleHe)}</b></a>\n${it.summaryHe ? `${esc(it.summaryHe)} ` : ''}<i>· ${esc(it.sources)}</i>`;

// one message unless it would pass Telegram's limit; splits only between items
export function formatDigest(items: DigestItem[], header: string): string[] {
  const blocks: string[] = [];
  let category: Category | null = null;
  for (const it of items) {
    const head = it.category !== category ? `\n<b>${CATEGORY_LABEL[it.category]}</b>\n` : '';
    category = it.category;
    blocks.push(`${head}${itemLine(it)}`);
  }
  const chunks: string[] = [];
  let cur = header;
  for (const b of blocks) {
    if (cur.length + b.length + 1 > MAX_MESSAGE) {
      chunks.push(cur);
      cur = b.trimStart();
    } else cur += `\n${b}`;
  }
  chunks.push(cur);
  return chunks;
}

export function digestKeyboard(items: DigestItem[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  items.forEach((it, i) => {
    kb.text(String(it.pos + 1), `it:${it.id}`);
    if (i % 6 === 5) kb.row();
  });
  return kb.row().text('🏠 תפריט', 'm:new');
}

export const alertText = (it: DigestItem) =>
  `🚨 <b>${esc(it.titleHe)}</b>\n${esc(it.summaryHe)}\n<a href="${esc(it.url)}">לכתבה</a> <i>· ${esc(it.sources)}</i>`;

export const cardText = (it: DigestItem) =>
  `<b>${esc(it.titleHe)}</b>\n${esc(it.summaryHe)}\n<a href="${esc(it.url)}">${esc(it.title)}</a>\n<i>${esc(it.sources)}</i>`;

// closable: a card opened from a digest number; an alert carries the same buttons on itself and is never closed
export function cardKeyboard(it: DigestItem, vote: number, saved: boolean, closable = true): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text(vote === 1 ? '👍 ✓' : '👍', `v:${it.id}:1`)
    .text(vote === -1 ? '👎 ✓' : '👎', `v:${it.id}:-1`)
    .text(saved ? '📌 נשמר ✓' : '📌 שמור', `sv:${it.id}`)
    .row()
    .text('🔍 הרחב', `ex:${it.id}`)
    .text('🔇 השתק נושא', `mu:${it.id}`);
  return closable ? kb.row().text(BACK, 'x') : kb;
}

export const cardView = (s: ItemState) => ({
  text: s.alert ? alertText(s.item) : cardText(s.item),
  keyboard: cardKeyboard(s.item, s.vote, s.saved, !s.alert),
});

// the persistent button under the input field: the way back to the menu without typing
export const HOME = '🏠 תפריט';
export const homeKeyboard = () => new Keyboard().text(HOME).resized().persistent();

export const MENU_TEXT = '🗞 <b>תפריט</b>\nסקירות נשלחות ב-08:00 וב-20:00, ומייל שבועי בשישי ב-09:00.';

export const menuKeyboard = () =>
  new InlineKeyboard()
    .text('⚡ שלח סקירה עכשיו', 'm:now')
    .row()
    .text('📌 שמורים', 'm:saved')
    .text('📰 מקורות', 'm:src')
    .row()
    .text('🔇 השתקות', 'm:mut')
    .text('📧 מייל שבועי עכשיו', 'm:weekly')
    .row()
    .text('🧹 ניקוי מסך', 'm:clear');

export function sourcesScreen(sources: Source[]): { text: string; keyboard: InlineKeyboard } {
  const kb = new InlineKeyboard();
  for (const s of sources) {
    kb.text(`${s.enabled ? '✅' : '⛔'} ${s.name}`, `st:${s.id}`).row();
  }
  kb.text(BACK, 'm:home');
  return { text: '📰 <b>מקורות</b>\nלחיצה מפעילה או מכבה מקור.', keyboard: kb };
}

export function mutesScreen(mutes: Mute[]): { text: string; keyboard: InlineKeyboard } {
  const kb = new InlineKeyboard();
  for (const m of mutes) kb.text(`❌ ${m.word}${m.until ? ` (עד ${m.until.slice(8, 10)}.${m.until.slice(5, 7)})` : ''}`, `um:${m.id}`).row();
  kb.text(BACK, 'm:home');
  const text = mutes.length ? '🔇 <b>השתקות</b>\nלחיצה מבטלת השתקה.' : '🔇 <b>השתקות</b>\nאין נושאים מושתקים.';
  return { text: `${text}\nלהשתקת נושא: פותחים כתבה מהסקירה ולוחצים 🔇.`, keyboard: kb };
}

export function savedScreen(items: DigestItem[]): { text: string; keyboard: InlineKeyboard } {
  const kb = new InlineKeyboard();
  const lines = items.map((it, i) => `${i + 1}. <a href="${esc(it.url)}">${esc(it.titleHe)}</a>`);
  items.forEach((it, i) => {
    kb.text(`🗑 ${i + 1}`, `us:${it.id}`);
    if (i % 5 === 4) kb.row();
  });
  kb.row().text(BACK, 'm:home');
  return { text: `📌 <b>שמורים</b>\n${lines.join('\n') || 'אין פריטים שמורים.'}`, keyboard: kb };
}

export function muteTagsKeyboard(it: DigestItem): InlineKeyboard {
  const kb = new InlineKeyboard();
  it.tags.forEach((t, i) => kb.text(t, `mt:${it.id}:${i}`).row());
  return kb.text(BACK, `card:${it.id}`);
}

export const muteForKeyboard = (id: number, tag: number) =>
  new InlineKeyboard().text('לתמיד', `md:${id}:${tag}:f`).text('לשבוע', `md:${id}:${tag}:w`).row().text(BACK, `mu:${id}`);
