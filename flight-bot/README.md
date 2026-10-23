# flight-bot

Private Telegram bot: searches direct round trips on flexible weekends (SerpApi / Google Flights) and tracks up to two chosen flight pairs for price drops. Buttons only, no LLM.

## Setup (once)

1. Create the bot with @BotFather and keep the token.
2. Get your Telegram user ID from @userinfobot.
3. Create a free SerpApi account and keep the API key.
4. Create the database and paste the printed id into `wrangler.toml` (`database_id`):
   ```bash
   npx wrangler d1 create flight-bot
   ```
5. Apply the schema:
   ```bash
   npx wrangler d1 migrations apply flight-bot --remote
   ```
6. Store the five secrets (each command prompts for the value):
   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put SERPAPI_KEY
   npx wrangler secret put OWNER_ID
   npx wrangler secret put WEBHOOK_SECRET
   npx wrangler secret put PROFILE
   ```
   `WEBHOOK_SECRET` is any long random string (`openssl rand -hex 24`).
   `PROFILE` holds the trip details, so they stay out of the repo. One line of JSON: `{"origin":"AAA","adults":2,"infantsOnLap":1,"favorites":[{"code":"BBB","name":"City"}]}`. `origin` is the home airport code; `adults` defaults to 1, `infantsOnLap` to 0, `favorites` to none. For local runs put the same keys in `.dev.vars` (git-ignored).
7. Deploy:
   ```bash
   npm run deploy
   ```
8. Point Telegram at the Worker, using the same token and secret as above:
   ```bash
   TELEGRAM_BOT_TOKEN=... WEBHOOK_SECRET=... scripts/set-webhook.sh https://flight-bot.<account>.workers.dev
   ```

## Commands

`/search` start a search, `/tracking` tracked flights, `/quota` searches left and used.

The "search" and "I want this" buttons disappear the moment they are tapped, so a double tap cannot run a search twice or track a flight twice.

## Search counter

The bot counts its own SerpApi searches per month (`used:YYYY-MM` in the `kv` table). The number SerpApi reports is preferred; our count is the fallback when SerpApi's is unavailable, and it can only overstate (cache hits are counted too).

## Configuration (`src/config.ts`)

- `searchUntil`: last day any SerpApi call may run (`2026-12-31`). Change it for a later trip.
- `quotaReserve`, `maxTracked`, time window.
- Home airport, passengers and favorite destinations: the `PROFILE` secret.

## Develop

```bash
npm test
npx tsc --noEmit
npm run dev   # wrangler dev with scheduled-trigger testing
```

Tracking runs at 11:00 Israel time (and 20:00 while exactly one flight is tracked); the cron fires at 08, 09, 17 and 18 UTC and the handler filters by the Israel hour.
