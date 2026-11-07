/**
 * The state of a page (section 2.8 of spec/tycho-scene.md). A small store holds the snapshot (the
 * variables, the panels with their views and values, the clock channel, and the layout), plus the
 * frame index and the playing flag, which are not part of the snapshot and are never stored. The
 * snapshot is immutable and is replaced on every change, thus the code that reads it compares references.
 */
import { checkState, fits, variableDef } from '../evaluate/resolve.js';
import { ID_PATTERN, type Layout, type PanelState, type Scene, type State, type VariableValue } from '../scene.js';
import { panelAreas, panelIds, removePanel, splitAt, type DropZone } from './layout.js';

/** Which of the snapshot, the frame index, and the playing flag changed. */
export type Change = 'state' | 'frame' | 'playing';
export type Listener = (change: Change) => void;

type Values = NonNullable<State['variables']>;

/** A dictionary without a prototype, so that an id like "__proto__" is an own key. */
export function dict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** A copy of `obj` with `key` set to `value`, or removed when `value` is undefined. */
function put<T>(obj: Record<string, T | undefined> | undefined, key: string, value: T | undefined): Record<string, T> {
  const out = dict<T>();
  for (const [k, v] of Object.entries(obj ?? {})) if (k !== key && v !== undefined) out[k] = v;
  if (value !== undefined) out[key] = value;
  return out;
}

const mod = (i: number, n: number): number => ((i % n) + n) % n;

export class Store {
  private snap: State;
  private index = 0;
  private play = false;
  private readonly steps: number;
  private readonly listeners = new Set<Listener>();

  constructor(state: State, steps: number) {
    this.snap = state;
    this.steps = steps;
  }

  get state(): State {
    return this.snap;
  }

  /** The frame index, kept in [0, steps), since the indices i and i + steps are the same frame (section 2.6). */
  get frame(): number {
    return this.index;
  }

  get playing(): boolean {
    return this.play;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: Change): void {
    for (const l of [...this.listeners]) l(change);
  }

  set(next: State): void {
    if (next === this.snap) return;
    this.snap = next;
    this.emit('state');
  }

  update(f: (s: State) => State): void {
    this.set(f(this.snap));
  }

  setFrame(i: number): void {
    if (!Number.isInteger(i)) return;
    const next = mod(i, this.steps);
    if (next === this.index) return;
    this.index = next;
    this.emit('frame');
  }

  setPlaying(on: boolean): void {
    if (on === this.play) return;
    this.play = on;
    this.emit('playing');
  }
}
