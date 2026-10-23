export const CONFIG = {
  currency: 'ILS',
  gl: 'il',
  hl: 'en',
  earliestDepart: '08:00',
  latestArrive: '18:00',
  // outbound_times / return_times: departure range then arrival range, hours
  timesParam: '8,18,8,18',
  // first month offered in the month picker
  searchFrom: '2026-12',
  // last Israel date on which any SerpApi call may run; move it to re-open the bot for a later trip
  searchUntil: '2026-12-31',
  // SerpApi free plan size, used only when account.json cannot tell how many searches are left
  monthlySearches: 250,
  quotaReserve: 60,
  maxTracked: 2,
  lowCostAirlines: ['Wizz Air'],
  monthsAhead: 6,
} as const;

export type Env = {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  SERPAPI_KEY: string;
  // JSON, see src/profile.ts
  PROFILE: string;
  OWNER_ID: string;
  WEBHOOK_SECRET: string;
};
