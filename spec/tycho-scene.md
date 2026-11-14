# The TyCHO scene format

This file is the contract between `pytycho`, which writes a scene, and the browser runtime, which reads it.
The contract has three parts:

1. the structure in `scene.schema.json`,
2. the named rules in this file, and
3. the conformance corpus in `conformance/`, which both the Python package and the runtime run.

The meaning, type, and default of each key are given by the `description` of the key in `scene.schema.json`, and the reference page of the docs is generated from it.
This file holds what the schema cannot state, i.e. the layout of the data container, the mathematics of the evaluator, and the conditions that tie a key to another key or to the data.
Where two conflicting readings of a rule are possible, the corpus is taken as right, and the rule is then reworded to match it.

Each rule is a bullet that opens with its name in backticks, and an error of the code and a case of the corpus cite a rule by this name.
Each section that a reader checks as a whole also has a rule named after the section, under which the reader rejects what the other rules of the section do not cover.

A scene is split between `data.tyd`, the data container, in which the raw data is stored as named, typed arrays, and `scene.tys`, the scene document, a JSON file in which what is drawn from these arrays, and how, is described.
How the runtime draws a scene on the page is not part of the format.

## 1. The data container, `data.tyd`

The data container is at version 2, and a reader rejects every other version (rule `container-version`).

```
bytes 0..3    magic word "TYCD", i.e. the ASCII bytes for the letters T, Y, C, D
bytes 4..7    u32 little endian, which stores the container's format version (02 00 00 00 for version 2)
bytes 8..11   u32 little endian, byte length of the JSON header, not counting its padding
header        UTF-8 encoded JSON (with no "EF BB BF" byte order mark preceding the JSON), then padded with zero bytes up to the payload
payload       the actual data, starting at a byte number which is the smallest multiple of 8, that is at least 12 plus the header length
```

The header is one JSON object, `{"format": "tycho-data", "version": 2, "generator": string, "meta": object, "arrays": {name: array}}`.
The key `format` is always the string `"tycho-data"`, and `version` repeats the container version of the preamble.
The key `generator` is free text that names the program that wrote the file, and `meta` is an object of extra information about the file.
Both `generator` and `meta` are optional.
The one entry of `meta` that the format defines is `meta.casts`, which maps the name of an array to the dtype, i.e. the element type, that the array had before the writer cast it to the dtype that is stored (rule `array-dtype`).

The key `arrays` maps the name of each stored array to its entry, `{"dtype": string, "shape": [int, ...], "encoding": string, ...}`.
In an entry, `dtype` is the element type of the array, `shape` is its size along each axis, and `encoding` names how the bytes of the array are stored in the payload.
The encoding also determines which further keys the entry has.

- An array with the encoding `"raw"` also has the keys `"offset": int, "length": int`.
  The bytes of a raw array are stored as they are in memory, little endian, from byte `offset` of the payload and for `length` bytes.
  A reader can use these bytes in place, i.e. point a typed array at them without copying them.
- An array with the encoding `"shuffle-delta-deflate"` also has the keys `"chunk_rows": int, "chunks": [[offset, length], ...]`.
  The array is cut along its first axis into chunks of `chunk_rows` rows each, and each chunk is stored as one zlib stream of `length` bytes from byte `offset` of the payload (rule `shuffle-delta-deflate`).
  The list `chunks` gives one `[offset, length]` pair per chunk, in order.
  Each chunk is decoded independently of the others, hence a reader can decode some rows of the array without decoding the rest.

Offsets and lengths are in bytes, and offsets count from the start of the payload, not from the start of the file.
A writer stores the arrays in the order in which they were added, and stores the chunks of an array one after another.
It pads the bytes of each array with zeros to a multiple of 8, so that every raw array starts at a byte offset that is a multiple of 8.
This alignment lets a reader use a raw array in place, because a typed array of 8-byte elements (`float64`) must start at a multiple of 8.
A reader never reads the padding bytes.

The rules for the data container follow.

- `container`. A reader rejects a file that lacks the 12-byte preamble with the magic word `TYCD`, whose header runs past the end of the file or is not a JSON object with the `format` `"tycho-data"`, or whose `generator`, `meta`, `arrays`, or entry of `arrays` is not of the type given above.
- `array-dtype`. The dtypes are `int8`, `uint8`, `int16`, `uint16`, `int32`, `uint32`, `float32`, and `float64`, where the number is the width of one element in bits, the prefix `u` marks an unsigned integer, and `float` marks an IEEE 754 floating-point number.
  Every dtype wider than one byte is little endian.
  A writer never changes a dtype without reporting it.
  The stored dtype is either the dtype that the caller gives when adding the array or, when the caller does not give one, the dtype of the array itself, and a writer raises an error for any other dtype.
  An array whose dtype is not in the list is thus refused, unless the caller gives a dtype from the list to cast it to.
  A cast that the caller gives is recorded in `meta.casts`, so that a reader can tell what the original dtype was.
  Since the header is JSON, every number in it is finite.
- `array-keys`. An entry of `arrays` has the keys `dtype`, `shape`, and `encoding`, plus the further keys of its encoding, and it does not have any other key.
  A reader rejects an entry with an unknown key, a missing key, or an unknown encoding, since a key or an encoding added in a later version may change how the bytes have to be read.
  The `shape` of an array has at least one entry, and an array with a zero in its shape is allowed and is empty.
  In a raw array, `length` must equal the product of the entries of `shape` times the item size, computed without rounding, and `offset` must be a multiple of 8.
  A reader rejects a raw array for which either condition does not hold, or whose bytes run past the end of the file.
- `container-version`. A reader rejects a container of any version but 2.
  Any change to how the bytes of an array are stored, such as a new encoding, changes the container version, since an older reader could not read such a file correctly.
- `c-order`. Arrays are stored in C order (i.e. row-major order), in which the last index varies fastest.
  For an array of shape `(S, 3)`, the bytes hold the three coordinates of row 0, then the three coordinates of row 1, and so on.
