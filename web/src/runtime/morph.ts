/**
 * Parametric conformal morph layer for WebGL (rule `morph` of spec/tycho-scene.md).
 *
 * Allocates static region grids and instanced line-segment quads once per layer plan,
 * then updates only uniforms and optional dash arc-length buffers when `alpha` or `period` changes.
 */
import * as THREE from 'three';
import { conformalExp } from '../evaluate/complex.js';
import { resolveMorphCoord, resolveNumber, type LayerEnv } from '../evaluate/layers.js';
import { inputDef, inputValue } from '../evaluate/resolve.js';
import { opacityAt, timeAt } from '../evaluate/timeline.js';
import type { MorphItem, MorphLayer } from '../scene.js';
import { hexRgb, themed } from './colors.js';
import { flatten, type Draw, type DrawContext } from './renderer.js';

const CONFORMAL_GLSL = /* glsl */ `
vec2 cmul(vec2 a, vec2 b) {
  return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}
vec2 conformalExp(vec2 s, float alpha, float period) {
  float denomA = (1.0 - alpha) * period + alpha;
  vec2 w = alpha * period * s;
  // Float32 exp(w) - 1 loses precision below |w| < 1e-3, where |w|^4 / 120 < 1e-14 is below float32 epsilon.
  if (alpha < 1e-4 || length(w) < 1e-3) {
    vec2 sScaled = (period / denomA) * s;
    vec2 t2 = vec2(1.0 / 6.0, 0.0) + w / 24.0;
    vec2 t1 = vec2(0.5, 0.0) + cmul(w, t2);
    vec2 series = vec2(1.0, 0.0) + cmul(w, t1);
    return vec2(alpha, 0.0) + cmul(sScaled, series);
  }
  float cAlpha = alpha * denomA;
  float ex = exp(clamp(w.x, -40.0, 40.0));
  vec2 ez = ex * vec2(cos(w.y), sin(w.y));
  return vec2(alpha + (ez.x - 1.0) / cAlpha, ez.y / cAlpha);
}
`;

const REGION_VS = /* glsl */ `
attribute vec2 aParam;
uniform vec4 uRange;
uniform float uAlpha;
uniform float uPeriod;
uniform float uZ;
varying vec2 vBase;
${CONFORMAL_GLSL}
void main() {
  float u = mix(uRange.x, uRange.y, aParam.x);
  float v = mix(uRange.z, uRange.w, aParam.y);
  vBase = vec2(u, v);
  vec2 p = conformalExp(vBase, uAlpha, uPeriod);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, uZ, 1.0);
}
`;

const REGION_FS = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uReveal;
uniform vec2 uOrigin;
uniform float uMaxRadius;
varying vec2 vBase;
void main() {
  float alpha = uOpacity;
  if (uReveal < 0.999) {
    if (uReveal <= 0.0) discard;
    float d = length(vBase - uOrigin);
    float r = uReveal * uMaxRadius;
    float fw = max(fwidth(d) * 1.5, 0.015);
    float mask = 1.0 - smoothstep(r - fw, r + fw, d);
    if (mask <= 0.001) discard;
    alpha *= mask;
  }
  gl_FragColor = vec4(uColor, alpha);
}
`;

const LINE_VS = /* glsl */ `
attribute float aSide;
attribute float aEnd;
attribute vec2 aT;
attribute vec2 aDist;
uniform vec2 uFrom;
uniform vec2 uTo;
uniform float uAlpha;
uniform float uPeriod;
uniform float uReveal;
uniform float uWidth;
uniform vec2 uResolution;
uniform float uDashed;
varying float vDist;
${CONFORMAL_GLSL}
void main() {
  if (aT.x >= uReveal) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vDist = 0.0;
    return;
  }
  float t0 = aT.x;
  float t1 = min(aT.y, uReveal);
  if (t1 <= t0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vDist = 0.0;
    return;
  }
  vec2 p0 = conformalExp(mix(uFrom, uTo, t0), uAlpha, uPeriod);
  vec2 p1 = conformalExp(mix(uFrom, uTo, t1), uAlpha, uPeriod);
  vec4 clip0 = projectionMatrix * modelViewMatrix * vec4(p0, 0.001, 1.0);
  vec4 clip1 = projectionMatrix * modelViewMatrix * vec4(p1, 0.001, 1.0);
  if (clip0.w <= 0.0 && clip1.w <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vDist = 0.0;
    return;
  }
  vec2 halfRes = max(0.5 * uResolution, vec2(1.0));
  vec2 ndc0 = clip0.xy / clip0.w;
  vec2 ndc1 = clip1.xy / clip1.w;
  vec2 px0 = ndc0 * halfRes;
  vec2 px1 = ndc1 * halfRes;
  vec2 delta = px1 - px0;
  float segPx = length(delta);
  vec2 dir = segPx > 1e-6 ? delta / segPx : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  vec4 clip = mix(clip0, clip1, aEnd);
  float overlap = uDashed > 0.5 ? 0.0 : (aEnd * 2.0 - 1.0) * 0.35 * uWidth;
  vec2 pxOff = perp * (aSide * 0.5 * uWidth) + dir * overlap;
  clip.xy += (pxOff / halfRes) * clip.w;
  gl_Position = clip;
  float frac = (mix(t0, t1, aEnd) - aT.x) / max(1e-6, aT.y - aT.x);
  // Estimate CSS pixels per world unit at this point for consistent dash cadence
  vec4 clipO = projectionMatrix * modelViewMatrix * vec4(p0, 0.001, 1.0);
  vec4 clipX = projectionMatrix * modelViewMatrix * vec4(p0 + vec2(0.05, 0.0), 0.001, 1.0);
  vec4 clipY = projectionMatrix * modelViewMatrix * vec4(p0 + vec2(0.0, 0.05), 0.001, 1.0);
  float scaleX = length((clipX.xy / clipX.w - clipO.xy / clipO.w) * halfRes) / 0.05;
  float scaleY = length((clipY.xy / clipY.w - clipO.xy / clipO.w) * halfRes) / 0.05;
  float pxPerUnit = max(1.0, 0.5 * (scaleX + scaleY));
  vDist = mix(aDist.x, aDist.y, frac) * pxPerUnit;
}
`;

const LINE_FS = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform float uOpacity;
uniform vec2 uDash;
varying float vDist;
void main() {
  float cycle = uDash.x + uDash.y;
  if (cycle > 0.0 && mod(vDist, cycle) > uDash.x) discard;
  gl_FragColor = vec4(uColor, uOpacity);
}
`;

