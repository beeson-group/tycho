"""The Scene API: ``rotating-loop`` rebuilt through it gives the corpus answers, and ``thin`` keeps its contract."""

from __future__ import annotations

import base64
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
    loop = scene.trajectory_set("loop", frame=rot, attrs={"d": 0.5, "k": 2.0}, periodic=True)
    loop.add(LOOP, channels={"a": ANGLE})
    loop.describe("a", interp="linear")
    frame = scene.choice("frame", ["rot", "inertial", "scaled"], scope="per_panel")
    scene.clock("fraction", channels=["@index", "a"], frame_count=8)
    scene.panel(
        "v",
        frame=frame,
        reference=ty.reference(loop, 0),
        layers=[ty.trajectories(loop, reveal="none"), ty.trajectories(loop, trail=0.5, head=True), ty.body(b1, trail=0.5), ty.axes()],
    )
    scene.show("p1", panel="v")
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


def test_identifier_and_two_samples_fail_at_the_call():
    scene = ty.Scene()
    with pytest.raises(ty.SceneError, match="identifier"):
        scene.frame("not an id")
    root = scene.frame("root")
    ts = scene.trajectory_set("s", frame=root)
    with pytest.raises(ty.SceneError, match="two-samples"):
        ts.add(np.zeros((1, 2)))
    with pytest.raises(ty.SceneError, match=r"^identifier: the parameter name @index is built in"):
        ts.add(np.zeros((2, 2)), parameters={"@index": 1.0})


def test_the_layout_shows_a_declared_panel_that_was_not_shown():
    scene, moving, _ = small()
    scene.panel("v", frame="root", reference=ty.reference(moving, 0), layers=[])
    scene.panel("w", frame="root", reference=ty.reference(moving, 0), layers=[])
    assert scene.to_document()["initial"]["panels"] == {"v": {"panel": "v"}, "w": {"panel": "w"}}
    scene.show("copy", panel="v")
    scene.layout(ty.split("row", 0.5, "copy", "w"))
    initial = scene.to_document()["initial"]
    assert initial["panels"] == {"copy": {"panel": "v"}, "w": {"panel": "w"}}
    with pytest.raises(ty.SceneError, match=r"^panel: the scene does not have a panel"):
        small()[0].to_document()


def test_thin_selects_stored_samples_in_other_frames():
    scene = ty.Scene()
    rot = scene.frame("rot")
    scene.frame("inertial", parent=rot, rotation=ty.rotation("z", ty.channel("f")))
    ts = scene.trajectory_set("s", frame=rot, dtype="float64")
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
    scene.clock(channels=["f"], frame_count=4)
    scene.panel("v", frame="rot", reference=ty.reference(ts, 0), layers=[])
    scene.show("p", panel="v")
    stored = ty.Container(scene.to_container())
    np.testing.assert_array_equal(stored.array("s/channels/f"), np.concatenate([f[k] for k in ts.kept]))


def test_kept_must_count_the_trajectories():
    scene = ty.Scene()
    rot = scene.frame("rot")
    ts = scene.trajectory_set("s", frame=rot)
    f = np.linspace(0, 6, 50)
    ts.add(np.column_stack([np.cos(f), np.sin(f)]), channels={"f": f})
    ts.add(np.column_stack([f, f]), channels={"f": f})
    ts.thin(10)
    assert ts.kept is not None
    ts.kept = ts.kept[:1]  # a selection that lost a trajectory is a two-samples failure, not a silently shorter container
    scene.clock(channels=["f"], frame_count=4)
    scene.panel("v", frame="rot", reference=ty.reference(ts, 0), layers=[])
    scene.show("p", panel="v")
    with pytest.raises(ty.SceneError, match="two-samples: trajectory set 's' has kept indices for 1 trajectories, not 2"):
        scene.to_container()


def test_writer_lists_every_failure_with_its_rule():
    scene = ty.Scene()
    rot = scene.frame("rot")
    scene.frame("inertial", parent=rot, rotation=ty.rotation("z", ty.channel("f")))
    for sid in ("a", "b"):
        ts = scene.trajectory_set(sid, frame=rot, tags={"kind": "x"})
        ts.add(np.zeros((3, 2)), channels={"t": [0.0, 1.0, 1.0]})
    frame = scene.choice("frame", ["rot", "inertial"], scope="per_panel")
    scene.clock(channels=["t"], frame_count=4)
    scene.panel("v", frame=frame, reference=ty.reference(ty.by_id("a"), 0), layers=[ty.trajectories(ty.by_tags(kind="x"))])
    scene.show("p", panel="v")
    with pytest.raises(ty.SceneError) as info:
        scene.to_document()
    message = str(info.value)
    for expected in ("monotone-clock-channel:", "set-query:", "transform-channels:", "'inertial'"):
        assert expected in message


def small():
    scene = ty.Scene()
    root = scene.frame("root")
    moving = scene.trajectory_set("moving", frame=root, dtype="float64")
    moving.add(np.zeros((3, 2)), channels={"t": [0.0, 1.0, 2.0]}, parameters={"e": 0.1})
    still = scene.trajectory_set("still", frame=root)
    still.add(np.ones((2, 2)))
    scene.clock(channels=["t"], frame_count=4)
    return scene, moving, still


def test_clock_channel_carried_only_a_set_that_is_read_needs_the_clock_channels():
    scene, moving, still = small()
    scene.panel("v", frame="root", reference=ty.reference(moving, 0), layers=[ty.trajectories(still)])
    scene.show("p", panel="v")
    scene.to_document()
    reads: dict[str, Any]
    for reads in ({"head": True}, {"reveal": "grow"}, {"trail": 0.5}):
        scene, moving, still = small()
        scene.panel("v", frame="root", reference=ty.reference(moving, 0), layers=[ty.trajectories(still, **reads)])
        scene.show("p", panel="v")
        with pytest.raises(ty.SceneError, match="clock-channel-carried: panel 'v': trajectory set 'still'"):
            scene.to_document()
    scene, moving, still = small()
    scene.panel("v", frame="root", reference=ty.reference(still, 0), layers=[])
    scene.show("p", panel="v")
    with pytest.raises(ty.SceneError, match="clock-channel-carried: panel 'v': trajectory set 'still', the reference trajectory"):
        scene.to_document()


