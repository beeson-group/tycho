"""Writes the analytic and reference scenes of the conformance corpus, and depends only on pytycho and NumPy.

Run it from anywhere: ``python spec/conformance/generate.py``. The script writes ``scene.tys``,
``data.tyd``, and ``cases.json`` into each scene directory. The ``analytic`` cases are computed here from
closed forms written independently of ``pytycho._evaluate``. The ``reference`` cases are produced
by ``pytycho._evaluate`` itself, for behavior that TyCHO defines and that does not come from a dynamical model.

The documents of ``rotating-loop`` and ``value-clock`` are written as plain dicts, with the container
writer for their data. The scenes ``two-panels``, ``edge-fraction``, ``edge-value``, and ``laps`` are
built through the Scene API, and ``edge-fraction`` and ``laps`` also carry ``rejections.json``, the
scenes that a reader must reject. The directory ``containers`` does not hold a scene. It holds the same
views in ``encoded.tyd``, with the encodings that the writer picks and several chunks to a view, and in
``raw.tyd``, all raw. A reader must decode both to the same bits.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

import pytycho
from pytycho._evaluate import evaluate
from pytycho.container import ContainerWriter

HERE = Path(__file__).resolve().parent
TOL = 1e-12


def rz(a):
    return np.array([[np.cos(a), -np.sin(a), 0.0], [np.sin(a), np.cos(a), 0.0], [0.0, 0.0, 1.0]])


def rx(a):
    return np.array([[1.0, 0.0, 0.0], [0.0, np.cos(a), -np.sin(a)], [0.0, np.sin(a), np.cos(a)]])


def write(name, document, writer, cases):
    out = HERE / name
    out.mkdir(exist_ok=True)
    (out / "scene.tys").write_text(json.dumps(document, indent=1) + "\n")
    writer.write(out / "data.tyd")
    (out / "cases.json").write_text(json.dumps(cases, indent=1) + "\n")
    print(f"{name}: {len(cases)} cases")


def rotating_loop():
    """A closed planar loop in a rotating frame whose angle channel advances by 2.5 rad per period, not by a full turn."""
    pts = np.array([[1.0, 0.0], [0.0, 1.0], [-1.0, 0.0], [0.0, -1.0], [1.0, 0.0]])
    a = np.array([0.0, 0.5, 1.0, 1.5, 2.5])
    d, k, tilt = 0.5, 2.0, 0.25
    w = ContainerWriter(generator=f"pytycho {pytycho.__version__}, spec/conformance/generate.py")
    w.add_view("loop/offsets", np.array([0, 5]), dtype="uint32")
    w.add_view("loop/positions", pts, dtype="float32")
    w.add_view("loop/a", a, dtype="float32")
    doc = {
        "format": "tycho-scene",
        "version": "0.2",
        "generator": w.generator,
        "frames": {
            "rot": {"label": "rotating"},
            "inertial": {"parent": "rot", "rotation": {"axis": "z", "angle": {"channel": "a"}}},
            "scaled": {
                "parent": "rot",
                "origin": [{"attr": "d"}, 0.0, 0.0],
                "rotation": {"axis": "x", "angle": tilt},
                "scale": {"attr": "k"},
            },
        },
        "bodies": {"b1": {"frame": "rot", "position": [{"attr": "d"}, 0.0, 0.0]}},
        "track_sets": {
            "loop": {
                "frame": "rot",
                "tracks": 1,
                "offsets": "loop/offsets",
                "positions": "loop/positions",
                "channels": {"a": {"view": "loop/a", "interp": "linear"}},
                "attrs": {"d": d, "k": k},
                "periodic": True,
            }
        },
        "variables": {"frame": {"kind": "choice", "values": ["rot", "inertial", "scaled"], "default": "rot", "scope": "panel"}},
        "clock": {"mode": "fraction", "channels": ["@index", "a"], "steps": 8},
        "views": {
            "v": {
                "frame": {"var": "frame"},
                "driver": {"sets": {"set": "loop"}, "member": {"index": 0}},
                "layers": [
                    {"kind": "track", "sets": {"set": "loop"}, "members": "all", "reveal": "none"},
                    {
                        "kind": "track",
                        "sets": {"set": "loop"},
                        "members": "all",
                        "reveal": "trail",
                        "trail": {"fraction": 0.5},
                        "head": True,
                    },
                    {"kind": "body", "body": "b1", "trail": {"fraction": 0.5}},
                    {"kind": "axes"},
                ],
            }
        },
        "initial": {
            "variables": {},
            "clock": {"channel": "@index"},
            "panels": {"p1": {"view": "v"}},
            "layout": {"kind": "panel", "id": "p1"},
        },
    }
    P = np.hstack([pts, np.zeros((5, 1))])
    shift = a[-1] - a[0]
    b = np.array([d, 0.0, 0.0])

    def state(frame, channel="@index"):
        return {
            "variables": {},
            "clock": {"channel": channel},
            "panels": {"p1": {"view": "v", "variables": {"frame": frame}}},
            "layout": {"kind": "panel", "id": "p1"},
        }

    def L(x):
        return [list(map(float, p)) for p in x]

    cases = []
    inertial = [rz(a[i]) @ P[i] for i in range(5)]
    scaled = [k * rx(tilt) @ (P[i] - b) for i in range(5)]
    for frame, line in (("inertial", inertial), ("scaled", scaled)):
        cases.append(
            {
                "name": f"edge equation, {frame}, reveal none",
                "source": "analytic",
                "state": state(frame),
                "frame_index": 0,
                "tolerance": TOL,
                "expected": {
                    "panels": {
                        "p1": {
                            "frame": frame,
                            "layers": [
                                {"kind": "track", "set": "loop", "members": [{"index": 0, "line": L(line)}]},
                                None,
                                None,
                                {"kind": "axes"},
                            ],
                        }
                    }
                },
            }
        )
    # on the @index clock, frame 1 has u = 1/8. the tail at 5/8 lies halfway between samples 2 and 3, in the shifted context of rule L2
    sh = [rz(a[i] - shift) @ P[i] for i in range(5)]
    head = 0.5 * inertial[0] + 0.5 * inertial[1]
    track_trail = [0.5 * sh[2] + 0.5 * sh[3], sh[3], inertial[0], head]
    bn = [rz(a[i]) @ b for i in range(5)]
    bs = [rz(a[i] - shift) @ b for i in range(5)]
    body_trail = [0.5 * bs[2] + 0.5 * bs[3], bs[3], bn[0], 0.5 * bn[0] + 0.5 * bn[1]]
    cases.append(
        {
            "name": "periodic trail wrap in a rotating frame, angle advance 2.5 rad, @index",
            "source": "analytic",
            "state": state("inertial"),
            "frame_index": 1,
            "tolerance": TOL,
            "expected": {
                "panels": {
                    "p1": {
                        "frame": "inertial",
                        "layers": [
                            None,
                            {
                                "kind": "track",
                                "set": "loop",
                                "members": [{"index": 0, "line": L(track_trail), "head": list(map(float, head))}],
                            },
                            {"kind": "body", "body": "b1", "position": list(map(float, 0.5 * bn[0] + 0.5 * bn[1])), "trail": L(body_trail)},
                            {"kind": "axes"},
                        ],
                    }
                }
            },
        }
    )
    data = w.to_bytes()
    for frame in ("rot", "inertial", "scaled"):
        for channel in ("@index", "a"):
            for i in range(-1, 9):
                s = state(frame, channel)
                cases.append(
                    {
                        "name": f"{frame}, {channel}, frame {i}",
                        "source": "reference",
                        "state": s,
                        "frame_index": i,
                        "tolerance": TOL,
                        "expected": evaluate(doc, data, s, i),
                    }
                )
    write("rotating-loop", doc, w, cases)


def containers():
    """The same views written twice, with the encodings the writer picks and all raw, for a reader to decode bit for bit."""
    rng = np.random.default_rng(78)
    t = np.linspace(0.0, 2.0 * np.pi, 401)
    special = np.array([np.nan, -0.0, np.inf, -np.inf, 5e-324, np.finfo(np.float64).max])
    orbit = np.stack([np.cos(t), np.sin(t)], axis=1)
    orbit[50:56, 0] = special
    orbit[200, 1] = np.frombuffer(np.array([0x7FF8DEADBEEF0001], "<u8").tobytes(), "<f8")[0]  # a NaN with a payload
    views = [
        # a chunk_rows of None selects the writer's default, which gives one chunk to each view below that passes None
        ("float64/orbit", orbit, None, 64),  # 401 rows make six chunks of 64 and one of 17
        ("float32/orbit", orbit.astype(np.float32), None, 401),  # one chunk of all 401 rows
        ("float32/still", np.full((6, 4), 1.5, np.float32), None, 10),  # its 6 rows are fewer than one chunk of 10
        ("uint32/offsets", np.array([0, 170, 401]), "uint32", None),  # too short to gain from an encoding, thus written raw
        ("uint32/fall", np.arange(4_000_000_000, 0, -40_000_000), "uint32", 7),  # its deltas wrap
        ("int32/steps", np.repeat(np.arange(-20, 20), 3).reshape(-1, 3) * 1000, "int32", 9),
        ("uint16/ramp", np.arange(100) * 655, "uint16", 30),
        ("int16/wave", np.round(np.sin(np.arange(600) / 200.0) * 32000).reshape(200, 3), "int16", 64),
        ("uint8/bytes", np.arange(200) % 256, "uint8", 64),
        ("int8/wave", np.round(np.sin(np.arange(800) / 200.0) * 127).reshape(400, 2), "int8", 150),
        ("uint8/noise", rng.integers(0, 256, 64), "uint8", None),  # noise does not compress, and the writer keeps it raw
        ("float64/cube", np.linspace(-1.0, 1.0, 60).reshape(5, 3, 4), None, 2),
        ("int16/empty", np.zeros((0, 3)), "int16", None),
    ]
    generator = f"pytycho {pytycho.__version__}, spec/conformance/generate.py"
    encoded, raw = ContainerWriter(generator=generator), ContainerWriter(generator=generator, raw=True)
    for name, array, dtype, rows in views:
        encoded.add_view(name, array, dtype, chunk_rows=rows)
        raw.add_view(name, array, dtype)
    kinds = {name: v["encoding"] for name, v in encoded.views.items()}
    assert kinds["uint32/offsets"] == kinds["uint8/noise"] == kinds["int16/empty"] == "raw", kinds
    assert sum(k == "shuffle-delta-deflate" for k in kinds.values()) == len(views) - 3, kinds
    out = HERE / "containers"
    out.mkdir(exist_ok=True)
    encoded.write(out / "encoded.tyd")
    raw.write(out / "raw.tyd")
    print(f"containers: {len(views)} views, {len(encoded.to_bytes())} bytes encoded, {len(raw.to_bytes())} raw")


if __name__ == "__main__":
    rotating_loop()
    containers()
