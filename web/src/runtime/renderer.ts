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

export class TrackDraw implements Draw {
  readonly key: string;
  readonly group = new THREE.Group();
  private readonly src: TrackSource;
  private readonly layer: TrackLayer;
  private readonly set: SetData;
  private readonly geo: TrackGeometry;
  private readonly clocks: TrackReadings | null;
  private readonly spec: RevealSpec;
  private readonly color: ColorSpec | undefined;
  private readonly width: number;
  private readonly hiWidth: number;
  private readonly opacity: number;
  private readonly hiOpacity: number;
  /** Along a trail, the loop readings over which the taper falls, else 0, and the width and opacity it falls to. */
  private readonly fraction: number;
  private readonly taperWidth: number;
  private readonly taperOpacity: number;
  private readonly kernel: Kernel | null;
  private readonly ranges: ReturnType<typeof trackTexture>;
  private readonly alphas: ReturnType<typeof trackTexture> | null;
  private readonly resolution: THREE.IUniform<THREE.Vector2> = { value: new THREE.Vector2(1, 1) };
  private readonly uniforms: Record<string, THREE.IUniform>;
  private readonly baseHolder = new THREE.Object3D();
  private readonly hiHolder = new THREE.Object3D();
  /** The passes built so far, by lap and kind, each built the first time its lap shows anything. */
  private readonly passes = new Map<string, Pass>();
  private readonly pieces: Pieces;
  private heads: THREE.Points | null = null;
  private readonly headSize: number;
  private readonly headColor: Rgb | null;
  private members: number[] = [];
  private highlight: number | null = null;
  private selected: number | null = null;
  private baseWhat: 'set' | number | null = null;
  private skip = -1;
  private filled = false;

  constructor(ctx: DrawContext, plan: TrackPlan & { set: SetData }, display: string, key: string) {
    this.key = key;
    const set = plan.set;
    const layer = plan.layer;
    this.set = set;
    this.layer = layer;
    this.geo = ctx.geometry.geometry(set.id, display);
    this.clocks = plan.channel === null ? null : ctx.geometry.readings(set.id, plan.channel);
    const readings = this.clocks ?? ctx.geometry.readings(set.id, INDEX_CHANNEL);
    this.spec = revealSpec(layer, set.periodic, clockLaps(ctx.scene.clock));
    this.color = plan.color;
    const color = coloring(plan.color, set, hexRgb(ctx.theme.foreground));
    this.kernel = kernelOf(ctx, layer, set);
    this.src = { ctx, set, geo: this.geo, display, readings, colorKey: JSON.stringify(plan.color ?? null), coloring: color, kernel: this.kernel !== null };
    this.width = layer.width ?? 1;
    this.hiWidth = layer.highlight?.width ?? this.width;
    this.opacity = layer.opacity ?? 1;
    this.hiOpacity = layer.highlight?.opacity ?? 1;
    this.fraction = this.spec.reveal === 'trail' ? this.spec.laps * this.spec.fraction : 0;
    this.taperWidth = layer.trail?.taper?.width ?? TAPER_WIDTH;
    this.taperOpacity = layer.trail?.taper?.opacity ?? TAPER_OPACITY;

    this.ranges = trackTexture(set.tracks);
    for (let t = 0; t < set.tracks; t++) this.ranges.data.set(EMPTY_RANGE, 4 * t);
    this.alphas = this.kernel === null ? null : trackTexture(set.tracks);
    this.uniforms = {
      uRanges: { value: this.ranges.texture },
      uAlphas: { value: (this.alphas ?? this.ranges).texture },
      uRangesWidth: { value: this.ranges.width },
      uColor: { value: new THREE.Vector3(...(color.kind === 'constant' ? color.rgb : [1, 1, 1])) },
      uResolution: this.resolution,
      uFraction: { value: this.fraction },
      uTaperWidth: { value: this.taperWidth },
      uTaperOpacity: { value: this.fraction > 0 ? this.taperOpacity : 1 },
    };
    this.group.add(this.baseHolder, this.hiHolder);

    // the end pieces computed on the CPU, at most two per track
    this.pieces = new Pieces(2 * Math.min(set.tracks, 64), this.resolution);
    this.group.add(this.pieces.mesh);

    const head = layer.head;
    this.headSize = typeof head === 'object' && head !== null ? (head.size ?? HEAD_SIZE) : HEAD_SIZE;
    this.headColor = typeof head === 'object' && head !== null && head.color !== undefined ? hexRgb(head.color) : null;
    if (hasHead(layer)) {
      const hm = new THREE.PointsMaterial({
        size: this.headSize,
        sizeAttenuation: false,
        map: ctx.disc,
        alphaTest: 0.5,
        vertexColors: true,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      });
      this.heads = new THREE.Points(new THREE.BufferGeometry(), hm);
      this.heads.frustumCulled = false;
      this.growHeads(1);
      this.group.add(this.heads);
    }
  }

