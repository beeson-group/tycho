// Tests the runtime's static buffers and reveal logic against the evaluator, over the conformance corpus.
import { describe, expect, it } from 'vitest';
import { TychoError } from '../src/errors';
import { bound, clockLaps, lapOf, progress } from '../src/evaluate/clock';
import { evaluate } from '../src/evaluate/index';
import { bodyLayer, hasHead, point, type LayerEnv } from '../src/evaluate/layers';
import { driverMember, layerVisible, oneSet, type PanelScope } from '../src/evaluate/resolve';
import type { BodyLayerResult, TrackLayerResult, Vec3 } from '../src/evaluate/types';
import {
  channelAtReading,
  GeometryCache,
  needsReading,
  pairReadings,
  revealSpec,
  revealTrack,
  segmentShown,
  trailCapacity,
  type Reveal,
  type TrackGeometry,
} from '../src/runtime/geometry';
import { driverMatrix, planPanel } from '../src/runtime/renderer';
import type { Layer, Scene, State, TrackLayer } from '../src/scene';
import type * as THREE from 'three';
import { corpusNames, loadCorpus } from './corpus';

const names = corpusNames();

const evaluateOrSkip = (scene: Scene, c: ReturnType<typeof loadCorpus>, state: State, i: number, skip: string[]) => {
  try {
    return evaluate(scene, c.data, state, i);
  } catch (e) {
    if (e instanceof TychoError && skip.includes(e.rule)) return null;
    throw e;
  }
};

describe('track geometry, lap after lap, is the reveal-none line of the evaluator (F4, C6)', () => {
  for (const name of names) {
    it(`${name}: every track set in every display frame it can be drawn in`, () => {
      const c = loadCorpus(name);
      const geo = new GeometryCache(c.scene, c.data);
      const clockChannels = c.scene.clock.channels.filter((ch) => ch !== '@index');
      const carries = (id: string) => clockChannels.every((ch) => Object.hasOwn(c.scene.track_sets[id]!.channels ?? {}, ch));
      // a driver of several laps belongs to a periodic track set (rule C6)
      const ids = Object.keys(c.scene.track_sets).sort(
        (a, b) => Number(c.scene.track_sets[b]!.periodic === true) - Number(c.scene.track_sets[a]!.periodic === true),
      );
      const driver = ids.find(carries)!;
      let compared = 0;
      for (const setId of Object.keys(c.scene.track_sets)) {
        for (const frame of Object.keys(c.scene.frames)) {
          const scene = structuredClone(c.scene);
          scene.views = {
            probe: { frame, driver: { sets: { set: driver }, member: { index: 0 } }, layers: [{ kind: 'track', sets: { set: setId }, members: 'all' }] },
          };
          const state: State = {
            variables: {},
            clock: { channel: c.scene.clock.channels[0] },
            panels: { p: { view: 'probe' } },
            layout: { kind: 'panel', id: 'p' },
          };
          const result = evaluateOrSkip(scene, c, state, 0, ['F5', 'F2']);
          if (result === null) continue;
          const g = geo.geometry(setId, frame);
          for (const m of (result.panels.p!.layers[0] as TrackLayerResult).members) {
            const s = g.set.start(m.index);
            const n = g.set.count(m.index);
            // every lap without its closing sample, which is also the first sample of the next lap, and the top lap whole
            const laps: number[] = [];
            for (let j = 0; j <= g.top; j++) laps.push(...g.lapPositions(j).subarray(3 * s, 3 * (s + (j < g.top ? n - 1 : n))));
            expect(laps).toEqual(m.line.flat());
            expect(m.line.length).toBe(g.laps * (n - 1) + 1);
          }
          compared++;
        }
      }
      expect(compared).toBeGreaterThan(0);
    });
  }
});

/**
 * Every segment the runtime draws for one track, i.e. the pieces computed on the CPU and the
 * segments stored on the GPU. The segments are simulated pass by pass over every lap a trail can reach, and each pass is
 * checked to lie within the passes of the reveal.
 */
function drawn(g: TrackGeometry, t: number, rev: Reveal, u: ArrayLike<number>): Vec3[][] {
  const out: Vec3[][] = [];
  if (rev.hidden) return out;
  const at = (v: Parameters<TrackGeometry['vertex']>[1]): Vec3 => {
    const p: Vec3 = [0, 0, 0];
    g.vertex(t, v, p);
    return p;
  };
  for (const [a, b] of rev.pieces) out.push([at(a), at(b)]);
  const s = g.set.start(t);
  const gpu = (lap: number, i: number): Vec3 => {
    const p: Vec3 = [0, 0, 0];
    g.gpuSample(t, lap, i, p);
    return p;
  };
  for (let lap = -g.laps - 1; lap <= g.top; lap++) {
    for (let i = 0; i + 1 < g.set.count(t); i++) {
      if (!segmentShown(rev.range, lap, u[s + i]!, u[s + i + 1]!)) continue;
      expect(rev.laps !== null && rev.laps[0] <= lap && lap <= rev.laps[1], `a segment of lap ${lap} outside the passes ${JSON.stringify(rev.laps)}`).toBe(
        true,
      );
      out.push([gpu(lap, i), gpu(lap, i + 1)]);
    }
  }
  return out;
}

