/**
 * One WebGL renderer for the whole stage. Every panel is a scissor rectangle of the one canvas,
 * with a camera and a three.js scene per panel, and one redraw draws them all. A frame is a
 * function of the state snapshot, the frame index, the stage size, and the pixel scale, plus
 * whatever the user did to a camera after it was fitted.
 *
 * A track layer draws from the static buffers of geometry.ts, one pass per lap (rule C6 of
 * spec/tycho-scene.md). Its shader compares each segment's two readings with the revealed range of
 * its track. Each range is read from a small float texture with one texel per track, so that the
 * reveals `none`, `grow`, and `trail` differ only in this range (rules L1, L2 and C6). The ranges
 * are per track rather than uniforms because in `value` mode every track has a separate reading
 * (rule C2). A second texel per track holds the opacity a highlight's kernel gives it. A line of
 * width 1 is a GL line. A wider one is a quad per segment, offset in screen space by half the width
 * in CSS pixels on each side, and along a trail the width and the opacity taper from the head to
 * the tail. The CPU draws the pieces at the ends of the range, the heads (rule L3), and the bodies
 * and their trails (rule L4) with the evaluator's functions. Under a plane camera the axes and the
 * grid follow the visible rectangle and give their tick numbers and titles as panel labels.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { fail, TychoError } from '../errors.js';
import { bound, clockLaps, lapOf } from '../evaluate/clock.js';
import { hasHead, point, type LayerEnv, type Vertex } from '../evaluate/layers.js';
import {
  displayFrame,
  driverMember,
  layerVisible,
  members as resolveMembers,
  oneSet,
  selectorTrack,
  variableDef,
  variableValue,
  type PanelScope,
} from '../evaluate/resolve.js';
import type { SetData } from '../evaluate/sets.js';
import type { BodyLayer, Camera, ColorSpec, MarkLayer, Scene, State, TrackLayer, View } from '../scene.js';
import { INDEX_CHANNEL } from '../scene.js';
import { colorScale, coloring, gradientCss, gradientStops, hexRgb, mixHex, sceneTheme, type Coloring, type Rgb, type Theme } from './colors.js';
import {
  EMPTY_RANGE,
  GeometryCache,
  lapPairs,
  pairs,
  needsReading,
  pairReadings,
  pairTracks,
  readingPairs,
  revealSpec,
  revealTrack,
  slicePairs,
  trackLapPairs,
  trailCapacity,
  vertexReading,
  type RevealSpec,
  type TrackGeometry,
  type TrackReadings,
} from './geometry.js';
import { mergeColorbars, type Colorbar, type PanelLabel } from './overlay.js';
import { tile, type Rect } from './tiles.js';

/** Width of the gutter between two panels, in CSS pixels. */
export const GUTTER = 6;
const HEAD_SIZE = 9;
const BODY_SIZE = 8;
/** Along a trail, the width and the opacity at the tail, as fractions of those at the head, when the layer does not set a taper. */
const TAPER_WIDTH = 0.25;
const TAPER_OPACITY = 0.35;

const HIDDEN = 'vec4(2.0, 2.0, 2.0, 1.0)';

/**
 * The comparison of rules L1, L2 and C6. A segment of lap uLap is shown when both its readings
 * lie inside its track's range, whose texel holds the lap and the within-lap reading of each end.
 * Along a trail, `along` is 1 at the head and falls to 0 one trail behind it, in loop readings.
 */
const REVEAL_GLSL = /* glsl */ `
attribute vec2 useg;
attribute float track;
uniform highp sampler2D uRanges;
uniform highp sampler2D uAlphas;
uniform int uRangesWidth;
uniform int uKernel;
uniform float uLap;
uniform float uSkip;
uniform float uOpacity;
uniform float uFraction;
uniform float uTaperOpacity;
ivec2 texelOf(float tr) {
  int t = int(tr + 0.5);
  return ivec2(t % uRangesWidth, t / uRangesWidth);
}
bool revealed(vec4 r) {
  bool lo = uLap > r.x || (uLap == r.x && r.y < useg.x);
  bool hi = uLap < r.z || (uLap == r.z && useg.y < r.w);
  return lo && hi && !(uSkip >= 0.0 && abs(track - uSkip) < 0.5);
}
float along(vec4 r, float u) {
  if (uFraction <= 0.0) return 1.0;
  return clamp(1.0 - (r.z + r.w - (uLap + u)) / uFraction, 0.0, 1.0);
}
float alphaOf(float tr) {
  return uKernel == 1 ? texelFetch(uAlphas, texelOf(tr), 0).x : uOpacity;
}
`;

