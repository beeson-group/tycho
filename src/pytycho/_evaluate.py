"""The NumPy evaluator of a TyCHO scene, section 3 of ``spec/tycho-scene.md``.

The evaluator is the reference for the behavior that TyCHO defines, i.e. the edge equation of the frame tree, the
clock reading, the blend between two stored samples, the trail, and the laps of a periodic track. It does not hold
the frame formula of any dynamical model. Every frame is instead the generic edge ``p_child = s * R * (p_parent - o)``
of rule F1. The scale ``s`` and the angle of the rotation ``R`` are each a number, a track set attribute, or a per-sample
channel, and the origin ``o`` is three numbers or attributes, or the position of a body (rule F2). The TypeScript
evaluator in ``web/`` is the second implementation, and both must reproduce every case of the conformance corpus in
``spec/conformance/``. Every computation runs in float64.

:meth:`pytycho.TrackSet.thin` also uses :class:`FrameTree` to measure arclength in frames other than
the frame of the track set.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Iterable, Mapping
from typing import Any

import numpy as np

from .container import Container

INDEX = "@index"


class EvaluationError(ValueError):
    """A scene, a state, or a data container that the evaluator cannot evaluate."""


# contexts and scalars


class Context:
    """The context of rule 2.2 for ``n`` points at once, made of one track set, one track, and one sample per point.

    ``attrs`` are the track set's attributes. ``channel(name)`` returns the channel's value at each
    point's sample, already raised by the channel's advance times the lap of rule C6.
    """

    __slots__ = ("_channel", "attrs", "n")

    def __init__(self, attrs: Mapping[str, float], channel: Callable[[str], np.ndarray | None], n: int) -> None:
        self.attrs = attrs
        self.n = n
        self._channel = channel

    def channel(self, name: str) -> np.ndarray:
        values = self._channel(name)
        if values is None:
            raise EvaluationError(f"F5: the context's track set lacks channel {name!r}")
        return values

    def attr(self, name: str) -> float:
        try:
            return float(self.attrs[name])
        except KeyError:
            raise EvaluationError(f"F5: the context's track set lacks attribute {name!r}") from None


def _number(value: Any, what: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise EvaluationError(f"{what} is {value!r}, not a number")
    if not math.isfinite(value):
        raise EvaluationError(f"S4: {what} is {value!r}, not finite")
    return float(value)


def scalar(spec: Any, ctx: Context) -> float | np.ndarray:
    """The value of a number, an attribute, or a channel (section 2.2) in ``ctx``."""
    if isinstance(spec, Mapping) and "attr" in spec:
        return _number(spec.get("factor", 1.0), "a factor") * ctx.attr(spec["attr"]) + _number(spec.get("offset", 0.0), "an offset")
    if isinstance(spec, Mapping) and "channel" in spec:
        if spec["channel"] == INDEX:
            raise EvaluationError(f"2.2: {INDEX} is not allowed in a frame edge")
        return ctx.channel(spec["channel"])
    return _number(spec, "a scalar")


def _point(spec: Any, ctx: Context) -> np.ndarray:
    """A list of three constant scalars, as an ``(n, 3)`` array (rules F2 and 2.4)."""
    if not isinstance(spec, list) or len(spec) != 3:
        raise EvaluationError(f"F2: an origin or a position is three scalars, not {spec!r}")
    out = np.empty((ctx.n, 3))
    for j, value in enumerate(spec):
        if isinstance(value, Mapping) and "channel" in value:
            raise EvaluationError("F2: an origin or a position takes a number or an attribute, not a channel")
        out[:, j] = scalar(value, ctx)
    return out


# the frame tree


class FrameTree:
    """The frames and bodies of a scene document, and the transforms between frames (rules F1 to F3 and F6)."""

    def __init__(self, frames: Mapping[str, Any], bodies: Mapping[str, Any] | None = None) -> None:
        self.frames = frames
        self.bodies = bodies or {}
        roots = [fid for fid, f in frames.items() if "parent" not in f]
        if len(roots) != 1:
            raise EvaluationError(f"2.3: the frames have {len(roots)} roots, not one: {roots}")
        self.root = roots[0]
        for fid in frames:
            self.ancestors(fid)
        root = frames[self.root]
        if any(k in root for k in ("origin", "rotation", "scale")):
            raise EvaluationError(f"2.3: the root frame {self.root!r} has an origin, a rotation, or a scale")
        for fid, frame in frames.items():
            scale = frame.get("scale")
            if scale == 0 or (
                isinstance(scale, Mapping) and "attr" in scale and scale.get("factor", 1) == 0 and scale.get("offset", 0) == 0
            ):
                raise EvaluationError(f"F2: the scale of frame {fid!r} is zero")
        for fid in frames:
            # rule F6 is checked at load, whatever is drawn
            self.requirements(fid, self.root)

    def ancestors(self, fid: str) -> list[str]:
        """The frame ``fid`` and its ancestors, up to the root."""
        chain = [fid]
        while "parent" in self._frame(chain[-1]):
            parent = self._frame(chain[-1])["parent"]
            if parent in chain:
                raise EvaluationError(f"2.3: the parents of frame {fid!r} form a cycle")
            chain.append(parent)
        return chain

    def _frame(self, fid: str) -> Mapping[str, Any]:
        try:
            return self.frames[fid]
        except KeyError:
            raise EvaluationError(f"2.3: frame {fid!r} is not declared") from None

    def path(self, src: str, dst: str) -> tuple[list[str], list[str]]:
        """The edges from ``src`` to ``dst`` (rule F3), each identified by its child frame.

        The first list holds the edges applied inversely, from ``src`` up to the lowest common
        ancestor. The second holds those applied forward, from below this ancestor down to ``dst``.
        """
        up, down = self.ancestors(src), self.ancestors(dst)
        common = next(f for f in up if f in down)
        return up[: up.index(common)], list(reversed(down[: down.index(common)]))

    def transform(self, points: np.ndarray, src: str, dst: str, ctx: Context, _stack: tuple[str, ...] = ()) -> np.ndarray:
        """Takes ``(n, 3)`` points from frame ``src`` to frame ``dst``, each point in its context."""
        p = np.array(points, dtype=np.float64, copy=True).reshape(ctx.n, 3)
        up, down = self.path(src, dst)
        for fid in up:
            o, axis, angle, s = self._edge(fid, ctx, _stack)
            p = p / s
            if axis is not None and angle is not None:
                p = _rotate(p, axis, angle, inverse=True)
            p = o + p
        for fid in down:
            o, axis, angle, s = self._edge(fid, ctx, _stack)
            p = p - o
            if axis is not None and angle is not None:
                p = _rotate(p, axis, angle, inverse=False)
            p = s * p
        return p

    def body_position(self, body: str, frame: str, ctx: Context, _stack: tuple[str, ...] = ()) -> np.ndarray:
        """The position of the body in ``frame`` at every point of ``ctx``, as an ``(n, 3)`` array."""
        try:
            spec = self.bodies[body]
        except KeyError:
            raise EvaluationError(f"2.4: body {body!r} is not declared") from None
        return self.transform(_point(spec.get("position"), ctx), spec["frame"], frame, ctx, _stack)

    def _edge(self, fid: str, ctx: Context, stack: tuple[str, ...]):
        frame = self._frame(fid)
        origin = frame.get("origin")
        if origin is None:
            o: Any = 0.0
        elif isinstance(origin, Mapping):
            if fid in stack:
                raise EvaluationError(f"F6: the origin of frame {fid!r} depends on itself")
            o = self.body_position(origin["body"], frame["parent"], ctx, (*stack, fid))
        else:
            o = _point(origin, ctx)
        rotation = frame.get("rotation")
        axis = angle = None
        if rotation is not None:
            axis = rotation["axis"]
            angle = np.broadcast_to(np.asarray(scalar(rotation["angle"], ctx), dtype=np.float64), (ctx.n,))[:, None]
        s = frame.get("scale")
        s = 1.0 if s is None else np.broadcast_to(np.asarray(scalar(s, ctx), dtype=np.float64), (ctx.n,))[:, None]
        if np.any(np.asarray(s) == 0.0):
            raise EvaluationError(f"F2: the scale of frame {fid!r} is zero")
        return o, axis, angle, s

    def requirements(self, src: str, dst: str, _stack: tuple[str, ...] = ()) -> tuple[set[str], set[str]]:
        """The channels and attributes that a context must carry to take a point from ``src`` to ``dst`` (rule F5).

        For an origin at a body, the result also holds the attributes of the body's position and the requirements of
        the path from the body's frame to the edge's parent frame. Raises when an origin depends on itself (rule F6).
        """
        channels: set[str] = set()
        attrs: set[str] = set()
        up, down = self.path(src, dst)
        for fid in up + down:
            frame = self._frame(fid)
            for spec in (frame.get("rotation", {}).get("angle"), frame.get("scale")):
                _collect(spec, channels, attrs)
            origin = frame.get("origin")
            if isinstance(origin, Mapping):
                if fid in _stack:
                    raise EvaluationError(f"F6: the origin of frame {fid!r} depends on itself")
                c, a = self.body_requirements(origin["body"], frame["parent"], (*_stack, fid))
                channels |= c
                attrs |= a
            elif origin is not None:
                for spec in origin:
                    _collect(spec, channels, attrs)
        return channels, attrs

    def body_requirements(self, body: str, frame: str, _stack: tuple[str, ...] = ()) -> tuple[set[str], set[str]]:
        """The channels and attributes needed for the body's position in ``frame``."""
        spec = self.bodies.get(body)
        if spec is None:
            raise EvaluationError(f"2.4: body {body!r} is not declared")
        if spec.get("frame") not in self.frames:
            raise EvaluationError(f"2.4: body {body!r} is in frame {spec.get('frame')!r}, which is not declared")
        channels, attrs = self.requirements(spec["frame"], frame, _stack)
        position = spec.get("position")
        if not isinstance(position, list) or len(position) != 3:
            raise EvaluationError(f"2.4: the position of body {body!r} is three scalars, not {position!r}")
        for value in position:
            _collect(value, channels, attrs)
        return channels, attrs


