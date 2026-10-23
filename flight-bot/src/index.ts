import { webhookCallback } from 'grammy';
import { createBot } from './bot';
import type { Env } from './config';
import { runTracking } from './tracking';

export default {
  async fetch(req, env, ctx) {
    const secret = req.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (req.method !== 'POST' || !env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) {
      return new Response('forbidden', { status: 403 });
    }
    return webhookCallback(createBot(env, (p) => ctx.waitUntil(p)), 'cloudflare-mod')(req);
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runTracking(env));
  },
} satisfies ExportedHandler<Env>;