/**
 * A corner of a segment's quad, where position.x is the side, -1 or 1, and position.y the end, 0 or 1.
 * In a perspective view, a segment reaching behind the camera is first trimmed to end between the
 * camera plane and the near plane, as LineMaterial in three.js does, so that its screen direction stays
 * meaningful. A segment wholly behind the camera is not drawn.
 */
const QUAD_GLSL = /* glsl */ `
uniform vec2 uResolution;
void trimSegment(const in vec4 start, inout vec4 end) {
  float nearEstimate = -0.5 * projectionMatrix[3][2] / projectionMatrix[2][2];
  float alpha = (nearEstimate - start.z) / (end.z - start.z);
  end.xyz = mix(start.xyz, end.xyz, alpha);
}
vec4 corner(vec3 a, vec3 b, float w) {
  vec4 va = modelViewMatrix * vec4(a, 1.0);
  vec4 vb = modelViewMatrix * vec4(b, 1.0);
  if (projectionMatrix[2][3] == -1.0) {
    if (va.z >= 0.0 && vb.z >= 0.0) return ${HIDDEN};
    if (va.z < 0.0 && vb.z >= 0.0) trimSegment(va, vb);
    else if (vb.z < 0.0 && va.z >= 0.0) trimSegment(vb, va);
  }
  vec4 ca = projectionMatrix * va;
  vec4 cb = projectionMatrix * vb;
  vec2 d = (cb.xy / cb.w - ca.xy / ca.w) * uResolution;
  float len = length(d);
  vec2 dir = len > 1e-9 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  vec4 c = position.y > 0.5 ? cb : ca;
  c.xy += nrm * position.x * w / uResolution * c.w;
  return c;
}
`;

/** A GL line per segment. Its two vertices are 2j and 2j + 1, hence the parity of a vertex gives its end. */
const NARROW_VERTEX =
  REVEAL_GLSL +
  /* glsl */ `
#ifdef USE_TRACK_COLOR
attribute vec3 tcolor;
#endif
uniform vec3 uColor;
varying vec4 vColor;
void main() {
  vec4 r = texelFetch(uRanges, texelOf(track), 0);
  if (!revealed(r)) {
    vColor = vec4(0.0);
    gl_Position = ${HIDDEN};
    return;
  }
  float s = along(r, gl_VertexID % 2 == 1 ? useg.y : useg.x);
#ifdef USE_TRACK_COLOR
  vec3 rgb = tcolor;
#else
  vec3 rgb = uColor;
#endif
  vColor = vec4(rgb, alphaOf(track) * mix(uTaperOpacity, 1.0, s));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const WIDE_VERTEX =
  REVEAL_GLSL +
  QUAD_GLSL +
  /* glsl */ `
attribute vec3 instanceStart;
attribute vec3 instanceEnd;
#ifdef USE_TRACK_COLOR
attribute vec3 colorStart;
attribute vec3 colorEnd;
#endif
uniform vec3 uColor;
uniform float uWidth;
uniform float uTaperWidth;
varying vec4 vColor;
void main() {
  vec4 r = texelFetch(uRanges, texelOf(track), 0);
  if (!revealed(r)) {
    vColor = vec4(0.0);
    gl_Position = ${HIDDEN};
    return;
  }
  bool atEnd = position.y > 0.5;
  float s = along(r, atEnd ? useg.y : useg.x);
#ifdef USE_TRACK_COLOR
  vec3 rgb = atEnd ? colorEnd : colorStart;
#else
  vec3 rgb = uColor;
#endif
  vColor = vec4(rgb, alphaOf(track) * mix(uTaperOpacity, 1.0, s));
  gl_Position = corner(instanceStart, instanceEnd, uWidth * mix(uTaperWidth, 1.0, s));
}
`;

const PIECE_VERTEX =
  QUAD_GLSL +
  /* glsl */ `
