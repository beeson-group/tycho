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


def breathing(driver_channels=("t", "rho")):
    """A driver in a scaled frame, and a grid of the unscaled frame without any channel."""
    scene = ty.Scene()
    pulsating = scene.frame("pulsating")
    rot = scene.frame("rot", parent=pulsating, scale=ty.channel("rho"))
    orbit = scene.track_set("orbit", frame=rot, dtype="float64")
    channels = {"t": [0.0, 1.0, 2.0], "rho": [1.0, 2.0, 3.0]}
    orbit.add(np.zeros((3, 2)), channels={k: channels[k] for k in driver_channels})
    grid = scene.track_set("grid", frame=pulsating, dtype="float64")
    grid.add(np.array([[1.0, 0.0], [1.0, 1.0]]))
    scene.clock(channels=["t"], steps=4)
    return scene, orbit, grid


def test_a_layer_in_the_driver_context_reads_the_frame_edges_on_the_driver():
    scene, orbit, grid = breathing()
    scene.view("v", frame="rot", driver=ty.driver(orbit, 0), layers=[ty.track(grid, context="driver")])
    scene.panel("p", "v")
    doc, data = scene.to_document(), scene.to_container()
    assert (doc["version"], doc["requires"]) == ("0.3", ["layers.driver_context"])
    assert doc["views"]["v"]["layers"][0]["context"] == "driver"
    # at frame 1 of 4 the driver reads t = 0.5, halfway between rho = 1 and rho = 2 (rules L4 and L6)
    line = evaluate(doc, data, doc["initial"], 1)["panels"]["p"]["layers"][0]["members"][0]["line"]
    assert np.allclose(line, [[1.5, 0.0, 0.0], [1.5, 1.5, 0.0]])
    scene, orbit, grid = breathing()
    scene.view("v", frame="rot", driver=ty.driver(orbit, 0), layers=[ty.track(grid)])
    scene.panel("p", "v")
    with pytest.raises(ty.SceneError, match=r"F5: view 'v': .*'grid'"):
        scene.to_document()
    scene, orbit, grid = breathing(driver_channels=("t",))
    scene.view("v", frame="rot", driver=ty.driver(orbit, 0), layers=[ty.track(grid, context="driver")])
    scene.panel("p", "v")
    with pytest.raises(ty.SceneError, match=r"F5: .*in the driver's context"):
        scene.to_document()


def test_a_layer_in_the_driver_context_is_checked():
    scene, orbit, grid = breathing()
    scene.view("v", frame="pulsating", driver=ty.driver(orbit, 0), layers=[ty.track(orbit)])
    scene.panel("p", "v")
    assert "requires" not in scene.to_document()
    with pytest.raises(ty.SceneError, match="L6: a track layer's context"):
        scene.view("w", frame="pulsating", driver=ty.driver(orbit, 0), layers=[ty.track(grid, context="sample")])
    # a head reads the clock channel, which the grid lacks also in the driver's context (rule C5)
    scene, orbit, grid = breathing()
    scene.view("v", frame="rot", driver=ty.driver(orbit, 0), layers=[ty.track(grid, context="driver", head=True)])
    scene.panel("p", "v")
    with pytest.raises(ty.SceneError, match="C5: view 'v': track set 'grid'"):
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


def test_a_plane_camera_takes_an_aspect_and_an_orbit_camera_does_not():
    scene, moving, _ = small()
    scene.view("v", frame="root", driver=ty.driver(moving, 0), layers=[ty.track(moving)], camera={"kind": "plane", "aspect": "free"})
    scene.panel("p", "v")
    doc = scene.to_document()
    assert doc["views"]["v"]["camera"] == {"kind": "plane", "aspect": "free"}
    assert doc["version"] == "0.3"
    with pytest.raises(ty.SceneError, match=r"2\.7: a camera aspect is 'stretch', not one of equal, free"):
        scene.view("w", frame="root", driver=ty.driver(moving, 0), layers=[], camera={"kind": "plane", "aspect": "stretch"})
    with pytest.raises(ty.SceneError, match=r"2\.7: .* camera has unknown keys \['aspect'\]"):
        scene.view("w", frame="root", driver=ty.driver(moving, 0), layers=[], camera={"kind": "orbit", "aspect": "free"})


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


def test_parameters_are_stored_as_float64():
    scene, _, _ = small()
    assert ty.Container(scene.to_container()).view("moving/parameters/e").dtype == np.float64


