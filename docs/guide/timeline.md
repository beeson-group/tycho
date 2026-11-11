# The timeline

The timeline is the time of a loop in seconds, at playback speed 1. At the progress `q` through the loop it is `s = q * L`, where `L` is the length of the loop, i.e. the `seconds` of the clock, or 8 seconds a lap without it ([the clock](clock.md)). A scene that tells a story, e.g. a video for a talk, moves things by this time rather than by a stored channel: the camera zooms in after seven seconds, a caption changes at the start of each step, a cloud of tracks fades out. Section 2.11 of the [spec](../spec.md) defines these motions by _keys_, i.e. values at times of the timeline, and this page shows how pytycho writes them. Every number on the page still comes from the caller, and the runtime only blends between keys.

## Keys and eases

A key is `(t, v)` or `(t, v, ease)`, where `t` is a time in seconds, `v` a number, and `ease` names how the value travels to `v` from the key before (rules K1 and K2). The function {func}`pytycho.tween` collects keys into a tween, i.e. the value the keys give at each time.

```python
opacity = ty.tween((7.0, 0.0), (7.5, 1.0, "smooth"), (14.5, 1.0), (15.1, 0.0, "smooth"))
```

Before the first key the value is the first key's, and after the last key the last key's. Between two keys it runs from the earlier value to the later one by the ease of the later key: `linear`, the default, `smooth` (smoothstep, `x * x * (3 - 2 * x)`), `in`, `out`, and `in-out` (cubic), or `hold`, which keeps the earlier value until the later key's time. Two keys at one time make a jump. The function {func}`pytycho.fade` writes the most common tween, an opacity that rises at one time and, optionally, falls at another, `ty.fade(7.0, 14.5, duration=0.5)`.

The opacity of every layer, of a head or a marker, of a view, and of an overlay may be a tween, and so may the size of a marker, e.g. a marker that pops to twice its size and settles. A view's opacity fades its panels as a whole. A split of the layout may carry `keys`, a tween of its ratio, through {func}`pytycho.split`, so that a panel opens beside another one, or closes. These motions are for drawing only, and the evaluator does not read them.

## Clocks with keys

A clock in value mode can take `keys` in place of a `range` (rule K3). Its active channel then takes the value of the tween, which lets the clock pause, run at several speeds, and ease in and out.

```python
scene.clock(
    "value", channels=["t"], steps=570, seconds=19.0, end="stop", keys=ty.tween((1.0, 0.0), (7.0, t_fail), (8.0, t_fail), (13.0, t_resume))
)
```

Here the mission time `t` stands still for the first second, runs to the outage in six, holds for one while the outage is flagged, and runs on to the end of the coast. With `end="stop"`, playback holds the end of the loop rather than starting the next, as a video does.

A track, arrow, points, or label layer can carry a clock of its own, {func}`pytycho.layer_clock`, on a channel of its set (rule K4). It then reads its tracks in value mode on that channel, whatever the scene's clock does. Different layers can thus run on different channels and at different times, e.g. a cloud that grows backward in a backward time `tau` while the transfer it came from stays whole, or a costate history in days beside a trajectory in canonical time units. The layer's set carries the layer's channel, and rule T3 holds for it.

```python
ty.track(cloud, reveal="grow", clock=ty.layer_clock("tau", keys=ty.tween((16.1, 0.0), (28.1, tau_end, "smooth"))))
```

## Cameras with keys

A plane camera can carry `keys`, a list of camera keys written by {func}`pytycho.shot` (rule K5). A key gives the window the panel shows at its time: its center, two coordinates in the camera's plane, and its width in units of the display frame. Its height follows from the panel's aspect ratio, or is given under `"aspect": "free"`. Between two keys the camera moves by the later key's ease. The center moves linearly and the width geometrically, so that a zoom by a factor runs at a steady rate, as a real camera zooms.

A key may follow moving points instead of a fixed center. Each target, {func}`pytycho.follow`, is a member of a track layer of the same view, given by the index of the layer in the view's `layers`, and the key's center is the mean of the targets' current points, plus an `offset`. Both keys of a blend are taken at the current time, hence a blend from a fixed window into a follow key ends on the moving point.

