/** Polylines, trails, and layers by rules `polyline` to `visible`, with the point of rule `segment` and the revolutions of rule `revolutions`. */
import { fail } from '../errors.js';
import {
  INDEX_CHANNEL,
  type ArrowLayer,
  type BodyLayer,
  type Clock,
  type LabelLayer,
  type InsetBoxLayer,
  type PointsLayer,
  type TrajectoriesLayer,
} from '../scene.js';
import { bound, clockRevolutions, revolutionOf, layerClock, TrajectoryClock } from './clock.js';
import { scalarValue, type Context, type Frames } from './frames.js';
import type { PanelScope } from './resolve.js';
import { members, insetBoxTarget } from './resolve.js';
import type { SetData } from './sets.js';
import type {
  ArrowLayerResult,
  ArrowMemberResult,
  BodyLayerResult,
  LabelLayerResult,
  MemberResult,
  InsetBoxLayerResult,
  PointsLayerResult,
  TrajectoriesLayerResult,
  Vec3,
} from './types.js';

/**
 * A vertex is a stored sample or a point blended between samples k and k + 1, in the context of
 * its revolution of rule `revolutions` (0 when absent). `shifted` puts it one revolution lower (rule `trail-wrap`).
 */
export type Vertex = { sample: number; shifted: boolean; revolution?: number } | BlendVertex;
export type BlendVertex = { k: number; w: number; shifted: boolean; revolution?: number };

export function point(tc: TrajectoryClock, u: number, shifted: boolean, revolution = 0): BlendVertex {
  const { k, w } = tc.locate(u);
  return { k, w, shifted, revolution };
}

/** The polyline of a trajectory between readings `ua` and `ub` within one revolution (rule `polyline`). */
export function polyline(tc: TrajectoryClock, ua: number, ub: number, revolution = 0): Vertex[] {
  if (ua === ub) return [point(tc, ua, false, revolution)];
  const out: Vertex[] = [point(tc, ua, false, revolution)];
  for (let i = 0; i < tc.m; i++) {
    const ui = tc.at(i);
    if (ua < ui && ui < ub) out.push({ sample: i, shifted: false, revolution });
  }
  out.push(point(tc, ub, false, revolution));
  return out;
}

/** The polyline between loop readings `ua <= ub` across revolutions (rule `revolutions`). Each joint keeps the first sample of the higher revolution. */
export function loopPolyline(tc: TrajectoryClock, ua: number, ub: number, revolutions: number): Vertex[] {
  const a = revolutionOf(ua, revolutions);
  const b = revolutionOf(ub, revolutions);
  if (a.revolution === b.revolution) return polyline(tc, a.u, b.u, a.revolution);
  const out = polyline(tc, a.u, 1, a.revolution).slice(0, -1);
  for (let j = a.revolution + 1; j < b.revolution; j++) out.push(...polyline(tc, 0, 1, j).slice(0, -1));
  out.push(...polyline(tc, 0, b.u, b.revolution));
  return out;
}

/** Every sample of every revolution, joined (rule `revolutions`). A trajectory set that is not periodic has one revolution. */
export function whole(m: number, revolutions: number, periodic: boolean): Vertex[] {
  const n = periodic ? revolutions : 1;
  const out: Vertex[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < (j === n - 1 ? m : m - 1); i++) out.push({ sample: i, shifted: false, revolution: j });
  return out;
}

/** The trail from loop reading `loopReading - revolutions * fraction` to `loopReading`, cut at 0 unless the trajectory set is periodic (rules `trail-wrap` and `revolutions`). */
export function trail(tc: TrajectoryClock, loopReading: number, revolutions: number, fraction: number, periodic: boolean): Vertex[] {
  let tail = loopReading - revolutions * fraction;
  if (tail < 0 && !periodic) tail = 0;
  return loopPolyline(tc, tail, loopReading, revolutions);
}

/** Whether a trajectories layer gives a head (rule `head`), i.e. whether its `head` is `true` or an object. */
export function hasHead(layer: TrajectoriesLayer): boolean {
  return layer.head === true || (typeof layer.head === 'object' && layer.head !== null);
}

