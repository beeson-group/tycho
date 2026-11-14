"""Invariant manifolds of Earth-Moon periodic orbits of the circular restricted three-body problem, as one TyCHO page, in 3D.

The script reads ``manifolds-input.tyd``, which holds an L1 halo, the L1 and the L2 Lyapunov orbits, and the four legs of
the invariant manifold of each orbit, i.e. the stable and the unstable manifold on each side of the orbit, with 40 arcs a
leg over 8 TU. It writes ``manifolds.tys``, ``manifolds.tyd``, and ``manifolds.html`` next to this script, and it imports
only NumPy, pytycho, and the standard library. TyCHO does not hold any of the dynamics, and every number comes from the input
file.

The input: ``manifolds-input.tyd`` is not in the repository. It is attached to the GitHub Release of each version after 0.2.0
and is downloaded next to this script::

    gh release download vX.Y.Z --repo beeson-group/tycho --pattern manifolds-input.tyd --dir examples/manifolds

or from ``https://github.com/beeson-group/tycho/releases/download/vX.Y.Z/manifolds-input.tyd``, with the version of the
checkout in place of X.Y.Z. The trajectories in it were computed with PyDyLAN, whose build is recorded under ``provenance``
in the meta of the file. The file is a TyCHO data container. For each case, i.e. ``halo-L1``, ``lyapunov-L1``, and
``lyapunov-L2``, it holds the trajectory set ``<case>-orbit`` with one period of the orbit, and the trajectory sets
``<case>-<stability>-<side>`` with the arcs of the four legs. Each trajectory set holds the array ``offsets`` and the float64 arrays
``positions`` and ``channels/time``, plus ``parameters/period``, ``parameters/jacobi``, and ``parameters/closure_error`` for
an orbit and ``parameters/departure`` and ``parameters/span`` for a leg. Its meta holds the label, the mass ratio, the period,
and the Jacobi constant of every case, the manifold time, and the number of arcs a leg.

Time: the clock runs in epoch mode on one absolute time, so that every arc is drawn where it is at the same instant. The
time of a manifold sample is the time along the orbit at which the arc meets it, the parameter ``departure`` of the input,
plus PyDyLAN's time along the arc, which is negative along a stable leg. A stable arc is stored in reverse, from its far end
toward the orbit, so that time increases along every trajectory. The arcs grow from minus the manifold time to the longest period
plus the manifold time, over 20 of the 24 seconds of a loop, and the clock runs on for 4 seconds more, which hold the
manifolds whole. An arc is hidden before its first sample, grows up to the moving point, and stays whole after its last
sample (rule `before-after`). The orbit is the reference trajectory of the panels. Its one converged period is repeated
with the time raised by whole periods until it covers the clock range, as the revolutions of rule `revolutions` do for a
fraction clock, since an epoch clock does not have revolutions. The orbit is drawn as a trail one period long, which is
the whole loop in the rotating frame and the last period of the inertial path in the inertial frame.

Frames: the barycentric inertial frame turns about z by the time channel in TU, which is the inertial angle by the
definition of TU. The Earth and the Moon are bodies at ``-mu`` and ``1 - mu`` in the rotating frame, respectively.

Look: the stable legs are blue and the unstable legs vermilion, the selected arc of the slider is drawn brighter, and the two
manifolds can be toggled. Each arc is drawn only between its first and its last sample at least CLEARANCE from its orbit,
since closer in the arcs of a leg are drawn over the orbit as one bright band. The halo is nearly flat in z, hence the 3d
camera stretches z by a factor of STRETCH_Z, and it turns by AUTO_ROTATE degrees about z over each loop.

With ``--slide dark`` or ``--slide light``, the script instead writes ``manifolds-slide-<mode>.html`` and its two files, the
page from which the video of the halo for a slide of the talk template is exported. It holds the halo alone, with the inertial
panel above the rotating panel for a portrait figure box of 600 by 800 px. It is drawn in the colors of the deck for the mode, with
a label on each panel, without the caption, and without a highlight. The video is exported from it with
``web/scripts/video.mjs``, as described in the header of the script.

With ``--arcs N``, only the first N arcs of every leg are kept, for a quick run.
"""

from __future__ import annotations

import argparse
import hashlib
import sys
import time
from pathlib import Path

