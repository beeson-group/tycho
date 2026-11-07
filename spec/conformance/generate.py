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
        {"name": "S1: a layer kind that is not implemented", "rule": "S1", "scene": {"views": {"open": {"layers": [{"kind": "points"}]}}}},
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
    containers()
