# Guide

A TyCHO scene consists of NumPy arrays and declarations. A track is one trajectory, i.e. a sequence of samples, where each sample is one stored point of the trajectory. The arrays hold the positions, one value per sample for each channel, and one number per track for each parameter. A channel is a quantity stored with every sample, e.g. the time or the true anomaly, and a parameter is a quantity of a whole track, e.g. its period. The declarations specify what the arrays are and how they are drawn. They declare the parts below, and each part has a page in this guide.

- Track sets collect tracks that share a frame and a meaning, e.g. a family of periodic orbits ([track sets and channels](track-sets.md)).
- Frames are the coordinate frames in which positions are stored and drawn, and they form one tree ([frames and contexts](frames.md)).
- Bodies are named points such as the primary and the secondary ([bodies and drivers](bodies.md)).
- Variables hold the state that a person viewing the page changes, e.g. the chosen family ([variables and references](variables.md)).
- One clock gives the animation time that every panel shares ([the clock](clock.md)).
- Views come with layers. A view is the template of one picture, and each layer draws one thing in it ([views and layers](views.md)).
- Panels are the pictures on the page, each showing one view. Controls are the widgets that change variables, and readouts are the text that shows current values ([panels, controls, and readouts](panels.md)).
- The timeline moves cameras, captions, labels, and fades by the time of the video rather than by a stored channel, and names the stages of a presentation ([the timeline](timeline.md)).

The Python package pytycho writes the scene as two files, `scene.tys` for the declarations and `data.tyd` for the arrays. The browser runtime, i.e. the TypeScript program that pytycho inlines into the HTML page it writes, draws the scene. Two further pages cover thinning, i.e. keeping a subset of the stored samples of each track, and the HTML page with its video export.

The runtime only moves and blends stored points. It rotates, scales, and translates them from one frame to another, and it blends linearly between two stored samples. It never integrates, never creates a sample by interpolation, and does not hold the formula of any dynamical model. Every position and every channel value comes from the caller, i.e. from the script that builds the scene.

## How a scene fails

A builder is a method or a function of pytycho that declares a part of the scene, e.g. `scene.frame(...)` or `ty.track(...)`. Every builder checks its arguments at the call and raises {class}`~pytycho.SceneError`, whose message gives the broken rule. Other checks depend on the whole scene and require every declaration at once. These are the cross-references, i.e. the names by which one declaration refers to another (e.g. a view referring to a track set), and the rules that must hold for every value the variables can take. They are made by {meth}`~pytycho.Scene.to_document`, which {meth}`~pytycho.Scene.write` and {meth}`~pytycho.Scene.write_html` call first. This method reports every failure at once, one line each, and each line starts with the rule, or the section, of the [spec](../spec.md).

Suppose that the [minimal scene](../quickstart.md) stores its channel as `theta` instead of `angle`, while its inertial frame still turns by `ty.channel("angle")`. Suppose as well that its clock runs on `@index` alone, i.e. on the stored sample index, which every track has. The scene then fails with the error below. The change of clock leaves only rule F5 in the report, since a clock running on `angle` would require this channel on the set as well (rule C5).

```text
pytycho.scene.SceneError: the scene breaks these rules:
  F5: view 'main' with {'frame': 'inertial'}: track set 'loop' lacks ['angle'] for its tracks in frame 'inertial'
  F5: view 'main' with {'frame': 'inertial'}: track set 'loop' lacks ['angle'] for the driver in frame 'inertial'
```

Rule F5 requires a track set to carry every channel that is read by the edges between its frame and the frame it is drawn in. An edge is the link from a parent frame to a child frame ([frames and contexts](frames.md)). The first line concerns the tracks that a layer draws, and the second concerns the driver, i.e. the track that the view follows ([bodies and drivers](bodies.md)).

The view is valid in the rotating frame, where the set is stored, since drawing there does not cross any edge. In the inertial frame it is not valid, because the edge into this frame reads `angle`. The message gives the value of the `frame` choice for which the rule breaks, `{'frame': 'inertial'}`, since the view is checked once for every value of this choice.

Read the rule in the spec and fix the scene. Do not work around a check by editing the written document `scene.tys`, since the runtime enforces the same rules and rejects the scene.

## The concepts

The pages below take the concepts one at a time.

```{toctree}
:maxdepth: 1

track-sets
frames
bodies
variables
clock
views
panels
timeline
thinning
html
```
