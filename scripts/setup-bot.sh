#!/usr/bin/env bash
# Set up any bot in this repo: Telegram token, owner id, webhook secret, any extra secrets, then the webhook.
# Usage: scripts/setup-bot.sh <bot-dir> [--secret NAME]... [--url https://<worker>.workers.dev]
#        scripts/setup-bot.sh --selftest
# Example: scripts/setup-bot.sh flight-bot --secret SERPAPI_KEY
# Without --url it deploys the Worker first and takes the workers.dev URL from wrangler's output.
# Values are typed hidden and go straight to `wrangler secret put`; nothing is written to disk or the repo.
# Safe to re-run: it overwrites the secrets and re-registers the webhook.
set -euo pipefail

valid_token() { [[ $1 =~ ^[0-9]{6,}:[A-Za-z0-9_-]{30,}$ ]]; }
valid_digits() { [[ $1 =~ ^[0-9]+$ ]]; }
valid_any() { [ -n "$1" ]; }

if [[ ${1:-} == --selftest ]]; then
  # built at runtime so secret scanners do not mistake the test value for a real token
  valid_token "123456789:$(printf 'A%.0s' {1..35})" || { echo "FAIL token-shaped value"; exit 1; }
  ! valid_token 'echo ${#TELEGRAM_BOT_TOKEN}' || { echo "FAIL junk token accepted"; exit 1; }
  valid_digits 12345 && ! valid_digits 12a || { echo "FAIL digits"; exit 1; }
  ! valid_any '' || { echo "FAIL empty accepted"; exit 1; }
  echo "selftest ok"
  exit 0
fi

dir=${1:-}
[ -n "$dir" ] && [ "${dir:0:2}" != -- ] || { sed -n 2,8p "$0" >&2; exit 2; }
shift
url='' extras=()
while [ $# -gt 0 ]; do
  case $1 in
    --secret) extras+=("$2"); shift 2 ;;
    --url) url=$2; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
cd "$(dirname "$0")/../$dir"
[ -f wrangler.toml ] || { echo "no wrangler.toml in $dir" >&2; exit 2; }

# ask VAR "label" validator [hidden]: up to 3 tries, whitespace stripped
ask() {
  local var=$1 label=$2 check=$3 hidden=${4:-} v
  for _ in 1 2 3; do
    if [ -n "$hidden" ]; then read -rsp "$label: " v; echo; else read -rp "$label: " v; fi
    v=${v//[$'\r\n\t ']/}
    if "$check" "$v"; then
      printf -v "$var" '%s' "$v"
      [ -n "$hidden" ] && echo "  (received ${#v} characters)"
      return 0
    fi
    echo "  That does not look right, try again (copy only the value itself)."
  done
  echo "Giving up on $label." >&2
  exit 1
}

put_secret() { printf %s "$2" | npx wrangler secret put "$1" >/dev/null && echo "  saved $1"; }

if [ -z "$url" ]; then
  echo "Deploying $dir..."
  url=$(npx wrangler deploy 2>&1 | tee /dev/stderr | grep -oE 'https://[A-Za-z0-9.-]+\.workers\.dev' | head -1) || true
  [ -n "$url" ] || { echo "Could not find the workers.dev URL in the deploy output; re-run with --url." >&2; exit 1; }
fi

ask TELEGRAM_BOT_TOKEN "Bot token from BotFather" valid_token hidden
username=$(curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" |
  python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["result"]["username"]) if d.get("ok") else sys.exit(1)') ||
  { echo "Telegram rejected this token. Copy it again from BotFather." >&2; exit 1; }
echo "  Telegram accepts the token: @$username"

ask OWNER_ID "Your numeric Telegram user id (from @userinfobot)" valid_digits

extra_values=()
for name in ${extras[@]+"${extras[@]}"}; do
  ask EXTRA_VALUE "$name" valid_any hidden
  extra_values+=("$EXTRA_VALUE")
done

WEBHOOK_SECRET=$(openssl rand -hex 24)

echo "Saving secrets to Cloudflare..."
put_secret TELEGRAM_BOT_TOKEN "$TELEGRAM_BOT_TOKEN"
put_secret OWNER_ID "$OWNER_ID"
put_secret WEBHOOK_SECRET "$WEBHOOK_SECRET"
for i in ${extras[@]+"${!extras[@]}"}; do
  put_secret "${extras[$i]}" "${extra_values[$i]}"
done

echo "Registering the Telegram webhook at $url..."
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${url}" \
  --data-urlencode "secret_token=${WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message","callback_query"]' \
  --data-urlencode "drop_pending_updates=true"
echo
echo "Done. Open @$username in Telegram and send /start."
