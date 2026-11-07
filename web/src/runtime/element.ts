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

const STYLE = `
:host { display: block; position: relative; background: var(--bg); color: var(--fg);
  font: 13px/1.4 "Helvetica Neue", Arial, sans-serif; overflow: hidden; min-height: 240px; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
:focus { outline: none; }
:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 2px; }
button, select, input { font: inherit; color: inherit; margin: 0; }
.root { position: absolute; inset: 0; display: grid; grid-template-rows: auto 1fr auto auto; }
.root.kiosk { grid-template-rows: 1fr; }
.root.kiosk header, .root.kiosk .stats, .root.kiosk footer, .root.kiosk .phead { display: none; }
.root.dragging, .root.dragging * { cursor: grabbing !important; }

header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 24px; padding: 10px 14px 8px; }
header h1 { font-size: 17px; font-weight: 600; margin: 0; letter-spacing: 0.01em; }
.vars { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 18px; }
.vars:empty { display: none; }
.add { display: flex; align-items: center; min-width: 0; }
.chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
.k { color: var(--dim); font-size: 12px; }
.chips > .k { margin-right: 2px; }
.field { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }
.field output { font: 12px ui-monospace, Menlo, monospace; font-variant-numeric: tabular-nums; min-width: 7ch; color: var(--fg); }

.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; background: var(--surface); }
.seg button { background: none; color: var(--dim); border: 0; padding: 4px 10px; cursor: pointer; white-space: nowrap; }
.seg button + button { border-left: 1px solid var(--line); }
.seg button:hover { background: var(--raised); color: var(--fg); }
.seg button[aria-pressed="true"] { background: var(--accent-tint); color: var(--fg); box-shadow: inset 0 -2px var(--accent); }
.seg button:focus-visible { outline-offset: -2px; }
.mini .seg button { padding: 1px 7px; font-size: 11px; }
.icon { width: 28px; height: 28px; flex: none; display: inline-grid; place-items: center; padding: 0; border: 0; border-radius: 6px;
  background: none; color: var(--dim); cursor: pointer; }
.icon:hover { background: var(--raised); color: var(--fg); }
.icon svg { width: 16px; height: 16px; }
.icon.play { color: var(--fg); }
.icon.play.on { color: var(--accent); }
.btn { display: inline-flex; align-items: center; gap: 6px; background: var(--surface); color: var(--fg); border: 1px solid var(--line);
  border-radius: 6px; padding: 4px 10px; cursor: pointer; }
.btn:hover { background: var(--raised); }
.btn svg { width: 14px; height: 14px; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #000; }
.btn.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
.btn.primary:active { background: var(--accent-press); border-color: var(--accent-press); }
.btn:disabled { opacity: 0.45; cursor: default; }
.btn[aria-expanded="true"] .chev { transform: rotate(180deg); color: var(--accent-2); }
select { background: var(--surface); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 3px 6px; cursor: pointer; }
select option { background: var(--raised); color: var(--fg); }
input[type=checkbox] { accent-color: var(--accent); }

input[type=range] { -webkit-appearance: none; appearance: none; background: none; width: 200px; height: 18px; cursor: pointer; --p: 0%; }
input[type=range]::-webkit-slider-runnable-track { height: 4px; border-radius: 2px;
  background: linear-gradient(to right, var(--accent) var(--p), var(--track) var(--p)); }
input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 14px; height: 14px; margin-top: -5px;
  border: 0; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 2px var(--bg); }
input[type=range]:hover::-webkit-slider-thumb { background: var(--accent-hover); }
input[type=range]::-moz-range-track { height: 4px; border-radius: 2px; background: var(--track); }
input[type=range]::-moz-range-progress { height: 4px; border-radius: 2px; background: var(--accent); }
input[type=range]::-moz-range-thumb { width: 14px; height: 14px; border: 0; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 2px var(--bg); }
input[type=range]:disabled { opacity: 0.4; cursor: default; }
.mini input[type=range] { width: 90px; }

.chip { display: inline-flex; align-items: stretch; border: 1px solid var(--line); border-radius: 6px; background: var(--surface);
  color: var(--fg); user-select: none; -webkit-user-select: none; white-space: nowrap; }
.chip .body { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px 3px 4px; cursor: grab; touch-action: none; border-radius: 5px; }
.chip .body:not(:last-child) { border-radius: 5px 0 0 5px; }
.chip .body:hover, .chip .caret:hover { background: var(--raised); }
.chip .body:focus-visible { outline-offset: -2px; }
.chip .grip { width: 14px; height: 14px; flex: none; color: var(--dim); }
.chip .caret { position: relative; display: inline-grid; place-items: center; min-width: 24px; padding: 0 4px; border: 0;
  border-left: 1px solid var(--line); border-radius: 0 5px 5px 0; background: none; color: var(--dim); cursor: pointer; }
.chip .caret svg { width: 14px; height: 14px; transition: transform 0.15s; }
.chip .caret[aria-expanded="true"] { color: var(--accent-2); }
.chip .caret[aria-expanded="true"] svg { transform: rotate(180deg); }
.chip .caret select { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; border: 0; padding: 0; }
.chip .caret:has(select:focus-visible) { outline: 2px solid var(--accent-2); outline-offset: 2px; color: var(--accent-2); }
.chip.source { opacity: 0.4; }
.ghost { position: fixed; left: 0; top: 0; z-index: 30; pointer-events: none; transform: translate(12px, 12px);
  border-color: var(--accent-2); background: var(--raised); box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5); }
.ghost .grip { visibility: visible !important; }

.menu { position: fixed; z-index: 40; min-width: 180px; max-height: 70vh; overflow: auto; display: flex; flex-direction: column; padding: 4px;
  background: var(--raised); border: 1px solid var(--line); border-radius: 6px; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.55); }
.menu button { text-align: left; background: none; border: 0; border-radius: 4px; padding: 5px 10px; color: var(--fg); cursor: pointer; white-space: nowrap; }
.menu button:hover:not(:disabled) { background: var(--accent-tint); }
.menu button:focus-visible { outline-offset: -2px; }
.menu button:disabled { color: var(--dim); cursor: default; }
.menu hr { border: 0; border-top: 1px solid var(--line); margin: 4px 2px; }

.stage { position: relative; min-height: 120px; overflow: hidden; background: var(--gutter); }
.stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.panels { position: absolute; inset: 0; }
.panel { position: absolute; overflow: hidden; }
.pbody { position: absolute; inset: 0; }
.phead { position: absolute; top: 0; left: 0; right: 0; z-index: 2; display: flex; flex-wrap: wrap; align-items: center; gap: 2px 8px;
  padding: 3px 3px 3px 6px; background: var(--head); cursor: grab; user-select: none; -webkit-user-select: none; touch-action: none;
  font-size: 12px; white-space: nowrap; min-width: 0; }
.phead .t { font-weight: 600; flex: 0 1 auto; min-width: 2em; overflow: hidden; text-overflow: ellipsis; }
.phead .m { color: var(--dim); flex: 0 10 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.phead .pc { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 2px 8px; flex: 0 1 auto; min-width: 0; }
.phead select { padding: 0 4px; font-size: 11px; }
.phead .sp { flex: 1 0 0; }
.phead .icon { width: 24px; height: 24px; }
.phead .chip { min-width: 0; }
.phead .chip .body { padding: 1px 6px 1px 2px; min-width: 0; }
.phead .chip .lbl { overflow: hidden; text-overflow: ellipsis; }
.phead .chip .grip { visibility: hidden; }
.phead .chip:is(:hover, :focus-within) .grip { visibility: visible; }
.labels, .preadout, .perror, .drop, .cbars { pointer-events: none; }
.labels { position: absolute; inset: 0; z-index: 1; overflow: hidden; }
.labels span { position: absolute; left: 0; top: 0; white-space: nowrap; color: var(--fg); font-size: 12px; text-shadow: 0 0 3px var(--bg), 0 0 3px var(--bg); }
.cbars { position: absolute; right: 10px; top: 40px; z-index: 1; display: flex; gap: 12px; }
.cbar { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; font-size: 11px; color: var(--dim); }
.cbar-t { max-width: 9em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cbar-b { display: flex; gap: 5px; height: 120px; }
.cbar-g { position: relative; width: 8px; border: 1px solid var(--line); }
.cbar-g.live { width: 12px; pointer-events: auto; cursor: ns-resize; touch-action: none; }
.cbar-g.live:hover { border-color: var(--dim); }
.cbar-k { position: absolute; left: -3px; right: -3px; background: var(--fg); opacity: 0.18; }
.cbar-g i { position: absolute; left: -9px; right: 0; bottom: 0; height: 0; }
.cbar-g i::before { content: ""; position: absolute; left: 0; top: -4px; border: 4px solid transparent; border-left: 6px solid var(--highlight); border-right: 0; }
.cbar-g.live i::after { content: ""; position: absolute; left: 9px; right: 0; top: -1px; height: 2px; background: var(--highlight); box-shadow: 0 0 0 1px var(--bg); }
.cbar-n { display: flex; flex-direction: column; justify-content: space-between; font-variant-numeric: tabular-nums; }
.preadout { position: absolute; left: 8px; bottom: 6px; z-index: 1; display: flex; flex-direction: column; gap: 6px;
  text-shadow: 0 0 3px var(--bg), 0 0 3px var(--bg); }
.perror { position: absolute; inset: 34px 12px auto 12px; z-index: 1; color: var(--error); white-space: pre-wrap; }
.drop { position: absolute; inset: 0; z-index: 3; display: grid; place-items: center; background: var(--accent-2-tint); border: 2px solid var(--accent-2); }
.drop span { font-size: 11px; color: var(--fg); background: var(--raised); border-radius: 4px; padding: 1px 6px; }
.gutter { position: absolute; z-index: 2; touch-action: none; background: var(--gutter); }
.gutter.row { cursor: col-resize; }
.gutter.col { cursor: row-resize; }
.gutter:hover, .gutter.active { background: var(--accent-tint); }

.stats { display: flex; flex-direction: column; gap: 4px; padding: 8px 14px 0; }
.stats:empty { display: none; }
.readout dl { display: flex; flex-wrap: wrap; margin: 0; }
.wide dl > div { padding: 0 16px; border-left: 1px solid var(--line); }
.wide dl > div:first-child { border-left: 0; padding-left: 0; }
.stack dl { flex-direction: column; gap: 2px; }
.readout dt { font-size: 11px; color: var(--dim); }
.readout dd { margin: 0; white-space: nowrap; }
.readout b { display: inline-block; font: 500 15px/1.25 ui-monospace, Menlo, monospace; font-variant-numeric: tabular-nums; }
.stack b { font-size: 13px; }
.readout .u { color: var(--dim); font-size: 12px; margin-left: 0.35em; }
.readout .line { white-space: pre-wrap; font-variant-numeric: tabular-nums; }

footer { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 8px 14px 10px; }
.cap { display: flex; align-items: center; gap: 4px; padding: 3px; min-height: 36px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
.cap.playback { flex: 1 1 520px; flex-wrap: wrap; }
.cap .scrub { flex: 1 1 160px; min-width: 100px; width: auto; margin: 0 6px; }
.cap select { background: none; border-color: transparent; }
.cap select:hover { background: var(--raised); }
.frame, .fps { color: var(--dim); font: 12px ui-monospace, Menlo, monospace; font-variant-numeric: tabular-nums; white-space: nowrap; text-align: right; }
/* the rate reserves three digits as content, so that the dashes, 9 fps, and 120 fps take one width */
.fps { box-sizing: content-box; min-width: 7ch; padding: 0 6px 0 4px; }
.speed { font-variant-numeric: tabular-nums; }
.why { color: var(--dim); }
.disclose { position: relative; display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border: 0; border-radius: 6px;
  background: none; color: var(--fg); cursor: pointer; overflow: hidden; }
.disclose:hover { background: var(--raised); }
.disclose svg { width: 16px; height: 16px; }
.disclose .chev { width: 14px; height: 14px; color: var(--dim); transition: transform 0.15s; }
.disclose[aria-expanded="true"] { background: var(--accent-tint); box-shadow: inset 0 -2px var(--accent); }
.disclose[aria-expanded="true"] .chev { transform: rotate(180deg); }
.disclose:disabled { color: var(--dim); cursor: default; background: none; }
.disclose .xprog { position: absolute; left: 0; top: 0; height: 2px; width: 0; background: var(--accent); }
.exportbar { flex-basis: 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 4px 4px 4px 8px;
  background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
.exportbar .info { flex: 1 1 12em; color: var(--dim); font-variant-numeric: tabular-nums; }
.exportbar progress { width: 160px; accent-color: var(--accent); }
.status { position: absolute; inset: 0; display: grid; place-items: center; padding: 20px; color: var(--dim); white-space: pre-wrap; z-index: 5; }
.status.error { color: var(--error); }
`;

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