- `shuffle-delta-deflate`. This rule defines the `shuffle-delta-deflate` encoding.
  Consider an array of `n` rows, i.e. `n` is the first entry of its shape.
  Let `w` be the number of elements in one row, which is the product of the other entries of the shape (and 1 for a one-dimensional array).
  Let `s` be the item size in bytes, and let `r` be `chunk_rows`, a positive integer, the number of rows of every chunk but the last.
  The array has `ceil(n / r)` chunks, and zero chunks when `n` is 0.
  Chunk `k`, counted from 0, holds the rows from `k * r` up to but not including `min((k + 1) * r, n)`.
  A chunk of `m` rows is encoded in four steps.
  1. Its `m * w` elements, taken in C order, are read as unsigned little endian integers of `s` bytes each.
     A float is read as the integer with the same bit pattern, not converted by value, so that NaN payloads, signed zeros, and subnormal numbers survive the round trip bit for bit.
     The integer at row `i` and column `j` is written `u[i][j]`.
  2. In the delta step, each row is replaced by its difference from the row before it.
     The first row stays as it is, `d[0][j] = u[0][j]`, and for `i` from 1 on, `d[i][j] = (u[i][j] - u[i-1][j]) mod 2^(8s)`.
     Along a smooth trajectory consecutive rows are close, hence the deltas are small numbers with many zero bytes.
  3. In the shuffle step, the bytes of the deltas are reordered so that the bytes of the same significance in each of the `m * w` elements are next to each other.
     Let `b[e*s + q]` be byte `q` of element `e` of `d`, with the elements in C order and the bytes of each element in little endian order.
     The shuffled bytes are `t[q*m*w + e] = b[e*s + q]`, i.e. first the first byte of every element, then the second byte of every element, and so on up to the last byte.
  4. The shuffled bytes `t` are compressed, at any compression level, as one zlib stream in the format that the browser's `DecompressionStream('deflate')` reads.
     This format, defined in RFC 1950, is the deflate algorithm with a two-byte zlib header in front and the Adler-32 checksum of `t` appended, without a preset dictionary.

  Decoding reverses the four steps: the stream is inflated, the shuffle is undone, and the deltas are summed down each column modulo `2^(8s)`, which gives back every bit of the original elements.
  A reader rejects an array whose `chunk_rows` is not a positive integer, whose `chunks` is not a list of `[offset, length]` pairs of nonnegative integers, or whose `chunks` holds a number of chunks other than `ceil(n / r)`.
  It also rejects an array with a chunk that runs past the end of the file.
  It rejects a chunk that does not inflate, whose checksum does not match, that has bytes left after its stream ends, or that inflates to a number of bytes other than `m * w * s`.
  A writer may store any array raw instead.
  pytycho stores an array shuffle-delta-deflate, in chunks of about 1 MiB of raw bytes and at least one row each, unless the encoded array would not be smaller than the raw array, in which case it stores the array raw.

## 2. The scene document, `scene.tys`

The scene document is the JSON file in which what is drawn from the arrays of the data container, and how, is described.
A writer never writes a key that is not in the schema.
When `scene.tys` is read, a reader warns about a key that it does not know and ignores it, at every level of the document, so that a reader still draws the parts of a scene that it implements.

The rules of this section apply to the scene document only, and not to the data container, which is read by `web/src/container.ts` and `src/pytycho/container.py`.
The validator is the code that checks `scene.tys` against the schema and the rules below, before any part of the scene is evaluated or drawn, i.e. `web/src/validate.ts` in the runtime.
`pytycho` does not load a `scene.tys`, and of the rules of this section its evaluator `src/pytycho/_evaluate.py` checks only `finite-number`, the reserved name `@index` of rule `identifier`, and the layer kinds of rule `version`.
The renderer is the code that draws the page, i.e. the `<tycho-viewer>` element and `web/src/runtime/`.

The rules for the scene document as a whole follow.

- `scene`. A reader rejects a document that is not a JSON object, or that lacks one of the required keys `format`, `version`, `frames`, `trajectory_sets`, `clock`, `panels`, and `initial`.
- `version`. The `version` of a scene is a string `"major.minor"`, e.g. `"0.5"`.
  Before version 1.0, a key, a value, or a feature may be renamed or removed from one minor version to the next, without an alias for the old name, and a scene of an older minor version is therefore rejected by the rules on the renamed keys and values.
  From version 1.0 on, a minor version only adds to the format, i.e. what an earlier minor version defined is never changed or removed.
  The validator rejects a scene of another major version or of a newer minor version.
  The validator also rejects a scene whose `requires` lists a feature that it does not implement.
  When a scene has both faults, both are reported in one message.
  A layer kind, a control kind, or a feature of section 4 that is not implemented causes rejection, whether or not `requires` lists the feature.
- `plain-text`. Every string in a scene (i.e. a title, a label, or a part of a readout) is plain Unicode text.
  A string is written into the page only as DOM text nodes or canvas text, never as HTML, hence a string cannot inject markup or script into the page.
  The format does not have any markup, i.e. HTML, Markdown, or LaTeX in a string is not interpreted.
- `identifier`. Identifiers (the keys of `frames`, `bodies`, `trajectory_sets`, `inputs`, and `panels`, the ids of the shown panels, and the ids of the steps) match the regular expression `[A-Za-z0-9_.-]+` as a whole.
  The name `@index` is reserved for the built-in channel and the built-in parameter of rule `index-channel`, and a trajectory set may not declare a channel or a parameter of this name.
- `finite-number`. Every number in `scene.tys` is finite.
  NaN (not a number) and infinity are refused when a scene is written, and a document that contains them is rejected by the validator.
  JSON itself cannot represent them, but some JSON writers emit them as nonstandard tokens.

### 2.1 Trajectory sets

A trajectory is a sequence of samples, where each sample is one stored point of the trajectory together with the value of every channel at this point.
A trajectory set holds `trajectories` trajectories that share a frame and a meaning, e.g. the members of one family of periodic orbits.
The samples of all the trajectories of the set are concatenated into single arrays, one trajectory after another.
The key `offsets` names a `uint32` array of shape `(trajectories + 1,)` that marks where each trajectory begins, with `offsets[0] = 0`.
Trajectory `i` consists of the samples from `offsets[i]` up to but not including `offsets[i + 1]`, hence it has `offsets[i + 1] - offsets[i]` samples.
The total number of samples in the set is `S = offsets[trajectories]`, the last entry.

- The array of `positions` has the shape `(S, 2)` or `(S, 3)`, in the set's `frame`, and a two-component position has `z = 0`.
- The array of a channel has the shape `(S,)`, i.e. one scalar per sample.
  The `interp` of a channel is read only where a readout, a label, or an overlay shows the channel (rule `timeline-parts`), and a position is always interpolated linearly (rule `segment`).
- The array of a parameter has the shape `(trajectories,)`, i.e. one finite scalar per trajectory.

The rules for trajectory sets follow.

- `trajectory-set`. A reader rejects a trajectory set that is named but not declared, that lacks `frame`, `trajectories`, `offsets`, or `positions`, whose arrays are missing from the data container or do not have the dtype and the shape given above, or whose parameter is not finite.
- `two-samples`. Every trajectory has at least two samples, so that it has at least one segment.
- `periodic`. With `periodic: true`, the set declares that each of its trajectories is periodic, i.e. the last sample of every trajectory is declared to be the closing sample, the first sample again one period later.
  The advance of a channel over one revolution is then its value at the last sample minus its value at the first (e.g. the advance of a time channel is the period).
  Whether the positions of the last and the first sample coincide is not checked.
- `monotone-clock-channel`. A channel listed in `clock.channels` (section 2.6) can be the clock channel, and it is therefore strictly monotone, increasing or decreasing, along every trajectory of every set that carries it.
  On a trajectory of `m` samples, where the channel takes the values `c[0]` to `c[m-1]`, these values are finite, and so is their span `c[m-1] - c[0]`, which is then nonzero.
  Trajectories are always traversed in storage order, i.e. from sample 0 upward, even when the channel decreases.
  These conditions are checked by the writer, and also by the reader at load or when it computes a fraction along a trajectory (rule `clock-mode`).
  Rule `clock-channel-carried` says which sets must carry a clock channel.
- `index-channel`. The built-in channel `@index` has the value `i` at sample `i` of a trajectory, counted from the trajectory's first sample.
  It counts stored samples, and thinning a set therefore changes it.
  It may serve as a clock channel, but not in a transform (section 2.3) or in a readout part (section 2.9), where `{"clock": "frame_index"}` gives the frame index instead.
  The built-in parameter `@index` has the value `i` on member `i` of a set, counted from 0.

### 2.2 Numbers that depend on context

