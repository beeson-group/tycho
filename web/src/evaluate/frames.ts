/**
 * The frame tree, rules `transform` to `body-origin-cycle`. Positions move along tree edges in one context: a trajectory
 * set, one of its trajectories, and one of its samples, in one revolution (rules `trail-wrap` and `revolutions`).
 */
import { fail } from '../errors.js';
import { INDEX_CHANNEL, type ConstantScalar, type Frame, type Scalar, type Scene } from '../scene.js';
import type { SetData } from './sets.js';
import type { Vec3 } from './types.js';

export interface Context {
  set: SetData;
  trajectory: number;
  sample: number;
  /** One revolution lower than `revolution` (rule `trail-wrap`). */
  shifted: boolean;
  /** The revolution of rule `revolutions`, 0 when absent. */
  revolution?: number;
}

/** The value of a number, an attribute, or a channel in a context (section 2.2). */
export function scalarValue(s: Scalar | ConstantScalar, ctx: Context): number {
  if (typeof s === 'number') {
    if (!Number.isFinite(s)) fail('finite-number', `a scalar is ${s}, not finite`);
    return s;
  }
  if (s === null || typeof s !== 'object') fail('context-number', `${JSON.stringify(s)} is not a scalar`);
  if ('attr' in s) return (s.factor ?? 1) * ctx.set.attr(s.attr) + (s.offset ?? 0);
  if (s.channel === INDEX_CHANNEL) fail('context-number', `${INDEX_CHANNEL} is not allowed in a frame edge`);
  return ctx.set.channelAt(s.channel, ctx.trajectory, ctx.sample, ctx.shifted, ctx.revolution ?? 0);
}

/** Checks that `p` is a list of three scalars, which are constant unless `channels`, as in an origin, and returns it (rules `origin` and 2.4). */
function point(p: unknown, what: string, channels = false): Scalar[] {
  if (!Array.isArray(p) || p.length !== 3) fail('origin', `${what} is three scalars, not ${JSON.stringify(p)}`);
  if (!channels)
    for (const s of p) if (s !== null && typeof s === 'object' && 'channel' in s) fail('origin', `${what} takes a number or an attribute, not a channel`);
  return p as Scalar[];
}

/** Right-handed rotation by `angle` about `axis` (rule `transform`), or its transpose. */
function rotate(p: Vec3, axis: 'x' | 'y' | 'z', angle: number, transpose: boolean): Vec3 {
  const c = Math.cos(angle);
  const s = transpose ? -Math.sin(angle) : Math.sin(angle);
  const [x, y, z] = p;
  if (axis === 'z') return [c * x - s * y, s * x + c * y, z];
  if (axis === 'x') return [x, c * y - s * z, s * y + c * z];
  return [c * x + s * z, y, -s * x + c * z];
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
    if (roots.length !== 1) fail('frame', `the frames have ${roots.length} roots, not one: ${JSON.stringify(roots)}`);
    this.root = roots[0]!;
    const root = frames[this.root]!;
    if (root.origin !== undefined || root.rotation !== undefined || root.scale !== undefined) {
      fail('frame', `the root frame ${this.root} has an origin, a rotation, or a scale`);
    }
    for (const id of ids) {
      const s = frames[id]!.scale;
      if (s === 0 || (s !== undefined && typeof s === 'object' && 'attr' in s && (s.factor ?? 1) === 0 && (s.offset ?? 0) === 0)) {
        fail('origin', `the scale of frame ${id} is zero`);
      }
    }
    for (const id of ids) {
      let d = 0;
      for (let f: string | undefined = id; f !== this.root; d++) {
        const parent: string | undefined = frames[f!]!.parent;
        if (parent === undefined || !Object.hasOwn(frames, parent)) fail('frame', `the parent ${parent} of frame ${f} is not declared`);
        if (d > ids.length) fail('frame', `the parents of frame ${id} form a cycle`);
        f = parent;
      }
      this.depth.set(id, d);
    }
  }

  has(id: string): boolean {
    return this.depth.has(id);
  }

  frame(id: string): Frame {
    if (!this.has(id)) fail('frame', `frame ${JSON.stringify(id)} is not declared`);
    return this.frames[id]!;
  }

  /** True when `id` is `ancestor` or below it. */
  inSubtree(id: string, ancestor: string): boolean {
    for (let f: string | undefined = id; f !== undefined; f = this.frames[f]!.parent) if (f === ancestor) return true;
    return false;
  }

  /**
   * The edges from `a` to `b` (rule `frame-path`), each identified by its child frame. The edges in `up` are in the
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

export interface Requirements {
  channels: Set<string>;
  attrs: Set<string>;
}

const scalarNeeds = (s: Scalar | ConstantScalar | undefined, req: Requirements): void => {
  if (s === undefined || typeof s === 'number') return;
  if ('attr' in s) req.attrs.add(s.attr);
  else req.channels.add(s.channel);
};

/** Edge algebra over a scene's frames and bodies. */
/** An edge as rule `transform` applies it, with its origin checked once. */
interface Edge {
  parent: string;
  origin: Scalar[] | { body: string } | undefined;
  rotation: Frame['rotation'];
  scale: Scalar | undefined;
}

export class Frames {
  readonly tree: FrameTree;
  private readonly scene: Scene;
  private readonly active = new Set<string>();
  private readonly edges = new Map<string, Edge>();
  private readonly bodies = new Map<string, NonNullable<NonNullable<Scene['bodies']>[string]>>();

