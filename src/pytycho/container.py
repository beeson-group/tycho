"""The TyCHO data container, ``data.tyd``, at format version 2 (rules `array-dtype` to `shuffle-delta-deflate` of ``spec/tycho-scene.md``).

Layout::

    bytes 0..3   magic b"TYCD"
    bytes 4..7   u32 little endian, format version (2)
    bytes 8..11  u32 little endian, byte length of the JSON header
    header       UTF-8 JSON, then zero padding so that the payload starts at a multiple of 8
    payload      bytes of every array in insertion order, each array zero-padded to a multiple of 8

The header is ``{"format": "tycho-data", "version": 2, "generator", "meta", "arrays"}``. An array is
``{"dtype", "shape", "encoding", ...}``, and its encoding determines how its bytes are stored. A
``"raw"`` array also holds ``"offset"`` and ``"length"``, which locate its little-endian bytes in C
order. A ``"shuffle-delta-deflate"`` array also holds ``"chunk_rows"`` and ``"chunks"``, a list of
``[offset, length]`` pairs with one pair per chunk of ``chunk_rows`` rows. The bit patterns of each
chunk are delta-coded along its rows, byte-shuffled, and compressed in the zlib format. Offsets count
from the start of the payload, in bytes. The data container holds only named typed arrays, and their
meaning is given in the scene document, ``scene.tys``.
"""

from __future__ import annotations

import json
import os
import struct
import zlib
from typing import Any

import numpy as np

MAGIC = b"TYCD"
VERSION = 2

#: The stored dtypes of rule `array-dtype`, all little endian.
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
#: The keys of an array under each encoding (rule `array-keys`).
ARRAY_KEYS = {
    RAW: {"dtype", "shape", "encoding", "offset", "length"},
    ENCODED: {"dtype", "shape", "encoding", "chunk_rows", "chunks"},
}
#: The target size in raw bytes of one chunk of an encoded array, from which the writer derives the default ``chunk_rows``.
CHUNK_BYTES = 1 << 20
#: The zlib compression level of the writer. Any level decodes the same.
LEVEL = 6


class ContainerError(ValueError):
    """A data container that breaks one of the rules `array-dtype` to `shuffle-delta-deflate`, or a request that would break one."""


def _pad(n: int) -> int:
    return (-n) % 8


