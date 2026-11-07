/**
 * The checks a reader makes before evaluating a scene. `validate` throws a TychoError that gives the
 * rule, and returns warnings for what a reader only reports: unknown top-level keys (section 2)
 * and a panel value of a scene-scoped variable (rule V1).
 */
import type { DataStore } from './container.js';
import { fail } from './errors.js';
import { clockLaps } from './evaluate/clock.js';
import { Frames } from './evaluate/frames.js';
import { hasHead } from './evaluate/layers.js';
import { checkState, displayFrame, layerVisible, layoutIds, oneSet, querySets, variableDef, type PanelScope } from './evaluate/resolve.js';
import { SetCache } from './evaluate/sets.js';
import {
  ID_PATTERN,
  INDEX_CHANNEL,
  SCENE_MAJOR,
  SCENE_MINOR,
  SUPPORTED_FEATURES,
  TOP_LEVEL_KEYS,
  type ConstantScalar,
  type Layout,
  type MemberRef,
  type Scalar,
  type Scene,
  type SetQuery,
  type State,
  type Trail,
  type TrackLayer,
} from './scene.js';

const LAYER_KINDS = ['track', 'body', 'axes', 'grid'];
const CONTROL_KINDS = ['slider', 'tabs', 'toggle', 'transport'];
const COLORMAPS = ['viridis', 'plasma', 'cividis', 'blues', 'reds'];

const checkId = (id: string, what: string): void => {
  if (!ID_PATTERN.test(id)) fail('S3', `${what} ${JSON.stringify(id)} does not match [A-Za-z0-9_.-]+`);
};

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const COLOR = /^#[0-9a-fA-F]{6}$/;

/** Adds a warning for each key of `value` outside `known`. An unknown key is a warning at every level that the schema closes (section 2). */
function unknownKeys(value: unknown, known: readonly string[], where: string, warnings: string[]): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  for (const k of Object.keys(value)) if (!known.includes(k)) warnings.push(`${where} has a key ${JSON.stringify(k)} that this reader does not know`);
}

const FRAME_KEYS = ['label', 'axes', 'unit', 'parent', 'origin', 'rotation', 'scale'];
const BODY_KEYS = ['label', 'frame', 'position', 'color'];
const SET_KEYS = ['label', 'frame', 'tags', 'attrs', 'tracks', 'offsets', 'positions', 'channels', 'parameters', 'periodic'];
const VIEW_KEYS = ['label', 'frame', 'camera', 'driver', 'layers'];
const LAYER_KEYS: Record<string, readonly string[]> = {
  track: ['kind', 'sets', 'members', 'reveal', 'trail', 'head', 'before', 'after', 'color', 'opacity', 'width', 'highlight', 'visible'],
  body: ['kind', 'body', 'trail', 'size', 'visible'],
  axes: ['kind', 'span', 'visible'],
  grid: ['kind', 'labels', 'visible'],
};
const CLOCK_KEYS = ['mode', 'channels', 'labels', 'steps', 'range', 'laps'];
const THEME_KEYS = ['background', 'foreground', 'grid'];

/** Checks the format, the version, and `requires` (rule S1 and section 2). */
function checkVersion(scene: Scene): void {
  if (scene.format !== 'tycho-scene') fail('2', `the format is ${JSON.stringify(scene.format)}, not "tycho-scene"`);
  const problems: string[] = [];
  const m = /^([0-9]+)\.([0-9]+)$/.exec(String(scene.version));
  if (m === null) problems.push(`version ${JSON.stringify(scene.version)} is not "major.minor"`);
  else if (Number(m[1]) !== SCENE_MAJOR) problems.push(`major version ${m[1]} is unknown to this reader, which reads ${SCENE_MAJOR}.x`);
  else if (SCENE_MAJOR === 0 && Number(m[2]) > SCENE_MINOR)
    problems.push(`version ${m[1]}.${m[2]} is newer than this reader's ${SCENE_MAJOR}.${SCENE_MINOR}, and the format is unstable until 1.0`);
  const missing = (scene.requires ?? []).filter((f) => !SUPPORTED_FEATURES.has(f));
  if (missing.length > 0) problems.push(`the required features ${missing.join(', ')} are not implemented`);
  if (problems.length > 0) fail('S1', problems.join(', and '));
}
