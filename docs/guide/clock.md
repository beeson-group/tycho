# The clock

The clock is the animation time of a scene, which is shared by every panel, hence all panels move together.
Every scene declares one clock, and only one, with {meth}`Scene.clock <pytycho.Scene.clock>`.

```python
scene.clock("fraction", channels=["true_anomaly", "time", "@index"], labels=["true anomaly", "time", "sample"], frame_count=480)
```

The animation plays in loops.
The argument `frame_count` is the number of frame indices in one loop, where a frame index is the number of one instant of the animation.
The frame index wraps modulo `frame_count` to a remainder `i` in `[0, frame_count)`, hence counting past the end of the loop starts the loop again.
The progress through the loop is `q = i / frame_count`, in `[0, 1)`, i.e. the fraction of the loop that has elapsed.

A loop holds one revolution unless the clock sets more, and in fraction mode a revolution is one traversal of each trajectory from its first sample to its last.
At speed 1 a revolution lasts 8 seconds, hence a loop of `n` [revolutions](#revolutions) lasts `8 n` seconds, whatever the frame count is.
The frame count sets how finely a loop is cut and not how long it lasts, e.g. 480 frame indices a revolution give 60 frame indices a second at speed 1.
The speed menu of the playback control runs from 0.25× to 4×, in factors of 2.
Playback draws at the display's refresh rate.
When one frame index lasts longer than a refresh, playback draws between two frame indices, which keeps the motion smooth, and the frame counter shows the last index passed.

The argument `seconds` sets the length of one loop at speed 1 in place of 8 seconds a revolution, in either mode, hence `scene.clock(..., seconds=24)` plays a loop in 24 seconds whatever its revolutions and its frame count.
It changes the pace and not any fraction along, and a video is exported at the same pace as live playback.

The argument `channels` lists the channels the clock can run on, and the first is the initial one.
The channel whose value is currently read as the time of the animation is the clock channel.
The clock tabs of the playback control switch between the channels, showing `labels` when given, one label per channel.
Every clock channel is strictly monotone (strictly increasing or strictly decreasing) along every trajectory of every set that carries it, with a finite, nonzero span (rule `monotone-clock-channel`).
Each value of the channel thus occurs once on a trajectory.
The stored sample index `@index` is always available, since every trajectory has it.

The fraction along of a sample measures how far along its trajectory the sample lies.
Along one trajectory of `m` samples, sample `i` lies at the fraction along `u_i = (c[i] - c[0]) / (c[m-1] - c[0])`, where `c` is the clock channel, and at `i / (m - 1)` for `@index` (rule `sample-fraction`).
The fraction along is thus the fraction of the channel's span on the trajectory that the sample has reached, 0 at the first sample and 1 at the last.
The clock's mode, `fraction` or `epoch`, determines how the progress `q` becomes a fraction along each trajectory.

## Fraction mode

The `fraction` mode is the default.
In this mode the fraction along every trajectory equals the progress `q` through the loop (rule `clock-mode`), meaning that every trajectory runs through the whole span of the clock channel in one loop.
Members of different periods thus stay in phase, and each completes one period per loop, or one per revolution when the clock has [revolutions](#revolutions).
This mode suits a family of periodic orbits.
The head, i.e. the marker drawn at the current point of a trajectory, moves uniformly in whichever channel is the clock channel.
Switching the clock from the true anomaly to the time therefore changes how the head moves along each orbit.

## Epoch mode

In `epoch` mode the clock runs the clock channel through a common range of values, and the trajectories are synchronized by the value of the channel, e.g. all shown at the same time.
The clock then has a `range` `[a, b]`, and the shared value `v = a + q * (b - a)` drives every trajectory, whose fraction along is `(v - c[0]) / (c[m-1] - c[0])` (rule `clock-mode`).
This fraction along is where the value `v` falls on the span of the trajectory.
The shared value acts as a common epoch, since trajectories that start or end at different values of the channel show where each trajectory is at the same value.

A fraction along below 0 lies before the trajectory's first sample, and a fraction along above 1 lies after its last sample.
A trajectories layer's `before` and `after` set whether the trajectory is then clamped to its end (`"clamp"`, the default) or not drawn (`"hidden"`) (rule `before-after`).
A clamped trajectory is shown held at its first or its last sample.
A range that runs past the last value of every trajectory thus ends each loop on a hold, in which every trajectory clamped after its end is shown whole.
In the manifolds example, the legs grow over 20 of the 24 seconds of a loop and are held whole for the last 4.
The two lines below declare a clock in epoch mode and a layer that hides each transfer before its first sample, grows it from there, and shows it whole after its last sample.

```python
scene.clock("epoch", channels=["time"], range=[0.0, 30.0], frame_count=600)
ty.trajectories(transfers, "all", reveal="grow", before="hidden", after="clamp")
```

## Revolutions

In fraction mode, `revolutions=n` makes one loop cover `n` periods of the periodic sets instead of one (rule `revolutions`).
Since the frame count counts the frame indices of the whole loop, multiplying it by the number of revolutions keeps the same number of frame indices a period.
With nine revolutions, the call below keeps 480 frame indices a period.

```python
scene.clock("fraction", channels=["time", "@index"], labels=["time", "sample"], frame_count=480 * 9, revolutions=9)
```

The loop is cut into `n` revolutions, and a sample drawn in revolution `j` is evaluated in a context raised by `j` periods.
In this context every channel is raised by `j` times its advance over one period, which is its value at the last sample minus its value at the first ([periodic sets](track-sets.md#periodic-sets)).
Consider a periodic orbit of the rotating frame drawn in the inertial frame, which turns by the time channel.
The orbit then keeps turning through the nine periods, although the stored trajectory holds one, and it does not jump back at the end of each period.

The `trail` fraction of a layer is a fraction of the whole loop of `n` periods, e.g. `trail=0.3` covers 2.7 of the nine periods.
The full trajectory drawn with `reveal="none"` shows every revolution.
A readout of a channel reads the channel in the current revolution of the reference trajectory, and a time readout thus keeps rising through the loop.
With more than one revolution, every trajectory on which a fraction along is computed belongs to a periodic set, since only a periodic set defines what its next revolution is.
The writer checks this rule.
A clock in epoch mode does not have revolutions.

## Between two samples

A fraction along generally falls between two stored samples.
The point at a fraction along lies on the segment between the two stored samples around it, at the weight that the fraction along gives (rule `segment`).
The weight is 0 at the earlier sample and 1 at the later one, and it grows linearly with the fraction along in between.
The position of the point in a display frame is the blend of the two samples, each already transformed into the display frame in its context.
In other words, the transform is applied to the two samples first, and the two results are then interpolated linearly.
Channel values are never blended to build a transform.
A frame that turns by a stored angle therefore never turns by an interpolated angle.

## Which sets carry the clock

A fraction along is computed on four kinds of trajectory.

- A trajectory that a layer draws with a `reveal` other than `none`, i.e. a trajectory that grows or has a trail ([panels and layers](views.md#trajectories-layers)).
- A trajectory that a layer draws with a `head`.
- In epoch mode, a trajectory that a layer draws with a `before` or an `after` of `hidden`.
- The reference trajectory, i.e. the trajectory that the panel follows.

A set with such a trajectory carries every clock channel except `@index` (rule `clock-channel-carried`), so that the fraction along can be computed whichever channel is the clock channel.
A set drawn whole and never read can omit every clock channel.
Consequently, a context set, i.e. a set drawn whole in the background to give context, does not have to carry the time.
