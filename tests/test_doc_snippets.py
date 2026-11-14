"""The minimal scene of skills/tycho/SKILL.md, which docs/quickstart.md includes, runs and writes its page."""

from __future__ import annotations

import re
import runpy
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "skills" / "tycho" / "SKILL.md"
# docs/quickstart.md includes the python fence between these two markers
MINIMAL_SCENE = re.compile(r"<!-- minimal-scene:start -->\n```python\n(.*?)```\n<!-- minimal-scene:end -->", re.DOTALL)


def test_the_minimal_scene_writes_its_page(tmp_path, monkeypatch):
    match = MINIMAL_SCENE.search(SKILL.read_text(encoding="utf-8"))
    assert match, "the python fence between the minimal-scene markers of SKILL.md was not found"
    script = tmp_path / "minimal_scene.py"
    script.write_text(match.group(1), encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    runpy.run_path(str(script), run_name="__main__")
    assert "<tycho-viewer" in (tmp_path / "loop.html").read_text(encoding="utf-8")
