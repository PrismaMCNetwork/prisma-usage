---
description: Claude usage on this PC — today/week/tools/errors/sessions/status/what-is-sent, or setup <url> <token>
argument-hint: [today|week|tools|errors|sessions|status|what-is-sent|setup <url> <token>]
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/report.mjs" $ARGUMENTS`

Show the report above to the user as it is. If it points at something expensive or failing (a session with a huge average context, a tool returning very large results, a failure class that repeats), add one or two lines on what would cut it. Do not run anything else.