Several fields of a scene take a scalar that may depend on which trajectory set, trajectory, and sample is being evaluated.
The scalar is given in one of three forms, and the field determines which forms it allows.

- A number is a constant.
- An attribute, `{"attr": name, "factor": a, "offset": b}`, has the value `a * attrs[name] + b`, where `attrs[name]` is the attribute of the trajectory set.
  One attribute can thus serve several scalars, e.g. the origin of the primary at `-mu` and the origin of the secondary at `1 - mu`.
- A channel, `{"channel": name}`, has the value of the channel at one sample, so that the scalar changes along the trajectory.
  The channel `@index` is not allowed here.

The number behind an attribute or a channel is found in the data, and it is defined only in a context.
A context is made of three choices, i.e. a trajectory set, one trajectory of the set, and one sample of the trajectory.
An attribute depends only on the set, since it has one value for the whole set, while a channel depends on all three.
In the context "set `halo`, trajectory 3, sample 42", e.g., `{"attr": "mu"}` is the `mu` of the set `halo`, and `{"channel": "t"}` is the value of `t` at sample 42 of trajectory 3 of this set.
The context of a drawn sample and of a body is given by rule `sample-context`.

The rule for numbers that depend on context follows.

- `context-number`. A reader rejects a scalar in a form that its field does not allow, such as the channel `@index` in a transform.

### 2.3 Frames

A scene stores each trajectory set in one frame, and the runtime converts positions between frames, which is much cheaper than storing the whole data once per frame.
The frames of a scene form one tree, in which every frame but the root has a `parent`.
Every other frame is defined against its parent by an `origin`, a `rotation`, and a `scale`, each optional.
A transform is the map from a parent frame to a child frame that these three quantities define.
To convert a position from a frame A to a frame B, a reader follows the transforms of the tree through the lowest common ancestor of A and B (rule `frame-path`), hence `n` frames need only the `n - 1` transforms of the tree.

The rules for frames follow.

- `frame`. A reader rejects frames that do not form one tree with one root, a root with an origin, a rotation, or a scale, and a frame that is named but not declared.
- `transform`. The transform is `p_child = s * R * (p_parent - o)`, where `p_parent` and `p_child` are the coordinates of one and the same point in the parent and in the child, and `s`, `R`, and `o` are the scale, the rotation matrix, and the origin, respectively.
  To go from the parent to the child, the origin is thus subtracted first, the result is rotated, and it is then scaled.
  The origin `o` is given in the parent's coordinates.
  The rotation `R` turns by `angle` radians about the selected axis, in the right-handed sense (counterclockwise when seen from the positive end of the axis), so that a point fixed in the parent appears in the child rotated by `+angle`.
  Without a rotation, `R` is the identity, without a scale, `s = 1`, and without an origin, `o = 0`.
  The inverse, from the child back to the parent, is `p_parent = o + R^T * (p_child / s)`, where `R^T` is the transpose of `R`.
  Equivalently, `angle` is the angle of the parent's axes measured in the child.
  The standard case is a rotating frame (the parent) seen from an inertial frame (the child), where the rotating frame turns against the inertial one by the true anomaly `f`.
  The inertial frame is thus the child with `angle = f`, and `p_inertial = R(f) * p_rotating`.
- `origin`. An `origin` is either three scalars of section 2.2, the coordinates of the child's origin in the parent frame, or `{"body": id}`, which places the origin at the position of the body (section 2.4), expressed in the parent frame in the same context.
  A frame's `rotation.angle` and `scale` are each a number, an attribute, or a channel, so that an angle can follow a stored channel such as the true anomaly along the reference trajectory.
  A writer lists the feature `frames.origin_channel` in `requires` (section 4) for a scene with an origin given by a channel.
  The scale `s` is never zero, since the inverse transform would divide by zero.
  A zero scale is rejected in any context that the scene can evaluate, including the contexts of the other revolutions of rules `trail-wrap` and `revolutions`.
  At load, a reader rejects a zero scale given as a constant or as an attribute, and it reports rule `origin` wherever it meets a zero scale while evaluating.
- `frame-path`. To take a position from frame A to frame B, a reader steps along the transforms of the tree.
  It applies inverse transforms (the inverse of rule `transform`) from A up to the lowest common ancestor of A and B, then forward transforms down to B, all evaluated in one and the same context.
  The lowest common ancestor is the deepest frame that is an ancestor of both A and B, or A or B itself when one lies above the other.
- `sample-context`. The context of a sample of a drawn trajectory is the sample itself, i.e. its set, its trajectory, and its index, unless the trajectory's layer reads from the reference trajectory (rule `read-from`).
  A body does not have any stored samples, hence it takes its context from the panel's reference trajectory (section 2.7), i.e. from the sample of the reference trajectory at which the body is needed.
  A body that is fixed in the rotating frame can thus trace its orbit in an inertial frame, since the angle of the transform between the two frames is read from the sample of the reference trajectory.
- `transform-channels`. A trajectory set drawn in a frame must carry every channel used by a transform on the path from the set's frame to the frame it is drawn in, because each such transform is evaluated in the context of the set's samples.
  Its `attrs` must likewise carry every attribute used on the same path.
  The same holds for a panel's reference trajectory and for the bodies drawn in the panel, whose context is the reference trajectory's (rule `sample-context`).
  For a `trajectories` layer that reads from the reference trajectory (rule `read-from`), the set of the reference trajectory must carry the channels and attributes of the path from the frame of the layer's set to the display frame, and the layer's set does not need to carry them.
  For an `inset_box` layer (rule `inset-box`), the set of the reference trajectory must likewise carry the channels and attributes of the path from the target frame to the display frame.
  A writer rejects a scene that breaks this rule for any value its inputs (section 2.5) can take, since an input may change the display frame or the set.
- `body-origin-cycle`. An origin at a body (`{"body": id}` in rule `origin`) must not depend on itself, directly or through other origins at bodies.
  A reader rejects any such circular definition.

### 2.4 Bodies

A body is a point with a `frame` and a `position` in this frame, three scalars that are each a number or an attribute (section 2.2).

The rule for bodies follows.

- `body`. A reader rejects a body that is named but not declared, whose frame is not declared, or whose position is not three scalars.
  The `image` of a body names a `uint8` array of the data container.

### 2.5 Inputs and references

An input is a value that the person at the page can change through a control (section 2.9).
A shared input has one value for the whole page, and a per-panel input has one value per shown panel.
Where a scene needs a value, the value is written either as a literal or as `{"input": id}`, which reads the input with this id.

Where a member reference or a highlight refers to an input of kind `parameter`, its number is resolved to the trajectory whose parameter value is nearest to it.
Distances are compared in float64, and a tie is resolved to the trajectory with the lowest index.
With the built-in parameter `@index` (rule `index-channel`), the number is thus the number of a member in its set.

The rules for inputs and references follow.

- `input`. A reader rejects an input without a known kind or a default, a reference to an input that is not declared, and a value that is not of its input's kind.
  A value of the wrong kind (e.g. a boolean or a string for an input of kind `parameter`, or a number for a toggle) is never cast to the right kind.
- `input-scope`. In a shown panel, `{"input": id}` reads the panel's value when the input is per-panel, and the shared value otherwise.
  A missing value is the input's default.
  A panel's value for a shared input is never read, and a writer rejects such a value in `initial` (section 2.8).
