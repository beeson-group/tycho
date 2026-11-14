// Tests the copy of a panel's static layers under Node, with a stub in place of the WebGL renderer.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { sceneTheme } from '../src/runtime/colors';
import { GeometryCache } from '../src/runtime/geometry';
import { overlaps, Shared, PanelAreaRenderer } from '../src/runtime/renderer';
import type { Keyframes, Layout, State } from '../src/scene';
import { baseScene, MemoryStore } from './helpers';

/** Copies a panel's region `r` into a target of 782 by 600 px, and returns where the copy ends. */
function copyEnd(r: THREE.Vector4): { x: number; y: number } {
  let end = { x: 0, y: 0 };
  const gl = {
    setRenderTarget() {},
    clear() {},
    render() {},
    copyTextureToTexture(_source: THREE.Texture, _target: THREE.Texture, region: THREE.Box2, corner: THREE.Vector2) {
      end = { x: corner.x + region.max.x - region.min.x, y: corner.y + region.max.y - region.min.y };
    },
  };
  const stage = Object.assign(Object.create(PanelAreaRenderer.prototype), { gl, scratch: null, region: new THREE.Box2(), corner: new THREE.Vector2() });
  stage.drawFine({ staticScene: new THREE.Scene(), camera: new THREE.Camera() }, new THREE.WebGLRenderTarget(782, 600), r);
  return end;
}

describe('the copy of static layers', () => {
  it('stops at the end of the target when the viewport is rounded up past it', () => {
    // 626 CSS px at a pixel ratio of 1.25 are a viewport of 783 px and a drawing buffer of 782 px
    expect(copyEnd(new THREE.Vector4(0, 0, 783, 600))).toEqual({ x: 782, y: 600 });
    expect(copyEnd(new THREE.Vector4(400, 100, 383, 501))).toEqual({ x: 782, y: 600 });
  });

  it('keeps the whole region of a panel inside the target', () => {
    expect(copyEnd(new THREE.Vector4(10, 20, 300, 200))).toEqual({ x: 310, y: 220 });
  });
});

/**
 * A stand-in for three's renderer at a pixel ratio of 1, which keeps for every pixel of the underlay and of the canvas the number of
 * the panel whose static layers were drawn there, or 0. It does not draw the live layers, hence the canvas shows what the underlay
 * gives back, and `owner` gives the number of a panel's static scene, or null for a live scene.
 */
class PixelGl {
  w = 0;
  h = 0;
  underlay = new Int32Array(0);
  canvas = new Int32Array(0);
  private target: THREE.WebGLRenderTarget | null = null;
  private drawn = 0;
  private readonly viewport = new THREE.Vector4();
  private readonly scissor = new THREE.Vector4();

  constructor(
    private readonly owner: (scene: THREE.Object3D) => number | null,
    private readonly blitScene: THREE.Scene,
  ) {}

  private paint(pixels: Int32Array, x: number, y: number, w: number, h: number, value: number | ((i: number) => number)): void {
    for (let j = Math.max(0, y); j < Math.min(this.h, y + h); j++)
      for (let i = Math.max(0, x); i < Math.min(this.w, x + w); i++) pixels[j * this.w + i] = typeof value === 'number' ? value : value(j * this.w + i);
  }

  /** The numbers of the panels seen on the canvas in region `r`. */
  seen(r: THREE.Vector4): number[] {
    const out = new Set<number>();
    for (let j = r.y; j < r.y + r.w; j++) for (let i = r.x; i < r.x + r.z; i++) out.add(this.canvas[j * this.w + i]!);
    return [...out].sort();
  }

  setPixelRatio(): void {}
  setSize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.underlay = new Int32Array(w * h);
    this.canvas = new Int32Array(w * h);
  }
  getDrawingBufferSize(v: THREE.Vector2): THREE.Vector2 {
    return v.set(this.w, this.h);
  }
  setScissorTest(): void {}
  setClearColor(): void {}
  clear(): void {
    // only the frame clears the canvas, and a draw into the scratch target replaces all of it
    if (this.target === null) this.canvas.fill(0);
  }
  setViewport(x: number | THREE.Vector4, y = 0, w = 0, h = 0): void {
    if (typeof x === 'number') this.viewport.set(x, y, w, h);
    else this.viewport.copy(x);
  }
  getViewport(v: THREE.Vector4): THREE.Vector4 {
    return v.copy(this.viewport);
  }
  getCurrentViewport(v: THREE.Vector4): THREE.Vector4 {
    return v.copy(this.viewport);
  }
  setScissor(x: number | THREE.Vector4, y = 0, w = 0, h = 0): void {
    if (typeof x === 'number') this.scissor.set(x, y, w, h);
    else this.scissor.copy(x);
  }
  getScissor(v: THREE.Vector4): THREE.Vector4 {
    return v.copy(this.scissor);
  }
  initRenderTarget(): void {}
  setRenderTarget(t: THREE.WebGLRenderTarget | null): void {
    this.target = t;
  }
  render(scene: THREE.Object3D): void {
    const v = this.viewport;
    if (scene === this.blitScene) return this.paint(this.canvas, v.x, v.y, v.z, v.w, (i) => this.underlay[i]!);
    const id = this.owner(scene);
    if (id === null) return;
    if (this.target === null) this.paint(this.canvas, v.x, v.y, v.z, v.w, id);
    else if (this.target.samples > 0) this.drawn = id;
    else this.paint(this.underlay, this.target.viewport.x, this.target.viewport.y, this.target.viewport.z, this.target.viewport.w, id);
  }
  copyTextureToTexture(_s: THREE.Texture, _t: THREE.Texture, region: THREE.Box2, corner: THREE.Vector2): void {
    this.paint(this.underlay, corner.x, corner.y, region.max.x - region.min.x, region.max.y - region.min.y, this.drawn);
  }
}

