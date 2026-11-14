# Quickstart

## Install

```sh
pip install pytycho
```

pytycho requires only Python 3.10 or later and NumPy, since the browser runtime ships inside the wheel and is inlined into every page that pytycho writes.
Before version 1.0, a new minor version (the second number, as in 0.3 after 0.2) may break the scene format.
A requirement should thus fix the minor version, e.g. {{ "`pytycho>=" ~ version.split(".")[0] ~ "." ~ version.split(".")[1] ~ ",<" ~ version.split(".")[0] ~ "." ~ (version.split(".")[1] | int + 1) ~ "`" }}, under which pip installs any release of this minor version but not the next one.

In a source checkout (a clone of the repository), the runtime has to be built once, since the built file is not tracked in git.
The commands below build it with npm and install pytycho in editable mode, in which Python imports it from the checkout.

```sh
(cd web && npm ci && npm run build)   # writes web/dist and src/pytycho/_static/tycho.js
pip install -e .
```

## The minimal scene

The script below writes a page of two panels, which show one looping trajectory in a rotating frame and in an inertial frame.
The same script is given in the agent [skill](agents.md), and it is run by a test of the repository.

````{literalinclude} ../skills/tycho/SKILL.md
:language: python
:start-after: "```python"
:end-before: "```"
````

Line by line, the script does the following.
Each term is defined in the [glossary](glossary.md), and each key that a call writes is described in the [scene reference](reference.md).

- Two frames form a tree, in which every frame but the root is defined against its parent.
  The frame `rotating` is the root, and `inertial` is its child.
  The child is turned about the z axis by the channel `angle` of whichever sample is being drawn, meaning that each sample is turned by the angle stored with it.
- The trajectory set `loop` holds one trajectory, an ellipse of 400 samples stored in the rotating frame.
  The angle is stored beside every sample as a channel, which holds one number per sample.
  With `periodic=True`, the last sample is the first sample again, one period later.
  A trail can then reach back across the start of the trajectory into the previous period, rather than being cut at the first sample.
- The input `frame` is a choice, which holds one of a list of strings, here the two frame ids.
  It is held per panel, meaning that each panel holds a separate value, and the two panels can thus show different frames.
- The clock is the time of the animation, which every panel shares.
  One loop has a frame count of 200, i.e. it runs through 200 frame indices, where a frame index numbers one instant of the animation.
  The clock channel can be the angle or `@index`, the stored sample index, which is a channel built into every trajectory.
  The moving point advances in equal steps of the clock channel, and the page starts with the first channel of the list, `angle`.
- The declared panel `main` draws three layers.
  The first draws the whole loop, the second draws the same trajectory again with a trail and a head, and the third draws the axes.
  The trail is a stretch of 30 percent of the loop that follows the moving point, and the head is a marker at the moving point.
  The reference trajectory of the panel, trajectory 0 of `loop`, is the trajectory that bodies and readouts follow.
- Two shown panels, `p1` and `p2`, show the same declared panel, one in each frame, side by side.
  The tabs over `frame` are a control, and since `frame` is held per panel, they appear in the header of each panel as a chip (a small button) that shows the frame of the panel.
  The playback is the control that plays the clock.

## What the page shows

Open `loop.html` in a browser, from disk or from any web server, since the scene, the data, and the runtime are all inside the file.
The left panel draws the ellipse in the rotating frame, where it stays put, with the head running around it.
The right panel draws the same 400 samples in the inertial frame, each turned by the angle stored with it, and these points trace a different closed curve.
The page does not compute any rotation angle.
The runtime reads the angle stored with each sample, and between two samples it blends the two transformed points, i.e. it transforms both samples first and then interpolates linearly between the two results (rule `segment` of the [spec](spec.md)).

You can work the page in the following ways.

- Space or the play button starts and stops the animation, and the left and right arrow keys move by one frame index.
- The caret (the small arrow) of a panel's frame chip switches the frame of the panel.
- The clock tabs in the footer change the clock channel.
- The Add panel menu in the top bar offers the declared panel `main`, and adding it makes a copy with a new id.
  Dragging a panel by its header rearranges the layout.
- The house icon in a panel's header, or a double-click on the panel, resets its view after a pan or a zoom.
  The key `f` resets the view of every panel.
- The circular arrow in the footer resets the scene to the state that was written, the initial state of the scene.

The page keeps its state in the browser's local storage, so that a reload restores it.
The state holds the shown panels, their layout, the values of the inputs, and the clock channel.

A scene that breaks a rule is not written.
Every builder checks its arguments at the call.
The methods `write_html`, `write`, and `to_document` also check the whole scene for every value its inputs can take, since the person at the page can set any of these values.
They raise {class}`~pytycho.SceneError` with one line per failure.
Each line starts with the name of the rule it breaks, such as `transform-channels`, from the named rules of the [spec](spec.md).

## The example

[`examples/broucke/build.py`](https://github.com/beeson-group/tycho/blob/main/examples/broucke/build.py) draws Broucke's (1969) families 7, 8 and 11 of the planar elliptic restricted three-body problem in the five frames of Broucke's figures, with one colormap (a color scale) per frame.
A family is a set of periodic orbits that changes continuously from one member to the next.
Its page is in the [gallery](gallery.md).

The script imports only NumPy, pytycho, and the standard library.
It reads the trajectories from `broucke-input.tyd`, a TyCHO data container of about 85 MB, which is attached to each [GitHub Release](https://github.com/beeson-group/tycho/releases) rather than kept in the repository.
The trajectories cover one period of each of the 1877 members, which are the periodic orbits of the three families.
They were computed with PyDyLAN and thinned to at most 1920 samples a member, by keeping a subset of the samples that PyDyLAN computed.
Download the input file next to the script, from the release of the version you have installed, and build the page.
For version {{ version }} the commands are the following, in which `gh` is the GitHub command-line tool.

{{ "```sh\ngh release download v" ~ version ~ " --repo beeson-group/tycho --pattern broucke-input.tyd --dir examples/broucke\npython examples/broucke/build.py\n```" }}

The script writes the scene document `broucke.tys`, the data container `broucke.tyd`, and the page `broucke.html`.
Four options change what it does.

- The option `--out` gives the directory that the three files are written into, which defaults to the directory of the script.
- The option `--input` selects another input file.
- The option `--members N` keeps the first, middle, and last N members of every family, for a quick run.
- With `--no-page`, the script writes the two files without the page.

The page carries the true anomaly, the pulsation scale, and the time for every sample of its 1877 members.
The true anomaly is the angle along the elliptic orbit of the primary and the secondary, measured from periapsis, and it is the independent variable of the elliptic problem.
The pulsation scale is the distance between the primary and the secondary, which changes along this orbit.
The transforms of the frames read these two channels, and the clock can run on the time or on the true anomaly.
The frame tree of the example is explained in the comments of its function `declare_frames`.
Each member is thinned to at most 480 samples, which brings the page to about 13 MB.

## Next

- The [scene reference](reference.md) describes every key of a scene, with its units and its default.
- The how-to pages explain [thinning](guide/thinning.md) and [the page and its video export](guide/html.md).
- The agent [skill](agents.md) sets out for a coding agent how the pieces of a scene fit.
- The [spec](spec.md) sets out the contract between pytycho, which writes a scene, and the runtime, which draws it, rule by rule.
