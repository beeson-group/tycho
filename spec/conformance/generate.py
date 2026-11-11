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

import copy
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
    absent = state(variables={"group": "absent"})
    cases.append(
        {
            "name": "a driver and a layer whose set query matches nothing",
            "source": "analytic",
            "state": absent,
            "frame_index": 2,
            "tolerance": TOL,
            "expected": {
                "panels": {
                    "p1": {
                        "frame": "shift",
                        "layers": [
                            None,
                            None,
                            {"kind": "track", "set": None, "members": []},
                            None,
                            {"kind": "body", "body": "anchor", "position": None, "trail": []},
                            {"kind": "grid"},
                        ],
                    }
                }
            },
        }
    )
    # under rule V1, k and frame are panel-scoped, thus their scene values are not read and p1 falls back to the defaults,
    # root and track 0. e and group are scene-scoped, hence the values in p1 are not read, and the scene's e = 0.31 is nearest to track 2
    scoped = state(p1={"e": 0.1, "group": "absent"}, p2={"frame": "rot", "k": 1}, variables={"k": 1, "frame": "rot", "e": 0.31})
    r0 = in_root(tracks[0][0][0], tracks[0][1][0])
    r2 = in_root(tracks[2][0][0], tracks[2][1][0])
    rot1 = o + rx(tilt).T @ tracks[1][0][0]
    cases.append(
        {
            "name": "panel scope and scene scope are not read across",
            "source": "analytic",
            "state": scoped,
            "frame_index": 0,
            "tolerance": TOL,
            "expected": {
                "panels": {
                    "p1": {
                        "frame": "root",
                        "layers": [
                            None,
                            None,
                            {"kind": "track", "set": "orbits", "members": [{"index": 0, "line": L([r0]), "head": list(map(float, r0))}]},
                            {"kind": "track", "set": "orbits", "members": [{"index": 2, "line": L([r2])}]},
                            None,
                            {"kind": "grid"},
                        ],
                    },
                    "p2": {
                        "frame": "rot",
                        "layers": [
                            None,
                            None,
                            {
                                "kind": "track",
                                "set": "orbits",
                                "members": [{"index": 1, "line": L([rot1]), "head": list(map(float, rot1))}],
                            },
                            None,
                            None,
                            {"kind": "grid"},
                        ],
                    },
                }
            },
        }
    )
    states = {
        "initial": state(),
        "root and rot, k 1.5 and -0.6": state(p1={"frame": "root", "k": 1.5}, p2={"frame": "rot", "k": -0.6}),
        "no driver": absent,
        "scopes": scoped,
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


def _write_scene(name, scene, cases, rejections=None, strip_periodic=()):
    """Writes a Scene API scene, dropping the periodic key of the named sets to test rule T2's default."""
    out = HERE / name
    out.mkdir(exist_ok=True)
    doc, data = scene.to_document(), scene.to_container()
    for sid in strip_periodic:
        del doc["track_sets"][sid]["periodic"]
    (out / "scene.tys").write_text(json.dumps(doc, indent=1) + "\n")
    (out / "data.tyd").write_bytes(data)
    (out / "cases.json").write_text(json.dumps(cases, indent=1) + "\n")
    if rejections is not None:
        (out / "rejections.json").write_text(json.dumps(rejections, indent=1) + "\n")
    print(f"{name}: {len(cases)} cases" + (f", {len(rejections)} rejections" if rejections else ""))
    return doc, data


def edge_fraction():
    """The rules that a plausible wrong implementation would still pass in the other scenes, tested in fraction mode."""
    import pytycho as ty

    scene = ty.Scene(title="edge cases, fraction mode")
    p = scene.frame("p")
    scene.frame("c", parent=p, origin=[1.0, 0.0, 0.0], rotation=ty.rotation("z", np.pi / 2))
    scene.frame("y", parent=p, rotation=ty.rotation("y", np.pi / 2))
    b = scene.body("b", frame=p, position=[1.0, 0.0, 0.0])
    tri = np.array([[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]])
    opened = scene.track_set("open", frame=p, periodic=True, dtype="float64")
    opened.add(tri)
    nokey = scene.track_set("nokey", frame=p, dtype="float64")
    nokey.add(tri)
    off = scene.track_set("off", frame=p, dtype="float64")
    off.add(np.array([[2.0, 0.0], [0.0, 0.0]]))
    yrot = scene.track_set("yrot", frame=p, dtype="float64")
    yrot.add(np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0]]))
    scene.clock("fraction", channels=["@index"], steps=4)
    scene.view(
        "open",
        frame=p,
        driver=ty.driver(opened, 0),
        layers=[ty.track(opened, trail=0.75, head=True), ty.track(nokey, trail=0.5), ty.track(off, head=True), ty.body(b)],
    )
    scene.view("c", frame="c", driver=ty.driver(off, 0), layers=[ty.track(off)])
    scene.view("y", frame="y", driver=ty.driver(yrot, 0), layers=[ty.track(yrot)])
    for pid in ("open", "c", "y"):
        scene.panel(pid, pid)
    initial = {
        "variables": {},
        "clock": {"channel": "@index"},
        "panels": {pid: {"view": pid} for pid in ("open", "c", "y")},
        "layout": ty.split("row", 0.5, "open", ty.split("row", 0.5, "c", "y")),
    }
    cases = [
        {
            "name": "L2 joint on an open periodic loop, T2 absent periodic, L3 head on reveal none, a body without a trail, "
            "F1 origin off the rotation axis, F1 rotation about y",
            "source": "analytic",
            "state": initial,
            "frame_index": 1,
            "tolerance": TOL,
            "expected": {
                "panels": {
                    # frame 1 has u = 0.25 and the tail at -0.5. the wrapped part thus runs from 0.5 to 1, and its closing sample is dropped
                    "open": {
                        "frame": "p",
                        "layers": [
                            {
                                "kind": "track",
                                "set": "open",
                                "members": [
                                    {"index": 0, "line": [[1.0, 0.0, 0.0], [0.0, 0.0, 0.0], [0.5, 0.0, 0.0]], "head": [0.5, 0.0, 0.0]}
                                ],
                            },
                            {"kind": "track", "set": "nokey", "members": [{"index": 0, "line": [[0.0, 0.0, 0.0], [0.5, 0.0, 0.0]]}]},
                            {
                                "kind": "track",
                                "set": "off",
                                "members": [{"index": 0, "line": [[2.0, 0.0, 0.0], [0.0, 0.0, 0.0]], "head": [1.5, 0.0, 0.0]}],
                            },
                            {"kind": "body", "body": "b", "position": [1.0, 0.0, 0.0]},
                        ],
                    },
                    "c": {
                        "frame": "c",
                        "layers": [{"kind": "track", "set": "off", "members": [{"index": 0, "line": [[0.0, 1.0, 0.0], [0.0, -1.0, 0.0]]}]}],
                    },
                    "y": {
                        "frame": "y",
                        "layers": [
                            {"kind": "track", "set": "yrot", "members": [{"index": 0, "line": [[0.0, 0.0, -1.0], [1.0, 0.0, 0.0]]}]}
                        ],
                    },
                }
            },
        }
    ]
    one = {"variables": {}, "clock": {"channel": "@index"}, "panels": {"open": {"view": "open"}}, "layout": {"kind": "panel", "id": "open"}}
    rejections = [
        {"name": "T1: a track of one sample", "rule": "T1", "scene": {"track_sets": {"open": {"tracks": 2, "offsets": "bad/one"}}}},
        {"name": "2.1: offsets[0] is not 0", "rule": "2.1", "scene": {"track_sets": {"off": {"offsets": "bad/offsets"}}}},
        {
            "name": "S3: a set channel named @index",
            "rule": "S3",
            "scene": {"track_sets": {"off": {"channels": {"@index": {"view": "bad/time"}}}}},
        },
        {
            "name": "T3: a clock channel that is not monotone",
            "rule": "T3",
            "scene": {
                "track_sets": {"open": {"channels": {"t": {"view": "bad/t"}}}},
                "clock": {"channels": ["t"]},
                "initial": {"clock": {"channel": "t"}},
            },
            "state": {**one, "clock": {"channel": "t"}},
        },
        {"name": "F2: a constant zero scale", "rule": "F2", "scene": {"frames": {"c": {"scale": 0}}}},
        {"name": "F2: an origin of two scalars", "rule": "F2", "scene": {"frames": {"c": {"origin": [1.0, 0.0]}}}},
        {"name": "2.3: an edge field on the root", "rule": "2.3", "scene": {"frames": {"p": {"scale": 2}}}},
        {
            "name": "2.2: @index in a frame edge",
            "rule": "2.2",
            "scene": {"frames": {"c": {"rotation": {"axis": "z", "angle": {"channel": "@index"}}}}},
        },
        {
            "name": "F6: an origin at a body in the frame it defines",
            "rule": "F6",
            "scene": {"bodies": {"loop": {"frame": "c", "position": [0, 0, 0]}}, "frames": {"c": {"origin": {"body": "loop"}}}},
        },
        {
            "name": "V2: a {set} query naming no set",
            "rule": "V2",
            "scene": {"views": {"open": {"layers": [{"kind": "track", "sets": {"set": "nope"}, "members": "all"}]}}},
        },
        {
            "name": "V2: a driver query matching two sets",
            "rule": "V2",
            "scene": {
                "track_sets": {"open": {"tags": {"g": "x"}}, "nokey": {"tags": {"g": "x"}}},
                "views": {"open": {"driver": {"sets": {"set": None, "tags": {"g": "x"}}}}},
            },
        },
        {
            "name": "V3: a literal index past the last track",
            "rule": "V3",
            "scene": {"views": {"open": {"driver": {"sets": {"set": "open"}, "member": {"index": 1}}}}},
        },
        {
            "name": "V3: a driver member of all",
            "rule": "V3",
            "scene": {"views": {"open": {"driver": {"sets": {"set": "open"}, "member": "all"}}}},
        },
        {
            "name": "C5: a driver set without the clock channel",
            "rule": "C5",
            "scene": {
                "track_sets": {"nokey": {"channels": {"t": {"view": "bad/time"}}}},
                "clock": {"channels": ["t"]},
                "initial": {"clock": {"channel": "t"}},
            },
            "state": {**one, "clock": {"channel": "t"}},
        },
        {"name": "C2: value mode without a range", "rule": "C2", "scene": {"clock": {"mode": "value"}}},
        {"name": "2.6: a frame index that is not an integer", "rule": "2.6", "frame_index": 0.5},
        {"name": "2.8: a panel showing an unknown view", "rule": "2.8", "state": {**one, "panels": {"open": {"view": "nope"}}}},
        {
            "name": "2.8: a layout showing a panel twice",
            "rule": "2.8",
            "state": {
                **one,
                "layout": {
                    "kind": "split",
                    "dir": "row",
                    "ratio": 0.5,
                    "a": {"kind": "panel", "id": "open"},
                    "b": {"kind": "panel", "id": "open"},
                },
            },
        },
        {
            "name": "2.5: a selector holding a boolean",
            "rule": "2.5",
            "scene": {
                "variables": {"k": {"kind": "selector", "by": "index", "default": 0}},
                "views": {"open": {"driver": {"sets": {"set": "open"}, "member": {"var": "k"}}}},
            },
            "state": {**one, "variables": {"k": True}},
        },
        {
            "name": "L5: visible naming a choice",
            "rule": "L5",
            "scene": {
                "variables": {"c": {"kind": "choice", "values": ["x"], "default": "x"}},
                "views": {"open": {"layers": [{"kind": "grid", "visible": {"var": "c"}}]}},
            },
        },
        {"name": "S1: a layer kind that is not implemented", "rule": "S1", "scene": {"views": {"open": {"layers": [{"kind": "mesh"}]}}}},
        {
            "name": "2.7: a trail fraction above 1",
            "rule": "2.7",
            "scene": {
                "views": {
                    "open": {
                        "layers": [
                            {"kind": "track", "sets": {"set": "open"}, "members": "all", "reveal": "trail", "trail": {"fraction": 1.5}}
                        ]
                    }
                }
            },
        },
    ]
    doc, data = _write_scene("edge-fraction", scene, cases, rejections, strip_periodic=("nokey",))
    # the rejections point at the extra views below, i.e. a nonmonotone channel, an unaligned offsets view, and a plain channel
    w = ty.ContainerWriter(generator=doc["generator"])
    c = ty.Container(data)
    for name in c.names:
        w.add_view(name, c.view(name))
    w.add_view("bad/t", np.array([0.0, 2.0, 1.0]))
    w.add_view("bad/offsets", np.array([1, 2]), dtype="uint32")
    w.add_view("bad/one", np.array([0, 1, 3]), dtype="uint32")
    w.add_view("bad/time", np.array([0.0, 1.0, 2.0]))
    (HERE / "edge-fraction" / "data.tyd").write_bytes(w.to_bytes())