attribute vec3 instanceStart;
attribute vec3 instanceEnd;
attribute vec4 colorStart;
attribute vec4 colorEnd;
attribute float widthStart;
attribute float widthEnd;
varying vec4 vColor;
void main() {
  bool atEnd = position.y > 0.5;
  vColor = atEnd ? colorEnd : colorStart;
  gl_Position = corner(instanceStart, instanceEnd, atEnd ? widthEnd : widthStart);
}
`;

const FRAGMENT = /* glsl */ `
varying vec4 vColor;
void main() {
  gl_FragColor = vColor;
}
`;

function discTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.beginPath();
  g.arc(32, 32, 28, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}

/** A pleasant round step near `range / target`, which is 1, 2 or 5 times a power of ten. */
export function niceStep(range: number, target = 6): number {
  if (!(range > 0) || !Number.isFinite(range)) return 1;
  const raw = range / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const r = raw / mag;
  return (r < 1.5 ? 1 : r < 3.5 ? 2 : r < 7.5 ? 5 : 10) * mag;
}

/** The screen axes of a camera (right, up, and toward the user) in the display frame. */
function cameraBasis(cam: Camera): { right: THREE.Vector3; up: THREE.Vector3; normal: THREE.Vector3 } {
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  if (cam.kind === 'plane') {
    if (cam.plane === 'xz') return { right: v(1, 0, 0), up: v(0, 0, 1), normal: v(0, -1, 0) };
    if (cam.plane === 'yz') return { right: v(0, 1, 0), up: v(0, 0, 1), normal: v(1, 0, 0) };
    return { right: v(1, 0, 0), up: v(0, 1, 0), normal: v(0, 0, 1) };
  }
  // an oblique view, above the plane normal to `up`
  const [e1, e2, e3] =
    cam.up === 'x' ? [v(0, 1, 0), v(0, 0, 1), v(1, 0, 0)] : cam.up === 'y' ? [v(0, 0, 1), v(1, 0, 0), v(0, 1, 0)] : [v(1, 0, 0), v(0, 1, 0), v(0, 0, 1)];
  const normal = e1.clone().addScaledVector(e2, -1.6).addScaledVector(e3, 0.9).normalize();
  const right = new THREE.Vector3().crossVectors(e3, normal).normalize();
  return { right, up: e3, normal };
}

/** The display-frame axes a plane camera shows across and up the screen, as indices into a frame's `axes`. */
function planeAxes(cam: Camera & { kind: 'plane' }): [number, number] {
  return cam.plane === 'xz' ? [0, 2] : cam.plane === 'yz' ? [1, 2] : [0, 1];
}

/** The quad of a segment, with four corners and two triangles, drawn once per instance. */
function quadGeometry(): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0], 3));
  g.setIndex([0, 1, 2, 2, 1, 3]);
  return g;
}

const material = (vertexShader: string, uniforms: Record<string, THREE.IUniform>, defines: Record<string, string> = {}) =>
  new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader: FRAGMENT,
    uniforms,
    defines,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

// buffers shared by every panel

/** Arrays and GPU buffers built once and shared by every geometry that draws them, kept for the renderer's life. */
export class Shared {
  private readonly cache = new Map<string, unknown>();

  get<T>(key: string, make: () => T): T {
    let v = this.cache.get(key) as T | undefined;
    if (v === undefined) {
      v = make();
      this.cache.set(key, v);
    }
    return v;
  }
}

interface DrawContext {
  scene: Scene;
  geometry: GeometryCache;
  shared: Shared;
  theme: Theme;
  disc: THREE.Texture;
}

// what a panel draws, resolved from the state

export interface TrackPlan {
  kind: 'track';
  index: number;
  layer: TrackLayer;
  set: SetData | null;
  /** The members of rule V3, in increasing order. */
  members: number[];
  /** The highlighted member, when the highlight's selector resolves to one of the members. */
  highlight: number | null;
  /** The track that the highlight's selector resolves to in the set, a member or not, which is the center of its kernel. */
  selected: number | null;
  /** The clock channel the layer reads, or null when it does not take a reading. */
  channel: string | null;
  /** The layer's color, where a colormap keyed on a choice is resolved to the colormap that the panel's value of the choice maps to (section 2.7). */
  color: ColorSpec | undefined;
}

export interface BodyPlan {
  kind: 'body';
  index: number;
  layer: BodyLayer;
}

export interface MarkPlan {
  kind: 'axes' | 'grid';
  index: number;
  layer: MarkLayer;
}

export type LayerPlan = TrackPlan | BodyPlan | MarkPlan;

export interface PanelPlan {
  viewId: string;
  view: View;
  display: string;
  scope: PanelScope;
  driver: { set: SetData; track: number } | null;
  layers: LayerPlan[];
}

/** A layer's color with a colormap keyed on a choice (section 2.7) resolved by the panel's value of the choice (rule V1). */
export function resolveColor(scope: PanelScope, spec: ColorSpec | undefined): ColorSpec | undefined {
  if (spec === undefined || typeof spec === 'string' || typeof spec.colormap === 'string') return spec;
  const by = spec.colormap;
  if (variableDef(scope.scene, by.var)?.kind !== 'choice') fail('2.7', `the colormap is keyed on ${by.var}, which is not a choice`);
  const value = variableValue(scope, by.var);
  const name = typeof value === 'string' && Object.hasOwn(by.map, value) ? by.map[value] : undefined;
  if (name === undefined) fail('2.7', `the colormap keyed on ${by.var} does not name a colormap for ${JSON.stringify(value)}`);
  return { ...spec, colormap: name };
}

/** What a panel of a state draws: its display frame, its driver, and its visible layers resolved. */
export function planPanel(scene: Scene, geometry: GeometryCache, state: State, pid: string): PanelPlan {
  const panel = state.panels[pid]!;
  const view = scene.views[panel.view]!;
  const scope: PanelScope = { scene, state, panel };
  const display = displayFrame(scope, view);
  const laps = clockLaps(scene.clock);
  const driverId = oneSet(scope, view.driver.sets);
  const driver = driverId === null ? null : { set: geometry.sets.get(driverId), track: 0 };
  if (driver) {
    driver.track = driverMember(scope, view.driver.member, driver.set);
    if (laps > 1 && !driver.set.periodic) fail('C6', `the driver's track set ${driver.set.id} is not periodic, and the clock has ${laps} laps`);
  }
  const layers: LayerPlan[] = [];
  view.layers.forEach((layer, index) => {
    if (!layerVisible(scope, layer)) return;
    if (layer.kind === 'track') {
      const id = oneSet(scope, layer.sets);
      const set = id === null ? null : geometry.sets.get(id);
      const members = set === null ? [] : resolveMembers(scope, layer.members, set);
      const channel = needsReading(layer, scene.clock) ? state.clock.channel : null;
      if (set !== null && channel !== null && laps > 1 && !set.periodic)
        fail('C6', `a reading is taken on track set ${set.id}, which is not periodic, and the clock has ${laps} laps`);
      const hl = layer.highlight;
      if (hl?.kernel !== undefined) {
        const sel = variableDef(scene, hl.var);
        if (sel?.kind !== 'selector' || (sel.by ?? 'nearest') !== 'nearest' || sel.parameter === undefined)
          fail('2.7', `a highlight kernel needs a selector by nearest, and ${hl.var} is not one`);
      }
      const selected = set !== null && hl !== undefined ? selectorTrack(scope, { var: hl.var }, set) : null;
      const highlight = selected !== null && members.includes(selected) ? selected : null;
      layers.push({ kind: 'track', index, layer, set, members, highlight, selected, channel, color: resolveColor(scope, layer.color) });
    } else if (layer.kind === 'body') layers.push({ kind: 'body', index, layer });
    else layers.push({ kind: layer.kind, index, layer });
  });
  return { viewId: panel.view, view, display, scope, driver, layers };
}