import numpy as np

import pytycho as ty

HERE = Path(__file__).resolve().parent
# the SHA-256 hash of the input attached to the Release, or None to read any input
INPUT_SHA256: str | None = None
FRAMES = ["rotating", "barycentric-inertial"]
LEGS = [("stable", "left"), ("stable", "right"), ("unstable", "left"), ("unstable", "right")]
COLORS = {"stable": "#0072b2", "unstable": "#d55e00", "orbit": "#ffffff"}
# the strands and the accent of the talk template, by mode, with the background, foreground, and grid of its palette
SLIDE_COLORS = {
    "dark": {"stable": "#3d8bff", "unstable": "#f08050", "orbit": "#c94fe6"},
    "light": {"stable": "#1f5fd0", "unstable": "#c8571e", "orbit": "#8a2be2"},
}
SLIDE_THEMES = {
    "dark": {"background": "#050505", "foreground": "#f2f2ef", "grid": "#232320"},
    "light": {"background": "#faf8f3", "foreground": "#141413", "grid": "#e3e0d8"},
}
SLIDE_CASE = "halo-L1"
SAMPLES = 400  # stored samples per arc
GROWTH_SECONDS, LOOP_SECONDS = 20.0, 24.0
FRAME_COUNT = 1440  # 60 frames a second over the loop
STRETCH_Z = 5.0
AUTO_ROTATE = 60.0  # degrees about z over one loop
CLEARANCE = 0.02  # DU: an arc is drawn from where it is this far from its orbit
ORBIT_PARAMETERS = ("period", "jacobi", "closure_error")
LEG_PARAMETERS = ("departure", "span")


def read_input(path: Path) -> ty.Container:
    """The input container, checked against ``INPUT_SHA256`` when the hash is set."""
    if not path.is_file():
        raise SystemExit(
            f"{path} does not exist. Download manifolds-input.tyd from the GitHub Release, as the docstring of {__file__} says"
        )
    data = path.read_bytes()
    if INPUT_SHA256 is not None and (digest := hashlib.sha256(data).hexdigest()) != INPUT_SHA256:
        raise SystemExit(f"{path} has SHA-256 {digest}, not the {INPUT_SHA256} of the released input")
    return ty.Container(data)


def declare_frames(scene: ty.Scene, slide: str | None):
    """Declares the two frames, the Earth, and the Moon, and returns the rotating frame and the two bodies."""
    rotating = scene.frame("rotating", label="rotating", axes=("x", "y", "z"), unit="DU")
    scene.frame(
        "barycentric-inertial",
        label="barycentric inertial",
        axes=("X", "Y", "Z"),
        unit="DU",
        parent=rotating,
        rotation=ty.rotation("z", ty.channel("time")),
    )
    moon_color = "#999999" if slide is None else SLIDE_THEMES[slide]["foreground"]
    earth = scene.body("earth", frame=rotating, position=[-ty.attr("mu"), 0.0, 0.0], label="Earth", color="#56b4e9")
    moon = scene.body("moon", frame=rotating, position=[1 - ty.attr("mu"), 0.0, 0.0], label="Moon", color=moon_color)
    return rotating, earth, moon


def tiled(positions: np.ndarray, times: np.ndarray, period: float, start: float, end: float) -> tuple[np.ndarray, np.ndarray]:
    """One period of an orbit repeated, with the time raised by whole periods, so that the time covers ``[start, end]``.

    The closing sample of every repetition but the last is dropped, since it is the first sample of the next one.
    """
    first, last = int(np.floor(start / period)) - 1, int(np.ceil(end / period)) + 1
    parts = [(positions[:-1], times[:-1] + k * period) for k in range(first, last)]
    parts.append((positions[-1:], times[-1:] + (last - 1) * period))
    return np.vstack([p for p, _ in parts]), np.concatenate([t for _, t in parts])


def cleared(arc: np.ndarray, orbit: np.ndarray) -> slice:
    """The rows of an arc from its first to its last sample at least CLEARANCE from the orbit.

    An arc is started within 1e-6 DU of the orbit, and about half of its 8 TU is spent within 0.02 DU of it. Closer in, the arcs
    of a leg coincide with the orbit, and in the inertial frame they are drawn along its path as one bright band.
    """
    far = np.flatnonzero(np.min(np.linalg.norm(arc[:, None, :] - orbit[None, :, :], axis=2), axis=1) >= CLEARANCE)
    return slice(int(far[0]), int(far[-1]) + 1) if far.size else slice(0, 0)


