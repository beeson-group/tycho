/**
 * Scene types. Every structural type comes from scene.gen.ts, which is generated from
 * spec/scene.schema.json, and the types therefore cannot drift apart from the schema. The aliases below
 * only name parts that the generator, web/scripts/gen-types.mjs, leaves anonymous.
 */
import type { Input, Layer, State, TrajectorySet } from './scene.gen.js';

export type * from './scene.gen.js';

export type ChannelDef = NonNullable<NonNullable<TrajectorySet['channels']>[string]>;
export type ParameterDef = NonNullable<NonNullable<TrajectorySet['parameters']>[string]>;
export type TrajectoriesLayer = Extract<Layer, { kind: 'trajectories' }>;
export type ArrowLayer = Extract<Layer, { kind: 'arrow' }>;
export type InsetBoxLayer = Extract<Layer, { kind: 'inset_box' }>;
export type BodyLayer = Extract<Layer, { kind: 'body' }>;
export type MarkLayer = Extract<Layer, { kind: 'axes' | 'grid' }>;
export type LabelLayer = Extract<Layer, { kind: 'label' }>;
export type PointsLayer = Extract<Layer, { kind: 'points' }>;
export type ParameterInput = Extract<Input, { kind: 'parameter' }>;
export type Choice = Extract<Input, { kind: 'choice' }>;
export type Toggle = Extract<Input, { kind: 'toggle' }>;
export type ShownPanel = NonNullable<State['panels'][string]>;
export type InputValue = number | string | boolean;

/** The scene format version this reader implements. */
export const SCENE_MAJOR = 0;
export const SCENE_MINOR = 5;

/** Features from `requires` that this reader implements, i.e. the features of section 4 that version 0.5 of the format includes. */
export const SUPPORTED_FEATURES: ReadonlySet<string> = new Set([
  'frames.origin_channel',
  'layers.arrows',
  'layers.read_from',
  'layers.inset_box',
  'clock.keyframes',
  'layers.clock',
  'camera.keyframes',
  'layers.label',
  'layers.points',
]);

export const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'format',
  'version',
  'requires',
  'generator',
  'title',
  'theme',
  'frames',
  'bodies',
  'trajectory_sets',
  'inputs',
  'clock',
  'panels',
  'controls',
  'readouts',
  'initial',
  'steps',
  'overlays',
]);

export const ID_PATTERN = /^[A-Za-z0-9_.-]+$/;
export const INDEX_CHANNEL = '@index';
/** The built-in parameter whose value is the number of the member in its set. */
export const INDEX_PARAMETER = '@index';
