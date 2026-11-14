import { describe, expect, it } from 'vitest';
import type { Layout, Scene, State } from '../src/scene';
import { fnv1a, newPanelId, repair, storageKey, Store, swapLeaves, withChannel, withDrop, withoutPanel, withInput } from '../src/runtime/state';
import { loadCorpus } from './corpus';

// the two-panels scene has one declared panel v, the clock channels t and @index, and the inputs frame (choice, per panel),
// k (parameter input over @index, per panel), e (parameter input, shared), and group (choice, shared).
const scene = (): Scene => loadCorpus('two-panels').scene;

const stored = (over: Partial<State> = {}): State => ({
  inputs: { e: 0.3, group: 'moving' },
  clock: { channel: '@index' },
  panels: {
    p1: { panel: 'v', inputs: { frame: 'rot', k: 1 } },
    p2: { panel: 'v', inputs: { frame: 'tilt' } },
    p3: { panel: 'v', inputs: { k: 2 } },
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
    s.panels.p2 = { panel: 'gone' };
    const r = repair(scene(), s);
    expect(Object.keys(r.panels).sort()).toEqual(['p1', 'p3']);
    expect(r.layout).toEqual({ kind: 'split', dir: 'row', ratio: 0.4, a: { kind: 'panel', id: 'p1' }, b: { kind: 'panel', id: 'p3' } });
  });

  it('falls back to initial once every panel is dropped', () => {
    const s = stored();
    for (const p of Object.values(s.panels)) p!.panel = 'gone';
    expect(repair(scene(), s)).toEqual(scene().initial);
  });

  it('drops a value that does not fit its input, in the scene and in a panel', () => {
    const s = stored({ inputs: { e: 'high', group: 'nowhere' } });
    s.panels.p1!.inputs = { frame: 'inertial', k: true };
    s.panels.p2!.inputs = { frame: 4, k: 2 };
    const r = repair(scene(), s);
    expect(r.inputs).toEqual({});
    expect(r.panels.p1!.inputs).toEqual({});
    expect(r.panels.p2!.inputs).toEqual({ k: 2 });
  });

  it('drops a panel value of a shared input, and values that a reader never reads', () => {
    const s = stored({ inputs: { e: 0.3, frame: 'rot', unknown: 1 } });
    s.panels.p1!.inputs = { frame: 'rot', e: 0.5, group: 'moving', other: 'x' };
    const r = repair(scene(), s);
    expect(r.inputs).toEqual({ e: 0.3 });
    expect(r.panels.p1!.inputs).toEqual({ frame: 'rot' });
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

  it('keeps the keys of a split, so that a restored layout still moves with the timeline (section 2.11)', () => {
    // the first panel takes the whole row, then gives 0.4 of it to the others, which split their column with a hold
    const outer = [
      [0, 1],
      [2, 1],
      [3.5, 0.6, 'smooth'],
    ];
    const inner = [
      [0, 0.5],
      [5, 0.2, 'hold'],
    ];
    const s = stored();
    s.layout = { ...s.layout, keyframes: outer, b: { ...(s.layout as Extract<Layout, { kind: 'split' }>).b, keyframes: inner } } as Layout;
    const copy = structuredClone(s);
    const r = repair(scene(), s);
    expect(r.layout).toEqual(copy.layout);
    expect(s).toEqual(copy);
    // the keys are copied, hence a change of the restored layout cannot reach the stored one
    const keys = (r.layout as Extract<Layout, { kind: 'split' }>).keyframes!;
    expect(keys).not.toBe(outer);
    expect(keys[0]).not.toBe(outer[0]);
    // a split that loses a side goes with its keys, and the split left in its place keeps its own
    s.panels.p1 = { panel: 'gone' };
    expect(repair(scene(), s).layout).toEqual({
      kind: 'split',
      dir: 'col',
      ratio: 0.7,
      a: { kind: 'panel', id: 'p2' },
      b: { kind: 'panel', id: 'p3' },
      keyframes: inner,
    });
  });

  it('drops the keys of a split that the scene reader would refuse, and keeps the split at its ratio', () => {
    const bad: unknown[] = [
      [],
      'keys',
      [[0, 1.5]],
      [[0, -0.1]],
      [
        [1, 0.2],
        [0, 0.4],
      ],
      [[0, 0.2, 'bounce']],
      [[0, 0.2, 'smooth', 1]],
      [['start', 0.2]],
      [[0, '0.2']],
    ];
    for (const keys of bad) {
      const s = stored();
      (s.layout as Record<string, unknown>).keyframes = keys;
      const r = repair(scene(), s);
      expect(r.layout).toEqual(stored().layout);
      expect(Object.hasOwn(r.layout, 'keys')).toBe(false);
    }
  });

  it('drops a panel whose id is not an identifier, and keeps "__proto__" as an own key', () => {
    const s = JSON.parse(
      '{"clock":{"channel":"t"},"panels":{"__proto__":{"panel":"v"},"a b":{"panel":"v"}},' +
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
    const store = new Store(s.initial, s.clock.frame_count);
    const seen: string[] = [];
    store.subscribe((c) => seen.push(c));
    store.set(store.state);
    store.setFrame(-1);
    expect(store.frame).toBe(s.clock.frame_count - 1);
    store.setFrame(s.clock.frame_count - 1);
    store.setFrame(0.5);
    store.setPlaying(true);
    store.update((st) => withChannel(st, '@index'));
    store.update((st) => withChannel(st, '@index'));
    expect(seen).toEqual(['frame', 'playing', 'state']);
  });

  it('writes a per-panel value in the panel and a shared one in the scene, refusing what does not fit', () => {
    const s = scene();
    let st = withInput(s, s.initial, 'frame', 'rot', 'p2');
    expect(st.panels.p2!.inputs).toEqual({ frame: 'rot', k: 2.5 });
    expect(st.panels.p1).toBe(s.initial.panels.p1);
    st = withInput(s, st, 'e', 0.4, 'p1');
    expect(st.inputs).toEqual({ e: 0.4 });
    expect(withInput(s, st, 'frame', 'nowhere', 'p1')).toBe(st);
    expect(withInput(s, st, 'e', 'x')).toBe(st);
    expect(withInput(s, st, 'e', 0.4)).toBe(st);
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
  it('a declared panel on an edge makes a copy of the target there when the target shows it', () => {
    const s = scene();
    const st = withDrop(s, s.initial, 'p2', 'bottom', { kind: 'declared', panel: 'v' });
    expect(st.panels.p3).toEqual({ panel: 'v', inputs: s.initial.panels.p2!.inputs });
    expect(st.layout).toEqual({
      kind: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { kind: 'panel', id: 'p1' },
      b: { kind: 'split', dir: 'col', ratio: 0.5, a: { kind: 'panel', id: 'p2' }, b: { kind: 'panel', id: 'p3' } },
    });
    expect(st.panels.p2).toBe(s.initial.panels.p2);
  });
  it('a declared panel on the center replaces the declared panel of the target, and an unknown one changes nothing', () => {
    const s = scene();
    expect(withDrop(s, s.initial, 'p1', 'centre', { kind: 'declared', panel: 'nowhere' })).toBe(s.initial);
    expect(withDrop(s, s.initial, 'p1', 'centre', { kind: 'declared', panel: 'v' })).toBe(s.initial);
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
    expect(withDrop(s, s.initial, 'p1', 'right', { kind: 'declared', panel: 'v' }, 2)).toBe(s.initial);
  });
});
