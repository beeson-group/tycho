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
