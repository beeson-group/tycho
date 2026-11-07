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

        def channel(name: str) -> np.ndarray | None:
            values = self.channel(name)
            if values is None or lap == 0:
                return values
            return values + lap * (values[-1] - values[0])

        return Context(self.attrs, channel, self.m)

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