def _collect(spec: Any, channels: set[str], attrs: set[str]) -> None:
    if isinstance(spec, Mapping):
        if "attr" in spec:
            attrs.add(spec["attr"])
        elif "channel" in spec:
            channels.add(spec["channel"])


def _rotate(p: np.ndarray, axis: str, angle: np.ndarray, *, inverse: bool) -> np.ndarray:
    """Returns ``R p``, or ``R^T p`` when ``inverse``, where ``R`` is the right-handed rotation by ``angle`` about ``axis`` (rule F1)."""
    c, s = np.cos(angle), np.sin(angle)
    if inverse:
        s = -s
    x, y, z = p[:, 0:1], p[:, 1:2], p[:, 2:3]
    if axis == "z":
        return np.hstack([c * x - s * y, s * x + c * y, z])
    if axis == "x":
        return np.hstack([x, c * y - s * z, s * y + c * z])
    if axis == "y":
        return np.hstack([c * x + s * z, y, -s * x + c * z])
    raise EvaluationError(f"rotation axis {axis!r} is not x, y, or z")


# track data


class Track:
    """One track of a track set, with its positions as an ``(m, 3)`` array, its channels, and the attributes of its track set."""

    def __init__(self, positions: np.ndarray, channels: Mapping[str, np.ndarray], attrs: Mapping[str, float], periodic: bool) -> None:
        self.positions = positions
        self.channels = channels
        self.attrs = attrs
        self.periodic = periodic
        self.m = len(positions)

    def channel(self, name: str) -> np.ndarray | None:
        if name == INDEX:
            return np.arange(self.m, dtype=np.float64)
        return self.channels.get(name)

    def context(self, lap: int = 0) -> Context:
        """The context of every sample in lap ``lap`` of rule C6. Lap -1 is the shifted context of rule L2."""

        return Context(self.attrs, lambda name: _raised(self.channel(name), lap), self.m)

    def sample_context(self, lap: int, sample: int, n: int) -> Context:
        """The context of sample ``sample`` in lap ``lap``, repeated for ``n`` points.

        A layer in the driver's context reads its points in this context (rule L6).
        """

        def channel(name: str) -> np.ndarray | None:
            values = _raised(self.channel(name), lap)
            return None if values is None else np.full(n, values[sample])

        return Context(self.attrs, channel, n)

    def clock_values(self, name: str) -> np.ndarray:
        """The clock channel's values along the track, checked against rule T3."""
        if name == INDEX:
            return np.arange(self.m, dtype=np.float64)
        c = self.channel(name)
        if c is None:
            raise EvaluationError(f"C5: the track lacks clock channel {name!r}")
        d = np.diff(c)
        if not np.all(np.isfinite(c)) or not (np.all(d > 0) or np.all(d < 0)) or not np.isfinite(c[-1] - c[0]):
            raise EvaluationError(f"T3: clock channel {name!r} is not strictly monotone with a finite span along a track")
        return c

    def sample_readings(self, name: str) -> np.ndarray:
        """The sample readings ``u_i`` of rule C1 for clock channel ``name``."""
        c = self.clock_values(name)
        return (c - c[0]) / (c[-1] - c[0])


