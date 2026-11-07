# Bodies and drivers

A body is a named point that does not have samples, e.g. the primary or the secondary of a restricted three-body problem. A driver is the track that a view follows, and a body takes from the driver the values on which its position depends.

## Bodies

A body is a point in a frame, placed at three numbers or attributes and declared with {meth}`Scene.body <pytycho.Scene.body>`. It is a point without extent, which does not have a radius or a shape. Its `label` and `color` are used only for drawing. The primary and the secondary of a restricted three-body problem are bodies at `-mu` and `1 - mu` on the x axis of the rotating frame, respectively. Here the mass ratio `mu` is an attribute of the drawn track set ([frames and contexts](frames.md)). The two lines below declare the Earth and the Moon of an Earth–Moon scene in this way.

```python
earth = scene.body("earth", frame=rotating, position=[-ty.attr("mu"), 0.0, 0.0], label="Earth", color="#56b4e9")
moon = scene.body("moon", frame=rotating, position=[1 - ty.attr("mu"), 0.0, 0.0], label="Moon", color="#999999")
```

A body is fixed in the frame it is declared in, and it moves in any other frame through the edges between the two frames. These edges may read a channel or an attribute, whose value comes from a context (a track set, one of its tracks, and one of its samples). Since a body does not have samples, it does not have a context either, and it takes the context of the view's driver (rule F4).

Suppose that the barycentric inertial frame turns by the time channel, as it does in the circular restricted three-body problem. Drawn in this frame, the Moon sits at the position given by the time stored with the driver's sample, and it thus moves with the driver as the clock runs. The attributes of a body's position are read from the driver's set in the same way. In the Broucke scene the mass ratio `mu` is 0.012155 for family 7 and 0.5 for families 8 and 11. This attribute is read from the driver's set, and the primary and the secondary therefore move to their positions for the new family whenever the family changes.

A body is drawn by a body layer, e.g. {func}`ty.body(m1, trail=1.0, size=6.0) <pytycho.body>`, which draws the body at the driver's reading, with an optional trail and a size (rule L4). The driver's reading is the point of the driver's track that the clock has reached ([the clock](clock.md)). The trail covers a fraction of the loop given on the layer, e.g. `trail=1.0` for the whole loop, and the size is the diameter of the body in CSS pixels. In the Broucke example, the primary and the secondary have a trail of the whole loop, which traces their orbits in the inertial frames. The body's `label`, when given, is drawn beside the body. A body can also be the origin of a frame ([frames and contexts](frames.md)).

## Drivers

Every view has a driver, i.e. a set query and a member that resolve to one track, which a panel follows. The set query specifies the track set, and the member specifies one track of this set ([variables and references](variables.md#references)). The function {func}`ty.driver(sets, member) <pytycho.driver>` builds a driver. The member is a track index or a selector, i.e. a variable that picks one track, as in the three drivers below.

```python
ty.driver(loop, 0)  # track 0 of the set loop
ty.driver(family, z0)  # the track a selector picks
ty.driver(ty.sets(family=family, branch=branch), e)  # a set chosen by two choices, then a track by a selector
```

The driver gives the context of everything that does not have samples, i.e. the bodies and the frames whose origin is at a body. Readouts, i.e. the text on the page that shows current values, read the driver's parameters, attributes, and channels ([panels, controls, and readouts](panels.md)). A change of the driver's set refits the panel's camera, i.e. pans and zooms the panel so that what it draws fills it.

The runtime resolves the driver of every panel whether or not a layer uses it. The rules on set queries (V2), member references (V3), and clock channels (C5) therefore always apply to the driver ([section 2.7](../spec.md#27-views-drivers-and-layers)). In particular, the driver's set carries every clock channel other than `@index`, since the clock takes a reading on the driver's track.

When a driver's set query does not match any set, e.g. when a choice holds a tag value that does not appear on any set, the bodies are left without a context. A body layer then does not give a position. A query that matches more than one set is an error, since a driver is one track. The writer rules this error out for every value the variables can take.
