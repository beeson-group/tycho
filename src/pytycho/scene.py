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
