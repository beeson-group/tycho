/**
 * Static geometry of a trajectory set in a display frame, and the revealed part of one trajectory at a
 * reading. A set's samples are transformed once per display frame and revolution, each in its context
 * (rules `sample-context` and `revolutions`). Their readings u_i are computed once per clock channel (rule `sample-fraction`), so that
 * drawing a frame only compares readings and blends two transformed samples (rule `segment`). Every
 * panel showing the same frame shares the same buffers, and a revolution is transformed the first time
 * something draws it.
 *
 * The GPU draws the stored segments of one revolution per pass. Within a revolution below the top one, the
 * closing sample of a trajectory is replaced by the first sample of the next revolution, which is the joint
 * of rule `revolutions`, so that the passes of consecutive revolutions draw one polyline. A segment is drawn when
 * both its ends lie strictly inside the revealed range of loop readings U = n u, where n is the
 * number of revolutions and u the reading. The range is stored as the revolution and the within-revolution reading of
 * each end, and compared revolution by revolution, so that the GPU compares the float32 readings as stored and
 * does not add a revolution to any of them. The CPU draws the pieces at the two ends of the range, thus
 * the GPU and the CPU together draw the polyline of rules `polyline`, `trail-wrap` and `revolutions`.
 */
import type { DataStore } from '../container.js';
import { fail } from '../errors.js';
import { bound, clockRevolutions, revolutionOf, TrajectoryClock } from '../evaluate/clock.js';
import { Frames } from '../evaluate/frames.js';
import { hasHead, point, type Vertex } from '../evaluate/layers.js';
import { SetCache, type SetData } from '../evaluate/sets.js';
import type { Clock, Scene, TrajectoriesLayer } from '../scene.js';
import { INDEX_CHANNEL } from '../scene.js';

type Box6 = [number, number, number, number, number, number];

/** The revolution a vertex is evaluated in, which is its revolution of rule `revolutions`, or one lower when it is shifted (rule `trail-wrap`). */
export function vertexRevolution(v: Vertex): number {
  return (v.revolution ?? 0) - (v.shifted ? 1 : 0);
}

interface RevolutionStore {
  buf: Float64Array;
  /** One flag per trajectory, 1 when the samples of the trajectory are transformed. */
  done: Uint8Array;
  all: boolean;
}

/**
 * Every sample of a set in one display frame, per revolution, as x, y, z per sample in storage order.
 * A trajectory is transformed in a revolution the first time it is needed, so that drawing one member of a
 * large set costs one trajectory, and the revolutions of rule `revolutions` do not cost anything until something draws them.
 */
export class TrajectoryGeometry {
  readonly set: SetData;
  readonly frame: string;
  /** The number of revolutions of rule `revolutions` on the set. It is taken from the clock for a periodic set, and is one otherwise. */
  readonly revolutions: number;
  /** The highest revolution, the only one that keeps its closing sample when the revolutions are joined. */
  readonly top: number;
  /** True when the edges into the display frame do not read any channel, meaning that every revolution has the positions of revolution 0. */
  readonly invariant: boolean;
  private readonly frames: Frames;
  private readonly stores = new Map<number, RevolutionStore>();
  private box: Box6 | null = null;

  constructor(set: SetData, frame: string, frames: Frames, revolutions = 1) {
    this.set = set;
    this.frame = frame;
    this.frames = frames;
    this.revolutions = set.periodic ? revolutions : 1;
    this.top = this.revolutions - 1;
    this.invariant = frames.requirements(set.def.frame, frame).channels.size === 0;
  }

  /** The revolution whose positions revolution `j` has. */
  private storeRevolution(j: number): number {
    return this.invariant ? 0 : j;
  }

  /** A name for the GPU's segments of revolution `j`, the same for every revolution whose segments are the same. */
  revolutionKey(j: number): string {
    return this.invariant ? (j < this.top ? 'joined' : 'top') : String(j);
  }

  private store(j: number): RevolutionStore {
    const k = this.storeRevolution(j);
    let s = this.stores.get(k);
    if (s === undefined) {
      s = { buf: new Float64Array(3 * this.set.samples), done: new Uint8Array(this.set.trajectories), all: false };
      this.stores.set(k, s);
    }
    return s;
  }

