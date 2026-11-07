"""pytycho: the Python side of TyCHO, animated astrodynamics in a single HTML file.

Writes a TyCHO scene from NumPy arrays as two files. The scene document ``scene.tys`` describes the
arrays, and the data container ``data.tyd`` holds them. pytycho DOES NOT hold any dynamics or any
frame formula of a dynamical model, and it does not interpolate samples. Every array comes from
the caller.
"""

__version__ = "0.2.0"

from ._evaluate import EvaluationError, evaluate
from .container import Container, ContainerWriter
from .html import build_html, write_html
from .scene import (
    Scene,
    SceneError,
    TrackSet,
    attr,
    axes,
    body,
    channel,
    driver,
    every,
    grid,
    rotation,
    set_id,
    sets,
    split,
    track,
)

__all__ = [
    "Container",
    "ContainerWriter",
    "EvaluationError",
    "Scene",
    "SceneError",
    "TrackSet",
    "__version__",
    "attr",
    "axes",
    "body",
    "build_html",
    "channel",
    "driver",
    "evaluate",
    "every",
    "grid",
    "rotation",
    "set_id",
    "sets",
    "split",
    "track",
    "write_html",
]
