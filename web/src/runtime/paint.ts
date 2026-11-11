/**
 * The 2D painting of section 2.11 of spec/tycho-scene.md: markers, labels, the box of an axes layer, and the overlays. The page
 * paints them onto a canvas over the stage, and a video export onto each of its frames, with the same functions, so that a frame of a
 * video shows what the page shows. Every text is canvas text, never markup (rule S2).
 */
import type { Box, LabelLayer, Layout, Marker, Overlay, Readout, Scene, State } from '../scene.js';
import type { StageRenderer } from './renderer.js';
import { loopSeconds, opacityAt, sizeAt } from '../evaluate/timeline.js';
import { hexRgb, mixHex, type Theme } from './colors.js';
import type { Rect } from './tiles.js';

export const FONT = '"Helvetica Neue", Arial, sans-serif';
export const LABEL_SIZE = 13;
export const TICK_SIZE = 12;

type G = CanvasRenderingContext2D;

const rgba = (hex: string, a: number): string => {
  const [r, g, b] = hexRgb(hex).map((c) => Math.round(255 * c));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};

/** Draws a marker of `shape`, `d` CSS pixels across, centered at (x, y). A ring, a cross, and a plus are stroked in `fill`. */
export function drawMarker(g: G, shape: string, x: number, y: number, d: number, fill: string | null, edge: string | null, edgeWidth: number): void {
  const r = d / 2;
  g.beginPath();
  switch (shape) {
    case 'square':
      g.rect(x - r, y - r, d, d);
      break;
    case 'diamond':
      g.moveTo(x, y - r);
      g.lineTo(x + r, y);
      g.lineTo(x, y + r);
      g.lineTo(x - r, y);
      g.closePath();
      break;
    case 'triangle':
      g.moveTo(x, y - r);
      g.lineTo(x + 0.866 * r, y + 0.5 * r);
      g.lineTo(x - 0.866 * r, y + 0.5 * r);
      g.closePath();
      break;
    case 'star':
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rr = i % 2 === 0 ? r : 0.4 * r;
        if (i === 0) g.moveTo(x + rr * Math.cos(a), y + rr * Math.sin(a));
        else g.lineTo(x + rr * Math.cos(a), y + rr * Math.sin(a));
      }
      g.closePath();
      break;
    case 'cross':
    case 'plus': {
      // a cross spans the square of the marker's size, corner to corner, as matplotlib's x does
      if (shape === 'cross') {
        g.moveTo(x - r, y - r);
        g.lineTo(x + r, y + r);
        g.moveTo(x - r, y + r);
        g.lineTo(x + r, y - r);
      } else {
        g.moveTo(x - r, y);
        g.lineTo(x + r, y);
        g.moveTo(x, y - r);
        g.lineTo(x, y + r);
      }
      g.lineWidth = Math.max(1, edgeWidth || d / 6);
      g.strokeStyle = fill ?? '#ffffff';
      g.lineCap = 'butt';
      g.stroke();
      return;
    }
    default:
      g.arc(x, y, r, 0, 2 * Math.PI);
  }
  if (shape === 'ring') {
    g.lineWidth = Math.max(1, edgeWidth || d / 6);
    g.strokeStyle = fill ?? '#ffffff';
    g.stroke();
    return;
  }
  if (fill !== null) {
    g.fillStyle = fill;
    g.fill();
  }
  if (edge !== null && edgeWidth > 0) {
    g.lineWidth = edgeWidth;
    g.strokeStyle = edge;
    g.lineJoin = 'miter';
    g.stroke();
  }
}

/** The width of the stroke of a marker: its outline, or the line of a ring, a cross, or a plus. */
export function markerStroke(marker: Marker, size: number): number {
  const shape = marker.shape ?? 'disc';
  const ew = marker.edge_width ?? (marker.edge !== undefined ? 1 : 0);
  return shape === 'ring' || shape === 'cross' || shape === 'plus' ? Math.max(1, ew || size / 6) : marker.edge !== undefined ? ew : 0;
}

