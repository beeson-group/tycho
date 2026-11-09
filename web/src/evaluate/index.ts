/**
 * The pure evaluator of section 3 of spec/tycho-scene.md. For every panel of a state, it returns
 * the display frame and one entry per layer, computed in float64 throughout. It throws a TychoError
 * for a scene it cannot evaluate. It does not run every check of validate().
 */
import type { DataStore } from '../container.js';
import { fail } from '../errors.js';
import type { Scene, State } from '../scene.js';
import { clockLaps, progress } from './clock.js';
import { Frames } from './frames.js';
import { arrowLayer, bodyLayer, outlineLayer, trackLayer, type LayerEnv } from './layers.js';
import { checkState, displayFrame, driverMember, layerVisible, oneSet, type PanelScope } from './resolve.js';
import { INDEX_CHANNEL } from '../scene.js';
import { SetCache } from './sets.js';
import type { EvaluateResult, LayerResult, PanelResult } from './types.js';

export type * from './types.js';

/**
 * Evaluates `state` at frame index `frameIndex` and returns, for every panel, the display frame and one entry per layer,
 * the same answer as pytycho.evaluate. It throws a TychoError that gives the broken rule.
 */
export function evaluate(scene: Scene, data: DataStore, state: State, frameIndex: number): EvaluateResult {
  const sets = new SetCache(scene, data);
  const frames = new Frames(scene);
  checkState(scene, state);
  const laps = clockLaps(scene.clock);
  const channel = state.clock.channel;
  const q = progress(scene.clock.steps, frameIndex);
  // a null prototype, so that a panel id like "__proto__" is an own key of the result
  const panels: Record<string, PanelResult> = Object.create(null) as Record<string, PanelResult>;
  for (const [pid, panel] of Object.entries(state.panels)) {
    const view = scene.views[panel!.view]!;
    const scope: PanelScope = { scene, state, panel: panel! };
    const display = displayFrame(scope, view);
    // the driver is resolved for every panel, whether or not a layer uses it (section 2.7)
    const driverId = oneSet(scope, view.driver.sets);
    const driver = driverId === null ? null : { set: sets.get(driverId), track: 0 };
    if (driver) {
      driver.track = driverMember(scope, view.driver.member, driver.set);
      const missing = scene.clock.channels.filter((c) => c !== INDEX_CHANNEL && !driver.set.hasChannel(c));
      if (missing.length > 0) fail('C5', `the driver's track set ${driver.set.id} lacks clock channels ${missing.join(', ')}`);
      if (laps > 1 && !driver.set.periodic) fail('C6', `the driver's track set ${driver.set.id} is not periodic, and the clock has ${laps} laps`);
    }
    const env: LayerEnv = { scope, frames, clock: scene.clock, channel, q, display };
    const layers: LayerResult[] = [];
    for (const layer of view.layers) {
      if (!['track', 'arrow', 'outline', 'body', 'axes', 'grid'].includes(layer.kind))
        fail('S1', `layer kind ${JSON.stringify(layer.kind)} is not implemented`);
      if (!layerVisible(scope, layer)) continue;
      if (layer.kind === 'track') {
        const id = oneSet(scope, layer.sets);
        layers.push(trackLayer(env, layer, id === null ? null : sets.get(id), driver));
      } else if (layer.kind === 'arrow') {
        const id = oneSet(scope, layer.sets);
        layers.push(arrowLayer(env, layer, id === null ? null : sets.get(id)));
      } else if (layer.kind === 'outline') {
        layers.push(outlineLayer(env, layer, driver));
      } else if (layer.kind === 'body') {
        layers.push(bodyLayer(env, layer, driver));
      } else {
        layers.push({ kind: layer.kind });
      }
    }
    panels[pid] = { frame: display, layers };
  }
  return { panels };
}
