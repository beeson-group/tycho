"""The sample selection behind ``thin``.

It returns indices only, and it keeps the endpoints, the forced indices, and otherwise at most ``n`` samples.
"""

from __future__ import annotations

from itertools import pairwise

import numpy as np
import pytest

from pytycho._thin import select


def circle(m, r=1.0):
    a = np.linspace(0, 2 * np.pi, m)
    return np.column_stack([r * np.cos(a), r * np.sin(a), 0 * a])


def test_count_mode_contract_on_ragged_tracks():
    tracks = [circle(200), circle(57, 3.0), circle(5)]
    kept = select([tracks], n=20, keep=[[3, 150], [], []])
    for k, t in zip(kept, tracks, strict=True):
        assert np.all(np.diff(k) > 0)
        assert k[0] == 0
        assert k[-1] == len(t) - 1
    assert {3, 150} <= set(kept[0].tolist())
    assert len(kept[0]) <= 20
    assert len(kept[1]) <= 20
    np.testing.assert_array_equal(kept[2], np.arange(5))  # a track shorter than n is left whole


def test_keep_may_force_more_than_n():
    kept = select([[circle(100)]], n=4, keep=lambda _: range(10, 20))
    assert set(range(10, 20)) <= set(kept[0].tolist())
    assert kept[0][0] == 0
    assert kept[0][-1] == 99


def test_tolerance_mode_keeps_every_frame_within_tolerance():
    a, b = circle(300), circle(300) * [1.0, 4.0, 1.0]
    kept = select([[a], [b]], tolerance=1e-3)[0]
    for p in (a, b):
        extent = np.linalg.norm(p.max(axis=0) - p.min(axis=0))
        for i, j in pairwise(kept):
            seg = p[j] - p[i]
            t = np.clip((p[i:j] - p[i]) @ seg / (seg @ seg), 0, 1)
            assert np.max(np.linalg.norm(p[i:j] - (p[i] + t[:, None] * seg), axis=1)) <= 1e-3 * extent


def test_exactly_one_mode():
    with pytest.raises(ValueError, match="and thinning takes one of the two"):
        select([[circle(10)]])