type RegionItem = Extract<MorphItem, { kind: 'region' }>;
type LineItem = Extract<MorphItem, { kind: 'line' }>;

interface RegionEntry {
  kind: 'region';
  item: RegionItem;
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  material: THREE.ShaderMaterial;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

interface LineEntry {
  kind: 'line';
  item: LineItem;
  mesh: THREE.Mesh;
  geometry: THREE.InstancedBufferGeometry;
  material: THREE.ShaderMaterial;
  samples: number;
  distAttr: THREE.InstancedBufferAttribute | null;
  distArr: Float32Array | null;
  lastAlpha: number;
  lastPeriod: number;
  from: [number, number];
  to: [number, number];
}

type MorphEntry = RegionEntry | LineEntry;

function buildRegionGeometry(nu: number, nv: number): THREE.BufferGeometry {
  const cols = nu + 1;
  const rows = nv + 1;
  const count = cols * rows;
  const pos = new Float32Array(count * 3);
  const param = new Float32Array(count * 2);
  let pIdx = 0;
  for (let j = 0; j < rows; j++) {
    const v = j / nv;
    for (let i = 0; i < cols; i++) {
      const u = i / nu;
      param[pIdx++] = u;
      param[pIdx++] = v;
    }
  }
  const indices: number[] = [];
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      indices.push(a, b, d, a, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aParam', new THREE.BufferAttribute(param, 2));
  g.setIndex(indices);
  return g;
}

function buildLineGeometry(
  samples: number,
  hasDash: boolean,
): {
  geometry: THREE.InstancedBufferGeometry;
  distAttr: THREE.InstancedBufferAttribute | null;
  distArr: Float32Array | null;
} {
  const segs = Math.max(1, samples - 1);
  const g = new THREE.InstancedBufferGeometry();
  g.instanceCount = segs;
  const pos = new Float32Array(4 * 3);
  const idx = [0, 1, 2, 1, 3, 2];
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSide', new THREE.BufferAttribute(new Float32Array([-1, 1, -1, 1]), 1));
  g.setAttribute('aEnd', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 1]), 1));
  g.setIndex(idx);

  const aT = new Float32Array(segs * 2);
  for (let i = 0; i < segs; i++) {
    aT[2 * i] = i / segs;
    aT[2 * i + 1] = (i + 1) / segs;
  }
  g.setAttribute('aT', new THREE.InstancedBufferAttribute(aT, 2));

  let distAttr: THREE.InstancedBufferAttribute | null = null;
  let distArr: Float32Array | null = null;
  if (hasDash) {
    distArr = new Float32Array(segs * 2);
    distAttr = new THREE.InstancedBufferAttribute(distArr, 2).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aDist', distAttr);
  } else {
    g.setAttribute('aDist', new THREE.InstancedBufferAttribute(new Float32Array(segs * 2), 2));
  }
  return { geometry: g, distAttr, distArr };
}

