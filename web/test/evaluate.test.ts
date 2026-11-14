import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/evaluate/index';
import type { ArrowLayerResult, BodyLayerResult, TrajectoriesLayerResult } from '../src/evaluate/types';
import type { Scene } from '../src/scene';
import { validate } from '../src/validate';
import { baseScene, MemoryStore, state } from './helpers';

const close = (a: number[][], b: number[][]) => {
  expect(a.length).toBe(b.length);
  a.forEach((p, i) => p.forEach((x, j) => expect(x).toBeCloseTo(b[i]![j]!, 12)));
};
const trajectory = (r: ReturnType<typeof evaluate>, i = 0) => r.panels.p1!.layers[i] as TrajectoriesLayerResult;

describe('frame edges (transform, frame-path)', () => {
  const frames: Scene['frames'] = { a: {}, b: { parent: 'a', origin: [1, 2, 3], rotation: { axis: 'z', angle: Math.PI / 2 }, scale: 2 } };
  it('the forward edge gives p_child = s R (p_parent - o)', () => {
    const data = new MemoryStore()
      .add('off', [0, 2], 'uint32')
      .add('pos', [
        [2, 2, 3],
        [1, 2, 3],
      ])
      .add('time', [0, 1]);
    const scene = baseScene({
      frames,
      panels: {
        main: { frame: 'b', reference: { sets: { set: 's' }, member: { index: 0 } }, layers: [{ kind: 'trajectories', sets: { set: 's' }, members: 'all' }] },
      },
    });
    validate(scene, data, state());
    close(trajectory(evaluate(scene, data, state(), 0)).members[0]!.line, [
      [0, 2, 0],
      [0, 0, 0],
    ]);
  });
  it('the inverse edge gives p_parent = o + R^T (p_child / s)', () => {
    const data = new MemoryStore()
      .add('off', [0, 2], 'uint32')
      .add('pos', [
        [0, 2, 0],
        [0, 0, 0],
      ])
      .add('time', [0, 1]);
    const scene = baseScene({ frames });
    scene.trajectory_sets.s!.frame = 'b';
    close(trajectory(evaluate(scene, data, state(), 0)).members[0]!.line, [
      [2, 2, 3],
      [1, 2, 3],
    ]);
  });
  it('rotation about x and y', () => {
    for (const [axis, want] of [
      ['x', [0, 0, 1]],
      ['y', [0, 0, -1]],
    ] as const) {
      const data = new MemoryStore()
        .add('off', [0, 2], 'uint32')
        .add('pos', [
          [0, 1, 0],
          [1, 0, 0],
        ])
        .add('time', [0, 1]);
      const scene = baseScene({ frames: { a: {}, b: { parent: 'a', rotation: { axis, angle: Math.PI / 2 } } } });
      scene.panels.main!.frame = 'b';
      const line = trajectory(evaluate(scene, data, state(), 0)).members[0]!.line;
      close([axis === 'x' ? line[0]! : line[1]!], [want as unknown as number[]]);
    }
  });
});

const lineData = () =>
  new MemoryStore()
    .add('off', [0, 5], 'uint32')
    .add('pos', [
      [0, 0],
      [10, 0],
      [20, 0],
      [30, 0],
      [40, 0],
    ])
    .add('time', [0, 1, 2, 3, 4]);

