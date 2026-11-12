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
 * and their trails (rule L4) with the evaluator's functions. A layer in the driver's context (rule L6)
 * keeps its buffers in the frame of its set, and its group's matrix is the affine map into the display
 * frame at the driver's reading, i.e. the blend of the maps in the contexts of two driver samples.
 * Under a plane camera the axes and the grid follow the visible rectangle and give their tick
 * numbers and titles as panel labels.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { fail, TychoError } from '../errors.js';
import { bound, clockLaps, lapOf, layerClock, type TrackClock } from '../evaluate/clock.js';
import {
  arrowLayer,
  driverContexts,
  driverPoint,
  hasHead,
  labelLayer,
  layerEnv,
  loopPolyline,
  outlineLayer,
  point,
  pointsLayer,
  trail as trailVertices,
  whole,
  type Driver,
  type LayerEnv,
  type Vertex,
} from '../evaluate/layers.js';
import { cameraAt } from '../evaluate/index.js';
import { numberAt, opacityAt, planeAxes, sizeAt, timeAt, tweenValue, type CameraWindow, type Key } from '../evaluate/timeline.js';
import type { OutlineLayerResult, Vec3 } from '../evaluate/types.js';
import type { Context, Frames } from '../evaluate/frames.js';
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
import type {
  ArrowLayer,
  BodyLayer,
  Camera,
  Clock,
  ColorSpec,
  LabelLayer,
  Layout,
  Marker,
  MarkLayer,
  OutlineLayer,
  PointsLayer,
  Scene,
  State,
  TrackLayer,
  View,
} from '../scene.js';
import { INDEX_CHANNEL } from '../scene.js';
import {
  colorScale,
  coloring,
  gradientCss,
  gradientStops,
  hexRgb,
  isStepped,
  mixHex,
  sceneTheme,
  themed,
  themedMarker,
  themedSpec,
  type Coloring,
  type Rgb,
  type Theme,
} from './colors.js';
import { markerCanvas, markerStroke, TICK_SIZE, type BoxPaint } from './paint.js';
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
import { outlineTriangles } from './outline.js';
import { mergeColorbars, type Colorbar, type PanelLabel } from './overlay.js';
import { tile, type Rect } from './tiles.js';

/** Width of the gutter between two panels, in CSS pixels. */
export const GUTTER = 6;
const HEAD_SIZE = 9;
/** The length of an arrowhead in CSS pixels when the layer does not set one, and its width as a fraction of its length. */
const ARROWHEAD_SIZE = 10;
const ARROWHEAD_WIDTH = 0.8;
const BODY_SIZE = 8;
/** The least width and height of an outline on the screen, in CSS pixels, when its layer does not set min_size. */
const OUTLINE_MIN_SIZE = 8;
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
uniform float uFade;
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
#ifdef DASH
attribute float dist;
uniform highp sampler2D uDashFrom;
uniform int uDashWidth;
uniform float uSegBase;
float restartAt(float j) {
  int i = int(j + uSegBase + 0.5);
  return texelFetch(uDashFrom, ivec2(i % uDashWidth, i / uDashWidth), 0).x;
}
varying float vDist;
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
#ifdef DASH
  // the pattern starts again where the track last entered the stage
  vDist = dist - restartAt(float(gl_VertexID / 2));
#endif
  vColor = vec4(rgb, uFade * alphaOf(track) * mix(uTaperOpacity, 1.0, s));
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
#ifdef DASH
attribute float distStart;
attribute float distEnd;
uniform highp sampler2D uDashFrom;
uniform int uDashWidth;
uniform float uSegBase;
float restartAt(float j) {
  int i = int(j + uSegBase + 0.5);
  return texelFetch(uDashFrom, ivec2(i % uDashWidth, i / uDashWidth), 0).x;
}
varying float vDist;
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
#ifdef DASH
  vDist = (atEnd ? distEnd : distStart) - restartAt(float(gl_InstanceID));
#endif
  vColor = vec4(rgb, uFade * alphaOf(track) * mix(uTaperOpacity, 1.0, s));
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
#ifdef DASH
attribute float distStart;
attribute float distEnd;
varying float vDist;
#endif
varying vec4 vColor;
void main() {
  bool atEnd = position.y > 0.5;
  vColor = atEnd ? colorEnd : colorStart;
#ifdef DASH
  vDist = atEnd ? distEnd : distStart;
#endif
  gl_Position = corner(instanceStart, instanceEnd, atEnd ? widthEnd : widthStart);
}
`;

/**
 * The shaft of an arrow, or its head under the define HEAD, laid out in CSS pixels between the projected base and tip. The head is
 * shortened to the arrow's length on screen, and an arrow whose ends coincide on screen, or that has an end behind a perspective camera, is not drawn.
 */
const ARROW_VERTEX = /* glsl */ `
uniform vec2 uResolution;
uniform vec4 uColor;
uniform float uWidth;
uniform float uHead;
uniform float uHeadWidth;
attribute vec3 instanceBase;
attribute vec3 instanceTip;
varying vec4 vColor;
void main() {
  vColor = uColor;
  vec4 ca = projectionMatrix * modelViewMatrix * vec4(instanceBase, 1.0);
  vec4 cb = projectionMatrix * modelViewMatrix * vec4(instanceTip, 1.0);
  vec2 half_ = 0.5 * uResolution;
  vec2 a = ca.xy / ca.w * half_;
  vec2 b = cb.xy / cb.w * half_;
  float len = length(b - a);
  if (ca.w <= 0.0 || cb.w <= 0.0 || len < 1e-3) {
    gl_Position = ${HIDDEN};
    return;
  }
  vec2 dir = (b - a) / len;
  vec2 nrm = vec2(-dir.y, dir.x);
  float head = min(uHead, len);
  vec2 neck = b - dir * head;
#ifdef HEAD
  vec2 p = position.y > 0.5 ? b : neck + nrm * position.x * 0.5 * uHeadWidth * head;
#else
  // the shaft runs half a pixel into the head, so that the two do not leave a seam
  vec2 p = (position.y > 0.5 ? neck + dir * min(0.5, head) : a) + nrm * position.x * 0.5 * uWidth;
#endif
  gl_Position = vec4(p / half_, 0.0, 1.0);
}
`;

/** The vertices of an outline, laid out on the CPU in normalized device coordinates. */
const OUTLINE_VERTEX = /* glsl */ `
uniform vec4 uColor;
varying vec4 vColor;
void main() {
  vColor = uColor;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
varying vec4 vColor;
#ifdef DASH
varying float vDist;
uniform float uPixels;
uniform vec2 uDash;
#endif
void main() {
#ifdef DASH
  // a dash of uDash.x and a gap of uDash.y pixels along the screen, from the arclength in the display frame
  if (mod(vDist * uPixels, uDash.x + uDash.y) > uDash.x) discard;
#endif
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

/** The factors by which an orbit camera stretches what it shows along x, y, and z, or 1 along each. */
function stretchOf(cam: Camera): THREE.Vector3 {
  return cam.kind === 'orbit' && cam.stretch !== undefined ? new THREE.Vector3(...cam.stretch) : new THREE.Vector3(1, 1, 1);
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

/**
 * Makes a material blend each pixel, or each sample of a multisampled pixel, once per layer, as a translucent path of a plot
 * does (section 2.11): a fragment passes only where the stencil does not hold the layer's mark yet, and leaves the mark. The
 * stencil is cleared with each frame, and two flat layers of a panel carry different marks.
 */
function flatten(mat: THREE.Material, mark: number): void {
  mat.stencilWrite = true;
  mat.stencilRef = mark;
  mat.stencilFunc = THREE.NotEqualStencilFunc;
  mat.stencilFail = THREE.KeepStencilOp;
  mat.stencilZFail = THREE.KeepStencilOp;
  mat.stencilZPass = THREE.ReplaceStencilOp;
}

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
  /** The context its samples are transformed in (rule L6). */
  context: 'own' | 'driver';
  /** The clock the layer reads, the scene's or its own (rule K4). */
  clock: Clock;
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

export interface ArrowPlan {
  kind: 'arrow';
  index: number;
  layer: ArrowLayer;
  /** Null when the set query does not match any track set. */
  set: SetData | null;
  /** The clock channel the layer reads. */
  channel: string;
  /** The clock the layer reads, the scene's or its own (rule K4). */
  clock: Clock;
}

export interface PointsPlan {
  kind: 'points';
  index: number;
  layer: PointsLayer;
  /** Null when the set query does not match any track set. */
  set: SetData | null;
}

export interface LabelPlan {
  kind: 'label';
  index: number;
  layer: LabelLayer;
  /** The set of an anchor at a member, or null. */
  set: SetData | null;
}

export interface OutlinePlan {
  kind: 'outline';
  index: number;
  layer: OutlineLayer;
}

export type LayerPlan = TrackPlan | ArrowPlan | OutlinePlan | BodyPlan | MarkPlan | PointsPlan | LabelPlan;

export interface PanelPlan {
  viewId: string;
  view: View;
  display: string;
  scope: PanelScope;
  driver: Driver;
  layers: LayerPlan[];
}

/** A layer's color with a colormap keyed on a choice (section 2.7) resolved by the panel's value of the choice (rule V1). */
export function resolveColor(scope: PanelScope, spec: ColorSpec | undefined): ColorSpec | undefined {
  if (spec === undefined || typeof spec === 'string' || isStepped(spec) || typeof spec.colormap === 'string') return spec;
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
      const clock = layer.clock === undefined ? scene.clock : layerClock(scene.clock, layer.clock);
      const channel = needsReading(layer, clock) ? (layer.clock === undefined ? state.clock.channel : clock.channels[0]!) : null;
      const context = layer.context ?? 'own';
      if (context !== 'own' && context !== 'driver') fail('L6', `a track layer's context is ${JSON.stringify(context)}, not own or driver`);
      if (set !== null && channel !== null && layer.clock === undefined && laps > 1 && !set.periodic)
        fail('C6', `a reading is taken on track set ${set.id}, which is not periodic, and the clock has ${laps} laps`);
      const hl = layer.highlight;
      if (hl?.kernel !== undefined) {
        const sel = variableDef(scene, hl.var);
        if (sel?.kind !== 'selector' || (sel.by ?? 'nearest') !== 'nearest' || sel.parameter === undefined)
          fail('2.7', `a highlight kernel needs a selector by nearest, and ${hl.var} is not one`);
      }
      const selected = set !== null && hl !== undefined ? selectorTrack(scope, { var: hl.var }, set) : null;
      const highlight = selected !== null && members.includes(selected) ? selected : null;
      layers.push({ kind: 'track', index, layer, set, members, highlight, selected, channel, color: resolveColor(scope, layer.color), context, clock });
    } else if (layer.kind === 'arrow') {
      const id = oneSet(scope, layer.sets);
      const clock = layer.clock === undefined ? scene.clock : layerClock(scene.clock, layer.clock);
      const channel = layer.clock === undefined ? state.clock.channel : clock.channels[0]!;
      layers.push({ kind: 'arrow', index, layer, set: id === null ? null : geometry.sets.get(id), channel, clock });
    } else if (layer.kind === 'outline') layers.push({ kind: 'outline', index, layer });
    else if (layer.kind === 'body') layers.push({ kind: 'body', index, layer });
    else if (layer.kind === 'points') {
      const id = oneSet(scope, layer.sets);
      layers.push({ kind: 'points', index, layer, set: id === null ? null : geometry.sets.get(id) });
    } else if (layer.kind === 'label') {
      const at = layer.at as { sets?: unknown };
      const id = at !== null && typeof at === 'object' && 'sets' in at ? oneSet(scope, at.sets as never) : null;
      layers.push({ kind: 'label', index, layer, set: id === null ? null : geometry.sets.get(id) });
    } else layers.push({ kind: layer.kind, index, layer });
  });
  return { viewId: panel.view, view, display, scope, driver, layers };
}