def _raised(values: np.ndarray | None, lap: int) -> np.ndarray | None:
    """A channel's values raised by ``lap`` times its advance over one period (rule C6)."""
    if values is None or lap == 0:
        return values
    return values + lap * (values[-1] - values[0])


class SetData:
    """A track set of the scene document, read from the container as float64."""

    def __init__(self, sid: str, spec: Mapping[str, Any], container: Container) -> None:
        self.id = sid
        self.spec = spec
        if not isinstance(spec, Mapping) or not all(k in spec for k in ("frame", "tracks", "offsets", "positions")):
            raise EvaluationError(f"2.1: track set {sid!r} lacks frame, tracks, offsets, or positions")

        def view(name: Any) -> np.ndarray:
            try:
                return container.view(name)
            except (KeyError, TypeError):
                raise EvaluationError(f"2.1: track set {sid!r} names view {name!r}, which the data container lacks") from None

        self.tracks = spec["tracks"]
        if isinstance(self.tracks, bool) or not isinstance(self.tracks, int) or self.tracks < 1:
            raise EvaluationError(f"2.1: track set {sid!r} has tracks {self.tracks!r}, not a count of at least one")
        offsets = view(spec["offsets"])
        if offsets.dtype != np.uint32 or offsets.shape != (self.tracks + 1,):
            raise EvaluationError(
                f"2.1: track set {sid!r}: offsets view {spec['offsets']!r} is {offsets.dtype} of shape {offsets.shape}, "
                f"not uint32 of shape ({self.tracks + 1},)"
            )
        self.offsets = offsets.astype(np.int64)
        if self.offsets[0] != 0:
            raise EvaluationError(f"2.1: track set {sid!r}: offsets[0] is {self.offsets[0]}, not 0")
        if np.any(np.diff(self.offsets) < 2):
            t = int(np.flatnonzero(np.diff(self.offsets) < 2)[0])
            n = int(self.offsets[t + 1] - self.offsets[t])
            raise EvaluationError(f"T1: track set {sid!r}: the sample count of track {t} is {n}, fewer than two")
        positions = view(spec["positions"]).astype(np.float64)
        size = int(self.offsets[-1])
        if positions.ndim != 2 or positions.shape[0] != size or positions.shape[1] not in (2, 3):
            raise EvaluationError(
                f"2.1: track set {sid!r}: positions view {spec['positions']!r} has shape {positions.shape}, not ({size}, 2) or ({size}, 3)"
            )
        if positions.shape[1] == 2:
            positions = np.hstack([positions, np.zeros((size, 1))])
        self.positions = positions
        self.channels = {}
        for name, info in (spec.get("channels") or {}).items():
            if name == INDEX:
                raise EvaluationError(f"S3: track set {sid!r} declares a channel named {INDEX}, which is reserved")
            values = view(info["view"] if isinstance(info, Mapping) else None).astype(np.float64)
            if values.shape != (size,):
                raise EvaluationError(f"2.1: track set {sid!r}: channel {name!r} has shape {values.shape}, not ({size},)")
            self.channels[name] = values
        self.parameters = {}
        for name, info in (spec.get("parameters") or {}).items():
            values = view(info["view"] if isinstance(info, Mapping) else None).astype(np.float64)
            if values.shape != (self.tracks,):
                raise EvaluationError(f"2.1: track set {sid!r}: parameter {name!r} has shape {values.shape}, not ({self.tracks},)")
            if not np.all(np.isfinite(values)):
                t = int(np.flatnonzero(~np.isfinite(values))[0])
                raise EvaluationError(f"2.1: parameter {name!r} of track set {sid!r} is not finite at track {t}")
            self.parameters[name] = values
        self.attrs = {k: _number(v, f"attribute {k!r} of track set {sid!r}") for k, v in (spec.get("attrs") or {}).items()}
        self.tags = spec.get("tags") or {}
        self.frame = spec["frame"]
        self.periodic = spec.get("periodic", False)
        if not isinstance(self.periodic, bool):
            raise EvaluationError(f"T2: track set {sid!r} has periodic {self.periodic!r}, not a boolean")

    def track(self, i: int) -> Track:
        a, b = self.offsets[i], self.offsets[i + 1]
        return Track(self.positions[a:b], {k: v[a:b] for k, v in self.channels.items()}, self.attrs, self.periodic)