def build(input_path: Path, out_dir: Path, arcs_per_leg: int | None, write_page: bool, slide: str | None = None) -> None:
    source = read_input(input_path)
    cases = source.meta["cases"]
    if slide is not None:
        cases = {SLIDE_CASE: cases[SLIDE_CASE]}
    colors = COLORS if slide is None else SLIDE_COLORS[slide]
    manifold_time = float(source.meta["manifold_time"])
    longest_period = max(float(c["period"]) for c in cases.values())
    start, grown = -manifold_time, longest_period + manifold_time
    clock_range = (start, start + (grown - start) * LOOP_SECONDS / GROWTH_SECONDS)
    title = "Invariant manifolds of Earth-Moon periodic orbits in the circular restricted three-body problem"
    scene = ty.Scene(title=title, theme=None if slide is None else SLIDE_THEMES[slide])
    rotating, earth, moon = declare_frames(scene, slide)

    t0 = time.time()
    orbit_trail = 0.0
    for case, meta in cases.items():
        mu, period = float(meta["mu"]), float(meta["period"])
        orbit = scene.trajectory_set(
            f"{case}-orbit", frame=rotating, tags={"case": case, "kind": "orbit"}, attrs={"mu": mu}, label=f"{meta['label']} orbit"
        )
        positions, times = tiled(
            source.array(f"{case}-orbit/positions"),
            source.array(f"{case}-orbit/channels/time"),
            period,
            clock_range[0] - longest_period,
            clock_range[1],
        )
        orbit.add(
            positions,
            channels={"time": times},
            parameters={n: float(source.array(f"{case}-orbit/parameters/{n}")[0]) for n in ORBIT_PARAMETERS},
        )
        orbit.describe("time", unit="TU")
        orbit.describe("period", label="period", unit="TU")
        orbit.describe("jacobi", label="Jacobi constant")
        orbit.describe("closure_error", label="closure error", unit="DU")
        # a trail of one longest period, as a fraction of the span of this orbit's trajectory, plus a margin that hides the seam
        orbit_trail = max(orbit_trail, (longest_period + 0.1) / float(times[-1] - times[0]))
        for stability, side in LEGS:
            set_name = f"{case}-{stability}-{side}"
            leg = scene.trajectory_set(
                set_name,
                frame=rotating,
                tags={"case": case, "kind": "manifold", "stability": stability, "side": side},
                attrs={"mu": mu},
                label=f"{meta['label']}, {stability} manifold, {side}",
            )
            offsets = source.array(f"{set_name}/offsets")
            positions = source.array(f"{set_name}/positions")
            leg_time = source.array(f"{set_name}/channels/time")
            parameters = {n: source.array(f"{set_name}/parameters/{n}") for n in LEG_PARAMETERS}
            arcs = range(len(offsets) - 1) if arcs_per_leg is None else range(min(arcs_per_leg, len(offsets) - 1))
            for i in arcs:
                arc = slice(int(offsets[i]), int(offsets[i + 1]))
                away = cleared(positions[arc], source.array(f"{case}-orbit/positions"))
                rows = slice(arc.start + away.start, arc.start + away.stop)
                absolute = float(parameters["departure"][i]) + leg_time[rows]
                order = slice(None, None, -1) if stability == "stable" else slice(None)
                leg.add(
                    positions[rows][order], channels={"time": absolute[order]}, parameters={n: float(v[i]) for n, v in parameters.items()}
                )
            leg.describe("time", unit="TU")
            leg.describe("departure", label="departure", unit="TU")
            leg.describe("span", label="span", unit="TU")
            kept = leg.thin(SAMPLES, frames=FRAMES)
            print(
                f"{set_name:28}: {len(arcs):3d} arcs read and thinned to at most {max(map(len, kept))} samples, {time.time() - t0:5.1f} s",
                flush=True,
            )

    case = scene.choice("case", list(cases), labels=[c["label"] for c in cases.values()])
    frame = scene.choice("frame", FRAMES, labels=["rotating", "barycentric inertial" if slide is None else "inertial"], scope="per_panel")
    stable = scene.toggle("stable", default=True)
    unstable = scene.toggle("unstable", default=True)
    toggles = {"stable": stable, "unstable": unstable}
    departure = scene.parameter("departure", parameter="departure", default=0.0)
    orbit_of = ty.by_tags(case=case, kind="orbit")
    legs_of = {leg: ty.by_tags(case=case, kind="manifold", stability=leg[0], side=leg[1]) for leg in LEGS}
    scene.clock("epoch", channels=["time"], labels=["time"], range=list(clock_range), frame_count=FRAME_COUNT, seconds=LOOP_SECONDS)
    layers = []
    highlight = None if slide is not None else {"input": departure, "width": 2.5, "opacity": 1.0}
    for leg, query in legs_of.items():
        layers.append(
            ty.trajectories(
                query,
                "all",
                reveal="grow",
                before="hidden",
                after="clamp",
                color=colors[leg[0]],
                opacity=0.5,
                width=1.0,
                highlight=highlight,
                visible=toggles[leg[0]],
            )
        )
    # the orbit is drawn over the manifolds, which would hide it near the Moon
    layers += [
        ty.trajectories(orbit_of, 0, trail=orbit_trail, taper=(1.0, 1.0), color=colors["orbit"], width=1.5),
        ty.body(earth, trail=1.0, size=8.0),
        ty.body(moon, trail=1.0, size=5.0),
        ty.axes(),
        ty.grid(),
    ]
    scene.panel(
        "main",
        label="manifolds",
        frame=frame,
        reference=ty.reference(orbit_of, 0),
        camera={"kind": "3d", "projection": "perspective", "up": "z", "stretch": [1.0, 1.0, STRETCH_Z], "auto_rotate": AUTO_ROTATE},
        layers=layers,
    )
    scene.show("rotating", panel="main", inputs={frame: "rotating"})
    scene.show("inertial", panel="main", inputs={frame: "barycentric-inertial"})
    if slide is not None:
        scene.layout(ty.split("col", 0.5, "inertial", "rotating"))
        scene.playback()
        scene.readout("panel", frame)
    else:
        scene.layout(ty.split("row", 0.5, "rotating", "inertial"))
        scene.tabs(case, label="orbit")
        scene.toggle_control(stable, label="stable manifold")
        scene.toggle_control(unstable, label="unstable manifold")
        scene.slider(departure, label="departure, TU", domain=ty.by_tags(case=case, kind="manifold"))
        scene.tabs(frame, label="frame")
        scene.playback()
        scene.readout(
            "caption",
            "t = ",
            {"channel": "time", "digits": 4},
            " TU, period ",
            {"parameter": "period", "digits": 5},
            " TU, Jacobi constant ",
            {"parameter": "jacobi", "digits": 6},
            ", selected departure ",
            {"input": "departure", "digits": 4},
            " TU",
        )

    name = "manifolds" if slide is None else f"manifolds-slide-{slide}"
    out_dir.mkdir(parents=True, exist_ok=True)
    scene.write(out_dir / f"{name}.tys", out_dir / f"{name}.tyd")
    print(f"wrote {out_dir / f'{name}.tyd'} ({(out_dir / f'{name}.tyd').stat().st_size / 1e6:.1f} MB) in {time.time() - t0:.1f} s")
    if write_page:
        sizes = scene.write_html(out_dir / f"{name}.html")
        print(f"wrote {out_dir / f'{name}.html'} ({sizes['page'] / 1e6:.1f} MB)")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    parser.add_argument("--input", type=Path, default=HERE / "manifolds-input.tyd", help="the input container from the GitHub Release")
    parser.add_argument(
        "--out", type=Path, default=HERE, help="the directory to write manifolds.tys, manifolds.tyd, and manifolds.html into"
    )
    parser.add_argument("--arcs", type=int, default=None, help="keep the first N arcs of every leg for a quick run")
    parser.add_argument("--no-page", action="store_true", help="write the two files without the HTML page")
    parser.add_argument("--slide", choices=("dark", "light"), default=None, help="write the slide variant for the video in this mode")
    args = parser.parse_args(argv)
    build(args.input, args.out, args.arcs, not args.no_page, args.slide)


if __name__ == "__main__":
    sys.exit(main())
