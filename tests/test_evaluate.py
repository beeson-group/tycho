"""The NumPy evaluator on small hand-built scenes, with expected values from closed forms."""

from __future__ import annotations

import numpy as np
import pytest

from pytycho._evaluate import evaluate
from pytycho.container import ContainerWriter


def scene(positions, channels, *, frames, periodic=False, layers, frame="root", mode="fraction", steps=8, rng=None):
    m = len(positions)
    w = ContainerWriter()
    w.add_view("s/offsets", np.array([0, m]), dtype="uint32")
    w.add_view("s/positions", np.asarray(positions, dtype=np.float64))
    for name, values in channels.items():
        w.add_view(f"s/{name}", np.asarray(values, dtype=np.float64))
    clock = {"mode": mode, "channels": ["@index", *channels], "steps": steps}
    if rng is not None:
        clock["range"] = rng
    doc = {
        "format": "tycho-scene",
        "version": "0.2",
        "frames": frames,
        "track_sets": {
            "s": {
                "frame": "root",
                "tracks": 1,
                "offsets": "s/offsets",
                "positions": "s/positions",
                "channels": {k: {"view": f"s/{k}"} for k in channels},
                "attrs": {"k": 2.0},
                "periodic": periodic,
            }
        },
        "clock": clock,
        "views": {"v": {"frame": frame, "driver": {"sets": {"set": "s"}, "member": {"index": 0}}, "layers": layers}},
    }
    return doc, w.to_bytes()


def state(channel="@index"):
    return {"clock": {"channel": channel}, "panels": {"p": {"view": "v"}}, "layout": {"kind": "panel", "id": "p"}}


def rz(a):
    return np.array([[np.cos(a), -np.sin(a), 0], [np.sin(a), np.cos(a), 0], [0, 0, 1]])


def test_edge_with_origin_rotation_and_scale():
    frames = {
        "root": {},
        "child": {
            "parent": "root",
            "origin": [1.0, {"attr": "k", "factor": -1}, 0.5],
            "rotation": {"axis": "z", "angle": {"channel": "a"}},
            "scale": {"attr": "k"},
        },
    }
    pts = np.array([[1.0, 2.0, 3.0], [0.5, -1.0, 0.0], [2.0, 0.0, 1.0]])
    angle = [0.3, 0.7, 1.1]
    layers = [{"kind": "track", "sets": {"set": "s"}, "members": "all", "reveal": "none"}]
    doc, data = scene(pts, {"a": angle}, frames=frames, layers=layers, frame="child")
    out = evaluate(doc, data, state(), 0)["panels"]["p"]
    expected = [2.0 * rz(a) @ (p - np.array([1.0, -2.0, 0.5])) for p, a in zip(pts, angle, strict=True)]
    np.testing.assert_allclose(out["layers"][0]["members"][0]["line"], expected, atol=1e-13)


def test_c4_at_an_exact_sample_and_grow():
    pts = np.array([[0.0, 0, 0], [1.0, 0, 0], [3.0, 0, 0], [6.0, 0, 0], [10.0, 0, 0]])
    layers = [{"kind": "track", "sets": {"set": "s"}, "members": "all", "reveal": "grow", "head": True}]
    doc, data = scene(pts, {}, frames={"root": {}}, layers=layers)
    member = evaluate(doc, data, state(), 4)["panels"]["p"]["layers"][0]["members"][0]
    # the clock reading is q = 4/8 and the sample readings are u_i = i/4, thus the reading falls on sample 2
    assert member["line"] == [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [3.0, 0.0, 0.0]]
    assert member["head"] == [3.0, 0.0, 0.0]


def test_periodic_trail_wraps_in_the_shifted_context():
    frames = {"root": {}, "inertial": {"parent": "root", "rotation": {"axis": "z", "angle": {"channel": "a"}}}}
    pts = np.array([[1.0, 0, 0], [0.0, 1, 0], [-1.0, 0, 0], [0.0, -1, 0], [1.0, 0, 0]])
    angle = np.array([0.0, 0.5, 1.0, 1.5, 2.5])
    layers = [{"kind": "track", "sets": {"set": "s"}, "members": "all", "reveal": "trail", "trail": {"fraction": 0.5}}]
    doc, data = scene(pts, {"a": angle}, frames=frames, periodic=True, layers=layers, frame="inertial")
    line = evaluate(doc, data, state(), 1)["panels"]["p"]["layers"][0]["members"][0]["line"]
    # the reading is u = 1/8, and the tail wraps to 1/8 - 1/2 + 1 = 5/8. the line runs from the point at 5/8,
    # between samples 2 and 3, through samples 3 and 0 to the head
    shift = angle[-1] - angle[0]
    p_tail = 0.5 * rz(angle[2] - shift) @ pts[2] + 0.5 * rz(angle[3] - shift) @ pts[3]
    expected = [p_tail, rz(angle[3] - shift) @ pts[3], rz(angle[0]) @ pts[0], 0.5 * rz(angle[0]) @ pts[0] + 0.5 * rz(angle[1]) @ pts[1]]
    np.testing.assert_allclose(line, expected, atol=1e-13)


