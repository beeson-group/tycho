"""The Scene API, which takes declarations and arrays and writes ``scene.tys`` and ``data.tyd``.

A :class:`Scene` records frames, bodies, track sets, variables, the clock, views, panels,
controls, and readouts, and writes them as the scene document and the data container of
``spec/tycho-scene.md``. It does not hold any dynamics or frame formula, and it never interpolates.

Every builder checks what it can at the call and raises :class:`SceneError`, whose message refers to
the broken rule. The checks that depend on the whole scene, i.e. the cross-references and the rules
that must hold for every value the variables can take, are made by :meth:`Scene.to_document`,
which reports every failure at once.
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Mapping, Sequence
from typing import Any

import numpy as np

from ._evaluate import Context, FrameTree
from ._thin import select

ID = re.compile(r"[A-Za-z0-9_.-]+")
HEX = re.compile(r"#[0-9a-fA-F]{6}")
COLORMAPS = ("viridis", "plasma", "cividis", "blues", "reds")
INDEX = "@index"


class SceneError(ValueError):
    """A declaration that breaks a rule, with the rule given by its number."""


def _check_id(value: Any, what: str) -> str:
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise SceneError(f"S3: {what} {value!r} does not match [A-Za-z0-9_.-]+")
    return value


def _finite(value: Any, what: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float, np.integer, np.floating)):
        raise SceneError(f"{what} is {value!r}, not a number")
    x = float(value)
    if not math.isfinite(x):
        raise SceneError(f"S4: {what} is {value!r}, not finite")
    return x


def _integer(value: Any, what: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, np.integer)):
        raise SceneError(f"{what} is {value!r}, not an integer")
    return int(value)


def _enum(value: Any, allowed: Sequence[str], what: str) -> str:
    if value not in allowed:
        raise SceneError(f"{what} is {value!r}, not one of {', '.join(allowed)}")
    return value


def _text(value: Any, what: str) -> str:
    if not isinstance(value, str):
        raise SceneError(f"{what} is {value!r}, not text")
    return value


def _color(value: Any, what: str) -> str:
    if not isinstance(value, str) or not HEX.fullmatch(value):
        raise SceneError(f"{what} is {value!r}, not a #rrggbb color")
    return value


# scalars


class Channel:
    """A per-sample channel, read at the context's sample."""

    def __init__(self, name: str) -> None:
        self.name = _text(name, "a channel name")

    def to_json(self) -> dict[str, Any]:
        return {"channel": self.name}


class Attr:
    """A set attribute, as ``factor * attrs[name] + offset``."""

    def __init__(self, name: str, factor: float = 1.0, offset: float = 0.0) -> None:
        self.name = _text(name, "an attribute name")
        self.factor, self.offset = _finite(factor, "an attribute factor"), _finite(offset, "an attribute offset")

    def __neg__(self) -> Attr:
        return Attr(self.name, -self.factor, -self.offset)

    def __mul__(self, k: float) -> Attr:
        return Attr(self.name, self.factor * k, self.offset * k)

    __rmul__ = __mul__

    def __add__(self, c: float) -> Attr:
        return Attr(self.name, self.factor, self.offset + c)

    __radd__ = __add__

    def __sub__(self, c: float) -> Attr:
        return Attr(self.name, self.factor, self.offset - c)

    def __rsub__(self, c: float) -> Attr:
        return Attr(self.name, -self.factor, c - self.offset)

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"attr": self.name}
        if self.factor != 1.0:
            out["factor"] = self.factor
        if self.offset != 0.0:
            out["offset"] = self.offset
        return out


class Rotation:
    """A rotation by ``angle`` radians about ``axis``."""

    def __init__(self, axis: str, angle: Any) -> None:
        self.axis = _enum(axis, ("x", "y", "z"), "F1: a rotation axis")
        self.angle = _scalar(angle, "a rotation angle")

    def to_json(self) -> dict[str, Any]:
        return {"axis": self.axis, "angle": self.angle}


def channel(name: str) -> Channel:
    """A channel scalar."""
    return Channel(name)


