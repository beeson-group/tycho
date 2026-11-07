# Track sets and channels

A track is one trajectory, i.e. a sequence of samples, where each sample is one stored point of the trajectory together with the other numbers stored for it. A track set is a collection of tracks that share a frame and a meaning, e.g. a family of periodic orbits, the legs of a manifold, or one transfer. The method {meth}`Scene.track_set <pytycho.Scene.track_set>` declares a set, and {meth}`TrackSet.add <pytycho.TrackSet.add>` adds one track at a time and returns its index, the position of the track in the set counted from 0.

The Broucke example builds each of its sets from the arrays of its input, one track per family member, and the code below builds one of them. In this code, `offsets`, `positions`, and the channel and parameter arrays are read from the input file `broucke-input.tyd`, and the rows of member `i` run from `offsets[i]` up to `offsets[i + 1]`. The handle `pulsating` stands for the rotating-pulsating frame, in which the orbits are stored ([frames and contexts](frames.md)).

```python
family = scene.track_set(
    "family-11-periapsis",
    frame=pulsating,
    tags={"family": "11", "branch": "periapsis"},
    attrs={"mu": 0.5},
    periodic=True,
    label="Broucke family 11, periapsis branch",
)
for i in range(len(offsets) - 1):
    rows = slice(offsets[i], offsets[i + 1])
    family.add(
        positions[rows],
        channels={"true_anomaly": true_anomaly[rows], "rho": rho[rows], "time": time[rows]},
        parameters={"eccentricity": eccentricity[i], "period": period[i], "closure_error": closure_error[i]},
    )
family.describe("time", unit="TU")
family.describe("eccentricity", label="eccentricity")
```

## Positions

The positions of a track are an array of shape `(m, 2)` or `(m, 3)` in the set's frame, where `m` is the number of samples, and each row holds the coordinates of one sample. Every entry is finite. A two-component position is planar and has `z = 0`, and a set does not mix the two shapes, meaning that its tracks are either all planar or all three-dimensional. Every track has at least two samples (rule T1), so that it has at least one segment to draw. Since `add` copies its inputs, the caller can reuse the arrays after the call.

## Channels

A channel holds one value per sample, as an array of shape `(m,)` beside the positions, e.g. a time, a true anomaly, a pulsation scale, or a mass. Channels make the frames of TyCHO generic, since a frame can be defined without a formula when the quantity it depends on is stored with every sample. Channels are read in three places.

- A frame edge, i.e. the link from a parent frame to a child frame, reads its angle or its scale from the channel of the sample being drawn ([frames and contexts](frames.md)).
- The clock runs on channels, i.e. it moves along every track by the value of one channel ([the clock](clock.md)).
- A color or a readout can show one.

Every track of a set gives the same channel names, and the writer rejects a track whose channel names differ from those of the first track.

{meth}`TrackSet.describe <pytycho.TrackSet.describe>` sets a channel's `unit` and its `interp`, which is `linear` by default or `hold`. The key `interp` is meant to specify how the channel is interpolated between samples. The rules of version {{ scene_format }} do not read `interp`, which is recorded for the readouts and colors of a later version. The method `describe` looks the name up among the channels and parameters of the first track, hence it is called after the first `add`.

The name `@index` is reserved, and a set cannot declare a channel of this name. It refers to the built-in channel whose value at sample `i` is `i`, counted from the track's first stored sample (rule T4), i.e. the sample number itself. It counts stored samples, and [thinning](thinning.md) a set, i.e. keeping a subset of its samples, therefore changes this channel. It can drive the clock. It is refused in a frame edge and in a readout, where `{"clock": "index"}` gives the frame index instead, i.e. the number of the drawn picture within the loop of the animation ([the clock](clock.md)).

## Parameters

A parameter is one finite number per track, e.g. the eccentricity of a family member, its period, its Jacobi constant, or its closure error. Parameters are read in four places.

