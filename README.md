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

## Keeping secrets out (this repo is public)

- Secrets live only in Cloudflare (`wrangler secret put`) and, for local runs, in `.dev.vars`, which is git-ignored.
- `.githooks/pre-commit` blocks any commit that adds `.dev.vars`/`.env`/key files or a line that looks like a Telegram token, a 64-hex API key, a private key, or `key/secret/token/password = "<long value>"`. It is turned on per clone with `git config core.hooksPath .githooks`; `scripts/setup-bot.sh` does that for you.
- GitHub secret scanning and push protection are on as a second net.
- Trip details and other personal data go in secrets too (see flight-bot's `PROFILE`), not in code.