/** What the camera fit depends on: the view, the display frame, the driver's track set, and the track sets of the track layers. */
export function contentKey(plan: PanelPlan): string {
  return [
    plan.viewId,
    plan.display,
    plan.driver?.set.id ?? '',
    ...plan.layers.map((l) => (l.kind === 'track' || l.kind === 'points' ? (l.set?.id ?? '') : '')),
  ].join('\0');
}

type Box6 = [number, number, number, number, number, number];

/** An affine map p -> A p + b, as the rows of A followed by b. */
type Affine = Float64Array;

/** The affine map of rule F3 from frame `from` to frame `to` in one context, read off the images of the origin and the three unit points. */
export function affineAt(frames: Frames, from: string, to: string, ctx: Context): Affine {
  const o = frames.transform([0, 0, 0], from, to, ctx);
  const m = new Float64Array(12);
  for (let c = 0; c < 3; c++) {
    const e = frames.transform([c === 0 ? 1 : 0, c === 1 ? 1 : 0, c === 2 ? 1 : 0], from, to, ctx);
    for (let r = 0; r < 3; r++) m[3 * r + c] = e[r]! - o[r]!;
  }
  m.set(o, 9);
  return m;
}

/**
 * The affine map from frame `from` into the display frame at the driver's reading (rule L6), i.e. the maps in the
 * contexts of the driver's samples k and k + 1 blended by the weight w, as a matrix of three.js.
 */
export function driverMatrix(env: LayerEnv, from: string, driver: NonNullable<Driver>, out = new THREE.Matrix4(), clock?: TrackClock): THREE.Matrix4 {
  const { a, b, w } = driverContexts(driver, driverPoint(env, driver, clock).at);
  const ma = affineAt(env.frames, from, env.display, a);
  const mb = affineAt(env.frames, from, env.display, b);
  const m = ma.map((x, i) => (1 - w) * x + w * mb[i]!);
  return out.set(m[0]!, m[1]!, m[2]!, m[9]!, m[3]!, m[4]!, m[5]!, m[10]!, m[6]!, m[7]!, m[8]!, m[11]!, 0, 0, 0, 1);
}

/** Above this many products of a sample and a driver context, the fit of a layer in the driver's context maps the corners of its box. */
const DRIVER_FIT_BUDGET = 4_000_000;

/**
 * The box of a layer in the driver's context, which holds its members as they are drawn at every sample of the
 * driver's track in every lap (rule L6). A point between two driver samples is a blend of the two images, and
 * the box holds it too. For a layer of more than 8 points over the budget, the 8 corners of its box in its own frame are mapped instead,
 * and their images bound it.
 */
function driverFitBox(l: TrackPlan & { set: SetData }, driver: NonNullable<Driver>, display: string, geometry: GeometryCache, budget: number): Box6 {
  const frames = geometry.frames;
  const from = l.set.def.frame;
  const own = geometry.geometry(l.set.id, from);
  const laps = driver.set.periodic ? clockLaps(geometry.scene.clock) : 1;
  // without a channel on the path, every context of the driver's track gives the same map
  const varies = frames.requirements(from, display).channels.size > 0;
  const m = varies ? driver.set.count(driver.track) : 1;
  let points = l.members.length === l.set.tracks ? own.positions : Float64Array.from(l.members.flatMap((t) => [...own.track(t, 0)]));
  // points holds 3 numbers per point, and the 8 corners save work only on a layer of more than 8 points
  if (points.length > 24 && (points.length / 3) * m * (varies ? laps : 1) > budget) {
    const [x0, y0, z0, x1, y1, z1] = own.bounds();
    points = Float64Array.from([x0, y0, z0, x1, y0, z0, x0, y1, z0, x1, y1, z0, x0, y0, z1, x1, y0, z1, x0, y1, z1, x1, y1, z1]);
  }
  const box: Box6 = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let lap = 0; lap < (varies ? laps : 1); lap++) {
    for (let i = 0; i < m; i++) {
      const a = affineAt(frames, from, display, { set: driver.set, track: driver.track, sample: i, shifted: false, lap });
      for (let j = 0; j < points.length; j += 3) {
        const x = points[j]!;
        const y = points[j + 1]!;
        const z = points[j + 2]!;
        for (let r = 0; r < 3; r++) {
          const v = a[3 * r]! * x + a[3 * r + 1]! * y + a[3 * r + 2]! * z + a[9 + r]!;
          if (v < box[r]!) box[r] = v;
          if (v > box[r + 3]!) box[r + 3] = v;
        }
      }
    }
  }
  return box;
}

/**
 * The box a panel's camera fits, which holds every member of every track layer without `fit: false`, whole, in every lap
 * from 0 to the top, in the display frame. A layer in the driver's context is held at every sample of
 * the driver's track. The box is given as minimum then maximum x, y, z, and is null when the track
 * layers do not draw anything. A test passes a small `budget` in place of DRIVER_FIT_BUDGET, to force the fit by the corners.
 */
export function fitBox(plan: PanelPlan, geometry: GeometryCache, budget = DRIVER_FIT_BUDGET): Box6 | null {
  let box: Box6 | null = null;
  for (const l of plan.layers) {
    if (l.kind !== 'track' || l.set === null || l.members.length === 0 || l.layer.fit === false) continue;
    if (l.context === 'driver' && plan.driver === null) continue;
    let parts: Box6[];
    if (l.context === 'driver') parts = [driverFitBox(l as TrackPlan & { set: SetData }, plan.driver!, plan.display, geometry, budget)];
    else {
      const g = geometry.geometry(l.set.id, plan.display);
      parts = l.members.length === l.set.tracks ? [g.bounds()] : l.members.map((t) => g.bounds(t));
    }
    for (const b of parts) {
      if (box === null) box = [...b];
      else for (let c = 0; c < 3; c++) ((box[c] = Math.min(box[c]!, b[c]!)), (box[c + 3] = Math.max(box[c + 3]!, b[c + 3]!)));
    }
  }
  return box;
}

/** Whether a camera is a plane camera with a free aspect, under which the two axes of its plane are scaled separately in the fit (section 2.7). */
const freeAspect = (cam: Camera): boolean => cam.kind === 'plane' && cam.aspect === 'free';

/**
 * An orthographic fit, given as the center of the box and half the view's width and height, for a viewport
 * whose width over height is `aspect`. A tenth of margin is added. One world unit is as long across the
 * screen as up it, unless the camera has a free aspect. The box is then fitted in each direction separately,
 * and along an axis on which the box is flat the half size is the one of the equal fit.
 */
export function orthoFit(box: THREE.Box3, cam: Camera, aspect: number): { center: THREE.Vector3; halfWidth: number; halfHeight: number } {
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, 1e-9);
  const { right, up } = cameraBasis(cam);
  const abs = (v: THREE.Vector3) => new THREE.Vector3(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z));
  const hw = cam.kind === 'plane' ? size.dot(abs(right)) / 2 : radius;
  const hh = cam.kind === 'plane' ? size.dot(abs(up)) / 2 : radius;
  const half = Math.max(hh, hw / aspect) * 1.1;
  const halfHeight = half > 1e-12 ? half : Math.max(radius, 1);
  if (!freeAspect(cam)) return { center, halfWidth: halfHeight * aspect, halfHeight };
  // an axis is flat when its extent is within the rounding of its values, i.e. below a billionth of their magnitude, e.g. the
  // height of a horizontal line, while a residual of 1e-13 against an iteration count is still solid
  const magnitude = (v: THREE.Vector3) => Math.max(Math.abs(box.min.dot(v)), Math.abs(box.max.dot(v)));
  const solid = (extent: number, m: number) => extent > 0 && extent > 1e-9 * m;
  return { center, halfWidth: solid(hw, magnitude(right)) ? hw * 1.1 : halfHeight * aspect, halfHeight: solid(hh, magnitude(up)) ? hh * 1.1 : halfHeight };
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

/**
 * A label's box in CSS pixels from the panel's corner, as [left, top, right, bottom]. Its length is estimated from its text as
 * `tickWidth` estimates a tick number, scaled to 13 px for a title and kept at 12 px for any other label, and its height is
 * the font size. The box is estimated rather than measured, so that the same titles are hidden in a page and in a video frame,
 * although their text is set in different fonts.
 */
export function labelBox(l: PanelLabel): [number, number, number, number] {
  const size = l.kind === 'title' ? 13 : 12;
  const along = (tickWidth(l.text) * size) / 12;
  const from = l.align === 'center' ? -along / 2 : l.align === 'end' ? -along : 0;
  // a rotated label is set upward, hence its start is at the bottom of its box
  return l.rotate ? [l.x - size / 2, l.y - from - along, l.x + size / 2, l.y - from] : [l.x + from, l.y - size / 2, l.x + from + along, l.y + size / 2];
}