/** What the camera fit depends on: the view, the display frame, the driver's track set, and the track sets of the track layers. */
export function contentKey(plan: PanelPlan): string {
  return [plan.viewId, plan.display, plan.driver?.set.id ?? '', ...plan.layers.map((l) => (l.kind === 'track' ? (l.set?.id ?? '') : ''))].join('\0');
}

type Box6 = [number, number, number, number, number, number];

/**
 * The box a panel's camera fits, which holds every member of every track layer, whole, in every lap
 * from 0 to the top, in the display frame. It is given as minimum then maximum x, y, z, and is null
 * when the track layers do not draw anything.
 */
export function fitBox(plan: PanelPlan, geometry: GeometryCache): Box6 | null {
  let box: Box6 | null = null;
  for (const l of plan.layers) {
    if (l.kind !== 'track' || l.set === null || l.members.length === 0) continue;
    const g = geometry.geometry(l.set.id, plan.display);
    const parts = l.members.length === l.set.tracks ? [g.bounds()] : l.members.map((t) => g.bounds(t));
    for (const b of parts) {
      if (box === null) box = [...b];
      else for (let c = 0; c < 3; c++) ((box[c] = Math.min(box[c]!, b[c]!)), (box[c + 3] = Math.max(box[c + 3]!, b[c + 3]!)));
    }
  }
  return box;
}

