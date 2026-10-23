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
6. Deploy:
   ```bash
   npm run deploy
   ```
7. Store the secrets and register the Telegram webhook in one go (prompts for each value, checks its format, then saves it with `wrangler secret put`):
   ```bash
   scripts/setup-secrets.sh https://flight-bot.<account>.workers.dev
   ```
   It asks for the BotFather token, the SerpApi key, your numeric Telegram id, and the trip profile (home airport, adults, infants on lap, favorite destinations). The profile is stored in the `PROFILE` secret so trip details stay out of the repo. For local runs put the same keys in `.dev.vars` (git-ignored). Re-running overwrites the secrets.

## Commands

`/search` start a search, `/tracking` tracked flights, `/quota` searches left and used, `/blocked` hidden flights.

Under every flight list, "🚫 להסתיר טיסה" hides a flight (say, a night flight) from all later searches and from price tracking. It is matched by flight number and departure time, so if the airline moves the flight to another hour it shows up again. `/blocked` brings it back.

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
