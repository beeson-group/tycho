// Tests the runtime's static buffers and reveal logic against the evaluator, over the conformance corpus.
import { describe, expect, it } from 'vitest';
import { TychoError } from '../src/errors';
import { bound, clockRevolutions, revolutionOf, layerClock, progress } from '../src/evaluate/clock';
import { evaluate } from '../src/evaluate/index';
import { arrowLayer, bodyLayer, hasHead, layerEnv, point, type LayerEnv } from '../src/evaluate/layers';
import { referenceMember, layerVisible, oneSet, type PanelScope } from '../src/evaluate/resolve';
import type { ArrowLayerResult, BodyLayerResult, TrajectoriesLayerResult, Vec3 } from '../src/evaluate/types';
import {
  channelAtReading,
  GeometryCache,
  needsReading,
  pairReadings,
  revealSpec,
  revealTrajectory,
  segmentShown,
  trailCapacity,
  type Reveal,
  type TrajectoryGeometry,
} from '../src/runtime/geometry';
import { referenceMatrix, planPanel } from '../src/runtime/renderer';
import type { Layer, Scene, State, TrajectoriesLayer } from '../src/scene';
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

describe('trajectory geometry, revolution after revolution, is the reveal-none line of the evaluator (sample-context, revolutions)', () => {
  for (const name of names) {
    it(`${name}: every trajectory set in every display frame it can be drawn in`, () => {
      const c = loadCorpus(name);
      const geo = new GeometryCache(c.scene, c.data);
      const clockChannels = c.scene.clock.channels.filter((ch) => ch !== '@index');
      const carries = (id: string) => clockChannels.every((ch) => Object.hasOwn(c.scene.trajectory_sets[id]!.channels ?? {}, ch));
      // a reference trajectory of several revolutions belongs to a periodic trajectory set (rule `revolutions`)
      const ids = Object.keys(c.scene.trajectory_sets).sort(
        (a, b) => Number(c.scene.trajectory_sets[b]!.periodic === true) - Number(c.scene.trajectory_sets[a]!.periodic === true),
      );
      const reference = ids.find(carries)!;
      let compared = 0;
      for (const setId of Object.keys(c.scene.trajectory_sets)) {
        for (const frame of Object.keys(c.scene.frames)) {
          const scene = structuredClone(c.scene);
          scene.panels = {
            probe: {
              frame,
              reference: { sets: { set: reference }, member: { index: 0 } },
              layers: [{ kind: 'trajectories', sets: { set: setId }, members: 'all' }],
            },
          };
          const state: State = {
            inputs: {},
            clock: { channel: c.scene.clock.channels[0] },
            panels: { p: { panel: 'probe' } },
            layout: { kind: 'panel', id: 'p' },
          };
          const result = evaluateOrSkip(scene, c, state, 0, ['transform-channels', 'origin']);
          if (result === null) continue;
          const g = geo.geometry(setId, frame);
          for (const m of (result.panels.p!.layers[0] as TrajectoriesLayerResult).members) {
            const s = g.set.start(m.index);
            const n = g.set.count(m.index);
            // every revolution without its closing sample, which is also the first sample of the next revolution, and the top revolution whole
            const revolutions: number[] = [];
            for (let j = 0; j <= g.top; j++) revolutions.push(...g.revolutionPositions(j).subarray(3 * s, 3 * (s + (j < g.top ? n - 1 : n))));
            expect(revolutions).toEqual(m.line.flat());
            expect(m.line.length).toBe(g.revolutions * (n - 1) + 1);
          }
          compared++;
        }
      }
      expect(compared).toBeGreaterThan(0);
    });
  }
});

/**
 * Every segment the runtime draws for one trajectory, i.e. the pieces computed on the CPU and the
 * segments stored on the GPU. The segments are simulated pass by pass over every revolution a trail can reach, and each pass is
 * checked to lie within the passes of the reveal.
 */
