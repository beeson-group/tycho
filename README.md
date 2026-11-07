# Typed Celestial HTML Observer (TyCHO)

TyCHO makes animated, interactive astrodynamics visualizations that ship as a single HTML file. Each one has a black background, sliders, tabs, and panels you drag and drop, and it can show several reference frames of the same orbit family side by side, e.g. a rotating frame next to an inertial one. Open the file standalone in a browser, embed it on a website, or drop it into a slide of a reveal.js presentation. The page works offline and from disk, since the data and the code that draws them are both inside the file.

TyCHO is a visualizer, not a physics engine. It draws trajectories that another library has computed, and it does not integrate any equation of motion. A scene is the complete description of one visualization, and it consists of two files, which a Python script writes from NumPy arrays. The data container `data.tyd` holds only named typed arrays, i.e. arrays whose elements all share one type, such as `float64`. The scene document `scene.tys` is JSON that refers to these arrays by name and specifies what they are and how to draw them. It declares the pieces below.

- A track set is a collection of trajectories, called tracks, that share a frame and a meaning (e.g. the members of one orbit family). Each stored point of a track is a sample, and per-sample channels store further numbers at every sample, such as the time or the true anomaly.
- A body is a named point, such as the primary or the secondary of a three-body problem.
- The reference frames form a tree, in which every frame but the root is defined against its parent by an origin, a rotation, and a scale.
- A variable is a piece of state that a person viewing the page can change, e.g. which member of a family is selected.
- The clock is the animation time, which every panel shares, so that all panels move together.
- A view is a template for one picture, and each of its layers draws one thing, such as the tracks of a set, a body, or the axes.
- A panel is one picture on the page, which shows one view, and several panels can sit side by side.
- A control is a widget that sets a variable or the clock, i.e. a slider, tabs, a toggle, or the transport with its play and pause buttons.
- A readout is a piece of text that shows current values, e.g. the eccentricity of the selected member.

Together these declarations form the scene grammar, i.e. the vocabulary from which every scene is built. The browser runtime, a JavaScript program that the page carries inline, reads a scene in this grammar and draws it. The only mathematics of the runtime is rotation, scaling, and translation, which take a stored point from one frame into another, and a linear blend between two stored samples. Every number on screen therefore comes from the library that computed the trajectory.

| Package | Registry | What it is |
|---|---|---|
| `pytycho` | PyPI | the Python package that writes scenes, i.e. the `Scene` builder, the data container, and the HTML writer, which bundles the runtime |
| `@beeson-group/tycho` | npm | the browser runtime, as an ECMAScript module and as an immediately invoked function expression, i.e. a plain script that defines the global `tycho`. It holds the scene reader, the evaluator (the function that computes what each panel draws at a given frame), and the `<tycho-viewer>` web component (a custom HTML element that draws a scene). |

Most users need only pytycho, since every page that it writes carries the runtime inline.

## Quick start

```sh
pip install pytycho
```

The script below writes the page `loop.html`, which shows one elliptical loop in two panels side by side, in a rotating frame and in an inertial frame.

```python
import numpy as np
import pytycho as ty

scene = ty.Scene(title="a rotating loop")
rotating = scene.frame("rotating", axes=("x", "y", "z"))
scene.frame("inertial", parent=rotating, rotation=ty.rotation("z", ty.channel("angle")))

loop = scene.track_set("loop", frame=rotating, periodic=True)
angle = np.linspace(0.0, 2.0 * np.pi, 400)
loop.add(np.column_stack([np.cos(angle), 0.5 * np.sin(angle)]), channels={"angle": angle})

frame = scene.choice("frame", ["rotating", "inertial"], scope="panel")
scene.clock(channels=["angle", "@index"], steps=200)
layers = [ty.track(loop), ty.track(loop, 0, trail=0.3, head=True, width=2.0), ty.axes()]
scene.view("main", frame=frame, driver=ty.driver(loop, 0), layers=layers)
scene.panel("p1", "main", {frame: "rotating"})
scene.panel("p2", "main", {frame: "inertial"})
scene.tabs(frame, label="frame")
scene.transport()
scene.write_html("loop.html")
```

The script declares two frames, `rotating` and its child `inertial`, and a track set `loop` that holds one ellipse of 400 samples in the rotating frame. Each sample also stores its angle, as the channel `angle`. The call `ty.channel("angle")` makes the inertial frame turn by the stored angle of each sample. The runtime thus never integrates or interpolates a channel. It draws the samples it was given, in the frames that the scene declares. The choice variable `frame` is scoped to the panel, hence the panels `p1` and `p2` each hold a separate value of it and show the view `main` in different frames. The tabs switch the frame of a panel, and the transport plays the clock, which runs 200 animation frames per loop.