/** Draws `morph` layer curves and regions using closed-form GPU shaders. */
export class MorphDraw implements Draw {
  readonly key: string;
  readonly group = new THREE.Group();
  private readonly entries: MorphEntry[] = [];
  private readonly layer: MorphLayer;
  private lastAlpha = 0;
  private lastPeriod = 1;

  /** `index` is the index of the layer in its panel, from which the stencil marks of its lines are taken. */
  constructor(ctx: DrawContext, layer: MorphLayer, key: string, index: number) {
    this.key = key;
    this.layer = layer;
    const fg = ctx.theme.foreground;
    let lines = 0;
    for (const item of layer.items) {
      const rgb = hexRgb(themed(item.color ?? fg, ctx.theme));
      if (item.kind === 'region') {
        const [nu, nv] = item.samples ?? [24, 24];
        const geometry = buildRegionGeometry(Math.max(1, nu), Math.max(1, nv));
        const material = new THREE.ShaderMaterial({
          vertexShader: REGION_VS,
          fragmentShader: REGION_FS,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
          uniforms: {
            uRange: { value: new THREE.Vector4(0, 1, 0, 1) },
            uAlpha: { value: 0 },
            uPeriod: { value: 1 },
            uZ: { value: -0.004 },
            uColor: { value: new THREE.Color(rgb[0], rgb[1], rgb[2]) },
            uOpacity: { value: 1 },
            uReveal: { value: 1 },
            uOrigin: { value: new THREE.Vector2(0, 0) },
            uMaxRadius: { value: 1 },
          },
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.frustumCulled = false;
        this.group.add(mesh);
        this.entries.push({ kind: 'region', item, mesh, geometry, material, u0: 0, u1: 1, v0: 0, v1: 1 });
      } else {
        const samples = Math.max(2, item.samples ?? 64);
        const dash = item.dash;
        const { geometry, distAttr, distArr } = buildLineGeometry(samples, dash !== undefined);
        const material = new THREE.ShaderMaterial({
          vertexShader: LINE_VS,
          fragmentShader: LINE_FS,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
          uniforms: {
            uFrom: { value: new THREE.Vector2(0, 0) },
            uTo: { value: new THREE.Vector2(1, 0) },
            uAlpha: { value: 0 },
            uPeriod: { value: 1 },
            uReveal: { value: 1 },
            uWidth: { value: item.width ?? 2 },
            uResolution: { value: new THREE.Vector2(800, 600) },
            uDashed: { value: dash !== undefined ? 1 : 0 },
            uDash: { value: new THREE.Vector2(dash?.[0] ?? 0, dash?.[1] ?? 0) },
            uColor: { value: new THREE.Color(rgb[0], rgb[1], rgb[2]) },
            uOpacity: { value: 1 },
          },
        });
        // The quads of two segments overlap at their joint, where a translucent line would be blended twice. Each solid line thus
        // carries a mark of its own in 128 to 255, apart from the marks of the flat trajectories layers of a panel with fewer than 127 layers.
        if (dash === undefined) flatten(material, 128 + ((16 * index + lines++) % 128));
        const mesh = new THREE.Mesh(geometry, material);
        mesh.frustumCulled = false;
        this.group.add(mesh);
        this.entries.push({
          kind: 'line',
          item,
          mesh,
          geometry,
          material,
          samples,
          distAttr,
          distArr,
          lastAlpha: Number.NaN,
          lastPeriod: Number.NaN,
          from: [0, 0],
          to: [1, 0],
        });
      }
    }
  }

  update(env: LayerEnv, layer: MorphLayer): void {
    const s = timeAt(env.clock, env.q);
    const layerOpacity = opacityAt(layer.opacity, s, 1);
    const alpha = opacityAt(layer.alpha, s, 0);
    const period = resolveNumber(env.scope, layer.period, 'morph', true, 'a morph period');
    this.lastAlpha = alpha;
    this.lastPeriod = period;
    this.group.visible = layerOpacity > 0;
    if (layerOpacity <= 0) return;

    for (const entry of this.entries) {
      const vis = entry.item.visible;
      if (vis !== undefined) {
        const def = inputDef(env.scope.scene, vis.input);
        if (def?.kind === 'toggle' && inputValue(env.scope, vis.input) === false) {
          entry.mesh.visible = false;
          continue;
        }
      }
      const itemOpacity = opacityAt(entry.item.opacity, s, 1) * layerOpacity;
      if (itemOpacity <= 0) {
        entry.mesh.visible = false;
        continue;
      }
      entry.mesh.visible = true;
      const u = entry.material.uniforms;
      u.uAlpha!.value = alpha;
      u.uPeriod!.value = period;
      u.uOpacity!.value = itemOpacity;

      if (entry.kind === 'region') {
        const reveal = opacityAt(entry.item.reveal, s, 1);
        if (reveal <= 0) {
          entry.mesh.visible = false;
          continue;
        }
        entry.u0 = resolveMorphCoord(entry.item.u[0], period);
        entry.u1 = resolveMorphCoord(entry.item.u[1], period);
        entry.v0 = resolveMorphCoord(entry.item.v[0], period);
        entry.v1 = resolveMorphCoord(entry.item.v[1], period);
        const ro = entry.item.reveal_origin;
        const ox = ro !== undefined ? resolveMorphCoord(ro[0]!, period) : 0.5 * (entry.u0 + entry.u1);
        const oy = ro !== undefined ? resolveMorphCoord(ro[1]!, period) : 0.5 * (entry.v0 + entry.v1);
        const maxR =
          Math.max(
            Math.hypot(entry.u0 - ox, entry.v0 - oy),
            Math.hypot(entry.u0 - ox, entry.v1 - oy),
            Math.hypot(entry.u1 - ox, entry.v0 - oy),
            Math.hypot(entry.u1 - ox, entry.v1 - oy),
          ) + 0.04;
        (u.uRange!.value as THREE.Vector4).set(entry.u0, entry.u1, entry.v0, entry.v1);
        u.uReveal!.value = reveal;
        (u.uOrigin!.value as THREE.Vector2).set(ox, oy);
        u.uMaxRadius!.value = maxR;
      } else {
        const reveal = opacityAt(entry.item.reveal, s, 1);
        u.uReveal!.value = reveal;
        if (reveal <= 0) {
          entry.mesh.visible = false;
          continue;
        }
        const fx = resolveMorphCoord(entry.item.from[0], period);
        const fy = resolveMorphCoord(entry.item.from[1], period);
        const tx = resolveMorphCoord(entry.item.to[0], period);
        const ty = resolveMorphCoord(entry.item.to[1], period);
        const coordsChanged = fx !== entry.from[0] || fy !== entry.from[1] || tx !== entry.to[0] || ty !== entry.to[1];
        entry.from = [fx, fy];
        entry.to = [tx, ty];
        (u.uFrom!.value as THREE.Vector2).set(fx, fy);
        (u.uTo!.value as THREE.Vector2).set(tx, ty);
        if (entry.distArr !== null && entry.distAttr !== null && (coordsChanged || alpha !== entry.lastAlpha || period !== entry.lastPeriod)) {
          entry.lastAlpha = alpha;
          entry.lastPeriod = period;
          const segs = entry.samples - 1;
          let acc = 0;
          let [px, py] = conformalExp(fx, fy, alpha, period);
          for (let i = 0; i < segs; i++) {
            const t1 = (i + 1) / segs;
            const [nx, ny] = conformalExp(fx + t1 * (tx - fx), fy + t1 * (ty - fy), alpha, period);
            const ds = Math.hypot(nx - px, ny - py);
            entry.distArr[2 * i] = acc;
            acc += ds;
            entry.distArr[2 * i + 1] = acc;
            px = nx;
            py = ny;
          }
          entry.distAttr.needsUpdate = true;
        }
      }
    }
  }

  extend(box: THREE.Box3): void {
    const tmp = new THREE.Vector3();
    for (const entry of this.entries) {
      if (!entry.mesh.visible) continue;
      if (entry.kind === 'region') {
        const samples = 5;
        for (let j = 0; j < samples; j++) {
          const v = entry.v0 + (j / (samples - 1)) * (entry.v1 - entry.v0);
          for (let i = 0; i < samples; i++) {
            const u = entry.u0 + (i / (samples - 1)) * (entry.u1 - entry.u0);
            const [x, y] = conformalExp(u, v, this.lastAlpha, this.lastPeriod);
            box.expandByPoint(tmp.set(x, y, 0));
          }
        }
      } else {
        const samples = 17;
        for (let i = 0; i < samples; i++) {
          const t = i / (samples - 1);
          const u = entry.from[0] + t * (entry.to[0] - entry.from[0]);
          const v = entry.from[1] + t * (entry.to[1] - entry.from[1]);
          const [x, y] = conformalExp(u, v, this.lastAlpha, this.lastPeriod);
          box.expandByPoint(tmp.set(x, y, 0));
        }
      }
    }
  }

  resize(w: number, h: number): void {
    for (const entry of this.entries) {
      if (entry.kind === 'line') (entry.material.uniforms.uResolution!.value as THREE.Vector2).set(w, h);
    }
  }

  dispose(): void {
    for (const entry of this.entries) {
      entry.geometry.dispose();
      entry.material.dispose();
    }
  }
}
