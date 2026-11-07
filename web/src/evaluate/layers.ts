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
export type Vertex = { sample: number; shifted: boolean; lap?: number } | { k: number; w: number; shifted: boolean; lap?: number };

export function point(tc: TrackClock, u: number, shifted: boolean, lap = 0): Vertex {
  const { k, w } = tc.locate(u);
  return { k, w, shifted, lap };
}

/** The polyline of a track between readings `ua` and `ub` within one lap (rule L1). */
export function polyline(tc: TrackClock, ua: number, ub: number, lap = 0): Vertex[] {
  if (ua === ub) return [point(tc, ua, false, lap)];
  const out = [point(tc, ua, false, lap)];
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
