# Guide

A TyCHO scene consists of NumPy arrays and declarations.
A trajectory is a sequence of samples, where each sample is one stored point of the trajectory.
The arrays hold the positions, one value per sample for each channel, and one number per trajectory for each parameter.
A channel is a quantity stored with every sample, e.g. the time or the true anomaly, and a parameter is a quantity of a whole trajectory, e.g. its period.
The declarations specify what the arrays are and how they are drawn.
They declare the parts below, and each part has a page in this guide.

- Trajectory sets collect trajectories that share a frame and a meaning, e.g. a family of periodic orbits ([trajectory sets and channels](track-sets.md)).
- Frames are the coordinate frames in which positions are stored and drawn, and they form one tree ([frames and contexts](frames.md)).
- Bodies are named points such as the primary and the secondary ([bodies and reference trajectories](bodies.md)).
- Inputs hold the values that the person at the page changes, e.g. the chosen family ([inputs and references](variables.md)).
- One clock gives the animation time that every panel shares ([the clock](clock.md)).
- Declared panels come with layers.
  A declared panel describes one picture, and each layer draws one thing in it ([panels and layers](views.md)).
- Shown panels are the pictures on the page, each showing one declared panel.
  Controls are the widgets that change inputs, and readouts are the text that shows current values ([panels, controls, and readouts](panels.md)).
- The timeline moves cameras, captions, labels, and fades by the time of the video rather than by a stored channel, and names the steps of a presentation ([the timeline](timeline.md)).

The Python package pytycho writes the scene as two files, `scene.tys` for the declarations and `data.tyd` for the arrays.
The browser runtime, i.e. the TypeScript program that pytycho inlines into the HTML page it writes, draws the scene.
Two further pages cover thinning, i.e. keeping a subset of the stored samples of each trajectory, and the HTML page with its video export.

The runtime only moves and blends stored points.
It rotates, scales, and translates them from one frame to another, and it blends linearly between two stored samples.
It never integrates, never creates a sample by interpolation, and does not hold the formula of any dynamical model.
Every position and every channel value comes from the caller, i.e. from the script that builds the scene.

## How a scene fails

A builder is a method or a function of pytycho that declares a part of the scene, e.g. `scene.frame(...)` or `ty.trajectories(...)`.
Every builder checks its arguments at the call and raises {class}`~pytycho.SceneError`, whose message gives the broken rule.
Other checks depend on the whole scene and require every declaration at once.
These are the cross-references, i.e. the names by which one declaration refers to another (e.g. a panel referring to a trajectory set), and the rules that must hold for every value the inputs can take.
They are made by {meth}`~pytycho.Scene.to_document`, which {meth}`~pytycho.Scene.write` and {meth}`~pytycho.Scene.write_html` call first.
This method reports every failure at once, one line each, and each line starts with the rule, or the section, of the [spec](../spec.md).

Suppose that the [minimal scene](../quickstart.md) stores its channel as `theta` instead of `angle`, while its inertial frame still turns by `ty.channel("angle")`.
Suppose as well that its clock runs on `@index` alone, i.e. on the stored sample index, which every trajectory has.
The scene then fails with the error below.
The change of clock leaves only rule `transform-channels` in the report, since a clock running on `angle` would require this channel on the set as well (rule `clock-channel-carried`).

```text
pytycho.scene.SceneError: scene: the scene breaks these rules:
  transform-channels: panel 'main' with {'frame': 'inertial'}: trajectory set 'loop' lacks ['angle'] for the reference trajectory in frame 'inertial'
  transform-channels: panel 'main' with {'frame': 'inertial'}: trajectory set 'loop' lacks ['angle'] for its trajectories in frame 'inertial'
```

Rule `transform-channels` requires a trajectory set to carry every channel that is read by the transforms between its frame and the frame it is drawn in.
A transform is the map from a parent frame to a child frame ([frames and contexts](frames.md)).
The first line concerns the reference trajectory, i.e. the trajectory that the panel follows ([bodies and reference trajectories](bodies.md)), and the second concerns the trajectories that a layer draws.

The panel is valid in the rotating frame, where the set is stored, since drawing there does not cross any transform.
In the inertial frame it is not valid, because the transform into this frame reads `angle`.
The message gives the value of the `frame` choice for which the rule breaks, `{'frame': 'inertial'}`, since the panel is checked once for every value of this choice.

Read the rule in the spec and fix the scene.
Do not work around a check by editing the written document `scene.tys`, since the runtime enforces the same rules and rejects the scene.

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