/**
 * The class of the `<tycho-viewer>` element. It reads its attributes once, when it connects, and shows the error
 * of a scene that cannot be read in place of the panels.
 */
export class TychoViewerElement extends Base {
  private scene: Scene | null = null;
  private sceneText = '';
  private geometry: GeometryCache | null = null;
  private store: Store | null = null;
  private renderer: StageRenderer | null = null;
  private kiosk = false;
  private loading = false;
  /** Counts the loads begun, so that a load that a later one overtook drops its result. */
  private loads = 0;
  /** The panel-scoped choice that a panel's header chip shows. */
  private choice: { id: string; def: Choice; label: string } | null = null;

  private root!: HTMLDivElement;
  private header!: HTMLElement;
  private titleEl!: HTMLHeadingElement;
  private varsEl!: HTMLDivElement;
  private addEl!: HTMLDivElement;
  private stage!: HTMLDivElement;
  private panelsEl!: HTMLDivElement;
  private statusEl!: HTMLDivElement;
  private statsEl!: HTMLDivElement;
  private footer!: HTMLElement;
  private canvas: HTMLCanvasElement | null = null;

  private readonly panelDom = new Map<string, PanelDom>();
  private readonly gutterDom = new Map<string, HTMLDivElement>();
  private gutters: Gutter[] = [];
  private sceneWidgets: Widget[] = [];
  private captions: ReadoutDom[] = [];
  private addChips: HTMLElement[] = [];
  private addButton: HTMLButtonElement | null = null;
  private addGroup: HTMLElement | null = null;
  private transport: {
    play: HTMLButtonElement;
    scrub: HTMLInputElement;
    frame: HTMLSpanElement;
    fps: HTMLSpanElement;
    channel: { set(id: string): void } | null;
  } | null = null;
  private menu: { anchor: HTMLElement; close(focus: boolean): void } | null = null;
  /** Closes the export row when it is open, and returns whether it was open. */
  private closeExport: (() => boolean) | null = null;

