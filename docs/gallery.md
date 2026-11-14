# Gallery

Each page here is the unchanged output of {meth}`Scene.write_html <pytycho.Scene.write_html>`, i.e. one HTML file with the scene, the data, and the runtime inside.
The page is built for each release, attached as a file to its [GitHub Release](https://github.com/beeson-group/tycho/releases), and copied into this site when the site is built.
The page thus always matches the release whose runtime wrote it.

::::{grid} 1
:gutter: 4

:::{grid-item-card} Broucke families of the elliptic problem, in five frames

The page shows Broucke's (1969) families 7, 8 and 11 of the planar elliptic restricted three-body problem, on their periapsis and apoapsis branches.
A family is a set of periodic orbits that changes continuously from one member to the next.
Each of the 1877 members of the three families was propagated for one period with PyDyLAN.

The five frames of Broucke's figures form one frame tree, in which every frame but the root is defined against its parent by a scale, a rotation, or a shift of its origin.

- The orbits are stored in the rotating-pulsating frame, which is the root.
- The rotating frame is the rotating-pulsating frame scaled by the distance between the primary and the secondary, which changes along their elliptic orbit.
- The barycentric inertial frame is the rotating frame rotated by the true anomaly, which is the angle along the elliptic orbit of the primary and the secondary, measured from periapsis.
- The last two frames are inertial frames centered on the primary and on the secondary.

The page opens with all five frames on screen, on the periapsis branch of family 11 at an eccentricity of 0.25.
The eccentricity here belongs to the orbit of the primary and the secondary, and it differs from member to member.
The page has the following controls.

- Tabs pick the family and the branch.
- The frame chip in the header of each panel picks the frame of the panel.
- The slider or the colorbar picks the member by its eccentricity.
- The clock runs on the true anomaly, the elapsed time, or the sample index, and the clock tabs switch between them.

Each frame has a separate colormap (a color scale) over the eccentricity, as in Broucke's figures, and its axes carry tick numbers and titles in DU, the distance unit.
In the rotating-pulsating frame DU is the current distance between the primary and the secondary, and in the other four frames it is the semi-major axis of their relative orbit.
About 40 members spread over the family stand out from the faint rest.
A kernel in eccentricity raises the opacity of the neighbors of the selected member, i.e. a member is drawn more opaque the closer its eccentricity lies to the eccentricity of the selected member.
The trail of the selected member is a glow in the color of this member, under a white line with a yellow head.
Every member is thinned to at most 480 samples by keeping a subset of its stored samples, and the page carries a time channel for every sample.

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

:::{grid-item-card} Invariant manifolds of Earth–Moon periodic orbits, in 3D

Three periodic orbits of the Earth–Moon circular restricted three-body problem are shown on this page, an L1 halo orbit and the L1 and L2 Lyapunov orbits, each with its stable and unstable manifolds on both sides.
Each of the four legs of an orbit holds 40 arcs that leave or reach the orbit along one period, propagated for 8 TU (the time unit of the problem) with PyDyLAN.

One declared panel is shown twice, in the rotating frame and in the barycentric inertial frame, under a 3d camera, which can be turned by hand.
The clock is in epoch mode on one absolute time, hence every arc is drawn where it is at the same instant.
A stable arc grows toward the orbit and an unstable arc away from it, over 20 seconds of a 24-second loop, and the arcs are held whole for the last 4 seconds.
Each arc is drawn only from where it is 0.02 DU (about 7700 km) from its orbit, since closer in the 40 arcs of a leg are drawn over the orbit as one bright band.
The halo orbit is nearly flat, hence the drawing is stretched by a factor of 5 along z, as is shown in the title of the z axis, and the camera is turned by 60° about z over each loop.
The controls of the page are the following.

- Tabs pick the orbit and the frame.
- Two toggles show and hide the stable and the unstable manifolds.
- The slider picks one arc by the time at which it leaves or reaches the orbit, and this arc is drawn brighter.

```{only} manifolds_page and manifolds_poster
<a href="examples/manifolds.html"><img class="tycho-poster" src="examples/manifolds.png" alt="A still of the manifolds page"></a>
```

```{only} manifolds_page
[Open the manifolds page](site:examples/manifolds.html). The interactive page has a size of {{ manifolds_size }}, about {{ manifolds_transfer }} to download in compressed form, and it opens separately.
```

```{only} not manifolds_page
The page is not part of this build of the documentation. It is attached to each [GitHub Release](https://github.com/beeson-group/tycho/releases) after 0.2.0, and you can also build it from its input file, as the docstring of its script describes.
```
+++
[`examples/manifolds/build.py`](https://github.com/beeson-group/tycho/blob/main/examples/manifolds/build.py)
:::
::::