/** Evaluates a vertex with `f`, which gives the position of a sample in a context (rule `segment`). */
export function vertexPosition(v: Vertex, set: SetData, trajectory: number, f: (ctx: Context) => Vec3): Vec3 {
  const revolution = v.revolution ?? 0;
  if ('sample' in v) return f({ set, trajectory, sample: v.sample, shifted: v.shifted, revolution });
  const a = f({ set, trajectory, sample: v.k, shifted: v.shifted, revolution });
  const b = f({ set, trajectory, sample: v.k + 1, shifted: v.shifted, revolution });
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
  /** The environment of the scene's clock, for a layer with a clock of its own (rule `layer-clock`), whose reference still reads the scene's clock. */
  base?: LayerEnv;
}

/** The environment in which a layer takes its readings: the scene's, or one on the layer's own clock (rule `layer-clock`). */
export function layerEnv(env: LayerEnv, layer: { clock?: TrajectoriesLayer['clock'] }): LayerEnv {
  if (layer.clock === undefined) return env;
  const base = env.base ?? env;
  const clock = layerClock(base.clock, layer.clock);
  return { ...base, clock, channel: clock.channels[0]!, base };
}

/** The reference's trajectory, as a panel resolves it, or null when its set query does not match any set. */
export type Reference = { set: SetData; trajectory: number } | null;

/**
 * The reference's clock and loop reading, and the point at the reading in its revolution. A body layer and a layer that reads from the reference lack `before` and `after`,
 * thus the reading is clamped (rules `body-layer` and `read-from`). A caller that keeps the reference trajectory's clock on `env.channel` passes it as `tc`, which is otherwise built here.
 */
export function referencePoint(
  env: LayerEnv,
  reference: NonNullable<Reference>,
  tc?: TrajectoryClock,
): { tc: TrajectoryClock; loopReading: number; at: BlendVertex } {
  // a layer clock does not move the reference, which reads the scene's clock (rule `layer-clock`)
  env = env.base ?? env;
  tc ??= new TrajectoryClock(reference.set, reference.trajectory, env.channel);
  const revolutions = clockRevolutions(env.clock);
  const loopReading = revolutions * bound(tc.reading(env.clock, env.q))!;
  const revolution = revolutionOf(loopReading, revolutions);
  return { tc, loopReading, at: point(tc, revolution.u, false, revolution.revolution) };
}

/** The contexts of the reference trajectory's samples k and k + 1 at its point `at`, and the weight that blends them (rules `body-layer` and `read-from`). */
export function referenceContexts(reference: NonNullable<Reference>, at: BlendVertex): { a: Context; b: Context; w: number } {
  const revolution = at.revolution ?? 0;
  const { set, trajectory } = reference;
  return { a: { set, trajectory, sample: at.k, shifted: false, revolution }, b: { set, trajectory, sample: at.k + 1, shifted: false, revolution }, w: at.w };
}

