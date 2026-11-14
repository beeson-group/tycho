/**
 * The timeline of section 2.11 of spec/tycho-scene.md: the time of a progress, keyframes and their eases
 * (rules `keyframes` and `ease`), the shared value of a clock with keyframes (rule `clock-keyframes`), and the window of a camera with
 * keyframes (rule `camera-keyframes`). Everything here is pure, so that the evaluator and the renderer read the same numbers.
 */
import { fail } from '../errors.js';
import type { Camera, Clock, Opacity, Size } from '../scene.js';

/** Seconds one revolution of the clock lasts at speed 1, whatever its frame count. */
export const REVOLUTION_SECONDS = 8;

export const EASES: readonly string[] = ['linear', 'smooth', 'in', 'out', 'in-out', 'hold'];

/** A keyframe as the scene gives it, `[t, v]` or `[t, v, ease]`. */
export type Keyframe = readonly unknown[];

/** The seconds that one loop of the clock lasts at speed 1: its `seconds` when given, else REVOLUTION_SECONDS for each of its revolutions (rule `revolutions`). */
export function loopSeconds(clock: Pick<Clock, 'seconds' | 'revolutions'> & Partial<Clock>): number {
  return clock.seconds ?? REVOLUTION_SECONDS * (clock.revolutions ?? 1);
}

/** The time of the timeline at progress `q`, `s = q * L` (section 2.11). */
export function timeAt(clock: Pick<Clock, 'seconds' | 'revolutions'> & Partial<Clock>, q: number): number {
  return q * loopSeconds(clock);
}

/** The ease E(x) of rule `ease`. */
export function ease(name: unknown, x: number): number {
  switch (name ?? 'linear') {
    case 'linear':
      return x;
    case 'smooth':
      return x * x * (3 - 2 * x);
    case 'in':
      return x * x * x;
    case 'out': {
      const y = 1 - x;
      return 1 - y * y * y;
    }
    case 'in-out': {
      if (x < 0.5) return 4 * x * x * x;
      const y = 2 - 2 * x;
      return 1 - (y * y * y) / 2;
    }
    case 'hold':
      return 0;
    default:
      return fail('ease', `the ease ${JSON.stringify(name)} is not one of ${EASES.join(', ')}`);
  }
}

/** Checks a list of keyframes (rules `keyframes` and `ease`), with numbers for values unless `values` says otherwise, and returns it. */
export function checkKeyframes(keys: unknown, what: string, values: (v: unknown) => boolean = (v) => typeof v === 'number' && Number.isFinite(v)): Keyframe[] {
  if (!Array.isArray(keys) || keys.length === 0) fail('keyframes', `${what} has keyframes ${JSON.stringify(keys)}, not a list of at least one keyframe`);
  let last = -Infinity;
  for (const k of keys as unknown[]) {
    if (!Array.isArray(k) || k.length < 2 || k.length > 3) fail('keyframes', `${what} has a keyframe ${JSON.stringify(k)}, not [t, v] or [t, v, ease]`);
    const t = k[0] as unknown;
    if (typeof t !== 'number' || !Number.isFinite(t)) fail('keyframes', `${what} has a keyframe at ${JSON.stringify(t)}, not a finite time`);
    if (t < last) fail('keyframes', `${what} has keyframes whose times decrease, from ${last} to ${t}`);
    last = t;
    if (!values(k[1])) fail('keyframes', `${what} has a keyframe whose value is ${JSON.stringify(k[1])}`);
    if (k.length === 3 && (typeof k[2] !== 'string' || !EASES.includes(k[2])))
      fail('ease', `${what} has a keyframe whose ease is ${JSON.stringify(k[2])}, not one of ${EASES.join(', ')}`);
  }
  return keys as Keyframe[];
}

/**
 * The segment of a list of keyframes at time `s` (rule `keyframes`): the index `i` of the last keyframe at or before `s`, and the eased
 * weight `e` toward keyframe `i + 1`, or `e = null` when `s` lies before the first keyframe (i = 0) or at or after the last.
 */