/**
 * An orthographic fit, given as the center of the box and half the view's height, for a viewport whose
 * width over height is `aspect`. One world unit is as long across the screen as up it, and a tenth of
 * margin is added.
 */
export function orthoFit(box: THREE.Box3, cam: Camera, aspect: number): { center: THREE.Vector3; halfHeight: number } {
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, 1e-9);
  const { right, up } = cameraBasis(cam);
  const abs = (v: THREE.Vector3) => new THREE.Vector3(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z));
  const hw = cam.kind === 'plane' ? size.dot(abs(right)) / 2 : radius;
  const hh = cam.kind === 'plane' ? size.dot(abs(up)) / 2 : radius;
  const half = Math.max(hh, hw / aspect) * 1.1;
  return { center, halfHeight: half > 1e-12 ? half : Math.max(radius, 1) };
}

/** The opacity of a member at parameter distance `d` from the center of a highlight's kernel (section 2.7). */
export function kernelOpacity(floor: number, kernel: { width: number; opacity: number }, extent: number, d: number): number {
  const ratio = extent > 0 ? d / (kernel.width * extent) : 0;
  return Math.max(floor, kernel.opacity * Math.exp(-ratio * ratio));
}

/** The part of the display plane a plane camera shows, and the steps of its ticks. */
export interface PlaneView {
  /** The visible rectangle along the camera's right and up axes, in display-frame units. */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** The panel's size in CSS pixels. */
  w: number;
  h: number;
  stepX: number;
  stepY: number;
}

/** What an orthographic camera under a plane camera shows, with a tick about every 110 pixels across and 70 up. */
export function planeView(camera: THREE.OrthographicCamera, cam: Camera & { kind: 'plane' }, w: number, h: number): PlaneView {
  const { right, up } = cameraBasis(cam);
  const cx = camera.position.dot(right);
  const cy = camera.position.dot(up);
  const hw = (camera.right - camera.left) / (2 * camera.zoom);
  const hh = (camera.top - camera.bottom) / (2 * camera.zoom);
  return {
    x0: cx - hw,
    x1: cx + hw,
    y0: cy - hh,
    y1: cy + hh,
    w,
    h,
    stepX: niceStep(2 * hw, Math.max(3, w / 110)),
    stepY: niceStep(2 * hh, Math.max(3, h / 70)),
  };
}

/** The multiples of `step` in [a, b]. */
function multiples(a: number, b: number, step: number): number[] {
  const out: number[] = [];
  const k1 = Math.floor(b / step);
  for (let k = Math.ceil(a / step); k <= k1 && out.length < 1000; k++) out.push(k * step);
  return out;
}

/** A tick number with as many decimals as its step, and a true minus. */
function tickText(v: number, step: number): string {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  return (Math.abs(v) < step * 1e-9 ? 0 : v).toFixed(decimals).replace('-', '−');
}

/** A label's width in CSS pixels at the 12 px of a tick number, a little over the widest digit and the minus. */
const tickWidth = (s: string): number => 7 * s.length - 3.5 * (s.split('.').length - 1);

/** The height below which a panel does not have room for the x title under its tick row, and the width below which it does not have room for the y title. */
const TITLE_ROOM = 160;

