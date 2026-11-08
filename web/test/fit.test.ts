// Tests the camera fit, the lazy per-track geometry, and the per-track buffers under Node, which do not need WebGL.
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { TychoError } from '../src/errors';
import { progress } from '../src/evaluate/clock';
import { evaluate } from '../src/evaluate/index';
import type { LayerEnv } from '../src/evaluate/layers';
import type { TrackLayerResult } from '../src/evaluate/types';
import { members, sparse } from '../src/evaluate/resolve';
import type { SetData } from '../src/evaluate/sets';
import { sceneTheme } from '../src/runtime/colors';
import { GeometryCache, pairReadings, pairs, readingPairs, revealSpec, revealTrack, slicePairs, vertexReading } from '../src/runtime/geometry';
import { mergeColorbars, type Colorbar } from '../src/runtime/overlay';
import {
  cameraMoved,
  contentKey,
  fitBox,
  kernelOpacity,
  labelBox,
  labelsOverlap,
  orthoFit,
  planeLabels,
  planeView,
  planPanel,
  Shared,
  StageRenderer,
  TrackDraw,
  type TrackPlan,
} from '../src/runtime/renderer';
import { withVariable } from '../src/runtime/state';
import type { Camera, Layer, State, TrackLayer } from '../src/scene';
import { loadCorpus } from './corpus';
import { baseScene, MemoryStore } from './helpers';

const broucke = () => {
  const c = loadCorpus('broucke-mini');
  return { ...c, geometry: new GeometryCache(c.scene, c.data) };
};

describe('when a panel refits', () => {
  it("on a new display frame, driver's track set, or track layer's track set, and not on a new member", () => {
    const c = broucke();
    const key = (st: State) => contentKey(planPanel(c.scene, c.geometry, st, 'p1'));
    const st = c.scene.initial;
    const base = key(st);
    const other = c.geometry.sets.get('family-7-periapsis').parameter('eccentricity')[2]!;
    expect(key(withVariable(c.scene, st, 'e', other))).toBe(base);
    expect(key(withVariable(c.scene, st, 'family', '8'))).not.toBe(base);
    expect(key(withVariable(c.scene, st, 'branch', 'apoapsis'))).not.toBe(base);
    expect(key(withVariable(c.scene, st, 'frame', 'rotating', 'p1'))).not.toBe(base);
  });
});

describe('fitBox', () => {
  it('holds every sample of every member of every track layer, and is not larger', () => {
    const c = broucke();
    for (const frame of ['rotating-pulsating', 'rotating', 'barycentric-inertial', 'inertial-m1', 'inertial-m2']) {
      const st = withVariable(c.scene, withVariable(c.scene, c.scene.initial, 'family', '8'), 'frame', frame, 'p1');
      const plan = planPanel(c.scene, c.geometry, st, 'p1');
      const box = fitBox(plan, c.geometry)!;
      const p = c.geometry.geometry('family-8-periapsis', frame).positions;
      const want = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (let i = 0; i < p.length; i += 3)
        for (let k = 0; k < 3; k++) ((want[k] = Math.min(want[k]!, p[i + k]!)), (want[k + 3] = Math.max(want[k + 3]!, p[i + k]!)));
      expect(box).toEqual(want);
    }
  });
  it('is null when the track layers do not draw anything', () => {
    const c = broucke();
    c.scene.views.main!.layers = c.scene.views.main!.layers.filter((l) => l.kind !== 'track');
    expect(fitBox(planPanel(c.scene, c.geometry, c.scene.initial, 'p1'), c.geometry)).toBeNull();
  });
});

describe('orthoFit', () => {
  const box = new THREE.Box3(new THREE.Vector3(-1, 0, -3), new THREE.Vector3(3, 2, 4));
  it('keeps a world unit square and leaves a tenth of margin', () => {
    expect(orthoFit(box, { kind: 'plane', plane: 'xy' }, 1).halfHeight).toBeCloseTo(2.2, 12);
    expect(orthoFit(box, { kind: 'plane', plane: 'xy' }, 4).halfHeight).toBeCloseTo(1.1, 12);
    expect(orthoFit(box, { kind: 'plane', plane: 'xz' }, 1).halfHeight).toBeCloseTo(3.85, 12);
    expect(orthoFit(box, { kind: 'plane', plane: 'yz' }, 0.5).halfHeight).toBeCloseTo(3.85, 12);
    expect(orthoFit(box, { kind: 'plane' }, 1).center.toArray()).toEqual([1, 1, 0.5]);
  });
  it('shows the whole box at any aspect', () => {
    for (const aspect of [0.3, 1, 2.7]) {
      const { halfHeight } = orthoFit(box, { kind: 'plane', plane: 'xy' }, aspect);
      expect(halfHeight * aspect).toBeGreaterThanOrEqual(2);
      expect(halfHeight).toBeGreaterThanOrEqual(1);
    }
  });
  it('under a free aspect fits the two axes separately, and a flat axis at the scale of the equal fit', () => {
    const wide = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 1, 0));
    const equal = orthoFit(wide, { kind: 'plane', plane: 'xy' }, 1);
    expect([equal.halfWidth, equal.halfHeight]).toEqual([expect.closeTo(5.5, 12), expect.closeTo(5.5, 12)]);
    const free = orthoFit(wide, { kind: 'plane', plane: 'xy', aspect: 'free' }, 1);
    expect([free.halfWidth, free.halfHeight]).toEqual([expect.closeTo(5.5, 12), expect.closeTo(0.55, 12)]);
    const line = new THREE.Box3(new THREE.Vector3(0, 2, 0), new THREE.Vector3(10, 2, 0));
    const flat = orthoFit(line, { kind: 'plane', plane: 'xy', aspect: 'free' }, 2);
    expect([flat.halfWidth, flat.halfHeight]).toEqual([expect.closeTo(5.5, 12), expect.closeTo(2.75, 12)]);
  });
  it('under a free aspect keeps a tiny but real extent, e.g. a residual below 1e-12 against an iteration count', () => {
    const residual = new THREE.Box3(new THREE.Vector3(0, 1e-15, 0), new THREE.Vector3(10, 5e-13, 0));
    const fit = orthoFit(residual, { kind: 'plane', plane: 'xy', aspect: 'free' }, 1);
    expect([fit.halfWidth, fit.halfHeight]).toEqual([expect.closeTo(5.5, 12), expect.closeTo(2.7445e-13, 16)]);
  });
});