def edge_value():
    """The rules that a plausible wrong implementation would still pass in the other scenes, tested in value mode."""
    import pytycho as ty

    scene = ty.Scene(title="edge cases, value mode")
    p = scene.frame("p")
    scene.frame("th", parent=p, rotation=ty.rotation("z", ty.channel("th")))
    b = scene.body("b", frame=p, position=[1.0, 0.0, 0.0])
    dec = scene.track_set("dec", frame=p, dtype="float64")
    dec.add(np.array([[0.0, 0.0], [1.0, 0.0]]), channels={"t": [1.0, 0.0]})
    drv = scene.track_set("drv", frame=p, dtype="float64")
    drv.add(np.array([[0.0, 0.0], [1.0, 0.0]]), channels={"t": [0.0, 1.0], "th": [0.0, 0.5]})
    whole = scene.track_set("whole", frame=p, dtype="float64")
    whole.add(np.array([[0.0, 0.0], [1.0, 0.0]]), channels={"t": [0.0, 1.0]})
    idx = scene.track_set("idx", frame=p, dtype="float64")
    idx.add(np.array([[k, 0.0] for k in range(5)]), channels={"t": [0.0, 1.0, 2.0, 3.0, 4.0]})
    scene.clock("value", channels=["t", "@index"], steps=8, range=[2.0, 10.0])
    scene.view(
        "v",
        frame=p,
        driver=ty.driver(drv, 0),
        layers=[
            ty.track(dec, reveal="grow", head=True, before="hidden", after="clamp"),
            ty.track(dec, reveal="grow", head=True, before="clamp", after="hidden"),
            ty.track(whole, after="hidden"),
            ty.track(idx, reveal="grow", head=True),
        ],
    )
    scene.view("body", frame="th", driver=ty.driver(drv, 0), layers=[ty.body(b), ty.body(b, trail=0.5)])
    scene.panel("v", "v")
    scene.panel("body", "body")
    initial = {
        "variables": {},
        "clock": {"channel": "t"},
        "panels": {"v": {"view": "v"}, "body": {"view": "body"}},
        "layout": ty.split("row", 0.5, "v", "body"),
    }
    c, s = float(np.cos(0.5)), float(np.sin(0.5))
    cases = [
        {
            "name": "C3 on a decreasing channel with before and after apart, C3 and C5 on a reveal-none layer, "
            "L4 clamp of the driver's reading, a body trail in value mode",
            "source": "analytic",
            "state": initial,
            "frame_index": 0,
            "tolerance": TOL,
            "expected": {
                "panels": {
                    # frame 0 has v = 2. dec reads u = (2 - 1) / (0 - 1) = -1, before the track, and whole reads u = 2, after it.
                    # drv reads u = 2, which is clamped to 1
                    "v": {
                        "frame": "p",
                        "layers": [
                            {"kind": "track", "set": "dec", "members": [{"index": 0, "line": [], "head": None}]},
                            {"kind": "track", "set": "dec", "members": [{"index": 0, "line": [[0.0, 0.0, 0.0]], "head": [0.0, 0.0, 0.0]}]},
                            {"kind": "track", "set": "whole", "members": [{"index": 0, "line": []}]},
                            {
                                "kind": "track",
                                "set": "idx",
                                "members": [
                                    {"index": 0, "line": [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [2.0, 0.0, 0.0]], "head": [2.0, 0.0, 0.0]}
                                ],
                            },
                        ],
                    },
                    "body": {
                        "frame": "th",
                        "layers": [
                            {"kind": "body", "body": "b", "position": [c, s, 0.0]},
                            # the trail runs from u = 0.5 to the clamped 1, i.e. from the blended point to the closing sample
                            {"kind": "body", "body": "b", "position": [c, s, 0.0], "trail": [[0.5 + 0.5 * c, 0.5 * s, 0.0], [c, s, 0.0]]},
                        ],
                    },
                }
            },
        },
        {
            "name": "T4: a value-mode clock on @index counts stored samples from 0",
            "source": "analytic",
            "state": {**initial, "clock": {"channel": "@index"}},
            "frame_index": 0,
            "tolerance": TOL,
            # on the five-sample track, v = 2 gives u = 2 / 4, and the head sits on sample 2
            "expected": {
                "panels": {
                    "v": {
                        "frame": "p",
                        "layers": [
                            None,
                            None,
                            None,
                            {
                                "kind": "track",
                                "set": "idx",
                                "members": [
                                    {"index": 0, "line": [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [2.0, 0.0, 0.0]], "head": [2.0, 0.0, 0.0]}
                                ],
                            },
                        ],
                    }
                }
            },
        },
    ]
    doc, data = _write_scene("edge-value", scene, cases)
    for channel in ("t", "@index"):
        for i in range(-1, 9):
            st = {**initial, "clock": {"channel": channel}}
            cases.append(
                {
                    "name": f"{channel}, frame {i}",
                    "source": "reference",
                    "state": st,
                    "frame_index": i,
                    "tolerance": TOL,
                    "expected": evaluate(doc, data, st, i),
                }
            )
    (HERE / "edge-value" / "cases.json").write_text(json.dumps(cases, indent=1) + "\n")
    print(f"edge-value: {len(cases)} cases with the reference ones")