def breathing(driver_channels=("t", "rho")):
    """A reference trajectory in a scaled frame, and a grid of the unscaled frame without any channel."""
    scene = ty.Scene()
    pulsating = scene.frame("pulsating")
    rot = scene.frame("rot", parent=pulsating, scale=ty.channel("rho"))
    orbit = scene.trajectory_set("orbit", frame=rot, dtype="float64")
    channels = {"t": [0.0, 1.0, 2.0], "rho": [1.0, 2.0, 3.0]}
    orbit.add(np.zeros((3, 2)), channels={k: channels[k] for k in driver_channels})
    grid = scene.trajectory_set("grid", frame=pulsating, dtype="float64")
    grid.add(np.array([[1.0, 0.0], [1.0, 1.0]]))
    scene.clock(channels=["t"], frame_count=4)
    return scene, orbit, grid


def test_a_layer_read_from_the_reference_reads_the_frame_edges_on_the_reference_trajectory():
    scene, orbit, grid = breathing()
    scene.panel("v", frame="rot", reference=ty.reference(orbit, 0), layers=[ty.trajectories(grid, read_from="reference")])
    scene.show("p", panel="v")
    doc, data = scene.to_document(), scene.to_container()
    assert (doc["version"], doc["requires"]) == ("0.5", ["layers.read_from"])
    assert doc["panels"]["v"]["layers"][0]["read_from"] == "reference"
    # at frame 1 of 4 the reference trajectory reads t = 0.5, halfway between rho = 1 and rho = 2 (rules `body-layer` and `read-from`)
    line = evaluate(doc, data, doc["initial"], 1)["panels"]["p"]["layers"][0]["members"][0]["line"]
    assert np.allclose(line, [[1.5, 0.0, 0.0], [1.5, 1.5, 0.0]])
    scene, orbit, grid = breathing()
    scene.panel("v", frame="rot", reference=ty.reference(orbit, 0), layers=[ty.trajectories(grid)])
    scene.show("p", panel="v")
    with pytest.raises(ty.SceneError, match=r"transform-channels: panel 'v': .*'grid'"):
        scene.to_document()
    scene, orbit, grid = breathing(driver_channels=("t",))
    scene.panel("v", frame="rot", reference=ty.reference(orbit, 0), layers=[ty.trajectories(grid, read_from="reference")])
    scene.show("p", panel="v")
    with pytest.raises(ty.SceneError, match=r"transform-channels: .*in the reference trajectory's context"):
        scene.to_document()


def test_a_layer_read_from_the_reference_is_checked():
    scene, orbit, grid = breathing()
    scene.panel("v", frame="pulsating", reference=ty.reference(orbit, 0), layers=[ty.trajectories(orbit)])
    scene.show("p", panel="v")
    assert "requires" not in scene.to_document()
    with pytest.raises(ty.SceneError, match="read-from: a trajectories layer's read_from"):
        scene.panel("w", frame="pulsating", reference=ty.reference(orbit, 0), layers=[ty.trajectories(grid, read_from="sample")])
    # a head reads the clock channel, which the grid lacks also in the reference trajectory's context (rule `clock-channel-carried`)
    scene, orbit, grid = breathing()
    scene.panel("v", frame="rot", reference=ty.reference(orbit, 0), layers=[ty.trajectories(grid, read_from="reference", head=True)])
    scene.show("p", panel="v")
    with pytest.raises(ty.SceneError, match="clock-channel-carried: panel 'v': trajectory set 'grid'"):
        scene.to_document()


def test_members_fail_at_the_write():
    scene, moving, still = small()
    e = scene.parameter("e", parameter="e")
    scene.panel("v", frame="root", reference=ty.reference(moving, 1), layers=[ty.trajectories(still, e), ty.trajectories(moving, 0)])
    scene.show("p", panel="v")
    with pytest.raises(ty.SceneError) as info:
        scene.to_document()
    message = str(info.value)
    assert (
        "members: panel 'v': member index 1 of the reference trajectory is not below the trajectory count 1 of trajectory set 'moving'"
        in message
    )
    assert "members: panel 'v': trajectory set 'still' lacks parameter 'e' for parameter input 'e'" in message


def test_cross_references_fail_at_the_write_all_at_once():
    scene, moving, _ = small()
    scene.toggle("show")
    scene.parameter("e", parameter="e")
    # ids given as strings are checked at the write, and handles of the wrong kind at the call
    scene.panel(
        "v",
        frame="nowhere",
        reference=ty.reference(moving, "show"),
        layers=[
            ty.body("ghost"),
            ty.trajectories(ty.by_tags({"kind": {"input": "show"}})),
            ty.trajectories("unset"),
            ty.trajectories(moving, highlight="show"),
        ],
    )
    scene.show("p", panel="missing", inputs={"show": 3, "e": 0.1})
    scene.layout(ty.split("row", 0.5, "p", "q"))
    scene.tabs("show", label="show")
    scene.readout("caption", {"parameter": "nope"})
    with pytest.raises(ty.SceneError) as info:
        scene.to_document()
    message = str(info.value)
    for expected in (
        "'nowhere', which is not a frame",
        "members: the reference trajectory of panel 'v' names 'show', which is a toggle, not a parameter",
        "'ghost', which is not a body",
        "set-query: a trajectories layer of panel 'v' names 'show', which is a toggle, not a choice",
        "'unset', which is not a trajectory set",
        "panel: a highlight of panel 'v' names 'show', which is a toggle, not a parameter",
        "'missing', which is not a declared panel",
        "sets toggle 'show' to 3",
        "input-scope: shown panel 'p' sets 'e', which is shared and never read there",
        "the layout shows 'q', which is not a shown panel",
        "control: a tabs control names 'show', which is a toggle, not a choice",
    ):
        assert expected in message


def test_handles_of_the_wrong_kind_fail_at_the_call():
    scene, moving, _ = small()
    show = scene.toggle("show")
    with pytest.raises(ty.SceneError, match="toggle, not a parameter"):
        ty.reference(moving, show)
    with pytest.raises(ty.SceneError, match="toggle, not a choice"):
        ty.by_tags(kind=show)
    with pytest.raises(ty.SceneError, match="but lacks a trail"):
        ty.trajectories(moving, reveal="trail")
    with pytest.raises(ty.SceneError, match="toggle, not a choice"):
        scene.tabs(show, label="show")
    with pytest.raises(ty.SceneError, match="members: the reference trajectory's member"):
        ty.reference(moving, "all")
    with pytest.raises(ty.SceneError, match="negative"):
        ty.trajectories(moving, -1)
    with pytest.raises(ty.SceneError, match="not in \\(0, 1\\]"):
        ty.trajectories(moving, trail=1.5)
    with pytest.raises(ty.SceneError, match=r"panel: a camera kind"):
        scene.panel("v", frame="root", reference=ty.reference(moving, 0), layers=[], camera={"kind": "fisheye"})


