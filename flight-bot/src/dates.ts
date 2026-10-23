import { CONFIG } from './config';

export type DatePair = { out: string; ret: string };
export type Pattern = 'thu' | 'wed' | 'both';

const DAY_MS = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

export function weekendPairs(month: string, pattern: Pattern, after: string): DatePair[] {
  const [y, m] = month.split('-').map(Number);
  const pairs: DatePair[] = [];
  for (let d = new Date(Date.UTC(y, m - 1, 1)); d.getUTCMonth() === m - 1; d = new Date(d.getTime() + DAY_MS)) {
    const dow = d.getUTCDay();
    const wanted = (dow === 4 && pattern !== 'wed') || (dow === 3 && pattern !== 'thu');
    if (!wanted || iso(d) <= after) continue;
    // Thursday -> Monday is +4 days, Wednesday -> Monday is +5
    pairs.push({ out: iso(d), ret: iso(new Date(d.getTime() + (dow === 4 ? 4 : 5) * DAY_MS)) });
  }
  return pairs;
}

export function israelNow(now: Date): { date: string; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Jerusalem',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

export function isClosed(now: Date, until: string = CONFIG.searchUntil): boolean {
  return israelNow(now).date > until;
}

export function monthOptions(now: Date, until: string = CONFIG.searchUntil): string[] {
  const [y, m] = israelNow(now).date.split('-').map(Number);
  const months: string[] = [];
  for (let i = 0; i < CONFIG.monthsAhead; i++) {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    const key = iso(d).slice(0, 7);
    if (key > until.slice(0, 7)) break;
    months.push(key);
  }
  return months;
}