export function segmentAt(times: (i: number) => number, count: number, s: number, easeOf: (i: number) => unknown): { i: number; e: number | null } {
  let i = -1;
  // the last keyframe with t_i <= s, by bisection, since the times are nondecreasing
  let lo = 0;
  let hi = count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times(mid) <= s) {
      i = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (i < 0) return { i: 0, e: null };
  if (i === count - 1) return { i, e: null };
  const x = (s - times(i)) / (times(i + 1) - times(i));
  return { i, e: ease(easeOf(i + 1), x) };
}

/** The value of a list of keyframes at time `s` (rule `keyframes`). */
export function keyframesValue(keys: readonly Keyframe[], s: number): number {
  const { i, e } = segmentAt(
    (j) => keys[j]![0] as number,
    keys.length,
    s,
    (j) => keys[j]![2],
  );
  const v = keys[i]![1] as number;
  if (e === null) return v;
  return v + e * ((keys[i + 1]![1] as number) - v);
}

/** A number that may be keyframed, at time `s`, or `fallback` when it is absent. */
export function numberAt(value: number | { keyframes: unknown } | undefined, s: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value === 'number') return value;
  return keyframesValue(value.keyframes as Keyframe[], s);
}

/** An opacity that may be keyframed, at time `s`, clamped into [0, 1]. */
export function opacityAt(value: Opacity | undefined, s: number, fallback = 1): number {
  return Math.min(1, Math.max(0, numberAt(value, s, fallback)));
}

/** A size that may be keyframed, at time `s`, never below zero. */
export function sizeAt(value: Size | undefined, s: number, fallback: number): number {
  return Math.max(0, numberAt(value, s, fallback));
}

/** Checks a number that may be keyframed, whose values `ok` accepts, e.g. an opacity in [0, 1]. */
export function checkKeyframed(value: unknown, what: string, ok: (v: unknown) => boolean, rule = 'panel'): void {
  if (value === undefined) return;
  if (typeof value === 'number') {
    if (!ok(value)) fail(rule, `${what} is ${value}`);
    return;
  }
  if (value === null || typeof value !== 'object' || !('keyframes' in value)) fail(rule, `${what} is ${JSON.stringify(value)}, not a number or {keyframes}`);
  checkKeyframes((value as { keyframes: unknown }).keyframes, what, ok);
}

export const isOpacity = (v: unknown): boolean => typeof v === 'number' && v >= 0 && v <= 1;
/** A value of the keyframes of a split (section 2.11), the share of its first side, in [0, 1]. */
export const isShare = (v: unknown): boolean => typeof v === 'number' && v >= 0 && v <= 1;
export const isPositive = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** The shared value of a clock in epoch mode at progress `q`, by its range (rule `clock-mode`) or its keyframes (rule `clock-keyframes`). */
export function clockValue(clock: Clock, q: number): number {
  if (clock.keyframes !== undefined) {
    if (clock.range !== undefined) fail('clock-keyframes', 'the clock has both a range and keyframes');
    return keyframesValue(clock.keyframes as Keyframe[], timeAt(clock, q));
  }
  if (clock.range === undefined) fail('clock-mode', 'the clock is in epoch mode but does not have a range of two numbers or keyframes');
  const [a, b] = clock.range;
  return a + q * (b - a);
}

/** The two axes of a 2d camera's plane, as indices of x, y, and z. */
export function planeAxes(cam: { plane?: 'xy' | 'xz' | 'yz' }): [number, number] {
  return cam.plane === 'xz' ? [0, 2] : cam.plane === 'yz' ? [1, 2] : [0, 1];
}

export type CameraKeyframe = NonNullable<Extract<Camera, { kind: '2d' }>['keyframes']>[number];

/** The window of a camera at a time (rule `camera-keyframes`), with `height` null when the panel's aspect ratio gives it. */
export interface CameraWindow {
  center: [number, number];
  width: number;
  height: number | null;
}

