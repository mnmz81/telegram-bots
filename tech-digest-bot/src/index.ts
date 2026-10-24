import { webhookCallback } from 'grammy';
import { createBot } from './bot';
import type { Env } from './config';
import { FETCH_CRON, runCollect, runScheduled } from './schedule';
import { ownerApi } from './telegram';

export default {
  async fetch(req, env, ctx) {
    const secret = req.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (req.method !== 'POST' || !env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) {
      return new Response('forbidden', { status: 403 });
    }
    return webhookCallback(createBot(env, (p) => ctx.waitUntil(p)), 'cloudflare-mod')(req);
  },
  async scheduled(controller, env, ctx) {
    const now = new Date(controller.scheduledTime);
    const api = ownerApi(env);
    ctx.waitUntil(controller.cron === FETCH_CRON ? runCollect(env, api, now) : runScheduled(env, api, now));
  },
} satisfies ExportedHandler<Env>;
