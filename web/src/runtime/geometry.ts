/**
 * Static geometry of a track set in a display frame, and the revealed part of one track at a
 * reading. A set's samples are transformed once per display frame and lap, each in its context
 * (rules F4 and C6). Their readings u_i are computed once per clock channel (rule C1), so that
 * drawing a frame only compares readings and blends two transformed samples (rule C4). Every
 * panel showing the same frame shares the same buffers, and a lap is transformed the first time
 * something draws it.
 *
 * The GPU draws the stored segments of one lap per pass. Within a lap below the top one, the
 * closing sample of a track is replaced by the first sample of the next lap, which is the joint
 * of rule C6, so that the passes of consecutive laps draw one polyline. A segment is drawn when
 * both its ends lie strictly inside the revealed range of loop readings U = n u, where n is the
 * number of laps and u the reading. The range is stored as the lap and the within-lap reading of
 * each end, and compared lap by lap, so that the GPU compares the float32 readings as stored and
 * does not add a lap to any of them. The CPU draws the pieces at the two ends of the range, thus
 * the GPU and the CPU together draw the polyline of rules L1, L2 and C6.
 */
import type { DataStore } from '../container.js';
import { bound, clockLaps, lapOf, TrackClock } from '../evaluate/clock.js';
import { Frames } from '../evaluate/frames.js';
import { hasHead, point, type Vertex } from '../evaluate/layers.js';
import { SetCache, type SetData } from '../evaluate/sets.js';
import type { Clock, Scene, TrackLayer } from '../scene.js';
import { INDEX_CHANNEL } from '../scene.js';

type Box6 = [number, number, number, number, number, number];

/** The lap a vertex is evaluated in, which is its lap of rule C6, or one lower when it is shifted (rule L2). */
export function vertexLap(v: Vertex): number {
  return (v.lap ?? 0) - (v.shifted ? 1 : 0);
}

interface LapStore {
  buf: Float64Array;
  /** One flag per track, 1 when the samples of the track are transformed. */
  done: Uint8Array;
  all: boolean;
}

/**
 * Every sample of a set in one display frame, per lap, as x, y, z per sample in storage order.
 * A track is transformed in a lap the first time it is needed, so that drawing one member of a
 * large set costs one track, and the laps of rule C6 do not cost anything until something draws them.
 */
export class TrackGeometry {
  readonly set: SetData;
  readonly frame: string;
  /** The number of laps of rule C6 on the set. It is taken from the clock for a periodic set, and is one otherwise. */
  readonly laps: number;
  /** The highest lap, the only one that keeps its closing sample when the laps are joined. */
  readonly top: number;
  /** True when the edges into the display frame do not read any channel, meaning that every lap has the positions of lap 0. */
  readonly invariant: boolean;
  private readonly frames: Frames;
  private readonly stores = new Map<number, LapStore>();
  private box: Box6 | null = null;

  constructor(set: SetData, frame: string, frames: Frames, laps = 1) {
    this.set = set;
    this.frame = frame;
    this.frames = frames;
    this.laps = set.periodic ? laps : 1;
    this.top = this.laps - 1;
    this.invariant = frames.requirements(set.def.frame, frame).channels.size === 0;
  }

  /** The lap whose positions lap `j` has. */
  private storeLap(j: number): number {
    return this.invariant ? 0 : j;
  }

  /** A name for the GPU's segments of lap `j`, the same for every lap whose segments are the same. */
  lapKey(j: number): string {
    return this.invariant ? (j < this.top ? 'joined' : 'top') : String(j);
  }

  private store(j: number): LapStore {
    const k = this.storeLap(j);
    let s = this.stores.get(k);
    if (s === undefined) {
      s = { buf: new Float64Array(3 * this.set.samples), done: new Uint8Array(this.set.tracks), all: false };
      this.stores.set(k, s);
    }
    return s;
  }

  /** Transforms track `t` in lap `lap` (true stands for lap -1 and false for lap 0), unless it is already transformed. */
  ensure(t: number, lap: number | boolean): Float64Array {
    const j = lapNumber(lap);
    const st = this.store(j);
    if (st.done[t] === 1) return st.buf;
    const set = this.set;
    const k = this.storeLap(j);
    const s = set.start(t);
    for (let i = 0; i < set.count(t); i++) {
      st.buf.set(this.frames.transform(set.position(t, i), set.def.frame, this.frame, { set, track: t, sample: i, shifted: false, lap: k }), 3 * (s + i));
    }
    st.done[t] = 1;
    return st.buf;
  }

  /** Every sample of lap `j`, each in its context. */
  lapPositions(j: number): Float64Array {
    const st = this.store(j);
    if (!st.all) {
      for (let t = 0; t < this.set.tracks; t++) this.ensure(t, j);
      st.all = true;
    }
    return st.buf;
  }

  /** Every sample of lap 0, each in its context (rule F4). */
  get positions(): Float64Array {
    return this.lapPositions(0);
  }

