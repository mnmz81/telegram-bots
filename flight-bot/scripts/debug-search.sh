#!/usr/bin/env bash
# Run ONE SerpApi Google Flights search with the bot's parameters and print a short summary
# (error text, how many itineraries, and each one's stops / times / price). Costs 1 search.
# Usage: scripts/debug-search.sh ORIGIN DEST OUT_DATE RET_DATE [--no-times] [--dep-only] [--any-stops]
#   --no-times   drop the departure/arrival time window
#   --dep-only   time window on departures only (8,18) instead of departure+arrival (8,18,8,18)
#   --any-stops  allow connecting flights
# Env: ADULTS (default 2), INFANTS (default 1). The API key is typed hidden, never stored.
set -euo pipefail

[ $# -ge 4 ] || { sed -n 2,8p "$0" >&2; exit 2; }
origin=$1 dest=$2 out=$3 ret=$4
shift 4
times=1 stops=1 tparam='8,18,8,18'
for flag in "$@"; do
  case $flag in
    --no-times) times=0 ;;
    --dep-only) tparam='8,18' ;;
    --any-stops) stops=0 ;;
    *) echo "unknown flag $flag" >&2; exit 2 ;;
  esac
done

read -rsp "SerpApi API key: " key; echo
key=${key//[$'\r\n\t ']/}

args=(
  --data-urlencode "engine=google_flights" --data-urlencode "departure_id=$origin" --data-urlencode "arrival_id=$dest"
  --data-urlencode "outbound_date=$out" --data-urlencode "return_date=$ret" --data-urlencode "type=1"
  --data-urlencode "adults=${ADULTS:-2}" --data-urlencode "infants_on_lap=${INFANTS:-1}" --data-urlencode "stops=$stops"
  --data-urlencode "currency=ILS" --data-urlencode "gl=il" --data-urlencode "hl=en" --data-urlencode "sort_by=2"
  --data-urlencode "api_key=$key"
)
[ "$times" = 1 ] && args+=(--data-urlencode "outbound_times=$tparam" --data-urlencode "return_times=$tparam")

summary=$(cat <<'PY'
import json, sys
d = json.load(sys.stdin)
if d.get("error"):
    print("ERROR:", d["error"])
best, other = d.get("best_flights", []), d.get("other_flights", [])
print("best_flights=%d other_flights=%d" % (len(best), len(other)))
for it in best + other:
    segs = it.get("flights", [])
    first, last = segs[0], segs[-1]
    print("  %d stop(s)  %s %s  %s -> %s  price=%s" % (
        len(segs) - 1, first.get("airline"), first.get("flight_number"),
        first["departure_airport"]["time"], last["arrival_airport"]["time"], it.get("price")))
print("google_flights_url:", d.get("search_metadata", {}).get("google_flights_url", "-"))
PY
)

curl -sS -G "https://serpapi.com/search.json" "${args[@]}" | python3 -c "$summary"
