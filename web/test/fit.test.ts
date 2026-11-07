// Tests the camera fit, the lazy per-track geometry, and the per-track buffers under Node, which do not need WebGL.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { TychoError } from '../src/errors';
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
  orthoFit,
  planeLabels,
  planeView,
  planPanel,
  Shared,
  TrackDraw,
  type TrackPlan,
} from '../src/runtime/renderer';
import { withVariable } from '../src/runtime/state';
import type { State, TrackLayer } from '../src/scene';
import { loadCorpus } from './corpus';

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
