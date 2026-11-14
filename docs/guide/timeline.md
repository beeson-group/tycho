# The timeline

The timeline is the time of a loop in seconds, at playback speed 1.
At the progress `q` through the loop it is `s = q * L`, where `L` is the length of the loop, i.e. the `seconds` of the clock, or 8 seconds a revolution without it ([the clock](clock.md)).
A scene that tells a story, e.g. a video for a talk, moves things by this time rather than by a stored channel: the camera zooms in after seven seconds, a caption changes at the start of each part of the story, a cloud of trajectories fades out.
Section 2.11 of the [spec](../spec.md) defines these motions by _keyframes_, i.e. values at times of the timeline, and this page shows how pytycho writes them.
Every number on the page still comes from the caller, and the runtime only blends between keyframes.

## Keyframes and eases

A keyframe is `(t, v)` or `(t, v, ease)`, where `t` is a time in seconds, `v` a number, and `ease` names how the value travels to `v` from the keyframe before (rules `keyframes` and `ease`).
The function {func}`pytycho.keyframes` collects keyframes into a keyframed value, i.e. the value that the keyframes give at each time.

```python
opacity = ty.keyframes((7.0, 0.0), (7.5, 1.0, "smooth"), (14.5, 1.0), (15.1, 0.0, "smooth"))
```

Before the first keyframe the value is the first keyframe's, and after the last keyframe the last keyframe's.
Between two keyframes it runs from the earlier value to the later one by the ease of the later keyframe: `linear`, the default, `smooth` (smoothstep, `x * x * (3 - 2 * x)`), `in`, `out`, and `in-out` (cubic), or `hold`, which keeps the earlier value until the later keyframe's time.
Two keyframes at one time make a jump.
The function {func}`pytycho.fade` writes the most common keyframed value, an opacity that rises at one time and, optionally, falls at another, `ty.fade(7.0, 14.5, duration=0.5)`.

The opacity of every layer, of a head or a marker, of a declared panel, and of an overlay may be a keyframed value, and so may the size of a marker, e.g. a marker that pops to twice its size and settles.
A declared panel's opacity fades its shown panels as a whole.
A split of the layout may carry `keyframes`, a keyframed value of its ratio, through {func}`pytycho.split`, so that a panel opens beside another one, or closes.
These motions are for drawing only, and the evaluator does not read them.

## Clocks with keyframes

A clock in epoch mode can take `keyframes` in place of a `range` (rule `clock-keyframes`).
Its clock channel then takes the value of the keyframed value, which lets the clock pause, run at several speeds, and ease in and out.

```python
scene.clock(
    "epoch",
    channels=["t"],
    frame_count=570,
    seconds=19.0,
    end="stop",
    keyframes=ty.keyframes((1.0, 0.0), (7.0, t_fail), (8.0, t_fail), (13.0, t_resume)),
)
```

Here the mission time `t` stands still for the first second, runs to the outage in six, holds for one while the outage is flagged, and runs on to the end of the coast.
With `end="stop"`, playback holds the end of the loop rather than starting the next, as a video does.

A trajectories, arrow, points, or label layer can carry a clock of its own, {func}`pytycho.layer_clock`, on a channel of its set (rule `layer-clock`).
It then reads its trajectories in epoch mode on that channel, whatever the scene's clock does.
Different layers can thus run on different channels and at different times, e.g. a cloud that grows backward in a backward time `tau` while the transfer it came from stays whole, or a costate history in days beside a trajectory in canonical time units.
The layer's set carries the layer's channel, and rule `monotone-clock-channel` holds for it.

```python
ty.trajectories(cloud, reveal="grow", clock=ty.layer_clock("tau", keyframes=ty.keyframes((16.1, 0.0), (28.1, tau_end, "smooth"))))
```

## Cameras with keyframes

A 2d camera can carry `keyframes`, a list of camera keyframes written by {func}`pytycho.camera_keyframe` (rule `camera-keyframes`).
A camera keyframe gives the window the panel shows at its time: its center, two coordinates in the camera's plane, and its width in units of the display frame.
Its height follows from the panel's aspect ratio, or is given under `"aspect": "free"`.
Between two camera keyframes the camera moves by the later keyframe's ease.
The center moves linearly and the width geometrically, so that a zoom by a factor runs at a steady rate, as a real camera zooms.

A camera keyframe may follow moving points instead of a fixed center.
Each target, {func}`pytycho.follow`, is a member of a trajectories layer of the same declared panel, given by the index of the layer in the panel's `layers`, and the keyframe's center is the mean of the targets' current points, plus an `offset`.
Both keyframes of a blend are taken at the current time, hence a blend from a fixed window into a following keyframe ends on the moving point.

```python
follow = [ty.follow(spacecraft_layer, 0), ty.follow(ghost_layer, 0)]
camera = {
    "kind": "2d",
    "keyframes": [
        ty.camera_keyframe(7.0, width=1.8, center=(0.30, -0.05)),
        ty.camera_keyframe(8.3, width=0.5, follow=follow),
        ty.camera_keyframe(13.0, width=0.3, follow=follow, ease="linear"),
        ty.camera_keyframe(14.5, width=0.3, follow=follow, ease="linear"),
        ty.camera_keyframe(16.5, width=1.8, center=(0.30, -0.05)),
    ],
}
```