def _is_count(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0


def stored_array(array: Any, dtype: str | None = None) -> np.ndarray:
    """Returns ``array`` as it would be stored, little endian and in C order (rules `array-dtype` and `c-order`).

    With ``dtype`` the caller gives the stored dtype, and the values are cast to it. A cast to
    an integer dtype must leave every value unchanged, since a wrapped or truncated integer is a
    silent change. Without ``dtype`` the dtype of ``array`` is kept, and it must be one of the
    eight of rule `array-dtype`.
    """
    a = np.asarray(array)
    if a.ndim == 0:
        raise ContainerError("c-order: the array is zero-dimensional. Reshape a scalar to shape (1,)")
    if a.dtype.kind == "b" and dtype is not None and np.dtype(dtype).kind in "iu":
        a = a.astype(np.uint8)
    if a.dtype.kind not in "iuf":
        raise ContainerError(f"array-dtype: arrays of kind {a.dtype} are not stored. Use one of {', '.join(DTYPES)}")
    if dtype is None:
        name = a.dtype.name
        if name not in DTYPES:
            raise ContainerError(f"array-dtype: dtype {name} is not one of {', '.join(DTYPES)}. Name the stored dtype to cast it")
    else:
        name = np.dtype(dtype).name
        if name not in DTYPES:
            raise ContainerError(f"array-dtype: dtype {name} is not one of {', '.join(DTYPES)}")
    with np.errstate(invalid="ignore", over="ignore"):
        stored = np.ascontiguousarray(a, dtype=DTYPES[name])
        if stored.dtype.kind in "iu" and a.dtype != stored.dtype:
            if a.dtype.kind == "f" and not np.all(np.isfinite(a)):
                raise ContainerError(f"array-dtype: nonfinite values do not fit {name}")
            if not np.array_equal(stored.astype(np.float64), a.astype(np.float64)):
                raise ContainerError(f"array-dtype: the values change when cast to {name}")
        elif stored.dtype.kind == "f" and not np.array_equal(np.isfinite(stored), np.isfinite(a)):
            raise ContainerError(f"array-dtype: finite values overflow {name}")
    return stored


def _bits(stored: np.ndarray) -> np.ndarray:
    """The bit patterns of a stored array as unsigned little-endian integers, one row per row of the array."""
    rows = stored.shape[0]
    width = int(np.prod(stored.shape[1:], dtype=np.int64))
    return stored.reshape(rows, width).view(f"<u{stored.dtype.itemsize}")


def _encode_chunk(bits: np.ndarray) -> bytes:
    """One chunk of a shuffle-delta-deflate array (rule `shuffle-delta-deflate`), from its rows of bit patterns."""
    delta = bits.copy()
    np.subtract(bits[1:], bits[:-1], out=delta[1:])  # the subtraction wraps around, since the integers are unsigned
    shuffled = delta.reshape(-1).view(np.uint8).reshape(-1, bits.dtype.itemsize).T
    return zlib.compress(shuffled.tobytes(), LEVEL)


def _decode_chunk(chunk: bytes | memoryview, rows: int, width: int, out: np.ndarray, where: str) -> None:
    """Decodes one chunk of ``rows`` rows of ``width`` elements into ``out``, its rows of bit patterns (rule `shuffle-delta-deflate`)."""
    size = out.dtype.itemsize
    expected = rows * width * size
    inflater = zlib.decompressobj()
    try:
        raw = inflater.decompress(chunk, expected + 1)
    except zlib.error as exc:
        raise ContainerError(f"shuffle-delta-deflate: {where} does not inflate: {exc}") from None
    if len(raw) > expected:
        raise ContainerError(f"shuffle-delta-deflate: {where} inflates to more than the {expected} bytes of its rows")
    if not inflater.eof:
        raise ContainerError(f"shuffle-delta-deflate: {where} ends before its zlib stream does")
    if inflater.unused_data:
        raise ContainerError(f"shuffle-delta-deflate: {where} has {len(inflater.unused_data)} bytes after its zlib stream")
    if len(raw) != expected:
        raise ContainerError(f"shuffle-delta-deflate: {where} inflates to {len(raw)} bytes, not the {expected} of its rows")
    planes = np.frombuffer(raw, np.uint8).reshape(size, rows * width)
    delta = np.ascontiguousarray(planes.T).view(out.dtype).reshape(rows, width)
    np.cumsum(delta, axis=0, dtype=out.dtype, out=out)  # the integers are unsigned, hence the cumulative sum wraps around


class ContainerWriter:
    """Accumulates named typed arrays, then serializes them as a version 2 container.

    Each array is stored shuffle-delta-deflate, or raw when its encoded bytes are not fewer than
    its raw bytes. ``raw=True`` stores every array raw, for tests and debugging.
    """

    def __init__(self, generator: str = "pytycho", meta: dict[str, Any] | None = None, *, raw: bool = False) -> None:
        if not isinstance(generator, str):
            raise ContainerError(f"container: the generator is {generator!r}, not a string")
        if meta is not None and not isinstance(meta, dict):
            raise ContainerError(f"container: meta is {meta!r}, not a dict")
        self.generator = generator
        self.meta: dict[str, Any] = dict(meta or {})
        self.raw = raw
        self._arrays: dict[str, dict[str, Any]] = {}
        self._parts: list[bytes] = []
        self._offset = 0

    @property
    def arrays(self) -> dict[str, dict[str, Any]]:
        """The array records written so far, by name."""
        return self._arrays

    def add_array(self, name: str, array: Any, dtype: str | None = None, *, chunk_rows: int | None = None) -> str:
        """Stores ``array`` under ``name``, and returns the name.

        ``dtype`` is the stored dtype. Without it the dtype of ``array`` is kept (rule `array-dtype`).
        ``chunk_rows`` is the number of rows in a chunk of an encoded array. The default chunk
        holds about 1 MiB of the array's raw bytes, and at least one row.
        """
        if not isinstance(name, str) or not name:
            raise ContainerError(f"container: the array name {name!r} is not a nonempty string")
        if name in self._arrays:
            raise ContainerError(f"container: array {name!r} already exists")
        if chunk_rows is not None and (not _is_count(chunk_rows) or chunk_rows < 1):
            raise ContainerError(f"shuffle-delta-deflate: chunk_rows is a positive integer, not {chunk_rows!r}")
        given = np.asarray(array).dtype.name
        stored = stored_array(array, dtype)
        record: dict[str, Any] = {"dtype": stored.dtype.name, "shape": [int(n) for n in stored.shape]}
        raw = stored.tobytes(order="C")
        chunks: list[bytes] | None = None
        if not self.raw and raw:
            bits = _bits(stored)
            if chunk_rows is None:
                chunk_rows = max(1, CHUNK_BYTES // max(1, bits.shape[1] * stored.dtype.itemsize))
            chunks = [_encode_chunk(bits[a : a + chunk_rows]) for a in range(0, bits.shape[0], chunk_rows)]
            if sum(map(len, chunks)) >= len(raw):
                chunks = None
        if chunks is None:
            record.update(encoding=RAW, offset=self._offset, length=len(raw))
            data = raw
        else:
            spans, at = [], self._offset
            for c in chunks:
                spans.append([at, len(c)])
                at += len(c)
            record.update(encoding=ENCODED, chunk_rows=chunk_rows, chunks=spans)
            data = b"".join(chunks)
        self._arrays[name] = record
        if stored.dtype.name != given:
            # record the cast that the writer made, so that a reader can tell a float32 store from float32 data
            self.meta.setdefault("casts", {})[name] = given
        padded = data + b"\0" * _pad(len(data))
        self._parts.append(padded)
        self._offset += len(padded)
        return name

    def header(self) -> dict[str, Any]:
        """The JSON header, as a dict."""
        return {
            "format": "tycho-data",
            "version": VERSION,
            "generator": self.generator,
            "meta": self.meta,
            "arrays": self._arrays,
        }

    def to_bytes(self) -> bytes:
        """The whole data container, as bytes."""
        try:
            header = json.dumps(self.header(), separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")
        except ValueError as exc:
            raise ContainerError(f"container: meta holds a NaN or an infinity, which the JSON header cannot encode: {exc}") from None
        head = MAGIC + struct.pack("<II", VERSION, len(header)) + header
        head += b"\0" * _pad(len(head))
        return head + b"".join(self._parts)

    def write(self, path: str | os.PathLike[str]) -> None:
        """Writes the container to ``path``."""
        with open(path, "wb") as fh:
            fh.write(self.to_bytes())


class Container:
    """The read side of a version 2 container.

    The constructor checks the record of every array, and raises :class:`~pytycho.container.ContainerError` on a version
    other than 2 (rule `container-version`). It also raises on an array with a key or an encoding that version 2 does not
    define, or whose bytes run past the end of the file (rule `array-keys`). The same holds for an encoded array whose chunks
    do not match its shape (rule `shuffle-delta-deflate`).
    A raw array is read without a copy. An encoded array is decoded on its first access and then cached, and a chunk that
    inflates to more or fewer bytes than its rows take is rejected on this access (rule `shuffle-delta-deflate`).
    """

    def __init__(self, data: bytes) -> None:
        data = bytes(data)
        if len(data) < 12 or data[:4] != MAGIC:
            raise ContainerError(
                "container: the bytes are not a TyCHO data container, since they lack the 12-byte preamble that starts with the "
                'magic "TYCD"'
            )
        version, hlen = struct.unpack_from("<II", data, 4)
        if version != VERSION:
            raise ContainerError(
                f"container-version: data container version {version} is not supported, since this reader reads only version {VERSION}"
            )
        if 12 + hlen > len(data):
            raise ContainerError(f"container: the header length {hlen} runs past the end of the file")

        def constant(name: str) -> Any:
            raise ValueError(f"container: {name} is not JSON")

        try:
            self.header: dict[str, Any] = json.loads(data[12 : 12 + hlen].decode("utf-8"), parse_constant=constant)
        except (UnicodeDecodeError, ValueError) as exc:
            raise ContainerError(f"container: the header is not JSON: {exc}") from None
        if not isinstance(self.header, dict) or self.header.get("format") != "tycho-data":
            raise ContainerError('container: the header format is not "tycho-data"')
        if self.header.get("version") != VERSION:
            raise ContainerError(
                f"container-version: header version {self.header.get('version')!r} is not supported, since this reader reads only "
                f"version {VERSION}"
            )
        if not isinstance(self.header.get("generator", ""), str):
            raise ContainerError("container: the header generator is not a string")
        if not isinstance(self.header.get("meta", {}), dict):
            raise ContainerError("container: the header meta is not an object")
        arrays = self.header.get("arrays")
        if not isinstance(arrays, dict):
            raise ContainerError('container: the header lacks an "arrays" object')
        payload_start = 12 + hlen + _pad(12 + hlen)
        self._payload = memoryview(data)[payload_start:]
        self._decoded: dict[str, np.ndarray] = {}
        for name, info in arrays.items():
            self._check(name, info)

    def _check(self, name: str, info: Any) -> None:
        if not isinstance(info, dict):
            raise ContainerError(f"container: array {name!r} is not an object")
        encoding = info.get("encoding")
        if encoding not in ARRAY_KEYS:
            raise ContainerError(f"array-keys: array {name!r} has encoding {encoding!r}, which this reader does not know")
        keys = ARRAY_KEYS[encoding]
        if extra := set(info) - keys:
            raise ContainerError(f"array-keys: array {name!r} has keys {sorted(extra)} that this reader does not know")
        if missing := keys - set(info):
            raise ContainerError(f"array-keys: array {name!r} lacks the keys {sorted(missing)}")
        dtype, shape = info["dtype"], info["shape"]
        if not isinstance(dtype, str) or dtype not in DTYPES:
            raise ContainerError(f"array-dtype: array {name!r} has dtype {dtype!r}, not one of {', '.join(DTYPES)}")
        if not isinstance(shape, list) or not shape or not all(map(_is_count, shape)):
            raise ContainerError(f"array-keys: array {name!r} has shape {shape!r}, not a nonempty list of counts")
        size = np.dtype(DTYPES[dtype]).itemsize
        nbytes = size
        for n in shape:
            nbytes *= n
        if encoding == RAW:
            offset, length = info["offset"], info["length"]
            if not _is_count(offset) or not _is_count(length):
                raise ContainerError(f"array-keys: array {name!r} has an offset or a length that is not a count")
            if offset % 8 != 0:
                raise ContainerError(f"array-keys: array {name!r} starts at byte {offset}, which is not a multiple of 8")
            if length != nbytes:
                raise ContainerError(f"array-keys: array {name!r} has length {length}, while shape {shape} of {dtype} takes {nbytes} bytes")
            if offset + length > len(self._payload):
                raise ContainerError(f"array-keys: array {name!r} runs past the end of the file")
            return
        rows, chunks = info["chunk_rows"], info["chunks"]
        if not _is_count(rows) or rows < 1:
            raise ContainerError(f"shuffle-delta-deflate: array {name!r} has chunk_rows {rows!r}, not a positive integer")
        if not isinstance(chunks, list):
            raise ContainerError(f"shuffle-delta-deflate: array {name!r} has chunks that are not a list")
        if len(chunks) != (count := -(-shape[0] // rows)):
            raise ContainerError(
                f"shuffle-delta-deflate: array {name!r} has {len(chunks)} chunks, while {shape[0]} rows in chunks of {rows} take {count}"
            )
        for k, span in enumerate(chunks):
            if not isinstance(span, list) or len(span) != 2 or not all(map(_is_count, span)):
                raise ContainerError(f"shuffle-delta-deflate: chunk {k} of array {name!r} is not an [offset, length] pair of counts")
            if span[0] + span[1] > len(self._payload):
                raise ContainerError(f"shuffle-delta-deflate: chunk {k} of array {name!r} runs past the end of the file")

    @property
    def meta(self) -> dict[str, Any]:
        """The header's ``meta`` object."""
        return self.header.get("meta", {})

    @property
    def names(self) -> list[str]:
        """The array names, in insertion order."""
        return list(self.header["arrays"])

    def _info(self, name: str) -> dict[str, Any]:
        try:
            return self.header["arrays"][name]
        except KeyError:
            raise KeyError(f"the data container lacks array {name!r}") from None

    def stored_size(self, name: str) -> int:
        """The number of bytes that the named array takes in the file, without its padding."""
        info = self._info(name)
        return info["length"] if info["encoding"] == RAW else sum(length for _, length in info["chunks"])

    def array(self, name: str) -> np.ndarray:
        """The named array, as a read-only array. A raw array shares the container's memory."""
        info = self._info(name)
        dtype = DTYPES[info["dtype"]]
        if info["encoding"] == RAW:
            buf = self._payload[info["offset"] : info["offset"] + info["length"]]
            return np.frombuffer(buf, dtype=dtype).reshape(info["shape"])
        if name not in self._decoded:
            shape = info["shape"]
            out = np.empty(shape, dtype=dtype)
            bits = _bits(out)
            rows = info["chunk_rows"]
            for k, (offset, length) in enumerate(info["chunks"]):
                block = bits[k * rows : (k + 1) * rows]
                _decode_chunk(self._payload[offset : offset + length], block.shape[0], bits.shape[1], block, f"chunk {k} of array {name!r}")
            out.flags.writeable = False
            self._decoded[name] = out
        return self._decoded[name]

    @classmethod
    def read(cls, path: str | os.PathLike[str]) -> Container:
        """Reads the container at ``path``."""
        with open(path, "rb") as fh:
            return cls(fh.read())
