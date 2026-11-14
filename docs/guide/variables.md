# Inputs and references

An input is a value that the person at the page can change, e.g. the chosen family or the selected eccentricity, with a default and a scope.
The default is the input's value when the page opens, and the scope sets whether the input has one value for the page or one per panel.
Controls (the sliders, tabs, and toggles on the page) write inputs, and panels, layers, and readouts read them.
One declaration thus serves many panels, since a declared panel that reads an input draws whatever the input holds in each shown panel.

## The three kinds

- {meth}`Scene.parameter <pytycho.Scene.parameter>` declares an input of kind parameter, which holds a finite number and selects one trajectory of a set.
  Its argument `parameter` names the parameter whose value the number is, e.g. an eccentricity.
  Where a member reference or a highlight refers to the input, the value is resolved among the trajectories of the trajectory set in which the reference or the highlight is resolved.
  The trajectory with the nearest parameter value is taken, and the one with the lowest index on a tie.
  The built-in parameter `@index` is the number of the member in its set, counted from 0, hence `parameter="@index"` makes the number a trajectory index.
- {meth}`Scene.choice <pytycho.Scene.choice>` holds one of a list of strings, which can be shown by `labels`, one text per value.
  When the values are frame handles, i.e. the objects that `Scene.frame` returns, the input is a choice of frames, which a panel can take as its display frame.
- {meth}`Scene.toggle <pytycho.Scene.toggle>` holds a boolean, e.g. whether a layer is visible.

A member reference specifies the trajectories of a set that a layer draws ([references](#references)), and a highlight draws one member of a layer more prominently ([panels and layers](views.md#trajectories-layers)).
A value of the wrong kind for its input, e.g. a boolean for an input of kind parameter or a number for a toggle, is an error, and it is never converted to the right kind ([section 2.5](../spec.md#25-inputs-and-references)).

An input of kind parameter holds a parameter value rather than an index, hence one input picks matching members in sets of different sizes.
In the Broucke scene, the eccentricity input picks the nearest member in whichever family and branch the other two choices select.

## Scope

The default, `scope="shared"`, gives an input one value for the page, and its control appears once, in the top bar.
Under `scope="per_panel"`, every shown panel keeps a separate value, which is set in {meth}`Scene.show <pytycho.Scene.show>` and changed by the control in the panel's header.
Two shown panels can thus show the same declared panel with different values, e.g. in two frames.
One declared panel serves five frames in this way in the Broucke scene, and the code below declares its frame choice, its declared panel, and two of its five shown panels.
The argument `inputs` of `scene.show` gives the shown panel's value of each per-panel input.

```python
frame = scene.choice("frame", frames, scope="per_panel")
scene.panel("main", frame=frame, reference=ty.reference(members_of, e), layers=layers)
scene.show("pulsating", panel="main", inputs={frame: "rotating-pulsating"})
scene.show("inertial", panel="main", inputs={frame: "barycentric-inertial"})
```

In a shown panel, a reference to a per-panel input reads the panel's value, and a reference to a shared input reads the shared value.
A missing value is the default value of the input.
The writer rejects a panel's value for a shared input, since this value would never be read (rule `input-scope`).

## References

Where a scene takes a value, the document holds either a literal or a reference `{"input": id}`, which reads the input with this id.
The Python handles that the builders return, e.g. the object that `scene.choice(...)` returns, stand for `{"input": id}` in the document.
An input's id string works in place of its handle where a string does not have another meaning, e.g. for a member, a highlight, or a control.
A panel's `frame` reads a string as a frame id, however, and a tags query reads a string as a tag value.
A choice therefore goes into either as its handle, since its id string would be read as a frame id or a tag value.
Four kinds of reference take inputs.

- A panel's `frame` is a frame id or a choice whose values are frame ids.
- A set query specifies the trajectory set that a layer or a reference trajectory draws from.
  It is a set (its handle, its id, or {func}`ty.by_id <pytycho.by_id>`) or a tags query, {func}`ty.by_tags(family=family, branch="periapsis") <pytycho.by_tags>`, whose values are strings or choices.
  A tags query matches every set whose tags contain all the given pairs, hence a choice in it switches the set when the person at the page changes the choice.
  Where one set is needed, as in a layer's `sets` or a reference trajectory, a query without a match makes the layer empty, and more than one match is an error (rule `set-query`).
  A slider's domain, i.e. the sets whose parameter values give the slider its stops, uses every match.
- A member reference specifies which trajectories of the set a layer draws.
  It is `"all"`, a trajectory index, an input of kind parameter, or an evenly spaced selection (rule `members`).
  A literal index at or past the number of trajectories of its set is an error and is never clamped to the last trajectory.
  The parameter of an input of kind parameter must be present on this set, unless it is `@index`.
  An evenly spaced selection, {func}`ty.evenly_spaced(n) <pytycho.evenly_spaced>`, specifies a sparse context of the set, i.e. about `n` of its trajectories.
  It holds every `s`-th trajectory counted from the first, together with the last trajectory, where `s` is the number of trajectories over `n`, rounded (and 1 when `n` is at least the number of trajectories).
  The call `ty.evenly_spaced(40)` thus draws about 40 members spread over a family, as the Broucke scene does under the faint full family.
  A reference trajectory's member is never `"all"` or an evenly spaced selection, since a reference trajectory is one trajectory.
- Three of a layer's drawing options take inputs ([panels and layers](views.md#trajectories-layers)).
  A colormap can be keyed on a choice, whose value then picks the colormap.
  A highlight refers to an input of kind parameter, and the member it resolves to is drawn more prominently.
  The option `visible` refers to a toggle, and the layer is omitted while the toggle is false.

The writer checks the rules that depend on inputs for every combination of choice values that a declared panel can be drawn with, meaning that a scene the writer accepts is valid whatever the person at the page selects.
The single declared panel of the Broucke scene is thus checked for all 30 combinations of the three families, the two branches, and the five frames.