  constructor(scene: Scene) {
    this.scene = scene;
    this.tree = new FrameTree(scene.frames);
    // at load, whatever is drawn, check rule `body-origin-cycle` and that every body origin refers to a declared body
    for (const id of Object.keys(scene.frames)) this.requirements(id, this.tree.root);
  }

  private body(bodyId: string): NonNullable<NonNullable<Scene['bodies']>[string]> {
    const known = this.bodies.get(bodyId);
    if (known !== undefined) return known;
    const bodies = this.scene.bodies ?? {};
    if (!Object.hasOwn(bodies, bodyId)) fail('body', `body ${JSON.stringify(bodyId)} is not declared`);
    const body = bodies[bodyId]!;
    if (!Object.hasOwn(this.scene.frames, body.frame)) fail('body', `body ${bodyId} is in frame ${JSON.stringify(body.frame)}, which is not declared`);
    point(body.position, `the position of body ${bodyId}`);
    this.bodies.set(bodyId, body);
    return body;
  }

  private edgeOf(child: string): Edge {
    let e = this.edges.get(child);
    if (e === undefined) {
      const f = this.tree.frame(child);
      const origin = Array.isArray(f.origin) ? point(f.origin, `the origin of frame ${child}`, true) : f.origin;
      e = { parent: f.parent!, origin, rotation: f.rotation, scale: f.scale };
      this.edges.set(child, e);
    }
    return e;
  }

  /** Takes `p` from frame `from` to frame `to` in one context (rule `frame-path`). */
  transform(p: Vec3, from: string, to: string, ctx: Context): Vec3 {
    const { up, down } = this.tree.path(from, to);
    let q = p;
    for (const child of up) q = this.edge(child, q, ctx, true);
    for (const child of down) q = this.edge(child, q, ctx, false);
    return q;
  }

  /** A body's position in `frame` (section 2.4), with its attributes read from the context's trajectory set. */
  bodyPosition(bodyId: string, frame: string, ctx: Context): Vec3 {
    const body = this.body(bodyId);
    const p = body.position.map((s) => scalarValue(s, ctx)) as Vec3;
    return this.transform(p, body.frame, frame, ctx);
  }

  /**
   * Applies the edge from `child`'s parent to `child` (rule `transform`), or its inverse. Only an origin at
   * a body evaluates further edges, hence only there can an edge meet itself (rule `body-origin-cycle`).
   */
  private edge(child: string, p: Vec3, ctx: Context, inverse: boolean): Vec3 {
    const f = this.edgeOf(child);
    let o: Vec3 = [0, 0, 0];
    if (Array.isArray(f.origin)) o = [scalarValue(f.origin[0]!, ctx), scalarValue(f.origin[1]!, ctx), scalarValue(f.origin[2]!, ctx)];
    else if (f.origin !== undefined) {
      if (this.active.has(child)) fail('body-origin-cycle', `the origin of frame ${child} depends on itself`);
      this.active.add(child);
      try {
        o = this.bodyPosition(f.origin.body, f.parent, ctx);
      } finally {
        this.active.delete(child);
      }
    }
    const scale = f.scale === undefined ? 1 : scalarValue(f.scale, ctx);
    if (scale === 0) fail('origin', `the scale of frame ${child} is zero`);
    const rot = f.rotation;
    const angle = rot === undefined ? 0 : scalarValue(rot.angle, ctx);
    if (!inverse) {
      // the forward edge gives p_child = s * R * (p_parent - o), with scale s, rotation R, and origin o
      let d: Vec3 = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
      if (rot !== undefined) d = rotate(d, rot.axis, angle, false);
      return [scale * d[0], scale * d[1], scale * d[2]];
    }
    // the inverse edge gives p_parent = o + R^T * (p_child / s)
    let d: Vec3 = [p[0] / scale, p[1] / scale, p[2] / scale];
    if (rot !== undefined) d = rotate(d, rot.axis, angle, true);
    return [o[0] + d[0], o[1] + d[1], o[2] + d[2]];
  }

  /**
   * The channels and attributes a context's trajectory set must carry to take a position from `from`
   * to `to` (rule `transform-channels`), through body origins too. It fails with rule `body-origin-cycle` on an origin that depends on itself.
   */
  requirements(from: string, to: string, req: Requirements = { channels: new Set(), attrs: new Set() }): Requirements {
    const { up, down } = this.tree.path(from, to);
    for (const child of [...up, ...down]) {
      if (this.active.has(child)) fail('body-origin-cycle', `the origin of frame ${child} depends on itself`);
      this.active.add(child);
      try {
        const f = this.tree.frame(child);
        if (Array.isArray(f.origin)) point(f.origin, `the origin of frame ${child}`, true).forEach((s) => scalarNeeds(s, req));
        else if (f.origin !== undefined) this.bodyRequirements(f.origin.body, f.parent!, req);
        scalarNeeds(f.rotation?.angle, req);
        scalarNeeds(f.scale, req);
      } finally {
        this.active.delete(child);
      }
    }
    return req;
  }

  bodyRequirements(bodyId: string, frame: string, req: Requirements = { channels: new Set(), attrs: new Set() }): Requirements {
    const body = this.body(bodyId);
    body.position.forEach((s) => scalarNeeds(s, req));
    return this.requirements(body.frame, frame, req);
  }
}