/**
 * A square canvas holding a marker for the texture of a sprite of `size` plus its stroke CSS pixels across, drawn at `scale` texture
 * pixels per CSS pixel. The shape is `size` across, and its stroke is centered on its outline, as matplotlib draws a marker's edge.
 * Without a fill color, the shape is white, so that a sprite's vertex color tints it.
 */
export function markerCanvas(marker: Marker, size: number, scale = 4): HTMLCanvasElement {
  const lw = markerStroke(marker, size);
  const sprite = size + lw;
  const n = Math.max(8, Math.min(512, Math.ceil(sprite * scale)));
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d')!;
  const k = n / sprite;
  g.scale(k, k);
  drawMarker(g, marker.shape ?? 'disc', sprite / 2, sprite / 2, size, marker.color ?? '#ffffff', marker.edge ?? null, lw);
  return c;
}

export interface TextStyle {
  size: number;
  color: string;
  weight: 'normal' | 'bold';
  font: string;
  align: 'start' | 'center' | 'end';
  baseline: 'top' | 'middle' | 'bottom';
  opacity: number;
  box?: Box;
}

/** The rectangle a text of possibly several lines covers when drawn at (x, y) in `style`, as [left, top, width, height]. */
export function textRect(g: G, text: string, x: number, y: number, style: TextStyle): [number, number, number, number] {
  g.font = `${style.weight === 'bold' ? 'bold ' : ''}${style.size}px ${style.font}`;
  const lines = text.split('\n');
  const lh = 1.25 * style.size;
  const w = Math.max(0, ...lines.map((l) => g.measureText(l).width));
  const h = lh * lines.length;
  const left = style.align === 'center' ? x - w / 2 : style.align === 'end' ? x - w : x;
  const top = style.baseline === 'middle' ? y - h / 2 : style.baseline === 'bottom' ? y - h : y;
  return [left, top, w, h];
}

/** Draws a text of possibly several lines at (x, y), aligned by `style`, on its box when it has one. */
export function drawText(g: G, text: string, x: number, y: number, style: TextStyle): void {
  if (style.opacity <= 0 || text === '') return;
  const [left, top, w, h] = textRect(g, text, x, y, style);
  g.save();
  g.globalAlpha *= style.opacity;
  const box = style.box;
  if (box !== undefined) {
    const pad = box.pad ?? 4;
    const r = box.radius ?? 0;
    g.beginPath();
    roundRect(g, left - pad, top - pad, w + 2 * pad, h + 2 * pad, r);
    if (box.fill !== undefined) {
      g.fillStyle = rgba(box.fill, box.opacity ?? 1);
      g.fill();
    }
    if (box.edge !== undefined && (box.edge_width ?? 1) > 0) {
      g.lineWidth = box.edge_width ?? 1;
      g.strokeStyle = rgba(box.edge, box.opacity ?? 1);
      g.stroke();
    }
  }
  g.fillStyle = style.color;
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  const lh = 1.25 * style.size;
  text.split('\n').forEach((line, i) => {
    const lw = g.measureText(line).width;
    const lx = style.align === 'center' ? left + (w - lw) / 2 : style.align === 'end' ? left + w - lw : left;
    g.fillText(line, lx, top + lh * (i + 0.5));
  });
  g.restore();
}

function roundRect(g: G, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  g.moveTo(x + rr, y);
  g.lineTo(x + w - rr, y);
  g.arcTo(x + w, y, x + w, y + rr, rr);
  g.lineTo(x + w, y + h - rr);
  g.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  g.lineTo(x + rr, y + h);
  g.arcTo(x, y + h, x, y + h - rr, rr);
  g.lineTo(x, y + rr);
  g.arcTo(x, y, x + rr, y, rr);
  g.closePath();
}

/** The style of a label or a text overlay at time `s` of the timeline. */
export function styleOf(spec: Pick<LabelLayer, 'size' | 'color' | 'weight' | 'align' | 'baseline' | 'opacity' | 'box'>, theme: Theme, s: number): TextStyle {
  return {
    size: spec.size ?? LABEL_SIZE,
    color: spec.color ?? theme.foreground,
    weight: spec.weight ?? 'normal',
    font: theme.font ?? FONT,
    align: spec.align ?? 'start',
    baseline: spec.baseline ?? 'middle',
    opacity: opacityAt(spec.opacity, s),
    box: spec.box,
  };
}

