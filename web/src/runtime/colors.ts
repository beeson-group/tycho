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
