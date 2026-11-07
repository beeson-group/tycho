"""Fails unless pytycho, the npm package, and the Claude Code plugin carry the same version.

Given a tag such as ``v0.2.0``, it also fails unless the tag names this version and CHANGELOG.md has a
section for it. A release thus cannot go out with mismatched versions or without its notes. The script
uses only the standard library.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def versions() -> dict[str, str]:
    init = (ROOT / "src" / "pytycho" / "__init__.py").read_text(encoding="utf-8")
    match = re.search(r'^__version__ = "([^"]+)"', init, re.MULTILINE)
    marketplace = json.loads((ROOT / ".claude-plugin" / "marketplace.json").read_text(encoding="utf-8"))
    return {
        "src/pytycho/__init__.py": match.group(1) if match else "<missing>",
        "web/package.json": json.loads((ROOT / "web" / "package.json").read_text(encoding="utf-8"))["version"],
        ".claude-plugin/plugin.json": json.loads((ROOT / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))["version"],
        ".claude-plugin/marketplace.json": next(p["version"] for p in marketplace["plugins"] if p["name"] == "tycho"),
    }


def main(argv: list[str]) -> str | None:
    found = versions()
    if len(set(found.values())) != 1:
        return "versions disagree: " + ", ".join(f"{path} {v}" for path, v in found.items())
    version = next(iter(found.values()))
    if argv:
        tag = argv[0]
        if tag != f"v{version}":
            return f"tag {tag} does not name version {version}"
        changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
        if f"## [{version}]" not in changelog:
            return f"CHANGELOG.md does not have a section ## [{version}]"
    return None


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
