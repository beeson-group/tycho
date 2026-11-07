# TyCHO

TyCHO, the Typed Celestial HTML Observer, turns trajectories computed elsewhere into animated, interactive visualizations, each of which ships as one HTML file. A page has a black background, sliders, tabs, and panels you drag and drop. It can show the same orbit family in several reference frames side by side, e.g. a rotating frame next to an inertial one.

A Python script declares the visualization as a scene over NumPy arrays. A scene is a set of declarations that specify what the arrays are and how they are drawn, and it is made of the following pieces.

- Track sets hold the trajectories. A track is one trajectory, i.e. a sequence of samples, and a track set is a collection of tracks that share a frame and a meaning, e.g. the members of one orbit family. Each sample can carry channels, which are numbers stored beside its position, such as the time.
- Bodies are named points, e.g. the primary and the secondary of the three-body problem.
- Frames are coordinate frames, and they form a tree in which every frame but the root is defined against its parent.
- Variables are the state that a person viewing the page can change, e.g. which member of a family is shown.
- The clock is the animation time, which every panel shares.
- A view is a template for a panel, and a panel is one picture on the page. Each panel shows one view, hence two panels can show the same view in two frames.
- Controls are the widgets that change the variables and the clock, e.g. sliders and tabs. Readouts are the pieces of text that show current values.

Together these declarations form the scene grammar, the vocabulary from which every scene is built, and the browser runtime interprets this grammar. The runtime only rotates, scales, and translates points, and blends linearly between two stored samples. It does not integrate any equation of motion, and every number on screen therefore comes from the library that computed the trajectory. The page works offline, from disk, inside an iframe, or on a reveal.js slide (a slide of a presentation written in HTML), since the runtime and the data are inlined into its one file.

## Two packages

| Package | Registry | What it is |
|---|---|---|
| `pytycho` | PyPI, the Python Package Index | the Python API, i.e. the `Scene` builder, which records the declarations, the data container, which holds the arrays, and the HTML writer, which bundles the runtime into the page |
| `@beeson-group/tycho` | npm | the browser runtime, i.e. the scene reader, which reads and checks a scene, the evaluator, which computes what each panel draws, and the `<tycho-viewer>` element, which shows a scene on a page. It ships as an ECMAScript module and as an immediately invoked function expression (a classic script that defines the global `tycho`) |

Most users need only `pytycho`, since every page it writes carries the runtime inline. The npm package serves to embed the viewer (the `<tycho-viewer>` element) in a website or an application that you build. Both packages are released together under one version, which is {{ version }} for this documentation.

## Where to start

::::{grid} 1 2 2 3
:gutter: 3

:::{grid-item-card} Quickstart
:link: quickstart
:link-type: doc

The quickstart shows how to install pytycho, write the minimal scene, a page of one looping track in two frames, and build the Broucke example.
:::

:::{grid-item-card} Guide
:link: guide/index
:link-type: doc

The guide gives one page to each concept of the scene grammar, i.e. track sets, frames, bodies, variables, the clock, views, panels, thinning, and the page. Thinning keeps a subset of the stored samples, which makes a page smaller.
:::

:::{grid-item-card} Gallery
:link: gallery
:link-type: doc

The gallery holds the page that pytycho writes for Broucke's families of periodic orbits in the elliptic restricted three-body problem, drawn in five frames.
:::

:::{grid-item-card} API reference
:link: api/index
:link-type: doc

The reference documents the Python API from its docstrings, and the `<tycho-viewer>` element together with the functions that the JavaScript bundle exports.
:::

:::{grid-item-card} Format
:link: spec
:link-type: doc

The format is the contract between pytycho, which writes a scene, and the runtime, which draws it. It consists of the numbered rules, the JSON Schema of the scene, and the conformance corpus, a set of test scenes with the answers that both implementations must give.
:::

:::{grid-item-card} Agents
:link: agents
:link-type: doc

The agent skill of TyCHO, one page of instructions in the Agent Skills format, sets out for a coding agent how to write scenes. The Agents page describes how to install the skill.
:::
::::

```{toctree}
:hidden:

Quickstart <quickstart>
Guide <guide/index>
Gallery <gallery>
API <api/index>
Format <spec>
Agents <agents>
Changelog <changelog>
```
