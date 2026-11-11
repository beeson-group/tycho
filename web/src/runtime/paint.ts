/**
 * The 2D painting of section 2.11 of spec/tycho-scene.md: markers, labels, the box of an axes layer, and the overlays. The page
 * paints them onto a canvas over the stage, and a video export onto each of its frames, with the same functions, so that a frame of a
 * video shows what the page shows. Every text is canvas text, never markup (rule S2).
 */
import type { Box, LabelLayer, Layout, Marker, Overlay, Readout, Scene, State } from '../scene.js';
import type { StageRenderer } from './renderer.js';
import { loopSeconds, opacityAt, sizeAt } from '../evaluate/timeline.js';
import { hexRgb, mixHex, themed, themedMarker, type Theme } from './colors.js';
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
  const ew = typeof marker.edge_width === 'number' ? marker.edge_width : marker.edge !== undefined ? 1 : 0;
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

/**
 * The text metrics of matplotlib's layout, in units of the font size, which the labels, the overlays, the legends, and the boxes
 * follow: a line's box is 0.984 tall with its baseline 0.227 above its bottom, and the lines of a text are 1.15 apart.
 */
export const TEXT_HEIGHT = 0.984;
export const TEXT_DESCENT = 0.227;
export const TEXT_ASCENT = TEXT_HEIGHT - TEXT_DESCENT;
export const LINE_PITCH = 1.15;
/** The gap matplotlib leaves at either end of an annotation's line, 2 points at a text of 14 points, in units of the text size. */
const LEADER_SHRINK = 2 / 14;

export interface TextStyle {
  size: number;
  color: string;
  weight: 'normal' | 'bold';
  font: string;
  align: 'start' | 'center' | 'end';
  /** `alphabetic` puts the baseline of the last line at the anchor, as matplotlib's `va="baseline"` does. */
  baseline: 'top' | 'middle' | 'bottom' | 'alphabetic';
  opacity: number;
  box?: Box;
  /** The spacing of the lines, as matplotlib's `linespacing`, 1.2 by default. */
  linespacing?: number;
}

/**
 * The distance between the baselines of two lines of a text, in units of its size. Matplotlib puts each line's baseline its
 * ascent times `linespacing` below the descent of the line before, hence the default pitch grows by the ascent per unit.
 */
export function linePitch(linespacing = 1.2): number {
  return LINE_PITCH + TEXT_ASCENT * (linespacing - 1.2);
}

/** A run of a text, set lowered and smaller as a subscript, raised and smaller as a superscript, or on the baseline (rule K7). */
export interface TextRun {
  text: string;
  shift?: 'sub' | 'sup';
}

/** A subscript or a superscript is set at this fraction of the size, lowered or raised by the fractions below, as mathtext sets them. */
const SCRIPT_SIZE = 0.7;
const SUB_DROP = 0.18;
const SUP_RISE = 0.42;

/** The runs of a text as its lines, split at its newline characters. */
function runLines(text: string | TextRun[]): TextRun[][] {
  const runs = typeof text === 'string' ? [{ text }] : text;
  const lines: TextRun[][] = [[]];
  for (const r of runs) {
    r.text.split('\n').forEach((piece, i) => {
      if (i > 0) lines.push([]);
      if (piece !== '') lines[lines.length - 1]!.push({ text: piece, ...(r.shift ? { shift: r.shift } : {}) });
    });
  }
  return lines;
}

const fontOf = (style: TextStyle, run?: TextRun): string =>
  `${style.weight === 'bold' ? 'bold ' : ''}${run?.shift ? SCRIPT_SIZE * style.size : style.size}px ${style.font}`;

/** The width of a line of runs in `style`. */
function lineWidth(g: G, line: TextRun[], style: TextStyle): number {
  let w = 0;
  for (const r of line) {
    g.font = fontOf(style, r);
    w += g.measureText(r.text).width;
  }
  return w;
}

/** The plain text of a text of runs. */
export const plainText = (text: string | TextRun[]): string => (typeof text === 'string' ? text : text.map((r) => r.text).join(''));

