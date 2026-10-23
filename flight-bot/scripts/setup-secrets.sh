#!/usr/bin/env bash
# One-time setup: store the Worker secrets and register the Telegram webhook.
# Usage: scripts/setup-secrets.sh https://<your-worker>.workers.dev
#        scripts/setup-secrets.sh --selftest
# Asks for each value (secrets are typed hidden), checks its format, saves it with
# `wrangler secret put`, generates WEBHOOK_SECRET, then calls set-webhook.sh.
# Nothing is written to disk or to the repo. Safe to re-run: it overwrites the secrets.
set -euo pipefail

valid_token() { [[ $1 =~ ^[0-9]{6,}:[A-Za-z0-9_-]{30,}$ ]]; }
valid_serpapi() { [[ $1 =~ ^[A-Za-z0-9]{32,}$ ]]; }
valid_digits() { [[ $1 =~ ^[0-9]+$ ]]; }
valid_iata() { [[ $1 =~ ^[A-Z]{3}$ ]]; }

if [[ ${1:-} == --selftest ]]; then
  valid_token '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw' || { echo "FAIL real-looking token"; exit 1; }
  ! valid_token 'echo ${#TELEGRAM_BOT_TOKEN}' || { echo "FAIL junk token accepted"; exit 1; }
  ! valid_token '' || { echo "FAIL empty token accepted"; exit 1; }
  valid_serpapi "$(printf 'a%.0s' {1..64})" || { echo "FAIL serpapi key"; exit 1; }
  ! valid_serpapi 'abc' || { echo "FAIL short serpapi key accepted"; exit 1; }
  valid_iata TLV && ! valid_iata tlv || { echo "FAIL iata"; exit 1; }
  echo "selftest ok"
  exit 0
fi

url=${1:-}
[ -n "$url" ] || { echo "usage: $0 <worker-url>" >&2; exit 2; }
cd "$(dirname "$0")/.."

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

ask TELEGRAM_BOT_TOKEN "Bot token from BotFather" valid_token hidden
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" |
  python3 -c 'import sys,json; sys.exit(0 if json.load(sys.stdin).get("ok") else 1)' ||
  { echo "Telegram rejected this token. Copy it again from BotFather." >&2; exit 1; }
echo "  Telegram accepts the token."

ask SERPAPI_KEY "SerpApi API key" valid_serpapi hidden
ask OWNER_ID "Your numeric Telegram user id (from @userinfobot)" valid_digits

ask ORIGIN "Home airport code, 3 capital letters" valid_iata
ask ADULTS "Number of adults" valid_digits
ask INFANTS "Number of infants on lap" valid_digits
fav_args=()
while true; do
  read -rp "Favorite destination airport code (empty to finish): " code
  code=${code//[$'\r\n\t ']/}
  [ -z "$code" ] && break
  valid_iata "$code" || { echo "  3 capital letters please."; continue; }
  read -rp "  Name shown on the button: " name
  fav_args+=("$code" "$name")
done
PROFILE=$(python3 -c '
import json, sys
a = sys.argv[1:]
print(json.dumps({"origin": a[0], "adults": int(a[1]), "infantsOnLap": int(a[2]),
                  "favorites": [{"code": a[i], "name": a[i + 1]} for i in range(3, len(a), 2)]}, ensure_ascii=False))
' "$ORIGIN" "$ADULTS" "$INFANTS" ${fav_args[@]+"${fav_args[@]}"})

WEBHOOK_SECRET=$(openssl rand -hex 24)

echo "Saving secrets to Cloudflare..."
put_secret TELEGRAM_BOT_TOKEN "$TELEGRAM_BOT_TOKEN"
put_secret SERPAPI_KEY "$SERPAPI_KEY"
put_secret OWNER_ID "$OWNER_ID"
put_secret PROFILE "$PROFILE"
put_secret WEBHOOK_SECRET "$WEBHOOK_SECRET"

echo "Registering the Telegram webhook..."
export TELEGRAM_BOT_TOKEN WEBHOOK_SECRET
scripts/set-webhook.sh "$url"
