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
<tycho-viewer>
<script type="application/octet-stream" data-tycho="scene" data-encoding="base64">eyJmb3JtYXQiOi...</script>
<script type="application/octet-stream" data-tycho="data" data-encoding="base64">VFlDRAEAAAA...</script>
</tycho-viewer>
```

| Attribute | Value |
|---|---|
| `scene` | a URL of `scene.tys`, or a CSS selector of a block, i.e. of a `<script type="application/octet-stream">` element holding `scene.tys` as base64 text. The browser treats a script of this type as data and does not run it |
| `data` | a URL of `data.tyd`, or a CSS selector of such a block |
| `theme` | `dark` or `light`, a built-in palette that replaces the theme of the scene. The viewer follows a later change of this attribute |
| `autoplay` | present or absent, whatever its value. When present, the viewer plays once the scene is loaded and the element is visible |
| `kiosk` | present or absent, whatever its value. When present, the viewer hides every control and plays as with `autoplay`, which suits a slide, and it neither restores nor stores the state |

The viewer takes each file from its child block marked `data-tycho="scene"` or `data-tycho="data"`, else from the attribute, else from the block with the id `tycho-scene` or `tycho-data`. A page can thus hold several viewers, each with its child blocks. Under `prefers-reduced-motion: reduce`, neither `autoplay` nor `kiosk` starts the clock, and the controls still work.

The `data-encoding` of each script is `base64`, which is the default and the only encoding, since the views of the container are already compressed. The viewer inflates (decompresses) these views with the browser's `DecompressionStream`.

The viewer looks up the selectors first in its root node, which is the document or the shadow root that contains it, and then in the document. A shadow root is the hidden subtree of another custom element, in which the viewer may be placed. The scripts may come after the element, since a viewer that connects while the document is still loading waits until the whole document has been parsed.

Apart from `theme`, the attributes are read once, when the element connects, which happens when it is inserted into the document. A later change of an attribute does not load another scene, and the method `load` below serves for this instead. Since the viewer fills its CSS box (the rectangle that the layout of the page gives it), it must be given a size. The pages written by pytycho give it one with `tycho-viewer { display: block; width: 100%; height: 100%; }`.

The custom properties `--tycho-background`, `--tycho-foreground`, and `--tycho-grid` of the host take precedence over the theme. Text in HTML inherits the font of the host, and text on a canvas, i.e. in a video export, is set in `--tycho-font` when this property is set. The clock runs only while the element intersects the viewport and the page is visible, and it resumes from where it paused. A key that the viewer uses does not reach the page, so that a deck does not also navigate.

The element is a `TychoViewerElement`, with the methods and properties below.

| Member | What it does |
|---|---|
| `load(sceneText, dataBytes)` | loads a scene from the text of `scene.tys` and the bytes of `data.tyd`, in place of the attributes, and returns a promise that resolves once the scene or its error shows. A load begun later takes precedence over one still decoding, whose result is then dropped |
| `state` | the current state snapshot of section 2.8 of the spec, which holds the panels and their layout, the values of the variables, and the clock channel. It is `null` before a scene loads |
| `play()`, `pause()` | starts and stops the clock, and does not do anything before a scene loads |
| `playing` | whether the clock is set to run, which stays true while the clock waits for the element to be shown |
| `reset()` | returns to the initial state of the scene and discards the stored state |
| `fitAll()` | fits the camera of every panel to what the panel draws, panning and zooming each panel until its content fills it |
| `exportVideo(options)` | records a video of the current state, as described below |
| `seek(t)` | shows time `t` of the timeline, in seconds, paused (section 2.11 of the spec) |
| `stages` | the stages of the scene, `{id, at, label}` in order of time, i.e. its named times for a presentation (rule K9) |
| `goto(stage)` | shows a stage, given by its id or its index, paused, and throws for a stage the scene does not have |
| `playTo(stage)` | plays from the time shown and pauses at the time of a stage. A stage behind the time shown is reached in the next loop |
| `next()`, `previous()` | plays to the next stage, or shows the stage before the time shown, and returns its id, or `null` when there is none |
| `time`, `currentStage` | the time shown in seconds, and the id of the last stage at or before it |

The viewer fires the event `tycho-stage` when playback reaches a stage, with `detail: {id, index, at}`, and the event bubbles out of a shadow root. A slide deck that advances a scene one stage per click, e.g. on the fragments of a reveal.js slide, calls `next()` on each click, and `goto()` when the deck jumps to a slide.

```js
const viewer = document.querySelector('tycho-viewer');
viewer.addEventListener('tycho-stage', (ev) => console.log(`reached ${ev.detail.id} at ${ev.detail.at} s`));
document.querySelector('#next').addEventListener('click', () => viewer.next());
```

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

## Video export

```js
import { exportVideo } from '@beeson-group/tycho';

