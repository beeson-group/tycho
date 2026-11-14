# Panels, controls, and readouts

## Panels and the layout

A panel is one picture on the page.
A shown panel is a panel on the page, and it shows one declared panel ([panels and layers](views.md)) and holds a separate value of each per-panel input, i.e. of each input whose value is set per panel.
The id of a shown panel is often the id of its declared panel, and a copy of a declared panel that is already shown gets a new id.
The method {meth}`Scene.show <pytycho.Scene.show>` adds a shown panel to the initial state, i.e. to the page as it first opens, with the panel's id, its declared panel, and its values.
{meth}`Scene.layout <pytycho.Scene.layout>` arranges the shown panels on the page as a tree of splits.
Each split, {func}`ty.split(dir, ratio, a, b) <pytycho.split>`, divides its area into two parts `a` and `b`, and each part is either another split or the id of a shown panel, which is a leaf of the tree.
The three calls below show the declared panel `main` twice and put the two shown panels side by side.
The first shows the rotating-pulsating frame, and the second shows the barycentric inertial frame.

```python
scene.show("pulsating", panel="main", inputs={frame: "rotating-pulsating"})
scene.show("inertial", panel="main", inputs={frame: "barycentric-inertial"})
scene.layout(ty.split("row", 0.5, "pulsating", "inertial"))
```

The direction `dir` is `"row"`, which puts `a` and `b` side by side, or `"col"`, which puts `a` above `b`.
The `ratio`, in `(0, 1)`, is the share of the area that `a` takes.
Without a layout, the shown panels sit in one row at equal widths, in the order in which they were added.
When the layout names an id that was not added with `scene.show` and that equals the id of a declared panel, pytycho shows this declared panel under its own id.

