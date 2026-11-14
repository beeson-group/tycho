/**
 * Colors for drawing (section 2.7): the theme, a layer's color as a constant or a colormap over
 * a parameter or a channel of its set, and the body colors. Colors are sRGB in [0, 1] and are
 * written to the canvas as they are, without color management.
 */
import type { SetData } from '../evaluate/sets.js';
import type { ColormapByChoice, ColormapName, ColorSpec, Scene } from '../scene.js';
import { colormap, type ColormapId } from './colormaps.js';

export type Rgb = [number, number, number];

export interface Theme {
  background: string;
  foreground: string;
  grid: string;
  /** A CSS font family for every text of the page and of a video (section 2.11). */
  font?: string;
  /** The color of the gutters between panels in a video, by default a blend of the foreground and the background. */
  gutter?: string;
  /** The foreground and the background of the scene's own theme, which the colors equal to them follow (section 2.11). */
  sceneForeground?: string;
  sceneBackground?: string;
}

/**
 * A color of the scene as the viewer draws it: a color equal to the foreground or the background of the scene's theme is drawn
 * in the viewer's foreground or background, so that black lines and white marker fills of a scene written for a white page follow
 * a palette that replaces its theme, e.g. the dark one of a slide. Any other color is drawn as it is.
 */
export function themed(hex: string, theme: Theme): string {
  const h = hex.toLowerCase();
  if (theme.sceneForeground !== undefined && h === theme.sceneForeground.toLowerCase()) return theme.foreground;
  if (theme.sceneBackground !== undefined && h === theme.sceneBackground.toLowerCase()) return theme.background;
  return hex;
}

/** A layer's color with its fixed colors themed. */
export function themedSpec(spec: ColorSpec | undefined, theme: Theme): ColorSpec | undefined {
  if (spec === undefined) return spec;
  if (typeof spec === 'string') return themed(spec, theme);
  if (isThreshold(spec)) return { ...spec, colors: spec.colors.map((c) => themed(c, theme)) as typeof spec.colors };
  return spec;
}

/** A marker with its fill and its edge themed. */
export function themedMarker<M extends { color?: string; edge?: string }>(m: M, theme: Theme): M {
  return { ...m, ...(m.color !== undefined ? { color: themed(m.color, theme) } : {}), ...(m.edge !== undefined ? { edge: themed(m.edge, theme) } : {}) };
}

export const DEFAULT_THEME: Theme = { background: '#000000', foreground: '#d8d8d8', grid: '#262626' };

export function sceneTheme(scene: Scene): Theme {
  return { ...DEFAULT_THEME, ...(scene.theme ?? {}) };
}

/** The palettes of the `theme` attribute of `<tycho-viewer>`, which match the dark and light modes of the Beeson group's slide theme. */
export const PALETTES = {
  dark: { background: '#050505', foreground: '#f2f2ef', grid: '#232320' },
  light: { background: '#faf8f3', foreground: '#141413', grid: '#e3e0d8' },
} as const satisfies Record<string, Theme>;

/**
 * The value of a CSS color as `#rrggbb`, or null when `value` is empty or is not a color. A form other than `#rgb` and
 * `#rrggbb` is read only in a browser, by painting it on a canvas. A canvas keeps its previous fill for a color that it rejects,
 * hence such a color is detected by two different previous fills.
 */
