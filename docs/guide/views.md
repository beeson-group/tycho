# Views and layers

A view is a template for a panel, i.e. for one picture on the page, and {meth}`Scene.view <pytycho.Scene.view>` declares it. A view is made of four parts.

- The display frame is the coordinate frame in which the panel draws everything.
- The driver is the one track that the panel follows, and the bodies and the readouts of the panel take their context from it, i.e. they read attributes and channels at the driver's track and sample ([bodies and drivers](bodies.md#drivers)).
- The camera determines how the display frame is seen in the panel ([cameras](#cameras)).
- The layers form a list, and each layer draws one thing, e.g. some tracks of a track set, a body, or the axes.

The display frame is given as a frame id or as a choice whose values are frame ids. A choice is a variable that holds one of a list of strings, and a panel-scoped choice holds a separate value in every panel ([variables and references](variables.md)). One view can thus serve every frame through a panel-scoped choice, with each panel picking its frame. The Broucke scene, i.e. the example scene of families 7, 8 and 11 of Broucke's periodic orbits in the elliptic restricted three-body problem, has a single view, declared below.

```python
members_of = ty.sets(family=family, branch=branch)
cmaps = {
    "rotating-pulsating": "viridis",
    "rotating": "blues",
    "barycentric-inertial": "plasma",
    "inertial-m1": "reds",
    "inertial-m2": "cividis",
}
by_frame = {"parameter": "eccentricity", "colormap": {"var": frame, "map": cmaps}}
highlight = {"var": e, "width": 2.5, "opacity": 1.0, "kernel": {"width": 0.05, "opacity": 0.55}}
layers = [
    ty.track(members_of, ty.every(40), color=by_frame, opacity=0.4),
    ty.track(members_of, "all", color=by_frame, opacity=0.05, highlight=highlight),
    ty.track(members_of, e, trail=0.3, taper=(0, 0), color=by_frame, width=22.0, opacity=0.3),
    ty.track(members_of, e, trail=0.3, taper=(0, 0), color=by_frame, width=6.0),
    ty.track(members_of, e, trail=0.3, head={"color": "#f0e442", "size": 9}, color="#ffffff", width=2.0),
    ty.body(m1, trail=1.0, size=6.0),
    ty.body(m2, trail=1.0, size=4.0),
    ty.axes(),
    ty.grid(),
]
scene.view("main", frame=frame, driver=ty.driver(members_of, e), camera={"kind": "plane", "plane": "xy"}, layers=layers)
```

The layers are drawn in the order of the list, each over the layers before it. Every track layer reads the family and the branch that the two choices `family` and `branch` currently select, through the tags query `members_of`. All track layers but the last are colored by eccentricity through `by_frame`, i.e. through the colormap that `cmaps` assigns to the panel's frame. The nine layers draw the following.

- The first layer draws about 40 members spread over the track set, at an opacity of 0.4.
- The second draws every member faintly, at an opacity of 0.05. It highlights the member that the eccentricity selector `e` picks, and its kernel brings up the neighbors of this member in eccentricity.
- The next two draw the trail of the selected member, first wide and translucent, then narrower. Both fade out at the tail, and together they form a glow.
- The fifth draws the same trail as a white line over the glow, with a yellow head.
- The two body layers draw the primary `m1` and the secondary `m2`, each with a trail of the whole loop.
- The last two layers draw the axes and a grid.

## Cameras

A camera determines how the display frame of a panel is seen, and it is one of two kinds.

- A plane camera, e.g. `{"kind": "plane", "plane": "xy"}`, gives a 2D view onto one coordinate plane, `xy`, `xz`, or `yz`. The plane camera onto `xy` is the default, which a view takes when it does not give a camera. Its `aspect` is `"equal"` by default, under which one unit is as long across the panel as up it, and the shape of an orbit is preserved. With `"aspect": "free"`, the two axes are scaled separately, so that a diagram, e.g. of a residual against an iteration count, is drawn across the whole panel in both directions, and each axis is ticked at a step for its scale.
- An orbit camera, e.g. `{"kind": "orbit", "projection": "perspective", "up": "z"}`, gives a 3D view that a person viewing the page can turn. Its projection is `orthographic`, under which parallel lines stay parallel, or `perspective`, under which far objects look smaller. Its up axis, i.e. the axis that points up on the screen, is `x`, `y`, or `z`. By default, the projection is `perspective` and the up axis is `z`.
  - Its `stretch` is three factors along `x`, `y`, and `z`, by which every position that the panel draws is multiplied, so that a drawing that is nearly flat in one axis can be shown taller in it. In the manifolds example, e.g. the halo and its manifolds are drawn under `"stretch": [1, 1, 5]`. The runtime fits the camera to the stretched drawing, and it titles a stretched axis with its factor, as in `z ×5`.
  - Its `turn` is the number of degrees by which the camera turns about the up axis over one loop of the clock, at a constant rate, counterclockwise seen from above when positive. The camera is back at its fit at the start of each loop, and the turn is added to any turn made by hand, live and in an exported video alike.

The runtime fits a panel's camera to the track layers that the panel draws, i.e. it pans and zooms so that they fill the panel. When the panel does not draw a track, the runtime fits the camera to the panel's bodies instead. It fits the camera again whenever the panel's view, frame, or sets change, and otherwise it keeps the pan and zoom set by the person viewing the page ([section 2.7](../spec.md#27-views-drivers-and-layers)). The house icon in a panel's header, or a double-click on the panel, resets the panel's view to this fit. The key `F` resets the view of every panel ([keys](panels.md#keys)).

## Track layers

A track layer draws tracks, i.e. trajectories, from one track set, and {func}`ty.track(sets, members, ...) <pytycho.track>` builds one. The argument `sets` is a set query, which must resolve to one set, and `members` specifies the tracks of this set that the layer draws, i.e. its members ([variables and references](variables.md)). The argument `members` takes one of four forms.

- The string `"all"`, the default, stands for every track of the set.
- A track index stands for the track with this number.
- A selector stands for the track that the selector picks.
- The count {func}`ty.every(n) <pytycho.every>` stands for about `n` members spread evenly over the set.

The option `reveal` sets how much of each track is drawn as the animation advances. It depends on the reading of the track, i.e. how far along the track the clock currently is, from 0 at its first sample to 1 at its last ([the clock](clock.md)).

- With `"none"`, the default, the whole track is always drawn. Every sample is transformed into the display frame and drawn, in every lap of the clock, where a lap is one of the periods that a loop of the clock covers ([laps](clock.md#laps)).
- With `"grow"`, the track is drawn from its first sample to the point at the clock's reading, hence it grows as the animation advances.
- With `"trail"`, the track is drawn from the reading minus a `trail` fraction of the loop up to the reading, hence a trail of fixed length follows the moving point. The fraction lies in `(0, 1]`. Giving `trail=0.3` implies `reveal="trail"`, and `reveal` can then be left out.

The part of a track between two readings is drawn as a polyline, i.e. a sequence of points joined by straight segments. This polyline consists of the point at the first reading, every stored sample between the two readings, and the point at the second reading (rule L1). Only the two end points are interpolated, each between the two stored samples around it.

A trail can reach back past the first sample of a track, e.g. just after the moving point has started a new loop. On a periodic set, i.e. a set whose tracks are closed loops, the trail then continues into the previous period. This part of the trail is evaluated in a shifted context, in which every channel is lowered by its advance over one period (e.g. a time channel by one period). A frame that turns by a channel thus stays continuous where the trail crosses from one period into the previous one (rule L2). On a set that is not periodic, the trail is cut at the first sample, since only a periodic set defines a period before the stored one.

The option `head=True` also draws the point at the reading, i.e. the current position of the moving point, as a marker. A dict such as `head={"color": "#f0e442", "size": 9}` sets the color of the head and its diameter in CSS pixels. A CSS pixel is the logical pixel of the web page, which on a high-resolution display covers several physical pixels. By default, the head takes the layer's color at this point and a size that the runtime chooses (rule L3).

Under a clock in value mode, a reading can fall before the first sample or after the last sample of a track. The options `before` and `after` then set what the track shows outside its span (rule C3). The value `"clamp"`, the default, holds the track at its first or its last sample, and `"hidden"` does not draw the track.

With `context="driver"`, every sample of the layer's tracks is transformed into the display frame in the driver's context, i.e. with the attributes and channels of the driver's track at its current reading, rather than in the context of the sample itself (rule L6). A static drawing of one frame is then moved with this frame in the display frame. For instance, a grid stored in the rotating-pulsating frame of the elliptic problem is scaled with the separation of the primary and the secondary when the rotating frame is shown, and it is also turned by the true anomaly when an inertial frame is shown. The channels of the frames are read on the driver's track set, hence they are not needed on the track set of such a layer. On a layer with a grow, a trail, or a head, a reading is still taken on its own tracks, and the clock channels must then be stored on its set. The track layers at the bottom of a panel are drawn once and kept up to the first layer that is redrawn on every frame, such as any layer in the driver's context, hence a large static family is best listed before such a layer.

The other options of a track layer serve drawing only, and they do not change any position.


The option `color` is a fixed color or a colormap. A fixed color is a `#rrggbb` string, with two hexadecimal digits each for red, green, and blue. A colormap turns the values of one parameter or one channel of the layer's set into colors, e.g. `{"parameter": "eccentricity", "colormap": "viridis"}`. A colormap over a parameter gives one color per track, and a colormap over a channel gives one color per sample, which varies along the track. The colormaps are `viridis`, `plasma`, `cividis`, `blues`, and `reds`. The interval `range` of values maps onto the part `clip` of the colormap, where the whole colormap runs from 0 to 1. By default, `range` is the extent of the values over the set, i.e. their minimum and maximum, and `clip` is `[0, 1]`, i.e. the whole colormap.

The colormap can also be keyed on a choice, as in `{"var": frame, "map": {...}}`. In this form, `map` gives one colormap for every value of the choice and for these values only, and the panel's value of the choice then picks the colormap. The Broucke scene keys it on the panel's frame, hence every frame has a separate colormap, as in Broucke's figures. A layer colored by a colormap, over a parameter or over a channel, shows a colorbar at the panel's top right, i.e. a strip that shows the colormap against its values. A colorbar over a parameter is titled with the parameter's label and unit, and it marks the highlighted member, while a colorbar over a channel is titled with the channel's name and does not carry a marker. A colorbar over the parameter of a scene-scoped selector also sets the selector ([colorbars](panels.md#colorbars)).

The remaining options are the following.

- The option `width` is the line width in CSS pixels, and `opacity` lies in `[0, 1]`, from transparent to opaque. Along a trail both keep their values at the head and fall linearly toward the tail. At the tail they reach their values times the factors `taper=(width, opacity)`, which default to `(0.25, 0.35)`, hence the trail thins and fades toward its end. A taper of `(0, 0)` fades the trail out completely.
- The option `highlight` refers to a selector, e.g. the eccentricity selector `e` in `{"var": e, "width": 2.5, "opacity": 1.0}`. The member that the selector resolves to in the layer's set is drawn with this width and opacity. When the highlight does not give them, the member is drawn with the layer's width and full opacity.
- A highlight's `kernel`, `{"width": w, "opacity": a}`, on a selector by `nearest` also brings up the members near the highlighted one in the selector's parameter. Their opacity falls off from `a` as a Gaussian of their distance from the highlighted member, over `w` times the parameter's extent, and it never drops below the layer's opacity.
- The option `visible` refers to a toggle, i.e. a variable that holds a boolean, and the layer is omitted while the toggle is false (rule L5).

A track layer that does not take a clock reading draws the same picture at every frame, and it is called static. A track layer is static when three conditions hold.

- It has `reveal="none"`.

- It does not have a head.
- Under a clock in value mode, it sets neither `before` nor `after` to `"hidden"`.

The runtime draws the first static layers of a view, i.e. the run of static layers at the start of the list, once per panel. It then copies this picture back at every frame, until the members they draw, the highlighted member, the camera, or the panel's size changes. A dense family therefore costs little during playback. Put the static layers first, since a static layer that comes after a layer that moves is drawn again at every frame. While a slider or the camera is dragged, the static layers are drawn without antialiasing, i.e. without smoothing their jagged edges. They are drawn again with antialiasing once the drag stops. Under an orbit camera with a `turn`, the camera is moved at every frame, hence the static layers are drawn at every frame as well, with antialiasing.

## Arrow layers

An arrow layer draws an arrow on each member at the clock's reading, and {func}`ty.arrow(sets, vector, members, scale=) <pytycho.arrow>` builds one (rule L7). The arrow is based at the point of the track at the reading, as a head is. It points along a vector that is read from two or three channels of the track set, e.g. `("vx", "vy", "vz")` for a velocity, and it is `scale` times as long as this vector. The `scale` is a number or an attribute of the set, and it defaults to 1. The call below draws the velocity of the driver's track at a tenth of its length, in white.

```python
ty.arrow(orbit, ("vx", "vy", "vz"), 0, scale=0.1, color="#ffffff", width=2.0, head=12.0)
```

The base and the tip are both transformed into the display frame, hence an arrow drawn in the rotating frame and shown in an inertial frame is turned with the frame. The vector channels are read as they are stored in every lap, and they are not raised by the lap as the channels of the frame edges are (rule C6). A reading is taken on every member, hence the set must carry the clock channels (rule C5).

The head is a filled triangle `head` CSS pixels long, 10 by default, and 0.8 times as wide as it is long, at every zoom. The head of an arrow shorter than its head on screen is shortened to the arrow, and an arrow whose ends meet on screen is not drawn. The `width` is the width of the shaft in CSS pixels, and the `color` and the `opacity` default to the foreground of the theme and to 1. The camera is not fitted to the arrows, since they move with the reading.

Under a clock in value mode, `before="hidden"` and `after="hidden"` hide an arrow while the clock value is outside the values of its track (rule C3). An arrow shown for a window of time is thus a track of two samples with the same position and vector, whose clock channel holds the start and the end of the window. The velocity at a node of a guess can thus be drawn for the iteration in which the guess is shown.

## Outline layers

An outline layer draws the rectangle that another panel currently shows, e.g. a faint box on a large panel around the part that a small panel magnifies, and {func}`ty.outline(view, color=, opacity=, width=, dash=, min_size=) <pytycho.outline>` builds one (rule L8). The argument `view` names the target view, which must have a plane camera and must differ from the view of the layer. The target panel is the first panel in layout order that shows the target view, and the outline follows its camera as the person viewing the page pans and zooms it. When the layout does not show the target view, the outline is not drawn. The call below draws a dashed white box around what the view `closeup` shows.

```python
ty.outline("closeup", color="#ffffff", opacity=0.6, width=1.0, dash=(4, 3), min_size=12)
```

The rectangle is mapped from the display frame of the target panel into the display frame of the layer's panel, at the reading of the layer's driver, as a track layer in the driver's context is mapped (rule L6). A close-up that magnifies the part of the rotating frame around a moving point is thus a child frame of the rotating frame whose origin and scale are channels of the driver's set. Its edge is `u = s (p - o)`, where `p` is a point of the rotating frame, `u` the same point in the close-up, `o` the origin, and `s` the scale. In the lines below, the channels `tx` and `ty` hold the point and `inv_w` holds one over the half width of the close-up, at every sample of the driver.

```python
rp = scene.frame("rp")
zoom = scene.frame("zoom", parent=rp, origin=[ty.channel("tx"), ty.channel("ty"), 0.0], scale=ty.channel("inv_w"))
```

The driver's set must then carry the channels of every edge between the two frames (rule F5). The `width` and the dash `(on, off)` are in CSS pixels, and the `color` and the `opacity` default to the foreground of the theme and to 1. An outline narrower or shorter on the screen than `min_size` CSS pixels, 8 by default, is stretched about its center to this size, hence the window of a deep close-up stays visible. The camera is not fitted to the outline, since the outline moves with another panel's camera.

## Body, axes, and grid layers

A body layer draws a body, i.e. a named point such as the primary, at the driver's reading, and {func}`ty.body(body, trail=, size=) <pytycho.body>` builds one. Its `trail` is a fraction of the loop, as on a track layer, and its `size` is the diameter of the body in CSS pixels ([bodies and drivers](bodies.md)).

An axes layer draws the coordinate axes of the display frame, and {func}`ty.axes(span=) <pytycho.axes>` builds one. A grid layer draws a grid of lines in the display frame, and {func}`ty.grid(labels=) <pytycho.grid>` builds one. The option `span` sets how much of each axis is drawn, and `labels` sets whether the grid numbers its lines. Both defaults depend on the camera.

Under a plane camera, `span` defaults to `"full"` and `labels` to true. The axes then run both ways through the origin across the view, with tick numbers along the panel's left and bottom edges. Each axis is titled with the frame's axis label and its `unit`, e.g. `x̃ [DU]` in the rotating frame of the Broucke example, where DU is the semi-major axis of the relative orbit of the primary and the secondary. The grid follows the visible rectangle and numbers its lines. Both the axes and the grid depend on the visible part of the view, and for this reason they are laid out again as the person viewing the page pans and zooms. With `span="positive"`, only the positive half-axes are drawn from the origin, each titled at its tip.

Under an orbit camera, `span` defaults to `"positive"` and `labels` to false. The axes and the grid are then laid out from the box that the camera was fitted to, and the axes are titled at their tips. All three layers, i.e. the body, axes, and grid layers, take `visible` as well.

## What a view evaluates to

The evaluator computes what a scene draws, as numbers rather than pixels. For a state of the page and a frame index, every panel evaluates to its display frame and one entry per layer ([section 3](../spec.md#3-what-an-evaluator-returns)). The entry of a track layer holds the set it draws from and, for every member drawn, the member's polyline and head. In the entry of an arrow layer, the base and the tip of the arrow are given for every member, and both are null while the member is hidden. The entry of an outline layer holds the target panel, its display frame, and the map into the display frame as an `origin` and three `axes`, and the rectangle itself is left to the browser, since it depends on the camera. The entry of a body layer holds the body's position and trail. The function {func}`pytycho.evaluate` returns this result, which is the same answer that the browser draws, since the browser runtime implements the same evaluator. This is how a test asserts that a scene draws what it should. The call below evaluates the initial state at frame index 100 and reads the head of the first member drawn by the second layer of panel `p2`.

```python
result = ty.evaluate(scene.to_document(), scene.to_container(), scene.to_document()["initial"], frame_index=100)
head = result["panels"]["p2"]["layers"][1]["members"][0]["head"]
```
