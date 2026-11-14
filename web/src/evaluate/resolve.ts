/** Inputs and references, rules `input-scope` to `members`. */
import { fail } from '../errors.js';
import type { Layer, Layout, MemberRef, ShownPanel, Scene, Panel, SetQuery, State, StringValue, InputRef, Input, InputValue } from '../scene.js';
import type { SetData } from './sets.js';

/** One panel of one state, where a value is read. */
export interface PanelScope {
  scene: Scene;
  state: State;
  panel: ShownPanel;
}

/** The definition of input `id`, looked up by own property only, so that an id like "constructor" is not declared. */
export function inputDef(scene: Scene, id: string): Input | undefined {
  return scene.inputs !== undefined && Object.hasOwn(scene.inputs, id) ? scene.inputs[id] : undefined;
}

/** The value of input `id` in a panel (rule `input-scope`). A per-panel input takes the panel's value, and any other input the scene's. */
export function inputValue(scope: PanelScope, id: string): InputValue {
  const v = inputDef(scope.scene, id);
  if (v === undefined) fail('input', `input ${JSON.stringify(id)} is not declared`);
  const values = v.scope === 'per_panel' ? scope.panel.inputs : scope.state.inputs;
  const value = values !== undefined && Object.hasOwn(values, id) ? values[id] : undefined;
  return value === undefined ? v.default : value;
}

/** Whether a value fits its input's kind (section 2.5). */
export function fits(v: Input, value: unknown): boolean {
  if (v.kind === 'parameter') return typeof value === 'number' && Number.isFinite(value);
  if (v.kind === 'toggle') return typeof value === 'boolean';
  return typeof value === 'string' && v.values.includes(value);
}

/**
 * Checks that a state is valid as section 2.8 defines it. Every shown panel names a declared panel, the layout
 * shows every panel once and does not repeat any, the clock channel is one of the scene's, and every
 * value fits its input. Undeclared input ids are ignored.
 */
export function checkState(scene: Scene, state: State): void {
  if (!scene.clock.channels.includes(state.clock.channel))
    fail('clock', `the state's clock channel ${JSON.stringify(state.clock.channel)} is not one of the scene's clock channels`);
  const values = (vals: Record<string, unknown> | undefined, where: string) => {
    for (const [id, value] of Object.entries(vals ?? {})) {
      const v = inputDef(scene, id);
      if (v !== undefined && !fits(v, value)) fail('input', `${where}: ${v.kind} ${id} cannot hold ${JSON.stringify(value)}`);
    }
  };
  values(state.inputs, 'the state');
  const ids = Object.keys(state.panels);
  if (ids.length === 0) fail('state', 'the state does not have a panel');
  for (const [pid, panel] of Object.entries(state.panels)) {
    if (!Object.hasOwn(scene.panels, panel!.panel)) fail('state', `shown panel ${pid} names ${JSON.stringify(panel!.panel)}, which is not a declared panel`);
    values(panel!.inputs, `panel ${pid}`);
  }
  const shown = layoutIds(state.layout).sort();
  if (shown.length !== ids.length || shown.some((id, i) => id !== ids.slice().sort()[i])) {
    fail('state', `the layout shows the panels ${shown.join(', ')}, while the state has the panels ${ids.slice().sort().join(', ')}`);
  }
}

export function layoutIds(node: Layout, out: string[] = []): string[] {
  if (node.kind === 'panel') out.push(node.id);
  else (layoutIds(node.a, out), layoutIds(node.b, out));
  return out;
}

export function stringValue(scope: PanelScope, s: StringValue): InputValue {
  return typeof s === 'string' ? s : inputValue(scope, s.input);
}

/** Every trajectory set a query matches, in the order of `trajectory_sets` (rule `set-query`). */
export function querySets(scope: PanelScope, q: SetQuery): string[] {
  if ('set' in q) {
    if (!Object.hasOwn(scope.scene.trajectory_sets, q.set)) fail('set-query', `the set query names ${JSON.stringify(q.set)}, which is not a trajectory set`);
    return [q.set];
  }
  if (q.tags === null || typeof q.tags !== 'object') fail('set-query', `a tags query has tags ${JSON.stringify(q.tags)}, not an object`);
  const want = Object.entries(q.tags).map(([k, v]) => [k, stringValue(scope, v!)] as const);
  return Object.entries(scope.scene.trajectory_sets)
    .filter(([, set]) => want.every(([k, v]) => Object.hasOwn(set!.tags ?? {}, k) && set!.tags![k] === v))
    .map(([id]) => id);
}

/** The one trajectory set that the query of a layer or a reference matches (rule `set-query`), null when the query does not match any and an error when it matches several. */
export function oneSet(scope: PanelScope, q: SetQuery): string | null {
  const ids = querySets(scope, q);
  if (ids.length > 1) fail('set-query', `the set query ${JSON.stringify(q)} matches the ${ids.length} trajectory sets ${ids.join(', ')}, where one is needed`);
  return ids[0] ?? null;
}