export function cssColorHex(value: string): string | null {
  const text = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(text)) return text.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(text)) return `#${[...text.slice(1)].map((c) => c + c).join('')}`.toLowerCase();
  if (text === '') return null;
  const g = document.createElement('canvas').getContext?.('2d', { willReadFrequently: true });
  if (g === null || g === undefined) return null;
  const paint = (sentinel: string) => {
    g.fillStyle = sentinel;
    g.fillStyle = text;
    return g.fillStyle;
  };
  if (paint('#000000') !== paint('#ffffff')) return null;
  g.fillRect(0, 0, 1, 1);
  const [r, gr, b] = g.getImageData(0, 0, 1, 1).data;
  return `#${[r!, gr!, b!].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The theme that a viewer draws with. `base` is the scene's theme, a `name` of a palette replaces it, and a color read from one of
 * the custom properties `--tycho-background`, `--tycho-foreground`, and `--tycho-grid` takes precedence over both.
 */
export function hostTheme(base: Theme, name: string | null, read: (property: string) => string): Theme {
  const palette = name === 'dark' || name === 'light';
  const theme: Theme = palette ? PALETTES[name] : base;
  const out: Theme = {
    background: cssColorHex(read('--tycho-background')) ?? theme.background,
    foreground: cssColorHex(read('--tycho-foreground')) ?? theme.foreground,
    grid: cssColorHex(read('--tycho-grid')) ?? theme.grid,
  };
  const font = read('--tycho-font') || base.font;
  if (font) out.font = font;
  out.sceneForeground = base.foreground;
  out.sceneBackground = base.background;
  // a gutter in the scene's background follows the background of a palette
  if (base.gutter !== undefined) out.gutter = palette && base.gutter.toLowerCase() === base.background.toLowerCase() ? out.background : base.gutter;
  return out;
}

/** The brand colors of the viewer's controls. Orange marks what is current, and violet what the pointer or the keyboard touches. */
export const ACCENT = { accent: '#f0a050', hover: '#ffb366', press: '#d98a3a', violet: '#c050f0', violetText: '#d98cff', error: '#ff7a7a' } as const;

/**
 * The colors of the controls as CSS custom properties. The neutrals are
 * the theme's foreground mixed toward its background, and the orange and violet accents are
 * fixed. Every value is a color, hence the result can be put into a style sheet as it is.
 */
export function controlsTokens(theme: Theme): Record<string, string> {
  const bg = mixHex(theme.background, theme.background, 0);
  const fg = mixHex(theme.foreground, theme.foreground, 0);
  const surface = mixHex(fg, bg, 0.95);
  const dark = hexRgb(bg).reduce((a, b) => a + b, 0) < 1.5;
  return {
    '--bg': bg,
    '--fg': fg,
    '--surface': surface,
    '--raised': mixHex(fg, bg, 0.82),
    '--line': mixHex(fg, bg, 0.8),
    '--dim': mixHex(fg, bg, 0.287),
    '--track': mixHex(fg, bg, 0.574),
    '--gutter': theme.gutter ?? mixHex(fg, bg, 0.9),
    '--header': `${surface}cc`,
    '--accent': ACCENT.accent,
    '--accent-hover': ACCENT.hover,
    '--accent-press': ACCENT.press,
    '--accent-tint': mixHex(ACCENT.accent, surface, 0.84),
    '--accent-2': ACCENT.violet,
    '--accent-2-text': ACCENT.violetText,
    '--accent-2-tint': 'rgba(192, 80, 240, 0.16)',
    '--error': ACCENT.error,
    '--highlight': dark ? '#ffffff' : '#000000',
  };
}

/** Parses `hex`, written as `#rrggbb`, into three numbers in [0, 1], and returns white, [1, 1, 1], for any other string. */
export function hexRgb(hex: string): Rgb {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
  if (m === null) return [1, 1, 1];
  return [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255];
}

/** The color `a` blended toward `b` by the fraction `t`, as `#rrggbb`. */
export function mixHex(a: string, b: string, t: number): string {
  const x = hexRgb(a);
  const y = hexRgb(b);
  const c = (i: number) =>
    Math.round(255 * ((1 - t) * x[i]! + t * y[i]!))
      .toString(16)
      .padStart(2, '0');
  return `#${c(0)}${c(1)}${c(2)}`;
}

/**
 * A value's position on a colormap. The interval `range` maps to [0, 1], a value outside it is
 * clamped, and the result maps onto the part of the colormap that `truncate` specifies.
 */
export function colormapPosition(value: number, range: readonly [number, number], truncate: readonly [number, number] = [0, 1]): number {
  const [lo, hi] = range;
  const t = hi === lo ? 0.5 : Math.min(1, Math.max(0, (value - lo) / (hi - lo)));
  return truncate[0] + t * (truncate[1] - truncate[0]);
}

function extent(values: ArrayLike<number>): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo <= hi ? [lo, hi] : [0, 1];
}

/** A colormapped color's values over a set, one per trajectory or one per sample, with its range and truncation. */
export interface ColorScale {
  id: ColormapId;
  name: string;
  perTrajectory: boolean;
  values: ArrayLike<number>;
  range: [number, number];
  truncate: [number, number];
}

/** A function from which a color reads a choice. It returns the current value of `input`, or undefined when `input` does not have one. */
export type ChoiceValue = (input: string) => string | undefined;