- `set-query`. A set query is either `{"set": id}`, which refers to a declared set directly, or `{"tags": {name: value, ...}}`, which matches every trajectory set whose tags contain all the given pairs (e.g. `{"family": "7"}`).
  Where one set is needed (the `sets` of a layer or of a reference trajectory), a query that does not match any set makes the layer empty, and more than one match is an error there, which a writer must rule out for every value the inputs can take.
  Where several sets are allowed (the domain of a slider, section 2.9), all matches are used.
- `members`. A member reference is `"all"`, `{"index": k}`, `{"evenly_spaced": n}`, or `{"input": id}`, which refers to an input of kind `parameter`.
  A literal index `k` at or past the number of trajectories of the set it is resolved in is an error, and it is not clamped.
  The parameter of an input of kind `parameter` must be carried by the same set, under the same condition, unless it is `@index`.
  For `{"evenly_spaced": n}`, with `n` an integer of at least 1, in a set of `N` trajectories, the selection keeps every `m`-th trajectory.
  It holds the trajectories `0, m, 2m, ...` below `N` and also the last trajectory `N - 1`, each once and in increasing order.
  Its spacing is `m = floor(N / n + 0.5)`, computed in float64, or `m = 1` when `n` is at least `N`, which then selects every trajectory.

### 2.6 The clock

The clock is the time of the animation, which is shared by every panel.
A frame index is an integer of either sign.
The remainder of a frame index modulo `frame_count`, in the range `[0, frame_count)`, is written `i`, so that index `-1` has the remainder `frame_count - 1`.
The progress is `q = i / frame_count`, in the range `[0, 1)`, i.e. the fraction of the loop that has elapsed.
During playback, a reader may evaluate at any progress between frame indices, and the frame index of such a progress is `floor(q * frame_count)`.
The state (section 2.8) names the clock channel, one of `clock.channels`.
A fraction along a trajectory is a function of the frame index alone, and it does not depend on the length of a loop in seconds.

In `fraction` mode, every trajectory runs from its first sample to its last over one loop, whatever the range of the channel on the trajectory.
In `epoch` mode, the trajectories are synchronized by the value of the clock channel (e.g. all shown at the same time `t`).

The rules for the clock follow.

- `clock`. A reader rejects a clock whose `mode` is not `fraction` or `epoch` or whose `frame_count` is not an integer of at least 1, a state whose clock channel is not one of `clock.channels`, and a frame index that is not an integer.
- `sample-fraction`. Along one trajectory of `m` samples, where the clock channel takes the values `c[0] .. c[m-1]`, sample `i` lies at the fraction along `u_i = (c[i] - c[0]) / (c[m-1] - c[0])`.
  The first sample is at fraction along 0 and the last at 1, and since the channel is strictly monotone (rule `monotone-clock-channel`), the fractions along increase strictly with `i`.
  For the channel `@index`, the fraction along is `u_i = i / (m - 1)`.
- `clock-mode`. In `fraction` mode, the fraction along a trajectory is the progress itself, `u = q`.
  In `epoch` mode, the clock has a `range` `[a, b]` or the `keyframes` of rule `clock-keyframes`.
  With a range, the shared value of the channel is `v = a + q * (b - a)`, and the fraction along a trajectory is `u = (v - c[0]) / (c[m-1] - c[0])`, which may be below 0 or above 1 when the value is outside the trajectory's range.
- `before-after`. In `epoch` mode, a fraction along below 0 lies before the trajectory's first stored sample, and a fraction along above 1 lies after its last, in storage order whatever the direction of the channel.
  A layer's `before` and `after` say what is evaluated then.
  Under `clamp`, the fraction along is taken as 0 or 1, respectively, and under `hidden` the trajectory is hidden.
- `segment`. The point at the fraction along `u` lies on segment `k`, where a segment joins two consecutive samples and `k` is the largest index, at most `m - 2`, with `u_k <= u <= u_(k+1)`.
  Its weight along the segment is `w = (u - u_k) / (u_(k+1) - u_k)`, which is 0 at sample `k` and 1 at sample `k + 1`.
  Its position in a display frame is `(1 - w) * P_k + w * P_(k+1)`, where `P_k` and `P_(k+1)` are the two samples already transformed into the display frame, each in the context of its sample.
  The transform is thus applied to the two samples first, and the two results are then interpolated linearly.
- `clock-channel-carried`. A fraction along is computed on every trajectory that a layer draws with a `reveal` other than `none`, with a `head`, or, in `epoch` mode, with a `before` or an `after` of `hidden`, on every member of an `arrow` layer (rule `arrow`), and on the reference trajectory (section 2.7).
  A set with such a trajectory carries every channel of `clock.channels` other than `@index`, so that the fraction along can be computed whichever channel is the clock channel.
  A writer rejects a scene that breaks this rule for any value its inputs can take.
  A set drawn whole and never hidden, with `reveal: none` and without a head, need not carry these channels, also when its layer reads from the reference trajectory (rule `read-from`).
  A layer with a layer clock (rule `layer-clock`) computes its fractions along by the channel of this clock, which its set carries instead, unless it is `@index`.
  A `points` layer with `reveal` `grow` (rule `points`), a label anchored at a member (rule `label`), and the target of a camera keyframe (rule `camera-keyframes`) compute a fraction along as well.
- `revolutions`. The key `revolutions` is the number `n` of revolutions that one loop of the animation covers.
  Only a `fraction` clock has it, and a writer and a reader reject it on an `epoch` clock.
  The total fraction along is `U = n * u`, where `u` is the fraction along of rules `clock-mode` and `before-after`, so that `U` runs from 0 to `n` over one loop.
  A total fraction along `U` lies in revolution `j = min(floor(U), n - 1)` at the fraction along `U - j` within the revolution, both computed in float64.
  A revolution is thus one traversal of a trajectory from its first sample to its closing sample, and revolution `j` is the `j`-th revolution after the stored one.
  The fractions along of rules `segment` and `polyline` are fractions along within a revolution.
  A vertex (a point of a polyline) in revolution `j` is evaluated in the context raised by `j` periods, in which the value of every channel is raised by `j` times the advance of the same channel over one revolution (rule `periodic`).
  A time channel, e.g., is raised by `j` periods, so that a transform driven by it keeps turning in the later revolutions.
  Revolution 0 is therefore the stored context, and in a revolution below 0 every channel value is lowered.
  The point at a total fraction along is the point at its fraction along within its revolution.
  The polyline between total fractions along `U_a <= U_b`, in revolutions `j_a <= j_b`, joins the polylines of rule `polyline` in every revolution `j` from `j_a` to `j_b`.
  Each of these polylines runs from `U_a - j_a` in revolution `j_a` and from 0 in the other revolutions, to `U_b - j_b` in revolution `j_b` and to 1 in the other revolutions.
  In the join, the closing sample of revolution `j` and the first sample of revolution `j + 1` are the same point, and they are kept as one vertex, the first sample of revolution `j + 1` in the context of revolution `j + 1`.
  A set that is not periodic has one revolution, revolution 0.
  With `n > 1`, every trajectory on which a fraction along is computed, by the list of rule `clock-channel-carried` with the reference trajectory included, belongs to a periodic set, since only a periodic set defines what the next revolution is.
  A writer rejects a scene that breaks this rule for any value its inputs can take, and a reader rejects it where it computes the fraction along.

### 2.7 Declared panels, reference trajectories, and layers

