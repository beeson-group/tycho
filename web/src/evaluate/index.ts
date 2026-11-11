/**
 * The pure evaluator of section 3 of spec/tycho-scene.md. For every panel of a state, it returns
 * the display frame and one entry per layer, computed in float64 throughout. It throws a TychoError
 * for a scene it cannot evaluate. It does not run every check of validate().
 */
import type { DataStore } from '../container.js';
import { fail } from '../errors.js';
import type { Scene, State, TrackLayer, View } from '../scene.js';
import { clockLaps, progress } from './clock.js';
import { Frames } from './frames.js';
import { arrowLayer, bodyLayer, labelLayer, layerEnv, outlineLayer, pointsLayer, targetPoint, trackLayer, type Driver, type LayerEnv } from './layers.js';
import { cameraWindow, checkCameraKeys, planeAxes, timeAt, type CameraKey } from './timeline.js';
import { checkState, displayFrame, driverMember, layerVisible, oneSet, type PanelScope } from './resolve.js';
import { INDEX_CHANNEL } from '../scene.js';
import { SetCache } from './sets.js';
import type { CameraResult, EvaluateResult, LayerResult, PanelResult } from './types.js';

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
      if (!LAYER_KINDS.includes(layer.kind)) fail('S1', `layer kind ${JSON.stringify(layer.kind)} is not implemented`);
      if (!layerVisible(scope, layer)) continue;
      if (layer.kind === 'track') {
        const id = oneSet(scope, layer.sets);
        layers.push(trackLayer(layerEnv(env, layer), layer, id === null ? null : sets.get(id), driver));
      } else if (layer.kind === 'arrow') {
        const id = oneSet(scope, layer.sets);
        layers.push(arrowLayer(layerEnv(env, layer), layer, id === null ? null : sets.get(id)));
      } else if (layer.kind === 'outline') {
        layers.push(outlineLayer(env, layer, driver));
      } else if (layer.kind === 'body') {
        layers.push(bodyLayer(env, layer, driver));
      } else if (layer.kind === 'points') {
        const id = oneSet(scope, layer.sets);
        layers.push(pointsLayer(env, layer, id === null ? null : sets.get(id)));
      } else if (layer.kind === 'label') {
        const at = layer.at as { sets?: unknown };
        const id = at !== null && typeof at === 'object' && 'sets' in at ? oneSet(scope, at.sets as never) : null;
        layers.push(labelLayer(env, layer, id === null ? null : sets.get(id), driver));
      } else {
        layers.push({ kind: layer.kind });
      }
    }
    const result: PanelResult = { frame: display, layers };
    if (view.camera?.kind === 'plane' && view.camera.keys !== undefined) result.camera = cameraAt(env, view, sets, driver);
    panels[pid] = result;
  }
  return { panels };
}

const LAYER_KINDS = ['track', 'arrow', 'outline', 'body', 'axes', 'grid', 'label', 'points'];

/**
 * The window of a plane camera with keys at the environment's progress (rule K5). A follow key's center is the mean of its targets'
 * points, projected onto the plane, plus its offset, and its `center` when every target's set query fails to match.
 */
export function cameraAt(env: LayerEnv, view: View, sets: SetCache, driver: Driver): CameraResult | null {
  const cam = view.camera as Extract<View['camera'], { kind: 'plane' }> & {};
  checkCameraKeys(cam.keys, cam.aspect === 'free', 'the camera');
  const keys = cam.keys as unknown as CameraKey[];
  const [ix, iy] = planeAxes(cam);
  const s = timeAt(env.clock, env.q);
  const center = (i: number): [number, number] | null => {
    const k = keys[i]!;
    if (k.follow === undefined) return k.center ?? null;
    let n = 0;
    let x = 0;
    let y = 0;
    for (const t of k.follow) {
      const layer = view.layers[t.layer];
      if (layer === undefined || layer.kind !== 'track') fail('K5', `a camera key follows layer ${t.layer}, which is not a track layer of the view`);
      const id = oneSet(env.scope, (layer as TrackLayer).sets);
      const p = targetPoint(env, layer as TrackLayer, id === null ? null : sets.get(id), t.member, driver);
      if (p === null) continue;
      x += p[ix]!;
      y += p[iy]!;
      n++;
    }
    if (n === 0) return k.center ?? null;
    const o = k.offset ?? [0, 0];
    return [x / n + o[0], y / n + o[1]];
  };
  return cameraWindow(keys, s, center);
}
