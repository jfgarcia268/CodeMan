---
description: Re-enable the Graphify PreToolUse hooks (graph-first codebase orientation)
---

Run the toggle script to turn the Graphify PreToolUse hooks back ON:

```
python3 .claude/toggle_graphify.py enable
```

After it succeeds, the `graphify hook-guard` PreToolUse hooks are active again,
so resume the normal graph-first workflow (`graphify query/path/explain` before
raw grepping, per CLAUDE.md). Report the script's output to me.