/** A panel of 400 by 400 CSS pixels that draws one track from (0, 0) to (10, 1) with `layers` after it, planned, fitted, and laid out without WebGL. */
function widePanel(camera: Camera, layers: Layer[] = []) {
  const scene = baseScene();
  scene.views.main!.camera = camera;
  scene.views.main!.layers.push(...layers);
  const data = new MemoryStore()
    .add('off', [0, 2], 'uint32')
    .add('pos', [
      [0, 0],
      [10, 1],
    ])
    .add('time', [0, 1]);
  const geometry = new GeometryCache(scene, data);
  const ctx = { scene, geometry, shared: new Shared(), theme: sceneTheme(scene), disc: new THREE.Texture() };
  const stage = Object.assign(Object.create(StageRenderer.prototype), { ctx, panels: new Map(), lastState: null });
  const p = stage.panel('p1');
  p.rect = { x: 0, y: 0, w: 400, h: 400 };
  stage.replan(p, scene.initial);
  stage.fit(p);
  stage.follow(p);
  // the track's two ends in normalized device coordinates, from -1 to 1 across and up the panel
  const ends = () => {
    p.camera.updateMatrixWorld();
    return [new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 1, 0)].map((v) => v.project(p.camera));
  };
  return { stage, p, ends };
}

/** A panel of 400 by 400 CSS pixels under `camera` that draws one track from (0, 0, 0) to (10, 1, 1) and the axes, planned and fitted without WebGL. */
function boxPanel(camera: Camera) {
  const scene = baseScene({ version: '0.3' });
  scene.views.main!.camera = camera;
  scene.views.main!.layers.push({ kind: 'axes' });
  const data = new MemoryStore()
    .add('off', [0, 2], 'uint32')
    .add('pos', [
      [0, 0, 0],
      [10, 1, 1],
    ])
    .add('time', [0, 1]);
  const geometry = new GeometryCache(scene, data);
  const ctx = { scene, geometry, shared: new Shared(), theme: sceneTheme(scene), disc: new THREE.Texture() };
  const stage = Object.assign(Object.create(StageRenderer.prototype), { ctx, panels: new Map(), lastState: null });
  const p = stage.panel('p1');
  p.rect = { x: 0, y: 0, w: 400, h: 400 };
  stage.replan(p, scene.initial);
  stage.fit(p);
  return { stage, p };
}

describe("an orbit camera's stretch and turn (2.7)", () => {
  const near = (v: THREE.Vector3) => v.toArray().map((x) => expect.closeTo(x, 9));
  it('stretches what the panel draws, fits the stretched box, and draws every axis at one length after the stretch', () => {
    const { p } = boxPanel({ kind: 'orbit', stretch: [1, 1, 5] });
    expect(p.scene.scale.toArray()).toEqual([1, 1, 5]);
    expect(p.staticScene.scale.toArray()).toEqual([1, 1, 5]);
    expect(p.box.max.toArray()).toEqual([10, 1, 1]);
    expect(p.target.toArray()).toEqual([5, 0.5, 2.5]);
    // the stretched box is 10 by 1 by 5, hence every axis is drawn 5 long, the round half of its largest side
    const drawn = p.draws.get(1).tips.map((t: THREE.Vector3) =>
      t
        .clone()
        .multiply(new THREE.Vector3(1, 1, 5))
        .length(),
    );
    expect(drawn).toEqual([5, 5, 5]);
    const plain = boxPanel({ kind: 'orbit' }).p;
    expect(plain.scene.scale.toArray()).toEqual([1, 1, 1]);
    expect(plain.target.toArray()).toEqual([5, 0.5, 0.5]);
  });
  it('titles a stretched axis with its factor and places every label at the stretched point', () => {
    const { stage, p } = boxPanel({ kind: 'orbit', stretch: [1, 1, 2.5] });
    const items = stage.labelItems(p);
    expect(items.map((l: { text: string }) => l.text)).toEqual(['x', 'y', 'z ×2.5']);
    const tip = p.draws
      .get(1)
      .tips[2].clone()
      .multiply(new THREE.Vector3(1, 1, 2.5))
      .project(p.camera);
    expect(items[2].x).toBeCloseTo(((tip.x + 1) / 2) * 400 + 4, 9);
    expect(items[2].y).toBeCloseTo(((1 - tip.y) / 2) * 400, 9);
    const plain = boxPanel({ kind: 'orbit' });
    expect(plain.stage.labelItems(plain.p).map((l: { text: string }) => l.text)).toEqual(['x', 'y', 'z']);
  });
  it('turns the camera about the up axis through its target by turn degrees times the progress, and back at the start of a loop', () => {
    const { stage, p } = boxPanel({ kind: 'orbit', turn: 90 });
    const offset = () => p.camera.position.clone().sub(p.target);
    const start = offset();
    stage.turn(p, 0.5);
    expect(offset().toArray()).toEqual(near(start.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 4)));
    stage.turn(p, 0);
    expect(offset().toArray()).toEqual(near(start));
    const y = boxPanel({ kind: 'orbit', up: 'y', turn: -180 });
    const from = y.p.camera.position.clone().sub(y.p.target);
    y.stage.turn(y.p, 0.25);
    expect(y.p.camera.position.clone().sub(y.p.target).toArray()).toEqual(near(from.applyAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 4)));
  });
  it('adds the turn to where the viewer moved the camera, and does not turn a camera without a turn', () => {
    const { stage, p } = boxPanel({ kind: 'orbit', turn: 90 });
    const z = new THREE.Vector3(0, 0, 1);
    const start = p.camera.position.clone().sub(p.target);
    p.camera.position.copy(p.target).add(start.clone().applyAxisAngle(z, 0.1));
    stage.turn(p, 0.5);
    expect(p.camera.position.clone().sub(p.target).toArray()).toEqual(near(start.clone().applyAxisAngle(z, 0.1 + Math.PI / 4)));
    const still = boxPanel({ kind: 'orbit' });
    const before = still.p.camera.position.clone();
    still.stage.turn(still.p, 0.5);
    expect(still.p.camera.position.toArray()).toEqual(before.toArray());
  });
});

