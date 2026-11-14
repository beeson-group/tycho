/**
 * The checks a reader makes before evaluating a scene. `validate` throws a TychoError that gives the
 * rule, and returns warnings for what a reader only reports: unknown top-level keys (section 2)
 * and a panel value of a shared input (rule `input-scope`).
 */
import type { DataStore } from './container.js';
import { fail } from './errors.js';
import { clockRevolutions } from './evaluate/clock.js';
import { Frames } from './evaluate/frames.js';
import { arrowParts, checkInsetBoxPanel, hasHead } from './evaluate/layers.js';
import { checkState, displayFrame, layerVisible, layoutIds, oneSet, insetBoxTarget, querySets, inputDef, type PanelScope } from './evaluate/resolve.js';
import { SetCache } from './evaluate/sets.js';
import { checkCameraKeyframes, checkKeyframes, checkKeyframed, isOpacity, isPositive, isShare, loopSeconds } from './evaluate/timeline.js';
import {
  ID_PATTERN,
  INDEX_CHANNEL,
  INDEX_PARAMETER,
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
  type TrajectoriesLayer,
  type ArrowLayer,
  type InsetBoxLayer,
  type LabelLayer,
  type PointsLayer,
  type LayerClock,
  type Marker,
  type TextPart,
  type Box,
} from './scene.js';

const LAYER_KINDS = ['trajectories', 'arrow', 'inset_box', 'body', 'axes', 'grid', 'label', 'points'];
const SHAPES = ['disc', 'ring', 'square', 'diamond', 'triangle', 'star', 'cross', 'plus'];
const CONTROL_KINDS = ['slider', 'tabs', 'toggle', 'playback'];
const COLORMAPS = ['viridis', 'plasma', 'cividis', 'blues', 'reds'];

