/** Polylines, trails, and layers by rules L1 to L5, with the point of rule C4 and the laps of rule C6. */
import { fail } from '../errors.js';
import type { BodyLayer, Clock, TrackLayer } from '../scene.js';
import { bound, clockLaps, lapOf, TrackClock } from './clock.js';
import type { Context, Frames } from './frames.js';
import type { PanelScope } from './resolve.js';
import { members } from './resolve.js';
import type { SetData } from './sets.js';
import type { BodyLayerResult, MemberResult, TrackLayerResult, Vec3 } from './types.js';

/**
 * A vertex is a stored sample or a point blended between samples k and k + 1, in the context of
 * its lap of rule C6 (0 when absent). `shifted` puts it one lap lower (rule L2).
 */
export type Vertex = { sample: number; shifted: boolean; lap?: number } | BlendVertex;
export type BlendVertex = { k: number; w: number; shifted: boolean; lap?: number };

export function point(tc: TrackClock, u: number, shifted: boolean, lap = 0): BlendVertex {
  const { k, w } = tc.locate(u);
  return { k, w, shifted, lap };
}

/** The polyline of a track between readings `ua` and `ub` within one lap (rule L1). */
export function polyline(tc: TrackClock, ua: number, ub: number, lap = 0): Vertex[] {
  if (ua === ub) return [point(tc, ua, false, lap)];
  const out: Vertex[] = [point(tc, ua, false, lap)];
  for (let i = 0; i < tc.m; i++) {
    const ui = tc.at(i);
    if (ua < ui && ui < ub) out.push({ sample: i, shifted: false, lap });
  }
  out.push(point(tc, ub, false, lap));
  return out;
}

/** The polyline between loop readings `ua <= ub` across laps (rule C6). Each joint keeps the first sample of the higher lap. */
export function loopPolyline(tc: TrackClock, ua: number, ub: number, laps: number): Vertex[] {
  const a = lapOf(ua, laps);
  const b = lapOf(ub, laps);
  if (a.lap === b.lap) return polyline(tc, a.u, b.u, a.lap);
  const out = polyline(tc, a.u, 1, a.lap).slice(0, -1);
  for (let j = a.lap + 1; j < b.lap; j++) out.push(...polyline(tc, 0, 1, j).slice(0, -1));
  out.push(...polyline(tc, 0, b.u, b.lap));
  return out;
}

/** Every sample of every lap, joined (rule C6). A track set that is not periodic has one lap. */
export function whole(m: number, laps: number, periodic: boolean): Vertex[] {
  const n = periodic ? laps : 1;
  const out: Vertex[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < (j === n - 1 ? m : m - 1); i++) out.push({ sample: i, shifted: false, lap: j });
  return out;
}

/** The trail from loop reading `loopReading - laps * fraction` to `loopReading`, cut at 0 unless the track set is periodic (rules L2 and C6). */
export function trail(tc: TrackClock, loopReading: number, laps: number, fraction: number, periodic: boolean): Vertex[] {
  let tail = loopReading - laps * fraction;
  if (tail < 0 && !periodic) tail = 0;
  return loopPolyline(tc, tail, loopReading, laps);
}

/** Whether a track layer gives a head (rule L3), i.e. whether its `head` is `true` or an object. */
export function hasHead(layer: TrackLayer): boolean {
  return layer.head === true || (typeof layer.head === 'object' && layer.head !== null);
}

/** Evaluates a vertex with `f`, which gives the position of a sample in a context (rule C4). */
export function vertexPosition(v: Vertex, set: SetData, track: number, f: (ctx: Context) => Vec3): Vec3 {
  const lap = v.lap ?? 0;
  if ('sample' in v) return f({ set, track, sample: v.sample, shifted: v.shifted, lap });
  const a = f({ set, track, sample: v.k, shifted: v.shifted, lap });
  const b = f({ set, track, sample: v.k + 1, shifted: v.shifted, lap });
  const w = v.w;
  return [(1 - w) * a[0] + w * b[0], (1 - w) * a[1] + w * b[1], (1 - w) * a[2] + w * b[2]];
}

export interface LayerEnv {
  scope: PanelScope;
  frames: Frames;
  clock: Clock;
  channel: string;
  q: number;
  display: string;
}

/** The driver's track, as a panel resolves it, or null when its set query does not match any set. */
export type Driver = { set: SetData; track: number } | null;

/** The driver's clock and loop reading, and the point at the reading in its lap. A body layer and a layer in the driver's context lack `before` and `after`, thus the reading is clamped (rules L4 and L6). */
export function driverPoint(env: LayerEnv, driver: NonNullable<Driver>): { tc: TrackClock; loopReading: number; at: BlendVertex } {
  const laps = clockLaps(env.clock);
  const tc = new TrackClock(driver.set, driver.track, env.channel);
  const loopReading = laps * bound(tc.reading(env.clock, env.q))!;
  const lap = lapOf(loopReading, laps);
  return { tc, loopReading, at: point(tc, lap.u, false, lap.lap) };
}