  /** Room for `n` heads in the heads' buffers. */
  private growHeads(n: number): void {
    const heads = this.heads;
    if (heads === null) return;
    const have = heads.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (have !== undefined && have.count >= n) return;
    heads.geometry.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * n), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(3 * n), 3).setUsage(THREE.DynamicDrawUsage));
    heads.geometry = g;
  }

  resize(w: number, h: number): void {
    this.resolution.value.set(Math.max(1, w), Math.max(1, h));
  }

  /** The color of a vertex of track `t`, which is the layer's color or a blend of the colors of two samples. */
  private colorAt(t: number, v: Vertex, out: Float32Array, o: number): void {
    const c = this.src.coloring;
    if (c.kind === 'constant') {
      out.set(c.rgb, o);
      return;
    }
    const s = this.set.start(t);
    if ('sample' in v) {
      for (let k = 0; k < 3; k++) out[o + k] = c.rgb[3 * (s + v.sample) + k]!;
      return;
    }
    for (let k = 0; k < 3; k++) out[o + k] = (1 - v.w) * c.rgb[3 * (s + v.k) + k]! + v.w * c.rgb[3 * (s + v.k + 1) + k]!;
  }

  /** Each track's opacity under the highlight's kernel, around the selected track's parameter value. */
  private fillKernel(): void {
    const k = this.kernel;
    if (k === null || this.alphas === null) return;
    const centre = this.selected === null ? null : k.values[this.selected]!;
    for (let t = 0; t < this.set.tracks; t++) {
      this.alphas.data[4 * t] = centre === null ? this.opacity : kernelOpacity(this.opacity, k, k.extent, Math.abs(k.values[t]! - centre));
    }
    this.alphas.texture.needsUpdate = true;
  }

  private showPass(p: Pass): void {
    p.show(p.spec.highlight ? this.highlight : this.baseWhat);
    p.mat.uniforms.uSkip!.value = p.spec.highlight ? -1 : this.skip;
  }

  private pass(lap: number, highlight: boolean): Pass {
    const key = `${highlight ? 'h' : 'b'}${lap}`;
    let p = this.passes.get(key);
    if (p === undefined) {
      p = new Pass(
        this.src,
        { lap, highlight, width: highlight ? this.hiWidth : this.width, opacity: highlight ? this.hiOpacity : this.opacity },
        this.uniforms,
      );
      (highlight ? this.hiHolder : this.baseHolder).add(p.holder);
      this.passes.set(key, p);
      this.showPass(p);
    }
    return p;
  }

  /** Shows the passes of the laps that draw a segment, building the ones not built yet, and hides the others. */
  private syncPasses(base: [number, number], hi: [number, number]): void {
    for (const p of this.passes.values()) p.holder.visible = false;
    if (this.baseWhat !== null) for (let lap = base[0]; lap <= base[1]; lap++) this.pass(lap, false).holder.visible = true;
    if (this.highlight !== null) for (let lap = hi[0]; lap <= hi[1]; lap++) this.pass(lap, true).holder.visible = true;
  }

  /** True when the layer does not take a reading, so that what it draws changes only with its members, its highlight, and its selection. */
  get isStatic(): boolean {
    return this.clocks === null;
  }

  /** Returns whether the picture changed through new members, a new highlight or selection, or a first fill. */
  update(plan: TrackPlan, scene: Scene, q: number): boolean {
    const h = plan.highlight;
    const changed =
      plan.members.length !== this.members.length ||
      plan.members.some((t, i) => t !== this.members[i]) ||
      h !== this.highlight ||
      plan.selected !== this.selected;
    if (changed) {
      const single = plan.layer.members !== 'all' && plan.members.length === 1 ? plan.members[0]! : -1;
      this.members = plan.members;
      this.highlight = h;
      this.selected = plan.selected;
      this.baseWhat = single >= 0 ? (single === h ? null : single) : plan.members.length > 0 ? 'set' : null;
      this.skip = single < 0 && h !== null ? h : -1;
      for (const p of this.passes.values()) this.showPass(p);
      for (let t = 0; t < this.set.tracks; t++) this.ranges.data.set(EMPTY_RANGE, 4 * t);
      this.fillKernel();
      this.growHeads(plan.members.length);
      this.filled = false;
    }
    if (this.clocks === null && this.filled) return false;
    const P = this.pieces.begin(2 * plan.members.length);
    const hp = this.heads?.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    const hc = this.heads?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    let heads = 0;
    const base: [number, number] = [Infinity, -Infinity];
    const hi: [number, number] = [Infinity, -Infinity];
    for (const t of plan.members) {
      const tc = this.clocks?.clocks[t] ?? null;
      const rev = revealTrack(tc, scene.clock, q, this.spec, Math.fround);
      this.ranges.data.set(rev.range, 4 * t);
      const isHi = t === h;
      // every lap draws, also where all laps have the same positions and coincide, as the
      // line that the evaluator returns holds every lap (rule C6)
      if (rev.laps !== null) {
        const r = isHi ? hi : base;
        r[0] = Math.min(r[0], rev.laps[0]);
        r[1] = Math.max(r[1], rev.laps[1]);
      }
      const width = isHi ? this.hiWidth : this.width;
      const alpha = isHi ? this.hiOpacity : this.alphas !== null ? this.alphas.data[4 * t]! : this.opacity;
      const tapered = this.fraction > 0 && rev.loop !== null;
      for (const piece of rev.pieces) {
        const o = 16 * this.pieces.n++;
        piece.forEach((v, e) => {
          this.geo.vertex(t, v, P, o + 3 * e);
          this.colorAt(t, v, P, o + 6 + 4 * e);
          const s = tapered ? clamp01(1 - (rev.loop! - vertexReading(tc!, v)) / this.fraction) : 1;
          P[o + 9 + 4 * e] = alpha * (tapered ? this.taperOpacity + (1 - this.taperOpacity) * s : 1);
          P[o + 14 + e] = width > 1 && tapered ? width * (this.taperWidth + (1 - this.taperWidth) * s) : width;
        });
      }
      if (hp !== undefined && hc !== undefined && rev.head !== null && heads < hp.count) {
        this.geo.vertex(t, rev.head, hp.array as Float32Array, 3 * heads);
        if (this.headColor !== null) (hc.array as Float32Array).set(this.headColor, 3 * heads);
        else this.colorAt(t, rev.head, hc.array as Float32Array, 3 * heads);
        heads++;
      }
    }
    this.pieces.end();
    if (this.heads !== null) {
      hp!.needsUpdate = hc!.needsUpdate = true;
      this.heads.geometry.setDrawRange(0, heads);
    }
    this.syncPasses(base, hi);
    this.ranges.texture.needsUpdate = true;
    this.filled = true;
    return true;
  }

  extend(): void {}

  /** The colorbar of a colormapped layer, with the highlighted or single member marked on it, and the kernel's band. */
  colorbar(): Colorbar | null {
    const spec = this.color;
    if (spec === undefined || typeof spec === 'string') return null;
    const scale = colorScale(spec, this.set);
    const params = this.set.def.parameters ?? {};
    const def = scale.perTrack && Object.hasOwn(params, scale.name) ? params[scale.name] : undefined;
    const label = def?.label ?? scale.name;
    const [lo, hi] = scale.range;
    const at = (v: number) => (hi === lo ? 0.5 : clamp01((v - lo) / (hi - lo)));
    const member = this.highlight ?? (this.layer.members !== 'all' && this.members.length === 1 ? this.members[0]! : null);
    const marker = scale.perTrack && member !== null ? at(scale.values[member]!) : null;
    const k = this.kernel;
    let band: [number, number] | null = null;
    if (k !== null && scale.perTrack && scale.name === k.parameter && this.selected !== null) {
      const v = scale.values[this.selected]!;
      const half = 1.5 * k.width * k.extent;
      band = [at(v - half), at(v + half)];
    }
    return { label: def?.unit ? `${label}, ${def.unit}` : label, gradient: gradientCss(scale), stops: gradientStops(scale), lo, hi, marker, band };
  }

  dispose(): void {
    for (const p of this.passes.values()) p.dispose();
    this.ranges.texture.dispose();
    this.alphas?.texture.dispose();
    this.pieces.dispose();
    if (this.heads) {
      this.heads.geometry.dispose();
      (this.heads.material as THREE.Material).dispose();
    }
  }
}