def attr(name: str) -> Attr:
    """An attribute scalar. The expression ``1 - attr("mu")`` gives factor -1 and offset 1."""
    return Attr(name)


def rotation(axis: str, angle: Any) -> Rotation:
    """A rotation about ``axis`` by ``angle``, which is a number, an attribute, or a channel."""
    return Rotation(axis, angle)


def _scalar(value: Any, what: str, *, constant: bool = False) -> Any:
    """The JSON of a number, an attribute, or a channel (section 2.2)."""
    if isinstance(value, Channel):
        if constant:
            raise SceneError(f"F2: {what} takes a number or an attribute, not a channel")
        if value.name == INDEX:
            raise SceneError(f"2.2: {what} reads channel {INDEX}, which is not allowed in a frame edge")
        return value.to_json()
    if isinstance(value, Attr):
        return value.to_json()
    return _finite(value, what)


def _point(values: Any, what: str) -> list[Any]:
    """A list of three constant scalars (rules F2 and 2.4)."""
    if isinstance(values, (str, bytes, Mapping)) or not isinstance(values, (Sequence, np.ndarray)) or len(values) != 3:
        raise SceneError(f"F2: {what} is {values!r}, not three scalars")
    return [_scalar(v, what, constant=True) for v in values]


# handles


class Frame:
    """A declared frame."""

    def __init__(self, fid: str) -> None:
        self.id = fid


class Body:
    """A declared body."""

    def __init__(self, bid: str) -> None:
        self.id = bid


class Variable:
    """A declared variable."""

    def __init__(self, vid: str, kind: str) -> None:
        self.id, self.kind = vid, kind

    def to_json(self) -> dict[str, Any]:
        return {"var": self.id}


def _id(value: Any) -> str:
    return value.id if isinstance(value, (Frame, Body, Variable, TrackSet)) else value


def _var(value: Any, what: str, kind: str | None = None) -> dict[str, Any]:
    """The reference ``{"var": id}`` to a variable given as a handle or an id.

    A handle of the wrong kind fails here, and an id of the wrong kind fails at the write.
    """
    if isinstance(value, Variable):
        if kind is not None and value.kind != kind:
            raise SceneError(f"{what} names {value.id!r}, which is a {value.kind}, not a {kind}")
        return value.to_json()
    return {"var": _check_id(value, what)}


# layers and queries


def sets(tags: Mapping[str, Any] | None = None, **kw: Any) -> dict[str, Any]:
    """A tags query, with values that are strings or choice variables."""
    merged = {**(tags or {}), **kw}
    out: dict[str, Any] = {}
    for k, v in merged.items():
        if isinstance(v, Variable):
            out[_text(k, "a tag name")] = _var(v, "V2: a tag value", "choice")
        elif isinstance(v, Mapping) and set(v) == {"var"}:
            out[_text(k, "a tag name")] = _var(v["var"], "V2: a tag value", "choice")
        else:
            out[_text(k, "a tag name")] = _text(v, "a tag value")
    return {"tags": out}


def set_id(value: Any) -> dict[str, Any]:
    """A query for one track set, by id or handle."""
    return {"set": _check_id(_id(value), "a track set id")}


def _query(value: Any) -> dict[str, Any]:
    if isinstance(value, (str, TrackSet)):
        return set_id(value)
    if isinstance(value, Mapping) and set(value) == {"set"}:
        return set_id(value["set"])
    if isinstance(value, Mapping) and set(value) == {"tags"} and isinstance(value["tags"], Mapping):
        return {
            "tags": {
                k: (_var(v["var"], "V2: a tag value") if isinstance(v, Mapping) else _text(v, "a tag value"))
                for k, v in value["tags"].items()
            }
        }
    raise SceneError(f"V2: a set query is a track set id, a handle, or sets(...), not {value!r}")


def every(n: int) -> dict[str, int]:
    """A sparse member reference ``{"count": n}``, which selects every ``s``-th track from the first, and the last (rule V3).

    The step ``s`` is ``floor(tracks / n + 0.5)``, or 1 when ``n`` is at least the number of tracks.
    """
    k = _integer(n, "V3: a member count")
    if k < 1:
        raise SceneError(f"V3: a member count is {k}, fewer than one")
    return {"count": k}