/** True when the boxes of two labels are overlapping, as `labelBox` estimates them, and false when they are only touching. */
export function labelsOverlap(a: PanelLabel, b: PanelLabel): boolean {
  const [al, at, ar, ab] = labelBox(a);
  const [bl, bt, br, bb] = labelBox(b);
  return al < br && bl < ar && at < bb && bt < ab;
}

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
  /** For a dashed layer, the arclength of every sample from the first of its track in the frame of the buffers, else null. */
  dist: Float32Array | null;
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
      uSegBase: { value: 0 },
      uOpacity: { value: spec.opacity },
      uWidth: { value: spec.width },
      uKernel: { value: src.kernel && !spec.highlight ? 1 : 0 },
    };
    const defines: Record<string, string> = {};
    if (src.coloring.kind === 'sample') defines.USE_TRACK_COLOR = '';
    if (src.dist !== null) defines.DASH = '';
    this.mat = material(this.wide ? WIDE_VERTEX : NARROW_VERTEX, own, defines);
  }

  /** Shows the whole set or one track, or clears the pass when `what` is null. */
  show(what: 'set' | number | null): void {
    // a pass of one track reads its segments' dash starts from the track's first segment on
    this.mat.uniforms.uSegBase!.value = typeof what === 'number' ? this.src.set.start(what) - what : 0;
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
  private arrays(what: 'set' | number): { pos: Float32Array; u: Float32Array; tr: Float32Array; col: Float32Array | null; dist: Float32Array | null } {
    const { ctx, set, geo, display, readings, coloring: c, colorKey, dist } = this.src;
    const lap = this.spec.lap;
    if (what === 'set') {
      return {
        pos: ctx.shared.get(`pos\0${set.id}\0${display}\0${geo.lapKey(lap)}`, () => lapPairs(geo, lap)),
        u: ctx.shared.get(`u\0${set.id}\0${readings.channel}`, () => pairReadings(set, readings.u)),
        tr: ctx.shared.get(`t\0${set.id}`, () => pairTracks(set)),
        col: c.kind === 'sample' ? ctx.shared.get(`c\0${set.id}\0${colorKey}`, () => pairs(set, c.rgb, 3)) : null,
        dist: dist === null ? null : ctx.shared.get(`d\0${set.id}\0${display}\0${keyOf(dist)}`, () => pairs(set, dist, 1)),
      };
    }
    const s = set.start(what);
    const m = set.count(what);
    return {
      pos: trackLapPairs(geo, what, lap),
      u: readingPairs(readings.u, s, m),
      tr: new Float32Array(2 * (m - 1)).fill(what),
      col: c.kind === 'sample' ? slicePairs(c.rgb, 3, s, m) : null,
      dist: dist === null ? null : slicePairs(dist, 1, s, m),
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
    if (a.dist) g.setAttribute('dist', attr('dist', a.dist, 1));
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
    if (a.dist) {
      const d = buffer('d', a.dist, 2);
      g.setAttribute('distStart', new THREE.InterleavedBufferAttribute(d, 1, 0));
      g.setAttribute('distEnd', new THREE.InterleavedBufferAttribute(d, 1, 1));
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

/** The floats of one end piece: its two ends, their colors with opacity, their widths, and their arclengths for a dash. */
const PIECE = 18;

/** The end pieces of every drawn track, computed on the CPU, as quads with a color, an opacity, and a width at each end. */
class Pieces {
  readonly mesh: THREE.Mesh;
  private buffer: THREE.InstancedInterleavedBuffer;
  private readonly mat: THREE.ShaderMaterial;
  n = 0;

  constructor(capacity: number, resolution: THREE.IUniform, dash: Record<string, THREE.IUniform> | null = null) {
    this.mat = material(PIECE_VERTEX, { uResolution: resolution, ...(dash ?? {}) }, dash === null ? {} : { DASH: '' });
    this.buffer = this.allocate(capacity);
    this.mesh = new THREE.Mesh(this.geometry(), this.mat);
    this.mesh.frustumCulled = false;
  }

  private allocate(capacity: number): THREE.InstancedInterleavedBuffer {
    const b = new THREE.InstancedInterleavedBuffer(new Float32Array(PIECE * Math.max(1, capacity)), PIECE);
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
    g.setAttribute('distStart', new THREE.InterleavedBufferAttribute(b, 1, 16));
    g.setAttribute('distEnd', new THREE.InterleavedBufferAttribute(b, 1, 17));
    g.instanceCount = 0;
    return g;
  }

  /** The array to write `count` pieces into, grown when it is too small. */
  begin(count: number): Float32Array {
    if (PIECE * count > this.buffer.array.length) {
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
    this.buffer.addUpdateRange(0, PIECE * this.n);
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

/**
 * Where the dash pattern of each segment of a track starts (section 2.11), as an arclength along the track, written to `out` from
 * `at` on, one value per segment: where the track last entered the rectangle `[x0, x1] x [y0, y1]` at or before the segment, or its
 * first sample when that lies in the rectangle, as matplotlib clips a line to its figure before it dashes it, which starts the
 * pattern again at each entry. `xy` holds the screen position of each of the `count` samples from `from`, two numbers per sample,
 * and `dist` the arclength of each. Before the track first enters the rectangle, its segments start at its first sample.
 */
export function dashRestarts(
  xy: ArrayLike<number>,
  dist: ArrayLike<number>,
  from: number,
  count: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  out: { [i: number]: number },
  at: number,
): void {
  let restart = count > 0 ? dist[from]! : 0;
  let wasInside = false;
  for (let i = 0; i + 1 < count; i++) {
    const ax = xy[2 * (from + i)]!;
    const ay = xy[2 * (from + i) + 1]!;
    const dx = xy[2 * (from + i + 1)]! - ax;
    const dy = xy[2 * (from + i + 1) + 1]! - ay;
    // Liang-Barsky: the part of the segment inside the rectangle runs from t0 to t1
    let t0 = 0;
    let t1 = 1;
    let crosses = true;
    for (const [q, r] of [
      [-dx, ax - x0],
      [dx, x1 - ax],
      [-dy, ay - y0],
      [dy, y1 - ay],
    ] as const) {
      if (q === 0) {
        if (r < 0) crosses = false;
      } else {
        const t = r / q;
        if (q < 0) t0 = Math.max(t0, t);
        else t1 = Math.min(t1, t);
      }
    }
    const inside = crosses && t0 <= t1;
    // a segment that comes in from outside starts the pattern where it enters; one that goes on from inside keeps it
    if (inside && (t0 > 0 || !wasInside)) {
      const d0 = dist[from + i]!;
      restart = d0 + t0 * (dist[from + i + 1]! - d0);
    }
    out[at + i] = restart;
    wasInside = inside && t1 >= 1;
  }
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

/**
 * The arclength of every sample from the first of its track, along the positions `pos` of x, y, z per sample, with the
 * component along axis `up` scaled by `ratio`, so that a free aspect, which scales the two axes of the plane apart, dashes evenly.
 */
function arclengths(set: SetData, pos: ArrayLike<number>, up = 1, ratio = 1): Float32Array {
  const out = new Float32Array(set.samples);
  const k = [1, 1, 1];
  k[up] = ratio;
  for (let t = 0; t < set.tracks; t++) {
    const s = set.start(t);
    let d = 0;
    out[s] = 0;
    for (let i = 1; i < set.count(t); i++) {
      const a = 3 * (s + i - 1);
      const b = 3 * (s + i);
      d += Math.hypot(k[0]! * (pos[b]! - pos[a]!), k[1]! * (pos[b + 1]! - pos[a + 1]!), k[2]! * (pos[b + 2]! - pos[a + 2]!));
      out[s + i] = d;
    }
  }
  return out;
}

/** The sprites of a marker (section 2.11), drawn from a texture of its shape, in one color or tinted per point. */
export class MarkerSprites {
  readonly points: THREE.Points;
  private readonly material: THREE.PointsMaterial;
  private readonly marker: Marker;
  private readonly tinted: boolean;
  private texSize = 0;
  /** The width of the stroke the texture was drawn with, which may move with the timeline as the size does. */
  private texEdge = -1;
  private edgeWidth: number | undefined;

  constructor(marker: Marker, size: number, tinted: boolean) {
    this.marker = marker;
    this.edgeWidth = typeof marker.edge_width === 'number' ? marker.edge_width : undefined;
    this.tinted = tinted;
    this.material = new THREE.PointsMaterial({
      size,
      sizeAttenuation: false,
      vertexColors: tinted,
      transparent: true,
      alphaTest: 0.01,
      depthTest: false,
      depthWrite: false,
    });
    this.points = new THREE.Points(new THREE.BufferGeometry(), this.material);
    this.points.frustumCulled = false;
    this.grow(1);
    this.setSize(size);
  }

  /**
   * Sets the size of the sprites' shape in CSS pixels, and the width of its stroke when given, drawing the texture again when either
   * moves, since the stroke is in CSS pixels and does not scale with the marker.
   */
  setSize(size: number, edgeWidth = this.edgeWidth): void {
    this.edgeWidth = edgeWidth;
    const marker: Marker = { ...this.marker, edge_width: edgeWidth };
    this.material.size = size + markerStroke(marker, size);
    const want = Math.max(1, size);
    const edge = edgeWidth ?? 0;
    if (Math.abs(want / Math.max(this.texSize, 1e-9) - 1) > 0.05 || Math.abs(edge - this.texEdge) > 0.05 * Math.max(edge, 0.5)) {
      this.texSize = want;
      this.texEdge = edge;
      this.material.map?.dispose();
      const t = new THREE.CanvasTexture(markerCanvas(this.tinted ? { ...marker, color: undefined } : marker, want));
      t.needsUpdate = true;
      this.material.map = t;
      this.material.needsUpdate = true;
    }
  }

  setOpacity(opacity: number): void {
    this.material.opacity = opacity;
  }

  /** Room for `n` points. */
  grow(n: number): void {
    const have = this.points.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (have !== undefined && have.count >= n) return;
    this.points.geometry.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * n), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(3 * n), 3).setUsage(THREE.DynamicDrawUsage));
    this.points.geometry = g;
  }

  get position(): THREE.BufferAttribute {
    return this.points.geometry.getAttribute('position') as THREE.BufferAttribute;
  }

  get color(): THREE.BufferAttribute {
    return this.points.geometry.getAttribute('color') as THREE.BufferAttribute;
  }

  /** Draws the first `n` points. */
  show(n: number): void {
    this.position.needsUpdate = true;
    this.color.needsUpdate = true;
    this.points.geometry.setDrawRange(0, n);
    this.points.visible = n > 0;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.map?.dispose();
    this.material.dispose();
  }
}

/** A head's marker, from the layer's `head` (rule L3 and section 2.11). */
function headMarker(layer: TrackLayer): Marker & { glow?: { channel: string; color?: string; size?: number; opacity?: number } } {
  const head = layer.head;
  return typeof head === 'object' && head !== null ? (head as Marker) : {};
}

export class TrackDraw implements Draw {
  readonly key: string;
  readonly group = new THREE.Group();
  private readonly src: TrackSource;
  private readonly layer: TrackLayer;
  private readonly set: SetData;
  private readonly geo: TrackGeometry;
  private readonly clocks: TrackReadings | null;
  private readonly clock: Clock;
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
  /** For a dashed layer, the arclength at which each segment's dash pattern starts on the stage (section 2.11), else null. */
  private readonly dashFrom: ReturnType<typeof trackTexture> | null;
  private dashScreen = new Float64Array(0);
  private restartOut: number[] = [];
  private readonly resolution: THREE.IUniform<THREE.Vector2> = { value: new THREE.Vector2(1, 1) };
  private readonly uniforms: Record<string, THREE.IUniform>;
  private readonly baseHolder = new THREE.Object3D();
  private readonly hiHolder = new THREE.Object3D();
  /** The passes built so far, by lap and kind, each built the first time its lap shows anything. */
  private readonly passes = new Map<string, Pass>();
  private readonly pieces: Pieces;
  private heads: MarkerSprites | null = null;
  private glow: MarkerSprites | null = null;
  private readonly headSize: number;
  private readonly headColor: Rgb | null;
  private fill: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null = null;
  private fillBuffer = new Float32Array(0);
  /** False for a layer that draws its heads alone (section 2.11). */
  private readonly line: boolean;
  /** The stencil mark of a flat layer, whose lines blend each pixel once (section 2.11), else 0. */
  private readonly flatMark: number;
  /** True when the layer's opacity or its head's size or opacity moves with the timeline, hence it is drawn every frame. */
  private readonly tweened: boolean;
  private members: number[] = [];
  private highlight: number | null = null;
  private selected: number | null = null;
  private baseWhat: 'set' | number | null = null;
  private skip = -1;
  private filled = false;
  /** True for a layer in the driver's context (rule L6), whose buffers are in the frame of its set and whose group's matrix moves them. */
  readonly driverContext: boolean;
  private readonly geometry: GeometryCache;

  constructor(ctx: DrawContext, plan: TrackPlan & { set: SetData }, display: string, key: string) {
    this.key = key;
    this.geometry = ctx.geometry;
    const set = plan.set;
    const layer = plan.layer;
    this.set = set;
    this.layer = layer;
    this.clock = plan.clock;
    this.driverContext = plan.context === 'driver';
    if (this.driverContext) this.group.matrixAutoUpdate = false;
    this.geo = ctx.geometry.geometry(set.id, this.driverContext ? set.def.frame : display);
    this.clocks = plan.channel === null ? null : ctx.geometry.readings(set.id, plan.channel);
    const readings = this.clocks ?? ctx.geometry.readings(set.id, INDEX_CHANNEL);
    this.spec = revealSpec(layer, set.periodic, clockLaps(plan.clock));
    this.color = plan.color;
    const color = coloring(themedSpec(plan.color, ctx.theme), set, hexRgb(ctx.theme.foreground));
    this.kernel = kernelOf(ctx, layer, set);
    this.line = layer.line !== false;
    this.flatMark = layer.flat === true ? (plan.index % 255) + 1 : 0;
    const dashed = layer.dash !== undefined && this.line;
    this.src = {
      ctx,
      set,
      geo: this.geo,
      display: this.geo.frame,
      readings,
      colorKey: JSON.stringify(plan.color ?? null),
      coloring: color,
      kernel: this.kernel !== null,
      dist: dashed ? ctx.shared.get(`dist\0${set.id}\0${this.geo.frame}`, () => arclengths(set, this.geo.positions)) : null,
    };
    this.width = layer.width ?? 1;
    this.hiWidth = layer.highlight?.width ?? this.width;
    this.opacity = typeof layer.opacity === 'number' ? layer.opacity : 1;
    this.hiOpacity = layer.highlight?.opacity ?? 1;
    this.fraction = this.spec.reveal === 'trail' ? this.spec.laps * this.spec.fraction : 0;
    this.taperWidth = layer.trail?.taper?.width ?? TAPER_WIDTH;
    this.taperOpacity = layer.trail?.taper?.opacity ?? TAPER_OPACITY;
    const marker = themedMarker(headMarker(layer), ctx.theme);
    this.tweened =
      typeof layer.opacity === 'object' || typeof marker.size === 'object' || typeof marker.opacity === 'object' || typeof marker.edge_width === 'object';

    this.ranges = trackTexture(set.tracks);
    for (let t = 0; t < set.tracks; t++) this.ranges.data.set(EMPTY_RANGE, 4 * t);
    this.alphas = this.kernel === null ? null : trackTexture(set.tracks);
    const dash = dashed ? { uPixels: { value: 1 }, uDash: { value: new THREE.Vector2(layer.dash![0], layer.dash![1]) } } : null;
    this.dashFrom = dashed ? trackTexture(Math.max(1, set.samples - set.tracks)) : null;
    this.uniforms = {
      uRanges: { value: this.ranges.texture },
      uAlphas: { value: (this.alphas ?? this.ranges).texture },
      uRangesWidth: { value: this.ranges.width },
      uColor: { value: new THREE.Vector3(...(color.kind === 'constant' ? color.rgb : [1, 1, 1])) },
      uResolution: this.resolution,
      uFraction: { value: this.fraction },
      uTaperWidth: { value: this.taperWidth },
      uTaperOpacity: { value: this.fraction > 0 ? this.taperOpacity : 1 },
      uFade: { value: 1 },
      ...(dash ?? {}),
      ...(this.dashFrom === null ? {} : { uDashFrom: { value: this.dashFrom.texture }, uDashWidth: { value: this.dashFrom.width } }),
    };
    if (layer.fill !== undefined) {
      const f = layer.fill;
      const rgb = hexRgb(
        f.color !== undefined
          ? themed(f.color, ctx.theme)
          : color.kind === 'constant'
            ? `#${new THREE.Color(...color.rgb).getHexString()}`
            : ctx.theme.foreground,
      );
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(...rgb),
        transparent: true,
        opacity: f.opacity ?? 0.25,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      this.fill = new THREE.Mesh(new THREE.BufferGeometry(), mat);
      this.fill.frustumCulled = false;
      this.group.add(this.fill);
    }
    // the fill lies under the line, as it does in matplotlib
    this.group.add(this.baseHolder, this.hiHolder);

    // the end pieces computed on the CPU, at most two per track
    this.pieces = new Pieces(2 * Math.min(set.tracks, 64), this.resolution, dash);
    if (this.flatMark > 0) flatten(this.pieces.mesh.material as THREE.Material, this.flatMark);
    this.group.add(this.pieces.mesh);

    this.headSize = typeof marker.size === 'number' ? marker.size : HEAD_SIZE;
    this.headColor = marker.color !== undefined ? hexRgb(marker.color) : null;
    if (hasHead(layer)) {
      if (marker.glow !== undefined) {
        const g = marker.glow;
        this.glow = new MarkerSprites({ shape: 'disc', color: g.color ?? '#d62728' }, g.size ?? 2.4 * this.headSize, false);
        this.glow.setOpacity(g.opacity ?? 0.35);
        this.group.add(this.glow.points);
      }
      this.heads = new MarkerSprites(marker, this.headSize, marker.color === undefined);
      this.group.add(this.heads.points);
    }
  }

  resize(w: number, h: number): void {
    this.resolution.value.set(Math.max(1, w), Math.max(1, h));
  }

  /** The ratio of the pixels per unit up the screen to those across it, for which the arclengths of a dash were computed. */
  private dashRatio = 1;

  /**
   * Sets the pixels per unit of the display frame across and up the screen, which a dash is measured in. Under a free aspect the two
   * differ, and the arclengths are computed again, and the passes built again, when their ratio changes.
   */
  setPixels(across: number, up: number): void {
    if (this.uniforms.uPixels === undefined || this.src.dist === null) return;
    this.uniforms.uPixels.value = across;
    const ratio = up / Math.max(across, 1e-12);
    if (!(Math.abs(ratio / this.dashRatio - 1) > 0.01)) return;
    this.dashRatio = ratio;
    this.src.dist = arclengths(this.set, this.geo.positions, this.planeAxes[1], ratio);
    for (const p of this.passes.values()) {
      p.holder.removeFromParent();
      p.dispose();
    }
    this.passes.clear();
    this.filled = false;
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

  /** The arclength of a vertex of track `t` for a dash, from where the track's pattern starts. */
  private distAt(t: number, v: Vertex): number {
    const d = this.src.dist;
    if (d === null) return 0;
    const s = this.set.start(t);
    const k = 'sample' in v ? Math.min(v.sample, this.set.count(t) - 2) : v.k;
    const from = this.dashFrom?.data[4 * (s - t + Math.max(0, k))] ?? 0;
    if ('sample' in v) return d[s + v.sample]! - from;
    return (1 - v.w) * d[s + v.k]! + v.w * d[s + v.k + 1]! - from;
  }

  /**
   * Starts the dash pattern of each track where it enters the stage, of `width` by `height` CSS pixels widened by `margin`, as
   * matplotlib clips a line to its figure before it dashes it (section 2.11). The panel draws with `camera` in `rect` of the stage.
   * The dashes of a line that the camera follows then stay where they are on the screen rather than crawl along it.
   */
  placeDash(camera: THREE.Camera, rect: { x: number; y: number; w: number; h: number }, width: number, height: number, margin: number): void {
    const from = this.dashFrom;
    const dist = this.src.dist;
    if (from === null || dist === null) return;
    camera.updateMatrixWorld();
    this.group.updateWorldMatrix(true, false);
    const m = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(this.group.matrixWorld);
    const e = m.elements;
    const pos = this.geo.positions;
    if (this.dashScreen.length < 2 * this.set.samples) this.dashScreen = new Float64Array(2 * this.set.samples);
    const xy = this.dashScreen;
    let changed = false;
    for (const t of this.members) {
      const s = this.set.start(t);
      const n = this.set.count(t);
      for (let i = s; i < s + n; i++) {
        const x = pos[3 * i]!;
        const y = pos[3 * i + 1]!;
        const z = pos[3 * i + 2]!;
        const w = e[3]! * x + e[7]! * y + e[11]! * z + e[15]!;
        const nx = (e[0]! * x + e[4]! * y + e[8]! * z + e[12]!) / w;
        const ny = (e[1]! * x + e[5]! * y + e[9]! * z + e[13]!) / w;
        xy[2 * i] = rect.x + ((nx + 1) / 2) * rect.w;
        xy[2 * i + 1] = rect.y + ((1 - ny) / 2) * rect.h;
      }
      const at = s - t;
      dashRestarts(xy, dist, s, n, -margin, -margin, width + margin, height + margin, this.restartOut, 0);
      for (let j = 0; j + 1 < n; j++) {
        const v = this.restartOut[j]!;
        if (from.data[4 * (at + j)] !== v) {
          from.data[4 * (at + j)] = v;
          changed = true;
        }
      }
    }
    if (changed) from.texture.needsUpdate = true;
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
      // the highlight is drawn over a flat layer as over any other
      if (this.flatMark > 0 && !highlight) flatten(p.mat, this.flatMark);
      (highlight ? this.hiHolder : this.baseHolder).add(p.holder);
      this.passes.set(key, p);
      this.showPass(p);
    }
    return p;
  }

  /** Shows the passes of the laps that draw a segment, building the ones not built yet, and hides the others. */
  private syncPasses(base: [number, number], hi: [number, number]): void {
    for (const p of this.passes.values()) p.holder.visible = false;
    if (!this.line) return;
    if (this.baseWhat !== null) for (let lap = base[0]; lap <= base[1]; lap++) this.pass(lap, false).holder.visible = true;
    if (this.highlight !== null) for (let lap = hi[0]; lap <= hi[1]; lap++) this.pass(lap, true).holder.visible = true;
  }

  /**
   * True when the layer does not take a reading, is not in the driver's context, and does not move with the timeline, so that
   * what it draws changes only with its members, its highlight, and its selection.
   */
  get isStatic(): boolean {
    return this.clocks === null && !this.driverContext && !this.tweened;
  }

  /** Moves a layer in the driver's context into the display frame at the driver's reading, or hides it when the driver does not match a set (rule L6). */
  place(env: LayerEnv, driver: Driver): void {
    this.group.visible = driver !== null;
    if (driver === null) return;
    driverMatrix(env, this.set.def.frame, driver, this.group.matrix, this.geometry.readings(driver.set.id, env.channel).clocks[driver.track]);
    this.group.matrixWorldNeedsUpdate = true;
  }

  /** Fades the layer as a whole by its opacity at time `s`, a tween or a number (section 2.11). */
  private fade(s: number): number {
    const layer = this.layer;
    const f = typeof layer.opacity === 'object' ? opacityAt(layer.opacity, s) / Math.max(this.opacity, 1e-9) : 1;
    this.uniforms.uFade!.value = typeof layer.opacity === 'object' ? opacityAt(layer.opacity, s) : 1;
    const marker = headMarker(layer);
    const fade = typeof layer.opacity === 'object' ? opacityAt(layer.opacity, s) : 1;
    this.heads?.setOpacity(fade * opacityAt(marker.opacity, s));
    if (this.heads !== null && (typeof marker.size === 'object' || typeof marker.edge_width === 'object'))
      this.heads.setSize(sizeAt(marker.size, s, HEAD_SIZE), marker.edge_width === undefined ? undefined : numberAt(marker.edge_width, s, 0));
    if (this.glow !== null) this.glow.setOpacity(fade * opacityAt(marker.opacity, s) * (marker.glow?.opacity ?? 0.35));
    if (this.fill !== null) this.fill.material.opacity = fade * (layer.fill?.opacity ?? 0.25);
    return f;
  }

  /** Returns whether the picture changed through new members, a new highlight or selection, or a first fill. */
  update(plan: TrackPlan, scene: Scene, q: number): boolean {
    const s = timeAt(scene.clock, q);
    this.fade(s);
    const fadeNow = this.uniforms.uFade!.value as number;
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
      this.heads?.grow(plan.members.length);
      this.glow?.grow(plan.members.length);
      this.filled = false;
    }
    if (this.clocks === null && this.filled) return false;
    const P = this.pieces.begin(this.line ? 2 * plan.members.length : 0);
    const hp = this.heads?.position;
    const hc = this.heads?.color;
    const gp = this.glow?.position;
    const glowChannel = headMarker(this.layer).glow?.channel;
    const glowValues = glowChannel === undefined ? null : this.set.channel(glowChannel, '2.7');
    let heads = 0;
    let glows = 0;
    const base: [number, number] = [Infinity, -Infinity];
    const hi: [number, number] = [Infinity, -Infinity];
    const fillVerts: number[] = [];
    for (const t of plan.members) {
      const tc = this.clocks?.clocks[t] ?? null;
      const rev = revealTrack(tc, this.clock, q, this.spec, Math.fround);
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
      const alpha = fadeNow * (isHi ? this.hiOpacity : this.alphas !== null ? this.alphas.data[4 * t]! : this.opacity);
      const tapered = this.fraction > 0 && rev.loop !== null;
      if (this.line) {
        for (const piece of rev.pieces) {
          const o = PIECE * this.pieces.n++;
          piece.forEach((v, e) => {
            this.geo.vertex(t, v, P, o + 3 * e);
            this.colorAt(t, v, P, o + 6 + 4 * e);
            const sv = tapered ? clamp01(1 - (rev.loop! - vertexReading(tc!, v)) / this.fraction) : 1;
            P[o + 9 + 4 * e] = alpha * (tapered ? this.taperOpacity + (1 - this.taperOpacity) * sv : 1);
            P[o + 14 + e] = width > 1 && tapered ? width * (this.taperWidth + (1 - this.taperWidth) * sv) : width;
            P[o + 16 + e] = this.distAt(t, v);
          });
        }
      }
      if (hp !== undefined && hc !== undefined && rev.head !== null && heads < hp.count) {
        this.geo.vertex(t, rev.head, hp.array as Float32Array, 3 * heads);
        if (this.headColor !== null) (hc.array as Float32Array).set(this.headColor, 3 * heads);
        else this.colorAt(t, rev.head, hc.array as Float32Array, 3 * heads);
        heads++;
        if (gp !== undefined && glowValues !== null) {
          const v = rev.head;
          // the head sits on sample k, or on k + 1 at the end of its segment, e.g. at the end of the track
          const k = 'sample' in v ? v.sample : v.w >= 1 ? v.k + 1 : v.k;
          if (glowValues[this.set.start(t) + k]! > 0) this.geo.vertex(t, v, gp.array as Float32Array, 3 * glows++);
        }
      }
      if (this.fill !== null && !rev.hidden) this.fillTrack(t, tc, rev.loop, fillVerts);
    }
    this.pieces.end();
    this.heads?.show(heads);
    this.glow?.show(glows);
    if (this.fill !== null) this.setFill(fillVerts);
    this.syncPasses(base, hi);
    this.ranges.texture.needsUpdate = true;
    this.filled = true;
    return true;
  }

  /** The vertices of the drawn polyline of track `t`, as rules L1, L2, and C6 give them, for a fill. */
  private fillTrack(t: number, tc: TrackClock | null, loop: number | null, out: number[]): void {
    const spec = this.spec;
    const n = spec.laps;
    let verts: Vertex[];
    if (tc === null || loop === null || spec.reveal === 'none') verts = whole(this.set.count(t), n, spec.periodic);
    else if (spec.reveal === 'grow') verts = loopPolyline(tc, 0, loop, n);
    else verts = trailVertices(tc, loop, n, spec.fraction, spec.periodic);
    const plane = this.planeAxes;
    const base = this.layer.fill?.base ?? 0;
    const p = new Float32Array(3);
    let prev: [number, number] | null = null;
    for (const v of verts) {
      this.geo.vertex(t, v, p, 0);
      const cur: [number, number] = [p[plane[0]]!, p[plane[1]]!];
      if (prev !== null) fillSegment(prev, cur, base, out);
      prev = cur;
    }
  }

  /** The two axes of the plane the fill is laid out in, set by the panel's camera. */
  planeAxes: [number, number] = [0, 1];

  private setFill(verts: number[]): void {
    const fill = this.fill!;
    const n = verts.length / 2;
    if (3 * n > this.fillBuffer.length) {
      this.fillBuffer = new Float32Array(3 * Math.max(2 * n, 96));
      fill.geometry.dispose();
      fill.geometry = new THREE.BufferGeometry();
      fill.geometry.setAttribute('position', new THREE.BufferAttribute(this.fillBuffer, 3).setUsage(THREE.DynamicDrawUsage));
    }
    const [ix, iy] = this.planeAxes;
    this.fillBuffer.fill(0, 0, 3 * n);
    for (let i = 0; i < n; i++) {
      this.fillBuffer[3 * i + ix] = verts[2 * i]!;
      this.fillBuffer[3 * i + iy] = verts[2 * i + 1]!;
    }
    const attr = fill.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (attr !== undefined) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, 3 * n);
      attr.needsUpdate = true;
    }
    fill.geometry.setDrawRange(0, n);
    fill.visible = n > 0;
  }

  extend(): void {}

  /** The colorbar of a colormapped layer, with the highlighted or single member marked on it, and the kernel's band. */
  colorbar(): Colorbar | null {
    const spec = this.color;
    if (spec === undefined || typeof spec === 'string' || isStepped(spec)) return null;
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
    this.heads?.dispose();
    this.glow?.dispose();
    if (this.fill !== null) {
      this.fill.geometry.dispose();
      this.fill.material.dispose();
    }
  }
}

/** Appends the triangles that shade the part of the segment from `a` to `b` above the line y = base, as x, y pairs. */
export function fillSegment(a: [number, number], b: [number, number], base: number, out: number[]): void {
  const [x0, y0] = a;
  const [x1, y1] = b;
  const up0 = y0 > base;
  const up1 = y1 > base;
  if (!up0 && !up1) return;
  const quad = (xa: number, ya: number, xb: number, yb: number) => out.push(xa, base, xa, ya, xb, yb, xa, base, xb, yb, xb, base);
  if (up0 && up1) {
    quad(x0, y0, x1, y1);
    return;
  }
  // the segment crosses the base line between its ends
  const xc = x0 + ((base - y0) / (y1 - y0)) * (x1 - x0);
  if (up0) out.push(x0, base, x0, y0, xc, base);
  else out.push(xc, base, x1, y1, x1, base);
}

// points layers

/** A points layer (rule K8): the drawn samples of its members as markers, from the evaluator's answer at each frame. */
class PointsDraw implements Draw {
  readonly key: string;
  readonly group = new THREE.Group();
  private readonly sprites: MarkerSprites;
  private readonly layer: PointsLayer;
  private readonly rgb: Rgb;
  /** True when what the layer draws does not change with the clock. */
  readonly isStatic: boolean;
  private done = false;

  constructor(ctx: DrawContext, layer: PointsLayer, key: string) {
    this.key = key;
    this.layer = layer;
    const m = layer.marker ?? {};
    this.rgb = hexRgb(m.color !== undefined ? themed(m.color, ctx.theme) : ctx.theme.foreground);
    this.sprites = new MarkerSprites(themedMarker(m, ctx.theme), typeof m.size === 'number' ? m.size : 4, false);
    this.group.add(this.sprites.points);
    this.isStatic =
      (layer.reveal ?? 'none') === 'none' &&
      layer.before === undefined &&
      layer.after === undefined &&
      typeof m.size !== 'object' &&
      typeof m.edge_width !== 'object' &&
      typeof m.opacity !== 'object' &&
      typeof layer.opacity !== 'object';
  }

  update(env: LayerEnv, plan: PointsPlan): void {
    const s = timeAt(env.base?.clock ?? env.clock, env.q);
    const m = this.layer.marker ?? {};
    this.sprites.setOpacity(opacityAt(this.layer.opacity, s) * opacityAt(m.opacity, s));
    if (typeof m.size === 'object' || typeof m.edge_width === 'object')
      this.sprites.setSize(sizeAt(m.size, s, 4), m.edge_width === undefined ? undefined : numberAt(m.edge_width, s, 0));
    if (this.isStatic && this.done) return;
    const result = pointsLayer(env, this.layer, plan.set);
    let n = 0;
    for (const mem of result.members) n += mem.points.length;
    this.sprites.grow(n);
    const pos = this.sprites.position.array as Float32Array;
    const col = this.sprites.color.array as Float32Array;
    let i = 0;
    for (const mem of result.members) {
      for (const p of mem.points) {
        pos.set(p, 3 * i);
        col.set(this.rgb, 3 * i);
        i++;
      }
    }
    this.sprites.show(n);
    this.done = true;
  }

  extend(box: THREE.Box3): void {
    const a = this.sprites.position;
    const r = this.sprites.points.geometry.drawRange;
    for (let i = 0; i < Math.min(a.count, r.count); i++) box.expandByPoint(new THREE.Vector3(a.getX(i), a.getY(i), a.getZ(i)));
  }

  dispose(): void {
    this.sprites.dispose();
  }
}

// label layers

/** A label layer (rule K6). It does not draw anything in GL, and the stage paints its text at the anchor that `update` finds. */
class LabelDraw implements Draw {
  readonly key: string;
  readonly group = new THREE.Group();
  readonly layer: LabelLayer;
  /** The anchor in the display frame at the last frame, or null on the screen or when it does not resolve. */
  at: THREE.Vector3 | null = null;

  constructor(layer: LabelLayer, key: string) {
    this.key = key;
    this.layer = layer;
  }

  update(env: LayerEnv, plan: LabelPlan, driver: Driver): void {
    const r = labelLayer(env, this.layer, plan.set, driver);
    this.at = r.position === null ? null : new THREE.Vector3(...r.position);
  }

  extend(): void {}

  dispose(): void {}
}

// body layers

/** The textures of body images, decoded once per view of the data container and kept for the page's life. */
const images = new WeakMap<GeometryCache, Map<string, Promise<THREE.Texture>>>();

/** Decodes the image file held by a view of `uint8` bytes (section 2.11) into a texture. */
function imageTexture(geometry: GeometryCache, view: string): Promise<THREE.Texture> {
  let byView = images.get(geometry);
  if (byView === undefined) images.set(geometry, (byView = new Map()));
  let t = byView.get(view);
  if (t === undefined) {
    t = (async () => {
      const bytes = geometry.bytes(view);
      const type = bytes[0] === 0xff ? 'image/jpeg' : bytes[0] === 0x52 ? 'image/webp' : 'image/png';
      const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }), { imageOrientation: 'flipY' });
      const texture = new THREE.Texture(bitmap as unknown as HTMLImageElement);
      // Sampled pixel by pixel from one level, as matplotlib draws a photograph: an image about the size it is shown at stays as
      // crisp as its own pixels wherever the body falls between two device pixels, where a linear blend would soften it.
      texture.generateMipmaps = false;
      texture.minFilter = THREE.NearestFilter;
      texture.magFilter = THREE.NearestFilter;
      texture.flipY = false;
      texture.colorSpace = THREE.NoColorSpace;
      texture.needsUpdate = true;
      return texture;
    })();
    byView.set(view, t);
  }
  return t;
}

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
  private readonly layer: BodyLayer;
  /** Resolves when the body's image is ready to draw or could not be read, or at once for a body without an image. */
  readonly ready: Promise<void>;
  /** Why the body's image could not be read, which `update` throws at every frame, or null. */
  private imageError: TychoError | null = null;

  constructor(ctx: DrawContext, layer: BodyLayer, key: string, onImage: () => void = () => undefined) {
    this.key = key;
    this.layer = layer;
    this.geometry = ctx.geometry;
    const bodies = ctx.scene.bodies ?? {};
    const body = Object.hasOwn(bodies, layer.body) ? bodies[layer.body] : undefined;
    this.label = body?.label ?? null;
    this.size = layer.size ?? BODY_SIZE;
    const color = new THREE.Color(...hexRgb(body?.color !== undefined ? themed(body.color, ctx.theme) : ctx.theme.foreground));
    this.ready = Promise.resolve();
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
    const image = body?.image;
    if (image !== undefined) {
      // the image is drawn in place of the disc, once it is decoded (section 2.11)
      const m = this.point.material as THREE.PointsMaterial;
      m.color.setRGB(1, 1, 1);
      m.alphaTest = 0.01;
      m.map = null;
      this.point.visible = false;
      this.ready = imageTexture(ctx.geometry, image).then(
        (t) => {
          m.map = t;
          m.needsUpdate = true;
          onImage();
        },
        (e: unknown) => {
          const decoded = `body ${layer.body} has image ${image}, which cannot be decoded as a PNG, JPEG, or WebP file`;
          this.imageError = e instanceof TychoError ? e : new TychoError('2.11', decoded);
          onImage();
        },
      );
    }
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
    if (this.imageError !== null) throw this.imageError;
    const opacity = opacityAt(this.layer.opacity, timeAt(env.clock, env.q));
    (this.point.material as THREE.PointsMaterial).opacity = opacity;
    (this.trail.material as THREE.LineBasicMaterial).opacity = 0.6 * opacity;
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
    this.point.visible = !this.hasImage || (this.point.material as THREE.PointsMaterial).map !== null;
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

  /** Hides a body drawn as an image while its position is outside the view, as matplotlib clips an annotation box (section 2.11). */
  clip(camera: THREE.Camera): void {
    if (!this.hasImage || this.at === null) return;
    const v = this.at.clone().project(camera);
    if (Math.abs(v.x) > 1 || Math.abs(v.y) > 1) this.point.visible = false;
  }

  private get hasImage(): boolean {
    const bodies = this.geometry.scene.bodies ?? {};
    return Object.hasOwn(bodies, this.layer.body) && bodies[this.layer.body]!.image !== undefined;
  }

  dispose(): void {
    (this.point.material as THREE.PointsMaterial).map?.dispose();
    for (const o of [this.point, this.trail]) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  }
}

