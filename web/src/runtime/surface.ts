/**
 * Three-dimensional height-field surface layer for WebGL (rule `surface` of spec/tycho-scene.md).
 *
 * Evaluates closed-form rational Laplace/Z-transform magnitudes, smooth ceiling clamps, diffuse lighting,
 * anti-aliased grid grooves, causal ROC shading, Fourier slices, and floor pole/zero markers at 120 fps.
 */
import * as THREE from 'three';
import { fail } from '../errors.js';
import { evalRationalS, evalRationalZ, impulseInvariantZ, mapHeight, polyRoots } from '../evaluate/complex.js';
import { resolveNumber, resolvePoints2d, SURFACE_RESOLUTION, type LayerEnv } from '../evaluate/layers.js';
import { inputDef, inputValue } from '../evaluate/resolve.js';
import { opacityAt, timeAt } from '../evaluate/timeline.js';
import type { SurfaceLayer } from '../scene.js';
import { colormap, type ColormapId } from './colormaps.js';
import { hexRgb, themed } from './colors.js';
import { MarkerSprites, type Draw, type DrawContext } from './renderer.js';

const COLOR_STABLE = '#b06ef3';
const COLOR_UNSTABLE = '#f0a050';
const COLOR_MARGINAL = '#5b9bd5';

const RATIONAL_HELPERS = /* glsl */ `
uniform int uMode;
uniform int uNPoles;
uniform int uNZeros;
uniform vec2 uSPoles[6];
uniform vec2 uSZeros[5];
uniform float uGain;
uniform vec2 uZPoles[6];
uniform vec2 uZNum[7];
uniform float uZScaleInv;
uniform float uScaleMode;
uniform float uUseClamp;
uniform float uClampMax;
uniform float uClampSoft;
uniform float uHeightScale;
uniform float uGrow;
uniform vec2 uCellSize;
uniform vec2 uDomainMin;
uniform vec2 uDomainMax;

vec2 cmul(vec2 a, vec2 b) {
  return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

float evalMag(vec2 xy) {
  if (uMode == 1) {
    vec2 num = vec2(uGain, 0.0);
    for (int k = 0; k < 5; k++) {
      if (k >= uNZeros) break;
      num = cmul(num, xy - uSZeros[k]);
    }
    vec2 den = vec2(1.0, 0.0);
    for (int k = 0; k < 6; k++) {
      if (k >= uNPoles) break;
      den = cmul(den, xy - uSPoles[k]);
    }
    float aNum = length(num);
    float aDen = length(den);
    if (aDen < 1e-12 * max(1.0, aNum)) return aNum < 1e-12 ? 0.0 : 1e6;
    return aNum / aDen;
  }
  vec2 zs = xy * uZScaleInv;
  vec2 num = vec2(0.0);
  for (int r = 6; r >= 0; r--) {
    if (r <= uNPoles) num = cmul(num, zs) + uZNum[r];
  }
  vec2 den = vec2(1.0, 0.0);
  for (int k = 0; k < 6; k++) {
    if (k >= uNPoles) break;
    den = cmul(den, zs - uZPoles[k]);
  }
  float aNum = length(num);
  float aDen = length(den);
  if (aDen < 1e-12 * max(1.0, aNum)) return aNum < 1e-12 ? 0.0 : 1e6;
  return aNum / aDen;
}

float mapH(float mag) {
  float raw = uScaleMode > 0.5 ? log(1.0 + max(mag, 0.0)) : mag;
  float val = raw;
  if (uUseClamp > 0.5) {
    float t = (uClampMax - raw) / uClampSoft;
    float sp = t > 0.0 ? t + log(1.0 + exp(-t)) : log(1.0 + exp(t));
    val = max(0.0, uClampMax - uClampSoft * sp);
  }
  return val * uHeightScale * uGrow;
}
`;

const SURFACE_RATIONAL_VS = /* glsl */ `
invariant gl_Position;
attribute vec2 aXY;
varying float vHeight;
varying vec3 vNormal;
varying vec2 vWorldXY;
${RATIONAL_HELPERS}
void main() {
  vec2 xy = aXY;
  bool snapped = false;
  for (int k = 0; k < 6; k++) {
    if (k >= uNPoles) break;
    vec2 p = uMode == 1 ? uSPoles[k] : (uZPoles[k] / max(uZScaleInv, 1e-6));
    bool inside = p.x > uDomainMin.x + 0.5 * uCellSize.x && p.x < uDomainMax.x - 0.5 * uCellSize.x &&
                  p.y > uDomainMin.y + 0.5 * uCellSize.y && p.y < uDomainMax.y - 0.5 * uCellSize.y;
    vec2 d = aXY - p;
    if (inside && d.x >= -0.5 * uCellSize.x && d.x < 0.5 * uCellSize.x &&
                  d.y >= -0.5 * uCellSize.y && d.y < 0.5 * uCellSize.y) {
      xy = p;
      snapped = true;
      break;
    }
  }
  float h = mapH(evalMag(xy));
  if (snapped) {
    vNormal = vec3(0.0, 0.0, 1.0);
  } else {
    float eps = 0.015;
    float hxp = mapH(evalMag(xy + vec2(eps, 0.0)));
    float hxm = mapH(evalMag(xy - vec2(eps, 0.0)));
    float hyp = mapH(evalMag(xy + vec2(0.0, eps)));
    float hym = mapH(evalMag(xy - vec2(0.0, eps)));
    float dhdx = (hxp - hxm) / (2.0 * eps);
    float dhdy = (hyp - hym) / (2.0 * eps);
    vNormal = normalize(vec3(-dhdx, -dhdy, 1.0));
  }
  vHeight = h;
  vWorldXY = xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(xy, h + 0.012, 1.0);
}
`;

