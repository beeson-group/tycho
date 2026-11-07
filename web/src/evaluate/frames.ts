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

export class FrameTree {
  private readonly frames: Record<string, Frame | undefined>;
  private readonly depth = new Map<string, number>();
  /** Paths already found, by their two ends, since a transform takes the same path at every sample. */
  private readonly paths = new Map<string, Map<string, { up: readonly string[]; down: readonly string[] }>>();
  readonly root: string;

  constructor(frames: Record<string, Frame | undefined>) {
    this.frames = frames;
    const ids = Object.keys(frames);
    const roots = ids.filter((id) => frames[id]!.parent === undefined);
    if (roots.length !== 1) fail('2.3', `the frames have ${roots.length} roots, not one: ${JSON.stringify(roots)}`);
    this.root = roots[0]!;
    const root = frames[this.root]!;
    if (root.origin !== undefined || root.rotation !== undefined || root.scale !== undefined) {
      fail('2.3', `the root frame ${this.root} has an origin, a rotation, or a scale`);
    }
    for (const id of ids) {
      const s = frames[id]!.scale;
      if (s === 0 || (s !== undefined && typeof s === 'object' && 'attr' in s && (s.factor ?? 1) === 0 && (s.offset ?? 0) === 0)) {
        fail('F2', `the scale of frame ${id} is zero`);
      }
    }
    for (const id of ids) {
      let d = 0;
      for (let f: string | undefined = id; f !== this.root; d++) {
        const parent: string | undefined = frames[f!]!.parent;
        if (parent === undefined || !Object.hasOwn(frames, parent)) fail('2.3', `the parent ${parent} of frame ${f} is not declared`);
        if (d > ids.length) fail('2.3', `the parents of frame ${id} form a cycle`);
        f = parent;
      }
      this.depth.set(id, d);
    }
  }

  has(id: string): boolean {
    return this.depth.has(id);
  }

  frame(id: string): Frame {
    if (!this.has(id)) fail('2.3', `frame ${JSON.stringify(id)} is not declared`);
    return this.frames[id]!;
  }

  /** True when `id` is `ancestor` or below it. */
  inSubtree(id: string, ancestor: string): boolean {
    for (let f: string | undefined = id; f !== undefined; f = this.frames[f]!.parent) if (f === ancestor) return true;
    return false;
  }

  /**
   * The edges from `a` to `b` (rule F3), each identified by its child frame. The edges in `up` are in the
   * order taken inversely from `a`, and those in `down` in the order taken forward toward `b`.
   */
  path(a: string, b: string): { up: readonly string[]; down: readonly string[] } {
    let from = this.paths.get(a);
    const known = from?.get(b);
    if (known !== undefined) return known;
    this.frame(a);
    this.frame(b);
    const up: string[] = [];
    const down: string[] = [];
    let x = a;
    let y = b;
    while (this.depth.get(x)! > this.depth.get(y)!) (up.push(x), (x = this.frames[x]!.parent!));
    while (this.depth.get(y)! > this.depth.get(x)!) (down.push(y), (y = this.frames[y]!.parent!));
    while (x !== y) {
      up.push(x);
      down.push(y);
      x = this.frames[x]!.parent!;
      y = this.frames[y]!.parent!;
    }
    const found = { up, down: down.reverse() };
    if (from === undefined) this.paths.set(a, (from = new Map()));
    from.set(b, found);
    return found;
  }
}