// arrow layers

/** The arrows of an arrow layer, as a shaft and a head per member, drawn in screen space from instance buffers shared by both. */
class ArrowDraw implements Draw {
  readonly key: string;
  readonly group = new THREE.Group();
  private readonly geometry: GeometryCache;
  private readonly resolution: THREE.IUniform<THREE.Vector2> = { value: new THREE.Vector2(1, 1) };
  private readonly shaft: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private readonly head: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private buffer: THREE.InstancedInterleavedBuffer;

  constructor(ctx: DrawContext, plan: ArrowPlan & { set: SetData }, key: string) {
    this.key = key;
    this.geometry = ctx.geometry;
    const { layer } = plan;
    const uniforms = {
      uResolution: this.resolution,
      uColor: {
        value: new THREE.Vector4(...hexRgb(themed(layer.color ?? ctx.theme.foreground, ctx.theme)), typeof layer.opacity === 'number' ? layer.opacity : 1),
      },
      uWidth: { value: layer.width ?? 1 },
      uHead: { value: layer.head?.size ?? ARROWHEAD_SIZE },
      uHeadWidth: { value: ARROWHEAD_WIDTH },
    };
    this.buffer = this.allocate(plan.set.tracks);
    const head = new THREE.InstancedBufferGeometry();
    head.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    this.shaft = new THREE.Mesh(this.attach(quadGeometry()), material(ARROW_VERTEX, uniforms));
    this.head = new THREE.Mesh(this.attach(head), material(ARROW_VERTEX, uniforms, { HEAD: '' }));
    for (const m of [this.shaft, this.head]) m.frustumCulled = false;
    this.group.add(this.shaft, this.head);
  }

