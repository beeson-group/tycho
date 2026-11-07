import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { generate, OUTPUT_PATH, SCHEMA_PATH } from '../scripts/gen-types.mjs';
import { TychoError } from '../src/errors';
import { evaluate } from '../src/evaluate/index';
import { sparse } from '../src/evaluate/resolve';
import type { TrackLayerResult } from '../src/evaluate/types';
import type { Layer, State, TrackLayer } from '../src/scene';
import { validate } from '../src/validate';
import { baseScene, MemoryStore, state } from './helpers';

const rule = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    if (e instanceof TychoError) return e.rule;
    throw e;
  }
  return 'no error';
};

describe('scene types', () => {
  it('src/scene.gen.ts matches the types generated from the schema', async () => {
    expect(readFileSync(OUTPUT_PATH, 'utf8')).toBe(await generate());
  });
  it('the test fixture scene satisfies the schema', () => {
    const ajv = new Ajv2020({ strict: false });
    const check = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')));
    expect(check(baseScene()), JSON.stringify(check.errors)).toBe(true);
  });
});

describe('validate', () => {
  const data = () =>
    new MemoryStore()
      .add('off', [0, 2], 'uint32')
      .add('pos', [
        [0, 0],
        [1, 0],
      ])
      .add('time', [0, 1]);
  it('the S1 error names an unknown major version and an unimplemented feature together', () => {
    const scene = baseScene({ version: '1.0', requires: ['layers.arrows'] });
    expect(() => validate(scene)).toThrow(/major version 1.*layers\.arrows/);
  });
  it('a drawn track set that lacks a channel on the path is rejected (F5)', () => {
    const scene = baseScene({ frames: { a: {}, b: { parent: 'a', rotation: { axis: 'z', angle: { channel: 'f' } } } } });
    scene.views.main!.frame = 'b';
    expect(rule(() => validate(scene, data(), state()))).toBe('F5');
  });
  it('an origin at a body that lies below the edge of the origin is rejected (F6)', () => {
    const scene = baseScene({ frames: { a: {}, b: { parent: 'a', origin: { body: 'x' } } }, bodies: { x: { frame: 'b', position: [0, 0, 0] } } });
    expect(rule(() => validate(scene))).toBe('F6');
  });
  it('a track of fewer than two samples (T1) and a clock channel that is not strictly monotone (T3) are rejected', () => {
    expect(
      rule(() =>
        validate(
          baseScene(),
          new MemoryStore()
            .add('off', [0, 1], 'uint32')
            .add('pos', [[0, 0]])
            .add('time', [0]),
        ),
      ),
    ).toBe('T1');
    expect(rule(() => validate(baseScene(), data().add('time', [1, 1])))).toBe('T3');
  });
  const second = () => {
    const scene = baseScene();
    scene.track_sets.u = { frame: 'a', tracks: 1, offsets: 'off', positions: 'pos' };
    scene.views.main!.layers = [{ kind: 'track', sets: { set: 'u' }, members: 'all' }];
    return scene;
  };
  it('only a track set on which a reading is taken must carry the clock channels (C5)', () => {
    const scene = second();
    validate(scene, data(), state());
    expect((evaluate(scene, data(), state(), 1).panels.p1!.layers[0] as TrackLayerResult).members[0]!.line.length).toBe(2);
    scene.views.main!.layers = [{ kind: 'track', sets: { set: 'u' }, members: 'all', head: true }];
    expect(rule(() => validate(scene, data(), state()))).toBe('C5');
    scene.views.main!.layers = [];
    scene.views.main!.driver.sets = { set: 'u' };
    expect(rule(() => validate(scene, data(), state()))).toBe('C5');
  });
  it('a track layer in the driver context reads the frame edges on the driver, and still needs the clock channels for a reading (L6, F5, C5)', () => {
    const scene = second();
    scene.frames = { a: {}, b: { parent: 'a', rotation: { axis: 'z', angle: { channel: 'time' } } } };
    scene.views.main!.frame = 'b';
    expect(rule(() => validate(scene, data(), state()))).toBe('F5');
    const layer: TrackLayer = { kind: 'track', sets: { set: 'u' }, members: 'all', context: 'driver' };
    scene.views.main!.layers = [layer];
    validate(scene, data(), state());
    // at frame 1 of 4 the driver reads time = 0.25, between the angles 0 and 1, and the set u does not carry any channel
    const line = (evaluate(scene, data(), state(), 1).panels.p1!.layers[0] as TrackLayerResult).members[0]!.line;
    const want = [0, 0, 0, 0.75 + 0.25 * Math.cos(1), 0.25 * Math.sin(1), 0];
    line.flat().forEach((x, i) => expect(x).toBeCloseTo(want[i]!, 15));
    scene.views.main!.layers = [{ ...layer, head: true }];
    expect(rule(() => validate(scene, data(), state()))).toBe('C5');
    scene.views.main!.layers = [{ ...layer, context: 'sample' } as unknown as Layer];
    expect(rule(() => validate(scene, data(), state()))).toBe('L6');
    expect(rule(() => evaluate(scene, data(), state(), 0))).toBe('L6');
  });
  it('a reader implements the feature layers.driver_context of version 0.3 and rejects any other (S1)', () => {
    validate(baseScene({ version: '0.3', requires: ['layers.driver_context'] }));
    expect(rule(() => validate(baseScene({ version: '0.3', requires: ['layers.arrows'] })))).toBe('S1');
  });
  it('a literal index past the last track and a selector whose parameter the track set lacks are rejected (V3)', () => {
    const scene = second();
    scene.views.main!.layers = [{ kind: 'track', sets: { set: 'u' }, members: { index: 1 } }];
    expect(rule(() => validate(scene, data(), state()))).toBe('V3');
    expect(rule(() => evaluate(scene, data(), state(), 0))).toBe('V3');
    scene.variables = { e: { kind: 'selector', parameter: 'e', default: 0 } };
    scene.views.main!.layers = [{ kind: 'track', sets: { set: 'u' }, members: { var: 'e' } }];
    expect(rule(() => validate(scene, data(), state()))).toBe('V3');
    expect(rule(() => evaluate(scene, data(), state(), 0))).toBe('V3');
  });
  it('a selector without `by: index` is by nearest and needs a parameter (section 2.5)', () => {
    const scene = baseScene({ variables: { e: { kind: 'selector', default: 0 } } });
    expect(rule(() => validate(scene))).toBe('2.5');
  });
  it('a query that needs one track set and matches two is rejected (V2)', () => {
    const scene = second();
    scene.track_sets.s!.tags = { kind: 'x' };
    scene.track_sets.u!.tags = { kind: 'x' };
    scene.views.main!.layers = [{ kind: 'track', sets: { tags: { kind: 'x' } }, members: 'all' }];
    expect(rule(() => evaluate(scene, data(), state(), 0))).toBe('V2');
  });

  it('ids that are Object.prototype member names are unknown, not inherited (S3, 2.8, 2.4, 2.9)', () => {
    const scene = baseScene({ bodies: { b1: { frame: 'a', position: [0, 0, 0] } } });
    const st = state();
    st.variables = { toString: 1 };
    expect(validate(scene, data(), st)).toEqual([]);
    expect(rule(() => validate(scene, data(), state('constructor')))).toBe('2.8');
    scene.views.main!.layers.push({ kind: 'body', body: 'toString' });
    expect(rule(() => validate(scene, data()))).toBe('L4');
    scene.views.main!.layers.pop();
    scene.readouts = [{ place: 'caption', parts: [{ var: 'valueOf' }] }];
    expect(rule(() => validate(scene))).toBe('2.9');
    const proto = JSON.parse('{"clock":{"channel":"time"},"panels":{"__proto__":{"view":"main"}},"layout":{"kind":"panel","id":"__proto__"}}') as State;
    const r = evaluate(baseScene(), data(), proto, 0);
    expect(Object.keys(r.panels)).toEqual(['__proto__']);
  });
  it('nonfinite values and an infinite span break T3, and a noninteger frame index breaks 2.6', () => {
    expect(rule(() => validate(baseScene(), data().add('time', [0, Infinity])))).toBe('T3');
    expect(rule(() => validate(baseScene(), data().add('time', [-1e308, 1e308])))).toBe('T3');
    expect(rule(() => evaluate(baseScene(), data().add('time', [0, Infinity]), state(), 0))).toBe('no error');
    const scene = baseScene();
    scene.views.main!.layers = [{ kind: 'track', sets: { set: 's' }, members: 'all', head: true }];
    expect(rule(() => evaluate(scene, data().add('time', [0, Infinity]), state(), 0))).toBe('T3');
    expect(rule(() => evaluate(baseScene(), data(), state(), 0.5))).toBe('2.6');
    expect(rule(() => evaluate(baseScene(), data(), state(), NaN))).toBe('2.6');
  });
  it('a zero scale, a two-element origin, and an edge field on the root are rejected at load (F2, 2.3)', () => {
    expect(rule(() => validate(baseScene({ frames: { a: {}, b: { parent: 'a', scale: 0 } } })))).toBe('F2');
    expect(rule(() => validate(baseScene({ frames: { a: {}, b: { parent: 'a', scale: { attr: 'k', factor: 0 } } } })))).toBe('F2');
    expect(rule(() => validate(baseScene({ frames: { a: {}, b: { parent: 'a', origin: [1, 2] as unknown as [number, number, number] } } })))).toBe('F2');
    expect(rule(() => validate(baseScene({ frames: { a: { scale: 2 } } })))).toBe('2.3');
    const scene = baseScene({ frames: { a: {}, b: { parent: 'a', scale: { attr: 'k' } } } });
    scene.track_sets.s!.attrs = { k: 0 };
    scene.views.main!.frame = 'b';
    expect(rule(() => validate(scene, data(), state()))).toBe('F2');
  });
  it('a state shows every panel once without repeats and holds values that fit their variables (2.8)', () => {
    const st = state();
    st.layout = { kind: 'split', dir: 'row', ratio: 0.5, a: { kind: 'panel', id: 'p1' }, b: { kind: 'panel', id: 'p1' } };
    expect(rule(() => validate(baseScene(), data(), st))).toBe('2.8');
    expect(rule(() => evaluate(baseScene(), data(), st, 0))).toBe('2.8');
    const scene = baseScene({ variables: { k: { kind: 'selector', by: 'index', default: 0 }, show: { kind: 'toggle', default: true } } });
    const bad = state();
    bad.variables = { k: true };
    expect(rule(() => evaluate(scene, data(), bad, 0))).toBe('2.5');
    bad.variables = { show: 'false' };
    expect(rule(() => evaluate(scene, data(), bad, 0))).toBe('2.5');
    const warn = state();
    warn.panels.p1!.variables = { k: 1 };
    expect(validate(scene, data(), warn)).toEqual(['panel p1 sets k, which is scene-scoped and never read there']);
  });
  it('the driver is resolved for every panel, hence V2, V3 and C5 are checked without a body layer', () => {
    const scene = baseScene();
    scene.track_sets.u = { frame: 'a', tracks: 1, offsets: 'off', positions: 'pos' };
    scene.views.main!.layers = [];
    scene.views.main!.driver = { sets: { set: 'u' }, member: { index: 0 } };
    expect(rule(() => evaluate(scene, data(), state(), 0))).toBe('C5');
    scene.views.main!.driver = { sets: { set: 's' }, member: { index: 3 } };
    expect(rule(() => evaluate(scene, data(), state(), 0))).toBe('V3');
    scene.views.main!.driver = { sets: { set: 's' }, member: 'all' as unknown as { index: number } };
    expect(rule(() => evaluate(scene, data(), state(), 0))).toBe('V3');
    expect(rule(() => validate(scene))).toBe('V3');
  });
  it('a plane camera takes an aspect of equal or free, in a scene of version 0.3 (2.7, S1)', () => {
    const scene = baseScene({ version: '0.3' });
    for (const aspect of ['equal', 'free'] as const) {
      scene.views.main!.camera = { kind: 'plane', aspect };
      expect(validate(scene, data(), state())).toEqual([]);
    }
    scene.views.main!.camera = { kind: 'plane', aspect: 'stretch' as 'free' };
    expect(rule(() => validate(scene))).toBe('2.7');
    expect(rule(() => validate(baseScene({ version: '0.4' })))).toBe('S1');
  });
  it('warns on a camera key this reader does not know, e.g. aspect on an orbit camera (section 2)', () => {
    const scene = baseScene();
    scene.views.main!.camera = { kind: 'orbit', aspect: 'free' } as never;
    expect(validate(scene)).toContain('the camera of view main has a key "aspect" that this reader does not know');
  });
  it('a newer minor version and an unknown layer kind break S1, and wrong kinds and ranges break L5 and 2.7', () => {
    expect(rule(() => validate(baseScene({ version: '0.9' })))).toBe('S1');
    const scene = baseScene();
    scene.views.main!.layers = [{ kind: 'points' } as unknown as Layer];
    expect(rule(() => validate(scene))).toBe('S1');
    expect(rule(() => evaluate(scene, data(), state(), 0))).toBe('S1');
    const choice = baseScene({ variables: { c: { kind: 'choice', values: ['x'], default: 'x' } } });
    choice.views.main!.layers = [{ kind: 'grid', visible: { var: 'c' } }];
    expect(rule(() => validate(choice))).toBe('L5');
    expect(rule(() => evaluate(choice, data(), state(), 0))).toBe('L5');
    const trail = baseScene();
    trail.views.main!.layers = [{ kind: 'track', sets: { set: 's' }, members: 'all', reveal: 'trail', trail: { fraction: 1.5 } }];
    expect(rule(() => validate(trail))).toBe('2.7');
    expect(rule(() => evaluate(trail, data(), state(), 0))).toBe('2.7');
    expect(rule(() => validate(baseScene({ frames: { a: {}, b: { parent: 'a', rotation: { axis: 'z', angle: { channel: '@index' } } } } })))).toBe('2.2');
  });
  it('readout parts and slider domains are checked against the driver (2.9)', () => {
    const scene = baseScene({ variables: { e: { kind: 'selector', parameter: 'C', default: 0 }, k: { kind: 'selector', by: 'index', default: 0 } } });
    scene.track_sets.s!.parameters = { C: { view: 'c' } };
    scene.track_sets.u = { frame: 'a', tracks: 1, offsets: 'off', positions: 'pos', channels: { time: { view: 'time' } } };
    scene.readouts = [
      {
        place: 'caption',
        parts: [
          { member: 'C', digits: 3 },
          { attr: 'mu', factor: -1, offset: 1 },
        ],
      },
    ];
    expect(rule(() => validate(scene))).toBe('2.9');
    scene.track_sets.s!.attrs = { mu: 0.1 };
    expect(validate(scene)).toEqual([]);
    scene.controls = [{ kind: 'slider', variable: 'e', label: 'e', domain: { set: 'u' } }];
    expect(rule(() => validate(scene))).toBe('2.9');
    scene.controls = [{ kind: 'slider', variable: 'k', label: 'k', domain: { set: 's' } }];
    expect(rule(() => validate(scene))).toBe('2.9');
    scene.controls = [];
    scene.variables!.c = { kind: 'choice', values: ['x', 'y'], default: 'x', labels: ['only one'] };
    expect(rule(() => validate(scene))).toBe('2.5');
  });
});

