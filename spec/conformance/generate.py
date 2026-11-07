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


def value_clock():
    """A value clock over ragged tracks, a decreasing channel, hidden and clamp, a nearest tie, tags, and a toggle."""
    w = ContainerWriter(generator=f"pytycho {pytycho.__version__}, spec/conformance/generate.py")
    w.add_view("a/offsets", np.array([0, 5, 8]), dtype="uint32")
    w.add_view("a/positions", np.array([[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [0, 1], [1, 1], [2, 1]], dtype=np.float64))
    w.add_view("a/t", np.array([4.0, 3, 2, 1, 0, 2, 3, 4]))
    w.add_view("a/p", np.array([0.0, 0.5]))
    w.add_view("b/offsets", np.array([0, 2]), dtype="uint32")
    w.add_view("b/positions", np.array([[0.0, 2.0, 1.0], [1.0, 2.0, 1.0]]))
    w.add_view("b/t", np.array([0.0, 1.0]))
    w.add_view("b/p", np.array([1.0]))

    def tset(sid, tracks):
        return {
            "frame": "plane",
            "tags": {"family": sid},
            "tracks": tracks,
            "offsets": f"{sid}/offsets",
            "positions": f"{sid}/positions",
            "channels": {"t": {"view": f"{sid}/t"}},
            "parameters": {"p": {"view": f"{sid}/p"}},
        }

    doc = {
        "format": "tycho-scene",
        "version": "0.2",
        "generator": w.generator,
        "frames": {"plane": {}},
        "track_sets": {"a": tset("a", 2), "b": tset("b", 1)},
        "variables": {
            "fam": {"kind": "choice", "values": ["a", "b"], "default": "a", "scope": "scene"},
            "sel": {"kind": "selector", "by": "nearest", "parameter": "p", "default": 0.25, "scope": "scene"},
            "show": {"kind": "toggle", "default": False, "scope": "panel"},
        },
        "clock": {"mode": "value", "channels": ["t"], "steps": 8, "range": [-1.0, 7.0]},
        "views": {
            "v": {
                "frame": "plane",
                "driver": {"sets": {"tags": {"family": {"var": "fam"}}}, "member": {"var": "sel"}},
                "layers": [
                    {
                        "kind": "track",
                        "sets": {"tags": {"family": {"var": "fam"}}},
                        "members": "all",
                        "reveal": "grow",
                        "head": True,
                        "before": "hidden",
                        "after": "hidden",
                    },
                    {
                        "kind": "track",
                        "sets": {"tags": {"family": {"var": "fam"}}},
                        "members": {"var": "sel"},
                        "reveal": "grow",
                        "head": True,
                    },
                    {
                        "kind": "track",
                        "sets": {"tags": {"family": {"var": "fam"}}},
                        "members": "all",
                        "reveal": "none",
                        "visible": {"var": "show"},
                    },
                ],
            }
        },
        "initial": {"variables": {}, "clock": {"channel": "t"}, "panels": {"p1": {"view": "v"}}, "layout": {"kind": "panel", "id": "p1"}},
    }

    def state(fam="a", show=False):
        return {
            "variables": {"fam": fam},
            "clock": {"channel": "t"},
            "panels": {"p1": {"view": "v", "variables": {"show": show}}},
            "layout": {"kind": "panel", "id": "p1"},
        }

    cases = []
    # frame 2 has v = 1. track 0 runs t from 4 down to 0, thus u = 0.75 falls on sample 3. track 1 starts at t = 2, hence u = -0.5
    grow = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [2.0, 0.0, 0.0], [3.0, 0.0, 0.0]]
    cases.append(
        {
            "name": "value mode, decreasing channel at an exact sample, hidden before, nearest tie to index 0",
            "source": "analytic",
            "state": state(),
            "frame_index": 2,
            "tolerance": TOL,
            "expected": {
                "panels": {
                    "p1": {
                        "frame": "plane",
                        "layers": [
                            {
                                "kind": "track",
                                "set": "a",
                                "members": [{"index": 0, "line": grow, "head": grow[-1]}, {"index": 1, "line": [], "head": None}],
                            },
                            {"kind": "track", "set": "a", "members": [{"index": 0, "line": grow, "head": grow[-1]}]},
                        ],
                    }
                }
            },
        }
    )
    # frame 6 has v = 5, at which track 0 reads u = -0.25. it is hidden in the first layer and clamped to its first sample in the second
    cases.append(
        {
            "name": "value mode, before the track, hidden and clamp",
            "source": "analytic",
            "state": state(),
            "frame_index": 6,
            "tolerance": TOL,
            "expected": {
                "panels": {
                    "p1": {
                        "frame": "plane",
                        "layers": [
                            {
                                "kind": "track",
                                "set": "a",
                                "members": [{"index": 0, "line": [], "head": None}, {"index": 1, "line": [], "head": None}],
                            },
                            {"kind": "track", "set": "a", "members": [{"index": 0, "line": [[0.0, 0.0, 0.0]], "head": [0.0, 0.0, 0.0]}]},
                        ],
                    }
                }
            },
        }
    )
    data = w.to_bytes()
    for fam in ("a", "b"):
        for show in (False, True):
            for i in range(8):
                s = state(fam, show)
                cases.append(
                    {
                        "name": f"family {fam}, show {show}, frame {i}",
                        "source": "reference",
                        "state": s,
                        "frame_index": i,
                        "tolerance": TOL,
                        "expected": evaluate(doc, data, s, i),
                    }
                )
    write("value-clock", doc, w, cases)


