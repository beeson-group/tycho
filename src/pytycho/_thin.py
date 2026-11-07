"""The sample selection behind ``TrackSet.thin``. It selects among the stored samples and does not create new ones.

The caller, ``TrackSet.thin``, passes the positions already taken into each frame of interest by ``FrameTree`` of ``_evaluate.py``.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from itertools import pairwise

import numpy as np


def _extent(tracks: Sequence[np.ndarray]) -> float:
    """The diagonal of the bounding box of every track of the track set, in one frame."""
    allpoints = np.vstack(tracks)
    if not np.all(np.isfinite(allpoints)):
        raise ValueError("the positions are not all finite")
    return float(np.linalg.norm(allpoints.max(axis=0) - allpoints.min(axis=0)))


def _forced(m: int, keep: Sequence[int] | None) -> set[int]:
    forced = {0, m - 1}
    for k in keep if keep is not None else ():
        if isinstance(k, bool) or not isinstance(k, (int, np.integer)):
            # The error is a ValueError, not a TypeError, since TrackSet.thin turns every ValueError into a SceneError.
            raise ValueError(f"kept index {k!r} is not an integer")  # noqa: TRY004
        i = int(k)
        if not 0 <= i < m:
            raise ValueError(f"kept index {i} is outside a track of {m} samples")
        forced.add(i)
    return forced


def select(
    frames: Sequence[Sequence[np.ndarray]],
    *,
    n: int | None = None,
    tolerance: float | None = None,
    keep: Sequence[Sequence[int]] | Callable[[int], Sequence[int]] | None = None,
) -> list[np.ndarray]:
    """Returns, for every track, the strictly increasing indices of the samples to keep.

    ``frames[f][t]`` holds the positions of track ``t`` in frame ``f``, of shape ``(m, 3)``. One of ``n`` and
    ``tolerance`` is given, but not both. ``n`` selects count mode, by blended arclength, and ``tolerance``
    selects the Douglas-Peucker algorithm, relative to the extent of each frame. Both endpoints and every
    index in ``keep`` are always kept, even when they number more than ``n``.
    """
    if (n is None) == (tolerance is None):
        raise ValueError(f"n is {n!r} and tolerance is {tolerance!r}, and thinning takes one of the two")
    if n is not None and (isinstance(n, bool) or not isinstance(n, (int, np.integer)) or n < 2):
        raise ValueError(f"n is {n!r}, not an integer of at least 2")
    if tolerance is not None and not (np.isfinite(tolerance) and tolerance >= 0.0):
        raise ValueError(f"tolerance is {tolerance!r}, not a finite number of at least 0")
    if keep is not None and not callable(keep) and len(keep) != len(frames[0]):
        raise ValueError(f"keep has {len(keep)} entries for {len(frames[0])} tracks")
    extents = [_extent(tracks) for tracks in frames]
    out = []
    for t in range(len(frames[0])):
        m = len(frames[0][t])
        k = keep(t) if callable(keep) else (keep[t] if keep is not None else None)
        # the ty type checker types keep(t) as object when keep is a sequence that is also callable. _forced checks every index anyway
        forced = _forced(m, k)  # ty: ignore[invalid-argument-type]
        pts = [tracks[t] for tracks in frames]
        if n is not None:
            out.append(_count(pts, extents, m, n, forced))
        elif tolerance is not None:
            out.append(_tolerance(pts, extents, float(tolerance), forced))
    return out


def _count(pts, extents, m, n, forced):
    if m <= n:
        return np.arange(m)
    steps = np.zeros(m - 1)
    for p, e in zip(pts, extents, strict=True):
        if e > 0.0:
            steps = np.maximum(steps, np.linalg.norm(np.diff(p, axis=0), axis=1) / e)
    s = np.concatenate([[0.0], np.cumsum(steps)])
    if s[-1] == 0.0:
        s = np.arange(m, dtype=np.float64)

    def snapped(count):
        targets = np.linspace(0.0, s[-1], count)
        j = np.clip(np.searchsorted(s, targets), 1, m - 1)
        # take the nearest stored sample, and the lower one on a tie
        j = np.where(targets - s[j - 1] <= s[j] - targets, j - 1, j)
        return set(j.tolist()) | forced

    for count in range(n, 1, -1):
        chosen = snapped(count)
        if len(chosen) <= n:
            return np.array(sorted(chosen))
    return np.array(sorted(forced))


def _segment_distance(p, a, b):
    ab = b - a
    denom = float(ab @ ab)
    t = np.zeros(len(p)) if denom == 0.0 else np.clip((p - a) @ ab / denom, 0.0, 1.0)
    return np.linalg.norm(p - (a + t[:, None] * ab), axis=1)


def _tolerance(pts, extents, tolerance, forced):
    kept = set(forced)
    # repeat until a pass does not add a point in any frame, so that every dropped sample is within tolerance in every frame
    while True:
        added = set()
        anchors = sorted(kept)
        for p, e in zip(pts, extents, strict=True):
            tol = tolerance * e
            for a, b in pairwise(anchors):
                stack = [(a, b)]
                while stack:
                    i, j = stack.pop()
                    if j - i < 2:
                        continue
                    d = _segment_distance(p[i + 1 : j], p[i], p[j])
                    worst = int(np.argmax(d))
                    if d[worst] > tol:
                        k = i + 1 + worst
                        added.add(k)
                        stack += [(i, k), (k, j)]
        if added <= kept:
            return np.array(sorted(kept))
        kept |= added
