"""Tests for TyCHO 0.6 complex-domain evaluators, builders, and validations."""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pytest

import pytycho as ty
from pytycho._complex import (
    companion_system,
    conformal_exp,
    eval_rational_s,
    eval_rational_z,
    eval_time_response,
    impulse_invariant_z,
    map_height,
)


def _eval_poly(coeffs: list[complex], z: complex) -> complex:
    acc = 0j
    for c in reversed(coeffs):
        acc = acc * z + c
    return acc


def test_conformal_exp_endpoints():
    for u, v, period in [(-1.5, 2.0, 0.8), (0.5, -3.1, 1.3), (0.0, 0.0, 2.0)]:
        x0, y0 = conformal_exp(u, v, 0.0, period)
        assert math.isclose(x0, u, abs_tol=1e-12)
        assert math.isclose(y0, v, abs_tol=1e-12)
        x1, y1 = conformal_exp(u, v, 1.0, period)
        z = np.exp((u + 1j * v) * period)
        assert math.isclose(x1, float(z.real), rel_tol=1e-12, abs_tol=1e-12)
        assert math.isclose(y1, float(z.imag), rel_tol=1e-12, abs_tol=1e-12)


@pytest.mark.parametrize(
    ("name", "poles", "zeros", "gain", "period", "exact_fn"),
    [
        ("exp(-at)", [(-0.8, 0.0)], [], 1.0, 0.7, lambda z, t: z / (z - np.exp(-0.8 * t))),
        ("u(t)", [(0.0, 0.0)], [], 1.0, 0.9, lambda z, _t: z / (z - 1.0)),
        ("t", [(0.0, 0.0), (0.0, 0.0)], [], 1.0, 0.8, lambda z, t: (t * z) / (z - 1.0) ** 2),
        ("t^2/2", [(0.0, 0.0), (0.0, 0.0), (0.0, 0.0)], [], 1.0, 0.6, lambda z, t: (t**2 * z * (z + 1.0)) / (2.0 * (z - 1.0) ** 3)),
        (
            "cos(at)",
            [(0.0, 1.4), (0.0, -1.4)],
            [(0.0, 0.0)],
            1.0,
            0.5,
            lambda z, t: (z * (z - math.cos(1.4 * t))) / (z**2 - 2.0 * math.cos(1.4 * t) * z + 1.0),
        ),
        (
            "sin(at)",
            [(0.0, 1.4), (0.0, -1.4)],
            [],
            1.4,
            0.5,
            lambda z, t: (z * math.sin(1.4 * t)) / (z**2 - 2.0 * math.cos(1.4 * t) * z + 1.0),
        ),
        (
            "e^(-at)sin(bt)",
            [(-0.5, 1.8), (-0.5, -1.8)],
            [],
            1.8,
            0.65,
            lambda z, t: (np.exp(-0.5 * t) * math.sin(1.8 * t) * z) / (z**2 - 2.0 * np.exp(-0.5 * t) * math.cos(1.8 * t) * z + np.exp(-t)),
        ),
        (
            "e^(-at)cos(bt)",
            [(-0.5, 1.8), (-0.5, -1.8)],
            [(-0.5, 0.0)],
            1.0,
            0.65,
            lambda z, t: (
                (z * (z - np.exp(-0.5 * t) * math.cos(1.8 * t))) / (z**2 - 2.0 * np.exp(-0.5 * t) * math.cos(1.8 * t) * z + np.exp(-t))
            ),
        ),
    ],
)
def test_impulse_invariant_matches_hlt_table(name, poles, zeros, gain, period, exact_fn):
    res = impulse_invariant_z(poles, zeros, gain, period)
    z_poles = [complex(r, i) for r, i in res["z_poles"]]
    z_num = [complex(r, i) for r, i in res["z_num"]]
    for z in (1.3 + 0.7j, -0.8 + 1.4j, 0.4 - 0.9j):
        num = _eval_poly(z_num, z)
        den = 1.0 + 0j
        for p in z_poles:
            den *= z - p
        got = num / den
        want = exact_fn(z, period)
        assert abs(got - want) < 1e-10, f"{name}: mismatch at z={z}: got {got}, want {want}"
        assert math.isclose(eval_rational_z(res["z_poles"], res["z_num"], z.real, z.imag), abs(want), rel_tol=1e-10)