def test_a_2d_camera_takes_an_aspect_and_a_3d_camera_does_not():
    scene, moving, _ = small()
    scene.panel(
        "v", frame="root", reference=ty.reference(moving, 0), layers=[ty.trajectories(moving)], camera={"kind": "2d", "aspect": "free"}
    )
    scene.show("p", panel="v")
    doc = scene.to_document()
    assert doc["panels"]["v"]["camera"] == {"kind": "2d", "aspect": "free"}
    assert doc["version"] == "0.5"
    with pytest.raises(ty.SceneError, match=r"panel: a camera aspect is 'stretch', not one of equal, free"):
        scene.panel("w", frame="root", reference=ty.reference(moving, 0), layers=[], camera={"kind": "2d", "aspect": "stretch"})
    with pytest.raises(ty.SceneError, match=r"panel: .* camera has unknown keys \['aspect'\]"):
        scene.panel("w", frame="root", reference=ty.reference(moving, 0), layers=[], camera={"kind": "3d", "aspect": "free"})


def test_a_3d_camera_takes_a_stretch_and_an_auto_rotate_and_a_2d_camera_does_not():
    jsonschema = pytest.importorskip("jsonschema")
    scene, moving, _ = small()
    scene.panel(
        "v",
        frame="root",
        reference=ty.reference(moving, 0),
        layers=[ty.trajectories(moving)],
        camera={"kind": "3d", "stretch": [1, 1, 5], "auto_rotate": -90},
    )
    scene.show("p", panel="v")
    doc = scene.to_document()
    assert doc["panels"]["v"]["camera"] == {"kind": "3d", "stretch": [1.0, 1.0, 5.0], "auto_rotate": -90.0}
    jsonschema.Draft202012Validator(json.loads((CORPUS.parent / "scene.schema.json").read_text())).validate(doc)
    for stretch in ([1, 1], [1, 0, 1], [1, 1, float("inf")], "5"):
        with pytest.raises(ty.SceneError, match=r"panel: a camera stretch"):
            scene.panel("w", frame="root", reference=ty.reference(moving, 0), layers=[], camera={"kind": "3d", "stretch": stretch})
    with pytest.raises(ty.SceneError, match=r"panel: a camera auto_rotate"):
        scene.panel("w", frame="root", reference=ty.reference(moving, 0), layers=[], camera={"kind": "3d", "auto_rotate": float("nan")})
    with pytest.raises(ty.SceneError, match=r"panel: .* camera has unknown keys \['auto_rotate', 'stretch'\]"):
        scene.panel(
            "w", frame="root", reference=ty.reference(moving, 0), layers=[], camera={"kind": "2d", "stretch": [1, 1, 5], "auto_rotate": 90}
        )


def test_a_clock_takes_the_seconds_of_one_loop_in_either_mode():
    jsonschema = pytest.importorskip("jsonschema")
    scene, moving, _ = small()
    scene.clock("epoch", channels=["t"], frame_count=4, range=[0.0, 2.0], seconds=24)
    scene.panel("v", frame="root", reference=ty.reference(moving, 0), layers=[ty.trajectories(moving)])
    scene.show("p", panel="v")
    doc = scene.to_document()
    assert doc["clock"]["seconds"] == 24.0
    jsonschema.Draft202012Validator(json.loads((CORPUS.parent / "scene.schema.json").read_text())).validate(doc)
    scene.clock(channels=["t"], frame_count=4, revolutions=2, seconds=30)
    assert scene._clock is not None
    assert scene._clock["seconds"] == 30.0
    for seconds in (0, -1, float("inf")):
        with pytest.raises(ty.SceneError, match=r"clock: the clock seconds"):
            scene.clock(channels=["t"], frame_count=4, seconds=seconds)


def test_a_point_has_three_scalars_and_every_number_is_finite():
    scene = ty.Scene()
    root = scene.frame("root")
    with pytest.raises(ty.SceneError, match="origin"):
        scene.frame("shift", parent=root, origin=[1.0, 2.0])
    with pytest.raises(ty.SceneError, match="origin"):
        scene.body("b", frame=root, position=[1.0, 2.0, 3.0, 4.0])
    with pytest.raises(ty.SceneError, match="finite-number"):
        scene.trajectory_set("s", frame=root, attrs={"mu": float("nan")})
    with pytest.raises(ty.SceneError, match="finite-number"):
        scene.clock("epoch", channels=["t"], frame_count=4, range=[0.0, float("inf")])
    with pytest.raises(ty.SceneError, match="origin"):
        scene.frame("z", parent=root, scale=np.int64(0))
    with pytest.raises(ty.SceneError, match="origin"):
        scene.frame("z", parent=root, scale=ty.attr("k") * 0)
    ts = scene.trajectory_set("s", frame=root)
    with pytest.raises(ty.SceneError, match="not all finite"):
        ts.add([[0.0, 0.0], [float("nan"), 1.0]])
    with pytest.raises(ty.SceneError, match="identifier"):
        scene.frame("a\n")


def test_an_attribute_scale_that_is_zero_for_a_drawn_set_fails_at_the_write():
    scene = ty.Scene()
    root = scene.frame("root")
    scene.frame("z", parent=root, scale=ty.attr("k"))
    ts = scene.trajectory_set("s", frame=root, attrs={"k": 0.0}, dtype="float64")
    ts.add(np.zeros((2, 2)), channels={"t": [0.0, 1.0]})
    scene.clock(channels=["t"], frame_count=2)
    scene.panel("v", frame="z", reference=ty.reference(ts, 0), layers=[ty.trajectories(ts)])
    scene.show("p", panel="v")
    with pytest.raises(ty.SceneError, match="origin: panel 'v': the scale of frame 'z' is zero for trajectory set 's'"):
        scene.to_document()


