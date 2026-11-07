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

describe('store and updates', () => {
  it('notifies on a new snapshot, frame, or playing flag, and not on a no-op', () => {
    const s = scene();
    const store = new Store(s.initial, s.clock.steps);
    const seen: string[] = [];
    store.subscribe((c) => seen.push(c));
    store.set(store.state);
    store.setFrame(-1);
    expect(store.frame).toBe(s.clock.steps - 1);
    store.setFrame(s.clock.steps - 1);
    store.setFrame(0.5);
    store.setPlaying(true);
    store.update((st) => withChannel(st, '@index'));
    store.update((st) => withChannel(st, '@index'));
    expect(seen).toEqual(['frame', 'playing', 'state']);
  });

  it('writes a panel-scoped value in the panel and a scene-scoped one in the scene, refusing what does not fit', () => {
    const s = scene();
    let st = withVariable(s, s.initial, 'frame', 'rot', 'p2');
    expect(st.panels.p2!.variables).toEqual({ frame: 'rot', k: 2.5 });
    expect(st.panels.p1).toBe(s.initial.panels.p1);
    st = withVariable(s, st, 'e', 0.4, 'p1');
    expect(st.variables).toEqual({ e: 0.4 });
    expect(withVariable(s, st, 'frame', 'nowhere', 'p1')).toBe(st);
    expect(withVariable(s, st, 'e', 'x')).toBe(st);
    expect(withVariable(s, st, 'e', 0.4)).toBe(st);
  });

  it('closes a panel by collapsing its split, keeps the last one, and finds a free id', () => {
    const s = scene();
    const one = withoutPanel(s.initial, 'p1');
    expect(Object.keys(one.panels)).toEqual(['p2']);
    expect(one.layout).toEqual({ kind: 'panel', id: 'p2' });
    expect(withoutPanel(one, 'p2')).toBe(one);
    expect(newPanelId(s.initial)).toBe('p3');
    expect(newPanelId(one)).toBe('p3');
  });
});

describe('drops on a panel', () => {
  // the initial state splits a row at 0.5 into p1 (frame shift, k 0.5) and p2 (frame tilt, k 2.5)
  it("a value on an edge makes a panel with the target's view and values, then sets the value", () => {
    const s = scene();
    const st = withDrop(s, s.initial, 'p2', 'bottom', { kind: 'value', variable: 'frame', value: 'rot' });
    expect(st.panels.p3).toEqual({ view: 'v', variables: { frame: 'rot', k: 2.5 } });
    expect(st.layout).toEqual({
      kind: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { kind: 'panel', id: 'p1' },
      b: { kind: 'split', dir: 'col', ratio: 0.5, a: { kind: 'panel', id: 'p2' }, b: { kind: 'panel', id: 'p3' } },
    });
    expect(st.panels.p2).toBe(s.initial.panels.p2);
  });
  it('a value or a view on the center changes the target only', () => {
    const s = scene();
    const st = withDrop(s, s.initial, 'p1', 'centre', { kind: 'value', variable: 'frame', value: 'root' });
    expect(st.panels.p1!.variables).toEqual({ frame: 'root', k: 0.5 });
    expect(st.layout).toBe(s.initial.layout);
    expect(withDrop(s, s.initial, 'p1', 'centre', { kind: 'view', view: 'nowhere' })).toBe(s.initial);
    expect(withDrop(s, s.initial, 'p1', 'centre', { kind: 'view', view: 'v' }).panels.p1).toEqual(s.initial.panels.p1);
  });
  it('a panel dropped on an edge moves there, and one dropped on the center swaps places', () => {
    const s = scene();
    const moved = withDrop(s, s.initial, 'p2', 'top', { kind: 'panel', id: 'p1' });
    expect(moved.layout).toEqual({ kind: 'split', dir: 'col', ratio: 0.5, a: { kind: 'panel', id: 'p1' }, b: { kind: 'panel', id: 'p2' } });
    const swapped = withDrop(s, s.initial, 'p2', 'centre', { kind: 'panel', id: 'p1' });
    expect(swapped.layout).toEqual(swapLeaves(s.initial.layout, 'p1', 'p2'));
    expect(swapped.layout).toEqual({ ...s.initial.layout, a: { kind: 'panel', id: 'p2' }, b: { kind: 'panel', id: 'p1' } });
    expect(withDrop(s, s.initial, 'p1', 'left', { kind: 'panel', id: 'p1' })).toBe(s.initial);
  });
  it('does not make a panel past the limit', () => {
    const s = scene();
    expect(withDrop(s, s.initial, 'p1', 'right', { kind: 'view', view: 'v' }, 2)).toBe(s.initial);
  });
});