The key `panels` declares the panels that a page may show, and a page may show several copies of one declared panel (section 2.8).
The `reference` of a declared panel names the reference trajectory, the one trajectory that the panel follows, by a set query and a member reference, `{"index": k}` or an input of kind `parameter`, that resolve to one trajectory.
The bodies, the readouts, and the `trajectories` layers that read from the reference trajectory take their context from it (rules `sample-context`, `body-layer`, and `read-from`, and section 2.9).
Rules `set-query`, `members`, and `clock-channel-carried` always apply to the reference trajectory, because a reader resolves the reference trajectory of every shown panel whether or not a layer uses it.

The `reveal` of a `trajectories` layer selects the part of each trajectory that is evaluated as the animation advances.

- With `none`, the layer gives every sample of the trajectory in every revolution of rule `revolutions`, transformed and joined as rule `revolutions` says.
- With `grow`, the layer gives the polyline from the first sample of revolution 0, at total fraction along 0, to the point at the fraction along.
- With `trail`, the layer gives the polyline from a tail at the total fraction along `U_t = U - n * fraction` to the point at the fraction along, both total fractions along of rule `revolutions`, where `fraction` is `trail.fraction`.

The rules for declared panels and layers follow.

- `panel`. A reader rejects a declared panel that lacks `frame`, `reference`, or `layers`, a reference that lacks `sets` or `member`, a display frame that is not declared, a camera `plane` other than `xy`, `xz`, or `yz`, a `reveal` other than `none`, `grow`, or `trail`, and a trail whose fraction is missing or outside `(0, 1]`.
- `polyline`. A polyline is a sequence of points joined by straight segments.
  The polyline between the fractions along `u_a <= u_b` on one trajectory, in one revolution, consists of the point at `u_a` (interpolated by rule `segment`), every stored sample `i` with `u_a < u_i < u_b`, and the point at `u_b`.
  When `u_a = u_b`, the polyline is the point at `u_a` alone.
  The polylines of several revolutions are joined by rule `revolutions`.
- `trail-wrap`. A trail whose tail total fraction along `U_t` is negative reaches back before the start of the stored trajectory.
  When the set is not periodic, the trail is cut at the first sample of revolution 0.
  When the set is periodic, the trail continues below revolution 0 into revolution -1, and into lower revolutions when its tail reaches them, each revolution evaluated as in rule `revolutions`.
  Revolution -1, the case `j = -1` of rule `revolutions`, is the shifted context, in which every channel value is lowered by the advance of the same channel over one revolution.
  The first sample of revolution 0 and the last vertex of revolution -1, which is the shifted closing sample, are the same point, and they are kept as one vertex, the first sample of revolution 0 in its unshifted context.
  The tail total fraction along `U_t = U - n * fraction` is computed in float64, the product first, so that with one revolution the shifted part starts at the fraction along `u - fraction + 1`, computed in this order.
  The order matters because floating-point arithmetic rounds at each operation, and both evaluators must get the same bits.
- `head`. With a `head`, the layer also gives the point at the fraction along, i.e. the current position of the moving point.
  A `head` is `true` or a marker, both of which give the same point, and an absent `head` is `false`.
  A head's `glow` reads its channel at sample `k` of rule `segment`, or at sample `k + 1` when the weight `w` is 1, and the layer's set carries this channel.
- `body-layer`. A `body` layer gives the body's position at the fraction along the reference trajectory, clamped to `[0, 1]`, since a body layer does not have a `before` or an `after`.
  The layer transforms the body's position into the display frame in the contexts of the samples `k` and `k + 1` of the reference trajectory in its revolution (rule `segment`), and blends the two results by the weight `w`, as in rule `segment`.
  With a `trail`, the layer also gives the body's position at every vertex of the trail that rules `polyline`, `trail-wrap`, and `revolutions` define on the reference trajectory for the trail's fraction, so that a body fixed in the rotating frame leaves a trail of its path in an inertial frame.
  Each of these positions is taken in the context of its vertex, i.e. the two blended contexts for an end point and the sample's context for a stored sample, each in the vertex's revolution.
- `visible`. The `visible` of a layer refers to a toggle (section 2.5), and a reader rejects a `visible` that refers to anything else.
  A layer with a `visible` is omitted while its toggle is false.
  The references of an omitted layer are still checked at load, so that turning the toggle on cannot uncover an error.
- `read-from`. The `read_from` of a `trajectories` layer is `own` or `reference`, and a reader rejects any other value.
  With `own`, each sample of a member is transformed into the display frame in its own context (rule `sample-context`).
  With `reference`, every sample of every member is instead transformed in the context of the fraction along the reference trajectory, as rule `body-layer` transforms a body.
  The sample is thus transformed in the contexts of the samples `k` and `k + 1` of the reference trajectory in its revolution, at its fraction along clamped to `[0, 1]`, and the two results are blended by the weight `w` of rule `segment`.
  Under `reference`, only the transform of a sample is different.
  The vertices of a member, its fraction along, its head, and whether it is hidden are still given by rules `polyline` to `head`, `before-after`, and `revolutions` on the layer's own trajectory, and a vertex between two samples is still the blend of rule `segment` of the two samples, each transformed in the context of the reference trajectory.
  The position of a vertex is therefore the same in every revolution and under the shift of rule `trail-wrap`.
  A polyline stored in one frame, e.g. a grid line of the rotating-pulsating frame, is thus drawn where this frame lies at the fraction along the reference trajectory, and its set does not need the channels of the path to the display frame.
  When the set query of the reference trajectory does not match any set, the line of every member is empty, and its head is `null` when the layer has a head.
  A writer lists the feature `layers.read_from` in `requires` (section 4) for a scene with a layer that reads from the reference trajectory.

  For example, the layer below gives every line of a trajectory set `grid`, stored in the rotating-pulsating frame of the elliptic problem, in the display frame of its panel.
  In the rotating frame, whose scale is the separation `rho` of the primary and the secondary, the grid then breathes as the reference trajectory moves.
  In the inertial frame it also turns with the true anomaly.
  The channels `rho` and `true_anomaly` are read from the reference trajectory alone, and the set `grid` carries neither.

  ```json
  {"kind": "trajectories", "sets": {"set": "grid"}, "members": "all", "read_from": "reference", "color": "#3a4150"}
  ```

- `arrow`. The arrow of a member of an `arrow` layer runs from its base to its tip.
  The base is the point at the fraction along of rule `segment`, in the revolution of rule `revolutions`, i.e. the point that a head of a `trajectories` layer gives (rule `head`).
  The tip of sample `i` is the point `p_i + scale * v_i` in the frame of the set, where `p_i` is the position of the sample and `v_i` its vector.
  The vector is read from the stored values of the channels of `vector`, with a third component of 0 when `vector` lists two channels.
  The values of these channels are not raised by the revolution of rule `revolutions`.
  The tip of the member is the blend of rule `segment` of the tips of samples `k` and `k + 1`, with the same `k`, weight `w`, and revolution as the base.
  Each of the two tips is transformed into the display frame in the context of its sample in the revolution.
  A fraction along is computed on every member, and its `before` and `after` hide the arrow as they hide a trajectory (rule `before-after`), in which case both its base and its tip are `null`.
  In `epoch` mode, a member of two samples whose clock channel runs from `a` to `b`, with `before: "hidden"` and `after: "hidden"`, is thus an arrow that is shown from the moment the shared value reaches `a` until it passes `b`.
  The channel `@index` is not allowed in `vector`, and the set carries every channel of `vector`, for every value the inputs can take.
  The `scale` is constant per set, and a reader rejects a channel there.
  A writer lists the feature `layers.arrows` in `requires` (section 4) for a scene with an arrow layer.