describe('laps, counts, and the options for drawing (C6, V3, L3, 2.7)', () => {
  const data = () =>
    new MemoryStore()
      .add('off', [0, 3], 'uint32')
      .add('pos', [
        [0, 0],
        [1, 0],
        [0, 0],
      ])
      .add('time', [0, 1, 2])
      .add('e', [0.5]);
  const withLayer = (layer: Partial<TrackLayer>, variables: NonNullable<ReturnType<typeof baseScene>['variables']> = {}) => {
    const scene = baseScene({
      variables: {
        e: { kind: 'selector', parameter: 'e', default: 0 },
        k: { kind: 'selector', by: 'index', default: 0 },
        look: { kind: 'choice', values: ['x', 'y'], default: 'x', scope: 'panel' },
        ...variables,
      },
    });
    scene.track_sets.s!.parameters = { e: { view: 'e' } };
    scene.views.main!.layers = [{ kind: 'track', sets: { set: 's' }, members: 'all', ...layer }];
    return scene;
  };
  it('laps need a clock in fraction mode, an integer of at least one, and periodic track sets where a reading is taken (C6)', () => {
    expect(rule(() => validate(baseScene({ clock: { mode: 'value', channels: ['time'], steps: 4, range: [0, 1], laps: 1 } })))).toBe('C6');
    expect(rule(() => validate(baseScene({ clock: { mode: 'fraction', channels: ['time'], steps: 4, laps: 1.5 } })))).toBe('C6');
    const scene = baseScene({ clock: { mode: 'fraction', channels: ['time'], steps: 4, laps: 2 } });
    expect(rule(() => validate(scene, data(), state()))).toBe('C6');
    expect(rule(() => evaluate(scene, data(), state(), 0))).toBe('C6');
    scene.track_sets.s!.periodic = true;
    expect(validate(scene, data(), state())).toEqual([]);
    // two laps of a closed three-sample track: lap 0 without its closing sample, then lap 1
    expect((evaluate(scene, data(), state(), 0).panels.p1!.layers[0] as TrackLayerResult).members[0]!.line.length).toBe(5);
  });
  it("a count steps by floor(N / n + 0.5), keeps the last track, and cannot be a driver's member (V3)", () => {
    expect(sparse(5, 2)).toEqual([0, 3, 4]);
    expect(sparse(5, 1)).toEqual([0, 4]);
    expect(sparse(5, 9)).toEqual([0, 1, 2, 3, 4]);
    expect(sparse(7, 3)).toEqual([0, 2, 4, 6]);
    expect(sparse(915, 40).length).toBe(41);
    expect(rule(() => validate(withLayer({ members: { count: 0 } })))).toBe('V3');
    const scene = baseScene();
    scene.views.main!.driver.member = { count: 2 } as unknown as { index: number };
    expect(rule(() => validate(scene))).toBe('V3');
    expect(rule(() => evaluate(scene, data(), state(), 0))).toBe('V3');
  });
  it('a colormap keyed on a choice names a colormap for every value and only for these values (2.7)', () => {
    const color = (map: Record<string, string>, v = 'look') => ({ color: { parameter: 'e', colormap: { var: v, map } } }) as Partial<TrackLayer>;
    expect(validate(withLayer(color({ x: 'viridis', y: 'reds' })), data(), state())).toEqual([]);
    expect(rule(() => validate(withLayer(color({ x: 'viridis' }))))).toBe('2.7');
    expect(rule(() => validate(withLayer(color({ x: 'viridis', y: 'reds', z: 'blues' }))))).toBe('2.7');
    expect(rule(() => validate(withLayer(color({ x: 'viridis', y: 'jet' }))))).toBe('2.7');
    expect(rule(() => validate(withLayer(color({ x: 'viridis', y: 'reds' }, 'e'))))).toBe('2.7');
  });
  it('the kernel, taper, head, span, and labels are checked (2.7, L3)', () => {
    expect(
      validate(
        withLayer({
          highlight: { var: 'e', kernel: { width: 0.05, opacity: 0.55 } },
          reveal: 'trail',
          trail: { fraction: 0.3, taper: { width: 0, opacity: 0 } },
          head: { color: '#f0e442', size: 9 },
        }),
        data(),
        state(),
      ),
    ).toEqual([]);
    expect(rule(() => validate(withLayer({ highlight: { var: 'k', kernel: { width: 0.05, opacity: 0.55 } } })))).toBe('2.7');
    expect(rule(() => validate(withLayer({ highlight: { var: 'e', kernel: { width: 0, opacity: 0.55 } } })))).toBe('2.7');
    expect(rule(() => validate(withLayer({ reveal: 'trail', trail: { fraction: 0.3, taper: { width: 1.5 } } })))).toBe('2.7');
    expect(rule(() => validate(withLayer({ head: { size: 0 } })))).toBe('L3');
    expect(rule(() => validate(withLayer({ head: { color: 'yellow' } })))).toBe('L3');
    const marks = baseScene();
    marks.views.main!.layers = [
      { kind: 'axes', span: 'full' },
      { kind: 'grid', labels: true },
    ];
    expect(validate(marks)).toEqual([]);
    marks.views.main!.layers = [{ kind: 'axes', span: 'half' as 'full' }];
    expect(rule(() => validate(marks))).toBe('2.7');
    marks.views.main!.layers = [{ kind: 'grid', labels: 'yes' as unknown as boolean }];
    expect(rule(() => validate(marks))).toBe('2.7');
  });
  it('a head object gives the same point as true and takes a reading (L3, C5)', () => {
    const scene = withLayer({ head: { color: '#f0e442' } });
    scene.views.main!.layers.push({ kind: 'track', sets: { set: 's' }, members: 'all', head: true });
    const r = evaluate(scene, data(), state(), 1).panels.p1!.layers as TrackLayerResult[];
    expect(r[0]!.members[0]!.head).toEqual(r[1]!.members[0]!.head);
    scene.track_sets.u = { frame: 'a', tracks: 1, offsets: 'off', positions: 'pos' };
    scene.views.main!.layers = [{ kind: 'track', sets: { set: 'u' }, members: 'all', head: {} }];
    expect(rule(() => validate(scene, data(), state()))).toBe('C5');
  });
});
