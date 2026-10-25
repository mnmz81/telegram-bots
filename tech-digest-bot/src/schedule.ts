import type { Api } from 'grammy';
import { runBreaking } from './breaking';
import { runFetch } from './collect';
import { CONFIG, type Env } from './config';
import { hoursAgo, israelNow } from './dates';
import { kvGet, kvSet, pruneItems, pruneMessages } from './db';
import { runDigest } from './digest';
import { GeminiError } from './gemini';
import { esc } from './messages';
import { sendWeekly } from './weekly';

export const FETCH_CRON = '50 * * * *';

const warn = (env: Env, api: Api, what: string, err: unknown) => {
  console.error(what, err);
  return api.sendMessage(env.OWNER_ID, `⚠️ ${what} נכשל: ${esc(String(err))}`, { parse_mode: 'HTML' }).catch(() => {});
};

// :50 every hour: a slice of the feeds, then the breaking-news check
export async function runCollect(env: Env, api: Api, now: Date): Promise<void> {
  await runFetch(env, api, now).catch((err) => console.error('fetch run failed', err));
  await runBreaking(env, api, now).catch((err) => console.error('breaking check failed', err));
}

// :00 every hour: acts only on the digest hours, a failed digest's retries and Friday morning (Israel time, so DST needs no cron change)
export async function runScheduled(env: Env, api: Api, now: Date): Promise<void> {
  const { hour, weekday } = israelNow(now);
  const failed = Number((await kvGet(env.DB, 'digest_failed')) ?? 0);
  if ((CONFIG.digestHours as readonly number[]).includes(hour) || failed) {
    try {
      await runDigest(env, api, now, 'scheduled');
      if (failed) await kvSet(env.DB, 'digest_failed', '0');
    } catch (err) {
      // Gemini down: try again next hour instead of sending English titles; the owner hears only when every try failed
      const retry = err instanceof GeminiError && failed + 1 < CONFIG.digestAttempts;
      await kvSet(env.DB, 'digest_failed', retry ? String(failed + 1) : '0');
      if (!retry) await warn(env, api, 'הסקירה', err);
    }
  }
  if (weekday === CONFIG.weeklyWeekday && hour === CONFIG.weeklyHour) {
    await sendWeekly(env, now, 'scheduled').catch((err) => warn(env, api, 'המייל השבועי', err));
    await pruneItems(env.DB, hoursAgo(now, CONFIG.retentionDays * 24));
    await pruneMessages(env.DB, hoursAgo(now, CONFIG.retentionDays * 24));
  }
}
