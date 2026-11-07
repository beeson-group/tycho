# Variables and references

A variable is a piece of state that a person viewing the page can change, e.g. the chosen family or the selected eccentricity, with a default and a scope. The default is the variable's value when the page opens, and the scope sets whether the variable has one value for the page or one per panel. Controls (the sliders, tabs, and toggles on the page) write variables, and views, layers, and readouts read them. One declaration thus serves many panels, since a view that reads a variable draws whatever the variable holds in each panel.

## The three kinds

- {meth}`Scene.selector <pytycho.Scene.selector>` holds a finite number and selects one track of a set. Its argument `by` specifies how the number is read.
  - By `nearest`, the default, the number is a value of a named parameter, e.g. an eccentricity. Where a member reference or a highlight refers to the selector, the value is resolved among the tracks of the track set in which the reference or the highlight is resolved. The track with the nearest parameter value is taken, and the one with the lowest index on a tie.
  - By `index`, the number is a track index, rounded to the nearest integer and clamped to the set's tracks, i.e. to the indices from 0 to the last.
- {meth}`Scene.choice <pytycho.Scene.choice>` holds one of a list of strings, which can be shown by `labels`, one text per value. When the values are frame handles, i.e. the objects that `Scene.frame` returns, the variable is a choice of frames, which a view can take as its display frame.
- {meth}`Scene.toggle <pytycho.Scene.toggle>` holds a boolean, e.g. whether a layer is visible.

A member reference specifies the tracks of a set that a layer draws ([references](#references)), and a highlight draws one member of a layer more prominently ([views and layers](views.md#track-layers)). A value of the wrong kind for its variable, e.g. a boolean for a selector or a number for a toggle, is an error, and it is never converted to the right kind ([section 2.5](../spec.md#25-variables-and-references)).

A selector by `nearest` holds a parameter value rather than an index, hence one selector picks matching members in sets of different sizes. In the Broucke scene, the eccentricity selector picks the nearest member in whichever family and branch the other two choices select.

## Scope

The default, `scope="scene"`, gives a variable one value for the page, and its control appears once, in the top bar. Under `scope="panel"`, every panel keeps a separate value, which is set in {meth}`Scene.panel <pytycho.Scene.panel>` and changed by the control in the panel's header. Two panels can thus show the same view with different values, e.g. in two frames. One view serves five frames in this way in the Broucke scene, and the code below declares its frame choice, its view, and two of its five panels. The third argument of `scene.panel` gives the panel's value of each panel-scoped variable.

```python
frame = scene.choice("frame", frames, scope="panel")
scene.view("main", frame=frame, driver=ty.driver(members_of, e), layers=layers)
scene.panel("pulsating", "main", {frame: "rotating-pulsating"})
scene.panel("inertial", "main", {frame: "barycentric-inertial"})
```

In a panel, a reference to a panel-scoped variable reads the panel's value, and a reference to a scene-scoped variable reads the scene's value. A missing value is the default value of the variable. The writer rejects a panel value for a scene-scoped variable, since this value would never be read (rule V1).

## References

Where a scene takes a value, the document holds either a literal or a reference `{"var": id}`, which reads the variable with this id. The Python handles that the builders return, e.g. the object that `scene.choice(...)` returns, stand for `{"var": id}` in the document. A variable's id string works in place of its handle where a string does not have another meaning, e.g. for a member, a highlight, or a control. A view's `frame` reads a string as a frame id, however, and a tags query reads a string as a tag value. A choice therefore goes into either as its handle, since its id string would be read as a frame id or a tag value. Four kinds of reference take variables.

- A view's `frame` is a frame id or a choice whose values are frame ids.
- A set query specifies the track set that a layer or a driver draws from. It is a set (its handle, its id, or {func}`ty.set_id <pytycho.set_id>`) or a tags query, {func}`ty.sets(family=family, branch="periapsis") <pytycho.sets>`, whose values are strings or choices. A tags query matches every set whose tags contain all the given pairs, hence a choice in it switches the set when a person viewing the page changes the choice. Where one set is needed, as in a layer's `sets` or a driver, a query without a match makes the layer empty, and more than one match is an error (rule V2). A slider's domain, i.e. the sets whose parameter values give the slider its stops, uses every match.
- A member reference specifies which tracks of the set a layer draws. It is `"all"`, a track index, a selector, or a count (rule V3). A literal index at or past the number of tracks of its set is an error and is never clamped to the last track. The parameter of a selector by `nearest` must be present on this set. A count, {func}`ty.every(n) <pytycho.every>`, specifies a sparse context of the set, i.e. an evenly spaced selection of about `n` of its tracks. It holds every `s`-th track counted from the first, together with the last track, where `s` is the number of tracks over `n`, rounded (and 1 when `n` is at least the number of tracks). The call `ty.every(40)` thus draws about 40 members spread over a family, as the Broucke scene does under the faint full family. A driver's member is never `"all"` or a count, since a driver is one track.
- Three of a layer's drawing options take variables ([views and layers](views.md#track-layers)). A colormap can be keyed on a choice, whose value then picks the colormap. A highlight refers to a selector, and the member it resolves to is drawn more prominently. The option `visible` refers to a toggle, and the layer is omitted while the toggle is false.

The writer checks the rules that depend on variables for every combination of choice values that a view can be drawn with, meaning that a scene the writer accepts is valid whatever a person viewing the page selects. The single view of the Broucke scene is thus checked for all 30 combinations of the three families, the two branches, and the five frames.
