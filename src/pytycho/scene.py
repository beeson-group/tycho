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

import copy
import itertools
import json
import math
import os
import re
from collections.abc import Callable, Mapping, Sequence
from typing import Any

import numpy as np

from . import __version__
from ._evaluate import Context, FrameTree
from ._thin import select
from .container import ContainerWriter

ID = re.compile(r"[A-Za-z0-9_.-]+")
HEX = re.compile(r"#[0-9a-fA-F]{6}")
COLORMAPS = ("viridis", "plasma", "cividis", "blues", "reds")
INDEX = "@index"
EASES = ("linear", "smooth", "in", "out", "in-out", "hold")
SHAPES = ("disc", "ring", "square", "diamond", "triangle", "star", "cross", "plus")


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


def _point(values: Any, what: str, *, channels: bool = False) -> list[Any]:
    """A list of three scalars, which are constant unless ``channels``, as in the origin of a frame (rules F2 and 2.4)."""
    if isinstance(values, (str, bytes, Mapping)) or not isinstance(values, (Sequence, np.ndarray)) or len(values) != 3:
        raise SceneError(f"F2: {what} is {values!r}, not three scalars")
    return [_scalar(v, what, constant=not channels) for v in values]


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


def _fraction(value: Any, what: str) -> dict[str, Any]:
    f = _finite(value, what)
    if not 0.0 < f <= 1.0:
        raise SceneError(f"2.7: {what} is {f}, not in (0, 1]")
    return {"fraction": f}


def _unit_interval(value: Any, what: str) -> float:
    x = _finite(value, what)
    if not 0.0 <= x <= 1.0:
        raise SceneError(f"2.7: {what} is {x}, not in [0, 1]")
    return x


def _taper(value: Any, what: str) -> dict[str, float]:
    """The trail taper ``trail.taper``, from ``(width, opacity)`` or from a dict with either key."""
    if isinstance(value, Mapping):
        spec = dict(value)
    elif isinstance(value, Sequence) and not isinstance(value, str) and len(value) == 2:
        spec = {"width": value[0], "opacity": value[1]}
    else:
        raise SceneError(f"2.7: the taper of {what} is (width, opacity) or a dict of width and opacity, not {value!r}")
    if extra := set(spec) - {"width", "opacity"}:
        raise SceneError(f"2.7: the taper of {what} has unknown keys {sorted(extra)}")
    return {k: _unit_interval(spec[k], f"the taper {k} of {what}") for k in ("width", "opacity") if k in spec}


def _trail(value: Any, what: str) -> dict[str, Any]:
    """A trail from a fraction or a dict of ``fraction`` and an optional ``taper``."""
    spec = dict(value) if isinstance(value, Mapping) else {"fraction": value}
    if "fraction" not in spec or set(spec) - {"fraction", "taper"}:
        raise SceneError(f"2.7: {what} is a fraction or a dict of fraction and taper, not {value!r}")
    out = _fraction(spec["fraction"], f"{what} fraction")
    if "taper" in spec:
        out["taper"] = _taper(spec["taper"], what)
    return out


def _head(value: Any) -> bool | dict[str, Any]:
    """The head of a track layer, as a boolean or a marker dict with an optional ``glow`` (rule L3 and section 2.11)."""
    if isinstance(value, bool):
        return value
    if not isinstance(value, Mapping):
        raise SceneError(f"L3: a track layer's head is {value!r}, not a boolean or a dict of color and size")
    if extra := set(value) - {"color", "size", "shape", "edge", "edge_width", "opacity", "glow"}:
        raise SceneError(f"L3: a head has unknown keys {sorted(extra)}")
    out: dict[str, Any] = {}
    if "color" in value:
        out["color"] = _color(value["color"], "a head color")
    if "size" in value:
        size = value["size"]
        if isinstance(size, (Mapping, list, tuple)):
            out["size"] = _size(size, "a head size")
        else:
            out["size"] = _finite(size, "a head size")
            if out["size"] <= 0.0:
                raise SceneError(f"L3: a head size is {out['size']}, not positive")
    rest = _marker({k: v for k, v in value.items() if k in ("shape", "edge", "edge_width", "opacity")}, "a head")
    out.update(rest)
    if "glow" in value:
        g = value["glow"]
        if not isinstance(g, Mapping) or "channel" not in g:
            raise SceneError(f"2.11: a head's glow is a dict of a channel, color, size, and opacity, not {g!r}")
        if extra := set(g) - {"channel", "color", "size", "opacity"}:
            raise SceneError(f"2.11: a head's glow has unknown keys {sorted(extra)}")
        glow: dict[str, Any] = {"channel": _text(g["channel"], "the channel of a glow")}
        if "color" in g:
            glow["color"] = _color(g["color"], "the color of a glow")
        if "size" in g:
            glow["size"] = _positive(g["size"], "the size of a glow")
        if "opacity" in g:
            glow["opacity"] = _unit_interval(g["opacity"], "the opacity of a glow")
        out["glow"] = glow
    return out


def _has_head(layer: Mapping[str, Any]) -> bool:
    head = layer.get("head", False)
    return head is True or isinstance(head, Mapping)


def _colormap(value: Any, what: str) -> Any:
    """A colormap name, or ``{"var": choice, "map": {value: name}}`` (section 2.7)."""
    if not isinstance(value, Mapping):
        return _enum(value, COLORMAPS, f"2.7: the colormap of {what}")
    if set(value) != {"var", "map"} or not isinstance(value["map"], Mapping) or not value["map"]:
        raise SceneError(f"2.7: the colormap of {what} is a name or a dict of var and a nonempty map, not {value!r}")
    names = {
        _text(_id(k), f"a value of the choice keying {what}"): _enum(v, COLORMAPS, f"2.7: the colormap of {what} at {_id(k)!r}")
        for k, v in value["map"].items()
    }
    return {"var": _var(value["var"], f"2.7: the colormap of {what}", "choice")["var"], "map": names}


def _pair(value: Any, what: str, rule: str = "2.11") -> list[float]:
    if isinstance(value, (str, bytes, Mapping)) or not isinstance(value, (Sequence, np.ndarray)) or len(value) != 2:
        raise SceneError(f"{rule}: {what} is {value!r}, not two numbers")
    return [_finite(x, what) for x in value]


def _bool(value: Any, what: str, rule: str = "2.11") -> bool:
    if not isinstance(value, bool):
        raise SceneError(f"{rule}: {what} is {value!r}, not a boolean")
    return value


def _positive(value: Any, what: str, rule: str = "2.11") -> float:
    x = _finite(value, what)
    if x <= 0.0:
        raise SceneError(f"{rule}: {what} is {x}, not positive")
    return x


def _nonnegative(value: Any, what: str, rule: str = "2.11") -> float:
    x = _finite(value, what)
    if x < 0.0:
        raise SceneError(f"{rule}: {what} is {x}, not a nonnegative length")
    return x


# the timeline (section 2.11)


def _key_list(value: Any, what: str, *, low: float | None = None, high: float | None = None, positive: bool = False) -> list[list[Any]]:
    """The keys of a tween (rules K1 and K2), from ``{"keys": [...]}`` or a list of ``(t, v)`` and ``(t, v, ease)``."""
    if isinstance(value, Mapping):
        if set(value) != {"keys"}:
            raise SceneError(f"K1: {what} is a tween {{'keys': [...]}}, not {dict(value)!r}")
        value = value["keys"]
    if isinstance(value, (str, bytes)) or not isinstance(value, (Sequence, np.ndarray)) or len(value) == 0:
        raise SceneError(f"K1: {what} has keys {value!r}, not a nonempty list of (t, v) or (t, v, ease)")
    out: list[list[Any]] = []
    for key in value:
        if isinstance(key, (str, bytes, Mapping)) or not isinstance(key, (Sequence, np.ndarray)) or len(key) not in (2, 3):
            raise SceneError(f"K1: a key of {what} is {key!r}, not (t, v) or (t, v, ease)")
        t = _finite(key[0], f"K1: the time of a key of {what}")
        v = _finite(key[1], f"K1: the value of a key of {what}")
        if (low is not None and v < low) or (high is not None and v > high):
            raise SceneError(f"K1: a key of {what} has the value {v}, not in [{low}, {high}]")
        if positive and v <= 0.0:
            raise SceneError(f"K1: a key of {what} has the value {v}, not positive")
        entry: list[Any] = [t, v]
        if len(key) == 3:
            entry.append(_enum(key[2], EASES, f"K2: the ease of a key of {what}"))
        if out and t < out[-1][0]:
            raise SceneError(f"K1: the key times of {what} decrease from {out[-1][0]} to {t}")
        out.append(entry)
    return out


def _tween(value: Any, what: str, **bounds: Any) -> dict[str, Any]:
    return {"keys": _key_list(value, what, **bounds)}


def _opacity(value: Any, what: str) -> Any:
    """An opacity in [0, 1], or a tween of opacities (section 2.11)."""
    if isinstance(value, (Mapping, list, tuple)):
        return _tween(value, what, low=0.0, high=1.0)
    return _unit_interval(value, what)


def _size(value: Any, what: str) -> Any:
    """A positive size in CSS pixels, or a tween of positive sizes (section 2.11)."""
    if isinstance(value, (Mapping, list, tuple)):
        return _tween(value, what, positive=True)
    return _positive(value, what)


def tween(*keys: Any) -> dict[str, Any]:
    """A tween ``{"keys": [...]}`` from keys ``(t, v)`` or ``(t, v, ease)``, with times in seconds of the timeline (rule K1).

    The ease of a key, ``linear`` by default, ``smooth``, ``in``, ``out``, ``in-out``, or ``hold``, says how the value travels to it from
    the key before (rule K2). Two keys at the same time make a jump.
    """
    return _tween(list(keys), "a tween")


def fade(
    on: float, off: float | None = None, *, duration: float = 0.5, ease: str = "smooth", low: float = 0.0, high: float = 1.0
) -> dict[str, Any]:
    """An opacity tween that fades in from ``low`` to ``high`` over ``duration`` seconds from ``on``, and back out from ``off``
    when given."""
    d = _finite(duration, "a fade duration")
    keys: list[Any] = [(on, low), (on + d, high, ease)]
    if off is not None:
        keys += [(off, high), (off + d, low, ease)]
    return _tween(keys, "a fade", low=0.0, high=1.0)


def _layer_clock(value: Any, what: str) -> dict[str, Any]:
    """The clock of a layer, ``{"channel": name}`` with a ``range`` or ``keys`` (rule K4)."""
    if not isinstance(value, Mapping) or "channel" not in value:
        raise SceneError(f"K4: the clock of {what} is a dict of a channel and a range or keys, not {value!r}")
    if extra := set(value) - {"channel", "range", "keys"}:
        raise SceneError(f"K4: the clock of {what} has unknown keys {sorted(extra)}")
    if ("range" in value) == ("keys" in value):
        raise SceneError(f"K4: the clock of {what} gives {'both' if 'range' in value else 'neither'} of a range and keys, not one")
    out: dict[str, Any] = {"channel": _text(value["channel"], f"the clock channel of {what}")}
    if "range" in value:
        out["range"] = _pair(value["range"], f"the clock range of {what}", "K4")
    else:
        out["keys"] = _key_list(value["keys"], f"the clock of {what}")
    return out


def layer_clock(channel: str, *, range: Sequence[float] | None = None, keys: Any = None) -> dict[str, Any]:
    """The clock of a layer (rule K4), which reads ``channel`` in value mode at the value that ``range`` or ``keys`` gives at the progress.

    ``keys`` is a tween or a list of keys ``(t, v)`` and ``(t, v, ease)`` with times in seconds of the timeline.
    """
    spec: dict[str, Any] = {"channel": channel}
    if range is not None:
        spec["range"] = range
    if keys is not None:
        spec["keys"] = keys
    return _layer_clock(spec, "a layer")


def _marker(value: Any, what: str, *, extra: Sequence[str] = ()) -> dict[str, Any]:
    """A marker ``{"shape", "size", "color", "edge", "edge_width", "opacity"}`` (section 2.11), all keys optional."""
    if not isinstance(value, Mapping):
        raise SceneError(f"2.11: {what} is a dict of shape, size, color, edge, edge_width, and opacity, not {value!r}")
    if unknown := set(value) - {"shape", "size", "color", "edge", "edge_width", "opacity", *extra}:
        raise SceneError(f"2.11: {what} has unknown keys {sorted(unknown)}")
    out: dict[str, Any] = {}
    if "shape" in value:
        out["shape"] = _enum(value["shape"], SHAPES, f"2.11: the shape of {what}")
    if "size" in value:
        out["size"] = _size(value["size"], f"the size of {what}")
    if "color" in value:
        out["color"] = _color(value["color"], f"the color of {what}")
    if "edge" in value:
        out["edge"] = _color(value["edge"], f"the edge of {what}")
    if "edge_width" in value:
        out["edge_width"] = _nonnegative(value["edge_width"], f"the edge width of {what}")
    if "opacity" in value:
        out["opacity"] = _opacity(value["opacity"], f"the opacity of {what}")
    return out