- `inset-box`. The `panel` of an `inset_box` layer names a declared panel other than the declared panel that holds the layer, with a `2d` camera, and a reader rejects any other target.
  The target panel is the first shown panel in layout order (section 2.8) whose declared panel is the target.
  When the layout does not show the target, the layer does not have a target panel.
  The target frame is the display frame of the target panel, read with the target panel's values of the inputs (rule `input-scope`).
  The layer gives the affine map from the target frame into the display frame of its own panel.
  It takes this map in the context of the fraction along its own reference trajectory, as rule `read-from` transforms a sample, i.e. in the contexts of the samples `k` and `k + 1` of the reference trajectory in its revolution, at its fraction along clamped to `[0, 1]`, and it blends the two maps by the weight `w` of rule `segment`.
  The map is given by `origin`, the image of the point `(0, 0, 0)` of the target frame, and by `axes`, three vectors, where `axes[j]` is the image of the unit point along axis `j` minus `origin`.
  A point `p` of the target frame thus lands at `origin + p_x * axes[0] + p_y * axes[1] + p_z * axes[2]`.
  Every transform of rule `transform` is affine in the point for a fixed context, and so is a blend of two affine maps, hence this formula gives the blended transform of every point.
  When the set query of the reference trajectory does not match any set, `origin` and `axes` are `null`.
  A writer lists the feature `layers.inset_box` in `requires` (section 4) for a scene with an `inset_box` layer.

  In the example below, a frame `zoom` is a magnified copy of the rotating frame `rot` about the middle `(mx, my)` of a window of half width `1 / k`, where the set of the reference trajectory carries the channels `mx`, `my`, and `k`.
  A point `p` of `rot` lies at `u = k * (p - m)` in `zoom` (rule `transform`), and the corners `u = (±1, ±1, 0)` of the window lie at `m ± 1 / k` in `rot`.
  A declared panel `orbit` in the frame `rot` draws the rectangle that a shown panel of the declared panel `closeup`, drawn in `zoom`, shows.

  ```json
  {"frames": {"rot": {}, "zoom": {"parent": "rot", "origin": [{"channel": "mx"}, {"channel": "my"}, 0], "scale": {"channel": "k"}}}}
  {"kind": "inset_box", "panel": "closeup", "color": "#ffffff", "opacity": 0.5, "width": 1, "dash": [4, 3], "min_size": 12}
  ```

The other keys of a declared panel and of its layers, such as a color, a width, an opacity, an `axes` or a `grid` layer, and every key of a camera but its `keyframes`, are for drawing only.
They are not read in the evaluation of section 3, hence they are not covered by any case of the conformance corpus.
A few of them still bind the data, as follows.
A color over a `channel` or a `parameter`, and a color by thresholds of a channel, need the layer's set to carry the channel or the parameter, as rule `transform-channels` asks for the channel of a transform.
The thresholds of a color by thresholds increase strictly, and the color has one entry in `colors` more than there are thresholds.
A colormap given by an input of kind `choice` maps every value of the choice to a colormap name, and only these values, and a writer and a reader reject any other map.
A `highlight` refers to an input of kind `parameter`, held to rule `members` like a member reference.

### 2.8 State

The state of a page is everything that the person at the page can change: which panels are shown, what each of them shows, and the current values of the inputs and of the clock.
A shown panel is a panel on the page, and each shown panel shows one declared panel of section 2.7.
The state is

```json
{"inputs": {id: value}, "clock": {"channel": name}, "panels": {shown id: {"panel": declared id, "inputs": {id: value}}}, "layout": node}
```

where `inputs` holds the values of the shared inputs, `clock` names the clock channel, `panels` maps each shown panel to its declared panel and its values of the per-panel inputs, and `layout` is a tree of nodes whose leaves are the shown panels.
The layout order is the order of the leaves of this tree, the side `a` of a split before its side `b`.
The starting state is carried in `scene.tys` as `initial`.

A reader that restores a stored state keys it on a hash of `scene.tys`, so that a state saved for one scene is not applied to another, and it repairs the state before use rather than rejecting it.
It drops a shown panel whose declared panel the scene does not declare or whose id is not an identifier (rule `identifier`), together with the panel's layout leaf.
It also drops a shown panel that the layout does not hold, a layout leaf that does not refer to a shown panel, and a repeated leaf.
It drops a value that does not fit its input or does not belong to any input, a panel's value of a shared input, and a shared value of a per-panel input.
It replaces a split ratio outside `(0, 1)` by one half, and drops invalid keyframes of a split.
The reader falls back to `initial` when the repaired state does not have any shown panel, when the clock channel is unknown, or when the stored data is not a state at all.

The rule for the state follows.

- `state`. A state is valid when every shown panel names a declared panel, the layout holds every shown panel of the state once and does not repeat any, the clock channel is one of `clock.channels`, and every value fits its input (section 2.5).
  Input ids that the scene does not declare are ignored.
  The checks of a reader and its evaluator take a valid state, and they reject any other state under rule `state`, rule `clock`, or rule `input`.

### 2.9 Controls and readouts

A control sets an input or drives the clock.
A control over a per-panel input sets the value of the shown panel in which it appears, and a control over a shared input sets the shared value.

The sets that a slider's `domain` matches must each carry the input's parameter, for every value the inputs can take, and a writer rejects a slider that breaks this rule.
A slider's stops are the distinct parameter values of the matched sets in increasing order, and moving the slider to a stop writes the stop's value into the input.
A change of the domain (e.g. through an input of kind `choice` that the query depends on) never changes the value of the input.

A readout is a list of `parts`, which are concatenated.
Each part is a string, shown as it is, or one of the following.

- `{"input": id}` is the value of an input.
- `{"parameter": name}` is the value of the named parameter for the current trajectory, and `@index` is accepted as the name.
- `{"attr": name, "factor": a, "offset": b}` is an attribute, as in section 2.2.
- `{"channel": name}` is the value of the named channel at the current fraction along.
- `{"clock": "frame_index"}` is the frame index, i.e. the remainder `i` in `[0, frame_count)`.
- `{"clock": "frame_count"}` is the frame count.

In a shown panel, the parameter, the attribute, and the channel are those of the reference trajectory, at its fraction along.
The channel is blended between the two samples of rule `segment` in the context of the revolution of the reference trajectory (rule `revolutions`), unless its `interp` is `hold` (rule `timeline-parts`), and the fraction along is clamped to `[0, 1]` as in rule `body-layer`.
In the caption they are those of the first shown panel in layout order, and so is the value of a per-panel `{"input"}` part.
A writer rejects a part that refers to a parameter, an attribute, or a channel that the set of the reference trajectory does not carry, for every value the inputs can take.
Readouts do not have a template language, i.e. a readout is the list of its parts, without a format string.

The rule for controls follows.

- `control`. A reader rejects a control of an unknown kind, a control whose `input` is not declared, and a control whose input is of a kind that the control does not set.

### 2.10 Export

How the runtime records a video of a page is not part of the format, apart from the rule below.

- `export`. A reader refuses to export a video that is longer than its stated ceiling, in seconds or in images.

### 2.11 The timeline