def laps():
    """The rotating loop over three laps (rule C6), a sparse context (rule V3), and the options that are for drawing only."""
    import pytycho as ty

    pts = np.array([[1.0, 0.0], [0.0, 1.0], [-1.0, 0.0], [0.0, -1.0], [1.0, 0.0]])
    a = np.array([0.0, 0.5, 1.0, 1.5, 2.5])
    d, n, advance = 0.5, 3, 2.5
    scene = ty.Scene(title="three laps of the rotating loop")
    rot = scene.frame("rot", label="rotating", axes=("x", "y", "z"), unit="DU")
    scene.frame("inertial", parent=rot, rotation=ty.rotation("z", ty.channel("a")), label="inertial", axes=("X", "Y", "Z"), unit="DU")
    b1 = scene.body("b1", frame=rot, position=[ty.attr("d"), 0.0, 0.0])
    loop = scene.track_set("loop", frame=rot, attrs={"d": d}, periodic=True, dtype="float64")
    loop.add(pts, channels={"a": a})
    # fan is not periodic and therefore has one lap. it is drawn whole and never read, hence it is allowed with a clock of three laps
    fan = scene.track_set("fan", frame=rot, dtype="float64")
    for j in range(5):
        fan.add(np.array([[j, 0.0], [j, 1.0]]), channels={"a": [0.0, 0.1 * (j + 1)]}, parameters={"e": 0.1 * j})
    frame = scene.choice("frame", ["rot", "inertial"], default="inertial", scope="panel")
    e = scene.selector("e", parameter="e", default=0.2)
    by_frame = {"parameter": "e", "colormap": {"var": frame, "map": {"rot": "viridis", "inertial": "plasma"}}}
    scene.clock("fraction", channels=["@index", "a"], steps=24, laps=n)
    scene.view(
        "v",
        frame=frame,
        driver=ty.driver(loop, 0),
        camera={"kind": "plane", "plane": "xy"},
        layers=[
            ty.track(loop),
            ty.track(loop, trail=0.25, taper=(0, 0), head={"color": "#f0e442", "size": 9}),
            ty.track(loop, reveal="grow"),
            ty.track(loop, trail=0.5),
            ty.body(b1, trail=0.25),
            ty.track(fan, ty.every(2), color=by_frame, opacity=0.4),
            ty.track(fan, color=by_frame, opacity=0.05, highlight={"var": e, "width": 2.5, "kernel": {"width": 0.05, "opacity": 0.55}}),
            ty.axes(span="full"),
            ty.grid(labels=True),
        ],
    )
    scene.panel("p1", "v")

    P = np.hstack([pts, np.zeros((5, 1))])
    b = np.array([d, 0.0, 0.0])

    def L(j, i):
        """Sample i of lap j in the inertial frame, where every channel is raised by j advances."""
        return rz(a[i] + j * advance) @ P[i]

    def B(j, i):
        return rz(a[i] + j * advance) @ b

    def mid(x, y):
        return 0.5 * x + 0.5 * y

    def pts_(x):
        return [list(map(float, p)) for p in x]

    fan_lines = {j: pts_([np.array([j, 0.0, 0.0]), rz(0.1 * (j + 1)) @ np.array([j, 1.0, 0.0])]) for j in range(5)}
    whole = [L(j, i) for j in range(2) for i in range(4)] + [L(2, i) for i in range(5)]
    marks = [{"kind": "axes"}, {"kind": "grid"}]

    def state(frame="inertial", channel="@index"):
        return {
            "variables": {},
            "clock": {"channel": channel},
            "panels": {"p1": {"view": "v", "variables": {"frame": frame}}},
            "layout": {"kind": "panel", "id": "p1"},
        }

    def expected(layers):
        return {"panels": {"p1": {"frame": "inertial", "layers": layers}}}

    # on @index, u_i = i / 4. frame 19 has the loop reading U = 3 * 19 / 24 = 2.375, i.e. lap 2 at 0.375, halfway between samples 1 and 2
    head = mid(L(2, 1), L(2, 2))
    body = mid(B(2, 1), B(2, 2))
    cases = [
        {
            "name": "C6: reveal none is three laps joined, 13 vertices, a head mid-lap 2, trails across one and two lap joints, "
            "grow from lap 0, a body trail across a joint, a nonperiodic set drawn once, V3 count 2 of 5 tracks",
            "source": "analytic",
            "state": state(),
            "frame_index": 19,
            "tolerance": TOL,
            "expected": expected(
                [
                    {"kind": "track", "set": "loop", "members": [{"index": 0, "line": pts_(whole)}]},
                    # the tail reads 2.375 - 3 * 0.25 = 1.625, i.e. lap 1 at 0.625, halfway between samples 2 and 3
                    {
                        "kind": "track",
                        "set": "loop",
                        "members": [
                            {
                                "index": 0,
                                "line": pts_([mid(L(1, 2), L(1, 3)), L(1, 3), L(2, 0), L(2, 1), head]),
                                "head": list(map(float, head)),
                            }
                        ],
                    },
                    {
                        "kind": "track",
                        "set": "loop",
                        "members": [
                            {"index": 0, "line": pts_([L(0, i) for i in range(4)] + [L(1, i) for i in range(4)] + [L(2, 0), L(2, 1), head])}
                        ],
                    },
                    # the tail reads 2.375 - 3 * 0.5 = 0.875, i.e. lap 0 at 0.875, halfway between samples 3 and 4
                    {
                        "kind": "track",
                        "set": "loop",
                        "members": [
                            {"index": 0, "line": pts_([mid(L(0, 3), L(0, 4))] + [L(1, i) for i in range(4)] + [L(2, 0), L(2, 1), head])}
                        ],
                    },
                    {
                        "kind": "body",
                        "body": "b1",
                        "position": list(map(float, body)),
                        "trail": pts_([mid(B(1, 2), B(1, 3)), B(1, 3), B(2, 0), B(2, 1), body]),
                    },
                    # the step is floor(5 / 2 + 0.5) = 3, which gives tracks 0 and 3, then the last
                    {"kind": "track", "set": "fan", "members": [{"index": j, "line": fan_lines[j]} for j in (0, 3, 4)]},
                    {"kind": "track", "set": "fan", "members": [{"index": j, "line": fan_lines[j]} for j in range(5)]},
                    *marks,
                ]
            ),
        },
    ]
    # at frame 1, U = 0.125 and the trails reach below lap 0, into lap -1 and, for the longer one, into lap -2
    head = mid(L(0, 0), L(0, 1))
    body = mid(B(0, 0), B(0, 1))
    cases.append(
        {
            "name": "C6 and L2: a trail continues below lap 0 into laps -1 and -2, each lowered by its number of advances",
            "source": "analytic",
            "state": state(),
            "frame_index": 1,
            "tolerance": TOL,
            "expected": expected(
                [
                    None,
                    # the tail reads 0.125 - 0.75 = -0.625, i.e. lap -1 at 0.375
                    {
                        "kind": "track",
                        "set": "loop",
                        "members": [
                            {
                                "index": 0,
                                "line": pts_([mid(L(-1, 1), L(-1, 2)), L(-1, 2), L(-1, 3), L(0, 0), head]),
                                "head": list(map(float, head)),
                            }
                        ],
                    },
                    {"kind": "track", "set": "loop", "members": [{"index": 0, "line": pts_([L(0, 0), head])}]},
                    # the tail reads 0.125 - 1.5 = -1.375, i.e. lap -2 at 0.625
                    {
                        "kind": "track",
                        "set": "loop",
                        "members": [
                            {"index": 0, "line": pts_([mid(L(-2, 2), L(-2, 3)), L(-2, 3)] + [L(-1, i) for i in range(4)] + [L(0, 0), head])}
                        ],
                    },
                    {
                        "kind": "body",
                        "body": "b1",
                        "position": list(map(float, body)),
                        "trail": pts_([mid(B(-1, 1), B(-1, 2)), B(-1, 2), B(-1, 3), B(0, 0), body]),
                    },
                    None,
                    None,
                    *marks,
                ]
            ),
        }
    )
    # frame 16 has U = 2, i.e. lap 2 at 0, which is the first sample of lap 2. the tail at 1.25 sits on sample 1 of lap 1
    cases.append(
        {
            "name": "C6: a reading on a lap joint is the first sample of the higher lap",
            "source": "analytic",
            "state": state(),
            "frame_index": 16,
            "tolerance": TOL,
            "expected": expected(
                [
                    None,
                    {
                        "kind": "track",
                        "set": "loop",
                        "members": [{"index": 0, "line": pts_([L(1, 1), L(1, 2), L(1, 3), L(2, 0)]), "head": list(map(float, L(2, 0)))}],
                    },
                    {
                        "kind": "track",
                        "set": "loop",
                        "members": [{"index": 0, "line": pts_([L(0, i) for i in range(4)] + [L(1, i) for i in range(4)] + [L(2, 0)])}],
                    },
                    None,
                    None,
                    None,
                    None,
                    *marks,
                ]
            ),
        }
    )
    doc, data = _write_scene("laps", scene, cases)
    for fr in ("rot", "inertial"):
        for channel in ("@index", "a"):
            for i in range(-1, 25):
                st = state(fr, channel)
                cases.append(
                    {
                        "name": f"{fr}, {channel}, frame {i}",
                        "source": "reference",
                        "state": st,
                        "frame_index": i,
                        "tolerance": TOL,
                        "expected": evaluate(doc, data, st, i),
                    }
                )
    (HERE / "laps" / "cases.json").write_text(json.dumps(cases, indent=1) + "\n")

    def with_layer(k, **changes):
        layers = copy.deepcopy(doc["views"]["v"]["layers"])
        layers[k].update(changes)
        return {"views": {"v": {"layers": layers}}}

    rejections = [
        {"name": "C6: laps on a value clock", "rule": "C6", "scene": {"clock": {"mode": "value", "range": [0.0, 1.0]}}},
        {"name": "C6: laps of zero", "rule": "C6", "scene": {"clock": {"laps": 0}}},
        {
            "name": "C6: laps 2 with a driver whose set is not periodic",
            "rule": "C6",
            "scene": {"clock": {"laps": 2}, "track_sets": {"loop": {"periodic": False}}},
        },
        {"name": "C6: laps 3 with a reading taken on a set that is not periodic", "rule": "C6", "scene": with_layer(5, head=True)},
        {"name": "V3: a member count of zero", "rule": "V3", "scene": with_layer(5, members={"count": 0})},
        {
            "name": "V3: a driver member that is a count",
            "rule": "V3",
            "scene": {"views": {"v": {"driver": {"member": {"index": None, "count": 2}}}}},
        },
    ]
    (HERE / "laps" / "rejections.json").write_text(json.dumps(rejections, indent=1) + "\n")
    print(f"laps: {len(cases)} cases with the reference ones, {len(rejections)} rejections")


