/**
 * <tycho-viewer>, the embeddable element of the TyCHO runtime.
 *
 * Attributes:
 *   scene   CSS selector of a `<script type="application/octet-stream">` holding scene.tys
 *   data    CSS selector of one holding data.tyd
 *   kiosk   hides every control and plays at once, for a slide
 *
 * Both scripts hold base64 text, `data-encoding="base64"`, the default and the only encoding. The
 * page state is the snapshot of section 2.8 of spec/tycho-scene.md, kept in a Store, restored from
 * and saved to localStorage under a hash of scene.tys and repaired before use. Panels tile the
 * stage according to the snapshot's layout.
 *
 * The top bar holds the title, the scene-scoped variables, and the Add panel group, whose chips
 * are the scene's views, or the values of its panel-scoped choice when it has one view. Drag a
 * chip onto a panel's edge to split it there or onto its center to replace it, click it to add
 * a panel, or use its menu. Drag a panel by its header to move or swap it, and a gutter to
 * resize. Under the stage the caption readouts are stat tiles, and the footer groups Playback,
 * View, and Export. A colorbar over the parameter of a scene-scoped selector sets it. Every
 * string from the scene is written as text (rule S2).
 */
import { decodeEmbedded, Container } from '../container.js';
import { TychoError } from '../errors.js';
import { variableDef, type PanelScope } from '../evaluate/resolve.js';
import type { Choice, Control, Layout, PanelState, Readout, Scene, State, VariableValue } from '../scene.js';
import { validate } from '../validate.js';
import { chromeTokens, sceneTheme } from './colors.js';
import {
  EXPORT_FPS,
  EXPORT_LOOPS,
  checkExport,
  defaultExportFps,
  exportVideo as runExport,
  frameSchedule,
  sizePreset,
  webCodecsMissing,
  type ExportOptions,
  type SizePreset,
} from './export.js';
import { GeometryCache } from './geometry.js';
import { icon, type IconName } from './icons.js';
import { zoneFor, type DropZone } from './layout.js';
import {
  colorbarLink,
  formatNumber,
  FrameMeter,
  fpsText,
  fpsTitle,
  keyAction,
  loopPosition,
  loopSeconds,
  nearestStop,
  positionIndex,
  positionProgress,
  readoutPieces,
  readoutTiles,
  sliderStops,
  stopAt,
  type ColorbarLink,
  type FrameReport,
  type ReadoutTile,
} from './readouts.js';
import { GUTTER, StageRenderer } from './renderer.js';
import {
  chipMenu,
  repair,
  storageKey,
  Store,
  withAdd,
  withChannel,
  withDrop,
  withLayout,
  withoutPanel,
  withPlacement,
  withVariable,
  type DropPayload,
} from './state.js';
import { ratioAt, tile, withRatio, type Gutter } from './tiles.js';

const MAX_PANELS = 8;
const SPEEDS = [0.25, 0.5, 1, 2, 4];

/** What the Add panel group offers, either a view or a value of the panel-scoped choice, with the chip's label. */
type Template = Exclude<DropPayload, { kind: 'panel' }> & { label: string };
type DragPayload = Template | Extract<DropPayload, { kind: 'panel' }>;

interface Widget {
  el: HTMLElement;
  sync(scope: PanelScope): void;
}

/** A readout's elements, which are stat tiles when its text splits, or else one line that also shows an error. */
export interface ReadoutDom {
  parts: Readout['parts'];
  tiles: ReadoutTile[] | null;
  root: HTMLDivElement;
  list: HTMLElement | null;
  values: HTMLElement[];
  line: HTMLDivElement;
}

interface BarDom {
  root: HTMLDivElement;
  title: HTMLDivElement;
  grad: HTMLDivElement;
  /** The part of the bar a highlight's kernel lights. */
  band: HTMLSpanElement;
  mark: HTMLElement;
  hi: HTMLSpanElement;
  lo: HTMLSpanElement;
  gradient: string;
  range: [number, number];
  link: ColorbarLink | null;
}

interface PanelDom {
  host: HTMLDivElement;
  body: HTMLDivElement;
  head: HTMLDivElement;
  title: HTMLSpanElement;
  chip: HTMLDivElement;
  chipLabel: HTMLSpanElement;
  select: HTMLSelectElement | null;
  meta: HTMLSpanElement;
  close: HTMLButtonElement;
  readouts: ReadoutDom[];
  error: HTMLDivElement;
  drop: HTMLDivElement;
  dropLabel: HTMLSpanElement;
  bars: HTMLDivElement;
  barDom: BarDom[];
  /** The snapshot the colorbars were last read for. */
  barsFor: State | null;
  widgets: Widget[];
  view: string;
}

interface MenuEntry {
  label: string;
  run: () => void;
  disabled?: boolean;
  /** Starts a new group, after a separator. */
  group?: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls !== undefined) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function setText(e: HTMLElement, text: string): void {
  if (e.textContent !== text) e.textContent = text;
}

const stop = (ev: Event) => ev.stopPropagation();