  private allocate(capacity: number): THREE.InstancedInterleavedBuffer {
    return new THREE.InstancedInterleavedBuffer(new Float32Array(6 * Math.max(1, capacity)), 6).setUsage(THREE.DynamicDrawUsage);
  }

  private attach(g: THREE.InstancedBufferGeometry): THREE.InstancedBufferGeometry {
    g.setAttribute('instanceBase', new THREE.InterleavedBufferAttribute(this.buffer, 3, 0));
    g.setAttribute('instanceTip', new THREE.InterleavedBufferAttribute(this.buffer, 3, 3));
    g.instanceCount = 0;
    return g;
  }

  /** Rule L7 as `arrowLayer` in evaluate/layers.ts evaluates it, on the clocks that the geometry cache keeps for the set. */
  update(env: LayerEnv, plan: ArrowPlan & { set: SetData }): void {
    if (typeof plan.layer.opacity === 'object')
      (this.shaft.material.uniforms.uColor!.value as THREE.Vector4).w = opacityAt(plan.layer.opacity, timeAt(env.clock, env.q));
    const clocks = this.geometry.readings(plan.set.id, plan.channel).clocks;
    const result = arrowLayer(env, plan.layer, plan.set, (t) => clocks[t]!);
    const shown = result.members.filter((m) => m.base !== null && m.tip !== null);
    if (6 * shown.length > this.buffer.array.length) {
      this.buffer = this.allocate(2 * shown.length);
      for (const m of [this.shaft, this.head]) {
        m.geometry.deleteAttribute('instanceBase');
        m.geometry.deleteAttribute('instanceTip');
        this.attach(m.geometry);
      }
    }
    const a = this.buffer.array as Float32Array;
    shown.forEach((m, i) => {
      a.set(m.base!, 6 * i);
      a.set(m.tip!, 6 * i + 3);
    });
    this.buffer.clearUpdateRanges();
    this.buffer.addUpdateRange(0, 6 * shown.length);
    this.buffer.needsUpdate = true;
    for (const m of [this.shaft, this.head]) {
      m.geometry.instanceCount = shown.length;
      m.visible = shown.length > 0;
    }
  }

