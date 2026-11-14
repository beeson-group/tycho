"""Every rule named by pytycho, the tests, and the conformance corpus is defined in ``spec/tycho-scene.md``."""

from __future__ import annotations

import io
import json
import re
import tokenize
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "spec" / "tycho-scene.md"
CORPUS = ROOT / "spec" / "conformance"
# a message that opens with a rule name, e.g. "members: ...", or a pytest pattern anchored on one
PREFIX = re.compile(r"\^?([a-z][a-z0-9-]*): ")
# a citation in prose, e.g. "rule `members`" or "rules `arrow`, `clock-channel-carried`, and `transform-channels`"
CITATION = re.compile(r"\brules? ((?:`[a-z][a-z0-9-]*`(?:,? and |,? or |, )?)+)")
FSTRING_START = getattr(tokenize, "FSTRING_START", None)
FSTRING_MIDDLE = getattr(tokenize, "FSTRING_MIDDLE", None)


def defined() -> set[str]:
    """The rule names of the spec, each defined by a bullet that opens with the name in backticks and a full stop."""
    return set(re.findall(r"^\s*- `([a-z][a-z0-9-]*)`\.", SPEC.read_text(encoding="utf-8"), flags=re.MULTILINE))


def _opening(tokens: list[tokenize.TokenInfo], i: int) -> str | None:
    """The opening text of a one-line string literal at token ``i``, or None for any other token."""
    tok = tokens[i]
    if tok.type == tokenize.STRING:
        quoted = re.match(r"[rbfuRBFU]*('|\")(?!\1\1)", tok.string)
        return tok.string[quoted.end() :] if quoted else None
    if tok.type == FSTRING_MIDDLE and i > 0 and tokens[i - 1].type == FSTRING_START and not tokens[i - 1].string.endswith(("'''", '"""')):
        return tok.string
    return None


def cited_in_python(path: Path, *, messages: bool) -> dict[str, str]:
    """The rule names cited in the prose of ``path``, and with ``messages`` also those that open a one-line string."""
    out: dict[str, str] = {}
    tokens = list(tokenize.generate_tokens(io.StringIO(path.read_text(encoding="utf-8")).readline))
    for i, tok in enumerate(tokens):
        where = f"{path.relative_to(ROOT)}:{tok.start[0]}"
        opening = _opening(tokens, i) if messages else None
        if opening is not None and (m := PREFIX.match(opening)):
            out.setdefault(m.group(1), where)
        if tok.type in (tokenize.STRING, tokenize.COMMENT, FSTRING_MIDDLE):
            for group in CITATION.findall(tok.string):
                for name in re.findall(r"`([a-z][a-z0-9-]*)`", group):
                    out.setdefault(name, where)
    return out


def cited() -> dict[str, str]:
    """Every rule name cited in pytycho, the tests, and the corpus, mapped to one place that cites it."""
    out: dict[str, str] = {}
    for path in sorted((ROOT / "src" / "pytycho").glob("*.py")) + sorted((ROOT / "tests").glob("*.py")):
        out.update({k: v for k, v in cited_in_python(path, messages=True).items() if k not in out})
    for k, v in cited_in_python(CORPUS / "generate.py", messages=False).items():
        out.setdefault(k, v)
    for path in sorted(CORPUS.glob("*/rejections.json")):
        for i, case in enumerate(json.loads(path.read_text(encoding="utf-8"))):
            out.setdefault(case["rule"], f"{path.relative_to(ROOT)}[{i}]")
    return out


def test_every_cited_rule_is_defined_in_the_spec():
    names = defined()
    missing = {name: where for name, where in cited().items() if name not in names}
    assert not missing, f"rules cited but not defined in {SPEC.relative_to(ROOT)}: {missing}"


def test_the_scan_finds_the_rules_of_messages_citations_and_rejections():
    found = cited()
    # a message prefix in pytycho, a citation in a comment of the corpus generator, and a rule of rejections.json
    assert {"identifier", "trail-wrap", "container-version", "input-scope"} <= set(found)
    assert "pytycho" not in found
