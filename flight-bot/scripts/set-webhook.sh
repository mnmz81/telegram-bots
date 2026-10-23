#!/usr/bin/env bash
# Register the Telegram webhook for the deployed Worker.
# Usage: TELEGRAM_BOT_TOKEN=... WEBHOOK_SECRET=... scripts/set-webhook.sh https://flight-bot.<account>.workers.dev
set -euo pipefail

url=${1:-}
: "${TELEGRAM_BOT_TOKEN:?set TELEGRAM_BOT_TOKEN}"
: "${WEBHOOK_SECRET:?set WEBHOOK_SECRET}"
[ -n "$url" ] || { echo "usage: $0 <worker-url>" >&2; exit 2; }

curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${url}" \
  --data-urlencode "secret_token=${WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message","callback_query"]' \
  --data-urlencode "drop_pending_updates=true"
echo
