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

/** What can be dropped on a panel: a view, a value of a panel-scoped choice, or another panel. */
export type DropPayload = { kind: 'view'; view: string } | { kind: 'value'; variable: string; value: string } | { kind: 'panel'; id: string };

/**
 * The state after a drop on panel `target`. On an edge, a view or a value makes a new panel
 * there, which takes the target's view and panel values and then the dropped one, and a panel
 * moves there. On the center, a view or a value changes the target, and a panel swaps places
 * with it. A new panel is not made once the state has `maxPanels` panels.
 */
export function withDrop(scene: Scene, state: State, target: string, zone: DropZone, payload: DropPayload, maxPanels = Infinity): State {
  if (!Object.hasOwn(state.panels, target)) return state;
  const base = state.panels[target]!;
  if (payload.kind === 'panel') {
    if (payload.id === target || !Object.hasOwn(state.panels, payload.id)) return state;
    if (zone === 'centre') return withLayout(state, swapLeaves(state.layout, payload.id, target));
    const without = removePanel(state.layout, payload.id);
    return without === null ? state : withLayout(state, splitAt(without, target, payload.id, zone));
  }
  if (zone === 'centre') {
    if (payload.kind === 'view') return Object.hasOwn(scene.views, payload.view) ? withPanel(state, target, { ...base, view: payload.view }) : state;
    return withVariable(scene, state, payload.variable, payload.value, target);
  }
  if (Object.keys(state.panels).length >= maxPanels) return state;
  const id = newPanelId(state);
  const panel: PanelState = { view: base.view, variables: Object.assign(dict<VariableValue>(), base.variables) };
  if (payload.kind === 'view') {
    if (!Object.hasOwn(scene.views, payload.view)) return state;
    panel.view = payload.view;
  }
  const next = withLayout(withPanel(state, id, panel), splitAt(state.layout, target, id, zone));
  return payload.kind === 'value' ? withVariable(scene, next, payload.variable, payload.value, id) : next;
}

/**
 * The state after adding a panel with `payload` where there is most room. The largest panel by
 * area is split along its longer side, below it when `tall` returns true (taller than wide) and
 * to its right otherwise. A new panel is not made once the state has `maxPanels` panels.
 */
export function withAdd(scene: Scene, state: State, payload: Exclude<DropPayload, { kind: 'panel' }>, maxPanels: number, tall: (id: string) => boolean): State {
  if (Object.keys(state.panels).length >= maxPanels) return state;
  const largest = panelAreas(state.layout).reduce((a, b) => (b.area > a.area ? b : a));
  return withDrop(scene, state, largest.id, tall(largest.id) ? 'bottom' : 'right', payload, maxPanels);
}

/** Where a chip's menu puts a panel, either where there is most room or where a drop on a panel would. */
export type Placement = { kind: 'add' } | { kind: 'drop'; target: string; zone: DropZone };

export interface MenuItem {
  label: string;
  placement: Placement;
  disabled: boolean;
  /** The item opens a new group of the menu. */
  group: boolean;
}

/**
 * The menu of a chip in the Add panel group, which offers from the keyboard what dragging does. It
 * lists Add panel, then for each panel in layout order Split it right, Split it below, and Replace
 * it. The function `name` gives a panel's name, which is numbered where two panels share one. An
 * item that would add a panel beyond `maxPanels` is disabled.
 */
export function chipMenu(state: State, name: (id: string) => string, maxPanels: number): MenuItem[] {
  const full = Object.keys(state.panels).length >= maxPanels;
  const ids = panelIds(state.layout);
  const names = ids.map(name);
  const items: MenuItem[] = [{ label: 'Add panel', placement: { kind: 'add' }, disabled: full, group: false }];
  ids.forEach((id, i) => {
    const repeated = names.filter((n) => n === names[i]).length > 1;
    const n = repeated ? `${names[i]} (${names.slice(0, i + 1).filter((x) => x === names[i]).length})` : names[i]!;
    items.push(
      { label: `Split ${n} right`, placement: { kind: 'drop', target: id, zone: 'right' }, disabled: full, group: true },
      { label: `Split ${n} below`, placement: { kind: 'drop', target: id, zone: 'bottom' }, disabled: full, group: false },
      { label: `Replace ${n}`, placement: { kind: 'drop', target: id, zone: 'centre' }, disabled: false, group: false },
    );
  });
  return items;
}