describe('a plane camera with a free aspect (2.7)', () => {
  it('fits a 10 by 1 track to fill a square panel in both directions, which an equal aspect does not', () => {
    const [a, b] = widePanel({ kind: 'plane', aspect: 'free' }).ends();
    expect([a!.x, a!.y, b!.x, b!.y]).toEqual([-1 / 1.1, -1 / 1.1, 1 / 1.1, 1 / 1.1].map((x) => expect.closeTo(x, 9)));
    const [c, d] = widePanel({ kind: 'plane' }).ends();
    expect(d!.x - c!.x).toBeCloseTo(2 / 1.1, 9);
    expect(d!.y - c!.y).toBeCloseTo(0.2 / 1.1, 9);
    const [e, f] = widePanel({ kind: 'plane', aspect: 'equal' }).ends();
    expect([e!.y, f!.y]).toEqual([c!.y, d!.y]);
  });
  it('keeps the rectangle it shows when the panel is resized after the viewer moved the camera, while an equal aspect widens it', () => {
    for (const [camera, width] of [
      [{ kind: 'plane', aspect: 'free' }, 11],
      [{ kind: 'plane' }, 22],
    ] as const) {
      const { stage, p } = widePanel(camera);
      p.userMoved = true;
      p.rect = { x: 0, y: 0, w: 800, h: 400 };
      stage.aspect(p);
      stage.follow(p);
      expect(p.view.x1 - p.view.x0).toBeCloseTo(width, 9);
    }
  });
  it('ticks and numbers each axis at a step for its scale', () => {
    const { p } = widePanel({ kind: 'plane', aspect: 'free' }, [{ kind: 'axes' }]);
    expect([p.view.stepX, p.view.stepY]).toEqual([2, 0.2]);
    const ticks = planeLabels(p.view, true, null);
    expect(ticks.filter((l) => l.align === 'center').map((l) => l.text)).toEqual(['2', '4', '6', '8', '10']);
    expect(ticks.filter((l) => l.align === 'end').map((l) => l.text)).toEqual(['0.2', '0.4', '0.6', '0.8']);
    const equal = widePanel({ kind: 'plane' }, [{ kind: 'axes' }]).p.view;
    expect(equal.stepX).toBe(equal.stepY);
  });
  it('lays a grid without numbers out across the view at the step of each axis', () => {
    const grid = (camera: Camera) => {
      const { p } = widePanel(camera, [{ kind: 'grid', labels: false }]);
      const draw = p.draws.get(1);
      const pos = draw.lines.geometry.getAttribute('position').array as Float32Array;
      const xs = new Set<number>();
      const ys = new Set<number>();
      for (let i = 0; i < pos.length; i += 6) (pos[i] === pos[i + 3] ? xs : ys).add(Math.round((pos[i] === pos[i + 3] ? pos[i]! : pos[i + 1]!) * 1e6) / 1e6);
      return { follows: draw.follows, xs: [...xs].sort((a, b) => a - b), ys: [...ys].sort((a, b) => a - b) };
    };
    expect(grid({ kind: 'plane', aspect: 'free' })).toEqual({ follows: true, xs: [0, 2, 4, 6, 8, 10], ys: [0, 0.2, 0.4, 0.6, 0.8, 1] });
    expect(grid({ kind: 'plane' }).follows).toBe(false);
  });
  it('draws positive half-axes as long as a round fraction of the box along each axis', () => {
    const tips = (camera: Camera) =>
      widePanel(camera, [{ kind: 'axes', span: 'positive' }])
        .p.draws.get(1)
        .tips.map((v: THREE.Vector3) => v.toArray());
    expect(tips({ kind: 'plane', aspect: 'free' })).toEqual([
      [5, 0, 0],
      [0, 0.5, 0],
      [0, 0, 5],
    ]);
    expect(tips({ kind: 'plane' })).toEqual([
      [5, 0, 0],
      [0, 5, 0],
      [0, 0, 5],
    ]);
  });
});