def driver_context():
    """A grid of a pulsating frame drawn in the driver's context (rule L6), whose set does not carry any channel (rule C5)."""
    import pytycho as ty

    e, mu = 0.5, 0.25
    f = np.array([0.0, 1.0, 3.0, 4.5, 2.0 * np.pi])
    rho = (1.0 - e**2) / (1.0 + e * np.cos(f))
    orbit_rot = np.array([[0.9, 0.0], [0.8, 0.1], [0.7, 0.0], [0.8, -0.1], [0.9, 0.0]])
    grid_lines = [
        np.array([[-0.5, -1.0], [-0.5, 0.0], [-0.5, 1.0]]),
        np.array([[0.5, -1.0], [0.5, 0.0], [0.5, 1.0]]),
        np.array([[-1.0, 0.0], [1.0, 0.0]]),
    ]
    ring = np.array([[1.2, 0.0], [0.0, 1.2], [-1.2, 0.0], [0.0, -1.2], [1.2, 0.0]])

    scene = ty.Scene(title="a grid of the pulsating frame in the driver's context")
    pulsating = scene.frame("pulsating", label="rotating-pulsating", axes=("x", "y", "z"), unit="DU")
    rot = scene.frame("rotating", parent=pulsating, scale=ty.channel("rho"), label="rotating", axes=("xi", "eta", "z"))
    inertial = scene.frame("inertial", parent=rot, rotation=ty.rotation("z", ty.channel("f")), label="inertial", axes=("X", "Y", "Z"))
    m1 = scene.body("m1", frame=pulsating, position=[-ty.attr("mu"), 0.0, 0.0])
    scene.frame("inertial-m1", parent=inertial, origin=m1, label="inertial, centered on the primary", axes=("X", "Y", "Z"))
    # mu is carried by the driver's set alone, and the frame inertial-m1 reads it through the origin at the body m1
    orbit = scene.track_set("orbit", frame=rot, tags={"family": "a"}, attrs={"mu": mu}, periodic=True, dtype="float64")
    orbit.add(orbit_rot, channels={"f": f, "rho": rho})
    grid = scene.track_set("grid", frame=pulsating, dtype="float64")
    for line in grid_lines:
        grid.add(line)
    # the ring carries the clock channel f, hence a layer may take a reading on it, and its values are its own
    ring_set = scene.track_set("ring", frame=pulsating, dtype="float64")
    ring_set.add(ring, channels={"f": [0.0, 0.5, 1.0, 1.5, 2.0]})
    frame = scene.choice("frame", ["pulsating", "rotating", "inertial", "inertial-m1"], default="inertial", scope="panel")
    family = scene.choice("family", ["a", "b"], default="a")
    scene.clock("fraction", channels=["f", "@index"], steps=8)
    scene.view(
        "v",
        frame=frame,
        driver=ty.driver(ty.sets(family=family), 0),
        camera={"kind": "plane", "plane": "xy"},
        layers=[
            ty.track(grid, context="driver", color="#3a4150"),
            ty.track(ring_set, reveal="grow", head=True, context="driver"),
            ty.track(orbit, head=True),
            ty.axes(),
        ],
    )
    scene.panel("p1", "v")

    def to(display, k, p):
        """A point of the pulsating frame in the display frame, in the context of sample k of the orbit."""
        p = np.array([p[0], p[1], 0.0])
        if display == "pulsating":
            return p
        if display == "rotating":
            return rho[k] * p
        if display == "inertial":
            return rz(f[k]) @ (rho[k] * p)
        return rz(f[k]) @ (rho[k] * (p - np.array([-mu, 0.0, 0.0])))

    def orbit_at(display, k):
        """Sample k of the orbit, stored in the rotating frame, in the display frame in its own context."""
        return to(display, k, orbit_rot[k] / rho[k])

    def reading(u):
        """The segment k and the weight w of the reading u on the orbit, whose sample readings are f / (2 pi) on f (rules C1 and C4)."""
        ui = (f - f[0]) / (f[-1] - f[0])
        k = min(int(np.searchsorted(ui, u, side="right")) - 1, 3)
        return k, (u - ui[k]) / (ui[k + 1] - ui[k])

    def blend(display, u, p):
        k, w = reading(u)
        return (1.0 - w) * to(display, k, p) + w * to(display, k + 1, p)

    def pts_(x):
        return [list(map(float, q)) for q in x]

    def state(display="inertial", channel="f", fam="a"):
        return {
            "variables": {"family": fam},
            "clock": {"channel": channel},
            "panels": {"p1": {"view": "v", "variables": {"frame": display}}},
            "layout": {"kind": "panel", "id": "p1"},
        }

    cases = []
    for display, i in (("inertial", 1), ("rotating", 3), ("inertial-m1", 6), ("pulsating", 5)):
        u = i / 8
        grid_out = [{"index": j, "line": pts_([blend(display, u, q) for q in line])} for j, line in enumerate(grid_lines)]
        # the ring's own readings are 0, 0.25, 0.5, 0.75, and 1 on f, where the orbit's differ
        rk = min(int(u * 4), 3)
        rw = (u - rk / 4) / 0.25
        ring_head = (1.0 - rw) * blend(display, u, ring[rk]) + rw * blend(display, u, ring[rk + 1])
        # a grown line ends at the head, which is not repeated when the reading falls on a sample
        ring_line = [blend(display, u, ring[j]) for j in range(rk + 1)] + ([ring_head] if rw > 0 else [])
        k, w = reading(u)
        orbit_head = (1.0 - w) * orbit_at(display, k) + w * orbit_at(display, k + 1)
        cases.append(
            {
                "name": f"L6: in {display} at frame {i}, every grid vertex is transformed in the blended context of the driver's reading, "
                "a grown ring with a head is blended at its own reading, and the orbit is drawn in its own context",
                "source": "analytic",
                "state": state(display),
                "frame_index": i,
                "tolerance": TOL,
                "expected": {
                    "panels": {
                        "p1": {
                            "frame": display,
                            "layers": [
                                {"kind": "track", "set": "grid", "members": grid_out},
                                {
                                    "kind": "track",
                                    "set": "ring",
                                    "members": [{"index": 0, "line": pts_(ring_line), "head": list(map(float, ring_head))}],
                                },
                                {
                                    "kind": "track",
                                    "set": "orbit",
                                    "members": [
                                        {
                                            "index": 0,
                                            "line": pts_([orbit_at(display, j) for j in range(5)]),
                                            "head": list(map(float, orbit_head)),
                                        }
                                    ],
                                },
                                {"kind": "axes"},
                            ],
                        }
                    }
                },
            }
        )
    cases.append(
        {
            "name": "L6: when the driver's set query does not match any set, every member of a layer in the driver's context is empty",
            "source": "analytic",
            "state": state(fam="b"),
            "frame_index": 1,
            "tolerance": TOL,
            "expected": {
                "panels": {
                    "p1": {
                        "frame": "inertial",
                        "layers": [
                            {"kind": "track", "set": "grid", "members": [{"index": j, "line": []} for j in range(3)]},
                            {"kind": "track", "set": "ring", "members": [{"index": 0, "line": [], "head": None}]},
                            None,
                            {"kind": "axes"},
                        ],
                    }
                }
            },
        }
    )
    doc, data = _write_scene("driver-context", scene, cases)
    for display in ("pulsating", "rotating", "inertial", "inertial-m1"):
        for channel in ("f", "@index"):
            for i in range(-1, 9):
                st = state(display, channel)
                cases.append(
                    {
                        "name": f"{display}, {channel}, frame {i}",
                        "source": "reference",
                        "state": st,
                        "frame_index": i,
                        "tolerance": TOL,
                        "expected": evaluate(doc, data, st, i),
                    }
                )
    (HERE / "driver-context" / "cases.json").write_text(json.dumps(cases, indent=1) + "\n")

    def with_layer(k, **changes):
        layers = copy.deepcopy(doc["views"]["v"]["layers"])
        layers[k].update(changes)
        return {"views": {"v": {"layers": layers}}}

    rejections = [
        {"name": "L6: a context that is neither own nor driver", "rule": "L6", "scene": with_layer(0, context="sample")},
        # the reveal, C3, and trail checks come before the check of the context
        {
            "name": "2.7: a reveal that is neither none, grow, nor trail, on a layer whose context is neither own nor driver",
            "rule": "2.7",
            "scene": with_layer(0, reveal="sweep", context="sample"),
        },
        {
            "name": "C5: a head on a layer in the driver's context whose set lacks the clock channel f",
            "rule": "C5",
            "scene": with_layer(0, head=True),
        },
        {
            "name": "F5: the driver's set lacks the channel rho, which only the layer in the driver's context reads in the inertial frame",
            "rule": "F5",
            "scene": {"track_sets": {"orbit": {"channels": {"rho": None}}}},
        },
    ]
    (HERE / "driver-context" / "rejections.json").write_text(json.dumps(rejections, indent=1) + "\n")
    print(f"driver-context: {len(cases)} cases with the reference ones, {len(rejections)} rejections")


def _segment(ui, u):
    """The segment k and the weight w of the reading u on the sample readings ui (rule C4)."""
    k = min(int(np.searchsorted(ui, u, side="right")) - 1, len(ui) - 2)
    return k, (u - ui[k]) / (ui[k + 1] - ui[k])


