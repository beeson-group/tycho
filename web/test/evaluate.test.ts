import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/evaluate/index';
import type { ArrowLayerResult, BodyLayerResult, TrackLayerResult } from '../src/evaluate/types';
import type { Scene } from '../src/scene';
import { validate } from '../src/validate';
import { baseScene, MemoryStore, state } from './helpers';

const close = (a: number[][], b: number[][]) => {
  expect(a.length).toBe(b.length);
  a.forEach((p, i) => p.forEach((x, j) => expect(x).toBeCloseTo(b[i]![j]!, 12)));
};
const track = (r: ReturnType<typeof evaluate>, i = 0) => r.panels.p1!.layers[i] as TrackLayerResult;

describe('frame edges (F1, F3)', () => {
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
      views: { main: { frame: 'b', driver: { sets: { set: 's' }, member: { index: 0 } }, layers: [{ kind: 'track', sets: { set: 's' }, members: 'all' }] } },
    });
    validate(scene, data, state());
    close(track(evaluate(scene, data, state(), 0)).members[0]!.line, [
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
    scene.track_sets.s!.frame = 'b';
    close(track(evaluate(scene, data, state(), 0)).members[0]!.line, [
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
      scene.views.main!.frame = 'b';
      const line = track(evaluate(scene, data, state(), 0)).members[0]!.line;
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

describe('clock and reveal (C1 to C4, L1, L3)', () => {
  it('grow at a reading that falls on a sample, with a head', () => {
    const scene = baseScene();
    scene.views.main!.layers = [{ kind: 'track', sets: { set: 's' }, members: 'all', reveal: 'grow', head: true }];
    const m = track(evaluate(scene, lineData(), state(), 1)).members[0]!;
    close(m.line, [
      [0, 0, 0],
      [10, 0, 0],
    ]);
    close([m.head!], [[10, 0, 0]]);
  });
  it('value mode at the last sample, and hidden after it', () => {
    const scene = baseScene({ clock: { mode: 'value', channels: ['time'], steps: 4, range: [0, 8] } });
    scene.views.main!.layers = [{ kind: 'track', sets: { set: 's' }, members: 'all', reveal: 'grow', head: true }];
    close([track(evaluate(scene, lineData(), state(), 2)).members[0]!.head!], [[40, 0, 0]]);
    scene.views.main!.layers = [{ kind: 'track', sets: { set: 's' }, members: 'all', reveal: 'grow', head: true, after: 'hidden' }];
    expect(track(evaluate(scene, lineData(), state(), 3)).members[0]).toEqual({ index: 0, line: [], head: null });
  });
  it('a decreasing clock channel and @index', () => {
    const data = lineData();
    data.add('time', [4, 3, 2, 1, 0]);
    const scene = baseScene();
    scene.views.main!.layers = [{ kind: 'track', sets: { set: 's' }, members: 'all', reveal: 'none', head: true }];
    close([track(evaluate(scene, data, state(), 2)).members[0]!.head!], [[20, 0, 0]]);
    close([track(evaluate(scene, data, state('main', '@index'), 3)).members[0]!.head!], [[30, 0, 0]]);
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
  scene.track_sets.s = {
    frame: 'rot',
    tracks: 1,
    offsets: 'off',
    positions: 'pos',
    periodic,
    attrs: { x: 1 },
    channels: { time: { view: 'time' }, f: { view: 'f' } },
  };
  scene.views.main = {
    frame: 'inertial',
    driver: { sets: { set: 's' }, member: { index: 0 } },
    layers: [
      { kind: 'track', sets: { set: 's' }, members: 'all', reveal: 'trail', trail: { fraction: 0.5 } },
      { kind: 'body', body: 'm', trail: { fraction: 0.5 } },
    ],
  };
  return [scene, data];
};
const unit = (f: number) => [Math.cos(f), Math.sin(f), 0];

describe('trails (L2, L4)', () => {
  it('a periodic trail wraps in the shifted context and keeps the joint once', () => {
    const [scene, data] = rotating(true);
    validate(scene, data, state());
    const r = evaluate(scene, data, state(), 1);
    close(track(r).members[0]!.line, [unit(-0.5), unit(0), unit(0.5)]);
    const body = r.panels.p1!.layers[1] as BodyLayerResult;
    close([body.position!], [unit(0.5).map((x) => 3 * x)]);
    close(
      body.trail!,
      [unit(-0.5), unit(0), unit(0.5)].map((p) => p.map((x) => 3 * x)),
    );
  });
  it('a nonperiodic trail is cut at the first sample', () => {
    const [scene, data] = rotating(false);
    close(track(evaluate(scene, data, state(), 1)).members[0]!.line, [unit(0), unit(0.5)]);
  });
});

describe('references (V1 to V3, L5)', () => {
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
      variables: {
        near: { kind: 'selector', by: 'nearest', parameter: 'C', default: 2 },
        idx: { kind: 'selector', by: 'index', default: 7.6, scope: 'panel' },
        show: { kind: 'toggle', default: true },
        fam: { kind: 'choice', values: ['x', 'y'], default: 'y' },
      },
    });
    s.track_sets.s = { ...s.track_sets.s!, tracks: 2, parameters: { C: { view: 'c' } }, tags: { family: 'x' } };
    s.views.main!.layers = [
      { kind: 'track', sets: { set: 's' }, members: { var: 'near' } },
      { kind: 'track', sets: { set: 's' }, members: { var: 'idx' }, visible: { var: 'show' } },
      { kind: 'track', sets: { tags: { family: { var: 'fam' } } }, members: 'all' },
    ];
    return s;
  };
  it('a selector by nearest takes the lowest index on a tie, and one by index rounds and clamps', () => {
    const r = evaluate(scene(), data(), state(), 0);
    expect(track(r, 0).members.map((m) => m.index)).toEqual([0]);
    expect(track(r, 1).members.map((m) => m.index)).toEqual([1]);
    expect(track(r, 2)).toEqual({ kind: 'track', set: null, members: [] });
  });
  it('panel scope against scene scope, a matching tags query, and a hidden layer (L5)', () => {
    const st = state();
    st.variables = { idx: 0, fam: 'x', show: true };
    st.panels.p1!.variables = { idx: 0 };
    let r = evaluate(scene(), data(), st, 0);
    expect(track(r, 1).members.map((m) => m.index)).toEqual([0]);
    expect(track(r, 2).set).toBe('s');
    st.panels.p1!.variables = {};
    st.variables.show = false;
    r = evaluate(scene(), data(), st, 0);
    expect(r.panels.p1!.layers.length).toBe(2);
  });
});

describe('origin at a body (F2)', () => {
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
    scene.views.main!.frame = 'b';
    validate(scene, data, state());
    close(track(evaluate(scene, data, state(), 0)).members[0]!.line, [
      [0, 0, 0],
      [1, 0, 0],
    ]);
  });
});

describe('arrows (L7)', () => {
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
      track_sets: {
        s: {
          frame: 'a',
          tracks: 1,
          offsets: 'off',
          positions: 'pos',
          channels: { time: { view: 'time' }, vx: { view: 'vx' }, vy: { view: 'vy' } },
          ...(attrs ? { attrs } : {}),
        },
      },
      views: {
        main: {
          frame: 'a',
          driver: { sets: { set: 's' }, member: { index: 0 } },
          layers: [
            { kind: 'arrow', sets: { set: 's' }, members: 'all', vector: ['vx', 'vy'], ...arrow } as NonNullable<Scene['views'][string]>['layers'][number],
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
    expect(rule(() => validate(scene({ color: 'white' }), data(), state()))).toBe('L7');
    expect(rule(() => validate(scene({ head: { size: 0 } }), data(), state()))).toBe('L7');
    expect(rule(() => validate(scene({ opacity: 2 }), data(), state()))).toBe('2.7');
    expect(rule(() => validate(scene({ scale: { attr: 'k' } }), data(), state()))).toBe('F5');
    expect(rule(() => validate(scene({ before: 'fade' }), data(), state()))).toBe('C3');
  });
});

describe('drawing keys of a track layer (2.11)', () => {
  it('rejects a dash that is not two positive lengths with the rule that pytycho cites', () => {
    const data = new MemoryStore()
      .add('off', [0, 2], 'uint32')
      .add('pos', [
        [0, 0, 0],
        [1, 0, 0],
      ])
      .add('time', [0, 1]);
    const scene = baseScene({
      views: {
        main: {
          frame: 'a',
          driver: { sets: { set: 's' }, member: { index: 0 } },
          layers: [{ kind: 'track', sets: { set: 's' }, members: 'all', dash: [1, 0] }],
        },
      },
    });
    let rule: string | undefined;
    try {
      validate(scene, data, state());
    } catch (e) {
      rule = (e as { rule?: string }).rule;
    }
    expect(rule).toBe('2.11');
  });
});
