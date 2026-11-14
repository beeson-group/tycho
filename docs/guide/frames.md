# Frames and contexts

A frame is a coordinate frame, e.g. the rotating frame of a restricted three-body problem or an inertial frame centered on the barycenter.
Frames form a tree with a single root, i.e. one frame without a parent, from which every other frame descends.
{meth}`Scene.frame <pytycho.Scene.frame>` declares a frame, and every frame but the root is declared with its `parent`.
A child frame is defined against its parent by three quantities, each optional.

- The `origin` is where the child's origin lies in the parent.
- The `rotation` is how the child's axes are turned against the parent's.
- The `scale` is how many child units one parent unit is.

A frame also carries a `label`, up to three `axes` labels, and a `unit` label, which are text only and do not affect any computation.
Under a 2d camera (a flat picture of one coordinate plane), an `axes` layer that spans the panel, as it does by default there, titles each axis with its label and the unit ([panels and layers](views.md#body-axes-and-grid-layers)).
In the rotating frame of the Broucke example, the title of the first axis is `x̃ [DU]`, where DU is the semi-major axis of the relative orbit of the primary and the secondary.

## The transform

A transform is the map from a parent frame to a child frame, given by the origin, the rotation, and the scale of the child.
A transform takes a point from the parent frame to the child frame by the equation below (rule `transform`)

```text
p_child = s * R * (p_parent - o)
```

where the point is `p_parent` in the parent and `p_child` in the child, `o` is the origin in the parent's coordinates, `R` is the right-handed rotation by `angle` radians about the named axis, and `s` is the scale.
In words, the transform first subtracts the origin, then rotates, then scales.
Right-handed means counterclockwise when seen from the positive end of the axis.
A point fixed in the parent thus appears in the child rotated by `+angle`.
A transform without a rotation has the identity as `R`, i.e. the child's axes are parallel to the parent's.
A transform without a scale has `s = 1`, and a transform without an origin has `o = 0`.

To take a position from frame A to frame B, the runtime applies inverse transforms from A up to the lowest common ancestor, then forward transforms down to B (rule `frame-path`).
An inverse transform goes from the child back to the parent, by `p_parent = o + R^T * (p_child / s)`, where `R^T` is the transpose of `R`, which for a rotation is also its inverse.
The lowest common ancestor is the deepest frame that is an ancestor of both A and B, or A or B itself when one lies above the other.

Equivalently, `angle` is the angle of the parent's axes measured in the child.
A rotating frame seen from an inertial frame turns by the true anomaly `f`, hence the inertial frame is the child of the rotating frame, with `angle = f`.
The minimal scene of the [quickstart](../quickstart.md) and the Broucke example both declare the inertial frame in this way.
The code below declares the first three frames of the Broucke example.

```python
pulsating = scene.frame("rotating-pulsating", label="rotating-pulsating", axes=("x", "y", "z"), unit="DU")
rotating = scene.frame("rotating", label="rotating", axes=("x̃", "ỹ", "z̃"), unit="DU", parent=pulsating, scale=ty.channel("rho"))
inertial = scene.frame(
    "barycentric-inertial",
    label="barycentric inertial",
    axes=("ξ", "η", "ζ"),
    unit="DU",
    parent=rotating,
    rotation=ty.rotation("z", ty.channel("true_anomaly")),
)
```

The Broucke orbits are stored in the rotating-pulsating frame, the root of the tree, in which the primary and the secondary stay at a fixed distance of 1.
The rotating frame is the pulsating frame scaled by `rho`, the distance between the primary and the secondary, which changes along their elliptic orbit.
The barycentric inertial frame is the rotating frame turned by the true anomaly of this orbit.
Both `rho` and the true anomaly are channels that PyDyLAN, the library that propagated the orbits, computed for every sample.
The scene therefore does not hold any formula of the elliptic restricted three-body problem.

## Numbers that depend on context

Several arguments take a scalar, i.e. one number, that may depend on which trajectory set, trajectory, and sample is being drawn.
A scalar takes one of three forms ([section 2.2](../spec.md#22-numbers-that-depend-on-context)).

- A number, i.e. a constant.
- An attribute of the drawn set, e.g. the mass ratio {func}`ty.attr("mu") <pytycho.attr>`, with a factor and an offset.
  Its value is the factor times the attribute plus the offset, and Python arithmetic on an attribute sets the two.
  The expression `1 - ty.attr("mu")` is thus the attribute times -1 plus 1.
  One attribute can thereby serve several fields, e.g. the positions `-mu` and `1 - mu` of the primary and the secondary.
- A channel of the drawn sample, {func}`ty.channel("rho") <pytycho.channel>`, whose value changes along the trajectory.
  The channel `@index` is not allowed here.

The keys `rotation.angle`, `scale`, and every entry of `origin` take any of the three forms, hence an angle can follow a stored channel such as the true anomaly, and an origin can move along a trajectory.
A body's position takes three scalars, every one a number or an attribute, since a point that moves per sample belongs in a trajectory (rule `origin`).
A scene with an origin given by a channel lists the feature `frames.origin_channel` in its `requires`, which pytycho adds.
The function {func}`ty.rotation(axis, angle) <pytycho.rotation>` builds a rotation about `"x"`, `"y"`, or `"z"`.

Every evaluation happens in a context, which consists of one trajectory set, one of its trajectories, and one of its samples.
The context determines where the value of a scalar comes from.
An attribute is read from the context's set, and a channel from the context's sample.
The context of a sample of a drawn trajectory is the sample itself (rule `sample-context`), i.e. its set, its trajectory, and its index.
Every sample is therefore transformed by the angle and the scale evaluated in its context, i.e. by the values stored with it and the attributes of its set.

Between two samples the runtime blends the two transformed points rather than using a blended angle (rule `segment`).
A frame that turns by a stored angle thus never turns by an interpolated angle.
Some samples are evaluated in a shifted context, whose channels are raised or lowered by whole periods (rules `revolutions` and `trail-wrap`).
These are the samples drawn in a later revolution of the clock ([the clock](clock.md#revolutions)), and those in the part of a trail that wraps back past the first sample.
A body does not have samples, and it takes its context from the panel's reference trajectory, i.e. the trajectory that the panel follows ([bodies and reference trajectories](bodies.md)).

## Origins at bodies

An origin can be a body, i.e. a named point, instead of three scalars.
Passing `origin=m1` puts the child's origin at the body's position, expressed in the parent frame in the same context (rule `origin`).
An origin at a body placed at `-mu` thus takes the `mu` of the set being drawn.
The Broucke scene centers two inertial frames on the primary and the secondary in this way, and the two lines below declare the primary and the frame centered on it.

```python
m1 = scene.body("m1", frame=pulsating, position=[-ty.attr("mu"), 0.0, 0.0], label="m1", color="#e69f00")
scene.frame("inertial-m1", label="inertial, centered on m1", axes=("ξ₁", "η₁", "ζ₁"), unit="DU", parent=inertial, origin=m1)
```

An origin at a body must not depend on itself, directly or through other origins at bodies (rule `body-origin-cycle`), since its position would then be circular.

## What a set must carry

The display frame of a panel is the frame in which the panel draws everything.
A set drawn in a display frame carries every channel read by a transform on the path from the frame of the set to the display frame, and every attribute read there (rule `transform-channels`).
The reason is that each such transform is evaluated in the context of the set's samples and requires the values there.
The same holds for a panel's reference trajectory and for the bodies drawn in the panel, since the bodies take the reference trajectory's context.
In the Broucke example every set carries `rho` and `true_anomaly`, because the path from the rotating-pulsating frame to the barycentric inertial frame reads both.

The writer checks this rule for every value the inputs can take, since an input may change the display frame or the set.
The error message lists the set, the frame, and what is missing, as in the example of [how a scene fails](index.md#how-a-scene-fails).

A scale is never zero, since a zero scale would collapse the frame to a point and the inverse transform would divide by zero.
The writer rejects a scene in which a scale can be zero in any context the scene can evaluate, including the contexts of the other revolutions (rule `origin`).
These are the contexts of the periods before and after the stored one.

Frames are generic, since TyCHO does not implement any restricted three-body problem, circular or elliptic, or any ephemeris.
A frame of a dynamical model is built as a chain of transforms, which read channels and attributes computed by the library that produced the trajectories.
Per-sample channels from this library are therefore the main source of every moving frame.