function drawn(g: TrajectoryGeometry, t: number, rev: Reveal, u: ArrayLike<number>): Vec3[][] {
  const out: Vec3[][] = [];
  if (rev.hidden) return out;
  const at = (v: Parameters<TrajectoryGeometry['vertex']>[1]): Vec3 => {
    const p: Vec3 = [0, 0, 0];
    g.vertex(t, v, p);
    return p;
  };
  for (const [a, b] of rev.pieces) out.push([at(a), at(b)]);
  const s = g.set.start(t);
  const gpu = (revolution: number, i: number): Vec3 => {
    const p: Vec3 = [0, 0, 0];
    g.gpuSample(t, revolution, i, p);
    return p;
  };
  for (let revolution = -g.revolutions - 1; revolution <= g.top; revolution++) {
    for (let i = 0; i + 1 < g.set.count(t); i++) {
      if (!segmentShown(rev.range, revolution, u[s + i]!, u[s + i + 1]!)) continue;
      expect(
        rev.revolutions !== null && rev.revolutions[0] <= revolution && revolution <= rev.revolutions[1],
        `a segment of revolution ${revolution} outside the passes ${JSON.stringify(rev.revolutions)}`,
      ).toBe(true);
      out.push([gpu(revolution, i), gpu(revolution, i + 1)]);
    }
  }
  return out;
}

const key = (segments: Vec3[][]): string[] => segments.map((s) => JSON.stringify(s)).sort();

/** A point of a layer's own frame in the display frame, by the model matrix of a layer in the reference trajectory's context (rule `read-from`). */
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
function float32Readings(g: TrajectoryGeometry, u: Float64Array): Float32Array {
  const pairs = pairReadings(g.set, u);
  const out = new Float32Array(g.set.samples);
  let j = 0;
  for (let t = 0; t < g.set.trajectories; t++) {
    const s = g.set.start(t);
    for (let i = 0; i + 1 < g.set.count(t); i++, j++) {
      out[s + i] = pairs[4 * j]!;
      out[s + i + 1] = pairs[4 * j + 1]!;
    }
  }
  return out;
}

const VARIANTS: Partial<TrajectoriesLayer>[] = [
  {},
  { reveal: 'none', head: true },
  { reveal: 'grow', head: true },
  { reveal: 'trail', trail: { fraction: 0.3 }, head: true },
  { reveal: 'trail', trail: { fraction: 1 } },
  { reveal: 'trail', trail: { fraction: 0.07 } },
  { reveal: 'grow', before: 'hidden', after: 'hidden', head: true },
  { reveal: 'trail', trail: { fraction: 0.5 }, before: 'clamp', after: 'hidden' },
];

const seen = { wraps: 0, hidden: 0, pieces: 0, revolutions: 0, deep: 0, reference: 0 };

/** With several revolutions, a reading is taken only on a periodic trajectory set (rule `revolutions`), hence the variants go only to the layers of periodic trajectory sets. */
const takesVariant = (scene: Scene, l: Layer): boolean =>
  l.kind === 'trajectories' && ((scene.clock.revolutions ?? 1) === 1 || ('set' in l.sets && scene.trajectory_sets[l.sets.set]?.periodic === true));

