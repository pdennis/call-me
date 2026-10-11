#!/bin/bash
# Stop hook: when away mode is on, keep Claude going once so it phones the user.
# Away mode is a flag file toggled by /callme:away and /callme:back.
flag="${CALLME_AWAY_FLAG:-$HOME/.claude/callme-away}"
[ -f "$flag" ] || exit 0

input=$(cat)
# Already continuing because of this hook - let it stop, or we would loop forever.
if printf '%s' "$input" | grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  exit 0
fi

cat <<'JSON'
{"decision": "block", "reason": "The user is away from the keyboard (callme away mode). Before stopping, use initiate_call to phone them: briefly say what you did, and ask whatever you need answered to keep going. If they give you more work, do it. Skip the call only if this turn did nothing worth reporting."}
JSON
