/**
 * The pure evaluator of section 3 of spec/tycho-scene.md. For every panel of a state, it returns
 * the display frame and one entry per layer, computed in float64 throughout. It throws a TychoError
 * for a scene it cannot evaluate. It does not run every check of validate().
 */
import type { DataStore } from '../container.js';
import { fail } from '../errors.js';
import type { Panel, Scene, State, TrajectoriesLayer } from '../scene.js';
import { clockRevolutions, progress } from './clock.js';
import { Frames } from './frames.js';
import {
  arrowLayer,
  bodyLayer,
  labelLayer,
  layerEnv,
  insetBoxLayer,
  pointsLayer,
  targetPoint,
  trajectoriesLayer,
  type Reference,
  type LayerEnv,
} from './layers.js';
import { cameraWindow, checkCameraKeyframes, planeAxes, timeAt, type CameraKeyframe } from './timeline.js';
import { checkState, displayFrame, referenceMember, layerVisible, oneSet, type PanelScope } from './resolve.js';
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
  const revolutions = clockRevolutions(scene.clock);
  const channel = state.clock.channel;
  const q = progress(scene.clock.frame_count, frameIndex);
  // a null prototype, so that a panel id like "__proto__" is an own key of the result
  const panels: Record<string, PanelResult> = Object.create(null) as Record<string, PanelResult>;
  for (const [pid, panel] of Object.entries(state.panels)) {
    const declared = scene.panels[panel!.panel]!;
    const scope: PanelScope = { scene, state, panel: panel! };
    const display = displayFrame(scope, declared);
    // the reference is resolved for every panel, whether or not a layer uses it (section 2.7)
    const referenceId = oneSet(scope, declared.reference.sets);
    const reference = referenceId === null ? null : { set: sets.get(referenceId), trajectory: 0 };
    if (reference) {
      reference.trajectory = referenceMember(scope, declared.reference.member, reference.set);
      const missing = scene.clock.channels.filter((c) => c !== INDEX_CHANNEL && !reference.set.hasChannel(c));
      if (missing.length > 0)
        fail('clock-channel-carried', `the reference trajectory's trajectory set ${reference.set.id} lacks clock channels ${missing.join(', ')}`);
      if (revolutions > 1 && !reference.set.periodic)
        fail('revolutions', `the reference trajectory's trajectory set ${reference.set.id} is not periodic, and the clock has ${revolutions} revolutions`);
    }
    const env: LayerEnv = { scope, frames, clock: scene.clock, channel, q, display };
    const layers: LayerResult[] = [];
    for (const layer of declared.layers) {
      if (!LAYER_KINDS.includes(layer.kind)) fail('version', `layer kind ${JSON.stringify(layer.kind)} is not implemented`);
      if (!layerVisible(scope, layer)) continue;
      if (layer.kind === 'trajectories') {
        const id = oneSet(scope, layer.sets);
        layers.push(trajectoriesLayer(layerEnv(env, layer), layer, id === null ? null : sets.get(id), reference));
      } else if (layer.kind === 'arrow') {
        const id = oneSet(scope, layer.sets);
        layers.push(arrowLayer(layerEnv(env, layer), layer, id === null ? null : sets.get(id)));
      } else if (layer.kind === 'inset_box') {
        layers.push(insetBoxLayer(env, layer, reference));
      } else if (layer.kind === 'body') {
        layers.push(bodyLayer(env, layer, reference));
      } else if (layer.kind === 'points') {
        const id = oneSet(scope, layer.sets);
        layers.push(pointsLayer(env, layer, id === null ? null : sets.get(id)));
      } else if (layer.kind === 'label') {
        const at = layer.at as { sets?: unknown };
        const id = at !== null && typeof at === 'object' && 'sets' in at ? oneSet(scope, at.sets as never) : null;
        layers.push(labelLayer(env, layer, id === null ? null : sets.get(id), reference));
      } else {
        layers.push({ kind: layer.kind });
      }
    }
    const result: PanelResult = { frame: display, layers };
    if (declared.camera?.kind === '2d' && declared.camera.keyframes !== undefined) result.camera = cameraAt(env, declared, sets, reference);
    panels[pid] = result;
  }
  return { panels };
}

const LAYER_KINDS = ['trajectories', 'arrow', 'inset_box', 'body', 'axes', 'grid', 'label', 'points'];

/** The lists of camera keyframes that passed `checkCameraKeyframes`, each with whether it was checked for a camera of free aspect. */
const checkedKeyframes = new WeakMap<object, boolean>();

/**
 * The window of a 2d camera with keyframes at the environment's progress (rule `camera-keyframes`). A follow key's center is the mean of its targets'
 * points, projected onto the plane, plus its offset, and its `center` when every target's set query fails to match.
 */
export function cameraAt(env: LayerEnv, panel: Panel, sets: SetCache, reference: Reference): CameraResult | null {
  const cam = panel.camera as Extract<Panel['camera'], { kind: '2d' }> & {};
  // a renderer asks for the window at every frame, hence a list of keyframes is checked once
  const free = cam.aspect === 'free';
  if (typeof cam.keyframes !== 'object' || cam.keyframes === null || checkedKeyframes.get(cam.keyframes) !== free) {
    checkCameraKeyframes(cam.keyframes, free, 'the camera');
    checkedKeyframes.set(cam.keyframes!, free);
  }
  const keys = cam.keyframes as unknown as CameraKeyframe[];
  const [ix, iy] = planeAxes(cam);
  const s = timeAt(env.clock, env.q);
  const center = (i: number): [number, number] | null => {
    const k = keys[i]!;
    if (k.follow === undefined) return k.center ?? null;
    let n = 0;
    let x = 0;
    let y = 0;
    for (const t of k.follow) {
      const layer = panel.layers[t.layer];
      if (layer === undefined || layer.kind !== 'trajectories')
        fail('camera-keyframes', `a camera keyframe follows layer ${t.layer}, which is not a trajectories layer of the panel`);
      const id = oneSet(env.scope, (layer as TrajectoriesLayer).sets);
      const p = targetPoint(env, layer as TrajectoriesLayer, id === null ? null : sets.get(id), t.member, reference);
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
