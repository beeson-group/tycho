import { describe, expect, it } from 'vitest';
import { evalRationalZ, impulseInvariantZ, polyRoots } from '../src/evaluate/complex';
import type { LayerEnv } from '../src/evaluate/layers';
import { SurfaceDraw } from '../src/runtime/surface';
import type { Scene, SurfaceLayer } from '../src/scene';
import { loadCorpus } from './corpus';

const sorted = (roots: [number, number][]) => [...roots].sort((a, b) => a[0] - b[0] || a[1] - b[1]);

describe('the zeros of the numerator of a rational surface in z', () => {
  it('finds the roots of a polynomial with ascending complex coefficients', () => {
    // (z - 1) (z - 2) = 2 - 3 z + z^2
    const real = sorted(
      polyRoots([
        [2, 0],
        [-3, 0],
        [1, 0],
      ]),
    );
    expect(real[0]![0]).toBeCloseTo(1, 10);
    expect(real[1]![0]).toBeCloseTo(2, 10);
    // z^2 + 1, and a leading coefficient of zero, which lowers the degree
    const pair = sorted(
      polyRoots([
        [1, 0],
        [0, 0],
        [1, 0],
        [0, 0],
      ]),
    );
    expect(pair).toHaveLength(2);
    expect(pair[0]![1]).toBeCloseTo(-1, 10);
    expect(pair[1]![1]).toBeCloseTo(1, 10);
    // a double root at 0.5 and a root at 0: z (z - 0.5)^2
    const double = sorted(
      polyRoots([
        [0, 0],
        [0.25, 0],
        [-1, 0],
        [1, 0],
      ]),
    );
    expect(double[0]![0]).toBeCloseTo(0, 6);
    expect(double[1]![0]).toBeCloseTo(0.5, 4);
    expect(double[2]![0]).toBeCloseTo(0.5, 4);
    expect(polyRoots([[3, 0]])).toEqual([]);
    expect(polyRoots([])).toEqual([]);
  });

  it('gives points at which the transform of six poles and five zeros vanishes', () => {
    const poles: [number, number][] = [
      [-0.3, 1.6],
      [-0.3, -1.6],
      [-0.8, 0],
      [-1.2, 0.7],
      [-1.2, -0.7],
      [-2, 0],
    ];
    const zeros: [number, number][] = [
      [-0.5, 0],
      [0.2, 1],
      [0.2, -1],
      [-1.5, 0],
      [-0.1, 0],
    ];
    const z = impulseInvariantZ(poles, zeros, 1.5, 0.8);
    const roots = polyRoots(z.z_num);
    expect(roots.length).toBeGreaterThan(0);
    const scale = evalRationalZ(z.z_poles, z.z_num, 2, 0);
    for (const [x, y] of roots) expect(evalRationalZ(z.z_poles, z.z_num, x, y) / scale).toBeLessThan(1e-6);
  });

  it('marks these zeros on a rational surface in z, and not the images of the zeros of the s-plane', () => {
    const { scene } = loadCorpus('complex-domains');
    const layer = structuredClone(scene.panels.main!.layers.find((l) => l.kind === 'surface' && l.source.kind === 'rational_z')) as SurfaceLayer;
    // cos(1.6 t) exp(-0.3 t), whose transform at T = 1 vanishes at 0 and at exp(-0.3) cos(1.6)
    const state: Scene['initial'] = {
      ...scene.initial,
      inputs: {
        T: 1,
        poles: [
          [-0.3, 1.6],
          [-0.3, -1.6],
        ],
        zeros: [[-0.3, 0]],
      },
    };
    const env = { scope: { scene, state, panel: state.panels.p1! }, clock: scene.clock, q: 0 } as LayerEnv;
    const draw = new SurfaceDraw({ scene, theme: { background: '#050505', foreground: '#f2f2ef', grid: '#232320' }, geometry: {} } as never, layer, 'k');
    draw.update(env, layer);
    const shown = (draw as unknown as { cachedZZeros: [number, number][] }).cachedZZeros;
    const xs = sorted(shown).map(([x]) => x);
    expect(xs).toHaveLength(2);
    expect(xs[0]).toBeCloseTo(Math.exp(-0.3) * Math.cos(1.6), 5);
    expect(xs[1]).toBeCloseTo(0, 5);
    for (const [, y] of shown) expect(y).toBeCloseTo(0, 5);
  });
});
