# Thinning

Thinning a trajectory set keeps only some of its stored samples, which makes the page smaller.
A propagated orbit often holds thousands of samples, and most of them do not change what shows on screen.
The method {meth}`TrajectorySet.thin <pytycho.TrajectorySet.thin>` keeps a subset of each trajectory's stored samples and never creates a sample, e.g. by interpolation.
Every sample on the page is therefore still one that the producing library computed, i.e. the library that propagated the orbit.
The method returns the kept indices of every trajectory, i.e. for each trajectory the array of the indices of the samples it keeps.
The call below keeps at most 480 samples per trajectory, measured in three frames.

```python
kept = family.thin(480, frames=["rotating", "barycentric-inertial", "inertial-moon"])
```

## Count mode

The call `thin(n)` keeps at most `n` samples per trajectory, at equal steps of arclength, i.e. of the length along the trajectory.
A trajectory of at most `n` samples is kept whole.
The arclength is measured in each frame of the list `frames`, which by default holds only the frame of the trajectory set.
In each frame, the length of every step between two consecutive samples is divided by the extent of the set in this frame.
The extent is the diagonal of the box that holds every trajectory of the set.
For each step, the largest of these relative lengths over the frames counts, hence a sample that matters in any frame is kept.
Each kept sample is the stored sample nearest to one of `n` points spaced evenly along this arclength.
Fewer points are taken when the forced samples below would bring the total above `n`.
Pass every frame in which the set will be drawn.
A flyby that is a small loop in the rotating frame and a sharp turn in an inertial frame then stays resolved wherever it is seen.

## Tolerance mode

The call `thin(tolerance=t)` runs the Douglas-Peucker algorithm relative to the set's extent.
This algorithm simplifies a polyline, i.e. a sequence of points joined by straight segments, by keeping only the samples that lie far from the segments between the kept ones.
It starts from the forced samples below and keeps the sample farthest from the segment between two kept samples when its distance exceeds the tolerance, then repeats on both halves.
A sample is thus dropped only when its distance to the segment between the kept samples around it is at most `t` times the set's extent, in every frame of `frames`.

## Forced samples

A forced sample is one that thinning always keeps.
Both endpoints of every trajectory are forced, i.e. its first and its last sample, and so is every index in `keep`.
The argument `keep` is either a list of index lists, one per trajectory, or a function that takes the trajectory index and returns the list for this trajectory.
Use `keep` for thrust switches, epochs, or any sample on which a readout must fall.
Forced samples take precedence over `n` when there are more than `n` of them, i.e. all of them are kept.

## Rules

- Thin after the last `add`, and only once.
  Another `add` on a thinned set raises {class}`~pytycho.SceneError`, and so does a second call to `thin`.
- Thinning changes `@index`, the built-in channel whose value at a sample is the sample's number, since it counts stored samples (rule `index-channel`).
  A clock on `@index` thus moves through the kept samples.
- Clock channels must stay strictly monotone, i.e. strictly increasing or strictly decreasing along every trajectory, which a selection of samples preserves.
  The writer checks them on the stored values, i.e. after thinning and after the cast to the stored dtype.
- The size of the page follows the number of stored samples.
  At float32, the default dtype, a 3D sample costs 12 bytes, i.e. 4 bytes for each of its three coordinates, and each channel costs 4 more.
  The size of every stored array is returned by {meth}`~pytycho.Scene.write_html`.
