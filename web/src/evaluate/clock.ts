/** The clock, rules C1 to C4 and the laps of rule C6. */
import { fail } from '../errors.js';
import { INDEX_CHANNEL, type Clock, type LayerClock } from '../scene.js';
import type { SetData } from './sets.js';
import { checkKeys, clockValue, loopSeconds } from './timeline.js';

/** Progress q in [0, 1) for a frame index, taken modulo `steps` (section 2.6). */
export function progress(steps: number, frameIndex: number): number {
  if (!Number.isInteger(frameIndex)) fail('2.6', `the frame index ${String(frameIndex)} is not an integer`);
  if (!Number.isInteger(steps) || steps < 1) fail('2.6', `the clock has steps ${String(steps)}, not a count of at least one`);
  const i = ((frameIndex % steps) + steps) % steps;
  return i / steps;
}

/** The clock along one track, which holds the sample readings u_i of rule C1 and gives the reading of rule C2. */
export class TrackClock {
  readonly m: number;
  private readonly c0: number;
  private readonly c1: number;
  private readonly u: Float64Array;

  constructor(set: SetData, track: number, channel: string) {
    const m = set.count(track);
    this.m = m;
    this.u = new Float64Array(m);
    if (channel === INDEX_CHANNEL) {
      this.c0 = 0;
      this.c1 = m - 1;
      for (let i = 0; i < m; i++) this.u[i] = i / (m - 1);
      return;
    }
    const c = set.channel(channel, 'C5');
    const s = set.start(track);
    this.c0 = c[s]!;
    this.c1 = c[s + m - 1]!;
    // where the reading is taken, the clock channel is checked to be finite and strictly monotone along the track, with a finite span (rule T3)
    const sign = Math.sign(c[s + 1]! - c[s]!);
    for (let i = 0; i < m; i++) {
      if (!Number.isFinite(c[s + i]!) || (i > 0 && !((c[s + i]! - c[s + i - 1]!) * sign > 0))) {
        fail('T3', `clock channel ${channel} of track set ${set.id} is not both finite and strictly monotone along track ${track}`);
      }
    }
    if (!Number.isFinite(this.c1 - this.c0)) fail('T3', `clock channel ${channel} of track set ${set.id} has an infinite span along track ${track}`);
    for (let i = 0; i < m; i++) this.u[i] = (c[s + i]! - this.c0) / (this.c1 - this.c0);
  }

  /** The reading u_i at which sample `i` sits along the track (rule C1). */
  at(i: number): number {
    return this.u[i]!;
  }

  /** The track's reading at progress q (rule C2), possibly outside [0, 1] in value mode. */
  reading(clock: Clock, q: number): number {
    if (clock.mode === 'fraction') return q;
    const v = clockValue(clock, q);
    return (v - this.c0) / (this.c1 - this.c0);
  }

  /** The segment k and weight w of the point at reading u in [0, 1] (rule C4). */
  locate(u: number): { k: number; w: number } {
    let lo = 0;
    let hi = this.m - 2;
    // The search finds the largest k <= m - 2 with u_k <= u, since readings increase strictly (rule T3).
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.u[mid]! <= u) lo = mid;
      else hi = mid - 1;
    }
    const k = lo;
    return { k, w: (u - this.u[k]!) / (this.u[k + 1]! - this.u[k]!) };
  }
}

/** The number of laps of rule C6, 1 when absent. Only a clock in fraction mode has laps. */
export function clockLaps(clock: Clock): number {
  if (clock.laps === undefined) return 1;
  if (clock.mode === 'value') fail('C6', 'the clock is in value mode but has laps');
  if (!Number.isInteger(clock.laps) || clock.laps < 1) fail('C6', `the clock has laps ${String(clock.laps)}, not an integer of at least one`);
  return clock.laps;
}

/** The lap of a loop reading and the within-lap reading there (rule C6). */
export function lapOf(loopReading: number, laps: number): { lap: number; u: number } {
  const lap = Math.min(Math.floor(loopReading), laps - 1);
  return { lap, u: loopReading - lap };
}

/** Applies `before` and `after` (rule C3) to a reading. Null means the track is hidden. */
export function bound(u: number, before: 'clamp' | 'hidden' = 'clamp', after: 'clamp' | 'hidden' = 'clamp'): number | null {
  if (u < 0) return before === 'hidden' ? null : 0;
  if (u > 1) return after === 'hidden' ? null : 1;
  return u;
}

/**
 * The clock of a layer with a clock of its own (rule K4), as a clock in value mode on the layer's channel, whose loop lasts as
 * long as the scene's, so that its keys read the same timeline. It does not have laps.
 */
export function layerClock(scene: Clock, own: LayerClock): Clock {
  if (own === null || typeof own !== 'object' || typeof own.channel !== 'string')
    fail('K4', `a layer's clock is ${JSON.stringify(own)}, not {channel, range} or {channel, keys}`);
  const hasRange = own.range !== undefined;
  const hasKeys = own.keys !== undefined;
  if (hasRange === hasKeys) fail('K4', `the clock of a layer on channel ${own.channel} has ${hasRange ? 'both a range and keys' : 'neither a range nor keys'}`);
  if (hasRange && !(Array.isArray(own.range) && own.range.length === 2 && own.range.every((x) => typeof x === 'number' && Number.isFinite(x))))
    fail('K4', `the clock of a layer on channel ${own.channel} has range ${JSON.stringify(own.range)}, not two finite numbers`);
  if (hasKeys) checkKeys(own.keys, `the clock of a layer on channel ${own.channel}`);
  const clock: Clock = { mode: 'value', channels: [own.channel], steps: scene.steps, seconds: loopSeconds(scene) };
  if (hasRange) clock.range = [own.range![0], own.range![1]];
  else clock.keys = own.keys;
  return clock;
}