export function trajectoriesLayer(env: LayerEnv, layer: TrajectoriesLayer, set: SetData | null, reference: Reference = null): TrajectoriesLayerResult {
  if (set === null) return { kind: 'trajectories', set: null, members: [] };
  const reveal = layer.reveal ?? 'none';
  if (!['none', 'grow', 'trail'].includes(reveal)) fail('panel', `a trajectories layer's reveal is ${JSON.stringify(reveal)}, not none, grow, or trail`);
  for (const key of ['before', 'after'] as const) {
    if (layer[key] !== undefined && layer[key] !== 'clamp' && layer[key] !== 'hidden')
      fail('before-after', `a trajectories layer's ${key} is ${JSON.stringify(layer[key])}, not clamp or hidden`);
  }
  if (reveal === 'trail') layerTrailFraction(layer);
  const context = layer.read_from ?? 'own';
  if (context !== 'own' && context !== 'reference') fail('read-from', `a trajectories layer's read_from is ${JSON.stringify(context)}, not own or reference`);
  const revolutions = clockRevolutions(env.clock);
  const from = set.def.frame;
  let f = (ctx: Context): Vec3 => env.frames.transform(set.position(ctx.trajectory, ctx.sample), from, env.display, ctx);
  // in a layer that reads from the reference, every sample is transformed in the two contexts around the reference trajectory's reading, then blended (rule `read-from`)
  const blended = context === 'reference' && reference !== null ? referenceContexts(reference, referencePoint(env, reference).at) : null;
  if (blended !== null) {
    const { a, b, w } = blended;
    f = (ctx: Context): Vec3 => {
      const p = set.position(ctx.trajectory, ctx.sample);
      const pa = env.frames.transform(p, from, env.display, a);
      const pb = env.frames.transform(p, from, env.display, b);
      return [(1 - w) * pa[0] + w * pb[0], (1 - w) * pa[1] + w * pb[1], (1 - w) * pa[2] + w * pb[2]];
    };
  }
  const head = hasHead(layer);
  const needsReading = reveal !== 'none' || head || (env.clock.mode === 'epoch' && (layer.before === 'hidden' || layer.after === 'hidden'));
  if (needsReading && revolutions > 1 && !set.periodic)
    fail('revolutions', `a reading is taken on trajectory set ${set.id}, which is not periodic, and the clock has ${revolutions} revolutions`);
  const out: MemberResult[] = [];
  for (const t of members(env.scope, layer.members, set)) {
    const vertices: Vertex[] = [];
    let u: number | null = null;
    let tc: TrajectoryClock | null = null;
    if (needsReading) {
      tc = new TrajectoryClock(set, t, env.channel);
      u = bound(tc.reading(env.clock, env.q), layer.before, layer.after);
    }
    const hidden = (needsReading && u === null) || (context === 'reference' && blended === null);
    const loopReading = revolutions * (u ?? 0);
    if (!hidden) {
      if (reveal === 'none') vertices.push(...whole(set.count(t), revolutions, set.periodic));
      else if (reveal === 'grow') vertices.push(...loopPolyline(tc!, 0, loopReading, revolutions));
      else vertices.push(...trail(tc!, loopReading, revolutions, layerTrailFraction(layer), set.periodic));
    }
    const m: MemberResult = { index: t, line: vertices.map((v) => vertexPosition(v, set, t, f)) };
    if (head) {
      const at = revolutionOf(loopReading, revolutions);
      m.head = hidden ? null : vertexPosition(point(tc!, at.u, false, at.revolution), set, t, f);
    }
    out.push(m);
  }
  return { kind: 'trajectories', set: set.id, members: out };
}

/** Checks the keys of an arrow layer that rule `arrow` restricts, and returns its vector channels and its scale. */
export function arrowParts(layer: ArrowLayer): { vector: string[]; scale: ArrowLayer['scale'] & {} } {
  const vector = layer.vector as unknown;
  if (!Array.isArray(vector) || vector.length < 2 || vector.length > 3 || !vector.every((c) => typeof c === 'string'))
    fail('arrow', `an arrow layer's vector is ${JSON.stringify(vector)}, not two or three channel names`);
  if (vector.includes(INDEX_CHANNEL)) fail('arrow', `${INDEX_CHANNEL} is not allowed in the vector of an arrow layer`);
  const scale = layer.scale ?? 1;
  if (typeof scale === 'object' && scale !== null && 'channel' in scale)
    fail('arrow', 'the scale of an arrow layer takes a number or an attribute, not a channel');
  return { vector: vector as string[], scale };
}

/**
 * The base and the tip of each member's arrow at the reading (rule `arrow`). A caller that keeps the clocks of the set's trajectories on `env.channel` passes them as
 * `clocks`, which are otherwise built here.
 */
