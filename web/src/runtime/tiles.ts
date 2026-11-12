/**
 * Where the panels of a layout tree sit on a stage. The placement is a pure function of the tree
 * and the stage rectangle, and both the page and the renderer use it, so that a frame does not
 * depend on how the browser lays out the page.
 */
import type { Layout } from '../scene.js';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One split's gutter: its rectangle, the rectangle of the whole split, and the path to the split. */
export interface Gutter {
  path: string;
  dir: 'row' | 'col';
  rect: Rect;
  outer: Rect;
}

export interface Tiles {
  panels: Map<string, Rect>;
  gutters: Gutter[];
}

/**
 * Tiles `rect` by the layout. A split gives `ratio` of its extent less the gutter to `a`, in
 * whole pixels, and the rest to `b`. A gutter's path is the string of letters a and b
 * that leads from the root to the split.
 */
export function tile(layout: Layout, rect: Rect, gutter: number): Tiles {
  const out: Tiles = { panels: new Map(), gutters: [] };
  const walk = (node: Layout, r: Rect, path: string): void => {
    if (node.kind === 'panel') {
      out.panels.set(node.id, r);
      return;
    }
    const row = node.dir === 'row';
    // a split with keys may give one side all of its extent (section 2.11), and it then does not have a gutter
    const g = node.ratio <= 0 || node.ratio >= 1 ? 0 : gutter;
    const extent = Math.max(0, (row ? r.w : r.h) - g);
    const a = Math.round(extent * Math.min(1, Math.max(0, node.ratio)));
    const b = extent - a;
    if (row) {
      walk(node.a, { x: r.x, y: r.y, w: a, h: r.h }, `${path}a`);
      if (g > 0) out.gutters.push({ path, dir: node.dir, rect: { x: r.x + a, y: r.y, w: g, h: r.h }, outer: r });
      walk(node.b, { x: r.x + a + g, y: r.y, w: b, h: r.h }, `${path}b`);
    } else {
      walk(node.a, { x: r.x, y: r.y, w: r.w, h: a }, `${path}a`);
      if (g > 0) out.gutters.push({ path, dir: node.dir, rect: { x: r.x, y: r.y + a, w: r.w, h: g }, outer: r });
      walk(node.b, { x: r.x, y: r.y + a + g, w: r.w, h: b }, `${path}b`);
    }
  };
  walk(layout, rect, '');
  return out;
}

/** The layout with the ratio of the split at `path` replaced. */
export function withRatio(layout: Layout, path: string, ratio: number): Layout {
  if (layout.kind === 'panel') return layout;
  if (path === '') return { ...layout, ratio };
  return path[0] === 'a' ? { ...layout, a: withRatio(layout.a, path.slice(1), ratio) } : { ...layout, b: withRatio(layout.b, path.slice(1), ratio) };
}

/** The ratio of a split for a pointer at (x, y), in the split's rectangle less its gutter, kept in [0.1, 0.9]. */
export function ratioAt(g: Gutter, x: number, y: number, gutter: number): number {
  const o = g.outer;
  const along = g.dir === 'row' ? x - o.x - gutter / 2 : y - o.y - gutter / 2;
  const extent = Math.max(1, (g.dir === 'row' ? o.w : o.h) - gutter);
  return Math.min(0.9, Math.max(0.1, along / extent));
}