const key = (segments: Vec3[][]): string[] => segments.map((s) => JSON.stringify(s)).sort();

/** A point of a layer's own frame in the display frame, by the model matrix of a layer in the driver's context (rule L6). */
const apply = (m: THREE.Matrix4, p: Vec3): Vec3 => {
  const e = m.elements;
  return [0, 1, 2].map((r) => e[r]! * p[0] + e[4 + r]! * p[1] + e[8 + r]! * p[2] + e[12 + r]!) as Vec3;
};

/** Whether the segments match the wanted ones one to one, each point within the tolerance, in any order. */
function sameSegments(segments: Vec3[][], want: Vec3[][], tol = 1e-12): boolean {
  if (segments.length !== want.length) return false;
  const free = want.map(() => true);
  const near = (a: Vec3[], b: Vec3[]) => a.every((p, i) => p.every((x, c) => Math.abs(x - b[i]![c]!) <= tol));
  return segments.every((s) => {
    const j = want.findIndex((w, i) => free[i] && near(s, w));
    if (j >= 0) free[j] = false;
    return j >= 0;
  });
}

/** Readings as the GPU stores them, one per sample, read back from the pair layout. */
function float32Readings(g: TrackGeometry, u: Float64Array): Float32Array {
  const pairs = pairReadings(g.set, u);
  const out = new Float32Array(g.set.samples);
  let j = 0;
  for (let t = 0; t < g.set.tracks; t++) {
    const s = g.set.start(t);
    for (let i = 0; i + 1 < g.set.count(t); i++, j++) {
      out[s + i] = pairs[4 * j]!;
      out[s + i + 1] = pairs[4 * j + 1]!;
    }
  }
  return out;
}

const VARIANTS: Partial<TrackLayer>[] = [
  {},
  { reveal: 'none', head: true },
  { reveal: 'grow', head: true },
  { reveal: 'trail', trail: { fraction: 0.3 }, head: true },
  { reveal: 'trail', trail: { fraction: 1 } },
  { reveal: 'trail', trail: { fraction: 0.07 } },
  { reveal: 'grow', before: 'hidden', after: 'hidden', head: true },
  { reveal: 'trail', trail: { fraction: 0.5 }, before: 'clamp', after: 'hidden' },
];

const seen = { wraps: 0, hidden: 0, pieces: 0, laps: 0, deep: 0 };

/** With several laps, a reading is taken only on a periodic track set (rule C6), hence the variants go only to the layers of periodic track sets. */
const takesVariant = (scene: Scene, l: Layer): boolean =>
  l.kind === 'track' && ((scene.clock.laps ?? 1) === 1 || ('set' in l.sets && scene.track_sets[l.sets.set]?.periodic === true));