/**
 * The labels of a plane view. Tick numbers run along the bottom and the left edges, clear of the corners.
 * The two axis titles sit at the bottom center and the left center, the second reading upward, each in a
 * separate row outside the tick numbers. The tick row is centered 28 px above the bottom edge and the x
 * title 10 px above it. The y title sits 10 px from the left edge, and the y tick column is right-aligned
 * clear of it at its widest number. A panel too short or too narrow for a title keeps its ticks.
 */
export function planeLabels(v: PlaneView, ticks: boolean, titles: [string, string] | null): PanelLabel[] {
  const out: PanelLabel[] = [];
  const sx = (x: number) => ((x - v.x0) / (v.x1 - v.x0)) * v.w;
  const sy = (y: number) => v.h - ((y - v.y0) / (v.y1 - v.y0)) * v.h;
  if (ticks) {
    const left: PanelLabel[] = [];
    for (const y of multiples(v.y0, v.y1, v.stepY)) {
      const py = sy(y);
      if (py > 22 && py < v.h - 44) left.push({ text: tickText(y, v.stepY), x: 0, y: py, align: 'end', kind: 'tick' });
    }
    // the column ends where its widest number starts 22 px from the edge, clear of the y title
    const column = Math.max(44, 22 + Math.max(0, ...left.map((l) => tickWidth(l.text))));
    for (const x of multiples(v.x0, v.x1, v.stepX)) {
      const px = sx(x);
      if (px > column + 12 && px < v.w - 16) out.push({ text: tickText(x, v.stepX), x: px, y: v.h - 28, align: 'center', kind: 'tick' });
    }
    for (const l of left) out.push({ ...l, x: column });
  }
  if (titles !== null) {
    if (titles[0] !== '' && v.h >= TITLE_ROOM) out.push({ text: titles[0], x: v.w / 2, y: v.h - 10, align: 'center', kind: 'title' });
    if (titles[1] !== '' && v.w >= TITLE_ROOM) out.push({ text: titles[1], x: 10, y: v.h / 2, align: 'center', rotate: true, kind: 'title' });
  }
  return out;
}

interface Draw {
  readonly key: string;
  readonly group: THREE.Group;
  extend(box: THREE.Box3): void;
  resize?(w: number, h: number): void;
  dispose(): void;
}

// track layers

interface PassSpec {
  lap: number;
  highlight: boolean;
  width: number;
  opacity: number;
}

/** The arrays a track layer draws from, shared by its passes. */
interface TrackSource {
  ctx: DrawContext;
  set: SetData;
  geo: TrackGeometry;
  display: string;
  /** The readings for the comparison, on the layer's channel, or on @index when the layer does not take a reading. */
  readings: TrackReadings;
  colorKey: string;
  coloring: Coloring;
  /** The base passes read each track's opacity from the kernel's texel. */
  kernel: boolean;
}

/**
 * One pass of a track layer in one lap. It draws the whole set from buffers that every panel shares, or
 * one track from small per-track buffers, as GL lines when the width is 1 and as quads when it is wider.
 */
class Pass {
  readonly holder = new THREE.Object3D();
  readonly mat: THREE.ShaderMaterial;
  readonly spec: PassSpec;
  private readonly src: TrackSource;
  private readonly wide: boolean;
  private obj: THREE.Mesh | THREE.LineSegments | null = null;
  private sharedNames: string[] = [];
  private shown = '';

  constructor(src: TrackSource, spec: PassSpec, uniforms: Record<string, THREE.IUniform>) {
    this.src = src;
    this.spec = spec;
    this.wide = spec.width > 1;
    const own: Record<string, THREE.IUniform> = {
      ...uniforms,
      uLap: { value: spec.lap },
      uSkip: { value: -1 },
      uOpacity: { value: spec.opacity },
      uWidth: { value: spec.width },
      uKernel: { value: src.kernel && !spec.highlight ? 1 : 0 },
    };
    const defines = src.coloring.kind === 'sample' ? { USE_TRACK_COLOR: '' } : undefined;
    this.mat = material(this.wide ? WIDE_VERTEX : NARROW_VERTEX, own, defines);
  }

