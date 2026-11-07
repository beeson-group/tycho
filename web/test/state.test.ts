import { describe, expect, it } from 'vitest';
import type { Scene, State } from '../src/scene';
import { fnv1a, newPanelId, repair, storageKey, Store, swapLeaves, withChannel, withDrop, withoutPanel, withVariable } from '../src/runtime/state';
import { loadCorpus } from './corpus';

// the two-panels scene has one view v, the clock channels t and @index, and the variables frame (choice, panel),
// k (selector by index, panel), e (selector by nearest, scene), and group (choice, scene).
const scene = (): Scene => loadCorpus('two-panels').scene;

const stored = (over: Partial<State> = {}): State => ({
  variables: { e: 0.3, group: 'moving' },
  clock: { channel: '@index' },
  panels: {
    p1: { view: 'v', variables: { frame: 'rot', k: 1 } },
    p2: { view: 'v', variables: { frame: 'tilt' } },
    p3: { view: 'v', variables: { k: 2 } },
  },
  layout: {
    kind: 'split',
    dir: 'row',
    ratio: 0.4,
    a: { kind: 'panel', id: 'p1' },
    b: { kind: 'split', dir: 'col', ratio: 0.7, a: { kind: 'panel', id: 'p2' }, b: { kind: 'panel', id: 'p3' } },
  },
  ...over,
});

describe('repair (section 2.8)', () => {
  it('keeps a valid stored state as it is, and does not modify its input', () => {
    const s = stored();
    const copy = structuredClone(s);
    expect(repair(scene(), s)).toEqual(copy);
    expect(s).toEqual(copy);
  });

  it('falls back to initial on anything that is not a state', () => {
    for (const bad of [null, 3, 'state', [], {}, { clock: { channel: 't' } }, { ...stored(), layout: { kind: 'tree' } }]) {
      expect(repair(scene(), bad)).toEqual(scene().initial);
    }
  });

  it('falls back to initial when the clock channel is unknown', () => {
    expect(repair(scene(), stored({ clock: { channel: 'time' } }))).toEqual(scene().initial);
  });

  it('drops a panel whose view the scene lacks, with its layout leaf, collapsing the split', () => {
    const s = stored();
    s.panels.p2 = { view: 'gone' };
    const r = repair(scene(), s);
    expect(Object.keys(r.panels).sort()).toEqual(['p1', 'p3']);
    expect(r.layout).toEqual({ kind: 'split', dir: 'row', ratio: 0.4, a: { kind: 'panel', id: 'p1' }, b: { kind: 'panel', id: 'p3' } });
  });

  it('falls back to initial once every panel is dropped', () => {
    const s = stored();
    for (const p of Object.values(s.panels)) p!.view = 'gone';
    expect(repair(scene(), s)).toEqual(scene().initial);
  });

  it('drops a value that does not fit its variable, in the scene and in a panel', () => {
    const s = stored({ variables: { e: 'high', group: 'nowhere' } });
    s.panels.p1!.variables = { frame: 'inertial', k: true };
    s.panels.p2!.variables = { frame: 4, k: 2 };
    const r = repair(scene(), s);
    expect(r.variables).toEqual({});
    expect(r.panels.p1!.variables).toEqual({});
    expect(r.panels.p2!.variables).toEqual({ k: 2 });
  });

  it('drops a panel value of a scene-scoped variable, and values that a reader never reads', () => {
    const s = stored({ variables: { e: 0.3, frame: 'rot', unknown: 1 } });
    s.panels.p1!.variables = { frame: 'rot', e: 0.5, group: 'moving', other: 'x' };
    const r = repair(scene(), s);
    expect(r.variables).toEqual({ e: 0.3 });
    expect(r.panels.p1!.variables).toEqual({ frame: 'rot' });
  });

  it('drops a leaf without a panel, a panel without a leaf, a repeated leaf, and a bad ratio', () => {
    const s = stored();
    s.layout = {
      kind: 'split',
      dir: 'row',
      ratio: 1.5,
      a: { kind: 'split', dir: 'col', ratio: 0.5, a: { kind: 'panel', id: 'p1' }, b: { kind: 'panel', id: 'ghost' } },
      b: { kind: 'split', dir: 'col', ratio: 0.5, a: { kind: 'panel', id: 'p2' }, b: { kind: 'panel', id: 'p1' } },
    };
    const r = repair(scene(), s);
    expect(Object.keys(r.panels).sort()).toEqual(['p1', 'p2']);
    expect(r.layout).toEqual({ kind: 'split', dir: 'row', ratio: 0.5, a: { kind: 'panel', id: 'p1' }, b: { kind: 'panel', id: 'p2' } });
  });

  it('drops a panel whose id is not an identifier, and keeps "__proto__" as an own key', () => {
    const s = JSON.parse(
      '{"clock":{"channel":"t"},"panels":{"__proto__":{"view":"v"},"a b":{"view":"v"}},' +
        '"layout":{"kind":"split","dir":"row","ratio":0.5,"a":{"kind":"panel","id":"__proto__"},"b":{"kind":"panel","id":"a b"}}}',
    ) as unknown;
    const r = repair(scene(), s);
    expect(Object.keys(r.panels)).toEqual(['__proto__']);
    expect(Object.hasOwn(r.panels, '__proto__')).toBe(true);
    expect(r.layout).toEqual({ kind: 'panel', id: '__proto__' });
  });
});

describe('storage key', () => {
  it('is the FNV-1a hash of the UTF-8 bytes of scene.tys', () => {
    expect(fnv1a('')).toBe('811c9dc5');
    expect(fnv1a('a')).toBe('e40c292c');
    expect(fnv1a('foobar')).toBe('bf9cf968');
    const text = loadCorpus('two-panels').text;
    expect(storageKey(text)).toBe(storageKey(`${text}`));
    expect(storageKey(text)).not.toBe(storageKey(`${text} `));
  });
});