const SURFACE_GRID_VS = /* glsl */ `
invariant gl_Position;
attribute float aVal;
attribute vec4 aNeighbors;
uniform vec2 uGridStep;
uniform float uScaleMode;
uniform float uUseClamp;
uniform float uClampMax;
uniform float uClampSoft;
uniform float uHeightScale;
uniform float uGrow;
varying float vHeight;
varying vec3 vNormal;
varying vec2 vWorldXY;

float mapGridH(float rawIn) {
  float raw = uScaleMode > 0.5 ? log(1.0 + max(rawIn, 0.0)) : rawIn;
  float val = raw;
  if (uUseClamp > 0.5) {
    float t = (uClampMax - raw) / uClampSoft;
    float sp = t > 0.0 ? t + log(1.0 + exp(-t)) : log(1.0 + exp(t));
    val = max(0.0, uClampMax - uClampSoft * sp);
  }
  return val * uHeightScale * uGrow;
}

void main() {
  float h = mapGridH(aVal);
  float hL = mapGridH(aNeighbors.x);
  float hR = mapGridH(aNeighbors.y);
  float hD = mapGridH(aNeighbors.z);
  float hU = mapGridH(aNeighbors.w);
  float dhdx = (hR - hL) / max(1e-6, uGridStep.x);
  float dhdy = (hU - hD) / max(1e-6, uGridStep.y);
  vNormal = normalize(vec3(-dhdx, -dhdy, 1.0));
  vHeight = h;
  vWorldXY = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy, h + 0.012, 1.0);
}
`;

const SURFACE_FS = /* glsl */ `
precision highp float;
uniform sampler2D uRamp;
uniform float uColorLo;
uniform float uColorHi;
uniform float uOpacity;
uniform vec2 uGrooveStep;
uniform vec3 uGrooveColor;
uniform float uGrooveOpacity;
varying float vHeight;
varying vec3 vNormal;
varying vec2 vWorldXY;
void main() {
  float span = uColorHi - uColorLo;
  float t = abs(span) > 1e-6 ? clamp((vHeight - uColorLo) / span, 0.0, 1.0) : 0.0;
  vec3 col = texture2D(uRamp, vec2(t, 0.5)).rgb;
  vec3 lightDir = normalize(vec3(0.45, 0.55, 0.72));
  float shade = 0.58 + 0.42 * abs(dot(normalize(vNormal), lightDir));
  col *= shade;
  if (uGrooveOpacity > 0.0) {
    vec2 coord = vWorldXY / max(uGrooveStep, vec2(1e-4));
    vec2 grid = abs(fract(coord - 0.5) - 0.5) / max(fwidth(coord), vec2(1e-4));
    float line = 1.0 - min(min(grid.x, grid.y), 1.0);
    col = mix(col, uGrooveColor, line * uGrooveOpacity);
  }
  gl_FragColor = vec4(col, uOpacity);
}
`;

const SURFACE_RATIONAL_FS = /* glsl */ `
precision highp float;
${RATIONAL_HELPERS}
uniform sampler2D uRamp;
uniform float uColorLo;
uniform float uColorHi;
uniform float uOpacity;
uniform float uCutout;
uniform vec2 uGrooveStep;
uniform vec3 uGrooveColor;
uniform float uGrooveOpacity;
varying float vHeight;
varying vec3 vNormal;
varying vec2 vWorldXY;
void main() {
  float mag = evalMag(vWorldXY);
  float h = mapH(mag);
  float eps = 0.008;
  float hxp = mapH(evalMag(vWorldXY + vec2(eps, 0.0)));
  float hxm = mapH(evalMag(vWorldXY - vec2(eps, 0.0)));
  float hyp = mapH(evalMag(vWorldXY + vec2(0.0, eps)));
  float hym = mapH(evalMag(vWorldXY - vec2(0.0, eps)));
  vec3 nrm;
  if (mag >= 1e5 || (abs(hxp - h) < 1e-4 && abs(hxm - h) < 1e-4 && abs(hyp - h) < 1e-4 && abs(hym - h) < 1e-4 && h > 0.5 * uClampMax * uHeightScale * uGrow)) {
    nrm = vec3(0.0, 0.0, 1.0);
  } else {
    float dhdx = (hxp - hxm) / (2.0 * eps);
    float dhdy = (hyp - hym) / (2.0 * eps);
    nrm = normalize(vec3(-dhdx, -dhdy, 1.0));
  }
  float hColor = max(h, vHeight);
  float span = uColorHi - uColorLo;
  float t = abs(span) > 1e-6 ? clamp((hColor - uColorLo) / span, 0.0, 1.0) : 0.0;
  vec3 col = texture2D(uRamp, vec2(t, 0.5)).rgb;
  vec3 lightDir = normalize(vec3(0.45, 0.55, 0.72));
  float shade = 0.58 + 0.42 * abs(dot(nrm, lightDir));
  col *= shade;
  if (uGrooveOpacity > 0.0) {
    vec2 coord = vWorldXY / max(uGrooveStep, vec2(1e-4));
    vec2 grid = abs(fract(coord - 0.5) - 0.5) / max(fwidth(coord), vec2(1e-4));
    float line = 1.0 - min(min(grid.x, grid.y), 1.0);
    col = mix(col, uGrooveColor, line * uGrooveOpacity);
  }
  float alpha = uOpacity;
  if (uCutout > 0.001) {
    float cutDist = uMode == 1 ? vWorldXY.x : (length(vWorldXY) - 1.0);
    if (cutDist > 0.0) {
      float fw = max(fwidth(cutDist), 1e-4);
      float edge = smoothstep(0.0, fw, cutDist);
      float keep = 1.0 - edge * uCutout;
      if (keep <= 0.002) discard;
      alpha *= keep;
    }
  }
  gl_FragColor = vec4(col, alpha);
}
`;

const DEPTH_ONLY_FS = /* glsl */ `
precision highp float;
void main() {
  gl_FragColor = vec4(0.0);
}
`;

const RATIONAL_DEPTH_FS = /* glsl */ `
precision highp float;
uniform int uMode;
uniform float uCutout;
varying vec2 vWorldXY;
void main() {
  if (uCutout > 0.05) {
    float cutDist = uMode == 1 ? vWorldXY.x : (length(vWorldXY) - 1.0);
    if (cutDist > 0.0) discard;
  }
  gl_FragColor = vec4(0.0);
}
`;

const ROC_VS = /* glsl */ `
varying vec2 vXY;
void main() {
  vXY = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const ROC_FS = /* glsl */ `