- A selector, i.e. a variable that picks one track, resolves to the track whose parameter is nearest a value ([variables and references](variables.md)).
- A slider takes its stops from parameter values, one stop per value, and thus snaps from one member to the next.
- A colormap can color the tracks by one.
- A readout shows the parameters of the driver, i.e. the track a view follows ([bodies and drivers](bodies.md)).

Parameters are stored as float64 whatever the set's `dtype`, since each is only one number per track and a selector compares against them. The method `describe` sets a parameter's `label` and `unit`, which a colorbar over the parameter shows as its title ([colorbars](panels.md#colorbars)).

## Tags and attributes

The `tags` of a set map names to strings, e.g. `{"family": "11", "branch": "periapsis"}`, and its `attrs` map names to numbers, e.g. `{"mu": 0.5}`. Both hold for the whole set, whereas a channel holds per sample and a parameter per track. Tags serve to find sets. A set query is the way a view or a layer refers to the track set it draws, and it can match tags. One view can thus draw "the set whose family is the chosen one and whose branch is periapsis" ([variables and references](variables.md)). Attributes are constants that a frame edge or a body can read, e.g. the mass ratio `mu`, which differs from one Broucke family to the next ([frames and contexts](frames.md)). Since it differs, it is stored on each set rather than written into the frames and the bodies, which are declared once and shared by every family.

## Periodic sets

Setting `periodic=True` declares that every track of the set is a closed loop, whose last sample is the closing sample, one period after the first (rule T2). The closing sample is thus the first sample again. Whether the positions of the last and the first sample coincide is not checked. An absent `periodic` is `False`. Two things work only on a periodic set.

- A trail, i.e. the stretch of track drawn behind the moving point, can wrap from the end of the track back to its start (rule L2). When the moving point has just passed the first sample, the trail thus continues into the end of the previous period instead of being cut.
- A clock with `laps` can run the set through several periods in one loop of the animation (rule C6).

The advance of a channel over one period is its value at the last sample minus its value at the first, e.g. the period itself for a time channel. The wrapped part of a trail and every lap after the first are evaluated with this advance, i.e. with every channel shifted by whole periods. A frame that turns by a channel thereby keeps turning instead of jumping back at the end of a period ([the clock](clock.md#laps)).

## Storage

The `dtype` of a set is the stored type of its positions and channels, i.e. the element type of their arrays, `float32` by default or `float64` (rule D1). A cast to the stored type is never silent, since the dtype is declared and the container records the cast in its `meta.casts`, which maps each array to the dtype it had before the cast. At float32 a 3D sample costs 12 bytes (three coordinates of 4 bytes), and each channel 4 more, before the container compresses them. The method {meth}`~pytycho.Scene.write_html` returns the size of every array as stored, in bytes, which makes the cost of a set visible. A set whose data are compared to many digits, as in the conformance corpus (the test cases that both the Python and the TypeScript evaluator run), stores float64.

In a float32 set, a clock channel, i.e. a channel that the clock can run on, is stored as float64 in two cases.

- Float32 would round the ends of a step between samples by more than 1% of the step.
- Float32 would make the channel nonmonotone, i.e. no longer strictly increasing or strictly decreasing, which rule T3 forbids for a clock channel.

This happens for a time in seconds past J2000, since float32 carries about seven significant digits and such a time has nine digits before the decimal point. The argument `channel_dtypes={"time": "float64"}` sets a channel's dtype outright. A dtype given there overrides both the set's `dtype` and the switch of a clock channel to float64.

In the container, a set `s` is stored as a few named arrays ([section 2.1](../spec.md#21-track-sets)).

- The array `s/offsets` holds the sample offsets as a `uint32` array of length `tracks + 1`, where `tracks` is the number of tracks. Its first entry is 0, and the samples of track `i` run from `offsets[i]` up to but not including `offsets[i + 1]`.
- The array `s/positions` holds every track's samples concatenated, one track after another.
- Each array `s/channels/<name>` holds one channel, concatenated in the same way.
- Each array `s/parameters/<name>` holds one parameter, with one entry per track.
