import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MorphDraw } from '../src/runtime/morph';
import { Shared, type DrawContext } from '../src/runtime/renderer';
import { sceneTheme } from '../src/runtime/colors';
import type { MorphLayer } from '../src/scene';
import { baseScene } from './helpers';

describe('the drawing of a morph layer (rule `morph`)', () => {
  it('blends each pixel of a solid line once, since the quads of its segments overlap at their joints', () => {
    const scene = baseScene({ version: '0.6' });
    const ctx = { scene, shared: new Shared(), theme: sceneTheme(scene), disc: new THREE.Texture() } as unknown as DrawContext;
    const layer: MorphLayer = {
      kind: 'morph',
      map: 'conformal_exp',
      alpha: 1,
      period: 1,
      items: [
        { kind: 'line', from: [0, -1], to: [0, 1], opacity: 0.5 },
        { kind: 'line', from: [-1, 0], to: [1, 0] },
        { kind: 'line', from: [-1, 1], to: [1, 1], dash: [4, 2] },
        { kind: 'region', u: [-1, 0], v: [0, 1] },
      ],
    };
    const draw = new MorphDraw(ctx, layer, 'key', 3);
    const [first, second, dashed, region] = draw.group.children.map((o) => (o as THREE.Mesh).material as THREE.Material);
    for (const m of [first!, second!]) {
      expect(m.stencilWrite).toBe(true);
      expect(m.stencilFunc).toBe(THREE.NotEqualStencilFunc);
      expect(m.stencilZPass).toBe(THREE.ReplaceStencilOp);
    }
    // two lines carry different marks, so that the later line is still drawn over the earlier one where they cross
    expect(first!.stencilRef).not.toBe(second!.stencilRef);
    // the marks of flat trajectories layers are the low ones
    expect(Math.min(first!.stencilRef, second!.stencilRef)).toBeGreaterThanOrEqual(128);
    expect(dashed!.stencilWrite).toBe(false);
    expect(region!.stencilWrite).toBe(false);
    draw.dispose();
  });
});
