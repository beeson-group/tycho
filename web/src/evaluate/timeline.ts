/**
 * The timeline of section 2.11 of spec/tycho-scene.md: the time of a progress, tweens and their eases
 * (rules K1 and K2), the shared value of a clock with keys (rule K3), and the window of a camera with
 * keys (rule K5). Everything here is pure, so that the evaluator and the renderer read the same numbers.
 */
import { fail } from '../errors.js';
import type { Camera, Clock, Opacity, Size } from '../scene.js';

/** Seconds one lap of the clock lasts at speed 1, whatever its steps. */
export const LAP_SECONDS = 8;

export const EASES: readonly string[] = ['linear', 'smooth', 'in', 'out', 'in-out', 'hold'];

/** A key of a tween as the scene gives it, `[t, v]` or `[t, v, ease]`. */
export type Key = readonly unknown[];

/** The seconds that one loop of the clock lasts at speed 1: its `seconds` when given, else LAP_SECONDS for each of its laps (rule C6). */
export function loopSeconds(clock: Pick<Clock, 'seconds' | 'laps'> & Partial<Clock>): number {
  return clock.seconds ?? LAP_SECONDS * (clock.laps ?? 1);
}

/** The time of the timeline at progress `q`, `s = q * L` (section 2.11). */
export function timeAt(clock: Pick<Clock, 'seconds' | 'laps'> & Partial<Clock>, q: number): number {
  return q * loopSeconds(clock);
}

/** The ease E(x) of rule K2. */
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
      return fail('K2', `the ease ${JSON.stringify(name)} is not one of ${EASES.join(', ')}`);
  }
}

/** Checks a list of keys (rules K1 and K2), with numbers for values unless `values` says otherwise, and returns it. */
export function checkKeys(keys: unknown, what: string, values: (v: unknown) => boolean = (v) => typeof v === 'number' && Number.isFinite(v)): Key[] {
  if (!Array.isArray(keys) || keys.length === 0) fail('K1', `${what} has keys ${JSON.stringify(keys)}, not a list of at least one key`);
  let last = -Infinity;
  for (const k of keys as unknown[]) {
    if (!Array.isArray(k) || k.length < 2 || k.length > 3) fail('K1', `${what} has a key ${JSON.stringify(k)}, not [t, v] or [t, v, ease]`);
    const t = k[0] as unknown;
    if (typeof t !== 'number' || !Number.isFinite(t)) fail('K1', `${what} has a key at ${JSON.stringify(t)}, not a finite time`);
    if (t < last) fail('K1', `${what} has keys whose times decrease, from ${last} to ${t}`);
    last = t;
    if (!values(k[1])) fail('K1', `${what} has a key whose value is ${JSON.stringify(k[1])}`);
    if (k.length === 3 && (typeof k[2] !== 'string' || !EASES.includes(k[2])))
      fail('K2', `${what} has a key whose ease is ${JSON.stringify(k[2])}, not one of ${EASES.join(', ')}`);
  }
  return keys as Key[];
}

/**
 * The segment of a list of keys at time `s` (rule K1): the index `i` of the last key at or before `s`, and the eased
 * weight `e` toward key `i + 1`, or `e = null` when `s` lies before the first key (i = 0) or at or after the last.
 */
