/**
 * The state of a page (section 2.8 of spec/tycho-scene.md). A small store holds the snapshot (the
 * shared inputs, the shown panels with their declared panels and inputs, the clock channel, and the layout), plus the
 * frame index and the playing flag, which are not part of the snapshot and are never stored. The
 * snapshot is immutable and is replaced on every change, thus the code that reads it compares references.
 */
import { checkState, fits, inputDef } from '../evaluate/resolve.js';
import { checkKeyframes, isShare } from '../evaluate/timeline.js';
import { ID_PATTERN, type Keyframes, type Layout, type ShownPanel, type Scene, type State, type InputValue } from '../scene.js';
import { panelAreas, panelIds, removePanel, splitAt, type DropZone } from './layout.js';

/** Which of the snapshot, the frame index, and the playing flag changed. */
export type Change = 'state' | 'frame' | 'playing';
export type Listener = (change: Change) => void;

type Values = NonNullable<State['inputs']>;

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
  private readonly frameCount: number;
  private readonly listeners = new Set<Listener>();

  constructor(state: State, frameCount: number) {
    this.snap = state;
    this.frameCount = frameCount;
  }

  get state(): State {
    return this.snap;
  }

  /** The frame index, kept in [0, frameCount), since the indices i and i + frameCount are the same frame (section 2.6). */
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
    const next = mod(i, this.frameCount);
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
 * Sets an input in the shown panel when the input is per-panel, and in the state's shared inputs otherwise
 * (rule `input-scope`). A value that does not fit the input leaves the state as it is.
 */
export function withInput(scene: Scene, state: State, id: string, value: InputValue, panel?: string): State {
  const v = inputDef(scene, id);
  if (v === undefined || !fits(v, value)) return state;
  if (v.scope === 'per_panel') {
    if (panel === undefined || !Object.hasOwn(state.panels, panel)) return state;
    const p = state.panels[panel]!;
    if (p.inputs !== undefined && Object.hasOwn(p.inputs, id) && p.inputs[id] === value) return state;
    return withPanel(state, panel, { ...p, inputs: put(p.inputs, id, value) });
  }
  if (state.inputs !== undefined && Object.hasOwn(state.inputs, id) && state.inputs[id] === value) return state;
  return { ...state, inputs: put(state.inputs, id, value) };
}

export function withChannel(state: State, channel: string): State {
  return state.clock.channel === channel ? state : { ...state, clock: { channel } };
}