def _member(value: Any, what: str, *, one: bool = False) -> Any:
    if isinstance(value, str) and value == "all":
        if one:
            raise SceneError(f"V3: {what} is 'all', but a driver resolves to one track")
        return "all"
    if isinstance(value, (Variable, str)):
        return _var(value, what, "selector")
    if isinstance(value, Mapping) and set(value) == {"count"}:
        if one:
            raise SceneError(f"V3: {what} is a count, but a driver resolves to one track")
        return every(value["count"])
    if isinstance(value, Mapping) and set(value) == {"index"}:
        value = value["index"]
    if isinstance(value, Mapping) and set(value) == {"var"}:
        return _var(value["var"], what, "selector")
    k = _integer(value, f"V3: {what}")
    if k < 0:
        raise SceneError(f"V3: {what} is {k}, a negative track index")
    return {"index": k}


def driver(sets: Any, member: Any) -> dict[str, Any]:
    """A view's driver, given by a set query and a member, which is a track index or a selector."""
    return {"sets": _query(sets), "member": _member(member, "the driver's member", one=True)}


# track sets


class TrackSet:
    """A collection of tracks that share a frame. Each :meth:`add` gives one track."""

    def __init__(
        self,
        scene: Scene,
        sid: str,
        frame: str,
        tags: Mapping[str, str],
        attrs: Mapping[str, float],
        periodic: bool,
        dtype: str,
        label: str | None,
        channel_dtypes: Mapping[str, str],
    ) -> None:
        self.scene, self.id, self.frame = scene, sid, frame
        self.tags = {_text(k, "a tag name"): _text(v, f"tag {k!r} of track set {sid!r}") for k, v in tags.items()}
        self.attrs = {_text(k, "an attribute name"): _finite(v, f"attribute {k!r} of track set {sid!r}") for k, v in attrs.items()}
        if not isinstance(periodic, bool):
            raise SceneError(f"T2: track set {sid!r} has periodic {periodic!r}, not a boolean")
        self.periodic, self.dtype, self.label = periodic, dtype, label
        self.channel_dtypes = dict(channel_dtypes)
        self.positions: list[np.ndarray] = []
        self.channels: list[dict[str, np.ndarray]] = []
        self.parameters: list[dict[str, float]] = []
        self.channel_info: dict[str, dict[str, str]] = {}
        self.parameter_info: dict[str, dict[str, str]] = {}
        self.kept: list[np.ndarray] | None = None

    @property
    def tracks(self) -> int:
        """The number of tracks added so far."""
        return len(self.positions)

    def add(self, positions: Any, *, channels: Mapping[str, Any] | None = None, parameters: Mapping[str, float] | None = None) -> int:
        """Adds one track, copying its arrays, and returns its index. Every track must give the same channel and parameter names."""
        if self.kept is not None:
            raise SceneError(f"track set {self.id!r} is already thinned")
        p = np.array(positions, dtype=np.float64, copy=True)
        if p.ndim != 2 or p.shape[1] not in (2, 3):
            raise SceneError(f"2.1: track set {self.id!r}: positions have shape {p.shape}, not (m, 2) or (m, 3)")
        if len(p) < 2:
            raise SceneError(f"T1: track set {self.id!r}: the sample count of the added track is {len(p)}, fewer than two")
        if not np.all(np.isfinite(p)):
            raise SceneError(f"2.1: track set {self.id!r}: positions are not all finite")
        if self.positions and p.shape[1] != self.positions[0].shape[1]:
            raise SceneError(f"2.1: track set {self.id!r} mixes 2D and 3D positions")
        chans = {}
        for k, v in (channels or {}).items():
            if _text(k, "a channel name") == INDEX:
                raise SceneError(f"S3: the channel name {INDEX} is reserved")
            c = np.array(v, dtype=np.float64, copy=True)
            if c.shape != (len(p),):
                raise SceneError(f"2.1: track set {self.id!r}: channel {k!r} has shape {c.shape}, not ({len(p)},)")
            if not np.all(np.isfinite(c)):
                raise SceneError(f"2.1: track set {self.id!r}: channel {k!r} is not all finite")
            chans[k] = c
        if not self.positions and (missing := sorted(set(self.channel_dtypes) - set(chans))):
            raise SceneError(f"D1: channel_dtypes of track set {self.id!r} names channels {missing}, which the track set lacks")
        params = {
            _text(k, "a parameter name"): _finite(v, f"2.1: parameter {k!r} of track set {self.id!r}")
            for k, v in (parameters or {}).items()
        }
        if self.positions and (set(chans) != set(self.channels[0]) or set(params) != set(self.parameters[0])):
            raise SceneError(f"2.1: track set {self.id!r}: the added track gives other channel or parameter names than the first")
        self.positions.append(p)
        self.channels.append(chans)
        self.parameters.append(params)
        return len(self.positions) - 1

    def describe(self, name: str, *, interp: str | None = None, unit: str | None = None, label: str | None = None) -> None:
        """Sets the ``interp`` and ``unit`` of a channel, or the ``label`` and ``unit`` of a parameter, after the first :meth:`add`."""
        if not self.positions:
            raise SceneError(f"track set {self.id!r} does not have a track yet, hence {name!r} cannot be described")
        is_channel, is_parameter = name in self.channels[0], name in self.parameters[0]
        if is_channel and is_parameter:
            raise SceneError(f"2.1: {name!r} is both a channel and a parameter of track set {self.id!r}. Describe it under one name")
        if not (is_channel or is_parameter):
            raise SceneError(f"2.1: track set {self.id!r} lacks a channel or a parameter named {name!r}")
        info = self.channel_info if is_channel else self.parameter_info
        entry = info.setdefault(name, {})
        if interp is not None:
            if is_parameter:
                raise SceneError(f"2.1: an interp is given for parameter {name!r} of track set {self.id!r}, and only a channel takes one")
            entry["interp"] = _enum(interp, ("linear", "hold"), f"2.1: the interp of channel {name!r}")
        if label is not None:
            if is_channel:
                raise SceneError(f"2.1: a label is given for channel {name!r} of track set {self.id!r}, and only a parameter takes one")
            entry["label"] = _text(label, "a label")
        if unit is not None:
            entry["unit"] = _text(unit, "a unit")

    def _context(self, i: int) -> Context:
        chans = dict(self.channels[i])
        m = len(self.positions[i])
        chans[INDEX] = np.arange(m, dtype=np.float64)
        return Context(self.attrs, chans.get, m)

    def thin(
        self,
        n: int | None = None,
        *,
        tolerance: float | None = None,
        keep: Sequence[Sequence[int]] | Callable[[int], Sequence[int]] | None = None,
        frames: Sequence[Any] | None = None,
    ) -> list[np.ndarray]:
        """Selects a subset of the stored samples of each track, and does not create new samples. Returns a copy of the kept indices.

        In count mode, ``n`` samples are kept per track at equal steps of blended arclength. The arclength is measured
        in every frame of ``frames`` (by default the track set's frame), relative to the track set's extent in the same frame.
        In tolerance mode, the samples are chosen by the Douglas-Peucker algorithm, relative to the same extent. Both
        endpoints and every index in ``keep`` are always kept, even when they number more than ``n``.
        """
        if not self.positions:
            raise SceneError(f"track set {self.id!r} does not have a track to thin")
        if self.kept is not None:
            raise SceneError(f"track set {self.id!r} is already thinned")
        frame_ids = [_check_id(_id(f), "a frame id") for f in (frames or [self.frame])]
        for fid in frame_ids:
            if fid not in self.scene._frames:
                raise SceneError(f"2.3: thin measures in {fid!r}, which is not a declared frame")
        if keep is not None and not callable(keep) and len(keep) != len(self.positions):
            raise SceneError(f"keep has {len(keep)} entries for the {len(self.positions)} tracks of track set {self.id!r}")
        try:
            tree = FrameTree(self.scene._frames, self.scene._bodies)
            in_frames = []
            for fid in frame_ids:
                per_track = []
                for i, p in enumerate(self.positions):
                    p3 = np.hstack([p, np.zeros((len(p), 1))]) if p.shape[1] == 2 else p
                    per_track.append(tree.transform(p3, self.frame, fid, self._context(i)))
                in_frames.append(per_track)
            kept = select(in_frames, n=n, tolerance=tolerance, keep=keep)
        except ValueError as exc:
            raise SceneError(f"track set {self.id!r} cannot be thinned: {exc}") from None
        self.kept = [np.array(k, dtype=np.int64) for k in kept]
        for k in self.kept:
            k.flags.writeable = False
        return [k.copy() for k in self.kept]

    def _stored(self) -> tuple[list[np.ndarray], list[dict[str, np.ndarray]]]:
        if self.kept is None:
            return self.positions, self.channels
        return (
            [p[k] for p, k in zip(self.positions, self.kept, strict=True)],
            [{n: v[k] for n, v in c.items()} for c, k in zip(self.channels, self.kept, strict=True)],
        )