describe('reveal, pieces, and the GPU comparison give the evaluator line (before-after, polyline to head)', () => {
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
            for (const view of Object.values(scene.panels))
              view!.layers = view!.layers.map((l) => (takesVariant(scene, l) ? ({ ...l, ...variant } as Layer) : l));
            for (let i = 0; i < Math.min(scene.clock.frame_count, 70); i++) {
              const result = evaluateOrSkip(scene, c, state, i, ['clock-channel-carried', 'revolutions']);
              if (result === null) break;
              const q = progress(scene.clock.frame_count, i);
              for (const [pid, panel] of Object.entries(state.panels)) {
                const scope: PanelScope = { scene, state, panel: panel! };
                const defs = scene.panels[panel!.panel]!.layers.filter((l) => layerVisible(scope, l));
                const res = result.panels[pid]!;
                const plan = planPanel(scene, geo, state, pid);
                const env: LayerEnv = { scope, frames: geo.frames, clock: scene.clock, channel: state.clock.channel, q, display: res.frame };
                defs.forEach((def, li) => {
                  // the renderer draws an arrow layer from the clocks that the geometry cache keeps for its set (rule `arrow`)
                  if (def.kind === 'arrow') {
                    const r = res.layers[li] as ArrowLayerResult;
                    if (r.set === null) return;
                    const lenv = layerEnv(env, def);
                    const clocks = geo.readings(r.set, lenv.channel).clocks;
                    expect(arrowLayer(lenv, def, geo.sets.get(r.set), (t) => clocks[t]!)).toEqual(r);
                    compared += r.members.length;
                    return;
                  }
                  const r = res.layers[li] as TrajectoriesLayerResult;
                  if (def.kind !== 'trajectories' || r.set === null) return;
                  // a layer in the reference trajectory's context is drawn from its own frame by a model matrix, and is hidden without a reference trajectory (rule `read-from`)
                  const own = def.read_from === 'reference' ? scene.trajectory_sets[r.set]!.frame : null;
                  if (own !== null && plan.reference === null) {
                    for (const m of r.members) expect([m.line, m.head ?? null]).toEqual([[], null]);
                    return;
                  }
                  const model = own === null ? null : referenceMatrix(env, own, plan.reference!);
                  const g = geo.geometry(r.set, own ?? res.frame);
                  // a layer with a clock of its own reads its channel on its clock (rule `layer-clock`)
                  const lclock = def.clock === undefined ? scene.clock : layerClock(scene.clock, def.clock);
                  const lchannel = def.clock === undefined ? state.clock.channel : lclock.channels[0]!;
                  const reads = needsReading(def, lclock) ? geo.readings(r.set, lchannel) : null;
                  const u = reads ?? geo.readings(r.set, '@index');
                  const gpuU = rounding === 'float32' ? float32Readings(g, u.u) : u.u;
                  for (const m of r.members) {
                    const rev = revealTrajectory(reads?.clocks[m.index] ?? null, lclock, q, revealSpec(def, g.set.periodic, clockRevolutions(lclock)), round);
                    if (rev.revolutions !== null && rev.revolutions[0] < 0) seen.wraps++;
                    if (rev.revolutions !== null && rev.revolutions[0] < rev.revolutions[1] && g.revolutions > 1) seen.revolutions++;
                    if (rev.revolutions !== null && rev.revolutions[0] < -1) seen.deep++;
                    if (rev.hidden) seen.hidden++;
                    seen.pieces += rev.pieces.length;
                    const want = m.line.slice(1).map((p, j) => [m.line[j]!, p]);
                    const where = `${pid} layer ${li} member ${m.index} frame ${i}`;
                    if (model === null) expect(key(drawn(g, m.index, rev, gpuU)), where).toEqual(key(want));
                    else {
                      const segments = drawn(g, m.index, rev, gpuU).map((s) => s.map((p) => apply(model, p)));
                      expect(sameSegments(segments, want), where).toBe(true);
                      seen.reference++;
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

describe('body trails from the per-revolution table are the evaluator trail (body-layer, revolutions)', () => {
  const FRACTIONS = [undefined, 1, 0.3, 0.07];
  for (const name of names) {
    it(`${name}: every body layer, at integer frames and between them`, () => {
      const c = loadCorpus(name);
      const geo = new GeometryCache(c.scene, c.data);
      const states = [...new Map(c.cases.map((k) => [JSON.stringify(k.state), k.state])).values()];
      if (states.length === 0) states.push(c.scene.initial);
      let compared = 0;
      let revolutions = 0;
      for (const state of states) {
        for (const fraction of FRACTIONS) {
          const scene = structuredClone(c.scene);
          for (const view of Object.values(scene.panels)) {
            view!.layers = view!.layers.map((l) => (l.kind === 'body' && fraction !== undefined ? ({ ...l, trail: { fraction } } as Layer) : l));
          }
          const n = clockRevolutions(scene.clock);
          for (let i = 0; i < Math.min(scene.clock.frame_count, 50); i++) {
            const result = evaluateOrSkip(scene, c, state, i, ['clock-channel-carried', 'revolutions']);
            if (result === null) break;
            for (const half of [0, 0.5]) {
              const q = progress(scene.clock.frame_count, i) + half / scene.clock.frame_count;
              for (const [pid, panel] of Object.entries(state.panels)) {
                const scope: PanelScope = { scene, state, panel: panel! };
                const view = scene.panels[panel!.panel]!;
                const defs = view.layers.filter((l) => layerVisible(scope, l));
                const res = result.panels[pid]!;
                const referenceId = oneSet(scope, view.reference.sets);
                const reference = referenceId === null ? null : { set: geo.sets.get(referenceId), trajectory: 0 };
                if (reference) reference.trajectory = referenceMember(scope, view.reference.member, reference.set);
                const env: LayerEnv = { scope, frames: geo.frames, clock: scene.clock, channel: state.clock.channel, q, display: res.frame };
                defs.forEach((def, li) => {
                  if (def.kind !== 'body' || reference === null) return;
                  const want = half === 0 ? (res.layers[li] as BodyLayerResult) : bodyLayer(env, def, reference);
                  const table = geo.bodyTrail(def.body, res.frame, reference.set.id, reference.trajectory);
                  const tc = geo.readings(reference.set.id, state.clock.channel).clocks[reference.trajectory]!;
                  const loopReading = n * bound(tc.reading(scene.clock, q))!;
                  const at = revolutionOf(loopReading, n);
                  const got: Vec3 = [0, 0, 0];
                  table.vertex(point(tc, at.u, false, at.revolution), got);
                  expect(got, `${pid} layer ${li} frame ${i}+${half}`).toEqual(want.position);
                  if (def.trail !== undefined) {
                    let tail = loopReading - n * def.trail.fraction;
                    if (tail < 0 && !reference.set.periodic) tail = 0;
                    const out = new Float32Array(3 * trailCapacity(table.m, n, def.trail.fraction));
                    const count = table.polyline(tc, tail, loopReading, n, out);
                    const trail = want.trail!;
                    expect(count, `${pid} layer ${li} frame ${i}+${half}`).toBe(trail.length);
                    const expected = Float32Array.from(trail.flat());
                    expect(Array.from(out.subarray(0, 3 * count))).toEqual(Array.from(expected));
                    if (revolutionOf(tail, n).revolution < at.revolution) revolutions++;
                  }
                  compared++;
                });
              }
            }
          }
        }
      }
      // a trail crosses a revolution joint only on a periodic trajectory set under a clock in fraction mode with revolutions
      if (compared > 0 && clockRevolutions(c.scene.clock) > 1) expect(revolutions).toBeGreaterThan(0);
    });
  }
  it('shares one revolution when neither the body nor the frame reads a channel, and stores each revolution otherwise', () => {
    const c = loadCorpus('revolutions');
    const geo = new GeometryCache(c.scene, c.data);
    const body = Object.keys(c.scene.bodies ?? {})[0];
    if (body === undefined) return;
    for (const frame of Object.keys(c.scene.frames)) {
      const table = geo.bodyTrail(body, frame, Object.keys(c.scene.trajectory_sets)[0]!, 0);
      const shared = table.revolution(0) === table.revolution(2);
      expect(shared).toBe(table.invariant);
      expect(table.invariant).toBe(geo.frames.bodyRequirements(body, frame).channels.size === 0);
    }
  });
});

describe('the corpus sweep above', () => {
  it('met periodic wraps, trails across revolution joints and below revolution -1, hidden trajectories, end pieces, and layers in the reference trajectory context', () => {
    expect(seen.reference).toBeGreaterThan(0);
    expect(seen.wraps).toBeGreaterThan(0);
    expect(seen.revolutions).toBeGreaterThan(0);
    expect(seen.deep).toBeGreaterThan(0);
    expect(seen.hidden).toBeGreaterThan(0);
    expect(seen.pieces).toBeGreaterThan(0);
  });
});

describe('revolutions on demand (revolutions)', () => {
  it('shares one revolution of positions across every revolution when the edges do not read a channel, and keeps each revolution apart otherwise', () => {
    const c = loadCorpus('revolutions');
    const geo = new GeometryCache(c.scene, c.data);
    const rot = geo.geometry('loop', 'rot');
    const inertial = geo.geometry('loop', 'inertial');
    expect([rot.revolutions, rot.top, rot.invariant, inertial.invariant]).toEqual([3, 2, true, false]);
    expect([-1, 0, 1, 2].map((j) => rot.revolutionKey(j))).toEqual(['joined', 'joined', 'joined', 'top']);
    expect([-1, 0, 1, 2].map((j) => inertial.revolutionKey(j))).toEqual(['-1', '0', '1', '2']);
    // a trajectory set that is not periodic has one revolution, whatever the revolutions of the clock
    expect(geo.geometry('fan', 'inertial').revolutions).toBe(1);
    expect(rot.revolutionPositions(2)).toBe(rot.revolutionPositions(0));
    expect(inertial.revolutionPositions(2)).not.toEqual(inertial.revolutionPositions(0));
  });
  it("a readout reads the reference trajectory's channel in the reference trajectory's revolution", () => {
    const c = loadCorpus('revolutions');
    const geo = new GeometryCache(c.scene, c.data);
    const set = geo.sets.get('loop');
    const tc = geo.readings('loop', '@index').clocks[0]!;
    const a = set.channel('a');
    const m = set.count(0);
    for (const index of [0, 5, 8, 13, 19, 23]) {
      const q = index / c.scene.clock.frame_count;
      const U = 3 * q;
      const revolution = Math.min(Math.floor(U), 2);
      const { k, w } = tc.locate(U - revolution);
      const raise = revolution * (a[m - 1]! - a[0]!);
      expect(channelAtReading(set, tc, 0, 'a', c.scene.clock, q)).toBeCloseTo((1 - w) * (a[k]! + raise) + w * (a[k + 1]! + raise), 12);
    }
  });
});