export function segmentAt(times: (i: number) => number, count: number, s: number, easeOf: (i: number) => unknown): { i: number; e: number | null } {
  let i = -1;
  // the last key with t_i <= s, by bisection, since the times are nondecreasing
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

/** The value of a tween's keys at time `s` (rule K1). */
export function tweenValue(keys: readonly Key[], s: number): number {
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

/** A number that may be a tween, at time `s`, or `fallback` when it is absent. */
export function numberAt(value: number | { keys: unknown } | undefined, s: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value === 'number') return value;
  return tweenValue(value.keys as Key[], s);
}

/** An opacity that may be a tween, at time `s`, clamped into [0, 1]. */
export function opacityAt(value: Opacity | undefined, s: number, fallback = 1): number {
  return Math.min(1, Math.max(0, numberAt(value, s, fallback)));
}

/** A size that may be a tween, at time `s`, never below zero. */
export function sizeAt(value: Size | undefined, s: number, fallback: number): number {
  return Math.max(0, numberAt(value, s, fallback));
}

/** Checks a number that may be a tween, whose values `ok` accepts, e.g. an opacity in [0, 1]. */
export function checkTweened(value: unknown, what: string, ok: (v: unknown) => boolean, rule = '2.7'): void {
  if (value === undefined) return;
  if (typeof value === 'number') {
    if (!ok(value)) fail(rule, `${what} is ${value}`);
    return;
  }
  if (value === null || typeof value !== 'object' || !('keys' in value)) fail(rule, `${what} is ${JSON.stringify(value)}, not a number or a tween`);
  checkKeys((value as { keys: unknown }).keys, what, ok);
}

export const isOpacity = (v: unknown): boolean => typeof v === 'number' && v >= 0 && v <= 1;
/** A value of the keys of a split (section 2.11), the share of its first side, in [0, 1]. */
export const isShare = (v: unknown): boolean => typeof v === 'number' && v >= 0 && v <= 1;
export const isPositive = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** The shared value of a clock in value mode at progress `q`, by its range (rule C2) or its keys (rule K3). */
export function clockValue(clock: Clock, q: number): number {
  if (clock.keys !== undefined) {
    if (clock.range !== undefined) fail('K3', 'the clock has both a range and keys');
    return tweenValue(clock.keys as Key[], timeAt(clock, q));
  }
  if (clock.range === undefined) fail('C2', 'the clock is in value mode but does not have a range of two numbers or keys');
  const [a, b] = clock.range;
  return a + q * (b - a);
}

/** The two axes of a plane camera's plane, as indices of x, y, and z. */
export function planeAxes(cam: { plane?: 'xy' | 'xz' | 'yz' }): [number, number] {
  return cam.plane === 'xz' ? [0, 2] : cam.plane === 'yz' ? [1, 2] : [0, 1];
}

export type CameraKey = NonNullable<Extract<Camera, { kind: 'plane' }>['keys']>[number];

/** The window of a camera at a time (rule K5), with `height` null when the panel's aspect ratio gives it. */
export interface CameraWindow {
  center: [number, number];
  width: number;
  height: number | null;
}

/**
 * The window of a camera with keys at time `s` (rule K5). `center(i)` gives the center of key `i` at `s`, a follow key's
 * mean of its targets plus its offset, or null when the key does not have a center then.
 */
export function cameraWindow(keys: readonly CameraKey[], s: number, center: (i: number) => [number, number] | null): CameraWindow | null {
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

/** Checks the keys of a plane camera (rule K5), apart from the targets of its follow keys, which need the view's layers. */
export function checkCameraKeys(keys: unknown, free: boolean, what: string): void {
  if (!Array.isArray(keys) || keys.length === 0) fail('K5', `${what} has keys ${JSON.stringify(keys)}, not a list of at least one camera key`);
  let last = -Infinity;
  let heights = 0;
  for (const k of keys as CameraKey[]) {
    if (k === null || typeof k !== 'object') fail('K5', `${what} has a key ${JSON.stringify(k)}, not an object`);
    if (typeof k.at !== 'number' || !Number.isFinite(k.at)) fail('K5', `${what} has a key at ${JSON.stringify(k.at)}, not a finite time`);
    if (k.at < last) fail('K5', `${what} has keys whose times decrease, from ${last} to ${k.at}`);
    last = k.at;
    if (!isPositive(k.width)) fail('K5', `${what} has a key of width ${JSON.stringify(k.width)}, not a positive number`);
    if (k.height !== undefined) {
      if (!free) fail('K5', `${what} has a key with a height, which only a camera of free aspect takes`);
      if (!isPositive(k.height)) fail('K5', `${what} has a key of height ${JSON.stringify(k.height)}, not a positive number`);
      heights++;
    }
    for (const v of [k.center, k.offset]) {
      if (v !== undefined && !(Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && Number.isFinite(x))))
        fail('K5', `${what} has a key whose center or offset is ${JSON.stringify(v)}, not two finite numbers`);
    }
    if (k.follow === undefined && k.center === undefined) fail('K5', `${what} has a key with neither a center nor follow targets`);
    if (k.follow !== undefined) {
      if (!Array.isArray(k.follow) || k.follow.length === 0) fail('K5', `${what} has a key whose follow is not a list of targets`);
      for (const t of k.follow) {
        if (t === null || typeof t !== 'object' || !Number.isInteger(t.layer) || t.layer < 0 || !Number.isInteger(t.member) || t.member < 0)
          fail('K5', `${what} has a follow target ${JSON.stringify(t)}, not {layer, member} of two nonnegative integers`);
      }
    }
    if (k.ease !== undefined) ease(k.ease, 0);
  }
  if (heights !== 0 && heights !== keys.length) fail('K5', `${what} gives a height in some keys but not in all`);
}
