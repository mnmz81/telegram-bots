import { Api, type Transformer } from 'grammy';
import type { Env } from './config';
import { logMessage } from './db';

// remembers every message the bot sends, so /clear can delete it later
export const logSent = (db: D1Database, now: () => Date): Transformer => async (prev, method, payload, signal) => {
  const res = await prev(method, payload, signal);
  const id = res.ok && method === 'sendMessage' ? (res.result as { message_id?: number }).message_id : undefined;
  if (typeof id === 'number') await logMessage(db, id, now().toISOString()).catch(() => {});
  return res;
};

// Api for scheduled runs (no update to reply to): messages go to the owner's private chat, whose id is the owner's user id
export function ownerApi(env: Env, now: () => Date = () => new Date()): Api {
  const api = new Api(env.TELEGRAM_BOT_TOKEN);
  api.config.use(logSent(env.DB, now));
  return api;
}
