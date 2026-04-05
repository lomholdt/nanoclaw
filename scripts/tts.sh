#!/bin/bash
# TTS wrapper script — generates audio from text
# Provider can be switched via TTS_PROVIDER env var
# Currently supports: edge-tts
# Output: base64-encoded audio to stdout (or file if --output is given)
#
# Usage:
#   tts.sh "Hello world"
#   tts.sh --voice da-DK-JeppeNeural "Hej verden"
#   tts.sh --output /tmp/out.mp3 "Hello"
#   echo "Hello world" | tts.sh --stdin

set -euo pipefail

PROVIDER="${TTS_PROVIDER:-edge-tts}"
VOICE="${TTS_VOICE:-en-US-EmmaNeural}"
OUTPUT=""
TEXT=""
FROM_STDIN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --voice) VOICE="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    --provider) PROVIDER="$2"; shift 2 ;;
    --stdin) FROM_STDIN=true; shift ;;
    *) TEXT="$1"; shift ;;
  esac
done

if $FROM_STDIN; then
  TEXT="$(cat)"
fi

if [[ -z "$TEXT" ]]; then
  echo "Usage: tts.sh [--voice VOICE] [--output FILE] [--provider PROVIDER] TEXT" >&2
  exit 1
fi

TMPFILE="$(mktemp /tmp/tts-XXXXXX.mp3)"
trap "rm -f '$TMPFILE'" EXIT

case "$PROVIDER" in
  edge-tts)
    /opt/tts-env/bin/edge-tts --voice "$VOICE" --text "$TEXT" --write-media "$TMPFILE" 2>/dev/null
    ;;
  # Add new providers here:
  # openai)
  #   curl -s https://api.openai.com/v1/audio/speech \
  #     -H "Authorization: Bearer $OPENAI_API_KEY" \
  #     -H "Content-Type: application/json" \
  #     -d "{\"model\":\"tts-1\",\"input\":$(echo "$TEXT" | jq -Rs .),\"voice\":\"${VOICE:-alloy}\"}" \
  #     --output "$TMPFILE"
  #   ;;
  *)
    echo "Unknown TTS provider: $PROVIDER" >&2
    exit 1
    ;;
esac

if [[ -n "$OUTPUT" ]]; then
  mv "$TMPFILE" "$OUTPUT"
  trap - EXIT
else
  base64 -w0 "$TMPFILE"
fi
