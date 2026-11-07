"""The Scene API: ``rotating-loop`` rebuilt through it gives the corpus answers, and ``thin`` keeps its contract."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest

import pytycho as ty
from pytycho._evaluate import evaluate
from test_conformance import compare  # tests/ is on sys.path in pytest's prepend import mode

CORPUS = Path(__file__).resolve().parents[1] / "spec" / "conformance"

LOOP = np.array([[1.0, 0.0], [0.0, 1.0], [-1.0, 0.0], [0.0, -1.0], [1.0, 0.0]])
ANGLE = np.array([0.0, 0.5, 1.0, 1.5, 2.5])


def rotating_loop() -> ty.Scene:
    scene = ty.Scene()
    rot = scene.frame("rot", label="rotating")
    scene.frame("inertial", parent=rot, rotation=ty.rotation("z", ty.channel("a")))
    scene.frame("scaled", parent=rot, origin=[ty.attr("d"), 0.0, 0.0], rotation=ty.rotation("x", 0.25), scale=ty.attr("k"))
    b1 = scene.body("b1", frame=rot, position=[ty.attr("d"), 0.0, 0.0])
    loop = scene.track_set("loop", frame=rot, attrs={"d": 0.5, "k": 2.0}, periodic=True)
    loop.add(LOOP, channels={"a": ANGLE})
    loop.describe("a", interp="linear")
    frame = scene.choice("frame", ["rot", "inertial", "scaled"], scope="panel")
    scene.clock("fraction", channels=["@index", "a"], steps=8)
    scene.view(
        "v",
        frame=frame,
        driver=ty.driver(loop, 0),
        layers=[ty.track(loop, reveal="none"), ty.track(loop, trail=0.5, head=True), ty.body(b1, trail=0.5), ty.axes()],
    )
    scene.panel("p1", "v")
    return scene


def test_document_validates_against_the_schema():
    jsonschema = pytest.importorskip("jsonschema")
    schema = json.loads((CORPUS.parent / "scene.schema.json").read_text())
    jsonschema.Draft202012Validator(schema).validate(rotating_loop().to_document())


def test_rotating_loop_through_the_api_gives_the_corpus_answers():
    scene = rotating_loop()
    document, data = scene.to_document(), scene.to_container()
    for case in json.loads((CORPUS / "rotating-loop" / "cases.json").read_text()):
        compare(evaluate(document, data, case["state"], case["frame_index"]), case["expected"], case["tolerance"])


def test_attr_arithmetic():
    assert (1 - ty.attr("mu")).to_json() == {"attr": "mu", "factor": -1.0, "offset": 1.0}
    assert (-ty.attr("mu")).to_json() == {"attr": "mu", "factor": -1.0}
    assert (ty.attr("mu") * 2 + 3).to_json() == {"attr": "mu", "factor": 2.0, "offset": 3.0}


def test_s3_and_t1_fail_at_the_call():
    scene = ty.Scene()
    with pytest.raises(ty.SceneError, match="S3"):
        scene.frame("not an id")
    root = scene.frame("root")
    ts = scene.track_set("s", frame=root)
    with pytest.raises(ty.SceneError, match="T1"):
        ts.add(np.zeros((1, 2)))


def test_thin_selects_stored_samples_in_other_frames():
    scene = ty.Scene()
    rot = scene.frame("rot")
    scene.frame("inertial", parent=rot, rotation=ty.rotation("z", ty.channel("f")))
    ts = scene.track_set("s", frame=rot, dtype="float64")
    f = np.linspace(0, 6, 300)
    ts.add(np.column_stack([np.cos(3 * f), np.sin(f)]), channels={"f": f})
    ts.add(np.column_stack([f, f]), channels={"f": f})
    kept = ts.thin(20, frames=["rot", "inertial"], keep=[[7], []])
    assert all(len(k) <= 20 and k[0] == 0 and k[-1] == 299 for k in kept)
    assert 7 in kept[0]
    # the returned list is a copy, thus editing it cannot break the stored selection
    kept[0][1] = 0
    assert ts.kept is not None
    assert ts.kept[0][1] != 0
    scene.clock(channels=["f"], steps=4)
    scene.view("v", frame="rot", driver=ty.driver(ts, 0), layers=[])
    scene.panel("p", "v")
    stored = ty.Container(scene.to_container())
    np.testing.assert_array_equal(stored.view("s/channels/f"), np.concatenate([f[k] for k in ts.kept]))


def test_kept_must_count_the_tracks():
    scene = ty.Scene()
    rot = scene.frame("rot")
    ts = scene.track_set("s", frame=rot)
    f = np.linspace(0, 6, 50)
    ts.add(np.column_stack([np.cos(f), np.sin(f)]), channels={"f": f})
    ts.add(np.column_stack([f, f]), channels={"f": f})
    ts.thin(10)
    assert ts.kept is not None
    ts.kept = ts.kept[:1]  # a selection that lost a track is a T1 failure, not a silently shorter container
    scene.clock(channels=["f"], steps=4)
    scene.view("v", frame="rot", driver=ty.driver(ts, 0), layers=[])
    scene.panel("p", "v")
    with pytest.raises(ty.SceneError, match="T1: track set 's' has kept indices for 1 tracks, not 2"):
        scene.to_container()


def test_writer_lists_every_failure_with_its_rule():
    scene = ty.Scene()
    rot = scene.frame("rot")
    scene.frame("inertial", parent=rot, rotation=ty.rotation("z", ty.channel("f")))
    for sid in ("a", "b"):
        ts = scene.track_set(sid, frame=rot, tags={"kind": "x"})
        ts.add(np.zeros((3, 2)), channels={"t": [0.0, 1.0, 1.0]})
    frame = scene.choice("frame", ["rot", "inertial"], scope="panel")
    scene.clock(channels=["t"], steps=4)
    scene.view("v", frame=frame, driver=ty.driver(ty.set_id("a"), 0), layers=[ty.track(ty.sets(kind="x"))])
    scene.panel("p", "v")
    with pytest.raises(ty.SceneError) as info:
        scene.to_document()
    message = str(info.value)
    for expected in ("T3:", "V2:", "F5:", "'inertial'"):
        assert expected in message


def small():
    scene = ty.Scene()
    root = scene.frame("root")
    moving = scene.track_set("moving", frame=root, dtype="float64")
    moving.add(np.zeros((3, 2)), channels={"t": [0.0, 1.0, 2.0]}, parameters={"e": 0.1})
    still = scene.track_set("still", frame=root)
    still.add(np.ones((2, 2)))
    scene.clock(channels=["t"], steps=4)
    return scene, moving, still


def test_c5_only_a_set_that_is_read_needs_the_clock_channels():
    scene, moving, still = small()
    scene.view("v", frame="root", driver=ty.driver(moving, 0), layers=[ty.track(still)])
    scene.panel("p", "v")
    scene.to_document()
    reads: dict[str, Any]
    for reads in ({"head": True}, {"reveal": "grow"}, {"trail": 0.5}):
        scene, moving, still = small()
        scene.view("v", frame="root", driver=ty.driver(moving, 0), layers=[ty.track(still, **reads)])
        scene.panel("p", "v")
        with pytest.raises(ty.SceneError, match="C5: view 'v': track set 'still'"):
            scene.to_document()
    scene, moving, still = small()
    scene.view("v", frame="root", driver=ty.driver(still, 0), layers=[])
    scene.panel("p", "v")
    with pytest.raises(ty.SceneError, match="C5: view 'v': track set 'still', the driver"):
        scene.to_document()


def test_v3_fails_at_the_write():
    scene, moving, still = small()
    e = scene.selector("e", parameter="e")
    scene.view("v", frame="root", driver=ty.driver(moving, 1), layers=[ty.track(still, e), ty.track(moving, 0)])
    scene.panel("p", "v")
    with pytest.raises(ty.SceneError) as info:
        scene.to_document()
    message = str(info.value)
    assert "V3: view 'v': member index 1 of the driver is not below the track count 1 of track set 'moving'" in message
    assert "V3: view 'v': track set 'still' lacks parameter 'e' for selector 'e'" in message
