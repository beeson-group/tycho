import { describe, expect, it } from 'vitest';
import { conformalExp } from '../src/evaluate/complex.js';
import type { DataArray, DataStore } from '../src/container.js';
import { TychoError } from '../src/errors.js';
import type { Scene } from '../src/scene.js';
import { validate } from '../src/validate.js';

function minimalMorphScene(): { scene: Scene; data: DataStore } {
  const arrays = new Map<string, DataArray>([
    ['ref/offsets', { name: 'ref/offsets', dtype: 'uint32', shape: [2], data: new Uint32Array([0, 2]) }],
    ['ref/positions', { name: 'ref/positions', dtype: 'float32', shape: [2, 3], data: new Float32Array([0, 0, 0, 1, 0, 0]) }],
    ['ref/channels/t', { name: 'ref/channels/t', dtype: 'float64', shape: [2], data: new Float64Array([0, 1]) }],
  ]);
  const data: DataStore = {
    has: (name) => arrays.has(name),
    array: (name) => arrays.get(name)!,
  };
  const scene: Scene = {
    format: 'tycho-scene',
    version: '0.6',
    requires: ['inputs.number', 'layers.morph', 'controls.action'],
    frames: { s: { axes: ['σ', 'jω', 'z'] } },
    trajectory_sets: {
      ref: {
        frame: 's',
        trajectories: 1,
        offsets: 'ref/offsets',
        positions: 'ref/positions',
        channels: { t: { array: 'ref/channels/t' } },
      },
    },
    inputs: {
      T: { kind: 'number', min: 0.25, max: 2.0, step: 0.05, default: 1.0 },
    },
    clock: { mode: 'epoch', channels: ['t'], range: [0, 1], frame_count: 10, seconds: 5, end: 'stop' },
    steps: [{ id: 's0', at: 0, label: 'Start' }],
    panels: {
      main: {
        frame: 's',
        reference: { sets: { set: 'ref' }, member: { index: 0 } },
        layers: [
          {
            kind: 'morph',
            map: 'conformal_exp',
            alpha: 0,
            period: { input: 'T' },
            items: [
              {
                kind: 'region',
                u: [-2, 0],
                v: [-1, 1],
                reveal: {
                  keyframes: [
                    [0, 0],
                    [1, 1],
                  ],
                },
                reveal_origin: [-1, 0],
              },
            ],
          },
        ],
      },
    },
    controls: [{ kind: 'action', label: 'Go', from: 's0', to: 2 }],
    initial: { inputs: {}, clock: { channel: 't' }, panels: { main: { panel: 'main' } }, layout: { kind: 'panel', id: 'main' } },
  };
  return { scene, data };
}

describe('conformal morph evaluation and 0.6 controls', () => {
  it('evaluates conformalExp smoothly near alpha = 0 and matches exp(sT) at alpha = 1', () => {
    expect(conformalExp(-1.2, 0.9, 0.0, 0.7)).toEqual([-1.2, 0.9]);
    const [x, y] = conformalExp(-0.5, 1.2, 1.0, 0.8);
    expect(x).toBeCloseTo(Math.exp(-0.4) * Math.cos(0.96), 12);
    expect(y).toBeCloseTo(Math.exp(-0.4) * Math.sin(0.96), 12);
  });

  it('validates 0.6 morph, number, show_range, and action rules', () => {
    const { scene, data } = minimalMorphScene();
    expect(() => validate(scene, data)).not.toThrow();

    const badAction = structuredClone(scene);
    badAction.controls = [{ kind: 'action', label: 'Bad', from: 'missing', to: 1 }];
    expect(() => validate(badAction, data)).toThrow(TychoError);

    const badRange = structuredClone(scene);
    badRange.controls = [{ kind: 'slider', input: 'T', label: 'T', show_range: [3, 1] }];
    expect(() => validate(badRange, data)).toThrow(TychoError);

    const badOrigin = structuredClone(scene);
    (badOrigin.panels.main!.layers[0] as { items: Array<Record<string, unknown>> }).items[0]!.reveal_origin = [0];
    expect(() => validate(badOrigin, data)).toThrow(TychoError);
  });
});
