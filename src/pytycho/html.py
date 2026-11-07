"""Builds a self-contained HTML page from a scene document, a data container, and the runtime bundle.

Both files are embedded base64-encoded as text in ``<script type="application/octet-stream">``
elements, so that a string of the scene cannot close a script tag. The container is embedded as it
is, since its views are already compressed. The browser finds both files through the ``<tycho-viewer>``
element's ``scene`` and ``data`` attributes, inflates the container's encoded views with the
native ``DecompressionStream``, and parses both with no library. The runtime itself is inlined, so
the page works offline, from disk, inside an iframe on a reveal.js slide, or anywhere else a
single HTML file can go.

The runtime bundle ships inside the wheel as ``pytycho/_static/tycho.js``, built from ``web/``
by ``npm run build``.
"""

from __future__ import annotations

import base64
import html as html_escape
import json
import os
from importlib import resources
from pathlib import Path
from typing import Any

from .container import Container

#: The length of the longest string that Chrome holds, in characters. A longer base64 text reads back as empty.
MAX_STRING = 536_870_888


def _resource(name: str) -> str:
    return resources.files("pytycho").joinpath(name).read_text(encoding="utf-8")


def runtime_js() -> str:
    """The bundled browser runtime. Raises if the wheel was built without it."""
    try:
        return _resource("_static/tycho.js")
    except FileNotFoundError as err:
        raise RuntimeError(
            "pytycho/_static/tycho.js is missing: run `npm ci && npm run build` in web/ "
            "(a source checkout needs this once, and a published wheel includes it)"
        ) from err


def build_html(
    document: dict[str, Any] | str,
    container: bytes,
    *,
    title: str | None = None,
    runtime: str | None = None,
    kiosk: bool = False,
) -> str:
    """Renders the page as a string.

    ``document`` is the scene as a dict or as the text of ``scene.tys``. ``title`` defaults to the
    scene's title. ``kiosk`` hides the controls and autoplays, for slides. ``runtime`` overrides the
    bundled runtime, for development. Raises :class:`ValueError` when the base64 of the scene or
    of the data is longer than :data:`MAX_STRING`.
    """
    text = document if isinstance(document, str) else json.dumps(document, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    if title is None:
        title = (json.loads(text) if isinstance(document, str) else document).get("title", "TyCHO")
    js = runtime if runtime is not None else runtime_js()
    if "</script" in js.lower():
        raise ValueError("the runtime bundle contains a closing script tag")
    scene_b64 = base64.b64encode(text.encode("utf-8")).decode("ascii")
    data_b64 = base64.b64encode(container).decode("ascii")
    for what, encoded in (("scene", scene_b64), ("data", data_b64)):
        if len(encoded) > MAX_STRING:
            raise ValueError(
                f"the base64 of the {what} is {len(encoded):,} characters, over the {MAX_STRING:,} that Chrome holds in one string, "
                "and the page would stay empty. Thin the scene's track sets, or store fewer channels or tracks"
            )
    page = _resource("template.html")
    for key, value in (
        ("{{TITLE}}", html_escape.escape(str(title))),
        ("{{ATTRS}}", " kiosk" if kiosk else ""),
        ("{{SCENE}}", scene_b64),
        ("{{DATA}}", data_b64),
        ("{{RUNTIME}}", js),  # last, so that a placeholder inside the runtime is not substituted
    ):
        page = page.replace(key, value)
    return page


def write_html(path: str | os.PathLike[str], document: dict[str, Any] | str, container: bytes, **kwargs: Any) -> dict[str, int]:
    """Writes the page from :func:`build_html` to ``path``, and returns the stored size in bytes of every view and of the page."""
    out = Path(path)
    out.write_text(build_html(document, container, **kwargs), encoding="utf-8")
    stored = Container(container)
    sizes = {name: stored.stored_size(name) for name in stored.names}
    sizes["page"] = out.stat().st_size
    return sizes
