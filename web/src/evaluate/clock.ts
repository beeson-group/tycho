/** The clock, rules `sample-fraction` to `segment` and the revolutions of rule `revolutions`. */
import { fail } from '../errors.js';
import { INDEX_CHANNEL, type Clock, type LayerClock } from '../scene.js';
import type { SetData } from './sets.js';
import { checkKeyframes, clockValue, loopSeconds } from './timeline.js';

/** Progress q in [0, 1) for a frame index, taken modulo the frame count (section 2.6). */
export function progress(frameCount: number, frameIndex: number): number {
  if (!Number.isInteger(frameIndex)) fail('clock', `the frame index ${String(frameIndex)} is not an integer`);
  if (!Number.isInteger(frameCount) || frameCount < 1) fail('clock', `the clock has frame_count ${String(frameCount)}, not a count of at least one`);
  const i = ((frameIndex % frameCount) + frameCount) % frameCount;
  return i / frameCount;
}

/** The clock along one trajectory, which holds the sample readings u_i of rule `sample-fraction` and gives the reading of rule `clock-mode`. */
export class TrajectoryClock {
  readonly m: number;
  private readonly c0: number;
  private readonly c1: number;
  private readonly u: Float64Array;

  constructor(set: SetData, trajectory: number, channel: string) {
    const m = set.count(trajectory);
    this.m = m;
    this.u = new Float64Array(m);
    if (channel === INDEX_CHANNEL) {
      this.c0 = 0;
      this.c1 = m - 1;
      for (let i = 0; i < m; i++) this.u[i] = i / (m - 1);
      return;
    }
    const c = set.channel(channel, 'clock-channel-carried');
    const s = set.start(trajectory);
    this.c0 = c[s]!;
    this.c1 = c[s + m - 1]!;
    // where the reading is taken, the clock channel is checked to be finite and strictly monotone along the trajectory, with a finite span (rule `monotone-clock-channel`)
    const sign = Math.sign(c[s + 1]! - c[s]!);
    for (let i = 0; i < m; i++) {
      if (!Number.isFinite(c[s + i]!) || (i > 0 && !((c[s + i]! - c[s + i - 1]!) * sign > 0))) {
        fail(
          'monotone-clock-channel',
          `clock channel ${channel} of trajectory set ${set.id} is not both finite and strictly monotone along trajectory ${trajectory}`,
        );
      }
    }
    if (!Number.isFinite(this.c1 - this.c0))
      fail('monotone-clock-channel', `clock channel ${channel} of trajectory set ${set.id} has an infinite span along trajectory ${trajectory}`);
    for (let i = 0; i < m; i++) this.u[i] = (c[s + i]! - this.c0) / (this.c1 - this.c0);
  }

  /** The reading u_i at which sample `i` sits along the trajectory (rule `sample-fraction`). */
  at(i: number): number {
    return this.u[i]!;
  }

  /** The trajectory's reading at progress q (rule `clock-mode`), possibly outside [0, 1] in epoch mode. */
  reading(clock: Clock, q: number): number {
    if (clock.mode === 'fraction') return q;
    const v = clockValue(clock, q);
    return (v - this.c0) / (this.c1 - this.c0);
  }

  /** The segment k and weight w of the point at reading u in [0, 1] (rule `segment`). */
  locate(u: number): { k: number; w: number } {
    let lo = 0;
    let hi = this.m - 2;
    // The search finds the largest k <= m - 2 with u_k <= u, since readings increase strictly (rule `monotone-clock-channel`).
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.u[mid]! <= u) lo = mid;
      else hi = mid - 1;
    }
    const k = lo;
    return { k, w: (u - this.u[k]!) / (this.u[k + 1]! - this.u[k]!) };
  }
}

/** The number of revolutions of rule `revolutions`, 1 when absent. Only a clock in fraction mode has revolutions. */
export function clockRevolutions(clock: Clock): number {
  if (clock.revolutions === undefined) return 1;
  if (clock.mode === 'epoch') fail('revolutions', 'the clock is in epoch mode but has revolutions');
  if (!Number.isInteger(clock.revolutions) || clock.revolutions < 1)
    fail('revolutions', `the clock has revolutions ${String(clock.revolutions)}, not an integer of at least one`);
  return clock.revolutions;
}

/** The revolution of a loop reading and the within-revolution reading there (rule `revolutions`). */
export function revolutionOf(loopReading: number, revolutions: number): { revolution: number; u: number } {
  const revolution = Math.min(Math.floor(loopReading), revolutions - 1);
  return { revolution, u: loopReading - revolution };
}

/** Applies `before` and `after` (rule `before-after`) to a reading. Null means the trajectory is hidden. */
export function bound(u: number, before: 'clamp' | 'hidden' = 'clamp', after: 'clamp' | 'hidden' = 'clamp'): number | null {
  if (u < 0) return before === 'hidden' ? null : 0;
  if (u > 1) return after === 'hidden' ? null : 1;
  return u;
}

/** The clock built last by `layerClock` for each clock of a layer. */
const layerClocks = new WeakMap<object, Clock>();

/**
 * The clock of a layer with a clock of its own (rule `layer-clock`), as a clock in epoch mode on the layer's channel, whose loop lasts as
 * long as the scene's, so that its keyframes read the same timeline. It does not have revolutions. The clock is checked and built once
 * and returned again while the scene's clock keeps its frame count and its loop length, hence a caller must not change it.
 */
export function layerClock(scene: Clock, own: LayerClock): Clock {
  const built = own !== null && typeof own === 'object' ? layerClocks.get(own) : undefined;
  if (built !== undefined && built.frame_count === scene.frame_count && built.seconds === loopSeconds(scene)) return built;
  if (own === null || typeof own !== 'object' || typeof own.channel !== 'string')
    fail('layer-clock', `a layer's clock is ${JSON.stringify(own)}, not {channel, range} or {channel, keyframes}`);
  const hasRange = own.range !== undefined;
  const hasKeyframes = own.keyframes !== undefined;
  if (hasRange === hasKeyframes)
    fail('layer-clock', `the clock of a layer on channel ${own.channel} has ${hasRange ? 'both a range and keyframes' : 'neither a range nor keyframes'}`);
  if (hasRange && !(Array.isArray(own.range) && own.range.length === 2 && own.range.every((x) => typeof x === 'number' && Number.isFinite(x))))
    fail('layer-clock', `the clock of a layer on channel ${own.channel} has range ${JSON.stringify(own.range)}, not two finite numbers`);
  if (hasKeyframes) checkKeyframes(own.keyframes, `the clock of a layer on channel ${own.channel}`);
  const clock: Clock = { mode: 'epoch', channels: [own.channel], frame_count: scene.frame_count, seconds: loopSeconds(scene) };
  if (hasRange) clock.range = [own.range![0], own.range![1]];
  else clock.keyframes = own.keyframes;
  layerClocks.set(own, clock);
  return clock;
}