def test_add_copies_its_arrays_and_the_document_shares_nothing():
    scene, moving, _ = small()
    buf = np.zeros((3, 2))
    t = np.array([0.0, 1.0, 2.0])
    for k in range(3):
        buf[:] = [[k, 0], [k, 1], [k, 2]]
        moving.add(buf, channels={"t": t}, parameters={"e": 0.1 * k})
    t[:] = 5
    scene.panel("v", frame="root", reference=ty.reference(moving, 0), layers=[ty.trajectories(moving)])
    scene.show("p", panel="v")
    data = ty.Container(scene.to_container())
    np.testing.assert_array_equal(data.array("moving/positions")[3:6, 0], [0.0, 0.0, 0.0])
    np.testing.assert_array_equal(data.array("moving/channels/t")[3:6], [0.0, 1.0, 2.0])
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
    scene.panel("v", frame="root", reference=ty.reference(moving, 0), layers=[])
    scene.show("p", panel="v")
    doc = scene.to_document()
    assert doc["trajectory_sets"]["moving"]["channels"]["t"] == {"array": "moving/channels/t", "interp": "hold", "unit": "TU"}
    assert doc["trajectory_sets"]["moving"]["parameters"]["e"] == {"array": "moving/parameters/e", "label": "eccentricity"}


def test_readouts_and_sliders_are_checked_against_the_reference_trajectory():
    scene, moving, still = small()
    e = scene.parameter("e", parameter="e")
    k = scene.parameter("k", parameter="@index")
    scene.panel("v", frame="root", reference=ty.reference(moving, e), layers=[])
    scene.show("p", panel="v")
    scene.readout("panel", "e = ", {"parameter": "e", "digits": 3}, " at ", ty.channel("t"), " of ", 2 * ty.attr("mu") + 1)
    scene.readout("caption", {"parameter": "nope"}, {"channel": "nope"}, {"attr": "nope"})
    scene.slider(e, label="e", domain=still)
    scene.slider(k, label="k", domain=moving)
    with pytest.raises(ty.SceneError) as info:
        scene.to_document()
    message = str(info.value)
    for expected in (
        "names parameter 'nope', which trajectory set 'moving' lacks",
        "names channel 'nope', which trajectory set 'moving' lacks",
        "names attribute 'nope', which trajectory set 'moving' lacks",
        "names attribute 'mu', which trajectory set 'moving' lacks",
        "control: the slider over 'e' has trajectory set 'still' in its domain, which lacks parameter 'e'",
    ):
        assert expected in message
    with pytest.raises(ty.SceneError, match="of input, parameter, attr, channel, clock, keyframes, timed_text, sub, and sup, not one"):
        scene.readout("panel", {"parameter": "e", "attr": "mu"})
    with pytest.raises(ty.SceneError, match="digits"):
        scene.readout("panel", {"parameter": "e", "digits": 0})


def test_declarations_fail_at_the_call():
    scene = ty.Scene()
    with pytest.raises(ty.SceneError, match=r"^input: parameter input 'e' names an empty parameter"):
        scene.parameter("e", parameter="")
    with pytest.raises(ty.SceneError, match=r"input"):
        scene.choice("c", ["a", "b"], default="z")
    with pytest.raises(ty.SceneError, match="array-dtype"):
        scene.trajectory_set("s", frame=scene.frame("root"), dtype="int32")


def test_parameters_are_stored_as_float64():
    scene, _, _ = small()
    assert ty.Container(scene.to_container()).array("moving/parameters/e").dtype == np.float64


def clocked(time, **kwargs):
    scene = ty.Scene()
    root = scene.frame("root")
    ts = scene.trajectory_set("s", frame=root, **kwargs)
    ts.add(np.column_stack([np.linspace(0.0, 1.0, len(time)), np.zeros(len(time))]), channels={"time": time, "rho": np.ones(len(time))})
    scene.clock(channels=["time"], frame_count=10)
    scene.panel("v", frame="root", reference=ty.reference(ts, 0), layers=[ty.trajectories(ts)])
    scene.show("p", panel="v")
    return scene


def test_a_clock_in_seconds_past_j2000_is_stored_as_float64():
    # 1e6 samples from 2026 to 2028 in seconds past J2000. float32 steps of 64 s at this magnitude would make the clock nonmonotone (rule
    # monotone-clock-channel)
    time = 8.2e8 + np.linspace(0.0, 2 * 365.25 * 86400.0, 1_000_000)
    scene = clocked(time)
    scene.to_document()
    data = ty.Container(scene.to_container())
    stored = data.array("s/channels/time")
    assert stored.dtype == np.float64
    assert np.array_equal(stored, time)
    assert data.array("s/positions").dtype == np.float32
    assert data.array("s/channels/rho").dtype == np.float32


def test_a_nondimensional_clock_stays_float32():
    scene = clocked(np.linspace(0.0, 2 * np.pi, 1000))
    scene.to_document()
    assert ty.Container(scene.to_container()).array("s/channels/time").dtype == np.float32


def test_channel_dtypes_win():
    scene = clocked(np.linspace(0.0, 2 * np.pi, 1000), channel_dtypes={"time": "float64", "rho": "float64"})
    data = ty.Container(scene.to_container())
    assert data.array("s/channels/time").dtype == np.float64
    assert data.array("s/channels/rho").dtype == np.float64
    assert data.array("s/positions").dtype == np.float32
    # rule `monotone-clock-channel` holds on the stored values, thus a forced float32 clock that rounds to repeated values is refused
    scene = clocked(8.2e8 + np.linspace(0.0, 1000.0, 1000), channel_dtypes={"time": "float32"})
    with pytest.raises(ty.SceneError, match="monotone-clock-channel: clock channel 'time' of trajectory set 's' is not strictly monotone"):
        scene.to_document()


def test_a_bad_channel_dtypes_mapping_is_refused():
    scene = ty.Scene()
    root = scene.frame("root")
    for bad in ({"time": "int32"}, {"time": np.float64}, ["time"], {"@index": "float64"}):
        with pytest.raises(ty.SceneError, match="array-dtype: channel"):
            scene.trajectory_set("s", frame=root, channel_dtypes=bad)  # pyright: ignore[reportArgumentType]
    ts = scene.trajectory_set("s", frame=root, channel_dtypes={"tim": "float64"})
    with pytest.raises(ty.SceneError, match=r"array-dtype: channel_dtypes of trajectory set 's' names channels \['tim'\]"):
        ts.add(np.zeros((2, 2)), channels={"time": [0.0, 1.0]})


def test_write_html_embeds_both_files_and_reports_sizes(tmp_path):
    scene = rotating_loop()
    sizes = scene.write_html(tmp_path / "page.html", runtime="console.log('tycho')")
    page = (tmp_path / "page.html").read_text(encoding="utf-8")
    assert 'data-tycho="scene"' in page
    assert 'data-tycho="data"' in page
    assert page.count('data-encoding="base64"') == 2
    assert "console.log('tycho')" in page
    # the stored size is below five rows of two float32 values, since the encoding makes it smaller
    assert sizes["loop/positions"] == ty.Container(scene.to_container()).stored_size("loop/positions") < 5 * 2 * 4
    assert sizes["page"] == len(page.encode("utf-8"))
    with pytest.raises(ValueError, match="closing script tag"):
        ty.build_html(scene.to_document(), scene.to_container(), runtime="</script>")