/** A button that shows only an icon, named for assistive technology and in a tooltip. */
function iconButton(name: IconName, label: string, tip: string, cls = 'icon'): HTMLButtonElement {
  const b = el('button', cls);
  b.type = 'button';
  b.setAttribute('aria-label', label);
  b.title = tip;
  b.appendChild(icon(name));
  b.addEventListener('pointerdown', stop);
  return b;
}

/** A group of controls on one surface, named for assistive technology. */
function capsule(name: string, cls?: string): HTMLDivElement {
  const c = el('div', cls === undefined ? 'cap' : `cap ${cls}`);
  c.setAttribute('role', 'group');
  c.setAttribute('aria-label', name);
  return c;
}

/** A button group, one button per item, the current one pressed. */
function seg(items: { id: string; label: string }[], onPick: (id: string) => void, name?: string): { el: HTMLDivElement; set(id: string): void } {
  const root = el('div', 'seg');
  root.setAttribute('role', 'group');
  if (name !== undefined) root.setAttribute('aria-label', name);
  const buttons = new Map<string, HTMLButtonElement>();
  for (const it of items) {
    const b = el('button', undefined, it.label);
    b.type = 'button';
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('pointerdown', stop);
    b.addEventListener('click', () => onPick(it.id));
    buttons.set(it.id, b);
    root.appendChild(b);
  }
  return {
    el: root,
    set(id: string) {
      for (const [k, b] of buttons) b.setAttribute('aria-pressed', String(k === id));
    },
  };
}

/** Sets a range input's value and its filled part, which WebKit draws from `--p`. */
function setRange(range: HTMLInputElement, value: number): void {
  range.value = String(value);
  const max = Number(range.max) - Number(range.min);
  range.style.setProperty('--p', `${max > 0 ? (100 * (Number(range.value) - Number(range.min))) / max : 0}%`);
}

/**
 * A chip holds a grip and a label in a body that drags, then a caret. The caret is a menu button for `menu`. For `select` it
 * is a chevron under a native select at opacity 0, which opens the platform's picker, and for `none` it is left out. The caret
 * never starts a drag.
 */
export function buildChip(text: string, caret: 'menu' | 'select' | 'none') {
  const root = el('div', 'chip');
  const body = el('span', 'body');
  const label = el('span', 'lbl', text);
  body.append(icon('grip', 'grip'), label);
  root.appendChild(body);
  let button: HTMLButtonElement | null = null;
  let select: HTMLSelectElement | null = null;
  if (caret === 'menu') {
    button = el('button', 'caret');
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-label', `${text}: placement`);
    button.title = 'Add, split, or replace a panel';
    button.appendChild(icon('chevronDown'));
    button.addEventListener('pointerdown', stop);
    root.appendChild(button);
  } else if (caret === 'select') {
    const holder = el('span', 'caret');
    select = el('select');
    holder.append(icon('chevronDown'), select);
    holder.addEventListener('pointerdown', stop);
    root.appendChild(holder);
  }
  return { root, body, label, button, select };
}

/** A readout's elements, as stat tiles when `readoutTiles` splits its parts, in a row under the stage or stacked in a panel. */
export function buildReadout(parts: Readout['parts'], cls: 'wide' | 'stack'): ReadoutDom {
  const tiles = readoutTiles(parts);
  const root = el('div', `readout ${cls}`);
  const line = el('div', 'line');
  let list: HTMLElement | null = null;
  const values: HTMLElement[] = [];
  if (tiles !== null) {
    list = el('dl');
    for (const t of tiles) {
      const item = el('div');
      const dd = el('dd');
      const b = el('b');
      if (t.width !== null) b.style.minWidth = `${t.width}ch`;
      dd.appendChild(b);
      if (t.unit !== '') dd.appendChild(el('span', 'u', t.unit));
      item.append(el('dt', undefined, t.label), dd);
      list.appendChild(item);
      values.push(b);
    }
    root.appendChild(list);
    line.hidden = true;
  }
  root.appendChild(line);
  return { parts, tiles, root, list, values, line };
}

/** Writes a readout: its value parts into the tiles, or the whole text, or an error, as a line. */
export function fillReadout(r: ReadoutDom, pieces: string[] | { error: string }): void {
  const ok = Array.isArray(pieces);
  if (ok && r.tiles !== null && r.list !== null && pieces.length > 0) {
    r.list.hidden = false;
    r.line.hidden = true;
    r.tiles.forEach((t, i) => setText(r.values[i]!, pieces[t.part] ?? ''));
    return;
  }
  if (r.list !== null) r.list.hidden = true;
  r.line.hidden = false;
  setText(r.line, ok ? pieces.join('') : pieces.error);
}

/** The words inside a drop overlay. */
export function dropText(payload: { kind: string }, zone: DropZone): string {
  const panel = payload.kind === 'panel';
  if (zone === 'centre') return panel ? 'swap' : 'replace';
  const side = { left: 'left', right: 'right', top: 'above', bottom: 'below' }[zone];
  return `${panel ? 'move' : 'split'} ${side}`;
}

/** HTMLElement where there is one, so that importing this module under Node does not throw. */
const Base = (typeof HTMLElement === 'undefined' ? class {} : HTMLElement) as typeof HTMLElement;