  /** Transforms trajectory `t` in revolution `revolution` (true stands for revolution -1 and false for revolution 0), unless it is already transformed. */
  ensure(t: number, revolution: number | boolean): Float64Array {
    const j = revolutionNumber(revolution);
    const st = this.store(j);
    if (st.done[t] === 1) return st.buf;
    const set = this.set;
    const k = this.storeRevolution(j);
    const s = set.start(t);
    for (let i = 0; i < set.count(t); i++) {
      st.buf.set(
        this.frames.transform(set.position(t, i), set.def.frame, this.frame, { set, trajectory: t, sample: i, shifted: false, revolution: k }),
        3 * (s + i),
      );
    }
    st.done[t] = 1;
    return st.buf;
  }

  /** Every sample of revolution `j`, each in its context. */
  revolutionPositions(j: number): Float64Array {
    const st = this.store(j);
    if (!st.all) {
      for (let t = 0; t < this.set.trajectories; t++) this.ensure(t, j);
      st.all = true;
    }
    return st.buf;
  }

  /** Every sample of revolution 0, each in its context (rule `sample-context`). */
  get positions(): Float64Array {
    return this.revolutionPositions(0);
  }

  /** Every sample of revolution -1, the shifted contexts of rule `trail-wrap`, for a periodic set only. */
  get shifted(): Float64Array | null {
    return this.set.periodic ? this.revolutionPositions(-1) : null;
  }

  /** The samples of trajectory `t` alone in a revolution, as x, y, z per sample. */
  trajectory(t: number, revolution: number | boolean): Float64Array {
    const buf = this.ensure(t, revolution);
    const s = this.set.start(t);
    return buf.subarray(3 * s, 3 * (s + this.set.count(t)));
  }

  /**
   * Sample `i` of trajectory `t` as the GPU draws revolution `revolution`, written at `out[o..o+2]`. It is the sample
   * of revolution `revolution` itself, except for the closing sample of a revolution below the top, which is the first
   * sample of the next revolution (rule `revolutions`).
   */
  gpuSample(t: number, revolution: number, i: number, out: { [i: number]: number }, o = 0): void {
    const joint = i === this.set.count(t) - 1 && revolution < this.top;
    const buf = this.ensure(t, joint ? revolution + 1 : revolution);
    const a = 3 * (this.set.start(t) + (joint ? 0 : i));
    out[o] = buf[a]!;
    out[o + 1] = buf[a + 1]!;
    out[o + 2] = buf[a + 2]!;
  }

  /**
   * The bounding box of trajectory `t`, or of the whole set, over every revolution from 0 to the top, as
   * minimum then maximum x, y, z.
   */
  bounds(t?: number): Box6 {
    if (t === undefined && this.box !== null) return this.box;
    const b: Box6 = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let j = 0; j <= (this.invariant ? 0 : this.top); j++) {
      const p = t === undefined ? this.revolutionPositions(j) : this.trajectory(t, j);
      for (let i = 0; i < p.length; i += 3) {
        for (let c = 0; c < 3; c++) {
          const v = p[i + c]!;
          if (v < b[c]!) b[c] = v;
          if (v > b[c + 3]!) b[c + 3] = v;
        }
      }
    }
    if (t === undefined) this.box = b;
    return b;
  }

  /** The position of a vertex of trajectory `t` (rule `segment`) in its revolution, written at `out[o..o+2]`. */
  vertex(t: number, v: Vertex, out: { [i: number]: number }, o = 0): void {
    const buf = this.ensure(t, vertexRevolution(v));
    const s = this.set.start(t);
    if ('sample' in v) {
      const a = 3 * (s + v.sample);
      out[o] = buf[a]!;
      out[o + 1] = buf[a + 1]!;
      out[o + 2] = buf[a + 2]!;
      return;
    }
    const a = 3 * (s + v.k);
    const w = v.w;
    for (let c = 0; c < 3; c++) out[o + c] = (1 - w) * buf[a + c]! + w * buf[a + 3 + c]!;
  }
}

const revolutionNumber = (revolution: number | boolean): number => (revolution === true ? -1 : revolution === false ? 0 : revolution);

/** The clock along every trajectory of a set for one channel, with the reading u_i of every sample and one TrajectoryClock per trajectory. */
export class TrajectoryReadings {
  readonly channel: string;
  readonly clocks: TrajectoryClock[];
  readonly u: Float64Array;

