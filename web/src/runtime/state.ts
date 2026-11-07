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

// pure updates of a snapshot

/**
 * Sets a variable in the panel when the variable is panel-scoped, and in the scene otherwise
 * (rule V1). A value that does not fit the variable leaves the state as it is.
 */
export function withVariable(scene: Scene, state: State, id: string, value: VariableValue, panel?: string): State {
  const v = variableDef(scene, id);
  if (v === undefined || !fits(v, value)) return state;
  if (v.scope === 'panel') {
    if (panel === undefined || !Object.hasOwn(state.panels, panel)) return state;
    const p = state.panels[panel]!;
    if (p.variables !== undefined && Object.hasOwn(p.variables, id) && p.variables[id] === value) return state;
    return withPanel(state, panel, { ...p, variables: put(p.variables, id, value) });
  }
  if (state.variables !== undefined && Object.hasOwn(state.variables, id) && state.variables[id] === value) return state;
  return { ...state, variables: put(state.variables, id, value) };
}

export function withChannel(state: State, channel: string): State {
  return state.clock.channel === channel ? state : { ...state, clock: { channel } };
}

export function withPanel(state: State, id: string, panel: PanelState): State {
  return { ...state, panels: put(state.panels, id, panel) };
}

export function withLayout(state: State, layout: Layout): State {
  return { ...state, layout };
}

/** Removes a panel and its layout leaf, collapsing its split. The last panel stays. */
export function withoutPanel(state: State, id: string): State {
  if (!Object.hasOwn(state.panels, id) || Object.keys(state.panels).length < 2) return state;
  const layout = removePanel(state.layout, id);
  if (layout === null) return state;
  return { ...state, panels: put(state.panels, id, undefined), layout };
}

/** A panel id of the form p1, p2, and so on that the state does not use yet. */
export function newPanelId(state: State): string {
  for (let n = Object.keys(state.panels).length + 1; ; n++) {
    const id = `p${n}`;
    if (!Object.hasOwn(state.panels, id)) return id;
  }
}

/** The layout with two leaves exchanged. */
export function swapLeaves(node: Layout, a: string, b: string): Layout {
  if (node.kind === 'panel') return node.id === a ? { kind: 'panel', id: b } : node.id === b ? { kind: 'panel', id: a } : node;
  return { ...node, a: swapLeaves(node.a, a, b), b: swapLeaves(node.b, a, b) };
}
