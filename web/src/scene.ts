/**
 * Scene types. Every structural type comes from scene.gen.ts, which is generated from
 * spec/scene.schema.json, and the types therefore cannot drift apart from the schema. The aliases below
 * only name parts that the generator, web/scripts/gen-types.mjs, leaves anonymous.
 */
import type { Layer, State, TrackSet, Variable } from './scene.gen.js';

export type * from './scene.gen.js';

export type ChannelDef = NonNullable<NonNullable<TrackSet['channels']>[string]>;
export type ParameterDef = NonNullable<NonNullable<TrackSet['parameters']>[string]>;
export type TrackLayer = Extract<Layer, { kind: 'track' }>;
export type BodyLayer = Extract<Layer, { kind: 'body' }>;
export type MarkLayer = Extract<Layer, { kind: 'axes' | 'grid' }>;
export type Selector = Extract<Variable, { kind: 'selector' }>;
export type Choice = Extract<Variable, { kind: 'choice' }>;
export type Toggle = Extract<Variable, { kind: 'toggle' }>;
export type PanelState = NonNullable<State['panels'][string]>;
export type VariableValue = number | string | boolean;

/** The scene format version this reader implements. */
export const SCENE_MAJOR = 0;
export const SCENE_MINOR = 3;

/** Features from `requires` that this reader implements. Version 0.3 of the format does not include any feature of section 4. */
export const SUPPORTED_FEATURES: ReadonlySet<string> = new Set();

export const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'format',
  'version',
  'requires',
  'generator',
  'title',
  'theme',
  'frames',
  'bodies',
  'track_sets',
  'variables',
  'clock',
  'views',
  'controls',
  'readouts',
  'initial',
]);

export const ID_PATTERN = /^[A-Za-z0-9_.-]+$/;
export const INDEX_CHANNEL = '@index';
