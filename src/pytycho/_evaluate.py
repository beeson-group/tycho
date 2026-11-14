"""The NumPy evaluator of a TyCHO scene, section 3 of ``spec/tycho-scene.md``.

The evaluator is the reference for the behavior that TyCHO defines, i.e. the edge equation of the frame tree, the
clock reading, the blend between two stored samples, the trail, and the revolutions of a periodic trajectory. It does not hold
the frame formula of any dynamical model. Every frame is instead the generic edge ``p_child = s * R * (p_parent - o)``
of rule `transform`. The scale ``s`` and the angle of the rotation ``R`` are each a number, a trajectory set attribute, or a per-sample
channel, and the origin ``o`` is three numbers, attributes, or channels, or the position of a body (rule `origin`). The TypeScript
evaluator in ``web/`` is the second implementation, and both must reproduce every case of the conformance corpus in
``spec/conformance/``. Every computation runs in float64.

:meth:`pytycho.TrajectorySet.thin` also uses :class:`FrameTree` to measure arclength in frames other than
the frame of the trajectory set.
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Iterable, Mapping
from typing import Any

import numpy as np

from .container import Container

INDEX = "@index"


class EvaluationError(ValueError):
    """A scene, a state, or a data container that the evaluator cannot evaluate."""


# contexts and scalars


class Context:
    """The context of rule `context-number` for ``n`` points at once, made of one trajectory set, one trajectory, and one sample per point.

    ``attrs`` are the trajectory set's attributes. ``channel(name)`` returns the channel's value at each
    point's sample, already raised by the channel's advance times the revolution of rule `revolutions`.
    """

    __slots__ = ("_channel", "attrs", "n")

    def __init__(self, attrs: Mapping[str, float], channel: Callable[[str], np.ndarray | None], n: int) -> None:
        self.attrs = attrs
        self.n = n
        self._channel = channel

    def channel(self, name: str) -> np.ndarray:
        values = self._channel(name)
        if values is None:
            raise EvaluationError(f"transform-channels: the context's trajectory set lacks channel {name!r}")
        return values

    def attr(self, name: str) -> float:
        try:
            return float(self.attrs[name])
        except KeyError:
            raise EvaluationError(f"transform-channels: the context's trajectory set lacks attribute {name!r}") from None


def _number(value: Any, what: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        message = f"{what} is {value!r}, not a number"
        raise EvaluationError(message if re.match(r"[a-z][a-z0-9-]*: ", message) else f"scene: {message}")
    if not math.isfinite(value):
        raise EvaluationError(f"finite-number: {what} is {value!r}, not finite")
    return float(value)


def scalar(spec: Any, ctx: Context) -> float | np.ndarray:
    """The value of a number, an attribute, or a channel (section 2.2) in ``ctx``."""
    if isinstance(spec, Mapping) and "attr" in spec:
        return _number(spec.get("factor", 1.0), "a factor") * ctx.attr(spec["attr"]) + _number(spec.get("offset", 0.0), "an offset")
    if isinstance(spec, Mapping) and "channel" in spec:
        if spec["channel"] == INDEX:
            raise EvaluationError(f"context-number: {INDEX} is not allowed in a frame edge")
        return ctx.channel(spec["channel"])
    return _number(spec, "a scalar")


def _point(spec: Any, ctx: Context, *, channels: bool = False) -> np.ndarray:
    """Three scalars as an ``(n, 3)`` array, with a channel allowed only under ``channels``, i.e. in an origin (rules `origin` and
    `body`)."""
    if not isinstance(spec, list) or len(spec) != 3:
        raise EvaluationError(f"origin: an origin or a position is three scalars, not {spec!r}")
    out = np.empty((ctx.n, 3))
    for j, value in enumerate(spec):
        if not channels and isinstance(value, Mapping) and "channel" in value:
            raise EvaluationError("origin: the position of a body takes a number or an attribute, not a channel")
        out[:, j] = scalar(value, ctx)
    return out


# the frame tree


class FrameTree:
    """The frames and bodies of a scene document, and the transforms between frames (rules `transform` to `frame-path` and
    `body-origin-cycle`)."""

    def __init__(self, frames: Mapping[str, Any], bodies: Mapping[str, Any] | None = None) -> None:
        self.frames = frames
        self.bodies = bodies or {}
        roots = [fid for fid, f in frames.items() if "parent" not in f]
        if len(roots) != 1:
            raise EvaluationError(f"frame: the frames have {len(roots)} roots, not one: {roots}")
        self.root = roots[0]
        for fid in frames:
            self.ancestors(fid)
        root = frames[self.root]
        if any(k in root for k in ("origin", "rotation", "scale")):
            raise EvaluationError(f"frame: the root frame {self.root!r} has an origin, a rotation, or a scale")
        for fid, frame in frames.items():
            scale = frame.get("scale")
            if scale == 0 or (
                isinstance(scale, Mapping) and "attr" in scale and scale.get("factor", 1) == 0 and scale.get("offset", 0) == 0
            ):
                raise EvaluationError(f"origin: the scale of frame {fid!r} is zero")
        for fid in frames:
            # rule `body-origin-cycle` is checked at load, whatever is drawn
            self.requirements(fid, self.root)

    def ancestors(self, fid: str) -> list[str]:
        """The frame ``fid`` and its ancestors, up to the root."""
        chain = [fid]
        while "parent" in self._frame(chain[-1]):
            parent = self._frame(chain[-1])["parent"]
            if parent in chain:
                raise EvaluationError(f"frame: the parents of frame {fid!r} form a cycle")
            chain.append(parent)
        return chain

    def _frame(self, fid: str) -> Mapping[str, Any]:
        try:
            return self.frames[fid]
        except KeyError:
            raise EvaluationError(f"frame: frame {fid!r} is not declared") from None

    def path(self, src: str, dst: str) -> tuple[list[str], list[str]]:
        """The edges from ``src`` to ``dst`` (rule `frame-path`), each identified by its child frame.

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
            raise EvaluationError(f"body: body {body!r} is not declared") from None
        return self.transform(_point(spec.get("position"), ctx), spec["frame"], frame, ctx, _stack)

    def _edge(self, fid: str, ctx: Context, stack: tuple[str, ...]):
        frame = self._frame(fid)
        origin = frame.get("origin")
        if origin is None:
            o: Any = 0.0
        elif isinstance(origin, Mapping):
            if fid in stack:
                raise EvaluationError(f"body-origin-cycle: the origin of frame {fid!r} depends on itself")
            o = self.body_position(origin["body"], frame["parent"], ctx, (*stack, fid))
        else:
            o = _point(origin, ctx, channels=True)
        rotation = frame.get("rotation")
        axis = angle = None
        if rotation is not None:
            axis = rotation["axis"]
            angle = np.broadcast_to(np.asarray(scalar(rotation["angle"], ctx), dtype=np.float64), (ctx.n,))[:, None]
        s = frame.get("scale")
        s = 1.0 if s is None else np.broadcast_to(np.asarray(scalar(s, ctx), dtype=np.float64), (ctx.n,))[:, None]
        if np.any(np.asarray(s) == 0.0):
            raise EvaluationError(f"origin: the scale of frame {fid!r} is zero")
        return o, axis, angle, s

    def requirements(self, src: str, dst: str, _stack: tuple[str, ...] = ()) -> tuple[set[str], set[str]]:
        """The channels and attributes that a context must carry to take a point from ``src`` to ``dst`` (rule `transform-channels`).

        For an origin at a body, the result also holds the attributes of the body's position and the requirements of
        the path from the body's frame to the edge's parent frame. Raises when an origin depends on itself (rule `body-origin-cycle`).
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
                    raise EvaluationError(f"body-origin-cycle: the origin of frame {fid!r} depends on itself")
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
            raise EvaluationError(f"body: body {body!r} is not declared")
        if spec.get("frame") not in self.frames:
            raise EvaluationError(f"body: body {body!r} is in frame {spec.get('frame')!r}, which is not declared")
        channels, attrs = self.requirements(spec["frame"], frame, _stack)
        position = spec.get("position")
        if not isinstance(position, list) or len(position) != 3:
            raise EvaluationError(f"body: the position of body {body!r} is three scalars, not {position!r}")
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
    """Returns ``R p``, or ``R^T p`` when ``inverse``, where ``R`` is the right-handed rotation by ``angle`` about ``axis`` (rule
    `transform`)."""
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
    raise EvaluationError(f"transform: rotation axis {axis!r} is not x, y, or z")


# trajectory data


class Trajectory:
    """One trajectory of a trajectory set, with its positions as an ``(m, 3)`` array, its channels, and the attributes of its trajectory
    set."""

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

    def context(self, revolution: int = 0) -> Context:
        """The context of every sample in revolution ``revolution`` of rule `revolutions`. Revolution -1 is the shifted context of rule
        `trail-wrap`."""

        return Context(self.attrs, lambda name: _raised(self.channel(name), revolution), self.m)

    def sample_context(self, revolution: int, sample: int, n: int) -> Context:
        """The context of sample ``sample`` in revolution ``revolution``, repeated for ``n`` points.

        A layer that reads from the reference reads its points in this context (rule `read-from`).
        """

        def channel(name: str) -> np.ndarray | None:
            values = _raised(self.channel(name), revolution)
            return None if values is None else np.full(n, values[sample])

        return Context(self.attrs, channel, n)

    def clock_values(self, name: str) -> np.ndarray:
        """The clock channel's values along the trajectory, checked against rule `monotone-clock-channel`."""
        if name == INDEX:
            return np.arange(self.m, dtype=np.float64)
        c = self.channel(name)
        if c is None:
            raise EvaluationError(f"clock-channel-carried: the trajectory lacks clock channel {name!r}")
        d = np.diff(c)
        if not np.all(np.isfinite(c)) or not (np.all(d > 0) or np.all(d < 0)) or not np.isfinite(c[-1] - c[0]):
            raise EvaluationError(
                f"monotone-clock-channel: clock channel {name!r} is not strictly monotone with a finite span along a trajectory"
            )
        return c

    def sample_readings(self, name: str) -> np.ndarray:
        """The sample readings ``u_i`` of rule `sample-fraction` for clock channel ``name``."""
        c = self.clock_values(name)
        return (c - c[0]) / (c[-1] - c[0])