# the scene


class Scene:
    """A TyCHO scene under construction."""

    def __init__(self, title: str | None = None, theme: Mapping[str, str] | None = None) -> None:
        self.title = _text(title, "a title") if title is not None else None
        self.theme: dict[str, str] | None = None
        if theme is not None:
            if extra := set(theme) - {"background", "foreground", "grid"}:
                raise SceneError(f"a theme has unknown keys {sorted(extra)}")
            self.theme = {k: _color(v, f"theme {k}") for k, v in theme.items()}
        self._frames: dict[str, dict[str, Any]] = {}
        self._bodies: dict[str, dict[str, Any]] = {}
        self._sets: dict[str, TrackSet] = {}
        self._variables: dict[str, dict[str, Any]] = {}
        self._clock: dict[str, Any] | None = None
        self._views: dict[str, dict[str, Any]] = {}
        self._controls: list[dict[str, Any]] = []
        self._readouts: list[dict[str, Any]] = []
        self._panels: dict[str, dict[str, Any]] = {}
        self._layout: dict[str, Any] | None = None

    def _new(self, table: Mapping[str, Any], value: str, what: str) -> str:
        _check_id(value, what)
        if value in table:
            raise SceneError(f"{what} {value!r} is declared twice")
        return value

    def frame(
        self,
        id: str,
        *,
        label: str | None = None,
        axes: Sequence[str] | None = None,
        unit: str | None = None,
        parent: Any = None,
        origin: Any = None,
        rotation: Rotation | None = None,
        scale: Any = None,
    ) -> Frame:
        """Declares a frame, defined against ``parent`` by ``origin``, ``rotation``, and ``scale`` (rule F1)."""
        self._new(self._frames, id, "frame")
        out: dict[str, Any] = {}
        if label is not None:
            out["label"] = _text(label, "a frame label")
        if axes is not None:
            names = [_text(a, "an axis label") for a in axes]
            if len(names) > 3:
                raise SceneError(f"2.3: frame {id!r} has {len(names)} axis labels, more than three")
            out["axes"] = names + [""] * (3 - len(names))
        if unit is not None:
            out["unit"] = _text(unit, "a unit")
        if parent is None:
            if any(x is not None for x in (origin, rotation, scale)):
                raise SceneError(f"2.3: frame {id!r} has an edge but does not have a parent")
            if any("parent" not in f for f in self._frames.values()):
                raise SceneError(f"2.3: frame {id!r} would be a second root")
        else:
            if _id(parent) not in self._frames:
                raise SceneError(f"2.3: the parent {_id(parent)!r} of frame {id!r} is not declared")
            out["parent"] = _id(parent)
        if isinstance(origin, Body) or (isinstance(origin, Mapping) and set(origin) == {"body"}):
            bid = _id(origin) if isinstance(origin, Body) else origin["body"]
            if bid not in self._bodies:
                raise SceneError(f"F2: the origin of frame {id!r} is at {bid!r}, which is not a declared body")
            out["origin"] = {"body": bid}
        elif origin is not None:
            out["origin"] = _point(origin, f"the origin of frame {id!r}")
        if rotation is not None:
            if not isinstance(rotation, Rotation):
                raise SceneError(f"F1: the rotation of frame {id!r} is {rotation!r}, not rotation(axis, angle)")
            out["rotation"] = rotation.to_json()
        if scale is not None:
            s = _scalar(scale, f"the scale of frame {id!r}")
            if s == 0.0 or (isinstance(s, Mapping) and "attr" in s and s.get("factor", 1.0) == 0.0 and s.get("offset", 0.0) == 0.0):
                raise SceneError(f"F2: the scale of frame {id!r} is zero")
            out["scale"] = s
        self._frames[id] = out
        return Frame(id)

    def body(self, id: str, *, frame: Any, position: Sequence[Any], label: str | None = None, color: str | None = None) -> Body:
        """Declares a body, a point at three numbers or attributes in ``frame``."""
        self._new(self._bodies, id, "body")
        if _id(frame) not in self._frames:
            raise SceneError(f"2.4: the frame {_id(frame)!r} of body {id!r} is not declared")
        out: dict[str, Any] = {"frame": _id(frame), "position": _point(position, f"the position of body {id!r}")}
        if label is not None:
            out["label"] = _text(label, "a body label")
        if color is not None:
            out["color"] = _color(color, f"the color of body {id!r}")
        self._bodies[id] = out
        return Body(id)

    def track_set(
        self,
        id: str,
        *,
        frame: Any,
        tags: Mapping[str, str] | None = None,
        attrs: Mapping[str, float] | None = None,
        periodic: bool = False,
        dtype: str = "float32",
        label: str | None = None,
        channel_dtypes: Mapping[str, str] | None = None,
    ) -> TrackSet:
        """Declares a track set. ``dtype`` is the stored dtype of its positions and channels (rule D1).

        The default is float32, and the cast is recorded in the ``meta`` of the data container. A clock channel is stored as
        float64 instead when, on some track, float32 would make the channel nonmonotone or would round either end of a step
        between consecutive samples by more than 1% of the step. ``channel_dtypes`` maps a channel name to float32 or float64,
        and a dtype given there overrides both ``dtype`` and the switch of a clock channel to float64. Parameters are stored
        as float64, since each is one number per track and a selector compares against it.
        """
        if dtype not in ("float32", "float64"):
            raise SceneError(f"D1: positions and channels of track set {id!r} are stored as float32 or float64, not {dtype!r}")
        if channel_dtypes is None:
            channel_dtypes = {}
        if not isinstance(channel_dtypes, Mapping):
            raise SceneError(f"D1: channel_dtypes of track set {id!r} is a dict of channel names to dtypes, not {channel_dtypes!r}")
        for name, cd in channel_dtypes.items():
            if _text(name, "a channel name") == INDEX:
                raise SceneError(f"D1: channel_dtypes of track set {id!r} names {INDEX}, which is not stored")
            if cd not in ("float32", "float64"):
                raise SceneError(f"D1: channel {name!r} of track set {id!r} is stored as float32 or float64, not {cd!r}")
        self._new(self._sets, id, "track set")
        if _id(frame) not in self._frames:
            raise SceneError(f"2.1: the frame {_id(frame)!r} of track set {id!r} is not declared")
        ts = TrackSet(
            self,
            id,
            _id(frame),
            tags or {},
            attrs or {},
            periodic,
            dtype,
            _text(label, "a track set label") if label is not None else None,
            channel_dtypes,
        )
        self._sets[id] = ts
        return ts

    def _variable(self, id: str, spec: dict[str, Any]) -> Variable:
        self._new(self._variables, id, "variable")
        spec["scope"] = _enum(spec["scope"], ("scene", "panel"), f"2.5: the scope of variable {id!r}")
        self._variables[id] = spec
        return Variable(id, spec["kind"])

    def selector(
        self, id: str, *, parameter: str | None = None, by: str = "nearest", default: float = 0.0, scope: str = "scene"
    ) -> Variable:
        """A selector, whose value is either a parameter value, resolved to the nearest track, or a track index."""
        _enum(by, ("nearest", "index"), f"2.5: selector {id!r} is by")
        if by == "nearest" and parameter is None:
            raise SceneError(f"2.5: selector {id!r} is by nearest but does not name a parameter")
        spec: dict[str, Any] = {
            "kind": "selector",
            "by": by,
            "default": _finite(default, f"2.5: the default of selector {id!r}"),
            "scope": scope,
        }
        if parameter is not None:
            spec["parameter"] = _text(parameter, "a parameter name")
        return self._variable(id, spec)

    def choice(
        self, id: str, values: Sequence[Any], *, default: Any = None, labels: Sequence[str] | None = None, scope: str = "scene"
    ) -> Variable:
        """A choice among strings, or among frames given as handles."""
        vals = [_id(v) for v in values]
        if not vals or len(set(vals)) != len(vals) or not all(isinstance(v, str) for v in vals):
            raise SceneError(f"2.5: the values of choice {id!r} are not distinct strings: {vals!r}")
        spec: dict[str, Any] = {
            "kind": "choice",
            "values": vals,
            "default": _id(default) if default is not None else vals[0],
            "scope": scope,
        }
        if spec["default"] not in vals:
            raise SceneError(f"2.5: choice {id!r} defaults to {spec['default']!r}, which is not one of its values")
        if labels is not None:
            spec["labels"] = [_text(x, "a choice label") for x in labels]
            if len(spec["labels"]) != len(vals):
                raise SceneError(f"2.5: choice {id!r} has {len(spec['labels'])} labels for {len(vals)} values")
        return self._variable(id, spec)

    def toggle(self, id: str, *, default: bool = False, scope: str = "scene") -> Variable:
        """A boolean variable."""
        if not isinstance(default, bool):
            raise SceneError(f"2.5: toggle {id!r} defaults to {default!r}, not a boolean")
        return self._variable(id, {"kind": "toggle", "default": default, "scope": scope})

    def clock(
        self,
        mode: str = "fraction",
        *,
        channels: Sequence[str],
        steps: int,
        range: Sequence[float] | None = None,
        labels: Sequence[str] | None = None,
        laps: int | None = None,
    ) -> None:
        """The clock (section 2.6). The first channel is the initial one.

        ``laps``, in fraction mode only, is the number of periods that one loop of ``steps`` frames covers (rule C6).
        """
        _enum(mode, ("fraction", "value"), "2.6: the clock mode")
        if isinstance(channels, str) or not channels:
            raise SceneError(f"2.6: the clock channels are a list of names, not {channels!r}")
        names = [_text(c, "a clock channel") for c in channels]
        if len(set(names)) != len(names):
            raise SceneError(f"2.6: the clock channels repeat a name: {names!r}")
        n = _integer(steps, "2.6: the clock steps")
        if n < 1:
            raise SceneError(f"2.6: the clock has {n} steps, fewer than one")
        out: dict[str, Any] = {"mode": mode, "channels": names, "steps": n}
        if laps is not None:
            if mode == "value":
                raise SceneError("C6: the clock is in value mode but has laps")
            out["laps"] = _integer(laps, "C6: the clock laps")
            if out["laps"] < 1:
                raise SceneError(f"C6: the clock has {out['laps']} laps, fewer than one")
        if mode == "value":
            if range is None or isinstance(range, str) or len(range) != 2:
                raise SceneError("C2: the clock is in value mode but does not have a range of two numbers")
            out["range"] = [_finite(x, "C2: a clock range value") for x in range]
        if labels is not None:
            out["labels"] = [_text(x, "a clock label") for x in labels]
            if len(out["labels"]) != len(names):
                raise SceneError(f"2.6: the clock has {len(out['labels'])} labels for {len(names)} channels")
        self._clock = out
