/** Polylines, trails, and layers by rules L1 to L5, with the point of rule C4 and the laps of rule C6. */
import { fail } from '../errors.js';
import { INDEX_CHANNEL, type ArrowLayer, type BodyLayer, type Clock, type LabelLayer, type OutlineLayer, type PointsLayer, type TrackLayer } from '../scene.js';
import { bound, clockLaps, lapOf, layerClock, TrackClock } from './clock.js';
import { scalarValue, type Context, type Frames } from './frames.js';
import type { PanelScope } from './resolve.js';
import { members, outlineTarget } from './resolve.js';
import type { SetData } from './sets.js';
import type {
  ArrowLayerResult,
  ArrowMemberResult,
  BodyLayerResult,
  LabelLayerResult,
  MemberResult,
  OutlineLayerResult,
  PointsLayerResult,
  TrackLayerResult,
  Vec3,
} from './types.js';

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
  /** The environment of the scene's clock, for a layer with a clock of its own (rule K4), whose driver still reads the scene's clock. */
  base?: LayerEnv;
}

/** The environment in which a layer takes its readings: the scene's, or one on the layer's own clock (rule K4). */
export function layerEnv(env: LayerEnv, layer: { clock?: TrackLayer['clock'] }): LayerEnv {
  if (layer.clock === undefined) return env;
  const base = env.base ?? env;
  const clock = layerClock(base.clock, layer.clock);
  return { ...base, clock, channel: clock.channels[0]!, base };
}

/** The driver's track, as a panel resolves it, or null when its set query does not match any set. */
export type Driver = { set: SetData; track: number } | null;

/**
 * The driver's clock and loop reading, and the point at the reading in its lap. A body layer and a layer in the driver's context lack `before` and `after`,
 * thus the reading is clamped (rules L4 and L6). A caller that keeps the driver's clock on `env.channel` passes it as `tc`, which is otherwise built here.
 */
