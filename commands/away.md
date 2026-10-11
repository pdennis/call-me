---
description: Turn on away mode - Claude phones you when it stops or has a question
allowed-tools: Bash(touch:*)
---
Run `touch ~/.claude/callme-away`, then confirm in one line that away mode is on: you will phone the user when you finish or need input, instead of waiting at the terminal. Away mode applies to every Claude Code session on this machine until `/callme:back`.