// body layers

class BodyDraw implements Draw {
  readonly key: string;
  readonly group = new THREE.Group();
  readonly label: string | null;
  readonly size: number;
  /** The body's position at the last frame, for its label, or null when the driver does not match any set. */
  at: THREE.Vector3 | null = null;
  private readonly point: THREE.Points;
  private readonly trail: THREE.Line;
  private readonly geometry: GeometryCache;
  private readonly scratch = new Float64Array(3);
  private capacity = 0;

  constructor(ctx: DrawContext, layer: BodyLayer, key: string) {
    this.key = key;
    this.geometry = ctx.geometry;
    const bodies = ctx.scene.bodies ?? {};
    const body = Object.hasOwn(bodies, layer.body) ? bodies[layer.body] : undefined;
    this.label = body?.label ?? null;
    this.size = layer.size ?? BODY_SIZE;
    const color = new THREE.Color(...hexRgb(body?.color ?? ctx.theme.foreground));
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3).setUsage(THREE.DynamicDrawUsage));
    this.point = new THREE.Points(
      pg,
      new THREE.PointsMaterial({
        color,
        size: this.size,
        sizeAttenuation: false,
        map: ctx.disc,
        alphaTest: 0.5,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.point.frustumCulled = false;
    this.trail = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6, depthTest: false, depthWrite: false }),
    );
    this.trail.frustumCulled = false;
    this.group.add(this.trail, this.point);
  }

  /**
   * Rule L4 as `bodyLayer` in evaluate/layers.ts evaluates it, from the positions kept per lap by the
   * geometry cache. A frame blends the point and the two trail ends, copies the samples between them,
   * and uploads only the vertices it draws.
   */
  update(env: LayerEnv, layer: BodyLayer, driver: PanelPlan['driver']): void {
    if (driver === null) {
      this.point.visible = false;
      this.trail.visible = false;
      this.at = null;
      return;
    }
    const { set, track } = driver;
    const laps = clockLaps(env.clock);
    const tc = this.geometry.readings(set.id, env.channel).clocks[track]!;
    const table = this.geometry.bodyTrail(layer.body, env.display, set.id, track);
    const loopReading = laps * bound(tc.reading(env.clock, env.q))!;
    const at = lapOf(loopReading, laps);
    const s = this.scratch;
    table.vertex(point(tc, at.u, false, at.lap), s);
    this.point.visible = true;
    this.at = new THREE.Vector3(s[0], s[1], s[2]);
    const pa = this.point.geometry.getAttribute('position') as THREE.BufferAttribute;
    pa.setXYZ(0, s[0]!, s[1]!, s[2]!);
    pa.needsUpdate = true;
    if (layer.trail === undefined) {
      this.trail.visible = false;
      return;
    }
    const fraction = layer.trail.fraction;
    let tail = loopReading - laps * fraction;
    if (tail < 0 && !set.periodic) tail = 0;
    const need = trailCapacity(table.m, laps, fraction);
    if (need > this.capacity) {
      this.capacity = need;
      this.trail.geometry.dispose();
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * this.capacity), 3).setUsage(THREE.DynamicDrawUsage));
      this.trail.geometry = g;
    }
    const a = this.trail.geometry.getAttribute('position') as THREE.BufferAttribute;
    const n = table.polyline(tc, tail, loopReading, laps, a.array as Float32Array);
    a.clearUpdateRanges();
    a.addUpdateRange(0, 3 * n);
    a.needsUpdate = true;
    this.trail.geometry.setDrawRange(0, n);
    this.trail.visible = n > 1;
  }

  extend(box: THREE.Box3): void {
    if (this.at !== null) box.expandByPoint(this.at);
  }

  dispose(): void {
    for (const o of [this.point, this.trail]) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  }
}

// axes and grid

/**
 * Lines of an axes or a grid layer. Under a plane camera, axes spanning the view and a grid that
 * numbers its lines follow the visible rectangle and are laid out again whenever it moves. Every
 * other mark is laid out from the fitted box: the grid in the view plane, and the three axes from
 * the origin, both ways when they span the view.
 */
class MarkDraw implements Draw {
  readonly key: string;
  readonly group = new THREE.Group();
  readonly kind: 'axes' | 'grid';
  /** Laid out from the visible rectangle of a plane camera, on every camera change. */
  readonly follows: boolean;
  /** Axes drawn both ways through the origin. */
  readonly full: boolean;
  /** True when the mark gives tick numbers under a plane camera, i.e. for axes spanning the view or a grid with labels. */
  readonly ticks: boolean;
  private readonly theme: Theme;
  private readonly lines: THREE.LineSegments;
  private shown = '';
  /** Axis tips, for the labels of axes laid out from the box. */
  tips: THREE.Vector3[] = [];

