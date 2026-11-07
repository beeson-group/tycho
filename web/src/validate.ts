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

function checkTrackLayer(scene: Scene, id: string, layer: TrackLayer): void {
  checkQuery(scene, layer.sets);
  if (typeof layer.members === 'object' && 'var' in layer.members) checkVariableRef(scene, layer.members.var, 'selector', 'V3');
  if (typeof layer.members === 'object' && 'count' in layer.members && !(Number.isInteger(layer.members.count) && layer.members.count >= 1)) {
    fail('V3', `view ${id}: member count ${JSON.stringify(layer.members.count)} is not an integer of at least one`);
  }
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
    if (layer.head.size !== undefined && !(layer.head.size > 0)) fail('L3', `view ${id}: a head size is ${layer.head.size}, not positive`);
  }
  for (const key of ['before', 'after'] as const) {
    if (layer[key] !== undefined && layer[key] !== 'clamp' && layer[key] !== 'hidden')
      fail('C3', `view ${id}: a track layer's ${key} is ${JSON.stringify(layer[key])}, not clamp or hidden`);
  }
  if (layer.opacity !== undefined && !unit(layer.opacity)) fail('2.7', `view ${id}: a track layer's opacity is ${layer.opacity}, not in [0, 1]`);
  if (layer.width !== undefined && !(layer.width > 0)) fail('2.7', `view ${id}: a track layer's width is ${layer.width}, not positive`);
  if (layer.color !== undefined && typeof layer.color === 'object') {
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
  for (const [k, v] of Object.entries(scene.theme ?? {}))
    if (typeof v !== 'string' || !COLOR.test(v)) fail('2', `theme ${k} is ${JSON.stringify(v)}, not a #rrggbb color`);
  unknownKeys(scene.clock, CLOCK_KEYS, 'the clock', warnings);
  for (const [id, f] of Object.entries(scene.frames)) unknownKeys(f, FRAME_KEYS, `frame ${id}`, warnings);
  for (const [id, b] of Object.entries(scene.bodies ?? {})) {
    unknownKeys(b, BODY_KEYS, `body ${id}`, warnings);
    if (b!.color !== undefined && !COLOR.test(b!.color)) fail('2.4', `body ${id} has color ${JSON.stringify(b!.color)}, not #rrggbb`);
  }
  for (const [id, s] of Object.entries(scene.track_sets)) unknownKeys(s, SET_KEYS, `track set ${id}`, warnings);
  for (const [id, v] of Object.entries(scene.views)) {
    unknownKeys(v, VIEW_KEYS, `view ${id}`, warnings);
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
    if (Array.isArray(f!.origin)) f!.origin.forEach((s) => checkScalar(s, `the origin of frame ${id}`, true));
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
    if (clock.range === undefined) fail('C2', 'the clock is in value mode but does not have a range of two numbers');
    if (!clock.range.every(finite)) fail('S4', 'the clock range is not finite');
  }
  if (clock.labels !== undefined && clock.labels.length !== clock.channels.length)
    fail('2.6', `the clock has ${clock.labels.length} labels for ${clock.channels.length} channels`);
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
    for (const layer of view!.layers) {
      if (!LAYER_KINDS.includes(layer.kind)) fail('S1', `view ${id}: layer kind ${JSON.stringify(layer.kind)} is not implemented`);
      if (layer.visible !== undefined) checkVariableRef(scene, layer.visible.var, 'toggle', 'L5');
      if (layer.kind === 'track') checkTrackLayer(scene, id, layer);
      else if (layer.kind === 'body') {
        if (!Object.hasOwn(scene.bodies ?? {}, layer.body)) fail('L4', `view ${id} draws ${layer.body}, which is not a body`);
        if (layer.trail !== undefined) checkTrail(id, layer.trail);
        if (layer.size !== undefined && !(layer.size > 0)) fail('2.7', `view ${id}: a body layer's size is ${layer.size}, not positive`);
      } else if (layer.kind === 'axes') {
        if (layer.span !== undefined && layer.span !== 'full' && layer.span !== 'positive')
          fail('2.7', `view ${id}: an axes layer's span is ${JSON.stringify(layer.span)}, not full or positive`);
      } else if (layer.labels !== undefined && typeof layer.labels !== 'boolean')
        fail('2.7', `view ${id}: a grid layer's labels is ${JSON.stringify(layer.labels)}, not a boolean`);
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
    for (const p of r.parts) {
      if (typeof p === 'string') continue;
      if ('var' in p) checkVariableRef(scene, p.var, null, '2.9');
      if ('channel' in p && p.channel === INDEX_CHANNEL) fail('2.9', `a readout channel part names ${INDEX_CHANNEL}, which is not allowed in a readout`);
      if ('attr' in p && (!finite(p.factor ?? 1) || !finite(p.offset ?? 0))) fail('S4', 'a readout attr part has a factor or offset that is not finite');
      if ('digits' in p && p.digits !== undefined && !(Number.isInteger(p.digits) && p.digits >= 1 && p.digits <= 17))
        fail('2.9', `readout digits is ${String(p.digits)}, not in 1 to 17`);
    }
  }

  if (data !== undefined) {
    const sets = new SetCache(scene, data);
    for (const id of Object.keys(scene.track_sets)) {
      const s = sets.get(id); // checks the shapes of section 2.1 and rule T1
      for (const name of Object.keys(s.def.channels ?? {})) s.channel(name);
      for (const name of Object.keys(s.def.parameters ?? {})) {
        const p = s.parameter(name);
        for (let t = 0; t < s.tracks; t++) if (!Number.isFinite(p[t]!)) fail('2.1', `parameter ${name} of track set ${id} is not finite at track ${t}`);
      }
      for (const ch of scene.clock.channels) {
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
    const need = (setId: string, req: { channels: Set<string>; attrs: Set<string> }, what: string) => {
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
      for (const fid of edgesUsed(frames, scene, set.frame, display)) {
        const s = scene.frames[fid]!.scale;
        if (s !== undefined && typeof s === 'object' && 'attr' in s && (s.factor ?? 1) * (set.attrs?.[s.attr] ?? NaN) + (s.offset ?? 0) === 0) {
          fail('F2', `panel ${pid}: the scale of frame ${fid} is zero for track set ${setId}`);
        }
      }
    };
    const clocked = (setId: string, what: string) => {
      const set = scene.track_sets[setId]!;
      const missing = scene.clock.channels.filter((c) => c !== INDEX_CHANNEL && !Object.hasOwn(set.channels ?? {}, c));
      if (missing.length > 0) fail('C5', `panel ${pid}: track set ${setId}, ${what}, lacks clock channels ${missing.join(', ')}`);
      if (laps > 1 && set.periodic !== true) fail('C6', `panel ${pid}: track set ${setId}, ${what}, is not periodic, and the clock has ${laps} laps`);
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
      need(driver, frames.requirements(scene.track_sets[driver]!.frame, display), 'the driver');
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
        need(id, frames.requirements(scene.track_sets[id]!.frame, display), 'its tracks');
        member(id, layer.members);
        if (layer.highlight !== undefined) member(id, { var: layer.highlight.var });
        const set = scene.track_sets[id]!;
        if (layer.color !== undefined && typeof layer.color === 'object') {
          if ('channel' in layer.color && !Object.hasOwn(set.channels ?? {}, layer.color.channel))
            fail('2.7', `panel ${pid}: track set ${id} lacks channel ${layer.color.channel} for a layer's color`);
          if ('parameter' in layer.color && !Object.hasOwn(set.parameters ?? {}, layer.color.parameter))
            fail('2.7', `panel ${pid}: track set ${id} lacks parameter ${layer.color.parameter} for a layer's color`);
        }
        const hides = scene.clock.mode === 'value' && (layer.before === 'hidden' || layer.after === 'hidden');
        if ((layer.reveal ?? 'none') !== 'none' || hasHead(layer) || hides) clocked(id, 'on which a reading is taken');
      } else if (layer.kind === 'body' && driver !== null) {
        need(driver, frames.bodyRequirements(layer.body, display), `body ${layer.body}`);
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