/** The contexts of the driver's samples k and k + 1 at its point `at`, and the weight that blends them (rules L4 and L6). */
export function driverContexts(driver: NonNullable<Driver>, at: BlendVertex): { a: Context; b: Context; w: number } {
  const lap = at.lap ?? 0;
  const { set, track } = driver;
  return { a: { set, track, sample: at.k, shifted: false, lap }, b: { set, track, sample: at.k + 1, shifted: false, lap }, w: at.w };
}

export function trackLayer(env: LayerEnv, layer: TrackLayer, set: SetData | null, driver: Driver = null): TrackLayerResult {
  if (set === null) return { kind: 'track', set: null, members: [] };
  const reveal = layer.reveal ?? 'none';
  if (!['none', 'grow', 'trail'].includes(reveal)) fail('2.7', `a track layer's reveal is ${JSON.stringify(reveal)}, not none, grow, or trail`);
  for (const key of ['before', 'after'] as const) {
    if (layer[key] !== undefined && layer[key] !== 'clamp' && layer[key] !== 'hidden')
      fail('C3', `a track layer's ${key} is ${JSON.stringify(layer[key])}, not clamp or hidden`);
  }
  if (reveal === 'trail') layerTrailFraction(layer);
  const context = layer.context ?? 'own';
  if (context !== 'own' && context !== 'driver') fail('L6', `a track layer's context is ${JSON.stringify(context)}, not own or driver`);
  const laps = clockLaps(env.clock);
  const from = set.def.frame;
  let f = (ctx: Context): Vec3 => env.frames.transform(set.position(ctx.track, ctx.sample), from, env.display, ctx);
  // in the driver's context every sample is transformed in the two contexts around the driver's reading, then blended (rule L6)
  const blended = context === 'driver' && driver !== null ? driverContexts(driver, driverPoint(env, driver).at) : null;
  if (blended !== null) {
    const { a, b, w } = blended;
    f = (ctx: Context): Vec3 => {
      const p = set.position(ctx.track, ctx.sample);
      const pa = env.frames.transform(p, from, env.display, a);
      const pb = env.frames.transform(p, from, env.display, b);
      return [(1 - w) * pa[0] + w * pb[0], (1 - w) * pa[1] + w * pb[1], (1 - w) * pa[2] + w * pb[2]];
    };
  }
  const head = hasHead(layer);
  const needsReading = reveal !== 'none' || head || (env.clock.mode === 'value' && (layer.before === 'hidden' || layer.after === 'hidden'));
  if (needsReading && laps > 1 && !set.periodic) fail('C6', `a reading is taken on track set ${set.id}, which is not periodic, and the clock has ${laps} laps`);
  const out: MemberResult[] = [];
  for (const t of members(env.scope, layer.members, set)) {
    const vertices: Vertex[] = [];
    let u: number | null = null;
    let tc: TrackClock | null = null;
    if (needsReading) {
      tc = new TrackClock(set, t, env.channel);
      u = bound(tc.reading(env.clock, env.q), layer.before, layer.after);
    }
    const hidden = (needsReading && u === null) || (context === 'driver' && blended === null);
    const loopReading = laps * (u ?? 0);
    if (!hidden) {
      if (reveal === 'none') vertices.push(...whole(set.count(t), laps, set.periodic));
      else if (reveal === 'grow') vertices.push(...loopPolyline(tc!, 0, loopReading, laps));
      else vertices.push(...trail(tc!, loopReading, laps, layerTrailFraction(layer), set.periodic));
    }
    const m: MemberResult = { index: t, line: vertices.map((v) => vertexPosition(v, set, t, f)) };
    if (head) {
      const at = lapOf(loopReading, laps);
      m.head = hidden ? null : vertexPosition(point(tc!, at.u, false, at.lap), set, t, f);
    }
    out.push(m);
  }
  return { kind: 'track', set: set.id, members: out };
}

function layerTrailFraction(layer: TrackLayer | BodyLayer): number {
  if (layer.trail === undefined) fail('2.7', 'a layer draws a trail but lacks a trail fraction');
  const f = layer.trail.fraction;
  if (typeof f !== 'number' || !(f > 0 && f <= 1)) fail('2.7', `the trail fraction ${String(f)} is not in (0, 1]`);
  return f;
}

/** The position and trail of a body layer (rule L4). The driver's reading is clamped to [0, 1], since a body layer does not have `before` or `after`. */
export function bodyLayer(env: LayerEnv, layer: BodyLayer, driver: Driver): BodyLayerResult {
  const result: BodyLayerResult = { kind: 'body', body: layer.body, position: null };
  if (driver === null) {
    if (layer.trail !== undefined) result.trail = [];
    return result;
  }
  const { set, track } = driver;
  const laps = clockLaps(env.clock);
  const { tc, loopReading, at } = driverPoint(env, driver);
  const f = (ctx: Context): Vec3 => env.frames.bodyPosition(layer.body, env.display, ctx);
  result.position = vertexPosition(at, set, track, f);
  if (layer.trail !== undefined) {
    result.trail = trail(tc, loopReading, laps, layerTrailFraction(layer), set.periodic).map((v) => vertexPosition(v, set, track, f));
  }
  return result;
}
