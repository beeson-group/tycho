/** Variables and references, rules V1 to V3. */
import { fail } from '../errors.js';
import type { Layer, Layout, MemberRef, PanelState, Scene, Selector, SetQuery, State, StringValue, VarRef, Variable, VariableValue, View } from '../scene.js';
import type { SetData } from './sets.js';

/** One panel of one state, where a value is read. */
export interface PanelScope {
  scene: Scene;
  state: State;
  panel: PanelState;
}

/** The definition of variable `id`, looked up by own property only, so that an id like "constructor" is not declared. */
export function variableDef(scene: Scene, id: string): Variable | undefined {
  return scene.variables !== undefined && Object.hasOwn(scene.variables, id) ? scene.variables[id] : undefined;
}

/** The value of variable `id` in a panel (rule V1). A panel-scoped variable takes the panel's value, and any other variable the scene's. */
export function variableValue(scope: PanelScope, id: string): VariableValue {
  const v = variableDef(scope.scene, id);
  if (v === undefined) fail('2.5', `variable ${JSON.stringify(id)} is not declared`);
  const values = v.scope === 'panel' ? scope.panel.variables : scope.state.variables;
  const value = values !== undefined && Object.hasOwn(values, id) ? values[id] : undefined;
  return value === undefined ? v.default : value;
}

/** Whether a value fits its variable's kind (section 2.5). */
export function fits(v: Variable, value: unknown): boolean {
  if (v.kind === 'selector') return typeof value === 'number' && Number.isFinite(value);
  if (v.kind === 'toggle') return typeof value === 'boolean';
  return typeof value === 'string' && v.values.includes(value);
}

/**
 * Checks that a state is valid as section 2.8 defines it. Every panel shows a declared view, the layout
 * shows every panel once and does not repeat any, the clock channel is one of the scene's, and every
 * value fits its variable. Undeclared variable ids are ignored.
 */
export function checkState(scene: Scene, state: State): void {
  if (!scene.clock.channels.includes(state.clock.channel))
    fail('2.6', `the state's clock channel ${JSON.stringify(state.clock.channel)} is not one of the scene's clock channels`);
  const values = (vals: Record<string, unknown> | undefined, where: string) => {
    for (const [id, value] of Object.entries(vals ?? {})) {
      const v = variableDef(scene, id);
      if (v !== undefined && !fits(v, value)) fail('2.5', `${where}: ${v.kind} ${id} cannot hold ${JSON.stringify(value)}`);
    }
  };
  values(state.variables, 'the state');
  const ids = Object.keys(state.panels);
  if (ids.length === 0) fail('2.8', 'the state does not have a panel');
  for (const [pid, panel] of Object.entries(state.panels)) {
    if (!Object.hasOwn(scene.views, panel!.view)) fail('2.8', `panel ${pid} shows ${JSON.stringify(panel!.view)}, which is not a view`);
    values(panel!.variables, `panel ${pid}`);
  }
  const shown = layoutIds(state.layout).sort();
  if (shown.length !== ids.length || shown.some((id, i) => id !== ids.slice().sort()[i])) {
    fail('2.8', `the layout shows the panels ${shown.join(', ')}, while the state has the panels ${ids.slice().sort().join(', ')}`);
  }
}

export function layoutIds(node: Layout, out: string[] = []): string[] {
  if (node.kind === 'panel') out.push(node.id);
  else (layoutIds(node.a, out), layoutIds(node.b, out));
  return out;
}

export function stringValue(scope: PanelScope, s: StringValue): VariableValue {
  return typeof s === 'string' ? s : variableValue(scope, s.var);
}

/** Every track set a query matches, in the order of `track_sets` (rule V2). */
export function querySets(scope: PanelScope, q: SetQuery): string[] {
  if ('set' in q) {
    if (!Object.hasOwn(scope.scene.track_sets, q.set)) fail('V2', `the set query names ${JSON.stringify(q.set)}, which is not a track set`);
    return [q.set];
  }
  if (q.tags === null || typeof q.tags !== 'object') fail('V2', `a tags query has tags ${JSON.stringify(q.tags)}, not an object`);
  const want = Object.entries(q.tags).map(([k, v]) => [k, stringValue(scope, v!)] as const);
  return Object.entries(scope.scene.track_sets)
    .filter(([, set]) => want.every(([k, v]) => Object.hasOwn(set!.tags ?? {}, k) && set!.tags![k] === v))
    .map(([id]) => id);
}

