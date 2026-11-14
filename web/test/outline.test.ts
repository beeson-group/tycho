// Tests the screen geometry of an inset box layer (rule `inset-box`), which is drawn only, hence it is not covered by the conformance corpus.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { outlinePaths, outlineTriangles, strokeTriangles, widen } from '../src/runtime/outline';
import { insetBoxShownPanel, outlineCorners, planeView } from '../src/runtime/renderer';
import type { InsetBoxLayerResult, Vec3 } from '../src/evaluate/types';

type Vec2 = [number, number];
const square = (x0: number, y0: number, x1: number, y1: number): [Vec2, Vec2, Vec2, Vec2] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

describe('the minimum size of an outline', () => {
  it('stretches a narrow outline about its center along the narrow axis only', () => {
    expect(widen(square(10, 20, 14, 80), 12)).toEqual(square(6, 20, 18, 80));
  });
  it('opens a degenerate outline to the minimum size', () => {
    // the ring is opened along x on its second side and along y on its first, hence it runs the other way round
    expect(widen(square(50, 50, 50, 50), 8)).toEqual([
      [46, 46],
      [46, 54],
      [54, 54],
      [54, 46],
    ]);
  });
  it('opens an outline collapsed to a vertical line across the line', () => {
    expect(widen(square(30, 0, 30, 60), 8)).toEqual(square(26, 0, 34, 60));
  });
  it('leaves an outline larger than the minimum alone', () => {
    expect(widen(square(0, 0, 100, 40), 12)).toEqual(square(0, 0, 100, 40));
  });
});

describe('the paths of an outline', () => {
  it('is one closed ring when it is solid and inside the panel', () => {
    const { closed, paths } = outlinePaths(square(10, 10, 90, 60), 100, 100);
    expect(closed).toBe(true);
    expect(paths).toEqual([square(10, 10, 90, 60)]);
  });
  it('cuts dashes of the given length along the ring, through the corners', () => {
    const { closed, paths } = outlinePaths(square(0, 0, 10, 10), 100, 100, [4, 2]);
    expect(closed).toBe(false);
    // a perimeter of 40 pixels holds dashes starting at 0, 6, 12, 18, 24, 30, and 36
    expect(paths.length).toBe(7);
    // the dash from 18 to 22 turns the corner at (10, 10)
    expect(paths[3]).toEqual([
      [10, 8],
      [10, 10],
      [8, 10],
    ]);
  });
  it('does not lay out a ring that misses the panel', () => {
    expect(outlinePaths(square(200, 200, 300, 300), 100, 100, [4, 2]).paths).toEqual([]);
  });
  it('lays out only the dashes near the panel when the ring is far larger than the panel', () => {
    const { paths } = outlinePaths(square(-1e9, -1e9, 50, 50), 100, 100, [4, 3]);
    // two sides of the ring cross the panel, each over about 66 pixels with the margin
    expect(paths.length).toBeGreaterThan(10);
    expect(paths.length).toBeLessThan(30);
    for (const p of paths) for (const [x, y] of p) expect(Math.abs(x) + Math.abs(y)).toBeLessThan(500);
  });
});

describe('the stroke of an outline', () => {
  it('miters the corners of a closed ring', () => {
    const tri = strokeTriangles(square(0, 0, 10, 10), true, 2);
    expect(tri.length).toBe(4 * 6 * 2);
    const xs = tri.filter((_, i) => i % 2 === 0);
    const ys = tri.filter((_, i) => i % 2 === 1);
    // the outer corners of a square ring 2 pixels wide are 1 pixel out along both axes
    for (const v of [...xs, ...ys])
      expect(v).toBeCloseTo(
        [-1, 1, 9, 11].reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a)),
        9,
      );
    expect(Math.min(...xs)).toBeCloseTo(-1, 9);
    expect(Math.max(...ys)).toBeCloseTo(11, 9);
  });
  it('lays out nothing for an outline off the panel', () => {
    expect(outlineTriangles(square(200, 200, 300, 300), 100, 100, { width: 1, minSize: 8 })).toEqual([]);
  });
});

describe('the corners of an outline', () => {
  const map = (scale: number): InsetBoxLayerResult & { origin: Vec3; axes: [Vec3, Vec3, Vec3] } => ({
    kind: 'inset_box',
    panel: 'closeup',
    shown_panel: 'b',
    frame: 'zoom',
    origin: [0, 0, 0],
    axes: [
      [scale, 0, 0],
      [0, scale, 0],
      [0, 0, scale],
    ],
  });
  const plane = { kind: '2d', plane: 'xy' } as const;
  it('outlines the shown panel of the target, whose id differs from the declared id of a copy', () => {
    expect(insetBoxShownPanel(map(0.5))).toBe('b');
    expect(insetBoxShownPanel({ ...map(0.5), origin: null })).toBeNull();
    expect(insetBoxShownPanel(null)).toBeNull();
  });
  it('maps the target camera rectangle into the host camera panel', () => {
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    const view = planeView(camera, plane, 200, 100);
    const corners = outlineCorners(map(0.5), view, plane, camera, plane, 200, 100)!;
    const expected = square(50, 75, 150, 25);
    corners.forEach((c, i) => {
      expect(c[0]).toBeCloseTo(expected[i]![0], 9);
      expect(c[1]).toBeCloseTo(expected[i]![1], 9);
    });
  });
  it('hides the outline when a corner is behind a perspective camera', () => {
    const camera = new THREE.PerspectiveCamera(45, 2, 0.1, 100);
    camera.position.set(0, 0, 0.5);
    camera.lookAt(0, 0, 0);
    const view = planeView(new THREE.OrthographicCamera(-1, 1, 1, -1), plane, 200, 100);
    const orbit = { kind: '3d' } as const;
    expect(outlineCorners(map(1), { ...view, x0: -1, x1: 1, y0: -1, y1: 1 }, plane, camera, orbit, 200, 100)).not.toBeNull();
    camera.position.set(0, 0, -0.5);
    camera.lookAt(0, 0, -1);
    expect(outlineCorners(map(1), { ...view, x0: -1, x1: 1, y0: -1, y1: 1 }, plane, camera, orbit, 200, 100)).toBeNull();
  });
});