The full example, [`examples/broucke/build.py`](https://github.com/beeson-group/tycho/blob/main/examples/broucke/build.py), draws the planar Broucke families of the elliptic restricted three-body problem in five frames. These are families of periodic orbits that Broucke published in 1969. The example reads trajectories computed with the PyDyLAN library from `broucke-input.tyd`, a file attached to each GitHub Release rather than kept in the repository.

## On a slide

To put a scene on a slide, paste the output of `ty.build_embed(scene.to_document(), scene.to_container(), theme="dark", autoplay=True)` into the deck, and load the runtime from `pytycho.html.runtime_js()` once per deck. A deck can hold several viewers. The keywords of the call are attributes of the viewer element.

| Attribute | Meaning |
|---|---|
| `theme` | `dark` or `light`, a built-in palette that replaces the theme of the scene and can change at any time |
| `autoplay` | plays once the scene is loaded and the element is visible, unless the user asked for reduced motion |
| `scene`, `data` | URLs of the two files, used when the element does not have child blocks |

## Files

| Extension | What |
|---|---|
| `.tys` | the scene document, a JSON file whose `format` is `tycho-scene`, at version 0.3. The format may still change incompatibly until version 1.0. |
| `.tyd` | the data container, a binary file. It starts with the `TYCD` magic number, i.e. four bytes that identify the file type, followed by a JSON header that describes each array, and then the little-endian typed arrays. Each array is stored raw, as its bytes lie in memory, or compressed in chunks of rows, which a reader can decode one at a time. |
| `.html` | the deliverable, i.e. the page that you share. It embeds both files as base64 text and inlines the runtime. |

The contract between the writer (pytycho) and the runtime, i.e. what a scene may contain and what it means, is kept in [`spec/`](https://github.com/beeson-group/tycho/tree/main/spec). It has three parts.

- The numbered rules are in [`tycho-scene.md`](https://github.com/beeson-group/tycho/blob/main/spec/tycho-scene.md).
- The JSON Schema [`scene.schema.json`](https://github.com/beeson-group/tycho/blob/main/spec/scene.schema.json) gives the structure, i.e. which keys a scene may have and the type of each.
- The conformance corpus in [`conformance/`](https://github.com/beeson-group/tycho/tree/main/spec/conformance) holds scenes with the answers an evaluator must give, and both implementations run it.

Where the Python and the TypeScript evaluators disagree, the answer in the corpus holds, and the rule is reworded to match it.

## Use with a coding agent

The repository carries an agent skill, a page of instructions from which a coding agent learns the scene grammar and its rules. In Claude Code, the repository serves as a plugin marketplace, and the command below installs the skill as a plugin.

```sh
claude plugin marketplace add beeson-group/tycho && claude plugin install tycho@beeson-group
```

For Codex, Cursor, Copilot, Gemini CLI, OpenCode, and other agents, the `skills` command-line tool installs it.

```sh
npx skills add beeson-group/tycho
```

## Development

The built runtime is not kept in git, hence it has to be built once in a source checkout. The commands below build it and run the tests of both packages.

```sh
(cd web && npm ci && npm run build)        # the runtime, into web/dist and src/pytycho/_static/tycho.js
(cd web && npm test && npm run typecheck)   # vitest under node, including every conformance case
uv run pytest                               # or: pip install -e . --group dev && pytest (pip 25.1+)
```

Style and static checks run through [pre-commit](https://pre-commit.com), a tool that runs a list of checks, called hooks, on every commit. The command `uvx` runs a Python tool through uv without installing it into the project. After a one-time `uvx pre-commit install`, the hooks below run on every commit, and `uvx pre-commit run --all-files` runs them on demand.

- ruff lints and formats the Python code.
- pyright checks the types of the Python code.
- prettier checks the format of the TypeScript, in check mode, i.e. it reports what it would change without changing it.
- codespell flags common misspellings.
- The schema checks validate the GitHub workflows and other configuration files against their JSON Schemas.

[nox](https://nox.thea.codes) wraps the rest, as the sessions of `noxfile.py`. A bare `uvx nox` runs the lint and the tests, `uvx nox -s docs` builds the documentation, and `uvx nox -s build` builds the sdist and the wheel. [CONTRIBUTING.md](https://github.com/beeson-group/tycho/blob/main/CONTRIBUTING.md) has the details and the release steps.

The example reads `examples/broucke/broucke-input.tyd`, which is attached to each GitHub Release rather than kept in git, and its test is therefore skipped when this file is missing. The page `web/dev/index.html` loads any conformance scene into the runtime, so that a change can be checked by eye. It runs the development bundle that `npm --prefix web run build:dev` builds, and it is served from the checkout root, e.g. by `python3 -m http.server 8000`.

## License

TyCHO is licensed under Apache-2.0, whose text is in [`LICENSE`](https://github.com/beeson-group/tycho/blob/main/LICENSE). The runtime bundle, i.e. the one JavaScript file that every page inlines, carries three.js and mp4-muxer, which are both MIT-licensed. The library three.js draws the panels with WebGL, and mp4-muxer writes the MP4 file of a video export. Hence the packages declare `Apache-2.0 AND MIT`, meaning that both licenses apply. [`NOTICE`](https://github.com/beeson-group/tycho/blob/main/NOTICE) lists the two libraries, and [`THIRD_PARTY_NOTICES.md`](https://github.com/beeson-group/tycho/blob/main/THIRD_PARTY_NOTICES.md) holds their license texts.
