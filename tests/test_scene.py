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


def test_cross_references_fail_at_the_write_all_at_once():
    scene, moving, _ = small()
    scene.toggle("show")
    scene.selector("e", parameter="e")
    # ids given as strings are checked at the write, and handles of the wrong kind at the call
    scene.view(
        "v",
        frame="nowhere",
        driver=ty.driver(moving, "show"),
        layers=[ty.body("ghost"), ty.track(ty.sets({"kind": {"var": "show"}})), ty.track("unset"), ty.track(moving, highlight="show")],
    )
    scene.panel("p", "missing", {"show": 3, "e": 0.1})
    scene.layout(ty.split("row", 0.5, "p", "q"))
    scene.tabs("show", label="show")
    scene.readout("caption", {"member": "nope"})
    with pytest.raises(ty.SceneError) as info:
        scene.to_document()
    message = str(info.value)
    for expected in (
        "'nowhere', which is not a frame",
        "V3: the driver of view 'v' names 'show', which is a toggle, not a selector",
        "'ghost', which is not a body",
        "V2: a track layer of view 'v' names 'show', which is a toggle, not a choice",
        "'unset', which is not a track set",
        "2.7: a highlight of view 'v' names 'show', which is a toggle, not a selector",
        "'missing', which is not a view",
        "sets toggle 'show' to 3",
        "V1: panel 'p' sets 'e', which is scene-scoped",
        "the layout shows 'q', which is not a panel",
        "2.9: a tabs control names 'show', which is a toggle, not a choice",
    ):
        assert expected in message


def test_handles_of_the_wrong_kind_fail_at_the_call():
    scene, moving, _ = small()
    show = scene.toggle("show")
    with pytest.raises(ty.SceneError, match="toggle, not a selector"):
        ty.driver(moving, show)
    with pytest.raises(ty.SceneError, match="toggle, not a choice"):
        ty.sets(kind=show)
    with pytest.raises(ty.SceneError, match="but lacks a trail"):
        ty.track(moving, reveal="trail")
    with pytest.raises(ty.SceneError, match="toggle, not a choice"):
        scene.tabs(show, label="show")
    with pytest.raises(ty.SceneError, match="V3: the driver's member"):
        ty.driver(moving, "all")
    with pytest.raises(ty.SceneError, match="negative"):
        ty.track(moving, -1)
    with pytest.raises(ty.SceneError, match="not in \\(0, 1\\]"):
        ty.track(moving, trail=1.5)
    with pytest.raises(ty.SceneError, match=r"2\.7: a camera kind"):
        scene.view("v", frame="root", driver=ty.driver(moving, 0), layers=[], camera={"kind": "fisheye"})


def test_a_point_has_three_scalars_and_every_number_is_finite():
    scene = ty.Scene()
    root = scene.frame("root")
    with pytest.raises(ty.SceneError, match="F2"):
        scene.frame("shift", parent=root, origin=[1.0, 2.0])
    with pytest.raises(ty.SceneError, match="F2"):
        scene.body("b", frame=root, position=[1.0, 2.0, 3.0, 4.0])
    with pytest.raises(ty.SceneError, match="S4"):
        scene.track_set("s", frame=root, attrs={"mu": float("nan")})
    with pytest.raises(ty.SceneError, match="S4"):
        scene.clock("value", channels=["t"], steps=4, range=[0.0, float("inf")])
    with pytest.raises(ty.SceneError, match="F2"):
        scene.frame("z", parent=root, scale=np.int64(0))
    with pytest.raises(ty.SceneError, match="F2"):
        scene.frame("z", parent=root, scale=ty.attr("k") * 0)
    ts = scene.track_set("s", frame=root)
    with pytest.raises(ty.SceneError, match="not all finite"):
        ts.add([[0.0, 0.0], [float("nan"), 1.0]])
    with pytest.raises(ty.SceneError, match="S3"):
        scene.frame("a\n")


def test_an_attribute_scale_that_is_zero_for_a_drawn_set_fails_at_the_write():
    scene = ty.Scene()
    root = scene.frame("root")
    scene.frame("z", parent=root, scale=ty.attr("k"))
    ts = scene.track_set("s", frame=root, attrs={"k": 0.0}, dtype="float64")
    ts.add(np.zeros((2, 2)), channels={"t": [0.0, 1.0]})
    scene.clock(channels=["t"], steps=2)
    scene.view("v", frame="z", driver=ty.driver(ts, 0), layers=[ty.track(ts)])
    scene.panel("p", "v")
    with pytest.raises(ty.SceneError, match="F2: view 'v': the scale of frame 'z' is zero for track set 's'"):
        scene.to_document()


