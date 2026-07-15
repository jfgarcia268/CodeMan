---
description: Disable the Graphify PreToolUse hooks (force raw codebase reads instead of the graph)
---

Run the toggle script to turn the Graphify PreToolUse hooks OFF:

```
python3 .claude/toggle_graphify.py disable
```

After it succeeds, the `graphify hook-guard` PreToolUse hooks are inactive, so
for the rest of this session you should explore the codebase with **raw reads,
greps, and globs** — do NOT run `graphify query/path/explain` for orientation.
Report the script's output to me.
