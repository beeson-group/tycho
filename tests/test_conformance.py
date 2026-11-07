"""Every case of the conformance corpus, ``spec/conformance/*/cases.json``, through the NumPy evaluator."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from pytycho._evaluate import evaluate
from pytycho.container import Container

CORPUS = Path(__file__).resolve().parents[1] / "spec" / "conformance"


def _cases():
    for path in sorted(CORPUS.glob("*/cases.json")):
        for i, case in enumerate(json.loads(path.read_text())):
            yield pytest.param(path.parent, case, id=f"{path.parent.name}[{i}] {case['name']}")


def compare(actual, expected, tol, where="$"):
    """Compares numbers within ``tol`` and the rest for equality, skipping a null layer, a missing panel, and a panel's missing layers."""
    if isinstance(expected, bool) or expected is None or isinstance(expected, str):
        assert actual == expected, f"{where}: {actual!r} != {expected!r}"
    elif isinstance(expected, (int, float)):
        assert isinstance(actual, (int, float)), f"{where}: {actual!r} is not a number"
        assert not isinstance(actual, bool), f"{where}: {actual!r} is not a number"
        assert abs(actual - expected) <= tol, f"{where}: {actual!r} differs from {expected!r} by more than {tol}"
    elif isinstance(expected, list):
        assert isinstance(actual, list), f"{where}: {actual!r} is not a list"
        assert len(actual) == len(expected), f"{where}: lengths {len(actual)} != {len(expected)}"
        for i, (a, e) in enumerate(zip(actual, expected, strict=True)):
            if where.endswith(".layers") and e is None:
                continue
            compare(a, e, tol, f"{where}[{i}]")
    else:
        assert isinstance(actual, dict), f"{where}: {actual!r} is not an object"
        if where == "$.panels":
            assert set(expected) <= set(actual), f"{where}: missing panels {set(expected) - set(actual)}"
        elif where.startswith("$.panels.") and where.count(".") == 2:
            assert set(expected) <= set(actual), f"{where}: keys {sorted(actual)} != {sorted(expected)}"
            assert set(actual) <= {"frame", "layers"}, f"{where}: keys {sorted(actual)} != {sorted(expected)}"
        else:
            assert set(actual) == set(expected), f"{where}: keys {sorted(actual)} != {sorted(expected)}"
        for k, e in expected.items():
            compare(actual[k], e, tol, f"{where}.{k}")


@pytest.mark.parametrize(("directory", "case"), list(_cases()))
def test_case(directory, case):
    document = json.loads((directory / "scene.tys").read_text())
    container = Container.read(directory / "data.tyd")
    actual = evaluate(document, container, case["state"], case["frame_index"])
    compare(actual, case["expected"], case["tolerance"])