describe('lazy geometry and per-track buffers', () => {
  it('one track transformed alone equals its slice of the whole track set, shifted too', () => {
    const c = broucke();
    const fresh = new GeometryCache(c.scene, c.data).geometry('family-7-apoapsis', 'inertial-m1');
    const whole = c.geometry.geometry('family-7-apoapsis', 'inertial-m1');
    const set = whole.set;
    for (let t = 0; t < set.tracks; t++) {
      const s = set.start(t);
      const m = set.count(t);
      expect(Array.from(fresh.track(t, true))).toEqual(Array.from(whole.shifted!.subarray(3 * s, 3 * (s + m))));
      expect(Array.from(fresh.track(t, false))).toEqual(Array.from(whole.positions.subarray(3 * s, 3 * (s + m))));
    }
  });
  it('a track pass draws the same pairs as its part of the whole-set pass', () => {
    const c = broucke();
    const g = c.geometry.geometry('family-8-apoapsis', 'rotating');
    const set = g.set;
    const all = pairs(set, g.positions, 3);
    const u = c.geometry.readings(set.id, 'time').u;
    const allU = pairReadings(set, u);
    for (let t = 0; t < set.tracks; t++) {
      const j = set.start(t) - t;
      const m = set.count(t);
      expect(Array.from(slicePairs(g.track(t, false), 3, 0, m))).toEqual(Array.from(all.subarray(6 * j, 6 * (j + m - 1))));
      expect(Array.from(readingPairs(u, set.start(t), m))).toEqual(Array.from(allU.subarray(4 * j, 4 * (j + m - 1))));
    }
  });
  it('a taper reads the head at the reading and a wrapped tail one fraction behind', () => {
    const c = broucke();
    const set = c.geometry.sets.get('family-7-periapsis');
    const layer: TrackLayer = { kind: 'track', sets: { set: set.id }, members: 'all', reveal: 'trail', trail: { fraction: 0.4 }, head: true };
    const tc = c.geometry.readings(set.id, 'true_anomaly').clocks[1]!;
    for (const q of [0.1, 0.25, 0.7]) {
      const rev = revealTrack(tc, c.scene.clock, q, revealSpec(layer, true));
      expect(rev.reading).toBe(q);
      expect(vertexReading(tc, rev.head!)).toBeCloseTo(q, 12);
      expect(vertexReading(tc, rev.pieces[0]![0])).toBeCloseTo(q - 0.4, 12);
      expect(vertexReading(tc, rev.pieces[rev.pieces.length - 1]![1])).toBeCloseTo(q, 12);
    }
  });
});

describe('a panel plan of the grammar of 0.2', () => {
  const laps = () => {
    const c = loadCorpus('laps');
    return { ...c, geometry: new GeometryCache(c.scene, c.data) };
  };
  const tracks = (c: ReturnType<typeof laps>, st: State) => planPanel(c.scene, c.geometry, st, 'p1').layers.filter((l): l is TrackPlan => l.kind === 'track');

  it("resolves a colormap keyed on a choice by the panel's value, and leaves the rest alone", () => {
    const c = laps();
    const inertial = tracks(c, c.scene.initial);
    const rot = tracks(c, withVariable(c.scene, c.scene.initial, 'frame', 'rot', 'p1'));
    expect(inertial.map((l) => (typeof l.color === 'object' ? l.color.colormap : (l.color ?? null)))).toEqual([null, null, null, null, 'plasma', 'plasma']);
    expect(rot.map((l) => (typeof l.color === 'object' ? l.color.colormap : (l.color ?? null)))).toEqual([null, null, null, null, 'viridis', 'viridis']);
    expect(inertial[4]!.color).toEqual({ parameter: 'e', colormap: 'plasma' });
  });

  it('takes its members from the evaluator for every reference, a count included', () => {
    const c = laps();
    const plan = planPanel(c.scene, c.geometry, c.scene.initial, 'p1');
    const fan = c.geometry.sets.get('fan');
    const ts = plan.layers.filter((l): l is TrackPlan => l.kind === 'track');
    expect(ts[4]!.members).toEqual(sparse(5, 2));
    expect(ts[4]!.members).toEqual([0, 3, 4]);
    for (const l of ts) expect(l.members).toEqual(members(plan.scope, l.layer.members, l.set!));
    // the selector `e` of the highlight, by nearest at 0.2, picks a member of the all-members layer
    expect(ts[5]!.selected).toBe(ts[5]!.highlight);
    expect(fan.parameter('e')[ts[5]!.selected!]).toBeCloseTo(0.2, 12);
  });

  it('refuses a reading on a track set that is not periodic when the clock has laps (C6)', () => {
    const c = laps();
    c.scene.views.v!.layers[5] = { ...(c.scene.views.v!.layers[5] as TrackLayer), reveal: 'grow' };
    expect(() => planPanel(c.scene, c.geometry, c.scene.initial, 'p1')).toThrow(TychoError);
    expect(() => planPanel(c.scene, c.geometry, c.scene.initial, 'p1')).toThrow(/\[C6\]/);
  });

  it('fits every lap the loop draws', () => {
    const c = laps();
    const box = fitBox(planPanel(c.scene, c.geometry, c.scene.initial, 'p1'), c.geometry)!;
    const g = c.geometry.geometry('loop', 'inertial');
    for (let j = 0; j < 3; j++) {
      const p = g.lapPositions(j);
      for (let i = 0; i < p.length; i += 3)
        for (let k = 0; k < 3; k++) (expect(p[i + k]!).toBeGreaterThanOrEqual(box[k]! - 1e-15), expect(p[i + k]!).toBeLessThanOrEqual(box[k + 3]! + 1e-15));
    }
  });
});

