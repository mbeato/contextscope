---
name: usage
description: Launch the tokenscope dashboard (per-turn token context audit + session analytics for Claude Code). Spawns a local server in the background and prints the URL.
allowed-tools: Bash
---

The user wants to open the tokenscope dashboard. Run this **once** in a background bash invocation:

```bash
npx tokenscope --no-open > /tmp/tokenscope.log 2>&1 &
sleep 2
grep "running on" /tmp/tokenscope.log | tail -1
```

Then tell the user:
- the URL printed above
- they can stop it with `pkill -f tokenscope` when finished

If `npx tokenscope` is not installed, tell the user to install with `npm install -g tokenscope` and try again.

Do not analyze the dashboard yourself — it's a UI for the user.