def driver_context_laps():
    """A grid and a grown ring in the driver's context over two laps (rules L6 and C6), driven by a time channel on a rotating edge."""
    import pytycho as ty

    loop_pts = np.array([[1.0, 0.0], [0.0, 1.0], [-1.0, 0.0], [0.0, -1.0], [1.0, 0.0]])
    # the advance of the time channel t over one period is 2.5, hence lap 1 is turned by 2.5 rad more than lap 0
    t, advance = np.array([0.0, 0.5, 1.0, 1.5, 2.5]), 2.5
    grid_lines = [np.array([[-0.5, -1.0], [-0.5, 1.0]]), np.array([[-1.0, 0.5], [1.0, 0.5]])]
    ring = np.array([[0.4, 0.0], [0.0, 0.4], [-0.4, 0.0], [0.0, -0.4], [0.4, 0.0]])
    ring_t = np.array([0.0, 0.6, 1.0, 1.4, 2.0])

    scene = ty.Scene(title="a grid and a grown ring in the driver's context over two laps")
    rot = scene.frame("rot", label="rotating", axes=("x", "y", "z"), unit="DU")
    scene.frame("inertial", parent=rot, rotation=ty.rotation("z", ty.channel("t")), label="inertial", axes=("X", "Y", "Z"), unit="DU")
    loop = scene.track_set("loop", frame=rot, periodic=True, dtype="float64")
    loop.add(loop_pts, channels={"t": t})
    # the grid is drawn whole and never read, hence it is not periodic and does not store any channel
    grid = scene.track_set("grid", frame=rot, dtype="float64")
    for line in grid_lines:
        grid.add(line)
    ring_set = scene.track_set("ring", frame=rot, periodic=True, dtype="float64")
    ring_set.add(ring, channels={"t": ring_t})
    frame = scene.choice("frame", ["rot", "inertial"], default="inertial", scope="panel")
    scene.clock("fraction", channels=["t", "@index"], steps=8, laps=2)
    scene.view(
        "v",
        frame=frame,
        driver=ty.driver(loop, 0),
        camera={"kind": "plane", "plane": "xy"},
        layers=[
            ty.track(grid, context="driver"),
            ty.track(ring_set, reveal="grow", head=True, context="driver"),
            ty.track(loop, head=True),
        ],
    )
    scene.panel("p1", "v")

    ui, ring_ui = t / advance, (ring_t - ring_t[0]) / (ring_t[-1] - ring_t[0])

    def driver_map(display, i):
        """The map from the rotating frame into the display frame at frame i, blended at the driver's reading in its lap."""
        if display == "rot":
            return np.eye(3)
        lap = min(int(2 * i / 8), 1)
        k, w = _segment(ui, 2 * i / 8 - lap)
        return (1.0 - w) * rz(t[k] + lap * advance) + w * rz(t[k + 1] + lap * advance)

    def pts_(x):
        return [list(map(float, x_ @ np.array([*p, 0.0]))) for x_, p in x]

    def state(display="inertial", channel="t"):
        return {
            "variables": {},
            "clock": {"channel": channel},
            "panels": {"p1": {"view": "v", "variables": {"frame": display}}},
            "layout": {"kind": "panel", "id": "p1"},
        }

    cases = []
    for display, i in (("inertial", 3), ("inertial", 5), ("inertial", 7), ("rot", 5)):
        m = driver_map(display, i)
        lap = min(int(2 * i / 8), 1)
        k, w = _segment(ring_ui, 2 * i / 8 - lap)
        head = (1.0 - w) * ring[k] + w * ring[k + 1]
        # with the reading in lap 1, lap 0 is grown whole, and its closing sample is kept once, as the first sample of lap 1
        ring_line = [ring[s] for s in range(4)] * lap + [ring[s] for s in range(k + 1)] + [head]
        cases.append(
            {
                "name": f"L6 and C6: in {display} at frame {i}, in lap {lap}, the grid and the ring are transformed in the blended "
                "context of the driver's reading in its lap, raised by the advance of the time channel, and every lap of the ring "
                "is drawn in this context",
                "source": "analytic",
                "state": state(display),
                "frame_index": i,
                "tolerance": TOL,
                "expected": {
                    "panels": {
                        "p1": {
                            "frame": display,
                            "layers": [
                                {
                                    "kind": "track",
                                    "set": "grid",
                                    "members": [{"index": j, "line": pts_((m, p) for p in g)} for j, g in enumerate(grid_lines)],
                                },
                                {
                                    "kind": "track",
                                    "set": "ring",
                                    "members": [{"index": 0, "line": pts_((m, p) for p in ring_line), "head": pts_([(m, head)])[0]}],
                                },
                                None,
                            ],
                        }
                    }
                },
            }
        )
    doc, data = _write_scene("driver-context-laps", scene, cases)
    for display in ("rot", "inertial"):
        for channel in ("t", "@index"):
            for i in range(-1, 9):
                st = state(display, channel)
                cases.append(
                    {
                        "name": f"{display}, {channel}, frame {i}",
                        "source": "reference",
                        "state": st,
                        "frame_index": i,
                        "tolerance": TOL,
                        "expected": evaluate(doc, data, st, i),
                    }
                )
    (HERE / "driver-context-laps" / "cases.json").write_text(json.dumps(cases, indent=1) + "\n")
    print(f"driver-context-laps: {len(cases)} cases with the reference ones")


def driver_context_value():
    """A grid and a grown ring in the driver's context under a value clock that runs past both ends of the driver (rules L6 and C3)."""
    import pytycho as ty

    drv_pts = np.array([[1.0, 0.0], [0.8, 0.3], [0.6, 0.0]])
    t, th = np.array([0.0, 1.0, 2.0]), np.array([0.0, 0.5, 1.5])
    grid_lines = [np.array([[-0.5, -1.0], [-0.5, 1.0]]), np.array([[-1.0, 0.5], [1.0, 0.5]])]
    ring = np.array([[0.4, 0.0], [0.0, 0.4], [-0.4, 0.0]])
    ring_t = np.array([0.25, 1.0, 1.75])

    scene = ty.Scene(title="a grid and a grown ring in the driver's context under a value clock")
    rot = scene.frame("rot", label="rotating", axes=("x", "y", "z"), unit="DU")
    inertial = scene.frame("inertial", parent=rot, rotation=ty.rotation("z", ty.channel("th")), label="inertial", axes=("X", "Y", "Z"))
    drv = scene.track_set("drv", frame=rot, dtype="float64")
    drv.add(drv_pts, channels={"t": t, "th": th})
    grid = scene.track_set("grid", frame=rot, dtype="float64")
    for line in grid_lines:
        grid.add(line)
    # the clock channel t is stored on the ring, and the angle th only on the driver
    ring_set = scene.track_set("ring", frame=rot, dtype="float64")
    ring_set.add(ring, channels={"t": ring_t})
    scene.clock("value", channels=["t", "@index"], steps=8, range=[-1.0, 3.0])
    scene.view(
        "v",
        frame=inertial,
        driver=ty.driver(drv, 0),
        camera={"kind": "plane", "plane": "xy"},
        layers=[
            ty.track(grid, context="driver"),
            ty.track(ring_set, reveal="grow", head=True, before="hidden", context="driver"),
            ty.track(drv, head=True),
        ],
    )
    scene.panel("p1", "v")

    def pts_(m, x):
        return [list(map(float, m @ np.array([*p, 0.0]))) for p in x]

    def state(channel="t"):
        return {"variables": {}, "clock": {"channel": channel}, "panels": {"p1": {"view": "v"}}, "layout": {"kind": "panel", "id": "p1"}}

    cases = []
    # the value is v = -1 + 4 q, at which the driver's reading is v / 2, clamped to [0, 1], and the ring's reading is (v - 0.25) / 1.5,
    # hidden below 0
    for i, where in ((0, "below"), (3, "inside"), (7, "above")):
        v = -1.0 + 4.0 * i / 8
        k, w = _segment(t / 2.0, min(max(v / 2.0, 0.0), 1.0))
        m = (1.0 - w) * rz(th[k]) + w * rz(th[k + 1])
        u = (v - ring_t[0]) / (ring_t[-1] - ring_t[0])
        if u < 0.0:
            ring_member = {"index": 0, "line": [], "head": None}
        else:
            rk, rw = _segment((ring_t - ring_t[0]) / 1.5, min(u, 1.0))
            head = (1.0 - rw) * ring[rk] + rw * ring[rk + 1]
            line = [ring[s] for s in range(rk + 1)] + ([head] if rw > 0 else [])
            ring_member = {"index": 0, "line": pts_(m, line), "head": pts_(m, [head])[0]}
        cases.append(
            {
                "name": f"L6 and C3: at frame {i} the value is {where} the driver's span, the driver's reading is clamped to [0, 1], "
                "and the ring is hidden or clamped by its own reading",
                "source": "analytic",
                "state": state(),
                "frame_index": i,
                "tolerance": TOL,
                "expected": {
                    "panels": {
                        "p1": {
                            "frame": "inertial",
                            "layers": [
                                {
                                    "kind": "track",
                                    "set": "grid",
                                    "members": [{"index": j, "line": pts_(m, g)} for j, g in enumerate(grid_lines)],
                                },
                                {"kind": "track", "set": "ring", "members": [ring_member]},
                                None,
                            ],
                        }
                    }
                },
            }
        )
    doc, data = _write_scene("driver-context-value", scene, cases)
    for channel in ("t", "@index"):
        for i in range(-1, 9):
            st = state(channel)
            cases.append(
                {
                    "name": f"{channel}, frame {i}",
                    "source": "reference",
                    "state": st,
                    "frame_index": i,
                    "tolerance": TOL,
                    "expected": evaluate(doc, data, st, i),
                }
            )
    (HERE / "driver-context-value" / "cases.json").write_text(json.dumps(cases, indent=1) + "\n")
    print(f"driver-context-value: {len(cases)} cases with the reference ones")


def _arrow_doc(w, clock, track_sets, layers, views=("rot", "inertial")):
    """A scene document of arrow layers, drawn in the rotating frame and in an inertial frame that turns by the channel th."""
    return {
        "format": "tycho-scene",
        "version": "0.3",
        "requires": ["layers.arrows"],
        "generator": w.generator,
        "frames": {"rot": {}, "inertial": {"parent": "rot", "rotation": {"axis": "z", "angle": {"channel": "th"}}}},
        "track_sets": track_sets,
        "clock": clock,
        "views": {
            v: {"frame": v, "driver": {"sets": {"set": next(iter(track_sets))}, "member": {"index": 0}}, "layers": layers} for v in views
        },
        "initial": {
            "variables": {},
            "clock": {"channel": clock["channels"][0]},
            "panels": {v: {"view": v} for v in views},
            "layout": {
                "kind": "split",
                "dir": "row",
                "ratio": 0.5,
                "a": {"kind": "panel", "id": views[0]},
                "b": {"kind": "panel", "id": views[1]},
            },
        },
    }


def _arrow(P, V, th, k, w, scale, frame):
    """The base and the tip of rule L7 between samples k and k + 1 at weight w. In the inertial frame, each sample turns by its angle th."""
    R = [rz(a) if frame == "inertial" else np.eye(3) for a in th]
    base = (1.0 - w) * R[k] @ P[k] + w * R[k + 1] @ P[k + 1]
    tip = (1.0 - w) * R[k] @ (P[k] + scale * V[k]) + w * R[k + 1] @ (P[k + 1] + scale * V[k + 1])
    return list(map(float, base)), list(map(float, tip))