def clocked(time, **kwargs):
    scene = ty.Scene()
    root = scene.frame("root")
    ts = scene.track_set("s", frame=root, **kwargs)
    ts.add(np.column_stack([np.linspace(0.0, 1.0, len(time)), np.zeros(len(time))]), channels={"time": time, "rho": np.ones(len(time))})
    scene.clock(channels=["time"], steps=10)
    scene.view("v", frame="root", driver=ty.driver(ts, 0), layers=[ty.track(ts)])
    scene.panel("p", "v")
    return scene


def test_a_clock_in_seconds_past_j2000_is_stored_as_float64():
    # 1e6 samples from 2026 to 2028 in seconds past J2000. float32 steps of 64 s at this magnitude would make the clock nonmonotone (T3)
    time = 8.2e8 + np.linspace(0.0, 2 * 365.25 * 86400.0, 1_000_000)
    scene = clocked(time)
    scene.to_document()
    data = ty.Container(scene.to_container())
    stored = data.view("s/channels/time")
    assert stored.dtype == np.float64
    assert np.array_equal(stored, time)
    assert data.view("s/positions").dtype == np.float32
    assert data.view("s/channels/rho").dtype == np.float32


def test_a_nondimensional_clock_stays_float32():
    scene = clocked(np.linspace(0.0, 2 * np.pi, 1000))
    scene.to_document()
    assert ty.Container(scene.to_container()).view("s/channels/time").dtype == np.float32


def test_channel_dtypes_win():
    scene = clocked(np.linspace(0.0, 2 * np.pi, 1000), channel_dtypes={"time": "float64", "rho": "float64"})
    data = ty.Container(scene.to_container())
    assert data.view("s/channels/time").dtype == np.float64
    assert data.view("s/channels/rho").dtype == np.float64
    assert data.view("s/positions").dtype == np.float32
    # rule T3 holds on the stored values, thus a forced float32 clock that rounds to repeated values is refused
    scene = clocked(8.2e8 + np.linspace(0.0, 1000.0, 1000), channel_dtypes={"time": "float32"})
    with pytest.raises(ty.SceneError, match="T3: clock channel 'time' of track set 's' is not strictly monotone"):
        scene.to_document()


def test_a_bad_channel_dtypes_mapping_is_refused():
    scene = ty.Scene()
    root = scene.frame("root")
    for bad in ({"time": "int32"}, {"time": np.float64}, ["time"], {"@index": "float64"}):
        with pytest.raises(ty.SceneError, match="D1: channel"):
            scene.track_set("s", frame=root, channel_dtypes=bad)  # pyright: ignore[reportArgumentType]
    ts = scene.track_set("s", frame=root, channel_dtypes={"tim": "float64"})
    with pytest.raises(ty.SceneError, match=r"D1: channel_dtypes of track set 's' names channels \['tim'\]"):
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


@pytest.mark.parametrize("attributes", [{"theme": "sepia"}, {"scene": "a.tys"}, {"data": "a.tyd"}, {"onload x": "1"}])
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
    ts = scene.track_set("s", frame=root, tags={"kind": "x"}, attrs={"mu": 0.1}, periodic=True, dtype="float64", label="s")
    f = np.linspace(0, 2 * np.pi, 10)
    for e in (0.1, 0.2):
        ts.add(np.column_stack([np.cos(f), np.sin(f)]), channels={"f": f, "t": f * 2}, parameters={"e": e})
    ts.describe("f", interp="linear", unit="rad")
    ts.describe("e", label="eccentricity")
    kind = scene.choice("kind", ["x", "y"], labels=["ex", "why"])
    frame = scene.choice("frame", ["root", "inertial"], scope="panel")
    e = scene.selector("e", parameter="e", default=0.1)
    show = scene.toggle("show", default=True)
    scene.clock("fraction", channels=["f", "t", "@index"], labels=["anomaly", "time", "sample"], steps=16)
    scene.view(
        "v",
        frame=frame,
        driver=ty.driver(ty.sets(kind=kind), e),
        camera={"kind": "plane", "plane": "xy", "aspect": "free"},
        layers=[
            ty.track(
                ty.sets(kind=kind),
                color={"parameter": "e", "colormap": "viridis", "range": [0, 1]},
                opacity=0.4,
                highlight={"var": e, "width": 2.0, "opacity": 1.0},
            ),
            ty.track(ty.sets(kind=kind), e, trail=0.3, head=True, color="#ffffff", width=2.0, visible=show),
            ty.body(b, trail=0.3, size=5.0),
            ty.axes(),
            ty.grid(visible=show),
        ],
    )
    scene.view(
        "orbit",
        frame=root,
        driver=ty.driver(ts, 0),
        camera={"kind": "orbit", "projection": "perspective", "up": "z"},
        layers=[ty.track(ts)],
    )
    scene.panel("p1", "v", {frame: "root"})
    scene.panel("p2", "orbit")
    scene.layout(ty.split("row", 0.5, "p1", "p2"))
    scene.tabs(kind, label="kind")
    scene.tabs(frame, label="frame")
    scene.slider(e, label="e", domain=ty.sets(kind=kind))
    scene.toggle_control(show, label="show")
    scene.transport()
    scene.readout(
        "caption",
        "e = ",
        {"member": "e", "digits": 3},
        " at ",
        ty.channel("f"),
        " mu ",
        1 - ty.attr("mu"),
        " ",
        kind,
        " frame ",
        {"clock": "index"},
        " of ",
        {"clock": "steps"},
    )
    scene.readout("panel", {"channel": "t", "digits": 2})
    doc = scene.to_document()
    schema = json.loads((CORPUS.parent / "scene.schema.json").read_text())
    jsonschema.Draft202012Validator(schema).validate(doc)
    assert doc["controls"][0] == {"kind": "tabs", "variable": "kind", "label": "kind"}
    assert doc["readouts"][0]["parts"][5] == {"attr": "mu", "factor": -1.0, "offset": 1.0}
    evaluate(doc, scene.to_container(), doc["initial"], 3)


