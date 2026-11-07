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
}

export const DEFAULT_THEME: Theme = { background: '#000000', foreground: '#d8d8d8', grid: '#262626' };

export function sceneTheme(scene: Scene): Theme {
  return { ...DEFAULT_THEME, ...(scene.theme ?? {}) };
}

/** The brand colors of the viewer's controls (its chrome). Orange marks what is current, and violet what the pointer or the keyboard touches. */
export const ACCENT = { accent: '#f0a050', hover: '#ffb366', press: '#d98a3a', violet: '#c050f0', violetText: '#d98cff', error: '#ff7a7a' } as const;

/**
 * The colors of the chrome as CSS custom properties. The neutrals are
 * the theme's foreground mixed toward its background, and the orange and violet accents are
 * fixed. Every value is a color, hence the result can be put into a style sheet as it is.
 */
export function chromeTokens(theme: Theme): Record<string, string> {
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
    '--gutter': mixHex(fg, bg, 0.9),
    '--head': `${surface}cc`,
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
 * clamped, and the result maps onto the part of the colormap that `clip` specifies.
 */
export function colormapPosition(value: number, range: readonly [number, number], clip: readonly [number, number] = [0, 1]): number {
  const [lo, hi] = range;
  const t = hi === lo ? 0.5 : Math.min(1, Math.max(0, (value - lo) / (hi - lo)));
  return clip[0] + t * (clip[1] - clip[0]);
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

/** A colormapped color's values over a set, one per track or one per sample, with its range and clip. */
export interface ColorScale {
  id: ColormapId;
  name: string;
  perTrack: boolean;
  values: ArrayLike<number>;
  range: [number, number];
  clip: [number, number];
}

/** A function from which a color reads a choice. It returns the current value of `variable`, or undefined when `variable` does not have one. */
export type ChoiceValue = (variable: string) => string | undefined;

/**
 * The colormap given by `colormap`, or for a map keyed by a choice, its entry for the choice's
 * current value. The map's first entry is used without a value or for a value that the map lacks.
 */
export function colormapName(colormap: ColormapName | ColormapByChoice, value?: ChoiceValue): ColormapId {
  if (typeof colormap === 'string') return colormap;
  const v = value?.(colormap.var);
  const named = v !== undefined && Object.hasOwn(colormap.map, v) ? colormap.map[v] : undefined;
  return (named ?? Object.values(colormap.map).find((c) => c !== undefined) ?? 'viridis') as ColormapId;
}

export function colorScale(spec: Exclude<ColorSpec, string>, set: SetData, value?: ChoiceValue): ColorScale {
  const perTrack = 'parameter' in spec;
  const name = 'parameter' in spec ? spec.parameter : spec.channel;
  const values = 'parameter' in spec ? set.parameter(spec.parameter, '2.7') : set.channel(spec.channel, '2.7');
  return { id: colormapName(spec.colormap, value), name, perTrack, values, range: spec.range ?? extent(values), clip: spec.clip ?? [0, 1] };
}

/** A layer's color on its set, either one constant or one color per sample (a track's color repeated over its samples). */
export type Coloring = { kind: 'constant'; rgb: Rgb } | { kind: 'sample'; rgb: Float32Array };

export function coloring(spec: ColorSpec | undefined, set: SetData, fallback: Rgb, value?: ChoiceValue): Coloring {
  if (spec === undefined) return { kind: 'constant', rgb: fallback };
  if (typeof spec === 'string') return { kind: 'constant', rgb: hexRgb(spec) };
  const scale = colorScale(spec, set, value);
  const out = new Float32Array(3 * set.samples);
  const rgb = [0, 0, 0];
  if (scale.perTrack) {
    for (let t = 0; t < set.tracks; t++) {
      colormap(scale.id, colormapPosition(scale.values[t]!, scale.range, scale.clip), rgb);
      for (let i = set.start(t); i < set.start(t) + set.count(t); i++) out.set(rgb, 3 * i);
    }
  } else {
    for (let i = 0; i < set.samples; i++) out.set(colormap(scale.id, colormapPosition(scale.values[i]!, scale.range, scale.clip), rgb), 3 * i);
  }
  return { kind: 'sample', rgb: out };
}

/** Colors along the part of a colormap that a scale uses, from 0 at the low end to 1 at the high end. */
export function gradientStops(scale: ColorScale, stops = 12): [number, string][] {
  const out: [number, string][] = [];
  const rgb = [0, 0, 0];
  for (let i = 0; i < stops; i++) {
    const t = i / (stops - 1);
    colormap(scale.id, scale.clip[0] + t * (scale.clip[1] - scale.clip[0]), rgb);
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
