# TyCHO

TyCHO, the Typed Celestial HTML Observer, turns trajectories computed elsewhere into pages, each of which is one HTML file with an animated, interactive picture of them.
A page has a black background, sliders, tabs, and panels you drag and drop.
It can show the same orbit family in several reference frames side by side, e.g. a rotating frame next to an inertial one.

A Python script declares what the page shows as a scene over NumPy arrays.
A scene is made of the following pieces, whose names are defined in the [glossary](glossary.md).

- Trajectory sets hold the trajectories.
  A trajectory is a sequence of samples, and a trajectory set is a collection of trajectories that share a frame and a meaning, e.g. the members of one orbit family.
  Each sample can carry channels, which are numbers stored beside its position, such as the time.
- Bodies are named points, e.g. the primary and the secondary of the three-body problem.
- Frames are coordinate frames, and they form a tree in which every frame but the root is defined against its parent.
- Inputs are the values that the person at the page can change, e.g. which member of a family is shown.
- The clock is the time of the animation, which every panel shares.
- A panel is one picture on the page, with its own display frame, camera, reference trajectory, and layers.
  The scene declares its panels, and the page may show one declared panel several times, hence two shown panels can show the same declared panel in two frames.
- Controls are the widgets that change the inputs and the clock, e.g. sliders and tabs.
  Readouts are the pieces of text that show current values.

The browser runtime draws a scene, and it only rotates, scales, and translates points, and blends linearly between two stored samples.
It does not integrate any equation of motion, and every number on screen therefore comes from the library that computed the trajectory.
The page works offline, from disk, inside an iframe, or on a reveal.js slide (a slide of a presentation written in HTML), since the runtime and the data are inlined into its one file.

## Two packages

| Package | Registry | What it is |
|---|---|---|
| `pytycho` | PyPI, the Python Package Index | the Python API, i.e. the `Scene` builder, which records the declarations, the data container, which holds the arrays, and the HTML writer, which bundles the runtime into the page |
| `@beeson-group/tycho` | npm | the browser runtime, i.e. the validator, which reads and checks a scene, the evaluator, which computes what each panel draws, and the `<tycho-viewer>` element, which shows a scene on a page. It ships as an ECMAScript module and as an immediately invoked function expression (a classic script that defines the global `tycho`) |

Most users need only `pytycho`, since every page it writes carries the runtime inline.
The npm package serves to embed the viewer (the `<tycho-viewer>` element) in a website or an application that you build.
Both packages are released together under one version, which is {{ version }} for this documentation.

## Where to start

::::{grid} 1 2 2 3
:gutter: 3

:::{grid-item-card} Quickstart
:link: quickstart
:link-type: doc

The quickstart shows how to install pytycho, write the minimal scene, a page of one looping trajectory in two frames, and build the Broucke example.
:::

:::{grid-item-card} How-to pages
:link: guide/thinning
:link-type: doc

One how-to page explains thinning, which keeps a subset of the stored samples and thus makes a page smaller.
A [second](guide/html.md) explains what the page holds, how it is embedded in another page, and how its video is exported.
:::

:::{grid-item-card} Gallery
:link: gallery
:link-type: doc

The gallery holds the pages that pytycho writes for the two examples, Broucke's families of periodic orbits in the elliptic restricted three-body problem and the invariant manifolds of three Earth–Moon periodic orbits.
:::

:::{grid-item-card} Scene reference
:link: reference
:link-type: doc

The scene reference describes every key of a scene, with its units and its default, and it is generated from the JSON Schema of the scene document.
:::

:::{grid-item-card} API
:link: api/index
:link-type: doc

The API pages document the Python API from its docstrings, and the `<tycho-viewer>` element together with the functions that the JavaScript bundle exports.
:::

:::{grid-item-card} Glossary
:link: glossary
:link-type: doc

The glossary defines each word that TyCHO uses in a narrower sense than everyday English, with one meaning across pytycho, the runtime, the schema, and the docs.
:::

:::{grid-item-card} Spec
:link: spec
:link-type: doc

The spec is the contract between pytycho, which writes a scene, and the runtime, which draws it.
It gives the layout of the data container and the named rules that both evaluators follow.
:::

:::{grid-item-card} Conformance
:link: conformance
:link-type: doc

The conformance corpus is a set of test scenes with the answers that both evaluators, in Python and in TypeScript, must give.
:::

:::{grid-item-card} Agents
:link: agents
:link-type: doc

The agent skill of TyCHO, one page of instructions in the Agent Skills format, sets out for a coding agent how to write scenes, and the Agents page describes how to install it.
:::
::::

```{toctree}
:hidden:

Quickstart <quickstart>
Thinning <guide/thinning>
The page <guide/html>
Gallery <gallery>
Scene reference <reference>
API <api/index>
Glossary <glossary>
Spec <spec>
Conformance <conformance>
Agents <agents>
Changelog <changelog>
```