def periodic_pair(**clock_kw):
    """Two track sets told apart by a choice, one periodic and one not, and a clock with the given keywords."""
    scene = ty.Scene()
    root = scene.frame("root")
    for sid, periodic in (("closed", True), ("open", False)):
        ts = scene.track_set(sid, frame=root, tags={"kind": sid}, periodic=periodic, dtype="float64")
        for k in range(5):
            ts.add(np.array([[k, 0.0], [k, 1.0], [k, 0.0]]), channels={"t": [0.0, 1.0, 2.0]}, parameters={"e": 0.1 * k})
    kind = scene.choice("kind", ["closed", "open"])
    scene.clock(channels=["t"], steps=4, **clock_kw)
    return scene, kind


def test_c6_laps_are_for_a_fraction_clock_and_periodic_read_sets():
    scene = ty.Scene()
    with pytest.raises(ty.SceneError, match="C6: the clock is in value mode but has laps"):
        scene.clock("value", channels=["t"], steps=4, range=[0.0, 1.0], laps=1)
    with pytest.raises(ty.SceneError, match="C6: the clock has 0 laps"):
        scene.clock(channels=["t"], steps=4, laps=0)
    scene, kind = periodic_pair(laps=3)
    assert scene._clock is not None
    assert scene._clock["laps"] == 3
    # drawn whole and never read, a track set that is not periodic is accepted, and has one lap
    scene.view("v", frame="root", driver=ty.driver("closed", 0), layers=[ty.track("open"), ty.track("closed", trail=0.5)])
    scene.panel("p", "v")
    assert scene.to_document()["clock"]["laps"] == 3
    scene, kind = periodic_pair(laps=3)
    scene.view("v", frame="root", driver=ty.driver(ty.sets(kind=kind), 0), layers=[ty.track(ty.sets(kind=kind), head={"size": 4})])
    scene.panel("p", "v")
    with pytest.raises(ty.SceneError) as info:
        scene.to_document()
    message = str(info.value)
    assert "C6: view 'v' with {'kind': 'open'}: track set 'open', the driver, is not periodic" in message
    assert "C6: view 'v' with {'kind': 'open'}: track set 'open', on which a reading is taken, is not periodic" in message
    assert "'closed'" not in message


def test_v3_every_names_a_sparse_context():
    assert ty.every(40) == {"count": 40}
    scene, _ = periodic_pair()
    assert ty.track("closed", ty.every(2))["members"] == {"count": 2}
    assert ty.track("closed", {"count": 3})["members"] == {"count": 3}
    with pytest.raises(ty.SceneError, match="V3: a member count is 0"):
        ty.every(0)
    with pytest.raises(ty.SceneError, match="V3"):
        ty.every(2.5)  # pyright: ignore[reportArgumentType]
    with pytest.raises(ty.SceneError, match="V3: the driver's member is a count, but a driver resolves to one track"):
        ty.driver("closed", {"count": 2})
    scene.view("v", frame="root", driver=ty.driver("closed", 0), layers=[ty.track("closed", ty.every(2))])
    scene.panel("p", "v")
    doc = scene.to_document()
    out = evaluate(doc, scene.to_container(), doc["initial"], 0)
    assert [m["index"] for m in out["panels"]["p"]["layers"][0]["members"]] == [0, 3, 4]