export function arrowLayer(env: LayerEnv, layer: ArrowLayer, set: SetData | null, clocks?: (t: number) => TrajectoryClock): ArrowLayerResult {
  const { vector, scale } = arrowParts(layer);
  for (const key of ['before', 'after'] as const) {
    if (layer[key] !== undefined && layer[key] !== 'clamp' && layer[key] !== 'hidden')
      fail('before-after', `an arrow layer's ${key} is ${JSON.stringify(layer[key])}, not clamp or hidden`);
  }
  if (set === null) return { kind: 'arrow', set: null, members: [] };
  for (const name of vector)
    if (!set.hasChannel(name)) fail('arrow', `trajectory set ${set.id} lacks channel ${JSON.stringify(name)} of an arrow layer's vector`);
  const revolutions = clockRevolutions(env.clock);
  if (revolutions > 1 && !set.periodic)
    fail('revolutions', `a reading is taken on trajectory set ${set.id}, which is not periodic, and the clock has ${revolutions} revolutions`);
  const from = set.def.frame;
  const channels = vector.map((name) => set.channel(name));
  const out: ArrowMemberResult[] = [];
  for (const t of members(env.scope, layer.members, set)) {
    const tc = clocks ? clocks(t) : new TrajectoryClock(set, t, env.channel);
    const u = bound(tc.reading(env.clock, env.q), layer.before, layer.after);
    if (u === null) {
      out.push({ index: t, base: null, tip: null });
      continue;
    }
    const s = scalarValue(scale, { set, trajectory: t, sample: 0, shifted: false, revolution: 0 });
    const first = set.start(t);
    const base = (ctx: Context): Vec3 => env.frames.transform(set.position(ctx.trajectory, ctx.sample), from, env.display, ctx);
    // the vector is read from the stored values in every revolution, since rule `revolutions` raises only the context
    const tip = (ctx: Context): Vec3 => {
      const p = set.position(ctx.trajectory, ctx.sample);
      for (let j = 0; j < channels.length; j++) p[j]! += s * channels[j]![first + ctx.sample]!;
      return env.frames.transform(p, from, env.display, ctx);
    };
    const at = revolutionOf(revolutions * u, revolutions);
    const v = point(tc, at.u, false, at.revolution);
    out.push({ index: t, base: vertexPosition(v, set, t, base), tip: vertexPosition(v, set, t, tip) });
  }
  return { kind: 'arrow', set: set.id, members: out };
}

/**
 * Checks that the panel of an inset_box layer is declared, is not the declared panel `host` that holds the layer, and has a 2d camera
 * (rule `inset-box`).
 */
export function checkInsetBoxPanel(scene: { panels: Record<string, { camera?: { kind: string } } | undefined> }, host: string, layer: InsetBoxLayer): void {
  const panel = layer.panel as unknown;
  if (typeof panel !== 'string' || !Object.hasOwn(scene.panels, panel))
    fail('inset-box', `an inset_box layer names ${JSON.stringify(panel)}, which is not a declared panel`);
  if (panel === host) fail('inset-box', `an inset_box layer of panel ${host} names its own panel`);
  if ((scene.panels[panel]!.camera?.kind ?? '2d') !== '2d') fail('inset-box', `an inset_box layer names panel ${panel}, whose camera is not a 2d camera`);
}

/**
 * The target panel and frame of an inset_box layer, and the affine map from the target frame into the display frame at the reading of
 * the reference trajectory (rule `inset-box`).
 */
