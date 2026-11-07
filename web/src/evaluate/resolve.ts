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