  /** Every sample of lap -1, the shifted contexts of rule L2, for a periodic set only. */
  get shifted(): Float64Array | null {
    return this.set.periodic ? this.lapPositions(-1) : null;
  }

  /** The samples of track `t` alone in a lap, as x, y, z per sample. */
  track(t: number, lap: number | boolean): Float64Array {
    const buf = this.ensure(t, lap);
    const s = this.set.start(t);
    return buf.subarray(3 * s, 3 * (s + this.set.count(t)));
  }

  /**
   * Sample `i` of track `t` as the GPU draws lap `lap`, written at `out[o..o+2]`. It is the sample
   * of lap `lap` itself, except for the closing sample of a lap below the top, which is the first
   * sample of the next lap (rule C6).
   */
  gpuSample(t: number, lap: number, i: number, out: { [i: number]: number }, o = 0): void {
    const joint = i === this.set.count(t) - 1 && lap < this.top;
    const buf = this.ensure(t, joint ? lap + 1 : lap);
    const a = 3 * (this.set.start(t) + (joint ? 0 : i));
    out[o] = buf[a]!;
    out[o + 1] = buf[a + 1]!;
    out[o + 2] = buf[a + 2]!;
  }

  /**
   * The bounding box of track `t`, or of the whole set, over every lap from 0 to the top, as
   * minimum then maximum x, y, z.
   */
  bounds(t?: number): Box6 {
    if (t === undefined && this.box !== null) return this.box;
    const b: Box6 = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let j = 0; j <= (this.invariant ? 0 : this.top); j++) {
      const p = t === undefined ? this.lapPositions(j) : this.track(t, j);
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

  /** The position of a vertex of track `t` (rule C4) in its lap, written at `out[o..o+2]`. */
  vertex(t: number, v: Vertex, out: { [i: number]: number }, o = 0): void {
    const buf = this.ensure(t, vertexLap(v));
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

const lapNumber = (lap: number | boolean): number => (lap === true ? -1 : lap === false ? 0 : lap);

/** The clock along every track of a set for one channel, with the reading u_i of every sample and one TrackClock per track. */
export class TrackReadings {
  readonly channel: string;
  readonly clocks: TrackClock[];
  readonly u: Float64Array;

  constructor(set: SetData, channel: string) {
    this.channel = channel;
    this.clocks = [];
    this.u = new Float64Array(set.samples);
    for (let t = 0; t < set.tracks; t++) {
      const tc = new TrackClock(set, t, channel);
      const s = set.start(t);
      for (let i = 0; i < tc.m; i++) this.u[s + i] = tc.at(i);
      this.clocks.push(tc);
    }
  }
}

/**
 * A channel of the driver's track at progress `q`, as a readout shows it (section 2.9). The
 * reading is clamped to [0, 1], and the channel is blended between the samples of rule C4 in the
 * context of the driver's lap of rule C6.
 */
export function channelAtReading(set: SetData, tc: TrackClock, track: number, channel: string, clock: Clock, q: number): number {
  const laps = clockLaps(clock);
  const at = lapOf(laps * bound(tc.reading(clock, q))!, laps);
  const { k, w } = tc.locate(at.u);
  return (1 - w) * set.channelAt(channel, track, k, false, at.lap) + w * set.channelAt(channel, track, k + 1, false, at.lap);
}

// the revealed part of a track

const identity = (x: number): number => x;

/** A lap number far past any real lap. EMPTY_RANGE runs from lap FAR down to lap -FAR, hence it does not contain any vertex. */
const FAR = 1 << 20;

/** A range that does not contain any vertex, as [lap, reading, lap, reading] of its two ends. */
export const EMPTY_RANGE: readonly [number, number, number, number] = [FAR, 0, -FAR, 0];

/** The range every sample of every lap from 0 to `top` lies inside, closing samples included. */
export const fullRange = (top: number): [number, number, number, number] => [0, -1, top, 2];

/** The part of a polyline the GPU draws and the pieces the CPU draws at its two ends. */
export interface LoopSpan {
  /** The lap and the within-lap reading of each end for the GPU, [jA, uA, jB, uB], rounded as the GPU stores readings. */
  range: [number, number, number, number];
  /** The lowest and the highest lap whose pass draws a segment, or null when the GPU does not draw any segment. */
  laps: [number, number] | null;
  /** Segments the CPU draws, at the ends of the range. */
  pieces: [Vertex, Vertex][];
}

/** The first index whose rounded reading is above `x` (or at least `x` when `orEqual`), or the sample count `tc.m` when such an index does not exist. */
function search(tc: TrackClock, x: number, orEqual: boolean, round: (x: number) => number): number {
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
 * Whether the GPU draws, in lap `lap`, a segment whose samples read `ui` and `uj` (as stored),
 * against a range of `LoopSpan.range`. Both ends must lie strictly inside the range in loop
 * readings, compared lap first and reading second.
 */
export function segmentShown(range: readonly [number, number, number, number], lap: number, ui: number, uj: number): boolean {
  return (lap > range[0] || (lap === range[0] && range[1] < ui)) && (lap < range[2] || (lap === range[2] && uj < range[3]));
}

/**
 * The polyline of rules L1 and C6 between loop readings `ua <= ub`, on a set of `laps` laps. A
 * vertex is inside when its rounded reading in its lap lies strictly inside the rounded range, as
 * segmentShown tests it. With `round` the identity, the test selects the vertices of the
 * evaluator's polyline. With Math.fround, it is the comparison a float32 GPU makes, so that the
 * CPU's end pieces meet the GPU's segments at the same samples.
 */
export function loopSpan(tc: TrackClock, ua: number, ub: number, laps: number, round: (x: number) => number = identity): LoopSpan {
  if (ua === ub) return { range: [...EMPTY_RANGE], laps: null, pieces: [] };
  const top = laps - 1;
  const a = lapOf(ua, laps);
  const b = lapOf(ub, laps);
  const start = point(tc, a.u, false, a.lap);
  const end = point(tc, b.u, false, b.lap);
  const jA = a.lap;
  const uA = round(a.u);
  let jB = b.lap;
  let uB = round(b.u);
  // an end at the first sample of a lap is the closing sample of the lap below, where the joint
  // segment that reaches it is not inside
  if (uB === 0) (jB--, (uB = 1));
  const range: [number, number, number, number] = [jA, uA, jB, uB];
  const r = (i: number) => round(tc.at(i));
  // the last sample that belongs to a lap. below the top lap, the closing sample is the first sample of the next lap
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
    return { range, laps: null, pieces: [[start, end]] };
  }
  const pieces: [Vertex, Vertex][] = [
    [start, { sample: first[1], shifted: false, lap: first[0] }],
    [{ sample: final[1], shifted: false, lap: final[0] }, end],
  ];
  // a segment is drawn by the pass of the lap of its first sample
  const same = first[0] === final[0] && first[1] === final[1];
  return { range, laps: same ? null : [first[0], final[1] === 0 ? final[0] - 1 : final[0]], pieces };
}

export interface Reveal extends LoopSpan {
  /** The track is not drawn at this reading (rule C3). */
  hidden: boolean;
  /** The track's reading u, bounded by rule C3, or null when the layer does not take a reading or the track is hidden. */
  reading: number | null;
  /** The loop reading U = n u of rule C6, null when `reading` is null. */
  loop: number | null;
  /** The point at the reading, i.e. the head of rule L3, when the layer draws a head and the track is shown. */
  head: Vertex | null;
}

export interface RevealSpec {
  reveal: 'none' | 'grow' | 'trail';
  fraction: number;
  before?: 'clamp' | 'hidden';
  after?: 'clamp' | 'hidden';
  head: boolean;
  periodic: boolean;
  /** The number of laps n of rule C6 on this set, taken from the clock for a periodic set and one otherwise. */
  laps: number;
}

/** Whether a layer takes a reading on its tracks (rule C5), by the same test as the evaluator. */
export function needsReading(layer: TrackLayer, clock: Clock): boolean {
  return (layer.reveal ?? 'none') !== 'none' || hasHead(layer) || (clock.mode === 'value' && (layer.before === 'hidden' || layer.after === 'hidden'));
}

export function revealSpec(layer: TrackLayer, periodic: boolean, laps = 1): RevealSpec {
  return {
    reveal: layer.reveal ?? 'none',
    fraction: layer.trail?.fraction ?? 1,
    before: layer.before,
    after: layer.after,
    head: hasHead(layer),
    periodic,
    laps: periodic ? laps : 1,
  };
}

/**
 * The revealed part of one track at progress `q` (rules C2, C3, C6, L1, L2 and L3). The track clock
 * `tc` is null only for a layer that does not take a reading, which shows every sample of every lap.
 */
export function revealTrack(tc: TrackClock | null, clock: Clock, q: number, spec: RevealSpec, round: (x: number) => number = identity): Reveal {
  const n = spec.laps;
  const full = { range: fullRange(n - 1), laps: [0, n - 1] as [number, number], pieces: [] };
  if (tc === null) return { hidden: false, reading: null, loop: null, head: null, ...full };
  const u = bound(tc.reading(clock, q), spec.before, spec.after);
  if (u === null) return { hidden: true, reading: null, loop: null, head: null, range: [...EMPTY_RANGE], laps: null, pieces: [] };
  const U = n * u;
  const at = lapOf(U, n);
  const head = spec.head ? point(tc, at.u, false, at.lap) : null;
  if (spec.reveal === 'none') return { hidden: false, reading: u, loop: U, head, ...full };
  // the tail of rule L2 is computed in float64 with the product first, and cut at 0 unless the set is periodic
  let tail = spec.reveal === 'grow' ? 0 : U - n * spec.fraction;
  if (tail < 0 && !spec.periodic) tail = 0;
  return { hidden: false, reading: u, loop: U, head, ...loopSpan(tc, tail, U, n, round) };
}