def arrows():
    """Arrow layers under a value clock: an arrow on a track, sticks shown in windows of the clock value, and a query matching no set."""
    w = ContainerWriter(generator=f"pytycho {pytycho.__version__}, spec/conformance/generate.py")
    vel_p = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [-1.0, 0.0, 0.0]])
    vel_v = np.array([[0.0, 1.0, 0.0], [-1.0, 0.0, 0.0], [0.0, -1.0, 0.0]])
    vel_t, vel_th = np.array([0.0, 1.0, 2.0]), np.array([0.0, 0.5, 1.5])
    w.add_view("vel/offsets", np.array([0, 3]), dtype="uint32")
    w.add_view("vel/positions", vel_p[:, :2])
    w.add_view("vel/t", vel_t)
    w.add_view("vel/th", vel_th)
    w.add_view("vel/vx", vel_v[:, 0])
    w.add_view("vel/vy", vel_v[:, 1])
    # each stick is a track of two samples with one position and one vector, shown while t lies in its window
    sticks = [((2.0, 0.0, 0.0), (0.0, 1.0, 0.5), (0.5, 1.0), (0.2, 0.4)), ((0.0, 2.0, 0.0), (1.0, 0.0, 0.5), (1.5, 2.0), (0.6, 1.0))]
    w.add_view("sticks/offsets", np.array([0, 2, 4]), dtype="uint32")
    w.add_view("sticks/positions", np.array([p for p, _, _, _ in sticks for _ in range(2)]))
    for j, name in enumerate(("vx", "vy", "vz")):
        w.add_view(f"sticks/{name}", np.array([v[j] for _, v, _, _ in sticks for _ in range(2)]))
    w.add_view("sticks/t", np.array([t for _, _, window, _ in sticks for t in window]))
    w.add_view("sticks/th", np.array([a for _, _, _, angles in sticks for a in angles]))

    def tset(sid, tracks, channels, attrs=None):
        spec = {
            "frame": "rot",
            "tags": {"g": sid},
            "tracks": tracks,
            "offsets": f"{sid}/offsets",
            "positions": f"{sid}/positions",
            "channels": {c: {"view": f"{sid}/{c}"} for c in channels},
            "periodic": False,
        }
        if attrs:
            spec["attrs"] = attrs
        return spec

    layers = [
        {"kind": "arrow", "sets": {"set": "vel"}, "members": "all", "vector": ["vx", "vy"], "scale": {"attr": "s"}},
        {
            "kind": "arrow",
            "sets": {"set": "sticks"},
            "members": "all",
            "vector": ["vx", "vy", "vz"],
            "scale": 0.25,
            "before": "hidden",
            "after": "hidden",
            "color": "#ffffff",
            "width": 1.8,
            "head": {"size": 12},
        },
        {"kind": "arrow", "sets": {"tags": {"g": "none"}}, "members": "all", "vector": ["vx", "vy"]},
    ]
    doc = _arrow_doc(
        w,
        {"mode": "value", "channels": ["t"], "steps": 8, "range": [0.0, 2.0]},
        {"vel": tset("vel", 1, ("t", "th", "vx", "vy"), {"s": 0.5}), "sticks": tset("sticks", 2, ("t", "th", "vx", "vy", "vz"))},
        layers,
    )
    cases = []
    for i in range(8):
        v = 0.25 * i
        panels = {}
        for frame in ("rot", "inertial"):
            k, wt = _segment(vel_t / 2.0, v / 2.0)
            base, tip = _arrow(vel_p, vel_v, vel_th, k, wt, 0.5, frame)
            members = []
            for j, (p, vec, (a, b), angles) in enumerate(sticks):
                if not a <= v <= b:
                    members.append({"index": j, "base": None, "tip": None})
                    continue
                P, V = np.array([p, p]), np.array([vec, vec])
                sb, st = _arrow(P, V, angles, 0, (v - a) / (b - a), 0.25, frame)
                members.append({"index": j, "base": sb, "tip": st})
            panels[frame] = {
                "frame": frame,
                "layers": [
                    {"kind": "arrow", "set": "vel", "members": [{"index": 0, "base": base, "tip": tip}]},
                    {"kind": "arrow", "set": "sticks", "members": members},
                    {"kind": "arrow", "set": None, "members": []},
                ],
            }
        cases.append(
            {
                "name": f"L7: at value {v}, the arrow at the reading of a track, and the sticks shown in their windows of t (C3)",
                "source": "analytic",
                "state": doc["initial"],
                "frame_index": i,
                "tolerance": TOL,
                "expected": {"panels": panels},
            }
        )

    def with_layer(patch):
        return {"views": {v: {"layers": [{**layers[0], **patch}, *layers[1:]]} for v in ("rot", "inertial")}}

    rejections = [
        {"name": "L7: @index in the vector of an arrow layer", "rule": "L7", "scene": with_layer({"vector": ["vx", "@index"]})},
        {"name": "L7: a vector channel that the set lacks", "rule": "L7", "scene": with_layer({"vector": ["vx", "vz"]})},
        {"name": "L7: a channel as the scale of an arrow layer", "rule": "L7", "scene": with_layer({"scale": {"channel": "t"}})},
        {
            "name": "C5: an arrow layer on a set without the clock channel",
            "rule": "C5",
            "scene": {"track_sets": {"sticks": {"channels": {"t": None}}}},
        },
    ]
    out = HERE / "arrows"
    out.mkdir(exist_ok=True)
    (out / "scene.tys").write_text(json.dumps(doc, indent=1) + "\n")
    w.write(out / "data.tyd")
    (out / "cases.json").write_text(json.dumps(cases, indent=1) + "\n")
    (out / "rejections.json").write_text(json.dumps(rejections, indent=1) + "\n")
    print(f"arrows: {len(cases)} cases, {len(rejections)} rejections")


def arrows_laps():
    """An arrow on a periodic loop over two laps of a fraction clock, whose vector channels are not raised by the lap (rules L7 and C6)."""
    w = ContainerWriter(generator=f"pytycho {pytycho.__version__}, spec/conformance/generate.py")
    P = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [-1.0, 0.0, 0.0], [0.0, -1.0, 0.0], [1.0, 0.0, 0.0]])
    # vx advances by 4 over the loop, which would be added to it in lap 1 if the vector were raised
    V = np.array([[0.0, 1.0, 0.0], [1.0, 1.0, 0.0], [2.0, 1.0, 0.0], [3.0, 1.0, 0.0], [4.0, 1.0, 0.0]])
    th = np.array([0.0, 0.5, 1.0, 1.5, 2.0])
    w.add_view("loop/offsets", np.array([0, 5]), dtype="uint32")
    w.add_view("loop/positions", P[:, :2])
    w.add_view("loop/th", th)
    w.add_view("loop/vx", V[:, 0])
    w.add_view("loop/vy", V[:, 1])
    track_sets = {
        "loop": {
            "frame": "rot",
            "tracks": 1,
            "offsets": "loop/offsets",
            "positions": "loop/positions",
            "channels": {c: {"view": f"loop/{c}"} for c in ("th", "vx", "vy")},
            "periodic": True,
        }
    }
    layers = [{"kind": "arrow", "sets": {"set": "loop"}, "members": {"index": 0}, "vector": ["vx", "vy"], "scale": 0.5}]
    doc = _arrow_doc(w, {"mode": "fraction", "channels": ["@index"], "steps": 10, "laps": 2}, track_sets, layers)
    ui = np.arange(5) / 4.0
    cases = []
    for i in range(10):
        loop_reading = 2.0 * i / 10
        lap = min(int(np.floor(loop_reading)), 1)
        k, wt = _segment(ui, loop_reading - lap)
        panels = {}
        for frame in ("rot", "inertial"):
            base, tip = _arrow(P, V, th + lap * (th[-1] - th[0]), k, wt, 0.5, frame)
            panels[frame] = {
                "frame": frame,
                "layers": [{"kind": "arrow", "set": "loop", "members": [{"index": 0, "base": base, "tip": tip}]}],
            }
        cases.append(
            {
                "name": f"L7 and C6: at frame {i}, lap {lap}, the edge angle is raised by the lap and the vector is not",
                "source": "analytic",
                "state": doc["initial"],
                "frame_index": i,
                "tolerance": TOL,
                "expected": {"panels": panels},
            }
        )
    rejections = [
        {
            "name": "C6: an arrow layer on a set that is not periodic, under two laps",
            "rule": "C6",
            "scene": {"track_sets": {"loop": {"periodic": False}}},
        },
    ]
    out = HERE / "arrows-laps"
    out.mkdir(exist_ok=True)
    (out / "scene.tys").write_text(json.dumps(doc, indent=1) + "\n")
    w.write(out / "data.tyd")
    (out / "cases.json").write_text(json.dumps(cases, indent=1) + "\n")
    (out / "rejections.json").write_text(json.dumps(rejections, indent=1) + "\n")
    print(f"arrows-laps: {len(cases)} cases, {len(rejections)} rejections")


