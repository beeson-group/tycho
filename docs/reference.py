"""Writes the scene reference page, docs/reference.md, from the descriptions of spec/scene.schema.json.

docs/conf.py calls :func:`write` at every build, hence the page is not tracked in git.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

SCHEMA = Path(__file__).resolve().parent.parent / "spec" / "scene.schema.json"

INTRO = """# Scene reference

This page lists every key of `scene.tys`, the scene document, at version {{ scene_format }} of the scene format.
The page is generated from the descriptions of the JSON Schema at each build of the site.
A name in backticks at the end of a description is the name of the rule of the [spec](spec.md) that governs the key.
The raw schema is published at {{ schema_link }}.
"""


def anchor(*names: str) -> str:
    """Returns the HTML id of a section or a key, e.g. ``layer-trajectories-width``."""
    return re.sub(r"[^a-z0-9]+", "-", "-".join(names).lower()).strip("-")


def words(items: list[str]) -> str:
    """Joins items with the serial comma, e.g. ``a, b, and c``."""
    return items[0] if len(items) == 1 else " and ".join(items) if len(items) == 2 else ", ".join(items[:-1]) + ", and " + items[-1]


def type_of(node: dict[str, Any]) -> str:
    """Returns the type of a schema node as Markdown, with a link for each reference to a definition."""
    if "$ref" in node:
        name = node["$ref"].rsplit("/", 1)[-1]
        return f"[{name}](#{anchor('ref', name)})"
    if "const" in node:
        return f'`"{node["const"]}"`'
    if "enum" in node:
        return " \\| ".join(f"`{json.dumps(v)}`" for v in node["enum"])
    for key in ("anyOf", "oneOf"):
        if key in node:
            return " or ".join(dict.fromkeys(type_of(v) for v in node[key]))
    kind = node.get("type", "any")
    kind = " or ".join(kind) if isinstance(kind, list) else kind
    if kind == "array" and isinstance(node.get("items"), dict):
        return f"array of {type_of(node['items'])}"
    if kind == "object" and isinstance(node.get("additionalProperties"), dict):
        return f"map of {type_of(node['additionalProperties'])}"
    return kind


def rows(node: dict[str, Any], section: str, prefix: str = "") -> list[str]:
    """Returns the table rows of the properties of node, with nested objects flattened into dotted keys."""
    out = []
    required = set(node.get("required", []))
    for key, prop in node.get("properties", {}).items():
        path = prefix + key
        desc = prop.get("description", "").replace("|", "\\|")
        out.append(f'| <a id="{anchor(section, path)}"></a>`{path}` | {type_of(prop)} | {"yes" if key in required else ""} | {desc} |')
        out += rows(prop, section, path + ".")
        for inner, mark in (("items", "[]"), ("additionalProperties", ".*")):
            if isinstance(prop.get(inner), dict):
                out += rows(prop[inner], section, path + mark + ".")
        for variant in prop.get("anyOf", []) + prop.get("oneOf", []):
            out += rows(variant, section, path + ".")
    return out


def table(node: dict[str, Any], section: str) -> list[str]:
    """Returns the property table of node, or nothing when node does not have properties."""
    body = rows(node, section)
    return ["", "| Key | Type | Required | Description |", "| --- | --- | --- | --- |", *body] if body else []


def section(name: str, node: dict[str, Any]) -> list[str]:
    """Returns the section of one definition, with a subsection for each variant that has properties."""
    out = ["", f"({anchor('ref', name)})=", f"## {name}", "", node.get("description", ""), "", f"The type is {type_of(node)}."]
    out += table(node, name)
    for variant in node.get("oneOf", []) + node.get("anyOf", []):
        if "properties" not in variant:
            continue
        kind = variant["properties"].get("kind", {})
        kind = kind.get("const") or "/".join(kind.get("enum", []))
        keys = [k for k in variant.get("required", variant["properties"]) if k != "kind"]
        title = f"{name} of kind {kind}" if kind else f"{name} with " + words([f"`{k}`" for k in keys])
        out += ["", f"### {title}", "", variant.get("description", "")]
        out += table(variant, anchor(name, kind or "-".join(keys)))
    return out


def render(schema: dict[str, Any]) -> str:
    """Returns the Markdown of the reference page for schema."""
    lines = [INTRO.rstrip(), "", "(ref-scene)=", "## Scene", "", "The scene document is a JSON object with the keys below."]
    lines += table(schema, "scene")
    for name, node in schema["$defs"].items():
        lines += section(name, node)
    return "\n".join(lines) + "\n"


def write(dest: Path, schema_path: Path = SCHEMA) -> None:
    """Writes the reference page to dest, and leaves the file untouched when its text is unchanged."""
    text = render(json.loads(schema_path.read_text(encoding="utf-8")))
    if not dest.is_file() or dest.read_text(encoding="utf-8") != text:
        dest.write_text(text, encoding="utf-8")
