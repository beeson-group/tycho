"""The Broucke example, built with a few members per family and skipped when its input file has not been downloaded."""

from __future__ import annotations

import ast
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
import pytest

from pytycho._evaluate import evaluate
from pytycho.container import Container

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "examples"
SCHEMA = json.loads((ROOT / "spec" / "scene.schema.json").read_text())
BROUCKE_INPUT = EXAMPLES / "broucke" / "broucke-input.tyd"


def _example(name: str):
    """The ``build.py`` module of an example, imported from the directory of the example."""
    spec = importlib.util.spec_from_file_location(f"{name}_build", EXAMPLES / name / "build.py")
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


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


@pytest.mark.skipif(not BROUCKE_INPUT.is_file(), reason="needs examples/broucke/broucke-input.tyd, attached to each GitHub Release")
def test_broucke_example_builds_a_valid_scene(tmp_path):
    jsonschema = pytest.importorskip("jsonschema")
    build = _example("broucke")
    build.build(BROUCKE_INPUT, tmp_path, 1, False)
    doc = json.loads((tmp_path / "broucke.tys").read_text())
    jsonschema.Draft202012Validator(SCHEMA).validate(doc)
    container = Container.read(tmp_path / "broucke.tyd")
    assert all(s["tracks"] == 3 for s in doc["track_sets"].values())
    assert len(doc["track_sets"]) == 6
    out = evaluate(doc, container, doc["initial"], 120)
    layers = out["panels"]["inertial"]["layers"]
    # the sparse context holds every track of a track set of three, and the white trail has the head
    assert len(layers[0]["members"]) == len(layers[1]["members"]) == 3
    assert layers[4]["members"][0]["head"] is not None
    assert doc["views"]["main"]["layers"][0]["color"]["colormap"]["map"]["inertial-m2"] == "cividis"
    # the pulsation scale rho and the time channel come from the input, with one value per stored sample
    rho = container.view("family-7-periapsis/channels/rho")
    assert rho.shape == container.view("family-7-periapsis/channels/time").shape
    assert float(rho.min()) > 0.0
    assert int(np.diff(container.view("family-7-periapsis/offsets")).max()) <= 480