const blob = await exportVideo(viewer, { size: '1080p', fps: 30, loops: 2 });
```

The function `exportVideo(element, options)`, the same as `element.exportVideo(options)`, freezes the current state and resolves to an MP4 blob of H.264 video. Freezing the state means that the state does not change during the recording. A blob is the bytes of a file held in memory. VP9 is not used in place of H.264, because QuickTime, the video player of every Mac, rejects VP9 in an MP4.

The returned promise rejects with an `AbortError` when `options.signal` aborts, as it does when the caller cancels the export. It rejects with an error that gives the reason in three other cases.

- The browser lacks a WebCodecs encoder. WebCodecs is the browser API that encodes video frames.
- The browser lacks an H.264 encoder that takes the size.
- The export would pass the ceiling of `EXPORT_LIMITS`, `{frames: 2000, seconds: 90}`.

The options are an `ExportOptions` object, with the keys below.

| Option | Default | Meaning |
|---|---|---|
| `size` | `'720p'` | a `SizePreset`, i.e. `'720p'`, `'1080p'`, or `'stage'`, or an `ExportSize`, `{width, height, pixelRatio}`, with the width and the height in video pixels and the pixel ratio in video pixels per CSS pixel. The picture is laid out at a width of the width divided by the pixel ratio, in CSS pixels, hence with a higher ratio the same layout is drawn at a higher pixel density |
| `fps` | 30 | frames per second |
| `loops` | 1 | the number of loops of the clock that the video holds |
| `speed` | the speed of the viewer | the playback speed, at which a lap of the clock (one traversal of a track, rule C6) lasts 8 s divided by the speed |
| `start` | 0 | the frame index of the first frame |
| `bitrate` | 0.08 bits per pixel per frame, within 1 to 40 Mbit/s | the target bitrate in bits per second. The default is ample for lines on a plain background |
| `onConfig` | | a function called before the first frame with the encoder configuration that the browser accepted |
| `onProgress` | | a function called after each frame with the number of frames done and the total |
| `signal` | | an `AbortSignal` that cancels the export |

The function `sizePreset(preset, stage, devicePixelRatio, fps)` returns the `ExportSize` that a preset gives, which an export dialog you build can show before the export starts. The three presets give the following sizes.

- The preset `720p` is 1280 by 720 at a pixel ratio of 1.
- The preset `1080p` is the same layout at 1920 by 1080 and a pixel ratio of 1.5, i.e. the picture of 720p drawn at 1.5 times the pixel density.
- The preset `stage` follows the stage, the area of the viewer in which the panels are tiled, in three steps.
  1. It takes the size `{w, h}` of the stage in CSS pixels, given as `stage` and 1280 by 720 by default, and rounds it down to even pixels, since H.264 requires both sides even.
  2. It then scales the size by the whole pixel ratio nearest `devicePixelRatio` (the number of physical pixels per CSS pixel of the screen), at most 2.
  3. It lowers this ratio in eighths until H.264 holds the size at `fps`, 30 by default, i.e. until a level of H.264 up to 5.2 takes the size and the rate and neither side exceeds 4096 pixels.

When the viewer exports a video, it passes the size of its stage to `sizePreset`.

## Reading and evaluating

The exports below do not require a DOM, hence they run anywhere, in a browser or under Node.js.

| Export | What it does |
|---|---|
| `Container.parse(bytes)` | parses `data.tyd` from an `ArrayBuffer` or a typed array into a promise of a `Container`. It checks rules D1 to D3 and D5 for every view, and it decodes the encoded (compressed) views with `DecompressionStream`. On the container, `view(name)` returns one array, `has(name)` and `names()` report which arrays it holds, and `header` is the parsed JSON header |
| `decodeEmbedded(text, encoding)` | decodes the text of a `<script>` element embedded in the page into bytes, for `base64`, the only encoding |
| `validate(scene, data?, state?)` | checks a scene, and also its data and a state when they are given. It throws a `TychoError` for the first broken rule, and it returns the warnings as a list of strings |
| `evaluate(scene, data, state, frameIndex)` | the pure evaluator of section 3 of the spec, which returns what each panel draws at a frame index as an `EvaluateResult`. It gives the same answer as {func}`pytycho.evaluate`, which is checked case by case through the conformance corpus |
| `TychoError` | the only error type that a reader throws, with `rule` set to the broken rule, e.g. `"F5"`, or to the section number of a requirement stated without a rule number, e.g. `"2.3"` |
| `SCENE_MAJOR`, `SCENE_MINOR`, `DATA_VERSION` | the scene and container versions this runtime reads |

```js
import { Container, evaluate, validate } from '@beeson-group/tycho';