/**
 * Draws a label (rule K6) whose anchor lies at (ax, ay), with its text `offset` pixels away and the leader between them. The leader
 * runs from the anchor to the nearest point of the text's rectangle, and stops 3 pixels short of it.
 */
export function drawLabel(g: G, layer: LabelLayer, text: string, ax: number, ay: number, theme: Theme, s: number): void {
  const style = styleOf(layer, theme, s);
  if (style.opacity <= 0 || text === '') return;
  const [dx, dy] = layer.offset ?? [0, 0];
  const x = ax + dx;
  const y = ay + dy;
  if (layer.leader !== undefined && layer.leader !== false && (dx !== 0 || dy !== 0)) {
    const [left, top, w, h] = textRect(g, text, x, y, style);
    const pad = layer.box !== undefined ? (layer.box.pad ?? 4) : 0;
    const cx = Math.min(Math.max(ax, left - pad), left + w + pad);
    const cy = Math.min(Math.max(ay, top - pad), top + h + pad);
    const len = Math.hypot(cx - ax, cy - ay);
    if (len > 3) {
      const leader = layer.leader === true ? {} : layer.leader;
      g.save();
      g.globalAlpha *= style.opacity;
      g.strokeStyle = leader.color ?? style.color;
      g.lineWidth = leader.width ?? 1;
      g.beginPath();
      g.moveTo(ax, ay);
      g.lineTo(cx - (3 * (cx - ax)) / len, cy - (3 * (cy - ay)) / len);
      g.stroke();
      g.restore();
    }
  }
  drawText(g, text, x, y, style);
}

/** The steps of matplotlib's tick locator, i.e. 1, 2, 2.5, and 5 times a power of ten. */
const TICK_MANTISSAS = [1, 2, 2.5, 5, 10];

/** Ticks across [lo, hi] at the smallest round step of at least (hi - lo) / bins, as matplotlib's MaxNLocator picks them. */
export function boxTicks(lo: number, hi: number, bins: number): { values: number[]; step: number } {
  const range = hi - lo;
  if (!(range > 0) || !Number.isFinite(range)) return { values: [], step: 1 };
  const raw = range / Math.max(1, bins);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = (TICK_MANTISSAS.find((m) => m * mag >= raw * (1 - 1e-9)) ?? 10) * mag;
  const values: number[] = [];
  for (let k = Math.ceil(lo / step - 1e-9); k <= Math.floor(hi / step + 1e-9) && values.length < 200; k++) values.push(k * step + 0);
  return { values, step };
}

/** A tick number with the decimals its step needs, and a true minus. */
export function tickLabel(v: number, step: number): string {
  let decimals = 0;
  while (decimals < 10 && Math.abs(Math.round(step * 10 ** decimals) - step * 10 ** decimals) > 1e-9 * 10 ** decimals) decimals++;
  return (Math.abs(v) < step * 1e-9 ? 0 : v).toFixed(decimals).replace('-', '−');
}

export interface BoxPaint {
  /** The part of the panel the camera draws, in stage pixels. */
  rect: Rect;
  /** The visible window along the camera's right and up axes. */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** The axes that carry tick numbers. */
  ticks: { x: boolean; y: boolean };
  size: number;
  titles: [string, string];
  opacity: number;
}