The camera shows the full transfer, zooms onto the midpoint of the spacecraft and the ghost that keeps flying the nominal, closes in as the two separate, and pulls back out.
A camera whose window comes from a computation of the caller, e.g. a percentile box of a cloud smoothed over time, is written as camera keyframes sampled every few frame indices.
The evaluator returns the window of a camera with keyframes for each panel, under the key `camera`, so that a test can check it.
When the person at the page pans or zooms a panel, the camera stays where it was left while the scene plays on, and the panel shows a button, Timeline view, which returns it to its keyframes, as the key `F` does for every panel.
Neither playing nor a step of a presentation returns it by itself.

## Labels, points, and overlays

A label layer, {func}`pytycho.label`, writes a text at an anchor (rule `label`): a point of the display frame ({func}`pytycho.at_point`), a point of another frame that moves with the reference trajectory, the current point of a member ({func}`pytycho.at_member`), or a fixed place in the panel ({func}`pytycho.at_screen`).
The text is drawn `offset` CSS pixels from the anchor, with an optional leader from the anchor and a box behind it.

```python
ty.label(
    "spacecraft",
    ty.at_member(outage, 0),
    offset=(-19, -19),
    align="end",
    baseline="bottom",
    size=21,
    box={"fill": "#ffffff", "opacity": 0.85},
    opacity=ty.fade(7.0, 14.5, duration=0.4),
)
```

The text of a label, a readout, or an overlay is a list of parts.
Beside the parts of a readout, it takes the shared value of the clock, {func}`pytycho.clock_value`, the time of the timeline, {func}`pytycho.clock_time`, the keyframed value of a number, {func}`pytycho.keyframed_number`, e.g. a counter that runs from 0 to 1000 during a sampling phase, and a text that changes at given times, {func}`pytycho.timed_text`, i.e. a caption in parts (rule `timeline-parts`).
A part that gives a number can carry `decimals`, `grouping` (commas between the thousands), `factor`, and `offset`.

```python
scene.text(
    ty.timed_text((0.0, "Nominal transfer"), (3.6, "Sample terminal conditions"), (11.4, "Correct the costates")),
    at=(0.975, 0.04),
    align="end",
    size=24,
)
scene.text(
    ["samples: ", ty.keyframed_number((4.4, 0), (9.0, 5), (11.0, 1000), decimals=0, grouping=True), " / 1,000"],
    at=(0.975, 0.09),
    align="end",
)
```

A points layer, {func}`pytycho.points`, draws the stored samples of its members as markers, e.g. a scatter of terminal states, and with `reveal="grow"` the samples appear one after another as the clock passes them (rule `points`).
A marker, {func}`pytycho.marker`, has a shape (`disc`, `ring`, `square`, `diamond`, `triangle`, `star`, `cross`, or `plus`), a size, a fill, and an edge.
The head of a trajectories layer takes the same form, and a head can glow while a channel of its member is positive, e.g. while the thruster fires.

Overlays are texts and legends drawn over the whole panel area rather than in one panel, placed at fractions of the width and the height of the panel area, with {meth}`Scene.text <pytycho.Scene.text>` and {meth}`Scene.legend <pytycho.Scene.legend>`.
A legend entry, {func}`pytycho.entry`, shows a line, a marker, or a row of colors beside its label.

## Plots and figures

A trajectories layer can be dashed, filled down to a base value, and colored by thresholds of a channel, e.g. thrust red where the switching function is positive and coast black elsewhere, with {func}`pytycho.threshold_color`.
With `group_opacity=True`, a translucent layer blends each pixel that its lines cover once, as one translucent path of a plot does, so that a cloud of a thousand lines at opacity 0.2 keeps one shade where they overlap and tints an orbit beneath it rather than hiding it.
An axes layer with `span="box"` draws a box around the plot, with ticks pointing out and tick numbers and titles outside it, as a plot does.
A declared panel's `margin` keeps a part of its panel free of the camera, as fractions of the panel, so that the tick numbers have room and a band at the top is left for a legend.
With these, a scene can follow the layout of a matplotlib figure: each axes of the figure becomes a panel whose margin places the plot where the axes were.
A body can carry an image, e.g. a photograph of the Earth, drawn in place of its disc at a fixed size in CSS pixels.

## Steps and presentations

A scene can name times of its timeline as steps, with {meth}`Scene.step <pytycho.Scene.step>`, e.g. one step per click on a slide (rule `steps`).
The viewer element then plays from step to step: `playTo(step)` plays from the time shown and pauses at the step, `next()` and `previous()` move through the steps, `goto(step)` shows a step paused, and `seek(t)` shows any time paused.
It fires the event `tycho-step` when playback reaches a step.
A slide deck that advances a scene one step per click calls `next()` on each click ([JavaScript API](../api/javascript.md)).