const scene = JSON.parse(sceneText);
const data = await Container.parse(dataBytes);
validate(scene, data, scene.initial);
const result = evaluate(scene, data, scene.initial, 100);
console.log(result.panels.p1.layers[1].members[0].head);
```

The functions `validate` and `evaluate` read arrays through a `DataStore`, i.e. any object with the two methods `has(name)` and `view(name)`. A `Container` implements these methods, and arrays already in memory can implement them as well, so that a scene can be evaluated without a `data.tyd`. The method `view` returns an `ArrayView`, which holds the `name` of the array, its `dtype` (a `Dtype`, e.g. `'float32'`), its `shape`, and its elements as a `TypedArray`. The elements are flat in C order, i.e. one row after another with the last index varying fastest.

The `header` of a container is a `DataHeader`, whose `views` give the `ViewInfo` of each array. A `ViewInfo` describes how one array is stored. It holds the `dtype`, the `shape`, and the `encoding` of the array, and it is one of two kinds (section 1 of the spec).

- A `RawViewInfo` adds the byte `offset` and `length` of the array in the payload, the part of the file that follows the header.
- An `EncodedViewInfo` adds `chunk_rows` and `chunks`, the `[offset, length]` of each chunk, for an array that is compressed in chunks of `chunk_rows` rows.

The TypeScript types of the scene (`Scene`, `State`, `View`, `Layer`, and the rest) are generated from the JSON Schema. Aliases name the parts that the schema describes in place without a name. They are the layers `TrackLayer`, `BodyLayer`, and `MarkLayer`, the variables `Selector`, `Choice`, and `Toggle`, the `ChannelDef` and `ParameterDef` of a track set, and the `PanelState` of one panel. The alias `VariableValue` is a number, a string, or a boolean, i.e. the value of a selector, a choice, or a toggle.

The `EvaluateResult` of the evaluator maps each panel to a `PanelResult`, which holds the display `frame` of the panel (the frame it draws in) and one `LayerResult` per layer. A layer result is one of three kinds.

- A `TrackLayerResult` holds one `MemberResult` per drawn member, with its `line`, the polyline that is drawn (rule L1), and its `head`, the position of the moving point.
- A `BodyLayerResult` holds the `position` and the `trail` of the body.
- A `MarkLayerResult` stands for axes and a grid, for which the evaluator does not compute anything.

Every position is a `Vec3` of three numbers.

## Readout numbers and colormaps

The function `formatNumber(x, digits)` writes a number as a readout shows it, where a readout is a piece of text on the page that shows current values (section 2.9 of the spec). It follows three rules.

- When `digits` is given, the number is written to `digits` significant digits with trailing zeros kept.
- Otherwise an integer is written as it is, and any other number is written to six significant digits with trailing zeros dropped.
- An exponent is written as `e` followed by the exponent, and a minus sign as U+2212, the typographic minus sign, in place of the hyphen.

The function `colormap(name, t)` returns the color of one of the viewer's colormaps at the position `t` in [0, 1], clamped, meaning that a `t` outside [0, 1] is moved to the nearer end. The color is returned as three numbers in [0, 1], its red, green, and blue components. The colormaps are `'viridis'`, `'plasma'`, `'cividis'`, `'blues'`, and `'reds'` (the scene type `ColormapName`). The color is written into the optional third argument when one is given. The function `colormapCss(name, t)` gives the same color as a CSS `rgb()` string. A legend or a plot outside the viewer drawn with these functions thus matches the colors of the viewer. The maps `blues` and `reds` are the lighter part of matplotlib's `Blues` and `Reds`, from a mid blue or a mid red up to the lightest tint and without the near-black end of the full maps, so that their low end still shows on black.

The package does not export anything else.