  /** Shows the whole set or one track, or clears the pass when `what` is null. */
  show(what: 'set' | number | null): void {
    const key = what === null ? '' : String(what);
    if (key === this.shown) return;
    this.clear();
    this.shown = key;
    if (what === null) return;
    const geometry = this.wide ? this.quads(what) : this.lines(what);
    this.obj = this.wide ? new THREE.Mesh(geometry, this.mat) : new THREE.LineSegments(geometry, this.mat);
    this.obj.frustumCulled = false;
    this.obj.renderOrder = this.holder.parent?.renderOrder ?? 0;
    this.holder.add(this.obj);
  }

  /** The four arrays in pair layout, for the whole set (shared) or for one track. */
  private arrays(what: 'set' | number): { pos: Float32Array; u: Float32Array; tr: Float32Array; col: Float32Array | null } {
    const { ctx, set, geo, display, readings, coloring: c, colorKey } = this.src;
    const lap = this.spec.lap;
    if (what === 'set') {
      return {
        pos: ctx.shared.get(`pos\0${set.id}\0${display}\0${geo.lapKey(lap)}`, () => lapPairs(geo, lap)),
        u: ctx.shared.get(`u\0${set.id}\0${readings.channel}`, () => pairReadings(set, readings.u)),
        tr: ctx.shared.get(`t\0${set.id}`, () => pairTracks(set)),
        col: c.kind === 'sample' ? ctx.shared.get(`c\0${set.id}\0${colorKey}`, () => pairs(set, c.rgb, 3)) : null,
      };
    }
    const s = set.start(what);
    const m = set.count(what);
    return {
      pos: trackLapPairs(geo, what, lap),
      u: readingPairs(readings.u, s, m),
      tr: new Float32Array(2 * (m - 1)).fill(what),
      col: c.kind === 'sample' ? slicePairs(c.rgb, 3, s, m) : null,
    };
  }

  private lines(what: 'set' | number): THREE.BufferGeometry {
    const a = this.arrays(what);
    const attr = (name: string, array: Float32Array, k: number) =>
      what === 'set'
        ? this.src.ctx.shared.get(`gl\0${name}\0${this.src.set.id}\0${keyOf(array)}`, () => new THREE.BufferAttribute(array, k))
        : new THREE.BufferAttribute(array, k);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', attr('position', a.pos, 3));
    g.setAttribute('useg', attr('useg', a.u, 2));
    g.setAttribute('track', attr('track', a.tr, 1));
    if (a.col) g.setAttribute('tcolor', attr('tcolor', a.col, 3));
    this.sharedNames = what === 'set' ? Object.keys(g.attributes) : [];
    return g;
  }

  private quads(what: 'set' | number): THREE.InstancedBufferGeometry {
    const a = this.arrays(what);
    const buffer = (name: string, array: Float32Array, stride: number) =>
      what === 'set'
        ? this.src.ctx.shared.get(`gpu\0${name}\0${this.src.set.id}\0${keyOf(array)}`, () => new THREE.InstancedInterleavedBuffer(array, stride))
        : new THREE.InstancedInterleavedBuffer(array, stride);
    const g = quadGeometry();
    const pos = buffer('pos', a.pos, 6);
    g.setAttribute('instanceStart', new THREE.InterleavedBufferAttribute(pos, 3, 0));
    g.setAttribute('instanceEnd', new THREE.InterleavedBufferAttribute(pos, 3, 3));
    g.setAttribute('useg', new THREE.InterleavedBufferAttribute(buffer('u', a.u, 4), 2, 0));
    g.setAttribute('track', new THREE.InterleavedBufferAttribute(buffer('t', a.tr, 2), 1, 0));
    if (a.col) {
      const col = buffer('c', a.col, 6);
      g.setAttribute('colorStart', new THREE.InterleavedBufferAttribute(col, 3, 0));
      g.setAttribute('colorEnd', new THREE.InterleavedBufferAttribute(col, 3, 3));
    }
    g.instanceCount = a.pos.length / 6;
    this.sharedNames = what === 'set' ? Object.keys(g.attributes).filter((n) => n !== 'position') : [];
    return g;
  }