/**
 * The window of a camera with keyframes at time `s` (rule `camera-keyframes`). `center(i)` gives the center of keyframe `i` at `s`, a follow keyframe's
 * mean of its targets plus its offset, or null when the keyframe does not have a center then.
 */
export function cameraWindow(keys: readonly CameraKeyframe[], s: number, center: (i: number) => [number, number] | null): CameraWindow | null {
  const { i, e } = segmentAt(
    (j) => keys[j]!.at,
    keys.length,
    s,
    (j) => keys[j]!.ease,
  );
  const a = keys[i]!;
  const ca = center(i);
  if (ca === null) return null;
  if (e === null) return { center: ca, width: a.width, height: a.height ?? null };
  const b = keys[i + 1]!;
  const cb = center(i + 1);
  if (cb === null) return null;
  const geo = (x: number, y: number) => Math.exp((1 - e) * Math.log(x) + e * Math.log(y));
  return {
    center: [(1 - e) * ca[0] + e * cb[0], (1 - e) * ca[1] + e * cb[1]],
    width: geo(a.width, b.width),
    height: a.height !== undefined && b.height !== undefined ? geo(a.height, b.height) : null,
  };
}

/** Checks the keyframes of a 2d camera (rule `camera-keyframes`), apart from the targets of its follow keyframes, which need the layers of the panel. */
export function checkCameraKeyframes(keys: unknown, free: boolean, what: string): void {
  if (!Array.isArray(keys) || keys.length === 0)
    fail('camera-keyframes', `${what} has keyframes ${JSON.stringify(keys)}, not a list of at least one camera keyframe`);
  let last = -Infinity;
  let heights = 0;
  for (const k of keys as CameraKeyframe[]) {
    if (k === null || typeof k !== 'object') fail('camera-keyframes', `${what} has a keyframe ${JSON.stringify(k)}, not an object`);
    if (typeof k.at !== 'number' || !Number.isFinite(k.at)) fail('camera-keyframes', `${what} has a keyframe at ${JSON.stringify(k.at)}, not a finite time`);
    if (k.at < last) fail('camera-keyframes', `${what} has keyframes whose times decrease, from ${last} to ${k.at}`);
    last = k.at;
    if (!isPositive(k.width)) fail('camera-keyframes', `${what} has a keyframe of width ${JSON.stringify(k.width)}, not a positive number`);
    if (k.height !== undefined) {
      if (!free) fail('camera-keyframes', `${what} has a keyframe with a height, which only a camera of free aspect takes`);
      if (!isPositive(k.height)) fail('camera-keyframes', `${what} has a keyframe of height ${JSON.stringify(k.height)}, not a positive number`);
      heights++;
    }
    for (const v of [k.center, k.offset]) {
      if (v !== undefined && !(Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && Number.isFinite(x))))
        fail('camera-keyframes', `${what} has a keyframe whose center or offset is ${JSON.stringify(v)}, not two finite numbers`);
    }
    if (k.follow === undefined && k.center === undefined) fail('camera-keyframes', `${what} has a keyframe with neither a center nor follow targets`);
    if (k.follow !== undefined) {
      if (!Array.isArray(k.follow) || k.follow.length === 0) fail('camera-keyframes', `${what} has a keyframe whose follow is not a list of targets`);
      for (const t of k.follow) {
        if (t === null || typeof t !== 'object' || !Number.isInteger(t.layer) || t.layer < 0 || !Number.isInteger(t.member) || t.member < 0)
          fail('camera-keyframes', `${what} has a follow target ${JSON.stringify(t)}, not {layer, member} of two nonnegative integers`);
      }
    }
    if (k.ease !== undefined) ease(k.ease, 0);
  }
  if (heights !== 0 && heights !== keys.length) fail('camera-keyframes', `${what} gives a height in some keys but not in all`);
}
