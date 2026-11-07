# Gallery

Each page here is the unchanged output of {meth}`Scene.write_html <pytycho.Scene.write_html>`, i.e. one HTML file with the scene, the data, and the runtime inside. The page is built for each release, attached as a file to its [GitHub Release](https://github.com/beeson-group/tycho/releases), and copied into this site when the site is built. The page thus always matches the release whose runtime wrote it.

::::{grid} 1
:gutter: 4

:::{grid-item-card} Broucke families of the elliptic problem, in five frames

The page shows Broucke's (1969) families 7, 8 and 11 of the planar elliptic restricted three-body problem, on their periapsis and apoapsis branches. A family is a set of periodic orbits that changes continuously from one member to the next. Each of the 1877 members of the three families was propagated for one period with PyDyLAN.

The five frames of Broucke's figures form one frame tree, in which every frame but the root is defined against its parent by a scale, a rotation, or a shift of its origin.

- The orbits are stored in the rotating-pulsating frame, which is the root.
- The rotating frame is the rotating-pulsating frame scaled by the distance between the primary and the secondary, which changes along their elliptic orbit.
- The barycentric inertial frame is the rotating frame rotated by the true anomaly, which is the angle along the elliptic orbit of the primary and the secondary, measured from periapsis.
- The last two frames are inertial frames centered on the primary and on the secondary.

The page opens with all five frames on screen, on the periapsis branch of family 11 at an eccentricity of 0.25. The eccentricity here belongs to the orbit of the primary and the secondary, and it differs from member to member. The page has the following controls.

- Tabs pick the family and the branch.
- The frame chip in the header of each panel picks the frame of the panel.
- The slider or the colorbar picks the member by its eccentricity.
- The clock runs on the true anomaly, the elapsed time, or the sample index, and the clock tabs switch between them.

Each frame has a separate colormap (a color scale) over the eccentricity, as in Broucke's figures, and its axes carry tick numbers and titles in DU, the distance unit. In the rotating-pulsating frame DU is the current distance between the primary and the secondary, and in the other four frames it is the semi-major axis of their relative orbit. About 40 members spread over the family stand out from the faint rest. A kernel in eccentricity raises the opacity of the neighbors of the selected member, i.e. a member is drawn more opaque the closer its eccentricity lies to the eccentricity of the selected member. The trail of the selected member is a glow in the color of this member, under a white line with a yellow head. Every member is thinned to at most 480 samples by keeping a subset of its stored samples, and the page carries a time channel for every sample.

```{only} broucke_page and broucke_poster
<a href="examples/broucke.html"><img class="tycho-poster" src="examples/broucke.png" alt="A still of the Broucke page"></a>
```

```{only} broucke_page
[Open the Broucke page](site:examples/broucke.html). The interactive page has a size of {{ broucke_size }}, about {{ broucke_transfer }} to download in compressed form. It is too large to load together with this page, hence it opens separately.
```

```{only} not broucke_page
The page is not part of this build of the documentation. It is attached to each [GitHub Release](https://github.com/beeson-group/tycho/releases), and you can also build it from its input file as the [quickstart](quickstart.md#the-example) describes.
```
+++
[`examples/broucke/build.py`](https://github.com/beeson-group/tycho/blob/main/examples/broucke/build.py)
:::
::::
