import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { companionSystem, conformalExp, evalRationalS, evalRationalZ, evalTimeResponse, impulseInvariantZ, mapHeight } from '../src/evaluate/complex.js';
import { surfaceLayer, type LayerEnv } from '../src/evaluate/layers.js';
import { readoutPieces, readoutText } from '../src/runtime/readouts.js';
import { PoleZeroPicker, snapPickerPoint } from '../src/runtime/picker.js';
import { GeometryCache } from '../src/runtime/geometry.js';
import { withInput } from '../src/runtime/state.js';
import { SurfaceDraw } from '../src/runtime/surface.js';
import type { DataArray, DataStore } from '../src/container.js';
import { TychoError } from '../src/errors.js';
import type { Control, Scene, SurfaceLayer } from '../src/scene.js';
import { validate } from '../src/validate.js';
import { byClass, installDom } from './dom-shim.js';

function cMul(a: [number, number], b: [number, number]): [number, number] {
  return [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
}

function cAdd(a: [number, number], b: [number, number]): [number, number] {
  return [a[0] + b[0], a[1] + b[1]];
}

function cDiv(a: [number, number], b: [number, number]): [number, number] {
  const d = b[0] * b[0] + b[1] * b[1];
  return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
}

function minimalScene06(): { scene: Scene; data: DataStore } {
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
    requires: ['inputs.number', 'inputs.points_2d', 'layers.morph', 'layers.surface', 'controls.action'],
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
      poles: { kind: 'points_2d', default: [[-0.8, 0.0]], min_points: 1, max_points: 6 },
      zeros: { kind: 'points_2d', default: [], min_points: 0, max_points: 5 },
    },
    clock: { mode: 'epoch', channels: ['t'], range: [0, 1], frame_count: 10, seconds: 5, end: 'stop' },
    steps: [{ id: 's0', at: 0, label: 'Start' }],
    panels: {
      main: {
        frame: 's',
        reference: { sets: { set: 'ref' }, member: { index: 0 } },
        layers: [
          {
            kind: 'surface',
            source: { kind: 'rational_s', poles: { input: 'poles' }, zeros: { input: 'zeros' }, period: { input: 'T' }, x: [-2, 2], y: [-2, 2] },
          },
        ],
      },
    },
    controls: [{ kind: 'action', label: 'Go', from: 's0', to: 2 }],
    readouts: [{ place: 'caption', parts: ['ROC: ', { roc_status: { poles: { input: 'poles' }, period: { input: 'T' } } }] }],
    initial: { inputs: {}, clock: { channel: 't' }, panels: { main: { panel: 'main' } }, layout: { kind: 'panel', id: 'main' } },
  };
  return { scene, data };
}

