"""The timeline of section 2.11: tweens, clock and layer keys, cameras with keys, labels, points, and the keys for drawing only."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest

import pytycho as ty
from pytycho._evaluate import EvaluationError, ease, evaluate, tween_keys, tween_value
from pytycho.container import Container

CORPUS = Path(__file__).resolve().parents[1] / "spec" / "conformance"
PNG = b"\x89PNG\r\n\x1a\n" + bytes(range(32))


def base(*, layers: Any = None, camera: Any = None, clock: dict[str, Any] | None = None) -> tuple[ty.Scene, ty.TrackSet]:
    scene = ty.Scene(title="timeline", theme={"background": "#ffffff", "foreground": "#000000", "font": "serif", "gutter": "#ffffff"})
    root = scene.frame("root", axes=("x", "y", "z"))
    a = scene.track_set("a", frame=root, dtype="float64")
    t = np.arange(5.0)
    for y in (0.0, 1.0):
        a.add(np.column_stack([t, np.full(5, y)]), channels={"t": t, "tau": 10.0 - t, "S": np.array([1.0, -1.0, 1.0, -1.0, 1.0])})
    scene.clock(**(clock or {"mode": "value", "channels": ["t"], "steps": 10, "seconds": 5.0, "keys": [(0, 0), (5, 4, "smooth")]}))
    scene.view("v", frame=root, driver=ty.driver(a, 0), layers=layers if layers is not None else [ty.track(a)], camera=camera)
    scene.panel("p", "v")
    return scene, a


# tweens (rules K1 and K2)


def test_tween_and_fade_write_keys():
    assert ty.tween((0, 1), (2, 3, "smooth")) == {"keys": [[0.0, 1.0], [2.0, 3.0, "smooth"]]}
    assert ty.fade(1.0, 3.0, duration=0.5) == {"keys": [[1.0, 0.0], [1.5, 1.0, "smooth"], [3.0, 1.0], [3.5, 0.0, "smooth"]]}
    with pytest.raises(ty.SceneError, match=r"^K1:"):
        ty.tween((1, 0), (0, 1))
    with pytest.raises(ty.SceneError, match=r"^K2:"):
        ty.tween((0, 0), (1, 1, "bounce"))
    with pytest.raises(ty.SceneError, match=r"^K1:"):
        ty.tween()


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("linear", 0.25),
        ("smooth", 0.25 * 0.25 * (3 - 0.5)),
        ("in", 0.25**3),
        ("out", 1 - 0.75**3),
        ("in-out", 4 * 0.25**3),
        ("hold", 0.0),
    ],
)
def test_eases_at_a_quarter(name, expected):
    assert ease(name, 0.25) == pytest.approx(expected, abs=1e-15)


def test_in_out_above_one_half_and_tween_values():
    assert ease("in-out", 0.75) == pytest.approx(1 - 0.5**3 / 2, abs=1e-15)
    keys = tween_keys([[1, 0], [3, 2, "smooth"], [5, 2], [5, 3], [7, 4]], "a tween")
    assert [tween_value(keys, s) for s in (0, 1, 2, 4.9, 5, 6, 8)] == [0, 0, 1, 2, 3, 3.5, 4]
    with pytest.raises(EvaluationError, match=r"^K1:"):
        tween_keys([[1, 0], [0, 1]], "a tween")
    with pytest.raises(EvaluationError, match=r"^K2:"):
        tween_keys([[0, 0], [1, 1, "jump"]], "a tween")


# the clock (rules K3 and K4)


def test_clock_keys_and_requires():
    scene, _ = base()
    doc = scene.to_document()
    assert doc["version"] == "0.4"
    assert doc["requires"] == ["clock.keys"]
    assert doc["clock"]["keys"] == [[0.0, 0.0], [5.0, 4.0, "smooth"]]
    with pytest.raises(ty.SceneError, match=r"^K3:"):
        ty.Scene().clock("value", channels=["t"], steps=4, range=(0, 1), keys=[(0, 0)])
    with pytest.raises(ty.SceneError, match=r"^K3:"):
        ty.Scene().clock("fraction", channels=["t"], steps=4, keys=[(0, 0)])
    with pytest.raises(ty.SceneError, match=r"^C2:"):
        ty.Scene().clock("value", channels=["t"], steps=4)
    with pytest.raises(ty.SceneError, match=r"^K9:"):
        ty.Scene().clock("fraction", channels=["t"], steps=4, end="pause")


def test_a_layer_clock_reads_its_own_channel():
    assert ty.layer_clock("tau", range=(10, 0)) == {"channel": "tau", "range": [10.0, 0.0]}
    with pytest.raises(ty.SceneError, match=r"^K4:"):
        ty.layer_clock("tau")
    with pytest.raises(ty.SceneError, match=r"^K4:"):
        ty.layer_clock("tau", range=(0, 1), keys=[(0, 0)])
    scene, _ = base(layers=[ty.track("a", reveal="grow", head=True, clock=ty.layer_clock("tau", keys=[(0, 10), (5, 6)]))])
    doc, data = scene.to_document(), scene.to_container()
    assert doc["requires"] == ["clock.keys", "layers.clock"]
    # at s = 2.5 the tau clock is at 8, hence t = 2 on both tracks
    out = evaluate(doc, data, doc["initial"], 5)
    heads = [m["head"] for m in out["panels"]["p"]["layers"][0]["members"]]
    assert heads == [[2.0, 0.0, 0.0], [2.0, 1.0, 0.0]]


def test_a_layer_clock_needs_its_channel_and_not_the_scene_clock():
    scene = ty.Scene()
    root = scene.frame("root")
    a = scene.track_set("a", frame=root, dtype="float64")
    a.add(np.zeros((3, 2)) + np.arange(3.0)[:, None], channels={"t": np.arange(3.0)})
    b = scene.track_set("b", frame=root, dtype="float64")
    b.add(np.zeros((3, 2)), channels={"k": np.array([0.0, 1.0, 0.5])})
    scene.clock("value", channels=["t"], steps=4, range=(0, 2))
    scene.view("v", frame=root, driver=ty.driver(a, 0), layers=[ty.track(b, reveal="grow", clock=ty.layer_clock("k", range=(0, 1)))])
    scene.panel("p", "v")
    with pytest.raises(ty.SceneError, match=r"T3: .*layer clock channel 'k'"):
        scene.to_document()
    scene._views["v"]["layers"] = [ty.track(b, reveal="grow", clock=ty.layer_clock("nope", range=(0, 1)))]
    with pytest.raises(ty.SceneError, match=r"C5: .*lacks channel 'nope'"):
        scene.to_document()
    scene._views["v"]["layers"] = [ty.track(b, reveal="grow", clock=ty.layer_clock("@index", range=(0, 2)))]
    assert scene.to_document()["requires"] == ["layers.clock"]


# cameras with keys (rule K5)


def test_shot_checks_its_keys():
    key = ty.shot(1.0, center=(0, 1), width=2.0)
    assert key == {"at": 1.0, "width": 2.0, "center": [0.0, 1.0], "ease": "smooth"}
    assert ty.shot(0.0, follow=ty.follow(0, 1), width=1.0)["follow"] == [{"layer": 0, "member": 1}]
    with pytest.raises(ty.SceneError, match=r"^K5:"):
        ty.shot(0.0, width=1.0)
    with pytest.raises(ty.SceneError, match=r"^K5:"):
        ty.shot(0.0, center=(0, 0), width=0.0)
    with pytest.raises(ty.SceneError, match=r"^K5:"):
        base(camera={"kind": "plane", "keys": [ty.shot(2.0, center=(0, 0), width=1.0), ty.shot(1.0, center=(0, 0), width=1.0)]})
    with pytest.raises(ty.SceneError, match=r"^K5: a camera key gives a height"):
        base(camera={"kind": "plane", "keys": [ty.shot(0.0, center=(0, 0), width=1.0, height=1.0)]})
    with pytest.raises(ty.SceneError, match=r"^K5: some keys"):
        base(
            camera={
                "kind": "plane",
                "aspect": "free",
                "keys": [ty.shot(0.0, center=(0, 0), width=1.0, height=1.0), ty.shot(1.0, center=(0, 0), width=1.0)],
            }
        )


def test_camera_targets_are_checked_against_the_view():
    keys = [ty.shot(0.0, follow=ty.follow(1, 0), width=1.0)]
    scene, _ = base(layers=[ty.track("a"), ty.axes()], camera={"kind": "plane", "keys": keys})
    with pytest.raises(ty.SceneError, match=r"K5: .*axes layer, not a track layer"):
        scene.to_document()
    scene, _ = base(layers=[ty.track("a")], camera={"kind": "plane", "keys": [ty.shot(0.0, follow=ty.follow(0, 2), width=1.0)]})
    with pytest.raises(ty.SceneError, match=r"K5: .*member 2 .*not below the track count 2"):
        scene.to_document()


def test_a_camera_follows_the_midpoint_and_blends_geometrically():
    keys = [
        ty.shot(0.0, center=(0, 0), width=1.0),
        ty.shot(4.0, follow=[ty.follow(0, 0), ty.follow(0, 1)], offset=(0, 1), width=4.0, ease="linear"),
    ]
    scene, _ = base(layers=[ty.track("a", reveal="grow", head=True)], camera={"kind": "plane", "keys": keys})
    doc, data = scene.to_document(), scene.to_container()
    assert doc["requires"] == ["clock.keys", "camera.keys"]
    # frame 4 is s = 2: the clock is at t = 4 smooth(0.4), x = 0.5 of the camera's linear segment
    t = 4 * 0.4 * 0.4 * (3 - 0.8)
    cam = evaluate(doc, data, doc["initial"], 4)["panels"]["p"]["camera"]
    assert cam["center"] == pytest.approx([0.5 * t, 0.5 * 1.5])
    assert cam["width"] == pytest.approx(2.0)
    assert cam["height"] is None
    # a key whose targets are all left out, here by a set query without a match, and that lacks a center gives no window
    doc["views"]["v"]["layers"][0]["sets"] = {"tags": {"kind": "none"}}
    assert evaluate(doc, data, doc["initial"], 4)["panels"]["p"]["camera"] is None
    assert evaluate(doc, data, doc["initial"], 9)["panels"]["p"]["camera"] is None


# labels and points (rules K6 and K8)


def test_labels_take_parts_and_anchors():
    layer = ty.label(
        ["t = ", ty.clock_value(factor=2.0, decimals=1), " days, ", ty.keyed((0, 0), (5, 1000), decimals=0, grouping=True)],
        ty.at_member("a", 1),
        offset=(4, -4),
        align="end",
        baseline="bottom",
        size=15,
        color="#123456",
        weight="bold",
        box={"fill": "#ffffff", "edge": "#999999", "pad": 3, "radius": 2, "opacity": 0.9},
        leader={"color": "#000000", "width": 1.0},
        opacity=ty.fade(1.0, 3.0),
    )
    assert layer["text"][1] == {"clock": "value", "decimals": 1, "factor": 2.0}
    assert layer["at"] == {"sets": {"set": "a"}, "member": 1}
    assert ty.steps((0, "one"), (2, "two")) == {"steps": [[0.0, "one"], [2.0, "two"]]}
    with pytest.raises(ty.SceneError, match=r"^K7:"):
        ty.steps((2, "two"), (0, "one"))
    with pytest.raises(ty.SceneError, match=r"^K7:"):
        ty.clock_value(digits=3, decimals=1)
    with pytest.raises(ty.SceneError, match=r"^K6:"):
        ty.label("x", {"nowhere": 1})
    scene, _ = base(layers=[ty.track("a"), layer, ty.label("far", ty.at_point(0, 0, frame="nope")), ty.label("s", ty.at_screen(0.5, 0.5))])
    with pytest.raises(ty.SceneError, match=r"K6: .*'nope', which is not a frame"):
        scene.to_document()
    scene, _ = base(layers=[ty.track("a"), ty.label("seven", ty.at_member("a", 7))])
    with pytest.raises(ty.SceneError, match=r"K6: .*member 7 is not below"):
        scene.to_document()
    scene, _ = base(layers=[ty.track("a"), layer, ty.label("s", ty.at_screen(0.5, 0.5))])
    doc, data = scene.to_document(), scene.to_container()
    assert "layers.label" in doc["requires"]
    out = evaluate(doc, data, doc["initial"], 0)["panels"]["p"]["layers"]
    assert out[1] == {"kind": "label", "position": [0.0, 1.0, 0.0]}
    assert out[2] == {"kind": "label", "position": None}


def test_points_appear_as_the_reading_passes_them():
    scene, _ = base(
        layers=[
            ty.points("a", 0, reveal="grow", marker=ty.marker("diamond", 9, "#ffffff", "#1f4e79", 2.0)),
            ty.points("a", 1, after="hidden"),
        ]
    )
    doc, data = scene.to_document(), scene.to_container()
    assert "layers.points" in doc["requires"]
    layers = evaluate(doc, data, doc["initial"], 4)["panels"]["p"]["layers"]
    # s = 2 gives t = 4 smooth(0.4) = 1.408, past samples 0 and 1
    assert layers[0]["members"] == [{"index": 0, "points": [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]]}]
    assert len(layers[1]["members"][0]["points"]) == 5
    with pytest.raises(ty.SceneError, match=r"^K8:"):
        ty.points("a", reveal="trail")


# drawing only


def test_drawing_keys_are_written_as_given():
    glow = {"channel": "S", "color": "#d62728", "size": 22, "opacity": 0.35}
    head = {"shape": "ring", "size": ty.tween((0, 9), (1, 12)), "edge": "#000000", "edge_width": 1.5, "opacity": 1.0, "glow": glow}
    layers = [
        ty.track(
            "a", reveal="grow", head=head, color=ty.steps_color("S", [0.0], ["#000000", "#d62728"]), dash=(4, 2), opacity=ty.fade(0.5)
        ),
        ty.track("a", 0, line=False, head=True, fill={"base": 0.0, "color": "#d62728", "opacity": 0.25}),
        ty.axes("box", ticks=["y"], size=11),
        ty.grid(opacity=0.5),
    ]
    scene, _ = base(layers=layers)
    scene.body("earth", frame="root", position=[0, 0, 0], image=PNG)
    scene._views["v"]["layers"].append(ty.body("earth", size=24, opacity=0.8))
    scene._views["v"]["margin"] = {"top": 0.1}
    scene.stage("start", 0.0)
    scene.stage("end", 5.0, label="the end")
    scene.text(["step ", ty.steps((0, "one"), (2, "two"))], (0.98, 0.05), align="end", size=17, opacity=ty.fade(1.0))
    scene.legend(
        [
            ty.entry("Thrust", line={"color": "#d62728", "width": 2}),
            ty.entry("query", marker=ty.marker("diamond")),
            ty.entry("anchors", colors=["#6a3d9a", "#33a02c"]),
        ],
        (0.5, 0.0),
        columns=3,
    )
    scene.layout(ty.split("row", 0.5, "p", "q", keys=[(0, 1), (1, 0.5, "smooth")]))
    scene.panel("q", "v")
    doc, data = scene.to_document(), scene.to_container()
    assert doc["bodies"]["earth"]["image"] == "bodies/earth/image"
    assert Container(data).view("bodies/earth/image").tobytes() == PNG
    assert doc["stages"] == [{"id": "start", "at": 0.0}, {"id": "end", "at": 5.0, "label": "the end"}]
    assert [o["kind"] for o in doc["overlays"]] == ["text", "legend"]
    assert doc["initial"]["layout"]["keys"] == [[0.0, 1.0], [1.0, 0.5, "smooth"]]
    assert doc["theme"]["font"] == "serif"
    jsonschema = pytest.importorskip("jsonschema")
    schema = json.loads((CORPUS.parent / "scene.schema.json").read_text())
    jsonschema.Draft202012Validator(schema).validate(doc)


def test_drawing_keys_are_checked():
    scene = ty.Scene()
    scene.frame("root")
    with pytest.raises(ty.SceneError, match=r"^2.11: the image"):
        scene.body("b", frame="root", position=[0, 0, 0], image=b"GIF89a")
    with pytest.raises(ty.SceneError, match=r"^2.11:"):
        ty.steps_color("S", [1.0, 0.0], ["#000000", "#111111", "#222222"])
    with pytest.raises(ty.SceneError, match=r"^2.11:"):
        ty.track("a", dash=(1, 0))
    with pytest.raises(ty.SceneError, match=r"^K1:"):
        ty.track("a", opacity=ty.tween((0, 0), (1, 2)))
    scene, _ = base(layers=[ty.track("a", head={"glow": {"channel": "nope"}})])
    with pytest.raises(ty.SceneError, match=r"2.11: .*'nope' for a head's glow"):
        scene.to_document()
    scene, _ = base(layers=[ty.track("a", color=ty.steps_color("nope", [0.0], ["#000000", "#ffffff"]))])
    with pytest.raises(ty.SceneError, match=r"2.7: .*lacks channel 'nope'"):
        scene.to_document()
    scene, _ = base()
    scene.stage("late", 6.0)
    with pytest.raises(ty.SceneError, match="K9: stage 'late'"):
        scene.to_document()
    with pytest.raises(ty.SceneError, match=r"^K9:"):
        scene.stage("late", 7.0)
    with pytest.raises(ty.SceneError, match=r"^K9:"):
        scene.stage("early", 1.0)
    with pytest.raises(ty.SceneError, match="a theme has unknown keys"):
        ty.Scene(theme={"fonts": "serif"})
    with pytest.raises(ty.SceneError, match=r"^2.11:"):
        base()[0].view("w", frame="root", driver=ty.driver("a", 0), layers=[], margin={"top": 1.0})


def test_legend_spacing_is_written_in_units_of_the_text_size():
    scene = ty.Scene()
    scene.legend([ty.entry("a", line={"color": "#ff0000"})], at=(0.5, 0.0), handle_length=1.8, handle_pad=0.8, column_spacing=1.2)
    assert scene._overlays[0]["handle_length"] == 1.8
    assert scene._overlays[0]["column_spacing"] == 1.2
    with pytest.raises(ty.SceneError, match=r"^2\.11:"):
        scene.legend([ty.entry("a")], at=(0.5, 0.0), handle_pad=-1)
