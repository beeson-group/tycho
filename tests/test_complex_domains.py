"""Tests for TyCHO 0.6 morph layers, number inputs, and action controls."""

from __future__ import annotations

import math

import numpy as np
import pytest

import pytycho as ty
from pytycho._complex import conformal_exp


def test_conformal_exp_endpoints():
    for u, v, period in [(-1.5, 2.0, 0.8), (0.5, -3.1, 1.3), (0.0, 0.0, 2.0)]:
        x0, y0 = conformal_exp(u, v, 0.0, period)
        assert math.isclose(x0, u, abs_tol=1e-12)
        assert math.isclose(y0, v, abs_tol=1e-12)
        x1, y1 = conformal_exp(u, v, 1.0, period)
        z = np.exp((u + 1j * v) * period)
        assert math.isclose(x1, float(z.real), rel_tol=1e-12, abs_tol=1e-12)
        assert math.isclose(y1, float(z.imag), rel_tol=1e-12, abs_tol=1e-12)


def test_06_morph_builders_and_validation_errors():
    scene = ty.Scene("test")
    f = scene.frame("s")
    ts = scene.trajectory_set("pts", frame=f)
    ts.add(np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]]), channels={"t": np.array([0.0, 1.0])})
    ts.describe("t")
    scene.clock("epoch", channels=["t"], range=[0.0, 1.0], frame_count=10, seconds=2.0)

    with pytest.raises(ty.SceneError, match="number-input"):
        scene.number("bad_step", min=0.0, max=1.0, step=0.0, default=0.5)
    with pytest.raises(ty.SceneError, match="number-input"):
        scene.number("bad_default", min=0.0, max=1.0, default=2.0)
    with pytest.raises(ty.SceneError, match=r"^morph: a morph period is 0.0, not positive"):
        ty.morph(alpha=0.0, period=0.0, items=[])

    n = scene.number("T", min=0.1, max=2.0, default=1.0)
    tog = scene.toggle("vis", default=True)
    scene.step("start", 0.0)
    bad_action_scene = ty.Scene("bad_action")
    bf = bad_action_scene.frame("s")
    bts = bad_action_scene.trajectory_set("pts", frame=bf)
    bts.add(np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]]), channels={"t": np.array([0.0, 1.0])})
    bts.describe("t")
    bad_action_scene.clock("epoch", channels=["t"], range=[0.0, 1.0], frame_count=10, seconds=2.0)
    bad_action_scene.panel("main", frame=bf, reference=ty.reference(ty.by_id("pts"), 0), layers=[])
    bad_action_scene.show("main")
    bad_action_scene.action_control("Replay", "missing_step", 1.0)
    with pytest.raises(ty.SceneError, match="action-control"):
        bad_action_scene.to_document()
    scene.action_control("Go", "start", 1.0, show_range=(0.0, 2.0))
    scene.toggle_control(tog, label="V", color="#b06ef3", show_range=(0.0, 1.0))

    scene.panel(
        "main",
        frame=f,
        reference=ty.reference(ty.by_id("pts"), 0),
        layers=[
            ty.morph(
                alpha=0.5,
                period=n,
                items=[
                    ty.morph_line((-1, 0), (1, 0)),
                    ty.morph_region([-2, 0], [-1, 1], reveal=ty.keyframes((0.0, 0.0), (1.0, 1.0)), reveal_origin=(-1.0, 0.0)),
                ],
            ),
        ],
    )
    scene.show("main")
    doc = scene.to_document()
    assert doc["version"] == "0.6"
    assert {"inputs.number", "layers.morph", "controls.action"}.issubset(doc["requires"])

    bad_origin = ty.Scene("bad_origin")
    bf2 = bad_origin.frame("s")
    bts2 = bad_origin.trajectory_set("pts", frame=bf2)
    bts2.add(np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]]), channels={"t": np.array([0.0, 1.0])})
    bts2.describe("t")
    bad_origin.clock("epoch", channels=["t"], range=[0.0, 1.0], frame_count=10, seconds=2.0)
    with pytest.raises(ty.SceneError, match="reveal_origin"):
        bad_origin.panel(
            "main",
            frame=bf2,
            reference=ty.reference(ty.by_id("pts"), 0),
            layers=[ty.morph(alpha=0.0, period=1.0, items=[ty.morph_region([-1, 0], [-1, 1], reveal_origin=[0.0])])],
        )