describe('reveal, pieces, and the GPU comparison give the evaluator line (C3, L1 to L3)', () => {
  for (const name of names) {
    for (const rounding of ['float64', 'float32'] as const) {
      it(`${name}, readings in ${rounding}`, () => {
        const c = loadCorpus(name);
        const geo = new GeometryCache(c.scene, c.data);
        const round = rounding === 'float32' ? Math.fround : (x: number) => x;
        const states = [...new Map(c.cases.map((k) => [JSON.stringify(k.state), k.state])).values()];
        if (states.length === 0) states.push(c.scene.initial);
        let compared = 0;
        for (const state of states) {
          for (const variant of VARIANTS) {
            const scene = structuredClone(c.scene);
            for (const view of Object.values(scene.views))
              view!.layers = view!.layers.map((l) => (takesVariant(scene, l) ? ({ ...l, ...variant } as Layer) : l));
            for (let i = 0; i < Math.min(scene.clock.steps, 70); i++) {
              const result = evaluateOrSkip(scene, c, state, i, ['C5', 'C6']);
              if (result === null) break;
              const q = progress(scene.clock.steps, i);
              for (const [pid, panel] of Object.entries(state.panels)) {
                const scope: PanelScope = { scene, state, panel: panel! };
                const defs = scene.views[panel!.view]!.layers.filter((l) => layerVisible(scope, l));
                const res = result.panels[pid]!;
                const plan = planPanel(scene, geo, state, pid);
                const env: LayerEnv = { scope, frames: geo.frames, clock: scene.clock, channel: state.clock.channel, q, display: res.frame };
                defs.forEach((def, li) => {
                  const r = res.layers[li] as TrackLayerResult;
                  if (def.kind !== 'track' || r.set === null) return;
                  // a layer in the driver's context is drawn from its own frame by a model matrix, and is hidden without a driver (rule L6)
                  const own = def.context === 'driver' ? scene.track_sets[r.set]!.frame : null;
                  if (own !== null && plan.driver === null) {
                    for (const m of r.members) expect([m.line, m.head ?? null]).toEqual([[], null]);
                    return;
                  }
                  const model = own === null ? null : driverMatrix(env, own, plan.driver!);
                  const g = geo.geometry(r.set, own ?? res.frame);
                  const reads = needsReading(def, scene.clock) ? geo.readings(r.set, state.clock.channel) : null;
                  const u = reads ?? geo.readings(r.set, '@index');
                  const gpuU = rounding === 'float32' ? float32Readings(g, u.u) : u.u;
                  for (const m of r.members) {
                    const rev = revealTrack(reads?.clocks[m.index] ?? null, scene.clock, q, revealSpec(def, g.set.periodic, clockLaps(scene.clock)), round);
                    if (rev.laps !== null && rev.laps[0] < 0) seen.wraps++;
                    if (rev.laps !== null && rev.laps[0] < rev.laps[1] && g.laps > 1) seen.laps++;
                    if (rev.laps !== null && rev.laps[0] < -1) seen.deep++;
                    if (rev.hidden) seen.hidden++;
                    seen.pieces += rev.pieces.length;
                    const want = m.line.slice(1).map((p, j) => [m.line[j]!, p]);
                    const where = `${pid} layer ${li} member ${m.index} frame ${i}`;
                    if (model === null) expect(key(drawn(g, m.index, rev, gpuU)), where).toEqual(key(want));
                    else {
                      const segments = drawn(g, m.index, rev, gpuU).map((s) => s.map((p) => apply(model, p)));
                      expect(sameSegments(segments, want), where).toBe(true);
                    }
                    if (hasHead(def)) {
                      let head = rev.head === null ? null : ([0, 0, 0] as Vec3);
                      if (head !== null) g.vertex(m.index, rev.head!, head);
                      if (head !== null && model !== null) {
                        head = apply(model, head);
                        expect(sameSegments([[head]], [[m.head!]]), where).toBe(true);
                      } else expect(head).toEqual(m.head);
                    }
                    compared++;
                  }
                });
              }
            }
          }
        }
        expect(compared).toBeGreaterThan(0);
        // broucke-mini takes about 2.5 s on a laptop and over the default 5 s on a CI runner
      }, 60_000);
    }
  }
});

