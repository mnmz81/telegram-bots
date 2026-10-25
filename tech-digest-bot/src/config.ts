export const CONFIG = {
  // Israel time
  digestHours: [8, 20],
  weeklyWeekday: 'Fri',
  weeklyHour: 9,
  digestMax: 25,
  // clusters offered to Gemini per digest
  maxCandidates: 80,
  // only the newest N items of each feed are parsed (OpenAI's feed alone holds 1300+)
  itemsPerFeed: 30,
  // each hourly run fetches 1/feedSlices of the RSS sources, to stay inside the free plan's 10ms CPU per run
  feedSlices: 3,
  // token Jaccard on titles at or above this = same story
  sameStory: 0.5,
  hnMinPoints: 150,
  // items older than this (by publish date) never enter a digest, so a feed's back catalogue is ignored on first fetch
  maxAgeHours: 48,
  breaking: { minSources: 3, windowHours: 3, hnPoints: 600, maxPerDay: 2, quietFrom: 23, quietUntil: 7 },
  feedFailAlertAfter: 3,
  retentionDays: 30,
  // free tier only: the key must come from an AI Studio project WITHOUT billing, so it can never be charged.
  // Best first; the next one is tried on 429 / 404 / 5xx / unparsable output. 3.x Pro has no free tier,
  // and 2.5 Flash answers 404 'no longer available to new users'. Flash-Lite is the least loaded fallback.
  models: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'],
  // free-tier keys get 503 'high demand' in spikes: a model is retried after each of these waits before the next one.
  // tap = any button (🔍, send digest now, weekly email now), scheduled = cron runs (up to 15 minutes each)
  geminiRetryMs: { tap: [10000], scheduled: [5000, 15000, 30000] } as Record<'tap' | 'scheduled', number[]>,
  // a tap's background work is killed ~30s after the reply (Cloudflare waitUntil): past this, no new wait or model is
  // started, so a digest still goes out (English titles) instead of nothing
  tapBudgetMs: 22000,
  // a scheduled digest Gemini could not write is retried on the next hourly runs, up to this many tries in all:
  // the free-tier daily quota resets at midnight Pacific (09:00/10:00 Israel), after the 08:00 digest
  digestAttempts: 4,
  expandChars: 8000,
  // Telegram refuses to delete messages older than this
  clearWindowHours: 48,
  weeklyTop: 15,
} as const;

export type Env = {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  OWNER_ID: string;
  WEBHOOK_SECRET: string;
  GEMINI_API_KEY: string;
  RESEND_API_KEY: string;
  // a secret, not config: the repo is public
  OWNER_EMAIL: string;
};