/** The state after a chip's menu item: `withAdd` or `withDrop` with the chip's payload. */
export function withPlacement(
  scene: Scene,
  state: State,
  placement: Placement,
  payload: Exclude<DropPayload, { kind: 'panel' }>,
  maxPanels: number,
  tall: (id: string) => boolean,
): State {
  return placement.kind === 'add'
    ? withAdd(scene, state, payload, maxPanels, tall)
    : withDrop(scene, state, placement.target, placement.zone, payload, maxPanels);
}

// storage of the state

/** The 32-bit FNV-1a hash (Fowler-Noll-Vo) of the UTF-8 bytes of `text`, as eight hex digits. */
export function fnv1a(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** The key under which a stored state is kept, built from a hash of scene.tys and its length (section 2.8). */
export function storageKey(sceneText: string): string {
  return `tycho:state:${fnv1a(sceneText)}:${sceneText.length}`;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The values of `stored` that a scene can use in `scope`, i.e. those whose variable is declared
 * and has the scope `scope`, and that fit the variable. Every other value is dropped.
 */
function keepValues(scene: Scene, stored: unknown, scope: 'scene' | 'panel'): Values {
  const out = dict<VariableValue>();
  if (!isObject(stored)) return out;
  for (const [id, value] of Object.entries(stored)) {
    const v = variableDef(scene, id);
    if (v === undefined || (v.scope === 'panel') !== (scope === 'panel') || !fits(v, value)) continue;
    out[id] = value as VariableValue;
  }
  return out;
}

/**
 * The layout without the leaves for which `keep` returns false or that repeat an earlier leaf, with
 * splits collapsed as closing a panel collapses them. It is undefined when the tree is malformed,
 * and null when every leaf is dropped.
 */
function cleanLayout(node: unknown, keep: (id: string) => boolean, seen: Set<string>): Layout | null | undefined {
  if (!isObject(node)) return undefined;
  if (node.kind === 'panel') {
    if (typeof node.id !== 'string') return undefined;
    if (!keep(node.id) || seen.has(node.id)) return null;
    seen.add(node.id);
    return { kind: 'panel', id: node.id };
  }
  if (node.kind !== 'split' || (node.dir !== 'row' && node.dir !== 'col')) return undefined;
  const a = cleanLayout(node.a, keep, seen);
  const b = cleanLayout(node.b, keep, seen);
  if (a === undefined || b === undefined) return undefined;
  if (a === null) return b;
  if (b === null) return a;
  const r = node.ratio;
  const ratio = typeof r === 'number' && r > 0 && r < 1 ? r : 0.5;
  return { kind: 'split', dir: node.dir, ratio, a, b };
}

/**
 * Repairs a stored state against a scene, as described in section 2.8. A panel whose view the
 * scene lacks is dropped together with its layout leaf, and a value that does not fit its
 * variable is dropped, as is a panel value of a scene-scoped variable. The repair falls back to
 * `initial` once every panel is dropped or when the clock channel is unknown. Beyond section 2.8,
 * it also drops values that are never read (undeclared ids, and a scene value of a panel-scoped variable),
 * a panel that the layout does not show or whose id is not an identifier, and a repeated leaf. It falls
 * back to `initial` as well on input that is not a state at all. It is pure and does not modify `stored`.
 */
export function repair(scene: Scene, stored: unknown): State {
  const initial = (): State => structuredClone(scene.initial);
  if (!isObject(stored) || !isObject(stored.clock) || !isObject(stored.panels)) return initial();
  const channel = stored.clock.channel;
  if (typeof channel !== 'string' || !scene.clock.channels.includes(channel)) return initial();

  const panels = dict<PanelState>();
  for (const [pid, p] of Object.entries(stored.panels)) {
    if (!ID_PATTERN.test(pid) || !isObject(p) || typeof p.view !== 'string' || !Object.hasOwn(scene.views, p.view)) continue;
    panels[pid] = { view: p.view, variables: keepValues(scene, p.variables, 'panel') };
  }
  const layout = cleanLayout(stored.layout, (id) => Object.hasOwn(panels, id), new Set());
  if (layout === undefined || layout === null) return initial();
  const shown = new Set<string>();
  const walk = (n: Layout): void => (n.kind === 'panel' ? void shown.add(n.id) : (walk(n.a), walk(n.b)));
  walk(layout);
  for (const pid of Object.keys(panels)) if (!shown.has(pid)) delete panels[pid];
  if (Object.keys(panels).length === 0) return initial();

  const state: State = { variables: keepValues(scene, stored.variables, 'scene'), clock: { channel }, panels, layout };
  try {
    checkState(scene, state);
  } catch {
    return initial();
  }
  return state;
}