describe('a highlight kernel (2.7)', () => {
  it('gives max(o, a exp(-(d / (w extent))^2)), and the floor where the kernel is weaker', () => {
    const k = { width: 0.05, opacity: 0.55 };
    expect(kernelOpacity(0.05, k, 2, 0)).toBe(0.55);
    expect(kernelOpacity(0.05, k, 2, 0.1)).toBeCloseTo(0.55 * Math.exp(-1), 15);
    expect(kernelOpacity(0.05, k, 2, 0.3)).toBe(0.05);
    // the ratio is 0 when the extent is zero
    expect(kernelOpacity(0.05, k, 0, 5)).toBe(0.55);
    expect(kernelOpacity(0.8, k, 2, 0)).toBe(0.8);
  });
  it('merged colorbars keep the first marker and the first band that any of them has', () => {
    const bar = (marker: number | null, band: [number, number] | null): Colorbar => ({ label: 'e', gradient: 'g', stops: [], lo: 0, hi: 1, marker, band });
    expect(mergeColorbars([bar(null, null), bar(0.5, [0.4, 0.6]), bar(0.7, null)])).toEqual([bar(0.5, [0.4, 0.6])]);
    expect(mergeColorbars([bar(null, null), { ...bar(null, null), label: 'f' }])).toHaveLength(2);
  });
});

describe("a plane camera's axes and grid follow the visible rectangle", () => {
  const camera = (cx: number, cy: number, half: number, aspect: number, zoom = 1) => {
    const cam = new THREE.OrthographicCamera(-half * aspect, half * aspect, half, -half, -10, 10);
    cam.position.set(cx, cy, 5);
    cam.zoom = zoom;
    return cam;
  };
  it('reads the rectangle off the camera, through pan and zoom', () => {
    const v = planeView(camera(0.3, -0.2, 1.1, 2), { kind: 'plane', plane: 'xy' }, 880, 440);
    expect([v.x0, v.x1, v.y0, v.y1]).toEqual([0.3 - 2.2, 0.3 + 2.2, -0.2 - 1.1, -0.2 + 1.1].map((x) => expect.closeTo(x, 12)));
    // 880 / 110 = 8 ticks across 4.4 and 440 / 70 ticks up 2.2
    expect([v.stepX, v.stepY]).toEqual([0.5, 0.5]);
    const zoomed = planeView(camera(0.3, -0.2, 1.1, 2, 4), { kind: 'plane', plane: 'xy' }, 880, 440);
    expect(zoomed.x1 - zoomed.x0).toBeCloseTo(1.1, 12);
    expect([zoomed.stepX, zoomed.stepY]).toEqual([0.1, 0.1]);
    const xz = planeView(camera(0, 0, 1, 1), { kind: 'plane', plane: 'xz' }, 500, 500);
    expect(xz.x1 - xz.x0).toBeCloseTo(2, 12);
  });
  it('numbers the lines at the step, with decimals from it, clear of the corners, and titles the two axes', () => {
    const v = planeView(camera(0, 0, 1.1, 2), { kind: 'plane', plane: 'xy' }, 880, 440);
    const labels = planeLabels(v, true, ['x\u0303 [DU]', 'y\u0303 [DU]']);
    const ticks = labels.filter((l) => l.kind === 'tick');
    const bottom = ticks.filter((l) => l.align === 'center').map((l) => l.text);
    const left = ticks.filter((l) => l.align === 'end').map((l) => l.text);
    expect(bottom).toEqual(['\u22121.5', '\u22121.0', '\u22120.5', '0.0', '0.5', '1.0', '1.5', '2.0']);
    // the left edge skips the top 22 pixels and the bottom 44, where the tick row and the corner are
    expect(left).toEqual(['\u22120.5', '0.0', '0.5']);
    for (const t of ticks) expect(t.x > 0 && t.x <= 880 && t.y > 0 && t.y < 440).toBe(true);
    const titles = labels.filter((l) => l.kind === 'title');
    expect(titles).toEqual([
      { text: 'x\u0303 [DU]', x: 440, y: 430, align: 'center', kind: 'title' },
      { text: 'y\u0303 [DU]', x: 10, y: 220, align: 'center', rotate: true, kind: 'title' },
    ]);
    // each title has a separate row. the tick row sits 28 px and the x title 10 px above the bottom edge. the y tick column ends
    // at 46.5 px for the label of -0.5 and starts at 22 px, clear of the 13 px that the y title spans around x = 10 px
    expect(new Set(ticks.filter((l) => l.align === 'center').map((l) => l.y))).toEqual(new Set([412]));
    expect(new Set(ticks.filter((l) => l.align === 'end').map((l) => l.x))).toEqual(new Set([46.5]));
    expect(planeLabels(v, false, null)).toEqual([]);
  });
  it('keeps the y tick column clear of the y title at its widest number, and drops a title that does not have room', () => {
    const wide = planeView(camera(0, 0, 1100, 2), { kind: 'plane', plane: 'xy' }, 880, 440);
    const column = planeLabels(wide, true, null).filter((l) => l.align === 'end');
    expect(column.map((l) => l.text)).toContain('\u2212500');
    expect(new Set(column.map((l) => l.x))).toEqual(new Set([22 + 7 * 4]));
    // the x ticks start right of the column
    expect(
      Math.min(
        ...planeLabels(wide, true, null)
          .filter((l) => l.align === 'center')
          .map((l) => l.x),
      ),
    ).toBeGreaterThan(62);
    const kinds = (w: number, h: number) =>
      planeLabels(planeView(camera(0, 0, 1.1, 2), { kind: 'plane', plane: 'xy' }, w, h), true, ['x', 'y'])
        .filter((l) => l.kind === 'title')
        .map((l) => l.text);
    expect([kinds(880, 160), kinds(880, 159), kinds(159, 440), kinds(150, 150)]).toEqual([['x', 'y'], ['y'], ['x'], []]);
    expect(planeLabels(planeView(camera(0, 0, 1.1, 2), { kind: 'plane', plane: 'xy' }, 880, 150), true, ['x', 'y']).some((l) => l.kind === 'tick')).toBe(true);
  });
});

