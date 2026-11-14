"""The Broucke and the manifolds examples, built with a few members or arcs and skipped when their input files have not been downloaded."""

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
MANIFOLDS_INPUT = EXAMPLES / "manifolds" / "manifolds-input.tyd"


def _example(name: str):
    """The ``build.py`` module of an example, imported from the directory of the example."""
    spec = importlib.util.spec_from_file_location(f"{name}_build", EXAMPLES / name / "build.py")
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("name", ["broucke", "manifolds"])
def test_an_example_imports_only_numpy_pytycho_and_the_standard_library(name):
    tree = ast.parse((EXAMPLES / name / "build.py").read_text(encoding="utf-8"))
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
    assert all(s["trajectories"] == 3 for s in doc["trajectory_sets"].values())
    assert len(doc["trajectory_sets"]) == 6
    out = evaluate(doc, container, doc["initial"], 120)
    layers = out["panels"]["inertial"]["layers"]
    # the sparse subset holds every trajectory of a trajectory set of three, and the white trail has the head
    assert len(layers[0]["members"]) == len(layers[1]["members"]) == 3
    assert layers[4]["members"][0]["head"] is not None
    # each frame is a declared panel with the colormap of the frame, hence Add panel offers the five frames
    assert sorted(doc["panels"]) == sorted(build.PANELS)
    assert doc["panels"]["inertial-m2"]["layers"][0]["color"]["colormap"] == "cividis"
    # the pulsation scale rho and the time channel come from the input, with one value per stored sample
    rho = container.array("family-7-periapsis/channels/rho")
    assert rho.shape == container.array("family-7-periapsis/channels/time").shape
    assert float(rho.min()) > 0.0
    assert int(np.diff(container.array("family-7-periapsis/offsets")).max()) <= 480


def _lines(out, panel: str, layer: int) -> list[int]:
    """The number of vertices of every member's line in one layer of one panel."""
    return [len(m["line"]) for m in out["panels"][panel]["layers"][layer]["members"]]


@pytest.mark.skipif(not MANIFOLDS_INPUT.is_file(), reason="needs examples/manifolds/manifolds-input.tyd, attached to each GitHub Release")
def test_manifolds_example_builds_a_valid_scene(tmp_path):
    jsonschema = pytest.importorskip("jsonschema")
    build = _example("manifolds")
    build.build(MANIFOLDS_INPUT, tmp_path, 3, False)
    doc = json.loads((tmp_path / "manifolds.tys").read_text())
    jsonschema.Draft202012Validator(SCHEMA).validate(doc)
    container = Container.read(tmp_path / "manifolds.tyd")
    sets = doc["trajectory_sets"]
    assert len(sets) == 15
    assert all(sets[s]["trajectories"] == (1 if s.endswith("-orbit") else 3) for s in sets)
    assert doc["panels"]["main"]["camera"] == {
        "kind": "3d",
        "projection": "perspective",
        "up": "z",
        "stretch": [1.0, 1.0, build.STRETCH_Z],
        "auto_rotate": build.AUTO_ROTATE,
    }
    clock = doc["clock"]
    assert clock["mode"] == "epoch"
    assert clock["seconds"] == 24.0
    manifold_time = float(Container(MANIFOLDS_INPUT.read_bytes()).meta["manifold_time"])
    assert clock["range"][0] == -manifold_time

    # the time of a stable leg increases along the stored trajectory and runs from the departure minus the manifold time
    offsets = container.array("halo-L1-stable-left/offsets")
    stable_time = container.array("halo-L1-stable-left/channels/time")[offsets[0] : offsets[1]]
    departure = container.array("halo-L1-stable-left/parameters/departure")
    assert bool(np.all(np.diff(stable_time) > 0))
    assert stable_time[0] == pytest.approx(departure[0] - manifold_time)
    assert stable_time[-1] < departure[0]
    # a stable arc ends where it comes within the clearance of the orbit, and an unstable arc starts where it leaves it
    orbit = Container(MANIFOLDS_INPUT.read_bytes()).array("halo-L1-orbit/positions")
    for set_id, end in (("halo-L1-stable-left", -1), ("halo-L1-unstable-left", 0)):
        bounds = container.array(f"{set_id}/offsets")
        arc = container.array(f"{set_id}/positions")[bounds[0] : bounds[1]]
        gap = float(np.min(np.linalg.norm(orbit - arc[end], axis=1)))
        assert build.CLEARANCE <= gap < 1.5 * build.CLEARANCE
    # the repeated orbit covers the clock range with a strictly increasing time
    orbit_time = container.array("halo-L1-orbit/channels/time")
    assert orbit_time[0] < clock["range"][0]
    assert orbit_time[-1] > clock["range"][1]
    assert bool(np.all(np.diff(orbit_time) > 0))

    # layers 0 to 3 are the four legs, 4 the orbit, 5 and 6 the Earth and the Moon
    frame_count = clock["frame_count"]
    first, last = evaluate(doc, container, doc["initial"], 0), evaluate(doc, container, doc["initial"], frame_count - 1)
    # at the start, every unstable arc is hidden and only the stable arc arriving at departure 0 shows, as its first sample
    assert _lines(first, "rotating", 2) == [0, 0, 0]
    assert sorted(_lines(first, "rotating", 0)) == [0, 0, 1]
    # the arcs are complete once 20 of the 24 seconds have passed, and they are held to the end of the loop
    hold = evaluate(doc, container, doc["initial"], int(frame_count * 20.2 / 24))
    whole = [int(d) for d in np.diff(offsets)]
    assert _lines(hold, "rotating", 0) == _lines(last, "rotating", 0) == whole
    assert all(x > 0 for x in _lines(last, "rotating", 2))
    # nothing is drawn with a head
    assert all(m.get("head") is None for layer in last["panels"]["rotating"]["layers"] for m in layer.get("members", []))
    # the orbit trail is drawn throughout, and it differs between the rotating and the inertial frame
    rot = first["panels"]["rotating"]["layers"][4]["members"][0]["line"]
    inert = first["panels"]["inertial"]["layers"][4]["members"][0]["line"]
    assert len(rot) == len(inert) > 2
    assert rot[-1] != inert[-1]


@pytest.mark.skipif(not MANIFOLDS_INPUT.is_file(), reason="needs examples/manifolds/manifolds-input.tyd, attached to each GitHub Release")
def test_manifolds_slide_variant_holds_the_halo_alone_in_two_stacked_panels(tmp_path):
    build = _example("manifolds")
    build.build(MANIFOLDS_INPUT, tmp_path, 3, False, "light")
    doc = json.loads((tmp_path / "manifolds-slide-light.tys").read_text())
    assert sorted(doc["trajectory_sets"]) == sorted(["halo-L1-orbit"] + [f"halo-L1-{a}-{b}" for a, b in build.LEGS])
    assert doc["theme"] == build.SLIDE_THEMES["light"]
    assert doc["initial"]["layout"] == {
        "kind": "split",
        "dir": "col",
        "ratio": 0.5,
        "a": {"kind": "panel", "id": "inertial"},
        "b": {"kind": "panel", "id": "rotating"},
    }
    assert [r["place"] for r in doc["readouts"]] == ["panel"]
    trajectory_layers = [layer for layer in doc["panels"]["main"]["layers"] if layer["kind"] == "trajectories"]
    assert all("highlight" not in layer for layer in trajectory_layers)
    assert {layer["color"] for layer in trajectory_layers} == set(build.SLIDE_COLORS["light"].values())