/** The one track set that the query of a layer or a driver matches (rule V2), null when the query does not match any and an error when it matches several. */
export function oneSet(scope: PanelScope, q: SetQuery): string | null {
  const ids = querySets(scope, q);
  if (ids.length > 1) fail('V2', `the set query ${JSON.stringify(q)} matches the ${ids.length} track sets ${ids.join(', ')}, where one is needed`);
  return ids[0] ?? null;
}

/** The track a selector picks in the track set where the member reference or highlight that refers to the selector is resolved (section 2.5). */
export function selectorTrack(scope: PanelScope, ref: VarRef, set: SetData): number {
  const sel = variableDef(scope.scene, ref.var);
  if (sel === undefined || sel.kind !== 'selector') fail('V3', `variable ${ref.var} is not a selector`);
  const value = variableValue(scope, ref.var);
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('2.5', `selector ${ref.var} holds ${JSON.stringify(value)}, not a finite number`);
  const by = (sel as Selector).by ?? 'nearest';
  if (by === 'index') return Math.min(Math.max(Math.floor(value + 0.5), 0), set.tracks - 1);
  const name = (sel as Selector).parameter;
  if (name === undefined) fail('2.5', `selector ${ref.var} is by nearest but does not name a parameter`);
  const p = set.parameter(name, 'V3');
  let best = 0;
  for (let i = 1; i < set.tracks; i++) if (Math.abs(p[i]! - value) < Math.abs(p[best]! - value)) best = i;
  return best;
}

function literalIndex(k: number, set: SetData): number {
  if (!Number.isInteger(k) || k < 0) fail('V3', `member index ${JSON.stringify(k)} is not a track index`);
  if (k >= set.tracks) fail('V3', `member index ${k} is not below the track count ${set.tracks} of track set ${set.id}`);
  return k;
}

/** The tracks of `{"count": n}` (rule V3), i.e. every `step`-th track from 0, and the last track. */
export function sparse(tracks: number, n: number): number[] {
  if (!Number.isInteger(n) || n < 1) fail('V3', `member count ${JSON.stringify(n)} is not an integer of at least one`);
  const step = n >= tracks ? 1 : Math.floor(tracks / n + 0.5);
  const out: number[] = [];
  for (let i = 0; i < tracks; i += step) out.push(i);
  if (out[out.length - 1] !== tracks - 1) out.push(tracks - 1);
  return out;
}

/** The tracks that a member reference selects in a track set (rule V3), i.e. all of them, one by index, an evenly spaced subset, or a selector's track. */
export function members(scope: PanelScope, ref: MemberRef, set: SetData): number[] {
  if (ref === 'all') return Array.from({ length: set.tracks }, (_, i) => i);
  if (ref === null || typeof ref !== 'object') fail('V3', `a member reference is "all", {index}, {count}, or {var}, not ${JSON.stringify(ref)}`);
  if ('index' in ref) return [literalIndex(ref.index, set)];
  if ('count' in ref) return sparse(set.tracks, ref.count);
  return [selectorTrack(scope, ref, set)];
}

export function driverMember(scope: PanelScope, ref: { index: number } | VarRef, set: SetData): number {
  if ((ref as unknown) === 'all') fail('V3', 'the driver\'s member is "all", but a driver resolves to one track');
  if (ref === null || typeof ref !== 'object') fail('V3', `the driver's member is {index} or {var}, not ${JSON.stringify(ref)}`);
  if ('count' in (ref as object)) fail('V3', "the driver's member is a count, but a driver resolves to one track");
  return 'index' in ref ? literalIndex(ref.index, set) : selectorTrack(scope, ref, set);
}

/** The display frame of a view in a panel (section 2.7). */
export function displayFrame(scope: PanelScope, view: View): string {
  const id = typeof view.frame === 'string' ? view.frame : variableValue(scope, view.frame.var);
  if (typeof id !== 'string' || !Object.hasOwn(scope.scene.frames, id)) fail('2.7', `the view displays ${JSON.stringify(id)}, which is not a frame`);
  return id;
}

/** Whether a layer is drawn, i.e. false while its `visible` toggle is off (rule L5). */
export function layerVisible(scope: PanelScope, layer: Layer): boolean {
  if (layer.visible === undefined) return true;
  const def = variableDef(scope.scene, layer.visible.var);
  if (def === undefined || def.kind !== 'toggle') fail('L5', `a layer's visible names ${layer.visible.var}, which is not a toggle`);
  const v = variableValue(scope, layer.visible.var);
  if (typeof v !== 'boolean') fail('L5', `toggle ${layer.visible.var} holds ${JSON.stringify(v)}, not a boolean`);
  return v;
}