describe('clock and reveal (sample-fraction to segment, polyline, head)', () => {
  it('grow at a reading that falls on a sample, with a head', () => {
    const scene = baseScene();
    scene.panels.main!.layers = [{ kind: 'trajectories', sets: { set: 's' }, members: 'all', reveal: 'grow', head: true }];
    const m = trajectory(evaluate(scene, lineData(), state(), 1)).members[0]!;
    close(m.line, [
      [0, 0, 0],
      [10, 0, 0],
    ]);
    close([m.head!], [[10, 0, 0]]);
  });
  it('value mode at the last sample, and hidden after it', () => {
    const scene = baseScene({ clock: { mode: 'epoch', channels: ['time'], frame_count: 4, range: [0, 8] } });
    scene.panels.main!.layers = [{ kind: 'trajectories', sets: { set: 's' }, members: 'all', reveal: 'grow', head: true }];
    close([trajectory(evaluate(scene, lineData(), state(), 2)).members[0]!.head!], [[40, 0, 0]]);
    scene.panels.main!.layers = [{ kind: 'trajectories', sets: { set: 's' }, members: 'all', reveal: 'grow', head: true, after: 'hidden' }];
    expect(trajectory(evaluate(scene, lineData(), state(), 3)).members[0]).toEqual({ index: 0, line: [], head: null });
  });
  it('a decreasing clock channel and @index', () => {
    const data = lineData();
    data.add('time', [4, 3, 2, 1, 0]);
    const scene = baseScene();
    scene.panels.main!.layers = [{ kind: 'trajectories', sets: { set: 's' }, members: 'all', reveal: 'none', head: true }];
    close([trajectory(evaluate(scene, data, state(), 2)).members[0]!.head!], [[20, 0, 0]]);
    close([trajectory(evaluate(scene, data, state('main', '@index'), 3)).members[0]!.head!], [[30, 0, 0]]);
  });
});

