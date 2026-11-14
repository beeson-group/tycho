// Tests the controls of a panel's camera under Node, with a stand-in for the element they listen on.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { StageRenderer } from '../src/runtime/renderer';
import type { Camera } from '../src/scene';

/** An element that takes the listeners of the controls and never calls them. */
function element(): object {
  const listens = { addEventListener() {}, removeEventListener() {} };
  return { ...listens, ownerDocument: listens, style: {} };
}

/** A panel with a camera of `spec` and its controls, aimed at the origin from `from`, as a fit aims it. */
function panel(spec: Camera, from: [number, number, number]) {
  const stage = Object.assign(Object.create(StageRenderer.prototype), { panels: new Map(), onChange() {} });
  const p = stage.panel('p');
  p.element = element();
  stage.setCamera(p, spec);
  p.camera.position.set(...from);
  p.camera.lookAt(0, 0, 0);
  p.controls.target.set(0, 0, 0);
  p.controls.update();
  return p as { camera: THREE.Camera; controls: { rotateLeft(a: number): void; rotateUp(a: number): void } };
}

const along = (v: THREE.Vector3, axis: 'x' | 'y' | 'z') => v[axis];
const around = (v: THREE.Vector3, axis: 'x' | 'y' | 'z') => Math.hypot(...(['x', 'y', 'z'] as const).filter((a) => a !== axis).map((a) => v[a]));

describe('the controls of an orbit camera', () => {
  for (const up of ['x', 'y', 'z'] as const) {
    it(`turn a drag across the panel about the up axis ${up}, as a turntable`, () => {
      const from: [number, number, number] = up === 'x' ? [2.7, 3, -4.8] : up === 'y' ? [-4.8, 2.7, 3] : [3, -4.8, 2.7];
      const p = panel({ kind: 'orbit', up }, from);
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
    const p = panel({ kind: 'orbit', up: 'z' }, [3, -4.8, 2.7]);
    const azimuth = (v: THREE.Vector3) => Math.atan2(v.y, v.x);
    const before = p.camera.position.clone();
    p.controls.rotateUp(0.3);
    const after = p.camera.position.clone();
    expect(azimuth(after)).toBeCloseTo(azimuth(before), 9);
    expect(after.length()).toBeCloseTo(before.length(), 9);
    expect(after.z).not.toBeCloseTo(before.z, 3);
  });
});
