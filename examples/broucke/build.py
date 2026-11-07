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

import hashlib
from pathlib import Path

import pytycho as ty

# the SHA-256 of the released broucke-input.tyd, set in each release as described in CONTRIBUTING.md.
# read_input() checks the file against it if set
INPUT_SHA256: str | None = None
# each frame maps to its axis titles and its colormap
FRAMES = {
    "rotating-pulsating": (("x", "y", "z"), "viridis"),
    "rotating": (("x̃", "ỹ", "z̃"), "blues"),
    "barycentric-inertial": (("ξ", "η", "ζ"), "plasma"),
    "inertial-m1": (("ξ₁", "η₁", "ζ₁"), "reds"),
    "inertial-m2": (("ξ₂", "η₂", "ζ₂"), "cividis"),
}


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
