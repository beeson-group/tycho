# The HTML page and the export

## Writing a scene

A scene leaves Python in one of two forms.

- {meth}`Scene.write_html(path) <pytycho.Scene.write_html>` writes one self-contained page, i.e. a single HTML file that holds the scene, its data, and the runtime that draws them.
  It returns the size in bytes of every array as the container stores it, and of the page.
- {meth}`Scene.write(tys_path, tyd_path) <pytycho.Scene.write>` writes the two files of the scene apart.
  These are the scene document `scene.tys`, the JSON that specifies what to draw, and the data container `data.tyd`, which holds the arrays.
  The method serializes both before opening either file, hence a scene that fails its checks does not leave a file half written.
  The two files serve a page you write yourself or {func}`pytycho.evaluate`.

The functions {func}`pytycho.build_html` and {func}`pytycho.write_html` do the same from a document and a container already written, e.g. from a `.tys` and a `.tyd` file read back from disk.
The first returns the page as a string, and the second writes the page to a file and returns the sizes.

## What the page holds

The page embeds both files as text in two `<script type="application/octet-stream">` elements.
Each file is base64-encoded, i.e. written with letters, digits, `+`, `/`, and `=` only, hence a string of the scene cannot close a script tag.
The container goes in as it is, since it already stores each array compressed (rule `shuffle-delta-deflate` of the [spec](../spec.md)).
An array is compressed in three steps as it is written into the container.

1. The bit patterns of each column are delta-coded down the rows, i.e. each row is replaced by its difference from the row before it.
2. The bytes of these differences are shuffled, i.e. the bytes at the same position within their element are put next to each other.
3. The shuffled bytes are deflated, i.e. compressed with the deflate algorithm, in chunks of about 1 MiB.

Along a smooth trajectory consecutive rows are close, and their differences thus hold many zero bytes.
The three steps roughly halve the size of smooth trajectories.
The `<tycho-viewer>` element is the HTML element of the runtime that draws the scene.
It finds the two script elements through its `scene` and `data` attributes, inflates the container's chunks with the browser's native `DecompressionStream`, and parses both files without any library.
The runtime itself is inlined, at about 850 KB.
The page thus works offline, from disk, inside an iframe on a website or a reveal.js slide, or anywhere else a single HTML file can go.

Every string in a scene is plain text.
The runtime writes it into the page through text nodes or canvas text and never as markup (rule `plain-text`), hence a string cannot inject HTML or script.
The title, which also enters the HTML of the page as its `<title>`, is escaped there.

Chrome does not hold a string longer than 536,870,888 characters, and a longer base64 text reads back as empty.
For this reason `build_html` rejects a scene or data whose base64 is longer, since the page would stay empty.
A scene of this size has to be thinned ([thinning](thinning.md)) or store fewer channels.
The page requires WebGL to draw.
The state of the page, i.e. what the person at the page has changed, is stored per browser in local storage, under a hash of `scene.tys`.

## Using the page

The top bar of the page holds the title, the controls of the shared inputs, and a row of Add panel chips, i.e. small labeled buttons that each add a panel.
The chips stand for the declared panels of the scene, each shown by its label or its id.
Adding a declared panel that is already shown makes a copy of it with a new id.

- A click on a chip adds the panel where there is most room, by splitting the largest panel.
- A drag of a chip onto a panel splits this panel on the side that a drop marker shows during the drag, or replaces what the panel shows on a drop at its center.
- The caret of a chip opens a menu that adds the panel, or that splits or replaces any panel by name, which is the way to do it from the keyboard.

When the chips would not fit on one line, one Add panel button takes their place.
A page holds at most eight panels.

Each panel has a header along its top.
The chip in the header names the frame of the panel, and its caret switches the frame when the panel has a per-panel choice of frame.
The header also holds the controls of the other per-panel inputs, a house icon that resets the view of the panel, and a × that closes the panel when there is more than one.

- A drag of a panel by its header onto another panel moves it to the side that the drop marker shows, or swaps the two on a drop at the center.
- A drag of the gutter, i.e. the gap between two panels, resizes them.
- A double click on a panel resets its view.

A drag across a panel with a 3d camera turns the view about the camera's up axis, as a turntable does, and a drag up or down tilts the view toward this axis.
Shift with a drag, or a drag with the right button, pans the view, and the wheel or a pinch zooms it.
While the pointer is over such a panel, its keys are listed at its foot, except under `minimal` and `kiosk` and on a device whose pointer does not hover, such as a phone.

A colorbar shows a colormap against its values at the top right of a panel.
When a shared parameter input is over the same parameter, the colorbar acts as a second slider for this input, except on a kiosk page.
A click or a drag on the colorbar jumps the input to the stop nearest the value under the pointer, and with the colorbar focused, the arrow keys move the input by one stop, PageUp and PageDown by ten, and Home and End to the ends.

