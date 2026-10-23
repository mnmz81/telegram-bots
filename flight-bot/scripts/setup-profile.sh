#!/usr/bin/env bash
# Store the trip profile (home airport, passengers, favorite destinations) as the PROFILE Worker secret.
# Usage: scripts/setup-profile.sh
# Run after ../scripts/setup-bot.sh flight-bot --secret SERPAPI_KEY. Re-run any time to change the profile.
set -euo pipefail
cd "$(dirname "$0")/.."

ask() {
  local var=$1 label=$2 pattern=$3 v
  while true; do
    read -rp "$label: " v
    v=${v//[$'\r\n\t ']/}
    [[ $v =~ $pattern ]] && { printf -v "$var" '%s' "$v"; return 0; }
    echo "  That does not look right, try again."
  done
}

ask ORIGIN "Home airport code, 3 capital letters (e.g. TLV)" '^[A-Z]{3}$'
ask ADULTS "Number of adults" '^[1-9][0-9]*$'
ask INFANTS "Number of infants on lap" '^[0-9]+$'
fav_args=()
while true; do
  read -rp "Favorite destination airport code (empty to finish): " code
  code=${code//[$'\r\n\t ']/}
  [ -z "$code" ] && break
  [[ $code =~ ^[A-Z]{3}$ ]] || { echo "  3 capital letters please."; continue; }
  read -rp "  Name shown on the button: " name
  fav_args+=("$code" "$name")
done

PROFILE=$(python3 -c '
import json, sys
a = sys.argv[1:]
print(json.dumps({"origin": a[0], "adults": int(a[1]), "infantsOnLap": int(a[2]),
                  "favorites": [{"code": a[i], "name": a[i + 1]} for i in range(3, len(a), 2)]}, ensure_ascii=False))
' "$ORIGIN" "$ADULTS" "$INFANTS" ${fav_args[@]+"${fav_args[@]}"})

printf %s "$PROFILE" | npx wrangler secret put PROFILE >/dev/null && echo "saved PROFILE: $PROFILE"