/** Draws the box of an axes layer with `"span": "box"` around its rectangle, with ticks pointing out, tick numbers, and the axis titles. */
export function drawBox(g: G, b: BoxPaint, theme: Theme): void {
  if (b.opacity <= 0 || b.rect.w < 2 || b.rect.h < 2) return;
  const { x, y, w, h } = b.rect;
  const font = theme.font ?? FONT;
  const fg = theme.foreground;
  // the tick length, the pad of the tick numbers, and the pad of the titles of matplotlib's defaults, relative to its tick numbers of 14 points
  const tick = 0.25 * b.size;
  const pad = 0.25 * b.size;
  const titlePad = 0.29 * b.size;
  g.save();
  g.globalAlpha *= b.opacity;
  g.strokeStyle = fg;
  g.fillStyle = fg;
  g.lineWidth = 1;
  g.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w) - 1, Math.round(h) - 1);
  g.font = `${b.size}px ${font}`;
  const sx = (v: number) => x + ((v - b.x0) / (b.x1 - b.x0)) * w;
  const sy = (v: number) => y + h - ((v - b.y0) / (b.y1 - b.y0)) * h;
  // matplotlib allows a tick per three heights of a tick number across, and per two up
  const xt = boxTicks(b.x0, b.x1, Math.max(1, Math.floor(w / (3 * b.size))));
  const yt = boxTicks(b.y0, b.y1, Math.max(1, Math.floor(h / (2 * b.size))));
  g.beginPath();
  for (const v of xt.values) {
    const px = Math.round(sx(v)) + 0.5;
    g.moveTo(px, y + h);
    g.lineTo(px, y + h + tick);
  }
  for (const v of yt.values) {
    const py = Math.round(sy(v)) + 0.5;
    g.moveTo(x, py);
    g.lineTo(x - tick, py);
  }
  g.stroke();
  let yLabelWidth = 0;
  if (b.ticks.x) {
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (const v of xt.values) g.fillText(tickLabel(v, xt.step), sx(v), y + h + tick + pad);
  }
  if (b.ticks.y) {
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (const v of yt.values) {
      const t = tickLabel(v, yt.step);
      yLabelWidth = Math.max(yLabelWidth, g.measureText(t).width);
      g.fillText(t, x - tick - pad, sy(v));
    }
  }
  const title = (16 / 14) * b.size;
  g.font = `${title}px ${font}`;
  if (b.titles[0] !== '') {
    g.textAlign = 'center';
    g.textBaseline = 'top';
    g.fillText(b.titles[0], x + w / 2, y + h + tick + pad + (b.ticks.x ? 1.15 * b.size : 0) + titlePad);
  }
  if (b.titles[1] !== '') {
    g.save();
    g.translate(x - tick - pad - (b.ticks.y ? yLabelWidth : 0) - titlePad, y + h / 2);
    g.rotate(-Math.PI / 2);
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    g.fillText(b.titles[1], 0, 0);
    g.restore();
  }
  g.restore();
}

/** Draws a legend overlay (section 2.11) on a stage of `w` by `h` pixels. */
export function drawLegend(g: G, legend: Extract<Overlay, { kind: 'legend' }>, w: number, h: number, theme: Theme, s: number): void {
  const opacity = opacityAt(legend.opacity, s);
  if (opacity <= 0 || legend.entries.length === 0) return;
  const size = legend.size ?? LABEL_SIZE;
  const font = theme.font ?? FONT;
  g.save();
  g.globalAlpha *= opacity;
  g.font = `${size}px ${font}`;
  const handle = 1.8 * size;
  const gap = 0.6 * size;
  const columnGap = 1.4 * size;
  const columns = Math.max(1, Math.min(legend.columns ?? legend.entries.length, legend.entries.length));
  const rows = Math.ceil(legend.entries.length / columns);
  const handleWidth = (e: (typeof legend.entries)[number]) => (e.colors !== undefined ? Math.max(handle, 0.55 * size * e.colors.length) : handle);
  // matplotlib fills a legend's columns from top to bottom, and so does this one
  const cells = legend.entries.map((e, i) => ({ e, col: Math.floor(i / rows), row: i % rows }));
  const colWidth: number[] = Array.from({ length: columns }, () => 0);
  for (const c of cells) colWidth[c.col] = Math.max(colWidth[c.col]!, handleWidth(c.e) + gap + g.measureText(c.e.label).width);
  const total = colWidth.reduce((a, b) => a + b, 0) + columnGap * (columns - 1);
  const lh = 1.45 * size;
  const height = rows * lh;
  const ax = legend.at[0] * w;
  const ay = legend.at[1] * h;
  const align = legend.align ?? 'center';
  const left = align === 'center' ? ax - total / 2 : align === 'end' ? ax - total : ax;
  const base = legend.baseline ?? 'top';
  const top = base === 'middle' ? ay - height / 2 : base === 'bottom' ? ay - height : ay;
  for (const { e, col, row } of cells) {
    const cx = left + colWidth.slice(0, col).reduce((a, b) => a + b, 0) + columnGap * col;
    const cy = top + lh * (row + 0.5);
    const hw = handleWidth(e);
    if (e.colors !== undefined) {
      const n = e.colors.length;
      const part = hw / n;
      e.colors.forEach((c, i) => {
        g.strokeStyle = c;
        g.lineWidth = e.line?.width ?? 2;
        g.globalAlpha = opacity * (e.line?.opacity ?? 1);
        g.beginPath();
        g.moveTo(cx + i * part + 1, cy);
        g.lineTo(cx + (i + 1) * part - 1, cy);
        g.stroke();
      });
      g.globalAlpha = opacity;
    } else if (e.line !== undefined) {
      g.save();
      g.globalAlpha = opacity * (e.line.opacity ?? 1);
      g.strokeStyle = e.line.color ?? theme.foreground;
      g.lineWidth = e.line.width ?? 2;
      if (e.line.dash !== undefined) g.setLineDash(e.line.dash);
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + hw, cy);
      g.stroke();
      g.restore();
    }
    if (e.marker !== undefined) {
      const m = e.marker;
      g.save();
      g.globalAlpha = opacity * opacityAt(m.opacity, s);
      drawMarker(
        g,
        m.shape ?? 'disc',
        cx + hw / 2,
        cy,
        sizeAt(m.size, s, 0.6 * size),
        m.color ?? theme.foreground,
        m.edge ?? null,
        m.edge_width ?? (m.edge ? 1 : 0),
      );
      g.restore();
    }
    g.fillStyle = legend.color ?? theme.foreground;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText(e.label, cx + hw + gap, cy);
  }
  g.restore();
}

