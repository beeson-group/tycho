import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { generate, OUTPUT_PATH, SCHEMA_PATH } from '../scripts/gen-types.mjs';
import { TychoError } from '../src/errors';
import { evaluate } from '../src/evaluate/index';
import { sparse } from '../src/evaluate/resolve';
import type { TrajectoriesLayerResult } from '../src/evaluate/types';
import type { Layer, State, TrajectoriesLayer } from '../src/scene';
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
  it('the version error names an unknown major version and an unimplemented feature together', () => {
    const scene = baseScene({ version: '1.0', requires: ['panels.plot'] });
    expect(() => validate(scene)).toThrow(/major version 1.*panels\.plot/);
  });
  it('a drawn trajectory set that lacks a channel on the path is rejected (transform-channels)', () => {
    const scene = baseScene({ frames: { a: {}, b: { parent: 'a', rotation: { axis: 'z', angle: { channel: 'f' } } } } });
    scene.panels.main!.frame = 'b';
    expect(rule(() => validate(scene, data(), state()))).toBe('transform-channels');
  });
  it('an origin at a body that lies below the edge of the origin is rejected (body-origin-cycle)', () => {
    const scene = baseScene({ frames: { a: {}, b: { parent: 'a', origin: { body: 'x' } } }, bodies: { x: { frame: 'b', position: [0, 0, 0] } } });
    expect(rule(() => validate(scene))).toBe('body-origin-cycle');
  });
  it('a trajectory of fewer than two samples (two-samples) and a clock channel that is not strictly monotone (monotone-clock-channel) are rejected', () => {
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
    ).toBe('two-samples');
    expect(rule(() => validate(baseScene(), data().add('time', [1, 1])))).toBe('monotone-clock-channel');
  });
  const second = () => {
    const scene = baseScene();
    scene.trajectory_sets.u = { frame: 'a', trajectories: 1, offsets: 'off', positions: 'pos' };
    scene.panels.main!.layers = [{ kind: 'trajectories', sets: { set: 'u' }, members: 'all' }];
    return scene;
  };
  it('only a trajectory set on which a reading is taken must carry the clock channels (clock-channel-carried)', () => {
    const scene = second();
    validate(scene, data(), state());
    expect((evaluate(scene, data(), state(), 1).panels.p1!.layers[0] as TrajectoriesLayerResult).members[0]!.line.length).toBe(2);
    scene.panels.main!.layers = [{ kind: 'trajectories', sets: { set: 'u' }, members: 'all', head: true }];
    expect(rule(() => validate(scene, data(), state()))).toBe('clock-channel-carried');
    scene.panels.main!.layers = [];
    scene.panels.main!.reference.sets = { set: 'u' };
    expect(rule(() => validate(scene, data(), state()))).toBe('clock-channel-carried');
  });
  it('a trajectories layer in the reference trajectory context reads the frame edges on the reference trajectory, and still needs the clock channels for a reading (read-from, transform-channels, clock-channel-carried)', () => {
    const scene = second();
    scene.frames = { a: {}, b: { parent: 'a', rotation: { axis: 'z', angle: { channel: 'time' } } } };
    scene.panels.main!.frame = 'b';
    expect(rule(() => validate(scene, data(), state()))).toBe('transform-channels');
    const layer: TrajectoriesLayer = { kind: 'trajectories', sets: { set: 'u' }, members: 'all', read_from: 'reference' };
    scene.panels.main!.layers = [layer];
    validate(scene, data(), state());
    // at frame 1 of 4 the reference trajectory reads time = 0.25, between the angles 0 and 1, and the set u does not carry any channel
    const line = (evaluate(scene, data(), state(), 1).panels.p1!.layers[0] as TrajectoriesLayerResult).members[0]!.line;
    const want = [0, 0, 0, 0.75 + 0.25 * Math.cos(1), 0.25 * Math.sin(1), 0];
    line.flat().forEach((x, i) => expect(x).toBeCloseTo(want[i]!, 15));
    scene.panels.main!.layers = [{ ...layer, head: true }];
    expect(rule(() => validate(scene, data(), state()))).toBe('clock-channel-carried');
    scene.panels.main!.layers = [{ ...layer, read_from: 'sample' } as unknown as Layer];
    expect(rule(() => validate(scene, data(), state()))).toBe('read-from');
    expect(rule(() => evaluate(scene, data(), state(), 0))).toBe('read-from');
    // without validate, the reveal is still checked before the context, in the order of the NumPy evaluator
    scene.panels.main!.layers = [{ ...layer, reveal: 'sweep', read_from: 'sample' } as unknown as Layer];
    expect(rule(() => evaluate(scene, data(), state(), 0))).toBe('panel');
  });
  it('a reader implements the four features of version 0.3 and the five of version 0.4, and rejects any other (version)', () => {
    validate(baseScene({ version: '0.3', requires: ['frames.origin_channel', 'layers.arrows', 'layers.read_from', 'layers.inset_box'] }));
    validate(baseScene({ version: '0.4', requires: ['clock.keyframes', 'layers.clock', 'camera.keyframes', 'layers.label', 'layers.points'] }));
    expect(rule(() => validate(baseScene({ version: '0.4', requires: ['panels.plot'] })))).toBe('version');
  });
  it('a literal index past the last trajectory and a parameter input whose parameter the trajectory set lacks are rejected (members)', () => {
    const scene = second();
    scene.panels.main!.layers = [{ kind: 'trajectories', sets: { set: 'u' }, members: { index: 1 } }];
    expect(rule(() => validate(scene, data(), state()))).toBe('members');
    expect(rule(() => evaluate(scene, data(), state(), 0))).toBe('members');
    scene.inputs = { e: { kind: 'parameter', parameter: 'e', default: 0 } };
    scene.panels.main!.layers = [{ kind: 'trajectories', sets: { set: 'u' }, members: { input: 'e' } }];
    expect(rule(() => validate(scene, data(), state()))).toBe('members');
    expect(rule(() => evaluate(scene, data(), state(), 0))).toBe('members');
  });
  it('a parameter input needs a parameter (rule `input`)', () => {
    const scene = baseScene({ inputs: { e: { kind: 'parameter', default: 0 } as never } });
    expect(rule(() => validate(scene))).toBe('input');
  });
  it('a query that needs one trajectory set and matches two is rejected (set-query)', () => {
    const scene = second();
    scene.trajectory_sets.s!.tags = { kind: 'x' };
    scene.trajectory_sets.u!.tags = { kind: 'x' };
    scene.panels.main!.layers = [{ kind: 'trajectories', sets: { tags: { kind: 'x' } }, members: 'all' }];
    expect(rule(() => evaluate(scene, data(), state(), 0))).toBe('set-query');
  });

  it('ids that are Object.prototype member names are unknown, not inherited (identifier, 2.8, 2.4, 2.9)', () => {
    const scene = baseScene({ bodies: { b1: { frame: 'a', position: [0, 0, 0] } } });
    const st = state();
    st.inputs = { toString: 1 };
    expect(validate(scene, data(), st)).toEqual([]);
    expect(rule(() => validate(scene, data(), state('constructor')))).toBe('state');
    scene.panels.main!.layers.push({ kind: 'body', body: 'toString' });
    expect(rule(() => validate(scene, data()))).toBe('body-layer');
    scene.panels.main!.layers.pop();
    scene.readouts = [{ place: 'caption', parts: [{ input: 'valueOf' }] }];
    expect(rule(() => validate(scene))).toBe('control');
    const proto = JSON.parse('{"clock":{"channel":"time"},"panels":{"__proto__":{"panel":"main"}},"layout":{"kind":"panel","id":"__proto__"}}') as State;
    const r = evaluate(baseScene(), data(), proto, 0);
    expect(Object.keys(r.panels)).toEqual(['__proto__']);
  });
  it('nonfinite values and an infinite span break monotone-clock-channel, and a noninteger frame index breaks 2.6', () => {
    expect(rule(() => validate(baseScene(), data().add('time', [0, Infinity])))).toBe('monotone-clock-channel');
    expect(rule(() => validate(baseScene(), data().add('time', [-1e308, 1e308])))).toBe('monotone-clock-channel');
    expect(rule(() => evaluate(baseScene(), data().add('time', [0, Infinity]), state(), 0))).toBe('no error');
    const scene = baseScene();
    scene.panels.main!.layers = [{ kind: 'trajectories', sets: { set: 's' }, members: 'all', head: true }];
    expect(rule(() => evaluate(scene, data().add('time', [0, Infinity]), state(), 0))).toBe('monotone-clock-channel');
    expect(rule(() => evaluate(baseScene(), data(), state(), 0.5))).toBe('clock');
    expect(rule(() => evaluate(baseScene(), data(), state(), NaN))).toBe('clock');
  });
  it('a zero scale, a two-element origin, and an edge field on the root are rejected at load (origin, 2.3)', () => {
    expect(rule(() => validate(baseScene({ frames: { a: {}, b: { parent: 'a', scale: 0 } } })))).toBe('origin');
    expect(rule(() => validate(baseScene({ frames: { a: {}, b: { parent: 'a', scale: { attr: 'k', factor: 0 } } } })))).toBe('origin');
    expect(rule(() => validate(baseScene({ frames: { a: {}, b: { parent: 'a', origin: [1, 2] as unknown as [number, number, number] } } })))).toBe('origin');
    expect(rule(() => validate(baseScene({ frames: { a: { scale: 2 } } })))).toBe('frame');
    const scene = baseScene({ frames: { a: {}, b: { parent: 'a', scale: { attr: 'k' } } } });
    scene.trajectory_sets.s!.attrs = { k: 0 };
    scene.panels.main!.frame = 'b';
    expect(rule(() => validate(scene, data(), state()))).toBe('origin');
  });
  it('a state shows every panel once without repeats and holds values that fit their inputs (2.8)', () => {
    const st = state();
    st.layout = { kind: 'split', dir: 'row', ratio: 0.5, a: { kind: 'panel', id: 'p1' }, b: { kind: 'panel', id: 'p1' } };
    expect(rule(() => validate(baseScene(), data(), st))).toBe('state');
    expect(rule(() => evaluate(baseScene(), data(), st, 0))).toBe('state');
    const scene = baseScene({ inputs: { k: { kind: 'parameter', parameter: '@index', default: 0 }, show: { kind: 'toggle', default: true } } });
    const bad = state();
    bad.inputs = { k: true };
    expect(rule(() => evaluate(scene, data(), bad, 0))).toBe('input');
    bad.inputs = { show: 'false' };
    expect(rule(() => evaluate(scene, data(), bad, 0))).toBe('input');
    const warn = state();
    warn.panels.p1!.inputs = { k: 1 };
    expect(validate(scene, data(), warn)).toEqual(['panel p1 sets k, which is shared and never read there']);
  });
  it('the reference trajectory is resolved for every panel, hence set-query, members and clock-channel-carried are checked without a body layer', () => {
    const scene = baseScene();
    scene.trajectory_sets.u = { frame: 'a', trajectories: 1, offsets: 'off', positions: 'pos' };
    scene.panels.main!.layers = [];
    scene.panels.main!.reference = { sets: { set: 'u' }, member: { index: 0 } };
    expect(rule(() => evaluate(scene, data(), state(), 0))).toBe('clock-channel-carried');
    scene.panels.main!.reference = { sets: { set: 's' }, member: { index: 3 } };
    expect(rule(() => evaluate(scene, data(), state(), 0))).toBe('members');
    scene.panels.main!.reference = { sets: { set: 's' }, member: 'all' as unknown as { index: number } };
    expect(rule(() => evaluate(scene, data(), state(), 0))).toBe('members');
    expect(rule(() => validate(scene))).toBe('members');
  });
  it('a 2d camera takes an aspect of equal or free, in a scene of version 0.3 (2.7, version)', () => {
    const scene = baseScene({ version: '0.3' });
    for (const aspect of ['equal', 'free'] as const) {
      scene.panels.main!.camera = { kind: '2d', aspect };
      expect(validate(scene, data(), state())).toEqual([]);
    }
    scene.panels.main!.camera = { kind: '2d', aspect: 'stretch' as 'free' };
    expect(rule(() => validate(scene))).toBe('panel');
    expect(rule(() => validate(baseScene({ version: '0.6' })))).toBe('version');
  });
  it('an 3d camera takes a stretch of three positive factors and a finite turn, in a scene of version 0.3 (2.7)', () => {
    const scene = baseScene({ version: '0.3' });
    scene.panels.main!.camera = { kind: '3d', stretch: [1, 1, 5], auto_rotate: -90 };
    expect(validate(scene, data(), state())).toEqual([]);
    for (const stretch of [
      [1, 1],
      [1, 0, 1],
      [1, 1, Infinity],
      [1, 1, '5'],
    ])
      expect(rule(() => validate({ ...scene, panels: { main: { ...scene.panels.main!, camera: { kind: '3d', stretch: stretch as never } } } }))).toBe('panel');
    for (const turn of [NaN, Infinity, '90'])
      expect(rule(() => validate({ ...scene, panels: { main: { ...scene.panels.main!, camera: { kind: '3d', auto_rotate: turn as never } } } }))).toBe('panel');
  });
  it('a clock takes the seconds of one loop, a positive finite number, in either mode (2.6)', () => {
    const scene = baseScene({ version: '0.3' });
    scene.clock = { ...scene.clock, seconds: 24 };
    expect(validate(scene, data(), state())).toEqual([]);
    for (const seconds of [0, -1, Infinity, '24'])
      expect(rule(() => validate({ ...scene, clock: { ...scene.clock, seconds: seconds as never } }))).toBe('clock');
  });
  it('warns on a camera key this reader does not know, e.g. aspect on a 3d camera (section 2)', () => {
    const scene = baseScene();
    scene.panels.main!.camera = { kind: '3d', aspect: 'free' } as never;
    expect(validate(scene)).toContain('the camera of panel main has a key "aspect" that this reader does not know');
  });
  it('a newer minor version and an unknown layer kind break version, and wrong kinds and ranges break visible and 2.7', () => {
    expect(rule(() => validate(baseScene({ version: '0.9' })))).toBe('version');
    const scene = baseScene();
    scene.panels.main!.layers = [{ kind: 'surface' } as unknown as Layer];
    expect(rule(() => validate(scene))).toBe('version');
    expect(rule(() => evaluate(scene, data(), state(), 0))).toBe('version');
    const choice = baseScene({ inputs: { c: { kind: 'choice', values: ['x'], default: 'x' } } });
    choice.panels.main!.layers = [{ kind: 'grid', visible: { input: 'c' } }];
    expect(rule(() => validate(choice))).toBe('visible');
    expect(rule(() => evaluate(choice, data(), state(), 0))).toBe('visible');
    const trail = baseScene();
    trail.panels.main!.layers = [{ kind: 'trajectories', sets: { set: 's' }, members: 'all', reveal: 'trail', trail: { fraction: 1.5 } }];
    expect(rule(() => validate(trail))).toBe('panel');
    expect(rule(() => evaluate(trail, data(), state(), 0))).toBe('panel');
    expect(rule(() => validate(baseScene({ frames: { a: {}, b: { parent: 'a', rotation: { axis: 'z', angle: { channel: '@index' } } } } })))).toBe(
      'context-number',
    );
  });
  it('readout parts and slider domains are checked against the reference trajectory (2.9)', () => {
    const scene = baseScene({ inputs: { e: { kind: 'parameter', parameter: 'C', default: 0 }, k: { kind: 'parameter', parameter: '@index', default: 0 } } });
    scene.trajectory_sets.s!.parameters = { C: { array: 'c' } };
    scene.trajectory_sets.u = { frame: 'a', trajectories: 1, offsets: 'off', positions: 'pos', channels: { time: { array: 'time' } } };
    scene.readouts = [
      {
        place: 'caption',
        parts: [
          { parameter: 'C', digits: 3 },
          { attr: 'mu', factor: -1, offset: 1 },
        ],
      },
    ];
    expect(rule(() => validate(scene))).toBe('control');
    scene.trajectory_sets.s!.attrs = { mu: 0.1 };
    expect(validate(scene)).toEqual([]);
    scene.controls = [{ kind: 'slider', input: 'e', label: 'e', domain: { set: 'u' } }];
    expect(rule(() => validate(scene))).toBe('control');
    // a slider over the built-in parameter @index is valid over any set
    scene.controls = [{ kind: 'slider', input: 'k', label: 'k', domain: { set: 's' } }];
    expect(validate(scene)).toEqual([]);
    scene.controls = [];
    scene.inputs!.c = { kind: 'choice', values: ['x', 'y'], default: 'x', labels: ['only one'] };
    expect(rule(() => validate(scene))).toBe('input');
  });
});