precision highp float;
uniform int uMode;
uniform float uThreshold;
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vXY;
void main() {
  float signedDist = uMode == 1 ? (vXY.x - uThreshold) : (length(vXY) - uThreshold);
  float fw = max(fwidth(signedDist), 1e-4);
  float fill = smoothstep(-fw, fw, signedDist);
  float edge = 1.0 - smoothstep(0.0, 1.8 * fw, abs(signedDist));
  float alpha = max(fill * uOpacity, edge * min(1.0, uOpacity * 2.4));
  if (alpha < 0.002) discard;
  vec3 col = mix(uColor, min(vec3(1.0), uColor * 1.25), edge);
  gl_FragColor = vec4(col, alpha);
}
`;

const SLICE_VS = /* glsl */ `
uniform float uGrow;
uniform float uMinZ;
attribute float aArc;
attribute float aZOffset;
varying float vArc;
void main() {
  vArc = aArc;
  vec3 p = vec3(position.xy, max(uMinZ, position.z * uGrow + aZOffset));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const SLICE_FS = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uDiverges;
varying float vArc;
void main() {
  if (uDiverges > 0.5 && mod(vArc, 0.24) > 0.13) discard;
  gl_FragColor = vec4(uColor, uOpacity);
}
`;

const STEM_FS = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform float uOpacity;
void main() {
  gl_FragColor = vec4(uColor, uOpacity);
}
`;

function makeRampTexture(id: ColormapId): THREE.DataTexture {
  const w = 256;
  const data = new Uint8Array(w * 4);
  for (let i = 0; i < w; i++) {
    const [r, g, b] = colormap(id, i / (w - 1));
    data[4 * i] = Math.round(r * 255);
    data[4 * i + 1] = Math.round(g * 255);
    data[4 * i + 2] = Math.round(b * 255);
    data[4 * i + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, w, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

function buildDomainGrid(x0: number, x1: number, y0: number, y1: number, nx: number, ny: number): THREE.BufferGeometry {
  const count = nx * ny;
  const pos = new Float32Array(count * 3);
  const xy = new Float32Array(count * 2);
  let p = 0;
  let q = 0;
  for (let j = 0; j < ny; j++) {
    const y = y0 + (j / (ny - 1)) * (y1 - y0);
    for (let i = 0; i < nx; i++) {
      const x = x0 + (i / (nx - 1)) * (x1 - x0);
      pos[p++] = x;
      pos[p++] = y;
      pos[p++] = 0;
      xy[q++] = x;
      xy[q++] = y;
    }
  }
  const indices = new Uint32Array((nx - 1) * (ny - 1) * 6);
  let k = 0;
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      indices[k++] = a;
      indices[k++] = b;
      indices[k++] = d;
      indices[k++] = a;
      indices[k++] = d;
      indices[k++] = c;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aXY', new THREE.BufferAttribute(xy, 2));
  g.setIndex(new THREE.BufferAttribute(indices, 1));
  return g;
}

function buildGridValues(arr: ArrayLike<number>, nx: number, ny: number): { vals: Float32Array; neighbors: Float32Array } {
  const count = nx * ny;
  const vals = new Float32Array(count);
  const neighbors = new Float32Array(count * 4);
  for (let j = 0; j < ny; j++) {
    const jm = Math.max(0, j - 1);
    const jp = Math.min(ny - 1, j + 1);
    for (let i = 0; i < nx; i++) {
      const im = Math.max(0, i - 1);
      const ip = Math.min(nx - 1, i + 1);
      const idx = j * nx + i;
      vals[idx] = arr[idx]!;
      neighbors[4 * idx] = arr[j * nx + im]!;
      neighbors[4 * idx + 1] = arr[j * nx + ip]!;
      neighbors[4 * idx + 2] = arr[jm * nx + i]!;
      neighbors[4 * idx + 3] = arr[jp * nx + i]!;
    }
  }
  return { vals, neighbors };
}

function stabilityRgb(val: number, threshold: number): [number, number, number] {
  if (val < threshold - 1e-4) return hexRgb(COLOR_STABLE);
  if (val > threshold + 1e-4) return hexRgb(COLOR_UNSTABLE);
  return hexRgb(COLOR_MARGINAL);
}

const MAX_CONT_SAMPLES = 256;
const MAX_STEMS = 256;

/** Draws a 3D surface layer along with optional causal ROC, Fourier slices, and floor markers. */
export class SurfaceDraw implements Draw {
  readonly key: string;
  readonly group = new THREE.Group();
  private readonly layer: SurfaceLayer;
  private readonly domain: [number, number, number, number];
  private readonly maxBoxHeight: number;

  private readonly rampTex: THREE.DataTexture;
  private readonly surfaceGeo: THREE.BufferGeometry;
  private readonly surfaceMat: THREE.ShaderMaterial;
  private readonly surfaceMesh: THREE.Mesh;
  private readonly depthMat: THREE.ShaderMaterial | null = null;
  private readonly depthMesh: THREE.Mesh | null = null;

  private rocMesh: THREE.Mesh | null = null;
  private rocMat: THREE.ShaderMaterial | null = null;

  private contCurtainGeo: THREE.BufferGeometry | null = null;
  private contCurtainPos: Float32Array | null = null;
  private contCurtainMat: THREE.ShaderMaterial | null = null;
  private contCurtainMesh: THREE.Mesh | null = null;

  private contLineGeo: THREE.BufferGeometry | null = null;
  private contLinePos: Float32Array | null = null;
  private contLineArc: Float32Array | null = null;
  private contLineMat: THREE.ShaderMaterial | null = null;
  private contLineMesh: THREE.Mesh | null = null;

  private stemGeo: THREE.BufferGeometry | null = null;
  private stemPos: Float32Array | null = null;
  private stemMat: THREE.ShaderMaterial | null = null;
  private stemMesh: THREE.Mesh | null = null;
  private stemDots: MarkerSprites | null = null;

  private poleSprites: MarkerSprites | null = null;
  private zeroSprites: MarkerSprites | null = null;

  private lastSystemKey = '';
  private lastContKey = '';
  private lastDiscKey = '';
  private cachedSigmaMax = 0;
  private cachedRMax = 1;
  private cachedConverges = true;
  private cachedZPoles: [number, number][] = [];
  private cachedZNum: [number, number][] = [];
  /** The zeros of a rational surface in z, i.e. the roots of its numerator. */
  private cachedZZeros: [number, number][] = [];

  constructor(ctx: DrawContext, layer: SurfaceLayer, key: string) {
    this.key = key;
    this.layer = layer;
    const src = layer.source;
    const [x0, x1] = src.x;
    const [y0, y1] = src.y;
    this.domain = [x0, x1, y0, y1];
    this.maxBoxHeight = (layer.clamp?.max ?? 4) * (layer.height_scale ?? 1);

    const cmap = (layer.colormap ?? 'cividis') as ColormapId;
    this.rampTex = makeRampTexture(cmap);
    const grooveColor = hexRgb(themed(layer.grooves?.color ?? ctx.theme.background, ctx.theme));
    const grooveStep = layer.grooves?.step ?? [0.5, 0.5];
    const grooveOpacity = layer.grooves?.opacity ?? 0;
    const colorRange = layer.color_range ?? [0, this.maxBoxHeight];
    const heightScale = layer.height_scale ?? 1;
    const useClamp = layer.clamp !== undefined ? 1 : 0;
    const clampMax = layer.clamp?.max ?? 1;
    const clampSoft = layer.clamp?.softness ?? 1;

    if (src.kind === 'grid') {
      const arr = ctx.geometry.data.array(src.array);
      const [ny, nx] = [arr.shape[0]!, arr.shape[1]!];
      this.surfaceGeo = buildDomainGrid(x0, x1, y0, y1, nx, ny);
      const { vals, neighbors } = buildGridValues(arr.data, nx, ny);
      this.surfaceGeo.setAttribute('aVal', new THREE.BufferAttribute(vals, 1));
      this.surfaceGeo.setAttribute('aNeighbors', new THREE.BufferAttribute(neighbors, 4));
      const uniforms = {
        uGridStep: { value: new THREE.Vector2((2 * (x1 - x0)) / Math.max(1, nx - 1), (2 * (y1 - y0)) / Math.max(1, ny - 1)) },
        uScaleMode: { value: 0 },
        uUseClamp: { value: useClamp },
        uClampMax: { value: clampMax },
        uClampSoft: { value: clampSoft },
        uHeightScale: { value: heightScale },
        uGrow: { value: 1 },
        uRamp: { value: this.rampTex },
        uColorLo: { value: colorRange[0] },
        uColorHi: { value: colorRange[1] },
        uOpacity: { value: 1 },
        uGrooveStep: { value: new THREE.Vector2(grooveStep[0], grooveStep[1]) },
        uGrooveColor: { value: new THREE.Color(grooveColor[0], grooveColor[1], grooveColor[2]) },
        uGrooveOpacity: { value: grooveOpacity },
      };
      this.surfaceMat = new THREE.ShaderMaterial({
        vertexShader: SURFACE_GRID_VS,
        fragmentShader: SURFACE_FS,
        uniforms,
        transparent: true,
        depthWrite: true,
        side: THREE.DoubleSide,
      });
      this.depthMat = new THREE.ShaderMaterial({
        vertexShader: SURFACE_GRID_VS,
        fragmentShader: DEPTH_ONLY_FS,
        uniforms,
        transparent: true,
        colorWrite: false,
        depthWrite: true,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 4,
        side: THREE.DoubleSide,
      });
      this.depthMesh = new THREE.Mesh(this.surfaceGeo, this.depthMat);
      this.depthMesh.frustumCulled = false;
      this.depthMesh.visible = false;
      this.group.add(this.depthMesh);
      this.surfaceMesh = new THREE.Mesh(this.surfaceGeo, this.surfaceMat);
      this.surfaceMesh.frustumCulled = false;
      this.group.add(this.surfaceMesh);
      return;
    }

    const [nx, ny] = src.resolution ?? SURFACE_RESOLUTION;
    this.surfaceGeo = buildDomainGrid(x0, x1, y0, y1, nx, ny);
    const makeVec2Arr = (count: number) => Array.from({ length: count }, () => new THREE.Vector2(0, 0));
    const uniforms: Record<string, THREE.IUniform> = {
      uMode: { value: src.kind === 'rational_s' ? 1 : 2 },
      uNPoles: { value: 1 },
      uNZeros: { value: 0 },
      uSPoles: { value: makeVec2Arr(6) },
      uSZeros: { value: makeVec2Arr(5) },
      uGain: { value: 1 },
      uZPoles: { value: makeVec2Arr(6) },
      uZNum: { value: makeVec2Arr(7) },
      uZScaleInv: { value: 1 },
      uScaleMode: { value: 0 },
      uUseClamp: { value: useClamp },
      uClampMax: { value: clampMax },
      uClampSoft: { value: clampSoft },
      uHeightScale: { value: heightScale },
      uGrow: { value: 1 },
      uCellSize: { value: new THREE.Vector2((x1 - x0) / Math.max(1, nx - 1), (y1 - y0) / Math.max(1, ny - 1)) },
      uDomainMin: { value: new THREE.Vector2(x0, y0) },
      uDomainMax: { value: new THREE.Vector2(x1, y1) },
      uRamp: { value: this.rampTex },
      uColorLo: { value: colorRange[0] },
      uColorHi: { value: colorRange[1] },
      uOpacity: { value: 1 },
      uCutout: { value: 0 },
      uGrooveStep: { value: new THREE.Vector2(grooveStep[0], grooveStep[1]) },
      uGrooveColor: { value: new THREE.Color(grooveColor[0], grooveColor[1], grooveColor[2]) },
      uGrooveOpacity: { value: grooveOpacity },
    };
    if (layer.roc !== undefined) {
      const rColor = hexRgb(layer.roc.color ?? COLOR_STABLE);
      const rocGeo = new THREE.PlaneGeometry(x1 - x0, y1 - y0);
      rocGeo.translate(0.5 * (x0 + x1), 0.5 * (y0 + y1), 0.002);
      this.rocMat = new THREE.ShaderMaterial({
        vertexShader: ROC_VS,
        fragmentShader: ROC_FS,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: {
          uMode: { value: src.kind === 'rational_s' ? 1 : 2 },
          uThreshold: { value: 0 },
          uColor: { value: new THREE.Color(rColor[0], rColor[1], rColor[2]) },
          uOpacity: { value: 0.18 },
        },
      });
      this.rocMesh = new THREE.Mesh(rocGeo, this.rocMat);
      this.rocMesh.frustumCulled = false;
      this.group.add(this.rocMesh);
    }

    this.surfaceMat = new THREE.ShaderMaterial({
      vertexShader: SURFACE_RATIONAL_VS,
      fragmentShader: SURFACE_RATIONAL_FS,
      uniforms,
      transparent: true,
      depthWrite: true,
      side: THREE.DoubleSide,
    });
    this.depthMat = new THREE.ShaderMaterial({
      vertexShader: SURFACE_RATIONAL_VS,
      fragmentShader: RATIONAL_DEPTH_FS,
      uniforms,
      transparent: true,
      colorWrite: false,
      depthWrite: true,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 4,
      side: THREE.DoubleSide,
    });
    this.depthMesh = new THREE.Mesh(this.surfaceGeo, this.depthMat);
    this.depthMesh.frustumCulled = false;
    this.depthMesh.visible = false;
    this.group.add(this.depthMesh);

    this.surfaceMesh = new THREE.Mesh(this.surfaceGeo, this.surfaceMat);
    this.surfaceMesh.frustumCulled = false;
    this.group.add(this.surfaceMesh);

    if (layer.slices?.continuous !== undefined) {
      const cSpec = layer.slices.continuous;
      const cRgb = hexRgb(cSpec.color ?? '#38d0e8');
      this.contCurtainPos = new Float32Array(MAX_CONT_SAMPLES * 2 * 3);
      const cArc = new Float32Array(MAX_CONT_SAMPLES * 2);
      const cZOff = new Float32Array(MAX_CONT_SAMPLES * 2);
      for (let i = 0; i < MAX_CONT_SAMPLES; i++) {
        cZOff[2 * i] = 0.008;
        cZOff[2 * i + 1] = 0.024;
      }
      const cIndices: number[] = [];
      for (let i = 0; i < MAX_CONT_SAMPLES - 1; i++) {
        const a = 2 * i;
        const b = a + 1;
        const c = a + 2;
        const d = a + 3;
        cIndices.push(a, c, b, b, c, d);
      }
      this.contCurtainGeo = new THREE.BufferGeometry();
      this.contCurtainGeo.setAttribute('position', new THREE.BufferAttribute(this.contCurtainPos, 3).setUsage(THREE.DynamicDrawUsage));
      this.contCurtainGeo.setAttribute('aArc', new THREE.BufferAttribute(cArc, 1));
      this.contCurtainGeo.setAttribute('aZOffset', new THREE.BufferAttribute(cZOff, 1));
      this.contCurtainGeo.setIndex(cIndices);
      this.contCurtainMat = new THREE.ShaderMaterial({
        vertexShader: SLICE_VS,
        fragmentShader: SLICE_FS,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: {
          uColor: { value: new THREE.Color(cRgb[0], cRgb[1], cRgb[2]) },
          uOpacity: { value: 0.28 },
          uDiverges: { value: 0 },
          uGrow: { value: 1 },
          uMinZ: { value: 0 },
        },
      });
      this.contCurtainMesh = new THREE.Mesh(this.contCurtainGeo, this.contCurtainMat);
      this.contCurtainMesh.frustumCulled = false;
      this.group.add(this.contCurtainMesh);

      // Build crossed horizontal + vertical bold ribbon (4 vertices per sample)
      this.contLinePos = new Float32Array(MAX_CONT_SAMPLES * 4 * 3);
      this.contLineArc = new Float32Array(MAX_CONT_SAMPLES * 4);
      const lZOff = new Float32Array(MAX_CONT_SAMPLES * 4);
      for (let i = 0; i < MAX_CONT_SAMPLES; i++) {
        const o = 4 * i;
        lZOff[o] = 0.028;
        lZOff[o + 1] = 0.028;
        lZOff[o + 2] = 0.0;
        lZOff[o + 3] = 0.056;
      }
      const lIndices: number[] = [];
      for (let i = 0; i < MAX_CONT_SAMPLES - 1; i++) {
        const h0 = 4 * i;
        const h1 = h0 + 1;
        const h2 = h0 + 4;
        const h3 = h0 + 5;
        lIndices.push(h0, h1, h2, h1, h3, h2);
        const v0 = h0 + 2;
        const v1 = h0 + 3;
        const v2 = h0 + 6;
        const v3 = h0 + 7;
        lIndices.push(v0, v1, v2, v1, v3, v2);
      }
      this.contLineGeo = new THREE.BufferGeometry();
      this.contLineGeo.setAttribute('position', new THREE.BufferAttribute(this.contLinePos, 3).setUsage(THREE.DynamicDrawUsage));
      this.contLineGeo.setAttribute('aArc', new THREE.BufferAttribute(this.contLineArc, 1).setUsage(THREE.DynamicDrawUsage));
      this.contLineGeo.setAttribute('aZOffset', new THREE.BufferAttribute(lZOff, 1));
      this.contLineGeo.setIndex(lIndices);
      this.contLineMat = new THREE.ShaderMaterial({
        vertexShader: SLICE_VS,
        fragmentShader: SLICE_FS,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: {
          uColor: { value: new THREE.Color(cRgb[0], cRgb[1], cRgb[2]) },
          uOpacity: { value: 1 },
          uDiverges: { value: 0 },
          uGrow: { value: 1 },
          uMinZ: { value: 0.012 },
        },
      });
      this.contLineMesh = new THREE.Mesh(this.contLineGeo, this.contLineMat);
      this.contLineMesh.frustumCulled = false;
      this.group.add(this.contLineMesh);
    }

    if (layer.slices?.discrete !== undefined) {
      const dColor = layer.slices.discrete.color ?? '#5b9bd5';
      const dRgb = hexRgb(dColor);
      // Two crossed vertical quads per stem (8 vertices, 12 indices per stem)
      this.stemPos = new Float32Array(MAX_STEMS * 8 * 3);
      const sZOff = new Float32Array(MAX_STEMS * 8);
      for (let i = 0; i < MAX_STEMS; i++) {
        const o = 8 * i;
        sZOff[o] = 0.008;
        sZOff[o + 1] = 0.008;
        sZOff[o + 2] = 0.026;
        sZOff[o + 3] = 0.026;
        sZOff[o + 4] = 0.008;
        sZOff[o + 5] = 0.008;
        sZOff[o + 6] = 0.026;
        sZOff[o + 7] = 0.026;
      }
      const sIndices: number[] = [];
      for (let i = 0; i < MAX_STEMS; i++) {
        const b = 8 * i;
        sIndices.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
        sIndices.push(b + 4, b + 5, b + 6, b + 5, b + 7, b + 6);
      }
      this.stemGeo = new THREE.BufferGeometry();
      this.stemGeo.setAttribute('position', new THREE.BufferAttribute(this.stemPos, 3).setUsage(THREE.DynamicDrawUsage));
      this.stemGeo.setAttribute('aZOffset', new THREE.BufferAttribute(sZOff, 1));
      this.stemGeo.setIndex(sIndices);
      this.stemMat = new THREE.ShaderMaterial({
        vertexShader: SLICE_VS,
        fragmentShader: STEM_FS,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: {
          uColor: { value: new THREE.Color(dRgb[0], dRgb[1], dRgb[2]) },
          uOpacity: { value: 0.95 },
          uGrow: { value: 1 },
          uMinZ: { value: 0 },
        },
      });
      this.stemMesh = new THREE.Mesh(this.stemGeo, this.stemMat);
      this.stemMesh.frustumCulled = false;
      this.group.add(this.stemMesh);

      this.stemDots = new MarkerSprites({ shape: 'disc', color: dColor }, 8.5, false);
      this.stemDots.grow(MAX_STEMS);
      this.stemDots.points.position.z = 0.026;
      (this.stemDots.points.material as THREE.PointsMaterial).depthTest = true;
      this.group.add(this.stemDots.points);
    }

    if (layer.markers !== undefined) {
      this.poleSprites = new MarkerSprites({ shape: 'cross' }, 12, true);
      this.poleSprites.grow(6);
      this.group.add(this.poleSprites.points);

      this.zeroSprites = new MarkerSprites({ shape: 'ring', color: themed(ctx.theme.foreground, ctx.theme) }, 11, false);
      this.zeroSprites.grow(6);
      this.group.add(this.zeroSprites.points);
    }
  }

  private toggleVisible(ref: { input: string } | undefined, env: LayerEnv): boolean {
    if (ref === undefined) return true;
    const def = inputDef(env.scope.scene, ref.input);
    return def?.kind !== 'toggle' || inputValue(env.scope, ref.input) !== false;
  }

  update(env: LayerEnv, layer: SurfaceLayer): void {
    const s = timeAt(env.clock, env.q);
    const layerOpacity = opacityAt(layer.opacity, s, 1);
    const grow = opacityAt(layer.grow, s, 1);
    const scaleSpec = layer.scale;
    const scaleMode = scaleSpec === undefined ? 'linear' : typeof scaleSpec === 'string' ? scaleSpec : String(inputValue(env.scope, scaleSpec.input));
    const scaleFlag = scaleMode === 'log' ? 1 : 0;
    const u = this.surfaceMat.uniforms;
    u.uGrow!.value = grow;
    u.uScaleMode!.value = scaleFlag;
    u.uOpacity!.value = layerOpacity;

    const showSurface = layerOpacity > 0;
    this.surfaceMesh.visible = showSurface;
    if (this.depthMesh !== null) {
      this.depthMesh.visible = showSurface && layerOpacity < 0.999;
      this.surfaceMat.depthWrite = layerOpacity >= 0.999;
    }

    const src = layer.source;
    if (src.kind === 'grid') return;

    const poles = resolvePoints2d(env.scope, src.poles, 'surface', 1, 6, 'a rational surface poles');
    const zeros = src.zeros !== undefined ? resolvePoints2d(env.scope, src.zeros, 'surface', 0, 5, 'a rational surface zeros') : [];
    if (zeros.length > poles.length) {
      fail('surface', `a rational surface has ${zeros.length} zeros and ${poles.length} poles, which is improper`);
    }
    const gain = src.gain !== undefined ? resolveNumber(env.scope, src.gain, 'surface', false, 'a rational surface gain') : 1;
    const period = src.period !== undefined ? resolveNumber(env.scope, src.period, 'surface', true, 'a rational surface period') : 1;

    const sysKey = `${poles.map((p) => `${p[0]},${p[1]}`).join(';')}|${zeros.map((z) => `${z[0]},${z[1]}`).join(';')}|${gain}|${period}`;
    if (sysKey !== this.lastSystemKey) {
      this.lastSystemKey = sysKey;
      u.uNPoles!.value = poles.length;
      u.uNZeros!.value = zeros.length;
      u.uGain!.value = gain;
      const uSP = u.uSPoles!.value as THREE.Vector2[];
      for (let k = 0; k < 6; k++) uSP[k]!.set(poles[k]?.[0] ?? 0, poles[k]?.[1] ?? 0);
      const uSZ = u.uSZeros!.value as THREE.Vector2[];
      for (let k = 0; k < 5; k++) uSZ[k]!.set(zeros[k]?.[0] ?? 0, zeros[k]?.[1] ?? 0);

      if (src.kind === 'rational_s') {
        const sigmaMax = Math.max(...poles.map((p) => p[0]));
        this.cachedSigmaMax = sigmaMax;
        this.cachedRMax = Math.exp(sigmaMax * period);
        this.cachedConverges = sigmaMax < -1e-9;
      } else {
        const zRes = impulseInvariantZ(poles, zeros, gain, period);
        this.cachedSigmaMax = zRes.sigma_max;
        this.cachedRMax = zRes.r_max;
        this.cachedConverges = zRes.converges;
        this.cachedZPoles = zRes.z_poles;
        this.cachedZNum = zRes.z_num;
        this.cachedZZeros = polyRoots(zRes.z_num);
        let maxR = 1;
        for (const [zr, zi] of zRes.z_poles) maxR = Math.max(maxR, Math.hypot(zr, zi));
        u.uZScaleInv!.value = 1 / maxR;
        const uZP = u.uZPoles!.value as THREE.Vector2[];
        for (let k = 0; k < 6; k++) {
          const p = zRes.z_poles[k];
          uZP[k]!.set(p !== undefined ? p[0] / maxR : 0, p !== undefined ? p[1] / maxR : 0);
        }
        const uZN = u.uZNum!.value as THREE.Vector2[];
        const nP = poles.length;
        for (let r = 0; r < 7; r++) {
          const c = zRes.z_num[r];
          if (c !== undefined) {
            const scalePow = maxR ** (nP - r);
            uZN[r]!.set(c[0] / scalePow, c[1] / scalePow);
          } else {
            uZN[r]!.set(0, 0);
          }
        }
      }
    }

    if (this.rocMesh !== null && this.rocMat !== null && layer.roc !== undefined) {
      const rocOp = opacityAt(layer.roc.opacity, s, 0.18);
      const rocVis = this.toggleVisible(layer.roc.visible, env) && rocOp > 0;
      this.rocMesh.visible = rocVis;
      if (rocVis) {
        this.rocMat.uniforms.uThreshold!.value = src.kind === 'rational_s' ? this.cachedSigmaMax : this.cachedRMax;
        this.rocMat.uniforms.uOpacity!.value = rocOp;
      }
    }

    const contSpec = layer.slices?.continuous;
    const discSpec = layer.slices?.discrete;
    const nStems =
      discSpec !== undefined
        ? discSpec.count === undefined
          ? 16
          : typeof discSpec.count === 'number'
            ? discSpec.count
            : resolveNumber(env.scope, discSpec.count, 'surface', true, 'discrete slice count')
        : 0;
    const sliceKey = `${sysKey}|${scaleMode}|${Math.round(nStems)}`;
    let cActiveOp = 0;
    let dActiveOp = 0;

    if (this.contCurtainMesh !== null && this.contLineMesh !== null && contSpec !== undefined) {
      const cOp = opacityAt(contSpec.opacity, s, 1);
      const cVis = this.toggleVisible(contSpec.visible, env) && cOp > 0;
      cActiveOp = cVis ? cOp : 0;
      this.contCurtainMesh.visible = cVis;
      this.contLineMesh.visible = cVis;
      if (cVis) {
        const contChanged = sliceKey !== this.lastContKey;
        if (contChanged) this.lastContKey = sliceKey;
        const diverges = !this.cachedConverges;
        const cRgb = hexRgb(diverges ? (contSpec.divergent_color ?? COLOR_UNSTABLE) : (contSpec.color ?? '#38d0e8'));
        const curU = this.contCurtainMat!.uniforms;
        (curU.uColor!.value as THREE.Color).setRGB(cRgb[0], cRgb[1], cRgb[2]);
        curU.uOpacity!.value = 0.28 * cOp;
        curU.uDiverges!.value = diverges ? 1 : 0;
        curU.uGrow!.value = grow;
        const lineU = this.contLineMat!.uniforms;
        (lineU.uColor!.value as THREE.Color).setRGB(cRgb[0], cRgb[1], cRgb[2]);
        lineU.uOpacity!.value = cOp;
        lineU.uDiverges!.value = diverges ? 1 : 0;
        lineU.uGrow!.value = grow;

        if (contChanged && this.contCurtainPos !== null && this.contLinePos !== null && this.contLineArc !== null) {
          const [, , y0, y1] = this.domain;
          const n = MAX_CONT_SAMPLES;
          const halfW = 0.028;
          let arc = 0;
          let prevX = 0;
          let prevY = 0;
          let prevH = 0;
          for (let i = 0; i < n; i++) {
            const t = i / (n - 1);
            let x = 0;
            let y = 0;
            let mag = 0;
            let nx = 1;
            let ny = 0;
            if (src.kind === 'rational_s') {
              y = y0 + t * (y1 - y0);
              mag = evalRationalS(poles, zeros, gain, 0, y);
            } else {
              const theta = t * 2 * Math.PI;
              x = Math.cos(theta);
              y = Math.sin(theta);
              mag = evalRationalZ(this.cachedZPoles, this.cachedZNum, x, y);
              nx = x;
              ny = y;
            }
            const h = mapHeight(mag, scaleMode === 'log' ? 'log' : 'linear', layer.clamp, layer.height_scale ?? 1, 1);
            if (i > 0) arc += Math.hypot(x - prevX, y - prevY, h - prevH);
            prevX = x;
            prevY = y;
            prevH = h;

            const cb = i * 6;
            this.contCurtainPos[cb] = x;
            this.contCurtainPos[cb + 1] = y;
            this.contCurtainPos[cb + 2] = 0;
            this.contCurtainPos[cb + 3] = x;
            this.contCurtainPos[cb + 4] = y;
            this.contCurtainPos[cb + 5] = h;

            const lb = i * 12;
            this.contLinePos[lb] = x - nx * halfW;
            this.contLinePos[lb + 1] = y - ny * halfW;
            this.contLinePos[lb + 2] = h;
            this.contLinePos[lb + 3] = x + nx * halfW;
            this.contLinePos[lb + 4] = y + ny * halfW;
            this.contLinePos[lb + 5] = h;
            this.contLinePos[lb + 6] = x;
            this.contLinePos[lb + 7] = y;
            this.contLinePos[lb + 8] = h;
            this.contLinePos[lb + 9] = x;
            this.contLinePos[lb + 10] = y;
            this.contLinePos[lb + 11] = h;

            const ab = i * 4;
            this.contLineArc[ab] = arc;
            this.contLineArc[ab + 1] = arc;
            this.contLineArc[ab + 2] = arc;
            this.contLineArc[ab + 3] = arc;
          }
          (this.contCurtainGeo!.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
          (this.contLineGeo!.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
          (this.contLineGeo!.getAttribute('aArc') as THREE.BufferAttribute).needsUpdate = true;
        }
      }
    }

    if (this.stemMesh !== null && this.stemDots !== null && discSpec !== undefined) {
      const dOp = opacityAt(discSpec.opacity, s, 1);
      const dVis = this.toggleVisible(discSpec.visible, env) && dOp > 0;
      dActiveOp = dVis ? dOp : 0;
      this.stemMesh.visible = dVis;
      this.stemDots.points.visible = dVis;
      if (dVis) {
        const discChanged = sliceKey !== this.lastDiscKey;
        if (discChanged) this.lastDiscKey = sliceKey;
        this.stemMat!.uniforms.uOpacity!.value = 0.95 * dOp;
        this.stemMat!.uniforms.uGrow!.value = grow;
        this.stemDots.setOpacity(dOp);
        this.stemDots.points.scale.z = grow;
        if (discChanged && this.stemPos !== null && this.stemGeo !== null) {
          const N = Math.max(2, Math.min(MAX_STEMS, Math.round(nStems)));
          const pts: [number, number, number][] = [];
          const [, , y0, y1] = this.domain;
          if (src.kind === 'rational_s') {
            const step = (2 * Math.PI) / (N * period);
            const kMin = Math.ceil(y0 / step - 1e-9);
            const kMax = Math.floor(y1 / step + 1e-9);
            for (let k = kMin; k <= kMax && pts.length < MAX_STEMS; k++) {
              const w = k * step;
              const mag = evalRationalS(poles, zeros, gain, 0, w);
              const h = mapHeight(mag, scaleMode === 'log' ? 'log' : 'linear', layer.clamp, layer.height_scale ?? 1, 1);
              pts.push([0, w, h]);
            }
          } else {
            for (let k = 0; k < N && pts.length < MAX_STEMS; k++) {
              const theta = (k / N) * 2 * Math.PI;
              const x = Math.cos(theta);
              const y = Math.sin(theta);
              const mag = evalRationalZ(this.cachedZPoles, this.cachedZNum, x, y);
              const h = mapHeight(mag, scaleMode === 'log' ? 'log' : 'linear', layer.clamp, layer.height_scale ?? 1, 1);
              pts.push([x, y, h]);
            }
          }
          const sw = 0.016;
          const posAttr = this.stemDots.position;
          for (let i = 0; i < pts.length; i++) {
            const [x, y, h] = pts[i]!;
            const b = i * 24;
            // X-oriented stem quad
            this.stemPos[b] = x - sw;
            this.stemPos[b + 1] = y;
            this.stemPos[b + 2] = 0;
            this.stemPos[b + 3] = x + sw;
            this.stemPos[b + 4] = y;
            this.stemPos[b + 5] = 0;
            this.stemPos[b + 6] = x - sw;
            this.stemPos[b + 7] = y;
            this.stemPos[b + 8] = h;
            this.stemPos[b + 9] = x + sw;
            this.stemPos[b + 10] = y;
            this.stemPos[b + 11] = h;
            // Y-oriented stem quad
            this.stemPos[b + 12] = x;
            this.stemPos[b + 13] = y - sw;
            this.stemPos[b + 14] = 0;
            this.stemPos[b + 15] = x;
            this.stemPos[b + 16] = y + sw;
            this.stemPos[b + 17] = 0;
            this.stemPos[b + 18] = x;
            this.stemPos[b + 19] = y - sw;
            this.stemPos[b + 20] = h;
            this.stemPos[b + 21] = x;
            this.stemPos[b + 22] = y + sw;
            this.stemPos[b + 23] = h;
            posAttr.setXYZ(i, x, y, h);
          }
          (this.stemGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
          this.stemGeo.setDrawRange(0, pts.length * 12);
          this.stemDots.show(pts.length);
        }
      }
    }

    u.uCutout!.value = layer.slices?.clip === true ? Math.min(1, Math.max(cActiveOp, dActiveOp) / 0.85) : 0;

    if (this.poleSprites !== null && this.zeroSprites !== null && layer.markers !== undefined) {
      const mOp = opacityAt(layer.markers.opacity, s, 1);
      const mVis = this.toggleVisible(layer.markers.visible, env) && mOp > 0;
      if (!mVis) {
        this.poleSprites.points.visible = false;
        this.zeroSprites.points.visible = false;
      } else {
        this.poleSprites.setOpacity(mOp);
        this.zeroSprites.setOpacity(mOp);
        const [x0, x1, y0, y1] = this.domain;
        const pPos = this.poleSprites.position;
        const pCol = this.poleSprites.color;
        let pShown = 0;
        const mappedPoles = src.kind === 'rational_s' ? poles : this.cachedZPoles;
        for (let k = 0; k < mappedPoles.length; k++) {
          const [px, py] = mappedPoles[k]!;
          if (px < x0 - 0.5 || px > x1 + 0.5 || py < y0 - 0.5 || py > y1 + 0.5) continue;
          const [r, g, b] = src.kind === 'rational_s' ? stabilityRgb(px, 0) : stabilityRgb(Math.hypot(px, py), 1);
          pPos.setXYZ(pShown, px, py, 0.026);
          pCol.setXYZ(pShown, r, g, b);
          pShown++;
        }
        this.poleSprites.show(pShown);

        const zPos = this.zeroSprites.position;
        let zShown = 0;
        if (src.kind === 'rational_s') {
          for (const [zx, zy] of zeros) {
            if (zx < x0 - 0.5 || zx > x1 + 0.5 || zy < y0 - 0.5 || zy > y1 + 0.5) continue;
            zPos.setXYZ(zShown++, zx, zy, 0.026);
          }
        } else {
          for (const [zx, zy] of this.cachedZZeros) {
            if (zx < x0 - 0.5 || zx > x1 + 0.5 || zy < y0 - 0.5 || zy > y1 + 0.5) continue;
            zPos.setXYZ(zShown++, zx, zy, 0.026);
          }
        }
        this.zeroSprites.show(zShown);
      }
    }
  }

  extend(box: THREE.Box3): void {
    const [x0, x1, y0, y1] = this.domain;
    box.expandByPoint(new THREE.Vector3(x0, y0, 0));
    box.expandByPoint(new THREE.Vector3(x1, y1, this.maxBoxHeight));
  }

  dispose(): void {
    this.rampTex.dispose();
    this.surfaceGeo.dispose();
    this.surfaceMat.dispose();
    this.depthMat?.dispose();
    if (this.rocMesh !== null) this.rocMesh.geometry.dispose();
    this.rocMat?.dispose();
    this.contCurtainGeo?.dispose();
    this.contCurtainMat?.dispose();
    this.contLineGeo?.dispose();
    this.contLineMat?.dispose();
    this.stemGeo?.dispose();
    this.stemMat?.dispose();
    this.stemDots?.dispose();
    this.poleSprites?.dispose();
    this.zeroSprites?.dispose();
  }
}