def _raised(values: np.ndarray | None, revolution: int) -> np.ndarray | None:
    """A channel's values raised by ``revolution`` times its advance over one period (rule `revolutions`)."""
    if values is None or revolution == 0:
        return values
    return values + revolution * (values[-1] - values[0])


class SetData:
    """A trajectory set of the scene document, read from the container as float64."""

    def __init__(self, sid: str, spec: Mapping[str, Any], container: Container) -> None:
        self.id = sid
        self.spec = spec
        if not isinstance(spec, Mapping) or not all(k in spec for k in ("frame", "trajectories", "offsets", "positions")):
            raise EvaluationError(f"trajectory-set: trajectory set {sid!r} lacks frame, trajectories, offsets, or positions")

        def array(name: Any) -> np.ndarray:
            try:
                return container.array(name)
            except (KeyError, TypeError):
                raise EvaluationError(
                    f"trajectory-set: trajectory set {sid!r} names array {name!r}, which the data container lacks"
                ) from None

        self.trajectories = spec["trajectories"]
        if isinstance(self.trajectories, bool) or not isinstance(self.trajectories, int) or self.trajectories < 1:
            raise EvaluationError(
                f"trajectory-set: trajectory set {sid!r} has trajectories {self.trajectories!r}, not a count of at least one"
            )
        offsets = array(spec["offsets"])
        if offsets.dtype != np.uint32 or offsets.shape != (self.trajectories + 1,):
            raise EvaluationError(
                f"trajectory-set: trajectory set {sid!r}: offsets array {spec['offsets']!r} is {offsets.dtype} of shape {offsets.shape}, "
                f"not uint32 of shape ({self.trajectories + 1},)"
            )
        self.offsets = offsets.astype(np.int64)
        if self.offsets[0] != 0:
            raise EvaluationError(f"trajectory-set: trajectory set {sid!r}: offsets[0] is {self.offsets[0]}, not 0")
        if np.any(np.diff(self.offsets) < 2):
            t = int(np.flatnonzero(np.diff(self.offsets) < 2)[0])
            n = int(self.offsets[t + 1] - self.offsets[t])
            raise EvaluationError(f"two-samples: trajectory set {sid!r}: the sample count of trajectory {t} is {n}, fewer than two")
        positions = array(spec["positions"]).astype(np.float64)
        size = int(self.offsets[-1])
        if positions.ndim != 2 or positions.shape[0] != size or positions.shape[1] not in (2, 3):
            raise EvaluationError(
                f"trajectory-set: trajectory set {sid!r}: positions array {spec['positions']!r} has shape {positions.shape}, not "
                f"({size}, 2) or ({size}, 3)"
            )
        if positions.shape[1] == 2:
            positions = np.hstack([positions, np.zeros((size, 1))])
        self.positions = positions
        self.channels = {}
        for name, info in (spec.get("channels") or {}).items():
            if name == INDEX:
                raise EvaluationError(f"identifier: trajectory set {sid!r} declares a channel named {INDEX}, which is reserved")
            values = array(info["array"] if isinstance(info, Mapping) else None).astype(np.float64)
            if values.shape != (size,):
                raise EvaluationError(f"trajectory-set: trajectory set {sid!r}: channel {name!r} has shape {values.shape}, not ({size},)")
            self.channels[name] = values
        self.parameters = {}
        for name, info in (spec.get("parameters") or {}).items():
            if name == INDEX:
                raise EvaluationError(f"identifier: trajectory set {sid!r} declares a parameter named {INDEX}, which is reserved")
            values = array(info["array"] if isinstance(info, Mapping) else None).astype(np.float64)
            if values.shape != (self.trajectories,):
                raise EvaluationError(
                    f"trajectory-set: trajectory set {sid!r}: parameter {name!r} has shape {values.shape}, not ({self.trajectories},)"
                )
            if not np.all(np.isfinite(values)):
                t = int(np.flatnonzero(~np.isfinite(values))[0])
                raise EvaluationError(f"trajectory-set: parameter {name!r} of trajectory set {sid!r} is not finite at trajectory {t}")
            self.parameters[name] = values
        self.attrs = {k: _number(v, f"attribute {k!r} of trajectory set {sid!r}") for k, v in (spec.get("attrs") or {}).items()}
        self.tags = spec.get("tags") or {}
        self.frame = spec["frame"]
        self.periodic = spec.get("periodic", False)
        if not isinstance(self.periodic, bool):
            raise EvaluationError(f"periodic: trajectory set {sid!r} has periodic {self.periodic!r}, not a boolean")

    def trajectory(self, i: int) -> Trajectory:
        a, b = self.offsets[i], self.offsets[i + 1]
        return Trajectory(self.positions[a:b], {k: v[a:b] for k, v in self.channels.items()}, self.attrs, self.periodic)


# readings, points, and polylines

# A vertex ("sample", i, revolution) is stored sample i, and a vertex ("blend", k, w, revolution) is the point at weight w between
# samples k and k + 1. Both are taken in the context of revolution `revolution` of rule `revolutions`, where revolution -1 is the shifted
# context of rule `trail-wrap`.
Vertex = tuple