  constructor(ctx: DrawContext, layer: MarkLayer, cam: Camera, key: string) {
    this.key = key;
    this.kind = layer.kind;
    this.theme = ctx.theme;
    const plane = cam.kind === 'plane';
    if (layer.kind === 'axes') {
      this.full = (layer.span ?? (plane ? 'full' : 'positive')) === 'full';
      this.ticks = plane && this.full;
    } else {
      this.full = false;
      this.ticks = plane && (layer.labels ?? plane);
    }
    this.follows = this.ticks;
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthTest: false, depthWrite: false });
    this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), mat);
    this.lines.frustumCulled = false;
    this.group.add(this.lines);
  }

  private set(pos: number[], col: number[]): void {
    this.lines.geometry.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
    this.lines.geometry = g;
  }

  layout(box: THREE.Box3, cam: Camera): void {
    if (this.follows) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const ext = Math.max(size.x, size.y, size.z, 1e-9);
    const pos: number[] = [];
    const col: number[] = [];
    const add = (a: THREE.Vector3, b: THREE.Vector3, rgb: Rgb, alpha: number) => {
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      col.push(...rgb, alpha, ...rgb, alpha);
    };
    if (this.kind === 'axes') {
      const len = niceStep(ext, 2);
      const fg = hexRgb(this.theme.foreground);
      this.tips = [new THREE.Vector3(len, 0, 0), new THREE.Vector3(0, len, 0), new THREE.Vector3(0, 0, len)];
      for (const tip of this.tips) add(this.full ? tip.clone().negate() : new THREE.Vector3(), tip, fg, 0.8);
    } else {
      const { right, up, normal } = cameraBasis(cam.kind === 'plane' ? cam : { kind: 'plane', plane: cam.up === 'x' ? 'yz' : cam.up === 'y' ? 'xz' : 'xy' });
      const step = niceStep(ext, 8);
      const grid = hexRgb(this.theme.grid);
      const zero = hexRgb(mixHex(this.theme.grid, this.theme.foreground, 0.3));
      const c0 = center.dot(right);
      const c1 = center.dot(up);
      // the grid lies at 0 along the normal axis when the data spans 0 there, else through the center of the data
      const k = Math.abs(normal.x) > 0.5 ? 'x' : Math.abs(normal.y) > 0.5 ? 'y' : 'z';
      const axis = new THREE.Vector3();
      axis[k] = 1;
      const depth = box.min[k] <= 0 && box.max[k] >= 0 ? 0 : center[k];
      const reach = 2.5 * ext;
      const i0 = Math.floor((c0 - reach) / step);
      const i1 = Math.ceil((c0 + reach) / step);
      const j0 = Math.floor((c1 - reach) / step);
      const j1 = Math.ceil((c1 + reach) / step);
      const at = (a: number, b: number) => right.clone().multiplyScalar(a).addScaledVector(up, b).addScaledVector(axis, depth);
      for (let i = i0; i <= i1; i++) add(at(i * step, j0 * step), at(i * step, j1 * step), i === 0 ? zero : grid, 1);
      for (let j = j0; j <= j1; j++) add(at(i0 * step, j * step), at(i1 * step, j * step), j === 0 ? zero : grid, 1);
    }
    this.set(pos, col);
  }

  /** Lays the lines out across a plane camera's visible rectangle, unless they are already laid out for it. */
  follow(v: PlaneView, cam: Camera & { kind: 'plane' }): void {
    if (!this.follows) return;
    const key = [v.x0, v.x1, v.y0, v.y1, v.stepX, v.stepY].join(',');
    if (key === this.shown) return;
    this.shown = key;
    const { right, up } = cameraBasis(cam);
    const pos: number[] = [];
    const col: number[] = [];
    const add = (a0: number, b0: number, a1: number, b1: number, rgb: Rgb, alpha: number) => {
      const p = right.clone().multiplyScalar(a0).addScaledVector(up, b0);
      const q = right.clone().multiplyScalar(a1).addScaledVector(up, b1);
      pos.push(p.x, p.y, p.z, q.x, q.y, q.z);
      col.push(...rgb, alpha, ...rgb, alpha);
    };
    if (this.kind === 'axes') {
      const fg = hexRgb(this.theme.foreground);
      if (v.y0 <= 0 && v.y1 >= 0) add(v.x0, 0, v.x1, 0, fg, 0.5);
      if (v.x0 <= 0 && v.x1 >= 0) add(0, v.y0, 0, v.y1, fg, 0.5);
    } else {
      const grid = hexRgb(this.theme.grid);
      const zero = hexRgb(mixHex(this.theme.grid, this.theme.foreground, 0.3));
      for (const x of multiples(v.x0, v.x1, v.stepX)) add(x, v.y0, x, v.y1, x === 0 ? zero : grid, 1);
      for (const y of multiples(v.y0, v.y1, v.stepY)) add(v.x0, y, v.x1, y, y === 0 ? zero : grid, 1);
    }
    this.set(pos, col);
  }

  extend(): void {}

  dispose(): void {
    this.lines.geometry.dispose();
    (this.lines.material as THREE.Material).dispose();
  }
}

// panels

/**
 * A quad over the viewport that copies a panel's region of the underlay back pixel for pixel. The
 * fragment at window position (x, y) takes the texel at (x, y), hence sampling and filtering cannot
 * shift or blur it.
 */
/** Two underlay rebuilds closer than this, in milliseconds, are a drag. */
const DRAG_MS = 100;
/** How long after the last coarse rebuild the underlays are drawn again with antialiasing, in milliseconds. */
const REFINE_MS = 150;

/** A render target of `width` by `height` device pixels for copies pixel for pixel, multisampled when `samples` is above 0. */
function pixelTarget(width: number, height: number, samples: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(width, height, {
    samples,
    depthBuffer: false,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
  });
}

function blitPass(): { scene: THREE.Scene; camera: THREE.Camera; material: THREE.ShaderMaterial } {
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { uUnderlay: { value: null } },
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: 'uniform sampler2D uUnderlay; out vec4 color; void main() { color = texelFetch(uUnderlay, ivec2(gl_FragCoord.xy), 0); }',
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  return { scene, camera: new THREE.OrthographicCamera(), material };
}

/**
 * Whether a camera's world or projection matrix differs from `seen`, which then holds both. The test
 * covers any pan, zoom, rotation, fit, or change of aspect, however the camera was moved.
 */
export function cameraMoved(camera: THREE.Camera, seen: Float64Array): boolean {
  camera.updateMatrixWorld();
  const a = camera.matrixWorld.elements;
  const b = camera.projectionMatrix.elements;
  let moved = false;
  for (let i = 0; i < 16; i++) {
    if (seen[i] !== a[i]) ((moved = true), (seen[i] = a[i]!));
    if (seen[16 + i] !== b[i]) ((moved = true), (seen[16 + i] = b[i]!));
  }
  return moved;
}

type AnyCamera = THREE.OrthographicCamera | THREE.PerspectiveCamera;

