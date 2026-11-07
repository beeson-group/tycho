# @beeson-group/tycho

This package is the browser runtime of [TyCHO](https://github.com/beeson-group/tycho), the Typed Celestial HTML Observer, which draws astrodynamics trajectories as animated, interactive visualizations. A TyCHO scene is two files, the scene document `scene.tys`, which is JSON that says what to draw, and the data container `data.tyd`, which holds the arrays to draw from. The package holds three parts.

- The reader of the TyCHO scene format reads these two files.
- Its pure evaluator computes what each panel draws at a given frame. Pure means that its result depends only on its arguments, and that it does not have side effects.
- The `<tycho-viewer>` web component, a custom HTML element, draws a scene as animated, interactive panels.

Most users never install this package, since the Python package [pytycho](https://pypi.org/project/pytycho/) writes the scene and inlines this runtime into a single HTML file. The package serves to put the viewer in a page or an application that you build, or to read and evaluate scenes in JavaScript. The first command below installs it, and the code after it loads a scene from two files served beside the page.

```sh
npm install @beeson-group/tycho
```

```js
import '@beeson-group/tycho'; // registers <tycho-viewer>

const viewer = document.querySelector('tycho-viewer');
const [scene, data] = await Promise.all([
  fetch('scene.tys').then((r) => r.text()),
  fetch('data.tyd').then((r) => r.arrayBuffer()),
]);
await viewer.load(scene, new Uint8Array(data));
```

The method `load` takes the text of the scene document and the bytes of the data container. It returns a promise, since it inflates, i.e. decompresses, the compressed arrays of the container.

The package ships an ECMAScript module at the default export path, and an immediately invoked function expression (IIFE) at `@beeson-group/tycho/iife`, which exposes a global `tycho`. The IIFE is a plain script, and it is the bundle that pytycho inlines into its pages. Both bundle three.js, which draws the panels with WebGL, and mp4-muxer, which writes the MP4 file of a video export, hence the package does not have any runtime dependency. The scene format is specified in [spec/tycho-scene.md](https://github.com/beeson-group/tycho/blob/main/spec/tycho-scene.md), and the changes per release are in [CHANGELOG.md](https://github.com/beeson-group/tycho/blob/main/CHANGELOG.md).

The package is licensed under Apache-2.0. The bundled third-party code is MIT-licensed, and `NOTICE` and `THIRD_PARTY_NOTICES.md` in this package list this code with its license texts.
