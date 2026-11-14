import { describe, expect, it } from 'vitest';
import { loopSeconds } from '../src/evaluate/timeline';
import { paintPanelArea } from '../src/runtime/paint';
import type { PanelAreaRenderer } from '../src/runtime/renderer';
import { loadCorpus } from './corpus';

/** A stand-in for a 2D context, which records the alpha of every stroked rectangle and ignores what else is drawn. */
function recorder(): { g: CanvasRenderingContext2D; alphas: number[] } {
  const saved: number[] = [];
  const alphas: number[] = [];
  const g = new Proxy<Record<string, unknown>>(
    { globalAlpha: 1 },
    {
      get(target, key: string) {
        if (key in target) return target[key];
        if (key === 'save') return () => saved.push(target.globalAlpha as number);
        if (key === 'restore') return () => (target.globalAlpha = saved.pop());
        if (key === 'strokeRect') return () => alphas.push(target.globalAlpha as number);
        if (key === 'measureText') return () => ({ width: 10 });
        return () => undefined;
      },
    },
  );
  return { g: g as unknown as CanvasRenderingContext2D, alphas };
}

describe('the paint of the stage (section 2.11)', () => {
  it('fades the box of an axes layer by the opacity of the layer, a number or a keyframes', () => {
    const c = loadCorpus('two-panels');
    const pid = Object.keys(c.scene.initial.panels)[0]!;
    const L = loopSeconds(c.scene.clock);
    const rect = { x: 0, y: 0, w: 200, h: 100 };
    const theme = { background: '#000000', foreground: '#ffffff', grid: '#333333' };
    const alphaAt = (opacity: unknown, q: number): number[] => {
      const box = { rect, x0: 0, x1: 1, y0: 0, y1: 1, ticks: { x: true, y: true }, size: 14, titles: ['x', 'y'], opacity };
      const renderer = { paintInfo: (id: string) => (id === pid ? { outer: rect, rect, opacity: undefined, labels: [], box } : null) };
      const { g, alphas } = recorder();
      paintPanelArea(g, renderer as unknown as PanelAreaRenderer, c.scene, c.scene.initial, theme, q, 200, 100, () => []);
      return alphas;
    };
    const fadeIn = {
      keyframes: [
        [0, 0],
        [L, 1, 'linear'],
      ],
    };
    expect(alphaAt(0.25, 0)).toEqual([0.25]);
    expect(alphaAt(fadeIn, 0.5)).toEqual([0.5]);
    expect(alphaAt(undefined, 0)).toEqual([1]);
  });
});
