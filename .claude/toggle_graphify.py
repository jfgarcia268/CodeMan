#!/usr/bin/env python3
"""Toggle the Graphify PreToolUse hooks in .claude/settings.json on or off.

The Graphify hooks (see CLAUDE.md) run `graphify hook-guard ...` before Bash /
Read / Glob tool calls to steer the agent toward the knowledge graph. Disabling
them forces a raw read of the codebase instead of the graph.

Usage:
    python3 .claude/toggle_graphify.py disable   # graph guidance OFF (raw reads)
    python3 .claude/toggle_graphify.py enable    # graph guidance ON

The script renames the "PreToolUse" key to "_PreToolUse_disabled" (and back).
It works whether that key lives at the top level of settings.json or nested
under the standard "hooks" object.
"""

import json
import sys
from pathlib import Path

ACTIVE_KEY = "PreToolUse"
DISABLED_KEY = "_PreToolUse_disabled"

# settings.json lives next to this script, in the .claude directory.
SETTINGS_PATH = Path(__file__).resolve().parent / "settings.json"


def usage(exit_code: int) -> None:
    print("Usage: python3 .claude/toggle_graphify.py [enable|disable]")
    sys.exit(exit_code)


def load_settings(path: Path) -> dict:
    if not path.exists():
        print(f"Error: settings file not found at {path}")
        sys.exit(1)
    try:
        with path.open("r", encoding="utf-8") as fh:
            return json.load(fh)
    except json.JSONDecodeError as exc:
        print(f"Error: {path} is not valid JSON ({exc}). Aborting so nothing is clobbered.")
        sys.exit(1)


def save_settings(path: Path, data: dict) -> None:
    # Write with a trailing newline and 2-space indent to match the existing file.
    with path.open("w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")


def find_container(settings: dict, key: str):
    """Return the dict that directly holds `key`, or None if it isn't present.

    Checks the top level first, then the nested "hooks" object (where Claude
    Code actually stores hook config in this project).
    """
    if isinstance(settings, dict) and key in settings:
        return settings
    hooks = settings.get("hooks") if isinstance(settings, dict) else None
    if isinstance(hooks, dict) and key in hooks:
        return hooks
    return None


def rename_key(container: dict, old: str, new: str) -> None:
    """Rename `old` -> `new` in-place, preserving key order."""
    rebuilt = {}
    for k, v in container.items():
        rebuilt[new if k == old else k] = v
    container.clear()
    container.update(rebuilt)


def disable(settings: dict) -> bool:
    if find_container(settings, DISABLED_KEY) is not None:
        print(f'"{DISABLED_KEY}" already present — Graphify hooks are already disabled. Nothing to do.')
        return False
    container = find_container(settings, ACTIVE_KEY)
    if container is None:
        print(f'Error: no "{ACTIVE_KEY}" key found in settings.json (top level or under "hooks"). Nothing to disable.')
        return False
    rename_key(container, ACTIVE_KEY, DISABLED_KEY)
    print(f'Disabled: renamed "{ACTIVE_KEY}" -> "{DISABLED_KEY}". Graphify hooks are OFF (raw reads).')
    return True


def enable(settings: dict) -> bool:
    if find_container(settings, ACTIVE_KEY) is not None:
        print(f'"{ACTIVE_KEY}" already present — Graphify hooks are already enabled. Nothing to do.')
        return False
    container = find_container(settings, DISABLED_KEY)
    if container is None:
        print(f'Error: no "{DISABLED_KEY}" key found in settings.json (top level or under "hooks"). Nothing to enable.')
        return False
    rename_key(container, DISABLED_KEY, ACTIVE_KEY)
    print(f'Enabled: renamed "{DISABLED_KEY}" -> "{ACTIVE_KEY}". Graphify hooks are ON.')
    return True


def main() -> None:
    if len(sys.argv) != 2:
        usage(2)
    action = sys.argv[1].strip().lower()
    if action not in ("enable", "disable"):
        print(f'Error: unknown argument "{sys.argv[1]}".')
        usage(2)

    settings = load_settings(SETTINGS_PATH)
    changed = disable(settings) if action == "disable" else enable(settings)
    if changed:
        save_settings(SETTINGS_PATH, settings)


if __name__ == "__main__":
    main()
