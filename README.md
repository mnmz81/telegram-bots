# bots

My personal Telegram bots, one folder per bot. Each bot is self-contained (own `package.json`, own deploy) and private to its owner.

| Bot | What it does |
|-----|--------------|
| [flight-bot](flight-bot) | Searches direct round trips on flexible weekends and tracks price drops (SerpApi, Cloudflare Workers) |

Secrets never live in this repo: they are stored with `wrangler secret put` (or `.dev.vars`, which is git-ignored).

## Setting up a bot

1. Create the bot with @BotFather and get your numeric id from @userinfobot.
2. Do the bot's own one-time steps from its README (database, deploy).
3. From the repo root, store the secrets and point Telegram at the Worker:
   ```bash
   scripts/setup-bot.sh <bot-dir> [--secret EXTRA_NAME]... [--url https://<worker>.workers.dev]
   ```
   It asks for the BotFather token (checked with Telegram), your id and each `--secret`, generates `WEBHOOK_SECRET`, saves everything with `wrangler secret put`, and registers the webhook. Without `--url` it deploys first and reads the URL from the deploy output.

Every bot reads `TELEGRAM_BOT_TOKEN`, `OWNER_ID` and `WEBHOOK_SECRET`, and answers only `OWNER_ID`.