class PanelRender {
  readonly id: string;
  /** The layers that move with the clock, drawn every frame. */
  readonly scene = new THREE.Scene();
  /**
   * The bottom run of layers that do not take a reading, drawn once into `underlay` and copied back
   * every frame until the camera, the panel's size, or the layers' members, highlight, or selection change.
   */
  readonly staticScene = new THREE.Scene();
  /** The panel's region of the stage's underlay, in device pixels, when its static layers were last copied there. */
  readonly underlay = new THREE.Vector4(-1, -1, -1, -1);
  underlayDirty = true;
  /** The keys of the draws in `staticScene`, to detect a change of the run when the panel is planned again. */
  staticKey = '';
  /** When the underlay was last drawn again, in milliseconds. */
  rebuiltAt = -Infinity;
  /** The underlay was drawn without antialiasing, during a drag, and is drawn again with it once the drag stops. */
  coarse = false;
  /** The camera's world and projection matrices when the underlay was drawn. */
  readonly cameraSeen = new Float64Array(32);
  camera: AnyCamera = new THREE.OrthographicCamera();
  cameraSpec: Camera = { kind: 'plane', plane: 'xy' };
  controls: OrbitControls | null = null;
  element: HTMLElement | null = null;
  /** Text over the panel: tick numbers, axis titles, and body labels. */
  labels: HTMLElement | null = null;
  plan: PanelPlan | null = null;
  error: string | null = null;
  readonly draws = new Map<number, Draw>();
  rect: Rect = { x: 0, y: 0, w: 1, h: 1 };
  /** What the panel draws, as far as the fit depends on it. A change refits the camera. */
  content = '';
  needsFit = true;
  userMoved = false;
  fitting = false;
  /** Half the height of the orthographic view, at zoom 1. */
  halfHeight = 1;
  /** The box the camera was last fitted to. */
  box: THREE.Box3 | null = null;
  /** What a plane camera showed at the last frame, or null under an orbit camera. */
  view: PlaneView | null = null;

  constructor(id: string) {
    this.id = id;
  }
}

const cameraKey = (c: Camera): string => JSON.stringify(c);

export class StageRenderer {
  readonly canvas: HTMLCanvasElement;
  /** Called when the user moves a camera, so that the page redraws. */
  onChange: () => void = () => undefined;
  private readonly gl: THREE.WebGLRenderer;
  private readonly ctx: DrawContext;
  private readonly panels = new Map<string, PanelRender>();
  private lastState: State | null = null;
  private size = { w: 0, h: 0, ratio: 0 };
  private readonly background: THREE.Color;

  /**
   * Draws each panel's bottom run of layers that do not take a reading once, and copies it back every
   * frame. When it is off, every layer is drawn every frame, as the reference the cache is compared with.
   */
  cacheStatic: boolean;
  /**
   * Draws an underlay without antialiasing when it was drawn again less than DRAG_MS before, as
   * every frame of a slider or camera drag does, and with antialiasing REFINE_MS after the drag stops.
   * It is off for a video export, whose frames must all be finished.
   */
  coarseDrags: boolean;
  private refineTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly blit: { scene: THREE.Scene; camera: THREE.Camera; material: THREE.ShaderMaterial };
  /** Every panel's static layers, each panel in a separate region at the same pixels as on the canvas. */
  private underlay: THREE.WebGLRenderTarget | null = null;
  /**
   * Where a panel's static layers are drawn with antialiasing before they are copied into the
   * underlay, as large as the largest panel. Reading the antialiased canvas back instead gives, in
   * Chrome, the right pixels only for the last panel drawn in a frame, and stale pixels for the others.
   */
  private scratch: THREE.WebGLRenderTarget | null = null;
  private readonly viewport = new THREE.Vector4();
  private readonly buffer = new THREE.Vector2();
  private readonly region = new THREE.Box2();
  private readonly corner = new THREE.Vector2();

