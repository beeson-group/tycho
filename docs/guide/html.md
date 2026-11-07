# The HTML page and the export

## Writing a scene

A scene leaves Python in one of two forms.

- {meth}`Scene.write_html(path) <pytycho.Scene.write_html>` writes one self-contained page, i.e. a single HTML file that holds the scene, its data, and the runtime that draws them. It returns the size in bytes of every array as the container stores it, and of the page.
- {meth}`Scene.write(tys_path, tyd_path) <pytycho.Scene.write>` writes the two files of the scene apart. These are the scene document `scene.tys`, the JSON that specifies what to draw, and the data container `data.tyd`, which holds the arrays. The method serializes both before opening either file, hence a scene that fails its checks does not leave a file half written. The two files serve a page you write yourself or {func}`pytycho.evaluate`.

The functions {func}`pytycho.build_html` and {func}`pytycho.write_html` do the same from a document and a container already written, e.g. from a `.tys` and a `.tyd` file read back from disk. The first returns the page as a string, and the second writes the page to a file and returns the sizes.

## What the page holds

The page embeds both files as text in two `<script type="application/octet-stream">` elements. Each file is base64-encoded, i.e. written with letters, digits, `+`, `/`, and `=` only, hence a string of the scene cannot close a script tag. The container goes in as it is, since it already stores each array compressed ([section 1](../spec.md#1-the-data-container-datatyd)). An array is compressed in three steps as it is written into the container.


1. The bit patterns of each column are delta-coded down the rows, i.e. each row is replaced by its difference from the row before it.
2. The bytes of these differences are shuffled, i.e. the bytes at the same position within their element are put next to each other.
3. The shuffled bytes are deflated, i.e. compressed with the deflate algorithm, in chunks of about 1 MiB.

Along a smooth trajectory consecutive rows are close, and their differences thus hold many zero bytes. The three steps roughly halve the size of smooth trajectories. The `<tycho-viewer>` element is the HTML element of the runtime that draws the scene. It finds the two script elements through its `scene` and `data` attributes, inflates the container's chunks with the browser's native `DecompressionStream`, and parses both files without any library. The runtime itself is inlined, at about 700 KB. The page thus works offline, from disk, inside an iframe on a website or a reveal.js slide, or anywhere else a single HTML file can go.

Every string in a scene is plain text. The runtime writes it into the page through text nodes or canvas text and never as markup (rule S2), hence a string cannot inject HTML or script. The title, which also enters the HTML of the page as its `<title>`, is escaped there.

Chrome does not hold a string longer than 536,870,888 characters, and a longer base64 text reads back as empty. For this reason `build_html` rejects a scene or data whose base64 is longer, since the page would stay empty. A scene of this size has to be thinned ([thinning](thinning.md)) or store fewer channels. The page requires WebGL to draw. The state of the page, i.e. what a person viewing the page has changed, is stored per browser in local storage, under a hash of `scene.tys`.

## Embedding and kiosk pages

A page embeds in another page, on a website or on a reveal.js slide, through an iframe, i.e. an HTML element that shows one page inside another.

```html
<iframe src="loop.html" style="width: 100%; height: 600px; border: 0"></iframe>
```

The call `write_html(path, kiosk=True)` writes a kiosk page, i.e. a page meant for a slide. A kiosk page hides the top bar, the panel headers, the caption's tiles, and the footer, and it plays at once. The keys still play, step, and reset the views ([keys](panels.md#keys)). A kiosk page starts from the scene's initial state every time and does not store anything.

To put a scene on a slide without an iframe, paste the output of {func}`pytycho.build_embed` into the deck, and load the runtime from {func}`pytycho.html.runtime_js` once per deck. Each keyword of the call is an attribute of the viewer element, e.g. `theme="dark"` or `autoplay=True`, and a deck can hold several viewers. To put the viewer element in a page you write yourself, use the npm package ([JavaScript API](../api/javascript.md)).

## The video export

The Export video button in the footer records the current state as an MP4 video ([section 2.10](../spec.md#210-export)). The button opens a row of options, i.e. the size, the frame rate, and the number of loops, from one to four. The row shows the number of frames and the length of the video that these options give. The Start button records the video, showing a progress bar and a Cancel button, and then downloads the MP4, named after the scene's title.

The export freezes the state, i.e. the state does not change during the recording, and it starts at frame index 0. It draws each video frame at the progress that live playback reaches at the time of this frame, at the current playback speed. One loop thus lasts as long in the video as it does live. An export that draws its frames more slowly than live playback still moves as smoothly as the page. Every frame is drawn at a fixed size and pixel ratio, i.e. the number of video pixels per CSS pixel, through the same camera fit that the panels start with. The video therefore does not depend on the size of the browser window.

- The size is 1280 by 720 pixels, the default, 1920 by 1080, or the stage's size, where the stage is the area of the page that holds the panels. The first two share one layout, at a pixel ratio of 1 and 1.5, respectively, i.e. the 1920 by 1080 video is the same picture at a higher density. The stage size is the size of the panels on screen at the screen's pixel ratio, up to 2. This ratio is lowered when H.264 cannot hold the size at the frame rate.
- The frame rate is 24, 30, or 60 frames per second. An export is limited to 2000 frames and 90 seconds. The row opens at one loop and at the highest of the three rates at which one loop stays within these limits at the current speed. A loop of 72 seconds thus starts at 24 frames per second at speed 1, since 30 would give 2160 frames. A higher rate picked by hand is refused with its reason. When the speed changes while the row is open, the loops and the rate are both chosen again.
- The picture holds the panels with their layers, tick numbers, axis titles, body labels, colorbars, and panel readouts, and the caption as text under them. It leaves out the title, the panel headers, and every control.

The video is H.264 in MP4, i.e. its frames are compressed by the H.264 codec and held in an MP4 file. The frames are encoded by the browser's WebCodecs API and muxed in the page, i.e. packed into the MP4 file by the runtime. The export therefore requires a browser with a WebCodecs H.264 encoder. Without WebCodecs, the Export video button is disabled, with the reason beside it. An encoder that cannot take H.264 at the chosen size and rate fails the export with a message. The export does not fall back to VP9, another codec, since QuickTime rejects VP9 in an MP4. From a script, the `<tycho-viewer>` element's `exportVideo` method does the same. It resolves to the MP4 as a blob, i.e. as a file held in memory ([JavaScript API](../api/javascript.md#video-export)).