# readings, points, and polylines

# A vertex ("sample", i, lap) is stored sample i, and a vertex ("blend", k, w, lap) is the point at weight w between
# samples k and k + 1. Both are taken in the context of lap `lap` of rule C6, where lap -1 is the shifted context of rule L2.
Vertex = tuple


def segment(u_samples: np.ndarray, u: float) -> tuple[int, float]:
    """The segment ``k`` and the weight ``w`` of rule C4, where ``k`` is the last index with ``u_k <= u``, and at most ``m - 2``."""
    m = len(u_samples)
    k = int(np.searchsorted(u_samples, u, side="right")) - 1
    k = min(max(k, 0), m - 2)
    span = u_samples[k + 1] - u_samples[k]
    w = (u - u_samples[k]) / span if span != 0.0 else 0.0
    return k, float(w)


def polyline(u_samples: np.ndarray, ua: float, ub: float, lap: int = 0) -> list[Vertex]:
    """The polyline of rule L1 between readings ``ua <= ub`` in one lap."""
    first = ("blend", *segment(u_samples, ua), lap)
    if ua == ub:
        return [first]
    inner = [("sample", int(i), lap) for i in np.flatnonzero((u_samples > ua) & (u_samples < ub))]
    return [first, *inner, ("blend", *segment(u_samples, ub), lap)]


def lap_of(loop_reading: float, laps: int) -> tuple[int, float]:
    """The lap of a loop reading, and the reading within this lap (rule C6)."""
    j = min(math.floor(loop_reading), laps - 1)
    return j, loop_reading - j


def loop_polyline(u_samples: np.ndarray, ua: float, ub: float, laps: int) -> list[Vertex]:
    """The polyline of rule C6 between loop readings ``ua <= ub``, joined across laps."""
    ja, a = lap_of(ua, laps)
    jb, b = lap_of(ub, laps)
    if ja == jb:
        return polyline(u_samples, a, b, ja)
    # the closing sample of a lap and the first sample of the next lap make one vertex. the first sample is kept
    out = polyline(u_samples, a, 1.0, ja)[:-1]
    for j in range(ja + 1, jb):
        out += polyline(u_samples, 0.0, 1.0, j)[:-1]
    return out + polyline(u_samples, 0.0, b, jb)


def whole(m: int, laps: int, periodic: bool) -> list[Vertex]:
    """Every sample of every lap, joined (rule C6). A track set that is not periodic has one lap."""
    if laps == 1 or not periodic:
        return [("sample", i, 0) for i in range(m)]
    return [("sample", i, j) for j in range(laps) for i in range(m - 1)] + [("sample", m - 1, laps - 1)]


def trail(u_samples: np.ndarray, loop_reading: float, laps: int, fraction: float, periodic: bool) -> list[Vertex]:
    """The trail of rules L1, L2 and C6, from loop reading ``loop_reading - laps * fraction`` to ``loop_reading``."""
    tail = loop_reading - laps * fraction
    if tail < 0.0 and not periodic:
        tail = 0.0
    return loop_polyline(u_samples, tail, loop_reading, laps)