def test_build_embed_holds_the_element_its_blocks_and_attributes_but_not_the_runtime():
    scene = rotating_loop()
    document, data = scene.to_document(), scene.to_container()
    embed = ty.build_embed(document, data, theme="light", autoplay=True, kiosk=False, class_="wide", data_note='a "b"')
    assert embed.startswith('<tycho-viewer theme="light" autoplay class="wide" data-note="a &quot;b&quot;">\n')
    assert embed.endswith("</tycho-viewer>")
    for kind, payload in (("scene", json.dumps(document, separators=(",", ":"), ensure_ascii=False).encode()), ("data", data)):
        encoded = base64.b64encode(payload).decode()
        assert embed.count(f'<script type="application/octet-stream" data-tycho="{kind}" data-encoding="base64">{encoded}</script>') == 1
    assert embed.count("<script") == 2
    assert "<html" not in embed
    assert 'id="tycho' not in embed
    assert "customElements" not in embed


def test_build_html_and_build_embed_write_the_same_element():
    scene = rotating_loop()
    document, data = scene.to_document(), scene.to_container()
    assert ty.build_embed(document, data, kiosk=True) in ty.build_html(document, data, runtime="", kiosk=True)


@pytest.mark.parametrize("attributes", [{"theme": "sepia"}, {"scene": "a.tys"}, {"data": "a.tyd"}, {"onload x": "container"}])
def test_build_embed_refuses_attributes_that_would_not_work(attributes):
    scene = rotating_loop()
    with pytest.raises(ValueError, match=r"theme|attribute"):
        ty.build_embed(scene.to_document(), scene.to_container(), **attributes)


def test_build_embed_refuses_an_element_over_the_string_limit(monkeypatch):
    scene = rotating_loop()
    document, data = scene.to_document(), scene.to_container()
    monkeypatch.setattr("pytycho.html.MAX_STRING", 1)
    with pytest.raises(ValueError, match="the base64 of the scene"):
        ty.build_embed(document, data)


def test_build_html_refuses_a_page_over_the_string_limit(monkeypatch):
    import pytycho.html

    scene = rotating_loop()
    document, data = scene.to_document(), scene.to_container()
    monkeypatch.setattr(pytycho.html, "MAX_STRING", 100)
    with pytest.raises(ValueError, match=r"base64 of the scene is .* over the 100 that Chrome holds"):
        ty.build_html(document, data, runtime="")
    scene_chars = len(base64.b64encode(json.dumps(document, separators=(",", ":"), ensure_ascii=False).encode()))
    monkeypatch.setattr(pytycho.html, "MAX_STRING", scene_chars)
    ty.build_html(document, data, runtime="")
    with pytest.raises(ValueError, match=r"base64 of the data .* Thin the scene"):
        ty.build_html(document, data + bytes(scene_chars), runtime="")


def test_a_full_document_with_controls_readouts_theme_and_camera_validates_against_the_schema():
    jsonschema = pytest.importorskip("jsonschema")
    scene = ty.Scene(title="full", theme={"background": "#000000", "foreground": "#dddddd", "grid": "#333333"})
    root = scene.frame("root", label="root", axes=("x", "y", "z"), unit="DU")
    scene.frame("inertial", parent=root, rotation=ty.rotation("z", ty.channel("f")), label="inertial")
    b = scene.body("b", frame=root, position=[1.0, 0.0, 0.0], label="b", color="#e69f00")
    ts = scene.trajectory_set("s", frame=root, tags={"kind": "x"}, attrs={"mu": 0.1}, periodic=True, dtype="float64", label="s")
    f = np.linspace(0, 2 * np.pi, 10)
    for e in (0.1, 0.2):
        ts.add(np.column_stack([np.cos(f), np.sin(f)]), channels={"f": f, "t": f * 2}, parameters={"e": e})
    ts.describe("f", interp="linear", unit="rad")
    ts.describe("e", label="eccentricity")
    kind = scene.choice("kind", ["x", "y"], labels=["ex", "why"])
    frame = scene.choice("frame", ["root", "inertial"], scope="per_panel")
    e = scene.parameter("e", parameter="e", default=0.1)
    show = scene.toggle("show", default=True)
    scene.clock("fraction", channels=["f", "t", "@index"], labels=["anomaly", "time", "sample"], frame_count=16)
    scene.panel(
        "v",
        frame=frame,
        reference=ty.reference(ty.by_tags(kind=kind), e),
        camera={"kind": "2d", "plane": "xy", "aspect": "free"},
        layers=[
            ty.trajectories(
                ty.by_tags(kind=kind),
                color={"parameter": "e", "colormap": "viridis", "range": [0, 1]},
                opacity=0.4,
                highlight={"input": e, "width": 2.0, "opacity": 1.0},
            ),
            ty.trajectories(ty.by_tags(kind=kind), e, trail=0.3, head=True, color="#ffffff", width=2.0, visible=show),
            ty.body(b, trail=0.3, size=5.0),
            ty.axes(),
            ty.grid(visible=show),
        ],
    )
    scene.panel(
        "orbit",
        frame=root,
        reference=ty.reference(ts, 0),
        camera={"kind": "3d", "projection": "perspective", "up": "z"},
        layers=[ty.trajectories(ts)],
    )
    scene.show("p1", panel="v", inputs={frame: "root"})
    scene.show("p2", panel="orbit")
    scene.layout(ty.split("row", 0.5, "p1", "p2"))
    scene.tabs(kind, label="kind")
    scene.tabs(frame, label="frame")
    scene.slider(e, label="e", domain=ty.by_tags(kind=kind))
    scene.toggle_control(show, label="show")
    scene.playback()
    scene.readout(
        "caption",
        "e = ",
        {"parameter": "e", "digits": 3},
        " at ",
        ty.channel("f"),
        " mu ",
        1 - ty.attr("mu"),
        " ",
        kind,
        " frame ",
        {"clock": "frame_index"},
        " of ",
        {"clock": "frame_count"},
    )
    scene.readout("panel", {"channel": "t", "digits": 2})
    doc = scene.to_document()
    schema = json.loads((CORPUS.parent / "scene.schema.json").read_text())
    jsonschema.Draft202012Validator(schema).validate(doc)
    assert doc["controls"][0] == {"kind": "tabs", "input": "kind", "label": "kind"}
    assert doc["readouts"][0]["parts"][5] == {"attr": "mu", "factor": -1.0, "offset": 1.0}
    evaluate(doc, scene.to_container(), doc["initial"], 3)


