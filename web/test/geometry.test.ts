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
import type { Layer, Scene, State, TrackLayer } from '../src/scene';
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
                defs.forEach((def, li) => {
                  const r = res.layers[li] as TrackLayerResult;
                  if (def.kind !== 'track' || r.set === null) return;
                  const g = geo.geometry(r.set, res.frame);
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
                    expect(key(drawn(g, m.index, rev, gpuU)), `${pid} layer ${li} member ${m.index} frame ${i}`).toEqual(key(want));
                    if (hasHead(def)) {
                      const head = rev.head === null ? null : ([0, 0, 0] as Vec3);
                      if (head !== null) g.vertex(m.index, rev.head!, head);
                      expect(head).toEqual(m.head);
                    }
                    compared++;
                  }
                });
              }
            }
          }
        }
        expect(compared).toBeGreaterThan(0);
      });
    }
  }
});
