"""The data container and its rules D1 to D5."""

from __future__ import annotations

import json
import struct
import zlib
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


@pytest.mark.parametrize("dtype", list(DTYPES))
def test_every_dtype_decodes_bit_for_bit_through_the_encoding(dtype):
    a = values(dtype, (30, 4))
    stored = a.reshape(30, 4).view(f"<u{a.dtype.itemsize}")
    for rows in (30, 31, 4):
        chunks = [_encode_chunk(stored[r : r + rows]) for r in range(0, 30, rows)]
        spans, at = [], 0
        for chunk in chunks:
            spans.append([at, len(chunk)])
            at += len(chunk)
        header = {
            "format": "tycho-data",
            "version": 1,
            "views": {"a": {"dtype": dtype, "shape": [30, 4], "encoding": "shuffle-delta-deflate", "chunk_rows": rows, "chunks": spans}},
        }
        assert same_bits(Container(_rebuilt(header, b"".join(chunks))).view("a"), a)


def test_the_delta_wraps_and_the_shuffle_groups_bytes():
    bits = np.array([[1, 0xFFFFFFFF], [0, 0], [0xFFFFFFFF, 1]], dtype="<u4")
    raw = zlib.decompress(_encode_chunk(bits))
    delta = np.array([[1, 0xFFFFFFFF], [0xFFFFFFFF, 1], [0xFFFFFFFF, 1]], dtype="<u4")
    assert raw == delta.reshape(-1).view(np.uint8).reshape(-1, 4).T.tobytes()
    assert raw[:6] == bytes([1, 0xFF, 0xFF, 1, 0xFF, 1])  # the first byte of each of the six values


def test_the_writer_picks_the_smaller_encoding_and_raw_on_request():
    rng = np.random.default_rng(0)
    w = ContainerWriter()
    w.add_view("smooth", np.linspace(0.0, 1.0, 3000).reshape(1000, 3))
    w.add_view("noise", rng.integers(0, 256, 4000), dtype="uint8")
    w.add_view("empty", np.zeros((0, 3)))
    w.add_view("thin", np.zeros((4, 0), np.float32))
    kinds = {name: v["encoding"] for name, v in w.views.items()}
    assert kinds == {"smooth": "shuffle-delta-deflate", "noise": "raw", "empty": "raw", "thin": "raw"}
    forced = ContainerWriter(raw=True)
    forced.add_view("smooth", np.linspace(0.0, 1.0, 3000).reshape(1000, 3))
    assert forced.views["smooth"]["encoding"] == "raw"
    assert len(forced.to_bytes()) > len(w.to_bytes())


def test_the_default_chunk_holds_about_one_mebibyte():
    a = np.cumsum(np.ones((100_000, 3)), axis=0)
    w = ContainerWriter()
    w.add_view("a", a)
    info = w.views["a"]
    assert info["chunk_rows"] == (1 << 20) // 24
    assert len(info["chunks"]) == 3
    spans = info["chunks"]
    assert all(spans[k][0] + spans[k][1] == spans[k + 1][0] for k in range(len(spans) - 1))
    np.testing.assert_array_equal(Container(w.to_bytes()).view("a"), a)
    with pytest.raises(ContainerError, match="D5: chunk_rows"):
        w.add_view("b", a, chunk_rows=0)
