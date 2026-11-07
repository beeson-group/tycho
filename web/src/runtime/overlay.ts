/**
 * What a panel shows over its drawing, as data: its text labels and its colorbars. The renderer
 * computes them, the element writes them as DOM, and the video export draws them on a canvas.
 */

/**
 * A text label over a panel, centered vertically on (x, y) in CSS pixels from the panel's corner.
 * Its start sits at (x, y) by default, and its center or its end with `align` set to 'center' or
 * 'end'. A rotated label reads upward, turned a quarter turn about (x, y).
 */
export interface PanelLabel {
  text: string;
  x: number;
  y: number;
  align?: 'start' | 'center' | 'end';
  rotate?: boolean;
  /** Marks a tick number of the axes or the grid, or an axis title, and is left undefined for a body label or an axis tip. */
  kind?: 'tick' | 'title';
}

/** What a panel's overlay shows for a colormapped layer. */
export interface Colorbar {
  label: string;
  gradient: string;
  /** The same colors as stops from 0 at the low end to 1 at the high end, for a canvas. */
  stops: [number, string][];
  lo: number;
  hi: number;
  /** Where the highlighted or single member sits on the bar, in [0, 1], for a parameter colormap. */
  marker: number | null;
  /** The part of the bar a highlight's kernel lights, 1.5 kernel widths either side of the marker, in [0, 1]. */
  band: [number, number] | null;
}

/** The bars of a panel with the identical ones merged, keeping the first marker and band any of them has. */
export function mergeColorbars(bars: readonly Colorbar[]): Colorbar[] {
  const out = new Map<string, Colorbar>();
  for (const b of bars) {
    const key = JSON.stringify([b.label, b.gradient, b.lo, b.hi]);
    const seen = out.get(key);
    if (seen === undefined) out.set(key, b);
    else out.set(key, { ...seen, marker: seen.marker ?? b.marker, band: seen.band ?? b.band });
  }
  return [...out.values()];
}