  constructor(set: SetData, channel: string) {
    this.channel = channel;
    this.clocks = [];
    this.u = new Float64Array(set.samples);
    for (let t = 0; t < set.trajectories; t++) {
      const tc = new TrajectoryClock(set, t, channel);
      const s = set.start(t);
      for (let i = 0; i < tc.m; i++) this.u[s + i] = tc.at(i);
      this.clocks.push(tc);
    }
  }
}

/** Geometry and readings, built on first use and kept for the life of the page. */
export class GeometryCache {
  readonly scene: Scene;
  readonly sets: SetCache;
  readonly frames: Frames;
  private readonly geometries = new Map<string, TrajectoryGeometry>();
  private readonly readingsBy = new Map<string, TrajectoryReadings>();
  private readonly bodyTrails = new Map<string, BodyTrailTable>();

  private readonly data: DataStore;

  constructor(scene: Scene, data: DataStore) {
    this.scene = scene;
    this.data = data;
    this.sets = new SetCache(scene, data);
    this.frames = new Frames(scene);
  }

  /** The bytes of an array of `uint8` elements, e.g. the image file of a body (section 2.11). */
  bytes(name: string): Uint8Array {
    if (!this.data.has(name)) fail('body', `the data container does not hold array ${JSON.stringify(name)}`);
    const v = this.data.array(name);
    if (v.dtype !== 'uint8') fail('body', `array ${name} holds ${v.dtype}, not the uint8 bytes of an image`);
    return v.data as Uint8Array;
  }

  /** Throws an error of rule `revolutions` when the clock is in epoch mode but has revolutions. */
  geometry(setId: string, frame: string): TrajectoryGeometry {
    const key = `${setId}\0${frame}`;
    let g = this.geometries.get(key);
    if (!g) {
      g = new TrajectoryGeometry(this.sets.get(setId), frame, this.frames, clockRevolutions(this.scene.clock));
      this.geometries.set(key, g);
    }
    return g;
  }

  hasChannel(setId: string, channel: string): boolean {
    return channel === INDEX_CHANNEL || this.sets.get(setId).hasChannel(channel);
  }

  /** Throws an error of rule `clock-channel-carried` when the set lacks the channel. */
  readings(setId: string, channel: string): TrajectoryReadings {
    const key = `${setId}\0${channel}`;
    let r = this.readingsBy.get(key);
    if (!r) {
      r = new TrajectoryReadings(this.sets.get(setId), channel);
      this.readingsBy.set(key, r);
    }
    return r;
  }

  /** The positions of a body along one reference trajectory in one display frame, kept per revolution. */
  bodyTrail(bodyId: string, display: string, setId: string, trajectory: number): BodyTrailTable {
    const key = `${bodyId}\0${display}\0${setId}\0${trajectory}`;
    let t = this.bodyTrails.get(key);
    if (!t) {
      t = new BodyTrailTable(this.frames, bodyId, display, this.sets.get(setId), trajectory);
      this.bodyTrails.set(key, t);
    }
    return t;
  }
}

/**
 * A channel of the reference trajectory's trajectory at progress `q`, as a readout shows it (section 2.9). The
 * reading is clamped to [0, 1], and the channel is blended between the samples of rule `segment` in the
 * context of the reference trajectory's revolution of rule `revolutions`.
 */
export function channelAtReading(set: SetData, tc: TrajectoryClock, trajectory: number, channel: string, clock: Clock, q: number, hold = false): number {
  const revolutions = clockRevolutions(clock);
  const at = revolutionOf(revolutions * bound(tc.reading(clock, q))!, revolutions);
  const { k, w } = tc.locate(at.u);
  // a channel with interp hold keeps the value of sample k up to the next sample (rule `timeline-parts`)
  if (hold) return set.channelAt(channel, trajectory, w >= 1 ? k + 1 : k, false, at.revolution);
  return (1 - w) * set.channelAt(channel, trajectory, k, false, at.revolution) + w * set.channelAt(channel, trajectory, k + 1, false, at.revolution);
}

// the revealed part of a trajectory

const identity = (x: number): number => x;

/** A revolution number far past any real revolution. EMPTY_RANGE runs from revolution FAR down to revolution -FAR, hence it does not contain any vertex. */
const FAR = 1 << 20;