def resolve_vertices(vertices: Iterable[Vertex], table: Callable[[int], np.ndarray]) -> list[list[float]]:
    """The positions of the vertices, read from ``table(lap)``, which holds the samples already transformed in the context of each lap."""
    out = []
    for vertex in vertices:
        t = table(vertex[-1])
        if vertex[0] == "sample":
            out.append(t[vertex[1]])
        else:
            _, k, w, _ = vertex
            out.append((1.0 - w) * t[k] + w * t[k + 1])
    return [[float(x) for x in p] for p in out]


# the evaluator


def evaluate(document: Mapping[str, Any], container: Container | bytes, state: Mapping[str, Any], frame_index: int) -> dict[str, Any]:
    """Evaluates every panel of ``state`` at clock frame ``frame_index``.

    Returns ``{"panels": {panel id: {"frame": id, "layers": [...]}}}`` as section 3 of
    ``spec/tycho-scene.md`` gives it, with every position as three float64 numbers in plain
    lists. The function is pure.
    """
    if not isinstance(container, Container):
        container = Container(container)
    return _Evaluator(document, container).run(state, frame_index)


KINDS = ("track", "body", "axes", "grid")


class _Evaluator:
    def __init__(self, document: Mapping[str, Any], container: Container) -> None:
        if not isinstance(document, Mapping) or not all(k in document for k in ("frames", "track_sets", "clock", "views")):
            raise EvaluationError("2: the document lacks frames, track_sets, clock, or views")
        self.doc = document
        self.container = container
        self.tree = FrameTree(document["frames"], document.get("bodies") or {})
        self.variables = document.get("variables") or {}
        for vid, spec in self.variables.items():
            if not isinstance(spec, Mapping) or spec.get("kind") not in ("selector", "choice", "toggle") or "default" not in spec:
                raise EvaluationError(f"2.5: variable {vid!r} lacks a known kind or a default")
            if spec["kind"] == "selector" and spec.get("by", "nearest") == "nearest" and "parameter" not in spec:
                raise EvaluationError(f"2.5: selector {vid!r} is by nearest but does not name a parameter")
        self._sets: dict[str, SetData] = {}

    def set_data(self, sid: str) -> SetData:
        if sid not in self._sets:
            try:
                spec = self.doc["track_sets"][sid]
            except KeyError:
                raise EvaluationError(f"2.1: track set {sid!r} is not declared") from None
            self._sets[sid] = SetData(sid, spec, self.container)
        return self._sets[sid]

    def run(self, state: Mapping[str, Any], frame_index: int) -> dict[str, Any]:
        clock = self.doc["clock"]
        if not isinstance(state, Mapping) or not all(k in state for k in ("clock", "panels", "layout")):
            raise EvaluationError("2.8: the state lacks clock, panels, or layout")
        channel = state["clock"].get("channel") if isinstance(state["clock"], Mapping) else None
        if not isinstance(channel, str) or channel not in clock.get("channels", []):
            raise EvaluationError(f"2.6: the state's clock channel {channel!r} is not one of the scene's clock channels")
        steps = clock.get("steps")
        if isinstance(steps, bool) or not isinstance(steps, int) or steps < 1:
            raise EvaluationError(f"2.6: the clock has steps {steps!r}, not a count of at least one")
        if isinstance(frame_index, bool) or not isinstance(frame_index, (int, np.integer)):
            raise EvaluationError(f"2.6: the frame index {frame_index!r} is not an integer")
        q = (int(frame_index) % steps) / steps
        reading = _Reading(clock, channel, q)
        self.check_state(state)
        panels = {}
        for pid, panel in state["panels"].items():
            panels[pid] = _Panel(self, state, panel, reading).run()
        return {"panels": panels}

    def check_state(self, state: Mapping[str, Any]) -> None:
        """Checks that the values fit their variables and that the layout shows every panel once (section 2.8)."""

        def held(values: Any, where: str) -> None:
            if values is None:
                return
            if not isinstance(values, Mapping):
                raise EvaluationError(f"2.8: the variables of {where} are not an object")
            for vid, value in values.items():
                spec = self.variables.get(vid)
                if spec is None:
                    continue
                kind, choices = spec["kind"], spec.get("values", [])
                if kind == "selector":
                    ok = not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)
                elif kind == "choice":
                    ok = value in choices
                else:
                    ok = isinstance(value, bool)
                if not ok:
                    raise EvaluationError(f"2.5: {where}: {kind} {vid!r} cannot hold {value!r}")

        held(state.get("variables"), "the state")
        if not isinstance(state["panels"], Mapping) or not state["panels"]:
            raise EvaluationError("2.8: the state does not have a panel")
        for pid, panel in state["panels"].items():
            if not isinstance(panel, Mapping) or "view" not in panel:
                raise EvaluationError(f"2.8: panel {pid!r} does not name a view")
            held(panel.get("variables"), f"panel {pid!r}")

        def leaves(node: Any) -> list[str]:
            if not isinstance(node, Mapping):
                raise EvaluationError(f"2.8: the layout node {node!r} is not an object")
            if node.get("kind") == "panel":
                if not isinstance(node.get("id"), str):
                    raise EvaluationError(f"2.8: a layout panel has id {node.get('id')!r}, not a string")
                return [node["id"]]
            if node.get("kind") == "split":
                return leaves(node.get("a")) + leaves(node.get("b"))
            raise EvaluationError(f"2.8: a layout node has kind {node.get('kind')!r}, not panel or split")

        shown = leaves(state["layout"])
        if sorted(shown) != sorted(state["panels"]):
            raise EvaluationError(
                f"2.8: the layout shows the panels {sorted(shown)}, while the state has the panels {sorted(state['panels'])}"
            )