  resize(w: number, h: number): void {
    this.resolution.value.set(Math.max(1, w), Math.max(1, h));
  }

  extend(): void {}

  dispose(): void {
    for (const m of [this.shaft, this.head]) {
      m.geometry.dispose();
      m.material.dispose();
    }
  }
}

// outlines

/**
 * The corners, in CSS pixels from the host panel's top left corner, of what a plane camera shows in the target panel, i.e. the rectangle `view` in
 * the target panel's display frame, mapped by `map` into the host's display frame, stretched as the host camera stretches it, and projected by the
 * host camera onto a panel of `w` by `h` pixels. Null when a corner is behind a perspective camera.
 */
export function outlineCorners(
  map: OutlineLayerResult & { origin: Vec3; axes: [Vec3, Vec3, Vec3] },
  view: PlaneView,
  target: Camera & { kind: 'plane' },
  camera: THREE.OrthographicCamera | THREE.PerspectiveCamera,
  host: Camera,
  w: number,
  h: number,
): [[number, number], [number, number], [number, number], [number, number]] | null {
  const { right, up } = cameraBasis(target);
  const k = stretchOf(host);
  camera.updateMatrixWorld();
  const [ax, ay, az] = map.axes.map((a) => new THREE.Vector3(...a));
  const out: [number, number][] = [];
  for (const [x, y] of [
    [view.x0, view.y0],
    [view.x1, view.y0],
    [view.x1, view.y1],
    [view.x0, view.y1],
  ] as const) {
    const p = right.clone().multiplyScalar(x).addScaledVector(up, y);
    const q = new THREE.Vector3(...map.origin).addScaledVector(ax!, p.x).addScaledVector(ay!, p.y).addScaledVector(az!, p.z);
    q.multiply(k).applyMatrix4(camera.matrixWorldInverse);
    if (camera instanceof THREE.PerspectiveCamera && q.z >= -camera.near) return null;
    q.applyMatrix4(camera.projectionMatrix);
    out.push([((q.x + 1) / 2) * w, ((1 - q.y) / 2) * h]);
  }
  return out as [[number, number], [number, number], [number, number], [number, number]];
}

/**
 * The outline of what another panel shows (rule L8). Its map from the target frame is evaluated at the clock in `update`, and the ring is laid out
 * in `place` from the target camera's visible rectangle at the same frame, after every camera of the stage has moved.
 */
class OutlineDraw implements Draw {
  readonly key: string;
  readonly group = new THREE.Group();
  private readonly layer: OutlineLayer;
  private readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private positions = new Float32Array(0);
  private map: OutlineLayerResult | null = null;

  constructor(ctx: DrawContext, layer: OutlineLayer, key: string) {
    this.key = key;
    this.layer = layer;
    const color = new THREE.Vector4(...hexRgb(themed(layer.color ?? ctx.theme.foreground, ctx.theme)), typeof layer.opacity === 'number' ? layer.opacity : 1);
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material(OUTLINE_VERTEX, { uColor: { value: color } }));
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.group.add(this.mesh);
  }

  update(env: LayerEnv, driver: Driver): void {
    if (typeof this.layer.opacity === 'object')
      (this.mesh.material.uniforms.uColor!.value as THREE.Vector4).w = opacityAt(this.layer.opacity, timeAt(env.clock, env.q));
    this.map = outlineLayer(env, this.layer, driver);
  }

  /** The panel the outline shows the view of, or null when the layout does not show the view or the driver does not resolve to a track. */
  get target(): string | null {
    return this.map?.origin == null ? null : this.map.panel;
  }

  /** Lays the ring out on panel `host` from what the target panel `target` shows, or hides it when `target` is not a plane camera's panel. */
  place(host: PanelRender, target: PanelRender | undefined): void {
    const map = this.map;
    let tri: number[] = [];
    const { w, h } = host.rect;
    if (map?.origin != null && map.axes !== null && target?.view != null && target.error === null && target.cameraSpec.kind === 'plane') {
      const corners = outlineCorners({ ...map, origin: map.origin, axes: map.axes }, target.view, target.cameraSpec, host.camera, host.cameraSpec, w, h);
      const look = { width: this.layer.width ?? 1, minSize: this.layer.min_size ?? OUTLINE_MIN_SIZE, dash: this.layer.dash };
      if (corners !== null) tri = outlineTriangles(corners, w, h, look);
    }
    const n = tri.length / 2;
    if (3 * n > this.positions.length) {
      this.positions = new Float32Array(3 * Math.max(2 * n, 96));
      this.mesh.geometry.dispose();
      this.mesh.geometry = new THREE.BufferGeometry();
      this.mesh.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    }
    for (let i = 0; i < n; i++) {
      this.positions[3 * i] = (2 * tri[2 * i]!) / w - 1;
      this.positions[3 * i + 1] = 1 - (2 * tri[2 * i + 1]!) / h;
    }
    if (n > 0) {
      const attr = this.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, 3 * n);
      attr.needsUpdate = true;
    }
    this.mesh.geometry.setDrawRange(0, n);
    this.mesh.visible = n > 0;
  }

  extend(): void {}

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

// axes and grid

