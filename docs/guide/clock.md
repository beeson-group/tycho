# The clock

The clock is the animation time of a scene, i.e. one reading shared by every panel, hence all panels move together. Every scene declares one clock, and only one, with {meth}`Scene.clock <pytycho.Scene.clock>`.

```python
scene.clock("fraction", channels=["true_anomaly", "time", "@index"], labels=["true anomaly", "time", "sample"], steps=480)
```

The animation plays in loops. The argument `steps` is the number of frames in one loop, where a frame is one drawn picture of the animation, not a coordinate frame. The frame index wraps modulo `steps` to a remainder `i` in `[0, steps)`, hence counting past the end of the loop starts the loop again. The progress through the loop is `q = i / steps`, in `[0, 1)`, i.e. the fraction of the loop that has elapsed.

A loop holds one lap unless the clock sets more, and in fraction mode a lap is one traversal of each track from its first sample to its last. At speed 1 a lap lasts 8 seconds, hence a loop of `n` [laps](#laps) lasts `8 n` seconds, whatever `steps` is. The number of steps sets how finely a loop is cut and not how long it lasts, e.g. 480 steps a lap give 60 frames a second at speed 1. The speed menu of the transport, i.e. the playback controls, runs from 0.25× to 4×, in factors of 2. Playback draws at the display's refresh rate. When a step lasts longer than a refresh, playback draws between two frame indices, which keeps the motion smooth, and the frame counter shows the last index passed.

The argument `seconds` sets the length of one loop at speed 1 in place of 8 seconds a lap, in either mode, hence `scene.clock(..., seconds=24)` plays a loop in 24 seconds whatever its laps and steps. It changes the pace and not any reading, and a video is exported at the same pace as live playback.

The argument `channels` lists the channels the clock can run on, and the first is the initial one. The channel that the clock currently runs on is the active channel. The transport's clock tabs switch between the channels, showing `labels` when given, one label per channel. Every clock channel is strictly monotone (strictly increasing or strictly decreasing) along every track of every set that carries it, with a finite, nonzero span (rule T3). Each value of the channel thus occurs once on a track. The stored sample index `@index` is always available, since every track has it.

The reading of a sample measures how far along its track the sample lies. Along one track of `m` samples, sample `i` sits at the reading `u_i = (c[i] - c[0]) / (c[m-1] - c[0])`, where `c` is the active channel, and at `i / (m - 1)` for `@index` (rule C1). The reading is thus the fraction of the channel's span on the track that the sample has reached, 0 at the first sample and 1 at the last. The clock's mode, `fraction` or `value`, determines how the progress `q` becomes a reading on each track.

## Fraction mode

The `fraction` mode is the default. In this mode the reading `u` of every track equals the progress `q` through the loop (rule C2), meaning that every track runs through the whole span of the active channel in one loop. Members of different periods thus stay in phase, and each completes one period per loop, or one per lap when the clock has [laps](#laps). This mode suits a family of periodic orbits. The head, i.e. the marker drawn at the current point of a track, moves uniformly in whichever channel runs the clock. Switching the clock from the true anomaly to the time therefore changes how the head moves along each orbit.

## Value mode

In `value` mode the clock runs the active channel through a common range of values, and the tracks are synchronized by the value of the channel, e.g. all shown at the same time. The clock then has a `range` `[a, b]`, and the shared value `v = a + q * (b - a)` drives every track, whose reading is `(v - c[0]) / (c[m-1] - c[0])` (rule C2). This reading is where the value `v` falls on the span of the track. The shared value acts as a common epoch, since tracks that start or end at different values of the channel show where each track is at the same value.

A reading below 0 lies before the track's first sample, and a reading above 1 after its last sample. A track layer's `before` and `after` set whether the track is then clamped to its end (`"clamp"`, the default) or not drawn (`"hidden"`) (rule C3). A clamped track is shown held at its first or its last sample. The two lines below declare a clock in value mode and a layer that hides each transfer before its first sample, grows it from there, and shows it whole after its last sample.

```python
scene.clock("value", channels=["time"], range=[0.0, 30.0], steps=600)
ty.track(transfers, "all", reveal="grow", before="hidden", after="clamp")
```

## Laps

In fraction mode, `laps=n` makes one loop cover `n` periods of the periodic sets instead of one (rule C6). Since `steps` counts the frames of the whole loop, multiplying `steps` by the number of laps keeps the same number of frames a period. With nine laps, the call below keeps 480 frames a period.

```python
scene.clock("fraction", channels=["time", "@index"], labels=["time", "sample"], steps=480 * 9, laps=9)
```

The loop is cut into `n` laps, and a sample drawn in lap `j` is evaluated in a context raised by `j` periods. In this context every channel is raised by `j` times its advance over one period, which is its value at the last sample minus its value at the first ([periodic sets](track-sets.md#periodic-sets)). Consider a periodic orbit of the rotating frame drawn in the inertial frame, which turns by the time channel. The orbit then keeps turning through the nine periods, although the stored track holds one, and it does not jump back at the end of each period.

The `trail` fraction of a layer is a fraction of the whole loop of `n` periods, e.g. `trail=0.3` covers 2.7 of the nine periods. The full track drawn with `reveal="none"` shows every lap. A readout of a channel reads the channel in the driver's current lap, and a time readout thus keeps rising through the loop. With more than one lap, every track on which a reading is taken belongs to a periodic set, since only a periodic set defines what its next lap is. The writer checks this rule. A value clock does not have laps.

## Between two samples

A reading generally falls between two stored samples. The point at a reading lies on the segment between the two stored samples around it, at the weight the reading gives (rule C4). The weight is 0 at the earlier sample and 1 at the later one, and it grows linearly with the reading in between. The position of the point in a display frame is the blend of the two samples, each already transformed into the display frame in its context. In other words, the transform is applied to the two samples first, and the two results are then interpolated linearly. Channel values are never blended to build a transform. A frame that turns by a stored angle therefore never turns by an interpolated angle.

## Which sets carry the clock

A reading is taken on four kinds of track.

- A track that a layer draws with a `reveal` other than `none`, i.e. a track that grows or has a trail ([views and layers](views.md#track-layers)).
- A track that a layer draws with a `head`.
- In value mode, a track that a layer draws with a `before` or an `after` of `hidden`.
- The driver's track, i.e. the track that the view follows.

A set with such a track carries every clock channel except `@index` (rule C5), so that the reading can be computed whichever channel is active. A set drawn whole and never read can omit every clock channel. Consequently, a context set, i.e. a set drawn whole in the background to give context, does not have to carry the time.