```python
follow = [ty.follow(spacecraft_layer, 0), ty.follow(ghost_layer, 0)]
camera = {
    "kind": "plane",
    "keys": [
        ty.shot(7.0, width=1.8, center=(0.30, -0.05)),
        ty.shot(8.3, width=0.5, follow=follow),
        ty.shot(13.0, width=0.3, follow=follow, ease="linear"),
        ty.shot(14.5, width=0.3, follow=follow, ease="linear"),
        ty.shot(16.5, width=1.8, center=(0.30, -0.05)),
    ],
}
```

The camera shows the full transfer, zooms onto the midpoint of the spacecraft and the ghost that keeps flying the nominal, closes in as the two separate, and pulls back out. A camera whose window comes from a computation of the caller, e.g. a percentile box of a cloud smoothed over time, is written as keys sampled every few frames. The evaluator returns the window of a camera with keys for each panel, under the key `camera`, so that a test can check it. When the viewer pans or zooms a panel, the camera stays where it was left until it is fitted again, e.g. with the key `f`, which returns it to its keys.

## Labels, points, and overlays

A label layer, {func}`pytycho.label`, writes a text at an anchor (rule K6): a point of the display frame ({func}`pytycho.at_point`), a point of another frame that moves with the driver, the current point of a member ({func}`pytycho.at_member`), or a fixed place in the panel ({func}`pytycho.at_screen`). The text is drawn `offset` CSS pixels from the anchor, with an optional leader from the anchor and a box behind it.

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

The text of a label, a readout, or an overlay is a list of parts. Beside the parts of a readout, it takes the shared value of the clock, {func}`pytycho.clock_value`, the time of the timeline, {func}`pytycho.clock_time`, the value of a tween, {func}`pytycho.keyed`, e.g. a counter that runs from 0 to 1000 during a sampling step, and a text that changes at given times, {func}`pytycho.steps`, i.e. a staged caption (rule K7). A part that gives a number can carry `decimals`, `grouping` (commas between the thousands), `factor`, and `offset`.

```python
scene.text(
    ty.steps((0.0, "Nominal transfer"), (3.6, "Sample terminal conditions"), (11.4, "Correct the costates")),
    at=(0.975, 0.04),
    align="end",
    size=24,
)
scene.text(["samples: ", ty.keyed((4.4, 0), (9.0, 5), (11.0, 1000), decimals=0, grouping=True), " / 1,000"], at=(0.975, 0.09), align="end")
```

A points layer, {func}`pytycho.points`, draws the stored samples of its members as markers, e.g. a scatter of terminal states, and with `reveal="grow"` the samples appear one after another as the clock passes them (rule K8). A marker, {func}`pytycho.marker`, has a shape (`disc`, `ring`, `square`, `diamond`, `triangle`, `star`, `cross`, or `plus`), a size, a fill, and an edge. The head of a track layer takes the same form, and a head can glow while a channel of its member is positive, e.g. while the thruster fires.

Overlays are texts and legends drawn over the whole stage rather than in one panel, placed at fractions of the stage's width and height, with {meth}`Scene.text <pytycho.Scene.text>` and {meth}`Scene.legend <pytycho.Scene.legend>`. A legend entry, {func}`pytycho.entry`, shows a line, a marker, or a row of colors beside its label.

## Plots and figures

A track layer can be dashed, filled down to a base value, and colored in steps of a channel, e.g. thrust red where the switching function is positive and coast black elsewhere, with {func}`pytycho.steps_color`. An axes layer with `span="box"` draws a box around the plot, with ticks pointing out and tick numbers and titles outside it, as a plot does. A view's `margin` keeps a part of its panel free of the camera, as fractions of the panel, so that the tick numbers have room and a band at the top is left for a legend. With these, a scene can follow the layout of a matplotlib figure: each axes of the figure becomes a panel whose margin places the plot where the axes were. A body can carry an image, e.g. a photograph of the Earth, drawn in place of its disc at a fixed size in CSS pixels.

## Stages and presentations

A scene can name times of its timeline as stages, with {meth}`Scene.stage <pytycho.Scene.stage>`, e.g. one stage per click on a slide (rule K9). The viewer element then plays from stage to stage: `playTo(stage)` plays from the time shown and pauses at the stage, `next()` and `previous()` step through the stages, `goto(stage)` shows a stage paused, and `seek(t)` shows any time paused. It fires the event `tycho-stage` when playback reaches a stage. A slide deck that advances a scene one stage per click calls `next()` on each click ([JavaScript API](../api/javascript.md)).