/**
 * A panel of 400 by 400 CSS pixels under `camera` that draws one track from (0, 0, 0) to (10, 1, 1), the axes, and a
 * body labeled Moon, planned and fitted without WebGL. The Moon is placed at `place(p)` once the camera is fitted.
 */
function moonPanel(camera: Camera, place: (p: any) => [number, number, number]) {
  const scene = baseScene({ version: '0.3', bodies: { moon: { frame: 'a', position: [0, 0, 0], label: 'Moon' } } });
  scene.views.main!.camera = camera;
  scene.views.main!.layers.push({ kind: 'axes' }, { kind: 'body', body: 'moon' });
  const data = new MemoryStore()
    .add('off', [0, 2], 'uint32')
    .add('pos', [
      [0, 0, 0],
      [10, 1, 1],
    ])
    .add('time', [0, 1]);
  const geometry = new GeometryCache(scene, data);
  const ctx = { scene, geometry, shared: new Shared(), theme: sceneTheme(scene), disc: new THREE.Texture() };
  const stage = Object.assign(Object.create(StageRenderer.prototype), { ctx, panels: new Map(), lastState: null });
  const p = stage.panel('p1');
  p.rect = { x: 0, y: 0, w: 400, h: 400 };
  stage.replan(p, scene.initial);
  stage.fit(p);
  stage.follow(p);
  scene.bodies!.moon!.position = place(p);
  stage.advance(p, scene.initial, 0);
  // outside a render, the matrix that projects a label is updated by hand
  p.camera.updateMatrixWorld();
  const shown = () =>
    stage
      .labelItems(p)
      .filter((l: { hidden: boolean }) => !l.hidden)
      .map((l: { text: string }) => l.text);
  return { stage, p, shown };
}