The timeline is the time of one loop of the clock in seconds, at playback speed 1.
At the progress `q` of section 2.6 it is `s = q * L`, computed in float64, where `L` is the length of a loop, i.e. `clock.seconds`, or 8 seconds per revolution when `seconds` is absent.
A value that moves by the time of the timeline rather than by a stored channel, e.g. a camera that zooms in after seven seconds, is given by keyframes.
A keyframe is written `[t, v]` or `[t, v, ease]`, where `t` is a time in seconds, `v` is a number, and `ease` names how the value travels to `v` from the keyframe before.
A keyframed value is `{"keyframes": [keyframe, ...]}`, the value that its keyframes give at each time.

The rules for the timeline follow.

- `timeline`. A reader rejects a keyframed value whose values lie outside the range of the key that holds it, e.g. an opacity outside `[0, 1]`.
- `keyframes`. A keyframed value has at least one keyframe, and the times of its keyframes are finite and nondecreasing.
  Its value at time `s` is found as follows.
  Let `i` be the last keyframe with `t_i <= s`.
  When there is no such keyframe, the value is `v_0`, and when `i` is the last keyframe, the value is `v_i`.
  Otherwise `t_i <= s < t_(i+1)`, and the value is `v_i + E(x) * (v_(i+1) - v_i)`, where `x = (s - t_i) / (t_(i+1) - t_i)`, computed in float64 in this order, and `E` is the ease of keyframe `i + 1`.
  Two keyframes at the same time thus make a jump, to the value of the later keyframe, at this time.
- `ease`. The ease of a keyframe is one of the following, and each product is computed from the left.
  - `linear`, the default, has `E(x) = x`.
  - `smooth` has `E(x) = x * x * (3 - 2 * x)`.
  - `in` has `E(x) = x * x * x`.
  - `out` has `E(x) = 1 - y * y * y` for `y = 1 - x`.
  - `in-out` has `E(x) = 4 * x * x * x` for `x < 0.5`, and `E(x) = 1 - y * y * y / 2` for `y = 2 - 2 * x` otherwise.
  - `hold` has `E(x) = 0`, which keeps the value of keyframe `i` until the time of keyframe `i + 1`.

  A reader rejects any other name, and the ease of the first keyframe is never used.
- `clock-keyframes`. A clock in `epoch` mode gives the shared value of its clock channel either by its `range` (rule `clock-mode`) or by its `keyframes`, and a reader rejects a clock with both or with neither.
  With keyframes, the shared value at progress `q` is `v`, the value of the keyframes at `s = q * L`, and the fraction along a trajectory is `u = (v - c[0]) / (c[m-1] - c[0])`, as in rule `clock-mode`.
  The clock can therefore pause (two keyframes of one value), run at several speeds, and ease in and out of a move.
  A clock in `fraction` mode does not have keyframes.
  A writer lists the feature `clock.keyframes` in `requires` for a scene whose clock has keyframes.
- `layer-clock`. A `trajectories`, `arrow`, `points`, or `label` layer may carry a layer clock, `{"channel": name, "range": [a, b]}` or `{"channel": name, "keyframes": [keyframe, ...]}`.
  The layer then computes every fraction along on its members in `epoch` mode, with this channel and with the shared value that `range` (rule `clock-mode`) or `keyframes` (rule `clock-keyframes`) gives at the progress, whatever the mode and the clock channel of the scene's clock.
  Its fractions along are in one revolution, i.e. rule `revolutions` reads them with `n = 1`.
  Rule `clock-channel-carried` then asks the layer's set to carry the layer's channel, unless it is `@index`, rather than the channels of the scene's clock, and rule `monotone-clock-channel` holds for this channel on every trajectory on which the layer computes a fraction along.
  Different layers can thus run on different channels and at different times, e.g. a cloud that grows backward in a backward time while the transfer it came from stays whole.
  A writer lists the feature `layers.clock` in `requires` for a scene with a layer clock.
- `camera-keyframes`. A `2d` camera may carry `keyframes`, a list of camera keyframes, each `{"at": t, "width": w, "height": h, "center": [a, b], "follow": [target, ...], "offset": [da, db], "ease": name}`, whose times `at` are finite and nondecreasing.
  A camera keyframe gives the window that the panel shows at its time.
  The window has a center, two coordinates along the axes of the camera's plane (`x` and `y` for `xy`, `x` and `z` for `xz`, and `y` and `z` for `yz`), and a width `w > 0`, the extent of the window along the first of the two axes in units of the display frame.
  Its `height`, the extent along the second axis, is given only under `"aspect": "free"`, by every keyframe of the camera or by none.
  The center is `center`, or, with `follow`, a point that moves.
  A target `{"layer": i, "member": k}` is the point at the fraction along of member `k` of the `trajectories` layer at index `i` of the same declared panel's `layers`, i.e. the point of rule `segment` in its revolution of rule `revolutions`, under the layer's clock (rule `layer-clock`) and in the layer's `read_from` (rule `read-from`), with the fraction along clamped to `[0, 1]` as for a body (rule `body-layer`).
  The member `k` is a trajectory of the set that the layer's set query resolves to, and it is an error when `k` is at or past the number of its trajectories.
  The center of a follow keyframe is the mean of the points of its targets, projected onto the plane's two axes, plus `offset`.
  A target whose layer's set query does not match any set is left out, and a keyframe whose targets are all left out takes its `center`, or does not have a center when it lacks one.
  The camera at time `s` blends two keyframes as rule `keyframes` blends two values, with the ease of the later keyframe.
  The center is `(1 - E) * c_i + E * c_(i+1)`, and the width is `exp((1 - E) * ln(w_i) + E * ln(w_(i+1)))`, as is the height, so that a zoom by a factor runs at a steady rate.
  Both centers are taken at time `s`, hence a blend from a fixed window to a follow keyframe ends on the moving point.
  Before its first keyframe and after its last, the camera shows the window of this keyframe, and when a keyframe it needs lacks a center, the camera does not have a window at `s`.
  The layer at index `i` is a `trajectories` layer and `k` is an integer, and a reader rejects any other target.
  A writer lists the feature `camera.keyframes` in `requires` for a scene with a camera with keyframes.
- `label`. A `label` layer writes a text at an anchor.
  Its `text` is a string or a list of parts, the parts of a readout of section 2.9 and those of rule `timeline-parts`, read in the layer's panel.
  Its `at` is the anchor, one of the following.
  - `{"point": [x, y, z]}` is a point in the display frame.
  - `{"point": [x, y, z], "frame": id}` is a point in the frame `id`, taken into the display frame in the contexts of the fraction along the reference trajectory as rule `body-layer` takes a body.
  - `{"sets": query, "member": k}` is the point at the fraction along of member `k` of the set that `query` resolves to, under the layer's clock and with the fraction along clamped to `[0, 1]`.
  - `{"screen": [fx, fy]}` is a fixed place in the panel.

  The evaluator gives the anchor's position in the display frame, and `null` for an anchor on the screen, for a set query that does not match any set, and for a reference trajectory whose set query does not match any set.
  It is an error when `k` is at or past the number of trajectories of the set.
  A writer lists the feature `layers.label` in `requires` for a scene with a label layer.
