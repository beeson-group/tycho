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