/**
 * The member that an input of kind parameter picks in the trajectory set where the member reference or highlight that refers
 * to the input is resolved, i.e. the member whose value of the parameter is nearest, the lowest index on a tie (section 2.5).
 */
export function parameterMember(scope: PanelScope, ref: InputRef, set: SetData): number {
  const def = inputDef(scope.scene, ref.input);
  if (def === undefined || def.kind !== 'parameter') fail('members', `input ${ref.input} is not of kind parameter`);
  const value = inputValue(scope, ref.input);
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('input', `input ${ref.input} holds ${JSON.stringify(value)}, not a finite number`);
  const p = set.parameter(def.parameter, 'members');
  let best = 0;
  for (let i = 1; i < set.trajectories; i++) if (Math.abs(p[i]! - value) < Math.abs(p[best]! - value)) best = i;
  return best;
}

function literalIndex(k: number, set: SetData): number {
  if (!Number.isInteger(k) || k < 0) fail('members', `member index ${JSON.stringify(k)} is not a trajectory index`);
  if (k >= set.trajectories) fail('members', `member index ${k} is not below the trajectory count ${set.trajectories} of trajectory set ${set.id}`);
  return k;
}

/** The members of `{"evenly_spaced": n}` (rule `members`), i.e. every `step`-th trajectory from 0, and the last trajectory. */
export function sparse(trajectories: number, n: number): number[] {
  if (!Number.isInteger(n) || n < 1) fail('members', `evenly_spaced ${JSON.stringify(n)} is not an integer of at least one`);
  const step = n >= trajectories ? 1 : Math.floor(trajectories / n + 0.5);
  const out: number[] = [];
  for (let i = 0; i < trajectories; i += step) out.push(i);
  if (out[out.length - 1] !== trajectories - 1) out.push(trajectories - 1);
  return out;
}

/** The trajectories that a member reference selects in a trajectory set (rule `members`), i.e. all of them, one by index, an evenly spaced subset, or the member of an input of kind parameter. */
export function members(scope: PanelScope, ref: MemberRef, set: SetData): number[] {
  if (ref === 'all') return Array.from({ length: set.trajectories }, (_, i) => i);
  if (ref === null || typeof ref !== 'object') fail('members', `a member reference is "all", {index}, {evenly_spaced}, or {input}, not ${JSON.stringify(ref)}`);
  if ('index' in ref) return [literalIndex(ref.index, set)];
  if ('evenly_spaced' in ref) return sparse(set.trajectories, ref.evenly_spaced);
  return [parameterMember(scope, ref, set)];
}

export function referenceMember(scope: PanelScope, ref: { index: number } | InputRef, set: SetData): number {
  if ((ref as unknown) === 'all') fail('members', 'the member of the reference trajectory is "all", but a reference resolves to one trajectory');
  if (ref === null || typeof ref !== 'object') fail('members', `the member of the reference trajectory is {index} or {input}, not ${JSON.stringify(ref)}`);
  if ('evenly_spaced' in (ref as object))
    fail('members', 'the member of the reference trajectory is evenly_spaced, but a reference resolves to one trajectory');
  return 'index' in ref ? literalIndex(ref.index, set) : parameterMember(scope, ref, set);
}

/**
 * The target of an inset_box layer, i.e. the first shown panel in layout order that names declared panel `panelId`, and its display
 * frame read with its own values of the inputs (rule `inset-box`), or null when the layout does not show the declared panel.
 */
export function insetBoxTarget(scope: PanelScope, panelId: string): { shown: string; frame: string } | null {
  const { scene, state } = scope;
  const shown = layoutIds(state.layout).find((pid) => state.panels[pid]?.panel === panelId);
  if (shown === undefined) return null;
  return { shown, frame: displayFrame({ scene, state, panel: state.panels[shown]! }, scene.panels[panelId]!) };
}

/** The display frame of a declared panel where it is shown (section 2.7). */
export function displayFrame(scope: PanelScope, panel: Panel): string {
  const id = typeof panel.frame === 'string' ? panel.frame : inputValue(scope, panel.frame.input);
  if (typeof id !== 'string' || !Object.hasOwn(scope.scene.frames, id)) fail('panel', `the panel displays ${JSON.stringify(id)}, which is not a frame`);
  return id;
}

/** Whether a layer is drawn, i.e. false while its `visible` toggle is off (rule `visible`). */
export function layerVisible(scope: PanelScope, layer: Layer): boolean {
  if (layer.visible === undefined) return true;
  const def = inputDef(scope.scene, layer.visible.input);
  if (def === undefined || def.kind !== 'toggle') fail('visible', `a layer's visible names ${layer.visible.input}, which is not a toggle`);
  const v = inputValue(scope, layer.visible.input);
  if (typeof v !== 'boolean') fail('visible', `toggle ${layer.visible.input} holds ${JSON.stringify(v)}, not a boolean`);
  return v;
}