The keys below act while the viewer element has the keyboard focus, also on one of its tabs or buttons, unless the control takes the key itself, as a button takes Space.
In a text field or a select, every key is left to the field.

- Space or `k` plays and pauses.
- The right and left arrows move by one frame index and pause, or by ten with Shift.
- Home or `0` goes to frame index 0, and `1` to `9` go to as many tenths of the loop.
- `f` resets the view of every panel: a panel whose camera has keyframes follows them again, and any other panel is fitted to what it draws.
- The up and down arrows move the first slider over a shared input by one stop, or ten with Shift.
- In a panel with a 3d camera, `x`, `y`, and `z` show the view from the positive side of that axis, and from the negative side with Shift.
- In a panel with a 3d camera, `.` and `,` turn the view about the camera's up axis by 15 degrees, or by 90 with Shift.
  These keys and the axis keys act on the panel under the pointer, or on every panel with a 3d camera when the pointer is over none.
- Escape closes an open menu or the export options.

The keys that play, step, and seek require a playback control, except on a kiosk page, which plays without one.

## Embedding and kiosk pages

A page embeds in another page, on a website or on a reveal.js slide, through an iframe, i.e. an HTML element that shows one page inside another.

```html
<iframe src="loop.html" style="width: 100%; height: 600px; border: 0"></iframe>
```

The call `write_html(path, kiosk=True)` writes a kiosk page, i.e. a page meant for a slide.
A kiosk page hides the top bar, the panel headers, the caption's tiles, and the footer, and it plays at once.
The keys still play, step, and reset the views, e.g. Space plays and pauses, and the key `f` resets the view of every panel.
A kiosk page starts from the scene's initial state every time and does not store anything.

To put a scene on a slide without an iframe, paste the output of {func}`pytycho.build_embed` into the deck, and load the runtime from {func}`pytycho.html.runtime_js` once per deck.
Each keyword of the call is an attribute of the viewer element, e.g. `theme="dark"` or `autoplay=True`, and a deck can hold several viewers.
To put the viewer element in a page you write yourself, use the npm package ([JavaScript API](../api/javascript.md)).

## The video export

The Export video button in the footer records the current state as an MP4 video.
The button opens a row of options, i.e. the size, the frame rate, and the number of loops, from one to four.
The row shows the number of frames and the length of the video that these options give.
The Start button records the video, showing a progress bar and a Cancel button, and then downloads the MP4, named after the scene's title.

The export freezes the state, i.e. the state does not change during the recording, and it starts at frame index 0.
It draws each frame of the video at the progress that live playback reaches at the time of this frame, at the current playback speed.
One loop thus lasts as long in the video as it does live.
An export that draws its frames more slowly than live playback still moves as smoothly as the page.
Every frame is drawn at a fixed size and pixel ratio, i.e. the number of video pixels per CSS pixel, through the same camera fit that the panels start with.
The video therefore does not depend on the size of the browser window.

- The size is 1280 by 720 pixels, the default, 1920 by 1080, or the size of the panel area, i.e. of the part of the page in which the panels are laid out.
  The first two share one layout, at a pixel ratio of 1 and 1.5, respectively, i.e. the 1920 by 1080 video is the same picture at a higher density.
  The size of the panel area is taken on screen, at the screen's pixel ratio, up to 2.
  This ratio is lowered when H.264 cannot hold the size at the frame rate.
- The frame rate is 24, 30, or 60 frames per second.
  An export from the row is limited to 2000 frames and 90 seconds, and a script can raise these limits.
  The row opens at one loop and at the highest of the three rates at which one loop stays within these limits at the current speed.
  A loop of 72 seconds thus starts at 24 frames per second at speed 1, since 30 would give 2160 frames.
  A higher rate picked by hand is refused with its reason.
  When the speed changes while the row is open, the loops and the rate are both chosen again.
- Each frame is the picture of the viewer on the page at the time of this frame, laid out at the size of the video, in the fonts of the page.
  The picture holds the panels with their layers, tick numbers, axis titles, body labels, colorbars, and panel readouts, and the caption under them.
  It leaves out the title, the panel headers, and every control.
  A kiosk page leaves out the caption in the video too.

The video is H.264 in MP4, i.e. its frames are compressed by the H.264 codec and held in an MP4 file.
The frames are encoded by the browser's WebCodecs API and muxed in the page, i.e. packed into the MP4 file by the runtime.
The export therefore requires a browser with a WebCodecs H.264 encoder.
Without WebCodecs, the Export video button is disabled, with the reason beside it.
An encoder that cannot take H.264 at the chosen size and rate fails the export with a message.
The export does not fall back to VP9, another codec, since QuickTime rejects VP9 in an MP4.
From a script, the `<tycho-viewer>` element's `exportVideo` method does the same.
It resolves to the MP4 as a blob, i.e. as a file held in memory ([JavaScript API](../api/javascript.md#video-export)).