/** The rectangle a text of possibly several lines covers when drawn at (x, y) in `style`, as [left, top, width, height]. */
export function textRect(g: G, text: string | TextRun[], x: number, y: number, style: TextStyle): [number, number, number, number] {
  const lines = runLines(text);
  const w = Math.max(0, ...lines.map((l) => lineWidth(g, l, style)));
  g.font = fontOf(style);
  const h = (TEXT_HEIGHT + linePitch(style.linespacing) * (lines.length - 1)) * style.size;
  const left = style.align === 'center' ? x - w / 2 : style.align === 'end' ? x - w : x;
  const b = style.baseline;
  const top = b === 'middle' ? y - h / 2 : b === 'bottom' ? y - h : b === 'alphabetic' ? y - h + TEXT_DESCENT * style.size : y;
  return [left, top, w, h];
}

/** Draws a text of possibly several lines at (x, y), aligned by `style`, on its box when it has one. */
export function drawText(g: G, text: string | TextRun[], x: number, y: number, style: TextStyle): void {
  if (style.opacity <= 0 || plainText(text) === '') return;
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
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  runLines(text).forEach((line, i) => {
    const lw = lineWidth(g, line, style);
    let lx = style.align === 'center' ? left + (w - lw) / 2 : style.align === 'end' ? left + w - lw : left;
    const base = top + (TEXT_ASCENT + linePitch(style.linespacing) * i) * style.size;
    for (const r of line) {
      g.font = fontOf(style, r);
      const dy = r.shift === 'sub' ? SUB_DROP * style.size : r.shift === 'sup' ? -SUP_RISE * style.size : 0;
      g.fillText(r.text, lx, base + dy);
      lx += g.measureText(r.text).width;
    }
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
export function styleOf(
  spec: Pick<LabelLayer, 'size' | 'color' | 'weight' | 'align' | 'baseline' | 'opacity' | 'box' | 'linespacing'>,
  theme: Theme,
  s: number,
): TextStyle {
  const box =
    spec.box === undefined
      ? undefined
      : { ...spec.box, ...(spec.box.fill ? { fill: themed(spec.box.fill, theme) } : {}), ...(spec.box.edge ? { edge: themed(spec.box.edge, theme) } : {}) };
  return {
    size: spec.size ?? LABEL_SIZE,
    color: spec.color !== undefined ? themed(spec.color, theme) : theme.foreground,
    weight: spec.weight ?? 'normal',
    font: theme.font ?? FONT,
    align: spec.align ?? 'start',
    baseline: spec.baseline ?? 'middle',
    opacity: opacityAt(spec.opacity, s),
    box,
    ...(spec.linespacing === undefined ? {} : { linespacing: spec.linespacing }),
  };
}

/**
 * Draws a label (rule K6) whose anchor lies at (ax, ay), with its text `offset` pixels away and the leader between them. The leader
 * runs from the anchor to the nearest point of the text's rectangle, and stops 3 pixels short of it.
 */
export function drawLabel(g: G, layer: LabelLayer, text: string | TextRun[], ax: number, ay: number, theme: Theme, s: number): void {
  const style = styleOf(layer, theme, s);
  if (style.opacity <= 0 || plainText(text) === '') return;
  const [dx, dy] = layer.offset ?? [0, 0];
  const x = ax + dx;
  const y = ay + dy;
  if (layer.leader !== undefined && layer.leader !== false && (dx !== 0 || dy !== 0)) {
    // as matplotlib's annotation, the line aims from the anchor at the center of the text's box, starts where it leaves the box, and
    // stops short of both ends
    const [left, top, w, h] = textRect(g, text, x, y, style);
    const pad = layer.box !== undefined ? (layer.box.pad ?? 4) : 0;
    const cx = left + w / 2;
    const cy = top + h / 2;
    const vx = ax - cx;
    const vy = ay - cy;
    const hw = w / 2 + pad;
    const hh = h / 2 + pad;
    const t = Math.min(Math.abs(vx) > 1e-9 ? hw / Math.abs(vx) : Infinity, Math.abs(vy) > 1e-9 ? hh / Math.abs(vy) : Infinity);
    const shrink = LEADER_SHRINK * style.size;
    if (t < 1) {
      const ex = cx + t * vx;
      const ey = cy + t * vy;
      const len = Math.hypot(ax - ex, ay - ey);
      if (len > 2 * shrink) {
        const ux = (ax - ex) / len;
        const uy = (ay - ey) / len;
        const leader = layer.leader === true ? {} : layer.leader;
        g.save();
        g.globalAlpha *= style.opacity;
        g.strokeStyle = leader.color !== undefined ? themed(leader.color, theme) : style.color;
        g.lineWidth = leader.width ?? 1;
        g.beginPath();
        g.moveTo(ex + shrink * ux, ey + shrink * uy);
        g.lineTo(ax - shrink * ux, ay - shrink * uy);
        g.stroke();
        g.restore();
      }
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
  // the steps from the smallest round one of at least raw downward, since matplotlib keeps at least two ticks in view
  const all = [10, 1, 0.1, 0.01].flatMap((k) => TICK_MANTISSAS.map((m) => m * mag * k));
  const up = all.filter((x) => x >= raw * (1 - 1e-9)).sort((x, y) => x - y);
  const down = all.filter((x) => x < raw * (1 - 1e-9)).sort((x, y) => y - x);
  const ordered = [...up, ...down];
  let values: number[] = [];
  let step = ordered[0]!;
  for (const st of ordered) {
    step = st;
    values = [];
    for (let k = Math.ceil(lo / st - 1e-9); k <= Math.floor(hi / st + 1e-9) && values.length < 200; k++) values.push(k * st + 0);
    if (values.length >= 2) break;
  }
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
  /** The axis titles, the frame's or the axes layer's own, as text or as runs with subscripts. */
  titles: [string | TextRun[], string | TextRun[]];
  opacity: number;
}

/** Draws the box of an axes layer with `"span": "box"` around its rectangle, with ticks pointing out, tick numbers, and the axis titles. */
export function drawBox(g: G, b: BoxPaint, theme: Theme): void {
  if (b.opacity <= 0 || b.rect.w < 2 || b.rect.h < 2) return;
  const { x, y, w, h } = b.rect;
  const font = theme.font ?? FONT;
  const fg = theme.foreground;
  // the tick length, the pad of the tick numbers, the pad of the titles, and the width of the lines of matplotlib's defaults,
  // relative to its tick numbers of 14 points
  const tick = (3.5 / 14) * b.size;
  const pad = (3.5 / 14) * b.size;
  const titlePad = (4 / 14) * b.size;
  const lineWidth = (0.8 / 14) * b.size;
  g.save();
  g.globalAlpha *= b.opacity;
  g.strokeStyle = fg;
  g.fillStyle = fg;
  g.lineWidth = lineWidth;
  g.strokeRect(x, y, w, h);
  g.font = `${b.size}px ${font}`;
  const sx = (v: number) => x + ((v - b.x0) / (b.x1 - b.x0)) * w;
  const sy = (v: number) => y + h - ((v - b.y0) / (b.y1 - b.y0)) * h;
  // matplotlib allows a tick per three heights of a tick number across, and per two up
  const xt = boxTicks(b.x0, b.x1, Math.max(1, Math.floor(w / (3 * b.size))));
  const yt = boxTicks(b.y0, b.y1, Math.max(1, Math.floor(h / (2 * b.size))));
  g.beginPath();
  for (const v of xt.values) {
    g.moveTo(sx(v), y + h);
    g.lineTo(sx(v), y + h + tick);
  }
  for (const v of yt.values) {
    g.moveTo(x, sy(v));
    g.lineTo(x - tick, sy(v));
  }
  g.stroke();
  let yLabelWidth = 0;
  g.textBaseline = 'alphabetic';
  if (b.ticks.x) {
    g.textAlign = 'center';
    for (const v of xt.values) g.fillText(tickLabel(v, xt.step), sx(v), y + h + tick + pad + TEXT_ASCENT * b.size);
  }
  if (b.ticks.y) {
    g.textAlign = 'right';
    for (const v of yt.values) {
      const t = tickLabel(v, yt.step);
      yLabelWidth = Math.max(yLabelWidth, g.measureText(t).width);
      // matplotlib centers a y tick number on the middle of its letters above the baseline (va="center_baseline")
      g.fillText(t, x - tick - pad, sy(v) + (TEXT_ASCENT / 2) * b.size);
    }
  }
  const title = (16 / 14) * b.size;
  const style: TextStyle = { size: title, color: fg, weight: 'normal', font, align: 'center', baseline: 'alphabetic', opacity: 1 };
  if (plainText(b.titles[0]) !== '') {
    drawText(g, b.titles[0], x + w / 2, y + h + tick + pad + (b.ticks.x ? TEXT_HEIGHT * b.size : 0) + titlePad + TEXT_ASCENT * title, style);
  }
  if (plainText(b.titles[1]) !== '') {
    // turned to read upward, the title's descent faces the box, and its box ends the title pad from the tick numbers
    g.save();
    g.translate(x - tick - pad - (b.ticks.y ? yLabelWidth : 0) - titlePad, y + h / 2);
    g.rotate(-Math.PI / 2);
    drawText(g, b.titles[1], 0, -TEXT_DESCENT * title, style);
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
  const handle = (legend.handle_length ?? 2) * size;
  const gap = (legend.handle_pad ?? 0.8) * size;
  const columnGap = (legend.column_spacing ?? 2) * size;
  const columns = Math.max(1, Math.min(legend.columns ?? legend.entries.length, legend.entries.length));
  const rows = Math.ceil(legend.entries.length / columns);
  const handleWidth = (_: (typeof legend.entries)[number]) => handle;
  // matplotlib fills a legend's columns from top to bottom, and so does this one
  const cells = legend.entries.map((e, i) => ({ e, col: Math.floor(i / rows), row: i % rows }));
  const colWidth: number[] = Array.from({ length: columns }, () => 0);
  const labelStyle: TextStyle = {
    size,
    color: themed(legend.color ?? theme.foreground, theme),
    weight: 'normal',
    font,
    align: 'start',
    baseline: 'middle',
    opacity: 1,
  };
  for (const c of cells) colWidth[c.col] = Math.max(colWidth[c.col]!, handleWidth(c.e) + gap + textRect(g, labelRuns(c.e.label), 0, 0, labelStyle)[2]);
  const total = colWidth.reduce((a, b) => a + b, 0) + columnGap * (columns - 1);
  // matplotlib's legend: rows of a text's height and half a size apart, inside a border of 0.4 sizes, which keeps half a size from its anchor
  const lh = (TEXT_HEIGHT + 0.5) * size;
  const inner = 0.4 * size;
  const outer = 0.5 * size;
  // A label with a subscript reaches further down, as its mathtext does in matplotlib, whose legend stacks the entries of a column by
  // the heights of their texts, hence the entries below it in its column move down by as much.
  const below = (e: (typeof legend.entries)[number]): number =>
    labelRuns(e.label).some((r) => r.shift === 'sub') ? (SUB_DROP + (SCRIPT_SIZE - 1) * TEXT_DESCENT) * size : 0;
  const offsets = cells.map(({ col, row }) => {
    let y = 0;
    for (let r = 0; r < row; r++) y += lh + below(legend.entries[col * rows + r]!);
    return y;
  });
  const height = Math.max(...cells.map((c, i) => offsets[i]! + lh + below(c.e))) - 0.5 * size;
  const ax = legend.at[0] * w;
  const ay = legend.at[1] * h;
  const align = legend.align ?? 'center';
  const left = align === 'center' ? ax - total / 2 : align === 'end' ? ax - outer - inner - total : ax + outer + inner;
  const base = legend.baseline ?? 'top';
  const top = base === 'middle' ? ay - height / 2 : base === 'bottom' ? ay - outer - inner - height : ay + outer + inner;
  for (const [i, { e, col }] of cells.entries()) {
    const cx = left + colWidth.slice(0, col).reduce((a, b) => a + b, 0) + columnGap * col;
    const ty = top + offsets[i]! + (TEXT_HEIGHT / 2) * size;
    // matplotlib's handle box is 0.7 sizes tall and stands on the label's baseline, and its line runs through the middle of it
    const cy = ty + (TEXT_ASCENT - TEXT_HEIGHT / 2 - 0.35) * size;
    const hw = handleWidth(e);
    if (e.colors !== undefined) {
      const n = e.colors.length;
      const part = hw / n;
      e.colors.forEach((c, i) => {
        g.strokeStyle = themed(c, theme);
        g.lineWidth = e.line?.width ?? 2;
        g.globalAlpha = opacity * (e.line?.opacity ?? 1);
        g.lineCap = 'butt';
        g.beginPath();
        g.moveTo(cx + i * part, cy);
        g.lineTo(cx + (i + 1) * part, cy);
        g.stroke();
      });
      g.globalAlpha = opacity;
    } else if (e.line !== undefined) {
      g.save();
      g.globalAlpha = opacity * (e.line.opacity ?? 1);
      g.strokeStyle = themed(e.line.color ?? theme.foreground, theme);
      g.lineWidth = e.line.width ?? 2;
      // matplotlib's lines end in projecting caps
      g.lineCap = e.line.dash === undefined ? 'square' : 'butt';
      if (e.line.dash !== undefined) g.setLineDash(e.line.dash);
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + hw, cy);
      g.stroke();
      g.restore();
    }
    if (e.marker !== undefined) {
      const m = themedMarker(e.marker, theme);
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
        typeof m.edge_width === 'number' ? m.edge_width : m.edge ? 1 : 0,
      );
      g.restore();
    }
    drawText(g, labelRuns(e.label), cx + hw + gap, ty, labelStyle);
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
  text: (pid: string, parts: Readout['parts']) => string[],
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
    if (info.box !== null) {
      const own = info.boxTitles;
      const titles: BoxPaint['titles'] =
        own === undefined
          ? info.box.titles
          : ([0, 1].map((i) => {
              const t = own[i];
              if (t === undefined) return info.box!.titles[i]!;
              const parts = typeof t === 'string' ? [t] : t;
              return runsOf(parts, text(pid, parts));
            }) as BoxPaint['titles']);
      drawBox(g, { ...info.box, titles }, theme);
    }
    for (const l of info.labels) {
      // a label at a point is hidden while its anchor is outside the plot, as matplotlib clips an annotation
      const r = info.rect;
      if (l.clip && !(l.x >= r.x - 0.5 && l.x <= r.x + r.w + 0.5 && l.y >= r.y - 0.5 && l.y <= r.y + r.h + 0.5)) continue;
      const parts = typeof l.layer.text === 'string' ? [l.layer.text] : l.layer.text;
      drawLabel(g, l.layer, runsOf(parts, text(pid, parts)), l.x, l.y, theme, s);
    }
    g.restore();
  }
  for (const o of scene.overlays ?? []) {
    if (o.kind === 'legend') drawLegend(g, o, w, h, theme, s);
    else if (o.kind === 'text') {
      const parts = typeof o.text === 'string' ? [o.text] : o.text;
      drawText(g, first === null ? '' : runsOf(parts, text(first, parts)), o.at[0] * w, o.at[1] * h, styleOf(o, theme, s));
    }
  }
}

/** The runs of a text from its parts and the text of each part, a `sub` or a `sup` part set as a script (rule K7). */
export function runsOf(parts: Readout['parts'], pieces: string[]): TextRun[] {
  return pieces.map((text, i) => {
    const p = parts[i] as object | string | undefined;
    if (typeof p === 'object' && p !== null && 'sub' in p) return { text, shift: 'sub' as const };
    if (typeof p === 'object' && p !== null && 'sup' in p) return { text, shift: 'sup' as const };
    return { text };
  });
}

/** The runs of a legend entry's label, a string or a list of strings and `sub` and `sup` parts. */
function labelRuns(label: string | readonly (string | { sub?: string; sup?: string })[]): TextRun[] {
  if (typeof label === 'string') return [{ text: label }];
  return label.map((p) =>
    typeof p === 'string' ? { text: p } : p.sub !== undefined ? { text: p.sub, shift: 'sub' as const } : { text: p.sup ?? '', shift: 'sup' as const },
  );
}
