// Tests the copy of a panel's static layers under Node, with a stub in place of the WebGL renderer.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { StageRenderer } from '../src/runtime/renderer';

/** Copies a panel's region `r` into a target of 782 by 600 px, and returns where the copy ends. */
function copyEnd(r: THREE.Vector4): { x: number; y: number } {
  let end = { x: 0, y: 0 };
  const gl = {
    setRenderTarget() {},
    clear() {},
    render() {},
    copyTextureToTexture(_source: THREE.Texture, _target: THREE.Texture, region: THREE.Box2, corner: THREE.Vector2) {
      end = { x: corner.x + region.max.x - region.min.x, y: corner.y + region.max.y - region.min.y };
    },
  };
  const stage = Object.assign(Object.create(StageRenderer.prototype), { gl, scratch: null, region: new THREE.Box2(), corner: new THREE.Vector2() });
  stage.drawFine({ staticScene: new THREE.Scene(), camera: new THREE.Camera() }, new THREE.WebGLRenderTarget(782, 600), r);
  return end;
}

describe('the copy of static layers', () => {
  it('stops at the end of the target when the viewport is rounded up past it', () => {
    // 626 CSS px at a pixel ratio of 1.25 are a viewport of 783 px and a drawing buffer of 782 px
    expect(copyEnd(new THREE.Vector4(0, 0, 783, 600))).toEqual({ x: 782, y: 600 });
    expect(copyEnd(new THREE.Vector4(400, 100, 383, 501))).toEqual({ x: 782, y: 600 });
  });

  it('keeps the whole region of a panel inside the target', () => {
    expect(copyEnd(new THREE.Vector4(10, 20, 300, 200))).toEqual({ x: 310, y: 220 });
  });
});
