/**
 * Read access to one trajectory set's arrays (spec section 2.1), checked against the shapes given in
 * the same section. Every value is returned as a float64 number, whatever the stored dtype.
 */
import type { DataStore, TypedArray } from '../container.js';
import { fail } from '../errors.js';
import { INDEX_CHANNEL, INDEX_PARAMETER, type Scene, type TrajectorySet } from '../scene.js';
import type { Vec3 } from './types.js';

export class SetData {
  readonly id: string;
  readonly def: TrajectorySet;
  readonly trajectories: number;
  /** The number S of samples over all trajectories. */
  readonly samples: number;
  readonly dim: 2 | 3;
  private readonly data: DataStore;
  private readonly offsets: TypedArray;
  private readonly positions: TypedArray;
  private readonly channels = new Map<string, TypedArray>();
  private readonly parameters = new Map<string, TypedArray>();

  constructor(id: string, def: TrajectorySet, data: DataStore) {
    this.id = id;
    this.def = def;
    this.data = data;
    this.trajectories = def.trajectories;
    const offsets = data.array(def.offsets);
    if (offsets.dtype !== 'uint32' || offsets.shape.length !== 1 || offsets.shape[0] !== def.trajectories + 1) {
      fail(
        'trajectory-set',
        `trajectory set ${id}: offsets array ${def.offsets} is ${offsets.dtype} of shape (${offsets.shape.join(', ')}), not uint32 of shape (${def.trajectories + 1},)`,
      );
    }
    this.offsets = offsets.data;
    if (this.offsets[0] !== 0) fail('trajectory-set', `trajectory set ${id}: offsets[0] is ${this.offsets[0]}, not 0`);
    for (let t = 0; t < def.trajectories; t++) {
      const n = this.offsets[t + 1]! - this.offsets[t]!;
      if (n < 2) fail('two-samples', `trajectory set ${id}: the sample count of trajectory ${t} is ${n}, fewer than two`);
    }
    this.samples = this.offsets[def.trajectories]!;
    const positions = data.array(def.positions);
    const [rows, cols] = positions.shape;
    if (positions.shape.length !== 2 || rows !== this.samples || (cols !== 2 && cols !== 3)) {
      fail(
        'trajectory-set',
        `trajectory set ${id}: positions array ${def.positions} has shape (${positions.shape.join(', ')}), not (${this.samples}, 2) or (${this.samples}, 3)`,
      );
    }
    this.positions = positions.data;
    this.dim = cols;
  }

  get periodic(): boolean {
    return this.def.periodic === true;
  }

  /** Index of the first sample of trajectory `t` in the concatenated arrays. */
  start(t: number): number {
    return this.offsets[t]!;
  }

  /** The number m of samples of trajectory `t`. */
  count(t: number): number {
    return this.offsets[t + 1]! - this.offsets[t]!;
  }

  /** Sample `i` of trajectory `t`, in the trajectory set's frame. A two-component position has z = 0. */
  position(t: number, i: number): Vec3 {
    const row = (this.offsets[t]! + i) * this.dim;
    const p = this.positions;
    return [p[row]!, p[row + 1]!, this.dim === 3 ? p[row + 2]! : 0];
  }

  hasChannel(name: string): boolean {
    return name === INDEX_CHANNEL || Object.hasOwn(this.def.channels ?? {}, name);
  }

  /** The stored values of a channel, of shape (S,). `@index` does not have stored values. */
  channel(name: string, rule = 'transform-channels'): TypedArray {
    const cached = this.channels.get(name);
    if (cached) return cached;
    const def = this.def.channels?.[name];
    if (def === undefined || !Object.hasOwn(this.def.channels ?? {}, name)) {
      fail(rule, `trajectory set ${this.id} lacks channel ${JSON.stringify(name)}`);
    }
    const v = this.data.array(def.array);
    if (v.shape.length !== 1 || v.shape[0] !== this.samples) {
      fail('trajectory-set', `trajectory set ${this.id}: channel ${name} has shape (${v.shape.join(', ')}), not (${this.samples},)`);
    }
    this.channels.set(name, v.data);
    return v.data;
  }

  /**
   * The value of a channel at sample `i` of trajectory `t` (rule `index-channel` for `@index`), raised by the
   * channel's advance over the trajectory once per revolution (rules `periodic` and `revolutions`). A shifted context is one
   * revolution lower (rule `trail-wrap`).
   */
  channelAt(name: string, t: number, i: number, shifted: boolean, revolution = 0): number {
    const m = this.count(t);
    const periods = revolution - (shifted ? 1 : 0);
    if (name === INDEX_CHANNEL) return periods === 0 ? i : i + periods * (m - 1);
    const c = this.channel(name);
    const s = this.offsets[t]!;
    const v = c[s + i]!;
    return periods === 0 ? v : v + periods * (c[s + m - 1]! - c[s]!);
  }

  hasParameter(name: string): boolean {
    return name === INDEX_PARAMETER || Object.hasOwn(this.def.parameters ?? {}, name);
  }

  /** The values of a parameter, one per member, of shape (trajectories,). The built-in parameter `@index` has the value `t` for member `t`. */
  parameter(name: string, rule = 'input'): TypedArray {
    const cached = this.parameters.get(name);
    if (cached) return cached;
    if (name === INDEX_PARAMETER) {
      const index = Float64Array.from({ length: this.trajectories }, (_, t) => t);
      this.parameters.set(name, index);
      return index;
    }
    const def = this.def.parameters?.[name];
    if (def === undefined || !Object.hasOwn(this.def.parameters ?? {}, name)) {
      fail(rule, `trajectory set ${this.id} lacks parameter ${JSON.stringify(name)}`);
    }
    const v = this.data.array(def.array);
    if (v.shape.length !== 1 || v.shape[0] !== this.trajectories) {
      fail('trajectory-set', `trajectory set ${this.id}: parameter ${name} has shape (${v.shape.join(', ')}), not (${this.trajectories},)`);
    }
    this.parameters.set(name, v.data);
    return v.data;
  }

  hasAttr(name: string): boolean {
    return Object.hasOwn(this.def.attrs ?? {}, name);
  }

  attr(name: string): number {
    const v = this.def.attrs?.[name];
    if (v === undefined || !this.hasAttr(name)) fail('transform-channels', `trajectory set ${this.id} lacks attribute ${JSON.stringify(name)}`);
    return v;
  }
}

/** One SetData per trajectory set, built on first use. */
export class SetCache {
  private readonly scene: Scene;
  private readonly data: DataStore;
  private readonly sets = new Map<string, SetData>();

  constructor(scene: Scene, data: DataStore) {
    this.scene = scene;
    this.data = data;
  }

  get(id: string): SetData {
    let s = this.sets.get(id);
    if (!s) {
      const def = this.scene.trajectory_sets[id];
      if (def === undefined || !Object.hasOwn(this.scene.trajectory_sets, id)) fail('trajectory-set', `trajectory set ${JSON.stringify(id)} is not declared`);
      s = new SetData(id, def, this.data);
      this.sets.set(id, s);
    }
    return s;
  }
}
