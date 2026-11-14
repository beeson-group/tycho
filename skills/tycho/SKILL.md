---
name: tycho
description: Write a TyCHO scene with pytycho from NumPy arrays, computed by any library, and render it as one self-contained HTML page. Use when asked to animate or visualize trajectories, orbit families, manifolds, or bodies in several reference frames, or to add a frame, a slider, a readout, or a panel to a scene. Also use when a Scene fails to write and the error names a rule.
license: Apache-2.0
metadata:
  pytycho: "0.3"
---

# Writing a TyCHO scene

TyCHO draws what it is given. A _scene_ is what one page shows, and pytycho writes it as two files, the scene document `scene.tys` and the data container `data.tyd`. A scene consists of NumPy arrays and of declarations of trajectory sets with per-sample channels, bodies, a tree of frames, inputs, one clock, panels with layers, controls, and readouts. The runtime, i.e. the browser code that pytycho inlines into the page, rotates, scales, translates, and blends linearly between two stored samples. It never integrates, never creates a sample by interpolation, and does not hold a formula of any dynamical model. Every position and every channel value therefore comes from the caller, i.e. from the script that builds the scene.

The meaning, the units, and the default of every key of a scene are given in the [scene reference](https://pytycho.readthedocs.io/en/stable/reference.html), which is generated from the descriptions in [`spec/scene.schema.json`](https://github.com/beeson-group/tycho/blob/main/spec/scene.schema.json). A keyword argument of a pytycho builder has the name of the key it writes, and its docstring is shown by `help()`. How the pieces fit, and the traps, are given below, since the reference does not state them.

## The minimal scene

The script below writes a page that shows one closed loop, stored in a rotating frame, in two panels side by side. The panel `p1` draws the loop in the rotating frame, and the panel `p2` draws it in an inertial frame, against which the rotating frame turns by the stored channel `angle`.

<!-- minimal-scene:start -->
```python
import numpy as np
import pytycho as ty

scene = ty.Scene(title="a rotating loop")
rotating = scene.frame("rotating", axes=("x", "y", "z"))
scene.frame("inertial", parent=rotating, rotation=ty.rotation("z", ty.channel("angle")))

loop = scene.trajectory_set("loop", frame=rotating, periodic=True)
angle = np.linspace(0.0, 2.0 * np.pi, 400)
loop.add(np.column_stack([np.cos(angle), 0.5 * np.sin(angle)]), channels={"angle": angle})

frame = scene.choice("frame", ["rotating", "inertial"], scope="per_panel")
scene.clock(channels=["angle", "@index"], frame_count=200)
layers = [ty.trajectories(loop), ty.trajectories(loop, 0, trail=0.3, head=True, width=2.0), ty.axes()]
scene.panel("main", frame=frame, reference=ty.reference(loop, 0), layers=layers)
scene.show("p1", panel="main", inputs={frame: "rotating"})
scene.show("p2", panel="main", inputs={frame: "inertial"})
scene.tabs(frame, label="frame")
scene.playback()
scene.write_html("loop.html")
```
<!-- minimal-scene:end -->

A builder is any call that declares a piece of the scene, e.g. `scene.frame`, `loop.add`, or `ty.trajectories`. Every builder checks its arguments at the call and raises `SceneError` with the rule it breaks. The methods `to_document()` and `write()` then check the whole scene, for every value the inputs can take, and report all failures at once. This second check covers the cross-references between the pieces and the rules that depend on the values of the inputs. The method `write_html` makes it as well, since it builds the document through `to_document()`. Each line of the report starts with the name of a rule from [`spec/tycho-scene.md`](https://github.com/beeson-group/tycho/blob/main/spec/tycho-scene.md), e.g. `transform-channels` or `panel`. Read the rule, fix the scene, and never work around a check by editing the document.

## How the pieces fit

- A _trajectory set_ holds trajectories that share a frame and a meaning, e.g. a family, a manifold, or one transfer, and `scene.trajectory_set(id, frame=, periodic=)` declares one. Its method `add(positions, channels=, parameters=)` takes one trajectory as `(m, 2)` or `(m, 3)` positions, where `m` is the number of samples and two columns mean `z = 0`. A _channel_ holds one value per sample, e.g. the time, and a _parameter_ one number per trajectory, e.g. the eccentricity of a member. Every trajectory of a set gives the same names, because the writer stores each channel and each parameter of a set as one array over all its trajectories. With `periodic=True`, the last sample is the first sample again, one period later, and the advance of a channel over one period is its last value minus its first.
- A _frame_ is a coordinate frame, declared with `scene.frame(id, parent=, origin=, rotation=, scale=)`. The frames form a tree, whose root is the one frame without a parent. The angle of `ty.rotation(axis, angle)` and the scale may read a channel of the drawn sample (`ty.channel("true_anomaly")`) or an _attribute_ of the drawn set (`ty.attr("mu")`, with `1 - ty.attr("mu")` allowed). An attribute is one number for a whole set, given in `attrs=` of `scene.trajectory_set`. An origin is three numbers, attributes, or channels, or a body. The angle is that of the parent's axes seen in the child, hence an inertial frame is declared as the child of a rotating frame, with the angle of the rotating frame. A set drawn in a frame must carry every channel and attribute that the frames on the path between the two read, which is rule `transform-channels`, and the writer reports which one is missing.
- A _body_ is a point in a frame, declared with `scene.body(id, frame=, position=)`, e.g. the primary at `[-ty.attr("mu"), 0.0, 0.0]`. A body does not have samples, hence it reads its channels and attributes at the current sample of the _reference trajectory_ of the panel (rule `sample-context`). A body in a frame that rotates by a channel thus moves with this trajectory.
- An _input_ is a value that the person at the page can change through a control, and it is a parameter, a choice, or a toggle. An input of kind parameter, `scene.parameter(id, parameter=)`, holds a value of a parameter and shows the member of each set whose value is nearest. The built-in parameter `@index` is the number of the member in its set, starting at 0. A choice, `scene.choice(id, values, scope=)`, holds one of its strings, e.g. the id of a frame, and a toggle, `scene.toggle(id)`, holds a boolean. Under `scope="per_panel"`, every shown panel keeps a separate value, which is how one declared panel serves several frames.
- The _clock_ is the time of the animation, shared by every panel, and `scene.clock(mode, channels=, frame_count=)` declares it. The first of its `channels` is the clock channel at the start, and the playback control switches among them. In mode `fraction`, one loop takes every trajectory from the first to the last value of the clock channel, which keeps members of different periods in phase. In mode `epoch`, every trajectory shows the same value of the clock channel, which runs through `range=` or follows `keyframes=` over one loop. A clock channel must be strictly monotone along every trajectory that carries it (rule `monotone-clock-channel`). A set drawn with a trail, a head, or `reveal="grow"`, or read as a reference trajectory, must carry every clock channel (rule `clock-channel-carried`), while a set drawn whole need not carry any.
- A `fraction` clock can run several _revolutions_ of every periodic trajectory per loop, e.g. `scene.clock("fraction", channels=[...], frame_count=480 * 9, revolutions=9)`. Revolution `j` is read with every channel raised by `j` periods, so that an orbit drawn in a frame that turns by the time keeps turning instead of jumping back (rule `revolutions`). The writer rejects revolutions on an `epoch` clock, and on a set that is not periodic when a trail, a head, a grow, or a reference trajectory reads it. One loop lasts `seconds=` at speed 1, and 8 seconds per revolution without it.
- A declared _panel_, `scene.panel(id, frame=, reference=, layers=, camera=)`, is one picture with its display frame (or a choice of frames), its reference trajectory `ty.reference(sets, member)`, its camera, and its layers. The layers are built with `ty.trajectories`, `ty.arrow`, `ty.inset_box`, `ty.body`, `ty.axes`, `ty.grid`, `ty.label`, and `ty.points`, and the keyword arguments of each are the keys of its layer in the reference. The argument `sets` is a set, an id, or a query `ty.by_tags(family=family_choice, branch="periapsis")`, which must not match more than one set for any value of its inputs, while a query without a match leaves the layer empty (rule `set-query`). The option `members` is `"all"`, the number of a member, a parameter input, or `ty.evenly_spaced(40)`, and the member of a reference trajectory must resolve to one trajectory (rule `members`).
- With `read_from="reference"`, a trajectories layer is transformed with the channels of the reference trajectory at its reading rather than those of its own samples (rule `read-from`). A grid stored in the rotating-pulsating frame thus breathes and turns with this frame, and its set need not carry any channel. Such a layer is redrawn on every frame index, and the static layers of a panel are kept only up to the first redrawn layer, hence list a large static family before it.
- A _shown panel_ is a declared panel on the page, with its own values of the per-panel inputs, added by `scene.show(id, panel=, inputs=)`. The shown panels are laid out in one row, unless `scene.layout` with `ty.split` arranges them otherwise, and a scene without `scene.show` and without a layout shows every declared panel.
- The _controls_ are `scene.slider(input, label=, domain=)`, `scene.tabs(choice, label=)`, `scene.toggle_control(toggle, label=)`, and `scene.playback()`. A scene without a playback control shows its initial frame index and does not animate, apart from a kiosk page written by `write_html(path, kiosk=True)`, which plays at once.
- A _readout_, `scene.readout(place, *parts)`, is text whose parts, e.g. `{"parameter": "eccentricity", "digits": 4}`, `ty.channel("time")`, or `1 - ty.attr("mu")`, are read at the reference trajectory. Its place is `"panel"`, in each shown panel, or `"caption"`, below the panels, where it is read at the first shown panel in layout order.

## The timeline

A scene for a talk moves things by the time of the loop in seconds rather than by a stored channel. Every moving value is a list of _keyframes_ `(t, v)` or `(t, v, ease)`, written with `ty.keyframes(...)`, and `ty.fade(on, off, duration=)` writes an opacity that rises and falls.

- An `epoch` clock takes `keyframes=` in place of `range=`, so that the mission time pauses, speeds up, or eases (rule `clock-keyframes`), and `end="stop"` holds the last frame index, as a video does.
- A layer takes `clock=ty.layer_clock(channel, keyframes=...)` to read its set on a channel of its own, e.g. a cloud grown backward in time beside a transfer drawn whole (rule `layer-clock`). Its set then carries this channel instead of the clock channels of the scene.
- A 2d camera takes `"keyframes": [ty.camera_keyframe(at, width=, center=), ty.camera_keyframe(at, width=, follow=[ty.follow(layer_index, member)]), ...]` (rule `camera-keyframes`). A window computed by the caller, e.g. a smoothed percentile box, becomes keyframes sampled every few frame indices.
- The parts `ty.clock_value()`, `ty.clock_time()`, `ty.keyframed_number(...)`, and `ty.timed_text((t, text), ...)` show the clock, a counter, or a caption that changes over the timeline, in a readout, a label, or an overlay (`scene.text`, `scene.legend`) (rule `timeline-parts`).
- `scene.step(id, at)` names the times a presentation stops at, and the viewer element plays to them with `playTo`, `next`, and `previous` (rule `steps`).

## Thinning

Thinning drops stored samples of a set to make the page smaller, and it never creates a sample. The call `trajectory_set.thin(n, frames=[...])` keeps at most `n` samples per trajectory at equal steps of arclength, where each step counts with its largest length, relative to the extent of the set, over the listed frames. Give it every frame the set will be drawn in, so that a flyby stays resolved where it is seen. The call `thin(tolerance=...)` runs Douglas-Peucker relative to the extent, and `keep=` forces indices, e.g. thrust switches or epochs. Both endpoints and every forced index are always kept. Thin after the last `add`, since `add` raises on a set that is already thinned.

## Where the channels come from

Take every quantity that a frame reads from the library that computed the trajectory, per sample, and never from a formula in the script. Every number on screen then comes from this library, because the runtime only rotates, scales, translates, and blends what it is given. In the elliptic restricted three-body problem the independent variable is the true anomaly. Store it as a channel, together with the pulsation scale `rho`, the distance between the primary and the secondary, and the elapsed time, as [`examples/broucke/build.py`](https://github.com/beeson-group/tycho/blob/main/examples/broucke/build.py) reads them from its input. In the circular restricted three-body problem in nondimensional units, the angle between the rotating frame and an inertial frame equals the time, hence the time channel is the inertial angle.

## Checking a scene

In a test, validate the document from `scene.to_document()` against [`spec/scene.schema.json`](https://github.com/beeson-group/tycho/blob/main/spec/scene.schema.json). The function `pytycho.evaluate(document, container, state, frame_index)` returns every drawn position for a frame index, the same answer that the browser draws, hence a test can assert what a scene draws. Its `container` is e.g. the bytes from `scene.to_container()`, and its `state` is e.g. `document["initial"]`, the state in which the page opens. The method `write_html` returns the size of every array and of the page, in bytes as stored. A three-component position stored as float32 costs 12 bytes a sample before compression, a planar one 8, and each channel 4 more.
