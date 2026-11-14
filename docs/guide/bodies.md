# Bodies and reference trajectories

A body is a named point that does not have samples, e.g. the primary or the secondary of a restricted three-body problem.
A reference trajectory is the trajectory that a panel follows, and a body takes from the reference trajectory the values on which its position depends.

## Bodies

A body is a point in a frame, placed at three numbers or attributes and declared with {meth}`Scene.body <pytycho.Scene.body>`.
It is a point without extent, which does not have a radius or a shape.
Its `label` and `color` are used only for drawing.
The primary and the secondary of a restricted three-body problem are bodies at `-mu` and `1 - mu` on the x axis of the rotating frame, respectively.
Here the mass ratio `mu` is an attribute of the drawn trajectory set ([frames and contexts](frames.md)).
The two lines below declare the Earth and the Moon of an Earth–Moon scene in this way.

```python
earth = scene.body("earth", frame=rotating, position=[-ty.attr("mu"), 0.0, 0.0], label="Earth", color="#56b4e9")
moon = scene.body("moon", frame=rotating, position=[1 - ty.attr("mu"), 0.0, 0.0], label="Moon", color="#999999")
```

A body is fixed in the frame it is declared in, and it moves in any other frame through the transforms between the two frames.
These transforms may read a channel or an attribute, whose value comes from a context (a trajectory set, one of its trajectories, and one of its samples).
Since a body does not have samples, it does not have a context either, and it takes the context of the panel's reference trajectory (rule `sample-context`).

Suppose that the barycentric inertial frame turns by the time channel, as it does in the circular restricted three-body problem.
Drawn in this frame, the Moon sits at the position given by the time stored with the reference trajectory's sample, and it thus moves with the reference trajectory as the clock runs.
The attributes of a body's position are read from the reference trajectory's set in the same way.
In the Broucke scene the mass ratio `mu` is 0.012155 for family 7 and 0.5 for families 8 and 11.
This attribute is read from the reference trajectory's set, and the primary and the secondary therefore move to their positions for the new family whenever the family changes.

A body is drawn by a body layer, e.g. {func}`ty.body(m1, trail=1.0, size=6.0) <pytycho.body>`, which draws the body at the current fraction along the reference trajectory, with an optional trail and a size (rule `body-layer`).
This fraction along gives the point of the reference trajectory that the clock has reached ([the clock](clock.md)).
The trail covers a fraction of the loop given on the layer, e.g. `trail=1.0` for the whole loop, and the size is the diameter of the body in CSS pixels.
In the Broucke example, the primary and the secondary have a trail of the whole loop, which traces their orbits in the inertial frames.
The body's `label`, when given, is drawn beside the body.
An axis title under this label is hidden, while the label is kept, as where the Moon is on the x axis near the edge of the panel.
A body can also be the origin of a frame ([frames and contexts](frames.md)).

## Reference trajectories

Every declared panel has a reference trajectory, i.e. a set query and a member that resolve to one trajectory, which the panel follows.
The set query specifies the trajectory set, and the member specifies one trajectory of this set ([inputs and references](variables.md#references)).
The function {func}`ty.reference(sets, member) <pytycho.reference>` builds a reference trajectory.
The member is a trajectory index or an input of kind parameter, which picks one trajectory, as in the three reference trajectories below.

```python
ty.reference(loop, 0)  # trajectory 0 of the set loop
ty.reference(family, z0)  # the trajectory that a parameter input picks
ty.reference(ty.by_tags(family=family, branch=branch), e)  # a set chosen by two choices, then a trajectory by a parameter input
```

The reference trajectory gives the context of everything that does not have samples, i.e. the bodies and the frames whose origin is at a body.
Readouts, i.e. the text on the page that shows current values, read the reference trajectory's parameters, attributes, and channels ([panels, controls, and readouts](panels.md)).
A change of the reference trajectory's set refits the panel's camera, i.e. pans and zooms the panel so that what it draws fills it.

The runtime resolves the reference trajectory of every panel whether or not a layer uses it.
The rules on set queries (`set-query`), member references (`members`), and clock channels (`clock-channel-carried`) therefore always apply to the reference trajectory ([section 2.7](../spec.md#27-declared-panels-reference-trajectories-and-layers)).
In particular, the reference trajectory's set carries every clock channel other than `@index`, since the clock computes a fraction along the reference trajectory.

When a reference trajectory's set query does not match any set, e.g. when a choice holds a tag value that does not appear on any set, the bodies are left without a context.
A body layer then does not give a position.
A query that matches more than one set is an error, since a reference trajectory is one trajectory.
The writer rules this error out for every value the inputs can take.