def periodic_pair(**clock_kw):
    """Two trajectory sets told apart by a choice, one periodic and one not, and a clock with the given keywords."""
    scene = ty.Scene()
    root = scene.frame("root")
    for sid, periodic in (("closed", True), ("open", False)):
        ts = scene.trajectory_set(sid, frame=root, tags={"kind": sid}, periodic=periodic, dtype="float64")
        for k in range(5):
            ts.add(np.array([[k, 0.0], [k, 1.0], [k, 0.0]]), channels={"t": [0.0, 1.0, 2.0]}, parameters={"e": 0.1 * k})
    kind = scene.choice("kind", ["closed", "open"])
    scene.clock(channels=["t"], frame_count=4, **clock_kw)
    return scene, kind


def test_revolutions_are_for_a_fraction_clock_and_periodic_read_sets():
    scene = ty.Scene()
    with pytest.raises(ty.SceneError, match="revolutions: the clock is in epoch mode but has revolutions"):
        scene.clock("epoch", channels=["t"], frame_count=4, range=[0.0, 1.0], revolutions=1)
    with pytest.raises(ty.SceneError, match="revolutions: the clock has 0 revolutions"):
        scene.clock(channels=["t"], frame_count=4, revolutions=0)
    scene, kind = periodic_pair(revolutions=3)
    assert scene._clock is not None
    assert scene._clock["revolutions"] == 3
    # drawn whole and never read, a trajectory set that is not periodic is accepted, and has one revolution
    scene.panel(
        "v", frame="root", reference=ty.reference("closed", 0), layers=[ty.trajectories("open"), ty.trajectories("closed", trail=0.5)]
    )
    scene.show("p", panel="v")
    assert scene.to_document()["clock"]["revolutions"] == 3
    scene, kind = periodic_pair(revolutions=3)
    scene.panel(
        "v",
        frame="root",
        reference=ty.reference(ty.by_tags(kind=kind), 0),
        layers=[ty.trajectories(ty.by_tags(kind=kind), head={"size": 4})],
    )
    scene.show("p", panel="v")
    with pytest.raises(ty.SceneError) as info:
        scene.to_document()
    message = str(info.value)
    assert "revolutions: panel 'v' with {'kind': 'open'}: trajectory set 'open', the reference trajectory, is not periodic" in message
    assert "revolutions: panel 'v' with {'kind': 'open'}: trajectory set 'open', on which a reading is taken, is not periodic" in message
    assert "'closed'" not in message


def test_members_evenly_spaced_names_a_sparse_reference():
    assert ty.evenly_spaced(40) == {"evenly_spaced": 40}
    scene, _ = periodic_pair()
    assert ty.trajectories("closed", ty.evenly_spaced(2))["members"] == {"evenly_spaced": 2}
    assert ty.trajectories("closed", {"evenly_spaced": 3})["members"] == {"evenly_spaced": 3}
    with pytest.raises(ty.SceneError, match="members: a member count is 0"):
        ty.evenly_spaced(0)
    with pytest.raises(ty.SceneError, match="members"):
        ty.evenly_spaced(2.5)  # pyright: ignore[reportArgumentType]
    with pytest.raises(
        ty.SceneError, match="members: the reference trajectory's member is a count, but a reference trajectory resolves to one trajectory"
    ):
        ty.reference("closed", {"evenly_spaced": 2})
    scene.panel("v", frame="root", reference=ty.reference("closed", 0), layers=[ty.trajectories("closed", ty.evenly_spaced(2))])
    scene.show("p", panel="v")
    doc = scene.to_document()
    out = evaluate(doc, scene.to_container(), doc["initial"], 0)
    assert [m["index"] for m in out["panels"]["p"]["layers"][0]["members"]] == [0, 3, 4]


def test_a_colormap_keyed_on_a_choice_names_every_value_and_nothing_else():
    def write(cmap, choice_values=("closed", "open")):
        scene = ty.Scene()
        root = scene.frame("root")
        ts = scene.trajectory_set("s", frame=root, dtype="float64")
        ts.add(np.zeros((2, 2)), channels={"t": [0.0, 1.0]}, parameters={"e": 0.1})
        look = scene.choice("look", list(choice_values), scope="per_panel")
        scene.parameter("sel", parameter="@index")
        scene.clock(channels=["t"], frame_count=4)
        spec = {
            "parameter": "e",
            "colormap": {"input": look if cmap.pop("handle", False) else cmap.pop("input", "look"), "map": cmap["map"]},
        }
        scene.panel("v", frame=root, reference=ty.reference(ts, 0), layers=[ty.trajectories(ts, color=spec)])
        scene.show("p", panel="v")
        return scene.to_document()

    doc = write({"map": {"closed": "viridis", "open": "reds"}, "handle": True})
    assert doc["panels"]["v"]["layers"][0]["color"]["colormap"] == {"input": "look", "map": {"closed": "viridis", "open": "reds"}}
    with pytest.raises(ty.SceneError, match=r"panel: a colormap of panel 'v' keyed on 'look' does not name a colormap for \['open'\]"):
        write({"map": {"closed": "viridis"}})
    with pytest.raises(ty.SceneError, match=r"maps \['shut'\], which are not its values"):
        write({"map": {"closed": "viridis", "open": "reds", "shut": "blues"}})
    with pytest.raises(ty.SceneError, match="names 'sel', which is a parameter, not a choice"):
        write({"input": "sel", "map": {"closed": "viridis", "open": "reds"}})
    with pytest.raises(ty.SceneError, match="not one of viridis"):
        write({"map": {"closed": "jet", "open": "reds"}})
    scene, _ = periodic_pair()
    e = scene.parameter("e", parameter="e")
    with pytest.raises(ty.SceneError, match="parameter, not a choice"):
        ty.trajectories("closed", color={"parameter": "e", "colormap": {"input": e, "map": {"x": "viridis"}}})