class _Reading:
    """The clock at one frame index (rules C1 to C3, and the laps of rule C6)."""

    def __init__(self, clock: Mapping[str, Any], channel: str, q: float) -> None:
        self.mode = clock["mode"]
        self.channel = channel
        self.q = q
        if self.mode not in ("fraction", "value"):
            raise EvaluationError(f"2.6: the clock mode is {self.mode!r}, not fraction or value")
        self.laps = clock.get("laps", 1)
        if "laps" in clock and self.mode == "value":
            raise EvaluationError("C6: the clock is in value mode but has laps")
        if isinstance(self.laps, bool) or not isinstance(self.laps, int) or self.laps < 1:
            raise EvaluationError(f"C6: the clock has laps {self.laps!r}, not an integer of at least one")
        if self.mode == "value":
            rng = clock.get("range")
            if not isinstance(rng, list) or len(rng) != 2:
                raise EvaluationError("C2: the clock is in value mode but does not have a range of two numbers")
            a, b = (_number(x, "a clock range value") for x in rng)
            self.v = a + q * (b - a)

    def of(self, track: Track) -> float:
        """The track's reading ``u``, before any clamp."""
        if self.mode == "fraction":
            return self.q
        c = track.clock_values(self.channel)
        return float((self.v - c[0]) / (c[-1] - c[0]))