def test_a_colormap_keyed_on_a_choice_names_every_value_and_nothing_else():
    def write(cmap, choice_values=("closed", "open")):
        scene = ty.Scene()
        root = scene.frame("root")
        ts = scene.track_set("s", frame=root, dtype="float64")
        ts.add(np.zeros((2, 2)), channels={"t": [0.0, 1.0]}, parameters={"e": 0.1})
        look = scene.choice("look", list(choice_values), scope="panel")
        scene.selector("sel", by="index")
        scene.clock(channels=["t"], steps=4)
        spec = {"parameter": "e", "colormap": {"var": look if cmap.pop("handle", False) else cmap.pop("var", "look"), "map": cmap["map"]}}
        scene.view("v", frame=root, driver=ty.driver(ts, 0), layers=[ty.track(ts, color=spec)])
        scene.panel("p", "v")
        return scene.to_document()

    doc = write({"map": {"closed": "viridis", "open": "reds"}, "handle": True})
    assert doc["views"]["v"]["layers"][0]["color"]["colormap"] == {"var": "look", "map": {"closed": "viridis", "open": "reds"}}
    with pytest.raises(ty.SceneError, match=r"2.7: a colormap of view 'v' keyed on 'look' does not name a colormap for \['open'\]"):
        write({"map": {"closed": "viridis"}})
    with pytest.raises(ty.SceneError, match=r"maps \['shut'\], which are not its values"):
        write({"map": {"closed": "viridis", "open": "reds", "shut": "blues"}})
    with pytest.raises(ty.SceneError, match="names 'sel', which is a selector, not a choice"):
        write({"var": "sel", "map": {"closed": "viridis", "open": "reds"}})
    with pytest.raises(ty.SceneError, match="not one of viridis"):
        write({"map": {"closed": "jet", "open": "reds"}})
    scene, _ = periodic_pair()
    e = scene.selector("e", parameter="e")
    with pytest.raises(ty.SceneError, match="selector, not a choice"):
        ty.track("closed", color={"parameter": "e", "colormap": {"var": e, "map": {"x": "viridis"}}})


def test_drawing_options_kernel_taper_head_axes_and_grid():
    scene, _ = periodic_pair()
    e = scene.selector("e", parameter="e")
    k = scene.selector("k", by="index")
    layer = ty.track("closed", e, trail=0.3, taper=(0, 0), head={"color": "#f0e442", "size": 9})
    assert layer["trail"] == {"fraction": 0.3, "taper": {"width": 0.0, "opacity": 0.0}}
    assert layer["head"] == {"color": "#f0e442", "size": 9.0}
    assert ty.track("closed", trail={"fraction": 0.3, "taper": {"opacity": 0.5}})["trail"] == {"fraction": 0.3, "taper": {"opacity": 0.5}}
    assert ty.track("closed", head={})["head"] == {}
    assert ty.axes(span="full") == {"kind": "axes", "span": "full"}
    assert ty.grid(labels=True) == {"kind": "grid", "labels": True}
    for call, match in (
        (lambda: ty.track("closed", taper=(0, 0)), "2.7: a taper is given without a trail"),
        (lambda: ty.track("closed", trail=0.3, taper=(0, 1.5)), r"2.7: the taper opacity of a trail is 1.5, not in \[0, 1\]"),
        (lambda: ty.track("closed", trail={"fraction": 0.3, "taper": (0, 0)}, taper=(0, 0)), "given twice"),
        (lambda: ty.track("closed", head={"size": 0}), "L3: a head size is 0.0, not positive"),
        (lambda: ty.track("closed", head={"colour": "#ffffff"}), "L3: a head has unknown keys"),
        (lambda: ty.track("closed", head="yes"), "L3"),  # pyright: ignore[reportArgumentType]
        (
            lambda: ty.track("closed", highlight={"var": e, "kernel": {"width": 0.0, "opacity": 0.5}}),
            r"kernel's width is 0.0, not in \(0, 1\]",
        ),
        (lambda: ty.track("closed", highlight={"var": e, "kernel": {"width": 0.1, "opacity": 1.5}}), "kernel's opacity"),
        (lambda: ty.track("closed", highlight={"var": e, "kernel": {"width": 0.1}}), "a dict of width and opacity"),
        (lambda: ty.axes(span="half"), "an axes layer's span"),
        (lambda: ty.grid(labels="yes"), "labels is 'yes', not a boolean"),  # pyright: ignore[reportArgumentType]
    ):
        with pytest.raises(ty.SceneError, match=match):
            call()
    scene.view(
        "v",
        frame="root",
        driver=ty.driver("closed", 0),
        layers=[ty.track("closed", highlight={"var": k, "kernel": {"width": 0.1, "opacity": 0.5}})],
    )
    scene.panel("p", "v")
    with pytest.raises(ty.SceneError, match=r"2\.7: a highlight kernel of view 'v' needs a selector by nearest, and 'k' is by index"):
        scene.to_document()
