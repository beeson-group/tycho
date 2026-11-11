"""Sphinx configuration of the TyCHO documentation site.

The spec, the schema, the conformance README, the skill, and the changelog are read where they
live in the repository. The example pages are not tracked in git. Read the Docs downloads them
from the latest GitHub Release into ``_extra/examples``, as does a local build with TYCHO_DOCS_EXAMPLES=1
set. A build without the pages still succeeds, and docs/gallery.md then shows where they are.
"""

from __future__ import annotations

import gzip
import os
import shutil
import sys
import urllib.request
from pathlib import Path

from sphinx.util import logging
from sphinx.util.docutils import SphinxDirective
from sphinx.util.tags import Tags

tags: Tags = globals()["tags"]  # Sphinx puts it in this namespace before executing the file
logger = logging.getLogger("conf")

DOCS = Path(__file__).resolve().parent
ROOT = DOCS.parent
sys.path.insert(0, str(ROOT / "src"))

import pytycho  # noqa: E402

# the version of scene.tys that this release writes, which is also the name of the published schema directory
SCENE_FORMAT = "0.4"
REPOSITORY = "https://github.com/beeson-group/tycho"

project = "TyCHO"
author = "the TyCHO authors"
release = pytycho.__version__
version = ".".join(release.split(".")[:2])


def _copyright() -> str:
    notice = ROOT / "NOTICE"
    lines = notice.read_text(encoding="utf-8").splitlines() if notice.is_file() else []
    return next((line.removeprefix("Copyright ") for line in lines if line.startswith("Copyright ")), f"2026 {author}")


copyright = _copyright()

extensions = [
    "myst_parser",
    "sphinx.ext.autodoc",
    "sphinx.ext.intersphinx",
    "sphinx_autodoc_typehints",
    "sphinx_design",
]
try:
    import sphinx_llms_txt  # noqa: F401
except ImportError:
    pass
else:
    extensions.append("sphinx_llms_txt")

exclude_patterns = ["_build", "_extra", "README.md", "requirements.txt", ".DS_Store"]
# section 3 of the spec writes positions as [x, y, z] inside a json block, which Pygments cannot lex
suppress_warnings = ["misc.highlighting_failure"]
# a fence without a language is text, as in section 1 of the spec
highlight_language = "none"

# MyST

myst_enable_extensions = ["colon_fence", "substitution"]
myst_heading_anchors = 3
# site:path links to a file that html_extra_path publishes, which is not a document or a download
myst_url_schemes = {"http": None, "https": None, "mailto": None, "site": "{{path}}"}

# the published schema and the gallery assets

# html_extra_path copies _extra unchanged to the site root. the schema and the raw spec go to
# schema/<format>/, the path that the $id of the schema gives, and the example pages to examples/
EXTRA = DOCS / "_extra"
STAGED = EXTRA / "schema" / SCENE_FORMAT
STAGED.mkdir(parents=True, exist_ok=True)
for _name in ("scene.schema.json", "tycho-scene.md"):
    shutil.copyfile(ROOT / "spec" / _name, STAGED / _name)

EXAMPLES = EXTRA / "examples"
EXAMPLE_PAGES = ("broucke", "manifolds")
# The example pages are attached to each GitHub Release and are not tracked in git. When Read the Docs sets the READTHEDOCS
# environment variable, fetch_example_pages() downloads the pages and posters of the latest release from the release download
# URLs, which work without a token or an API call. A local build stays offline unless TYCHO_DOCS_EXAMPLES=1 is set.
RELEASE_ASSETS = "https://github.com/beeson-group/tycho/releases/latest/download/"


def fetch_example_pages(dest: Path) -> None:
    """Downloads the page and the poster of each example from the latest GitHub Release into dest, skipping any that is missing."""
    dest.mkdir(parents=True, exist_ok=True)
    for name in [f"{page}.{ext}" for page in EXAMPLE_PAGES for ext in ("html", "png")]:
        try:
            with urllib.request.urlopen(RELEASE_ASSETS + name, timeout=300) as response:
                (dest / name).write_bytes(response.read())
        except OSError as error:  # a release does not exist yet, the asset is missing, or the network is down
            logger.info("%s not fetched: %s", name, error)


if os.environ.get("READTHEDOCS") == "True" or os.environ.get("TYCHO_DOCS_EXAMPLES") == "1":
    fetch_example_pages(EXAMPLES)

myst_substitutions = {
    "version": release,
    "scene_format": SCENE_FORMAT,
    "schema_link": f"[`schema/{SCENE_FORMAT}/scene.schema.json`](site:schema/{SCENE_FORMAT}/scene.schema.json)",
    "spec_link": f"[`schema/{SCENE_FORMAT}/tycho-scene.md`](site:schema/{SCENE_FORMAT}/tycho-scene.md)",
}
for _page in EXAMPLE_PAGES:
    _path = EXAMPLES / f"{_page}.html"
    if _path.is_file():
        _bytes = _path.read_bytes()
        tags.add(f"{_page}_page")
        myst_substitutions[f"{_page}_size"] = f"{len(_bytes) / 1e6:.1f} MB"
        myst_substitutions[f"{_page}_transfer"] = f"{len(gzip.compress(_bytes, 6)) / 1e6:.1f} MB"
    else:
        myst_substitutions[f"{_page}_size"] = myst_substitutions[f"{_page}_transfer"] = "unknown"
    if (EXAMPLES / f"{_page}.png").is_file():
        tags.add(f"{_page}_poster")

# autodoc

# autodoc_default_options is left unset, since under Sphinx 9.1 a default "members" overrides an explicit :members: list
autodoc_member_order = "bysource"
always_document_param_types = True
typehints_defaults = "comma"

intersphinx_mapping = {
    "python": ("https://docs.python.org/3", None),
    "numpy": ("https://numpy.org/doc/stable/", None),
}

# HTML

html_theme = "pydata_sphinx_theme"
# the canonical URL of the version Read the Docs is building, which Sphinx writes into every page
html_baseurl = os.environ.get("READTHEDOCS_CANONICAL_URL", "")
html_title = f"TyCHO {release}"
html_extra_path = ["_extra"]
html_static_path = ["_static"]
html_css_files = ["tycho.css"]
html_show_sourcelink = False
html_theme_options = {
    "github_url": REPOSITORY,
    "header_links_before_dropdown": 7,
    "navbar_align": "left",
    "show_toc_level": 2,
    "footer_start": ["copyright"],
    "footer_end": ["sphinx-version", "theme-version"],
}

# llms.txt

llms_txt_summary = (
    "TyCHO writes animated, interactive astrodynamics visualizations as one self-contained HTML page: "
    "pytycho declares a scene over NumPy arrays, and the browser runtime draws it."
)


class IncludeIfPresent(SphinxDirective):
    """Includes a Markdown file when it exists, and renders the directive's content when it does not."""

    required_arguments = 1
    has_content = True

    def run(self):
        rel, path = self.env.relfn2path(self.arguments[0], self.env.docname)
        # Sphinx rereads a page with a missing dependency on every build, thus the file is included once it exists
        self.env.note_dependency(rel)
        if Path(path).is_file():
            return self.parse_text_to_nodes(Path(path).read_text(encoding="utf-8"), allow_section_headings=True)
        return self.parse_content_to_nodes(allow_section_headings=True)


def setup(app):
    app.add_directive("include-if-present", IncludeIfPresent)