/**
 * Lines of an axes or a grid layer. Under a plane camera, axes spanning the view, a grid that
 * numbers its lines, and under a free aspect a grid without numbers follow the visible rectangle
 * and are laid out again whenever it moves. Every other mark is laid out from the fitted box: the
 * grid in the view plane, and the three axes from the origin, both ways when they span the view.
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
  /** An axes layer with `"span": "box"`, which the stage paints around the plot rather than in GL (section 2.11). */
  readonly box: MarkLayer | null;
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
    this.box = layer.kind === 'axes' && layer.span === 'box' && plane ? layer : null;
    if (layer.kind === 'axes') {
      this.full = (layer.span ?? (plane ? 'full' : 'positive')) === 'full';
      this.ticks = plane && this.full;
    } else {
      this.full = false;
      this.ticks = plane && (layer.labels ?? plane);
    }
    // under a free aspect a grid without numbers is laid out across the view too, at a step for each axis, since one step from the box suits only one of them
    this.follows = this.ticks || (layer.kind === 'grid' && freeAspect(cam));
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

  layout(box: THREE.Box3, cam: Camera, stretch = new THREE.Vector3(1, 1, 1)): void {
    if (this.follows || this.box !== null) return;
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
      // under a free aspect each axis is as long as a round fraction of the box along it, or of the box's largest side where it is flat.
      // The lengths are taken in the stretched box and divided by the stretch, which the scene's scale applies again
      const seen = size.clone().multiply(stretch);
      const most = Math.max(seen.x, seen.y, seen.z, 1e-9);
      const len = (e: number) => niceStep(freeAspect(cam) && e > 1e-9 * most ? e : most, 2);
      const fg = hexRgb(this.theme.foreground);
      this.tips = [
        new THREE.Vector3(len(seen.x) / stretch.x, 0, 0),
        new THREE.Vector3(0, len(seen.y) / stretch.y, 0),
        new THREE.Vector3(0, 0, len(seen.z) / stretch.z),
      ];
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

/**
 * A render target of `width` by `height` device pixels for copies pixel for pixel, multisampled when `samples` is above 0. It
 * has a stencil, for flat layers, which three attaches together with a depth buffer.
 */
function pixelTarget(width: number, height: number, samples: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(width, height, {
    samples,
    depthBuffer: true,
    stencilBuffer: true,
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
  /** The part of the panel the camera draws into, inside the view's margin, in stage pixels. */
  rect: Rect = { x: 0, y: 0, w: 1, h: 1 };
  /** The panel's tile on the stage, margin included. */
  outer: Rect = { x: 0, y: 0, w: 1, h: 1 };
  /** The window of a camera with keys at the last frame, or null. */
  window: CameraWindow | null = null;
  /** The camera was moved to a window of its keys and has not been fitted since. */
  atWindow = false;
  /** What the panel draws, as far as the fit depends on it. A change refits the camera. */
  content = '';
  needsFit = true;
  userMoved = false;
  fitting = false;
  /** Half the width and half the height of the orthographic view, at zoom 1. */
  halfWidth = 1;
  halfHeight = 1;
  /** The box the camera was last fitted to, before an orbit camera's stretch. */
  box: THREE.Box3 | null = null;
  /** The point the fit aimed the camera at, which an orbit camera turns about while it has no controls. */
  readonly target = new THREE.Vector3();
  /** The angle in radians by which the clock has turned an orbit camera since the fit. */
  turned = 0;
  /** What a plane camera showed at the last frame, or null under an orbit camera. */
  view: PlaneView | null = null;

  constructor(id: string) {
    this.id = id;
  }
}

const cameraKey = (c: Camera): string => JSON.stringify(c);

/** An orbit camera turns with the clock when it has a nonzero turn. */
const turns = (c: Camera): boolean => c.kind === 'orbit' && (c.turn ?? 0) !== 0;

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
  /** The canvas's viewport and scissor in CSS pixels, as they were set for the panel being drawn. */
  private readonly cssViewport = new THREE.Vector4();
  private readonly cssScissor = new THREE.Vector4();
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
    // the stencil serves flat layers (section 2.11)
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: true, stencil: true, preserveDrawingBuffer: options.preserveDrawingBuffer ?? false });
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

  /**
   * Whether the viewer has panned or zoomed a panel whose camera has keys (rule K5), so that the panel no longer follows them. A
   * refit hands the camera back to its keys.
   */
  offKeys(pid: string): boolean {
    const p = this.panels.get(pid);
    return p !== undefined && p.userMoved && p.cameraSpec.kind === 'plane' && p.cameraSpec.keys !== undefined;
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
    const k = stretchOf(spec);
    p.scene.scale.copy(k);
    p.staticScene.scale.copy(k);
    p.underlayDirty = true;
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
    // a camera that the clock turns moves at every frame, which would draw the underlay coarse as during a drag
    if (!this.cacheStatic || turns(p.cameraSpec)) {
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
      // Leaving a render target, three floors the canvas's viewport and scissor in device pixels, where setViewport and setScissor
      // round them. At a fractional pixel ratio the rest of the panel would then be drawn a pixel shorter, and shifted by half a
      // pixel, at every frame that draws the underlay again, hence the panel's own viewport and scissor are set once more.
      this.gl.setViewport(this.gl.getViewport(this.cssViewport));
      this.gl.setScissor(this.gl.getScissor(this.cssScissor));
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
    this.gl.clear(true, false, true);
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
    this.gl.clear(true, false, true);
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
          const color = `${JSON.stringify(lp.color ?? null)}\0${theme}`;
          key = `track\0${plan.viewId}\0${lp.index}\0${lp.set.id}\0${plan.display}\0${lp.channel ?? ''}\0${color}`;
        } else if (lp.kind === 'arrow') {
          if (lp.set === null) continue;
          const look = JSON.stringify([lp.layer.color ?? null, theme, lp.layer.opacity, lp.layer.width, lp.layer.head]);
          key = `arrow\0${plan.viewId}\0${lp.index}\0${lp.set.id}\0${plan.display}\0${lp.channel}\0${look}`;
        } else if (lp.kind === 'outline') {
          key = `outline\0${plan.viewId}\0${lp.index}\0${JSON.stringify([lp.layer, theme])}`;
        } else if (lp.kind === 'points' || lp.kind === 'label') {
          if (lp.kind === 'points' && lp.set === null) continue;
          key = `${lp.kind}\0${plan.viewId}\0${lp.index}\0${lp.set?.id ?? ''}\0${plan.display}\0${JSON.stringify(lp.layer)}\0${theme}`;
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
            : lp.kind === 'arrow'
              ? new ArrowDraw(this.ctx, lp as ArrowPlan & { set: SetData }, key)
              : lp.kind === 'outline'
                ? new OutlineDraw(this.ctx, lp.layer, key)
                : lp.kind === 'body'
                  ? new BodyDraw(this.ctx, lp.layer, key, () => {
                      p.underlayDirty = true;
                      this.onChange();
                    })
                  : lp.kind === 'points'
                    ? new PointsDraw(this.ctx, lp.layer, key)
                    : lp.kind === 'label'
                      ? new LabelDraw(lp.layer, key)
                      : new MarkDraw(this.ctx, lp.layer, p.cameraSpec, key);
        // layers stack in their order, and within a layer its objects in the order they were added
        draw.group.renderOrder = lp.index;
        let k = 0;
        for (const o of draw.group.children) o.renderOrder = 16 * lp.index + k++;
        p.draws.set(lp.index, draw);
        if (draw instanceof MarkDraw && p.box !== null) draw.layout(p.box, p.cameraSpec, stretchOf(p.cameraSpec));
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
    const axes = p.cameraSpec.kind === 'plane' ? planeAxes(p.cameraSpec) : ([0, 1] as [number, number]);
    try {
      for (const lp of plan.layers) {
        const d = p.draws.get(lp.index);
        if (d instanceof TrackDraw && lp.kind === 'track') {
          d.planeAxes = axes;
          if (d.update(lp, scene, q) && d.isStatic) p.underlayDirty = true;
          if (d.driverContext) d.place(env, plan.driver);
        } else if (d instanceof ArrowDraw && lp.kind === 'arrow') d.update(layerEnv(env, lp.layer), lp as ArrowPlan & { set: SetData });
        else if (d instanceof OutlineDraw && lp.kind === 'outline') d.update(env, plan.driver);
        else if (d instanceof BodyDraw && lp.kind === 'body') d.update(env, lp.layer, plan.driver);
        else if (d instanceof PointsDraw && lp.kind === 'points') d.update(layerEnv(env, lp.layer), lp);
        else if (d instanceof LabelDraw && lp.kind === 'label') d.update(env, lp, plan.driver);
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
    else for (const d of p.draws.values()) if ((d instanceof BodyDraw && d.group.visible) || d instanceof PointsDraw) d.extend(box);
    if (box.isEmpty()) box.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const spec = p.cameraSpec;
    // the camera sees the box as stretched by the scale of the panel's scenes
    const k = stretchOf(spec);
    const seen = new THREE.Box3(box.min.clone().multiply(k), box.max.clone().multiply(k));
    const center = seen.getCenter(new THREE.Vector3());
    const size = seen.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1e-9);
    const { up, normal } = cameraBasis(spec);
    const cam = p.camera;
    p.fitting = true;
    if (cam instanceof THREE.OrthographicCamera) {
      ({ halfWidth: p.halfWidth, halfHeight: p.halfHeight } = orthoFit(seen, spec, p.rect.w / Math.max(1, p.rect.h)));
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
    p.target.copy(center);
    p.turned = 0;
    this.aspect(p);
    if (p.controls) {
      p.controls.target.copy(center);
      p.controls.update();
    }
    for (const d of p.draws.values()) if (d instanceof MarkDraw) d.layout(box, spec, k);
    p.box = box;
    p.fitting = false;
    p.needsFit = false;
    p.atWindow = false;
  }

  /**
   * Keeps one world unit the same length across and up the screen in an orthographic view. Under a free
   * aspect the visible rectangle is kept instead, and it is stretched with the panel.
   */
  private aspect(p: PanelRender): void {
    const aspect = p.rect.w / Math.max(1, p.rect.h);
    const cam = p.camera;
    if (cam instanceof THREE.OrthographicCamera) {
      if (!freeAspect(p.cameraSpec)) p.halfWidth = p.halfHeight * aspect;
      cam.top = p.halfHeight;
      cam.bottom = -p.halfHeight;
      cam.left = -p.halfWidth;
      cam.right = p.halfWidth;
    } else cam.aspect = aspect;
    cam.updateProjectionMatrix();
  }

  /**
   * Turns an orbit camera about its up axis through its target to its turn in degrees times the
   * progress `q` of the loop. The turn adds to where the viewer moved the camera.
   */
  private turn(p: PanelRender, q: number): void {
    const spec = p.cameraSpec;
    if (spec.kind !== 'orbit' || spec.turn === undefined) return;
    const angle = (spec.turn * q * Math.PI) / 180;
    const target = p.controls?.target ?? p.target;
    p.camera.position
      .sub(target)
      .applyAxisAngle(cameraBasis(spec).up, angle - p.turned)
      .add(target);
    p.camera.lookAt(target);
    p.turned = angle;
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
    const s = timeAt(this.ctx.scene.clock, q);
    const tiles = tile(layoutAt(state.layout, s), { x: 0, y: 0, w, h }, GUTTER);
    for (const p of [...this.panels.values()]) if (!Object.hasOwn(state.panels, p.id)) this.disposePanel(p);
    const replan = state !== this.lastState;
    this.lastState = state;
    const errors = new Map<string, string>();

    this.gl.setScissorTest(false);
    this.gl.setClearColor(this.background, 1);
    this.gl.clear();
    this.gl.setScissorTest(true);
    // every camera is moved before any panel is drawn, since an outline on one panel shows what another panel's camera shows at this frame
    for (const [pid, outer] of tiles.panels) {
      const p = this.panel(pid);
      const replanned = replan || p.plan === null;
      if (replanned) this.replan(p, state);
      const rect = inset(outer, p.plan?.view.margin);
      const resized = rect.w !== p.rect.w || rect.h !== p.rect.h;
      p.outer = outer;
      p.rect = rect;
      this.advance(p, state, q);
      if (p.needsFit || (resized && !p.userMoved)) this.fit(p);
      else if (resized) this.aspect(p);
      this.keyed(p, state, q);
      this.turn(p, q);
      this.follow(p);
      for (const d of p.draws.values()) if (d instanceof BodyDraw) d.clip(p.camera);
      const ortho = p.camera instanceof THREE.OrthographicCamera ? p.camera : null;
      const across = ortho === null ? 1 : p.rect.w / Math.max(1e-12, (ortho.right - ortho.left) / ortho.zoom);
      const up = ortho === null ? 1 : p.rect.h / Math.max(1e-12, (ortho.top - ortho.bottom) / ortho.zoom);
      for (const d of p.draws.values()) if (d instanceof TrackDraw) d.setPixels(across, up);
      // a dash pattern starts where its track enters the stage, widened by one device pixel, as matplotlib clips a line to its figure
      for (const d of p.draws.values()) if (d instanceof TrackDraw) d.placeDash(p.camera, p.rect, w, h, 1 / pixelRatio);
    }
    for (const [pid] of tiles.panels) {
      const p = this.panel(pid);
      const rect = p.rect;
      if (p.error !== null) {
        errors.set(pid, p.error);
        continue;
      }
      // a view faded out entirely is not drawn, rather than drawn under a cover whose edge may fall between two device pixels
      if (rect.w < 1 || rect.h < 1 || opacityAt(p.plan?.view.opacity, s) <= 0) continue;
      for (const d of p.draws.values()) d.resize?.(rect.w, rect.h);
      for (const d of p.draws.values()) if (d instanceof OutlineDraw) d.place(p, d.target === null ? undefined : this.panels.get(d.target));
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
   * box, and the body labels beside their discs. An axis title under a shown body label is hidden,
   * since the body label is the name of the disc beside it.
   */
  private labelItems(p: PanelRender): (PanelLabel & { hidden: boolean })[] {
    if (p.plan === null) return [];
    type Item = PanelLabel & { hidden: boolean };
    const items: Item[] = [];
    const titles: Item[] = [];
    const bodies: Item[] = [];
    const frame = this.ctx.scene.frames[p.plan.display];
    const names = frame?.axes ?? ['x', 'y', 'z'];
    const { normal } = cameraBasis(p.cameraSpec);
    const k = stretchOf(p.cameraSpec);
    const ox = p.rect.x - p.outer.x;
    const oy = p.rect.y - p.outer.y;
    const add = (text: string, at: THREE.Vector3, dx: number, hide: boolean): Item => {
      const s = at.clone().multiply(k).project(p.camera);
      const x = ((s.x + 1) / 2) * p.rect.w + dx;
      const y = ((1 - s.y) / 2) * p.rect.h;
      const inside = s.z > -1 && s.z < 1 && x >= 0 && x <= p.rect.w && y >= 0 && y <= p.rect.h;
      const item = { text, x: x + ox, y: y + oy, hidden: hide || !inside };
      items.push(item);
      return item;
    };
    const marks = [...p.draws.values()].filter((d): d is MarkDraw => d instanceof MarkDraw);
    if (p.view !== null && p.cameraSpec.kind === 'plane') {
      const [ix, iy] = planeAxes(p.cameraSpec);
      const title = (i: number) => (names[i] && frame?.unit ? `${names[i]} [${frame.unit}]` : (names[i] ?? ''));
      const axes = marks.some((d) => d.follows && d.kind === 'axes');
      const ticks = marks.some((d) => d.ticks);
      for (const l of planeLabels(p.view, ticks, axes ? [title(ix), title(iy)] : null)) {
        const item = { ...l, x: l.x + ox, y: l.y + oy, hidden: false };
        items.push(item);
        if (l.kind === 'title') titles.push(item);
      }
    }
    for (const d of p.draws.values()) {
      if (d instanceof MarkDraw && d.kind === 'axes' && !d.follows && d.box === null) {
        d.tips.forEach((tip, i) => {
          const name = names[i] ?? '';
          const factor = k.getComponent(i);
          const title = name !== '' && factor !== 1 ? `${name} ×${Number(factor.toPrecision(4))}` : name;
          titles.push(add(title, tip, 4, p.cameraSpec.kind === 'plane' && Math.abs(tip.clone().normalize().dot(normal)) > 0.99));
        });
      } else if (d instanceof BodyDraw && d.label !== null && d.at !== null && d.group.visible) {
        bodies.push(add(d.label, d.at, d.size / 2 + 3, false));
      }
    }
    const shown = bodies.filter((b) => !b.hidden);
    for (const t of titles) if (shown.some((b) => labelsOverlap(t, b))) t.hidden = true;
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

  /**
   * Moves a plane camera with keys to its window at progress `q` (rule K5), or back to its fit when the keys do not give a window
   * then, unless the viewer has moved the camera since its last fit. The window's height is its own under a free aspect, and
   * the width over the panel's aspect ratio otherwise.
   */
  private keyed(p: PanelRender, state: State, q: number): void {
    const spec = p.cameraSpec;
    p.window = null;
    if (spec.kind !== 'plane' || spec.keys === undefined || p.plan === null || p.userMoved || !(p.camera instanceof THREE.OrthographicCamera)) return;
    const scene = this.ctx.scene;
    const env: LayerEnv = {
      scope: p.plan.scope,
      frames: this.ctx.geometry.frames,
      clock: scene.clock,
      channel: state.clock.channel,
      q,
      display: p.plan.display,
    };
    let win: CameraWindow | null;
    try {
      win = cameraAt(env, p.plan.view, this.ctx.geometry.sets, p.plan.driver);
    } catch (e) {
      if (!(e instanceof TychoError)) throw e;
      p.error = e.message;
      return;
    }
    if (win === null) {
      // a camera without a window at this time shows its fit (section 2.11)
      if (p.atWindow) this.fit(p);
      return;
    }
    p.window = win;
    p.atWindow = true;
    const cam = p.camera;
    const { right, up, normal } = cameraBasis(spec);
    const aspect = p.rect.w / Math.max(1, p.rect.h);
    const hw = win.width / 2;
    const hh = win.height !== null ? win.height / 2 : hw / aspect;
    // the camera keeps its depth along the normal, and moves in the plane to the window's center
    const depth = cam.position.dot(normal);
    const center = right.clone().multiplyScalar(win.center[0]).addScaledVector(up, win.center[1]);
    const target = center.clone().addScaledVector(normal, p.target.dot(normal));
    p.fitting = true;
    p.halfWidth = hw;
    p.halfHeight = hh;
    cam.left = -hw;
    cam.right = hw;
    cam.top = hh;
    cam.bottom = -hh;
    cam.zoom = 1;
    cam.position.copy(center).addScaledVector(normal, depth);
    cam.up.copy(up);
    cam.lookAt(target);
    cam.updateProjectionMatrix();
    p.target.copy(target);
    if (p.controls) {
      p.controls.target.copy(target);
      p.controls.update();
    }
    p.fitting = false;
  }

  /** Resolves once every body image of the drawn panels is decoded, so that a video does not start without them. */
  async ready(): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const p of this.panels.values()) for (const d of p.draws.values()) if (d instanceof BodyDraw) waits.push(d.ready);
    await Promise.all(waits);
  }

  /** What the stage paints over a panel at the last frame (section 2.11), in stage pixels, or null for a panel that is not drawn. */
  paintInfo(pid: string): PanelPaint | null {
    const p = this.panels.get(pid);
    if (p === undefined || p.plan === null || p.error !== null) return null;
    const scene = this.ctx.scene;
    const k = stretchOf(p.cameraSpec);
    const project = (at: THREE.Vector3): [number, number] | null => {
      const v = at.clone().multiply(k).project(p.camera);
      if (!(v.z > -1 && v.z < 1)) return null;
      return [p.rect.x + ((v.x + 1) / 2) * p.rect.w, p.rect.y + ((1 - v.y) / 2) * p.rect.h];
    };
    const labels: PanelPaint['labels'] = [];
    let box: PanelPaint['box'] = null;
    let boxTitles: PanelPaint['boxTitles'];
    for (const lp of p.plan.layers) {
      const d = p.draws.get(lp.index);
      if (d instanceof LabelDraw) {
        const at = d.layer.at as { screen?: [number, number] };
        let xy: [number, number] | null;
        const screen = at !== null && typeof at === 'object' && 'screen' in at && at.screen !== undefined;
        if (screen) xy = [p.rect.x + at.screen![0] * p.rect.w, p.rect.y + at.screen![1] * p.rect.h];
        else xy = d.at === null ? null : project(d.at);
        if (xy !== null) labels.push({ layer: d.layer, x: xy[0], y: xy[1], clip: !screen });
      } else if (d instanceof MarkDraw && d.box !== null && p.view !== null && p.cameraSpec.kind === 'plane') {
        const frame = scene.frames[p.plan.display];
        const names = frame?.axes ?? ['', '', ''];
        const [ix, iy] = planeAxes(p.cameraSpec);
        const title = (i: number) => (names[i] && frame?.unit ? `${names[i]} [${frame.unit}]` : (names[i] ?? ''));
        const ticks = (d.box as { ticks?: string[] }).ticks ?? ['x', 'y'];
        box = {
          rect: p.rect,
          x0: p.view.x0,
          x1: p.view.x1,
          y0: p.view.y0,
          y1: p.view.y1,
          ticks: { x: ticks.includes('x'), y: ticks.includes('y') },
          size: (d.box as { size?: number }).size ?? TICK_SIZE,
          titles: [title(ix), title(iy)],
          opacity: d.box.opacity,
        };
        boxTitles = (d.box as { titles?: PanelPaint['boxTitles'] }).titles;
      }
    }
    return { outer: p.outer, rect: p.rect, opacity: p.plan.view.opacity, labels, box, ...(boxTitles !== undefined ? { boxTitles } : {}) };
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

/** What the stage paints over a panel (section 2.11): its labels at their anchors, the box of an axes layer, and the view's opacity. */
export interface PanelPaint {
  outer: Rect;
  rect: Rect;
  opacity: View['opacity'];
  /** The titles of the box's axes layer, when it gives its own (section 2.11). */
  boxTitles?: MarkLayer extends never ? never : Extract<MarkLayer, { kind: 'axes' }>['titles'];
  /** The labels at their anchors, `clip` for an anchor at a point, which is hidden outside the plot. */
  labels: { layer: LabelLayer; x: number; y: number; clip: boolean }[];
  /** The box of an axes layer, with the opacity of the layer, which the stage reads at the time of the timeline. */
  box: (Omit<BoxPaint, 'opacity'> & { opacity: MarkLayer['opacity'] }) | null;
}

/** A rectangle less a view's margin, given as fractions of its height and width (section 2.11). */
export function inset(r: Rect, margin: View['margin']): Rect {
  if (margin === undefined) return r;
  const l = Math.round((margin.left ?? 0) * r.w);
  const rt = Math.round((margin.right ?? 0) * r.w);
  const t = Math.round((margin.top ?? 0) * r.h);
  const b = Math.round((margin.bottom ?? 0) * r.h);
  return { x: r.x + l, y: r.y + t, w: Math.max(0, r.w - l - rt), h: Math.max(0, r.h - t - b) };
}

/** The layout at time `s` of the timeline, each split with keys at the ratio its tween gives then, clamped into [0, 1] (section 2.11). */
export function layoutAt(layout: Layout, s: number): Layout {
  if (layout.kind === 'panel') return layout;
  const a = layoutAt(layout.a, s);
  const b = layoutAt(layout.b, s);
  const ratio = layout.keys === undefined ? layout.ratio : Math.min(1, Math.max(0, tweenValue(layout.keys as Key[], s)));
  if (a === layout.a && b === layout.b && ratio === layout.ratio) return layout;
  return { ...layout, ratio, a, b };
}
