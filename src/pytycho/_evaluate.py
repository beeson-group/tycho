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
