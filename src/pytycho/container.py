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