def segment(u_samples: np.ndarray, u: float) -> tuple[int, float]:
    """The segment ``k`` and the weight ``w`` of rule `segment`, where ``k`` is the last index with ``u_k <= u``, and at most ``m - 2``."""
    m = len(u_samples)
    k = int(np.searchsorted(u_samples, u, side="right")) - 1
    k = min(max(k, 0), m - 2)
    span = u_samples[k + 1] - u_samples[k]
    w = (u - u_samples[k]) / span if span != 0.0 else 0.0
    return k, float(w)


def polyline(u_samples: np.ndarray, ua: float, ub: float, revolution: int = 0) -> list[Vertex]:
    """The polyline of rule `polyline` between readings ``ua <= ub`` in one revolution."""
    first = ("blend", *segment(u_samples, ua), revolution)
    if ua == ub:
        return [first]
    inner = [("sample", int(i), revolution) for i in np.flatnonzero((u_samples > ua) & (u_samples < ub))]
    return [first, *inner, ("blend", *segment(u_samples, ub), revolution)]


def revolution_of(loop_reading: float, revolutions: int) -> tuple[int, float]:
    """The revolution of a loop reading, and the reading within this revolution (rule `revolutions`)."""
    j = min(math.floor(loop_reading), revolutions - 1)
    return j, loop_reading - j


def loop_polyline(u_samples: np.ndarray, ua: float, ub: float, revolutions: int) -> list[Vertex]:
    """The polyline of rule `revolutions` between loop readings ``ua <= ub``, joined across revolutions."""
    ja, a = revolution_of(ua, revolutions)
    jb, b = revolution_of(ub, revolutions)
    if ja == jb:
        return polyline(u_samples, a, b, ja)
    # the closing sample of a revolution and the first sample of the next revolution make one vertex. the first sample is kept
    out = polyline(u_samples, a, 1.0, ja)[:-1]
    for j in range(ja + 1, jb):
        out += polyline(u_samples, 0.0, 1.0, j)[:-1]
    return out + polyline(u_samples, 0.0, b, jb)


def whole(m: int, revolutions: int, periodic: bool) -> list[Vertex]:
    """Every sample of every revolution, joined (rule `revolutions`). A trajectory set that is not periodic has one revolution."""
    if revolutions == 1 or not periodic:
        return [("sample", i, 0) for i in range(m)]
    return [("sample", i, j) for j in range(revolutions) for i in range(m - 1)] + [("sample", m - 1, revolutions - 1)]


def trail(u_samples: np.ndarray, loop_reading: float, revolutions: int, fraction: float, periodic: bool) -> list[Vertex]:
    """The trail of rules `polyline`, `trail-wrap` and `revolutions`, from loop reading ``loop_reading - revolutions * fraction`` to
    ``loop_reading``."""
    tail = loop_reading - revolutions * fraction
    if tail < 0.0 and not periodic:
        tail = 0.0
    return loop_polyline(u_samples, tail, loop_reading, revolutions)


def resolve_vertices(vertices: Iterable[Vertex], table: Callable[[int], np.ndarray]) -> list[list[float]]:
    """The positions of the vertices, read from ``table(revolution)``, which holds the samples already transformed in the context of each
    revolution."""
    out = []
    for vertex in vertices:
        t = table(vertex[-1])
        if vertex[0] == "sample":
            out.append(t[vertex[1]])
        else:
            _, k, w, _ = vertex
            out.append((1.0 - w) * t[k] + w * t[k + 1])
    return [[float(x) for x in p] for p in out]


# the timeline (section 2.11)

EASES = ("linear", "smooth", "in", "out", "in-out", "hold")


def ease(name: Any, x: float) -> float:
    """The ease ``E(x)`` of rule `ease`, with every product computed from the left."""
    if name == "linear":
        return x
    if name == "smooth":
        return x * x * (3.0 - 2.0 * x)
    if name == "in":
        return x * x * x
    if name == "out":
        y = 1.0 - x
        return 1.0 - y * y * y
    if name == "in-out":
        if x < 0.5:
            return 4.0 * x * x * x
        y = 2.0 - 2.0 * x
        return 1.0 - y * y * y / 2.0
    if name == "hold":
        return 0.0
    raise EvaluationError(f"ease: the ease {name!r} is not one of {', '.join(EASES)}")


def keyframe_list(value: Any, what: str) -> list[tuple[float, float, str]]:
    """Keyframes as ``(t, v, ease)``, checked against rules `keyframes` and `ease`."""
    if isinstance(value, Mapping) and "keyframes" in value:
        value = value["keyframes"]
    if not isinstance(value, list) or not value:
        raise EvaluationError(f"keyframes: {what} has keyframes {value!r}, not a nonempty list")
    out: list[tuple[float, float, str]] = []
    for item in value:
        if not isinstance(item, list) or len(item) not in (2, 3):
            raise EvaluationError(f"keyframes: a keyframe of {what} is {item!r}, not [t, v] or [t, v, ease]")
        t = _number(item[0], f"keyframes: the time of a keyframe of {what}")
        v = _number(item[1], f"keyframes: the value of a keyframe of {what}")
        name = item[2] if len(item) == 3 else "linear"
        if name not in EASES:
            raise EvaluationError(f"ease: a keyframe of {what} has the ease {name!r}, not one of {', '.join(EASES)}")
        if out and t < out[-1][0]:
            raise EvaluationError(f"keyframes: the keyframe times of {what} decrease from {out[-1][0]} to {t}")
        out.append((t, v, name))
    return out


def keyframe_value(keyframes: list[tuple[float, float, str]], s: float) -> float:
    """The value of keyframes at time ``s`` of the timeline (rule `keyframes`)."""
    i = -1
    for j, item in enumerate(keyframes):
        if item[0] <= s:
            i = j
    if i < 0:
        return keyframes[0][1]
    if i == len(keyframes) - 1:
        return keyframes[i][1]
    t0, v0, _ = keyframes[i]
    t1, v1, name = keyframes[i + 1]
    x = (s - t0) / (t1 - t0)
    return v0 + ease(name, x) * (v1 - v0)


def loop_seconds(clock: Mapping[str, Any]) -> float:
    """The length ``L`` of one loop in seconds: the clock's seconds, or 8 seconds per revolution (sections 2.6 and 2.11)."""
    if "seconds" in clock:
        return _number(clock["seconds"], "the clock seconds")
    revolutions = clock.get("revolutions", 1)
    return 8.0 * (revolutions if isinstance(revolutions, int) and not isinstance(revolutions, bool) else 1)


# the evaluator


def evaluate(document: Mapping[str, Any], container: Container | bytes, state: Mapping[str, Any], frame_index: int) -> dict[str, Any]:
    """Evaluates every panel of ``state`` at clock frame ``frame_index``.

    Returns ``{"panels": {shown panel id: {"frame": id, "layers": [...]}}}`` as section 3 of
    ``spec/tycho-scene.md`` gives it, with every position as three float64 numbers in plain
    lists. The function is pure.
    """
    if not isinstance(container, Container):
        container = Container(container)
    return _Evaluator(document, container).run(state, frame_index)


KINDS = ("trajectories", "arrow", "inset_box", "body", "axes", "grid", "label", "points")