const rotating = (periodic: boolean): [Scene, MemoryStore] => {
  const data = new MemoryStore()
    .add('off', [0, 5], 'uint32')
    .add('pos', [
      [1, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
    ])
    .add('time', [0, 1, 2, 3, 4])
    .add('f', [0, 0.5, 1, 1.5, 2]);
  const scene = baseScene({
    frames: { rot: {}, inertial: { parent: 'rot', rotation: { axis: 'z', angle: { channel: 'f' } } } },
    bodies: { m: { frame: 'rot', position: [{ attr: 'x', factor: 2, offset: 1 }, 0, 0] } },
  });
  scene.trajectory_sets.s = {
    frame: 'rot',
    trajectories: 1,
    offsets: 'off',
    positions: 'pos',
    periodic,
    attrs: { x: 1 },
    channels: { time: { array: 'time' }, f: { array: 'f' } },
  };
  scene.panels.main = {
    frame: 'inertial',
    reference: { sets: { set: 's' }, member: { index: 0 } },
    layers: [
      { kind: 'trajectories', sets: { set: 's' }, members: 'all', reveal: 'trail', trail: { fraction: 0.5 } },
      { kind: 'body', body: 'm', trail: { fraction: 0.5 } },
    ],
  };
  return [scene, data];
};
const unit = (f: number) => [Math.cos(f), Math.sin(f), 0];

describe('trails (trail-wrap, body-layer)', () => {
  it('a periodic trail wraps in the shifted context and keeps the joint once', () => {
    const [scene, data] = rotating(true);
    validate(scene, data, state());
    const r = evaluate(scene, data, state(), 1);
    close(trajectory(r).members[0]!.line, [unit(-0.5), unit(0), unit(0.5)]);
    const body = r.panels.p1!.layers[1] as BodyLayerResult;
    close([body.position!], [unit(0.5).map((x) => 3 * x)]);
    close(
      body.trail!,
      [unit(-0.5), unit(0), unit(0.5)].map((p) => p.map((x) => 3 * x)),
    );
  });
  it('a nonperiodic trail is cut at the first sample', () => {
    const [scene, data] = rotating(false);
    close(trajectory(evaluate(scene, data, state(), 1)).members[0]!.line, [unit(0), unit(0.5)]);
  });
});

describe('references (input-scope to members, visible)', () => {
  const data = () =>
    new MemoryStore()
      .add('off', [0, 2, 4], 'uint32')
      .add('pos', [
        [0, 0],
        [1, 0],
        [2, 0],
        [3, 0],
      ])
      .add('time', [0, 1, 0, 1])
      .add('c', [1, 3]);
  const scene = (): Scene => {
    const s = baseScene({
      inputs: {
        near: { kind: 'parameter', parameter: 'C', default: 2 },
        idx: { kind: 'parameter', parameter: '@index', default: 7.6, scope: 'per_panel' },
        show: { kind: 'toggle', default: true },
        fam: { kind: 'choice', values: ['x', 'y'], default: 'y' },
      },
    });
    s.trajectory_sets.s = { ...s.trajectory_sets.s!, trajectories: 2, parameters: { C: { array: 'c' } }, tags: { family: 'x' } };
    s.panels.main!.layers = [
      { kind: 'trajectories', sets: { set: 's' }, members: { input: 'near' } },
      { kind: 'trajectories', sets: { set: 's' }, members: { input: 'idx' }, visible: { input: 'show' } },
      { kind: 'trajectories', sets: { tags: { family: { input: 'fam' } } }, members: 'all' },
    ];
    return s;
  };
  it('a parameter input by nearest takes the lowest index on a tie, and one by index rounds and clamps', () => {
    const r = evaluate(scene(), data(), state(), 0);
    expect(trajectory(r, 0).members.map((m) => m.index)).toEqual([0]);
    expect(trajectory(r, 1).members.map((m) => m.index)).toEqual([1]);
    expect(trajectory(r, 2)).toEqual({ kind: 'trajectories', set: null, members: [] });
  });
  it('per-panel scope against shared scope, a matching tags query, and a hidden layer (visible)', () => {
    const st = state();
    st.inputs = { idx: 0, fam: 'x', show: true };
    st.panels.p1!.inputs = { idx: 0 };
    let r = evaluate(scene(), data(), st, 0);
    expect(trajectory(r, 1).members.map((m) => m.index)).toEqual([0]);
    expect(trajectory(r, 2).set).toBe('s');
    st.panels.p1!.inputs = {};
    st.inputs.show = false;
    r = evaluate(scene(), data(), st, 0);
    expect(r.panels.p1!.layers.length).toBe(2);
  });
});

describe('origin at a body (origin)', () => {
  it('a body in a frame other than the edge parent', () => {
    const data = new MemoryStore()
      .add('off', [0, 2], 'uint32')
      .add('pos', [
        [0, -1],
        [1, -1],
      ])
      .add('time', [0, 1]);
    const scene = baseScene({
      frames: { a: {}, c: { parent: 'a', rotation: { axis: 'z', angle: Math.PI / 2 } }, b: { parent: 'a', origin: { body: 'm' } } },
      bodies: { m: { frame: 'c', position: [1, 0, 0] } },
    });
    scene.panels.main!.frame = 'b';
    validate(scene, data, state());
    close(trajectory(evaluate(scene, data, state(), 0)).members[0]!.line, [
      [0, 0, 0],
      [1, 0, 0],
    ]);
  });
});

describe('arrows (arrow)', () => {
  const data = () =>
    new MemoryStore()
      .add('off', [0, 2], 'uint32')
      .add('pos', [
        [0, 0],
        [1, 0],
      ])
      .add('time', [0, 1])
      .add('vx', [1, 1])
      .add('vy', [0, 2]);
  const scene = (arrow: Record<string, unknown>, attrs?: Record<string, number>) =>
    baseScene({
      version: '0.3',
      requires: ['layers.arrows'],
      trajectory_sets: {
        s: {
          frame: 'a',
          trajectories: 1,
          offsets: 'off',
          positions: 'pos',
          channels: { time: { array: 'time' }, vx: { array: 'vx' }, vy: { array: 'vy' } },
          ...(attrs ? { attrs } : {}),
        },
      },
      panels: {
        main: {
          frame: 'a',
          reference: { sets: { set: 's' }, member: { index: 0 } },
          layers: [
            { kind: 'arrow', sets: { set: 's' }, members: 'all', vector: ['vx', 'vy'], ...arrow } as NonNullable<Scene['panels'][string]>['layers'][number],
          ],
        },
      },
    });
  const rule = (f: () => void): string | undefined => {
    try {
      f();
    } catch (e) {
      return (e as { rule?: string }).rule;
    }
    return undefined;
  };

  it('blends the base and the tip at the reading, with the scale of an attribute', () => {
    const s = scene({ scale: { attr: 'k', factor: 2 } }, { k: 0.25 });
    validate(s, data(), state());
    // at frame 2 of 4 the reading is 0.5, halfway between samples 0 and 1
    const r = evaluate(s, data(), state(), 2).panels.p1!.layers[0] as ArrowLayerResult;
    close(
      [r.members[0]!.base!, r.members[0]!.tip!],
      [
        [0.5, 0, 0],
        [1, 0.5, 0],
      ],
    );
  });

  it('checks the drawing keys, and the attribute of the scale on the set', () => {
    expect(rule(() => validate(scene({ color: 'white' }), data(), state()))).toBe('arrow');
    expect(rule(() => validate(scene({ head: { size: 0 } }), data(), state()))).toBe('arrow');
    expect(rule(() => validate(scene({ opacity: 2 }), data(), state()))).toBe('panel');
    expect(rule(() => validate(scene({ scale: { attr: 'k' } }), data(), state()))).toBe('transform-channels');
    expect(rule(() => validate(scene({ before: 'fade' }), data(), state()))).toBe('before-after');
  });
});

describe('drawing keys of a trajectories layer (2.11)', () => {
  it('rejects a dash that is not two positive lengths with the rule that pytycho cites', () => {
    const data = new MemoryStore()
      .add('off', [0, 2], 'uint32')
      .add('pos', [
        [0, 0, 0],
        [1, 0, 0],
      ])
      .add('time', [0, 1]);
    const scene = baseScene({
      panels: {
        main: {
          frame: 'a',
          reference: { sets: { set: 's' }, member: { index: 0 } },
          layers: [{ kind: 'trajectories', sets: { set: 's' }, members: 'all', dash: [1, 0] }],
        },
      },
    });
    let rule: string | undefined;
    try {
      validate(scene, data, state());
    } catch (e) {
      rule = (e as { rule?: string }).rule;
    }
    expect(rule).toBe('timeline');
  });
});

describe('the scope of an input', () => {
  it('rejects a scope other than shared or per_panel under rule input', () => {
    const data = new MemoryStore()
      .add('off', [0, 2], 'uint32')
      .add('pos', [
        [0, 0, 0],
        [1, 0, 0],
      ])
      .add('time', [0, 1]);
    const scene = baseScene({ inputs: { on: { kind: 'toggle', default: true, scope: 'panel' as 'shared' } } });
    let rule: string | undefined;
    try {
      validate(scene, data, state());
    } catch (e) {
      rule = (e as { rule?: string }).rule;
    }
    expect(rule).toBe('input');
  });
});

describe('the drawing keys of the timeline section', () => {
  const data = () =>
    new MemoryStore()
      .add('off', [0, 2], 'uint32')
      .add('pos', [
        [0, 0, 0],
        [1, 0, 0],
      ])
      .add('time', [0, 1]);
  const ruleOf = (layer: Record<string, unknown>): string | undefined => {
    const scene = baseScene({
      panels: {
        main: {
          frame: 'a',
          reference: { sets: { set: 's' }, member: { index: 0 } },
          layers: [{ kind: 'trajectories', sets: { set: 's' }, members: 'all', ...layer }],
        },
      },
    } as Partial<Scene>);
    try {
      validate(scene, data(), state());
    } catch (e) {
      return (e as { rule?: string }).rule;
    }
    return undefined;
  };
  it('cite the rule timeline that pytycho cites for a head glow and for thresholds', () => {
    expect(ruleOf({ head: { glow: { channel: '@index' } } })).toBe('timeline');
    expect(ruleOf({ head: { glow: { channel: 'nope' } } })).toBe('timeline');
    expect(ruleOf({ color: { channel: 'time', thresholds: [1, 0], colors: ['#000000', '#ffffff', '#ff0000'] } })).toBe('timeline');
  });
});