/** Covers a panel with the background at `1 - opacity`, which fades it as a whole (section 2.11). */
export function coverPanel(g: G, r: Rect, opacity: number, theme: Theme): void {
  if (opacity >= 1) return;
  g.save();
  g.fillStyle = rgba(theme.background, 1 - Math.max(0, opacity));
  g.fillRect(r.x, r.y, r.w, r.h);
  g.restore();
}

/** The gutter color of a video, the theme's or a blend of its foreground and background. */
export const gutterColor = (theme: Theme): string => theme.gutter ?? mixHex(theme.foreground, theme.background, 0.9);

/**
 * Paints, for every panel of `state`, the cover of its view's opacity, the box of its axes layer, and its labels, and then the
 * overlays of the scene, onto `g`, a 2D context in stage pixels (section 2.11). `text` gives the text of a list of parts in a panel.
 */
export function paintStage(
  g: CanvasRenderingContext2D,
  renderer: StageRenderer,
  scene: Scene,
  state: State,
  theme: Theme,
  q: number,
  w: number,
  h: number,
  text: (pid: string, parts: Readout['parts']) => string,
): void {
  const s = q * loopSeconds(scene.clock);
  let first: string | null = null;
  const walk = (n: Layout): string => (n.kind === 'panel' ? n.id : walk(n.a));
  first = walk(state.layout);
  for (const pid of Object.keys(state.panels)) {
    const info = renderer.paintInfo(pid);
    if (info === null || info.outer.w < 1 || info.outer.h < 1) continue;
    const opacity = opacityAt(info.opacity, s);
    coverPanel(g, info.outer, opacity, theme);
    if (opacity <= 0) continue;
    g.save();
    g.globalAlpha = opacity;
    if (info.box !== null) drawBox(g, info.box, theme);
    for (const l of info.labels) {
      const parts = typeof l.layer.text === 'string' ? [l.layer.text] : l.layer.text;
      drawLabel(g, l.layer, text(pid, parts), l.x, l.y, theme, s);
    }
    g.restore();
  }
  for (const o of scene.overlays ?? []) {
    if (o.kind === 'legend') drawLegend(g, o, w, h, theme, s);
    else if (o.kind === 'text') {
      const parts = typeof o.text === 'string' ? [o.text] : o.text;
      drawText(g, first === null ? '' : text(first, parts), o.at[0] * w, o.at[1] * h, styleOf(o, theme, s));
    }
  }
}
