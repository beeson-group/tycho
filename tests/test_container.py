"""The data container and its rules D1 to D5."""

from __future__ import annotations

import json
import struct
from pathlib import Path

import numpy as np
import pytest

from pytycho.container import CHUNK_BYTES, DTYPES, VERSION, Container, ContainerError, ContainerWriter, _encode_chunk

FIXTURES = Path(__file__).resolve().parents[1] / "spec" / "conformance" / "containers"

# the extremes of every dtype, and for floats the values whose bit patterns a careless decoder changes
SPECIAL = {
    "float32": [np.nan, -0.0, np.inf, -np.inf, 1e-45, 3.4e38],
    "float64": [np.nan, -0.0, np.inf, -np.inf, 5e-324, np.finfo(np.float64).max],
}


def values(dtype: str, shape: tuple[int, ...]) -> np.ndarray:
    """A smooth array of ``shape`` with the dtype's extremes, or its special floats, among its values."""
    n = int(np.prod(shape))
    info = np.iinfo(dtype) if np.dtype(dtype).kind in "iu" else None
    if info is None:
        a = np.sin(np.arange(n) / 5.0).astype(dtype)
        a[: min(n, 6)] = SPECIAL[dtype][: min(n, 6)]
    else:
        a = (np.arange(n) * 37 % (int(info.max) - int(info.min) + 1) + int(info.min)).astype(dtype)
        a[: min(n, 2)] = [info.min, info.max][: min(n, 2)]
    return a.reshape(shape)


def same_bits(a: np.ndarray, b: np.ndarray) -> bool:
    return a.dtype == b.dtype and a.shape == b.shape and a.tobytes() == b.tobytes()


def _header(data: bytes) -> dict:
    (hlen,) = struct.unpack_from("<I", data, 8)
    return json.loads(data[12 : 12 + hlen])


def _payload_start(data: bytes) -> int:
    (hlen,) = struct.unpack_from("<I", data, 8)
    return 12 + hlen + (-(12 + hlen)) % 8


def _rebuilt(header: dict, payload: bytes, version: int = VERSION) -> bytes:
    raw = json.dumps(header).encode()
    head = b"TYCD" + struct.pack("<II", version, len(raw)) + raw
    return head + b"\0" * ((-len(head)) % 8) + payload


def _patched(data: bytes, view: str, **fields) -> bytes:
    header = _header(data)
    header["views"][view].update(fields)
    return _rebuilt(header, data[_payload_start(data) :])


@pytest.mark.parametrize("dtype", list(DTYPES))
@pytest.mark.parametrize(
    ("shape", "chunk_rows"),
    [((40, 3), None), ((40, 3), 41), ((40, 3), 40), ((40, 3), 7), ((90,), 16), ((12, 2, 3), 5), ((1, 3), 1)],
    ids=["default", "shorter-than-a-chunk", "one-chunk", "six-chunks", "flat", "cube", "one-row"],
)
def test_round_trip_of_every_dtype_raw_and_encoded(dtype, shape, chunk_rows):
    a = values(dtype, shape)
    for raw in (False, True):
        w = ContainerWriter(raw=raw)
        w.add_view("a", a, chunk_rows=chunk_rows)
        w.add_view("odd", np.arange(3, dtype=np.uint8))
        c = Container(w.to_bytes())
        assert same_bits(c.view("a"), a)
        np.testing.assert_array_equal(c.view("odd"), np.arange(3))
        info = c.header["views"]["a"]
        assert info["encoding"] == "raw" if raw else info["encoding"] in ("raw", "shuffle-delta-deflate")
        if info["encoding"] == "shuffle-delta-deflate":
            rows = chunk_rows or max(1, CHUNK_BYTES // (a[0].nbytes))
            assert info["chunk_rows"] == rows
            assert len(info["chunks"]) == -(-shape[0] // rows)
        assert c.header["version"] == 1
        assert c.header["format"] == "tycho-data"
        assert all(v["offset"] % 8 == 0 for v in c.header["views"].values() if v["encoding"] == "raw")