describe('an axis title under the label of a body', () => {
  it('is hidden under an orbit camera, where the Moon is at the tip of the x axis, and the other titles are kept', () => {
    const tip = (i: number) => (p: any) => p.draws.get(1).tips[i].toArray();
    expect(moonPanel({ kind: 'orbit' }, tip(0)).shown()).toEqual(['y', 'z', 'Moon']);
    // the label of a Moon at the origin is clear of every title
    expect(moonPanel({ kind: 'orbit' }, () => [0, 0, 0]).shown()).toEqual(['x', 'y', 'z', 'Moon']);
  });
  it('is hidden under a plane camera, where the Moon is on the row of the x title just left of it, and the y title and the ticks are kept', () => {
    // the disc of the Moon is 12 px left of the center of the x title, on its row. its label is set 7 px right of the disc,
    // over the title
    const beside = (p: any): [number, number, number] => {
      const v = p.view;
      const x = planeLabels(v, true, ['x', 'y']).find((l) => l.kind === 'title' && !l.rotate)!;
      return [v.x0 + ((x.x - 12) / v.w) * (v.x1 - v.x0), v.y0 + ((v.h - x.y) / v.h) * (v.y1 - v.y0), 0];
    };
    const { stage, p, shown } = moonPanel({ kind: 'plane', plane: 'xy' }, beside);
    const items = stage.labelItems(p).filter((l: { hidden: boolean }) => !l.hidden);
    expect(items.filter((l: { kind?: string }) => l.kind === 'title').map((l: { text: string }) => l.text)).toEqual(['y']);
    expect(items.some((l: { kind?: string }) => l.kind === 'tick')).toBe(true);
    expect(shown()).toContain('Moon');
    expect(moonPanel({ kind: 'plane', plane: 'xy' }, () => [5, 0.5, 0]).shown()).toEqual(expect.arrayContaining(['x', 'y', 'Moon']));
  });
  it('is shown when the label of the body is hidden, as for a body just below the bottom edge', () => {
    // the label of the Moon is centered 1 px below the edge, outside the panel, and its box is 1.5 px deep into the box of
    // the x title
    const below = (p: any): [number, number, number] => {
      const v = p.view;
      const x = planeLabels(v, true, ['x', 'y']).find((l) => l.kind === 'title' && !l.rotate)!;
      return [v.x0 + ((x.x - 12) / v.w) * (v.x1 - v.x0), v.y0 - (1 / v.h) * (v.y1 - v.y0), 0];
    };
    expect(moonPanel({ kind: 'plane', plane: 'xy' }, below).shown()).toEqual(expect.arrayContaining(['x', 'y']));
    expect(moonPanel({ kind: 'plane', plane: 'xy' }, below).shown()).not.toContain('Moon');
  });
  it('is found from boxes estimated from the text at 12 px, or 13 px for a title, turned with a rotated label', () => {
    expect(labelBox({ text: 'Moon', x: 100, y: 50 })).toEqual([100, 44, 128, 56]);
    expect(labelBox({ text: 'Moon', x: 100, y: 50, align: 'end' })).toEqual([72, 44, 100, 56]);
    // a title of one letter is 7 * 13 / 12 px long, and the rotated y title is set upward, centered on its point
    const along = (7 * 13) / 12;
    const near = (b: number[]) => b.map((v) => expect.closeTo(v, 12));
    expect(labelBox({ text: 'x', x: 200, y: 390, align: 'center', kind: 'title' })).toEqual(near([200 - along / 2, 383.5, 200 + along / 2, 396.5]));
    expect(labelBox({ text: 'y', x: 10, y: 200, align: 'center', rotate: true, kind: 'title' })).toEqual(near([3.5, 200 - along / 2, 16.5, 200 + along / 2]));
    expect(labelBox({ text: 'y', x: 10, y: 200, rotate: true })).toEqual([4, 193, 16, 200]);
    // two rows of text at 12 px are not overlapping when 12 px apart, and are overlapping when 11 px apart
    expect(labelsOverlap({ text: 'Moon', x: 100, y: 50 }, { text: 'x', x: 110, y: 62 })).toBe(false);
    expect(labelsOverlap({ text: 'Moon', x: 100, y: 50 }, { text: 'x', x: 110, y: 61 })).toBe(true);
    expect(labelsOverlap({ text: 'Moon', x: 100, y: 50 }, { text: 'x', x: 128, y: 50 })).toBe(false);
  });
});

describe('the laps of a reveal-none layer (C6)', () => {
  it('draw a pass each, where the laps coincide as where they do not, as the evaluator draws every lap', () => {
    const c = loadCorpus('laps');
    const geometry = new GeometryCache(c.scene, c.data);
    const ctx = { scene: c.scene, geometry, shared: new Shared(), theme: sceneTheme(c.scene), disc: new THREE.Texture() };
    expect([geometry.geometry('loop', 'rot').invariant, geometry.geometry('loop', 'inertial').invariant]).toEqual([true, false]);
    for (const frame of ['rot', 'inertial']) {
      const plan = planPanel(c.scene, geometry, withVariable(c.scene, c.scene.initial, 'frame', frame, 'p1'), 'p1');
      const layer = plan.layers.find((l) => l.kind === 'track' && l.index === 0) as TrackPlan & { set: SetData };
      expect(layer.layer.reveal).toBe('none');
      const draw = new TrackDraw(ctx, layer, plan.display, 'k');
      draw.update(layer, c.scene, 0.4);
      const passes = (draw as unknown as { passes: Map<string, { holder: THREE.Object3D }> }).passes;
      expect(
        [...passes].filter(([, p]) => p.holder.visible).map(([key]) => key),
        frame,
      ).toEqual(['b0', 'b1', 'b2']);
      draw.dispose();
    }
  });
});

describe('the static-layer cache sees every camera change', () => {
  it('reports a pan, a zoom, a change of aspect, and a refit, and does not report anything while the camera stays', () => {
    const cam = new THREE.OrthographicCamera(-2, 2, 1, -1, -10, 10);
    cam.position.set(0, 0, 5);
    cam.updateProjectionMatrix();
    const seen = new Float64Array(32);
    expect(cameraMoved(cam, seen)).toBe(true);
    expect(cameraMoved(cam, seen)).toBe(false);
    cam.position.x += 0.25;
    expect(cameraMoved(cam, seen)).toBe(true);
    expect(cameraMoved(cam, seen)).toBe(false);
    cam.zoom = 1.5;
    cam.updateProjectionMatrix();
    expect(cameraMoved(cam, seen)).toBe(true);
    cam.left = -3;
    cam.updateProjectionMatrix();
    expect(cameraMoved(cam, seen)).toBe(true);
    cam.lookAt(1, 0, 0);
    expect(cameraMoved(cam, seen)).toBe(true);
    expect(cameraMoved(cam, seen)).toBe(false);
  });
});

