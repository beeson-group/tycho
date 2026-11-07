import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/evaluate/index';
import type { BodyLayerResult, TrackLayerResult } from '../src/evaluate/types';
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