export function insetBoxLayer(env: LayerEnv, layer: InsetBoxLayer, reference: Reference): InsetBoxLayerResult {
  checkInsetBoxPanel(env.scope.scene, env.scope.panel.panel, layer);
  const result: InsetBoxLayerResult = { kind: 'inset_box', panel: layer.panel, shown_panel: null, frame: null, origin: null, axes: null };
  const target = insetBoxTarget(env.scope, layer.panel);
  if (target === null) return result;
  result.shown_panel = target.shown;
  result.frame = target.frame;
  if (reference === null) return result;
  const { a, b, w } = referenceContexts(reference, referencePoint(env, reference).at);
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

function layerTrailFraction(layer: TrajectoriesLayer | BodyLayer): number {
  if (layer.trail === undefined) fail('panel', 'a layer draws a trail but lacks a trail fraction');
  const f = layer.trail.fraction;
  if (typeof f !== 'number' || !(f > 0 && f <= 1)) fail('panel', `the trail fraction ${String(f)} is not in (0, 1]`);
  return f;
}

/** The position and trail of a body layer (rule `body-layer`). The reference's reading is clamped to [0, 1], since a body layer does not have `before` or `after`. */
export function bodyLayer(env: LayerEnv, layer: BodyLayer, reference: Reference): BodyLayerResult {
  const result: BodyLayerResult = { kind: 'body', body: layer.body, position: null };
  if (reference === null) {
    if (layer.trail !== undefined) result.trail = [];
    return result;
  }
  const { set, trajectory } = reference;
  const revolutions = clockRevolutions(env.clock);
  const { tc, loopReading, at } = referencePoint(env, reference);
  const f = (ctx: Context): Vec3 => env.frames.bodyPosition(layer.body, env.display, ctx);
  result.position = vertexPosition(at, set, trajectory, f);
  if (layer.trail !== undefined) {
    result.trail = trail(tc, loopReading, revolutions, layerTrailFraction(layer), set.periodic).map((v) => vertexPosition(v, set, trajectory, f));
  }
  return result;
}

/** How a trajectories layer takes a sample into the display frame: in its own context, or in the contexts of the reference trajectory, blended at its reading (rule `read-from`). */
function sampleTransform(env: LayerEnv, layer: TrajectoriesLayer, set: SetData, reference: Reference): { f: (ctx: Context) => Vec3; hidden: boolean } {
  const from = set.def.frame;
  const own = (ctx: Context): Vec3 => env.frames.transform(set.position(ctx.trajectory, ctx.sample), from, env.display, ctx);
  if ((layer.read_from ?? 'own') !== 'reference') return { f: own, hidden: false };
  if (reference === null) return { f: own, hidden: true };
  const { a, b, w } = referenceContexts(reference, referencePoint(env, reference).at);
  return {
    hidden: false,
    f: (ctx: Context): Vec3 => {
      const p = set.position(ctx.trajectory, ctx.sample);
      const pa = env.frames.transform(p, from, env.display, a);
      const pb = env.frames.transform(p, from, env.display, b);
      return [(1 - w) * pa[0] + w * pb[0], (1 - w) * pa[1] + w * pb[1], (1 - w) * pa[2] + w * pb[2]];
    },
  };
}

/** Fails unless trajectory `k` lies in the set, as a literal member index must (rule `members`). */
function checkMember(set: SetData, k: number, rule: string, what: string): void {
  if (!Number.isInteger(k) || k < 0 || k >= set.trajectories)
    fail(rule, `${what} names member ${String(k)}, which is not a trajectory of trajectory set ${set.id} of ${set.trajectories}`);
}

/**
 * The point at the reading of member `k` of a set, clamped to [0, 1] as for a body (rule `body-layer`), in its revolution of rule `revolutions`, under the clock
 * of `env`, transformed by `f`. This is the anchor of a label at a member (rule `label`) and the target of a camera keyframe (rule `camera-keyframes`).
 */
export function memberPoint(env: LayerEnv, set: SetData, k: number, f: (ctx: Context) => Vec3): Vec3 {
  const revolutions = clockRevolutions(env.clock);
  if (revolutions > 1 && !set.periodic)
    fail('revolutions', `a reading is taken on trajectory set ${set.id}, which is not periodic, and the clock has ${revolutions} revolutions`);
  const tc = new TrajectoryClock(set, k, env.channel);
  const at = revolutionOf(revolutions * bound(tc.reading(env.clock, env.q))!, revolutions);
  return vertexPosition(point(tc, at.u, false, at.revolution), set, k, f);
}

/** The target of a camera keyframe (rule `camera-keyframes`): the point at the reading of member `k` of a trajectories layer, in the layer's context, or null when its set query does not match any set. */
export function targetPoint(env: LayerEnv, layer: TrajectoriesLayer, set: SetData | null, k: number, reference: Reference): Vec3 | null {
  if (set === null) return null;
  checkMember(set, k, 'camera-keyframes', 'a camera keyframe');
  const lenv = layerEnv(env, layer);
  const { f, hidden } = sampleTransform(lenv, layer, set, reference);
  if (hidden) return null;
  return memberPoint(lenv, set, k, f);
}

/** The position of a label's anchor (rule `label`), or null on the screen or when the anchor does not resolve. */
export function labelLayer(env: LayerEnv, layer: LabelLayer, set: SetData | null, reference: Reference): LabelLayerResult {
  const at = layer.at as unknown as Record<string, unknown>;
  if (at === null || typeof at !== 'object') fail('label', `a label's anchor is ${JSON.stringify(at)}, not an object`);
  if ('screen' in at) return { kind: 'label', position: null };
  if ('point' in at) {
    const p = at.point as unknown;
    if (!Array.isArray(p) || p.length !== 3 || !p.every((x) => typeof x === 'number' && Number.isFinite(x)))
      fail('label', `a label's point is ${JSON.stringify(p)}, not three finite numbers`);
    const v: Vec3 = [p[0], p[1], p[2]];
    if (at.frame === undefined) return { kind: 'label', position: v };
    if (reference === null) return { kind: 'label', position: null };
    // a point in another frame moves with the reference, as a body does (rule `body-layer`)
    const { a, b, w } = referenceContexts(reference, referencePoint(env, reference).at);
    const pa = env.frames.transform(v, at.frame as string, env.display, a);
    const pb = env.frames.transform(v, at.frame as string, env.display, b);
    return { kind: 'label', position: [(1 - w) * pa[0] + w * pb[0], (1 - w) * pa[1] + w * pb[1], (1 - w) * pa[2] + w * pb[2]] };
  }
  if (!('sets' in at) || !('member' in at)) fail('label', `a label's anchor is ${JSON.stringify(at)}, not a point, a member, or a place on the screen`);
  if (set === null) return { kind: 'label', position: null };
  const k = at.member as number;
  checkMember(set, k, 'label', 'a label');
  const lenv = layerEnv(env, layer);
  const from = set.def.frame;
  const f = (ctx: Context): Vec3 => lenv.frames.transform(set.position(ctx.trajectory, ctx.sample), from, lenv.display, ctx);
  return { kind: 'label', position: memberPoint(lenv, set, k, f) };
}

/** The drawn samples of each member of a points layer (rule `points`). */
export function pointsLayer(env: LayerEnv, layer: PointsLayer, set: SetData | null): PointsLayerResult {
  const reveal = layer.reveal ?? 'none';
  if (reveal !== 'none' && reveal !== 'grow') fail('points', `a points layer's reveal is ${JSON.stringify(reveal)}, not none or grow`);
  for (const key of ['before', 'after'] as const) {
    if (layer[key] !== undefined && layer[key] !== 'clamp' && layer[key] !== 'hidden')
      fail('before-after', `a points layer's ${key} is ${JSON.stringify(layer[key])}, not clamp or hidden`);
  }
  if (set === null) return { kind: 'points', set: null, members: [] };
  const lenv = layerEnv(env, layer);
  const hides = lenv.clock.mode === 'epoch' && (layer.before === 'hidden' || layer.after === 'hidden');
  const reads = reveal === 'grow' || hides;
  const revolutions = clockRevolutions(lenv.clock);
  if (reads && revolutions > 1 && !set.periodic)
    fail('revolutions', `a reading is taken on trajectory set ${set.id}, which is not periodic, and the clock has ${revolutions} revolutions`);
  const from = set.def.frame;
  const out: PointsLayerResult['members'] = [];
  for (const t of members(env.scope, layer.members, set)) {
    const m = set.count(t);
    let last = m - 1;
    if (reads) {
      const tc = new TrajectoryClock(set, t, lenv.channel);
      const u = tc.reading(lenv.clock, lenv.q);
      if (bound(u, layer.before, layer.after) === null) last = -1;
      else if (reveal === 'grow') {
        last = -1;
        while (last + 1 < m && tc.at(last + 1) <= u) last++;
      }
    }
    const points: Vec3[] = [];
    for (let i = 0; i <= last; i++)
      points.push(lenv.frames.transform(set.position(t, i), from, lenv.display, { set, trajectory: t, sample: i, shifted: false, revolution: 0 }));
    out.push({ index: t, points });
  }
  return { kind: 'points', set: set.id, members: out };
}
