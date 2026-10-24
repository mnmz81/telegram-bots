#!/usr/bin/env bash
# Fire one of the bot's cron runs against a local `npm run dev` (wrangler dev --test-scheduled).
# Usage: scripts/run-cron.sh collect|scheduled [port]
#   collect   = the :50 run: fetch a slice of the feeds + breaking check
#   scheduled = the :00 run: digest at 08/20 and weekly email Friday 09 (Israel time), otherwise nothing
# The local run uses the real clock; for a digest at any hour, send /now to the deployed bot.
set -euo pipefail
case ${1:-} in
  collect) cron='50 * * * *' ;;
  scheduled) cron='0 * * * *' ;;
  *) sed -n 2,7p "$0" >&2; exit 2 ;;
esac
curl -fsS "http://localhost:${2:-8787}/__scheduled" --get --data-urlencode "cron=${cron}"
echo
