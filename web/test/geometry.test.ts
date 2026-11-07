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
