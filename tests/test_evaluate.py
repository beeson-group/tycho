"""The NumPy evaluator on small hand-built scenes, with expected values from closed forms."""

from __future__ import annotations

import numpy as np

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