def test_add_copies_its_arrays_and_the_document_shares_nothing():
    scene, moving, _ = small()
    buf = np.zeros((3, 2))
    t = np.array([0.0, 1.0, 2.0])
    for k in range(3):
        buf[:] = [[k, 0], [k, 1], [k, 2]]
        moving.add(buf, channels={"t": t}, parameters={"e": 0.1 * k})
    t[:] = 5
    scene.view("v", frame="root", driver=ty.driver(moving, 0), layers=[ty.track(moving)])
    scene.panel("p", "v")
    data = ty.Container(scene.to_container())
    np.testing.assert_array_equal(data.view("moving/positions")[3:6, 0], [0.0, 0.0, 0.0])
    np.testing.assert_array_equal(data.view("moving/channels/t")[3:6], [0.0, 1.0, 2.0])
    doc = scene.to_document()
    doc["frames"]["root"]["scale"] = 0.0
    assert "scale" not in scene.to_document()["frames"]["root"]


def test_describe_keeps_channels_and_parameters_apart():
    scene, moving, _ = small()
    moving.describe("t", interp="hold", unit="TU")
    moving.describe("e", label="eccentricity")
    with pytest.raises(ty.SceneError, match="only a parameter takes one"):
        moving.describe("t", label="time")
    with pytest.raises(ty.SceneError, match="only a channel takes one"):
        moving.describe("e", interp="hold")
    with pytest.raises(ty.SceneError, match="not one of linear, hold"):
        moving.describe("t", interp="cubic")
    with pytest.raises(ty.SceneError, match="lacks a channel or a parameter named"):
        moving.describe("nope", unit="x")
    scene.view("v", frame="root", driver=ty.driver(moving, 0), layers=[])
    scene.panel("p", "v")
    doc = scene.to_document()
    assert doc["track_sets"]["moving"]["channels"]["t"] == {"view": "moving/channels/t", "interp": "hold", "unit": "TU"}
    assert doc["track_sets"]["moving"]["parameters"]["e"] == {"view": "moving/parameters/e", "label": "eccentricity"}


def test_readouts_and_sliders_are_checked_against_the_driver():
    scene, moving, still = small()
    e = scene.selector("e", parameter="e")
    k = scene.selector("k", by="index")
    scene.view("v", frame="root", driver=ty.driver(moving, e), layers=[])
    scene.panel("p", "v")
    scene.readout("panel", "e = ", {"member": "e", "digits": 3}, " at ", ty.channel("t"), " of ", 2 * ty.attr("mu") + 1)
    scene.readout("caption", {"member": "nope"}, {"channel": "nope"}, {"attr": "nope"})
    scene.slider(e, label="e", domain=still)
    scene.slider(k, label="k", domain=moving)
    with pytest.raises(ty.SceneError) as info:
        scene.to_document()
    message = str(info.value)
    for expected in (
        "names parameter 'nope', which track set 'moving' lacks",
        "names channel 'nope', which track set 'moving' lacks",
        "names attribute 'nope', which track set 'moving' lacks",
        "names attribute 'mu', which track set 'moving' lacks",
        "2.9: the slider over 'e' has track set 'still' in its domain, which lacks parameter 'e'",
        "2.9: the slider over 'k' needs a selector by nearest",
    ):
        assert expected in message
    with pytest.raises(ty.SceneError, match="of var, member, attr, channel, and clock, not one"):
        scene.readout("panel", {"member": "e", "attr": "mu"})
    with pytest.raises(ty.SceneError, match="digits"):
        scene.readout("panel", {"member": "e", "digits": 0})


def test_declarations_fail_at_the_call():
    scene = ty.Scene()
    with pytest.raises(ty.SceneError, match=r"2\.5"):
        scene.selector("k", by="rank")
    with pytest.raises(ty.SceneError, match=r"2\.5"):
        scene.selector("e")
    with pytest.raises(ty.SceneError, match=r"2\.5"):
        scene.choice("c", ["a", "b"], default="z")
    with pytest.raises(ty.SceneError, match="D1"):
        scene.track_set("s", frame=scene.frame("root"), dtype="int32")
