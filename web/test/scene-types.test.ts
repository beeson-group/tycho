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
});
