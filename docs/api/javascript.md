# JavaScript API

The npm package `@beeson-group/tycho` is the browser runtime, which has three parts. The scene reader reads and checks `scene.tys` and `data.tyd`. The evaluator computes what each panel draws, and it is pure, meaning that its result depends only on its arguments. The `<tycho-viewer>` element, called the viewer below, is the custom HTML element that shows a scene on a page. Every page that pytycho writes already carries the runtime inline. The package thus serves to put the viewer in a page or an application that you build, or to read and evaluate scenes in JavaScript.

## Bundles

| File | Format | Import |
|---|---|---|
| `dist/tycho.esm.js` | ECMAScript (ES) module | `@beeson-group/tycho` |
| `dist/tycho.js` | IIFE (immediately invoked function expression), a classic script that defines the global `tycho` | `@beeson-group/tycho/iife` |

Both bundles are minified (compacted without changing what the code does) for ES2022, the 2022 edition of ECMAScript. They include the MIT-licensed three.js, which draws the panels with WebGL, and mp4-muxer, which packs an exported video into an MP4 file. Consequently, the package does not have runtime dependencies, and installing it does not pull in any other package. Every bundle starts with a comment listing the bundled packages, whose notices are in `NOTICE` and `THIRD_PARTY_NOTICES.md`. The IIFE is the file that pytycho inlines into its pages, and its global `tycho` carries the same exports as the ES module.

Loading either bundle registers the viewer wherever the browser supports custom elements. The browser then builds a viewer for every `<tycho-viewer>` tag on the page. Node.js, which runs JavaScript outside a browser, does not have custom elements. Importing either bundle there does not register anything or throw, hence the reader and the evaluator can run in tests.

## Importing

A bundler is a build tool that packs the modules of an application into files for the browser. With a bundler, install the package and import it as below.

```sh
npm install @beeson-group/tycho
```

```js
import '@beeson-group/tycho';                                  // registers <tycho-viewer>
import { Container, evaluate, validate } from '@beeson-group/tycho';
```

A page without a bundler loads the runtime as a module from a content delivery network that serves npm packages. The version is fixed in the URL, since before version 1.0 a new minor version may break the scene format.

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@beeson-group/tycho@0.2.0/dist/tycho.esm.js"></script>
```

The page can also load the runtime as a classic script, which is a `<script>` element without `type="module"`. This bundle registers the viewer like the ES module, and it also defines `tycho` on `window`.

```html
<script src="https://cdn.jsdelivr.net/npm/@beeson-group/tycho@0.2.0/dist/tycho.js"></script>
```

## The element

```html
<tycho-viewer scene="#tycho-scene" data="#tycho-data"></tycho-viewer>
<script type="application/octet-stream" id="tycho-scene" data-encoding="base64">eyJmb3JtYXQiOi...</script>
<script type="application/octet-stream" id="tycho-data" data-encoding="base64">VFlDRAMAAAA...</script>
```

| Attribute | Value |
|---|---|
| `scene` | a CSS selector, e.g. `#tycho-scene`, of a `<script type="application/octet-stream">` element holding `scene.tys` as base64 text. The browser treats a script of this type as data and does not run it |
| `data` | a CSS selector of such an element holding `data.tyd` |
| `kiosk` | present or absent, whatever its value. When present, the viewer hides every control and plays at once, which suits a slide, and it neither restores nor stores the state |

The `data-encoding` of each script is `base64`, which is the default and the only encoding, since the views of the container are already compressed. The viewer inflates (decompresses) these views with the browser's `DecompressionStream`.

The viewer looks up the selectors first in its root node, which is the document or the shadow root that contains it, and then in the document. A shadow root is the hidden subtree of another custom element, in which the viewer may be placed. The scripts may come after the element, since a viewer that connects while the document is still loading waits until the whole document has been parsed.

The attributes are read once, when the element connects, which happens when it is inserted into the document. A later change of an attribute does not load another scene, and the method `load` below serves for this instead. Since the viewer fills its CSS box (the rectangle that the layout of the page gives it), it must be given a size. The pages written by pytycho give it one with `tycho-viewer { display: block; width: 100%; height: 100%; }`.

The element is a `TychoViewerElement`, with the methods and properties below.

| Member | What it does |
|---|---|
| `load(sceneText, dataBytes)` | loads a scene from the text of `scene.tys` and the bytes of `data.tyd`, in place of the attributes, and returns a promise that resolves once the scene or its error shows. A load begun later takes precedence over one still decoding, whose result is then dropped |
| `state` | the current state snapshot of section 2.8 of the spec, which holds the panels and their layout, the values of the variables, and the clock channel. It is `null` before a scene loads |
| `play()`, `pause()` | starts and stops the clock, and does not do anything before a scene loads |
| `reset()` | returns to the initial state of the scene and discards the stored state |
| `fitAll()` | fits the camera of every panel to what the panel draws, panning and zooming each panel until its content fills it |
| `exportVideo(options)` | records a video of the current state, as described below |

A scene can also be fetched over the network rather than embedded in the page, and then passed to `load`, as below.

```js
import '@beeson-group/tycho';

const viewer = document.querySelector('tycho-viewer');
const [scene, data] = await Promise.all([
  fetch('scene.tys').then((r) => r.text()),
  fetch('data.tyd').then((r) => r.arrayBuffer()),
]);
await viewer.load(scene, new Uint8Array(data));
```

A scene that cannot be read shows its error in place of the panels, with the number of the rule it breaks. The warnings of `validate` go to the console with the prefix `TyCHO:`. A warning reports a problem that does not stop the scene from being drawn, e.g. an unknown key, which a reader ignores.

The viewer keeps the state in the browser's local storage, the storage that a site keeps in the browser across visits. The key of a stored state is built from a hash of `scene.tys` (a short code computed from its text), so that a state saved for one scene is not applied to another. Two pages of the same scene on one site therefore share their state. A stored state is repaired against the scene before use, and only the parts that do not fit the scene are dropped.

The class is exported as `TychoViewerElement`, for a type annotation or an `instanceof` check. The function `define(tag = 'tycho-viewer')` registers the element under another name when the default name is taken. It does not do anything when an element of this name is already defined, or where custom elements do not exist.
