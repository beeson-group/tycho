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