  private raf = 0;
  private dirty = true;
  private anchor = { index: 0, time: 0 };
  /** The progress that playback last reached, between two frame indices, or null while paused. */
  private playProgress: number | null = null;
  private speed = 1;
  private readonly meter = new FrameMeter();
  /** The stage's size in CSS pixels, kept by the resize observer so that a draw never forces a layout. */
  private stageSize = { w: 0, h: 0 };
  private saveTimer = 0;
  private resizeObserver: ResizeObserver | null = null;
  private readonly onPageHide = () => this.flushSave();
  private unsubscribe: (() => void) | null = null;
  private lastPanels: State['panels'] | null = null;
  private lastLayout: Layout | null = null;
  /** Restates the export's length when the speed changes. */
  private refreshExport: (() => void) | null = null;

  connectedCallback(): void {
    if (this.shadowRoot === null) this.buildShell();
    if (this.scene !== null) {
      this.start();
      return;
    }
    if (this.loading || !(this.hasAttribute('scene') && this.hasAttribute('data'))) return;
    this.loading = true;
    // the scripts that the attributes select may come after the element
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void this.loadFromAttributes(), { once: true });
    else void this.loadFromAttributes();
  }

  disconnectedCallback(): void {
    this.stop();
  }

  private buildShell(): void {
    this.kiosk = this.hasAttribute('kiosk');
    const shadow = this.attachShadow({ mode: 'open' });
    const style = el('style');
    style.textContent = STYLE;
    shadow.appendChild(style);
    this.root = el('div', this.kiosk ? 'root kiosk' : 'root');
    this.header = el('header');
    this.titleEl = el('h1');
    this.varsEl = el('div', 'vars');
    this.varsEl.setAttribute('role', 'group');
    this.varsEl.setAttribute('aria-label', 'Scene');
    this.addEl = el('div', 'add');
    this.addEl.setAttribute('role', 'group');
    this.addEl.setAttribute('aria-label', 'Add panel');
    this.header.append(this.titleEl, this.varsEl, this.addEl);
    this.stage = el('div', 'stage');
    this.panelsEl = el('div', 'panels');
    this.statusEl = el('div', 'status', 'loading…');
    this.stage.append(this.panelsEl, this.statusEl);
    this.statsEl = el('div', 'stats');
    this.footer = el('footer');
    this.root.append(this.header, this.stage, this.statsEl, this.footer);
    shadow.appendChild(this.root);
    this.tabIndex = 0;
    this.addEventListener('keydown', (ev) => this.onKey(ev));
  }

  private fail(message: string): void {
    this.statusEl.hidden = false;
    this.statusEl.className = 'status error';
    this.statusEl.textContent = message;
  }

  private async loadFromAttributes(): Promise<void> {
    try {
      const find = (attr: string): HTMLElement => {
        const sel = this.getAttribute(attr);
        if (!sel) throw new Error(`the ${attr} attribute is missing`);
        const root = this.getRootNode() as Document | ShadowRoot;
        const found = (root.querySelector?.(sel) ?? document.querySelector(sel)) as HTMLElement | null;
        if (found === null) throw new Error(`the ${attr} selector ${sel} does not match an element`);
        return found;
      };
      const read = (e: HTMLElement) => decodeEmbedded(e.textContent ?? '', e.dataset.encoding ?? 'base64');
      const sceneBytes = read(find('scene'));
      const dataBytes = read(find('data'));
      if (this.loads > 0) return;
      await this.load(new TextDecoder('utf-8').decode(sceneBytes), dataBytes);
    } catch (e) {
      this.fail(`the scene did not load: ${(e as Error).message}`);
    }
  }

  /**
   * Loads a scene from the text of scene.tys and the bytes of data.tyd, and resolves once the scene or
   * its error shows. A load begun later takes precedence over this one.
   */
  async load(sceneText: string, dataBytes: Uint8Array): Promise<void> {
    if (this.shadowRoot === null) this.buildShell();
    const ticket = ++this.loads;
    let scene: Scene;
    let data: Container;
    try {
      scene = JSON.parse(sceneText) as Scene;
      data = await Container.parse(dataBytes);
      if (ticket !== this.loads) return;
      for (const w of validate(scene, data)) console.warn(`TyCHO: ${w}`);
    } catch (e) {
      if (ticket !== this.loads) return;
      this.stop();
      this.fail(e instanceof TychoError ? e.message : `the scene cannot be read: ${(e as Error).message}`);
      return;
    }
    this.stop();
    this.scene = scene;
    this.sceneText = sceneText;
    this.geometry = new GeometryCache(scene, data);
    this.store = new Store(this.recall(), scene.clock.steps);
    this.choice = this.templateChoice();
    this.statusEl.hidden = true;
    this.applyTheme();
    this.titleEl.textContent = scene.title ?? '';
    this.buildTopBar();
    this.buildFooter();
    this.start();
    if (this.kiosk) this.play();
  }
}

/**
 * Registers TychoViewerElement as the custom element `tag`, which a page passes when the default name is taken. It does
 * not do anything when an element named `tag` is already defined or where the environment lacks custom elements (e.g. Node).
 */
export function define(tag = 'tycho-viewer'): void {
  if (typeof customElements !== 'undefined' && !customElements.get(tag)) customElements.define(tag, TychoViewerElement);
}