def test_value_mode_hidden_and_clamp():
    pts = np.array([[0.0, 0, 0], [1.0, 0, 0], [2.0, 0, 0]])
    layers = [
        {"kind": "track", "sets": {"set": "s"}, "members": "all", "reveal": "grow", "head": True, "after": "hidden"},
        {"kind": "track", "sets": {"set": "s"}, "members": "all", "reveal": "grow", "head": True},
    ]
    doc, data = scene(pts, {"t": [0.0, 1.0, 2.0]}, frames={"root": {}}, layers=layers, mode="value", steps=4, rng=[0.0, 4.0])
    out = evaluate(doc, data, state("t"), 3)["panels"]["p"]["layers"]
    assert out[0]["members"][0] == {"index": 0, "line": [], "head": None}
    assert out[1]["members"][0]["head"] == [2.0, 0.0, 0.0]


def test_v2_more_than_one_match_is_an_error():
    pts = np.array([[0.0, 0, 0], [1.0, 0, 0]])
    doc, data = scene(pts, {}, frames={"root": {}}, layers=[])
    doc["track_sets"]["s"]["tags"] = {"a": "x"}
    doc["track_sets"]["t"] = dict(doc["track_sets"]["s"])
    doc["views"]["v"]["layers"] = [{"kind": "track", "sets": {"tags": {"a": "x"}}, "members": "all"}]
    with pytest.raises(ValueError, match="V2"):
        evaluate(doc, data, state(), 0)


def test_c5_a_track_drawn_whole_needs_no_clock_channel():
    pts = np.array([[0.0, 0, 0], [1.0, 0, 0], [2.0, 0, 0]])
    layers = [{"kind": "track", "sets": {"set": "u"}, "members": "all"}]
    doc, data = scene(pts, {"t": [0.0, 1.0, 2.0]}, frames={"root": {}}, layers=layers, mode="value", steps=4, rng=[0.0, 4.0])
    doc["clock"]["channels"] = ["t"]
    # the driver's track set s carries t. the drawn track set u does not, and is drawn whole
    doc["track_sets"]["u"] = {k: v for k, v in doc["track_sets"]["s"].items() if k != "channels"}
    assert len(evaluate(doc, data, state("t"), 1)["panels"]["p"]["layers"][0]["members"][0]["line"]) == 3
    for reads in ({"head": True}, {"reveal": "grow"}, {"before": "hidden"}):
        doc["views"]["v"]["layers"] = [{**layers[0], **reads}]
        with pytest.raises(ValueError, match="C5"):
            evaluate(doc, data, state("t"), 1)
    # the driver is resolved for every panel, hence its track set must carry the clock channels too
    doc["views"]["v"]["layers"] = []
    doc["views"]["v"]["driver"] = {"sets": {"set": "u"}, "member": {"index": 0}}
    with pytest.raises(ValueError, match="C5"):
        evaluate(doc, data, state("t"), 1)


def test_v3_a_literal_index_past_the_last_track_is_an_error():
    pts = np.array([[0.0, 0, 0], [1.0, 0, 0]])
    doc, data = scene(pts, {}, frames={"root": {}}, layers=[{"kind": "track", "sets": {"set": "s"}, "members": {"index": 1}}])
    with pytest.raises(ValueError, match="V3"):
        evaluate(doc, data, state(), 0)


def test_selector_by_index_rounds_a_half_up_and_clamps():
    w = ContainerWriter()
    w.add_view("s/offsets", np.array([0, 2, 4, 6]), dtype="uint32")
    w.add_view("s/positions", np.zeros((6, 3)))
    doc = {
        "frames": {"root": {}},
        "track_sets": {"s": {"frame": "root", "tracks": 3, "offsets": "s/offsets", "positions": "s/positions"}},
        "variables": {"k": {"kind": "selector", "by": "index", "default": 0}},
        "clock": {"mode": "fraction", "channels": ["@index"], "steps": 2},
        "views": {
            "v": {
                "frame": "root",
                "driver": {"sets": {"set": "s"}, "member": {"index": 0}},
                "layers": [{"kind": "track", "sets": {"set": "s"}, "members": {"var": "k"}}],
            }
        },
    }
    for value, index in ((-0.6, 0), (-0.5, 0), (0.49, 0), (0.5, 1), (1.5, 2), (2.5, 2)):
        out = evaluate(doc, w.to_bytes(), {**state(), "variables": {"k": value}}, 0)
        assert out["panels"]["p"]["layers"][0]["members"][0]["index"] == index


def test_v3_a_count_steps_by_the_rounded_ratio_and_keeps_the_last_track():
    from pytycho._evaluate import sparse

    # 5 / 2 = 2.5 rounds half up to 3, where a round half to even would give 2
    assert sparse(5, 2) == [0, 3, 4]
    assert sparse(5, 1) == [0, 4]
    assert sparse(5, 5) == sparse(5, 9) == [0, 1, 2, 3, 4]
    assert sparse(7, 3) == [0, 2, 4, 6]
    assert sparse(1, 1) == [0]
    assert len(sparse(915, 40)) == 41