describe('revolutions, counts, and the options for drawing (revolutions, members, head, 2.7)', () => {
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
  const withLayer = (layer: Partial<TrajectoriesLayer>, inputs: NonNullable<ReturnType<typeof baseScene>['inputs']> = {}) => {
    const scene = baseScene({
      inputs: {
        e: { kind: 'parameter', parameter: 'e', default: 0 },
        k: { kind: 'parameter', parameter: '@index', default: 0 },
        look: { kind: 'choice', values: ['x', 'y'], default: 'x', scope: 'per_panel' },
        ...inputs,
      },
    });
    scene.trajectory_sets.s!.parameters = { e: { array: 'e' } };
    scene.panels.main!.layers = [{ kind: 'trajectories', sets: { set: 's' }, members: 'all', ...layer }];
    return scene;
  };
  it('revolutions need a clock in fraction mode, an integer of at least one, and periodic trajectory sets where a reading is taken (revolutions)', () => {
    expect(rule(() => validate(baseScene({ clock: { mode: 'epoch', channels: ['time'], frame_count: 4, range: [0, 1], revolutions: 1 } })))).toBe(
      'revolutions',
    );
    expect(rule(() => validate(baseScene({ clock: { mode: 'fraction', channels: ['time'], frame_count: 4, revolutions: 1.5 } })))).toBe('revolutions');
    const scene = baseScene({ clock: { mode: 'fraction', channels: ['time'], frame_count: 4, revolutions: 2 } });
    expect(rule(() => validate(scene, data(), state()))).toBe('revolutions');
    expect(rule(() => evaluate(scene, data(), state(), 0))).toBe('revolutions');
    scene.trajectory_sets.s!.periodic = true;
    expect(validate(scene, data(), state())).toEqual([]);
    // two revolutions of a closed three-sample trajectory: revolution 0 without its closing sample, then revolution 1
    expect((evaluate(scene, data(), state(), 0).panels.p1!.layers[0] as TrajectoriesLayerResult).members[0]!.line.length).toBe(5);
  });
  it("a count steps by floor(N / n + 0.5), keeps the last trajectory, and cannot be a reference trajectory's member (members)", () => {
    expect(sparse(5, 2)).toEqual([0, 3, 4]);
    expect(sparse(5, 1)).toEqual([0, 4]);
    expect(sparse(5, 9)).toEqual([0, 1, 2, 3, 4]);
    expect(sparse(7, 3)).toEqual([0, 2, 4, 6]);
    expect(sparse(915, 40).length).toBe(41);
    expect(rule(() => validate(withLayer({ members: { evenly_spaced: 0 } })))).toBe('members');
    const scene = baseScene();
    scene.panels.main!.reference.member = { evenly_spaced: 2 } as unknown as { index: number };
    expect(rule(() => validate(scene))).toBe('members');
    expect(rule(() => evaluate(scene, data(), state(), 0))).toBe('members');
  });
  it('a colormap keyed on a choice names a colormap for every value and only for these values (2.7)', () => {
    const color = (map: Record<string, string>, v = 'look') => ({ color: { parameter: 'e', colormap: { input: v, map } } }) as Partial<TrajectoriesLayer>;
    expect(validate(withLayer(color({ x: 'viridis', y: 'reds' })), data(), state())).toEqual([]);
    expect(rule(() => validate(withLayer(color({ x: 'viridis' }))))).toBe('panel');
    expect(rule(() => validate(withLayer(color({ x: 'viridis', y: 'reds', z: 'blues' }))))).toBe('panel');
    expect(rule(() => validate(withLayer(color({ x: 'viridis', y: 'jet' }))))).toBe('panel');
    expect(rule(() => validate(withLayer(color({ x: 'viridis', y: 'reds' }, 'e'))))).toBe('panel');
  });
  it('the kernel, taper, head, span, and labels are checked (2.7, head)', () => {
    expect(
      validate(
        withLayer({
          highlight: { input: 'e', kernel: { width: 0.05, opacity: 0.55 } },
          reveal: 'trail',
          trail: { fraction: 0.3, taper: { width: 0, opacity: 0 } },
          head: { color: '#f0e442', size: 9 },
        }),
        data(),
        state(),
      ),
    ).toEqual([]);
    expect(validate(withLayer({ highlight: { input: 'k', kernel: { width: 0.05, opacity: 0.55 } } }), data(), state())).toEqual([]);
    expect(rule(() => validate(withLayer({ highlight: { input: 'e', kernel: { width: 0, opacity: 0.55 } } })))).toBe('panel');
    expect(rule(() => validate(withLayer({ reveal: 'trail', trail: { fraction: 0.3, taper: { width: 1.5 } } })))).toBe('panel');
    expect(rule(() => validate(withLayer({ head: { size: 0 } })))).toBe('head');
    expect(rule(() => validate(withLayer({ head: { color: 'yellow' } })))).toBe('head');
    // a flat layer blends each pixel of its lines once (section 2.11)
    expect(validate(withLayer({ group_opacity: true, opacity: 0.2 }), data(), state())).toEqual([]);
    expect(rule(() => validate(withLayer({ group_opacity: 'yes' as unknown as boolean })))).toBe('panel');
    const spaced = baseScene();
    spaced.panels.main!.layers = [{ kind: 'label', text: 'a\nb', at: { screen: [0.5, 0.5] }, linespacing: 1.5 }];
    expect(validate({ ...spaced, version: '0.4', requires: ['layers.label'] })).toEqual([]);
    spaced.panels.main!.layers = [{ kind: 'label', text: 'a\nb', at: { screen: [0.5, 0.5] }, linespacing: 0 }];
    expect(rule(() => validate({ ...spaced, version: '0.4', requires: ['layers.label'] }))).toBe('label');
    const marks = baseScene();
    marks.panels.main!.layers = [
      { kind: 'axes', span: 'full' },
      { kind: 'grid', labels: true },
    ];
    expect(validate(marks)).toEqual([]);
    marks.panels.main!.layers = [{ kind: 'axes', span: 'half' as 'full' }];
    expect(rule(() => validate(marks))).toBe('panel');
    marks.panels.main!.layers = [{ kind: 'grid', labels: 'yes' as unknown as boolean }];
    expect(rule(() => validate(marks))).toBe('panel');
  });
  it('a head object gives the same point as true and takes a reading (head, clock-channel-carried)', () => {
    const scene = withLayer({ head: { color: '#f0e442' } });
    scene.panels.main!.layers.push({ kind: 'trajectories', sets: { set: 's' }, members: 'all', head: true });
    const r = evaluate(scene, data(), state(), 1).panels.p1!.layers as TrajectoriesLayerResult[];
    expect(r[0]!.members[0]!.head).toEqual(r[1]!.members[0]!.head);
    scene.trajectory_sets.u = { frame: 'a', trajectories: 1, offsets: 'off', positions: 'pos' };
    scene.panels.main!.layers = [{ kind: 'trajectories', sets: { set: 'u' }, members: 'all', head: {} }];
    expect(rule(() => validate(scene, data(), state()))).toBe('clock-channel-carried');
  });
});
