"""Families 7, 8 and 11 of the planar elliptic restricted three-body problem from Broucke 1969, as one TyCHO page.

The families and the five frames are those of Broucke's JPL Technical Report 32-1360, "Periodic orbits in the
elliptic restricted three-body problem". The script reads ``broucke-input.tyd``, which holds one period of every
member of the six family branches, and declares the five frames as a frame tree. It thins every orbit to at most
480 stored samples and writes ``broucke.tys``, ``broucke.tyd``, and ``broucke.html`` next to this script. It
imports only NumPy, pytycho, and the standard library. TyCHO does not hold any of the dynamics, and every number
comes from the input file.

The input: ``broucke-input.tyd`` is not in the repository. It is attached to the GitHub Release of each version
and is downloaded next to this script::

    gh release download v0.2.0 --repo beeson-group/tycho --pattern broucke-input.tyd --dir examples/broucke

or from ``https://github.com/beeson-group/tycho/releases/download/v0.2.0/broucke-input.tyd``, with the
version of the checkout in place of 0.2.0. The trajectories in it were computed with PyDyLAN and thinned
to at most 1920 samples a member in the same five frames. The file is a TyCHO data container. For each track
set ``family-<family>-<branch>``, it holds the view ``offsets`` (uint32) and the float64 views ``positions``,
``channels/true_anomaly``, ``channels/rho``, ``channels/time``, ``parameters/eccentricity``, ``parameters/period``,
and ``parameters/closure_error``. Its meta holds the mass ratio, the tags, and the member count of every set, and
the provenance.

Frames: the orbits are stored in the rotating-pulsating frame. The rotating frame is the rotating-pulsating frame scaled by
the pulsation scale ``rho``, i.e. the distance between the primary and the secondary. The barycentric inertial
frame is the rotating frame rotated by the true anomaly, and the two remaining frames are inertial, one centered
on the primary and one on the secondary. The mass ratio ``mu`` differs per family (0.012155 for family 7 and 0.5
for families 8 and 11) and is therefore a set attribute. The primary and the secondary are bodies at ``-mu`` and
``1 - mu`` in the rotating-pulsating frame, respectively.

Clock channels: the page opens on the elapsed nondimensional time, and the true anomaly, the independent variable
of the elliptic problem, is offered as well, so that playback can be uniform in either. The stored sample index
is the third clock channel.

Look: each frame has a separate colormap over the eccentricity, selected by the frame of the panel, as in
Broucke's figures. A sparse context of about 40 members is drawn under the whole family, which is faint except
near the selected member, where a kernel in eccentricity raises the opacity of its neighbors. The trail of the
selected member is a glow and a comet in the member's colormap color, under a white line with a yellow head.

With ``--members N``, only the first, middle, and last N members of every family branch are kept, for a quick run.
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
# the SHA-256 of the released broucke-input.tyd, set in each release as described in CONTRIBUTING.md.
# read_input() checks the file against it if set
INPUT_SHA256: str | None = None
FAMILIES = [("7", 0.012155), ("8", 0.5), ("11", 0.5)]
# each frame maps to its axis titles and its colormap
FRAMES = {
    "rotating-pulsating": (("x", "y", "z"), "viridis"),
    "rotating": (("x̃", "ỹ", "z̃"), "blues"),
    "barycentric-inertial": (("ξ", "η", "ζ"), "plasma"),
    "inertial-m1": (("ξ₁", "η₁", "ζ₁"), "reds"),
    "inertial-m2": (("ξ₂", "η₂", "ζ₂"), "cividis"),
}
BRANCHES = [("periapsis", 0.0), ("apoapsis", float(np.pi))]
CHANNELS = ("true_anomaly", "rho", "time")
PARAMETERS = ("eccentricity", "period", "closure_error")
SAMPLES = 480
STEPS = 480


def declare_frames(scene: ty.Scene):
    """Declares the five frames, the primary m1, and the secondary m2, and returns the pulsating frame, m1, and m2."""
    pulsating = scene.frame("rotating-pulsating", label="rotating-pulsating", axes=FRAMES["rotating-pulsating"][0], unit="DU")
    rotating = scene.frame("rotating", label="rotating", axes=FRAMES["rotating"][0], unit="DU", parent=pulsating, scale=ty.channel("rho"))
    inertial = scene.frame(
        "barycentric-inertial",
        label="barycentric inertial",
        axes=FRAMES["barycentric-inertial"][0],
        unit="DU",
        parent=rotating,
        rotation=ty.rotation("z", ty.channel("true_anomaly")),
    )
    m1 = scene.body("m1", frame=pulsating, position=[-ty.attr("mu"), 0.0, 0.0], label="m1", color="#e69f00")
    m2 = scene.body("m2", frame=pulsating, position=[1 - ty.attr("mu"), 0.0, 0.0], label="m2", color="#56b4e9")
    scene.frame("inertial-m1", label="inertial, centered on m1", axes=FRAMES["inertial-m1"][0], unit="DU", parent=inertial, origin=m1)
    scene.frame("inertial-m2", label="inertial, centered on m2", axes=FRAMES["inertial-m2"][0], unit="DU", parent=inertial, origin=m2)
    return pulsating, m1, m2


def declare_set(scene: ty.Scene, pulsating, family: str, branch: str, mu: float) -> ty.TrackSet:
    """Declares the track set of one family branch."""
    return scene.track_set(
        f"family-{family}-{branch}",
        frame=pulsating,
        tags={"family": family, "branch": branch},
        attrs={"mu": mu},
        periodic=True,
        label=f"Broucke family {family}, {branch} branch",
    )


def subset(n_members: int, members_per_family: int | None) -> list[int]:
    """The members kept for a quick run, which are the first, middle, and last ``members_per_family``, or all of them."""
    members = list(range(n_members))
    if members_per_family is not None and n_members > 3 * members_per_family:
        n, mid = members_per_family, n_members // 2 - members_per_family // 2
        members = members[:n] + members[mid : mid + n] + members[-n:]
    return members


def read_input(path: Path) -> ty.Container:
    """The input container, checked against ``INPUT_SHA256`` when the hash is set."""
    if not path.is_file():
        raise SystemExit(f"{path} does not exist. Download broucke-input.tyd from the GitHub Release, as the docstring of {__file__} says")
    data = path.read_bytes()
    if INPUT_SHA256 is not None and (digest := hashlib.sha256(data).hexdigest()) != INPUT_SHA256:
        raise SystemExit(f"{path} has SHA-256 {digest}, not the {INPUT_SHA256} of the released input")
    return ty.Container(data)


def build(input_path: Path, out_dir: Path, members_per_family: int | None, write_page: bool) -> None:
    source = read_input(input_path)
    meta = source.meta.get("sets", {})
    scene = ty.Scene(title="Broucke families in the elliptic restricted three-body problem")
    pulsating, m1, m2 = declare_frames(scene)
    frames = list(FRAMES)

    t0 = time.time()
    for family, mu in FAMILIES:
        for branch, _ in BRANCHES:
            ts = declare_set(scene, pulsating, family, branch, mu)
            if ts.id not in meta or meta[ts.id].get("mu") != mu:
                raise SystemExit(f"{input_path} does not have a track set {ts.id!r} at mass ratio {mu}")
            offsets = source.view(f"{ts.id}/offsets")
            positions = source.view(f"{ts.id}/positions")
            channels = {n: source.view(f"{ts.id}/channels/{n}") for n in CHANNELS}
            parameters = {n: source.view(f"{ts.id}/parameters/{n}") for n in PARAMETERS}
            members = subset(len(offsets) - 1, members_per_family)
            for i in members:
                rows = slice(int(offsets[i]), int(offsets[i + 1]))
                ts.add(
                    positions[rows],
                    channels={n: v[rows] for n, v in channels.items()},
                    parameters={n: float(v[i]) for n, v in parameters.items()},
                )
            ts.describe("true_anomaly", unit="rad")
            ts.describe("time", unit="TU")
            ts.describe("eccentricity", label="eccentricity")
            ts.describe("period", label="period", unit="rad")
            ts.describe("closure_error", label="closure error", unit="DU")
            kept = ts.thin(SAMPLES, frames=frames)
            print(
                f"family {family:>2} {branch:9}: {len(members):4d} members read and thinned to at most "
                f"{max(map(len, kept))} samples, {time.time() - t0:5.0f} s",
                flush=True,
            )

    family = scene.choice("family", ["7", "8", "11"], default="11", labels=["family 7", "family 8", "family 11"])
    branch = scene.choice("branch", ["periapsis", "apoapsis"], default="periapsis")
    frame = scene.choice(
        "frame", frames, labels=["rotating-pulsating", "rotating", "barycentric inertial", "inertial, m1", "inertial, m2"], scope="panel"
    )
    e = scene.selector("e", parameter="eccentricity", default=0.25)
    members_of = ty.sets(family=family, branch=branch)
    by_frame = {"parameter": "eccentricity", "colormap": {"var": frame, "map": {f: cmap for f, (_, cmap) in FRAMES.items()}}}
    scene.clock("fraction", channels=["time", "true_anomaly", "@index"], labels=["time", "true anomaly", "sample"], steps=STEPS, laps=1)
    scene.view(
        "main",
        frame=frame,
        driver=ty.driver(members_of, e),
        camera={"kind": "plane", "plane": "xy"},
        layers=[
            ty.track(members_of, ty.every(40), color=by_frame, opacity=0.4),
            ty.track(
                members_of,
                "all",
                color=by_frame,
                opacity=0.05,
                highlight={"var": e, "width": 2.5, "opacity": 1.0, "kernel": {"width": 0.05, "opacity": 0.55}},
            ),
            ty.track(members_of, e, trail=0.3, taper=(0, 0), color=by_frame, width=22.0, opacity=0.3),
            ty.track(members_of, e, trail=0.3, taper=(0, 0), color=by_frame, width=6.0),
            ty.track(members_of, e, trail=0.3, head={"color": "#f0e442", "size": 9}, color="#ffffff", width=2.0),
            ty.body(m1, trail=1.0, size=6.0),
            ty.body(m2, trail=1.0, size=4.0),
            ty.axes(),
            ty.grid(),
        ],
    )
    # each frame gets one panel. the left 60% holds the pulsating and the barycentric frame over the rotating
    # frame, and the right 40% holds the two inertial frames centered on the primary and on the secondary
    scene.panel("pulsating", "main", {frame: "rotating-pulsating"})
    scene.panel("inertial", "main", {frame: "barycentric-inertial"})
    scene.panel("rotating", "main", {frame: "rotating"})
    scene.panel("inertial-m1", "main", {frame: "inertial-m1"})
    scene.panel("inertial-m2", "main", {frame: "inertial-m2"})
    scene.layout(
        ty.split(
            "row",
            0.6,
            ty.split("col", 0.66, ty.split("row", 0.5, "pulsating", "inertial"), "rotating"),
            ty.split("col", 0.5, "inertial-m1", "inertial-m2"),
        )
    )
    scene.tabs(family, label="family")
    scene.tabs(branch, label="branch")
    scene.slider(e, label="eccentricity", domain=members_of)
    scene.tabs(frame, label="frame")
    scene.transport()
    scene.readout(
        "caption",
        "e = ",
        {"member": "eccentricity", "digits": 4},
        ", period ",
        {"member": "period", "digits": 5},
        " rad, closure error ",
        {"member": "closure_error", "digits": 2},
        " DU, mu = ",
        {"attr": "mu", "digits": 6},
    )

    out_dir.mkdir(parents=True, exist_ok=True)
    scene.write(out_dir / "broucke.tys", out_dir / "broucke.tyd")
    print(f"wrote {out_dir / 'broucke.tyd'} ({(out_dir / 'broucke.tyd').stat().st_size / 1e6:.1f} MB) in {time.time() - t0:.0f} s")
    if write_page:
        sizes = scene.write_html(out_dir / "broucke.html")
        print(f"wrote {out_dir / 'broucke.html'} ({sizes['page'] / 1e6:.1f} MB)")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    parser.add_argument("--input", type=Path, default=HERE / "broucke-input.tyd", help="the input container from the GitHub Release")
    parser.add_argument("--out", type=Path, default=HERE, help="the directory to write broucke.tys, broucke.tyd, and broucke.html into")
    parser.add_argument("--members", type=int, default=None, help="keep 3N members per family for a quick run")
    parser.add_argument("--no-page", action="store_true", help="write the two files without the HTML page")
    args = parser.parse_args(argv)
    build(args.input, args.out, args.members, not args.no_page)


if __name__ == "__main__":
    sys.exit(main())
