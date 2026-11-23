"""Interactive s-to-z complex domains page built with TyCHO 0.6.

Demonstrates the continuous-to-discrete conformal mapping ``z = exp(s * T)``, the
continuous Laplace and causal impulse-invariant Z-transform magnitude surfaces, causal
region of convergence, Fourier slices, and a live 2D pole-zero picker. Imports only
NumPy, pytycho, and the Python standard library.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

import numpy as np

import pytycho as ty

HERE = Path(__file__).resolve().parent

VIOLET = "#b06ef3"
ORANGE = "#f0a050"
BLUE = "#5b9bd5"
CYAN = "#38d0e8"
GRAY = "#8a8880"
ALIAS = "#a078c8"

STEPS_FULL = [
    ("axes", 0.0, "Empty s-plane"),
    ("stable", 3.0, "Stable region (\u03c3 < 0)"),
    ("unstable", 6.0, "Unstable region (\u03c3 > 0)"),
    ("omega", 9.0, "Constant-\u03c9 & Nyquist"),
    ("marginal", 12.0, "Imaginary & real axes"),
    ("morph", 15.0, "Conformal morph s \u2192 z"),
    ("split", 21.0, "Side-by-side s and z"),
    ("surfaces", 25.0, "3D |F(s)|, |F(z)| & ROC"),
    ("continuous", 28.0, "FT & DTFT slices"),
    ("discrete", 31.0, "FS & DFT stems"),
]

STEPS_SLIDE = [
    ("axes", 0.0, "Empty s-plane"),
    ("stable", 3.0, "Stable region (\u03c3 < 0)"),
    ("unstable", 6.0, "Unstable region (\u03c3 > 0)"),
    ("omega", 9.0, "Constant-\u03c9 & Nyquist"),
    ("marginal", 12.0, "Imaginary & real axes"),
    ("morph", 15.0, "Conformal morph s \u2192 z"),
    ("split", 21.0, "Side-by-side s and z"),
    ("surfaces", 25.0, "3D |F(s)| & |F(z)|"),
]

PRESETS = [
    {"id": "exp_neg_at", "label": "e⁻ᵃᵗ", "poles": [[-0.8, 0.0]], "zeros": [], "gain": 1.0},
    {"id": "step_u", "label": "u(t)", "poles": [[0.0, 0.0]], "zeros": [], "gain": 1.0},
    {"id": "ramp_t", "label": "t", "poles": [[0.0, 0.0], [0.0, 0.0]], "zeros": [], "gain": 1.0},
    {"id": "quad_t2", "label": "t² / 2", "poles": [[0.0, 0.0], [0.0, 0.0], [0.0, 0.0]], "zeros": [], "gain": 1.0},
    {"id": "cos_at", "label": "cos(at)", "poles": [[0.0, 1.6], [0.0, -1.6]], "zeros": [[0.0, 0.0]], "gain": 1.0},
    {"id": "sin_at", "label": "sin(at)", "poles": [[0.0, 1.6], [0.0, -1.6]], "zeros": [], "gain": 1.6},
    {"id": "damped_sin", "label": "e⁻ᵃᵗ sin(bt)", "poles": [[-0.5, 1.8], [-0.5, -1.8]], "zeros": [], "gain": 1.8},
    {"id": "damped_cos", "label": "e⁻ᵃᵗ cos(bt)", "poles": [[-0.5, 1.8], [-0.5, -1.8]], "zeros": [[-0.5, 0.0]], "gain": 1.0},
]


def _morph_items(toggles: dict[str, Any], *, animated: bool, include_aliasing: bool) -> list[dict]:
    """Build conformal grid lines and stability half-plane fills."""

    def kf_reveal(t0: float, t1: float):
        return ty.keyframes((t0, 0.0), (t1, 1.0, "smooth")) if animated else 1.0

    def kf_step_opacity(t0: float, full: float, dim_3d: float):
        if not animated:
            return dim_3d
        return ty.keyframes((t0, 0.0), (t0 + 0.04, full), (21.0, full), (24.0, dim_3d, "smooth"))

    def kf_opacity(t0: float, t1: float, full: float, dim_3d: float):
        if not animated:
            return dim_3d
        return ty.keyframes((t0, 0.0), (t1, full, "smooth"), (21.0, full), (24.0, dim_3d, "smooth"))

    u_lo = -3.8
    u_hi = 1.05
    sigma_stable = [-3.5, -3.0, -2.5, -2.0, -1.5, -1.0, -0.5]
    sigma_unstable = [0.25, 0.5, 0.75, 1.0]
    omega_fracs = [-0.75, -0.5, -0.25, 0.25, 0.5, 0.75]
    items: list[dict] = []

    # Half-plane fills revealed smoothly with radial iris spread
    items.append(
        ty.morph_region(
            [u_lo, 0.0],
            [ty.nyquist(-1), ty.nyquist(1)],
            samples=(28, 128),
            color=VIOLET,
            opacity=kf_step_opacity(0.0, 0.16, 0.11),
            reveal=kf_reveal(0.15, 2.3),
            reveal_origin=(-1.9, 0.0),
            visible=toggles["stable"],
        )
    )
    items.append(
        ty.morph_region(
            [0.0, u_hi],
            [ty.nyquist(-1), ty.nyquist(1)],
            samples=(24, 128),
            color=ORANGE,
            opacity=kf_step_opacity(3.0, 0.16, 0.11),
            reveal=kf_reveal(3.15, 5.3),
            reveal_origin=(0.55, 0.0),
            visible=toggles["unstable"],
        )
    )

    if include_aliasing:
        # Aliasing strips (pi/T < |omega| <= 3 pi/T)
        for lo_k, hi_k in ((1, 3), (-3, -1)):
            items.append(
                ty.morph_region(
                    [u_lo, u_hi],
                    [ty.nyquist(lo_k), ty.nyquist(hi_k)],
                    samples=(24, 96),
                    color=ALIAS,
                    opacity=kf_step_opacity(6.0, 0.12, 0.10),
                    reveal=kf_reveal(6.1, 8.2),
                    reveal_origin=(-1.0, ty.nyquist(2 if lo_k > 0 else -2)),
                    visible=toggles["aliasing"],
                )
            )
        for k in (-2.5, -2.0, -1.5, 1.5, 2.0, 2.5):
            items.append(
                ty.morph_line(
                    (u_lo, ty.nyquist(k)),
                    (u_hi, ty.nyquist(k)),
                    samples=40,
                    color=ALIAS,
                    width=1.2,
                    opacity=kf_opacity(6.0, 8.5, 0.65, 0.45),
                    dash=(4.0, 4.0),
                    visible=toggles["aliasing"],
                )
            )

    # Base morphed coordinate axes visible while curving in and back from step 5
    morph_base_opacity = (
        ty.keyframes((0.0, 0.0), (12.0, 0.0), (12.5, 0.42, "smooth"), (20.2, 0.42), (20.9, 0.0, "smooth")) if animated else 0.35
    )
    items.append(
        ty.morph_line(
            (u_lo, 0.0),
            (u_hi, 0.0),
            samples=48,
            color=GRAY,
            width=1.4,
            opacity=morph_base_opacity,
        )
    )
    items.append(
        ty.morph_line(
            (0.0, ty.nyquist(-1.1)),
            (0.0, ty.nyquist(1.1)),
            samples=129,
            color=GRAY,
            width=1.4,
            opacity=morph_base_opacity,
        )
    )

    # Constant-sigma vertical lines
    for i, sig in enumerate(sigma_stable):
        dt = 0.2 * i
        items.append(
            ty.morph_line(
                (sig, ty.nyquist(-1)),
                (sig, ty.nyquist(1)),
                samples=129,
                color=VIOLET,
                width=1.6,
                opacity=kf_step_opacity(0.15 + dt, 0.85, 0.50),
                reveal=kf_reveal(0.2 + dt, 1.6 + dt),
                visible=toggles["stable"],
            )
        )
    for i, sig in enumerate(sigma_unstable):
        dt = 0.35 * i
        items.append(
            ty.morph_line(
                (sig, ty.nyquist(-1)),
                (sig, ty.nyquist(1)),
                samples=129,
                color=ORANGE,
                width=1.6,
                opacity=kf_step_opacity(3.15 + dt, 0.85, 0.50),
                reveal=kf_reveal(3.2 + dt, 4.8 + dt),
                visible=toggles["unstable"],
            )
        )

    # Constant-omega lines & Nyquist bounds
    for frac in omega_fracs:
        items.append(
            ty.morph_line(
                (u_lo, ty.nyquist(frac)),
                (u_hi, ty.nyquist(frac)),
                samples=40,
                color=GRAY,
                width=1.3,
                opacity=kf_step_opacity(6.1, 0.72, 0.42),
                reveal=kf_reveal(6.2, 8.0),
                visible=toggles["omega"],
            )
        )
    for bound_k in (-1, 1):
        items.append(
            ty.morph_line(
                (u_lo, ty.nyquist(bound_k)),
                (u_hi, ty.nyquist(bound_k)),
                samples=48,
                width=2.0,
                dash=(6.0, 4.0),
                opacity=kf_step_opacity(6.5, 0.88, 0.52),
                reveal=kf_reveal(6.6, 8.6),
                visible=toggles["omega"],
            )
        )

    # Highlighted real axis & imaginary unit-circle boundary
    items.append(
        ty.morph_line(
            (u_lo, 0.0),
            (u_hi, 0.0),
            samples=48,
            width=2.4,
            opacity=kf_step_opacity(9.3, 0.9, 0.52),
            reveal=kf_reveal(9.4, 11.2),
            visible=toggles["real"],
        )
    )
    items.append(
        ty.morph_line(
            (0.0, ty.nyquist(-1)),
            (0.0, ty.nyquist(1)),
            samples=129,
            color=BLUE,
            width=3.2,
            opacity=kf_step_opacity(9.3, 1.0, 0.65),
            reveal=kf_reveal(9.4, 11.4),
            visible=toggles["marginal"],
        )
    )
    return items


def _floor_grid_items(x_range: tuple[float, float], y_range: tuple[float, float]) -> list[dict]:
    """Build an outer Cartesian reference frame for the extended 3D base plane."""
    x0, x1 = x_range
    y0, y1 = y_range
    items: list[dict] = []
    for x in range(int(np.ceil(x0)), int(np.floor(x1)) + 1):
        if x == 0:
            continue
        items.append(ty.morph_line((float(x), y0), (float(x), y1), samples=2, color=GRAY, width=1.0, opacity=0.45))
    for y in range(int(np.ceil(y0)), int(np.floor(y1)) + 1):
        if y == 0:
            continue
        items.append(ty.morph_line((x0, float(y)), (x1, float(y)), samples=2, color=GRAY, width=1.0, opacity=0.45))
    for p0, p1 in (
        ((x0, y0), (x1, y0)),
        ((x1, y0), (x1, y1)),
        ((x1, y1), (x0, y1)),
        ((x0, y1), (x0, y0)),
    ):
        items.append(ty.morph_line(p0, p1, samples=2, color=GRAY, width=1.2, opacity=0.55))
    return items


def _add_arrow_set(
    scene: ty.Scene,
    set_id: str,
    frame: Any,
    segments: list[tuple[tuple[float, float, float], tuple[float, float, float]]],
) -> ty.TrajectorySet:
    """Create a static 2-sample trajectory set carrying displacement vectors for positive axis arrows."""
    ts = scene.trajectory_set(set_id, frame=frame)
    t_arr = np.array([0.0, 1.0], dtype=np.float64)
    for base, tip in segments:
        bx, by, bz = base
        tx, ty_, tz = tip
        vx, vy, vz = tx - bx, ty_ - by, tz - bz
        pts = np.array([[bx, by, bz], [bx, by, bz]], dtype=np.float64)
        ts.add(
            pts,
            channels={
                "t": t_arr,
                "vx": np.array([vx, vx], dtype=np.float64),
                "vy": np.array([vy, vy], dtype=np.float64),
                "vz": np.array([vz, vz], dtype=np.float64),
            },
        )
    ts.describe("t")
    return ts


def build_scene(*, slide: bool = False) -> ty.Scene:
    """Construct the interactive Complex Domains (s to z) scene or its compact talk-slide variant."""
    theme = {"background": "#050505", "foreground": "#f2f2ef", "grid": "#232320"}
    scene = ty.Scene(title=None if slide else "Complex Domains: s to z", theme=theme)

    s_frame = scene.frame("s", label="s-plane", axes=("\u03c3", "j\u03c9", "|F(s)|"))
    z_frame = scene.frame("z", parent=s_frame, label="z-plane", axes=("Re(z)", "Im(z)", "|F(z)|"))

    origin_ref = scene.trajectory_set("origin_ref", frame=s_frame)
    origin_ref.add(np.array([[0.0, 0.0, 0.0], [0.0, 0.0, 0.0]]), channels={"t": np.array([0.0, 1.0])})
    origin_ref.describe("t")
    ref = ty.reference(ty.by_id("origin_ref"), 0)

    end_t = 25.0 if slide else 32.0
    frame_count = 800 if slide else 1024
    steps = STEPS_SLIDE if slide else STEPS_FULL
    scene.clock("epoch", channels=["t"], labels=["t"], range=[0.0, 1.0], frame_count=frame_count, seconds=end_t, end="stop")
    for step_id, at_t, label in steps:
        scene.step(step_id, at_t, label=label)

    # Inputs: keep the picker bounds compact inside the enlarged rendered surface and plane
    picker_x_bounds = [-2.4, 1.6]
    picker_y_bounds = [-3.2, 3.2]
    period = scene.number("T", min=0.25, max=2.0, step=0.05, default=1.0)
    sample_n = scene.number("N", min=4, max=64, step=1, default=16)
    poles = scene.points_2d(
        "poles", default=[[-0.8, 0.0]], min_points=1, max_points=6, bounds=[picker_x_bounds, picker_y_bounds], conjugate_lock=True
    )
    zeros = scene.points_2d("zeros", default=[], min_points=0, max_points=5, bounds=[picker_x_bounds, picker_y_bounds], conjugate_lock=True)
    gain = scene.number("gain", min=-10.0, max=10.0, step=0.1, default=1.0)
    preset = (
        None
        if slide
        else scene.choice(
            "preset",
            [p["id"] for p in PRESETS] + ["custom"],
            labels=[p["label"] for p in PRESETS] + ["Custom"],
            default="exp_neg_at",
        )
    )
    scale = scene.choice("scale", ["linear", "log"], labels=["Linear |F|", "Log (1+|F|)"], default="linear")

    toggles_2d = {
        "stable": scene.toggle("show_stable", default=True),
        "unstable": scene.toggle("show_unstable", default=True),
        "marginal": scene.toggle("show_marginal", default=True),
        "real": scene.toggle("show_real", default=True),
        "omega": scene.toggle("show_omega", default=True),
        "aliasing": scene.toggle("show_aliasing", default=False),
    }
    show_roc = scene.toggle("show_roc", default=not slide)
    show_ft = scene.toggle("show_ft", default=not slide)
    show_fs = scene.toggle("show_fs", default=not slide)
    show_dtft = scene.toggle("show_dtft", default=not slide)
    show_dft = scene.toggle("show_dft", default=not slide)
    show_time = scene.toggle("show_time", default=slide)

    surf_grow = ty.keyframes((0.0, 0.0), (22.0, 0.0), (24.8, 1.0, "smooth"))
    surf_opacity = ty.keyframes((0.0, 0.0), (22.2, 0.0), (24.0, 0.74, "smooth"))
    roc_opacity = ty.keyframes((0.0, 0.0), (21.8, 0.0), (23.6, 0.24, "smooth"))
    cont_opacity = (
        ty.keyframes((0.0, 0.0), (22.2, 0.0), (24.0, 0.96, "smooth"))
        if slide
        else ty.keyframes((0.0, 0.0), (25.2, 0.0), (28.0, 0.96, "smooth"))
    )
    disc_opacity = (
        ty.keyframes((0.0, 0.0), (22.2, 0.0), (24.0, 0.96, "smooth"))
        if slide
        else ty.keyframes((0.0, 0.0), (28.2, 0.0), (31.0, 0.96, "smooth"))
    )
    mark_opacity = ty.keyframes((0.0, 0.0), (21.4, 0.0), (22.8, 1.0, "smooth"))
    floor_3d_opacity = ty.keyframes((0.0, 0.0), (21.2, 0.0), (23.2, 0.34, "smooth"))
    s_axes_xy_opacity = ty.keyframes((0.0, 0.80), (12.0, 0.80), (12.5, 0.0, "smooth"), (20.3, 0.0), (21.0, 0.86, "smooth"))
    s_morph_z_opacity = ty.keyframes((0.0, 0.0), (14.4, 0.0), (15.0, 0.85, "smooth"), (17.9, 0.85), (18.5, 0.0, "smooth"))
    axis_z_opacity = ty.keyframes((0.0, 0.0), (21.8, 0.0), (23.5, 0.88, "smooth"))

    s_axes_xy = _add_arrow_set(
        scene,
        "s_axes_xy",
        s_frame,
        [((-4.6, 0.0, 0.0), (3.7, 0.0, 0.0)), ((0.0, -5.0, 0.0), (0.0, 5.0, 0.0))],
    )
    s_axes_morph_z = _add_arrow_set(
        scene,
        "s_axes_morph_z",
        s_frame,
        [((-4.0, 0.0, 0.0), (4.05, 0.0, 0.0)), ((0.0, -4.0, 0.0), (0.0, 4.05, 0.0))],
    )
    s_axis_z = _add_arrow_set(scene, "s_axis_z", s_frame, [((0.0, 0.0, 0.0), (0.0, 0.0, 2.85))])
    z_axes_xy = _add_arrow_set(
        scene,
        "z_axes_xy",
        z_frame,
        [((-4.0, 0.0, 0.0), (4.05, 0.0, 0.0)), ((0.0, -4.0, 0.0), (0.0, 4.05, 0.0))],
    )
    z_axis_z = _add_arrow_set(scene, "z_axis_z", z_frame, [((0.0, 0.0, 0.0), (0.0, 0.0, 2.85))])

    s_cam = {
        "kind": "3d",
        "projection": "perspective",
        "up": "z",
        "keyframes": [
            ty.camera_keyframe_3d(0.0, center=[-0.45, 0.25, 0.0], width=30.0, azimuth=-90.0, elevation=90.0),
            ty.camera_keyframe_3d(12.0, center=[-0.45, 0.25, 0.0], width=30.0, azimuth=-90.0, elevation=90.0),
            ty.camera_keyframe_3d(15.0, center=[0.0, 0.22, 0.0], width=24.6, azimuth=-90.0, elevation=90.0, ease="smooth"),
            ty.camera_keyframe_3d(18.0, center=[0.0, 0.22, 0.0], width=24.6, azimuth=-90.0, elevation=90.0),
            ty.camera_keyframe_3d(21.0, center=[-0.45, 0.22, 0.0], width=15.6, azimuth=-90.0, elevation=90.0, ease="smooth"),
            ty.camera_keyframe_3d(23.6, center=[-0.45, 0.0, 0.62], width=14.2, azimuth=-56.0, elevation=32.0, ease="smooth"),
        ],
    }
    z_cam = {
        "kind": "3d",
        "projection": "perspective",
        "up": "z",
        "keyframes": [
            ty.camera_keyframe_3d(0.0, center=[0.0, 0.22, 0.0], width=12.6, azimuth=-90.0, elevation=90.0),
            ty.camera_keyframe_3d(21.0, center=[0.0, 0.22, 0.0], width=12.6, azimuth=-90.0, elevation=90.0),
            ty.camera_keyframe_3d(23.6, center=[0.0, 0.0, 0.62], width=11.8, azimuth=-56.0, elevation=32.0, ease="smooth"),
        ],
    }

    s_morph = ty.morph(
        alpha=ty.keyframes((0.0, 0.0), (12.0, 0.0), (15.0, 1.0, "smooth"), (18.0, 1.0), (21.0, 0.0, "smooth")),
        period=period,
        items=_morph_items(toggles_2d, animated=True, include_aliasing=not slide),
    )
    z_morph = ty.morph(
        alpha=1.0,
        period=period,
        items=_morph_items(toggles_2d, animated=False, include_aliasing=not slide),
    )
    s_floor_3d = ty.morph(
        alpha=0.0,
        period=1.0,
        opacity=floor_3d_opacity,
        items=_floor_grid_items((-4.4, 3.4), (-4.8, 4.8)),
    )
    z_floor_3d = ty.morph(
        alpha=0.0,
        period=1.0,
        opacity=floor_3d_opacity,
        items=_floor_grid_items((-3.8, 3.8), (-3.8, 3.8)),
    )

    s_roc_spec = None if slide else {"visible": show_roc, "color": VIOLET, "opacity": roc_opacity}
    z_roc_spec = None if slide else {"visible": show_roc, "color": VIOLET, "opacity": roc_opacity}

    s_surface = ty.surface(
        {
            "kind": "rational_s",
            "poles": poles,
            "zeros": zeros,
            "gain": gain,
            "period": period,
            "x": [-3.4, 2.4],
            "y": [-4.0, 4.0],
            "resolution": [208, 208],
        },
        scale=scale,
        clamp={"max": 3.6, "softness": 0.14},
        height_scale=0.6,
        colormap="magma",
        color_range=[-0.35, 2.16],
        grooves={"step": [0.5, 0.5], "color": "#050505", "opacity": 0.22},
        roc=s_roc_spec,
        slices={
            "continuous": {"visible": show_ft, "color": CYAN, "divergent_color": ORANGE, "opacity": cont_opacity},
            "discrete": {"visible": show_fs, "count": sample_n, "color": BLUE, "opacity": disc_opacity},
            "clip": True,
        },
        markers={"opacity": mark_opacity},
        grow=surf_grow,
        opacity=surf_opacity,
    )

    z_surface = ty.surface(
        {
            "kind": "rational_z",
            "poles": poles,
            "zeros": zeros,
            "gain": gain,
            "period": period,
            "x": [-2.8, 2.8],
            "y": [-2.8, 2.8],
            "resolution": [208, 208],
        },
        scale=scale,
        clamp={"max": 3.6, "softness": 0.14},
        height_scale=0.6,
        colormap="magma",
        color_range=[-0.35, 2.16],
        grooves={"step": [0.5, 0.5], "color": "#050505", "opacity": 0.22},
        roc=z_roc_spec,
        slices={
            "continuous": {"visible": show_dtft, "color": CYAN, "divergent_color": ORANGE, "opacity": cont_opacity},
            "discrete": {"visible": show_dft, "count": sample_n, "color": BLUE, "opacity": disc_opacity},
            "clip": True,
        },
        markers={"opacity": mark_opacity},
        grow=surf_grow,
        opacity=surf_opacity,
    )

    s_axes_xy_layer = ty.arrow(ty.by_id(s_axes_xy), ("vx", "vy", "vz"), color=GRAY, opacity=s_axes_xy_opacity, width=1.6, head=10)
    s_axes_morph_z_layer = ty.arrow(ty.by_id(s_axes_morph_z), ("vx", "vy", "vz"), color=GRAY, opacity=s_morph_z_opacity, width=1.6, head=10)
    s_axis_z_layer = ty.arrow(ty.by_id(s_axis_z), ("vx", "vy", "vz"), color=GRAY, opacity=axis_z_opacity, width=1.6, head=10)
    z_axes_xy_layer = ty.arrow(ty.by_id(z_axes_xy), ("vx", "vy", "vz"), color=GRAY, opacity=0.86, width=1.6, head=10)
    z_axis_z_layer = ty.arrow(ty.by_id(z_axis_z), ("vx", "vy", "vz"), color=GRAY, opacity=axis_z_opacity, width=1.6, head=10)

    s_labels = [
        ty.label("\u03c3", ty.at_point(3.95, -0.24, 0.0), color=GRAY, size=12, opacity=s_axes_xy_opacity),
        ty.label("j\u03c9", ty.at_point(0.42, 4.78, 0.0), color=GRAY, size=12, opacity=s_axes_xy_opacity),
        ty.label("Re(z)", ty.at_point(4.32, -0.24, 0.0), color=GRAY, size=12, opacity=s_morph_z_opacity),
        ty.label("Im(z)", ty.at_point(0.58, 3.85, 0.0), color=GRAY, size=12, opacity=s_morph_z_opacity),
        ty.label("|F(s)|", ty.at_point(0.0, 0.0, 3.08), color=GRAY, size=12, opacity=axis_z_opacity),
    ]
    z_labels = [
        ty.label("Re(z)", ty.at_point(4.32, -0.24, 0.0), color=GRAY, size=12, opacity=0.88),
        ty.label("Im(z)", ty.at_point(0.58, 3.85, 0.0), color=GRAY, size=12, opacity=0.88),
        ty.label("|F(z)|", ty.at_point(0.0, 0.0, 3.08), color=GRAY, size=12, opacity=axis_z_opacity),
    ]

    scene.panel(
        "s_panel",
        label="s-plane",
        frame=s_frame,
        reference=ref,
        camera=s_cam,
        layers=[s_morph, s_floor_3d, s_axes_xy_layer, s_axes_morph_z_layer, s_surface, s_axis_z_layer, *s_labels],
    )
    scene.panel(
        "z_panel",
        label="z-plane",
        frame=z_frame,
        reference=ref,
        camera=z_cam,
        layers=[z_morph, z_floor_3d, z_axes_xy_layer, z_surface, z_axis_z_layer, *z_labels],
    )
    scene.show("s_panel")
    scene.show("z_panel")

    scene.layout(
        ty.split(
            "row",
            0.5,
            "s_panel",
            "z_panel",
            keyframes=[(0.0, 1.0), (18.0, 1.0), (21.0, 0.5, "smooth")],
        )
    )

    # Controls staged along the storyboard timeline
    if not slide:
        scene.action_control("Replay Morph", "marginal", "morph", show_range=(12.0, end_t))
        scene.slider(period, label="T")
    scene.toggle_control(toggles_2d["stable"], label="\u03c3 < 0", color=VIOLET, show_range=(0.0, 20.99))
    scene.toggle_control(toggles_2d["unstable"], label="\u03c3 > 0", color=ORANGE, show_range=(0.0, 20.99))
    scene.toggle_control(toggles_2d["marginal"], label="\u03c3 = 0", color=BLUE, show_range=(0.0, 20.99))
    scene.toggle_control(toggles_2d["real"], label="\u03c9 = 0", show_range=(0.0, 20.99))
    scene.toggle_control(toggles_2d["omega"], label="const \u03c9", show_range=(0.0, 20.99))
    if not slide:
        scene.toggle_control(toggles_2d["aliasing"], label="Aliasing", color=ALIAS, show_range=(6.0, 20.99))
        scene.tabs(preset, label="Preset", show_range=(21.0, end_t))
    scene.tabs(scale, label="Scale", show_range=(21.0, end_t))
    if not slide:
        scene.slider(sample_n, label="N", show_range=(28.0, end_t))
        scene.toggle_control(show_roc, label="ROC", color=VIOLET, show_range=(21.0, end_t))
    cont_range = (21.0, end_t) if slide else (25.0, end_t)
    disc_range = (21.0, end_t) if slide else (28.0, end_t)
    scene.toggle_control(show_ft, label="FT", color=CYAN, show_range=cont_range)
    scene.toggle_control(show_dtft, label="DTFT", color=CYAN, show_range=cont_range)
    scene.toggle_control(show_fs, label="FS", color=BLUE, show_range=disc_range)
    scene.toggle_control(show_dft, label="DFT", color=BLUE, show_range=disc_range)
    scene.toggle_control(show_time, label="f(t)", show_range=(21.0, end_t))

    scene.points_2d_control(
        poles,
        label="Poles & Zeros (s)",
        secondary_input=zeros,
        gain_input=gain,
        period_input=period,
        preset_input=None if slide else preset,
        conjugate_lock=True,
        presets=None if slide else PRESETS,
        show_time_domain=show_time,
        show_range=(21.0, end_t),
    )

    scene.playback()
    if not slide:
        scene.readout(
            "caption",
            "T = ",
            {"input": period, "decimals": 2},
            " s, ROC: ",
            ty.roc_status(poles, period),
        )
    return scene


def build(out_dir: Path, *, write_page: bool = True, slide: bool = False) -> Path:
    """Build and write the s-to-z scene files into ``out_dir``."""
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = "s-to-z-slide" if slide else "s-to-z"
    scene = build_scene(slide=slide)
    scene.write(out_dir / f"{stem}.tys", out_dir / f"{stem}.tyd")
    html_path = out_dir / f"{stem}.html"
    if write_page:
        sizes = scene.write_html(html_path, title="Complex Domains: s to z", minimal="slide") if slide else scene.write_html(html_path)
        print(f"wrote {html_path} ({sizes['page'] / 1e6:.2f} MB)")
    return html_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    parser.add_argument("--out", type=Path, default=HERE, help="directory for s-to-z.tys, s-to-z.tyd, and s-to-z.html")
    parser.add_argument("--no-page", action="store_true", help="write scene and container without standalone HTML")
    parser.add_argument("--slide", action="store_true", help="write the minimal talk-slide variant s-to-z-slide.html")
    args = parser.parse_args(argv)
    build(args.out, write_page=not args.no_page, slide=args.slide)
    return 0


if __name__ == "__main__":
    sys.exit(main())
