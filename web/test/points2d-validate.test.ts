import { describe, expect, it } from 'vitest';
import { TychoError } from '../src/errors';
import { fits } from '../src/evaluate/resolve';
import type { Control, Input, Scene } from '../src/scene';
import { validate } from '../src/validate';
import { loadCorpus } from './corpus';

const rule = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    if (e instanceof TychoError) return e.rule;
    throw e;
  }
  return 'no error';
};

type Points = Extract<Input, { kind: 'points_2d' }>;
type Picker = Extract<Control, { kind: 'points_2d' }>;

/** The scene of the corpus with its rational surfaces, whose inputs `poles` and `zeros` are changed by `edit`. */
function surfaces(edit: (poles: Points, zeros: Points, scene: Scene) => void = () => {}) {
  const { scene, data } = loadCorpus('complex-domains');
  edit(scene.inputs!.poles as Points, scene.inputs!.zeros as Points, scene);
  return { scene, data };
}

const row = (n: number): [number, number][] => Array.from({ length: n }, (_, k) => [-0.1 * (k + 1), 0]);

describe('the points of a rational surface (rules `points-2d`, `surface`, and `control`)', () => {
  it('takes at most 6 points for an input without max_points', () => {
    const input: Points = { kind: 'points_2d', default: [] };
    expect(fits(input, row(6))).toBe(true);
    expect(fits(input, row(7))).toBe(false);
    expect(fits({ ...input, max_points: 8 }, row(7))).toBe(true);
  });

  it('rejects inputs that default to a function that the evaluator rejects', () => {
    const { scene, data } = surfaces();
    expect(rule(() => validate(scene, data))).toBe('no error');
    for (const edit of [
      (poles: Points) => Object.assign(poles, { default: [], min_points: 0 }),
      (poles: Points) => Object.assign(poles, { default: row(7), max_points: 8 }),
      (_: Points, zeros: Points) => Object.assign(zeros, { default: row(2) }),
      (poles: Points, zeros: Points) => (Object.assign(poles, { default: row(6) }), Object.assign(zeros, { default: row(6), max_points: undefined })),
    ]) {
      const bad = surfaces(edit);
      expect(rule(() => validate(bad.scene, bad.data))).toBe('surface');
    }
  });

  it('rejects a preset that is improper or outside the counts of the inputs that hold it', () => {
    const control = (preset: Record<string, unknown>): Picker =>
      ({ kind: 'points_2d', input: 'poles', secondary_input: 'zeros', label: 'Poles', presets: [{ id: 'a', label: 'A', ...preset }] }) as Picker;
    const withPreset = (preset: Record<string, unknown>, edit?: (poles: Points, zeros: Points) => void) => {
      const s = surfaces(edit);
      s.scene.controls = [control(preset)];
      return rule(() => validate(s.scene, s.data));
    };
    expect(withPreset({ poles: row(2), zeros: row(1), gain: 2 })).toBe('no error');
    expect(withPreset({ poles: row(1), zeros: row(2) })).toBe('control');
    expect(withPreset({ poles: [] })).toBe('control');
    expect(withPreset({ poles: row(7) })).toBe('control');
    expect(withPreset({ poles: row(2), zeros: row(6) })).toBe('control');
    expect(withPreset({ poles: [[0, Number.NaN]] })).toBe('control');
    expect(withPreset({ poles: row(1), gain: Infinity })).toBe('control');
    expect(withPreset({ poles: row(3) }, (poles) => Object.assign(poles, { max_points: 2 }))).toBe('control');
  });
});