class _Evaluator:
    def __init__(self, document: Mapping[str, Any], container: Container) -> None:
        if not isinstance(document, Mapping) or not all(k in document for k in ("frames", "trajectory_sets", "clock", "panels")):
            raise EvaluationError("scene: the document lacks frames, trajectory_sets, clock, or panels")
        self.doc = document
        self.container = container
        self.tree = FrameTree(document["frames"], document.get("bodies") or {})
        self.inputs = document.get("inputs") or {}
        for iid, spec in self.inputs.items():
            if not isinstance(spec, Mapping) or spec.get("kind") not in ("parameter", "choice", "toggle") or "default" not in spec:
                raise EvaluationError(f"input: input {iid!r} lacks a known kind or a default")
            if spec["kind"] == "parameter" and not isinstance(spec.get("parameter"), str):
                raise EvaluationError(f"input: parameter input {iid!r} does not name a parameter")
        self._sets: dict[str, SetData] = {}

    def set_data(self, sid: str) -> SetData:
        if sid not in self._sets:
            try:
                spec = self.doc["trajectory_sets"][sid]
            except KeyError:
                raise EvaluationError(f"trajectory-set: trajectory set {sid!r} is not declared") from None
            self._sets[sid] = SetData(sid, spec, self.container)
        return self._sets[sid]

    def run(self, state: Mapping[str, Any], frame_index: int) -> dict[str, Any]:
        clock = self.doc["clock"]
        if not isinstance(state, Mapping) or not all(k in state for k in ("clock", "panels", "layout")):
            raise EvaluationError("state: the state lacks clock, panels, or layout")
        channel = state["clock"].get("channel") if isinstance(state["clock"], Mapping) else None
        if not isinstance(channel, str) or channel not in clock.get("channels", []):
            raise EvaluationError(f"clock: the state's clock channel {channel!r} is not one of the scene's clock channels")
        frame_count = clock.get("frame_count")
        if isinstance(frame_count, bool) or not isinstance(frame_count, int) or frame_count < 1:
            raise EvaluationError(f"clock: the clock has frame_count {frame_count!r}, not a count of at least one")
        if isinstance(frame_index, bool) or not isinstance(frame_index, (int, np.integer)):
            raise EvaluationError(f"clock: the frame index {frame_index!r} is not an integer")
        q = (int(frame_index) % frame_count) / frame_count
        reading = _Reading(clock, channel, q)
        self.check_state(state)
        panels = {}
        for sid, shown in state["panels"].items():
            panels[sid] = _Panel(self, state, shown, reading).run()
        return {"panels": panels}

    def check_state(self, state: Mapping[str, Any]) -> None:
        """Checks that the values fit their inputs and that the layout shows every shown panel once (section 2.8)."""

        def held(values: Any, where: str) -> None:
            if values is None:
                return
            if not isinstance(values, Mapping):
                raise EvaluationError(f"state: the inputs of {where} are not an object")
            for iid, value in values.items():
                spec = self.inputs.get(iid)
                if spec is None:
                    continue
                kind, choices = spec["kind"], spec.get("values", [])
                if kind == "parameter":
                    ok = not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)
                elif kind == "choice":
                    ok = value in choices
                else:
                    ok = isinstance(value, bool)
                if not ok:
                    raise EvaluationError(f"input: {where}: {kind} {iid!r} cannot hold {value!r}")

        held(state.get("inputs"), "the state")
        if not isinstance(state["panels"], Mapping) or not state["panels"]:
            raise EvaluationError("state: the state does not have a panel")
        for sid, shown in state["panels"].items():
            if not isinstance(shown, Mapping) or "panel" not in shown:
                raise EvaluationError(f"state: shown panel {sid!r} does not name a declared panel")
            held(shown.get("inputs"), f"shown panel {sid!r}")

        shown = _leaves(state["layout"])
        if sorted(shown) != sorted(state["panels"]):
            raise EvaluationError(
                f"state: the layout shows the panels {sorted(shown)}, while the state has the panels {sorted(state['panels'])}"
            )


def _leaves(node: Any) -> list[str]:
    """The shown panel ids of a layout, in layout order (section 2.8)."""
    if not isinstance(node, Mapping):
        raise EvaluationError(f"state: the layout node {node!r} is not an object")
    if node.get("kind") == "panel":
        if not isinstance(node.get("id"), str):
            raise EvaluationError(f"state: a layout panel has id {node.get('id')!r}, not a string")
        return [node["id"]]
    if node.get("kind") == "split":
        return _leaves(node.get("a")) + _leaves(node.get("b"))
    raise EvaluationError(f"state: a layout node has kind {node.get('kind')!r}, not panel or split")


class _Reading:
    """The clock at one frame index (rules `sample-fraction` to `before-after`, the revolutions of rule `revolutions`, and the keyframes of
    rule `clock-keyframes`)."""

    def __init__(self, clock: Mapping[str, Any], channel: str, q: float) -> None:
        self.mode = clock["mode"]
        self.channel = channel
        self.q = q
        if self.mode not in ("fraction", "epoch"):
            raise EvaluationError(f"clock: the clock mode is {self.mode!r}, not fraction or epoch")
        self.revolutions = clock.get("revolutions", 1)
        if "revolutions" in clock and self.mode == "epoch":
            raise EvaluationError("revolutions: the clock is in epoch mode but has revolutions")
        if isinstance(self.revolutions, bool) or not isinstance(self.revolutions, int) or self.revolutions < 1:
            raise EvaluationError(f"revolutions: the clock has revolutions {self.revolutions!r}, not an integer of at least one")
        # the time of the timeline, s = q * L (section 2.11)
        self.s = q * loop_seconds(clock)
        if self.mode == "epoch":
            if "range" in clock and "keyframes" in clock:
                raise EvaluationError("clock-keyframes: the clock is in epoch mode and has both a range and keyframes, not one")
            if "keyframes" in clock:
                self.v = keyframe_value(keyframe_list(clock["keyframes"], "the clock"), self.s)
            else:
                rng = clock.get("range")
                if not isinstance(rng, list) or len(rng) != 2:
                    raise EvaluationError("clock-mode: the clock is in epoch mode but does not have a range of two numbers")
                a, b = (_number(x, "a clock range value") for x in rng)
                self.v = a + q * (b - a)
        elif "keyframes" in clock:
            raise EvaluationError("clock-keyframes: the clock is in fraction mode and has keyframes, which only an epoch clock takes")

    @classmethod
    def of_layer(cls, spec: Any, scene: _Reading) -> _Reading:
        """The clock of a layer (rule `layer-clock`), in epoch mode with its own channel, in one revolution, at the progress of the scene's
        clock."""
        if not isinstance(spec, Mapping) or not isinstance(spec.get("channel"), str):
            raise EvaluationError(f"layer-clock: a layer's clock is a dict with a channel, not {spec!r}")
        if ("range" in spec) == ("keyframes" in spec):
            raise EvaluationError(
                f"layer-clock: a layer's clock gives {'both' if 'range' in spec else 'neither'} of a range and keyframes, not one"
            )
        out = cls.__new__(cls)
        out.mode, out.channel, out.q, out.revolutions, out.s = "epoch", spec["channel"], scene.q, 1, scene.s
        if "keyframes" in spec:
            out.v = keyframe_value(keyframe_list(spec["keyframes"], "a layer's clock"), scene.s)
        else:
            rng = spec["range"]
            if not isinstance(rng, list) or len(rng) != 2:
                raise EvaluationError(f"layer-clock: a layer's clock range is {rng!r}, not two numbers")
            a, b = (_number(x, "a layer's clock range value") for x in rng)
            out.v = a + scene.q * (b - a)
        return out

    def of(self, trajectory: Trajectory) -> float:
        """The trajectory's reading ``u``, before any clamp."""
        if self.mode == "fraction":
            return self.q
        c = trajectory.clock_values(self.channel)
        return float((self.v - c[0]) / (c[-1] - c[0]))


