import { InlineKeyboard } from 'grammy';
import type { DatePair } from './dates';
import type { Leg } from './serpapi';
import type { Notice } from './tracking';

export const fmtPrice = (n: number): string => `₪${n.toLocaleString('en-US')}`;

export function fmtPair(p: DatePair): string {
  const [, m1, d1] = p.out.split('-').map(Number);
  const [, m2, d2] = p.ret.split('-').map(Number);
  return m1 === m2 ? `${d1}–${d2}.${m2}` : `${d1}.${m1}–${d2}.${m2}`;
}

export const fmtLeg = (l: Leg): string => `${l.airline} ${l.departAt.slice(-5)}→${l.arriveAt.slice(-5)}`;

export function noticeText(n: Notice): string {
  switch (n.kind) {
    case 'chosen_drop':
      return `🔻 הטיסה שבחרת (${n.label}) ירדה ל־${fmtPrice(n.price)} (הייתה ${fmtPrice(n.was)})`;
    case 'cheapest_drop':
      return `🔻 הטיסה הישירה הכי זולה בסופ"ש ירדה ל־${fmtPrice(n.price)} (${n.label}), הייתה ${fmtPrice(n.was)}`;
    case 'chosen_gone':
      return `⚠️ הטיסה שבחרת (${n.label}) כבר לא מופיעה בתוצאות. ממשיכים לעקוב אחרי הכי זולה.`;
  }
}

export const pausedText = (left: number): string => `⏸ המעקב הושהה, נשארו ${left} חיפושים החודש.`;
export const errorText = (err: unknown): string =>
  `⚠️ בדיקת המחירים נכשלה: ${err instanceof Error ? err.message : String(err)}`;
export const closedText = (): string => 'החיפושים סגורים, תקופת החיפוש הסתיימה.';
export const expiredText = (): string => 'פג תוקף, חפשו שוב';

export const trackedKeyboard = (trackedId: number): InlineKeyboard =>
  new InlineKeyboard().text('סגרתי ✅', 'booked').text('עצור', `stop:${trackedId}`);
