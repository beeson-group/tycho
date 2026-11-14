// Tests the controls of a panel's camera under Node, with a stand-in for the element they listen on.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PanelAreaRenderer } from '../src/runtime/renderer';
import type { Camera } from '../src/scene';

/** An element that takes the listeners of the controls and never calls them. */
function element(): object {
  const listens = { addEventListener() {}, removeEventListener() {} };
  return { ...listens, ownerDocument: listens, style: {} };
}

/** A panel with a camera of `spec` and its controls, aimed at `target` from `from`, as a fit aims it, and its renderer. */
function panel(spec: Camera, from: [number, number, number], target: [number, number, number] = [0, 0, 0]) {
  const stage = Object.assign(Object.create(PanelAreaRenderer.prototype), { panels: new Map(), onChange() {} });
  const p = stage.panel('p');
  p.element = element();
  stage.setCamera(p, spec);
  p.camera.position.set(...from);
  p.camera.lookAt(...target);
  p.controls.target.set(...target);
  p.controls.update();
  return Object.assign(p as { camera: THREE.Camera; controls: { rotateLeft(a: number): void; rotateUp(a: number): void } }, {
    stage: stage as PanelAreaRenderer,
  });
}

/** Where a point of the scene lies on the screen of a camera, as x to the right and y up, from -1 to 1. */
function onScreen(camera: THREE.Camera, x: number, y: number, z: number): THREE.Vector3 {
  camera.updateMatrixWorld();
  return new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse);
}

const along = (v: THREE.Vector3, axis: 'x' | 'y' | 'z') => v[axis];
const around = (v: THREE.Vector3, axis: 'x' | 'y' | 'z') => Math.hypot(...(['x', 'y', 'z'] as const).filter((a) => a !== axis).map((a) => v[a]));

describe('the controls of an 3d camera', () => {
  for (const up of ['x', 'y', 'z'] as const) {
    it(`turn a drag across the panel about the up axis ${up}, as a turntable`, () => {
      const from: [number, number, number] = up === 'x' ? [2.7, 3, -4.8] : up === 'y' ? [-4.8, 2.7, 3] : [3, -4.8, 2.7];
      const p = panel({ kind: '3d', up }, from);
      expect(p.camera.up.toArray()).toEqual(['x', 'y', 'z'].map((a) => (a === up ? 1 : 0)));
      const before = p.camera.position.clone();
      p.controls.rotateLeft(0.7);
      const after = p.camera.position.clone();
      // the camera moved, at the height and the distance from the up axis where it was
      expect(after.distanceTo(before)).toBeGreaterThan(1);
      expect(along(after, up)).toBeCloseTo(along(before, up), 9);
      expect(around(after, up)).toBeCloseTo(around(before, up), 9);
    });
  }

  it('tilt a drag up the panel toward the up axis, at the azimuth where the camera was', () => {
    const p = panel({ kind: '3d', up: 'z' }, [3, -4.8, 2.7]);
    const azimuth = (v: THREE.Vector3) => Math.atan2(v.y, v.x);
    const before = p.camera.position.clone();
    p.controls.rotateUp(0.3);
    const after = p.camera.position.clone();
    expect(azimuth(after)).toBeCloseTo(azimuth(before), 9);
    expect(after.length()).toBeCloseTo(before.length(), 9);
    expect(after.z).not.toBeCloseTo(before.z, 3);
  });
});

describe('the keys of an 3d camera', () => {
  it('show the view from the side of an axis, at the distance of the camera, with the up axis up the screen', () => {
    const p = panel({ kind: '3d', up: 'z' }, [3, -4.8, 2.7], [1, 1, 0]);
    const distance = p.camera.position.distanceTo(new THREE.Vector3(1, 1, 0));
    p.stage.viewFrom('p', 'x', 1);
    expect(p.camera.position.x).toBeCloseTo(1 + distance, 9);
    expect(p.camera.position.y).toBeCloseTo(1, 9);
    expect(p.camera.position.z).toBeCloseTo(0, 9);
    // z runs up the screen, and y to the right, as in a plot of y and z seen from +x
    expect(onScreen(p.camera, 1, 1, 1).y).toBeGreaterThan(onScreen(p.camera, 1, 1, 0).y);
    expect(onScreen(p.camera, 1, 2, 0).x).toBeGreaterThan(onScreen(p.camera, 1, 1, 0).x);
    p.stage.viewFrom('p', 'y', -1);
    expect(p.camera.position.x).toBeCloseTo(1, 9);
    expect(p.camera.position.y).toBeCloseTo(1 - distance, 9);
  });

  it('show the view along the up axis as a plot of the other two, with the first to the right and the second up', () => {
    const p = panel({ kind: '3d', up: 'z' }, [3, -4.8, 2.7]);
    p.stage.viewFrom('p', 'z', 1);
    const o = onScreen(p.camera, 0, 0, 0);
    expect(onScreen(p.camera, 1, 0, 0).x - o.x).toBeCloseTo(1, 3);
    expect(onScreen(p.camera, 0, 1, 0).y - o.y).toBeCloseTo(1, 3);
    // from below, the second axis is still up the screen, and the first then runs to the left
    p.stage.viewFrom('p', 'z', -1);
    const b = onScreen(p.camera, 0, 0, 0);
    expect(onScreen(p.camera, 0, 1, 0).y - b.y).toBeCloseTo(1, 3);
    expect(onScreen(p.camera, 1, 0, 0).x - b.x).toBeCloseTo(-1, 3);
  });

  it('turn the view about the up axis, as a drag to the right turns it', () => {
    const a = panel({ kind: '3d', up: 'z' }, [3, -4.8, 2.7]);
    const b = panel({ kind: '3d', up: 'z' }, [3, -4.8, 2.7]);
    a.stage.turnBy('p', 90);
    b.controls.rotateLeft(Math.PI / 2);
    expect(a.camera.position.toArray().map((v) => +v.toFixed(9))).toEqual(b.camera.position.toArray().map((v) => +v.toFixed(9)));
    expect(a.camera.position.z).toBeCloseTo(2.7, 9);
    expect(Math.hypot(a.camera.position.x, a.camera.position.y)).toBeCloseTo(Math.hypot(3, -4.8), 9);
  });

  it('leave a panel of a 2d camera as it is', () => {
    const p = panel({ kind: '2d', plane: 'xy' }, [0, 0, 5]);
    const before = p.camera.position.clone();
    p.stage.viewFrom('p', 'x', 1);
    p.stage.turnBy('p', 90);
    expect(p.camera.position.toArray()).toEqual(before.toArray());
    expect(p.stage.orbitPanels()).toEqual([]);
  });
});
