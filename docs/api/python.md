# Python API

Everything required to build a scene is importable from the top-level package, as `import pytycho as ty`.
The builders are the methods of `Scene` that declare the parts of a scene.
Those that declare a frame, a body, a trajectory set, or an input return a handle, i.e. a small object that stands for a reference in the written document.
Where a handle is passed to another declaration, the document holds the reference in its place, i.e. the id of a frame or a body, `{"set": id}` for a trajectory set, or `{"input": id}` for an input.
The handles are documented under {mod}`pytycho.scene`, apart from `TrajectorySet`, which is documented with the package.
The [guide](../guide/index.md) explains each concept with examples.

## pytycho

The top-level package exports the `Scene` builder, the functions that build the parts of a declaration (e.g. layers, set queries, and scalars), the data container, the evaluator, and the page writer.

```{eval-rst}
.. automodule:: pytycho
   :members:
   :member-order: groupwise
```

## Handles and scalars

Besides the handles `Frame`, `Body`, and `Input`, this module documents `Channel` and `Attr`, the scalars that `ty.channel` and `ty.attr` return.
Either scalar gives a number that depends on context, i.e. it is read from the trajectory set or from the sample being evaluated (section 2.2 of the spec).
The class `Rotation`, which `ty.rotation` returns, turns a frame against its parent about one axis.

```{eval-rst}
.. automodule:: pytycho.scene
   :members: Frame, Body, Input, Channel, Attr, Rotation
   :member-order: bysource
```

## The data container

The classes `Container` and `ContainerWriter` are documented with the package above.
This module also documents the error raised for a container that breaks one of the rules `array-dtype`, `array-keys`, `container-version`, `c-order`, and `shuffle-delta-deflate`, the function that returns an array as it would be stored, and the table of stored dtypes.

```{eval-rst}
.. automodule:: pytycho.container
   :members: ContainerError, stored_array, DTYPES
   :member-order: bysource
```

## The page

The function `runtime_js` returns the bundled browser runtime, i.e. the JavaScript that every page inlines.

```{eval-rst}
.. automodule:: pytycho.html
   :members: runtime_js
```