const checkId = (id: string, what: string): void => {
  if (!ID_PATTERN.test(id)) fail('identifier', `${what} ${JSON.stringify(id)} does not match [A-Za-z0-9_.-]+`);
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
const SET_KEYS = ['label', 'frame', 'tags', 'attrs', 'trajectories', 'offsets', 'positions', 'channels', 'parameters', 'periodic'];
const PANEL_KEYS = ['label', 'frame', 'camera', 'reference', 'layers', 'opacity', 'margin'];
const CAMERA_2D_KEYS = ['kind', 'plane', 'aspect', 'keyframes'];
const CAMERA_3D_KEYS = ['kind', 'projection', 'up', 'stretch', 'auto_rotate'];
const TEXT_KEYS = ['align', 'baseline', 'size', 'color', 'weight', 'linespacing', 'box', 'opacity'];
const LAYER_KEYS: Record<string, readonly string[]> = {
  trajectories: [
    'kind',
    'sets',
    'members',
    'reveal',
    'trail',
    'head',
    'before',
    'after',
    'read_from',
    'fit',
    'color',
    'opacity',
    'width',
    'highlight',
    'visible',
    'clock',
    'line',
    'group_opacity',
    'dash',
    'fill',
  ],
  arrow: ['kind', 'sets', 'members', 'vector', 'scale', 'before', 'after', 'color', 'opacity', 'width', 'head', 'visible', 'clock'],
  inset_box: ['kind', 'panel', 'color', 'opacity', 'width', 'dash', 'min_size', 'visible'],
  body: ['kind', 'body', 'trail', 'size', 'visible', 'opacity'],
  axes: ['kind', 'span', 'visible', 'ticks', 'size', 'opacity', 'titles'],
  grid: ['kind', 'labels', 'visible', 'opacity'],
  label: ['kind', 'text', 'at', 'offset', 'leader', 'clock', 'visible', ...TEXT_KEYS],
  points: ['kind', 'sets', 'members', 'marker', 'reveal', 'before', 'after', 'clock', 'fit', 'opacity', 'visible'],
};
const CLOCK_KEYS = ['mode', 'channels', 'labels', 'frame_count', 'range', 'revolutions', 'seconds', 'keyframes', 'end'];
const THEME_KEYS = ['background', 'foreground', 'grid', 'font', 'gutter'];

/** Checks the format, the version, and `requires` (rule `version` and section 2). */
function checkVersion(scene: Scene): void {
  if (scene.format !== 'tycho-scene') fail('scene', `the format is ${JSON.stringify(scene.format)}, not "tycho-scene"`);
  const problems: string[] = [];
  const m = /^([0-9]+)\.([0-9]+)$/.exec(String(scene.version));
  if (m === null) problems.push(`version ${JSON.stringify(scene.version)} is not "major.minor"`);
  else if (Number(m[1]) !== SCENE_MAJOR) problems.push(`major version ${m[1]} is unknown to this reader, which reads ${SCENE_MAJOR}.x`);
  else if (SCENE_MAJOR === 0 && Number(m[2]) > SCENE_MINOR)
    problems.push(`version ${m[1]}.${m[2]} is newer than this reader's ${SCENE_MAJOR}.${SCENE_MINOR}, and the format is unstable until 1.0`);
  const missing = (scene.requires ?? []).filter((f) => !SUPPORTED_FEATURES.has(f));
  if (missing.length > 0) problems.push(`the required features ${missing.join(', ')} are not implemented`);
  if (problems.length > 0) fail('version', problems.join(', and '));
}

function checkInputRef(scene: Scene, id: string, kind: string | null, rule: string): void {
  const v = inputDef(scene, id);
  if (v === undefined) fail(rule, `input ${JSON.stringify(id)} is not declared`);
  if (kind !== null && v.kind !== kind) fail(rule, `input ${id} is a ${v.kind}, not a ${kind}`);
}

function checkScalar(s: Scalar | ConstantScalar | undefined, what: string, constant: boolean): void {
  if (s === undefined) return;
  if (typeof s === 'number') {
    if (!Number.isFinite(s)) fail('finite-number', `${what} is ${String(s)}, not finite`);
    return;
  }
  if ('attr' in s) {
    if (!finite(s.factor ?? 1) || !finite(s.offset ?? 0)) fail('finite-number', `${what} has a factor or offset that is not finite`);
    return;
  }
  if (constant) fail('origin', `${what} takes a number or an attribute, not a channel`);
  if (s.channel === INDEX_CHANNEL) fail('context-number', `${what} reads channel ${INDEX_CHANNEL}, which is not allowed in a frame edge`);
}

function checkQuery(scene: Scene, q: SetQuery): void {
  if ('set' in q) {
    if (!Object.hasOwn(scene.trajectory_sets, q.set)) fail('set-query', `the set query names ${JSON.stringify(q.set)}, which is not a trajectory set`);
  } else {
    for (const v of Object.values(q.tags)) if (typeof v === 'object' && v !== null) checkInputRef(scene, v.input, 'choice', 'set-query');
  }
}

const unit = (x: unknown): boolean => typeof x === 'number' && x >= 0 && x <= 1;

/** Checks a trail's fraction and taper (section 2.7). */
function checkTrail(id: string, trail: Trail): void {
  if (!(trail.fraction > 0 && trail.fraction <= 1)) fail('panel', `panel ${id}: a trail fraction is ${trail.fraction}, not in (0, 1]`);
  if (trail.taper !== undefined && !(unit(trail.taper.width ?? 0) && unit(trail.taper.opacity ?? 0)))
    fail('panel', `panel ${id}: a trail taper is not in [0, 1]`);
}

/** Checks a marker or a head (section 2.11), whose color the layer may give instead. */
function checkMarker(id: string, m: Marker & { glow?: unknown }, rule: string): void {
  if (m.shape !== undefined && !SHAPES.includes(m.shape))
    fail(rule, `panel ${id}: a marker's shape is ${JSON.stringify(m.shape)}, not one of ${SHAPES.join(', ')}`);
  for (const key of ['color', 'edge'] as const)
    if (m[key] !== undefined && !COLOR.test(m[key])) fail(rule, `panel ${id}: a marker's ${key} is ${JSON.stringify(m[key])}, not a #rrggbb color`);
  checkKeyframed(m.size, `panel ${id}: a marker's size`, isPositive, rule);
  checkKeyframed(m.opacity, `panel ${id}: a marker's opacity`, isOpacity, rule);
  checkKeyframed(m.edge_width, `panel ${id}: a marker's edge_width`, (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0, rule);
}

/** Checks a layer's own clock (rule `layer-clock`). */
function checkLayerClock(id: string, c: LayerClock | undefined): void {
  if (c === undefined) return;
  if (c === null || typeof c !== 'object' || typeof c.channel !== 'string')
    fail('layer-clock', `panel ${id}: a layer's clock is ${JSON.stringify(c)}, not {channel, range} or {channel, keyframes}`);
  if ((c.range === undefined) === (c.keyframes === undefined))
    fail(
      'layer-clock',
      `panel ${id}: a layer's clock on ${c.channel} has ${c.range === undefined ? 'neither a range nor keyframes' : 'both a range and keyframes'}`,
    );
  if (c.range !== undefined && !(Array.isArray(c.range) && c.range.length === 2 && c.range.every(finite)))
    fail('layer-clock', `panel ${id}: a layer's clock on ${c.channel} has range ${JSON.stringify(c.range)}, not two finite numbers`);
  if (c.keyframes !== undefined) checkKeyframes(c.keyframes, `panel ${id}: the clock of a layer on ${c.channel}`);
}

/** Checks the parts of a readout, a label, or an overlay (section 2.9 and rule `timeline-parts`). */
function checkParts(scene: Scene, parts: unknown, what: string): void {
  if (typeof parts === 'string') return;
  if (!Array.isArray(parts)) fail('control', `${what} has text ${JSON.stringify(parts)}, not a string or a list of parts`);
  for (const p of parts as TextPart[]) {
    if (typeof p === 'string') continue;
    if (p === null || typeof p !== 'object') fail('control', `${what} has a part ${JSON.stringify(p)}`);
    if ('input' in p) checkInputRef(scene, p.input, null, 'control');
    if ('channel' in p && p.channel === INDEX_CHANNEL) fail('control', `${what} has a channel part naming ${INDEX_CHANNEL}, which is not allowed in a readout`);
    if ('timed_text' in p) {
      if (!Array.isArray(p.timed_text)) fail('timeline-parts', `${what} has timed_text ${JSON.stringify(p.timed_text)}, not a list of [t, text] pairs`);
      let last = -Infinity;
      for (const st of p.timed_text) {
        if (!Array.isArray(st) || st.length !== 2 || !finite(st[0]) || typeof st[1] !== 'string')
          fail('timeline-parts', `${what} has a timed text ${JSON.stringify(st)}, not [t, text]`);
        if ((st[0] as number) < last) fail('timeline-parts', `${what} has timed text whose times decrease`);
        last = st[0] as number;
      }
      continue;
    }
    if ('keyframes' in p) checkKeyframes(p.keyframes, what);
    if ('clock' in p && !['frame_index', 'frame_count', 'value', 'time'].includes(p.clock))
      fail('control', `${what} has a clock part ${JSON.stringify(p.clock)}`);
    const f = p as { factor?: unknown; offset?: unknown; digits?: unknown; decimals?: unknown };
    if (!finite(f.factor ?? 1) || !finite(f.offset ?? 0)) fail('finite-number', `${what} has a part whose factor or offset is not finite`);
    if (f.digits !== undefined && !(Number.isInteger(f.digits) && (f.digits as number) >= 1 && (f.digits as number) <= 17))
      fail('control', `${what} has digits ${String(f.digits)}, not in 1 to 17`);
    if (f.decimals !== undefined && !(Number.isInteger(f.decimals) && (f.decimals as number) >= 0 && (f.decimals as number) <= 17))
      fail('timeline-parts', `${what} has decimals ${String(f.decimals)}, not in 0 to 17`);
    if (f.digits !== undefined && f.decimals !== undefined) fail('timeline-parts', `${what} has a part with both digits and decimals`);
    const width = (p as { width?: unknown }).width;
    if (width !== undefined && !(Number.isInteger(width) && (width as number) >= 0 && (width as number) <= 40))
      fail('timeline-parts', `${what} has width ${String(width)}, not in 0 to 40`);
  }
}

/** Checks the style of a label or a text overlay (rule `label`). */
function checkTextStyle(
  id: string,
  t: { align?: unknown; baseline?: unknown; size?: unknown; color?: unknown; weight?: unknown; linespacing?: unknown; box?: Box; opacity?: unknown },
): void {
  if (t.align !== undefined && !['start', 'center', 'end'].includes(t.align as string)) fail('label', `${id}: an align is ${JSON.stringify(t.align)}`);
  if (t.baseline !== undefined && !['top', 'middle', 'bottom', 'alphabetic'].includes(t.baseline as string))
    fail('label', `${id}: a baseline is ${JSON.stringify(t.baseline)}`);
  if (t.size !== undefined && !isPositive(t.size)) fail('label', `${id}: a text size is ${JSON.stringify(t.size)}, not positive`);
  if (t.color !== undefined && !COLOR.test(t.color as string)) fail('label', `${id}: a text color is ${JSON.stringify(t.color)}, not #rrggbb`);
  if (t.weight !== undefined && t.weight !== 'normal' && t.weight !== 'bold')
    fail('label', `${id}: a weight is ${JSON.stringify(t.weight)}, not normal or bold`);
  if (t.linespacing !== undefined && !isPositive(t.linespacing)) fail('label', `${id}: a linespacing is ${JSON.stringify(t.linespacing)}, not positive`);
  checkKeyframed(t.opacity, `${id}: an opacity`, isOpacity, 'label');
  const b = t.box;
  if (b !== undefined) {
    for (const key of ['fill', 'edge'] as const) if (b[key] !== undefined && !COLOR.test(b[key])) fail('label', `${id}: a box ${key} is not #rrggbb`);
    if (b.opacity !== undefined && !unit(b.opacity)) fail('label', `${id}: a box opacity is not in [0, 1]`);
  }
}

function checkLabelLayer(scene: Scene, id: string, layer: LabelLayer): void {
  checkParts(scene, layer.text, `panel ${id}: a label`);
  checkTextStyle(`panel ${id}`, layer);
  checkLayerClock(id, layer.clock);
  const at = layer.at as Record<string, unknown>;
  if (at === null || typeof at !== 'object') fail('label', `panel ${id}: a label's anchor is ${JSON.stringify(at)}`);
  if ('point' in at) {
    const pt = at.point as unknown;
    if (!Array.isArray(pt) || pt.length !== 3 || !pt.every(finite))
      fail('label', `panel ${id}: a label's point is ${JSON.stringify(pt)}, not three finite numbers`);
    if (at.frame !== undefined && !Object.hasOwn(scene.frames, at.frame as string))
      fail('label', `panel ${id}: a label's point is in frame ${JSON.stringify(at.frame)}, which is not declared`);
  } else if ('sets' in at) {
    checkQuery(scene, at.sets as SetQuery);
    if (!Number.isInteger(at.member) || (at.member as number) < 0)
      fail('label', `panel ${id}: a label's member is ${JSON.stringify(at.member)}, not a trajectory index`);
  } else if ('screen' in at) {
    const sc = at.screen as unknown;
    if (!Array.isArray(sc) || sc.length !== 2 || !sc.every(finite))
      fail('label', `panel ${id}: a label's screen place is ${JSON.stringify(sc)}, not two fractions`);
  } else fail('label', `panel ${id}: a label's anchor is ${JSON.stringify(at)}, not a point, a member, or a place on the screen`);
  const off = layer.offset as unknown;
  if (off !== undefined && !(Array.isArray(off) && off.length === 2 && off.every(finite)))
    fail('label', `panel ${id}: a label's offset is ${JSON.stringify(off)}, not two lengths`);
  const lead = layer.leader;
  if (lead !== undefined && typeof lead === 'object' && lead.color !== undefined && !COLOR.test(lead.color))
    fail('label', `panel ${id}: a leader's color is not #rrggbb`);
}

function checkPointsLayer(scene: Scene, id: string, layer: PointsLayer): void {
  checkMembers(scene, id, layer);
  const reveal = layer.reveal ?? 'none';
  if (reveal !== 'none' && reveal !== 'grow') fail('points', `panel ${id}: a points layer's reveal is ${JSON.stringify(reveal)}, not none or grow`);
  for (const key of ['before', 'after'] as const) {
    if (layer[key] !== undefined && layer[key] !== 'clamp' && layer[key] !== 'hidden')
      fail('before-after', `panel ${id}: a points layer's ${key} is ${JSON.stringify(layer[key])}, not clamp or hidden`);
  }
  if (layer.marker !== undefined) checkMarker(id, layer.marker, 'points');
  checkKeyframed(layer.opacity, `panel ${id}: a points layer's opacity`, isOpacity);
  checkLayerClock(id, layer.clock);
}

function checkMembers(scene: Scene, id: string, layer: TrajectoriesLayer | ArrowLayer | PointsLayer): void {
  checkQuery(scene, layer.sets);
  if (typeof layer.members === 'object' && 'input' in layer.members) checkInputRef(scene, layer.members.input, 'parameter', 'members');
  const m = layer.members;
  if (typeof m === 'object' && 'evenly_spaced' in m && !(Number.isInteger(m.evenly_spaced) && m.evenly_spaced >= 1)) {
    fail('members', `panel ${id}: evenly_spaced ${JSON.stringify(m.evenly_spaced)} is not an integer of at least one`);
  }
}

function checkArrowLayer(scene: Scene, id: string, layer: ArrowLayer): void {
  checkMembers(scene, id, layer);
  arrowParts(layer);
  for (const key of ['before', 'after'] as const) {
    if (layer[key] !== undefined && layer[key] !== 'clamp' && layer[key] !== 'hidden')
      fail('before-after', `panel ${id}: an arrow layer's ${key} is ${JSON.stringify(layer[key])}, not clamp or hidden`);
  }
  if (layer.color !== undefined && !COLOR.test(layer.color))
    fail('arrow', `panel ${id}: an arrow layer's color is ${JSON.stringify(layer.color)}, not a #rrggbb color`);
  if (layer.head?.size !== undefined && !(layer.head.size > 0)) fail('arrow', `panel ${id}: an arrowhead size is ${layer.head.size}, not positive`);
  checkKeyframed(layer.opacity, `panel ${id}: an arrow layer's opacity`, isOpacity);
  if (layer.width !== undefined && !(layer.width > 0)) fail('panel', `panel ${id}: an arrow layer's width is ${layer.width}, not positive`);
  checkLayerClock(id, layer.clock);
}

function checkInsetBoxLayer(scene: Scene, id: string, layer: InsetBoxLayer): void {
  checkInsetBoxPanel(scene, id, layer);
  if (layer.color !== undefined && !COLOR.test(layer.color))
    fail('inset-box', `panel ${id}: an inset_box layer's color is ${JSON.stringify(layer.color)}, not a #rrggbb color`);
  checkKeyframed(layer.opacity, `panel ${id}: an inset_box layer's opacity`, isOpacity);
  if (layer.width !== undefined && !(layer.width > 0)) fail('panel', `panel ${id}: an inset_box layer's width is ${layer.width}, not positive`);
  const dash = layer.dash as unknown;
  if (dash !== undefined && !(Array.isArray(dash) && dash.length === 2 && dash.every((d) => finite(d) && d > 0)))
    fail('inset-box', `panel ${id}: an inset_box layer's dash is ${JSON.stringify(dash)}, not two positive lengths`);
  if (layer.min_size !== undefined && !(finite(layer.min_size) && layer.min_size >= 0))
    fail('inset-box', `panel ${id}: an inset_box layer's min_size is ${layer.min_size}, not a nonnegative length`);
}

function checkTrajectoryLayer(scene: Scene, id: string, layer: TrajectoriesLayer): void {
  checkMembers(scene, id, layer);
  if (layer.fit !== undefined && typeof layer.fit !== 'boolean')
    fail('panel', `panel ${id}: a trajectories layer's fit is ${JSON.stringify(layer.fit)}, not a boolean`);
  const hl = layer.highlight;
  if (hl !== undefined) {
    checkInputRef(scene, hl.input, 'parameter', 'panel');
    if (hl.width !== undefined && !(hl.width > 0)) fail('panel', `panel ${id}: a highlight width is ${hl.width}, not positive`);
    if (hl.opacity !== undefined && !unit(hl.opacity)) fail('panel', `panel ${id}: a highlight opacity is ${hl.opacity}, not in [0, 1]`);
    if (hl.kernel !== undefined) {
      if (!(hl.kernel.width > 0 && hl.kernel.width <= 1)) fail('panel', `panel ${id}: a highlight kernel's width is ${hl.kernel.width}, not in (0, 1]`);
      if (!unit(hl.kernel.opacity)) fail('panel', `panel ${id}: a highlight kernel's opacity is ${hl.kernel.opacity}, not in [0, 1]`);
    }
  }
  const reveal = layer.reveal ?? 'none';
  if (!['none', 'grow', 'trail'].includes(reveal))
    fail('panel', `panel ${id}: a trajectories layer's reveal is ${JSON.stringify(reveal)}, not none, grow, or trail`);
  if (reveal === 'trail' && layer.trail === undefined) fail('panel', `panel ${id}: a trajectories layer has reveal "trail" but lacks a trail`);
  if (layer.trail !== undefined) checkTrail(id, layer.trail);
  if (layer.head !== undefined && typeof layer.head !== 'boolean') {
    if (typeof layer.head !== 'object' || layer.head === null)
      fail('head', `panel ${id}: a trajectories layer's head is ${JSON.stringify(layer.head)}, not a boolean or an object`);
    if (layer.head.color !== undefined && !COLOR.test(layer.head.color))
      fail('head', `panel ${id}: a head color is ${JSON.stringify(layer.head.color)}, not a #rrggbb color`);
    checkMarker(id, layer.head, 'head');
    const glow = layer.head.glow;
    if (glow !== undefined) {
      if (typeof glow.channel !== 'string' || glow.channel === INDEX_CHANNEL)
        fail('timeline', `panel ${id}: a glow names channel ${JSON.stringify(glow.channel)}`);
      if (glow.color !== undefined && !COLOR.test(glow.color)) fail('timeline', `panel ${id}: a glow's color is not #rrggbb`);
      if (glow.size !== undefined && !isPositive(glow.size)) fail('timeline', `panel ${id}: a glow's size is not positive`);
      if (glow.opacity !== undefined && !unit(glow.opacity)) fail('timeline', `panel ${id}: a glow's opacity is not in [0, 1]`);
    }
  }
  if (layer.line !== undefined && typeof layer.line !== 'boolean')
    fail('panel', `panel ${id}: a trajectories layer's line is ${JSON.stringify(layer.line)}, not a boolean`);
  if (layer.group_opacity !== undefined && typeof layer.group_opacity !== 'boolean')
    fail('panel', `panel ${id}: a trajectories layer's group_opacity is ${JSON.stringify(layer.group_opacity)}, not a boolean`);
  const dash = layer.dash as unknown;
  if (dash !== undefined && !(Array.isArray(dash) && dash.length === 2 && dash.every((d) => finite(d) && d > 0)))
    fail('timeline', `panel ${id}: a trajectories layer's dash is ${JSON.stringify(dash)}, not two positive lengths`);
  if (layer.fill !== undefined) {
    if (layer.fill.base !== undefined && !finite(layer.fill.base)) fail('finite-number', `panel ${id}: a fill's base is not finite`);
    if (layer.fill.color !== undefined && !COLOR.test(layer.fill.color)) fail('panel', `panel ${id}: a fill's color is not #rrggbb`);
    if (layer.fill.opacity !== undefined && !unit(layer.fill.opacity)) fail('panel', `panel ${id}: a fill's opacity is not in [0, 1]`);
  }
  checkLayerClock(id, layer.clock);
  for (const key of ['before', 'after'] as const) {
    if (layer[key] !== undefined && layer[key] !== 'clamp' && layer[key] !== 'hidden')
      fail('before-after', `panel ${id}: a trajectories layer's ${key} is ${JSON.stringify(layer[key])}, not clamp or hidden`);
  }
  if (layer.read_from !== undefined && layer.read_from !== 'own' && layer.read_from !== 'reference')
    fail('read-from', `panel ${id}: a trajectories layer's read_from is ${JSON.stringify(layer.read_from)}, not own or reference`);
  checkKeyframed(layer.opacity, `panel ${id}: a trajectories layer's opacity`, isOpacity);
  if (layer.width !== undefined && !(layer.width > 0)) fail('panel', `panel ${id}: a trajectories layer's width is ${layer.width}, not positive`);
  if (layer.color !== undefined && typeof layer.color === 'object' && 'thresholds' in layer.color) {
    const c = layer.color;
    const t = c.thresholds;
    if (!Array.isArray(t) || t.length === 0 || !t.every(finite) || t.some((x, i) => i > 0 && !(x > t[i - 1]!)))
      fail('timeline', `panel ${id}: a threshold color's thresholds are ${JSON.stringify(t)}, not increasing finite numbers`);
    if (!Array.isArray(c.colors) || c.colors.length !== t.length + 1 || !c.colors.every((x) => COLOR.test(x)))
      fail('timeline', `panel ${id}: a threshold color has ${JSON.stringify(c.colors)} for ${t.length} thresholds, not one #rrggbb color more than thresholds`);
  } else if (layer.color !== undefined && typeof layer.color === 'object') {
    const cmap = layer.color.colormap;
    if (typeof cmap === 'object' && cmap !== null) {
      // a colormap keyed on a choice gives a colormap for every value of the choice, and only for these values
      checkInputRef(scene, cmap.input, 'choice', 'panel');
      const values = (inputDef(scene, cmap.input) as { values: string[] }).values;
      const keys = Object.keys(cmap.map ?? {});
      const missing = values.filter((v) => !Object.hasOwn(cmap.map, v));
      const extra = keys.filter((k) => !values.includes(k));
      if (missing.length > 0) fail('panel', `panel ${id}: a colormap keyed on ${cmap.input} does not name a colormap for ${JSON.stringify(missing)}`);
      if (extra.length > 0) fail('panel', `panel ${id}: a colormap keyed on ${cmap.input} maps ${JSON.stringify(extra)}, which are not its values`);
      for (const k of keys)
        if (!COLORMAPS.includes(cmap.map[k]!)) fail('panel', `panel ${id}: the colormap ${JSON.stringify(cmap.map[k])} is not one of ${COLORMAPS.join(', ')}`);
    } else if (!COLORMAPS.includes(cmap)) fail('panel', `panel ${id}: the colormap ${JSON.stringify(cmap)} is not one of ${COLORMAPS.join(', ')}`);
    if ('parameter' in layer.color === 'channel' in layer.color) fail('panel', `panel ${id}: a colormap color names both or neither of parameter and channel`);
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
      if (typeof v !== 'string') fail('scene', `theme font is ${JSON.stringify(v)}, not a CSS font family`);
    } else if (typeof v !== 'string' || !COLOR.test(v)) fail('scene', `theme ${k} is ${JSON.stringify(v)}, not a #rrggbb color`);
  }
  unknownKeys(scene.clock, CLOCK_KEYS, 'the clock', warnings);
  for (const [id, f] of Object.entries(scene.frames)) unknownKeys(f, FRAME_KEYS, `frame ${id}`, warnings);
  for (const [id, b] of Object.entries(scene.bodies ?? {})) {
    unknownKeys(b, BODY_KEYS, `body ${id}`, warnings);
    if (b!.color !== undefined && !COLOR.test(b!.color)) fail('body', `body ${id} has color ${JSON.stringify(b!.color)}, not #rrggbb`);
  }
  for (const [id, s] of Object.entries(scene.trajectory_sets)) unknownKeys(s, SET_KEYS, `trajectory set ${id}`, warnings);
  for (const [id, v] of Object.entries(scene.panels)) {
    unknownKeys(v, PANEL_KEYS, `panel ${id}`, warnings);
    if (v!.camera !== undefined) unknownKeys(v!.camera, v!.camera.kind === '3d' ? CAMERA_3D_KEYS : CAMERA_2D_KEYS, `the camera of panel ${id}`, warnings);
    for (const layer of v!.layers)
      if (Object.hasOwn(LAYER_KEYS, layer.kind)) unknownKeys(layer, LAYER_KEYS[layer.kind]!, `a ${layer.kind} layer of panel ${id}`, warnings);
  }
  for (const [what, table] of [
    ['frame', scene.frames],
    ['body', scene.bodies],
    ['trajectory set', scene.trajectory_sets],
    ['input', scene.inputs],
    ['panel', scene.panels],
  ] as const) {
    for (const id of Object.keys(table ?? {})) checkId(id, what);
  }

  // The Frames constructor checks the frame tree: one root without edge fields, scales that are not a constant zero, and rule `body-origin-cycle`.
  // It also checks that every body origin refers to a declared body.
  const frames = new Frames(scene);
  const isFrame = (id: string) => frames.tree.has(id);
  for (const [id, f] of Object.entries(scene.frames)) {
    if (Array.isArray(f!.origin)) f!.origin.forEach((s) => checkScalar(s, `the origin of frame ${id}`, false));
    checkScalar(f!.rotation?.angle, `the rotation of frame ${id}`, false);
    checkScalar(f!.scale, `the scale of frame ${id}`, false);
    if (f!.axes !== undefined && f!.axes.length !== 3) fail('frame', `frame ${id} has ${f!.axes.length} axis labels, not three`);
  }
  for (const [id, b] of Object.entries(scene.bodies ?? {})) {
    if (!isFrame(b!.frame)) fail('body', `body ${id} is in frame ${b!.frame}, which is not declared`);
    b!.position.forEach((s) => checkScalar(s, `the position of body ${id}`, true));
  }
  if (Object.keys(scene.trajectory_sets).length === 0) fail('trajectory-set', 'the scene does not have a trajectory set');
  for (const [id, s] of Object.entries(scene.trajectory_sets)) {
    if (!isFrame(s!.frame)) fail('trajectory-set', `trajectory set ${id} is in frame ${s!.frame}, which is not declared`);
    if (!Number.isInteger(s!.trajectories) || s!.trajectories < 1)
      fail('trajectory-set', `trajectory set ${id} has trajectories ${String(s!.trajectories)}, not a count of at least one`);
    if (Object.hasOwn(s!.channels ?? {}, INDEX_CHANNEL))
      fail('identifier', `trajectory set ${id} declares a channel named ${INDEX_CHANNEL}, which is reserved`);
    if (Object.hasOwn(s!.parameters ?? {}, INDEX_PARAMETER))
      fail('identifier', `trajectory set ${id} declares a parameter named ${INDEX_PARAMETER}, which is reserved`);
    for (const [k, v] of Object.entries(s!.attrs ?? {})) if (!finite(v)) fail('finite-number', `attribute ${k} of trajectory set ${id} is not finite`);
  }
  for (const [name, v] of Object.entries(scene.inputs ?? {})) {
    const scope: unknown = v!.scope;
    if (scope !== undefined && scope !== 'shared' && scope !== 'per_panel')
      fail('input', `input ${name} has scope ${JSON.stringify(scope)}, not shared or per_panel`);
    if (v!.kind === 'parameter') {
      if (typeof v!.parameter !== 'string') fail('input', `input ${name} is of kind parameter but does not name a parameter`);
      if (!finite(v!.default)) fail('input', `input ${name} defaults to ${String(v!.default)}, not a finite number`);
    } else if (v!.kind === 'choice') {
      if (!v!.values.includes(v!.default)) fail('input', `choice ${name} defaults to ${JSON.stringify(v!.default)}, which is not one of its values`);
      if (v!.labels !== undefined && v!.labels.length !== v!.values.length)
        fail('input', `choice ${name} has ${v!.labels.length} labels for ${v!.values.length} values`);
    } else if (v!.kind === 'toggle') {
      const d: unknown = v!.default;
      if (typeof d !== 'boolean') fail('input', `toggle ${name} defaults to ${JSON.stringify(d)}, not a boolean`);
    } else fail('input', `input ${name} has kind ${JSON.stringify((v as { kind: unknown }).kind)}, not parameter, choice, or toggle`);
  }
  const clock = scene.clock;
  if (clock.mode !== 'fraction' && clock.mode !== 'epoch') fail('clock', `the clock mode is ${JSON.stringify(clock.mode)}, not fraction or epoch`);
  if (!Number.isInteger(clock.frame_count) || clock.frame_count < 1)
    fail('clock', `the clock has frame_count ${String(clock.frame_count)}, not a count of at least one`);
  if (clock.mode === 'epoch') {
    if (clock.range !== undefined && clock.keyframes !== undefined) fail('clock-keyframes', 'the clock in epoch mode has both a range and keyframes');
    if (clock.range === undefined && clock.keyframes === undefined)
      fail('clock-mode', 'the clock is in epoch mode but does not have a range of two numbers or keyframes');
    if (clock.range !== undefined && !clock.range.every(finite)) fail('finite-number', 'the clock range is not finite');
    if (clock.keyframes !== undefined) checkKeyframes(clock.keyframes, 'the clock');
  } else if (clock.keyframes !== undefined) fail('clock-keyframes', 'the clock in fraction mode has keyframes, which only a clock in epoch mode takes');
  if (clock.end !== undefined && clock.end !== 'loop' && clock.end !== 'stop')
    fail('steps', `the clock's end is ${JSON.stringify(clock.end)}, not loop or stop`);
  const seconds = loopSeconds(clock);
  let lastStep = -Infinity;
  const stepIds = new Set<string>();
  for (const st of scene.steps ?? []) {
    checkId(st.id, 'step');
    if (stepIds.has(st.id)) fail('steps', `step ${st.id} is declared twice`);
    stepIds.add(st.id);
    if (!finite(st.at) || st.at < 0 || st.at > seconds) fail('steps', `step ${st.id} is at ${String(st.at)}, not a time in [0, ${seconds}]`);
    if (st.at < lastStep) fail('steps', `the steps are not in order of time at ${st.id}`);
    lastStep = st.at;
  }
  for (const [i, o] of (scene.overlays ?? []).entries()) {
    const where = `overlay ${i}`;
    if (!Array.isArray(o.at) || o.at.length !== 2 || !o.at.every(finite)) fail('timeline', `${where} is at ${JSON.stringify(o.at)}, not two fractions`);
    if (o.kind === 'text') {
      checkParts(scene, o.text, where);
      checkTextStyle(where, o);
    } else if (o.kind === 'legend') {
      checkKeyframed(o.opacity, `${where}: the opacity`, isOpacity, 'timeline');
      for (const e of o.entries) {
        const label = e.label as unknown;
        const staticPart = (x: unknown) =>
          typeof x === 'string' ||
          (x !== null &&
            typeof x === 'object' &&
            Object.keys(x).length === 1 &&
            (typeof (x as { sub?: unknown }).sub === 'string' || typeof (x as { sup?: unknown }).sup === 'string'));
        if (!(typeof label === 'string' || (Array.isArray(label) && label.every(staticPart))))
          fail('timeline', `${where} has an entry whose label is not a string or a list of strings and sub and sup parts`);
        if (e.marker !== undefined) checkMarker(where, e.marker, 'timeline');
        if (e.line?.color !== undefined && !COLOR.test(e.line.color)) fail('timeline', `${where} has a line color that is not #rrggbb`);
        for (const c of e.colors ?? []) if (!COLOR.test(c)) fail('timeline', `${where} has a color ${JSON.stringify(c)} that is not #rrggbb`);
      }
    } else fail('version', `overlay kind ${JSON.stringify((o as { kind: unknown }).kind)} is not implemented`);
  }
  if (clock.labels !== undefined && clock.labels.length !== clock.channels.length)
    fail('clock', `the clock has ${clock.labels.length} labels for ${clock.channels.length} channels`);
  if (clock.seconds !== undefined && !(finite(clock.seconds) && clock.seconds > 0))
    fail('clock', `the clock seconds are ${JSON.stringify(clock.seconds)}, not a positive finite number`);
  clockRevolutions(clock);
  for (const [id, panel] of Object.entries(scene.panels)) {
    if (typeof panel!.frame === 'string') {
      if (!isFrame(panel!.frame)) fail('panel', `panel ${id} displays ${panel!.frame}, which is not a frame`);
    } else {
      checkInputRef(scene, panel!.frame.input, 'choice', 'panel');
      const v = inputDef(scene, panel!.frame.input)!;
      if (v.kind === 'choice') for (const f of v.values) if (!isFrame(f)) fail('panel', `the frame of panel ${id} can be ${f}, which is not a frame`);
    }
    checkQuery(scene, panel!.reference.sets);
    if ((panel!.reference.member as unknown) === 'all')
      fail('members', `panel ${id}: the member of the reference trajectory is "all", but a reference resolves to one trajectory`);
    if ('evenly_spaced' in (panel!.reference.member as object))
      fail('members', `panel ${id}: the member of the reference trajectory is evenly_spaced, but a reference resolves to one trajectory`);
    if ('input' in panel!.reference.member) checkInputRef(scene, panel!.reference.member.input, 'parameter', 'members');
    if (panel!.camera !== undefined && panel!.camera.kind !== '2d' && panel!.camera.kind !== '3d')
      fail('panel', `panel ${id}: a camera kind is ${JSON.stringify((panel!.camera as { kind: unknown }).kind)}, not 2d or 3d`);
    const aspect = (panel!.camera as { aspect?: unknown } | undefined)?.aspect;
    if (panel!.camera?.kind === '2d' && aspect !== undefined && aspect !== 'equal' && aspect !== 'free')
      fail('panel', `panel ${id}: a 2d camera's aspect is ${JSON.stringify(aspect)}, not equal or free`);
    if (panel!.camera?.kind === '2d' && panel!.camera.keyframes !== undefined) {
      checkCameraKeyframes(panel!.camera.keyframes, aspect === 'free', `the camera of panel ${id}`);
      for (const k of panel!.camera.keyframes)
        for (const t of k.follow ?? [])
          if (panel!.layers[t.layer]?.kind !== 'trajectories')
            fail('camera-keyframes', `panel ${id}: a camera keyframe follows layer ${t.layer}, which is not a trajectories layer of the panel`);
    }
    checkKeyframed(panel!.opacity, `panel ${id}: the opacity`, isOpacity);
    const margin = panel!.margin;
    if (margin !== undefined) {
      for (const side of ['top', 'right', 'bottom', 'left'] as const) {
        const m = margin[side];
        if (m !== undefined && !(finite(m) && m >= 0 && m < 1)) fail('timeline', `panel ${id}: the ${side} margin is ${String(m)}, not a fraction in [0, 1)`);
      }
      if ((margin.top ?? 0) + (margin.bottom ?? 0) >= 1 || (margin.left ?? 0) + (margin.right ?? 0) >= 1)
        fail('timeline', `panel ${id}: the margins leave nothing to draw in`);
    }
    if (panel!.camera?.kind === '3d') {
      const { stretch, auto_rotate } = panel!.camera;
      if (stretch !== undefined && !(Array.isArray(stretch) && stretch.length === 3 && stretch.every((k) => finite(k) && k > 0)))
        fail('panel', `panel ${id}: a 3d camera's stretch is ${JSON.stringify(stretch)}, not three positive finite factors`);
      if (auto_rotate !== undefined && !finite(auto_rotate))
        fail('panel', `panel ${id}: a 3d camera's auto_rotate is ${JSON.stringify(auto_rotate)}, not a finite number of degrees`);
    }
    for (const layer of panel!.layers) {
      if (!LAYER_KINDS.includes(layer.kind)) fail('version', `panel ${id}: layer kind ${JSON.stringify(layer.kind)} is not implemented`);
      if (layer.visible !== undefined) checkInputRef(scene, layer.visible.input, 'toggle', 'visible');
      if (layer.kind === 'trajectories') checkTrajectoryLayer(scene, id, layer);
      else if (layer.kind === 'arrow') checkArrowLayer(scene, id, layer);
      else if (layer.kind === 'inset_box') checkInsetBoxLayer(scene, id, layer);
      else if (layer.kind === 'label') checkLabelLayer(scene, id, layer);
      else if (layer.kind === 'points') checkPointsLayer(scene, id, layer);
      else if (layer.kind === 'body') {
        if (!Object.hasOwn(scene.bodies ?? {}, layer.body)) fail('body-layer', `panel ${id} draws ${layer.body}, which is not a body`);
        if (layer.trail !== undefined) checkTrail(id, layer.trail);
        if (layer.size !== undefined && !(layer.size > 0)) fail('panel', `panel ${id}: a body layer's size is ${layer.size}, not positive`);
        checkKeyframed(layer.opacity, `panel ${id}: a body layer's opacity`, isOpacity);
      } else if (layer.kind === 'axes') {
        if (layer.span !== undefined && layer.span !== 'full' && layer.span !== 'positive' && layer.span !== 'box')
          fail('panel', `panel ${id}: an axes layer's span is ${JSON.stringify(layer.span)}, not full, positive, or box`);
        if (layer.ticks !== undefined && !(Array.isArray(layer.ticks) && layer.ticks.every((t) => t === 'x' || t === 'y')))
          fail('timeline', `panel ${id}: an axes layer's ticks are ${JSON.stringify(layer.ticks)}, not a list of x and y`);
        if (layer.size !== undefined && !isPositive(layer.size)) fail('timeline', `panel ${id}: an axes layer's size is not positive`);
        const titles = layer.titles as unknown;
        if (titles !== undefined) {
          if (!Array.isArray(titles) || titles.length !== 2)
            fail('timeline', `panel ${id}: an axes layer's titles are ${JSON.stringify(titles)}, not two texts`);
          for (const tt of titles) checkParts(scene, tt, `panel ${id}: an axes title`);
        }
        checkKeyframed(layer.opacity, `panel ${id}: an axes layer's opacity`, isOpacity);
      } else if (layer.kind === 'grid') {
        if (layer.labels !== undefined && typeof layer.labels !== 'boolean')
          fail('panel', `panel ${id}: a grid layer's labels is ${JSON.stringify(layer.labels)}, not a boolean`);
        checkKeyframed(layer.opacity, `panel ${id}: a grid layer's opacity`, isOpacity);
      }
    }
  }
  for (const c of scene.controls ?? []) {
    if (!CONTROL_KINDS.includes(c.kind)) fail('version', `control kind ${JSON.stringify(c.kind)} is not implemented`);
    if (c.kind === 'slider') {
      checkInputRef(scene, c.input, 'parameter', 'control');
      checkQuery(scene, c.domain);
    } else if (c.kind === 'tabs') checkInputRef(scene, c.input, 'choice', 'control');
    else if (c.kind === 'toggle') checkInputRef(scene, c.input, 'toggle', 'control');
  }
  for (const r of scene.readouts ?? []) {
    if (r.place !== 'caption' && r.place !== 'panel') fail('control', `readout place ${JSON.stringify(r.place)} is not caption or panel`);
    checkParts(scene, r.parts, 'a readout');
  }

  if (data !== undefined) {
    for (const [id, b] of Object.entries(scene.bodies ?? {})) {
      if (b!.image === undefined) continue;
      if (!data.has(b!.image)) fail('body', `body ${id} has image ${JSON.stringify(b!.image)}, which the data container does not hold`);
      if (data.array(b!.image).dtype !== 'uint8') fail('body', `body ${id} has image ${b!.image}, which is not an array of uint8 bytes`);
    }
    const sets = new SetCache(scene, data);
    const layerChannels = new Set<string>();
    for (const v of Object.values(scene.panels))
      for (const l of v!.layers) if ('clock' in l && l.clock !== undefined && l.clock.channel !== INDEX_CHANNEL) layerChannels.add(l.clock.channel);
    for (const id of Object.keys(scene.trajectory_sets)) {
      const s = sets.get(id); // checks the shapes of section 2.1 and rule `two-samples`
      for (const name of Object.keys(s.def.channels ?? {})) s.channel(name);
      for (const name of Object.keys(s.def.parameters ?? {})) {
        const p = s.parameter(name);
        for (let t = 0; t < s.trajectories; t++)
          if (!Number.isFinite(p[t]!)) fail('trajectory-set', `parameter ${name} of trajectory set ${id} is not finite at trajectory ${t}`);
      }
      for (const ch of new Set([...scene.clock.channels, ...layerChannels])) {
        if (ch === INDEX_CHANNEL || !s.hasChannel(ch)) continue;
        const c = s.channel(ch);
        for (let t = 0; t < s.trajectories; t++) {
          const a = s.start(t);
          const m = s.count(t);
          const sign = Math.sign(c[a + 1]! - c[a]!);
          for (let i = 0; i < m; i++) {
            if (!Number.isFinite(c[a + i]!))
              fail('monotone-clock-channel', `clock channel ${ch} of trajectory set ${id} is not finite along trajectory ${t} at sample ${i}`);
            if (i + 1 < m && !((c[a + i + 1]! - c[a + i]!) * sign > 0))
              fail('monotone-clock-channel', `clock channel ${ch} of trajectory set ${id} is not strictly monotone along trajectory ${t} at sample ${i}`);
          }
          if (!Number.isFinite(c[a + m - 1]! - c[a]!))
            fail('monotone-clock-channel', `clock channel ${ch} of trajectory set ${id} has an infinite span along trajectory ${t}`);
        }
      }
    }
  }
  for (const st of state === undefined ? [scene.initial] : [scene.initial, state]) validateState(scene, frames, st, warnings);
  return warnings;
}

/** Checks one state against section 2.8, rules `origin`, `transform-channels`, `clock-channel-carried`, `revolutions` and `members`, and section 2.9. */
function validateState(scene: Scene, frames: Frames, state: State, warnings: string[]): void {
  checkState(scene, state);
  for (const id of layoutIds(state.layout)) checkId(id, 'panel');
  const ratios = (node: Layout): void => {
    if (node.kind === 'panel') return;
    if (!(node.ratio > 0 && node.ratio < 1)) fail('state', `a split ratio is ${String(node.ratio)}, not in (0, 1)`);
    if (node.keyframes !== undefined) checkKeyframes(node.keyframes, 'a split', isShare);
    ratios(node.a);
    ratios(node.b);
  };
  ratios(state.layout);
  const revolutions = clockRevolutions(scene.clock);
  const relative = (scene.readouts ?? [])
    .map((r) => ({
      place: r.place,
      parts: r.parts.filter((p): p is Exclude<typeof p, string> => typeof p !== 'string' && ('parameter' in p || 'attr' in p || 'channel' in p)),
    }))
    .filter((r) => r.parts.length > 0);
  const first = layoutIds(state.layout)[0];
  for (const [pid, panel] of Object.entries(state.panels)) {
    for (const id of Object.keys(panel!.inputs ?? {})) {
      const v = inputDef(scene, id);
      if (v !== undefined && v.scope !== 'per_panel') warnings.push(`panel ${pid} sets ${id}, which is shared and never read there`);
    }
    const declared = scene.panels[panel!.panel]!;
    const scope: PanelScope = { scene, state, panel: panel! };
    const display = displayFrame(scope, declared);
    /** Rules `transform-channels` and `origin` for the path from `from` to the display frame, or for `req` when given, evaluated in the contexts of trajectory set `setId`. */
    const need = (setId: string, from: string, what: string, req = frames.requirements(from, display)) => {
      const set = scene.trajectory_sets[setId]!;
      const ch = [...req.channels].filter((c) => c !== INDEX_CHANNEL && !Object.hasOwn(set.channels ?? {}, c));
      const at = [...req.attrs].filter((a) => !Object.hasOwn(set.attrs ?? {}, a));
      if (ch.length + at.length > 0) {
        fail(
          'transform-channels',
          `panel ${pid}: trajectory set ${setId} lacks ${[...ch.map((c) => `channel ${c}`), ...at.map((a) => `attribute ${a}`)].join(', ')} for ${what} in frame ${display}`,
        );
      }
      // rule `origin` for an attribute scale on the path, which is constant per trajectory set
      for (const fid of edgesUsed(frames, scene, from, display)) {
        const s = scene.frames[fid]!.scale;
        if (s !== undefined && typeof s === 'object' && 'attr' in s && (s.factor ?? 1) * (set.attrs?.[s.attr] ?? NaN) + (s.offset ?? 0) === 0) {
          fail('origin', `panel ${pid}: the scale of frame ${fid} is zero for trajectory set ${setId}`);
        }
      }
    };
    const clocked = (setId: string, what: string, own?: LayerClock) => {
      const set = scene.trajectory_sets[setId]!;
      // a layer with a clock of its own reads its channel alone, in one revolution (rule `layer-clock`)
      const channels = own === undefined ? scene.clock.channels : [own.channel];
      const missing = channels.filter((c) => c !== INDEX_CHANNEL && !Object.hasOwn(set.channels ?? {}, c));
      if (missing.length > 0) fail('clock-channel-carried', `panel ${pid}: trajectory set ${setId}, ${what}, lacks clock channels ${missing.join(', ')}`);
      if (own === undefined && revolutions > 1 && set.periodic !== true)
        fail('revolutions', `panel ${pid}: trajectory set ${setId}, ${what}, is not periodic, and the clock has ${revolutions} revolutions`);
    };
    const member = (setId: string, ref: MemberRef) => {
      const set = scene.trajectory_sets[setId]!;
      if (ref === 'all' || 'evenly_spaced' in ref) return;
      if ('index' in ref) {
        if (ref.index >= set.trajectories)
          fail('members', `panel ${pid}: member index ${ref.index} is not below the trajectory count ${set.trajectories} of trajectory set ${setId}`);
        return;
      }
      const sel = inputDef(scene, ref.input);
      if (sel?.kind === 'parameter' && sel.parameter !== INDEX_PARAMETER && !Object.hasOwn(set.parameters ?? {}, sel.parameter)) {
        fail('members', `panel ${pid}: trajectory set ${setId} lacks parameter ${sel.parameter} for input ${ref.input}`);
      }
    };
    const reference = oneSet(scope, declared.reference.sets);
    if (reference !== null) {
      need(reference, scene.trajectory_sets[reference]!.frame, 'the reference');
      clocked(reference, 'the reference');
      member(reference, declared.reference.member);
      const set = scene.trajectory_sets[reference]!;
      for (const r of relative) {
        if (r.place === 'panel' || pid === first) {
          for (const p of r.parts) {
            if ('parameter' in p && p.parameter !== INDEX_PARAMETER && !Object.hasOwn(set.parameters ?? {}, p.parameter))
              fail('control', `the ${r.place} readout through panel ${pid} names parameter ${p.parameter}, which trajectory set ${reference} lacks`);
            if ('attr' in p && !Object.hasOwn(set.attrs ?? {}, p.attr))
              fail('control', `the ${r.place} readout through panel ${pid} names attribute ${p.attr}, which trajectory set ${reference} lacks`);
            if ('channel' in p && !Object.hasOwn(set.channels ?? {}, p.channel))
              fail('control', `the ${r.place} readout through panel ${pid} names channel ${p.channel}, which trajectory set ${reference} lacks`);
          }
        }
      }
    }
    for (const layer of declared.layers) {
      if (!layerVisible(scope, layer)) continue;
      if (layer.kind === 'trajectories') {
        const id = oneSet(scope, layer.sets);
        if (id === null) continue;
        // a layer that reads from the reference takes the edges from the frame of its set on the set of the reference trajectory (rule `read-from`)
        if (layer.read_from !== 'reference') need(id, scene.trajectory_sets[id]!.frame, 'its trajectories');
        else if (reference !== null) need(reference, scene.trajectory_sets[id]!.frame, `a layer of trajectory set ${id} that reads from the reference`);
        member(id, layer.members);
        if (layer.highlight !== undefined) member(id, { input: layer.highlight.input });
        const set = scene.trajectory_sets[id]!;
        if (layer.color !== undefined && typeof layer.color === 'object') {
          if ('channel' in layer.color && !Object.hasOwn(set.channels ?? {}, layer.color.channel))
            fail('panel', `panel ${pid}: trajectory set ${id} lacks channel ${layer.color.channel} for a layer's color`);
          if ('parameter' in layer.color && !Object.hasOwn(set.parameters ?? {}, layer.color.parameter))
            fail('panel', `panel ${pid}: trajectory set ${id} lacks parameter ${layer.color.parameter} for a layer's color`);
        }
        if (typeof layer.color === 'object' && 'thresholds' in layer.color && !Object.hasOwn(set.channels ?? {}, layer.color.channel))
          fail('panel', `panel ${pid}: trajectory set ${id} lacks channel ${layer.color.channel} for a layer's color`);
        const glow = typeof layer.head === 'object' ? layer.head.glow : undefined;
        if (glow !== undefined && !Object.hasOwn(set.channels ?? {}, glow.channel))
          fail('timeline', `panel ${pid}: trajectory set ${id} lacks channel ${glow.channel} for a head's glow`);
        const hides = (layer.clock !== undefined || scene.clock.mode === 'epoch') && (layer.before === 'hidden' || layer.after === 'hidden');
        if ((layer.reveal ?? 'none') !== 'none' || hasHead(layer) || hides) clocked(id, 'on which a reading is taken', layer.clock);
      } else if (layer.kind === 'arrow') {
        const id = oneSet(scope, layer.sets);
        if (id === null) continue;
        need(id, scene.trajectory_sets[id]!.frame, 'its arrows');
        member(id, layer.members);
        const set = scene.trajectory_sets[id]!;
        for (const c of layer.vector) {
          if (c !== INDEX_CHANNEL && !Object.hasOwn(set.channels ?? {}, c))
            fail('arrow', `panel ${pid}: trajectory set ${id} lacks channel ${c} of an arrow layer's vector`);
        }
        const scale = layer.scale;
        if (typeof scale === 'object' && 'attr' in scale && !Object.hasOwn(set.attrs ?? {}, scale.attr))
          fail('transform-channels', `panel ${pid}: trajectory set ${id} lacks attribute ${scale.attr} for an arrow layer's scale`);
        clocked(id, 'on which a reading is taken', layer.clock);
      } else if (layer.kind === 'points') {
        const id = oneSet(scope, layer.sets);
        if (id === null) continue;
        need(id, scene.trajectory_sets[id]!.frame, 'its points');
        member(id, layer.members);
        const hides = (layer.clock !== undefined || scene.clock.mode === 'epoch') && (layer.before === 'hidden' || layer.after === 'hidden');
        if ((layer.reveal ?? 'none') === 'grow' || hides) clocked(id, 'on which a reading is taken', layer.clock);
      } else if (layer.kind === 'label') {
        const at = layer.at as { sets?: SetQuery; member?: number; frame?: string };
        if (at.sets !== undefined) {
          const id = oneSet(scope, at.sets);
          if (id === null) continue;
          need(id, scene.trajectory_sets[id]!.frame, 'a label');
          if (at.member! >= scene.trajectory_sets[id]!.trajectories)
            fail('label', `panel ${pid}: a label names member ${at.member}, which is not a trajectory of trajectory set ${id}`);
          clocked(id, 'on which a label reads', layer.clock);
        } else if (at.frame !== undefined && reference !== null) need(reference, at.frame, 'a label in another frame');
      } else if (layer.kind === 'inset_box' && reference !== null) {
        const target = insetBoxTarget(scope, layer.panel);
        if (target !== null) need(reference, target.frame, `the inset box of panel ${layer.panel}`);
      } else if (layer.kind === 'body' && reference !== null) {
        need(reference, scene.trajectory_sets[reference]!.frame, `body ${layer.body}`, frames.bodyRequirements(layer.body, display));
      }
    }
    const cam = declared.camera;
    if (cam?.kind === '2d' && cam.keyframes !== undefined) {
      for (const k of cam.keyframes) {
        for (const t of k.follow ?? []) {
          const l = declared.layers[t.layer];
          if (l?.kind !== 'trajectories') continue;
          const id = oneSet(scope, l.sets);
          if (id === null) continue;
          if (t.member >= scene.trajectory_sets[id]!.trajectories)
            fail('camera-keyframes', `panel ${pid}: a camera keyframe follows member ${t.member}, which is not a trajectory of trajectory set ${id}`);
          clocked(id, 'which a camera follows', l.clock);
        }
      }
    }
    if (pid === first) {
      for (const c of scene.controls ?? []) {
        if (c.kind !== 'slider') continue;
        const sel = inputDef(scene, c.input);
        if (sel?.kind !== 'parameter' || sel.parameter === INDEX_PARAMETER) continue;
        for (const setId of querySets(scope, c.domain)) {
          if (!Object.hasOwn(scene.trajectory_sets[setId]!.parameters ?? {}, sel.parameter))
            fail('control', `the slider over ${c.input} has trajectory set ${setId} in its domain, which lacks parameter ${sel.parameter}`);
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
