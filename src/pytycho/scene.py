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
