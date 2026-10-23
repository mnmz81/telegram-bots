import { Api } from 'grammy';
import type { Env } from './config';
import { isClosed, israelNow } from './dates';
import {
  activeTracked, addCheck, kvGet, kvSet, lastCheck, pruneOptions, stopExpired,
  type Check, type Tracked,
} from './db';
import { errorText, fmtLeg, noticeText, pausedText, trackedKeyboard } from './messages';
import { needsConfirm } from './quota';
import { legKey, searchPair, searchReturns, searchesLeft } from './serpapi';

export type Notice =
  | { kind: 'chosen_drop' | 'cheapest_drop'; price: number; was: number; label: string }
  | { kind: 'chosen_gone'; label: string };

export function compare(prev: Check, cur: Check, label: string): Notice[] {
  const notices: Notice[] = [];
  if (prev.chosenPrice !== null && cur.chosenPrice !== null && cur.chosenPrice < prev.chosenPrice) {
    notices.push({ kind: 'chosen_drop', price: cur.chosenPrice, was: prev.chosenPrice, label });
  }
  if (prev.cheapestPrice !== null && cur.cheapestPrice !== null && cur.cheapestPrice < prev.cheapestPrice) {
    notices.push({ kind: 'cheapest_drop', price: cur.cheapestPrice, was: prev.cheapestPrice, label: cur.cheapestLabel ?? '' });
  }
  if (prev.chosenPrice !== null && cur.chosenPrice === null) notices.push({ kind: 'chosen_gone', label });
  return notices;
}

// 11:00 checks every active item; 20:00 only while a single item is tracked (keeps the monthly cost near 120 searches)
export const shouldRunNow = (hour: number, activeCount: number): boolean =>
  (hour === 11 && activeCount >= 1) || (hour === 20 && activeCount === 1);

export async function checkItem(env: Env, t: Tracked, now: Date): Promise<Check> {
  const pair = { out: t.out, ret: t.ret };
  const main = await searchPair(env, t.dest, pair, now);
  const cheapest = main.options[0];
  const outbound = main.options.find((o) => legKey(o.leg) === t.outKey);
  let chosenPrice: number | null = null;
  if (outbound?.departureToken) {
    const rets = await searchReturns(env, t.dest, pair, outbound.departureToken, now);
    chosenPrice = rets.options.find((o) => legKey(o.leg) === t.retKey)?.price ?? null;
  }
  return {
    chosenPrice,
    cheapestPrice: cheapest?.price ?? null,
    cheapestLabel: cheapest ? fmtLeg(cheapest.leg) : null,
  };
}

export async function runTracking(env: Env, now: Date = new Date()): Promise<void> {
  if (isClosed(now)) return;
  const { date, hour } = israelNow(now);
  await stopExpired(env.DB, date);
  await pruneOptions(env.DB, new Date(now.getTime() - 2 * 86_400_000).toISOString());
  const active = await activeTracked(env.DB);
  if (!shouldRunNow(hour, active.length)) return;

  const api = new Api(env.TELEGRAM_BOT_TOKEN);
  try {
    const left = await searchesLeft(env, now);
    if (needsConfirm(left, active.length * 2)) {
      if (!(await kvGet(env.DB, 'pause_notified'))) {
        await api.sendMessage(env.OWNER_ID, pausedText(left));
        await kvSet(env.DB, 'pause_notified', '1');
      }
      return;
    }
    await kvSet(env.DB, 'pause_notified', null);

    let failed = false;
    for (const t of active) {
      try {
        const cur = await checkItem(env, t, now);
        const prev = await lastCheck(env.DB, t.id);
        await addCheck(env.DB, t.id, cur, now.toISOString());
        for (const n of prev ? compare(prev, cur, t.label) : []) {
          await api.sendMessage(env.OWNER_ID, noticeText(n), { reply_markup: trackedKeyboard(t.id) });
        }
      } catch (err) {
        failed = true;
        console.error('tracking check failed', t.id, err);
        await notifyError(env, api, err);
      }
    }
    if (!failed) await kvSet(env.DB, 'error_notified', null);
  } catch (err) {
    console.error('tracking run failed', err);
    await notifyError(env, api, err);
  }
}

// one message per distinct error until a run succeeds, so a daily failure doesn't spam the owner
async function notifyError(env: Env, api: Api, err: unknown): Promise<void> {
  const text = errorText(err);
  if ((await kvGet(env.DB, 'error_notified')) === text) return;
  await kvSet(env.DB, 'error_notified', text);
  await api.sendMessage(env.OWNER_ID, text);
}