/** A range that does not contain any vertex, as [revolution, reading, revolution, reading] of its two ends. */
export const EMPTY_RANGE: readonly [number, number, number, number] = [FAR, 0, -FAR, 0];

/** The range every sample of every revolution from 0 to `top` lies inside, closing samples included. */
export const fullRange = (top: number): [number, number, number, number] => [0, -1, top, 2];

/** The part of a polyline the GPU draws and the pieces the CPU draws at its two ends. */
export interface LoopSpan {
  /** The revolution and the within-revolution reading of each end for the GPU, [jA, uA, jB, uB], rounded as the GPU stores readings. */
  range: [number, number, number, number];
  /** The lowest and the highest revolution whose pass draws a segment, or null when the GPU does not draw any segment. */
  revolutions: [number, number] | null;
  /** Segments the CPU draws, at the ends of the range. */
  pieces: [Vertex, Vertex][];
}

/** The first index whose rounded reading is above `x` (or at least `x` when `orEqual`), or the sample count `tc.m` when such an index does not exist. */
function search(tc: TrajectoryClock, x: number, orEqual: boolean, round: (x: number) => number): number {
  let lo = 0;
  let hi = tc.m;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const r = round(tc.at(mid));
    if (r > x || (orEqual && r === x)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Whether the GPU draws, in revolution `revolution`, a segment whose samples read `ui` and `uj` (as stored),
 * against a range of `LoopSpan.range`. Both ends must lie strictly inside the range in loop
 * readings, compared revolution first and reading second.
 */
export function segmentShown(range: readonly [number, number, number, number], revolution: number, ui: number, uj: number): boolean {
  return (revolution > range[0] || (revolution === range[0] && range[1] < ui)) && (revolution < range[2] || (revolution === range[2] && uj < range[3]));
}

/**
 * The polyline of rules `polyline` and `revolutions` between loop readings `ua <= ub`, on a set of `revolutions` revolutions. A
 * vertex is inside when its rounded reading in its revolution lies strictly inside the rounded range, as
 * segmentShown tests it. With `round` the identity, the test selects the vertices of the
 * evaluator's polyline. With Math.fround, it is the comparison a float32 GPU makes, so that the
 * CPU's end pieces meet the GPU's segments at the same samples.
 */
export function loopSpan(tc: TrajectoryClock, ua: number, ub: number, revolutions: number, round: (x: number) => number = identity): LoopSpan {
  if (ua === ub) return { range: [...EMPTY_RANGE], revolutions: null, pieces: [] };
  const top = revolutions - 1;
  const a = revolutionOf(ua, revolutions);
  const b = revolutionOf(ub, revolutions);
  const start = point(tc, a.u, false, a.revolution);
  const end = point(tc, b.u, false, b.revolution);
  const jA = a.revolution;
  const uA = round(a.u);
  let jB = b.revolution;
  let uB = round(b.u);
  // an end at the first sample of a revolution is the closing sample of the revolution below, where the joint
  // segment that reaches it is not inside
  if (uB === 0) (jB--, (uB = 1));
  const range: [number, number, number, number] = [jA, uA, jB, uB];
  const r = (i: number) => round(tc.at(i));
  // the last sample that belongs to a revolution. below the top revolution, the closing sample is the first sample of the next revolution
  const last = (j: number) => (j < top ? tc.m - 2 : tc.m - 1);
  const upper = (j: number, x: number) => j < jB || (j === jB && x < uB);
  const lower = (j: number, x: number) => j > jA || (j === jA && uA < x);
  const i0 = search(tc, uA, false, round);
  let first: [number, number] | null = i0 <= last(jA) ? [jA, i0] : jA < top ? [jA + 1, 0] : null;
  if (first !== null && !upper(first[0], r(first[1]))) first = null;
  const i1 = Math.min(search(tc, uB, true, round) - 1, last(jB));
  let final: [number, number] | null = i1 >= 0 ? [jB, i1] : null;
  if (final !== null && !lower(final[0], r(final[1]))) final = null;
  if (first === null || final === null || first[0] > final[0] || (first[0] === final[0] && first[1] > final[1])) {
    return { range, revolutions: null, pieces: [[start, end]] };
  }
  const pieces: [Vertex, Vertex][] = [
    [start, { sample: first[1], shifted: false, revolution: first[0] }],
    [{ sample: final[1], shifted: false, revolution: final[0] }, end],
  ];
  // a segment is drawn by the pass of the revolution of its first sample
  const same = first[0] === final[0] && first[1] === final[1];
  return { range, revolutions: same ? null : [first[0], final[1] === 0 ? final[0] - 1 : final[0]], pieces };
}

export interface Reveal extends LoopSpan {
  /** The trajectory is not drawn at this reading (rule `before-after`). */
  hidden: boolean;
  /** The trajectory's reading u, bounded by rule `before-after`, or null when the layer does not take a reading or the trajectory is hidden. */
  reading: number | null;
  /** The loop reading U = n u of rule `revolutions`, null when `reading` is null. */
  loop: number | null;
  /** The point at the reading, i.e. the head of rule `head`, when the layer draws a head and the trajectory is shown. */
  head: Vertex | null;
}

export interface RevealSpec {
  reveal: 'none' | 'grow' | 'trail';
  fraction: number;
  before?: 'clamp' | 'hidden';
  after?: 'clamp' | 'hidden';
  head: boolean;
  periodic: boolean;
  /** The number of revolutions n of rule `revolutions` on this set, taken from the clock for a periodic set and one otherwise. */
  revolutions: number;
}

/** Whether a layer takes a reading on its trajectories (rule `clock-channel-carried`), by the same test as the evaluator. */
export function needsReading(layer: TrajectoriesLayer, clock: Clock): boolean {
  return (layer.reveal ?? 'none') !== 'none' || hasHead(layer) || (clock.mode === 'epoch' && (layer.before === 'hidden' || layer.after === 'hidden'));
}

export function revealSpec(layer: TrajectoriesLayer, periodic: boolean, revolutions = 1): RevealSpec {
  return {
    reveal: layer.reveal ?? 'none',
    fraction: layer.trail?.fraction ?? 1,
    before: layer.before,
    after: layer.after,
    head: hasHead(layer),
    periodic,
    revolutions: periodic ? revolutions : 1,
  };
}

/**
 * The revealed part of one trajectory at progress `q` (rules `clock-mode`, `before-after`, `revolutions`, `polyline`, `trail-wrap` and `head`). The trajectory clock
 * `tc` is null only for a layer that does not take a reading, which shows every sample of every revolution.
 */
export function revealTrajectory(tc: TrajectoryClock | null, clock: Clock, q: number, spec: RevealSpec, round: (x: number) => number = identity): Reveal {
  const n = spec.revolutions;
  const full = { range: fullRange(n - 1), revolutions: [0, n - 1] as [number, number], pieces: [] };
  if (tc === null) return { hidden: false, reading: null, loop: null, head: null, ...full };
  const u = bound(tc.reading(clock, q), spec.before, spec.after);
  if (u === null) return { hidden: true, reading: null, loop: null, head: null, range: [...EMPTY_RANGE], revolutions: null, pieces: [] };
  const U = n * u;
  const at = revolutionOf(U, n);
  const head = spec.head ? point(tc, at.u, false, at.revolution) : null;
  if (spec.reveal === 'none') return { hidden: false, reading: u, loop: U, head, ...full };
  // the tail of rule `trail-wrap` is computed in float64 with the product first, and cut at 0 unless the set is periodic
  let tail = spec.reveal === 'grow' ? 0 : U - n * spec.fraction;
  if (tail < 0 && !spec.periodic) tail = 0;
  return { hidden: false, reading: u, loop: U, head, ...loopSpan(tc, tail, U, n, round) };
}

// buffers in the layout the GPU draws, with two vertices per stored segment

/** The number of stored segments of a set, i.e. its number of samples minus its number of trajectories. */
export function segmentCount(set: SetData): number {
  return set.samples - set.trajectories;
}

/** The index of the first segment of trajectory `t`. */
export function firstSegment(set: SetData, t: number): number {
  return set.start(t) - t;
}

/** Calls `f(segment, sample)` for every stored segment, with the global index of its first sample. */
function eachSegment(set: SetData, f: (j: number, s: number) => void): void {
  let j = 0;
  for (let t = 0; t < set.trajectories; t++) {
    const s = set.start(t);
    const m = set.count(t);
    for (let i = 0; i + 1 < m; i++) f(j++, s + i);
  }
}

/** Per-sample values of width `k`, as two vertices per segment. */
export function pairs(set: SetData, values: ArrayLike<number>, k: number): Float32Array {
  const out = new Float32Array(2 * k * segmentCount(set));
  eachSegment(set, (j, s) => {
    for (let c = 0; c < k; c++) {
      out[2 * k * j + c] = values[k * s + c]!;
      out[2 * k * j + k + c] = values[k * (s + 1) + c]!;
    }
  });
  return out;
}

/** Per-sample values of width `k` of the `m` samples from `s` on, as two vertices per segment. */
export function slicePairs(values: ArrayLike<number>, k: number, s: number, m: number): Float32Array {
  const out = new Float32Array(2 * k * (m - 1));
  for (let i = 0; i + 1 < m; i++) {
    for (let c = 0; c < k; c++) {
      out[2 * k * i + c] = values[k * (s + i) + c]!;
      out[2 * k * i + k + c] = values[k * (s + i + 1) + c]!;
    }
  }
  return out;
}

/** Writes the segments of trajectory `t` in revolution `revolution` as gpuSample gives them, from segment `j` on. */
function writeTrajectoryPairs(g: TrajectoryGeometry, t: number, revolution: number, out: Float32Array, j: number): void {
  const m = g.set.count(t);
  const own = g.trajectory(t, revolution);
  const joint = [0, 0, 0];
  if (revolution < g.top) g.gpuSample(t, revolution, m - 1, joint);
  for (let i = 0; i + 1 < m; i++, j++) {
    for (let c = 0; c < 3; c++) {
      out[6 * j + c] = own[3 * i + c]!;
      out[6 * j + 3 + c] = i + 2 === m && revolution < g.top ? joint[c]! : own[3 * (i + 1) + c]!;
    }
  }
}

/** The positions of every segment of a set in revolution `revolution`, as two vertices per segment, joined to the next revolution below the top. */
export function revolutionPairs(g: TrajectoryGeometry, revolution: number): Float32Array {
  const out = new Float32Array(6 * segmentCount(g.set));
  for (let t = 0; t < g.set.trajectories; t++) writeTrajectoryPairs(g, t, revolution, out, firstSegment(g.set, t));
  return out;
}

/** The positions of the segments of trajectory `t` in revolution `revolution`, as revolutionPairs lays them out. */
export function trajectoryRevolutionPairs(g: TrajectoryGeometry, t: number, revolution: number): Float32Array {
  const out = new Float32Array(6 * (g.set.count(t) - 1));
  writeTrajectoryPairs(g, t, revolution, out, 0);
  return out;
}

/** The loop reading of a vertex, which is the reading u_i at a sample or the blended reading at a point, plus its revolution. */
export function vertexReading(tc: TrajectoryClock, v: Vertex): number {
  const u = 'sample' in v ? tc.at(v.sample) : (1 - v.w) * tc.at(v.k) + v.w * tc.at(v.k + 1);
  return u + vertexRevolution(v);
}

/** The readings of a segment's two samples, (u_i, u_(i+1)), on both its vertices. */
export function pairReadings(set: SetData, u: Float64Array): Float32Array {
  const out = new Float32Array(4 * segmentCount(set));
  eachSegment(set, (j, s) => {
    out[4 * j] = out[4 * j + 2] = u[s]!;
    out[4 * j + 1] = out[4 * j + 3] = u[s + 1]!;
  });
  return out;
}

/** The readings of the `m` samples from `s` on, as pairReadings lays them out. */
export function readingPairs(u: ArrayLike<number>, s: number, m: number): Float32Array {
  const out = new Float32Array(4 * (m - 1));
  for (let i = 0; i + 1 < m; i++) {
    out[4 * i] = out[4 * i + 2] = u[s + i]!;
    out[4 * i + 1] = out[4 * i + 3] = u[s + i + 1]!;
  }
  return out;
}

/** The trajectory index of every vertex. */
export function pairTrajectories(set: SetData): Float32Array {
  const out = new Float32Array(2 * segmentCount(set));
  let j = 0;
  for (let t = 0; t < set.trajectories; t++) for (let i = 0; i + 1 < set.count(t); i++, j++) out[2 * j] = out[2 * j + 1] = t;
  return out;
}

// body trails

/**
 * A body's position in one display frame in the context of each sample of one reference trajectory,
 * per revolution of rule `revolutions`, as x, y, z per sample. A revolution is filled the first time it is drawn and kept,
 * so that a frame copies a trail instead of evaluating it. When neither the body's position nor an
 * edge into the display frame reads a channel, every revolution has the positions of revolution 0.
 */
export class BodyTrailTable {
  readonly m: number;
  readonly invariant: boolean;
  private readonly revolutions = new Map<number, Float64Array>();

  constructor(
    private readonly frames: Frames,
    private readonly body: string,
    private readonly display: string,
    private readonly set: SetData,
    private readonly trajectory: number,
  ) {
    this.m = set.count(trajectory);
    this.invariant = frames.bodyRequirements(body, display).channels.size === 0;
  }

  /** The body's positions at every sample of revolution `j`, each in the context of its sample. */
  revolution(j: number): Float64Array {
    const k = this.invariant ? 0 : j;
    let buf = this.revolutions.get(k);
    if (buf === undefined) {
      buf = new Float64Array(3 * this.m);
      const { set, trajectory } = this;
      for (let i = 0; i < this.m; i++)
        buf.set(this.frames.bodyPosition(this.body, this.display, { set, trajectory, sample: i, shifted: false, revolution: k }), 3 * i);
      this.revolutions.set(k, buf);
    }
    return buf;
  }

  /** The position of a vertex (rule `segment`) in its revolution, written at `out[o..o+2]`. */
  vertex(v: Vertex, out: { [i: number]: number }, o = 0): void {
    const buf = this.revolution(vertexRevolution(v));
    if ('sample' in v) {
      const a = 3 * v.sample;
      out[o] = buf[a]!;
      out[o + 1] = buf[a + 1]!;
      out[o + 2] = buf[a + 2]!;
      return;
    }
    const a = 3 * v.k;
    const w = v.w;
    for (let c = 0; c < 3; c++) out[o + c] = (1 - w) * buf[a + c]! + w * buf[a + 3 + c]!;
  }

  /**
   * The polyline of rules `polyline` and `revolutions` between loop readings `ua <= ub`, with the same vertices as the
   * evaluator's `loopPolyline`, written as x, y, z per vertex from `out[0]`. Returns the vertex
   * count. The samples of a revolution are copied as runs, and only the two ends are blended.
   */
  polyline(tc: TrajectoryClock, ua: number, ub: number, revolutions: number, out: Float32Array): number {
    let n = 0;
    const put = (v: Vertex) => {
      this.vertex(v, out, 3 * n);
      n++;
    };
    const a = revolutionOf(ua, revolutions);
    if (ua === ub) {
      put(point(tc, a.u, false, a.revolution));
      return n;
    }
    const b = revolutionOf(ub, revolutions);
    // the samples of revolution j strictly inside (lo, hi), as a run of the revolution's buffer
    const run = (j: number, lo: number, hi: number) => {
      const i0 = search(tc, lo, false, identity);
      const i1 = search(tc, hi, true, identity);
      if (i1 > i0) {
        out.set(this.revolution(j).subarray(3 * i0, 3 * i1), 3 * n);
        n += i1 - i0;
      }
    };
    if (a.revolution === b.revolution) {
      put(point(tc, a.u, false, a.revolution));
      run(a.revolution, a.u, b.u);
      put(point(tc, b.u, false, b.revolution));
      return n;
    }
    // each joint keeps the first sample of the higher revolution (rule `revolutions`), hence the end point of a revolution is dropped
    put(point(tc, a.u, false, a.revolution));
    run(a.revolution, a.u, 1);
    for (let j = a.revolution + 1; j < b.revolution; j++) {
      put(point(tc, 0, false, j));
      run(j, 0, 1);
    }
    put(point(tc, 0, false, b.revolution));
    // an end at the first sample of its revolution is the point put above (rule `polyline`)
    if (b.u === 0) return n;
    run(b.revolution, 0, b.u);
    put(point(tc, b.u, false, b.revolution));
    return n;
  }
}

/** The most vertices a trail of `fraction` of a loop of `revolutions` revolutions over `m` samples can have. */
export function trailCapacity(m: number, revolutions: number, fraction: number): number {
  return (Math.ceil(revolutions * fraction) + 2) * (m + 1) + 2;
}