export function withPanel(state: State, id: string, panel: ShownPanel): State {
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

/** What can be dropped on a shown panel: a declared panel, or another shown panel. */
export type DropPayload = { kind: 'declared'; panel: string } | { kind: 'panel'; id: string };

/**
 * A new shown panel of declared panel `panel`. It copies the inputs of the shown panel `target` when
 * `target` shows the same declared panel, and else those of the first shown panel in layout order that
 * does, so that adding a declared panel that is already shown makes a copy of it. It starts from the
 * defaults of its inputs when no shown panel shows the declared panel.
 */
function shownCopy(state: State, panel: string, target: string): ShownPanel {
  const ids = [target, ...panelIds(state.layout)];
  const from = ids.map((id) => state.panels[id]).find((p) => p !== undefined && p.panel === panel);
  return { panel, inputs: Object.assign(dict<InputValue>(), from?.inputs) };
}

/**
 * The state after a drop on the shown panel `target`. On an edge, a declared panel makes a new shown
 * panel there, and a shown panel moves there. On the center, a declared panel replaces the declared
 * panel that the target shows, which keeps its inputs, and a shown panel swaps places with it. A new
 * shown panel is not made once the state has `maxPanels` shown panels.
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
  if (!Object.hasOwn(scene.panels, payload.panel)) return state;
  if (zone === 'centre') return base.panel === payload.panel ? state : withPanel(state, target, { ...base, panel: payload.panel });
  if (Object.keys(state.panels).length >= maxPanels) return state;
  const id = newPanelId(state);
  return withLayout(withPanel(state, id, shownCopy(state, payload.panel, target)), splitAt(state.layout, target, id, zone));
}

/**
 * The state after adding a panel with `payload` where there is most room. The largest panel by
 * area is split along its longer side, below it when `tall` returns true (taller than wide) and
 * to its right otherwise. A new panel is not made once the state has `maxPanels` panels.
 */
export function withAdd(
  scene: Scene,
  state: State,
  payload: Extract<DropPayload, { kind: 'declared' }>,
  maxPanels: number,
  tall: (id: string) => boolean,
): State {
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
  payload: Extract<DropPayload, { kind: 'declared' }>,
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
 * The values of `stored` that a scene can use in `scope`, i.e. those whose input is declared
 * and has the scope `scope`, and that fit the input. Every other value is dropped.
 */
function keepValues(scene: Scene, stored: unknown, scope: 'shared' | 'per_panel'): Values {
  const out = dict<InputValue>();
  if (!isObject(stored)) return out;
  for (const [id, value] of Object.entries(stored)) {
    const v = inputDef(scene, id);
    if (v === undefined || (v.scope ?? 'shared') !== scope || !fits(v, value)) continue;
    out[id] = value as InputValue;
  }
  return out;
}

/** A copy of the keyframes of a split (section 2.11) when the scene reader would take them, and undefined otherwise. */
function splitKeyframes(keyframes: unknown): Keyframes | undefined {
  if (keyframes === undefined) return undefined;
  try {
    return checkKeyframes(keyframes, 'a split', isShare).map((k) => [...k]) as Keyframes;
  } catch {
    return undefined;
  }
}

/**
 * The layout without the leaves for which `keep` returns false or that repeat an earlier leaf, with
 * splits collapsed as closing a panel collapses them. A split keeps its keyframes when they are valid, and
 * loses them otherwise, to stay at its ratio. It is undefined when the tree is malformed, and null when
 * every leaf is dropped.
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
  const split: Layout = { kind: 'split', dir: node.dir, ratio, a, b };
  const keyframes = splitKeyframes(node.keyframes);
  if (keyframes !== undefined) split.keyframes = keyframes;
  return split;
}

/**
 * Repairs a stored state against a scene, as described in section 2.8. A shown panel whose declared
 * panel the scene lacks is dropped together with its layout leaf, and a value that does not fit its
 * input is dropped, as is a value of a shared input in a shown panel. A split keeps its keyframes, the
 * keyframes of its ratio (section 2.11), when they are valid, so that a restored layout still moves with
 * the timeline, and loses them otherwise. The repair falls back to `initial` once every panel is
 * dropped or when the clock channel is unknown. Beyond section 2.8,
 * it also drops values that are never read (undeclared ids, and a shared value of a per-panel input),
 * a shown panel that the layout does not show or whose id is not an identifier, and a repeated leaf. It falls
 * back to `initial` as well on input that is not a state at all. It is pure and does not modify `stored`.
 */
export function repair(scene: Scene, stored: unknown): State {
  const initial = (): State => structuredClone(scene.initial);
  if (!isObject(stored) || !isObject(stored.clock) || !isObject(stored.panels)) return initial();
  const channel = stored.clock.channel;
  if (typeof channel !== 'string' || !scene.clock.channels.includes(channel)) return initial();

  const panels = dict<ShownPanel>();
  for (const [pid, p] of Object.entries(stored.panels)) {
    if (!ID_PATTERN.test(pid) || !isObject(p) || typeof p.panel !== 'string' || !Object.hasOwn(scene.panels, p.panel)) continue;
    panels[pid] = { panel: p.panel, inputs: keepValues(scene, p.inputs, 'per_panel') };
  }
  const layout = cleanLayout(stored.layout, (id) => Object.hasOwn(panels, id), new Set());
  if (layout === undefined || layout === null) return initial();
  const shown = new Set<string>();
  const walk = (n: Layout): void => (n.kind === 'panel' ? void shown.add(n.id) : (walk(n.a), walk(n.b)));
  walk(layout);
  for (const pid of Object.keys(panels)) if (!shown.has(pid)) delete panels[pid];
  if (Object.keys(panels).length === 0) return initial();

  const state: State = { inputs: keepValues(scene, stored.inputs, 'shared'), clock: { channel }, panels, layout };
  try {
    checkState(scene, state);
  } catch {
    return initial();
  }
  return state;
}
