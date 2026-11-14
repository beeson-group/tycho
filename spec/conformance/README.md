# Conformance corpus

The _conformance corpus_ is the set of test scenes on which both evaluators of TyCHO must agree.
An _evaluator_ is a function `evaluate(scene, data, state, frame_index)`, given in section 3 of `../tycho-scene.md`, which returns every position that a scene draws at one frame index.
Each directory here but `containers/` is one scene with the answers an evaluator must give for it, and `containers/` holds the fixtures of the data container that the last section describes.
Both implementations, the TypeScript evaluator in `web/` and the NumPy evaluator in `pytycho`, run every case.
The Python runner `tests/test_conformance.py`, a pytest suite, passes each case to the NumPy evaluator, and the TypeScript runner `web/test/conformance.test.ts`, a vitest suite, passes it to the TypeScript evaluator.
Where the two evaluators disagree, the answer in the corpus holds.

A scene directory holds the three files below, and a fourth, `rejections.json`, when the scene has rejections.
The first two are the files of every TyCHO scene, i.e. the scene document of section 2 of `../tycho-scene.md` and the data container of its section 1.

```
<scene>/
  scene.tys         the scene document
  data.tyd          its arrays
  cases.json        the cases
  rejections.json   optional: scenes and states a reader must refuse, derived from scene.tys
```

A _case_ is one call of `evaluate` on the scene, together with the result that this call must return.
The file `cases.json` is a list, and each case in it has the form below.

```json
{
  "name": "inertial frame, member 2, mid-orbit",
  "source": "analytic",
  "state": { "inputs": {}, "clock": { "channel": "time" }, "panels": { "p1": { "panel": "main" } }, "layout": { "kind": "panel", "id": "p1" } },
  "frame_index": 100,
  "tolerance": 1e-12,
  "expected": { "panels": { "p1": { "frame": "inertial", "layers": [] } } }
}
```

The keys of a case are the following.

- The key `name` describes the case in words, and both runners show it as the name of the test.
- The key `source` records where the expected numbers come from, with the values that are listed further below.
  The TypeScript runner appends it to the name of the test, and it does not change how the case is compared.
- The key `state` is the state of the page (section 2.8 of `../tycho-scene.md`), i.e. the values of the inputs, the clock channel, the declared panel of each shown panel, and the layout of the shown panels.
- The key `frame_index` is the frame index at which the scene is evaluated, i.e. the number of one instant of the animation (section 2.6).
- The key `tolerance` is the largest absolute difference allowed between a number that the evaluator returns and the expected number.
- The key `expected` is the result that `evaluate` must return.

The value of `expected` has the shape that section 3 of `../tycho-scene.md` gives for the return value of `evaluate`.
Each runner reads `scene.tys` and `data.tyd`, calls `evaluate` with the `state` and the `frame_index` of the case, and compares the result with `expected`.
An evaluator passes a case when every number it returns lies within `tolerance` of the expected number, in absolute value, and every other value is equal.
The comparison follows the steps below.

1. A number passes when the absolute value of its difference from the expected number is at most `tolerance`.
   A string, a boolean, or a `null` passes when it equals the expected value.
2. A list passes when it has the same length as the expected list and each of its entries passes against the entry at the same position.
3. Below the level of a panel, a compared object has the same keys as the expected object.
   A key that is missing from the result fails the case, and so does a key that the expected object does not have.
4. A case may give `expected` for some shown panels only, and the panels that it leaves out are not compared.
   It may also give a panel without its `layers`, and the layers of this panel are then not compared.
5. A layer written as `null` in `expected` is not compared, while the list of layers must still have the same length.
   A case thus checks only the layers that are given in it.
   For example, a case of `rotating-loop` gives the layer of the whole trajectory and the axes layer.
   It holds `null` for the other two layers of the same declared panel, a `trajectories` layer with a trail and a body layer.

