/**
 * The icons of the viewer's controls, as inline SVG built with createElementNS from path strings, so that
 * the browser neither parses markup nor fetches a file. The icons house, chevron-down, grip-vertical, x,
 * rotate-ccw, plus, and download are taken from Lucide, on its 24 px grid with a 2 px stroke (the dots of grip-vertical
 * are written as paths). The icons play and pause are drawn here on a 16 px grid and filled.
 */

/**
 * @license Lucide, https://lucide.dev, ISC License
 *
 * Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT).
 * All other copyright (c) for Lucide are held by Lucide Contributors 2022.
 *
 * Permission to use, copy, modify, and/or distribute this software for any purpose with or
 * without fee is hereby granted, provided that the above copyright notice and this permission
 * notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS
 * SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE
 * AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
 * NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE
 * OF THIS SOFTWARE.
 */

const NS = 'http://www.w3.org/2000/svg';

interface Glyph {
  grid: 16 | 24;
  fill: boolean;
  d: readonly string[];
}

const dot = (x: number, y: number) => `M${x - 1} ${y}a1 1 0 1 0 2 0a1 1 0 1 0-2 0`;

export const GLYPHS = {
  house: {
    grid: 24,
    fill: false,
    d: [
      'M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8',
      'M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    ],
  },
  chevronDown: { grid: 24, fill: false, d: ['m6 9 6 6 6-6'] },
  grip: { grid: 24, fill: false, d: [[5, 12, 19].map((y) => dot(9, y)).join(''), [5, 12, 19].map((y) => dot(15, y)).join('')] },
  x: { grid: 24, fill: false, d: ['M18 6 6 18', 'm6 6 12 12'] },
  rotateCcw: { grid: 24, fill: false, d: ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5'] },
  plus: { grid: 24, fill: false, d: ['M5 12h14', 'M12 5v14'] },
  download: { grid: 24, fill: false, d: ['M12 15V3', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5'] },
  play: { grid: 16, fill: true, d: ['M5 3.5v9l7.5-4.5z'] },
  pause: { grid: 16, fill: true, d: ['M4.5 3H7v10H4.5zM9 3h2.5v10H9z'] },
} as const satisfies Record<string, Glyph>;

export type IconName = keyof typeof GLYPHS;

/** An icon as an `<svg>` that takes the text color. It is hidden from assistive technology, since its button carries the label. */
export function icon(name: IconName, cls?: string): SVGSVGElement {
  const g: Glyph = GLYPHS[name];
  const svg = document.createElementNS(NS, 'svg');
  const attrs: Record<string, string> = {
    viewBox: `0 0 ${g.grid} ${g.grid}`,
    'aria-hidden': 'true',
    focusable: 'false',
    fill: g.fill ? 'currentColor' : 'none',
    stroke: g.fill ? 'none' : 'currentColor',
  };
  if (!g.fill) Object.assign(attrs, { 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  svg.setAttribute('class', cls === undefined ? `i i-${name}` : `i i-${name} ${cls}`);
  for (const d of g.d) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}