class _Panel:
    def __init__(self, ev: _Evaluator, state: Mapping[str, Any], shown: Mapping[str, Any], reading: _Reading) -> None:
        self.ev = ev
        self.state = state
        self.shown = shown
        self.reading = reading
        try:
            self.declared = ev.doc["panels"][shown["panel"]]
        except (KeyError, TypeError):
            raise EvaluationError(f"state: a shown panel names {shown.get('panel')!r}, which is not a declared panel") from None
        if not isinstance(self.declared, Mapping) or not all(k in self.declared for k in ("frame", "reference", "layers")):
            raise EvaluationError(f"panel: panel {shown['panel']!r} lacks frame, reference, or layers")
        # the reference trajectory is resolved for every panel, whether or not a layer uses it (section 2.7)
        reference = self.declared["reference"]
        if not isinstance(reference, Mapping) or "sets" not in reference or "member" not in reference:
            raise EvaluationError(f"panel: the reference of panel {shown['panel']!r} lacks sets or member")
        data = self.one(reference["sets"])
        self.reference: tuple[SetData, int] | None = None
        if data is not None:
            if reference["member"] == "all" or (isinstance(reference["member"], Mapping) and "evenly_spaced" in reference["member"]):
                raise EvaluationError(
                    f"members: the member of the reference is {reference['member']!r}, but a reference resolves to one trajectory"
                )
            missing = [c for c in ev.doc["clock"]["channels"] if c != INDEX and c not in data.channels]
            if missing:
                raise EvaluationError(
                    f"clock-channel-carried: the trajectory set {data.id!r} of the reference lacks clock channels {missing}"
                )
            if reading.revolutions > 1 and not data.periodic:
                raise EvaluationError(
                    f"revolutions: the trajectory set {data.id!r} of the reference is not periodic, and the clock has "
                    f"{reading.revolutions} revolutions"
                )
            self.reference = (data, self.members(reference["member"], data)[0])

    # inputs (rule `input-scope`)

    def input(self, iid: str, shown: Mapping[str, Any] | None = None) -> Any:
        """The value of an input in this shown panel, or in the shown panel ``shown`` when given (rule `input-scope`)."""
        try:
            spec = self.ev.inputs[iid]
        except KeyError:
            raise EvaluationError(f"input: input {iid!r} is not declared") from None
        if spec.get("scope", "shared") == "per_panel":
            values = (self.shown if shown is None else shown).get("inputs", {})
        else:
            values = self.state.get("inputs", {})
        return values.get(iid, spec["default"])

    def value(self, spec: Any, shown: Mapping[str, Any] | None = None) -> Any:
        if isinstance(spec, Mapping) and "input" in spec:
            return self.input(spec["input"], shown)
        return spec

    # set queries and members (rules `set-query` and `members`)

    def match(self, query: Any) -> list[str]:
        sets = self.ev.doc["trajectory_sets"]
        if isinstance(query, Mapping) and "set" in query:
            if query["set"] not in sets:
                raise EvaluationError(f"set-query: the set query names {query['set']!r}, which is not a trajectory set")
            return [query["set"]]
        if not isinstance(query, Mapping) or not isinstance(query.get("tags"), Mapping):
            raise EvaluationError(f'set-query: a set query is {{"set": id}} or {{"tags": {{...}}}}, not {query!r}')
        wanted = {name: self.value(v) for name, v in query["tags"].items()}
        return [sid for sid, s in sets.items() if all((s.get("tags") or {}).get(k) == v for k, v in wanted.items())]

    def one(self, query: Mapping[str, Any]) -> SetData | None:
        matches = self.match(query)
        if len(matches) > 1:
            raise EvaluationError(
                f"set-query: the set query {dict(query)} matches the {len(matches)} trajectory sets {matches}, where one is needed"
            )
        return self.ev.set_data(matches[0]) if matches else None

    def members(self, ref: Any, data: SetData) -> list[int]:
        if ref == "all":
            return list(range(data.trajectories))
        if isinstance(ref, Mapping) and "index" in ref:
            k = ref["index"]
            if isinstance(k, bool) or not isinstance(k, int):
                raise EvaluationError(f"members: member index {k!r} is not an integer")
            if not 0 <= k < data.trajectories:
                raise EvaluationError(
                    f"members: member index {k} is not below the trajectory count {data.trajectories} of trajectory set {data.id!r}"
                )
            return [k]
        if isinstance(ref, Mapping) and "evenly_spaced" in ref:
            n = ref["evenly_spaced"]
            if isinstance(n, bool) or not isinstance(n, int) or n < 1:
                raise EvaluationError(f"members: member count {n!r} is not an integer of at least one")
            return sparse(data.trajectories, n)
        if isinstance(ref, Mapping) and "input" in ref:
            return [self.selected(ref["input"], data)]
        raise EvaluationError(
            f'members: a member reference is \'all\', {{"index": k}}, {{"evenly_spaced": n}}, or {{"input": id}}, not {ref!r}'
        )

    def selected(self, iid: str, data: SetData) -> int:
        spec = self.ev.inputs.get(iid)
        if spec is None or spec.get("kind") != "parameter":
            raise EvaluationError(f"members: input {iid!r} is not a parameter input")
        value = self.input(iid)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise EvaluationError(f"input: parameter input {iid!r} holds {value!r}, not a finite number")
        value = float(value)
        parameter = spec["parameter"]
        if parameter == INDEX:
            values = np.arange(data.trajectories, dtype=np.float64)
        elif parameter in data.parameters:
            values = data.parameters[parameter]
        else:
            raise EvaluationError(f"members: trajectory set {data.id!r} lacks parameter {parameter!r} for parameter input {iid!r}")
        # argmin takes the first of equal distances, i.e. the lowest index
        return int(np.argmin(np.abs(values - value)))

    # layers

    def run(self) -> dict[str, Any]:
        frame = self.value(self.declared["frame"])
        if frame not in self.ev.doc["frames"]:
            raise EvaluationError(f"panel: the panel displays {frame!r}, which is not a frame")
        self.frame = frame
        layers = []
        for layer in self.declared["layers"]:
            if not isinstance(layer, Mapping) or layer.get("kind") not in KINDS:
                raise EvaluationError(
                    f"version: layer kind {layer.get('kind') if isinstance(layer, Mapping) else layer!r} is not implemented"
                )
            if "visible" in layer:
                visible = layer["visible"]
                iid = visible.get("input") if isinstance(visible, Mapping) else None
                if iid is None or self.ev.inputs.get(iid, {}).get("kind") != "toggle":
                    raise EvaluationError(f"visible: a layer's visible names {iid!r}, which is not a toggle")
                if self.input(iid) is False:
                    continue
            kind = layer["kind"]
            if kind == "trajectories":
                layers.append(self.trajectories_layer(layer))
            elif kind == "arrow":
                layers.append(self.arrow_layer(layer))
            elif kind == "inset_box":
                layers.append(self.inset_box_layer(layer))
            elif kind == "body":
                layers.append(self.body_layer(layer))
            elif kind == "label":
                layers.append(self.label_layer(layer))
            elif kind == "points":
                layers.append(self.points_layer(layer))
            else:
                layers.append({"kind": kind})
        out: dict[str, Any] = {"frame": frame, "layers": layers}
        camera = self.declared.get("camera") or {"kind": "2d"}
        if isinstance(camera, Mapping) and camera.get("kind", "2d") == "2d" and "keyframes" in camera:
            out["camera"] = self.camera(camera)
        return out

    def reading_of(self, layer: Mapping[str, Any]) -> _Reading:
        """The clock a layer takes its readings on: its own (rule `layer-clock`), or the scene's."""
        return _Reading.of_layer(layer["clock"], self.reading) if "clock" in layer else self.reading

    def clamped(self, trajectory: Trajectory, layer: Mapping[str, Any], reading: _Reading | None = None) -> float | None:
        """The reading on ``trajectory``, clamped, or None when the trajectory is hidden under rule `before-after`."""
        u = (reading or self.reading).of(trajectory)
        if u < 0.0:
            if layer.get("before", "clamp") == "hidden":
                return None
            u = 0.0
        elif u > 1.0:
            if layer.get("after", "clamp") == "hidden":
                return None
            u = 1.0
        return u

    def trajectories_layer(self, layer: Mapping[str, Any]) -> dict[str, Any]:
        data = self.one(layer["sets"])
        if data is None:
            return {"kind": "trajectories", "set": None, "members": []}
        reveal = layer.get("reveal", "none")
        if reveal not in ("none", "grow", "trail"):
            raise EvaluationError(f"panel: a trajectories layer's reveal is {reveal!r}, not none, grow, or trail")
        head = layer.get("head", False)
        if not isinstance(head, (bool, Mapping)):
            raise EvaluationError(f"head: a trajectories layer's head is {head!r}, not a boolean or an object")
        # a head object gives the same point as true
        head = head is True or isinstance(head, Mapping)
        for key in ("before", "after"):
            if layer.get(key, "clamp") not in ("clamp", "hidden"):
                raise EvaluationError(f"before-after: a trajectories layer's {key} is {layer[key]!r}, not clamp or hidden")
        fraction = _fraction(layer) if reveal == "trail" else 0.0
        read_from = layer.get("read_from", "own")
        if read_from not in ("own", "reference"):
            raise EvaluationError(f"read-from: a trajectories layer's read_from is {read_from!r}, not own or reference")
        # under rule `clock-channel-carried`, a reading is not taken on a trajectory drawn whole and never hidden, whose trajectory set
        # need not carry the clock channels
        rd = self.reading_of(layer)
        hides = rd.mode == "epoch" and "hidden" in (layer.get("before"), layer.get("after"))
        reads = reveal != "none" or head or hides
        revolutions = rd.revolutions
        if reads and revolutions > 1 and not data.periodic:
            raise EvaluationError(
                f"revolutions: a reading is taken on trajectory set {data.id!r}, which is not periodic, and the clock has "
                f"{revolutions} revolutions"
            )
        at = self.reference_point() if read_from == "reference" and self.reference is not None else None
        members = []
        for i in self.members(layer["members"], data):
            trajectory = data.trajectory(i)
            entry: dict[str, Any] = {"index": i}
            u = self.clamped(trajectory, layer, rd) if reads else 0.0
            if u is None or (read_from == "reference" and at is None):
                entry["line"] = []
                if head:
                    entry["head"] = None
                members.append(entry)
                continue
            loop_reading = revolutions * u
            u_samples = trajectory.sample_readings(rd.channel) if reads else np.empty(0)
            if reveal == "none":
                vertices = whole(trajectory.m, revolutions, trajectory.periodic)
            elif reveal == "grow":
                vertices = loop_polyline(u_samples, 0.0, loop_reading, revolutions)
            else:
                vertices = trail(u_samples, loop_reading, revolutions, fraction, trajectory.periodic)

            if at is not None:
                table = _every_revolution(self.in_reference_context(trajectory.positions, data.frame, at))
            else:

                def positions(revolution: int, t: Trajectory = trajectory) -> np.ndarray:
                    return self.ev.tree.transform(t.positions, data.frame, self.frame, t.context(revolution))

                table = _by_revolution(positions)
            entry["line"] = resolve_vertices(vertices, table)
            if head:
                j, within = revolution_of(loop_reading, revolutions)
                entry["head"] = resolve_vertices([("blend", *segment(u_samples, within), j)], table)[0]
            members.append(entry)
        return {"kind": "trajectories", "set": data.id, "members": members}

    def arrow_layer(self, layer: Mapping[str, Any]) -> dict[str, Any]:
        """The base and the tip of each member's arrow at the reading (rule `arrow`)."""
        vector = layer.get("vector")
        if not isinstance(vector, list) or len(vector) not in (2, 3) or not all(isinstance(c, str) for c in vector):
            raise EvaluationError(f"arrow: an arrow layer's vector is {vector!r}, not two or three channel names")
        if INDEX in vector:
            raise EvaluationError(f"arrow: {INDEX} is not allowed in the vector of an arrow layer")
        scale = layer.get("scale", 1.0)
        if isinstance(scale, Mapping) and "channel" in scale:
            raise EvaluationError("arrow: the scale of an arrow layer takes a number or an attribute, not a channel")
        for key in ("before", "after"):
            if layer.get(key, "clamp") not in ("clamp", "hidden"):
                raise EvaluationError(f"before-after: an arrow layer's {key} is {layer[key]!r}, not clamp or hidden")
        data = self.one(layer["sets"])
        if data is None:
            return {"kind": "arrow", "set": None, "members": []}
        for name in vector:
            if name not in data.channels:
                raise EvaluationError(f"arrow: trajectory set {data.id!r} lacks channel {name!r} of an arrow layer's vector")
        rd = self.reading_of(layer)
        revolutions = rd.revolutions
        if revolutions > 1 and not data.periodic:
            raise EvaluationError(
                f"revolutions: a reading is taken on trajectory set {data.id!r}, which is not periodic, and the clock has "
                f"{revolutions} revolutions"
            )
        members = []
        for i in self.members(layer["members"], data):
            trajectory = data.trajectory(i)
            u = self.clamped(trajectory, layer, rd)
            if u is None:
                members.append({"index": i, "base": None, "tip": None})
                continue
            # the vector is read from the stored values in every revolution, since rule `revolutions` raises only the context
            v = np.zeros((trajectory.m, 3))
            for j, name in enumerate(vector):
                v[:, j] = trajectory.channels[name]
            tips = trajectory.positions + scalar(scale, trajectory.context()) * v

            def table(points: np.ndarray, t: Trajectory = trajectory) -> Callable[[int], np.ndarray]:
                return _by_revolution(lambda revolution: self.ev.tree.transform(points, data.frame, self.frame, t.context(revolution)))

            j, within = revolution_of(revolutions * u, revolutions)
            at = [("blend", *segment(trajectory.sample_readings(rd.channel), within), j)]
            base = resolve_vertices(at, table(trajectory.positions))[0]
            members.append({"index": i, "base": base, "tip": resolve_vertices(at, table(tips))[0]})
        return {"kind": "arrow", "set": data.id, "members": members}

    def inset_box_layer(self, layer: Mapping[str, Any]) -> dict[str, Any]:
        """The target panel and frame of an inset box layer, and the affine map from the target frame at the reading of the
        reference trajectory (rule `inset-box`)."""
        declared = self.ev.doc["panels"]
        pid = layer.get("panel")
        if not isinstance(pid, str) or pid not in declared:
            raise EvaluationError(f"inset-box: an inset box layer names {pid!r}, which is not a declared panel")
        if pid == self.shown["panel"]:
            raise EvaluationError(f"inset-box: an inset box layer of panel {pid!r} names its own panel")
        camera = declared[pid].get("camera") or {"kind": "2d"}
        if camera.get("kind") != "2d":
            raise EvaluationError(f"inset-box: an inset box layer names panel {pid!r}, whose camera is not a 2d camera")
        out: dict[str, Any] = {"kind": "inset_box", "panel": pid, "shown_panel": None, "frame": None, "origin": None, "axes": None}
        shown = self.state["panels"]
        # the first shown copy of the target panel in layout order
        target = next((sid for sid in _leaves(self.state["layout"]) if shown[sid].get("panel") == pid), None)
        if target is None:
            return out
        frame = self.value(declared[pid]["frame"], shown[target])
        if frame not in self.ev.doc["frames"]:
            raise EvaluationError(f"panel: the panel {pid!r} displays {frame!r}, which is not a frame")
        out["shown_panel"], out["frame"] = target, frame
        if self.reference is None:
            return out
        # every edge is affine for a fixed context, and so is the blend of two, hence the map is given by the images of the origin and the
        # unit points
        image = self.in_reference_context(np.vstack([np.zeros(3), np.eye(3)]), frame, self.reference_point())
        out["origin"] = [float(x) for x in image[0]]
        out["axes"] = [[float(x) for x in image[j] - image[0]] for j in (1, 2, 3)]
        return out

    def reference_point(self) -> tuple[Trajectory, np.ndarray, float, int, int, float]:
        """The reference trajectory, its sample readings, its loop reading, and the revolution, segment, and weight of the point
        at the reading.

        A body layer and a layer that reads from the reference lack before and after, thus the reading is clamped (rules
        `body-layer` and `read-from`).
        """
        assert self.reference is not None
        data, k_member = self.reference
        trajectory = data.trajectory(k_member)
        loop_reading = self.reading.revolutions * min(max(self.reading.of(trajectory), 0.0), 1.0)
        u_samples = trajectory.sample_readings(self.reading.channel)
        j, within = revolution_of(loop_reading, self.reading.revolutions)
        k, w = segment(u_samples, within)
        return trajectory, u_samples, loop_reading, j, k, w

    def in_reference_context(self, points: np.ndarray, src: str, at: tuple[Trajectory, np.ndarray, float, int, int, float]) -> np.ndarray:
        """Points of frame ``src`` in the display frame, in the blended context of the point ``at`` of the reference trajectory
        (rules `body-layer` and `read-from`)."""
        trajectory, _, _, j, k, w = at
        n = len(points)
        a = self.ev.tree.transform(points, src, self.frame, trajectory.sample_context(j, k, n))
        b = self.ev.tree.transform(points, src, self.frame, trajectory.sample_context(j, k + 1, n))
        return (1.0 - w) * a + w * b

    def body_layer(self, layer: Mapping[str, Any]) -> dict[str, Any]:
        body = layer.get("body")
        if not isinstance(body, str) or body not in self.ev.tree.bodies:
            raise EvaluationError(f"body-layer: a body layer draws {body!r}, which is not a body")
        out: dict[str, Any] = {"kind": "body", "body": body}
        fraction = _fraction(layer) if "trail" in layer else None
        if self.reference is None:
            out["position"] = None
            if fraction is not None:
                out["trail"] = []
            return out
        trajectory, u_samples, loop_reading, j, k, w = self.reference_point()
        revolutions = self.reading.revolutions
        tree = self.ev.tree
        table = _by_revolution(lambda revolution: tree.body_position(body, self.frame, trajectory.context(revolution)))
        out["position"] = resolve_vertices([("blend", k, w, j)], table)[0]
        if fraction is not None:
            out["trail"] = resolve_vertices(trail(u_samples, loop_reading, revolutions, fraction, trajectory.periodic), table)
        return out

    def point_at_reading(self, layer: Mapping[str, Any], data: SetData, k: int, *, read_from: str = "own") -> list[float] | None:
        """The point at the reading of trajectory ``k`` of ``data`` under the layer's clock, with the reading clamped to [0, 1] as
        in rule `body-layer`.

        It is taken in the context of its sample in its revolution of rule `revolutions`, or, with ``read_from="reference"``, in
        the context of the reference trajectory (rule `read-from`), where it is None without a reference trajectory.
        """
        rd = self.reading_of(layer)
        if rd.revolutions > 1 and not data.periodic:
            raise EvaluationError(
                f"revolutions: a reading is taken on trajectory set {data.id!r}, which is not periodic, and the clock has "
                f"{rd.revolutions} revolutions"
            )
        trajectory = data.trajectory(k)
        u = min(max(rd.of(trajectory), 0.0), 1.0)
        j, within = revolution_of(rd.revolutions * u, rd.revolutions)
        kk, w = segment(trajectory.sample_readings(rd.channel), within)
        if read_from == "reference":
            if self.reference is None:
                return None
            table = _every_revolution(self.in_reference_context(trajectory.positions, data.frame, self.reference_point()))
        else:
            table = _by_revolution(
                lambda revolution: self.ev.tree.transform(trajectory.positions, data.frame, self.frame, trajectory.context(revolution))
            )
        return resolve_vertices([("blend", kk, w, j)], table)[0]

    def label_layer(self, layer: Mapping[str, Any]) -> dict[str, Any]:
        """The position of a label's anchor in the display frame (rule `label`), or None on the screen and without a set or a reference
        trajectory."""
        at = layer.get("at")
        out: dict[str, Any] = {"kind": "label", "position": None}
        if not isinstance(at, Mapping):
            raise EvaluationError(f"label: a label's anchor is {at!r}, not an object")
        if "screen" in at:
            return out
        if "point" in at:
            point = at["point"]
            if not isinstance(point, list) or len(point) != 3:
                raise EvaluationError(f"label: a label's point is {point!r}, not three numbers")
            p = np.array([[_number(x, "label: a label's point") for x in point]])
            if "frame" not in at:
                out["position"] = [float(x) for x in p[0]]
                return out
            if at["frame"] not in self.ev.doc["frames"]:
                raise EvaluationError(f"label: a label's point is in {at['frame']!r}, which is not a frame")
            if self.reference is None:
                return out
            out["position"] = [float(x) for x in self.in_reference_context(p, at["frame"], self.reference_point())[0]]
            return out
        if "sets" in at:
            k = at.get("member")
            if isinstance(k, bool) or not isinstance(k, int) or k < 0:
                raise EvaluationError(f"label: a label's member is {k!r}, not a trajectory index")
            data = self.one(at["sets"])
            if data is None:
                return out
            if k >= data.trajectories:
                raise EvaluationError(
                    f"label: a label's member {k} is not below the trajectory count {data.trajectories} of trajectory set {data.id!r}"
                )
            out["position"] = self.point_at_reading(layer, data, k)
            return out
        raise EvaluationError(f"label: a label's anchor is a point, a member, or a screen place, not {dict(at)!r}")

    def points_layer(self, layer: Mapping[str, Any]) -> dict[str, Any]:
        """The drawn samples of every member of a points layer (rule `points`)."""
        reveal = layer.get("reveal", "none")
        if reveal not in ("none", "grow"):
            raise EvaluationError(f"points: a points layer's reveal is {reveal!r}, not none or grow")
        for key in ("before", "after"):
            if layer.get(key, "clamp") not in ("clamp", "hidden"):
                raise EvaluationError(f"before-after: a points layer's {key} is {layer[key]!r}, not clamp or hidden")
        data = self.one(layer["sets"])
        if data is None:
            return {"kind": "points", "set": None, "members": []}
        rd = self.reading_of(layer)
        hides = rd.mode == "epoch" and "hidden" in (layer.get("before"), layer.get("after"))
        if (reveal == "grow" or hides) and rd.revolutions > 1 and not data.periodic:
            raise EvaluationError(
                f"revolutions: a reading is taken on trajectory set {data.id!r}, which is not periodic, and the clock has "
                f"{rd.revolutions} revolutions"
            )
        members = []
        for i in self.members(layer["members"], data):
            trajectory = data.trajectory(i)
            # each sample in its own context, in revolution 0
            p = self.ev.tree.transform(trajectory.positions, data.frame, self.frame, trajectory.context(0))
            shown = np.ones(trajectory.m, dtype=bool)
            if reveal == "grow" or hides:
                u = rd.of(trajectory)
                if (u < 0.0 and layer.get("before") == "hidden") or (u > 1.0 and layer.get("after") == "hidden"):
                    shown[:] = False
                elif reveal == "grow":
                    shown = np.zeros(trajectory.m, dtype=bool) if u < 0.0 else trajectory.sample_readings(rd.channel) <= u
            members.append({"index": i, "points": [[float(x) for x in row] for row in p[shown]]})
        return {"kind": "points", "set": data.id, "members": members}

    def camera(self, camera: Mapping[str, Any]) -> dict[str, Any] | None:
        """The window of a 2d camera with keyframes at the time of the timeline (rule `camera-keyframes`), or None when a keyframe
        it needs lacks a center."""
        keys = camera["keyframes"]
        layers = self.declared["layers"]
        if not isinstance(keys, list) or not keys:
            raise EvaluationError(f"camera-keyframes: the keyframes of a camera are {keys!r}, not a nonempty list")
        axes = {"xy": (0, 1), "xz": (0, 2), "yz": (1, 2)}.get(camera.get("plane", "xy"))
        if axes is None:
            raise EvaluationError(f"panel: a camera plane is {camera.get('plane')!r}, not xy, xz, or yz")
        checked = []
        for key in keys:
            if not isinstance(key, Mapping):
                raise EvaluationError(f"camera-keyframes: a camera keyframe is {key!r}, not an object")
            at = _number(key.get("at"), "camera-keyframes: the time of a camera keyframe")
            width = _number(key.get("width"), "camera-keyframes: the width of a camera keyframe")
            if width <= 0.0:
                raise EvaluationError(f"camera-keyframes: the width of a camera keyframe is {width}, not positive")
            height = None
            if "height" in key:
                height = _number(key["height"], "camera-keyframes: the height of a camera keyframe")
                if height <= 0.0:
                    raise EvaluationError(f"camera-keyframes: the height of a camera keyframe is {height}, not positive")
            name = key.get("ease", "linear")
            if name not in EASES:
                raise EvaluationError(f"ease: a camera keyframe has the ease {name!r}, not one of {', '.join(EASES)}")
            for target in key.get("follow", []):
                i = target.get("layer") if isinstance(target, Mapping) else None
                k = target.get("member") if isinstance(target, Mapping) else None
                if not isinstance(i, int) or not isinstance(k, int) or isinstance(i, bool) or isinstance(k, bool) or i < 0 or k < 0:
                    raise EvaluationError(f"camera-keyframes: a camera target is {target!r}, not a layer index and a member index")
                if i >= len(layers) or not isinstance(layers[i], Mapping) or layers[i].get("kind") != "trajectories":
                    raise EvaluationError(
                        f"camera-keyframes: a camera keyframe follows layer {i}, which is not a trajectories layer of the panel"
                    )
                data = self.one(layers[i]["sets"])
                if data is not None and k >= data.trajectories:
                    raise EvaluationError(
                        f"camera-keyframes: a camera keyframe follows member {k}, which is not below the trajectory count "
                        f"{data.trajectories} of {data.id!r}"
                    )
            if checked and at < checked[-1][0]:
                raise EvaluationError(f"camera-keyframes: the times of the camera keyframes decrease from {checked[-1][0]} to {at}")
            checked.append((at, width, height, name))
        heights = [c[2] is not None for c in checked]
        if any(heights) and not all(heights):
            raise EvaluationError("camera-keyframes: some keyframes of a camera give a height and others do not")
        if any(heights) and camera.get("aspect", "equal") != "free":
            raise EvaluationError('camera-keyframes: a camera keyframe gives a height, which only a camera with "aspect": "free" takes')

        def center(key: Mapping[str, Any]) -> list[float] | None:
            points = []
            for target in key.get("follow", []):
                layer = layers[target["layer"]]
                data = self.one(layer["sets"])
                if data is None:
                    continue
                p = self.point_at_reading(layer, data, target["member"], read_from=layer.get("read_from", "own"))
                if p is not None:
                    points.append(p)
            if points:
                offset = key.get("offset", [0.0, 0.0])
                a = sum(p[axes[0]] for p in points) / len(points)
                b = sum(p[axes[1]] for p in points) / len(points)
                return [a + _number(offset[0], "camera-keyframes: an offset"), b + _number(offset[1], "camera-keyframes: an offset")]
            if "center" in key:
                c = key["center"]
                if not isinstance(c, list) or len(c) != 2:
                    raise EvaluationError(f"camera-keyframes: the center of a camera keyframe is {c!r}, not two numbers")
                return [_number(c[0], "camera-keyframes: a center"), _number(c[1], "camera-keyframes: a center")]
            return None

        s = self.reading.s
        i = -1
        for j, c in enumerate(checked):
            if c[0] <= s:
                i = j
        if i < 0 or i == len(keys) - 1:
            n = max(i, 0)
            c0 = center(keys[n])
            if c0 is None:
                return None
            return {"center": c0, "width": checked[n][1], "height": checked[n][2]}
        c0, c1 = center(keys[i]), center(keys[i + 1])
        if c0 is None or c1 is None:
            return None
        x = (s - checked[i][0]) / (checked[i + 1][0] - checked[i][0])
        e = ease(checked[i + 1][3], x)
        w0, w1 = checked[i][1], checked[i + 1][1]
        out: dict[str, Any] = {
            "center": [(1.0 - e) * c0[0] + e * c1[0], (1.0 - e) * c0[1] + e * c1[1]],
            "width": math.exp((1.0 - e) * math.log(w0) + e * math.log(w1)),
            "height": None,
        }
        h0, h1 = checked[i][2], checked[i + 1][2]
        if h0 is not None and h1 is not None:
            out["height"] = math.exp((1.0 - e) * math.log(h0) + e * math.log(h1))
        return out