/**
 * The colormap given by `colormap`, or for a map keyed by a choice, its entry for the choice's
 * current value. The map's first entry is used without a value or for a value that the map lacks.
 */
export function colormapName(colormap: ColormapName | ColormapByChoice, value?: ChoiceValue): ColormapId {
  if (typeof colormap === 'string') return colormap;
  const v = value?.(colormap.input);
  const named = v !== undefined && Object.hasOwn(colormap.map, v) ? colormap.map[v] : undefined;
  return (named ?? Object.values(colormap.map).find((c) => c !== undefined) ?? 'viridis') as ColormapId;
}

/** A color given by thresholds of a channel (section 2.11), which is not a colormap and does not have a colorbar. */
export type ThresholdColor = Extract<ColorSpec, { thresholds: unknown }>;

export const isThreshold = (spec: ColorSpec | undefined): spec is ThresholdColor => typeof spec === 'object' && spec !== null && 'thresholds' in spec;

/** The index of the color of a threshold color at value `x`, i.e. the count of thresholds below `x`. */
export function thresholdIndex(thresholds: readonly number[], x: number): number {
  let j = 0;
  while (j < thresholds.length && thresholds[j]! < x) j++;
  return j;
}

export function colorScale(spec: Exclude<ColorSpec, string | ThresholdColor>, set: SetData, value?: ChoiceValue): ColorScale {
  const perTrajectory = 'parameter' in spec;
  const name = 'parameter' in spec ? spec.parameter : spec.channel;
  const values = 'parameter' in spec ? set.parameter(spec.parameter, 'panel') : set.channel(spec.channel, 'panel');
  return { id: colormapName(spec.colormap, value), name, perTrajectory, values, range: spec.range ?? extent(values), truncate: spec.truncate ?? [0, 1] };
}

/** A layer's color on its set, either one constant or one color per sample (a trajectory's color repeated over its samples). */
export type Coloring = { kind: 'constant'; rgb: Rgb } | { kind: 'sample'; rgb: Float32Array };

export function coloring(spec: ColorSpec | undefined, set: SetData, fallback: Rgb, value?: ChoiceValue): Coloring {
  if (spec === undefined) return { kind: 'constant', rgb: fallback };
  if (typeof spec === 'string') return { kind: 'constant', rgb: hexRgb(spec) };
  if (isThreshold(spec)) {
    const values = set.channel(spec.channel, 'panel');
    const colors = spec.colors.map(hexRgb);
    const out = new Float32Array(3 * set.samples);
    for (let i = 0; i < set.samples; i++) out.set(colors[thresholdIndex(spec.thresholds, values[i]!)]!, 3 * i);
    return { kind: 'sample', rgb: out };
  }
  const scale = colorScale(spec, set, value);
  const out = new Float32Array(3 * set.samples);
  const rgb = [0, 0, 0];
  if (scale.perTrajectory) {
    for (let t = 0; t < set.trajectories; t++) {
      colormap(scale.id, colormapPosition(scale.values[t]!, scale.range, scale.truncate), rgb);
      for (let i = set.start(t); i < set.start(t) + set.count(t); i++) out.set(rgb, 3 * i);
    }
  } else {
    for (let i = 0; i < set.samples; i++) out.set(colormap(scale.id, colormapPosition(scale.values[i]!, scale.range, scale.truncate), rgb), 3 * i);
  }
  return { kind: 'sample', rgb: out };
}

/** Colors along the part of a colormap that a scale uses, from 0 at the low end to 1 at the high end. */
export function gradientStops(scale: ColorScale, stops = 12): [number, string][] {
  const out: [number, string][] = [];
  const rgb = [0, 0, 0];
  for (let i = 0; i < stops; i++) {
    const t = i / (stops - 1);
    colormap(scale.id, scale.truncate[0] + t * (scale.truncate[1] - scale.truncate[0]), rgb);
    out.push([t, `rgb(${rgb.map((v) => Math.round(255 * v)).join(',')})`]);
  }
  return out;
}

/** A CSS gradient from the bottom up over the part of a colormap that a scale uses. */
export function gradientCss(scale: ColorScale, stops = 12): string {
  return `linear-gradient(to top, ${gradientStops(scale, stops)
    .map(([t, css]) => `${css} ${(100 * t).toFixed(1)}%`)
    .join(', ')})`;
}