def test_companion_system_and_time_response():
    with pytest.raises(ValueError, match="at least one pole"):
        companion_system([], [], 1.0)
    with pytest.raises(ValueError, match="proper rational"):
        companion_system([-1.0 + 0j], [0j, -2.0 + 0j], 1.0)

    resp = eval_time_response([(-0.5, 1.8), (-0.5, -1.8)], [], 1.8, 0.5, t_max=4.0, n_cont=41)
    assert len(resp["t"]) == 41
    for t_val, f_val in zip(resp["t"], resp["f"], strict=True):
        want = math.exp(-0.5 * t_val) * math.sin(1.8 * t_val)
        assert math.isclose(f_val, want, abs_tol=1e-10)
    for tk, fk in zip(resp["tk"], resp["fk"], strict=True):
        want = math.exp(-0.5 * tk) * math.sin(1.8 * tk)
        assert math.isclose(fk, want, abs_tol=1e-10)

    mag_s = eval_rational_s([(-1.0, 0.0)], [], 2.0, 0.0, 0.0)
    assert math.isclose(mag_s, 2.0, rel_tol=1e-12)
    h = map_height(10.0, "linear", (4.0, 0.45), height_scale=0.5, grow=0.5)
    assert math.isclose(h, 1.0, rel_tol=1e-3)


def test_06_builders_and_validation_errors():
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
    with pytest.raises(ty.SceneError, match="points-2d"):
        scene.points_2d("bad_pts", default=[[0.0, 0.0], [1.0, 0.0]], min_points=3, max_points=4)

    p = scene.points_2d("p", default=[[-0.5, 0.0]])
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
    scene.readout("caption", ty.roc_status(p, n))

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
            ty.surface(
                {"kind": "rational_s", "poles": p, "x": [-2.0, 2.0], "y": [-2.0, 2.0]},
                slices={"continuous": {"visible": tog}, "clip": True},
            ),
        ],
    )
    scene.show("main")
    doc = scene.to_document()
    assert doc["version"] == "0.6"
    assert {"inputs.number", "inputs.points_2d", "layers.morph", "layers.surface", "controls.action"}.issubset(doc["requires"])

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

    bad_clip = ty.Scene("bad_clip")
    bf3 = bad_clip.frame("s")
    bts3 = bad_clip.trajectory_set("pts", frame=bf3)
    bts3.add(np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]]), channels={"t": np.array([0.0, 1.0])})
    bts3.describe("t")
    bad_clip.clock("epoch", channels=["t"], range=[0.0, 1.0], frame_count=10, seconds=2.0)
    p3 = bad_clip.points_2d("p", default=[[-0.5, 0.0]])
    with pytest.raises(ty.SceneError, match="clip"):
        bad_clip.panel(
            "main",
            frame=bf3,
            reference=ty.reference(ty.by_id("pts"), 0),
            layers=[ty.surface({"kind": "rational_s", "poles": p3, "x": [-2, 2], "y": [-2, 2]}, slices={"clip": "yes"})],
        )


