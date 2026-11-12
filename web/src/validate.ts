/**
 * The checks a reader makes before evaluating a scene. `validate` throws a TychoError that gives the
 * rule, and returns warnings for what a reader only reports: unknown top-level keys (section 2)
 * and a panel value of a scene-scoped variable (rule V1).
 */
import type { DataStore } from './container.js';
import { fail } from './errors.js';
import { clockLaps } from './evaluate/clock.js';
import { Frames } from './evaluate/frames.js';
import { arrowParts, checkOutlineView, hasHead } from './evaluate/layers.js';
import { checkState, displayFrame, layerVisible, layoutIds, oneSet, outlineTarget, querySets, variableDef, type PanelScope } from './evaluate/resolve.js';
import { SetCache } from './evaluate/sets.js';
import { checkCameraKeys, checkKeys, checkTweened, isOpacity, isPositive, loopSeconds } from './evaluate/timeline.js';
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
  type ArrowLayer,
  type OutlineLayer,
  type LabelLayer,
  type PointsLayer,
  type LayerClock,
  type Marker,
  type TextPart,
  type Box,
} from './scene.js';

const LAYER_KINDS = ['track', 'arrow', 'outline', 'body', 'axes', 'grid', 'label', 'points'];
const SHAPES = ['disc', 'ring', 'square', 'diamond', 'triangle', 'star', 'cross', 'plus'];
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
const BODY_KEYS = ['label', 'frame', 'position', 'color', 'image'];
const SET_KEYS = ['label', 'frame', 'tags', 'attrs', 'tracks', 'offsets', 'positions', 'channels', 'parameters', 'periodic'];
const VIEW_KEYS = ['label', 'frame', 'camera', 'driver', 'layers', 'opacity', 'margin'];
const PLANE_CAMERA_KEYS = ['kind', 'plane', 'aspect', 'keys'];
const ORBIT_CAMERA_KEYS = ['kind', 'projection', 'up', 'stretch', 'turn'];
const TEXT_KEYS = ['align', 'baseline', 'size', 'color', 'weight', 'linespacing', 'box', 'opacity'];
const LAYER_KEYS: Record<string, readonly string[]> = {
  track: [
    'kind',
    'sets',
    'members',
    'reveal',
    'trail',
    'head',
    'before',
    'after',
    'context',
    'fit',
    'color',
    'opacity',
    'width',
    'highlight',
    'visible',
    'clock',
    'line',
    'flat',
    'dash',
    'fill',
  ],
  arrow: ['kind', 'sets', 'members', 'vector', 'scale', 'before', 'after', 'color', 'opacity', 'width', 'head', 'visible', 'clock'],
  outline: ['kind', 'view', 'color', 'opacity', 'width', 'dash', 'min_size', 'visible'],
  body: ['kind', 'body', 'trail', 'size', 'visible', 'opacity'],
  axes: ['kind', 'span', 'visible', 'ticks', 'size', 'opacity', 'titles'],
  grid: ['kind', 'labels', 'visible', 'opacity'],
  label: ['kind', 'text', 'at', 'offset', 'leader', 'clock', 'visible', ...TEXT_KEYS],
  points: ['kind', 'sets', 'members', 'marker', 'reveal', 'before', 'after', 'clock', 'fit', 'opacity', 'visible'],
};
const CLOCK_KEYS = ['mode', 'channels', 'labels', 'steps', 'range', 'laps', 'seconds', 'keys', 'end'];
const THEME_KEYS = ['background', 'foreground', 'grid', 'font', 'gutter'];

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

function checkVariableRef(scene: Scene, id: string, kind: string | null, rule: string): void {
  const v = variableDef(scene, id);
  if (v === undefined) fail(rule, `variable ${JSON.stringify(id)} is not declared`);
  if (kind !== null && v.kind !== kind) fail(rule, `variable ${id} is a ${v.kind}, not a ${kind}`);
}

function checkScalar(s: Scalar | ConstantScalar | undefined, what: string, constant: boolean): void {
  if (s === undefined) return;
  if (typeof s === 'number') {
    if (!Number.isFinite(s)) fail('S4', `${what} is ${String(s)}, not finite`);
    return;
  }
  if ('attr' in s) {
    if (!finite(s.factor ?? 1) || !finite(s.offset ?? 0)) fail('S4', `${what} has a factor or offset that is not finite`);
    return;
  }
  if (constant) fail('F2', `${what} takes a number or an attribute, not a channel`);
  if (s.channel === INDEX_CHANNEL) fail('2.2', `${what} reads channel ${INDEX_CHANNEL}, which is not allowed in a frame edge`);
}

function checkQuery(scene: Scene, q: SetQuery): void {
  if ('set' in q) {
    if (!Object.hasOwn(scene.track_sets, q.set)) fail('V2', `the set query names ${JSON.stringify(q.set)}, which is not a track set`);
  } else {
    for (const v of Object.values(q.tags)) if (typeof v === 'object' && v !== null) checkVariableRef(scene, v.var, 'choice', 'V2');
  }
}

const unit = (x: unknown): boolean => typeof x === 'number' && x >= 0 && x <= 1;

/** Checks a trail's fraction and taper (section 2.7). */
function checkTrail(id: string, trail: Trail): void {
  if (!(trail.fraction > 0 && trail.fraction <= 1)) fail('2.7', `view ${id}: a trail fraction is ${trail.fraction}, not in (0, 1]`);
  if (trail.taper !== undefined && !(unit(trail.taper.width ?? 0) && unit(trail.taper.opacity ?? 0))) fail('2.7', `view ${id}: a trail taper is not in [0, 1]`);
}

