"""The Broucke example, built with a few members per family and skipped when its input file has not been downloaded."""

from __future__ import annotations

import ast
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "examples"


def test_broucke_example_imports_only_numpy_pytycho_and_the_standard_library():
    tree = ast.parse((EXAMPLES / "broucke" / "build.py").read_text(encoding="utf-8"))
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            assert node.level == 0, "build.py imports nothing relative to itself"
            assert node.module is not None
            imported.add(node.module.split(".")[0])
    assert imported, "build.py imports nothing, so the walk found no import"
    assert imported - sys.stdlib_module_names - {"numpy", "pytycho"} == set()

