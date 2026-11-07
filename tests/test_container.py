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


def test_encoded_views_are_decoded_once_and_read_only_and_raw_views_share_memory():
    w = ContainerWriter()
    w.add_view("smooth", np.linspace(0.0, 1.0, 3000))
    w.add_view("short", np.array([np.pi, np.e]))
    c = Container(w.to_bytes())
    assert c.header["views"]["short"]["encoding"] == "raw"
    assert c.view("smooth") is c.view("smooth")
    assert not c.view("smooth").flags.writeable
    assert not c.view("short").flags.writeable
    assert c.view("short").base is not None
    assert c.stored_size("short") == 16
    assert c.stored_size("smooth") == sum(n for _, n in c.header["views"]["smooth"]["chunks"]) < 24000


def test_empty_encoded_views_are_read():
    header = {
        "format": "tycho-data",
        "version": 1,
        "views": {
            "none": {"dtype": "float64", "shape": [0, 3], "encoding": "shuffle-delta-deflate", "chunk_rows": 4, "chunks": []},
            "thin": {"dtype": "int16", "shape": [3, 0], "encoding": "shuffle-delta-deflate", "chunk_rows": 2, "chunks": [[0, 8], [8, 8]]},
        },
    }
    c = Container(_rebuilt(header, zlib.compress(b"") * 2))
    assert c.view("none").shape == (0, 3)
    assert c.view("thin").shape == (3, 0)


def test_payload_starts_at_a_multiple_of_8():
    data = ContainerWriter(generator="x" * 5).to_bytes()
    (hlen,) = struct.unpack_from("<I", data, 8)
    assert len(data) % 8 == 0
    assert len(data) >= 12 + hlen


def test_named_dtype_casts_and_own_dtype_is_kept():
    w = ContainerWriter()
    w.add_view("f", np.linspace(0, 1, 5), dtype="float32")
    w.add_view("g", np.linspace(0, 1, 5))
    c = Container(w.to_bytes())
    assert c.view("f").dtype == np.float32
    assert c.view("g").dtype == np.float64


@pytest.mark.parametrize("array", [np.arange(3, dtype=np.int64), np.ones(3, dtype=np.float16), np.ones(3, dtype=bool)])
def test_d1_rejects_an_unnamed_foreign_dtype(array):
    with pytest.raises(ContainerError, match="D1"):
        ContainerWriter().add_view("a", array)


def test_d1_rejects_a_lossy_integer_cast():
    with pytest.raises(ContainerError, match="D1"):
        ContainerWriter().add_view("a", np.array([1.5, 2.0]), dtype="int32")
    with pytest.raises(ContainerError, match="D1"):
        ContainerWriter().add_view("a", np.array([-1]), dtype="uint32")


def _one(array=None, **kwargs) -> bytes:
    w = ContainerWriter(**kwargs)
    w.add_view("a", np.zeros(4) if array is None else array)
    return w.to_bytes()


def test_d2_rejects_a_wrong_length_and_a_view_past_the_end():
    data = _one(raw=True)
    with pytest.raises(ContainerError, match="D2"):
        Container(_patched(data, "a", length=24))
    with pytest.raises(ContainerError, match="D2"):
        Container(_patched(data, "a", offset=8))
    with pytest.raises(ContainerError, match="D2"):
        Container(_patched(data, "a", shape=[]))


def test_d2_rejects_a_view_key_an_encoding_and_a_missing_key():
    data = _one(raw=True)
    with pytest.raises(ContainerError, match=r"D2: view 'a' has keys \['filters'\]"):
        Container(_patched(data, "a", filters=["shuffle"]))
    with pytest.raises(ContainerError, match=r"D2: view 'a' has keys \['chunk_rows'\]"):
        Container(_patched(data, "a", chunk_rows=4))
    with pytest.raises(ContainerError, match="D2: view 'a' has encoding 'zstd'"):
        Container(_patched(data, "a", encoding="zstd"))
    header = _header(data)
    del header["views"]["a"]["length"]
    with pytest.raises(ContainerError, match=r"D2: view 'a' lacks the keys \['length'\]"):
        Container(_rebuilt(header, data[_payload_start(data) :]))