  /** Removes the current object and disposes of its geometry, after detaching the attributes that the panels share. */
  private clear(): void {
    if (this.obj === null) return;
    this.holder.remove(this.obj);
    for (const n of this.sharedNames) this.obj.geometry.deleteAttribute(n);
    this.obj.geometry.dispose();
    this.obj = null;
    this.sharedNames = [];
  }

  dispose(): void {
    this.clear();
    this.mat.dispose();
  }
}

/** A stable name for a shared array, so that its two GPU wrappers are built once each. */
const ids = new WeakMap<Float32Array, number>();
let nextId = 0;
function keyOf(a: Float32Array): number {
  let id = ids.get(a);
  if (id === undefined) {
    id = nextId++;
    ids.set(a, id);
  }
  return id;
}

/** The end pieces of every drawn track, computed on the CPU, as quads with a color, an opacity, and a width at each end. */
class Pieces {
  readonly mesh: THREE.Mesh;
  private buffer: THREE.InstancedInterleavedBuffer;
  private readonly mat: THREE.ShaderMaterial;
  n = 0;

  constructor(capacity: number, resolution: THREE.IUniform) {
    this.mat = material(PIECE_VERTEX, { uResolution: resolution });
    this.buffer = this.allocate(capacity);
    this.mesh = new THREE.Mesh(this.geometry(), this.mat);
    this.mesh.frustumCulled = false;
  }

  private allocate(capacity: number): THREE.InstancedInterleavedBuffer {
    const b = new THREE.InstancedInterleavedBuffer(new Float32Array(16 * Math.max(1, capacity)), 16);
    b.setUsage(THREE.DynamicDrawUsage);
    return b;
  }

  private geometry(): THREE.InstancedBufferGeometry {
    const g = quadGeometry();
    const b = this.buffer;
    g.setAttribute('instanceStart', new THREE.InterleavedBufferAttribute(b, 3, 0));
    g.setAttribute('instanceEnd', new THREE.InterleavedBufferAttribute(b, 3, 3));
    g.setAttribute('colorStart', new THREE.InterleavedBufferAttribute(b, 4, 6));
    g.setAttribute('colorEnd', new THREE.InterleavedBufferAttribute(b, 4, 10));
    g.setAttribute('widthStart', new THREE.InterleavedBufferAttribute(b, 1, 14));
    g.setAttribute('widthEnd', new THREE.InterleavedBufferAttribute(b, 1, 15));
    g.instanceCount = 0;
    return g;
  }

  /** The array to write `count` pieces into, grown when it is too small. */
  begin(count: number): Float32Array {
    if (16 * count > this.buffer.array.length) {
      this.mesh.geometry.dispose();
      this.buffer = this.allocate(2 * count);
      this.mesh.geometry = this.geometry();
    }
    this.n = 0;
    return this.buffer.array as Float32Array;
  }

  end(): void {
    (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = this.n;
    this.mesh.visible = this.n > 0;
    this.buffer.clearUpdateRanges();
    this.buffer.addUpdateRange(0, 16 * this.n);
    this.buffer.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}

/** A highlight's kernel over a layer's set, with the selector's parameter, its values, and their extent. */
interface Kernel {
  parameter: string;
  width: number;
  opacity: number;
  values: ArrayLike<number>;
  extent: number;
}

function kernelOf(ctx: DrawContext, layer: TrackLayer, set: SetData): Kernel | null {
  const k = layer.highlight?.kernel;
  if (k === undefined) return null;
  const sel = variableDef(ctx.scene, layer.highlight!.var);
  if (sel?.kind !== 'selector' || sel.parameter === undefined) return null;
  const values = set.parameter(sel.parameter, '2.7');
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < values.length; i++) ((lo = Math.min(lo, values[i]!)), (hi = Math.max(hi, values[i]!)));
  return { parameter: sel.parameter, width: k.width, opacity: k.opacity, values, extent: hi >= lo ? hi - lo : 0 };
}

/** A float texture with one RGBA texel per track, in rows of at most 2048. */
function trackTexture(tracks: number): { data: Float32Array; texture: THREE.DataTexture; width: number } {
  const width = Math.min(Math.max(tracks, 1), 2048);
  const height = Math.ceil(Math.max(tracks, 1) / width);
  const data = new Float32Array(4 * width * height);
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { data, texture, width };
}
