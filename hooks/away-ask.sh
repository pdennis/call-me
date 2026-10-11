#!/bin/bash
# PreToolUse hook on AskUserQuestion: when away, ask by phone instead of
# waiting on a terminal prompt nobody is watching.
flag="${CALLME_AWAY_FLAG:-$HOME/.claude/callme-away}"
[ -f "$flag" ] || exit 0

cat <<'JSON'
{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "The user is away from the keyboard (callme away mode). Ask this question with initiate_call instead, reading the options aloud, then continue with their answer."}}
JSON