class _Panel:
    def __init__(self, ev: _Evaluator, state: Mapping[str, Any], panel: Mapping[str, Any], reading: _Reading) -> None:
        self.ev = ev
        self.state = state
        self.panel = panel
        self.reading = reading
        try:
            self.view = ev.doc["views"][panel["view"]]
        except (KeyError, TypeError):
            raise EvaluationError(f"2.8: a panel shows {panel.get('view')!r}, which is not a view") from None
        if not isinstance(self.view, Mapping) or not all(k in self.view for k in ("frame", "driver", "layers")):
            raise EvaluationError(f"2.7: view {panel['view']!r} lacks frame, driver, or layers")
        # the driver is resolved for every panel, whether or not a layer uses it (section 2.7)
        driver = self.view["driver"]
        if not isinstance(driver, Mapping) or "sets" not in driver or "member" not in driver:
            raise EvaluationError(f"2.7: the driver of view {panel['view']!r} lacks sets or member")
        data = self.one(driver["sets"])
        self.driver: tuple[SetData, int] | None = None
        if data is not None:
            if driver["member"] == "all" or (isinstance(driver["member"], Mapping) and "count" in driver["member"]):
                raise EvaluationError(f"V3: the driver's member is {driver['member']!r}, but a driver resolves to one track")
            missing = [c for c in ev.doc["clock"]["channels"] if c != INDEX and c not in data.channels]
            if missing:
                raise EvaluationError(f"C5: the driver's track set {data.id!r} lacks clock channels {missing}")
            if reading.laps > 1 and not data.periodic:
                raise EvaluationError(f"C6: the driver's track set {data.id!r} is not periodic, and the clock has {reading.laps} laps")
            self.driver = (data, self.members(driver["member"], data)[0])

    # variables (rule V1)

    def var(self, vid: str) -> Any:
        try:
            spec = self.ev.variables[vid]
        except KeyError:
            raise EvaluationError(f"2.5: variable {vid!r} is not declared") from None
        values = self.panel.get("variables", {}) if spec.get("scope", "scene") == "panel" else self.state.get("variables", {})
        return values.get(vid, spec["default"])

    def value(self, spec: Any) -> Any:
        if isinstance(spec, Mapping) and "var" in spec:
            return self.var(spec["var"])
        return spec

    # set queries and members (rules V2 and V3)

    def match(self, query: Any) -> list[str]:
        sets = self.ev.doc["track_sets"]
        if isinstance(query, Mapping) and "set" in query:
            if query["set"] not in sets:
                raise EvaluationError(f"V2: the set query names {query['set']!r}, which is not a track set")
            return [query["set"]]
        if not isinstance(query, Mapping) or not isinstance(query.get("tags"), Mapping):
            raise EvaluationError(f'V2: a set query is {{"set": id}} or {{"tags": {{...}}}}, not {query!r}')
        wanted = {name: self.value(v) for name, v in query["tags"].items()}
        return [sid for sid, s in sets.items() if all((s.get("tags") or {}).get(k) == v for k, v in wanted.items())]

    def one(self, query: Mapping[str, Any]) -> SetData | None:
        matches = self.match(query)
        if len(matches) > 1:
            raise EvaluationError(f"V2: the set query {dict(query)} matches the {len(matches)} track sets {matches}, where one is needed")
        return self.ev.set_data(matches[0]) if matches else None

    def members(self, ref: Any, data: SetData) -> list[int]:
        if ref == "all":
            return list(range(data.tracks))
        if isinstance(ref, Mapping) and "index" in ref:
            k = ref["index"]
            if isinstance(k, bool) or not isinstance(k, int):
                raise EvaluationError(f"V3: member index {k!r} is not an integer")
            if not 0 <= k < data.tracks:
                raise EvaluationError(f"V3: member index {k} is not below the track count {data.tracks} of track set {data.id!r}")
            return [k]
        if isinstance(ref, Mapping) and "count" in ref:
            n = ref["count"]
            if isinstance(n, bool) or not isinstance(n, int) or n < 1:
                raise EvaluationError(f"V3: member count {n!r} is not an integer of at least one")
            return sparse(data.tracks, n)
        if isinstance(ref, Mapping) and "var" in ref:
            return [self.selected(ref["var"], data)]
        raise EvaluationError(f'V3: a member reference is \'all\', {{"index": k}}, {{"count": n}}, or {{"var": id}}, not {ref!r}')

    def selected(self, vid: str, data: SetData) -> int:
        spec = self.ev.variables.get(vid)
        if spec is None or spec.get("kind") != "selector":
            raise EvaluationError(f"V3: variable {vid!r} is not a selector")
        value = self.var(vid)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise EvaluationError(f"2.5: selector {vid!r} holds {value!r}, not a finite number")
        value = float(value)
        if spec.get("by", "nearest") == "index":
            return min(max(math.floor(value + 0.5), 0), data.tracks - 1)
        parameter = spec["parameter"]
        if parameter not in data.parameters:
            raise EvaluationError(f"V3: track set {data.id!r} lacks parameter {parameter!r} for selector {vid!r}")
        # argmin takes the first of equal distances, i.e. the lowest index
        return int(np.argmin(np.abs(data.parameters[parameter] - value)))

    # layers

    def run(self) -> dict[str, Any]:
        frame = self.value(self.view["frame"])
        if frame not in self.ev.doc["frames"]:
            raise EvaluationError(f"2.7: the view displays {frame!r}, which is not a frame")
        self.frame = frame
        layers = []
        for layer in self.view["layers"]:
            if not isinstance(layer, Mapping) or layer.get("kind") not in KINDS:
                raise EvaluationError(f"S1: layer kind {layer.get('kind') if isinstance(layer, Mapping) else layer!r} is not implemented")
            if "visible" in layer:
                visible = layer["visible"]
                vid = visible.get("var") if isinstance(visible, Mapping) else None
                if vid is None or self.ev.variables.get(vid, {}).get("kind") != "toggle":
                    raise EvaluationError(f"L5: a layer's visible names {vid!r}, which is not a toggle")
                if self.var(vid) is False:
                    continue
            kind = layer["kind"]
            if kind == "track":
                layers.append(self.track_layer(layer))
            elif kind == "body":
                layers.append(self.body_layer(layer))
            else:
                layers.append({"kind": kind})
        return {"frame": frame, "layers": layers}

    def clamped(self, track: Track, layer: Mapping[str, Any]) -> float | None:
        """The reading on ``track``, clamped, or None when the track is hidden under rule C3."""
        u = self.reading.of(track)
        if u < 0.0:
            if layer.get("before", "clamp") == "hidden":
                return None
            u = 0.0
        elif u > 1.0:
            if layer.get("after", "clamp") == "hidden":
                return None
            u = 1.0
        return u

    def track_layer(self, layer: Mapping[str, Any]) -> dict[str, Any]:
        data = self.one(layer["sets"])
        if data is None:
            return {"kind": "track", "set": None, "members": []}
        reveal = layer.get("reveal", "none")
        if reveal not in ("none", "grow", "trail"):
            raise EvaluationError(f"2.7: a track layer's reveal is {reveal!r}, not none, grow, or trail")
        head = layer.get("head", False)
        if not isinstance(head, (bool, Mapping)):
            raise EvaluationError(f"L3: a track layer's head is {head!r}, not a boolean or an object")
        # a head object gives the same point as true
        head = head is True or isinstance(head, Mapping)
        for key in ("before", "after"):
            if layer.get(key, "clamp") not in ("clamp", "hidden"):
                raise EvaluationError(f"C3: a track layer's {key} is {layer[key]!r}, not clamp or hidden")
        fraction = _fraction(layer) if reveal == "trail" else 0.0
        context = layer.get("context", "own")
        if context not in ("own", "driver"):
            raise EvaluationError(f"L6: a track layer's context is {context!r}, not own or driver")
        # under rule C5, a reading is not taken on a track drawn whole and never hidden, whose track set need not carry the clock channels
        hides = self.reading.mode == "value" and "hidden" in (layer.get("before"), layer.get("after"))
        reads = reveal != "none" or head or hides
        laps = self.reading.laps
        if reads and laps > 1 and not data.periodic:
            raise EvaluationError(f"C6: a reading is taken on track set {data.id!r}, which is not periodic, and the clock has {laps} laps")
        at = self.driver_point() if context == "driver" and self.driver is not None else None
        members = []
        for i in self.members(layer["members"], data):
            track = data.track(i)
            entry: dict[str, Any] = {"index": i}
            u = self.clamped(track, layer) if reads else 0.0
            if u is None or (context == "driver" and at is None):
                entry["line"] = []
                if head:
                    entry["head"] = None
                members.append(entry)
                continue
            loop_reading = laps * u
            u_samples = track.sample_readings(self.reading.channel) if reads else np.empty(0)
            if reveal == "none":
                vertices = whole(track.m, laps, track.periodic)
            elif reveal == "grow":
                vertices = loop_polyline(u_samples, 0.0, loop_reading, laps)
            else:
                vertices = trail(u_samples, loop_reading, laps, fraction, track.periodic)

            if at is not None:
                table = _every_lap(self.in_driver_context(track.positions, data.frame, at))
            else:

                def positions(lap: int, t: Track = track) -> np.ndarray:
                    return self.ev.tree.transform(t.positions, data.frame, self.frame, t.context(lap))

                table = _by_lap(positions)
            entry["line"] = resolve_vertices(vertices, table)
            if head:
                j, within = lap_of(loop_reading, laps)
                entry["head"] = resolve_vertices([("blend", *segment(u_samples, within), j)], table)[0]
            members.append(entry)
        return {"kind": "track", "set": data.id, "members": members}

    def driver_point(self) -> tuple[Track, np.ndarray, float, int, int, float]:
        """The driver's track, its sample readings, its loop reading, and the lap, segment, and weight of the point at the reading.

        A body layer and a layer in the driver's context lack before and after, thus the reading is clamped (rules L4 and L6).
        """
        assert self.driver is not None
        data, k_member = self.driver
        track = data.track(k_member)
        loop_reading = self.reading.laps * min(max(self.reading.of(track), 0.0), 1.0)
        u_samples = track.sample_readings(self.reading.channel)
        j, within = lap_of(loop_reading, self.reading.laps)
        k, w = segment(u_samples, within)
        return track, u_samples, loop_reading, j, k, w

    def in_driver_context(self, points: np.ndarray, src: str, at: tuple[Track, np.ndarray, float, int, int, float]) -> np.ndarray:
        """Points of frame ``src`` in the display frame, in the blended context of the driver's point ``at`` (rules L4 and L6)."""
        track, _, _, j, k, w = at
        n = len(points)
        a = self.ev.tree.transform(points, src, self.frame, track.sample_context(j, k, n))
        b = self.ev.tree.transform(points, src, self.frame, track.sample_context(j, k + 1, n))
        return (1.0 - w) * a + w * b

    def body_layer(self, layer: Mapping[str, Any]) -> dict[str, Any]:
        body = layer.get("body")
        if not isinstance(body, str) or body not in self.ev.tree.bodies:
            raise EvaluationError(f"L4: a body layer draws {body!r}, which is not a body")
        out: dict[str, Any] = {"kind": "body", "body": body}
        fraction = _fraction(layer) if "trail" in layer else None
        if self.driver is None:
            out["position"] = None
            if fraction is not None:
                out["trail"] = []
            return out
        track, u_samples, loop_reading, j, k, w = self.driver_point()
        laps = self.reading.laps
        tree = self.ev.tree
        table = _by_lap(lambda lap: tree.body_position(body, self.frame, track.context(lap)))
        out["position"] = resolve_vertices([("blend", k, w, j)], table)[0]
        if fraction is not None:
            out["trail"] = resolve_vertices(trail(u_samples, loop_reading, laps, fraction, track.periodic), table)
        return out