export function driverPoint(env: LayerEnv, driver: NonNullable<Driver>, tc?: TrackClock): { tc: TrackClock; loopReading: number; at: BlendVertex } {
  // a layer clock does not move the driver, which reads the scene's clock (rule K4)
  env = env.base ?? env;
  tc ??= new TrackClock(driver.set, driver.track, env.channel);
  const laps = clockLaps(env.clock);
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

/** Checks the keys of an arrow layer that rule L7 restricts, and returns its vector channels and its scale. */
export function arrowParts(layer: ArrowLayer): { vector: string[]; scale: ArrowLayer['scale'] & {} } {
  const vector = layer.vector as unknown;
  if (!Array.isArray(vector) || vector.length < 2 || vector.length > 3 || !vector.every((c) => typeof c === 'string'))
    fail('L7', `an arrow layer's vector is ${JSON.stringify(vector)}, not two or three channel names`);
  if (vector.includes(INDEX_CHANNEL)) fail('L7', `${INDEX_CHANNEL} is not allowed in the vector of an arrow layer`);
  const scale = layer.scale ?? 1;
  if (typeof scale === 'object' && scale !== null && 'channel' in scale)
    fail('L7', 'the scale of an arrow layer takes a number or an attribute, not a channel');
  return { vector: vector as string[], scale };
}

/**
 * The base and the tip of each member's arrow at the reading (rule L7). A caller that keeps the clocks of the set's tracks on `env.channel` passes them as
 * `clocks`, which are otherwise built here.
 */
export function arrowLayer(env: LayerEnv, layer: ArrowLayer, set: SetData | null, clocks?: (t: number) => TrackClock): ArrowLayerResult {
  const { vector, scale } = arrowParts(layer);
  for (const key of ['before', 'after'] as const) {
    if (layer[key] !== undefined && layer[key] !== 'clamp' && layer[key] !== 'hidden')
      fail('C3', `an arrow layer's ${key} is ${JSON.stringify(layer[key])}, not clamp or hidden`);
  }
  if (set === null) return { kind: 'arrow', set: null, members: [] };
  for (const name of vector) if (!set.hasChannel(name)) fail('L7', `track set ${set.id} lacks channel ${JSON.stringify(name)} of an arrow layer's vector`);
  const laps = clockLaps(env.clock);
  if (laps > 1 && !set.periodic) fail('C6', `a reading is taken on track set ${set.id}, which is not periodic, and the clock has ${laps} laps`);
  const from = set.def.frame;
  const channels = vector.map((name) => set.channel(name));
  const out: ArrowMemberResult[] = [];
  for (const t of members(env.scope, layer.members, set)) {
    const tc = clocks ? clocks(t) : new TrackClock(set, t, env.channel);
    const u = bound(tc.reading(env.clock, env.q), layer.before, layer.after);
    if (u === null) {
      out.push({ index: t, base: null, tip: null });
      continue;
    }
    const s = scalarValue(scale, { set, track: t, sample: 0, shifted: false, lap: 0 });
    const first = set.start(t);
    const base = (ctx: Context): Vec3 => env.frames.transform(set.position(ctx.track, ctx.sample), from, env.display, ctx);
    // the vector is read from the stored values in every lap, since rule C6 raises only the context
    const tip = (ctx: Context): Vec3 => {
      const p = set.position(ctx.track, ctx.sample);
      for (let j = 0; j < channels.length; j++) p[j]! += s * channels[j]![first + ctx.sample]!;
      return env.frames.transform(p, from, env.display, ctx);
    };
    const at = lapOf(laps * u, laps);
    const v = point(tc, at.u, false, at.lap);
    out.push({ index: t, base: vertexPosition(v, set, t, base), tip: vertexPosition(v, set, t, tip) });
  }
  return { kind: 'arrow', set: set.id, members: out };
}

/** Checks that the view of an outline layer is declared, is not the view `host` that holds the layer, and has a plane camera (rule L8). */
export function checkOutlineView(scene: { views: Record<string, { camera?: { kind: string } } | undefined> }, host: string, layer: OutlineLayer): void {
  const view = layer.view as unknown;
  if (typeof view !== 'string' || !Object.hasOwn(scene.views, view)) fail('L8', `an outline layer names ${JSON.stringify(view)}, which is not a view`);
  if (view === host) fail('L8', `an outline layer of view ${host} names its own view`);
  if ((scene.views[view]!.camera?.kind ?? 'plane') !== 'plane') fail('L8', `an outline layer names view ${view}, whose camera is not a plane camera`);
}

/** The target panel and frame of an outline layer, and the affine map from the target frame into the display frame at the driver's reading (rule L8). */
export function outlineLayer(env: LayerEnv, layer: OutlineLayer, driver: Driver): OutlineLayerResult {
  checkOutlineView(env.scope.scene, env.scope.panel.view, layer);
  const result: OutlineLayerResult = { kind: 'outline', view: layer.view, panel: null, frame: null, origin: null, axes: null };
  const target = outlineTarget(env.scope, layer.view);
  if (target === null) return result;
  result.panel = target.panel;
  result.frame = target.frame;
  if (driver === null) return result;
  const { a, b, w } = driverContexts(driver, driverPoint(env, driver).at);
  // every edge is affine for a fixed context, and so is the blend of two, hence the images of the origin and the unit points give the map
  const image = (p: Vec3): Vec3 => {
    const pa = env.frames.transform(p, target.frame, env.display, a);
    const pb = env.frames.transform(p, target.frame, env.display, b);
    return [(1 - w) * pa[0] + w * pb[0], (1 - w) * pa[1] + w * pb[1], (1 - w) * pa[2] + w * pb[2]];
  };
  const o = image([0, 0, 0]);
  const axis = (e: Vec3): Vec3 => {
    const p = image(e);
    return [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
  };
  result.origin = o;
  result.axes = [axis([1, 0, 0]), axis([0, 1, 0]), axis([0, 0, 1])];
  return result;
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

/** How a track layer takes a sample into the display frame: in its own context, or in the driver's blended at its reading (rule L6). */
function sampleTransform(env: LayerEnv, layer: TrackLayer, set: SetData, driver: Driver): { f: (ctx: Context) => Vec3; hidden: boolean } {
  const from = set.def.frame;
  const own = (ctx: Context): Vec3 => env.frames.transform(set.position(ctx.track, ctx.sample), from, env.display, ctx);
  if ((layer.context ?? 'own') !== 'driver') return { f: own, hidden: false };
  if (driver === null) return { f: own, hidden: true };
  const { a, b, w } = driverContexts(driver, driverPoint(env, driver).at);
  return {
    hidden: false,
    f: (ctx: Context): Vec3 => {
      const p = set.position(ctx.track, ctx.sample);
      const pa = env.frames.transform(p, from, env.display, a);
      const pb = env.frames.transform(p, from, env.display, b);
      return [(1 - w) * pa[0] + w * pb[0], (1 - w) * pa[1] + w * pb[1], (1 - w) * pa[2] + w * pb[2]];
    },
  };
}

/** Fails unless track `k` lies in the set, as a literal member index must (rule V3). */
function checkMember(set: SetData, k: number, rule: string, what: string): void {
  if (!Number.isInteger(k) || k < 0 || k >= set.tracks)
    fail(rule, `${what} names member ${String(k)}, which is not a track of track set ${set.id} of ${set.tracks}`);
}

/**
 * The point at the reading of member `k` of a set, clamped to [0, 1] as for a body (rule L4), in its lap of rule C6, under the clock
 * of `env`, transformed by `f`. This is the anchor of a label at a member (rule K6) and the target of a camera key (rule K5).
 */
export function memberPoint(env: LayerEnv, set: SetData, k: number, f: (ctx: Context) => Vec3): Vec3 {
  const laps = clockLaps(env.clock);
  if (laps > 1 && !set.periodic) fail('C6', `a reading is taken on track set ${set.id}, which is not periodic, and the clock has ${laps} laps`);
  const tc = new TrackClock(set, k, env.channel);
  const at = lapOf(laps * bound(tc.reading(env.clock, env.q))!, laps);
  return vertexPosition(point(tc, at.u, false, at.lap), set, k, f);
}

/** The target of a camera key (rule K5): the point at the reading of member `k` of a track layer, in the layer's context, or null when its set query does not match any set. */
export function targetPoint(env: LayerEnv, layer: TrackLayer, set: SetData | null, k: number, driver: Driver): Vec3 | null {
  if (set === null) return null;
  checkMember(set, k, 'K5', 'a camera key');
  const lenv = layerEnv(env, layer);
  const { f, hidden } = sampleTransform(lenv, layer, set, driver);
  if (hidden) return null;
  return memberPoint(lenv, set, k, f);
}

/** The position of a label's anchor (rule K6), or null on the screen or when the anchor does not resolve. */
export function labelLayer(env: LayerEnv, layer: LabelLayer, set: SetData | null, driver: Driver): LabelLayerResult {
  const at = layer.at as unknown as Record<string, unknown>;
  if (at === null || typeof at !== 'object') fail('K6', `a label's anchor is ${JSON.stringify(at)}, not an object`);
  if ('screen' in at) return { kind: 'label', position: null };
  if ('point' in at) {
    const p = at.point as unknown;
    if (!Array.isArray(p) || p.length !== 3 || !p.every((x) => typeof x === 'number' && Number.isFinite(x)))
      fail('K6', `a label's point is ${JSON.stringify(p)}, not three finite numbers`);
    const v: Vec3 = [p[0], p[1], p[2]];
    if (at.frame === undefined) return { kind: 'label', position: v };
    if (driver === null) return { kind: 'label', position: null };
    // a point in another frame moves with the driver, as a body does (rule L4)
    const { a, b, w } = driverContexts(driver, driverPoint(env, driver).at);
    const pa = env.frames.transform(v, at.frame as string, env.display, a);
    const pb = env.frames.transform(v, at.frame as string, env.display, b);
    return { kind: 'label', position: [(1 - w) * pa[0] + w * pb[0], (1 - w) * pa[1] + w * pb[1], (1 - w) * pa[2] + w * pb[2]] };
  }
  if (!('sets' in at) || !('member' in at)) fail('K6', `a label's anchor is ${JSON.stringify(at)}, not a point, a member, or a place on the screen`);
  if (set === null) return { kind: 'label', position: null };
  const k = at.member as number;
  checkMember(set, k, 'K6', 'a label');
  const lenv = layerEnv(env, layer);
  const from = set.def.frame;
  const f = (ctx: Context): Vec3 => lenv.frames.transform(set.position(ctx.track, ctx.sample), from, lenv.display, ctx);
  return { kind: 'label', position: memberPoint(lenv, set, k, f) };
}

/** The drawn samples of each member of a points layer (rule K8). */
export function pointsLayer(env: LayerEnv, layer: PointsLayer, set: SetData | null): PointsLayerResult {
  const reveal = layer.reveal ?? 'none';
  if (reveal !== 'none' && reveal !== 'grow') fail('K8', `a points layer's reveal is ${JSON.stringify(reveal)}, not none or grow`);
  for (const key of ['before', 'after'] as const) {
    if (layer[key] !== undefined && layer[key] !== 'clamp' && layer[key] !== 'hidden')
      fail('C3', `a points layer's ${key} is ${JSON.stringify(layer[key])}, not clamp or hidden`);
  }
  if (set === null) return { kind: 'points', set: null, members: [] };
  const lenv = layerEnv(env, layer);
  const hides = lenv.clock.mode === 'value' && (layer.before === 'hidden' || layer.after === 'hidden');
  const reads = reveal === 'grow' || hides;
  const from = set.def.frame;
  const out: PointsLayerResult['members'] = [];
  for (const t of members(env.scope, layer.members, set)) {
    const m = set.count(t);
    let last = m - 1;
    if (reads) {
      const tc = new TrackClock(set, t, lenv.channel);
      const u = tc.reading(lenv.clock, lenv.q);
      if (bound(u, layer.before, layer.after) === null) last = -1;
      else if (reveal === 'grow') {
        last = -1;
        while (last + 1 < m && tc.at(last + 1) <= u) last++;
      }
    }
    const points: Vec3[] = [];
    for (let i = 0; i <= last; i++)
      points.push(lenv.frames.transform(set.position(t, i), from, lenv.display, { set, track: t, sample: i, shifted: false, lap: 0 }));
    out.push({ index: t, points });
  }
  return { kind: 'points', set: set.id, members: out };
}