The state of the page is everything that the person at the page can change ([section 2.8](../spec.md#28-state)).
It consists of the shown panels with their declared panels and values, the layout, the clock channel, and the values of the shared inputs.
The scene carries its starting state as `initial`, and this person then changes the state from the page.
The page stores the state in the browser's local storage, i.e. the storage that the browser keeps for each site across visits.
The state is stored under a hash of `scene.tys`, hence a state saved for one scene is not applied to another.
Before using a stored state, the page repairs it against the scene, e.g. it drops a shown panel whose declared panel the scene does not declare.
The circular arrow in the footer resets the scene, i.e. it discards the stored state and goes back to `initial`.

The top bar of the page holds the title, the controls of the shared inputs, and a row of Add panel chips, i.e. small labeled buttons that each add a panel.
The chips stand for the declared panels of the scene, each shown by its label or its id, and for nothing else.
This holds also when the scene has one declared panel and a per-panel choice, as the Broucke scene does, i.e. the example scene of Broucke's periodic orbits in the elliptic restricted three-body problem.
Adding a declared panel that is already shown makes a copy of it with a new id, whose frame is then switched with the chip in its header.
A chip adds a panel in three ways.

- A click on a chip adds a panel where there is most room, by splitting the largest panel.
- A drag of a chip onto a panel splits this panel on the side that a drop marker shows during the drag (right, left, above, or below).
  A drop on the panel's center replaces what the panel shows.
- The caret of a chip, i.e. the small arrow beside its name, opens a menu that adds the panel, or that splits or replaces any panel by name.
  This menu is the way to do it from the keyboard.

When the chips would not fit on one line, one Add panel button takes their place.
A page holds at most eight panels.

Each panel has a header, i.e. a bar along the top of the panel.
The chip in the header shows the panel's value of the per-panel choice, which is usually the panel's frame, and the chip's caret opens the list of the choice's values.
In a scene without a per-panel choice, the chip shows the panel's frame and does not have a caret.
The header also holds the controls of the other per-panel inputs, a house icon that resets the panel's view, and a × that closes the panel when there is more than one.
The panels are rearranged with the pointer.

- A drag of a panel by its header onto another panel moves it to the side of the other panel that the drop marker shows.
- A drop of the dragged panel onto the other panel's center swaps the two.
- A drag of the gutter, i.e. the gap between two panels, resizes them.

## Controls

A control is a widget on the page that is bound to an input or to the clock, through which the person at the page changes it.
The table below lists the four builders of controls, the widget that each puts on the page, and what the widget binds ([section 2.9](../spec.md#29-controls-and-readouts)).

| Builder | Control | Binds |
|---|---|---|
| {meth}`~pytycho.Scene.slider` | a slider | an input of kind parameter, with a `domain` set query |
| {meth}`~pytycho.Scene.tabs` | tabs, or a menu in a panel header when a per-panel choice has more than three values | a choice |
| {meth}`~pytycho.Scene.toggle_control` | a checkbox | a toggle |
| {meth}`~pytycho.Scene.playback` | play and pause, the scrubber, the frame counter, the speed, and the clock tabs | the clock |

A control over a per-panel input appears in the header of every panel and sets the value of the panel in which it sits.
A control over a shared input appears once, in the top bar.
Tabs over the choice that the header chip shows are drawn as the chip itself, since the chip already opens the list of the choice's values.
A scene without a playback control is static, i.e. it shows the initial frame index and does not animate.
The one exception is autoplay on a kiosk page, i.e. a page written for a slide, which plays at once ([embedding and kiosk pages](html.md#embedding-and-kiosk-pages)).

A slider sets an input of kind parameter, i.e. an input that holds a parameter value and picks the trajectory whose parameter is nearest to it.
Its `domain` is a set query that specifies which trajectory sets the slider ranges over.
The slider's stops are the distinct values of the input's parameter over the sets that the domain matches, in increasing order, hence the slider snaps from one existing member to the next.
Moving the slider to a stop writes the value of the stop into the input.
Every set of the domain carries the parameter for every value the inputs can take, and the writer rejects a slider that breaks this rule.
When the domain does not match any set, the slider is disabled.
A change of the domain, e.g. through a choice that the query depends on, never changes the input's value.
The Broucke page therefore keeps the eccentricity when the family changes, and the input picks the nearest member of the new family.
Its slider over the eccentricity input `e` is declared below.

```python
scene.slider(e, label="eccentricity", domain=ty.by_tags(family=family, branch=branch))
```

The footer, i.e. the bar at the bottom of the page, holds three groups.

- Playback holds the playback control.
  While the scene plays, this group also shows how many pictures were drawn in the last second.
  The tooltip of this count gives how many came late, i.e. more than half a refresh interval after the picture they should have followed, and the display's refresh rate.
- View holds the house icon that resets every panel's view and the circular arrow that resets the scene.
- Export video comes last and opens the options of the [video export](html.md#the-video-export).

## Readouts

A readout is a piece of text on the page that shows current values, e.g. the eccentricity of the selected member.
{meth}`Scene.readout <pytycho.Scene.readout>` builds a readout from a place and a list of parts, which are concatenated.
The place is `"caption"`, i.e. once under the panels, or `"panel"`, i.e. in every panel.
A part takes one of six forms.

- A string is shown as it is.
- An input handle, i.e. the Python object that the builder of an input returns, shows the input's value.
  It shows a choice by its label, a toggle as on or off, and a number to `digits` significant digits.
  Without `digits`, an integer is shown as it is and any other number to six significant digits.
- The part `{"parameter": name}` shows a parameter of the reference trajectory, i.e. of the trajectory that the panel follows, and the name `@index` shows its number in its set.
- The part {func}`ty.attr(name) <pytycho.attr>` or `{"attr": name}` shows an attribute of the reference trajectory's set, i.e. a number stored once for the whole set.
  It takes a factor and an offset, and it then shows the attribute times `factor` plus `offset`.
- The part {func}`ty.channel(name) <pytycho.channel>` or `{"channel": name}` shows a channel of the reference trajectory at its current fraction along.
  The value is blended between the two samples around this fraction along, in the current revolution of the reference trajectory.
- The part `{"clock": "frame_index"}` shows the frame index, and `{"clock": "frame_count"}` shows the frame count, i.e. the number of frame indices in one loop.

Every dict part except the clock's takes `digits`, the number of significant digits, from 1 to 17.
In a panel, the parts read the panel's reference trajectory.
In the caption, which all panels share, they read the reference trajectory of the first panel in layout order.
The writer rejects a part that refers to a parameter, an attribute, or a channel that the reference trajectory's set does not carry for some value of the inputs.
Readouts do not have a template language, i.e. there is not a format string, only the list of parts.
Every string is written as plain text and never as markup, hence a string cannot inject HTML or script into the page (rule `plain-text`).

When the text of a readout splits into stat tiles, the page shows the readout as tiles.
A stat tile is a small box that shows a label above a value in a monospace font, with the value's unit.
The text of the readout is split around each value part by three rules.

1. The label of a value is the text after the last comma before the value, without a trailing `=` or `:`.
2. The unit of a value is the text after the value up to the next comma.
3. The tiles of attribute parts, which are constants of the set, go last.

A readout that does not split this way, e.g. one with an empty label, is shown as one line of text.
The caption's tiles sit in a row under the panels, and a panel's tiles are stacked at its bottom left.
The caption of the Broucke scene gives four tiles, labeled "e", "period", "closure error", and "mu".
They show the eccentricity, the period in radians, the closure error, and the mass ratio, respectively.
The closure error is how far the propagated orbit ends from where it started.
It is in DU, the length unit of the rotating-pulsating frame, in which the orbits are stored.
The call below builds these tiles.

```python
scene.readout(
    "caption",
    "e = ",
    {"parameter": "eccentricity", "digits": 4},
    ", period ",
    {"parameter": "period", "digits": 5},
    " rad, closure error ",
    {"parameter": "closure_error", "digits": 2},
    " DU, mu = ",
    {"attr": "mu", "digits": 6},
)
```

In this call, the text `" rad, closure error "` between the second and the third value splits at its comma.
The part before the comma gives the unit `rad` of the period, and the part after it gives the label `closure error` of the next tile.

## Colorbars

A colorbar is a strip that shows a colormap against its values.
A trajectories layer colored by a colormap shows a colorbar at the panel's top right.
The colorbar is titled with the parameter's label and unit, or with the channel's name, and it marks the highlighted member.
When a shared input of kind parameter is over the same parameter, the colorbar acts as a second slider for this input.

- A click or a drag on the colorbar jumps the input to the stop nearest the value under the pointer.
- With the colorbar focused, the arrow keys move the input by one stop, PageUp and PageDown by ten stops, and Home and End to the first and the last stop.

The stops are those of the input's slider, or the parameter's values over the layer's set when the input does not have a slider.
The ends of the bar are written as integers when both are integers, as for an iterate count, and to three significant digits otherwise.
On a kiosk page the colorbar is shown, but it does not act as a slider.

## Keys

The keys below act while the viewer element, `<tycho-viewer>`, has the keyboard focus, also when the focus is on one of its tabs, switches, or buttons, where only a key that the control takes itself, such as Space, is left to it.
In a text field or a select, every key is left to the field.
Hence `0` rewinds the loop right after a click on a tab.

- Space or `k` plays and pauses.
- The right and left arrows move by one frame index and pause, or by ten frame indices with Shift.
- Home or `0` goes to frame index 0, and `1` to `9` go to as many tenths of the loop.
- `F` resets every panel's view, as the house icon in the View group does: a panel whose camera has keyframes (see [the timeline](timeline.md)) follows its keyframes again, and any other panel is fitted to what it draws.
  A double click on a panel resets its own view.
- The up and down arrows move the first slider over a shared input by one stop, or ten stops with Shift.
- In a panel with a 3d camera, `x`, `y`, and `z` show the view from the positive side of that axis of the display frame, and Shift shows it from the negative side.
  The camera keeps its distance from its target, and the camera's up axis stays up the screen.
  Seen along the up axis, the view is a plot of the other two axes, e.g. of x to the right and y up under the up axis z.
- In a panel with a 3d camera, `.` and `,` turn the view about the camera's up axis by 15 degrees, as a drag to the right or to the left does, and Shift turns it by 90 degrees.
  These keys and the axis keys act on the panel under the pointer, or on every panel with a 3d camera when the pointer is over none of them.
- Escape closes an open menu or the export options.

The keys that play, step, and seek require a playback control, except on a kiosk page, which plays without one.

A drag across a panel with a 3d camera turns the view about the camera's up axis, as a turntable does.
A drag up or down the panel tilts the view toward this axis, so that the up axis stays up the screen.
Shift with a drag, or a drag with the right button, pans the view, and the wheel or a pinch zooms it.
While the pointer is over such a panel, the keys of a 3d camera are listed at its foot, as key caps over what they do.
The list is hidden under `minimal` and `kiosk`, i.e. on a slide, and on a device whose pointer does not hover, such as a phone.
The keys act there all the same.

A panel whose camera has keyframes stops following them once it is panned or zoomed, so that it stays where it was moved while the scene plays on.
It then shows a button, Timeline view, in its lower right corner, which hands the camera back to the keyframes, as `F` does for every panel.