- `timeline-parts`. The parts of section 2.9 are joined by the following parts, in readouts, labels, and overlays.
  - `{"clock": "value"}` is the shared value of the clock channel of the scene's clock at the progress, by rule `clock-mode` or `clock-keyframes`, and the progress `q` itself under a `fraction` clock.
  - `{"clock": "time"}` is the time `s` of the timeline.
  - `{"keyframes": [keyframe, ...]}` is the value of the keyframes (rule `keyframes`) at `s`, e.g. a counter that runs from 0 to 1000 during the burst of a sampling step.
  - `{"timed_text": [[t, text], ...]}` is the text of the last of its pairs with `t <= s`, and the empty string before the first.
    Its times are finite and nondecreasing.
  - `{"sub": text}` and `{"sup": text}` are a subscript and a superscript, which are parts rather than markup, since a string never holds markup (rule `plain-text`).

  A part that gives a number, i.e. an `input` of kind `parameter`, `parameter`, `attr`, `channel`, `clock`, and `keyframes`, may carry `factor` and `offset`, which show `factor * x + offset`, computed in float64 in this order.
  A channel part reads a channel whose `interp` is `hold` (section 2.1) at sample `k` of rule `segment`, or at sample `k + 1` when the weight `w` is 1, without the blend, so that a count stored per sample steps from one value to the next.
  A channel part reads a channel whose `interp` is `linear` with the blend of section 2.9.
- `points`. A `points` layer gives the stored samples of the members that `sets` and `members` select.
  With `reveal` `none`, it gives every sample of every member.
  With `reveal` `grow`, it computes the fraction along `u` of each member (rule `clock-mode`, or rule `layer-clock` with a layer clock) and gives the samples whose fractions along `u_i` (rule `sample-fraction`) are at most `u`, none when `u < 0` and all when `u > 1`.
  Its `before` and `after` hide a member as they hide a trajectory (rule `before-after`).
  Each sample is transformed into the display frame in its own context (rule `sample-context`), in revolution 0.
  The evaluator gives the positions of the given samples of each member, in storage order.
  A writer lists the feature `layers.points` in `requires` for a scene with a points layer.
- `steps`. The `steps` of a scene are the named times of its timeline at which a presentation stops.
  The ids of the steps are identifiers (rule `identifier`) and differ from each other, and their times are finite, nondecreasing, and lie in `[0, L]`.
  Steps are not evaluated.

The other keyframed values of a scene, e.g. an opacity, a marker's size, or the ratio of a split of the layout, are for drawing only, and the evaluator does not read them.

## 3. What an evaluator returns

Both implementations expose the same evaluator, a function `evaluate(scene, data, state, frame_index)` that is pure, i.e. its result depends only on its four arguments and it does not have side effects.
The two implementations can thus be compared case by case through the corpus.
For every shown panel in the state, the evaluator returns the display frame and one entry per layer, in the order of the layers of the declared panel.
All positions have three components and are float64.

```json
{"panels": {"p1": {"frame": "inertial", "layers": [
  {"kind": "trajectories", "set": "family-7-periapsis", "members": [
    {"index": 3, "line": [[x, y, z], ...], "head": [x, y, z]}]},
  {"kind": "body", "body": "m1", "position": [x, y, z], "trail": [[x, y, z], ...]},
  {"kind": "arrow", "set": "family-7-periapsis", "members": [
    {"index": 3, "base": [x, y, z], "tip": [x, y, z]}]},
  {"kind": "inset_box", "panel": "closeup", "shown_panel": "p2", "frame": "zoom",
    "origin": [x, y, z], "axes": [[x, y, z], [x, y, z], [x, y, z]]},
  {"kind": "axes"}
]}}}
```

A shown panel whose camera has keyframes (rule `camera-keyframes`) also has the key `camera`, `{"center": [a, b], "width": w, "height": h}`, the window at the frame index, with `height` `null` unless the keyframes give it, or `null` when the camera does not have a window then.
A label layer (rule `label`) gives `{"kind": "label", "position": [x, y, z]}`, the position of its anchor in the display frame or `null`.
A points layer (rule `points`) gives `{"kind": "points", "set": id, "members": [{"index": 3, "points": [[x, y, z], ...]}]}`, the given samples of each member, with `set` `null` and `members` empty when its set query does not match any set.

The example shows one shown panel `p1` in the frame `inertial` with five layers.
The `trajectories` layer gives member 3 of the set `family-7-periapsis` as the polyline `line` with a `head`.
The body layer gives the position of the body `m1` and its trail.
The arrow layer gives the base and the tip of the arrow of member 3 (rule `arrow`).
The `inset_box` layer gives the map from the frame `zoom` of the shown panel `p2`, which shows the declared panel `closeup` (rule `inset-box`).
The evaluator does not compute anything for the axes layer.
When the layout does not show the target of an `inset_box` layer, its `shown_panel`, `frame`, `origin`, and `axes` are `null`, and when only the set query of the reference trajectory does not match any set, its `origin` and `axes` are `null`.
When the set query of an arrow layer does not match any set, the layer's `set` is `null` and its `members` is empty, and the `base` and `tip` of a hidden member are `null`.
When the set query of a `trajectories` layer does not match any set, the layer's `set` is `null` and its `members` is empty.
A member's `line` is the polyline that the layer's `reveal` defines, and it is empty when the trajectory is hidden (rule `before-after`).
The `head` and `trail` keys are present only when the layer carries a head or a trail, respectively, and `head` is `null` when the trajectory is hidden.
When the set query of the reference trajectory does not match any set, a body layer's `position` is `null` and its `trail` is empty, and a `trajectories` layer that reads from the reference trajectory gives an empty `line` and a `null` head for every member (rule `read-from`).
A layer omitted by rule `visible` does not appear in the list.

## 4. Features

A feature is a named part of the format that is listed in `requires` (rule `version`) by a scene that uses it, so that a reader that does not implement the part rejects the scene instead of drawing it wrongly.
The features of version 0.5 are the following.

- `layers.arrows` is the `arrow` layer (rule `arrow`).
- `layers.inset_box` is the `inset_box` layer (rule `inset-box`).
- `layers.read_from` is the `read_from` of a `trajectories` layer (rule `read-from`).
- `frames.origin_channel` is an origin given by a channel (rule `origin`).
- `clock.keyframes` is the keyframes of a clock (rule `clock-keyframes`).
- `layers.clock` is a layer clock (rule `layer-clock`).
- `camera.keyframes` is the keyframes of a camera (rule `camera-keyframes`).
- `layers.label` is the `label` layer (rule `label`).
- `layers.points` is the `points` layer (rule `points`).

Several keys are not features, since a reader that ignores one of them still draws every trajectory, only at another scale, from another side, at another pace, or at another opacity.
They are the `aspect` of a `2d` camera, the `fit` of a `trajectories` layer, the `stretch` and the `auto_rotate` of a `3d` camera, the `seconds` and the `end` of the clock, the keyframed values of opacity, of a marker's size, and of a split's ratio, the parts of rule `timeline-parts`, the `steps` (rule `steps`), the markers, glows, dashes, fills, and threshold colors of a `trajectories` layer, the box of an axes layer, the margin and the opacity of a declared panel, the image of a body, the font and the gutter of the theme, and the overlays.

The following features do not exist yet.
They are reserved here so that they can be listed in `requires` once they exist.
They are `panels.plot`, `frames.quaternion` (an orientation from a quaternion channel), `frames.body_axis` (an axis from one body to another), `bodies.trajectory`, and `bodies.radius`.
They are not part of version 0.5.
