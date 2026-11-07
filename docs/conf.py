"""Sphinx configuration of the TyCHO documentation site.

The spec, the schema, the conformance README, the skill, and the changelog are read where they
live in the repository. The example pages are not tracked in git. Read the Docs downloads them
from the latest GitHub Release into ``_extra/examples``, as does a local build with TYCHO_DOCS_EXAMPLES=1
set. A build without the pages still succeeds, and docs/gallery.md then shows where they are.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

DOCS = Path(__file__).resolve().parent
ROOT = DOCS.parent
sys.path.insert(0, str(ROOT / "src"))

import pytycho  # noqa: E402

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