def test_drawing_options_kernel_taper_head_axes_and_grid():
    scene, _ = periodic_pair()
    e = scene.parameter("e", parameter="e")
    k = scene.parameter("k", parameter="@index")
    layer = ty.trajectories("closed", e, trail=0.3, taper=(0, 0), head={"color": "#f0e442", "size": 9})
    assert layer["trail"] == {"fraction": 0.3, "taper": {"width": 0.0, "opacity": 0.0}}
    assert layer["head"] == {"color": "#f0e442", "size": 9.0}
    assert ty.trajectories("closed", trail={"fraction": 0.3, "taper": {"opacity": 0.5}})["trail"] == {
        "fraction": 0.3,
        "taper": {"opacity": 0.5},
    }
    assert ty.trajectories("closed", head={})["head"] == {}
    assert ty.axes(span="full") == {"kind": "axes", "span": "full"}
    assert ty.grid(labels=True) == {"kind": "grid", "labels": True}
    for call, match in (
        (lambda: ty.trajectories("closed", taper=(0, 0)), "panel: a taper is given without a trail"),
        (lambda: ty.trajectories("closed", trail=0.3, taper=(0, 1.5)), r"panel: the taper opacity of a trail is 1.5, not in \[0, 1\]"),
        (lambda: ty.trajectories("closed", trail={"fraction": 0.3, "taper": (0, 0)}, taper=(0, 0)), "given twice"),
        (lambda: ty.trajectories("closed", head={"size": 0}), "head: a head size is 0.0, not positive"),
        (lambda: ty.trajectories("closed", head={"colour": "#ffffff"}), "head: a head has unknown keys"),
        (lambda: ty.trajectories("closed", head="yes"), "head"),  # pyright: ignore[reportArgumentType]
        (
            lambda: ty.trajectories("closed", highlight={"input": e, "kernel": {"width": 0.0, "opacity": 0.5}}),
            r"kernel's width is 0.0, not in \(0, 1\]",
        ),
        (lambda: ty.trajectories("closed", highlight={"input": e, "kernel": {"width": 0.1, "opacity": 1.5}}), "kernel's opacity"),
        (lambda: ty.trajectories("closed", highlight={"input": e, "kernel": {"width": 0.1}}), "a dict of width and opacity"),
        (lambda: ty.axes(span="half"), "an axes layer's span"),
        (lambda: ty.grid(labels="yes"), "labels is 'yes', not a boolean"),  # pyright: ignore[reportArgumentType]
    ):
        with pytest.raises(ty.SceneError, match=match):
            call()
    scene.panel(
        "v",
        frame="root",
        reference=ty.reference("closed", 0),
        layers=[ty.trajectories("closed", highlight={"input": k, "kernel": {"width": 0.1, "opacity": 0.5}})],
    )
    scene.show("p", panel="v")
    # a kernel over @index brightens the members whose numbers are close to the number of the highlighted member
    assert scene.to_document()["panels"]["v"]["layers"][0]["highlight"] == {"input": "k", "kernel": {"width": 0.1, "opacity": 0.5}}


def arrows_scene() -> ty.Scene:
    """The scene of the corpus directory ``arrows``, built through the API."""
    scene = ty.Scene()
    rot = scene.frame("rot")
    scene.frame("inertial", parent=rot, rotation=ty.rotation("z", ty.channel("th")))
    vel = scene.trajectory_set("vel", frame=rot, tags={"g": "vel"}, attrs={"s": 0.5}, dtype="float64")
    vel.add(
        [[1.0, 0.0], [0.0, 1.0], [-1.0, 0.0]],
        channels={"t": [0.0, 1.0, 2.0], "th": [0.0, 0.5, 1.5], "vx": [0.0, -1.0, 0.0], "vy": [1.0, 0.0, -1.0]},
    )
    sticks = scene.trajectory_set("sticks", frame=rot, tags={"g": "sticks"}, dtype="float64")
    sticks.add([[2.0, 0.0, 0.0]] * 2, channels={"t": [0.5, 1.0], "th": [0.2, 0.4], "vx": [0.0] * 2, "vy": [1.0] * 2, "vz": [0.5] * 2})
    sticks.add([[0.0, 2.0, 0.0]] * 2, channels={"t": [1.5, 2.0], "th": [0.6, 1.0], "vx": [1.0] * 2, "vy": [0.0] * 2, "vz": [0.5] * 2})
    scene.clock("epoch", channels=["t"], frame_count=8, range=[0.0, 2.0])
    layers = [
        ty.arrow(vel, ("vx", "vy"), scale=ty.attr("s")),
        ty.arrow(sticks, ("vx", "vy", "vz"), scale=0.25, before="hidden", after="hidden", color="#ffffff", width=1.8, head=12),
        ty.arrow(ty.by_tags(g="none"), ("vx", "vy")),
    ]
    for frame in ("rot", "inertial"):
        scene.panel(frame, frame=frame, reference=ty.reference(vel, 0), layers=layers)
        scene.show(frame)
    scene.layout(ty.split("row", 0.5, "rot", "inertial"))
    return scene


def test_arrows_through_the_api_give_the_corpus_answers():
    scene = arrows_scene()
    document, data = scene.to_document(), scene.to_container()
    assert document["requires"] == ["layers.arrows"]
    assert document["panels"]["rot"]["layers"][1] == json.loads((CORPUS / "arrows" / "scene.tys").read_text())["panels"]["rot"]["layers"][1]
    jsonschema = pytest.importorskip("jsonschema")
    jsonschema.Draft202012Validator(json.loads((CORPUS.parent / "scene.schema.json").read_text())).validate(document)
    for case in json.loads((CORPUS / "arrows" / "cases.json").read_text()):
        compare(evaluate(document, data, case["state"], case["frame_index"]), case["expected"], case["tolerance"])


def inset_boxes_scene() -> ty.Scene:
    """The scene of the corpus directory ``inset-boxes`` without its panel ``lost``, built through the API."""
    scene = ty.Scene()
    rot = scene.frame("rot")
    scene.frame("zoom", parent=rot, origin=[ty.channel("mx"), ty.channel("my"), 0.0], scale=ty.channel("k"))
    scene.frame("inertial", parent=rot, rotation=ty.rotation("z", ty.channel("th")))
    drv = scene.trajectory_set("drv", frame=rot, tags={"g": "drv"}, dtype="float64")
    drv.add(
        [[1.0, 0.0], [0.0, 1.0], [-1.0, 0.5]],
        channels={"t": [0.0, 1.0, 2.0], "mx": [0.5, 0.0, -0.5], "my": [0.0, 0.25, 0.5], "k": [2.0, 4.0, 10.0], "th": [0.0, 0.5, 1.5]},
    )
    scene.clock("epoch", channels=["t"], frame_count=8, range=[0.0, 2.0])
    box = ty.inset_box("closeup", color="#ffffff", opacity=0.5, width=1.5, dash=(4, 3), min_size=12)
    for frame in ("rot", "inertial"):
        scene.panel(frame, frame=frame, reference=ty.reference(drv, 0), layers=[ty.trajectories(drv), box])
    scene.panel(
        "closeup", frame="zoom", camera={"kind": "2d", "plane": "xy"}, reference=ty.reference(drv, 0), layers=[ty.trajectories(drv)]
    )
    for pid in ("rot", "inertial", "closeup"):
        scene.show(pid)
    scene.layout(ty.split("row", 0.5, "rot", ty.split("row", 0.5, "inertial", "closeup")))
    return scene


