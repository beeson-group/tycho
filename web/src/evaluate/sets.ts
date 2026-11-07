/**
 * Read access to one track set's arrays (spec section 2.1), checked against the shapes given in
 * the same section. Every value is returned as a float64 number, whatever the stored dtype.
 */
import type { DataStore, TypedArray } from '../container.js';
import { fail } from '../errors.js';
import { INDEX_CHANNEL, type Scene, type TrackSet } from '../scene.js';
import type { Vec3 } from './types.js';

export class SetData {
  readonly id: string;
  readonly def: TrackSet;
  readonly tracks: number;
  /** The number S of samples over all tracks. */
  readonly samples: number;
  readonly dim: 2 | 3;
  private readonly data: DataStore;
  private readonly offsets: TypedArray;
  private readonly positions: TypedArray;
  private readonly channels = new Map<string, TypedArray>();
  private readonly parameters = new Map<string, TypedArray>();

  constructor(id: string, def: TrackSet, data: DataStore) {
    this.id = id;
    this.def = def;
    this.data = data;
    this.tracks = def.tracks;
    const offsets = data.view(def.offsets);
    if (offsets.dtype !== 'uint32' || offsets.shape.length !== 1 || offsets.shape[0] !== def.tracks + 1) {
      fail(
        '2.1',
        `track set ${id}: offsets view ${def.offsets} is ${offsets.dtype} of shape (${offsets.shape.join(', ')}), not uint32 of shape (${def.tracks + 1},)`,
      );
    }
    this.offsets = offsets.data;
    if (this.offsets[0] !== 0) fail('2.1', `track set ${id}: offsets[0] is ${this.offsets[0]}, not 0`);
    for (let t = 0; t < def.tracks; t++) {
      const n = this.offsets[t + 1]! - this.offsets[t]!;
      if (n < 2) fail('T1', `track set ${id}: the sample count of track ${t} is ${n}, fewer than two`);
    }
    this.samples = this.offsets[def.tracks]!;
    const positions = data.view(def.positions);
    const [rows, cols] = positions.shape;
    if (positions.shape.length !== 2 || rows !== this.samples || (cols !== 2 && cols !== 3)) {
      fail(
        '2.1',
        `track set ${id}: positions view ${def.positions} has shape (${positions.shape.join(', ')}), not (${this.samples}, 2) or (${this.samples}, 3)`,
      );
    }
    this.positions = positions.data;
    this.dim = cols;
  }

  get periodic(): boolean {
    return this.def.periodic === true;
  }

  /** Index of the first sample of track `t` in the concatenated arrays. */
  start(t: number): number {
    return this.offsets[t]!;
  }

  /** The number m of samples of track `t`. */
  count(t: number): number {
    return this.offsets[t + 1]! - this.offsets[t]!;
  }

  /** Sample `i` of track `t`, in the track set's frame. A two-component position has z = 0. */
  position(t: number, i: number): Vec3 {
    const row = (this.offsets[t]! + i) * this.dim;
    const p = this.positions;
    return [p[row]!, p[row + 1]!, this.dim === 3 ? p[row + 2]! : 0];
  }

  hasChannel(name: string): boolean {
    return name === INDEX_CHANNEL || Object.hasOwn(this.def.channels ?? {}, name);
  }

  /** The stored values of a channel, of shape (S,). `@index` does not have stored values. */
  channel(name: string, rule = 'F5'): TypedArray {
    const cached = this.channels.get(name);
    if (cached) return cached;
    const def = this.def.channels?.[name];
    if (def === undefined || !Object.hasOwn(this.def.channels ?? {}, name)) {
      fail(rule, `track set ${this.id} lacks channel ${JSON.stringify(name)}`);
    }
    const v = this.data.view(def.view);
    if (v.shape.length !== 1 || v.shape[0] !== this.samples) {
      fail('2.1', `track set ${this.id}: channel ${name} has shape (${v.shape.join(', ')}), not (${this.samples},)`);
    }
    this.channels.set(name, v.data);
    return v.data;
  }

  /**
   * The value of a channel at sample `i` of track `t` (rule T4 for `@index`), raised by the
   * channel's advance over the track once per lap (rules T2 and C6). A shifted context is one
   * lap lower (rule L2).
   */
  channelAt(name: string, t: number, i: number, shifted: boolean, lap = 0): number {
    const m = this.count(t);
    const periods = lap - (shifted ? 1 : 0);
    if (name === INDEX_CHANNEL) return periods === 0 ? i : i + periods * (m - 1);
    const c = this.channel(name);
    const s = this.offsets[t]!;
    const v = c[s + i]!;
    return periods === 0 ? v : v + periods * (c[s + m - 1]! - c[s]!);
  }

  /** The per-track values of a parameter, of shape (tracks,). */
  parameter(name: string, rule = '2.5'): TypedArray {
    const cached = this.parameters.get(name);
    if (cached) return cached;
    const def = this.def.parameters?.[name];
    if (def === undefined || !Object.hasOwn(this.def.parameters ?? {}, name)) {
      fail(rule, `track set ${this.id} lacks parameter ${JSON.stringify(name)}`);
    }
    const v = this.data.view(def.view);
    if (v.shape.length !== 1 || v.shape[0] !== this.tracks) {
      fail('2.1', `track set ${this.id}: parameter ${name} has shape (${v.shape.join(', ')}), not (${this.tracks},)`);
    }
    this.parameters.set(name, v.data);
    return v.data;
  }

  hasAttr(name: string): boolean {
    return Object.hasOwn(this.def.attrs ?? {}, name);
  }

  attr(name: string): number {
    const v = this.def.attrs?.[name];
    if (v === undefined || !this.hasAttr(name)) fail('F5', `track set ${this.id} lacks attribute ${JSON.stringify(name)}`);
    return v;
  }
}

/** One SetData per track set, built on first use. */
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
      const def = this.scene.track_sets[id];
      if (def === undefined || !Object.hasOwn(this.scene.track_sets, id)) fail('2.1', `track set ${JSON.stringify(id)} is not declared`);
      s = new SetData(id, def, this.data);
      this.sets.set(id, s);
    }
    return s;
  }
}
