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
