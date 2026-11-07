/**
 * The frame tree, rules F1 to F6. Positions move along tree edges in one context: a track
 * set, one of its tracks, and one of its samples, in one lap (rules L2 and C6).
 */
import { fail } from '../errors.js';
import { INDEX_CHANNEL, type ConstantScalar, type Frame, type Scalar, type Scene } from '../scene.js';
import type { SetData } from './sets.js';
import type { Vec3 } from './types.js';

export interface Context {
  set: SetData;
  track: number;
  sample: number;
  /** One lap lower than `lap` (rule L2). */
  shifted: boolean;
  /** The lap of rule C6, 0 when absent. */
  lap?: number;
}

/** The value of a number, an attribute, or a channel in a context (section 2.2). */
export function scalarValue(s: Scalar | ConstantScalar, ctx: Context): number {
  if (typeof s === 'number') {
    if (!Number.isFinite(s)) fail('S4', `a scalar is ${s}, not finite`);
    return s;
  }
  if (s === null || typeof s !== 'object') fail('2.2', `${JSON.stringify(s)} is not a scalar`);
  if ('attr' in s) return (s.factor ?? 1) * ctx.set.attr(s.attr) + (s.offset ?? 0);
  if (s.channel === INDEX_CHANNEL) fail('2.2', `${INDEX_CHANNEL} is not allowed in a frame edge`);
  return ctx.set.channelAt(s.channel, ctx.track, ctx.sample, ctx.shifted, ctx.lap ?? 0);
}