def two_panels():
    """Two panels, a path up to the root and down again, an origin at a body of a third frame, and a selector by index."""
    import pytycho as ty

    d, k, tilt = 0.5, 2.0, 0.3
    tracks = [
        (np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.5], [-1.0, 0.0, 1.0]]), np.array([0.0, 0.4, 0.8]), np.array([0.0, 1.0, 2.0])),
        (
            np.array([[2.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 2.0, 0.25], [-1.0, 1.0, 0.5]]),
            np.array([0.1, 0.3, 0.9, 1.2]),
            np.array([0.0, 1.0, 3.0, 4.0]),
        ),
        (np.array([[0.0, 0.0, 1.0], [1.0, 1.0, 1.0]]), np.array([0.2, 1.0]), np.array([5.0, 3.0])),
    ]
    fixed_p, fixed_th = np.array([[3.0, 0.0, 0.0], [0.0, 3.0, 0.0], [0.0, 0.0, 3.0]]), np.array([0.0, 0.5, 1.0])

    scene = ty.Scene(title="two panels")
    root = scene.frame("root")
    rot = scene.frame("rot", parent=root, rotation=ty.rotation("z", ty.channel("th")))
    tilted = scene.frame("tilt", parent=rot, origin=[ty.attr("d"), 0.0, 0.0], rotation=ty.rotation("x", tilt))
    anchor = scene.body("anchor", frame=rot, position=[ty.attr("d"), 2 * ty.attr("d"), 0.0])
    scene.frame("shift", parent=root, origin=anchor, scale=ty.attr("k"))
    orbits = scene.track_set("orbits", frame=tilted, tags={"group": "moving"}, attrs={"d": d, "k": k}, dtype="float64")
    for (p, th, t), e in zip(tracks, (0.1, 0.2, 0.4), strict=True):
        orbits.add(p, channels={"th": th, "t": t}, parameters={"e": e})
    # fixed carries the channel th, which frame rot reads (rule F5). it is drawn whole and never read, hence it lacks
    # the clock channel (rule C5)
    fixed = scene.track_set("fixed", frame=root, tags={"group": "fixed"}, attrs={"d": d, "k": k}, dtype="float64")
    fixed.add(fixed_p, channels={"th": fixed_th})
    frame = scene.choice("frame", ["root", "rot", "tilt", "shift"], scope="panel")
    index = scene.selector("k", by="index", scope="panel")
    nearest = scene.selector("e", parameter="e", default=0.2)
    group = scene.choice("group", ["moving", "absent"])
    scene.clock("fraction", channels=["t", "@index"], steps=6)
    scene.view(
        "v",
        frame=frame,
        driver=ty.driver(ty.sets(group=group), index),
        layers=[
            ty.track(fixed),
            ty.track(orbits),
            ty.track(ty.sets(group=group), index, trail=0.4, head=True),
            ty.track(orbits, nearest, reveal="grow"),
            ty.body(anchor, trail=0.4),
            ty.grid(),
        ],
    )
    scene.panel("p1", "v", {"frame": "shift", "k": 0.5})
    scene.panel("p2", "v", {"frame": "tilt", "k": 2.5})
    scene.layout(ty.split("row", 0.5, "p1", "p2"))
    doc, data = scene.to_document(), scene.to_container()

    o, b = np.array([d, 0.0, 0.0]), np.array([d, 2 * d, 0.0])

    def in_root(p, th):
        return rz(th).T @ (o + rx(tilt).T @ p)

    def in_shift(p, th):
        return k * (in_root(p, th) - rz(th).T @ b)

    def L(x):
        return [list(map(float, p)) for p in x]

    def state(p1=None, p2=None, variables=None, channel="t"):
        return {
            "variables": variables or {},
            "clock": {"channel": channel},
            "panels": {
                "p1": {"view": "v", "variables": {"frame": "shift", "k": 0.5} if p1 is None else p1},
                "p2": {"view": "v", "variables": {"frame": "tilt", "k": 2.5} if p2 is None else p2},
            },
            "layout": doc["initial"]["layout"],
        }

    cases = []
    shift_all = [{"index": i, "line": L([in_shift(q, a) for q, a in zip(p, th, strict=True)])} for i, (p, th, _) in enumerate(tracks)]
    fixed_shift = L([k * (q - rz(a).T @ b) for q, a in zip(fixed_p, fixed_th, strict=True)])
    fixed_tilt = L([rx(tilt) @ (rz(a) @ q - o) for q, a in zip(fixed_p, fixed_th, strict=True)])
    cases.append(
        {
            "name": "a set drawn whole without the clock channel, and a path up to the root and down to an origin at a body",
            "source": "analytic",
            "state": state(),
            "frame_index": 0,
            "tolerance": TOL,
            "expected": {
                "panels": {
                    "p1": {
                        "frame": "shift",
                        "layers": [
                            {"kind": "track", "set": "fixed", "members": [{"index": 0, "line": fixed_shift}]},
                            {"kind": "track", "set": "orbits", "members": shift_all},
                            None,
                            None,
                            None,
                            {"kind": "grid"},
                        ],
                    },
                    "p2": {
                        "frame": "tilt",
                        "layers": [
                            {"kind": "track", "set": "fixed", "members": [{"index": 0, "line": fixed_tilt}]},
                            {
                                "kind": "track",
                                "set": "orbits",
                                "members": [{"index": i, "line": L(p)} for i, (p, _, _) in enumerate(tracks)],
                            },
                            None,
                            None,
                            None,
                            {"kind": "grid"},
                        ],
                    },
                }
            },
        }
    )
    # frame 3 has q = 1/2. in p1, k = 0.5 rounds up to track 1, whose t gives u_i = 0, 1/4, 3/4, 1. the head thus lies
    # halfway between samples 1 and 2, and the tail at u = 0.1 lies at weight 0.4 between samples 0 and 1.
    # in p2, k = 2.5 rounds to 3 and clamps to track 2, whose decreasing t gives u_i = 0, 1
    s1 = [in_shift(q, a) for q, a in zip(tracks[1][0], tracks[1][1], strict=True)]
    head1 = 0.5 * s1[1] + 0.5 * s1[2]
    t2 = tracks[2][0]
    head2 = 0.5 * t2[0] + 0.5 * t2[1]
    anchor_tilt = list(map(float, rx(tilt) @ (b - o)))
    cases.append(
        {
            "name": "selector by index rounds a half up and clamps, trail between samples of a nonperiodic track",
            "source": "analytic",
            "state": state(),
            "frame_index": 3,
            "tolerance": TOL,
            "expected": {
                "panels": {
                    "p1": {
                        "frame": "shift",
                        "layers": [
                            None,
                            None,
                            {
                                "kind": "track",
                                "set": "orbits",
                                "members": [
                                    {"index": 1, "line": L([0.6 * s1[0] + 0.4 * s1[1], s1[1], head1]), "head": list(map(float, head1))}
                                ],
                            },
                            None,
                            {"kind": "body", "body": "anchor", "position": [0.0, 0.0, 0.0], "trail": [[0.0, 0.0, 0.0]] * 3},
                            {"kind": "grid"},
                        ],
                    },
                    "p2": {
                        "frame": "tilt",
                        "layers": [
                            None,
                            None,
                            {
                                "kind": "track",
                                "set": "orbits",
                                "members": [{"index": 2, "line": L([0.9 * t2[0] + 0.1 * t2[1], head2]), "head": list(map(float, head2))}],
                            },
                            None,
                            {"kind": "body", "body": "anchor", "position": anchor_tilt, "trail": [anchor_tilt] * 2},
                            {"kind": "grid"},
                        ],
                    },
                }
            },
        }
    )
    # at frame 1, q = 1/6 makes the tail reading negative, and the trail is cut at the first sample (rule L2)
    head1 = (1.0 / 3.0) * s1[0] + (2.0 / 3.0) * s1[1]
    cases.append(
        {
            "name": "a nonperiodic trail is cut at the first sample",
            "source": "analytic",
            "state": state(),
            "frame_index": 1,
            "tolerance": TOL,
            "expected": {
                "panels": {
                    "p1": {
                        "frame": "shift",
                        "layers": [
                            None,
                            None,
                            {
                                "kind": "track",
                                "set": "orbits",
                                "members": [{"index": 1, "line": L([s1[0], head1]), "head": list(map(float, head1))}],
                            },
                            None,
                            None,
                            {"kind": "grid"},
                        ],
                    }
                }
            },
        }
    )
    states = {
        "initial": state(),
        "root and rot, k 1.5 and -0.6": state(p1={"frame": "root", "k": 1.5}, p2={"frame": "rot", "k": -0.6}),
    }
    for label, base in states.items():
        for channel in ("t", "@index"):
            for i in (-7, 0, 1, 2, 3, 4, 5):
                s = {**base, "clock": {"channel": channel}}
                cases.append(
                    {
                        "name": f"{label}, {channel}, frame {i}",
                        "source": "reference",
                        "state": s,
                        "frame_index": i,
                        "tolerance": TOL,
                        "expected": evaluate(doc, data, s, i),
                    }
                )
    out = HERE / "two-panels"
    out.mkdir(exist_ok=True)
    scene.write(out / "scene.tys", out / "data.tyd")
    (out / "cases.json").write_text(json.dumps(cases, indent=1) + "\n")
    print(f"two-panels: {len(cases)} cases")


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
    value_clock()
    two_panels()
    containers()