The scene and the state of every case are valid, and the checks of a reader must accept them.
The TypeScript runner checks this by calling `validate` before `evaluate`.
The function `validate` makes the checks that a reader makes before evaluating a scene, and it throws a `TychoError` whose `rule` is the broken rule.
The NumPy evaluator checks the state itself before it evaluates.
The Python runner also validates every `scene.tys` against the schema `../scene.schema.json`, when the package `jsonschema` is installed.

A _rejection_ is a broken variant of the scene, or a broken state, that a reader must reject.
The optional file `rejections.json` lists the rejections derived from `scene.tys`, and each entry of it is `{"name", "rule", "scene", "state", "frame_index"}`.

- The key `name` describes the rejection in words, and both runners show it as the name of the test.
- The key `rule` gives the name of the rule that the error must report, such as `revolutions` or `members`, as defined in `../tycho-scene.md`.
- The key `scene` is a patch merged into `scene.tys`, which turns the valid scene into the broken one.
  In the merge, objects recurse, `null` deletes a key, and any other value replaces the old one.
  An object of the patch is thus merged key by key into the object under the same key, and a list replaces the old list whole.
  An absent `scene` leaves `scene.tys` as it is, e.g. for a rejection that breaks only the state or the frame index.
- The key `state` defaults to the `initial` of the patched scene, i.e. the starting state that the scene document carries (section 2.8).
- The key `frame_index` defaults to 0.

A reader must reject the result, at load or at evaluation, with an error that reports `rule`.
The Python runner calls `evaluate` and checks that it raises a `ValueError` whose message starts with the rule and a colon, e.g. `revolutions:`.
The TypeScript runner calls `validate` and then `evaluate`, and it checks that one of them throws a `TychoError` whose `rule` is the given rule.

The field `source` records where the expected numbers come from.
The script `generate.py` in this directory writes every scene but `broucke-mini`, whose files are committed as they are.

- The value `analytic` marks numbers written by hand from a closed form, in a scene small enough to check on paper.
  The script `generate.py` computes them from closed forms that are written independently of the NumPy evaluator.
- The value `pydylan` marks positions converted between frames by PyDyLAN, the Python module of the DyLAN astrodynamics library, state by state, which tie the frame algebra of TyCHO to an independent implementation.
  The frame algebra is the chain of transforms through which TyCHO takes a position from one frame to another (section 2.3).
  State by state means that the conversion functions of PyDyLAN convert each stored sample separately.
  The `pydylan` cases are those of `broucke-mini`, whose numbers come from a PyDyLAN computation that is kept private, and they are committed as outputs so that every machine can run them.
- The value `reference` marks numbers produced by one evaluator and checked by the other, for behavior specific to TyCHO (the blend between samples, the trail, and the wrap of a periodic trajectory).
  The script `generate.py` produces them with the NumPy evaluator, and the TypeScript evaluator must reproduce them.
  Rules `segment`, `trail-wrap`, and `revolutions` define these behaviors, which do not come from a dynamical model.
  An independent source for their numbers therefore does not exist.

A scene whose data came from PyDyLAN stores float64 arrays, so that the comparison is not limited by storage.
Rounding the stored numbers to float32, the default dtype of pytycho, would cause differences far larger than the tolerance of a case.

The directory `containers/` does not hold a scene, and its files serve to check how a reader decodes the data container rather than how it evaluates a scene.
Its files `encoded.tyd` and `raw.tyd` hold the same arrays of every dtype (section 1 of `../tycho-scene.md`), where the dtype of an array is the type of its elements, e.g. `float64` or `uint8`.
The first stores them with the encodings that pytycho picks, with several chunks to an array and some arrays raw, and the second stores every array raw.
The encoding `raw` keeps the bytes of an array as they are in memory, and the encoding `shuffle-delta-deflate` compresses them in chunks of rows (rule `shuffle-delta-deflate`).
A reader passes when every array of `encoded.tyd` decodes to the same dtype, shape, and bytes as in `raw.tyd`.
The bytes are compared rather than the values, so that a decoder that alters a NaN payload, a signed zero, or a subnormal number fails.
The arrays hold such numbers for this reason.
The two checks are `tests/test_container.py` for pytycho and `web/test/container.test.ts` for the runtime.
