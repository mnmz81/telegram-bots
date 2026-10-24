# tech-digest-bot

Private Telegram bot: reads ~20 leading tech sources (AI, dev tools, gadgets, industry, TLDR newsletters, Hacker News), removes duplicates and noise, and sends a Hebrew digest of 10–12 stories at 08:00 and 20:00 Israel time, every day. A weekly summary goes out by email on Friday at 09:00. Big stories get a 🚨 alert in between, at most 2 a day and never at night.

## Setup (once)

1. Create the bot with @BotFather and keep the token. Get your Telegram user ID from @userinfobot.
2. Gemini key: in [Google AI Studio](https://aistudio.google.com/apikey) create a key in a project **without billing**. Without billing the API cannot charge anything. If Google's free quota runs out, the digest falls back to English titles. A consumer Gemini subscription does not cover API usage.
3. Email: create a free [Resend](https://resend.com) account with the address the weekly email should reach, and an API key. Without your own domain, Resend only sends to the account's own address, which is all this bot needs.
4. Create the database and paste the printed id into `wrangler.toml` (`database_id`):
   ```bash
   npx wrangler d1 create tech-digest-bot
   ```
5. Apply the schema:
   ```bash
   npx wrangler d1 migrations apply tech-digest-bot --remote
   ```
6. From the repo root, deploy, store the secrets and register the webhook (each value is typed hidden and saved with `wrangler secret put`):
   ```bash
   scripts/setup-bot.sh tech-digest-bot --secret GEMINI_API_KEY --secret RESEND_API_KEY --secret OWNER_EMAIL
   ```
   For local runs put the same keys in `.dev.vars` (git-ignored).
7. Send `/start` to the bot.

## Using it

Buttons only. `/start` (Telegram's Start button) installs a persistent "🏠 תפריט" button under the input field and removes the typed-command menu. Anything typed is deleted and answered with the menu.

- The menu has: send a digest now, saved items, sources (on/off), muted topics, weekly email now, clear screen.
- Each digest has number buttons. A number opens that story's card:
  - 👍 / 👎: feedback that steers later picks.
  - 📌: save for later. Saved stories also go into the weekly email.
  - 🔍: a longer Hebrew summary, made once and then cached.
  - 🔇: mute one of the story's topics, for good or for a week.
  - ⬅️ חזרה: closes the card.
- Only one card is open at a time, so tapping again replaces the card instead of stacking copies.
- 🚨 alerts carry the same buttons on the alert message itself.
- Screens opened from the menu replace the same message, and ⬅️ חזרה goes back to the menu.
- 🧹 Clear screen deletes the bot's and your messages from the chat. Nothing in the database is touched. Telegram only lets a bot delete messages from the last 48 hours, so older ones stay, and the bot says how many.
- A source that fails 3 runs in a row sends one warning. You can switch it off in the sources screen.

## How it works

- **:50 every hour**: fetches a third of the RSS sources, rotating so each source is read every 3 hours, plus Hacker News every hour. Then it checks for breaking news: the same story from 3 or more sources within 3 hours, or a Hacker News story past 600 points. Rotating keeps each run inside the free plan's 10 ms CPU limit. Parsing all feeds at once took about 6 ms on a laptop.
- **:00 every hour**: does something only at 08:00 and 20:00 (the digest) and on Friday at 09:00 (the weekly email, plus deleting items older than 30 days). Hours are Israel time, so daylight saving needs no cron change.
- **Digest**:
  1. Takes the items fetched since the last digest.
  2. Drops anything older than 48 hours or muted.
  3. Groups the same story across sources by title similarity, and drops stories already sent in the last 48 hours.
  4. Sends the top 80 to Gemini in **one call**. Gemini picks 10–12, merges the duplicates the code missed, and writes the Hebrew title and summary, category, tags and importance. Your 👍/👎 history goes into the prompt.
- **Gemini models** (`CONFIG.models` in `src/config.ts`): `gemini-3.8-flash`, then `gemini-3.6-flash`, then `gemini-3.5-flash-lite`. A model that answers 503 ("high demand", common on free keys) is retried once after 2 seconds; on other quota errors or downtime the next model is tried. Gemini 3.x Pro has no free tier, and 2.5 Flash is closed to new keys, so neither is used. Calls per day: 2 digests, at most 2 alerts, 1 per 🔍 tap, and 1 more on Fridays.
- **TLDR**: the RSS feed has one entry per issue, so each new issue page is fetched once and split into stories. Sponsor blocks are skipped.

Sources and thresholds: `src/sources.ts` and `src/config.ts`. Anthropic has no RSS feed, so it is not included. Its news still arrives through TLDR, Hacker News and the tech sites.

## Develop

```bash
npm test
npx tsc --noEmit
npm run dev                         # wrangler dev with scheduled-trigger testing
scripts/run-cron.sh collect         # in a second terminal: one fetch + breaking run against the local Worker
scripts/run-cron.sh scheduled       # the :00 run (acts only at 08/20, Friday 09)
```

Before the first `npm run dev`, apply the schema locally: `npx wrangler d1 migrations apply tech-digest-bot --local`.