def _fraction(layer: Mapping[str, Any]) -> float:
    """The trail fraction ``trail.fraction`` of a layer, in ``(0, 1]`` (section 2.7)."""
    spec = layer.get("trail")
    if not isinstance(spec, Mapping) or "fraction" not in spec:
        raise EvaluationError("2.7: a layer draws a trail but lacks a trail fraction")
    f = _number(spec["fraction"], "a trail fraction")
    if not 0.0 < f <= 1.0:
        raise EvaluationError(f"2.7: the trail fraction {f} is not in (0, 1]")
    return f


def sparse(tracks: int, n: int) -> list[int]:
    """The tracks of ``{"count": n}`` (rule V3), which are every ``step``-th track from the first, and the last.

    The step is ``floor(tracks / n + 0.5)``, or 1 when ``n`` is at least ``tracks``.
    """
    step = 1 if n >= tracks else math.floor(tracks / n + 0.5)
    out = list(range(0, tracks, step))
    if out[-1] != tracks - 1:
        out.append(tracks - 1)
    return out


def _every_lap(positions: np.ndarray) -> Callable[[int], np.ndarray]:
    """A table of positions that is the same in every lap, as for a layer in the driver's context (rule L6)."""
    return lambda _lap: positions


def _by_lap(compute: Callable[[int], np.ndarray]) -> Callable[[int], np.ndarray]:
    """Returns ``compute`` wrapped in a cache, so that it runs once per lap."""
    cache: dict[int, np.ndarray] = {}

    def get(lap: int) -> np.ndarray:
        if lap not in cache:
            cache[lap] = compute(lap)
        return cache[lap]

    return get