describe('a track layer in the driver context (L6)', () => {
  const c = loadCorpus('driver-context');
  const geometry = new GeometryCache(c.scene, c.data);
  const ctx = { scene: c.scene, geometry, shared: new Shared(), theme: sceneTheme(c.scene), disc: new THREE.Texture() };
  const grid = (scene: typeof c.scene, st: State) => {
    const plan = planPanel(scene, geometry, st, 'p1');
    const layer = plan.layers.find((l) => l.kind === 'track' && l.index === 0) as TrackPlan & { set: SetData };
    const env = (q: number): LayerEnv => ({
      scope: plan.scope,
      frames: geometry.frames,
      clock: scene.clock,
      channel: st.clock.channel,
      q,
      display: plan.display,
    });
    return { plan, layer, env };
  };
  for (const camera of [{ kind: 'plane', plane: 'xy' }, { kind: 'orbit' }] as Camera[]) {
    it(`is drawn from its own frame by a model matrix where the evaluator draws it, inside the fit, under a ${camera.kind} camera`, () => {
      const scene = structuredClone(c.scene);
      scene.views.v!.camera = camera;
      const own = geometry.geometry('grid', 'pulsating').positions;
      for (const frame of ['pulsating', 'rotating', 'inertial', 'inertial-m1']) {
        const st = withVariable(scene, scene.initial, 'frame', frame, 'p1');
        const { plan, layer, env } = grid(scene, st);
        expect(layer.context).toBe('driver');
        const draw = new TrackDraw(ctx, layer, plan.display, 'k');
        expect(draw.isStatic).toBe(false);
        const box = fitBox(plan, geometry)!;
        for (let i = 0; i <= scene.clock.steps; i++) {
          const q = progress(scene.clock.steps, i);
          draw.update(layer, scene, q);
          draw.place(env(q), plan.driver);
          expect(draw.group.visible).toBe(true);
          const want = (evaluate(scene, c.data, st, i).panels.p1!.layers[0] as TrackLayerResult).members.flatMap((m) => m.line);
          expect(want.length).toBe(own.length / 3);
          want.forEach((w, j) => {
            const p = new THREE.Vector3(own[3 * j]!, own[3 * j + 1]!, own[3 * j + 2]!).applyMatrix4(draw.group.matrix);
            [p.x, p.y, p.z].forEach((x, k) => {
              expect(x).toBeCloseTo(w[k]!, 12);
              expect(box[k]! - 1e-12 <= x && x <= box[k + 3]! + 1e-12, `${frame} frame ${i} vertex ${j}`).toBe(true);
            });
          });
        }
        draw.dispose();
      }
    });
  }
  it("is placed by the driver's clock of the geometry cache, not by a clock built on every frame", () => {
    const st = c.scene.initial;
    const { plan, layer, env } = grid(c.scene, st);
    const cached = geometry.readings(plan.driver!.set.id, st.clock.channel).clocks[plan.driver!.track]!;
    const reading = vi.spyOn(cached, 'reading');
    const draw = new TrackDraw(ctx, layer, plan.display, 'k');
    for (let i = 0; i <= c.scene.clock.steps; i++) draw.place(env(progress(c.scene.clock.steps, i)), plan.driver);
    expect(reading).toHaveBeenCalledTimes(c.scene.clock.steps + 1);
    reading.mockRestore();
    draw.dispose();
  });
  it('is fitted by the corners of its box when the budget is passed, and only when it has more than 8 points', () => {
    // the grid has 8 points and the ring 5, hence a budget of 0 leaves the fit by their points
    const plan = planPanel(c.scene, geometry, c.scene.initial, 'p1');
    expect(fitBox(plan, geometry, 0)).toEqual(fitBox(plan, geometry));
    // a circle of 12 points turned by the driver's time is fitted by the corners of its box, whose images reach past the circle
    const circle = Array.from({ length: 12 }, (_, k) => [Math.cos((k * Math.PI) / 6), Math.sin((k * Math.PI) / 6)]);
    const scene = baseScene({ frames: { a: {}, b: { parent: 'a', rotation: { axis: 'z', angle: { channel: 'time' } } } } });
    scene.track_sets.u = { frame: 'a', tracks: 1, offsets: 'uoff', positions: 'upos' };
    scene.views.main!.frame = 'b';
    scene.views.main!.layers = [{ kind: 'track', sets: { set: 'u' }, members: 'all', context: 'driver' }];
    const data = new MemoryStore()
      .add('off', [0, 2], 'uint32')
      .add('pos', [
        [1, 0],
        [0, 1],
      ])
      .add('time', [0, 1])
      .add('uoff', [0, 12], 'uint32')
      .add('upos', circle);
    const g = new GeometryCache(scene, data);
    const own = planPanel(scene, g, scene.initial, 'p1');
    const exact = fitBox(own, g)!;
    const corners = fitBox(own, g, 0)!;
    for (let k = 0; k < 3; k++) expect(corners[k]! <= exact[k]! && exact[k + 3]! <= corners[k + 3]!).toBe(true);
    expect(corners[3]!).toBeCloseTo(Math.cos(1) + Math.sin(1), 12);
    expect(exact[3]!).toBeCloseTo(1, 12);
  });
  it('is hidden, and is left out of the fit, when the driver does not match a set', () => {
    const st = withVariable(c.scene, c.scene.initial, 'family', 'b');
    const { plan, layer, env } = grid(c.scene, st);
    expect(plan.driver).toBeNull();
    const draw = new TrackDraw(ctx, layer, plan.display, 'k');
    draw.update(layer, c.scene, 0.5);
    draw.place(env(0.5), plan.driver);
    expect(draw.group.visible).toBe(false);
    const box = fitBox(plan, geometry)!;
    const orbit = geometry.geometry('orbit', plan.display);
    expect(box).toEqual(orbit.bounds());
    draw.dispose();
  });
});
