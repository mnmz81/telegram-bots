#!/usr/bin/env bash
# Check each Gemini model the bot uses, with your own key, to see why a digest fell back.
# Usage: GEMINI_API_KEY=... scripts/gemini-check.sh [model ...]
#   no key in the environment: asks for it (hidden). No models given: the list in src/config.ts.
# Per model, three requests: a tiny ping, a digest-sized answer (25 Hebrew items as JSON), and the same
# with thinkingLevel low (does the model accept it, and is it faster than the ~100s Cloudflare waits).
# Prints HTTP status, Google's error and which quota it hit (per minute / per day, and its limit),
# or the finish reason, token counts (thoughts = thinking tokens) and whether the JSON came back whole.
set -euo pipefail
cd "$(dirname "$0")/.."

key=${GEMINI_API_KEY:-}
if [[ -z $key ]]; then
  read -rsp 'Gemini API key: ' key
  echo
fi
[[ -n $key ]] || { echo 'no key' >&2; exit 2; }

models=("$@")
if ((${#models[@]} == 0)); then
  read -ra models <<<"$(grep -m1 "models: \[" src/config.ts | grep -o "'[^']*'" | tr -d "'" | tr '\n' ' ')"
fi

ping_body='{"contents":[{"role":"user","parts":[{"text":"Reply with the single word: ok"}]}]}'
digest_body=$(jq -n '{
  contents: [{ role: "user", parts: [{ text: "Invent 25 short tech news stories. For each, in Hebrew: title_he (up to ~12 words) and summary_he (1-2 sentences: what happened and why it matters). Keep product and company names in English." }] }],
  generationConfig: { temperature: 0.3, responseMimeType: "application/json", responseSchema: {
    type: "OBJECT", required: ["picks"],
    properties: { picks: { type: "ARRAY", items: { type: "OBJECT", required: ["title_he", "summary_he"],
      properties: { title_he: { type: "STRING" }, summary_he: { type: "STRING" } } } } } } }
}')

digest_low_body=$(jq '.generationConfig.thinkingConfig = { thinkingLevel: "low" }' <<<"$digest_body")

out=$(mktemp)
trap 'rm -f "$out"' EXIT

check() { # model label body
  local start code secs
  start=$(date +%s)
  # the key goes in through a file descriptor, so it never shows in `ps`
  code=$(curl -sS -o "$out" -w '%{http_code}' --max-time 300 \
    -H 'content-type: application/json' -H @<(printf 'x-goog-api-key: %s\n' "$key") \
    -d "$3" "https://generativelanguage.googleapis.com/v1beta/models/$1:generateContent") || code=000
  secs=$(($(date +%s) - start))
  printf '  %-6s HTTP %s, %ss  ' "$2" "$code" "$secs"
  if [[ $code != 200 ]]; then
    jq -j '[.error.status, (.error.message // "" | .[0:160]),
      (.error.details[]? | .violations[]? | "quota \(.quotaId) limit \(.quotaValue // "?")")] | map(select(. != null and . != "")) | join(" | ")' \
      "$out" 2>/dev/null || head -c 200 "$out"
    echo
    return
  fi
  jq -r '"finish \(.candidates[0].finishReason // "none") | tokens in \(.usageMetadata.promptTokenCount // 0) out \(.usageMetadata.candidatesTokenCount // 0) thoughts \(.usageMetadata.thoughtsTokenCount // 0)" +
    ((.candidates[0].content.parts // []) | map(.text // "") | join("") as $t |
      if ($t | test("^\\s*[{\\[]")) then ($t | try (fromjson | " | JSON ok, \(.picks | length) items") catch " | JSON cut off") else "" end)' "$out"
}

for m in "${models[@]}"; do
  echo "$m"
  check "$m" ping "$ping_body"
  check "$m" digest "$digest_body"
  check "$m" low "$digest_low_body"
done