def test_inset_boxes_through_the_api_give_the_corpus_answers():
    scene = inset_boxes_scene()
    document, data = scene.to_document(), scene.to_container()
    corpus = json.loads((CORPUS / "inset-boxes" / "scene.tys").read_text())
    assert document["requires"] == ["layers.inset_box", "frames.origin_channel"]
    assert document["frames"]["zoom"] == corpus["frames"]["zoom"]
    assert document["panels"]["rot"]["layers"][1] == corpus["panels"]["rot"]["layers"][1]
    jsonschema = pytest.importorskip("jsonschema")
    jsonschema.Draft202012Validator(json.loads((CORPUS.parent / "scene.schema.json").read_text())).validate(document)
    compared = 0
    for case in json.loads((CORPUS / "inset-boxes" / "cases.json").read_text()):
        if any(panel["panel"] == "lost" for panel in case["state"]["panels"].values()):
            continue
        compare(evaluate(document, data, case["state"], case["frame_index"]), case["expected"], case["tolerance"])
        compared += 1
    assert compared == 10


def test_a_trajectories_layer_left_out_of_the_fit():
    assert ty.trajectories("s", fit=False)["fit"] is False
    assert "fit" not in ty.trajectories("s")
    with pytest.raises(ty.SceneError, match=r"panel: a trajectories layer's fit is 'no', not a boolean"):
        ty.trajectories("s", fit="no")  # pyright: ignore[reportArgumentType]
    scene = inset_boxes_scene()
    scene._panels["closeup"]["layers"].append(ty.trajectories("drv", fit=False))
    jsonschema = pytest.importorskip("jsonschema")
    jsonschema.Draft202012Validator(json.loads((CORPUS.parent / "scene.schema.json").read_text())).validate(scene.to_document())


def test_an_inset_box_layer_fails_at_the_call_and_at_the_write():
    calls: tuple[tuple[dict[str, Any], str], ...] = (
        ({"dash": (4,)}, "inset-box: an inset box layer's dash"),
        ({"dash": (4, 0)}, "inset-box: an inset box layer's dash"),
        ({"min_size": -1}, "inset-box: an inset box layer's min_size"),
        ({"color": "white"}, "inset-box: an inset box layer's color"),
        ({"width": 0}, "panel: an inset box layer's width"),
        ({"opacity": 2}, "opacity"),
    )
    for kwargs, message in calls:
        with pytest.raises(ty.SceneError, match=message):
            ty.inset_box("closeup", **kwargs)
    scene = ty.Scene()
    rot = scene.frame("rot")
    with pytest.raises(ty.SceneError, match="origin: the position of body"):
        scene.body("b", frame=rot, position=[ty.channel("x"), 0.0, 0.0])
    with pytest.raises(ty.SceneError, match=r"context-number: the origin of frame"):
        scene.frame("zoom", parent=rot, origin=[ty.channel("@index"), 0.0, 0.0])
    for patch, message in (
        (
            {"layers": [ty.inset_box("nowhere")]},
            "inset-box: an inset box layer of panel 'rot' names 'nowhere', which is not a declared panel",
        ),
        ({"layers": [ty.inset_box("rot")]}, "inset-box: an inset box layer of panel 'rot' names its own panel"),
    ):
        scene = inset_boxes_scene()
        scene._panels["rot"] = {**scene._panels["rot"], **patch}
        with pytest.raises(ty.SceneError, match=message):
            scene.to_document()
    # the reference trajectory of the panel rot lacks the channel my of the origin of the target frame zoom (rule `transform-channels`)
    scene = inset_boxes_scene()
    other = scene.trajectory_set("other", frame="rot", tags={"g": "other"}, dtype="float64")
    other.add([[1.0, 0.0], [0.0, 1.0]], channels={"t": [0.0, 2.0], "mx": [0.0, 0.0], "k": [1.0, 1.0]})
    scene._panels["rot"] = {**scene._panels["rot"], "reference": {"sets": {"set": "other"}, "member": {"index": 0}}}
    with pytest.raises(
        ty.SceneError,
        match=r"transform-channels: panel 'rot': trajectory set 'other' lacks \['my'\] for the inset box of panel 'closeup' in frame 'rot'",
    ):
        scene.to_document()


def test_an_arrow_layer_fails_at_the_call_and_at_the_write():
    for kwargs, message in (
        ({"vector": ("vx",)}, "arrow: an arrow layer's vector"),
        ({"vector": ("vx", "@index")}, "arrow: @index is not allowed"),
        ({"scale": ty.channel("t")}, "arrow: the scale of an arrow layer takes a number or an attribute"),
        ({"head": 0.0}, "arrow: an arrowhead size"),
        ({"color": "white"}, "arrow: an arrow layer's color"),
        ({"before": "fade"}, "before-after: an arrow layer's before"),
    ):
        with pytest.raises(ty.SceneError, match=message):
            ty.arrow("vel", **{"vector": ("vx", "vy"), **kwargs})
    # the set of the arrows lacks vz, the clock channel t, and the attribute of the scale (rules `arrow`, `clock-channel-carried`, and
    # `transform-channels`)
    scene, moving, still = small()
    scene.panel("v", frame="root", reference=ty.reference(moving, 0), layers=[ty.arrow(still, ("vx", "vz"), scale=ty.attr("k"))])
    scene.show("p", panel="v")
    with pytest.raises(ty.SceneError) as e:
        scene.to_document()
    for expected in (
        "arrow: panel 'v': trajectory set 'still' lacks channels ['vx', 'vz']",
        "clock-channel-carried: panel 'v': trajectory set 'still'",
        "transform-channels: panel 'v'",
    ):
        assert expected in str(e.value)