  /**
   * The option `preserveDrawingBuffer` is set for a canvas that is read back after the frame, as in a
   * video export. It is left off for a page, which spares the compositor a copy of the canvas every frame.
   */
  constructor(
    canvas: HTMLCanvasElement,
    scene: Scene,
    geometry: GeometryCache,
    options: { preserveDrawingBuffer?: boolean; cacheStatic?: boolean; coarseDrags?: boolean; theme?: Theme } = {},
  ) {
    this.canvas = canvas;
    // colors are sRGB as the page gives them, written unconverted
    THREE.ColorManagement.enabled = false;
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: options.preserveDrawingBuffer ?? false });
    this.cacheStatic = options.cacheStatic ?? true;
    this.coarseDrags = options.coarseDrags ?? true;
    this.blit = blitPass();
    // a lost context takes its textures with it, and every underlay is therefore drawn again
    canvas.addEventListener('webglcontextrestored', () => {
      for (const p of this.panels.values()) p.underlayDirty = true;
    });
    this.gl.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.gl.autoClear = false;
    const theme = options.theme ?? sceneTheme(scene);
    this.background = new THREE.Color(...hexRgb(theme.background));
    this.ctx = { scene, geometry, shared: new Shared(), theme, disc: discTexture() };
  }

  /** Draws with `theme` from the next frame on. The cameras stay, and the next plan rebuilds only the draws that take a color from the theme. */
  setTheme(theme: Theme): void {
    this.ctx.theme = theme;
    this.background.setRGB(...hexRgb(theme.background));
    this.lastState = null;
    for (const p of this.panels.values()) p.underlayDirty = true;
  }

  private panel(pid: string): PanelRender {
    let p = this.panels.get(pid);
    if (!p) {
      p = new PanelRender(pid);
      this.panels.set(pid, p);
    }
    return p;
  }

  /** Gives a panel the element its camera controls listen on and its labels are written into, or takes it away. */
  bind(pid: string, element: HTMLElement | null): void {
    const p = this.panel(pid);
    if (p.element === element) return;
    p.controls?.dispose();
    p.controls = null;
    p.labels?.remove();
    p.labels = null;
    p.element = element;
    if (element !== null) {
      p.labels = document.createElement('div');
      p.labels.className = 'labels';
      element.append(p.labels);
      this.makeControls(p);
    }
  }

  /** Fits a panel's camera to what it draws at the next frame, forgetting how the user moved the camera. */
  refit(pid: string): void {
    const p = this.panels.get(pid);
    if (p) {
      p.needsFit = true;
      p.userMoved = false;
    }
  }

  refitAll(): void {
    for (const pid of this.panels.keys()) this.refit(pid);
  }

  private makeControls(p: PanelRender): void {
    p.controls?.dispose();
    p.controls = null;
    if (p.element === null) return;
    const c = new OrbitControls(p.camera, p.element);
    c.enableDamping = false;
    c.screenSpacePanning = true;
    if (p.cameraSpec.kind === 'plane') {
      c.enableRotate = false;
      c.zoomToCursor = true;
      c.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      c.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
    }
    c.addEventListener('change', () => {
      if (p.fitting) return;
      p.userMoved = true;
      this.onChange();
    });
    p.controls = c;
  }

  private setCamera(p: PanelRender, spec: Camera): void {
    p.cameraSpec = spec;
    const ortho = spec.kind === 'plane' || spec.projection === 'orthographic';
    p.camera = ortho ? new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1) : new THREE.PerspectiveCamera(35, 1, 0.01, 100);
    p.needsFit = true;
    p.userMoved = false;
    this.makeControls(p);
  }

  /**
   * Draws a panel's static layers into the viewport just set, copied back from the underlay, which
   * is drawn again first when anything they depend on changed.
   */
  private drawStatic(p: PanelRender): void {
    if (p.staticScene.children.length === 0) return;
    if (!this.cacheStatic) {
      this.gl.render(p.staticScene, p.camera);
      return;
    }
    const size = this.gl.getDrawingBufferSize(this.buffer);
    if (this.underlay === null || this.underlay.width !== size.x || this.underlay.height !== size.y) {
      this.underlay?.dispose();
      this.underlay = pixelTarget(size.x, size.y, 0);
      // the texture of the underlay must exist before a copy into it
      this.gl.initRenderTarget(this.underlay);
      for (const q of this.panels.values()) q.underlayDirty = true;
    }
    const vp = this.gl.getCurrentViewport(this.viewport);
    if (!vp.equals(p.underlay)) {
      p.underlay.copy(vp);
      p.underlayDirty = true;
    }
    if (cameraMoved(p.camera, p.cameraSeen)) p.underlayDirty = true;
    if (p.underlayDirty) {
      p.underlayDirty = false;
      const now = performance.now();
      p.coarse = this.coarseDrags && now - p.rebuiltAt < DRAG_MS;
      p.rebuiltAt = now;
      if (p.coarse) {
        this.drawCoarse(p, this.underlay, vp);
        this.scheduleRefine();
      } else this.drawFine(p, this.underlay, vp);
    }
    this.blit.material.uniforms.uUnderlay!.value = this.underlay.texture;
    this.gl.render(this.blit.scene, this.blit.camera);
  }

  /** Draws a panel's static layers straight into its region of `target`, which is not multisampled. */
  private drawCoarse(p: PanelRender, target: THREE.WebGLRenderTarget, r: THREE.Vector4): void {
    target.viewport.copy(r);
    target.scissor.copy(r);
    target.scissorTest = true;
    this.gl.setRenderTarget(target);
    this.gl.clear(true, false, false);
    this.gl.render(p.staticScene, p.camera);
    this.gl.setRenderTarget(null);
  }

  /** Draws every coarse underlay again with antialiasing once REFINE_MS pass without a coarse one. */
  private scheduleRefine(): void {
    if (this.refineTimer !== null) clearTimeout(this.refineTimer);
    this.refineTimer = setTimeout(() => {
      this.refineTimer = null;
      for (const q of this.panels.values()) {
        if (!q.coarse) continue;
        q.underlayDirty = true;
        q.rebuiltAt = -Infinity;
      }
      this.onChange();
    }, REFINE_MS);
  }

  /**
   * Draws a panel's static layers with antialiasing into the scratch target, which three resolves
   * after the draw, and copies them into the panel's region `r` of `target`.
   */
  private drawFine(p: PanelRender, target: THREE.WebGLRenderTarget, r: THREE.Vector4): void {
    let s = this.scratch;
    if (s === null || s.width < r.z || s.height < r.w) {
      s?.dispose();
      s = this.scratch = pixelTarget(Math.max(r.z, s?.width ?? 0), Math.max(r.w, s?.height ?? 0), 4);
    }
    s.viewport.set(0, 0, r.z, r.w);
    s.scissor.set(0, 0, r.z, r.w);
    s.scissorTest = true;
    this.gl.setRenderTarget(s);
    this.gl.clear(true, false, false);
    this.gl.render(p.staticScene, p.camera);
    this.gl.setRenderTarget(null);
    this.region.min.set(0, 0);
    // at a fractional pixel ratio, the viewport is rounded up past the end of the drawing buffer
    this.region.max.set(Math.min(r.z, target.width - r.x), Math.min(r.w, target.height - r.y));
    this.gl.copyTextureToTexture(s.texture, target.texture, this.region, this.corner.set(r.x, r.y));
  }

  private disposePanel(p: PanelRender): void {
    for (const d of p.draws.values()) d.dispose();
    p.draws.clear();
    p.controls?.dispose();
    p.labels?.remove();
    this.panels.delete(p.id);
  }

  /** Re-resolves a panel against a new state, rebuilding only the draws whose inputs changed. */
  private replan(p: PanelRender, state: State): void {
    const scene = this.ctx.scene;
    let plan: PanelPlan;
    try {
      plan = planPanel(scene, this.ctx.geometry, state, p.id);
      p.error = null;
    } catch (e) {
      if (!(e instanceof TychoError)) throw e;
      p.error = e.message;
      p.plan = null;
      for (const d of p.draws.values()) d.group.visible = false;
      return;
    }
    const prev = p.plan;
    const spec: Camera = plan.view.camera ?? { kind: 'plane', plane: 'xy' };
    if (prev === null || prev.viewId !== plan.viewId || cameraKey(spec) !== cameraKey(p.cameraSpec)) this.setCamera(p, spec);
    // a new display frame, driver's track set, or track layer's track set refits the camera. otherwise the camera stays where the user left it
    const content = contentKey(plan);
    if (content !== p.content) {
      p.content = content;
      p.needsFit = true;
      p.userMoved = false;
    }
    p.plan = plan;
    const keep = new Set<number>();
    const theme = JSON.stringify(this.ctx.theme);
    try {
      for (const lp of plan.layers) {
        let key: string;
        if (lp.kind === 'track') {
          if (lp.set === null) continue;
          const color = lp.color === undefined ? theme : JSON.stringify(lp.color);
          key = `track\0${plan.viewId}\0${lp.index}\0${lp.set.id}\0${plan.display}\0${lp.channel ?? ''}\0${color}`;
        } else key = `${lp.kind}\0${plan.viewId}\0${lp.index}\0${plan.display}\0${theme}`;
        keep.add(lp.index);
        const old = p.draws.get(lp.index);
        if (old !== undefined && old.key === key) {
          old.group.visible = true;
          continue;
        }
        if (old !== undefined) {
          old.group.removeFromParent();
          old.dispose();
          p.draws.delete(lp.index);
        }
        const draw: Draw =
          lp.kind === 'track'
            ? new TrackDraw(this.ctx, lp as TrackPlan & { set: SetData }, plan.display, key)
            : lp.kind === 'body'
              ? new BodyDraw(this.ctx, lp.layer, key)
              : new MarkDraw(this.ctx, lp.layer, p.cameraSpec, key);
        // layers stack in their order, and within a layer its objects in the order they were added
        draw.group.renderOrder = lp.index;
        let k = 0;
        for (const o of draw.group.children) o.renderOrder = 16 * lp.index + k++;
        p.draws.set(lp.index, draw);
        if (draw instanceof MarkDraw && p.box !== null) draw.layout(p.box, p.cameraSpec);
      }
    } catch (e) {
      if (!(e instanceof TychoError)) throw e;
      p.error = e.message;
      p.plan = null;
      for (const d of p.draws.values()) d.group.visible = false;
      return;
    }
    for (const [index, d] of [...p.draws]) {
      if (keep.has(index)) continue;
      d.group.removeFromParent();
      d.dispose();
      p.draws.delete(index);
    }
    // the bottom run of layers that do not take a reading is cached. a static layer above a moving one is drawn live
    const keys: string[] = [];
    let below = true;
    for (const lp of plan.layers) {
      const d = p.draws.get(lp.index);
      if (d === undefined) continue;
      below &&= d instanceof TrackDraw && d.isStatic;
      (below ? p.staticScene : p.scene).add(d.group);
      if (below) keys.push(d.key);
    }
    const staticKey = keys.join('\n');
    if (staticKey !== p.staticKey) {
      p.staticKey = staticKey;
      p.underlayDirty = true;
    }
  }

  /** Updates a panel's draws for progress `q`. */
  private advance(p: PanelRender, state: State, q: number): void {
    const plan = p.plan;
    if (plan === null) return;
    const scene = this.ctx.scene;
    const env: LayerEnv = { scope: plan.scope, frames: this.ctx.geometry.frames, clock: scene.clock, channel: state.clock.channel, q, display: plan.display };
    p.error = null;
    try {
      for (const lp of plan.layers) {
        const d = p.draws.get(lp.index);
        if (d instanceof TrackDraw && lp.kind === 'track') {
          if (d.update(lp, scene, q) && d.isStatic) p.underlayDirty = true;
        } else if (d instanceof BodyDraw && lp.kind === 'body') d.update(env, lp.layer, plan.driver);
      }
    } catch (e) {
      if (!(e instanceof TychoError)) throw e;
      p.error = e.message;
    }
  }

  /** Fits the camera to every track layer's members (fitBox), or to the bodies when the track layers do not draw anything. */
  private fit(p: PanelRender): void {
    const box = new THREE.Box3();
    const b = p.plan === null ? null : fitBox(p.plan, this.ctx.geometry);
    if (b !== null) box.set(new THREE.Vector3(b[0], b[1], b[2]), new THREE.Vector3(b[3], b[4], b[5]));
    else for (const d of p.draws.values()) if (d instanceof BodyDraw && d.group.visible) d.extend(box);
    if (box.isEmpty()) box.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1e-9);
    const spec = p.cameraSpec;
    const { up, normal } = cameraBasis(spec);
    const cam = p.camera;
    p.fitting = true;
    if (cam instanceof THREE.OrthographicCamera) {
      p.halfHeight = orthoFit(box, spec, p.rect.w / Math.max(1, p.rect.h)).halfHeight;
      const dist = 4 * radius + 1;
      const reach = 10 * (center.length() + dist + radius);
      cam.near = -reach;
      cam.far = reach;
      cam.zoom = 1;
      cam.position.copy(center).addScaledVector(normal, dist);
    } else {
      const dist = (radius / Math.sin((cam.fov * Math.PI) / 360)) * 1.08;
      cam.near = dist / 1000;
      cam.far = dist * 1000 + center.length();
      cam.position.copy(center).addScaledVector(normal, dist);
    }
    cam.up.copy(up);
    cam.lookAt(center);
    this.aspect(p);
    if (p.controls) {
      p.controls.target.copy(center);
      p.controls.update();
    }
    for (const d of p.draws.values()) if (d instanceof MarkDraw) d.layout(box, spec);
    p.box = box;
    p.fitting = false;
    p.needsFit = false;
  }

  /** Keeps one world unit the same length across and up the screen in an orthographic view. */
  private aspect(p: PanelRender): void {
    const aspect = p.rect.w / Math.max(1, p.rect.h);
    const cam = p.camera;
    if (cam instanceof THREE.OrthographicCamera) {
      cam.top = p.halfHeight;
      cam.bottom = -p.halfHeight;
      cam.left = -p.halfHeight * aspect;
      cam.right = p.halfHeight * aspect;
    } else cam.aspect = aspect;
    cam.updateProjectionMatrix();
  }

  /** What a plane camera shows now, and the marks that follow it laid out across it. */
  private follow(p: PanelRender): void {
    const spec = p.cameraSpec;
    p.view = spec.kind === 'plane' && p.camera instanceof THREE.OrthographicCamera ? planeView(p.camera, spec, p.rect.w, p.rect.h) : null;
    if (p.view === null || spec.kind !== 'plane') return;
    for (const d of p.draws.values()) if (d instanceof MarkDraw) d.follow(p.view, spec);
  }

  /**
   * Draws every panel of `state` at progress `q` in [0, 1) on a stage of `width` by `height` CSS
   * pixels. A frame index i sits at q = i / steps, and playback draws between two of them. Returns the
   * message of every panel that could not be drawn.
   */
  renderAt(state: State, q: number, width: number, height: number, pixelRatio: number): Map<string, string> {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w !== this.size.w || h !== this.size.h || pixelRatio !== this.size.ratio) {
      this.gl.setPixelRatio(pixelRatio);
      this.gl.setSize(w, h, false);
      this.size = { w, h, ratio: pixelRatio };
    }
    const tiles = tile(state.layout, { x: 0, y: 0, w, h }, GUTTER);
    for (const p of [...this.panels.values()]) if (!Object.hasOwn(state.panels, p.id)) this.disposePanel(p);
    const replan = state !== this.lastState;
    this.lastState = state;
    const errors = new Map<string, string>();

    this.gl.setScissorTest(false);
    this.gl.setClearColor(this.background, 1);
    this.gl.clear();
    this.gl.setScissorTest(true);
    for (const [pid, rect] of tiles.panels) {
      const p = this.panel(pid);
      const replanned = replan || p.plan === null;
      if (replanned) this.replan(p, state);
      const resized = rect.w !== p.rect.w || rect.h !== p.rect.h;
      p.rect = rect;
      this.advance(p, state, q);
      if (p.needsFit || (resized && !p.userMoved)) this.fit(p);
      else if (resized) this.aspect(p);
      this.follow(p);
      if (p.error !== null) {
        errors.set(pid, p.error);
        continue;
      }
      if (rect.w < 1 || rect.h < 1) continue;
      for (const d of p.draws.values()) d.resize?.(rect.w, rect.h);
      const y = h - rect.y - rect.h;
      this.gl.setViewport(rect.x, y, rect.w, rect.h);
      this.gl.setScissor(rect.x, y, rect.w, rect.h);
      this.drawStatic(p);
      this.gl.render(p.scene, p.camera);
      this.placeLabels(p);
    }
    this.gl.setScissorTest(false);
    return errors;
  }

  /**
   * The labels of a panel at the last frame, in CSS pixels from the panel's corner. They are the tick
   * numbers and axis titles of a plane camera, the axis titles at the tips of axes laid out from the
   * box, and the body labels beside their discs.
   */
  private labelItems(p: PanelRender): (PanelLabel & { hidden: boolean })[] {
    if (p.plan === null) return [];
    const items: (PanelLabel & { hidden: boolean })[] = [];
    const frame = this.ctx.scene.frames[p.plan.display];
    const names = frame?.axes ?? ['x', 'y', 'z'];
    const { normal } = cameraBasis(p.cameraSpec);
    const add = (text: string, at: THREE.Vector3, dx: number, hide: boolean) => {
      const s = at.clone().project(p.camera);
      const x = ((s.x + 1) / 2) * p.rect.w + dx;
      const y = ((1 - s.y) / 2) * p.rect.h;
      const inside = s.z > -1 && s.z < 1 && x >= 0 && x <= p.rect.w && y >= 0 && y <= p.rect.h;
      items.push({ text, x, y, hidden: hide || !inside });
    };
    const marks = [...p.draws.values()].filter((d): d is MarkDraw => d instanceof MarkDraw);
    if (p.view !== null && p.cameraSpec.kind === 'plane') {
      const [ix, iy] = planeAxes(p.cameraSpec);
      const title = (i: number) => (names[i] && frame?.unit ? `${names[i]} [${frame.unit}]` : (names[i] ?? ''));
      const axes = marks.some((d) => d.follows && d.kind === 'axes');
      const ticks = marks.some((d) => d.ticks);
      for (const l of planeLabels(p.view, ticks, axes ? [title(ix), title(iy)] : null)) items.push({ ...l, hidden: false });
    }
    for (const d of p.draws.values()) {
      if (d instanceof MarkDraw && d.kind === 'axes' && !d.follows) {
        d.tips.forEach((tip, i) => add(names[i] ?? '', tip, 4, p.cameraSpec.kind === 'plane' && Math.abs(tip.clone().normalize().dot(normal)) > 0.99));
      } else if (d instanceof BodyDraw && d.label !== null && d.at !== null && d.group.visible) {
        add(d.label, d.at, d.size / 2 + 3, false);
      }
    }
    return items;
  }

  /** The labels a panel shows at the last frame, for a page or a video frame to write as text. */
  labels(pid: string): PanelLabel[] {
    const p = this.panels.get(pid);
    return p === undefined
      ? []
      : this.labelItems(p)
          .filter((l) => !l.hidden)
          .map(({ hidden: _, ...l }) => l);
  }

  /** The colorbars a panel shows, the identical ones merged. */
  colorbars(pid: string): Colorbar[] {
    const p = this.panels.get(pid);
    const bars: Colorbar[] = [];
    if (p === undefined) return bars;
    for (const d of p.draws.values()) {
      if (!(d instanceof TrackDraw) || !d.group.visible) continue;
      const b = d.colorbar();
      if (b !== null) bars.push(b);
    }
    return mergeColorbars(bars);
  }

  private placeLabels(p: PanelRender): void {
    const el = p.labels;
    if (el === null) return;
    const items = this.labelItems(p);
    while (el.children.length < items.length) el.appendChild(document.createElement('span'));
    while (el.children.length > items.length) el.lastChild!.remove();
    items.forEach((it, i) => {
      const span = el.children[i] as HTMLElement;
      if (span.textContent !== it.text) span.textContent = it.text;
      span.hidden = it.hidden;
      const shift = it.align === 'center' ? '-50%' : it.align === 'end' ? '-100%' : '0';
      span.style.transformOrigin = '0 0';
      span.style.fontSize = it.kind === 'title' ? '13px' : '';
      span.style.transform = `translate(${it.x.toFixed(1)}px, ${it.y.toFixed(1)}px)${it.rotate ? ' rotate(-90deg)' : ''} translate(${shift}, -50%)`;
    });
  }

  dispose(): void {
    for (const p of [...this.panels.values()]) this.disposePanel(p);
    if (this.refineTimer !== null) clearTimeout(this.refineTimer);
    this.blit.material.dispose();
    this.underlay?.dispose();
    this.scratch?.dispose();
    this.ctx.disc.dispose();
    this.gl.dispose();
    // free the context now rather than at collection, since a page may hold only a few
    this.gl.forceContextLoss();
  }
}