/** Checks a marker or a head (section 2.11), whose color the layer may give instead. */
function checkMarker(id: string, m: Marker & { glow?: unknown }, rule: string): void {
  if (m.shape !== undefined && !SHAPES.includes(m.shape))
    fail(rule, `view ${id}: a marker's shape is ${JSON.stringify(m.shape)}, not one of ${SHAPES.join(', ')}`);
  for (const key of ['color', 'edge'] as const)
    if (m[key] !== undefined && !COLOR.test(m[key])) fail(rule, `view ${id}: a marker's ${key} is ${JSON.stringify(m[key])}, not a #rrggbb color`);
  checkTweened(m.size, `view ${id}: a marker's size`, isPositive, rule);
  checkTweened(m.opacity, `view ${id}: a marker's opacity`, isOpacity, rule);
  checkTweened(m.edge_width, `view ${id}: a marker's edge_width`, (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0, rule);
}

/** Checks a layer's own clock (rule K4). */
function checkLayerClock(id: string, c: LayerClock | undefined): void {
  if (c === undefined) return;
  if (c === null || typeof c !== 'object' || typeof c.channel !== 'string')
    fail('K4', `view ${id}: a layer's clock is ${JSON.stringify(c)}, not {channel, range} or {channel, keys}`);
  if ((c.range === undefined) === (c.keys === undefined))
    fail('K4', `view ${id}: a layer's clock on ${c.channel} has ${c.range === undefined ? 'neither a range nor keys' : 'both a range and keys'}`);
  if (c.range !== undefined && !(Array.isArray(c.range) && c.range.length === 2 && c.range.every(finite)))
    fail('K4', `view ${id}: a layer's clock on ${c.channel} has range ${JSON.stringify(c.range)}, not two finite numbers`);
  if (c.keys !== undefined) checkKeys(c.keys, `view ${id}: the clock of a layer on ${c.channel}`);
}

/** Checks the parts of a readout, a label, or an overlay (section 2.9 and rule K7). */
function checkParts(scene: Scene, parts: unknown, what: string): void {
  if (typeof parts === 'string') return;
  if (!Array.isArray(parts)) fail('2.9', `${what} has text ${JSON.stringify(parts)}, not a string or a list of parts`);
  for (const p of parts as TextPart[]) {
    if (typeof p === 'string') continue;
    if (p === null || typeof p !== 'object') fail('2.9', `${what} has a part ${JSON.stringify(p)}`);
    if ('var' in p) checkVariableRef(scene, p.var, null, '2.9');
    if ('channel' in p && p.channel === INDEX_CHANNEL) fail('2.9', `${what} has a channel part naming ${INDEX_CHANNEL}, which is not allowed in a readout`);
    if ('steps' in p) {
      if (!Array.isArray(p.steps)) fail('K7', `${what} has steps ${JSON.stringify(p.steps)}, not a list of [t, text] pairs`);
      let last = -Infinity;
      for (const st of p.steps) {
        if (!Array.isArray(st) || st.length !== 2 || !finite(st[0]) || typeof st[1] !== 'string')
          fail('K7', `${what} has a step ${JSON.stringify(st)}, not [t, text]`);
        if ((st[0] as number) < last) fail('K7', `${what} has steps whose times decrease`);
        last = st[0] as number;
      }
      continue;
    }
    if ('keys' in p) checkKeys(p.keys, what);
    if ('clock' in p && !['index', 'steps', 'value', 'time'].includes(p.clock)) fail('2.9', `${what} has a clock part ${JSON.stringify(p.clock)}`);
    const f = p as { factor?: unknown; offset?: unknown; digits?: unknown; decimals?: unknown };
    if (!finite(f.factor ?? 1) || !finite(f.offset ?? 0)) fail('S4', `${what} has a part whose factor or offset is not finite`);
    if (f.digits !== undefined && !(Number.isInteger(f.digits) && (f.digits as number) >= 1 && (f.digits as number) <= 17))
      fail('2.9', `${what} has digits ${String(f.digits)}, not in 1 to 17`);
    if (f.decimals !== undefined && !(Number.isInteger(f.decimals) && (f.decimals as number) >= 0 && (f.decimals as number) <= 17))
      fail('K7', `${what} has decimals ${String(f.decimals)}, not in 0 to 17`);
    if (f.digits !== undefined && f.decimals !== undefined) fail('K7', `${what} has a part with both digits and decimals`);
    const width = (p as { width?: unknown }).width;
    if (width !== undefined && !(Number.isInteger(width) && (width as number) >= 0 && (width as number) <= 40))
      fail('K7', `${what} has width ${String(width)}, not in 0 to 40`);
  }
}

/** Checks the style of a label or a text overlay (rule K6). */
function checkTextStyle(
  id: string,
  t: { align?: unknown; baseline?: unknown; size?: unknown; color?: unknown; weight?: unknown; linespacing?: unknown; box?: Box; opacity?: unknown },
): void {
  if (t.align !== undefined && !['start', 'center', 'end'].includes(t.align as string)) fail('K6', `${id}: an align is ${JSON.stringify(t.align)}`);
  if (t.baseline !== undefined && !['top', 'middle', 'bottom', 'alphabetic'].includes(t.baseline as string))
    fail('K6', `${id}: a baseline is ${JSON.stringify(t.baseline)}`);
  if (t.size !== undefined && !isPositive(t.size)) fail('K6', `${id}: a text size is ${JSON.stringify(t.size)}, not positive`);
  if (t.color !== undefined && !COLOR.test(t.color as string)) fail('K6', `${id}: a text color is ${JSON.stringify(t.color)}, not #rrggbb`);
  if (t.weight !== undefined && t.weight !== 'normal' && t.weight !== 'bold') fail('K6', `${id}: a weight is ${JSON.stringify(t.weight)}, not normal or bold`);
  if (t.linespacing !== undefined && !isPositive(t.linespacing)) fail('K6', `${id}: a linespacing is ${JSON.stringify(t.linespacing)}, not positive`);
  checkTweened(t.opacity, `${id}: an opacity`, isOpacity, 'K6');
  const b = t.box;
  if (b !== undefined) {
    for (const key of ['fill', 'edge'] as const) if (b[key] !== undefined && !COLOR.test(b[key])) fail('K6', `${id}: a box ${key} is not #rrggbb`);
    if (b.opacity !== undefined && !unit(b.opacity)) fail('K6', `${id}: a box opacity is not in [0, 1]`);
  }
}

function checkLabelLayer(scene: Scene, id: string, layer: LabelLayer): void {
  checkParts(scene, layer.text, `view ${id}: a label`);
  checkTextStyle(`view ${id}`, layer);
  checkLayerClock(id, layer.clock);
  const at = layer.at as Record<string, unknown>;
  if (at === null || typeof at !== 'object') fail('K6', `view ${id}: a label's anchor is ${JSON.stringify(at)}`);
  if ('point' in at) {
    const pt = at.point as unknown;
    if (!Array.isArray(pt) || pt.length !== 3 || !pt.every(finite))
      fail('K6', `view ${id}: a label's point is ${JSON.stringify(pt)}, not three finite numbers`);
    if (at.frame !== undefined && !Object.hasOwn(scene.frames, at.frame as string))
      fail('K6', `view ${id}: a label's point is in frame ${JSON.stringify(at.frame)}, which is not declared`);
  } else if ('sets' in at) {
    checkQuery(scene, at.sets as SetQuery);
    if (!Number.isInteger(at.member) || (at.member as number) < 0)
      fail('K6', `view ${id}: a label's member is ${JSON.stringify(at.member)}, not a track index`);
  } else if ('screen' in at) {
    const sc = at.screen as unknown;
    if (!Array.isArray(sc) || sc.length !== 2 || !sc.every(finite))
      fail('K6', `view ${id}: a label's screen place is ${JSON.stringify(sc)}, not two fractions`);
  } else fail('K6', `view ${id}: a label's anchor is ${JSON.stringify(at)}, not a point, a member, or a place on the screen`);
  const off = layer.offset as unknown;
  if (off !== undefined && !(Array.isArray(off) && off.length === 2 && off.every(finite)))
    fail('K6', `view ${id}: a label's offset is ${JSON.stringify(off)}, not two lengths`);
  const lead = layer.leader;
  if (lead !== undefined && typeof lead === 'object' && lead.color !== undefined && !COLOR.test(lead.color))
    fail('K6', `view ${id}: a leader's color is not #rrggbb`);
}

function checkPointsLayer(scene: Scene, id: string, layer: PointsLayer): void {
  checkMembers(scene, id, layer);
  const reveal = layer.reveal ?? 'none';
  if (reveal !== 'none' && reveal !== 'grow') fail('K8', `view ${id}: a points layer's reveal is ${JSON.stringify(reveal)}, not none or grow`);
  for (const key of ['before', 'after'] as const) {
    if (layer[key] !== undefined && layer[key] !== 'clamp' && layer[key] !== 'hidden')
      fail('C3', `view ${id}: a points layer's ${key} is ${JSON.stringify(layer[key])}, not clamp or hidden`);
  }
  if (layer.marker !== undefined) checkMarker(id, layer.marker, 'K8');
  checkTweened(layer.opacity, `view ${id}: a points layer's opacity`, isOpacity);
  checkLayerClock(id, layer.clock);
}

function checkMembers(scene: Scene, id: string, layer: TrackLayer | ArrowLayer | PointsLayer): void {
  checkQuery(scene, layer.sets);
  if (typeof layer.members === 'object' && 'var' in layer.members) checkVariableRef(scene, layer.members.var, 'selector', 'V3');
  if (typeof layer.members === 'object' && 'count' in layer.members && !(Number.isInteger(layer.members.count) && layer.members.count >= 1)) {
    fail('V3', `view ${id}: member count ${JSON.stringify(layer.members.count)} is not an integer of at least one`);
  }
}

function checkArrowLayer(scene: Scene, id: string, layer: ArrowLayer): void {
  checkMembers(scene, id, layer);
  arrowParts(layer);
  for (const key of ['before', 'after'] as const) {
    if (layer[key] !== undefined && layer[key] !== 'clamp' && layer[key] !== 'hidden')
      fail('C3', `view ${id}: an arrow layer's ${key} is ${JSON.stringify(layer[key])}, not clamp or hidden`);
  }
  if (layer.color !== undefined && !COLOR.test(layer.color))
    fail('L7', `view ${id}: an arrow layer's color is ${JSON.stringify(layer.color)}, not a #rrggbb color`);
  if (layer.head?.size !== undefined && !(layer.head.size > 0)) fail('L7', `view ${id}: an arrowhead size is ${layer.head.size}, not positive`);
  checkTweened(layer.opacity, `view ${id}: an arrow layer's opacity`, isOpacity);
  if (layer.width !== undefined && !(layer.width > 0)) fail('2.7', `view ${id}: an arrow layer's width is ${layer.width}, not positive`);
  checkLayerClock(id, layer.clock);
}

function checkOutlineLayer(scene: Scene, id: string, layer: OutlineLayer): void {
  checkOutlineView(scene, id, layer);
  if (layer.color !== undefined && !COLOR.test(layer.color))
    fail('L8', `view ${id}: an outline layer's color is ${JSON.stringify(layer.color)}, not a #rrggbb color`);
  checkTweened(layer.opacity, `view ${id}: an outline layer's opacity`, isOpacity);
  if (layer.width !== undefined && !(layer.width > 0)) fail('2.7', `view ${id}: an outline layer's width is ${layer.width}, not positive`);
  const dash = layer.dash as unknown;
  if (dash !== undefined && !(Array.isArray(dash) && dash.length === 2 && dash.every((d) => finite(d) && d > 0)))
    fail('L8', `view ${id}: an outline layer's dash is ${JSON.stringify(dash)}, not two positive lengths`);
  if (layer.min_size !== undefined && !(finite(layer.min_size) && layer.min_size >= 0))
    fail('L8', `view ${id}: an outline layer's min_size is ${layer.min_size}, not a nonnegative length`);
}

function checkTrackLayer(scene: Scene, id: string, layer: TrackLayer): void {
  checkMembers(scene, id, layer);
  if (layer.fit !== undefined && typeof layer.fit !== 'boolean') fail('2.7', `view ${id}: a track layer's fit is ${JSON.stringify(layer.fit)}, not a boolean`);
  const hl = layer.highlight;
  if (hl !== undefined) {
    checkVariableRef(scene, hl.var, 'selector', '2.7');
    if (hl.width !== undefined && !(hl.width > 0)) fail('2.7', `view ${id}: a highlight width is ${hl.width}, not positive`);
    if (hl.opacity !== undefined && !unit(hl.opacity)) fail('2.7', `view ${id}: a highlight opacity is ${hl.opacity}, not in [0, 1]`);
    if (hl.kernel !== undefined) {
      if (!(hl.kernel.width > 0 && hl.kernel.width <= 1)) fail('2.7', `view ${id}: a highlight kernel's width is ${hl.kernel.width}, not in (0, 1]`);
      if (!unit(hl.kernel.opacity)) fail('2.7', `view ${id}: a highlight kernel's opacity is ${hl.kernel.opacity}, not in [0, 1]`);
      const sel = variableDef(scene, hl.var);
      if (sel?.kind === 'selector' && sel.by === 'index') fail('2.7', `view ${id}: a highlight kernel needs a selector by nearest, and ${hl.var} is by index`);
    }
  }
  const reveal = layer.reveal ?? 'none';
  if (!['none', 'grow', 'trail'].includes(reveal)) fail('2.7', `view ${id}: a track layer's reveal is ${JSON.stringify(reveal)}, not none, grow, or trail`);
  if (reveal === 'trail' && layer.trail === undefined) fail('2.7', `view ${id}: a track layer has reveal "trail" but lacks a trail`);
  if (layer.trail !== undefined) checkTrail(id, layer.trail);
  if (layer.head !== undefined && typeof layer.head !== 'boolean') {
    if (typeof layer.head !== 'object' || layer.head === null)
      fail('L3', `view ${id}: a track layer's head is ${JSON.stringify(layer.head)}, not a boolean or an object`);
    if (layer.head.color !== undefined && !COLOR.test(layer.head.color))
      fail('L3', `view ${id}: a head color is ${JSON.stringify(layer.head.color)}, not a #rrggbb color`);
    checkMarker(id, layer.head, 'L3');
    const glow = layer.head.glow;
    if (glow !== undefined) {
      if (typeof glow.channel !== 'string' || glow.channel === INDEX_CHANNEL) fail('2.7', `view ${id}: a glow names channel ${JSON.stringify(glow.channel)}`);
      if (glow.color !== undefined && !COLOR.test(glow.color)) fail('2.7', `view ${id}: a glow's color is not #rrggbb`);
      if (glow.size !== undefined && !isPositive(glow.size)) fail('2.7', `view ${id}: a glow's size is not positive`);
      if (glow.opacity !== undefined && !unit(glow.opacity)) fail('2.7', `view ${id}: a glow's opacity is not in [0, 1]`);
    }
  }
  if (layer.line !== undefined && typeof layer.line !== 'boolean')
    fail('2.7', `view ${id}: a track layer's line is ${JSON.stringify(layer.line)}, not a boolean`);
  if (layer.flat !== undefined && typeof layer.flat !== 'boolean')
    fail('2.7', `view ${id}: a track layer's flat is ${JSON.stringify(layer.flat)}, not a boolean`);
  const dash = layer.dash as unknown;
  if (dash !== undefined && !(Array.isArray(dash) && dash.length === 2 && dash.every((d) => finite(d) && d > 0)))
    fail('2.7', `view ${id}: a track layer's dash is ${JSON.stringify(dash)}, not two positive lengths`);
  if (layer.fill !== undefined) {
    if (layer.fill.base !== undefined && !finite(layer.fill.base)) fail('S4', `view ${id}: a fill's base is not finite`);
    if (layer.fill.color !== undefined && !COLOR.test(layer.fill.color)) fail('2.7', `view ${id}: a fill's color is not #rrggbb`);
    if (layer.fill.opacity !== undefined && !unit(layer.fill.opacity)) fail('2.7', `view ${id}: a fill's opacity is not in [0, 1]`);
  }
  checkLayerClock(id, layer.clock);
  for (const key of ['before', 'after'] as const) {
    if (layer[key] !== undefined && layer[key] !== 'clamp' && layer[key] !== 'hidden')
      fail('C3', `view ${id}: a track layer's ${key} is ${JSON.stringify(layer[key])}, not clamp or hidden`);
  }
  if (layer.context !== undefined && layer.context !== 'own' && layer.context !== 'driver')
    fail('L6', `view ${id}: a track layer's context is ${JSON.stringify(layer.context)}, not own or driver`);
  checkTweened(layer.opacity, `view ${id}: a track layer's opacity`, isOpacity);
  if (layer.width !== undefined && !(layer.width > 0)) fail('2.7', `view ${id}: a track layer's width is ${layer.width}, not positive`);
  if (layer.color !== undefined && typeof layer.color === 'object' && 'steps' in layer.color) {
    const c = layer.color;
    if (!Array.isArray(c.steps) || c.steps.length === 0 || !c.steps.every(finite) || c.steps.some((x, i) => i > 0 && !(x > c.steps[i - 1]!)))
      fail('2.7', `view ${id}: a stepped color's steps are ${JSON.stringify(c.steps)}, not increasing finite numbers`);
    if (!Array.isArray(c.colors) || c.colors.length !== c.steps.length + 1 || !c.colors.every((x) => COLOR.test(x)))
      fail('2.7', `view ${id}: a stepped color has ${JSON.stringify(c.colors)} for ${c.steps.length} steps, not one #rrggbb color more than steps`);
  } else if (layer.color !== undefined && typeof layer.color === 'object') {
    const cmap = layer.color.colormap;
    if (typeof cmap === 'object' && cmap !== null) {
      // a colormap keyed on a choice gives a colormap for every value of the choice, and only for these values
      checkVariableRef(scene, cmap.var, 'choice', '2.7');
      const values = (variableDef(scene, cmap.var) as { values: string[] }).values;
      const keys = Object.keys(cmap.map ?? {});
      const missing = values.filter((v) => !Object.hasOwn(cmap.map, v));
      const extra = keys.filter((k) => !values.includes(k));
      if (missing.length > 0) fail('2.7', `view ${id}: a colormap keyed on ${cmap.var} does not name a colormap for ${JSON.stringify(missing)}`);
      if (extra.length > 0) fail('2.7', `view ${id}: a colormap keyed on ${cmap.var} maps ${JSON.stringify(extra)}, which are not its values`);
      for (const k of keys)
        if (!COLORMAPS.includes(cmap.map[k]!)) fail('2.7', `view ${id}: the colormap ${JSON.stringify(cmap.map[k])} is not one of ${COLORMAPS.join(', ')}`);
    } else if (!COLORMAPS.includes(cmap)) fail('2.7', `view ${id}: the colormap ${JSON.stringify(cmap)} is not one of ${COLORMAPS.join(', ')}`);
    if ('parameter' in layer.color === 'channel' in layer.color) fail('2.7', `view ${id}: a colormap color names both or neither of parameter and channel`);
  }
}

/** Checks a scene, and its data and a state when given. Returns the warnings. */
export function validate(scene: Scene, data?: DataStore, state?: State): string[] {
  const warnings: string[] = [];
  checkVersion(scene);
  for (const k of Object.keys(scene))
    if (!TOP_LEVEL_KEYS.has(k)) warnings.push(`the scene has a top-level key ${JSON.stringify(k)} that this reader does not know`);
  unknownKeys(scene.theme, THEME_KEYS, 'the theme', warnings);
  for (const [k, v] of Object.entries(scene.theme ?? {})) {
    if (k === 'font') {
      if (typeof v !== 'string') fail('2', `theme font is ${JSON.stringify(v)}, not a CSS font family`);
    } else if (typeof v !== 'string' || !COLOR.test(v)) fail('2', `theme ${k} is ${JSON.stringify(v)}, not a #rrggbb color`);
  }
  unknownKeys(scene.clock, CLOCK_KEYS, 'the clock', warnings);
  for (const [id, f] of Object.entries(scene.frames)) unknownKeys(f, FRAME_KEYS, `frame ${id}`, warnings);
  for (const [id, b] of Object.entries(scene.bodies ?? {})) {
    unknownKeys(b, BODY_KEYS, `body ${id}`, warnings);
    if (b!.color !== undefined && !COLOR.test(b!.color)) fail('2.4', `body ${id} has color ${JSON.stringify(b!.color)}, not #rrggbb`);
  }
  for (const [id, s] of Object.entries(scene.track_sets)) unknownKeys(s, SET_KEYS, `track set ${id}`, warnings);
  for (const [id, v] of Object.entries(scene.views)) {
    unknownKeys(v, VIEW_KEYS, `view ${id}`, warnings);
    if (v!.camera !== undefined)
      unknownKeys(v!.camera, v!.camera.kind === 'orbit' ? ORBIT_CAMERA_KEYS : PLANE_CAMERA_KEYS, `the camera of view ${id}`, warnings);
    for (const layer of v!.layers)
      if (Object.hasOwn(LAYER_KEYS, layer.kind)) unknownKeys(layer, LAYER_KEYS[layer.kind]!, `a ${layer.kind} layer of view ${id}`, warnings);
  }
  for (const [what, table] of [
    ['frame', scene.frames],
    ['body', scene.bodies],
    ['track set', scene.track_sets],
    ['variable', scene.variables],
    ['view', scene.views],
  ] as const) {
    for (const id of Object.keys(table ?? {})) checkId(id, what);
  }

  // The Frames constructor checks the frame tree: one root without edge fields, scales that are not a constant zero, and rule F6.
  // It also checks that every body origin refers to a declared body.
  const frames = new Frames(scene);
  const isFrame = (id: string) => frames.tree.has(id);
  for (const [id, f] of Object.entries(scene.frames)) {
    if (Array.isArray(f!.origin)) f!.origin.forEach((s) => checkScalar(s, `the origin of frame ${id}`, false));
    checkScalar(f!.rotation?.angle, `the rotation of frame ${id}`, false);
    checkScalar(f!.scale, `the scale of frame ${id}`, false);
    if (f!.axes !== undefined && f!.axes.length !== 3) fail('2.3', `frame ${id} has ${f!.axes.length} axis labels, not three`);
  }
  for (const [id, b] of Object.entries(scene.bodies ?? {})) {
    if (!isFrame(b!.frame)) fail('2.4', `body ${id} is in frame ${b!.frame}, which is not declared`);
    b!.position.forEach((s) => checkScalar(s, `the position of body ${id}`, true));
  }
  if (Object.keys(scene.track_sets).length === 0) fail('2.1', 'the scene does not have a track set');
  for (const [id, s] of Object.entries(scene.track_sets)) {
    if (!isFrame(s!.frame)) fail('2.1', `track set ${id} is in frame ${s!.frame}, which is not declared`);
    if (!Number.isInteger(s!.tracks) || s!.tracks < 1) fail('2.1', `track set ${id} has tracks ${String(s!.tracks)}, not a count of at least one`);
    if (Object.hasOwn(s!.channels ?? {}, INDEX_CHANNEL)) fail('S3', `track set ${id} declares a channel named ${INDEX_CHANNEL}, which is reserved`);
    for (const [k, v] of Object.entries(s!.attrs ?? {})) if (!finite(v)) fail('S4', `attribute ${k} of track set ${id} is not finite`);
  }
  for (const [name, v] of Object.entries(scene.variables ?? {})) {
    if (v!.kind === 'selector') {
      if (v!.by !== 'index' && v!.parameter === undefined) fail('2.5', `selector ${name} is by nearest but does not name a parameter`);
      if (!finite(v!.default)) fail('2.5', `selector ${name} defaults to ${String(v!.default)}, not a finite number`);
    } else if (v!.kind === 'choice') {
      if (!v!.values.includes(v!.default)) fail('2.5', `choice ${name} defaults to ${JSON.stringify(v!.default)}, which is not one of its values`);
      if (v!.labels !== undefined && v!.labels.length !== v!.values.length)
        fail('2.5', `choice ${name} has ${v!.labels.length} labels for ${v!.values.length} values`);
    } else if (v!.kind === 'toggle') {
      const d: unknown = v!.default;
      if (typeof d !== 'boolean') fail('2.5', `toggle ${name} defaults to ${JSON.stringify(d)}, not a boolean`);
    } else fail('2.5', `variable ${name} has kind ${JSON.stringify((v as { kind: unknown }).kind)}, not selector, choice, or toggle`);
  }
  const clock = scene.clock;
  if (clock.mode !== 'fraction' && clock.mode !== 'value') fail('2.6', `the clock mode is ${JSON.stringify(clock.mode)}, not fraction or value`);
  if (!Number.isInteger(clock.steps) || clock.steps < 1) fail('2.6', `the clock has steps ${String(clock.steps)}, not a count of at least one`);
  if (clock.mode === 'value') {
    if (clock.range !== undefined && clock.keys !== undefined) fail('K3', 'the clock in value mode has both a range and keys');
    if (clock.range === undefined && clock.keys === undefined) fail('C2', 'the clock is in value mode but does not have a range of two numbers or keys');
    if (clock.range !== undefined && !clock.range.every(finite)) fail('S4', 'the clock range is not finite');
    if (clock.keys !== undefined) checkKeys(clock.keys, 'the clock');
  } else if (clock.keys !== undefined) fail('K3', 'the clock in fraction mode has keys, which only a clock in value mode takes');
  if (clock.end !== undefined && clock.end !== 'loop' && clock.end !== 'stop') fail('K9', `the clock's end is ${JSON.stringify(clock.end)}, not loop or stop`);
  const seconds = loopSeconds(clock);
  let lastStage = -Infinity;
  const stageIds = new Set<string>();
  for (const st of scene.stages ?? []) {
    checkId(st.id, 'stage');
    if (stageIds.has(st.id)) fail('K9', `stage ${st.id} is declared twice`);
    stageIds.add(st.id);
    if (!finite(st.at) || st.at < 0 || st.at > seconds) fail('K9', `stage ${st.id} is at ${String(st.at)}, not a time in [0, ${seconds}]`);
    if (st.at < lastStage) fail('K9', `the stages are not in order of time at ${st.id}`);
    lastStage = st.at;
  }
  for (const [i, o] of (scene.overlays ?? []).entries()) {
    const where = `overlay ${i}`;
    if (!Array.isArray(o.at) || o.at.length !== 2 || !o.at.every(finite)) fail('2.11', `${where} is at ${JSON.stringify(o.at)}, not two fractions`);
    if (o.kind === 'text') {
      checkParts(scene, o.text, where);
      checkTextStyle(where, o);
    } else if (o.kind === 'legend') {
      checkTweened(o.opacity, `${where}: the opacity`, isOpacity, '2.11');
      for (const e of o.entries) {
        const label = e.label as unknown;
        const staticPart = (x: unknown) =>
          typeof x === 'string' ||
          (x !== null &&
            typeof x === 'object' &&
            Object.keys(x).length === 1 &&
            (typeof (x as { sub?: unknown }).sub === 'string' || typeof (x as { sup?: unknown }).sup === 'string'));
        if (!(typeof label === 'string' || (Array.isArray(label) && label.every(staticPart))))
          fail('2.11', `${where} has an entry whose label is not a string or a list of strings and sub and sup parts`);
        if (e.marker !== undefined) checkMarker(where, e.marker, '2.11');
        if (e.line?.color !== undefined && !COLOR.test(e.line.color)) fail('2.11', `${where} has a line color that is not #rrggbb`);
        for (const c of e.colors ?? []) if (!COLOR.test(c)) fail('2.11', `${where} has a color ${JSON.stringify(c)} that is not #rrggbb`);
      }
    } else fail('S1', `overlay kind ${JSON.stringify((o as { kind: unknown }).kind)} is not implemented`);
  }
  if (clock.labels !== undefined && clock.labels.length !== clock.channels.length)
    fail('2.6', `the clock has ${clock.labels.length} labels for ${clock.channels.length} channels`);
  if (clock.seconds !== undefined && !(finite(clock.seconds) && clock.seconds > 0))
    fail('2.6', `the clock seconds are ${JSON.stringify(clock.seconds)}, not a positive finite number`);
  clockLaps(clock);
  for (const [id, view] of Object.entries(scene.views)) {
    if (typeof view!.frame === 'string') {
      if (!isFrame(view!.frame)) fail('2.7', `view ${id} displays ${view!.frame}, which is not a frame`);
    } else {
      checkVariableRef(scene, view!.frame.var, 'choice', '2.7');
      const v = variableDef(scene, view!.frame.var)!;
      if (v.kind === 'choice') for (const f of v.values) if (!isFrame(f)) fail('2.7', `the frame of view ${id} can be ${f}, which is not a frame`);
    }
    checkQuery(scene, view!.driver.sets);
    if ((view!.driver.member as unknown) === 'all') fail('V3', `view ${id}: the driver's member is "all", but a driver resolves to one track`);
    if ('count' in (view!.driver.member as object)) fail('V3', `view ${id}: the driver's member is a count, but a driver resolves to one track`);
    if ('var' in view!.driver.member) checkVariableRef(scene, view!.driver.member.var, 'selector', 'V3');
    if (view!.camera !== undefined && view!.camera.kind !== 'plane' && view!.camera.kind !== 'orbit')
      fail('2.7', `view ${id}: a camera kind is ${JSON.stringify((view!.camera as { kind: unknown }).kind)}, not plane or orbit`);
    const aspect = (view!.camera as { aspect?: unknown } | undefined)?.aspect;
    if (view!.camera?.kind === 'plane' && aspect !== undefined && aspect !== 'equal' && aspect !== 'free')
      fail('2.7', `view ${id}: a plane camera's aspect is ${JSON.stringify(aspect)}, not equal or free`);
    if (view!.camera?.kind === 'plane' && view!.camera.keys !== undefined) {
      checkCameraKeys(view!.camera.keys, aspect === 'free', `the camera of view ${id}`);
      for (const k of view!.camera.keys)
        for (const t of k.follow ?? [])
          if (view!.layers[t.layer]?.kind !== 'track') fail('K5', `view ${id}: a camera key follows layer ${t.layer}, which is not a track layer of the view`);
    }
    checkTweened(view!.opacity, `view ${id}: the opacity`, isOpacity);
    const margin = view!.margin;
    if (margin !== undefined) {
      for (const side of ['top', 'right', 'bottom', 'left'] as const) {
        const m = margin[side];
        if (m !== undefined && !(finite(m) && m >= 0 && m < 1)) fail('2.11', `view ${id}: the ${side} margin is ${String(m)}, not a fraction in [0, 1)`);
      }
      if ((margin.top ?? 0) + (margin.bottom ?? 0) >= 1 || (margin.left ?? 0) + (margin.right ?? 0) >= 1)
        fail('2.11', `view ${id}: the margins leave nothing to draw in`);
    }
    if (view!.camera?.kind === 'orbit') {
      const { stretch, turn } = view!.camera;
      if (stretch !== undefined && !(Array.isArray(stretch) && stretch.length === 3 && stretch.every((k) => finite(k) && k > 0)))
        fail('2.7', `view ${id}: an orbit camera's stretch is ${JSON.stringify(stretch)}, not three positive finite factors`);
      if (turn !== undefined && !finite(turn)) fail('2.7', `view ${id}: an orbit camera's turn is ${JSON.stringify(turn)}, not a finite number of degrees`);
    }
    for (const layer of view!.layers) {
      if (!LAYER_KINDS.includes(layer.kind)) fail('S1', `view ${id}: layer kind ${JSON.stringify(layer.kind)} is not implemented`);
      if (layer.visible !== undefined) checkVariableRef(scene, layer.visible.var, 'toggle', 'L5');
      if (layer.kind === 'track') checkTrackLayer(scene, id, layer);
      else if (layer.kind === 'arrow') checkArrowLayer(scene, id, layer);
      else if (layer.kind === 'outline') checkOutlineLayer(scene, id, layer);
      else if (layer.kind === 'label') checkLabelLayer(scene, id, layer);
      else if (layer.kind === 'points') checkPointsLayer(scene, id, layer);
      else if (layer.kind === 'body') {
        if (!Object.hasOwn(scene.bodies ?? {}, layer.body)) fail('L4', `view ${id} draws ${layer.body}, which is not a body`);
        if (layer.trail !== undefined) checkTrail(id, layer.trail);
        if (layer.size !== undefined && !(layer.size > 0)) fail('2.7', `view ${id}: a body layer's size is ${layer.size}, not positive`);
        checkTweened(layer.opacity, `view ${id}: a body layer's opacity`, isOpacity);
      } else if (layer.kind === 'axes') {
        if (layer.span !== undefined && layer.span !== 'full' && layer.span !== 'positive' && layer.span !== 'box')
          fail('2.7', `view ${id}: an axes layer's span is ${JSON.stringify(layer.span)}, not full, positive, or box`);
        if (layer.ticks !== undefined && !(Array.isArray(layer.ticks) && layer.ticks.every((t) => t === 'x' || t === 'y')))
          fail('2.11', `view ${id}: an axes layer's ticks are ${JSON.stringify(layer.ticks)}, not a list of x and y`);
        if (layer.size !== undefined && !isPositive(layer.size)) fail('2.11', `view ${id}: an axes layer's size is not positive`);
        const titles = layer.titles as unknown;
        if (titles !== undefined) {
          if (!Array.isArray(titles) || titles.length !== 2) fail('2.11', `view ${id}: an axes layer's titles are ${JSON.stringify(titles)}, not two texts`);
          for (const tt of titles) checkParts(scene, tt, `view ${id}: an axes title`);
        }
        checkTweened(layer.opacity, `view ${id}: an axes layer's opacity`, isOpacity);
      } else if (layer.kind === 'grid') {
        if (layer.labels !== undefined && typeof layer.labels !== 'boolean')
          fail('2.7', `view ${id}: a grid layer's labels is ${JSON.stringify(layer.labels)}, not a boolean`);
        checkTweened(layer.opacity, `view ${id}: a grid layer's opacity`, isOpacity);
      }
    }
  }
  for (const c of scene.controls ?? []) {
    if (!CONTROL_KINDS.includes(c.kind)) fail('S1', `control kind ${JSON.stringify(c.kind)} is not implemented`);
    if (c.kind === 'slider') {
      checkVariableRef(scene, c.variable, 'selector', '2.9');
      const sel = variableDef(scene, c.variable);
      if (sel?.kind === 'selector' && sel.by === 'index')
        fail('2.9', `the slider over ${c.variable} needs a selector by nearest, and the selector is by index`);
      checkQuery(scene, c.domain);
    } else if (c.kind === 'tabs') checkVariableRef(scene, c.variable, 'choice', '2.9');
    else if (c.kind === 'toggle') checkVariableRef(scene, c.variable, 'toggle', '2.9');
  }
  for (const r of scene.readouts ?? []) {
    if (r.place !== 'caption' && r.place !== 'panel') fail('2.9', `readout place ${JSON.stringify(r.place)} is not caption or panel`);
    checkParts(scene, r.parts, 'a readout');
  }

  if (data !== undefined) {
    for (const [id, b] of Object.entries(scene.bodies ?? {})) {
      if (b!.image === undefined) continue;
      if (!data.has(b!.image)) fail('2.4', `body ${id} has image ${JSON.stringify(b!.image)}, which the data container does not hold`);
      if (data.view(b!.image).dtype !== 'uint8') fail('2.4', `body ${id} has image ${b!.image}, which is not a view of uint8 bytes`);
    }
    const sets = new SetCache(scene, data);
    const layerChannels = new Set<string>();
    for (const v of Object.values(scene.views))
      for (const l of v!.layers) if ('clock' in l && l.clock !== undefined && l.clock.channel !== INDEX_CHANNEL) layerChannels.add(l.clock.channel);
    for (const id of Object.keys(scene.track_sets)) {
      const s = sets.get(id); // checks the shapes of section 2.1 and rule T1
      for (const name of Object.keys(s.def.channels ?? {})) s.channel(name);
      for (const name of Object.keys(s.def.parameters ?? {})) {
        const p = s.parameter(name);
        for (let t = 0; t < s.tracks; t++) if (!Number.isFinite(p[t]!)) fail('2.1', `parameter ${name} of track set ${id} is not finite at track ${t}`);
      }
      for (const ch of new Set([...scene.clock.channels, ...layerChannels])) {
        if (ch === INDEX_CHANNEL || !s.hasChannel(ch)) continue;
        const c = s.channel(ch);
        for (let t = 0; t < s.tracks; t++) {
          const a = s.start(t);
          const m = s.count(t);
          const sign = Math.sign(c[a + 1]! - c[a]!);
          for (let i = 0; i < m; i++) {
            if (!Number.isFinite(c[a + i]!)) fail('T3', `clock channel ${ch} of track set ${id} is not finite along track ${t} at sample ${i}`);
            if (i + 1 < m && !((c[a + i + 1]! - c[a + i]!) * sign > 0))
              fail('T3', `clock channel ${ch} of track set ${id} is not strictly monotone along track ${t} at sample ${i}`);
          }
          if (!Number.isFinite(c[a + m - 1]! - c[a]!)) fail('T3', `clock channel ${ch} of track set ${id} has an infinite span along track ${t}`);
        }
      }
    }
  }
  for (const st of state === undefined ? [scene.initial] : [scene.initial, state]) validateState(scene, frames, st, warnings);
  return warnings;
}

/** Checks one state against section 2.8, rules F2, F5, C5, C6 and V3, and section 2.9. */
function validateState(scene: Scene, frames: Frames, state: State, warnings: string[]): void {
  checkState(scene, state);
  for (const id of layoutIds(state.layout)) checkId(id, 'panel');
  const ratios = (node: Layout): void => {
    if (node.kind === 'panel') return;
    if (!(node.ratio > 0 && node.ratio < 1)) fail('2.8', `a split ratio is ${String(node.ratio)}, not in (0, 1)`);
    if (node.keys !== undefined) checkKeys(node.keys, 'a split', (v) => typeof v === 'number' && v >= 0 && v <= 1);
    ratios(node.a);
    ratios(node.b);
  };
  ratios(state.layout);
  const laps = clockLaps(scene.clock);
  const relative = (scene.readouts ?? [])
    .map((r) => ({
      place: r.place,
      parts: r.parts.filter((p): p is Exclude<typeof p, string> => typeof p !== 'string' && ('member' in p || 'attr' in p || 'channel' in p)),
    }))
    .filter((r) => r.parts.length > 0);
  const first = layoutIds(state.layout)[0];
  for (const [pid, panel] of Object.entries(state.panels)) {
    for (const id of Object.keys(panel!.variables ?? {})) {
      const v = variableDef(scene, id);
      if (v !== undefined && v.scope !== 'panel') warnings.push(`panel ${pid} sets ${id}, which is scene-scoped and never read there`);
    }
    const view = scene.views[panel!.view]!;
    const scope: PanelScope = { scene, state, panel: panel! };
    const display = displayFrame(scope, view);
    /** Rules F5 and F2 for the path from `from` to the display frame, or for `req` when given, evaluated in the contexts of track set `setId`. */
    const need = (setId: string, from: string, what: string, req = frames.requirements(from, display)) => {
      const set = scene.track_sets[setId]!;
      const ch = [...req.channels].filter((c) => c !== INDEX_CHANNEL && !Object.hasOwn(set.channels ?? {}, c));
      const at = [...req.attrs].filter((a) => !Object.hasOwn(set.attrs ?? {}, a));
      if (ch.length + at.length > 0) {
        fail(
          'F5',
          `panel ${pid}: track set ${setId} lacks ${[...ch.map((c) => `channel ${c}`), ...at.map((a) => `attribute ${a}`)].join(', ')} for ${what} in frame ${display}`,
        );
      }
      // rule F2 for an attribute scale on the path, which is constant per track set
      for (const fid of edgesUsed(frames, scene, from, display)) {
        const s = scene.frames[fid]!.scale;
        if (s !== undefined && typeof s === 'object' && 'attr' in s && (s.factor ?? 1) * (set.attrs?.[s.attr] ?? NaN) + (s.offset ?? 0) === 0) {
          fail('F2', `panel ${pid}: the scale of frame ${fid} is zero for track set ${setId}`);
        }
      }
    };
    const clocked = (setId: string, what: string, own?: LayerClock) => {
      const set = scene.track_sets[setId]!;
      // a layer with a clock of its own reads its channel alone, in one lap (rule K4)
      const channels = own === undefined ? scene.clock.channels : [own.channel];
      const missing = channels.filter((c) => c !== INDEX_CHANNEL && !Object.hasOwn(set.channels ?? {}, c));
      if (missing.length > 0) fail('C5', `panel ${pid}: track set ${setId}, ${what}, lacks clock channels ${missing.join(', ')}`);
      if (own === undefined && laps > 1 && set.periodic !== true)
        fail('C6', `panel ${pid}: track set ${setId}, ${what}, is not periodic, and the clock has ${laps} laps`);
    };
    const member = (setId: string, ref: MemberRef) => {
      const set = scene.track_sets[setId]!;
      if (ref === 'all' || 'count' in ref) return;
      if ('index' in ref) {
        if (ref.index >= set.tracks) fail('V3', `panel ${pid}: member index ${ref.index} is not below the track count ${set.tracks} of track set ${setId}`);
        return;
      }
      const sel = variableDef(scene, ref.var);
      if (sel?.kind === 'selector' && sel.by !== 'index' && sel.parameter !== undefined && !Object.hasOwn(set.parameters ?? {}, sel.parameter)) {
        fail('V3', `panel ${pid}: track set ${setId} lacks parameter ${sel.parameter} for selector ${ref.var}`);
      }
    };
    const driver = oneSet(scope, view.driver.sets);
    if (driver !== null) {
      need(driver, scene.track_sets[driver]!.frame, 'the driver');
      clocked(driver, 'the driver');
      member(driver, view.driver.member);
      const set = scene.track_sets[driver]!;
      for (const r of relative) {
        if (r.place === 'panel' || pid === first) {
          for (const p of r.parts) {
            if ('member' in p && !Object.hasOwn(set.parameters ?? {}, p.member))
              fail('2.9', `the ${r.place} readout through panel ${pid} names parameter ${p.member}, which track set ${driver} lacks`);
            if ('attr' in p && !Object.hasOwn(set.attrs ?? {}, p.attr))
              fail('2.9', `the ${r.place} readout through panel ${pid} names attribute ${p.attr}, which track set ${driver} lacks`);
            if ('channel' in p && !Object.hasOwn(set.channels ?? {}, p.channel))
              fail('2.9', `the ${r.place} readout through panel ${pid} names channel ${p.channel}, which track set ${driver} lacks`);
          }
        }
      }
    }
    for (const layer of view.layers) {
      if (!layerVisible(scope, layer)) continue;
      if (layer.kind === 'track') {
        const id = oneSet(scope, layer.sets);
        if (id === null) continue;
        // a layer in the driver's context reads the edges from the frame of its set on the driver's set (rule L6)
        if (layer.context !== 'driver') need(id, scene.track_sets[id]!.frame, 'its tracks');
        else if (driver !== null) need(driver, scene.track_sets[id]!.frame, `a layer of track set ${id} in the driver's context`);
        member(id, layer.members);
        if (layer.highlight !== undefined) member(id, { var: layer.highlight.var });
        const set = scene.track_sets[id]!;
        if (layer.color !== undefined && typeof layer.color === 'object') {
          if ('channel' in layer.color && !Object.hasOwn(set.channels ?? {}, layer.color.channel))
            fail('2.7', `panel ${pid}: track set ${id} lacks channel ${layer.color.channel} for a layer's color`);
          if ('parameter' in layer.color && !Object.hasOwn(set.parameters ?? {}, layer.color.parameter))
            fail('2.7', `panel ${pid}: track set ${id} lacks parameter ${layer.color.parameter} for a layer's color`);
        }
        if (typeof layer.color === 'object' && 'steps' in layer.color && !Object.hasOwn(set.channels ?? {}, layer.color.channel))
          fail('2.7', `panel ${pid}: track set ${id} lacks channel ${layer.color.channel} for a layer's color`);
        const glow = typeof layer.head === 'object' ? layer.head.glow : undefined;
        if (glow !== undefined && !Object.hasOwn(set.channels ?? {}, glow.channel))
          fail('2.7', `panel ${pid}: track set ${id} lacks channel ${glow.channel} for a head's glow`);
        const hides = (layer.clock !== undefined || scene.clock.mode === 'value') && (layer.before === 'hidden' || layer.after === 'hidden');
        if ((layer.reveal ?? 'none') !== 'none' || hasHead(layer) || hides) clocked(id, 'on which a reading is taken', layer.clock);
      } else if (layer.kind === 'arrow') {
        const id = oneSet(scope, layer.sets);
        if (id === null) continue;
        need(id, scene.track_sets[id]!.frame, 'its arrows');
        member(id, layer.members);
        const set = scene.track_sets[id]!;
        for (const c of layer.vector) {
          if (c !== INDEX_CHANNEL && !Object.hasOwn(set.channels ?? {}, c))
            fail('L7', `panel ${pid}: track set ${id} lacks channel ${c} of an arrow layer's vector`);
        }
        const scale = layer.scale;
        if (typeof scale === 'object' && 'attr' in scale && !Object.hasOwn(set.attrs ?? {}, scale.attr))
          fail('F5', `panel ${pid}: track set ${id} lacks attribute ${scale.attr} for an arrow layer's scale`);
        clocked(id, 'on which a reading is taken', layer.clock);
      } else if (layer.kind === 'points') {
        const id = oneSet(scope, layer.sets);
        if (id === null) continue;
        need(id, scene.track_sets[id]!.frame, 'its points');
        member(id, layer.members);
        const hides = (layer.clock !== undefined || scene.clock.mode === 'value') && (layer.before === 'hidden' || layer.after === 'hidden');
        if ((layer.reveal ?? 'none') === 'grow' || hides) clocked(id, 'on which a reading is taken', layer.clock);
      } else if (layer.kind === 'label') {
        const at = layer.at as { sets?: SetQuery; member?: number; frame?: string };
        if (at.sets !== undefined) {
          const id = oneSet(scope, at.sets);
          if (id === null) continue;
          need(id, scene.track_sets[id]!.frame, 'a label');
          if (at.member! >= scene.track_sets[id]!.tracks)
            fail('K6', `panel ${pid}: a label names member ${at.member}, which is not a track of track set ${id}`);
          clocked(id, 'on which a label reads', layer.clock);
        } else if (at.frame !== undefined && driver !== null) need(driver, at.frame, 'a label in another frame');
      } else if (layer.kind === 'outline' && driver !== null) {
        const target = outlineTarget(scope, layer.view);
        if (target !== null) need(driver, target.frame, `the outline of view ${layer.view}`);
      } else if (layer.kind === 'body' && driver !== null) {
        need(driver, scene.track_sets[driver]!.frame, `body ${layer.body}`, frames.bodyRequirements(layer.body, display));
      }
    }
    const cam = view.camera;
    if (cam?.kind === 'plane' && cam.keys !== undefined) {
      for (const k of cam.keys) {
        for (const t of k.follow ?? []) {
          const l = view.layers[t.layer];
          if (l?.kind !== 'track') continue;
          const id = oneSet(scope, l.sets);
          if (id === null) continue;
          if (t.member >= scene.track_sets[id]!.tracks)
            fail('K5', `panel ${pid}: a camera key follows member ${t.member}, which is not a track of track set ${id}`);
          clocked(id, 'which a camera follows', l.clock);
        }
      }
    }
    if (pid === first) {
      for (const c of scene.controls ?? []) {
        if (c.kind !== 'slider') continue;
        const sel = variableDef(scene, c.variable);
        if (sel?.kind !== 'selector' || sel.parameter === undefined) continue;
        for (const setId of querySets(scope, c.domain)) {
          if (!Object.hasOwn(scene.track_sets[setId]!.parameters ?? {}, sel.parameter))
            fail('2.9', `the slider over ${c.variable} has track set ${setId} in its domain, which lacks parameter ${sel.parameter}`);
        }
      }
    }
  }
}

/** The frames whose edge is evaluated to take a point from `from` to `to`, through body origins too. */
function edgesUsed(frames: Frames, scene: Scene, from: string, to: string, stack: string[] = []): Set<string> {
  const { up, down } = frames.tree.path(from, to);
  const used = new Set<string>();
  for (const fid of [...up, ...down]) {
    if (stack.includes(fid)) continue;
    used.add(fid);
    const o = scene.frames[fid]!.origin;
    if (o !== undefined && !Array.isArray(o)) {
      const body = scene.bodies![o.body]!;
      for (const e of edgesUsed(frames, scene, body.frame, scene.frames[fid]!.parent!, [...stack, fid])) used.add(e);
    }
  }
  return used;
}