describe('body trails from the per-lap table are the evaluator trail (L4, C6)', () => {
  const FRACTIONS = [undefined, 1, 0.3, 0.07];
  for (const name of names) {
    it(`${name}: every body layer, at integer frames and between them`, () => {
      const c = loadCorpus(name);
      const geo = new GeometryCache(c.scene, c.data);
      const states = [...new Map(c.cases.map((k) => [JSON.stringify(k.state), k.state])).values()];
      if (states.length === 0) states.push(c.scene.initial);
      let compared = 0;
      let laps = 0;
      for (const state of states) {
        for (const fraction of FRACTIONS) {
          const scene = structuredClone(c.scene);
          for (const view of Object.values(scene.views)) {
            view!.layers = view!.layers.map((l) => (l.kind === 'body' && fraction !== undefined ? ({ ...l, trail: { fraction } } as Layer) : l));
          }
          const n = clockLaps(scene.clock);
          for (let i = 0; i < Math.min(scene.clock.steps, 50); i++) {
            const result = evaluateOrSkip(scene, c, state, i, ['C5', 'C6']);
            if (result === null) break;
            for (const half of [0, 0.5]) {
              const q = progress(scene.clock.steps, i) + half / scene.clock.steps;
              for (const [pid, panel] of Object.entries(state.panels)) {
                const scope: PanelScope = { scene, state, panel: panel! };
                const view = scene.views[panel!.view]!;
                const defs = view.layers.filter((l) => layerVisible(scope, l));
                const res = result.panels[pid]!;
                const driverId = oneSet(scope, view.driver.sets);
                const driver = driverId === null ? null : { set: geo.sets.get(driverId), track: 0 };
                if (driver) driver.track = driverMember(scope, view.driver.member, driver.set);
                const env: LayerEnv = { scope, frames: geo.frames, clock: scene.clock, channel: state.clock.channel, q, display: res.frame };
                defs.forEach((def, li) => {
                  if (def.kind !== 'body' || driver === null) return;
                  const want = half === 0 ? (res.layers[li] as BodyLayerResult) : bodyLayer(env, def, driver);
                  const table = geo.bodyTrail(def.body, res.frame, driver.set.id, driver.track);
                  const tc = geo.readings(driver.set.id, state.clock.channel).clocks[driver.track]!;
                  const loopReading = n * bound(tc.reading(scene.clock, q))!;
                  const at = lapOf(loopReading, n);
                  const got: Vec3 = [0, 0, 0];
                  table.vertex(point(tc, at.u, false, at.lap), got);
                  expect(got, `${pid} layer ${li} frame ${i}+${half}`).toEqual(want.position);
                  if (def.trail !== undefined) {
                    let tail = loopReading - n * def.trail.fraction;
                    if (tail < 0 && !driver.set.periodic) tail = 0;
                    const out = new Float32Array(3 * trailCapacity(table.m, n, def.trail.fraction));
                    const count = table.polyline(tc, tail, loopReading, n, out);
                    const trail = want.trail!;
                    expect(count, `${pid} layer ${li} frame ${i}+${half}`).toBe(trail.length);
                    const expected = Float32Array.from(trail.flat());
                    expect(Array.from(out.subarray(0, 3 * count))).toEqual(Array.from(expected));
                    if (lapOf(tail, n).lap < at.lap) laps++;
                  }
                  compared++;
                });
              }
            }
          }
        }
      }
      // a trail crosses a lap joint only on a periodic track set under a clock in fraction mode with laps
      if (compared > 0 && clockLaps(c.scene.clock) > 1) expect(laps).toBeGreaterThan(0);
    });
  }
  it('shares one lap when neither the body nor the frame reads a channel, and stores each lap otherwise', () => {
    const c = loadCorpus('laps');
    const geo = new GeometryCache(c.scene, c.data);
    const body = Object.keys(c.scene.bodies ?? {})[0];
    if (body === undefined) return;
    for (const frame of Object.keys(c.scene.frames)) {
      const table = geo.bodyTrail(body, frame, Object.keys(c.scene.track_sets)[0]!, 0);
      const shared = table.lap(0) === table.lap(2);
      expect(shared).toBe(table.invariant);
      expect(table.invariant).toBe(geo.frames.bodyRequirements(body, frame).channels.size === 0);
    }
  });
});

describe('the corpus sweep above', () => {
  it('met periodic wraps, trails across lap joints and below lap -1, hidden tracks, and end pieces', () => {
    expect(seen.wraps).toBeGreaterThan(0);
    expect(seen.laps).toBeGreaterThan(0);
    expect(seen.deep).toBeGreaterThan(0);
    expect(seen.hidden).toBeGreaterThan(0);
    expect(seen.pieces).toBeGreaterThan(0);
  });
});

describe('laps on demand (C6)', () => {
  it('shares one lap of positions across every lap when the edges do not read a channel, and keeps each lap apart otherwise', () => {
    const c = loadCorpus('laps');
    const geo = new GeometryCache(c.scene, c.data);
    const rot = geo.geometry('loop', 'rot');
    const inertial = geo.geometry('loop', 'inertial');
    expect([rot.laps, rot.top, rot.invariant, inertial.invariant]).toEqual([3, 2, true, false]);
    expect([-1, 0, 1, 2].map((j) => rot.lapKey(j))).toEqual(['joined', 'joined', 'joined', 'top']);
    expect([-1, 0, 1, 2].map((j) => inertial.lapKey(j))).toEqual(['-1', '0', '1', '2']);
    // a track set that is not periodic has one lap, whatever the laps of the clock
    expect(geo.geometry('fan', 'inertial').laps).toBe(1);
    expect(rot.lapPositions(2)).toBe(rot.lapPositions(0));
    expect(inertial.lapPositions(2)).not.toEqual(inertial.lapPositions(0));
  });
  it("a readout reads the driver's channel in the driver's lap", () => {
    const c = loadCorpus('laps');
    const geo = new GeometryCache(c.scene, c.data);
    const set = geo.sets.get('loop');
    const tc = geo.readings('loop', '@index').clocks[0]!;
    const a = set.channel('a');
    const m = set.count(0);
    for (const index of [0, 5, 8, 13, 19, 23]) {
      const q = index / c.scene.clock.steps;
      const U = 3 * q;
      const lap = Math.min(Math.floor(U), 2);
      const { k, w } = tc.locate(U - lap);
      const raise = lap * (a[m - 1]! - a[0]!);
      expect(channelAtReading(set, tc, 0, 'a', c.scene.clock, q)).toBeCloseTo((1 - w) * (a[k]! + raise) + w * (a[k + 1]! + raise), 12);
    }
  });
});