/** A stage of 100 by 40 CSS pixels whose panels p1 and p2 draw one static trajectory each, without WebGL, laid out by `layout`. */
function pixelStage(layout: Layout) {
  const scene = baseScene({ version: '0.4' });
  scene.panels.main!.layers = [{ kind: 'trajectories', sets: { set: 's' }, members: 'all', reveal: 'none' }];
  const data = new MemoryStore()
    .add('off', [0, 2], 'uint32')
    .add('pos', [
      [0, 0],
      [10, 1],
    ])
    .add('time', [0, 1]);
  const geometry = new GeometryCache(scene, data);
  const ctx = { scene, geometry, shared: new Shared(), theme: sceneTheme(scene), disc: new THREE.Texture() };
  const blit = { scene: new THREE.Scene(), camera: new THREE.Camera(), material: { uniforms: { uUnderlay: { value: null } } } };
  const panels = new Map<string, any>();
  const gl = new PixelGl((s) => {
    for (const [pid, p] of panels) if (p.staticScene === s) return Number(pid.slice(1));
    return null;
  }, blit.scene);
  const stage = Object.assign(Object.create(PanelAreaRenderer.prototype), {
    gl,
    ctx,
    panels,
    blit,
    lastState: null,
    size: { w: 0, h: 0, ratio: 0 },
    background: new THREE.Color(),
    cacheStatic: true,
    coarseDrags: false,
    refineTimer: null,
    underlay: null,
    scratch: null,
    viewport: new THREE.Vector4(),
    cssViewport: new THREE.Vector4(),
    cssScissor: new THREE.Vector4(),
    buffer: new THREE.Vector2(),
    region: new THREE.Box2(),
    corner: new THREE.Vector2(),
    onChange: () => undefined,
  });
  const state: State = { clock: { channel: 'time' }, panels: { p1: { panel: 'main' }, p2: { panel: 'main' } }, layout };
  // the timeline of the default clock lasts 8 s
  const at = (s: number) => stage.renderAt(state, s / 8, 100, 40, 1);
  /** The numbers of the panels that the canvas shows in panel `pid`'s region. */
  const shows = (pid: string): number[] => gl.seen(panels.get(pid).underlay);
  return { at, shows, panels };
}

describe('the underlay shared by the panels', () => {
  const split = (keys: readonly (readonly [number, number])[]): Layout => ({
    kind: 'split',
    dir: 'row',
    ratio: 0.5,
    keyframes: keys.map((k) => [...k]) as Keyframes,
    a: { kind: 'panel', id: 'p1' },
    b: { kind: 'panel', id: 'p2' },
  });

  it('tells regions that share a pixel from those that touch or were never set', () => {
    const r = (x: number, y: number, w: number, h: number) => new THREE.Vector4(x, y, w, h);
    expect(overlaps(r(0, 0, 10, 10), r(9, 9, 5, 5))).toBe(true);
    expect(overlaps(r(0, 0, 100, 40), r(62, 0, 38, 40))).toBe(true);
    expect(overlaps(r(0, 0, 10, 10), r(10, 0, 5, 5))).toBe(false);
    expect(overlaps(r(0, 0, 10, 10), r(0, 10, 5, 5))).toBe(false);
    expect(overlaps(r(-1, -1, -1, -1), r(0, 0, 100, 40))).toBe(false);
  });

  // a panel that takes the whole stage for a while, then gives a side back, either the first one or the second
  for (const [name, keys, cover] of [
    [
      'the first panel',
      [
        [0, 1],
        [2, 1],
        [4, 0.6],
      ],
      'p1',
    ],
    [
      'the second panel',
      [
        [0, 0],
        [2, 0],
        [4, 0.4],
      ],
      'p2',
    ],
  ] as const) {
    it(`draws a panel's own static layers after ${name} covered its region, across a seek (section 2.11)`, () => {
      const { at, shows } = pixelStage(split(keys));
      at(6);
      expect([shows('p1'), shows('p2')]).toEqual([[1], [2]]);
      // the covering panel draws its static layers over the whole underlay
      at(0);
      expect(shows(cover)).toEqual([Number(cover.slice(1))]);
      // a seek back: the other panel returns to its region of 6 s, with its camera of 6 s
      at(7);
      expect([shows('p1'), shows('p2')]).toEqual([[1], [2]]);
    });
  }

  it('does not draw the static layers of a panel again when nothing covered its region', () => {
    const { at, panels } = pixelStage(split([[0, 0.6]]));
    at(1);
    const rebuilt = [...panels.values()].map((p) => p.rebuiltAt);
    at(2);
    expect([...panels.values()].map((p) => p.rebuiltAt)).toEqual(rebuilt);
  });
});