describe('complex-domain evaluation and 0.6 controls', () => {
  it('evaluates conformalExp smoothly near alpha = 0 and matches exp(sT) at alpha = 1', () => {
    expect(conformalExp(-1.2, 0.9, 0.0, 0.7)).toEqual([-1.2, 0.9]);
    const [x, y] = conformalExp(-0.5, 1.2, 1.0, 0.8);
    expect(x).toBeCloseTo(Math.exp(-0.4) * Math.cos(0.96), 12);
    expect(y).toBeCloseTo(Math.exp(-0.4) * Math.sin(0.96), 12);
  });

  it('matches HLT Z-transform formulas including repeated poles', () => {
    const t = 0.6;
    const t2 = impulseInvariantZ(
      [
        [0, 0],
        [0, 0],
        [0, 0],
      ],
      [],
      1.0,
      t,
    );
    const z: [number, number] = [1.4, -0.7];
    let num: [number, number] = [0, 0];
    for (let i = t2.z_num.length - 1; i >= 0; i--) num = cAdd(cMul(num, z), t2.z_num[i]!);
    let den: [number, number] = [1, 0];
    for (const p of t2.z_poles) den = cMul(den, [z[0] - p[0], z[1] - p[1]]);
    const got = cDiv(num, den);
    const zm1 = [z[0] - 1, z[1]] as [number, number];
    const zm1Cubed = cMul(cMul(zm1, zm1), zm1);
    const want = cDiv(cMul([t * t, 0], cMul(z, [z[0] + 1, z[1]])), [2 * zm1Cubed[0], 2 * zm1Cubed[1]]);
    expect(Math.hypot(got[0] - want[0], got[1] - want[1])).toBeLessThan(1e-10);
    expect(evalRationalZ(t2.z_poles, t2.z_num, z[0], z[1])).toBeCloseTo(Math.hypot(want[0], want[1]), 10);
    expect(evalRationalS([[-1, 0]], [], 2, 0, 0)).toBeCloseTo(2, 12);
    expect(mapHeight(10, 'linear', { max: 4, softness: 0.45 }, 0.5, 0.5)).toBeCloseTo(1.0, 3);
  });

  it('evaluates time-domain responses accurately and guards companion realization', () => {
    expect(() => companionSystem([], [], 1)).toThrow();
    const r = evalTimeResponse(
      [
        [-0.5, 1.8],
        [-0.5, -1.8],
      ],
      [],
      1.8,
      0.5,
      4,
      41,
    );
    for (let i = 0; i < r.t.length; i++) {
      expect(r.f[i]).toBeCloseTo(Math.exp(-0.5 * r.t[i]!) * Math.sin(1.8 * r.t[i]!), 10);
    }
  });

  it('validates 0.6 rules including action controls and roc_status', () => {
    const { scene, data } = minimalScene06();
    expect(() => validate(scene, data)).not.toThrow();

    const badAction = structuredClone(scene);
    badAction.controls = [{ kind: 'action', label: 'Bad', from: 'missing', to: 1 }];
    expect(() => validate(badAction, data)).toThrow(TychoError);

    const badRange = structuredClone(scene);
    badRange.controls = [{ kind: 'slider', input: 'T', label: 'T', show_range: [3, 1] }];
    expect(() => validate(badRange, data)).toThrow(TychoError);

    const badRoc = structuredClone(scene);
    badRoc.readouts = [{ place: 'caption', parts: [{ roc_status: { poles: { input: 'T' } } }] }];
    expect(() => validate(badRoc, data)).toThrow(TychoError);

    const withIrisAndClip = structuredClone(scene);
    withIrisAndClip.panels.main!.layers = [
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
      {
        kind: 'surface',
        source: { kind: 'rational_s', poles: { input: 'poles' }, zeros: { input: 'zeros' }, period: { input: 'T' }, x: [-2, 2], y: [-2, 2] },
        slices: { clip: true },
      },
    ];
    expect(() => validate(withIrisAndClip, data)).not.toThrow();

    const badOrigin = structuredClone(withIrisAndClip);
    (badOrigin.panels.main!.layers[0] as { items: Array<Record<string, unknown>> }).items[0]!.reveal_origin = [0];
    expect(() => validate(badOrigin, data)).toThrow(TychoError);

    const badClip = structuredClone(withIrisAndClip);
    (badClip.panels.main!.layers[1] as { slices?: Record<string, unknown> }).slices!.clip = 'yes';
    expect(() => validate(badClip, data)).toThrow(TychoError);
  });

  it('formats roc_status readouts and copies points_2d arrays cleanly on withInput', () => {
    const { scene, data } = minimalScene06();
    const geo = new GeometryCache(scene, data);
    const parts = scene.readouts![0]!.parts;
    const stableText = readoutText({ scene, geometry: geo, state: scene.initial, panel: 'main', frameIndex: 0 }, parts);
    expect(stableText).toContain('Causal ROC: σ > −0.80, |z| > 0.45 (FT & DTFT converge)');
    expect(stableText).not.toContain('⚠');

    const unstableState = withInput(scene, scene.initial, 'poles', [[0.2, 0.0]]);
    expect(scene.initial.inputs?.poles).toBeUndefined();
    const pieces = readoutPieces({ scene, geometry: geo, state: unstableState, panel: 'main', frameIndex: 0 }, parts);
    const joined = pieces.join('');
    expect(joined).toContain('Causal ROC: σ > 0.20, |z| > 1.22 (FT & DTFT diverge) ⚠');
    expect(joined.endsWith('⚠')).toBe(true);
  });

  it('keeps magnetic axis snapping disabled until the picker Snap toggle is checked', () => {
    const { doc, uninstall } = installDom();
    const prevDoc = globalThis.document;
    globalThis.document = doc as unknown as Document;
    try {
      const updates: [string, unknown][] = [];
      const ctrl: Extract<Control, { kind: 'points_2d' }> = { kind: 'points_2d', input: 'poles', label: 'Poles & Zeros (s)' };
      const picker = new PoleZeroPicker(ctrl, false, (u) => {
        updates.push(...u);
      });
      const pad = byClass(picker.el as never, 'pz-canvas')[0]!;
      pad.getContext = () => null;
      pad.getBoundingClientRect = () => ({ left: 0, top: 0, right: 224, bottom: 172, width: 224, height: 172, x: 0, y: 0 });
      const snapBox = byClass(picker.el as never, 'pz-snap')[0]!.children[0]!;
      expect(snapBox.checked).toBe(false);

      // Default pole sits at [-0.8, 0] -> drag slightly off the real axis (3 px above oy = 86) with Snap OFF
      const [ox, oy] = [((0 - -3) / 5) * 224, ((3.5 - 0) / 7) * 172];
      const [pxPole, pyPole] = [((-0.8 - -3) / 5) * 224, oy];
      pad.dispatchEvent({ type: 'pointerdown', button: 0, clientX: pxPole, clientY: pyPole, pointerId: 1 });
      pad.dispatchEvent({ type: 'pointermove', clientX: ox + 3, clientY: oy - 3, pointerId: 1, buttons: 1, shiftKey: false });
      const unsnapped = updates.at(-1)![1] as [number, number][];
      expect(unsnapped[0]![0]).not.toBe(0);
      expect(unsnapped[0]![1]).not.toBe(0);

      // Check Snap ON and drag within 3 px of origin -> both coordinates snap cleanly to zero
      snapBox.checked = true;
      snapBox.dispatchEvent({ type: 'change' });
      pad.dispatchEvent({ type: 'pointermove', clientX: ox + 3, clientY: oy - 3, pointerId: 1, buttons: 1, shiftKey: false });
      const snapped = updates.at(-1)![1] as [number, number][];
      expect(snapped[0]).toEqual([0, 0]);
    } finally {
      globalThis.document = prevDoc;
      uninstall();
    }
  });

  it('ties a drag on the pad to the pointer that began it, and ends the drag when the pointer is released, canceled, or loses its capture', () => {
    const { doc, uninstall } = installDom();
    const prevDoc = globalThis.document;
    globalThis.document = doc as unknown as Document;
    try {
      const { scene } = minimalScene06();
      const theme = { background: '#050505', foreground: '#f2f2ef', grid: '#232320' };
      const ctrl: Extract<Control, { kind: 'points_2d' }> = { kind: 'points_2d', input: 'poles', label: 'Poles & Zeros (s)', conjugate_lock: false };
      let state = scene.initial;
      let picker: PoleZeroPicker;
      const sync = () => picker.sync({ scene, state, panel: state.panels.main! }, theme);
      picker = new PoleZeroPicker(ctrl, false, (updates) => {
        state = updates.reduce((acc, [id, val]) => withInput(scene, acc, id, val), state);
        sync();
      });
      const pad = byClass(picker.el as never, 'pz-canvas')[0]!;
      pad.getContext = () => null;
      pad.getBoundingClientRect = () => ({ left: 0, top: 0, right: 224, bottom: 172, width: 224, height: 172, x: 0, y: 0 });
      sync();
      const px = (x: number) => ((x + 3) / 5) * 224;
      const py = (y: number) => ((3.5 - y) / 7) * 172;
      const pole = () => ((state.inputs?.poles ?? scene.inputs!.poles!.default) as [number, number][])[0]!;
      const down = (pointerId: number) =>
        pad.dispatchEvent({
          type: 'pointerdown',
          button: 0,
          clientX: px(pole()[0]),
          clientY: py(pole()[1]),
          pointerId,
          preventDefault() {},
          stopPropagation() {},
        });
      const move = (pointerId: number, x: number, y: number, buttons = 1) =>
        pad.dispatchEvent({ type: 'pointermove', clientX: px(x), clientY: py(y), pointerId, buttons, shiftKey: false, stopPropagation() {} });

      // a second finger does not move the pole that the first one holds
      down(1);
      move(2, 1, 2);
      expect(pole()).toEqual([-0.8, 0]);
      move(1, -1, 1);
      expect(pole()[0]).toBeCloseTo(-1);
      expect(pole()[1]).toBeCloseTo(1);
      // the end of another pointer leaves the drag alone
      pad.dispatchEvent({ type: 'pointerup', pointerId: 2 });
      move(1, -1.5, 1);
      expect(pole()[0]).toBeCloseTo(-1.5);

      for (const end of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        const before = pole();
        down(1);
        pad.dispatchEvent({ type: end, pointerId: 1 });
        move(1, 1, 2);
        move(2, 1, 2);
        expect(pole(), end).toEqual(before);
      }

      // a release that the pad did not see, as when the viewer left the page during the drag, ends the drag at the next move
      const before = pole();
      down(1);
      move(1, 1, 2, 0);
      move(1, 1, 2);
      expect(pole()).toEqual(before);
    } finally {
      globalThis.document = prevDoc;
      uninstall();
    }
  });

  it('snaps pole-zero picker coordinates to both complex axes within 10 px', () => {
    const bounds: [[number, number], [number, number]] = [
      [-3, 2],
      [-3.5, 3.5],
    ];
    const ox = (3 / 5) * 224;
    const oy = (3.5 / 7) * 172;

    const nearImag = snapPickerPoint(ox + 8, oy - 25, bounds, true);
    expect(nearImag.snappedX).toBe(true);
    expect(nearImag.x).toBe(0);
    expect(nearImag.snappedY).toBe(false);

    const nearReal = snapPickerPoint(ox - 30, oy - 9, bounds, true);
    expect(nearReal.snappedY).toBe(true);
    expect(nearReal.y).toBe(0);
    expect(nearReal.snappedX).toBe(false);

    const nearOrigin = snapPickerPoint(ox - 6, oy + 7, bounds, true);
    expect(nearOrigin).toEqual({ x: 0, y: 0, snappedX: true, snappedY: true });

    const released = snapPickerPoint(ox + 12, oy - 14, bounds, true);
    expect(released.snappedX).toBe(false);
    expect(released.snappedY).toBe(false);
    expect(released.x).not.toBe(0);
    expect(released.y).not.toBe(0);

    const bypassed = snapPickerPoint(ox + 4, oy + 4, bounds, false);
    expect(bypassed.snappedX).toBe(false);
    expect(bypassed.snappedY).toBe(false);
    expect(bypassed.x).not.toBe(0);
    expect(bypassed.y).not.toBe(0);
  });

  it('keeps surface depth prepass materials in the transparent bucket with invariant position and slope offset', () => {
    const src = readFileSync(new URL('../src/runtime/surface.ts', import.meta.url), 'utf8');
    const vsMatches = [...src.matchAll(/const SURFACE_(?:RATIONAL|GRID)_VS = \/\* glsl \*\/ `([\s\S]*?)`;/g)];
    expect(vsMatches.length).toBe(2);
    for (const m of vsMatches) expect(m[1]).toContain('invariant gl_Position;');
    const blocks = [...src.matchAll(/this\.depthMat\s*=\s*new THREE\.ShaderMaterial\(\{([\s\S]*?)\}\);/g)];
    expect(blocks.length).toBe(2);
    for (const m of blocks) {
      expect(m[1]).toContain('transparent: true');
      expect(m[1]).toContain('polygonOffset: true');
      expect(m[1]).toContain('polygonOffsetFactor: 1');
      expect(m[1]).toContain('polygonOffsetUnits: 4');
    }
  });

  it('syncs PoleZeroPicker buttons and state even when a matching preset update is a no-op or re-entrant', () => {
    const { doc, uninstall } = installDom();
    const prevDoc = globalThis.document;
    globalThis.document = doc as unknown as Document;
    try {
      const theme = { background: '#050505', foreground: '#f2f2ef', grid: '#232320' };
      const { scene } = minimalScene06();
      scene.inputs!.poles = { kind: 'points_2d', default: [[-0.8, 0]], min_points: 1, max_points: 2 };
      scene.inputs!.zeros = { kind: 'points_2d', default: [], min_points: 0, max_points: 2 };
      scene.inputs!.gain = { kind: 'number', min: -5, max: 5, step: 0.1, default: 1 };
      scene.inputs!.preset = { kind: 'choice', values: ['p1', 'p2', 'custom'], default: 'p1' };
      const panelState = scene.initial.panels.main!;
      const ctrl: Extract<Control, { kind: 'points_2d' }> = {
        kind: 'points_2d',
        input: 'poles',
        secondary_input: 'zeros',
        gain_input: 'gain',
        preset_input: 'preset',
        label: 'Poles & Zeros (s)',
        presets: [
          {
            id: 'p1',
            label: 'Two real',
            poles: [
              [-0.6, 0],
              [-0.4, 0],
            ],
            zeros: [[-0.2, 0]],
            gain: 2,
          },
          { id: 'p2', label: 'One real', poles: [[-0.3, 0]], zeros: [], gain: 1 },
        ],
      };

      const pickerNoop = new PoleZeroPicker(ctrl, false, () => {
        // Store update can be a no-op when inputs already match; sync must not bail before syncing buttons/coords.
      });
      for (const cv of byClass(pickerNoop.el as never, 'pz-canvas')) cv.getContext = () => null;
      pickerNoop.sync({ scene, state: { ...scene.initial, inputs: { preset: 'p1' } }, panel: panelState }, theme);
      const noopAddPole = byClass(pickerNoop.el as never, 'pz-actions')[0]!.children[0]!;
      const noopRemove = byClass(pickerNoop.el as never, 'pz-actions')[0]!.children[2]!;
      const noopInfo = byClass(pickerNoop.el as never, 'pz-info')[0]!;
      expect(noopAddPole.disabled).toBe(true);
      expect(noopRemove.disabled).toBe(false);
      expect(noopInfo.textContent).toContain('−0.60');

      let reentrantState = { ...scene.initial, inputs: { preset: 'p1' } as Record<string, unknown> };
      let pickerReenter: PoleZeroPicker;
      pickerReenter = new PoleZeroPicker(ctrl, false, () => {
        if (reentrantState.inputs.preset !== 'p2') {
          reentrantState = {
            ...scene.initial,
            inputs: { preset: 'p2', poles: [[-0.3, 0]], zeros: [], gain: 1 },
          };
          pickerReenter.sync({ scene, state: reentrantState as never, panel: panelState }, theme);
        }
      });
      for (const cv of byClass(pickerReenter.el as never, 'pz-canvas')) cv.getContext = () => null;
      pickerReenter.sync({ scene, state: reentrantState as never, panel: panelState }, theme);
      const reAddPole = byClass(pickerReenter.el as never, 'pz-actions')[0]!.children[0]!;
      const reRemove = byClass(pickerReenter.el as never, 'pz-actions')[0]!.children[2]!;
      expect(reAddPole.disabled).toBe(false);
      expect(reRemove.disabled).toBe(true);
    } finally {
      globalThis.document = prevDoc;
      uninstall();
    }
  });

  it('keeps the poles and the gain that the state holds at the first sync of a new picker, and applies a preset that is chosen later', () => {
    const { doc, uninstall } = installDom();
    const prevDoc = globalThis.document;
    globalThis.document = doc as unknown as Document;
    try {
      const theme = { background: '#050505', foreground: '#f2f2ef', grid: '#232320' };
      const { scene } = minimalScene06();
      scene.inputs!.gain = { kind: 'number', min: -5, max: 5, step: 0.1, default: 1 };
      scene.inputs!.preset = { kind: 'choice', values: ['p1', 'p2'], default: 'p1' };
      const ctrl: Extract<Control, { kind: 'points_2d' }> = {
        kind: 'points_2d',
        input: 'poles',
        secondary_input: 'zeros',
        gain_input: 'gain',
        preset_input: 'preset',
        label: 'Poles & Zeros (s)',
        presets: [
          { id: 'p1', label: 'one', poles: [[-0.6, 0]], zeros: [], gain: 2 },
          { id: 'p2', label: 'two', poles: [[-0.3, 0]], zeros: [], gain: 1 },
        ],
      };
      // what a reload from localStorage or the twin of an export starts from, i.e. a dragged pole and a moved gain under the choice 'p1'
      let state = { ...scene.initial, inputs: { preset: 'p1', poles: [[-1.5, 0]], gain: 4 } } as Scene['initial'];
      const picker = new PoleZeroPicker(ctrl, false, (updates) => {
        state = updates.reduce((acc, [id, val]) => withInput(scene, acc, id, val), state);
      });
      for (const cv of byClass(picker.el as never, 'pz-canvas')) cv.getContext = () => null;
      const sync = () => picker.sync({ scene, state, panel: state.panels.main! }, theme);
      sync();
      expect(state.inputs).toEqual({ preset: 'p1', poles: [[-1.5, 0]], gain: 4 });
      expect(byClass(picker.el as never, 'pz-info')[0]!.textContent).toContain('−1.50');

      state = withInput(scene, state, 'preset', 'p2');
      sync();
      expect(state.inputs).toEqual({ preset: 'p2', poles: [[-0.3, 0]], zeros: [], gain: 1 });
      state = withInput(scene, state, 'preset', 'p1');
      sync();
      expect(state.inputs).toEqual({ preset: 'p1', poles: [[-0.6, 0]], zeros: [], gain: 2 });
    } finally {
      globalThis.document = prevDoc;
      uninstall();
    }
  });

  it('fails by rule `surface` in the draw, as the evaluator does, when a rational surface has more zeros than poles, and draws the next valid state', () => {
    for (const kind of ['rational_s', 'rational_z'] as const) {
      const { scene, data } = minimalScene06();
      const layer = scene.panels.main!.layers[0] as SurfaceLayer;
      layer.source = { ...layer.source, kind } as SurfaceLayer['source'];
      const improper = withInput(scene, scene.initial, 'zeros', [
        [-0.2, 0],
        [-0.3, 0],
      ]);
      const env = (state: Scene['initial']) => ({ scope: { scene, state, panel: state.panels.main! }, clock: scene.clock, q: 0 }) as LayerEnv;
      const thrown = (f: () => void): unknown => {
        try {
          f();
        } catch (e) {
          return e;
        }
        return null;
      };
      const draw = new SurfaceDraw({ scene, theme: { background: '#050505', foreground: '#f2f2ef', grid: '#232320' }, geometry: {} } as never, layer, 'k');
      const e = thrown(() => draw.update(env(improper), layer));
      expect(e, kind).toBeInstanceOf(TychoError);
      expect((e as TychoError).rule).toBe('surface');
      expect((e as TychoError).message).toBe((thrown(() => surfaceLayer(env(improper), layer, data)) as TychoError).message);
      expect(thrown(() => draw.update(env(scene.initial), layer))).toBeNull();
      expect((draw as unknown as { surfaceMat: { uniforms: { uNZeros: { value: number } } } }).surfaceMat.uniforms.uNZeros.value).toBe(0);
    }
  });

  it('meshes a rational surface without a resolution on the 64 by 64 grid that the evaluator samples', () => {
    const { scene, data } = minimalScene06();
    const layer = scene.panels.main!.layers[0] as SurfaceLayer;
    expect(layer.source.kind !== 'grid' && layer.source.resolution).toBeUndefined();
    const env = { scope: { scene, state: scene.initial, panel: scene.initial.panels.main! }, clock: scene.clock, q: 0 } as LayerEnv;
    const { grid } = surfaceLayer(env, layer, data);
    expect(grid).toEqual([64, 64]);
    const draw = new SurfaceDraw({ scene, theme: { background: '#050505', foreground: '#f2f2ef', grid: '#232320' }, geometry: {} } as never, layer, 'k');
    const geo = (draw as unknown as { surfaceGeo: { getAttribute(name: string): { count: number } } }).surfaceGeo;
    expect(geo.getAttribute('position').count).toBe(grid[0] * grid[1]);
  });

  it('scales continuous slice and discrete stem grow heights on the GPU without rebuilding geometry', () => {
    const src = readFileSync(new URL('../src/runtime/surface.ts', import.meta.url), 'utf8');
    const sliceKeyMatch = src.match(/const sliceKey = ([^;]+);/);
    expect(sliceKeyMatch).not.toBeNull();
    expect(sliceKeyMatch![1]).not.toContain('grow');
    const vsMatch = src.match(/const SLICE_VS = \/\* glsl \*\/ `([\s\S]*?)`;/);
    expect(vsMatch).not.toBeNull();
    expect(vsMatch![1]).toContain('uniform float uGrow;');
    expect(vsMatch![1]).toContain('attribute float aZOffset;');
    expect(vsMatch![1]).toContain('position.z * uGrow + aZOffset');
    expect(src).toContain('this.stemDots.points.scale.z = grow;');
  });
});
