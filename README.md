# bots

My personal Telegram bots, one folder per bot. Each bot is self-contained (own `package.json`, own deploy) and private to its owner.

| Bot | What it does |
|-----|--------------|
| [flight-bot](flight-bot) | Searches direct round trips on flexible weekends and tracks price drops (SerpApi, Cloudflare Workers) |

Secrets never live in this repo: they are stored with `wrangler secret put` (or `.dev.vars`, which is git-ignored).
