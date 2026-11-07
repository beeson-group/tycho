"""The TyCHO data container, ``data.tyd``, at format version 1 (rules D1 to D5 of ``spec/tycho-scene.md``).

Layout::

    bytes 0..3   magic b"TYCD"
    bytes 4..7   u32 little endian, format version (1)
    bytes 8..11  u32 little endian, byte length of the JSON header
    header       UTF-8 JSON, then zero padding so that the payload starts at a multiple of 8
    payload      bytes of every view in insertion order, each view zero-padded to a multiple of 8

The header is ``{"format": "tycho-data", "version": 1, "generator", "meta", "views"}``. A view is
``{"dtype", "shape", "encoding", ...}``, and its encoding determines how its bytes are stored. A
``"raw"`` view also holds ``"offset"`` and ``"length"``, which locate its little-endian bytes in C
order. A ``"shuffle-delta-deflate"`` view also holds ``"chunk_rows"`` and ``"chunks"``, a list of
``[offset, length]`` pairs with one pair per chunk of ``chunk_rows`` rows. The bit patterns of each
chunk are delta-coded along its rows, byte-shuffled, and compressed in the zlib format. Offsets count
from the start of the payload, in bytes. The data container holds only named typed arrays, and their
meaning is given in the scene document, ``scene.tys``.
"""

from __future__ import annotations

import zlib
from typing import Any

import numpy as np

MAGIC = b"TYCD"
VERSION = 1

#: The stored dtypes of rule D1, all little endian.
DTYPES = {
    "int8": "<i1",
    "uint8": "<u1",
    "int16": "<i2",
    "uint16": "<u2",
    "int32": "<i4",
    "uint32": "<u4",
    "float32": "<f4",
    "float64": "<f8",
}

RAW = "raw"
ENCODED = "shuffle-delta-deflate"
#: The keys of a view under each encoding (rule D2).
VIEW_KEYS = {
    RAW: {"dtype", "shape", "encoding", "offset", "length"},
    ENCODED: {"dtype", "shape", "encoding", "chunk_rows", "chunks"},
}
#: The target size in raw bytes of one chunk of an encoded view, from which the writer derives the default ``chunk_rows``.
CHUNK_BYTES = 1 << 20
#: The zlib compression level of the writer. Any level decodes the same.
LEVEL = 6


class ContainerError(ValueError):
    """A data container that breaks one of the rules D1 to D5, or a request that would break one."""


def _pad(n: int) -> int:
    return (-n) % 8


def _is_count(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0


def stored_array(array: Any, dtype: str | None = None) -> np.ndarray:
    """Returns ``array`` as it would be stored, little endian and in C order (rules D1 and D4).

    With ``dtype`` the caller gives the stored dtype, and the values are cast to it. A cast to
    an integer dtype must leave every value unchanged, since a wrapped or truncated integer is a
    silent change. Without ``dtype`` the dtype of ``array`` is kept, and it must be one of the
    eight of rule D1.
    """
    a = np.asarray(array)
    if a.ndim == 0:
        raise ContainerError("D4: the array is zero-dimensional. Reshape a scalar to shape (1,)")
    if a.dtype.kind == "b" and dtype is not None and np.dtype(dtype).kind in "iu":
        a = a.astype(np.uint8)
    if a.dtype.kind not in "iuf":
        raise ContainerError(f"D1: arrays of kind {a.dtype} are not stored. Use one of {', '.join(DTYPES)}")
    if dtype is None:
        name = a.dtype.name
        if name not in DTYPES:
            raise ContainerError(f"D1: dtype {name} is not one of {', '.join(DTYPES)}. Name the stored dtype to cast it")
    else:
        name = np.dtype(dtype).name
        if name not in DTYPES:
            raise ContainerError(f"D1: dtype {name} is not one of {', '.join(DTYPES)}")
    with np.errstate(invalid="ignore", over="ignore"):
        stored = np.ascontiguousarray(a, dtype=DTYPES[name])
        if stored.dtype.kind in "iu" and a.dtype != stored.dtype:
            if a.dtype.kind == "f" and not np.all(np.isfinite(a)):
                raise ContainerError(f"D1: nonfinite values do not fit {name}")
            if not np.array_equal(stored.astype(np.float64), a.astype(np.float64)):
                raise ContainerError(f"D1: the values change when cast to {name}")
        elif stored.dtype.kind == "f" and not np.array_equal(np.isfinite(stored), np.isfinite(a)):
            raise ContainerError(f"D1: finite values overflow {name}")
    return stored


def _bits(stored: np.ndarray) -> np.ndarray:
    """The bit patterns of a stored array as unsigned little-endian integers, one row per row of the view."""
    rows = stored.shape[0]
    width = int(np.prod(stored.shape[1:], dtype=np.int64))
    return stored.reshape(rows, width).view(f"<u{stored.dtype.itemsize}")


def _encode_chunk(bits: np.ndarray) -> bytes:
    """One chunk of a shuffle-delta-deflate view (rule D5), from its rows of bit patterns."""
    delta = bits.copy()
    np.subtract(bits[1:], bits[:-1], out=delta[1:])  # the subtraction wraps around, since the integers are unsigned
    shuffled = delta.reshape(-1).view(np.uint8).reshape(-1, bits.dtype.itemsize).T
    return zlib.compress(shuffled.tobytes(), LEVEL)


def _decode_chunk(chunk: bytes | memoryview, rows: int, width: int, out: np.ndarray, where: str) -> None:
    """Decodes one chunk of ``rows`` rows of ``width`` elements into ``out``, its rows of bit patterns (rule D5)."""
    size = out.dtype.itemsize
    expected = rows * width * size
    inflater = zlib.decompressobj()
    try:
        raw = inflater.decompress(chunk, expected + 1)
    except zlib.error as exc:
        raise ContainerError(f"D5: {where} does not inflate: {exc}") from None
    if len(raw) > expected:
        raise ContainerError(f"D5: {where} inflates to more than the {expected} bytes of its rows")
    if not inflater.eof:
        raise ContainerError(f"D5: {where} ends before its zlib stream does")
    if inflater.unused_data:
        raise ContainerError(f"D5: {where} has {len(inflater.unused_data)} bytes after its zlib stream")
    if len(raw) != expected:
        raise ContainerError(f"D5: {where} inflates to {len(raw)} bytes, not the {expected} of its rows")
    planes = np.frombuffer(raw, np.uint8).reshape(size, rows * width)
    delta = np.ascontiguousarray(planes.T).view(out.dtype).reshape(rows, width)
    np.cumsum(delta, axis=0, dtype=out.dtype, out=out)  # the integers are unsigned, hence the cumulative sum wraps around
