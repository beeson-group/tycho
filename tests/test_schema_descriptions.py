"""Tests that every key of the scene schema is described, and that the scene reference page is generated from it."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = json.loads((ROOT / "spec" / "scene.schema.json").read_text(encoding="utf-8"))


def _described(node: Any, path: str, out: dict[str, str]) -> None:
    """Collects the description of every property, every $defs entry, and every variant with properties, by path."""
    if not isinstance(node, dict):
        return
    for group in ("properties", "$defs"):
        for name, child in node.get(group, {}).items():
            out[f"{path}/{group}/{name}"] = child.get("description", "")
            _described(child, f"{path}/{group}/{name}", out)
    for key in ("items", "additionalProperties"):
        _described(node.get(key), f"{path}/{key}", out)
    for key in ("oneOf", "anyOf"):
        for i, child in enumerate(node.get(key, [])):
            if isinstance(child, dict) and "properties" in child:
                out[f"{path}/{key}/{i}"] = child.get("description", "")
            _described(child, f"{path}/{key}/{i}", out)


DESCRIPTIONS: dict[str, str] = {}
_described(SCHEMA, "#", DESCRIPTIONS)


@pytest.mark.parametrize("path", sorted(DESCRIPTIONS))
def test_every_key_is_described(path: str) -> None:
    description = DESCRIPTIONS[path]
    assert description.strip(), f"{path} lacks a description"
    assert ";" not in description, f"{path} has a semicolon"
    assert "—" not in description, f"{path} has an em dash"


def test_reference_page_lists_every_definition(tmp_path: Path) -> None:
    spec = importlib.util.spec_from_file_location("reference", ROOT / "docs" / "reference.py")
    assert spec is not None
    assert spec.loader is not None
    reference = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reference)
    page = tmp_path / "reference.md"
    reference.write(page)
    text = page.read_text(encoding="utf-8")
    assert text.startswith("# Scene reference\n")
    for name in SCHEMA["$defs"]:
        assert f"\n## {name}\n" in text, f"the reference page lacks a section for {name}"
    for name in SCHEMA["properties"]:
        assert f"`{name}`" in text