def _fraction(layer: Mapping[str, Any]) -> float:
    """The trail fraction ``trail.fraction`` of a layer, in ``(0, 1]`` (section 2.7)."""
    spec = layer.get("trail")
    if not isinstance(spec, Mapping) or "fraction" not in spec:
        raise EvaluationError("panel: a layer draws a trail but lacks a trail fraction")
    f = _number(spec["fraction"], "a trail fraction")
    if not 0.0 < f <= 1.0:
        raise EvaluationError(f"panel: the trail fraction {f} is not in (0, 1]")
    return f


def sparse(trajectories: int, n: int) -> list[int]:
    """The trajectories of ``{"evenly_spaced": n}`` (rule `members`), which are every ``step``-th trajectory from the first, and the last.

    The step is ``floor(trajectories / n + 0.5)``, or 1 when ``n`` is at least ``trajectories``.
    """
    step = 1 if n >= trajectories else math.floor(trajectories / n + 0.5)
    out = list(range(0, trajectories, step))
    if out[-1] != trajectories - 1:
        out.append(trajectories - 1)
    return out


def _every_revolution(positions: np.ndarray) -> Callable[[int], np.ndarray]:
    """A table of positions that is the same in every revolution, as for a layer that reads from the reference (rule `read-from`)."""
    return lambda _revolution: positions


def _by_revolution(compute: Callable[[int], np.ndarray]) -> Callable[[int], np.ndarray]:
    """Returns ``compute`` wrapped in a cache, so that it runs once per revolution."""
    cache: dict[int, np.ndarray] = {}

    def get(revolution: int) -> np.ndarray:
        if revolution not in cache:
            cache[revolution] = compute(revolution)
        return cache[revolution]

    return get