@pytest.mark.parametrize("version", [0, 2, 3])
def test_d3_rejects_every_other_version(version):
    data = bytearray(_one())
    data[4:8] = struct.pack("<I", version)
    with pytest.raises(ContainerError, match="D3: data container version"):
        Container(bytes(data))
    header = _header(bytes(data))
    header["version"] = version
    with pytest.raises(ContainerError, match="D3: header version"):
        Container(_rebuilt(header, bytes(data[_payload_start(bytes(data)) :])))


def _encoded(rows: int | None = None) -> bytes:
    w = ContainerWriter()
    w.add_view("a", np.linspace(0.0, 1.0, 600).reshape(200, 3), chunk_rows=rows)
    assert w.views["a"]["encoding"] == "shuffle-delta-deflate"
    return w.to_bytes()


def test_d5_rejects_chunks_that_do_not_match_the_shape_or_run_past_the_end():
    data = _encoded(64)
    chunks = _header(data)["views"]["a"]["chunks"]
    assert len(chunks) == 4
    with pytest.raises(ContainerError, match="D5: view 'a' has chunk_rows 0"):
        Container(_patched(data, "a", chunk_rows=0))
    with pytest.raises(ContainerError, match="D5: view 'a' has 4 chunks, while 200 rows in chunks of 40 take 5"):
        Container(_patched(data, "a", chunk_rows=40))
    with pytest.raises(ContainerError, match="D5: view 'a' has 3 chunks"):
        Container(_patched(data, "a", chunks=chunks[:3]))
    with pytest.raises(ContainerError, match="D5: chunk 3 of view 'a' runs past the end of the file"):
        Container(_patched(data, "a", chunks=[*chunks[:3], [chunks[3][0] + 4096, chunks[3][1]]]))
    with pytest.raises(ContainerError, match="D5: chunk 1 of view 'a' is not an"):
        Container(_patched(data, "a", chunks=[chunks[0], [0], *chunks[2:]]))


def test_d5_rejects_the_wrong_decoded_size():
    data = _encoded(64)
    # under a shape with one column fewer, every chunk inflates to more bytes than its rows take
    container = Container(_patched(data, "a", shape=[200, 2]))
    with pytest.raises(ContainerError, match="D5: chunk 0 of view 'a' inflates to more than the 1024 bytes"):
        container.view("a")
    # under a shape with one column more, every chunk inflates to fewer bytes than its rows take
    with pytest.raises(ContainerError, match="D5: chunk 0 of view 'a' inflates to 1536 bytes, not the 2048"):
        Container(_patched(data, "a", shape=[200, 4])).view("a")


def test_d5_rejects_corrupted_deflate_data_and_bytes_after_the_stream():
    data = _encoded()
    start = _payload_start(data)
    offset, length = _header(data)["views"]["a"]["chunks"][0]
    # flip a byte of the deflate data, and one of the Adler-32 checksum
    for at, why in ((2, ""), (length - 1, "does not inflate: .*incorrect data check")):
        bad = bytearray(data)
        bad[start + offset + at] ^= 0x40
        with pytest.raises(ContainerError, match=f"D5: chunk 0 of view 'a' {why}"):
            Container(bytes(bad)).view("a")
    with pytest.raises(ContainerError, match="D5: chunk 0 of view 'a' ends before its zlib stream does"):
        Container(_patched(data, "a", chunks=[[offset, length - 3]])).view("a")
    assert length % 8 != 0
    padded = bytearray(data)
    padded[start + offset + length] = 7
    with pytest.raises(ContainerError, match="D5: chunk 0 of view 'a' has 1 bytes after its zlib stream"):
        Container(_patched(bytes(padded), "a", chunks=[[offset, length + 1]])).view("a")


def test_rejects_foreign_bytes():
    with pytest.raises(ContainerError):
        Container(b"ASTV" + bytes(16))


def test_header_length_does_not_count_the_padding():
    data = bytearray(ContainerWriter(generator="x" * 6).to_bytes())
    (hlen,) = struct.unpack_from("<I", data, 8)
    assert (12 + hlen) % 8 != 0
    struct.pack_into("<I", data, 8, hlen + (-(12 + hlen)) % 8)
    with pytest.raises(ContainerError, match="is not JSON"):
        Container(bytes(data))
