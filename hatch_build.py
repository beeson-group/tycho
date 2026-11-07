"""Refuses to build a wheel without the browser runtime, which ``write_html`` inlines into every page."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from hatchling.builders.hooks.plugin.interface import BuildHookInterface

RUNTIME = "src/pytycho/_static/tycho.js"


class RuntimeHook(BuildHookInterface):  # type: ignore[type-arg]
    PLUGIN_NAME = "custom"

    def initialize(self, version: str, build_data: dict[str, Any]) -> None:  # noqa: ARG002
        if version != "editable" and not (Path(self.root) / RUNTIME).is_file():
            msg = f"{RUNTIME} is missing: run `npm --prefix web ci && npm --prefix web run build` before building a wheel"
            raise FileNotFoundError(msg)