def _surface_scene(poles=((-0.5, 0.0),), zeros=None, *, source="rational_s", poles_kwargs=None, zeros_kwargs=None):
    """A scene with one rational surface over the inputs ``poles`` and ``zeros``, and these two inputs."""
    scene = ty.Scene("surface")
    f = scene.frame("s")
    ts = scene.trajectory_set("pts", frame=f)
    ts.add(np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]]), channels={"t": np.array([0.0, 1.0])})
    ts.describe("t")
    scene.clock("epoch", channels=["t"], range=[0.0, 1.0], frame_count=10, seconds=2.0)
    p = scene.points_2d("poles", default=[list(pt) for pt in poles], **(poles_kwargs or {}))
    src = {"kind": source, "poles": p, "x": [-2.0, 2.0], "y": [-2.0, 2.0]}
    z = None
    if zeros is not None:
        z = scene.points_2d("zeros", default=[list(pt) for pt in zeros], **(zeros_kwargs or {}))
        src["zeros"] = z
    if source == "rational_z":
        src["period"] = 1.0
    scene.panel("main", frame=f, reference=ty.reference(ty.by_id("pts"), 0), layers=[ty.surface(src)])
    scene.show("main")
    return scene, p, z


@pytest.mark.parametrize(
    ("poles", "zeros", "kwargs", "message"),
    [
        ((), None, {}, r"surface: .*poles.*0 points"),
        ([(-0.1 * k, 0.0) for k in range(1, 8)], None, {"poles_kwargs": {"max_points": 8}}, r"surface: .*poles.*7 points"),
        (((-0.5, 0.0),), ((0.0, 0.0), (1.0, 0.0)), {}, r"surface: .*2 zeros and 1 poles"),
        ([(-0.1 * k, 0.0) for k in range(1, 7)], [(0.1 * k, 0.0) for k in range(1, 7)], {}, r"surface: .*zeros.*6 points"),
    ],
)
def test_the_writer_rejects_a_rational_surface_whose_defaults_the_evaluators_reject(poles, zeros, kwargs, message):
    scene, _, _ = _surface_scene(poles, zeros, **kwargs)
    with pytest.raises(ty.SceneError, match=message):
        scene.to_document()


def test_a_preset_of_a_points_2d_control_is_a_proper_rational_function_within_the_counts_of_its_inputs():
    scene, p, z = _surface_scene(((-0.5, 0.0),), (), poles_kwargs={"max_points": 2})
    improper = {"id": "a", "label": "A", "poles": [[-1, 0]], "zeros": [[0, 0], [1, 0]]}
    with pytest.raises(ty.SceneError, match=r"control: preset 'a' has 2 zeros and 1 poles"):
        scene.points_2d_control(p, label="Poles", secondary_input=z, presets=[improper])
    scene.points_2d_control(p, label="Poles", secondary_input=z, presets=[{"id": "b", "label": "B", "poles": [[-1, 0], [-2, 0], [-3, 0]]}])
    with pytest.raises(ty.SceneError, match=r"control: .*preset 'b'.*3 poles.*\[0, 2\]"):
        scene.to_document()


def test_points_2d_takes_numpy_arrays():
    scene, p, _ = _surface_scene(np.array([[-0.5, 0.25], [-0.5, -0.25]]))
    assert scene.to_document()["inputs"]["poles"]["default"] == [[-0.5, 0.25], [-0.5, -0.25]]
    scene.points_2d_control(p, label="Poles", presets=[{"id": "a", "label": "A", "poles": np.array([[-1.0, 0.0]])}])
    assert scene.to_document()["controls"][0]["presets"][0]["poles"] == [[-1.0, 0.0]]


def test_an_array_of_a_surface_grid_is_finite_at_the_dtype_it_is_stored_in():
    scene = ty.Scene("grid")
    with pytest.raises(ty.SceneError, match=r"finite-number: grid array 'big' has non-finite values as float32"):
        scene.array("big", np.full((2, 2), 1e39))
    assert scene.array("big", np.full((2, 2), 1e39), dtype="float64") == "big"


def test_a_points_2d_input_does_not_take_a_conjugate_lock_which_belongs_to_the_control():
    scene = ty.Scene("lock")
    lock: dict[str, Any] = {"conjugate_lock": True}
    with pytest.raises(TypeError):
        scene.points_2d("poles", default=[[-0.5, 0.0]], **lock)
