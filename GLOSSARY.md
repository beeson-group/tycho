# Glossary

The words used in TyCHO in a narrower sense than in everyday English, and the words coined for TyCHO, are defined here, each with one meaning across pytycho, the runtime, the schema, and the docs. An entry is added the moment a term is settled, hence the file grows as terms are settled, and the names in the code are chosen after it. Before a word is coined, the word that astrodynamics, NumPy, matplotlib, Plotly, or everyday English already has is used instead.

## Attribute

One number of a whole trajectory set, such as the mass ratio of the system in which every member was computed.

Avoid "parameter", which is one number per trajectory.

## Caption

The strip below the panels in which a readout may be shown.

## Channel

A quantity stored at every sample of a trajectory, such as the time or the true anomaly.

Avoid "time history" and "attribute".

## Choice

An input that holds one of a list of strings, such as the name of a frame or of a colormap.

## Clock

The time of the animation, which is shared by every panel, so that all panels move together.

## Clock channel

The channel of the trajectories whose value is read as the time of the animation. A scene may offer several, and the person at the page switches among them with the playback control.

Avoid "active channel" and "independent variable".

## Clock mode

How the clock places each trajectory. In mode "fraction", every trajectory runs from its first to its last sample in one loop, whatever its period. In mode "epoch", every trajectory shows the same value of the clock channel, which is usually a time.

Avoid "value" for the mode "epoch".

## Convention

A rule of TyCHO that is followed by default and may be argued with, as opposed to a hard invariant.

## Data container

The binary file `data.tyd`, in which the named, typed arrays of a scene are stored.

Avoid "data file" and "view" for an array of the container.

## Display frame

The frame in which a panel draws.

## Domain

The trajectory sets over which a slider ranges, whose values of the slider's parameter are the values at which the slider stops.

## Evaluator

The pure function that returns what each panel draws at a frame index. One evaluator is written in Python and one in TypeScript, and both are held to the answers of the conformance corpus.

## Feature

A named part of the scene format that a scene declares in its `requires` list, so that a reader that does not implement the part rejects the scene.

## Frame

A reference frame, i.e. the coordinate system in which positions are expressed, such as the rotating frame of the restricted three-body problem.

Avoid "frame" and "animation frame" for an instant of the animation, which is a frame index.

## Frame count

The number of frame indices in one loop.

Avoid "steps" and "frames".

## Frame index

The integer number of an instant of the animation. Two indices that differ by a whole loop are the same instant.

Avoid "animation frame", "step", and "tick".

## Hard invariant

A rule of TyCHO that is never traded away for another goal, and that an agent does not break without asking first. The hard invariants are listed at the top of `AGENTS.md`.

## Input

A value that the person at the page can change, such as the member shown or whether a layer is visible. An input is of kind parameter, choice, or toggle, and it is either shared by every panel or held per panel.

Avoid "variable", "selector", and "state" for an input.

## Kernel

The Gaussian falloff with which a highlight also brightens the members whose parameter values are close to the value of the highlighted member.

## Keyframe

A value given at a time of the timeline, together with the easing toward the next keyframe. A value that moves along the timeline is given as a list of keyframes.

Avoid "key", "tween", "shot", and "camera key".

## Layer clock

A clock of one layer, by which the layer reads its own channel rather than the clock channel of the scene.

## Loop

One cycle of the animation, after which the frame index starts over.

Avoid "loop" for a periodic trajectory.

## Member

One trajectory of a trajectory set, as an orbit is a member of a family.

## Page

The one HTML file that a user shares, in which a scene and the runtime are embedded, and which works offline.

Avoid "visualization", "demo", "deliverable", and "bundle".

## Panel

One picture on the page, with its own display frame, camera, reference trajectory, and layers.

Avoid "view", "plot", and "subplot".

## Panel area

The part of the page in which the panels are laid out.

Avoid "stage".

## Parameter

One number per trajectory, such as the Jacobi constant of each member of a family. An input of kind parameter holds a value of a parameter, and the member whose value is nearest is shown. The built-in parameter `@index` is the number of the member in its set.

Avoid "selector".

## Part

One item of the list from which the text of a readout or a label is built, such as a fixed string or the value of a channel.

## Place

Where a readout is shown, either in a panel or in the caption.

## Playback

The control that plays and pauses the clock and switches the clock channel.

Avoid "transport".

## Readout

A text that shows current values, such as the time or the Jacobi constant of the member shown.

## Reference trajectory

The one trajectory that a panel follows, at whose current sample the bodies and the readouts of the panel are placed and read.

Avoid "driver" and "context".

## Revolution

One traversal of a periodic trajectory. A loop may run several revolutions of every periodic trajectory.

Avoid "lap" and "period", which is the duration of one revolution.

## Runtime

The JavaScript that draws a scene in the browser, which is embedded in every page and published on npm as `@beeson-group/tycho`.

## Sample

One stored point of a trajectory, with the value of every channel at this point.

## Scene

What is shown on a page, as described by the scene document `scene.tys` and the data container `data.tyd`.

## Scene document

The JSON file `scene.tys`, in which what is drawn from the arrays of the data container, and how, is described.

## Slider

The control that sets an input of kind parameter, and that stops at the values of the parameter in its domain.

## Step

A named time of the timeline at which a presentation stops, so that one click of the presenter plays the animation to the next step. The word is used in the same sense in the slides template.

Avoid "stage" and "chapter".

## Tabs

The control that sets a choice, with one tab per value.

## Tag

A string that labels a whole trajectory set, by which a set is found among others.

## Toggle

An input that holds true or false, and the control, drawn as a checkbox, that sets it.

## Trajectory

One computed trajectory, stored as a sequence of samples.

Avoid "track", "trace", and "curve".

## Trajectory set

Trajectories that share a frame and a meaning, such as a family of periodic orbits, a manifold, or a grid of initial conditions.

Avoid "track set" and "family" for a set that is not a family.

## View

What the camera of a panel shows, which the person at the page may move, reset, or hand back to the keyframes of the timeline.

Avoid "view" for a panel or for an array of the data container.

## Viewer

The `<tycho-viewer>` element, in which a scene is shown on a page.
