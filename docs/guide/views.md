# Panels and layers

A panel is one picture on the page, and {meth}`Scene.panel <pytycho.Scene.panel>` declares it.
The page may show a declared panel once, several times, or not at all, and each picture on the page is a shown panel ([panels, controls, and readouts](panels.md)).
A declared panel is made of four parts.

- The display frame is the coordinate frame in which the panel draws everything.
- The reference trajectory is the one trajectory that the panel follows, and the bodies and the readouts of the panel take their context from it, i.e. they read attributes and channels at the current sample of the reference trajectory ([bodies and reference trajectories](bodies.md#reference-trajectories)).
- The camera determines how the display frame is seen in the panel ([cameras](#cameras)).
- The layers form a list, and each layer draws one thing, e.g. some trajectories of a trajectory set, a body, or the axes.

The display frame is given as a frame id or as a choice whose values are frame ids.
A choice is an input that holds one of a list of strings, and a per-panel choice holds a separate value in every shown panel ([inputs and references](variables.md)).
One declared panel can thus serve every frame through a per-panel choice, with each shown panel picking its frame.
The Broucke scene, i.e. the example scene of families 7, 8 and 11 of Broucke's periodic orbits in the elliptic restricted three-body problem, has a single declared panel, declared below.

```python
members_of = ty.by_tags(family=family, branch=branch)
cmaps = {
    "rotating-pulsating": "viridis",
    "rotating": "blues",
    "barycentric-inertial": "plasma",
    "inertial-m1": "reds",
    "inertial-m2": "cividis",
}
by_frame = {"parameter": "eccentricity", "colormap": {"input": frame, "map": cmaps}}
highlight = {"input": e, "width": 2.5, "opacity": 1.0, "kernel": {"width": 0.05, "opacity": 0.55}}
layers = [
    ty.trajectories(members_of, ty.evenly_spaced(40), color=by_frame, opacity=0.4),
    ty.trajectories(members_of, "all", color=by_frame, opacity=0.05, highlight=highlight),
    ty.trajectories(members_of, e, trail=0.3, taper=(0, 0), color=by_frame, width=22.0, opacity=0.3),
    ty.trajectories(members_of, e, trail=0.3, taper=(0, 0), color=by_frame, width=6.0),
    ty.trajectories(members_of, e, trail=0.3, head={"color": "#f0e442", "size": 9}, color="#ffffff", width=2.0),
    ty.body(m1, trail=1.0, size=6.0),
    ty.body(m2, trail=1.0, size=4.0),
    ty.axes(),
    ty.grid(),
]
scene.panel("main", frame=frame, reference=ty.reference(members_of, e), camera={"kind": "2d", "plane": "xy"}, layers=layers)
```

The layers are drawn in the order of the list, each over the layers before it.
Every trajectories layer reads the family and the branch that the two choices `family` and `branch` currently select, through the tags query `members_of`.
All trajectories layers but the last are colored by eccentricity through `by_frame`, i.e. through the colormap that `cmaps` assigns to the panel's frame.
The nine layers draw the following.

- The first layer draws about 40 members spread over the trajectory set, at an opacity of 0.4.
- The second draws every member faintly, at an opacity of 0.05.
  It highlights the member that the eccentricity input `e` picks, and its kernel brings up the neighbors of this member in eccentricity.
- The next two draw the trail of the selected member, first wide and translucent, then narrower.
  Both fade out at the tail, and together they form a glow.
- The fifth draws the same trail as a white line over the glow, with a yellow head.
- The two body layers draw the primary `m1` and the secondary `m2`, each with a trail of the whole loop.
- The last two layers draw the axes and a grid.

## Cameras

A camera determines how the display frame of a panel is seen, and it is one of two kinds.

- A 2d camera, e.g. `{"kind": "2d", "plane": "xy"}`, gives a flat view onto one coordinate plane, `xy`, `xz`, or `yz`.
  The 2d camera onto `xy` is the default, which a declared panel takes when it does not give a camera.
  Its `aspect` is `"equal"` by default, under which one unit is as long across the panel as up it, and the shape of an orbit is preserved.
  With `"aspect": "free"`, the two axes are scaled separately, so that a diagram, e.g. of a residual against an iteration count, is drawn across the whole panel in both directions, and each axis is ticked at a step for its scale.
- A 3d camera, e.g. `{"kind": "3d", "projection": "perspective", "up": "z"}`, gives a three-dimensional view that the person at the page can turn.
  Its projection is `orthographic`, under which parallel lines stay parallel, or `perspective`, under which far objects look smaller.
  Its up axis, i.e. the axis that points up on the screen, is `x`, `y`, or `z`.
  By default, the projection is `perspective` and the up axis is `z`.
  - Its `stretch` is three factors along `x`, `y`, and `z`, by which every position that the panel draws is multiplied, so that a drawing that is nearly flat in one axis can be shown taller in it.
    In the manifolds example, e.g. the halo and its manifolds are drawn under `"stretch": [1, 1, 5]`.
    The runtime fits the camera to the stretched drawing, and it titles a stretched axis with its factor, as in `z ×5`.
  - Its `auto_rotate` is the number of degrees by which the camera turns about the up axis over one loop of the clock, at a constant rate, counterclockwise seen from above when positive.
    The camera is back at its fit at the start of each loop, and this turn is added to any turn made by hand, live and in an exported video alike.

The runtime fits a panel's camera to the trajectories layers that the panel draws, i.e. it pans and zooms so that they fill the panel.
When the panel does not draw a trajectory, the runtime fits the camera to the panel's bodies instead.
It fits the camera again whenever the panel's declared panel, frame, or sets change, and otherwise it keeps the pan and zoom set by the person at the page ([section 2.7](../spec.md#27-declared-panels-reference-trajectories-and-layers)).
The house icon in a panel's header, or a double-click on the panel, resets the panel's view to this fit.
The key `F` resets the view of every panel ([keys](panels.md#keys)).

## Trajectories layers

A trajectories layer draws trajectories from one trajectory set, and {func}`ty.trajectories(sets, members, ...) <pytycho.trajectories>` builds one.
The argument `sets` is a set query, which must resolve to one set, and `members` specifies the trajectories of this set that the layer draws, i.e. its members ([inputs and references](variables.md)).
The argument `members` takes one of four forms.

- The string `"all"`, the default, stands for every trajectory of the set.
- A trajectory index stands for the trajectory with this number.
- An input of kind parameter stands for the trajectory that the input picks.
- The selection {func}`ty.evenly_spaced(n) <pytycho.evenly_spaced>` stands for about `n` members spread evenly over the set.

The option `reveal` sets how much of each trajectory is drawn as the animation advances.
It depends on the fraction along the trajectory, i.e. how far along the trajectory the clock currently is, from 0 at its first sample to 1 at its last ([the clock](clock.md)).

- With `"none"`, the default, the whole trajectory is always drawn.
  Every sample is transformed into the display frame and drawn, in every revolution of the clock, where a revolution is one of the periods that a loop of the clock covers ([revolutions](clock.md#revolutions)).
- With `"grow"`, the trajectory is drawn from its first sample to the point at the current fraction along, hence it grows as the animation advances.
- With `"trail"`, the trajectory is drawn from the fraction along minus a `trail` fraction of the loop up to the fraction along, hence a trail of fixed length follows the moving point.
  The fraction lies in `(0, 1]`.
  Giving `trail=0.3` implies `reveal="trail"`, and `reveal` can then be left out.

The part of a trajectory between two fractions along is drawn as a polyline, i.e. a sequence of points joined by straight segments.
This polyline consists of the point at the first fraction along, every stored sample between the two, and the point at the second fraction along (rule `polyline`).
Only the two end points are interpolated, each between the two stored samples around it.

A trail can reach back past the first sample of a trajectory, e.g. just after the moving point has started a new loop.
On a periodic set, i.e. a set whose trajectories are closed loops, the trail then continues into the previous period.
This part of the trail is evaluated in a shifted context, in which every channel is lowered by its advance over one period (e.g. a time channel by one period).
A frame that turns by a channel thus stays continuous where the trail crosses from one period into the previous one (rule `trail-wrap`).
On a set that is not periodic, the trail is cut at the first sample, since only a periodic set defines a period before the stored one.

The option `head=True` also draws the point at the current fraction along, i.e. the current position of the moving point, as a marker.
A dict such as `head={"color": "#f0e442", "size": 9}` sets the color of the head and its diameter in CSS pixels.
A CSS pixel is the logical pixel of the web page, which on a high-resolution display covers several physical pixels.
By default, the head takes the layer's color at this point and a size that the runtime chooses (rule `head`).

Under a clock in epoch mode, a fraction along can fall before the first sample or after the last sample of a trajectory.
The options `before` and `after` then set what the trajectory shows outside its span (rule `before-after`).
The value `"clamp"`, the default, holds the trajectory at its first or its last sample, and `"hidden"` does not draw the trajectory.

With `read_from="reference"`, every sample of the layer's trajectories is transformed into the display frame in the reference trajectory's context, i.e. with the attributes and channels of the reference trajectory at its current fraction along, rather than in the context of the sample itself (rule `read-from`).
A static drawing of one frame is then moved with this frame in the display frame.
For instance, a grid stored in the rotating-pulsating frame of the elliptic problem is scaled with the separation of the primary and the secondary when the rotating frame is shown, and it is also turned by the true anomaly when an inertial frame is shown.
The channels of the frames are read on the reference trajectory's set, hence they are not needed on the trajectory set of such a layer.
On a layer with a grow, a trail, or a head, a fraction along is still computed on its own trajectories, and the clock channels must then be stored on its set.
The trajectories layers at the bottom of a panel are drawn once and kept up to the first layer that is redrawn at every frame index, such as any layer in the reference trajectory's context, hence a large static family is best listed before such a layer.

The other options of a trajectories layer serve drawing only, and they do not change any position.

The option `color` is a fixed color or a colormap.
A fixed color is a `#rrggbb` string, with two hexadecimal digits each for red, green, and blue.
A colormap turns the values of one parameter or one channel of the layer's set into colors, e.g. `{"parameter": "eccentricity", "colormap": "viridis"}`.
A colormap over a parameter gives one color per trajectory, and a colormap over a channel gives one color per sample, which varies along the trajectory.
The colormaps are `viridis`, `plasma`, `cividis`, `blues`, and `reds`.
The interval `range` of values maps onto the part `truncate` of the colormap, where the whole colormap runs from 0 to 1.
By default, `range` is the extent of the values over the set, i.e. their minimum and maximum, and `truncate` is `[0, 1]`, i.e. the whole colormap.

The colormap can also be keyed on a choice, as in `{"input": frame, "map": {...}}`.
In this form, `map` gives one colormap for every value of the choice and for these values only, and the panel's value of the choice then picks the colormap.
The Broucke scene keys it on the panel's frame, hence every frame has a separate colormap, as in Broucke's figures.
A layer colored by a colormap, over a parameter or over a channel, shows a colorbar at the panel's top right, i.e. a strip that shows the colormap against its values.
A colorbar over a parameter is titled with the parameter's label and unit, and it marks the highlighted member, while a colorbar over a channel is titled with the channel's name and does not carry a marker.
A colorbar over the parameter of a shared input of kind parameter also sets the input ([colorbars](panels.md#colorbars)).

The remaining options are the following.

- The option `width` is the line width in CSS pixels, and `opacity` lies in `[0, 1]`, from transparent to opaque.
  Along a trail both keep their values at the head and fall linearly toward the tail.
  At the tail they reach their values times the factors `taper=(width, opacity)`, which default to `(0.25, 0.35)`, hence the trail thins and fades toward its end.
  A taper of `(0, 0)` fades the trail out completely.
- The option `highlight` refers to an input of kind parameter, e.g. the eccentricity input `e` in `{"input": e, "width": 2.5, "opacity": 1.0}`.
  The member that the input resolves to in the layer's set is drawn with this width and opacity.
  When the highlight does not give them, the member is drawn with the layer's width and full opacity.
- A highlight's `kernel`, `{"width": w, "opacity": a}`, also brings up the members near the highlighted one in the input's parameter.
  Their opacity falls off from `a` as a Gaussian of their distance from the highlighted member, over `w` times the parameter's extent, and it never drops below the layer's opacity.
- The option `visible` refers to a toggle, i.e. an input that holds a boolean, and the layer is omitted while the toggle is false (rule `visible`).

A trajectories layer that does not compute a fraction along draws the same picture at every frame index, and it is called static.
A trajectories layer is static when three conditions hold.

- It has `reveal="none"`.
- It does not have a head.
- Under a clock in epoch mode, it sets neither `before` nor `after` to `"hidden"`.

The runtime draws the first static layers of a declared panel, i.e. the run of static layers at the start of the list, once per panel.
It then copies this picture back at every frame index, until the members they draw, the highlighted member, the camera, or the panel's size changes.
A dense family therefore costs little during playback.
Put the static layers first, since a static layer that comes after a layer that moves is drawn again at every frame index.
While a slider or the camera is dragged, the static layers are drawn without antialiasing, i.e. without smoothing their jagged edges.
They are drawn again with antialiasing once the drag stops.
Under a 3d camera with an `auto_rotate`, the camera is moved at every frame index, hence the static layers are drawn at every frame index as well, with antialiasing.

## Arrow layers

An arrow layer draws an arrow on each member at its current fraction along, and {func}`ty.arrow(sets, vector, members, scale=) <pytycho.arrow>` builds one (rule `arrow`).
The arrow is based at the point of the trajectory at this fraction along, as a head is.
It points along a vector that is read from two or three channels of the trajectory set, e.g. `("vx", "vy", "vz")` for a velocity, and it is `scale` times as long as this vector.
The `scale` is a number or an attribute of the set, and it defaults to 1.
The call below draws the velocity of the reference trajectory at a tenth of its length, in white.

```python
ty.arrow(orbit, ("vx", "vy", "vz"), 0, scale=0.1, color="#ffffff", width=2.0, head=12.0)
```

The base and the tip are both transformed into the display frame, hence an arrow drawn in the rotating frame and shown in an inertial frame is turned with the frame.
The vector channels are read as they are stored in every revolution, and they are not raised by the revolution as the channels of the transforms are (rule `revolutions`).
A fraction along is computed on every member, hence the set must carry the clock channels (rule `clock-channel-carried`).

The head is a filled triangle `head` CSS pixels long, 10 by default, and 0.8 times as wide as it is long, at every zoom.
The head of an arrow shorter than its head on screen is shortened to the arrow, and an arrow whose ends meet on screen is not drawn.
The `width` is the width of the shaft in CSS pixels, and the `color` and the `opacity` default to the foreground of the theme and to 1.
The camera is not fitted to the arrows, since they move with the clock.

Under a clock in epoch mode, `before="hidden"` and `after="hidden"` hide an arrow while the clock value is outside the values of its trajectory (rule `before-after`).
An arrow shown for a window of time is thus a trajectory of two samples with the same position and vector, whose clock channel holds the start and the end of the window.
The velocity at a node of a guess can thus be drawn for the iteration in which the guess is shown.

## Inset box layers

An inset box layer draws the rectangle that another panel currently shows, e.g. a faint box on a large panel around the part that a small panel magnifies, and {func}`ty.inset_box(panel, color=, opacity=, width=, dash=, min_size=) <pytycho.inset_box>` builds one (rule `inset-box`).
The argument `panel` names the target, a declared panel that must have a 2d camera and must differ from the declared panel of the layer.
The target panel is the first shown panel in layout order that shows the target, and the inset box follows its camera as the person at the page pans and zooms it.
When the layout does not show the target, the inset box is not drawn.
The call below draws a dashed white box around what the declared panel `closeup` shows.

```python
ty.inset_box("closeup", color="#ffffff", opacity=0.6, width=1.0, dash=(4, 3), min_size=12)
```

The rectangle is mapped from the display frame of the target panel into the display frame of the layer's panel, at the fraction along the layer's reference trajectory, as a trajectories layer that reads from the reference trajectory is mapped (rule `read-from`).
A close-up that magnifies the part of the rotating frame around a moving point is thus a child frame of the rotating frame whose origin and scale are channels of the reference trajectory's set.
Its transform is `u = s (p - o)`, where `p` is a point of the rotating frame, `u` the same point in the close-up, `o` the origin, and `s` the scale.
In the lines below, the channels `tx` and `ty` hold the point and `inv_w` holds one over the half width of the close-up, at every sample of the reference trajectory.

```python
rp = scene.frame("rp")
zoom = scene.frame("zoom", parent=rp, origin=[ty.channel("tx"), ty.channel("ty"), 0.0], scale=ty.channel("inv_w"))
```

The reference trajectory's set must then carry the channels of every transform between the two frames (rule `transform-channels`).
The `width` and the dash `(on, off)` are in CSS pixels, and the `color` and the `opacity` default to the foreground of the theme and to 1.
An inset box narrower or shorter on the screen than `min_size` CSS pixels, 8 by default, is stretched about its center to this size, hence the window of a deep close-up stays visible.
The camera is not fitted to the inset box, since the inset box moves with another panel's camera.
A trajectories layer can be left out of the fit as well, with `fit=False` in `ty.trajectories`.
A close-up can thus draw a whole curve, which the person at the page sees when zooming out, while its camera is fitted to a window given by a second trajectories layer, e.g. the curve clipped to the window or a box drawn at opacity 0.

## Body, axes, and grid layers

A body layer draws a body, i.e. a named point such as the primary, at the current fraction along the reference trajectory, and {func}`ty.body(body, trail=, size=) <pytycho.body>` builds one.
Its `trail` is a fraction of the loop, as on a trajectories layer, and its `size` is the diameter of the body in CSS pixels ([bodies and reference trajectories](bodies.md)).

An axes layer draws the coordinate axes of the display frame, and {func}`ty.axes(span=) <pytycho.axes>` builds one.
A grid layer draws a grid of lines in the display frame, and {func}`ty.grid(labels=) <pytycho.grid>` builds one.
The option `span` sets how much of each axis is drawn, and `labels` sets whether the grid numbers its lines.
Both defaults depend on the camera.

Under a 2d camera, `span` defaults to `"full"` and `labels` to true.
The axes then run both ways through the origin across the panel, with tick numbers along the panel's left and bottom edges.
Each axis is titled with the frame's axis label and its `unit`, e.g. `x̃ [DU]` in the rotating frame of the Broucke example, where DU is the semi-major axis of the relative orbit of the primary and the secondary.
The grid follows the visible rectangle and numbers its lines.
Both the axes and the grid depend on the view, i.e. on what the camera shows, and for this reason they are laid out again as the person at the page pans and zooms.
With `span="positive"`, only the positive half-axes are drawn from the origin, each titled at its tip.

Under a 3d camera, `span` defaults to `"positive"` and `labels` to false.
The axes and the grid are then laid out from the box that the camera was fitted to, and the axes are titled at their tips.
All three layers, i.e. the body, axes, and grid layers, take `visible` as well.

## What a panel evaluates to

The evaluator computes what a scene draws, as numbers rather than pixels.
For a state of the page and a frame index, every shown panel evaluates to its display frame and one entry per layer ([section 3](../spec.md#3-what-an-evaluator-returns)).
The entry of a trajectories layer holds the set it draws from and, for every member drawn, the member's polyline and head.
In the entry of an arrow layer, the base and the tip of the arrow are given for every member, and both are null while the member is hidden.
The entry of an inset box layer holds the target, the shown target panel, its display frame, and the map into the display frame as an `origin` and three `axes`, and the rectangle itself is left to the browser, since it depends on the camera.
The entry of a body layer holds the body's position and trail.
The function {func}`pytycho.evaluate` returns this result, which is the same answer that the browser draws, since the browser runtime implements the same evaluator.
This is how a test asserts that a scene draws what it should.
The call below evaluates the initial state at frame index 100 and reads the head of the first member drawn by the second layer of panel `p2`.

```python
result = ty.evaluate(scene.to_document(), scene.to_container(), scene.to_document()["initial"], frame_index=100)
head = result["panels"]["p2"]["layers"][1]["members"][0]["head"]
```