def marker(
    shape: str | None = None,
    size: Any = None,
    color: str | None = None,
    edge: str | None = None,
    edge_width: float | None = None,
    opacity: Any = None,
) -> dict[str, Any]:
    """A marker for a points layer, a head, or a legend entry. ``size`` and ``opacity`` may be tweens (section 2.11)."""
    spec = (("shape", shape), ("size", size), ("color", color), ("edge", edge), ("edge_width", edge_width), ("opacity", opacity))
    return _marker({k: v for k, v in spec if v is not None}, "a marker")


def _box(value: Any, what: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise SceneError(f"2.11: the box of {what} is a dict of fill, edge, edge_width, pad, radius, and opacity, not {value!r}")
    if unknown := set(value) - {"fill", "edge", "edge_width", "pad", "radius", "opacity"}:
        raise SceneError(f"2.11: the box of {what} has unknown keys {sorted(unknown)}")
    out: dict[str, Any] = {}
    for k in ("fill", "edge"):
        if k in value:
            out[k] = _color(value[k], f"the box {k} of {what}")
    for k in ("edge_width", "pad", "radius"):
        if k in value:
            out[k] = _nonnegative(value[k], f"the box {k} of {what}")
    if "opacity" in value:
        out["opacity"] = _unit_interval(value["opacity"], f"the box opacity of {what}")
    return out


def _text_style(value: Mapping[str, Any], what: str, out: dict[str, Any]) -> None:
    """The keys that a label and a text overlay share: align, baseline, size, color, weight, box, and opacity."""
    if "align" in value:
        out["align"] = _enum(value["align"], ("start", "center", "end"), f"2.11: the align of {what}")
    if "baseline" in value:
        out["baseline"] = _enum(value["baseline"], ("top", "middle", "bottom", "alphabetic"), f"2.11: the baseline of {what}")
    if "size" in value:
        out["size"] = _positive(value["size"], f"the size of {what}")
    if "color" in value:
        out["color"] = _color(value["color"], f"the color of {what}")
    if "weight" in value:
        out["weight"] = _enum(value["weight"], ("normal", "bold"), f"2.11: the weight of {what}")
    if "box" in value:
        out["box"] = _box(value["box"], what)
    if "opacity" in value:
        out["opacity"] = _opacity(value["opacity"], f"the opacity of {what}")


FORMAT_KEYS = ("width", "digits", "decimals", "grouping", "factor", "offset")


def _format(p: Mapping[str, Any], out: dict[str, Any]) -> None:
    """The number format of a part: digits or decimals, grouping, factor, and offset (rule K7)."""
    if "digits" in p and "decimals" in p:
        raise SceneError("K7: a part gives both digits and decimals, not one")
    if "digits" in p:
        out["digits"] = _integer(p["digits"], "2.9: readout digits")
        if not 1 <= out["digits"] <= 17:
            raise SceneError(f"2.9: readout digits is {out['digits']}, not in 1 to 17")
    if "decimals" in p:
        out["decimals"] = _integer(p["decimals"], "K7: the decimals of a part")
        if not 0 <= out["decimals"] <= 17:
            raise SceneError(f"K7: the decimals of a part is {out['decimals']}, not in 0 to 17")
    if "grouping" in p:
        out["grouping"] = _bool(p["grouping"], "the grouping of a part", "K7")
    if "width" in p:
        out["width"] = _integer(p["width"], "K7: the width of a part")
        if not 0 <= out["width"] <= 40:
            raise SceneError(f"K7: the width of a part is {out['width']}, not in 0 to 40")
    for k in ("factor", "offset"):
        if k in p:
            out[k] = _finite(p[k], f"the {k} of a part")


def _text_part(p: Any) -> Any:
    """One part of a readout, a label, or a text overlay (section 2.9 and rule K7)."""
    if isinstance(p, str):
        return p
    if isinstance(p, Variable):
        return p.to_json()
    if isinstance(p, Channel):
        if p.name == INDEX:
            raise SceneError(f"2.9: a readout channel part names {INDEX}, which is not allowed in a readout")
        return p.to_json()
    if isinstance(p, Attr):
        return p.to_json()
    if not isinstance(p, Mapping):
        raise SceneError(f"2.9: a part is text, a variable, a channel, an attribute, or a dict, not {p!r}")
    kinds = [k for k in ("var", "member", "attr", "channel", "clock", "keys", "steps") if k in p]
    if len(kinds) != 1:
        raise SceneError(f"2.9: the part {dict(p)!r} names {len(kinds)} of var, member, attr, channel, clock, keys, and steps, not one")
    kind = kinds[0]
    allowed = {kind} if kind == "steps" else {kind, *FORMAT_KEYS}
    if extra := set(p) - allowed:
        raise SceneError(f"2.9: a {kind} part has unknown keys {sorted(extra)}")
    out: dict[str, Any] = {}
    if kind == "var":
        out = _var(p["var"], "2.9: a readout")
    elif kind == "clock":
        out["clock"] = _enum(p["clock"], ("index", "steps", "value", "time"), "2.9: a clock part")
    elif kind == "keys":
        out["keys"] = _key_list(p["keys"], "a keys part")
    elif kind == "steps":
        pairs = p["steps"]
        if isinstance(pairs, (str, bytes, Mapping)) or not isinstance(pairs, Sequence):
            raise SceneError(f"K7: a steps part is a list of (t, text), not {pairs!r}")
        steps_out: list[list[Any]] = []
        for pair in pairs:
            if isinstance(pair, (str, bytes, Mapping)) or not isinstance(pair, Sequence) or len(pair) != 2:
                raise SceneError(f"K7: a step of a steps part is (t, text), not {pair!r}")
            t = _finite(pair[0], "K7: the time of a step")
            if steps_out and t < steps_out[-1][0]:
                raise SceneError(f"K7: the times of a steps part decrease from {steps_out[-1][0]} to {t}")
            steps_out.append([t, _text(pair[1], "the text of a step")])
        out["steps"] = steps_out
    else:
        out[kind] = _text(p[kind], f"a readout {kind} name")
        if kind == "channel" and out[kind] == INDEX:
            raise SceneError(f"2.9: a readout channel part names {INDEX}, which is not allowed in a readout")
    _format(p, out)
    return out


def _text_parts(value: Any, what: str) -> Any:
    """A text, as a string or a list of parts (rule K6)."""
    if isinstance(value, str):
        return value
    if isinstance(value, (Variable, Channel, Attr, Mapping)):
        return [_text_part(value)]
    if not isinstance(value, Sequence):
        raise SceneError(f"2.11: the text of {what} is a string or a list of parts, not {value!r}")
    return [_text_part(p) for p in value]


def _fmt(kw: Mapping[str, Any]) -> dict[str, Any]:
    if extra := set(kw) - set(FORMAT_KEYS):
        raise SceneError(f"K7: a part has unknown format keys {sorted(extra)}")
    return {k: v for k, v in kw.items() if v is not None}


def clock_value(**fmt: Any) -> dict[str, Any]:
    """The part ``{"clock": "value"}``, the shared value of the clock's active channel (rule K7). ``fmt`` takes digits or decimals,
    grouping, factor, and offset, e.g. ``clock_value(factor=4.3426, decimals=1)`` for a time in days."""
    return _text_part({"clock": "value", **_fmt(fmt)})


def clock_time(**fmt: Any) -> dict[str, Any]:
    """The part ``{"clock": "time"}``, the time of the timeline in seconds (rule K7)."""
    return _text_part({"clock": "time", **_fmt(fmt)})


def keyed(*keys: Any, **fmt: Any) -> dict[str, Any]:
    """The part ``{"keys": [...]}``, the value of a tween at the time of the timeline (rule K7), e.g. a counter."""
    return _text_part({"keys": list(keys), **_fmt(fmt)})


def steps(*pairs: Any) -> dict[str, Any]:
    """The part ``{"steps": [[t, text], ...]}``, the text of the last pair whose time has passed (rule K7), e.g. a staged caption."""
    return _text_part({"steps": [list(p) for p in pairs]})


def _anchor(value: Any) -> dict[str, Any]:
    """The anchor of a label (rule K6)."""
    if not isinstance(value, Mapping):
        raise SceneError(f"K6: a label's anchor is at_point, at_member, or at_screen, not {value!r}")
    if "point" in value:
        if extra := set(value) - {"point", "frame"}:
            raise SceneError(f"K6: a point anchor has unknown keys {sorted(extra)}")
        p = value["point"]
        if isinstance(p, (str, bytes, Mapping)) or not isinstance(p, (Sequence, np.ndarray)) or len(p) not in (2, 3):
            raise SceneError(f"K6: a label's point is {p!r}, not three numbers")
        out: dict[str, Any] = {"point": [_finite(x, "K6: a label's point") for x in p] + ([0.0] if len(p) == 2 else [])}
        if "frame" in value:
            out["frame"] = _check_id(_id(value["frame"]), "K6: the frame of a label's point")
        return out
    if "sets" in value:
        if set(value) != {"sets", "member"}:
            raise SceneError(f"K6: a member anchor is a dict of sets and member, not {dict(value)!r}")
        k = _integer(value["member"], "K6: a label's member")
        if k < 0:
            raise SceneError(f"K6: a label's member is {k}, a negative track index")
        return {"sets": _query(value["sets"]), "member": k}
    if "screen" in value:
        if set(value) != {"screen"}:
            raise SceneError(f"K6: a screen anchor has unknown keys {sorted(set(value) - {'screen'})}")
        return {"screen": _pair(value["screen"], "a label's screen place", "K6")}
    raise SceneError(f"K6: a label's anchor is a point, a member, or a screen place, not {dict(value)!r}")


def at_point(x: float, y: float, z: float = 0.0, frame: Any = None) -> dict[str, Any]:
    """A label anchor at a point of the display frame, or of ``frame`` taken into the display frame at the driver's reading (rule K6)."""
    spec: dict[str, Any] = {"point": [x, y, z]}
    if frame is not None:
        spec["frame"] = _id(frame)
    return _anchor(spec)


def at_member(sets: Any, member: int) -> dict[str, Any]:
    """A label anchor at the point at the reading of track ``member`` of ``sets``, clamped to the track (rule K6)."""
    return _anchor({"sets": sets, "member": member})


def at_screen(fx: float, fy: float) -> dict[str, Any]:
    """A label anchor at a fixed place of the panel, ``fx`` of its width from the left and ``fy`` of its height from the top (rule K6)."""
    return _anchor({"screen": [fx, fy]})


def _color_spec(value: Any, what: str) -> Any:
    if isinstance(value, str):
        return _color(value, what)
    if isinstance(value, Mapping) and "steps" in value:
        # a color in steps of a channel (section 2.11)
        if set(value) != {"channel", "steps", "colors"}:
            raise SceneError(f"2.11: {what} in steps is a dict of channel, steps, and colors, not {dict(value)!r}")
        cuts = value["steps"]
        if isinstance(cuts, (str, bytes, Mapping)) or not isinstance(cuts, (Sequence, np.ndarray)) or len(cuts) == 0:
            raise SceneError(f"2.11: the steps of {what} are {cuts!r}, not a nonempty list of numbers")
        steps_out = [_finite(x, f"a step of {what}") for x in cuts]
        if any(b <= a for a, b in itertools.pairwise(steps_out)):
            raise SceneError(f"2.11: the steps of {what} are {steps_out}, not increasing")
        colors = value["colors"]
        if isinstance(colors, (str, bytes, Mapping)) or not isinstance(colors, Sequence) or len(colors) != len(steps_out) + 1:
            raise SceneError(f"2.11: {what} gives {colors!r} for {len(steps_out)} steps, not one color more than steps")
        return {
            "channel": _text(value["channel"], f"the channel of {what}"),
            "steps": steps_out,
            "colors": [_color(c, f"a color of {what}") for c in colors],
        }
    if not isinstance(value, Mapping) or ("parameter" in value) == ("channel" in value):
        raise SceneError(f"2.7: {what} is a #rrggbb color or a colormap over one parameter or channel, not {value!r}")
    out: dict[str, Any] = {"colormap": _colormap(value.get("colormap"), what)}
    key = "parameter" if "parameter" in value else "channel"
    out[key] = _text(value[key], f"the {key} of {what}")
    for k in ("range", "clip"):
        if k in value:
            pair = value[k]
            if not isinstance(pair, Sequence) or isinstance(pair, str) or len(pair) != 2:
                raise SceneError(f"2.7: the {k} of {what} is {pair!r}, not two numbers")
            out[k] = [_finite(x, f"the {k} of {what}") for x in pair]
            if k == "clip" and not all(0.0 <= x <= 1.0 for x in out[k]):
                raise SceneError(f"2.7: the clip of {what} is outside [0, 1]")
    if extra := set(value) - {"colormap", key, "range", "clip"}:
        raise SceneError(f"2.7: {what} has unknown keys {sorted(extra)}")
    return out


def steps_color(channel: str, steps: Sequence[float], colors: Sequence[str]) -> dict[str, Any]:
    """A color in steps of a channel (section 2.11). A sample whose channel is ``x`` takes ``colors[j]``, where ``j`` counts the steps
    below ``x``, e.g. ``steps_color("S", [0.0], ["#000000", "#d62728"])`` for coast and thrust by the sign of a switching function."""
    return _color_spec({"channel": channel, "steps": list(steps), "colors": list(colors)}, "a color in steps")


def _check_layer(layer: Any) -> dict[str, Any]:
    """A layer dict in the form that the schema and section 2.7 define, with every value checked."""
    if not isinstance(layer, Mapping) or "kind" not in layer:
        raise SceneError(f"2.7: a layer is a dict with a kind, not {layer!r}")
    kind = _enum(layer["kind"], ("track", "arrow", "outline", "body", "axes", "grid", "label", "points"), "2.7: a layer kind")
    out: dict[str, Any] = {"kind": kind}
    allowed = {"kind", "visible"}
    if "visible" in layer:
        v = layer["visible"]
        out["visible"] = v if isinstance(v, Mapping) and set(v) == {"var"} else _var(v, "L5: a layer's visible", "toggle")
    if kind == "track":
        allowed |= {
            "sets",
            "members",
            "reveal",
            "trail",
            "head",
            "before",
            "after",
            "context",
            "fit",
            "color",
            "opacity",
            "width",
            "highlight",
            "clock",
            "line",
            "dash",
            "fill",
        }
        out["sets"] = _query(layer.get("sets"))
        out["members"] = _member(layer.get("members", "all"), "a track layer's members")
        out["reveal"] = _enum(layer.get("reveal", "none"), ("none", "grow", "trail"), "2.7: a track layer's reveal")
        if "trail" in layer:
            out["trail"] = _trail(layer["trail"], "a trail")
        if out["reveal"] == "trail" and "trail" not in out:
            raise SceneError('2.7: a track layer has reveal "trail" but lacks a trail')
        if "head" in layer:
            out["head"] = _head(layer["head"])
        for key in ("before", "after"):
            if key in layer:
                out[key] = _enum(layer[key], ("clamp", "hidden"), f"C3: a track layer's {key}")
        if "context" in layer:
            out["context"] = _enum(layer["context"], ("own", "driver"), "L6: a track layer's context")
        if "fit" in layer:
            if not isinstance(layer["fit"], bool):
                raise SceneError(f"2.7: a track layer's fit is {layer['fit']!r}, not a boolean")
            out["fit"] = layer["fit"]
        if "color" in layer:
            out["color"] = _color_spec(layer["color"], "a track layer's color")
        if "opacity" in layer:
            if isinstance(layer["opacity"], (Mapping, list, tuple)):
                out["opacity"] = _opacity(layer["opacity"], "a track layer's opacity")
            else:
                out["opacity"] = _finite(layer["opacity"], "a track layer's opacity")
                if not 0.0 <= out["opacity"] <= 1.0:
                    raise SceneError(f"2.7: a track layer's opacity is {out['opacity']}, not in [0, 1]")
        if "clock" in layer:
            out["clock"] = _layer_clock(layer["clock"], "a track layer")
        if "line" in layer:
            out["line"] = _bool(layer["line"], "a track layer's line")
        if "dash" in layer:
            dash = _pair(layer["dash"], "a track layer's dash")
            if min(dash) <= 0.0:
                raise SceneError(f"2.11: a track layer's dash is {dash}, not two positive lengths")
            out["dash"] = dash
        if "fill" in layer:
            f = layer["fill"]
            if not isinstance(f, Mapping) or set(f) - {"base", "color", "opacity"}:
                raise SceneError(f"2.11: a track layer's fill is a dict of base, color, and opacity, not {f!r}")
            fill: dict[str, Any] = {}
            if "base" in f:
                fill["base"] = _finite(f["base"], "the base of a fill")
            if "color" in f:
                fill["color"] = _color(f["color"], "the color of a fill")
            if "opacity" in f:
                fill["opacity"] = _unit_interval(f["opacity"], "the opacity of a fill")
            out["fill"] = fill
        if "width" in layer:
            out["width"] = _finite(layer["width"], "a track layer's width")
            if out["width"] <= 0.0:
                raise SceneError(f"2.7: a track layer's width is {out['width']}, not positive")
        if "highlight" in layer:
            h = layer["highlight"]
            spec = dict(h) if isinstance(h, Mapping) else {"var": h}
            if extra := set(spec) - {"var", "width", "opacity", "kernel"}:
                raise SceneError(f"2.7: a highlight has unknown keys {sorted(extra)}")
            hl: dict[str, Any] = _var(spec.get("var"), "2.7: a highlight", "selector")
            if "width" in spec:
                hl["width"] = _finite(spec["width"], "a highlight width")
                if hl["width"] <= 0.0:
                    raise SceneError(f"2.7: a highlight width is {hl['width']}, not positive")
            if "opacity" in spec:
                hl["opacity"] = _finite(spec["opacity"], "a highlight opacity")
                if not 0.0 <= hl["opacity"] <= 1.0:
                    raise SceneError(f"2.7: a highlight opacity is {hl['opacity']}, not in [0, 1]")
            if "kernel" in spec:
                k = spec["kernel"]
                if not isinstance(k, Mapping) or set(k) != {"width", "opacity"}:
                    raise SceneError(f"2.7: a highlight kernel is a dict of width and opacity, not {k!r}")
                w = _finite(k["width"], "a highlight kernel's width")
                if not 0.0 < w <= 1.0:
                    raise SceneError(f"2.7: a highlight kernel's width is {w}, not in (0, 1]")
                hl["kernel"] = {"width": w, "opacity": _unit_interval(k["opacity"], "a highlight kernel's opacity")}
            out["highlight"] = hl
    elif kind == "arrow":
        allowed |= {"sets", "members", "vector", "scale", "before", "after", "color", "opacity", "width", "head", "clock"}
        out["sets"] = _query(layer.get("sets"))
        out["members"] = _member(layer.get("members", "all"), "an arrow layer's members")
        vector = layer.get("vector")
        if isinstance(vector, str) or not isinstance(vector, Sequence) or len(vector) not in (2, 3):
            raise SceneError(f"L7: an arrow layer's vector is {vector!r}, not two or three channel names")
        out["vector"] = [_check_id(_id(c), "L7: a vector channel") if c != INDEX else c for c in vector]
        if INDEX in out["vector"]:
            raise SceneError(f"L7: {INDEX} is not allowed in the vector of an arrow layer")
        if "scale" in layer:
            if isinstance(layer["scale"], Channel) or (isinstance(layer["scale"], Mapping) and "channel" in layer["scale"]):
                raise SceneError("L7: the scale of an arrow layer takes a number or an attribute, not a channel")
            scale = layer["scale"]
            if isinstance(scale, Mapping) and ("attr" not in scale or set(scale) - {"attr", "factor", "offset"}):
                raise SceneError(f"L7: the scale of an arrow layer is {scale!r}, not a number or an attribute")
            out["scale"] = dict(scale) if isinstance(scale, Mapping) else _scalar(scale, "an arrow layer's scale", constant=True)
        for key in ("before", "after"):
            if key in layer:
                out[key] = _enum(layer[key], ("clamp", "hidden"), f"C3: an arrow layer's {key}")
        if "color" in layer:
            out["color"] = _color(layer["color"], "L7: an arrow layer's color")
        if "opacity" in layer:
            out["opacity"] = _opacity(layer["opacity"], "an arrow layer's opacity")
        if "clock" in layer:
            out["clock"] = _layer_clock(layer["clock"], "an arrow layer")
        if "width" in layer:
            out["width"] = _finite(layer["width"], "an arrow layer's width")
            if out["width"] <= 0.0:
                raise SceneError(f"2.7: an arrow layer's width is {out['width']}, not positive")
        if "head" in layer:
            head = layer["head"]
            if not isinstance(head, Mapping) or set(head) - {"size"}:
                raise SceneError(f"L7: an arrowhead is a dict of size, not {head!r}")
            out["head"] = {}
            if "size" in head:
                out["head"]["size"] = _finite(head["size"], "an arrowhead size")
                if out["head"]["size"] <= 0.0:
                    raise SceneError(f"L7: an arrowhead size is {out['head']['size']}, not positive")
    elif kind == "outline":
        allowed |= {"view", "color", "opacity", "width", "dash", "min_size"}
        out["view"] = _check_id(_id(layer.get("view")), "L8: an outline layer's view")
        if "color" in layer:
            out["color"] = _color(layer["color"], "L8: an outline layer's color")
        if "opacity" in layer:
            out["opacity"] = _opacity(layer["opacity"], "an outline layer's opacity")
        if "width" in layer:
            out["width"] = _finite(layer["width"], "an outline layer's width")
            if out["width"] <= 0.0:
                raise SceneError(f"2.7: an outline layer's width is {out['width']}, not positive")
        if "dash" in layer:
            dash = layer["dash"]
            if isinstance(dash, (str, bytes, Mapping)) or not isinstance(dash, (Sequence, np.ndarray)) or len(dash) != 2:
                raise SceneError(f"L8: an outline layer's dash is {dash!r}, not two lengths")
            out["dash"] = [_finite(d, "an outline layer's dash") for d in dash]
            if min(out["dash"]) <= 0.0:
                raise SceneError(f"L8: an outline layer's dash is {out['dash']}, not two positive lengths")
        if "min_size" in layer:
            out["min_size"] = _finite(layer["min_size"], "an outline layer's min_size")
            if out["min_size"] < 0.0:
                raise SceneError(f"L8: an outline layer's min_size is {out['min_size']}, not a nonnegative length")
    elif kind == "body":
        allowed |= {"body", "trail", "size", "opacity"}
        if "opacity" in layer:
            out["opacity"] = _opacity(layer["opacity"], "a body layer's opacity")
        out["body"] = _check_id(_id(layer.get("body")), "L4: a body layer's body")
        if "trail" in layer:
            out["trail"] = _trail(layer["trail"], "a body trail")
        if "size" in layer:
            out["size"] = _finite(layer["size"], "a body layer's size")
            if out["size"] <= 0.0:
                raise SceneError(f"2.7: a body layer's size is {out['size']}, not positive")
    elif kind == "axes":
        allowed |= {"span", "ticks", "size", "opacity"}
        if "span" in layer:
            out["span"] = _enum(layer["span"], ("positive", "full", "box"), "2.7: an axes layer's span")
        if "ticks" in layer:
            ticks = layer["ticks"]
            if isinstance(ticks, (str, bytes, Mapping)) or not isinstance(ticks, Sequence) or len(set(ticks)) != len(ticks):
                raise SceneError(f"2.11: an axes layer's ticks are {ticks!r}, not a list of distinct axes x and y")
            out["ticks"] = [_enum(t, ("x", "y"), "2.11: an axis of an axes layer's ticks") for t in ticks]
        if "size" in layer:
            out["size"] = _positive(layer["size"], "an axes layer's size")
        if "opacity" in layer:
            out["opacity"] = _opacity(layer["opacity"], "an axes layer's opacity")
    elif kind == "grid":
        allowed |= {"labels", "opacity"}
        if "labels" in layer:
            if not isinstance(layer["labels"], bool):
                raise SceneError(f"2.7: a grid layer's labels is {layer['labels']!r}, not a boolean")
            out["labels"] = layer["labels"]
        if "opacity" in layer:
            out["opacity"] = _opacity(layer["opacity"], "a grid layer's opacity")
    elif kind == "label":
        allowed |= {"text", "at", "offset", "align", "baseline", "size", "color", "weight", "box", "opacity", "leader", "clock"}
        if "text" not in layer or "at" not in layer:
            raise SceneError("K6: a label layer lacks a text or an anchor")
        out["text"] = _text_parts(layer["text"], "a label")
        out["at"] = _anchor(layer["at"])
        if "offset" in layer:
            out["offset"] = _pair(layer["offset"], "a label's offset", "K6")
        _text_style(layer, "a label", out)
        if "leader" in layer:
            leader = layer["leader"]
            if isinstance(leader, bool):
                out["leader"] = leader
            elif isinstance(leader, Mapping) and not set(leader) - {"color", "width"}:
                spec: dict[str, Any] = {}
                if "color" in leader:
                    spec["color"] = _color(leader["color"], "the color of a leader")
                if "width" in leader:
                    spec["width"] = _positive(leader["width"], "the width of a leader", "K6")
                out["leader"] = spec
            else:
                raise SceneError(f"K6: a label's leader is a boolean or a dict of color and width, not {leader!r}")
        if "clock" in layer:
            out["clock"] = _layer_clock(layer["clock"], "a label layer")
    else:
        allowed |= {"sets", "members", "marker", "reveal", "before", "after", "clock", "fit", "opacity"}
        out["sets"] = _query(layer.get("sets"))
        out["members"] = _member(layer.get("members", "all"), "a points layer's members")
        if "marker" in layer:
            out["marker"] = _marker(layer["marker"], "a points layer's marker")
        if "reveal" in layer:
            out["reveal"] = _enum(layer["reveal"], ("none", "grow"), "K8: a points layer's reveal")
        for key in ("before", "after"):
            if key in layer:
                out[key] = _enum(layer[key], ("clamp", "hidden"), f"C3: a points layer's {key}")
        if "clock" in layer:
            out["clock"] = _layer_clock(layer["clock"], "a points layer")
        if "fit" in layer:
            out["fit"] = _bool(layer["fit"], "a points layer's fit", "2.7")
        if "opacity" in layer:
            out["opacity"] = _opacity(layer["opacity"], "a points layer's opacity")
    if extra := set(layer) - allowed:
        raise SceneError(f"2.7: a {kind} layer has unknown keys {sorted(extra)}")
    return out


def track(
    sets: Any,
    members: Any = "all",
    *,
    reveal: str | None = None,
    trail: Any = None,
    taper: Any = None,
    head: bool | Mapping[str, Any] = False,
    before: str | None = None,
    after: str | None = None,
    context: str | None = None,
    fit: bool | None = None,
    color: Any = None,
    opacity: Any = None,
    width: float | None = None,
    highlight: Any = None,
    visible: Any = None,
    clock: Any = None,
    line: bool | None = None,
    dash: Sequence[float] | None = None,
    fill: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """A track layer. A ``trail`` fraction implies ``reveal="trail"``.

    ``taper`` gives the fractions of the layer's width and opacity left at the tail of the trail, as
    ``(width, opacity)`` or as a dict. ``head`` is True or a dict of ``color`` and ``size``.
    ``context="driver"`` transforms every sample in the context of the driver's reading rather than in
    its own (rule L6), so that a static polyline of one frame, e.g. a grid line, follows this frame
    in the display frame. Its set then does not need the channels of the frame edges. ``fit=False`` leaves the layer out of the camera
    fit, e.g. for a whole curve drawn on a close-up whose camera is fitted to a window given by another layer.

    Section 2.11 adds ``clock``, a :func:`layer_clock` on which the layer takes its readings (rule K4), ``line=False``, which draws the
    heads alone, ``dash=(on, off)`` in CSS pixels, ``fill={"base": b, "color": c, "opacity": o}``, which shades the area between the
    line and the value ``b`` of the plane's second axis where the line lies above it, a head with a ``shape``, ``edge``, ``edge_width``,
    ``opacity``, and ``glow``, an ``opacity`` tween, and a color in steps of a channel (:func:`steps_color`).
    """
    if taper is not None:
        if trail is None:
            raise SceneError("2.7: a taper is given without a trail")
        spec = dict(trail) if isinstance(trail, Mapping) else {"fraction": trail}
        if "taper" in spec:
            raise SceneError("2.7: the taper is given twice, in the trail and as taper")
        trail = {**spec, "taper": taper}
    layer: dict[str, Any] = {
        "kind": "track",
        "sets": sets,
        "members": members,
        "reveal": reveal or ("trail" if trail is not None else "none"),
    }
    if head is not False:
        layer["head"] = head
    for key, value in (
        ("trail", trail),
        ("before", before),
        ("after", after),
        ("context", context),
        ("fit", fit),
        ("color", color),
        ("opacity", opacity),
        ("width", width),
        ("highlight", highlight),
        ("visible", visible),
        ("clock", clock),
        ("line", line),
        ("dash", None if dash is None else list(dash)),
        ("fill", fill),
    ):
        if value is not None:
            layer[key] = value
    return _check_layer(layer)


def arrow(
    sets: Any,
    vector: Sequence[str],
    members: Any = "all",
    *,
    scale: Any = None,
    before: str | None = None,
    after: str | None = None,
    color: str | None = None,
    opacity: Any = None,
    width: float | None = None,
    head: float | None = None,
    visible: Any = None,
    clock: Any = None,
) -> dict[str, Any]:
    """An arrow layer (rule L7), drawn on each member at the reading from the point to the point displaced by ``scale`` times the vector.

    ``vector`` names two or three channels of the set, e.g. ``("vx", "vy")``, which are read without the lap's raise. ``scale`` is a number
    or an attribute, by default 1. ``head`` is the arrowhead's length in CSS pixels, by default 10. A member is hidden before or after its
    range of clock values when ``before`` or ``after`` is ``"hidden"``, which shows a track of two samples for a window of the clock.
    """
    layer: dict[str, Any] = {"kind": "arrow", "sets": sets, "members": members, "vector": list(vector)}
    for key, value in (
        ("scale", scale),
        ("before", before),
        ("after", after),
        ("color", color),
        ("opacity", opacity),
        ("width", width),
        ("head", None if head is None else {"size": head}),
        ("visible", visible),
        ("clock", clock),
    ):
        if value is not None:
            layer[key] = value
    return _check_layer(layer)


def outline(
    view: Any,
    *,
    color: str | None = None,
    opacity: Any = None,
    width: float | None = None,
    dash: Sequence[float] | None = None,
    min_size: float | None = None,
    visible: Any = None,
) -> dict[str, Any]:
    """An outline layer (rule L8), which draws the rectangle that the first panel showing ``view`` shows, as the viewer pans and zooms it.

    ``view`` is the id of another view with a plane camera. The rectangle is mapped from the display frame of that panel into the
    display frame of the panel that holds the layer, at the reading of the holder's driver, hence the driver's set carries the channels
    of the frames between them. ``width`` is in CSS pixels, by default 1, ``dash`` is ``(on, off)`` in CSS pixels, and ``min_size`` is
    the least width and height of the outline on the screen, by default 8 CSS pixels. The outline is not part of the camera fit, and it
    is not drawn while the layout does not show ``view``.
    """
    layer: dict[str, Any] = {"kind": "outline", "view": view}
    for key, value in (
        ("color", color),
        ("opacity", opacity),
        ("width", width),
        ("dash", None if dash is None else list(dash)),
        ("min_size", min_size),
        ("visible", visible),
    ):
        if value is not None:
            layer[key] = value
    return _check_layer(layer)


def body(body: Any, *, trail: float | None = None, size: float | None = None, visible: Any = None, opacity: Any = None) -> dict[str, Any]:
    """A body layer, with an optional trail fraction. A body with an image draws it ``size`` CSS pixels across (section 2.11)."""
    layer: dict[str, Any] = {"kind": "body", "body": _id(body)}
    for key, value in (("trail", trail), ("size", size), ("visible", visible), ("opacity", opacity)):
        if value is not None:
            layer[key] = value
    return _check_layer(layer)


def axes(
    span: str | None = None, visible: Any = None, *, ticks: Sequence[str] | None = None, size: float | None = None, opacity: Any = None
) -> dict[str, Any]:
    """An axes layer. ``span`` is ``"full"`` or ``"positive"``, by default full under a plane camera, or ``"box"``, a plot box with
    ticks outside and tick numbers on the axes of ``ticks`` (``"x"`` and ``"y"``, by default both), ``size`` CSS pixels high (section 2.11).
    """
    layer: dict[str, Any] = {"kind": "axes"}
    for key, value in (
        ("span", span),
        ("visible", visible),
        ("ticks", None if ticks is None else list(ticks)),
        ("size", size),
        ("opacity", opacity),
    ):
        if value is not None:
            layer[key] = value
    return _check_layer(layer)


def grid(labels: bool | None = None, visible: Any = None, *, opacity: Any = None) -> dict[str, Any]:
    """A grid layer. ``labels`` numbers its lines, by default under a plane camera."""
    layer: dict[str, Any] = {"kind": "grid"}
    for key, value in (("labels", labels), ("visible", visible), ("opacity", opacity)):
        if value is not None:
            layer[key] = value
    return _check_layer(layer)


def label(
    text: Any,
    at: Mapping[str, Any],
    *,
    offset: Sequence[float] | None = None,
    align: str | None = None,
    baseline: str | None = None,
    size: float | None = None,
    color: str | None = None,
    weight: str | None = None,
    box: Mapping[str, Any] | None = None,
    leader: Any = None,
    opacity: Any = None,
    clock: Any = None,
    visible: Any = None,
) -> dict[str, Any]:
    """A label layer (rule K6), which writes ``text`` at the anchor ``at`` (:func:`at_point`, :func:`at_member`, or :func:`at_screen`).

    ``text`` is a string or a list of parts, e.g. ``["t = ", clock_value(factor=4.34, decimals=1), " days"]``. It is drawn ``offset``
    CSS pixels from the anchor, ``(dx, dy)`` with ``dy`` down the screen, aligned by ``align`` (start, center, end) and ``baseline``
    (top, middle, bottom), ``size`` CSS pixels high, with a ``leader`` line from the anchor and a ``box`` behind it when given.
    ``opacity`` may be a tween, e.g. :func:`fade`, and ``clock`` is the clock of a member anchor (rule K4).
    """
    layer: dict[str, Any] = {"kind": "label", "text": text, "at": at}
    for key, value in (
        ("offset", None if offset is None else list(offset)),
        ("align", align),
        ("baseline", baseline),
        ("size", size),
        ("color", color),
        ("weight", weight),
        ("box", box),
        ("leader", leader),
        ("opacity", opacity),
        ("clock", clock),
        ("visible", visible),
    ):
        if value is not None:
            layer[key] = value
    return _check_layer(layer)


def points(
    sets: Any,
    members: Any = "all",
    *,
    marker: Mapping[str, Any] | None = None,
    reveal: str | None = None,
    before: str | None = None,
    after: str | None = None,
    clock: Any = None,
    fit: bool | None = None,
    opacity: Any = None,
    visible: Any = None,
) -> dict[str, Any]:
    """A points layer (rule K8), which draws the stored samples of its members as markers.

    With ``reveal="grow"``, a sample is drawn once the reading passes it, so that points appear one after another. ``before`` and
    ``after`` hide a member outside its range of clock values, as on a track layer, and ``clock`` is a :func:`layer_clock`.
    """
    layer: dict[str, Any] = {"kind": "points", "sets": sets, "members": members}
    for key, value in (
        ("marker", marker),
        ("reveal", reveal),
        ("before", before),
        ("after", after),
        ("clock", clock),
        ("fit", fit),
        ("opacity", opacity),
        ("visible", visible),
    ):
        if value is not None:
            layer[key] = value
    return _check_layer(layer)


def split(dir: str, ratio: float, a: Any, b: Any, keys: Any = None) -> dict[str, Any]:
    """A layout split. A leaf is a panel id. ``keys`` is a tween of the ratio, with values in [0, 1] (section 2.11)."""
    node: dict[str, Any] = {"kind": "split", "dir": dir, "ratio": ratio, "a": a, "b": b}
    if keys is not None:
        node["keys"] = keys
    return _node(node)


def _node(value: Any) -> dict[str, Any]:
    if isinstance(value, str):
        return {"kind": "panel", "id": _check_id(value, "2.8: a panel id")}
    if isinstance(value, Mapping) and value.get("kind") == "panel" and set(value) == {"kind", "id"}:
        return _node(value["id"])
    split_keys = {"kind", "dir", "ratio", "a", "b"}
    if isinstance(value, Mapping) and value.get("kind") == "split" and split_keys <= set(value) <= split_keys | {"keys"}:
        ratio = _finite(value["ratio"], "2.8: a split ratio")
        if not 0.0 < ratio < 1.0:
            raise SceneError(f"2.8: a split ratio is {ratio}, not in (0, 1)")
        out: dict[str, Any] = {
            "kind": "split",
            "dir": _enum(value["dir"], ("row", "col"), "2.8: a split direction"),
            "ratio": ratio,
            "a": _node(value["a"]),
            "b": _node(value["b"]),
        }
        if "keys" in value:
            out["keys"] = _key_list(value["keys"], "a split's ratio", low=0.0, high=1.0)
        return out
    raise SceneError(f"2.8: a layout node is a panel id or a split, not {value!r}")


def _camera(value: Mapping[str, Any]) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise SceneError(f"2.7: a camera is a dict, not {value!r}")
    kind = _enum(value.get("kind"), ("plane", "orbit"), "2.7: a camera kind")
    out: dict[str, Any] = {"kind": kind}
    if kind == "plane":
        allowed = {"kind", "plane", "aspect", "keys"}
        if "plane" in value:
            out["plane"] = _enum(value["plane"], ("xy", "xz", "yz"), "2.7: a camera plane")
        if "aspect" in value:
            out["aspect"] = _enum(value["aspect"], ("equal", "free"), "2.7: a camera aspect")
        if "keys" in value:
            out["keys"] = _camera_keys(value["keys"], out.get("aspect", "equal"))
    else:
        allowed = {"kind", "projection", "up", "stretch", "turn"}
        if "projection" in value:
            out["projection"] = _enum(value["projection"], ("orthographic", "perspective"), "2.7: a camera projection")
        if "up" in value:
            out["up"] = _enum(value["up"], ("x", "y", "z"), "2.7: a camera up axis")
        if "stretch" in value:
            k = value["stretch"]
            if isinstance(k, (str, Mapping)) or not isinstance(k, Sequence) or len(k) != 3:
                raise SceneError(f"2.7: a camera stretch is three factors along x, y, and z, not {k!r}")
            out["stretch"] = [_finite(x, "2.7: a camera stretch factor") for x in k]
            if any(x <= 0 for x in out["stretch"]):
                raise SceneError(f"2.7: a camera stretch is {out['stretch']}, not three positive factors")
        if "turn" in value:
            out["turn"] = _finite(value["turn"], "2.7: a camera turn")
    if extra := set(value) - allowed:
        raise SceneError(f"2.7: a {kind} camera has unknown keys {sorted(extra)}")
    return out


def follow(layer: int, member: int) -> dict[str, int]:
    """A target of a camera key: the point at the reading of track ``member`` of the track layer at index ``layer`` of the view
    (rule K5)."""
    i = _integer(layer, "K5: the layer of a camera target")
    k = _integer(member, "K5: the member of a camera target")
    if i < 0 or k < 0:
        raise SceneError(f"K5: a camera target is layer {i}, member {k}, not two nonnegative indices")
    return {"layer": i, "member": k}


def shot(
    at: float,
    *,
    width: float,
    center: Sequence[float] | None = None,
    follow: Any = None,
    offset: Sequence[float] | None = None,
    height: float | None = None,
    ease: str = "smooth",
) -> dict[str, Any]:
    """A camera key of a plane camera (rule K5): at time ``at`` of the timeline, the panel shows a window ``width`` units wide (and
    ``height`` units tall under a free aspect), centered on ``center`` or on the mean of the points of ``follow`` plus ``offset``.

    ``follow`` is a :func:`follow` target or a list of them, and ``ease`` says how the camera travels to this key from the key before.
    A key with both ``center`` and ``follow`` takes ``center`` while none of its targets resolves.
    """
    key: dict[str, Any] = {"at": at, "width": width, "ease": ease}
    if center is not None:
        key["center"] = list(center)
    if follow is not None:
        key["follow"] = [follow] if isinstance(follow, Mapping) else list(follow)
    if offset is not None:
        key["offset"] = list(offset)
    if height is not None:
        key["height"] = height
    return _camera_key(key)


def _camera_key(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping) or "at" not in value or "width" not in value:
        raise SceneError(f"K5: a camera key is a dict with at and width, not {value!r}")
    if extra := set(value) - {"at", "width", "height", "center", "follow", "offset", "ease"}:
        raise SceneError(f"K5: a camera key has unknown keys {sorted(extra)}")
    out: dict[str, Any] = {
        "at": _finite(value["at"], "K5: the time of a camera key"),
        "width": _positive(value["width"], "the width of a camera key", "K5"),
    }
    if "height" in value:
        out["height"] = _positive(value["height"], "the height of a camera key", "K5")
    if "center" in value:
        out["center"] = _pair(value["center"], "the center of a camera key", "K5")
    if "follow" in value:
        targets = value["follow"]
        if isinstance(targets, (str, bytes, Mapping)) or not isinstance(targets, Sequence) or len(targets) == 0:
            raise SceneError(f"K5: the follow of a camera key is a nonempty list of targets, not {targets!r}")
        chosen = []
        for t in targets:
            if not isinstance(t, Mapping) or set(t) != {"layer", "member"}:
                raise SceneError(f"K5: a camera target is a dict of layer and member, not {t!r}")
            chosen.append(follow(t["layer"], t["member"]))
        out["follow"] = chosen
    if "center" not in out and "follow" not in out:
        raise SceneError("K5: a camera key has neither a center nor a follow")
    if "offset" in value:
        out["offset"] = _pair(value["offset"], "the offset of a camera key", "K5")
    if "ease" in value:
        out["ease"] = _enum(value["ease"], EASES, "K2: the ease of a camera key")
    return out


def _camera_keys(value: Any, aspect: str) -> list[dict[str, Any]]:
    if isinstance(value, (str, bytes, Mapping)) or not isinstance(value, Sequence) or len(value) == 0:
        raise SceneError(f"K5: the keys of a camera are a nonempty list of camera keys, not {value!r}")
    keys = [_camera_key(k) for k in value]
    for a, b in itertools.pairwise(keys):
        if b["at"] < a["at"]:
            raise SceneError(f"K5: the times of the camera keys decrease from {a['at']} to {b['at']}")
    heights = [("height" in k) for k in keys]
    if any(heights) and not all(heights):
        raise SceneError("K5: some keys of a camera give a height and others do not")
    if any(heights) and aspect != "free":
        raise SceneError('K5: a camera key gives a height, which only a camera with "aspect": "free" takes')
    return keys


def _entry(value: Any) -> dict[str, Any]:
    """A legend entry, ``{"label"}`` with a ``line``, a ``marker``, or ``colors`` (section 2.11)."""
    if not isinstance(value, Mapping) or "label" not in value:
        raise SceneError(f"2.11: a legend entry is a dict with a label, not {value!r}")
    if extra := set(value) - {"label", "line", "marker", "colors"}:
        raise SceneError(f"2.11: a legend entry has unknown keys {sorted(extra)}")
    out: dict[str, Any] = {"label": _text(value["label"], "the label of a legend entry")}
    if "line" in value:
        line = value["line"]
        if not isinstance(line, Mapping) or set(line) - {"color", "width", "dash", "opacity"}:
            raise SceneError(f"2.11: the line of a legend entry is a dict of color, width, dash, and opacity, not {line!r}")
        spec: dict[str, Any] = {}
        if "color" in line:
            spec["color"] = _color(line["color"], "the color of a legend line")
        if "width" in line:
            spec["width"] = _positive(line["width"], "the width of a legend line")
        if "dash" in line:
            spec["dash"] = _pair(line["dash"], "the dash of a legend line")
            if min(spec["dash"]) <= 0.0:
                raise SceneError(f"2.11: the dash of a legend line is {spec['dash']}, not two positive lengths")
        if "opacity" in line:
            spec["opacity"] = _unit_interval(line["opacity"], "the opacity of a legend line")
        out["line"] = spec
    if "marker" in value:
        out["marker"] = _marker(value["marker"], "the marker of a legend entry")
    if "colors" in value:
        colors = value["colors"]
        if isinstance(colors, (str, bytes, Mapping)) or not isinstance(colors, Sequence) or len(colors) == 0:
            raise SceneError(f"2.11: the colors of a legend entry are a nonempty list of colors, not {colors!r}")
        out["colors"] = [_color(c, "a color of a legend entry") for c in colors]
    return out


def entry(
    label: str, *, line: Mapping[str, Any] | None = None, marker: Mapping[str, Any] | None = None, colors: Sequence[str] | None = None
) -> dict[str, Any]:
    """A legend entry: ``label`` with a ``line`` (``{"color", "width", "dash", "opacity"}``), a :func:`marker`, or ``colors``, a list of
    colors drawn as short lines side by side (section 2.11)."""
    spec: dict[str, Any] = {"label": label}
    for key, value in (("line", line), ("marker", marker), ("colors", None if colors is None else list(colors))):
        if value is not None:
            spec[key] = value
    return _entry(spec)


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
            if extra := set(theme) - {"background", "foreground", "grid", "font", "gutter"}:
                raise SceneError(f"a theme has unknown keys {sorted(extra)}")
            self.theme = {k: (_text(v, "the theme font") if k == "font" else _color(v, f"theme {k}")) for k, v in theme.items()}
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
        self._stages: list[dict[str, Any]] = []
        self._overlays: list[dict[str, Any]] = []
        self._images: dict[str, bytes] = {}

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
            out["origin"] = _point(origin, f"the origin of frame {id!r}", channels=True)
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

    def body(
        self,
        id: str,
        *,
        frame: Any,
        position: Sequence[Any],
        label: str | None = None,
        color: str | None = None,
        image: str | os.PathLike[str] | bytes | None = None,
    ) -> Body:
        """Declares a body, a point at three numbers or attributes in ``frame``.

        ``image`` is the path or the bytes of a PNG, JPEG, or WebP file, e.g. a photograph of the Earth, stored in the data container
        and drawn in place of the body's disc (section 2.11).
        """
        self._new(self._bodies, id, "body")
        if _id(frame) not in self._frames:
            raise SceneError(f"2.4: the frame {_id(frame)!r} of body {id!r} is not declared")
        out: dict[str, Any] = {"frame": _id(frame), "position": _point(position, f"the position of body {id!r}")}
        if label is not None:
            out["label"] = _text(label, "a body label")
        if color is not None:
            out["color"] = _color(color, f"the color of body {id!r}")
        if image is not None:
            if isinstance(image, (bytes, bytearray, memoryview)):
                raw = bytes(image)
            else:
                with open(image, "rb") as fh:
                    raw = fh.read()
            if not (raw.startswith((b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff")) or (raw[:4] == b"RIFF" and raw[8:12] == b"WEBP")):
                raise SceneError(f"2.11: the image of body {id!r} is not a PNG, JPEG, or WebP file")
            name = f"bodies/{id}/image"
            self._images[name] = raw
            out["image"] = name
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
        seconds: float | None = None,
        keys: Any = None,
        end: str | None = None,
    ) -> None:
        """The clock (section 2.6). The first channel is the initial one.

        ``laps``, in fraction mode only, is the number of periods that one loop of ``steps`` frames covers (rule C6).
        ``seconds`` is how long one loop lasts at speed 1, in either mode, in place of 8 seconds for each lap.
        In value mode, ``keys`` gives the shared value of the channel at the times of the timeline in place of ``range`` (rule K3),
        so that the clock can pause and change pace. ``end="stop"`` stops playback at the end of the loop (rule K9).
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
        if seconds is not None:
            out["seconds"] = _finite(seconds, "2.6: the clock seconds")
            if out["seconds"] <= 0:
                raise SceneError(f"2.6: the clock seconds are {out['seconds']}, not positive")
        if mode == "value":
            if range is not None and keys is not None:
                raise SceneError("K3: the clock is in value mode and has both a range and keys, not one")
            if keys is not None:
                out["keys"] = _key_list(keys, "the clock")
            else:
                if range is None or isinstance(range, str) or len(range) != 2:
                    raise SceneError("C2: the clock is in value mode but does not have a range of two numbers")
                out["range"] = [_finite(x, "C2: a clock range value") for x in range]
        elif keys is not None:
            raise SceneError("K3: the clock is in fraction mode and has keys, which only a value clock takes")
        if end is not None:
            out["end"] = _enum(end, ("loop", "stop"), "K9: the clock's end")
        if labels is not None:
            out["labels"] = [_text(x, "a clock label") for x in labels]
            if len(out["labels"]) != len(names):
                raise SceneError(f"2.6: the clock has {len(out['labels'])} labels for {len(names)} channels")
        self._clock = out

    def view(
        self,
        id: str,
        *,
        frame: Any,
        driver: Mapping[str, Any],
        layers: Sequence[Mapping[str, Any]],
        camera: Mapping[str, Any] | None = None,
        label: str | None = None,
        margin: Mapping[str, float] | None = None,
        opacity: Any = None,
    ) -> str:
        """A view, given by a frame or a choice variable over frames, a driver, and layers.

        ``margin`` holds the fractions ``top``, ``right``, ``bottom``, and ``left`` of the panel that the camera does not draw into, and
        ``opacity``, a number or a tween, fades every panel of the view (section 2.11).
        """
        self._new(self._views, id, "view")
        if not isinstance(driver, Mapping) or set(driver) != {"sets", "member"}:
            raise SceneError(f"2.7: the driver of view {id!r} is {driver!r}, not driver(sets, member)")
        out: dict[str, Any] = {
            "frame": _var(frame, f"2.7: the frame of view {id!r}", "choice")
            if isinstance(frame, Variable)
            else _check_id(_id(frame), f"2.7: the frame of view {id!r}"),
            "driver": {"sets": _query(driver["sets"]), "member": _member(driver["member"], "the driver's member", one=True)},
            "layers": [_check_layer(x) for x in layers],
        }
        if camera is not None:
            out["camera"] = _camera(camera)
        if label is not None:
            out["label"] = _text(label, "a view label")
        if margin is not None:
            if not isinstance(margin, Mapping) or set(margin) - {"top", "right", "bottom", "left"}:
                raise SceneError(f"2.11: the margin of view {id!r} is a dict of top, right, bottom, and left, not {margin!r}")
            out["margin"] = {}
            for k, v in margin.items():
                x = _finite(v, f"the {k} margin of view {id!r}")
                if not 0.0 <= x < 1.0:
                    raise SceneError(f"2.11: the {k} margin of view {id!r} is {x}, not in [0, 1)")
                out["margin"][k] = x
        if opacity is not None:
            out["opacity"] = _opacity(opacity, f"the opacity of view {id!r}")
        self._views[id] = out
        return id

    def panel(self, id: str, view: str, variables: Mapping[str | Variable, Any] | None = None) -> str:
        """A panel of the initial state that shows ``view``, with the values that it gives to panel-scoped variables."""
        self._new(self._panels, id, "panel")
        out: dict[str, Any] = {"view": _check_id(_id(view), f"2.8: the view of panel {id!r}")}
        if variables:
            out["variables"] = {
                _check_id(_id(k), "a variable id"): self._value(v, f"2.5: the value of {_id(k)!r} in panel {id!r}")
                for k, v in variables.items()
            }
        self._panels[id] = out
        return id

    def _value(self, value: Any, what: str) -> Any:
        if isinstance(value, bool):
            return value
        if isinstance(value, (Frame, Body, TrackSet, Variable)):
            return value.id
        if isinstance(value, str):
            return value
        return _finite(value, what)

    def layout(self, node: Any) -> None:
        """The initial layout, given as a panel id or a :func:`split`."""
        self._layout = _node(node)

    def slider(self, variable: Any, *, label: str, domain: Any) -> None:
        """A slider over a selector by nearest, with its stops taken from the track sets of ``domain``."""
        self._controls.append(
            {
                "kind": "slider",
                "variable": _var(variable, "2.9: a slider", "selector")["var"],
                "label": _text(label, "a label"),
                "domain": _query(domain),
            }
        )

    def tabs(self, variable: Any, *, label: str) -> None:
        """Tabs over a choice."""
        self._controls.append({"kind": "tabs", "variable": _var(variable, "2.9: tabs", "choice")["var"], "label": _text(label, "a label")})

    def toggle_control(self, variable: Any, *, label: str) -> None:
        """A toggle control over a toggle variable."""
        self._controls.append(
            {"kind": "toggle", "variable": _var(variable, "2.9: a toggle control", "toggle")["var"], "label": _text(label, "a label")}
        )

    def transport(self) -> None:
        """The transport, bound to the clock."""
        self._controls.append({"kind": "transport"})

    def readout(self, place: str, *parts: Any) -> None:
        """A readout made of strings, variables, channels, attributes, or part dicts (section 2.9 and rule K7)."""
        _enum(place, ("caption", "panel"), "2.9: a readout place")
        self._readouts.append({"place": place, "parts": [_text_part(p) for p in parts]})

    def stage(self, id: str, at: float, *, label: str | None = None) -> str:
        """A stage, a named time ``at`` of the timeline at which a presentation stops (rule K9)."""
        _check_id(id, "a stage id")
        if any(st["id"] == id for st in self._stages):
            raise SceneError(f"K9: stage {id!r} is declared twice")
        spec: dict[str, Any] = {"id": id, "at": _finite(at, f"K9: the time of stage {id!r}")}
        if self._stages and spec["at"] < self._stages[-1]["at"]:
            raise SceneError(f"K9: stage {id!r} at {spec['at']} comes before stage {self._stages[-1]['id']!r} at {self._stages[-1]['at']}")
        if label is not None:
            spec["label"] = _text(label, "a stage label")
        self._stages.append(spec)
        return id

    def text(self, text: Any, at: Sequence[float], **style: Any) -> None:
        """A text overlay over the whole stage at the fractions ``at = (fx, fy)`` of its width and height (section 2.11).

        ``style`` takes the ``align``, ``baseline``, ``size``, ``color``, ``weight``, ``box``, and ``opacity`` of a label.
        """
        if extra := set(style) - {"align", "baseline", "size", "color", "weight", "box", "opacity"}:
            raise SceneError(f"2.11: a text overlay has unknown keys {sorted(extra)}")
        out: dict[str, Any] = {"kind": "text", "text": _text_parts(text, "a text overlay"), "at": _pair(at, "the place of a text overlay")}
        _text_style(style, "a text overlay", out)
        self._overlays.append(out)

    def legend(
        self,
        entries: Sequence[Mapping[str, Any]],
        at: Sequence[float],
        *,
        columns: int | None = None,
        size: float | None = None,
        color: str | None = None,
        align: str | None = None,
        baseline: str | None = None,
        opacity: Any = None,
        handle_length: float | None = None,
        handle_pad: float | None = None,
        column_spacing: float | None = None,
    ) -> None:
        """A legend overlay of :func:`entry` items at the fractions ``at = (fx, fy)`` of the stage, ``columns`` entries a row
        (section 2.11). ``handle_length``, ``handle_pad``, and ``column_spacing`` are matplotlib's ``handlelength``,
        ``handletextpad``, and ``columnspacing``, in units of the text size, by default 2, 0.8, and 2."""
        out: dict[str, Any] = {"kind": "legend", "at": _pair(at, "the place of a legend"), "entries": [_entry(e) for e in entries]}
        if columns is not None:
            out["columns"] = _integer(columns, "2.11: the columns of a legend")
            if out["columns"] < 1:
                raise SceneError(f"2.11: a legend has {out['columns']} columns, fewer than one")
        for key, value in (("handle_length", handle_length), ("handle_pad", handle_pad), ("column_spacing", column_spacing)):
            if value is not None:
                out[key] = _finite(value, f"2.11: the {key} of a legend")
                if out[key] < 0:
                    raise SceneError(f"2.11: the {key} of a legend is {out[key]}, not a nonnegative length")
        _text_style(
            {k: v for k, v in (("size", size), ("color", color), ("align", align), ("baseline", baseline)) if v is not None},
            "a legend",
            out,
        )
        if opacity is not None:
            out["opacity"] = _opacity(opacity, "the opacity of a legend")
        self._overlays.append(out)

    # output

    def to_document(self) -> dict[str, Any]:
        """The scene document, ``scene.tys``, as a plain dict that does not share any object with the scene."""
        if self._clock is None:
            raise SceneError("2.6: the scene does not have a clock")
        if not self._panels:
            raise SceneError("2.8: the scene does not have a panel")
        doc: dict[str, Any] = {"format": "tycho-scene", "version": "0.4"}
        # a reader that does not implement a feature of section 4 then rejects the scene (rule S1)
        layers = [layer for view in self._views.values() for layer in view["layers"]]
        requires = [
            f
            for f, used in (
                ("layers.arrows", any(layer["kind"] == "arrow" for layer in layers)),
                ("layers.driver_context", any(layer.get("context") == "driver" for layer in layers)),
                ("layers.outline", any(layer["kind"] == "outline" for layer in layers)),
                (
                    "frames.origin_channel",
                    any(
                        isinstance(x, Mapping) and "channel" in x
                        for f in self._frames.values()
                        if isinstance(f.get("origin"), list)
                        for x in f["origin"]
                    ),
                ),
                ("clock.keys", "keys" in self._clock),
                ("layers.clock", any("clock" in layer for layer in layers)),
                ("camera.keys", any("keys" in (view.get("camera") or {}) for view in self._views.values())),
                ("layers.label", any(layer["kind"] == "label" for layer in layers)),
                ("layers.points", any(layer["kind"] == "points" for layer in layers)),
            )
            if used
        ]
        if requires:
            doc["requires"] = requires
        doc["generator"] = f"pytycho {__version__}"
        if self.title is not None:
            doc["title"] = self.title
        if self.theme is not None:
            doc["theme"] = self.theme
        doc["frames"] = self._frames
        if self._bodies:
            doc["bodies"] = self._bodies
        doc["track_sets"] = {}
        for ts in self._sets.values():
            spec: dict[str, Any] = {}
            if ts.label is not None:
                spec["label"] = ts.label
            spec["frame"] = ts.frame
            if ts.tags:
                spec["tags"] = ts.tags
            if ts.attrs:
                spec["attrs"] = ts.attrs
            spec.update({"tracks": len(ts.positions), "offsets": f"{ts.id}/offsets", "positions": f"{ts.id}/positions"})
            if ts.positions and ts.channels[0]:
                spec["channels"] = {n: {"view": f"{ts.id}/channels/{n}", **ts.channel_info.get(n, {})} for n in ts.channels[0]}
            if ts.positions and ts.parameters[0]:
                spec["parameters"] = {n: {"view": f"{ts.id}/parameters/{n}", **ts.parameter_info.get(n, {})} for n in ts.parameters[0]}
            spec["periodic"] = ts.periodic
            doc["track_sets"][ts.id] = spec
        if self._variables:
            doc["variables"] = self._variables
        doc["clock"] = self._clock
        doc["views"] = self._views
        if self._controls:
            doc["controls"] = self._controls
        if self._readouts:
            doc["readouts"] = self._readouts
        layout = self._layout
        if layout is None:
            ids = list(self._panels)
            layout = _node(ids[-1])
            for j in range(len(ids) - 2, -1, -1):
                layout = split("row", 1.0 / (len(ids) - j), ids[j], layout)
        doc["initial"] = {"variables": {}, "clock": {"channel": self._clock["channels"][0]}, "panels": self._panels, "layout": layout}
        if self._stages:
            doc["stages"] = self._stages
        if self._overlays:
            doc["overlays"] = self._overlays
        failures = self._check(doc)
        if failures:
            raise SceneError("the scene breaks these rules:\n" + "\n".join(f"  {f}" for f in failures))
        return copy.deepcopy(doc)

    # the write-time check

    def _check(self, doc: dict[str, Any]) -> list[str]:
        """Every failure of the cross-references and of the rules that hold for the whole scene.

        The rules that depend on a variable are checked for every combination of choice values.
        """
        failures: list[str] = []
        if not self._sets:
            failures.append("2.1: the scene does not have a track set")
        for ts in self._sets.values():
            if not ts.positions:
                failures.append(f"T1: track set {ts.id!r} does not have a track")
            elif ts.kept is not None:
                failures += self._check_kept(ts)
        failures += self._check_clock_channels(doc["clock"])
        tree: FrameTree | None
        try:
            tree = FrameTree(self._frames, self._bodies)
            for fid in self._frames:
                tree.requirements(fid, tree.root)
        except ValueError as exc:
            failures.append(str(exc))
            tree = None
        choices = {k: v["values"] for k, v in self._variables.items() if v["kind"] == "choice"}

        def combos(used: set[str]) -> list[dict[str, str]]:
            keys = sorted(used)
            return (
                [{k: choices[k][j] for k, j in zip(keys, combo, strict=True)} for combo in np.ndindex(*[len(choices[k]) for k in keys])]
                if keys
                else [{}]
            )

        view_ok: dict[str, bool] = {}
        for vid, view in self._views.items():
            broken = self._check_references(vid, view)
            failures += broken
            view_ok[vid] = not broken
            if broken:
                continue
            for values in combos(self._choices_of(view)):
                failures += self._check_view(vid, view, values, tree, doc["clock"])
        failures += self._check_state(doc["initial"])
        for control in self._controls:
            failures += self._check_control(control, combos)
        for readout in self._readouts:
            failures += self._check_readout(readout, doc["initial"], view_ok, combos)
        # the parts of a text overlay are read through the first panel in layout order, as a caption is (rule K7)
        for overlay in self._overlays:
            if overlay["kind"] == "text" and isinstance(overlay["text"], list):
                failures += self._check_readout({"place": "caption", "parts": overlay["text"]}, doc["initial"], view_ok, combos)
        clock = doc["clock"]
        length = clock.get("seconds", 8.0 * clock.get("laps", 1))
        for st in self._stages:
            if not 0.0 <= st["at"] <= length:
                failures.append(f"K9: stage {st['id']!r} is at {st['at']} s, outside the loop of [0, {length}] s")
        return sorted(set(failures))

    def _check_kept(self, ts: TrackSet) -> list[str]:
        kept = ts.kept or []
        if len(kept) != len(ts.positions):
            return [f"T1: track set {ts.id!r} has kept indices for {len(kept)} tracks, not {len(ts.positions)}"]
        out = []
        for i, (k, p) in enumerate(zip(kept, ts.positions, strict=True)):
            if len(k) < 2 or k[0] != 0 or k[-1] != len(p) - 1 or np.any(np.diff(k) <= 0) or np.any(k < 0):
                out.append(f"T1: track set {ts.id!r}: the kept indices of track {i} are not strictly increasing from 0 to {len(p) - 1}")
        return out

    def _check_clock_channels(self, clock: Mapping[str, Any]) -> list[str]:
        """Checks that each clock channel, as stored, is strictly monotone and finite along every track, with a finite span (rule T3)."""
        out = []
        for name in clock["channels"]:
            if name == INDEX:
                continue
            for ts in self._sets.values():
                if not ts.positions or name not in ts.channels[0]:
                    continue
                dtype = self._channel_dtype(ts, name)
                for i, c in enumerate(ts._stored()[1]):
                    stored = c[name].astype(dtype).astype(np.float64)
                    d = np.diff(stored)
                    if not (np.all(d > 0) or np.all(d < 0)):
                        out.append(f"T3: clock channel {name!r} of track set {ts.id!r} is not strictly monotone along track {i}")
                    elif not np.isfinite(stored[-1] - stored[0]):
                        out.append(f"T3: clock channel {name!r} of track set {ts.id!r} has an infinite span along track {i}")
        return out

    def _channel_dtype(self, ts: TrackSet, name: str) -> str:
        """The stored dtype of a channel. It is the dtype given in ``channel_dtypes``, else float64 for a clock
        channel that float32 would spoil (see :meth:`track_set`), else the track set's dtype."""
        if name in ts.channel_dtypes:
            return ts.channel_dtypes[name]
        if ts.dtype == "float64" or self._clock is None or name not in self._clock_names():
            return ts.dtype
        for c in ts._stored()[1]:
            exact = c[name]
            rounded = exact.astype(np.float32).astype(np.float64)
            d = np.diff(rounded)
            if not (np.all(d > 0) or np.all(d < 0)):
                return "float64"
            # compare each step with the larger rounding error of its two ends
            error = np.abs(rounded - exact)
            if np.any(np.maximum(error[:-1], error[1:]) > 0.01 * np.abs(np.diff(exact))):
                return "float64"
        return ts.dtype

    def _clock_names(self) -> set[str]:
        """The channels that a clock reads: those of the scene's clock and those of every layer clock (rules C1 and K4)."""
        names = set(self._clock["channels"]) if self._clock is not None else set()
        for view in self._views.values():
            for layer in view["layers"]:
                if "clock" in layer:
                    names.add(layer["clock"]["channel"])
        return names

    def _check_var(self, vid: Any, kind: str | None, what: str) -> list[str]:
        spec = self._variables.get(vid)
        if spec is None:
            return [f"{what} names {vid!r}, which is not a variable"]
        if kind is not None and spec["kind"] != kind:
            return [f"{what} names {vid!r}, which is a {spec['kind']}, not a {kind}"]
        return []

    def _check_query(self, query: Mapping[str, Any], what: str) -> list[str]:
        if "set" in query:
            return [] if query["set"] in self._sets else [f"{what} names {query['set']!r}, which is not a track set"]
        out = []
        for value in query["tags"].values():
            if isinstance(value, Mapping):
                out += self._check_var(value["var"], "choice", what)
        return out

    def _check_references(self, vid: str, view: Mapping[str, Any]) -> list[str]:
        """Checks that every name in a view refers to a declared frame, body, track set, or variable of the right kind."""
        out = []
        where = f"view {vid!r}"
        if isinstance(view["frame"], Mapping):
            out += self._check_var(view["frame"]["var"], "choice", f"2.7: the frame of {where}")
            for value in self._variables.get(view["frame"]["var"], {}).get("values", []):
                if value not in self._frames:
                    out.append(f"2.7: the frame of {where} can be {value!r}, which is not a frame")
        elif view["frame"] not in self._frames:
            out.append(f"2.7: {where} displays {view['frame']!r}, which is not a frame")
        out += self._check_query(view["driver"]["sets"], f"V2: the driver of {where}")
        if "var" in view["driver"]["member"]:
            out += self._check_var(view["driver"]["member"]["var"], "selector", f"V3: the driver of {where}")
        for layer in view["layers"]:
            if "visible" in layer:
                out += self._check_var(layer["visible"]["var"], "toggle", f"L5: a layer of {where}")
            if layer["kind"] == "track":
                out += self._check_query(layer["sets"], f"V2: a track layer of {where}")
                if isinstance(layer["members"], Mapping) and "var" in layer["members"]:
                    out += self._check_var(layer["members"]["var"], "selector", f"V3: a track layer of {where}")
                if "highlight" in layer:
                    broken = self._check_var(layer["highlight"]["var"], "selector", f"2.7: a highlight of {where}")
                    out += broken
                    if not broken and "kernel" in layer["highlight"] and self._variables[layer["highlight"]["var"]].get("by") == "index":
                        out.append(
                            f"2.7: a highlight kernel of {where} needs a selector by nearest, and {layer['highlight']['var']!r} is by index"
                        )
                color = layer.get("color")
                if isinstance(color, Mapping) and isinstance(color.get("colormap"), Mapping):
                    out += self._check_colormap(color["colormap"], where)
            elif layer["kind"] == "arrow":
                out += self._check_query(layer["sets"], f"V2: an arrow layer of {where}")
                if isinstance(layer["members"], Mapping) and "var" in layer["members"]:
                    out += self._check_var(layer["members"]["var"], "selector", f"V3: an arrow layer of {where}")
            elif layer["kind"] == "outline":
                target = self._views.get(layer["view"])
                if target is None:
                    out.append(f"L8: an outline layer of {where} names {layer['view']!r}, which is not a view")
                elif layer["view"] == vid:
                    out.append(f"L8: an outline layer of {where} names its own view")
                elif (target.get("camera") or {"kind": "plane"})["kind"] != "plane":
                    out.append(f"L8: an outline layer of {where} names view {layer['view']!r}, whose camera is not a plane camera")
            elif layer["kind"] == "body" and layer["body"] not in self._bodies:
                out.append(f"L4: {where} draws {layer['body']!r}, which is not a body")
            elif layer["kind"] == "points":
                out += self._check_query(layer["sets"], f"V2: a points layer of {where}")
                if isinstance(layer["members"], Mapping) and "var" in layer["members"]:
                    out += self._check_var(layer["members"]["var"], "selector", f"V3: a points layer of {where}")
            elif layer["kind"] == "label":
                at = layer["at"]
                if "sets" in at:
                    out += self._check_query(at["sets"], f"V2: a label of {where}")
                if "frame" in at and at["frame"] not in self._frames:
                    out.append(f"K6: a label of {where} has a point in {at['frame']!r}, which is not a frame")
                for part in layer["text"] if isinstance(layer["text"], list) else []:
                    if isinstance(part, Mapping) and "var" in part:
                        out += self._check_var(part["var"], None, f"2.9: a label of {where}")
        for key in (view.get("camera") or {}).get("keys", []):
            for target in key.get("follow", []):
                i = target["layer"]
                if i >= len(view["layers"]):
                    out.append(f"K5: a camera key of {where} follows layer {i}, past its {len(view['layers'])} layers")
                elif view["layers"][i]["kind"] != "track":
                    out.append(
                        f"K5: a camera key of {where} follows layer {i}, which is a {view['layers'][i]['kind']} layer, not a track layer"
                    )
        return out

    def _check_colormap(self, cmap: Mapping[str, Any], where: str) -> list[str]:
        """Checks that a colormap keyed on a variable refers to a choice, and that its map gives a colormap for every value
        of the choice and only for these values (section 2.7)."""
        what = f"2.7: a colormap of {where}"
        broken = self._check_var(cmap["var"], "choice", what)
        if broken:
            return broken
        values = self._variables[cmap["var"]]["values"]
        out = []
        if missing := [v for v in values if v not in cmap["map"]]:
            out.append(f"{what} keyed on {cmap['var']!r} does not name a colormap for {missing}")
        if extra := [k for k in cmap["map"] if k not in values]:
            out.append(f"{what} keyed on {cmap['var']!r} maps {extra}, which are not its values")
        return out

    def _choices_of(self, view: Mapping[str, Any]) -> set[str]:
        """The choice variables on which the frame of a view and the track sets of its driver and layers depend."""
        used = set()
        if isinstance(view["frame"], Mapping):
            used.add(view["frame"]["var"])
        # the frame of an outline's target view, which may be a choice too (rule L8)
        for layer in view["layers"]:
            target = self._views.get(layer["view"]) if layer["kind"] == "outline" else None
            if target is not None and isinstance(target["frame"], Mapping):
                used.add(target["frame"]["var"])
        queries = [layer["sets"] for layer in view["layers"] if layer["kind"] in ("track", "arrow", "points")]
        queries += [layer["at"]["sets"] for layer in view["layers"] if layer["kind"] == "label" and "sets" in layer["at"]]
        for query in [view["driver"]["sets"], *queries]:
            used |= self._choices_in(query)
        return used

    def _choices_in(self, query: Mapping[str, Any]) -> set[str]:
        return {v["var"] for v in query.get("tags", {}).values() if isinstance(v, Mapping)}

    def _check_state(self, state: Mapping[str, Any]) -> list[str]:
        """Checks section 2.8 and rule V1 on the initial state."""
        out = []

        def held(values: Mapping[str, Any], where: str, scope: str) -> None:
            for vid, value in values.items():
                spec = self._variables.get(vid)
                if spec is None:
                    out.append(f"2.8: {where} sets {vid!r}, which is not a variable")
                    continue
                if scope == "panel" and spec["scope"] == "scene":
                    out.append(f"V1: {where} sets {vid!r}, which is scene-scoped and never read there")
                if spec["kind"] == "choice" and value not in spec["values"]:
                    out.append(f"2.5: {where} sets choice {vid!r} to {value!r}, which is not one of its values")
                elif spec["kind"] == "selector" and (isinstance(value, bool) or not isinstance(value, (int, float))):
                    out.append(f"2.5: {where} sets selector {vid!r} to {value!r}, which is not a number")
                elif spec["kind"] == "toggle" and not isinstance(value, bool):
                    out.append(f"2.5: {where} sets toggle {vid!r} to {value!r}, which is not a boolean")

        held(state.get("variables", {}), "the initial state", "scene")
        for pid, panel in state["panels"].items():
            if panel["view"] not in self._views:
                out.append(f"2.8: panel {pid!r} shows {panel['view']!r}, which is not a view")
            held(panel.get("variables", {}), f"panel {pid!r}", "panel")

        def leaves(node: Mapping[str, Any]) -> list[str]:
            return [node["id"]] if node["kind"] == "panel" else leaves(node["a"]) + leaves(node["b"])

        shown = leaves(state["layout"])
        for pid in shown:
            if pid not in state["panels"]:
                out.append(f"2.8: the layout shows {pid!r}, which is not a panel")
        for pid in state["panels"]:
            if pid not in shown:
                out.append(f"2.8: the layout does not show panel {pid!r}")
        if len(set(shown)) != len(shown):
            out.append("2.8: the layout shows a panel twice")
        return out

    def _match(self, query: Mapping[str, Any], values: Mapping[str, str]) -> list[TrackSet]:
        if "set" in query:
            return [self._sets[query["set"]]] if query["set"] in self._sets else []
        want = {k: values[v["var"]] if isinstance(v, Mapping) else v for k, v in query["tags"].items()}
        return [ts for ts in self._sets.values() if ts.positions and all(ts.tags.get(k) == v for k, v in want.items())]

    def _driver_of(self, view: Mapping[str, Any], values: Mapping[str, str], where: str) -> tuple[list[TrackSet], list[str]]:
        drivers = self._match(view["driver"]["sets"], values)
        if len(drivers) > 1:
            return drivers, [f"V2: {where}: the driver's set query matches the track sets {[t.id for t in drivers]}, where one is needed"]
        return drivers, []

    def _check_view(
        self, vid: str, view: Mapping[str, Any], values: Mapping[str, str], tree: FrameTree | None, clock: Mapping[str, Any]
    ) -> list[str]:
        """Checks rules F2, F5, V2, V3, C5, C6, and the drawing references for one view, at one combination of choice values."""
        out = []
        frame = values[view["frame"]["var"]] if isinstance(view["frame"], Mapping) else view["frame"]
        where = f"view {vid!r} with {dict(values)}" if values else f"view {vid!r}"

        def through(ts: TrackSet, src: str, what: str, body: str | None = None) -> None:
            """Checks rules F5 and F2 for a track set evaluated from src, or from the position of body, to the display frame."""
            if tree is None:
                return
            channels, attrs = tree.requirements(src, frame) if body is None else tree.body_requirements(body, frame)
            missing = sorted(channels - set(ts.channels[0]) - {INDEX}) + sorted(attrs - set(ts.attrs))
            if missing:
                out.append(f"F5: {where}: track set {ts.id!r} lacks {missing} for {what} in frame {frame!r}")
                return
            for fid in _edges_used(tree, src, frame):
                scale = self._frames[fid].get("scale")
                if isinstance(scale, Mapping) and "attr" in scale:
                    if scale.get("factor", 1.0) * ts.attrs[scale["attr"]] + scale.get("offset", 0.0) == 0.0:
                        out.append(f"F2: {where}: the scale of frame {fid!r} is zero for track set {ts.id!r}")
                elif isinstance(scale, Mapping) and "channel" in scale:
                    # check every lap that a trail or a reveal can reach, from -n to n - 1 for a clock of n laps (rules L2 and C6)
                    laps = range(-clock.get("laps", 1), clock.get("laps", 1)) if ts.periodic else range(1)
                    for i, c in enumerate(ts._stored()[1]):
                        stored = c[scale["channel"]].astype(ts.dtype).astype(np.float64)
                        advance = stored[-1] - stored[0]
                        if any(np.any((stored + j * advance if j else stored) == 0.0) for j in laps):
                            out.append(f"F2: {where}: the scale of frame {fid!r} is zero on track {i} of track set {ts.id!r}")
                            break

        def clocked(ts: TrackSet, what: str, layer: Mapping[str, Any] | None = None) -> None:
            own = layer.get("clock") if layer is not None else None
            if own is not None:
                # a layer with a clock of its own reads its channel, in one lap (rule K4)
                name = own["channel"]
                if name == INDEX:
                    return
                if name not in ts.channels[0]:
                    out.append(f"C5: {where}: track set {ts.id!r}, {what}, lacks channel {name!r} of its layer's clock")
                    return
                dtype = self._channel_dtype(ts, name)
                for i, c in enumerate(ts._stored()[1]):
                    stored = c[name].astype(dtype).astype(np.float64)
                    d = np.diff(stored)
                    if not (np.all(d > 0) or np.all(d < 0)):
                        out.append(
                            f"T3: {where}: the layer clock channel {name!r} of track set {ts.id!r} is not strictly monotone along track {i}"
                        )
                        break
                return
            missing = [c for c in clock["channels"] if c != INDEX and c not in ts.channels[0]]
            if missing:
                out.append(f"C5: {where}: track set {ts.id!r}, {what}, lacks clock channels {missing}")
            if clock.get("laps", 1) > 1 and not ts.periodic:
                out.append(f"C6: {where}: track set {ts.id!r}, {what}, is not periodic, and the clock has {clock['laps']} laps")

        def member(ts: TrackSet, ref: Any, what: str) -> None:
            if ref == "all" or "count" in ref:
                return
            if "index" in ref:
                if ref["index"] >= len(ts.positions):
                    out.append(
                        f"V3: {where}: member index {ref['index']} of {what} is not below the track count {len(ts.positions)} "
                        f"of track set {ts.id!r}"
                    )
                return
            spec = self._variables[ref["var"]]
            if spec.get("by", "nearest") == "nearest" and spec.get("parameter") not in ts.parameters[0]:
                out.append(f"V3: {where}: track set {ts.id!r} lacks parameter {spec.get('parameter')!r} for selector {ref['var']!r}")

        drivers, broken = self._driver_of(view, values, where)
        out += broken
        if len(drivers) == 1:
            d = drivers[0]
            through(d, d.frame, "the driver")
            clocked(d, "the driver")
            member(d, view["driver"]["member"], "the driver")
        for layer in view["layers"]:
            if layer["kind"] == "track":
                matched = self._match(layer["sets"], values)
                if len(matched) > 1:
                    out.append(
                        f"V2: {where}: a track layer's set query matches the track sets {[t.id for t in matched]}, where one is needed"
                    )
                elif matched:
                    ts = matched[0]
                    # a layer in the driver's context reads the edges from the frame of its set on the driver's set (rule L6)
                    if layer.get("context") != "driver":
                        through(ts, ts.frame, "its tracks")
                    elif len(drivers) == 1:
                        through(drivers[0], ts.frame, f"a layer of track set {ts.id!r} in the driver's context")
                    member(ts, layer["members"], "a track layer")
                    if "highlight" in layer:
                        member(ts, layer["highlight"], "a highlight")
                    hides = (clock["mode"] == "value" or "clock" in layer) and "hidden" in (layer.get("before"), layer.get("after"))
                    if layer.get("reveal", "none") != "none" or _has_head(layer) or hides:
                        clocked(ts, "on which a reading is taken", layer)
                    head = layer.get("head")
                    if isinstance(head, Mapping) and "glow" in head:
                        name = head["glow"]["channel"]
                        if name != INDEX and name not in ts.channels[0]:
                            out.append(f"2.11: {where}: track set {ts.id!r} lacks channel {name!r} for a head's glow")
                    color = layer.get("color")
                    if isinstance(color, Mapping):
                        if "channel" in color and color["channel"] not in ts.channels[0]:
                            out.append(f"2.7: {where}: track set {ts.id!r} lacks channel {color['channel']!r} for a layer's color")
                        if "parameter" in color and color["parameter"] not in ts.parameters[0]:
                            out.append(f"2.7: {where}: track set {ts.id!r} lacks parameter {color['parameter']!r} for a layer's color")
            elif layer["kind"] == "arrow":
                matched = self._match(layer["sets"], values)
                if len(matched) > 1:
                    out.append(
                        f"V2: {where}: an arrow layer's set query matches the track sets {[t.id for t in matched]}, where one is needed"
                    )
                elif matched:
                    ts = matched[0]
                    through(ts, ts.frame, "its arrows")
                    member(ts, layer["members"], "an arrow layer")
                    clocked(ts, "on which a reading is taken", layer)
                    if missing := [c for c in layer["vector"] if c not in ts.channels[0]]:
                        out.append(f"L7: {where}: track set {ts.id!r} lacks channels {missing} of an arrow layer's vector")
                    scale = layer.get("scale")
                    if isinstance(scale, Mapping) and scale["attr"] not in ts.attrs:
                        out.append(f"F5: {where}: track set {ts.id!r} lacks attribute {scale['attr']!r} for an arrow layer's scale")
            elif layer["kind"] == "outline" and len(drivers) == 1:
                target = self._views[layer["view"]]["frame"]
                target = values[target["var"]] if isinstance(target, Mapping) else target
                through(drivers[0], target, f"the outline of view {layer['view']!r}")
            elif layer["kind"] == "body" and len(drivers) == 1:
                d = drivers[0]
                body = self._bodies[layer["body"]]
                through(d, body["frame"], f"body {layer['body']!r}", layer["body"])
            elif layer["kind"] == "points":
                matched = self._match(layer["sets"], values)
                if len(matched) > 1:
                    out.append(
                        f"V2: {where}: a points layer's set query matches the track sets {[t.id for t in matched]}, where one is needed"
                    )
                elif matched:
                    ts = matched[0]
                    through(ts, ts.frame, "its points")
                    member(ts, layer["members"], "a points layer")
                    hides = (clock["mode"] == "value" or "clock" in layer) and "hidden" in (layer.get("before"), layer.get("after"))
                    if layer.get("reveal", "none") == "grow" or hides:
                        clocked(ts, "on which a reading is taken", layer)
            elif layer["kind"] == "label":
                at = layer["at"]
                if "sets" in at:
                    matched = self._match(at["sets"], values)
                    if len(matched) > 1:
                        out.append(
                            f"V2: {where}: a label's set query matches the track sets {[t.id for t in matched]}, where one is needed"
                        )
                    elif matched:
                        ts = matched[0]
                        if at["member"] >= len(ts.positions):
                            out.append(
                                f"K6: {where}: a label's member {at['member']} is not below the track count {len(ts.positions)} "
                                f"of track set {ts.id!r}"
                            )
                        through(ts, ts.frame, "a label's anchor")
                        clocked(ts, "on which a label takes a reading", layer)
                elif "frame" in at and len(drivers) == 1:
                    through(drivers[0], at["frame"], "a label's point")
                parts = [x for x in layer["text"] if isinstance(x, Mapping)] if isinstance(layer["text"], list) else []
                if len(drivers) == 1:
                    d = drivers[0]
                    for part in parts:
                        if "member" in part and part["member"] not in d.parameters[0]:
                            out.append(f"2.9: {where}: a label names parameter {part['member']!r}, which track set {d.id!r} lacks")
                        if "attr" in part and part["attr"] not in d.attrs:
                            out.append(f"2.9: {where}: a label names attribute {part['attr']!r}, which track set {d.id!r} lacks")
                        if "channel" in part and part["channel"] not in d.channels[0]:
                            out.append(f"2.9: {where}: a label names channel {part['channel']!r}, which track set {d.id!r} lacks")
        # a camera key's targets take a reading on the member of a track layer (rules K5 and C5)
        for key in (view.get("camera") or {}).get("keys", []):
            for target in key.get("follow", []):
                layer = view["layers"][target["layer"]]
                matched = self._match(layer["sets"], values)
                if len(matched) != 1:
                    continue
                ts = matched[0]
                if target["member"] >= len(ts.positions):
                    out.append(
                        f"K5: {where}: a camera key follows member {target['member']} of layer {target['layer']}, which is not below "
                        f"the track count {len(ts.positions)} of track set {ts.id!r}"
                    )
                else:
                    clocked(ts, "which a camera key follows", layer)
        return out

    def _check_control(self, control: Mapping[str, Any], combos: Callable[[set[str]], list[dict[str, str]]]) -> list[str]:
        kind = {"slider": "selector", "tabs": "choice", "toggle": "toggle"}.get(control["kind"])
        if kind is None:
            return []
        out = self._check_var(control["variable"], kind, f"2.9: a {control['kind']} control")
        if out or control["kind"] != "slider":
            return out
        spec = self._variables[control["variable"]]
        if spec.get("by", "nearest") != "nearest":
            return [f"2.9: the slider over {control['variable']!r} needs a selector by nearest, and the selector is by index"]
        out += self._check_query(control["domain"], "2.9: a slider's domain")
        if out:
            return out
        for values in combos(self._choices_in(control["domain"])):
            for ts in self._match(control["domain"], values):
                if spec["parameter"] not in ts.parameters[0]:
                    out.append(
                        f"2.9: the slider over {control['variable']!r} has track set {ts.id!r} in its domain, "
                        f"which lacks parameter {spec['parameter']!r}"
                    )
        return out

    def _check_readout(
        self,
        readout: Mapping[str, Any],
        state: Mapping[str, Any],
        view_ok: Mapping[str, bool],
        combos: Callable[[set[str]], list[dict[str, str]]],
    ) -> list[str]:
        """Checks section 2.9: a var part refers to a variable, and every possible driver's track set carries each driver-relative part."""
        out = []
        parts = [p for p in readout["parts"] if isinstance(p, Mapping)]
        for part in parts:
            if "var" in part:
                out += self._check_var(part["var"], None, "2.9: a readout")
        relative = [p for p in parts if any(k in p for k in ("member", "attr", "channel"))]
        if not relative:
            return out

        def leaves(node: Mapping[str, Any]) -> list[str]:
            return [node["id"]] if node["kind"] == "panel" else leaves(node["a"]) + leaves(node["b"])

        panel_ids = list(state["panels"]) if readout["place"] == "panel" else leaves(state["layout"])[:1]
        for pid in panel_ids:
            panel = state["panels"].get(pid)
            if panel is None or not view_ok.get(panel["view"], False):
                continue
            view = self._views[panel["view"]]
            for values in combos(self._choices_in(view["driver"]["sets"])):
                drivers, _ = self._driver_of(view, values, "")
                if len(drivers) != 1:
                    continue
                ts = drivers[0]
                where = f"the {readout['place']} readout through panel {pid!r}" + (f" with {values}" if values else "")
                for part in relative:
                    if "member" in part and part["member"] not in ts.parameters[0]:
                        out.append(f"2.9: {where} names parameter {part['member']!r}, which track set {ts.id!r} lacks")
                    if "attr" in part and part["attr"] not in ts.attrs:
                        out.append(f"2.9: {where} names attribute {part['attr']!r}, which track set {ts.id!r} lacks")
                    if "channel" in part and part["channel"] not in ts.channels[0]:
                        out.append(f"2.9: {where} names channel {part['channel']!r}, which track set {ts.id!r} lacks")
        return out

    def to_container(self) -> bytes:
        """The data container, ``data.tyd``, as bytes."""
        w = ContainerWriter(generator=f"pytycho {__version__}")
        for ts in self._sets.values():
            if not ts.positions:
                raise SceneError(f"T1: track set {ts.id!r} does not have a track")
            if ts.kept is not None and (bad := self._check_kept(ts)):
                raise SceneError(bad[0])
            positions, channels = ts._stored()
            offsets = np.concatenate([[0], np.cumsum([len(p) for p in positions])])
            w.add_view(f"{ts.id}/offsets", offsets, dtype="uint32")
            w.add_view(f"{ts.id}/positions", np.vstack(positions), dtype=ts.dtype)
            for n in channels[0]:
                w.add_view(f"{ts.id}/channels/{n}", np.concatenate([c[n] for c in channels]), dtype=self._channel_dtype(ts, n))
            for n in ts.parameters[0]:
                w.add_view(f"{ts.id}/parameters/{n}", np.array([p[n] for p in ts.parameters]), dtype="float64")
        for name, raw in self._images.items():
            w.add_view(name, np.frombuffer(raw, dtype=np.uint8), dtype="uint8")
        return w.to_bytes()

    def write(self, tys_path: str | os.PathLike[str], tyd_path: str | os.PathLike[str]) -> None:
        """Writes ``scene.tys`` and ``data.tyd``, serializing both before opening either file."""
        try:
            text = json.dumps(self.to_document(), indent=1, ensure_ascii=False, allow_nan=False) + "\n"
        except ValueError as exc:
            raise SceneError(f"S4: {exc}") from None
        data = self.to_container()
        with open(tys_path, "w", encoding="utf-8") as fh:
            fh.write(text)
        with open(tyd_path, "wb") as fh:
            fh.write(data)

    def write_html(self, path: str | os.PathLike[str], *, kiosk: bool = False, runtime: str | None = None) -> dict[str, int]:
        """Writes the scene as one self-contained page, and returns the stored size in bytes of every view and of the page."""
        from .html import write_html

        return write_html(path, self.to_document(), self.to_container(), kiosk=kiosk, runtime=runtime)


def _edges_used(tree: FrameTree, src: str, dst: str, _stack: tuple[str, ...] = ()) -> set[str]:
    """The frames whose edge is evaluated to take a point from ``src`` to ``dst``, through body origins too."""
    up, down = tree.path(src, dst)
    used: set[str] = set()
    for fid in up + down:
        if fid in _stack:
            continue
        used.add(fid)
        origin = tree.frames[fid].get("origin")
        if isinstance(origin, Mapping):
            body = tree.bodies[origin["body"]]
            used |= _edges_used(tree, body["frame"], tree.frames[fid]["parent"], (*_stack, fid))
    return used