def outlines():
    """Outline layers under a value clock, from a magnified frame whose origin and scale are driver channels (rules L8 and F2)."""
    w = ContainerWriter(generator=f"pytycho {pytycho.__version__}, spec/conformance/generate.py")
    P = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [-1.0, 0.5, 0.0]])
    t = np.array([0.0, 1.0, 2.0])
    # the frame zoom is magnified k times about the middle (mx, my), and the frame inertial turns by th
    mx, my, k, th = np.array([0.5, 0.0, -0.5]), np.array([0.0, 0.25, 0.5]), np.array([2.0, 4.0, 10.0]), np.array([0.0, 0.5, 1.5])
    w.add_view("drv/offsets", np.array([0, 3]), dtype="uint32")
    w.add_view("drv/positions", P[:, :2])
    for name, values in (("t", t), ("mx", mx), ("my", my), ("k", k), ("th", th)):
        w.add_view(f"drv/{name}", values)
    outline = {"kind": "outline", "view": "closeup", "color": "#ffffff", "opacity": 0.5, "width": 1.5, "dash": [4, 3], "min_size": 12}
    drawn = {"kind": "track", "sets": {"set": "drv"}, "members": "all"}

    def view(frame, layers, driver=None):
        return {"frame": frame, "driver": {"sets": driver or {"set": "drv"}, "member": {"index": 0}}, "layers": layers}

    doc = {
        "format": "tycho-scene",
        "version": "0.3",
        "requires": ["layers.outline", "frames.origin_channel"],
        "generator": w.generator,
        "frames": {
            "rot": {},
            "zoom": {"parent": "rot", "origin": [{"channel": "mx"}, {"channel": "my"}, 0.0], "scale": {"channel": "k"}},
            "inertial": {"parent": "rot", "rotation": {"axis": "z", "angle": {"channel": "th"}}},
        },
        "track_sets": {
            "drv": {
                "frame": "rot",
                "tags": {"g": "drv"},
                "tracks": 1,
                "offsets": "drv/offsets",
                "positions": "drv/positions",
                "channels": {c: {"view": f"drv/{c}"} for c in ("t", "mx", "my", "k", "th")},
                "periodic": False,
            }
        },
        "clock": {"mode": "value", "channels": ["t"], "steps": 8, "range": [0.0, 2.0]},
        "views": {
            "rot": view("rot", [drawn, outline]),
            "inertial": view("inertial", [drawn, outline]),
            "closeup": {**view("zoom", [drawn]), "camera": {"kind": "plane", "plane": "xy"}},
            "lost": view("rot", [outline], {"tags": {"g": "none"}}),
        },
    }

    def state(panels, layout):
        return {"variables": {}, "clock": {"channel": "t"}, "panels": {pid: {"view": v} for pid, v in panels.items()}, "layout": layout}

    def leaf(pid):
        return {"kind": "panel", "id": pid}

    def row(a, b):
        return {"kind": "split", "dir": "row", "ratio": 0.5, "a": a, "b": b}

    doc["initial"] = state(
        {"rot": "rot", "inertial": "inertial", "closeup": "closeup"}, row(leaf("rot"), row(leaf("inertial"), leaf("closeup")))
    )

    def mapped(frame, i):
        """The images of the origin and the unit points of zoom in frame, in the context of sample i (rule F1)."""
        R = rz(th[i]) if frame == "inertial" else np.eye(3)
        o = np.array([mx[i], my[i], 0.0])
        return R @ o, [R @ e / k[i] for e in np.eye(3)]

    def expected_outline(frame, v, panel="closeup"):
        s, wt = _segment(t / 2.0, v / 2.0)
        (oa, xa), (ob, xb) = mapped(frame, s), mapped(frame, s + 1)
        origin = (1.0 - wt) * oa + wt * ob
        axes = [list(map(float, (1.0 - wt) * a + wt * b)) for a, b in zip(xa, xb, strict=True)]
        return {"kind": "outline", "view": "closeup", "panel": panel, "frame": "zoom", "origin": list(map(float, origin)), "axes": axes}

    def line(frame):
        if frame == "zoom":
            return [list(map(float, k[i] * (P[i] - np.array([mx[i], my[i], 0.0])))) for i in range(3)]
        return [list(map(float, (rz(th[i]) if frame == "inertial" else np.eye(3)) @ P[i])) for i in range(3)]

    def track(frame):
        return {"kind": "track", "set": "drv", "members": [{"index": 0, "line": line(frame)}]}

    cases = []
    for i in range(8):
        v = 0.25 * i
        panels = {f: {"frame": f, "layers": [track(f), expected_outline(f, v)]} for f in ("rot", "inertial")}
        panels["closeup"] = {"frame": "zoom", "layers": [track("zoom")]}
        cases.append(
            {
                "name": f"L8 and F2: at value {v}, the map from the frame zoom, whose edge reads driver channels, blended at the reading",
                "source": "analytic",
                "state": doc["initial"],
                "frame_index": i,
                "tolerance": TOL,
                "expected": {"panels": panels},
            }
        )
    absent = {"kind": "outline", "view": "closeup", "panel": None, "frame": None, "origin": None, "axes": None}
    cases.append(
        {
            "name": "L8: the layout does not show the view closeup, hence the outline does not have a target panel",
            "source": "analytic",
            "state": state({"rot": "rot"}, leaf("rot")),
            "frame_index": 3,
            "tolerance": TOL,
            "expected": {"panels": {"rot": {"frame": "rot", "layers": [track("rot"), absent]}}},
        }
    )
    cases.append(
        {
            "name": "L8: two panels show the view closeup, and the target panel is the first in layout order",
            "source": "analytic",
            "state": state({"rot": "rot", "zb": "closeup", "za": "closeup"}, row(leaf("rot"), row(leaf("zb"), leaf("za")))),
            "frame_index": 5,
            "tolerance": TOL,
            "expected": {"panels": {"rot": {"frame": "rot", "layers": [track("rot"), expected_outline("rot", 1.25, "zb")]}}},
        }
    )
    cases.append(
        {
            "name": "L8: the driver's set query does not match any set, hence the map is null",
            "source": "analytic",
            "state": state({"lost": "lost", "closeup": "closeup"}, row(leaf("lost"), leaf("closeup"))),
            "frame_index": 2,
            "tolerance": TOL,
            "expected": {"panels": {"lost": {"frame": "rot", "layers": [{**absent, "panel": "closeup", "frame": "zoom"}]}}},
        }
    )

    def with_outline(patch):
        return {"views": {"rot": {"layers": [drawn, {**outline, **patch}]}}}

    rejections = [
        {"name": "L8: an outline layer names a view that is not declared", "rule": "L8", "scene": with_outline({"view": "nowhere"})},
        {"name": "L8: an outline layer names the view that holds it", "rule": "L8", "scene": with_outline({"view": "rot"})},
        {
            "name": "L8: an outline layer names a view with an orbit camera",
            "rule": "L8",
            "scene": {"views": {"closeup": {"camera": {"kind": "orbit"}}}},
        },
        {
            "name": "F5: the driver's set lacks a channel of the origin of the frame zoom",
            "rule": "F5",
            "scene": {"track_sets": {"drv": {"channels": {"my": None}}}},
        },
        {
            "name": "2.2: @index in the origin of a frame",
            "rule": "2.2",
            "scene": {"frames": {"zoom": {"origin": [{"channel": "@index"}, {"channel": "my"}, 0.0]}}},
        },
    ]
    out = HERE / "outlines"
    out.mkdir(exist_ok=True)
    (out / "scene.tys").write_text(json.dumps(doc, indent=1) + "\n")
    w.write(out / "data.tyd")
    (out / "cases.json").write_text(json.dumps(cases, indent=1) + "\n")
    (out / "rejections.json").write_text(json.dumps(rejections, indent=1) + "\n")
    print(f"outlines: {len(cases)} cases, {len(rejections)} rejections")


def timeline():
    """Clock keys with every ease, a jump and a hold, a layer clock on another channel, points revealed by two clocks, labels at a point,
    at a point of a turning frame, at members and on the screen, and two cameras with keys, one following the midpoint of two members
    and a member under a layer clock, and one of a free aspect with heights (section 2.11)."""
    import pytycho as ty

    scene = ty.Scene(title="the timeline")
    root = scene.frame("root")
    scene.frame("spin", parent=root, rotation=ty.rotation("z", ty.channel("t")))
    a = scene.track_set("a", frame=root, dtype="float64")
    t = np.arange(9.0)
    for y in (0.0, 2.0):
        a.add(np.column_stack([t, np.full(9, y)]), channels={"t": t, "tau": 10.0 - t})
    pts = scene.track_set("pts", frame=root, dtype="float64")
    pts.add(np.column_stack([np.arange(5.0), np.full(5, -1.0)]), channels={"t": np.arange(1.0, 6.0)})
    # one loop of 10 s in 20 steps, hence frame index i is at s = i / 2
    clock_keys = [(1, 0), (3, 2, "smooth"), (5, 2), (5, 3), (7, 4, "in-out"), (8, 6, "hold"), (9, 8, "out")]
    scene.clock("value", channels=["t"], steps=20, seconds=10.0, keys=clock_keys)
    tau = ty.layer_clock("tau", keys=[(0, 10), (10, 0, "in")])
    layers = [
        ty.track(a, reveal="grow", head=True),
        ty.track(a, reveal="grow", head=True, clock=tau),
        ty.points(pts, reveal="grow", before="hidden"),
        ty.points(pts, reveal="grow", clock=ty.layer_clock("@index", range=[0.0, 4.0])),
        ty.label("fixed", ty.at_point(1.0, 2.0)),
        ty.label("turning", ty.at_point(1.0, 0.0, frame="spin")),
        ty.label("member 1", ty.at_member(a, 1)),
        ty.label("screen", ty.at_screen(0.5, 0.1)),
        ty.label("member 0 by tau", ty.at_member(a, 0), clock=tau),
    ]
    camera = {
        "kind": "plane",
        "keys": [
            ty.shot(1.0, center=(0.0, 0.0), width=2.0),
            ty.shot(3.0, follow=[ty.follow(0, 0), ty.follow(0, 1)], offset=(0.5, 0.0), width=4.0, ease="smooth"),
            ty.shot(6.0, follow=ty.follow(1, 0), width=4.0, ease="in-out"),
            ty.shot(8.0, center=(4.0, 1.0), width=8.0, ease="linear"),
        ],
    }
    scene.view("main", frame=root, driver=ty.driver(a, 0), layers=layers, camera=camera)
    plot = {
        "kind": "plane",
        "aspect": "free",
        "keys": [ty.shot(0.0, center=(0.0, 0.0), width=2.0, height=1.0), ty.shot(10.0, center=(4.0, 2.0), width=8.0, height=4.0)],
    }
    scene.view("plot", frame=root, driver=ty.driver(a, 0), layers=[ty.track(a, 0)], camera=plot)
    scene.panel("p1", "main")
    scene.panel("p2", "plot")
    doc, data = scene.to_document(), scene.to_container()
    state = doc["initial"]

    def P(*xyz):
        return [float(x) for x in xyz]

    def smooth(x):
        return x * x * (3.0 - 2.0 * x)

    cases = []
    # s = 2: the clock is halfway along a smooth segment from 0 to 2, hence t = 1. tau runs 10 - 10 x^3 with x = 0.2, i.e. 9.92,
    # and t = 0.08 on the tau clock. the driver reads t = 1 exactly, where the frame spin is turned by 1 rad
    e = smooth(0.5)
    mid = (1.5, 1.0)
    cases.append(
        {
            "name": "K1 to K8: at s = 2, a smooth clock key, a layer clock, points, labels, and a blend into a follow key",
            "source": "analytic",
            "state": state,
            "frame_index": 4,
            "tolerance": TOL,
            "expected": {
                "panels": {
                    "p1": {
                        "frame": "root",
                        "layers": [
                            {
                                "kind": "track",
                                "set": "a",
                                "members": [
                                    {"index": 0, "line": [P(0, 0, 0), P(1, 0, 0)], "head": P(1, 0, 0)},
                                    {"index": 1, "line": [P(0, 2, 0), P(1, 2, 0)], "head": P(1, 2, 0)},
                                ],
                            },
                            {
                                "kind": "track",
                                "set": "a",
                                "members": [
                                    {"index": 0, "line": [P(0, 0, 0), P(0.08, 0, 0)], "head": P(0.08, 0, 0)},
                                    {"index": 1, "line": [P(0, 2, 0), P(0.08, 2, 0)], "head": P(0.08, 2, 0)},
                                ],
                            },
                            {"kind": "points", "set": "pts", "members": [{"index": 0, "points": [P(0, -1, 0)]}]},
                            {"kind": "points", "set": "pts", "members": [{"index": 0, "points": [P(0, -1, 0)]}]},
                            {"kind": "label", "position": P(1, 2, 0)},
                            {"kind": "label", "position": P(np.cos(1.0), -np.sin(1.0), 0)},
                            {"kind": "label", "position": P(1, 2, 0)},
                            {"kind": "label", "position": None},
                            {"kind": "label", "position": P(0.08, 0, 0)},
                        ],
                        "camera": {
                            "center": [(1 - e) * 0.0 + e * mid[0], (1 - e) * 0.0 + e * mid[1]],
                            "width": np.sqrt(8.0),
                            "height": None,
                        },
                    },
                    # the free camera eases smoothly from a window of 2 by 1 to one of 8 by 4 over the loop, at x = 0.2,
                    # and the zoom is geometric
                    "p2": {
                        "frame": "root",
                        "camera": {
                            "center": [4.0 * smooth(0.2), 2.0 * smooth(0.2)],
                            "width": 2.0 * 4.0 ** smooth(0.2),
                            "height": 1.0 * 4.0 ** smooth(0.2),
                        },
                    },
                }
            },
        }
    )
    # s = 5: the clock jumps from 2 to 3. the camera blends the follow key at 3 s, the midpoint of the heads at t = 3 plus the offset,
    # into the follow key at 6 s, the head of member 0 under the tau clock at tau = 10 - 10 / 8 = 8.75, i.e. t = 1.25, by in-out at x = 2/3
    y = 2.0 - 2.0 * (2.0 / 3.0)
    e = 1.0 - y * y * y / 2.0
    c1, c2 = (3.5, 1.0), (1.25, 0.0)
    cases.append(
        {
            "name": "K1, K2, K5: at s = 5, a jump of the clock, and an in-out blend between two follow keys",
            "source": "analytic",
            "state": state,
            "frame_index": 10,
            "tolerance": TOL,
            "expected": {
                "panels": {
                    "p1": {
                        "frame": "root",
                        "layers": [
                            {
                                "kind": "track",
                                "set": "a",
                                "members": [
                                    {"index": 0, "line": [P(i, 0, 0) for i in range(4)], "head": P(3, 0, 0)},
                                    {"index": 1, "line": [P(i, 2, 0) for i in range(4)], "head": P(3, 2, 0)},
                                ],
                            },
                            None,
                            {"kind": "points", "set": "pts", "members": [{"index": 0, "points": [P(0, -1, 0), P(1, -1, 0), P(2, -1, 0)]}]},
                            {"kind": "points", "set": "pts", "members": [{"index": 0, "points": [P(0, -1, 0), P(1, -1, 0), P(2, -1, 0)]}]},
                            None,
                            {"kind": "label", "position": P(np.cos(3.0), -np.sin(3.0), 0)},
                            {"kind": "label", "position": P(3, 2, 0)},
                            None,
                            {"kind": "label", "position": P(1.25, 0, 0)},
                        ],
                        "camera": {"center": [(1 - e) * c1[0] + e * c2[0], (1 - e) * c1[1] + e * c2[1]], "width": 4.0, "height": None},
                    }
                }
            },
        }
    )
    # s = 0: before the first clock key t = 0, before the first points sample, which is hidden, and before the first camera key
    cases.append(
        {
            "name": "K1, K5, K8: at s = 0, before the first keys, and a points member hidden before its range",
            "source": "analytic",
            "state": state,
            "frame_index": 0,
            "tolerance": TOL,
            "expected": {
                "panels": {
                    "p1": {
                        "frame": "root",
                        "layers": [
                            None,
                            None,
                            {"kind": "points", "set": "pts", "members": [{"index": 0, "points": []}]},
                            {"kind": "points", "set": "pts", "members": [{"index": 0, "points": [P(0, -1, 0)]}]},
                            None,
                            {"kind": "label", "position": P(1, 0, 0)},
                            {"kind": "label", "position": P(0, 2, 0)},
                            None,
                            {"kind": "label", "position": P(0, 0, 0)},
                        ],
                        "camera": {"center": [0.0, 0.0], "width": 2.0, "height": None},
                    },
                    "p2": {"frame": "root", "camera": {"center": [0.0, 0.0], "width": 2.0, "height": 1.0}},
                }
            },
        }
    )
    # s = 9.5: after the last clock key t = 8, every points sample, and the window of the last camera key
    cases.append(
        {
            "name": "K1, K5, K8: at s = 9.5, after the last keys",
            "source": "analytic",
            "state": state,
            "frame_index": 19,
            "tolerance": TOL,
            "expected": {
                "panels": {
                    "p1": {
                        "frame": "root",
                        "layers": [
                            None,
                            None,
                            {"kind": "points", "set": "pts", "members": [{"index": 0, "points": [P(i, -1, 0) for i in range(5)]}]},
                            None,
                            None,
                            None,
                            {"kind": "label", "position": P(8, 2, 0)},
                            None,
                            None,
                        ],
                        "camera": {"center": [4.0, 1.0], "width": 8.0, "height": None},
                    }
                }
            },
        }
    )
    for i in range(-1, 21):
        cases.append(
            {
                "name": f"frame {i}",
                "source": "reference",
                "state": state,
                "frame_index": i,
                "tolerance": TOL,
                "expected": evaluate(doc, data, state, i),
            }
        )

    def with_layers(**changes):
        main = copy.deepcopy(doc["views"]["main"]["layers"])
        for index, layer in changes.items():
            main[int(index[1:])] = layer
        return {"views": {"main": {"layers": main}}}

    def with_keys(i, **changes):
        keys = copy.deepcopy(doc["views"]["main"]["camera"]["keys"])
        keys[i].update(changes)
        return {"views": {"main": {"camera": {"keys": keys}}}}

    tau_layer = doc["views"]["main"]["layers"][1]
    rejections = [
        {"name": "K1: clock keys whose times decrease", "rule": "K1", "scene": {"clock": {"keys": [[2.0, 0.0], [1.0, 1.0]]}}},
        {
            "name": "K2: a clock key with an ease that is not defined",
            "rule": "K2",
            "scene": {"clock": {"keys": [[0.0, 0.0], [1.0, 1.0, "bounce"]]}},
        },
        {"name": "K3: a value clock with both a range and keys", "rule": "K3", "scene": {"clock": {"range": [0.0, 8.0]}}},
        {"name": "K3: a fraction clock with keys", "rule": "K3", "scene": {"clock": {"mode": "fraction"}}},
        {
            "name": "K4: a layer clock with both a range and keys",
            "rule": "K4",
            "scene": with_layers(l1={**tau_layer, "clock": {**tau_layer["clock"], "range": [10.0, 0.0]}}),
        },
        {
            "name": "C5: a layer clock on a channel that the layer's set lacks",
            "rule": "C5",
            "scene": with_layers(l1={**tau_layer, "clock": {"channel": "nope", "range": [0.0, 1.0]}}),
        },
        {"name": "K5: camera keys whose times decrease", "rule": "K5", "scene": with_keys(3, at=0.5)},
        {"name": "K5: a camera key follows a points layer", "rule": "K5", "scene": with_keys(2, follow=[{"layer": 2, "member": 0}])},
        {
            "name": "K5: a camera key follows a member past the track count",
            "rule": "K5",
            "scene": with_keys(2, follow=[{"layer": 1, "member": 5}]),
        },
        {"name": "K2: a camera key with an ease that is not defined", "rule": "K2", "scene": with_keys(1, ease="bounce")},
        {
            "name": "K6: a label at a member past the track count",
            "rule": "K6",
            "scene": with_layers(l6={"kind": "label", "text": "member 7", "at": {"sets": {"set": "a"}, "member": 7}}),
        },
        {
            "name": "K8: a points layer whose reveal is trail",
            "rule": "K8",
            "scene": with_layers(l2={"kind": "points", "sets": {"set": "pts"}, "members": "all", "reveal": "trail"}),
        },
    ]
    out = HERE / "timeline"
    out.mkdir(exist_ok=True)
    (out / "scene.tys").write_text(json.dumps(doc, indent=1) + "\n")
    (out / "data.tyd").write_bytes(data)
    (out / "cases.json").write_text(json.dumps(cases, indent=1) + "\n")
    (out / "rejections.json").write_text(json.dumps(rejections, indent=1) + "\n")
    print(f"timeline: {len(cases)} cases with the reference ones, {len(rejections)} rejections")


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
    edge_fraction()
    edge_value()
    laps()
    driver_context()
    driver_context_laps()
    driver_context_value()
    arrows()
    arrows_laps()
    outlines()
    timeline()
    containers()
