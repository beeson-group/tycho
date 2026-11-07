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
import { chromeTokens, hostTheme, sceneTheme, type Theme } from './colors.js';
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
  controlUsesKey,
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

function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** HTMLElement where there is one, so that importing this module under Node does not throw. */
const Base = (typeof HTMLElement === 'undefined' ? class {} : HTMLElement) as typeof HTMLElement;

/**
 * The class of the `<tycho-viewer>` element. It reads its attributes once, when it connects, apart from `theme`, and shows the
 * error of a scene that cannot be read in place of the panels.
 */
export class TychoViewerElement extends Base {
  static readonly observedAttributes = ['theme'];

  private scene: Scene | null = null;
  private sceneText = '';
  private geometry: GeometryCache | null = null;
  private store: Store | null = null;
  private renderer: StageRenderer | null = null;
  /** The colors in use, or null before a scene loads. */
  private theme: Theme | null = null;
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
  /** Whether the element intersects the viewport. It stays true where IntersectionObserver does not exist. */
  private intersecting = true;
  /** Whether the animation loop may run, i.e. the element intersects the viewport and the page is visible. */
  private shown = false;
  private viewObserver: IntersectionObserver | null = null;
  private readonly onVisibility = () => this.syncShown();
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
      this.applyTheme();
      this.start();
      return;
    }
    if (this.loading) return;
    this.loading = true;
    // the parser may not have reached the blocks yet, whether they are children of the element or come after it
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void this.loadFromSources(), { once: true });
    else void this.loadFromSources();
  }

  disconnectedCallback(): void {
    this.stop();
  }

  attributeChangedCallback(): void {
    this.applyTheme();
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
    if (!this.hasAttribute('tabindex')) this.tabIndex = 0;
    this.addEventListener('keydown', (ev) => this.onKey(ev));
  }

  private fail(message: string): void {
    this.statusEl.hidden = false;
    this.statusEl.className = 'status error';
    this.statusEl.textContent = message;
  }

  /** The element that `selector` matches, or null when it does not match any or is not a valid selector, as most URLs are not. */
  private select(selector: string): HTMLElement | null {
    const root = this.getRootNode() as Document | ShadowRoot;
    try {
      return (root.querySelector?.(selector) ?? document.querySelector(selector)) as HTMLElement | null;
    } catch {
      return null;
    }
  }

  /** The block or the URL of the scene or the data, by the order given at the top of this file, or null when the page gives neither. */
  private source(kind: 'scene' | 'data'): HTMLElement | string | null {
    for (const child of this.children) if (child.tagName === 'SCRIPT' && child.getAttribute('data-tycho') === kind) return child as HTMLElement;
    const value = this.getAttribute(kind);
    if (!value) return this.select(`#tycho-${kind}`);
    const found = this.select(value);
    if (found === null && value.startsWith('#')) throw new Error(`the ${kind} selector ${value} does not match an element`);
    return found ?? value;
  }

  private async read(source: HTMLElement | string): Promise<Uint8Array> {
    if (typeof source !== 'string') return decodeEmbedded(source.textContent ?? '', source.getAttribute('data-encoding') ?? 'base64');
    const response = await fetch(source);
    if (!response.ok) throw new Error(`${source} answered ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  /** Loads the scene that the page gives this viewer. A viewer without any source stays empty until a caller invokes `load`. */
  private async loadFromSources(): Promise<void> {
    try {
      const scene = this.source('scene');
      const data = this.source('data');
      if (scene === null && data === null) {
        this.loading = false;
        return;
      }
      if (scene === null || data === null) throw new Error(`the ${scene === null ? 'scene' : 'data'} is missing`);
      const [sceneBytes, dataBytes] = await Promise.all([this.read(scene), this.read(data)]);
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
    if ((this.kiosk || this.hasAttribute('autoplay')) && !reducedMotion()) this.play();
  }

  // lifecycle

  private start(): void {
    if (this.scene === null || this.store === null || this.renderer !== null || !this.isConnected) return;
    this.canvas = el('canvas');
    this.stage.insertBefore(this.canvas, this.panelsEl);
    try {
      this.renderer = new StageRenderer(this.canvas, this.scene, this.geometry!, { theme: this.theme! });
    } catch (e) {
      this.fail(`WebGL is not available: ${(e as Error).message}`);
      return;
    }
    this.renderer.onChange = () => this.invalidate();
    this.unsubscribe = this.store.subscribe((change) => this.onChange(change));
    this.measureStage();
    this.resizeObserver = new ResizeObserver(() => {
      this.measureStage();
      this.layoutDom();
      this.fitAddGroup();
      this.invalidate();
    });
    this.resizeObserver.observe(this.stage);
    this.resizeObserver.observe(this.header);
    window.addEventListener('pagehide', this.onPageHide);
    document.addEventListener('visibilitychange', this.onVisibility);
    if (typeof IntersectionObserver !== 'undefined') {
      this.intersecting = false;
      this.viewObserver = new IntersectionObserver(
        (entries) => {
          this.intersecting = entries[entries.length - 1]!.isIntersecting;
          this.syncShown();
        },
        { threshold: 0 },
      );
      this.viewObserver.observe(this);
    }
    this.lastPanels = null;
    this.lastLayout = null;
    for (const pid of [...this.panelDom.keys()]) this.removePanelDom(pid);
    this.onChange('state');
    if (this.store.playing) this.onChange('playing');
    this.syncShown();
  }

  private stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.shown = false;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.viewObserver?.disconnect();
    this.viewObserver = null;
    this.flushSave();
    this.closeMenu(false);
    window.removeEventListener('pagehide', this.onPageHide);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.renderer?.dispose();
    this.renderer = null;
    this.canvas?.remove();
    this.canvas = null;
  }

  /** The computed value of a custom property on the host, or an empty string when it is not set. */
  private hostProperty(name: string): string {
    return typeof getComputedStyle === 'undefined' ? '' : getComputedStyle(this).getPropertyValue(name).trim();
  }

  /** Recolors the chrome and a live renderer from the scene's theme, the `theme` attribute, and the custom properties of the host. */
  private applyTheme(): void {
    if (this.scene === null) return;
    this.theme = hostTheme(sceneTheme(this.scene), this.getAttribute('theme'), (name) => this.hostProperty(name));
    for (const [k, v] of Object.entries(chromeTokens(this.theme))) this.style.setProperty(k, v);
    this.renderer?.setTheme(this.theme);
    this.invalidate();
  }

  // state

  private recall(): State {
    const scene = this.scene!;
    if (this.kiosk) return structuredClone(scene.initial);
    try {
      const text = localStorage.getItem(storageKey(this.sceneText));
      return text === null ? structuredClone(scene.initial) : repair(scene, JSON.parse(text));
    } catch {
      return structuredClone(scene.initial);
    }
  }

  private save(): void {
    if (this.kiosk) return;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.flushSave(), 300);
  }

  private flushSave(): void {
    if (this.saveTimer === 0 || this.store === null) return;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    try {
      localStorage.setItem(storageKey(this.sceneText), JSON.stringify(this.store.state));
    } catch {
      // localStorage may be unavailable, and the state is then not saved
    }
  }

  /** Returns to the scene's initial state and discards the stored state. */
  reset(): void {
    if (this.scene === null || this.store === null) return;
    try {
      localStorage.removeItem(storageKey(this.sceneText));
    } catch {
      // localStorage may be unavailable, and a state was then never stored
    }
    this.closeMenu(false);
    this.store.set(structuredClone(this.scene.initial));
    for (const pid of this.panelDom.keys()) this.renderer?.refit(pid);
  }

  /** The current state snapshot of section 2.8, or null before a scene loads. */
  get state(): State | null {
    return this.store?.state ?? null;
  }

  private onChange(change: 'state' | 'frame' | 'playing'): void {
    const store = this.store!;
    if (change === 'state') {
      const st = store.state;
      if (st.panels !== this.lastPanels) this.syncPanels();
      if (st.layout !== this.lastLayout || st.panels !== this.lastPanels) this.layoutDom();
      this.lastPanels = st.panels;
      this.lastLayout = st.layout;
      this.syncWidgets();
      this.save();
    } else if (change === 'playing') {
      const t = this.transport;
      if (t !== null) {
        const label = store.playing ? 'Pause (k)' : 'Play (k)';
        t.play.replaceChildren(icon(store.playing ? 'pause' : 'play'));
        t.play.setAttribute('aria-label', label);
        t.play.title = label;
        t.play.classList.toggle('on', store.playing);
      }
      this.meter.reset();
      this.playProgress = null;
      if (t !== null) this.showRate(null);
      if (store.playing) this.anchor = { index: store.frame, time: performance.now() };
    }
    this.invalidate();
  }

  private invalidate(): void {
    this.dirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.raf === 0 && this.renderer !== null && this.shown) this.raf = requestAnimationFrame((t) => this.tick(t));
  }

  /** Stops the animation loop when the element stops being shown, and restarts it when the element comes back, with the clock where it paused. */
  private syncShown(): void {
    const shown = this.intersecting && !document.hidden;
    if (shown === this.shown) return;
    this.shown = shown;
    if (!shown) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      return;
    }
    if (this.store?.playing) {
      this.meter.reset();
      this.anchor = { index: this.playPosition(), time: performance.now() };
    }
    this.invalidate();
  }

  /** The loop position that playback last reached, between two frame indices, so that a new anchor does not move the picture back to a frame index. */
  private playPosition(): number {
    return this.playProgress === null ? this.store!.frame : this.playProgress * this.scene!.clock.steps;
  }

  /**
   * One animation frame. In live playback it maps wall time to a loop position, whose integer part is the
   * frame index the controls show, and draws at the fractional progress every frame. Otherwise it draws
   * if anything changed.
   */
  private tick(now: number): void {
    this.raf = 0;
    const store = this.store!;
    const clock = this.scene!.clock;
    if (store.playing) {
      const x = loopPosition(this.anchor.index, now - this.anchor.time, 1000, clock.steps, this.speed, loopSeconds(clock));
      store.setFrame(positionIndex(x, clock.steps));
      this.playProgress = positionProgress(x, clock.steps);
      this.dirty = true;
    }
    if (this.dirty) {
      this.dirty = false;
      this.draw();
      if (store.playing) this.countDraw(now);
    }
    if (store.playing) this.schedule();
  }

  /** Feeds the frame rate shown in the Playback group with a draw presented at `now`. */
  private countDraw(now: number): void {
    this.meter.note(now);
    this.showRate(this.meter.report(now));
  }

  private showRate(report: FrameReport | null): void {
    const t = this.transport;
    if (t === null) return;
    setText(t.fps, fpsText(report));
    const title = fpsTitle(report);
    if (t.fps.title !== title) t.fps.title = title;
  }

  /** Reads the stage's size once per resize, so that the draw loop never forces a layout. */
  private measureStage(): void {
    this.stageSize = { w: this.stage.clientWidth, h: this.stage.clientHeight };
  }

  private draw(): void {
    const renderer = this.renderer;
    const store = this.store!;
    const scene = this.scene!;
    if (renderer === null) return;
    const st = store.state;
    const { w, h } = this.stageSize;
    if (w < 1 || h < 1) return;
    const q = store.playing && this.playProgress !== null ? this.playProgress : store.frame / scene.clock.steps;
    const errors = renderer.renderAt(st, q, w, h, Math.min(window.devicePixelRatio || 1, 2));
    for (const [pid, dom] of this.panelDom) {
      setText(dom.error, errors.get(pid) ?? '');
      for (const r of dom.readouts) fillReadout(r, this.pieces(pid, r.parts, q));
      if (dom.barsFor !== st) {
        this.syncBars(pid, dom);
        dom.barsFor = st;
      }
    }
    const first = this.firstPanel();
    for (const r of this.captions) fillReadout(r, first === null ? [] : this.pieces(first, r.parts, q));
    if (this.transport) {
      setRange(this.transport.scrub, store.frame);
      setText(this.transport.frame, `${store.frame} / ${scene.clock.steps}`);
    }
  }

  private pieces(pid: string, parts: Readout['parts'], q: number): string[] | { error: string } {
    try {
      const ctx = { scene: this.scene!, geometry: this.geometry!, state: this.store!.state, panel: pid, frameIndex: this.store!.frame, progress: q };
      return readoutPieces(ctx, parts);
    } catch (e) {
      if (e instanceof TychoError) return { error: e.message };
      throw e;
    }
  }

  private firstPanel(): string | null {
    const walk = (n: Layout): string => (n.kind === 'panel' ? n.id : walk(n.a));
    return this.store === null ? null : walk(this.store.state.layout);
  }

  // transport

  private hasTransport(): boolean {
    return (this.scene?.controls ?? []).some((c) => c.kind === 'transport');
  }

  /** Whether the clock is set to run. It stays true while the clock waits for the element to be shown. */
  get playing(): boolean {
    return this.store?.playing ?? false;
  }

  /** Starts the clock, at once or when the element is next shown. It does not do anything before a scene loads. */
  play(): void {
    this.store?.setPlaying(true);
  }

  /** Stops the clock. It does not do anything before a scene loads. */
  pause(): void {
    this.store?.setPlaying(false);
  }

  private step(by: number): void {
    const store = this.store;
    if (store === null) return;
    this.pause();
    store.setFrame(store.frame + by);
  }

  /** Goes to a frame, playing on from there when playing. */
  private seek(frame: number): void {
    const store = this.store!;
    store.setFrame(frame);
    this.playProgress = null;
    if (store.playing) this.anchor = { index: store.frame, time: performance.now() };
  }

  private onKey(ev: KeyboardEvent): void {
    if (this.useKey(ev)) ev.stopPropagation();
  }

  /**
   * Acts on a key that reached the element, and returns whether the viewer used it. A key used by a focused control counts as
   * used, since a listener on the document, such as reveal.js's, sees the event retargeted to the element and cannot tell.
   */
  private useKey(ev: KeyboardEvent): boolean {
    if (this.store === null || ev.metaKey || ev.ctrlKey || ev.altKey) return false;
    if (ev.key === 'Escape') {
      if (this.menu !== null) this.closeMenu(true);
      else if (!this.closeExport?.()) return false;
      ev.preventDefault();
      return true;
    }
    const action = keyAction(ev.key, ev.shiftKey, this.scene!.clock.steps);
    const target = ev.composedPath()[0] as Element | undefined;
    if (target !== undefined && ['INPUT', 'SELECT', 'BUTTON', 'TEXTAREA'].includes(target.tagName)) {
      return action !== null || controlUsesKey(target.tagName, (target as HTMLInputElement).type, ev.key);
    }
    if (action === null) return false;
    if (action.kind === 'fit') {
      ev.preventDefault();
      this.fitAll();
      return true;
    }
    if (action.kind === 'slider') {
      if (!this.stepSlider(action.by)) return false;
      ev.preventDefault();
      return true;
    }
    if (!this.hasTransport() && !this.kiosk) return false;
    ev.preventDefault();
    if (action.kind === 'toggle') this.store.setPlaying(!this.store.playing);
    else if (action.kind === 'step') this.step(action.by);
    else this.seek(action.frame);
    return true;
  }

  /** Fits every panel's camera to what it draws. */
  fitAll(): void {
    this.renderer?.refitAll();
    this.invalidate();
  }

  private fitPanel(pid: string): void {
    this.renderer?.refit(pid);
    this.invalidate();
  }

  /** Moves the first scene-scoped slider by `by` stops, and returns false when there is not a slider with stops to move. */
  private stepSlider(by: number): boolean {
    const scene = this.scene!;
    const st = this.store!.state;
    const first = this.firstPanel();
    const control = (scene.controls ?? []).find((c) => c.kind === 'slider' && variableDef(scene, c.variable)?.scope !== 'panel') as
      Extract<Control, { kind: 'slider' }> | undefined;
    if (control === undefined || first === null) return false;
    const scope: PanelScope = { scene, state: st, panel: st.panels[first]! };
    const stops = sliderStops(scope, this.geometry!.sets, control);
    if (stops.length === 0) return false;
    const value = this.panelValue(scope, control.variable) as number;
    const i = Math.min(stops.length - 1, Math.max(0, nearestStop(stops, value) + by));
    this.store!.update((s) => withVariable(scene, s, control.variable, stops[i]!));
    return true;
  }

  private buildFooter(): void {
    const scene = this.scene!;
    this.footer.replaceChildren();
    this.transport = null;
    if (this.hasTransport()) {
      const cap = capsule('Playback', 'playback');
      const play = iconButton('play', 'Play (k)', 'Play (k)', 'icon play');
      play.addEventListener('click', () => this.store!.setPlaying(!this.store!.playing));
      const scrub = el('input', 'scrub');
      scrub.type = 'range';
      scrub.min = '0';
      scrub.max = String(scene.clock.steps - 1);
      scrub.step = '1';
      scrub.setAttribute('aria-label', 'Frame');
      scrub.addEventListener('pointerdown', stop);
      scrub.addEventListener('input', () => {
        this.pause();
        this.store!.setFrame(Number(scrub.value));
      });
      const frame = el('span', 'frame');
      frame.style.minWidth = `${2 * String(scene.clock.steps).length + 3}ch`;
      frame.title = 'Frame index of the loop. Left and right step, Home goes to 0';
      const speed = el('select', 'speed');
      speed.setAttribute('aria-label', 'Playback speed');
      speed.title = 'Playback speed';
      for (const s of SPEEDS) {
        const o = el('option', undefined, `${s}×`);
        o.value = String(s);
        o.selected = s === this.speed;
        speed.appendChild(o);
      }
      speed.addEventListener('change', () => {
        this.speed = Number(speed.value);
        this.anchor = { index: this.playPosition(), time: performance.now() };
        this.refreshExport?.();
      });
      cap.append(play, scrub, frame, speed);
      let channel: { el: HTMLDivElement; set(id: string): void } | null = null;
      if (scene.clock.channels.length > 1) {
        channel = seg(
          scene.clock.channels.map((c, i) => ({ id: c, label: scene.clock.labels?.[i] ?? c })),
          (c) => this.store!.update((s) => withChannel(s, c)),
          'Clock',
        );
        channel.el.title = 'What the frame index runs along';
        cap.append(channel.el);
      }
      const fps = el('span', 'fps', fpsText(null));
      fps.title = fpsTitle(null);
      cap.append(fps);
      this.footer.append(cap);
      this.transport = { play, scrub, frame, fps, channel };
    }
    const view = capsule('View');
    const fit = iconButton('house', 'Reset every view', 'Reset every view: fit each panel to what it draws (F)');
    fit.addEventListener('click', () => this.fitAll());
    const reset = iconButton('rotateCcw', 'Reset scene', 'Reset scene: panels, layout, and controls as written');
    reset.addEventListener('click', () => this.reset());
    view.append(fit, reset);
    this.footer.append(view);
    this.buildExport();
  }

  // video export

  /**
   * Exports a video of the current state, at the viewer's playback speed unless `options.speed` is set,
   * and resolves to an MP4 blob. It rejects for the reasons that exportVideo in export.ts lists, and when
   * the viewer has not loaded a scene.
   */
  exportVideo(options: ExportOptions = {}): Promise<Blob> {
    if (this.scene === null || this.store === null || this.geometry === null) return Promise.reject(new Error('the viewer has not loaded a scene'));
    const stage = { w: this.stage.clientWidth, h: this.stage.clientHeight };
    const font = this.hostProperty('--tycho-font');
    const look = { ...(this.theme === null ? {} : { theme: this.theme }), ...(font === '' ? {} : { font }) };
    return runExport({ scene: this.scene, geometry: this.geometry, state: this.store.state, stage, ...look }, { speed: this.speed, ...options });
  }

  private buildExport(): void {
    const cap = capsule('Export');
    const button = el('button', 'disclose');
    button.type = 'button';
    button.append(icon('download'), el('span', undefined, 'Export video'), icon('chevronDown', 'chev'));
    const bar = el('div', 'exportbar');
    cap.appendChild(button);
    this.footer.appendChild(cap);
    this.closeExport = null;
    const missing = webCodecsMissing();
    if (missing !== null) {
      button.disabled = true;
      this.footer.append(el('span', 'why', `video export is unavailable: ${missing}`));
      return;
    }
    const meter = el('span', 'xprog');
    meter.hidden = true;
    button.appendChild(meter);
    bar.id = 'xbar';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Export options');
    bar.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', 'xbar');
    const setOpen = (open: boolean) => {
      bar.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
      if (open) {
        preselect();
        refresh();
      }
    };
    this.closeExport = () => {
      if (bar.hidden) return false;
      setOpen(false);
      button.focus();
      return true;
    };
    button.addEventListener('click', () => setOpen(bar.hidden !== false));
    const select = (name: string, items: [string, string][]) => {
      const s = el('select');
      s.setAttribute('aria-label', name);
      s.title = name;
      for (const [value, label] of items) {
        const o = el('option', undefined, label);
        o.value = value;
        s.appendChild(o);
      }
      return s;
    };
    const size = select('Size', [
      ['720p', '1280×720'],
      ['1080p', '1920×1080'],
      ['stage', 'stage size'],
    ]);
    const fps = select(
      'Frame rate',
      EXPORT_FPS.map((f) => [String(f), `${f} fps`]),
    );
    fps.value = '30';
    // the stage preset's size depends on the rate, since the size and the rate must fit one H.264 level together
    const stageSize = () => sizePreset('stage', { w: this.stage.clientWidth, h: this.stage.clientHeight }, window.devicePixelRatio || 1, Number(fps.value));
    const loops = select(
      'Loops',
      EXPORT_LOOPS.map((n) => [String(n), n === 1 ? '1 loop' : `${n} loops`]),
    );
    const info = el('span', 'info');
    const start = el('button', 'btn primary', 'Start');
    start.type = 'button';
    const progress = el('progress');
    progress.hidden = true;
    const cancel = el('button', 'btn', 'Cancel');
    cancel.type = 'button';
    cancel.hidden = true;
    const close = iconButton('x', 'Close export options', 'Close (Esc)');
    close.addEventListener('click', () => {
      setOpen(false);
      button.focus();
    });
    let running: AbortController | null = null;
    // one loop at the highest rate that fits EXPORT_LIMITS at the current speed, or at the lowest rate when every rate exceeds them
    const preselect = () => {
      if (running !== null) return;
      const clock = this.scene!.clock;
      loops.value = '1';
      fps.value = String(defaultExportFps(clock.steps, this.speed, loopSeconds(clock)) ?? EXPORT_FPS[0]);
    };
    const refresh = () => {
      if (running !== null) return;
      const stageOption = size.options[2]!;
      const st = stageSize();
      stageOption.textContent = `stage, ${st.width}×${st.height}`;
      const clock = this.scene!.clock;
      const sch = frameSchedule(clock.steps, Number(fps.value), Number(loops.value), this.speed, 0, loopSeconds(clock));
      const refused = checkExport(sch.count, Number(fps.value));
      info.textContent = refused ?? `${sch.count} frames, ${sch.duration.toFixed(1)} s at ${this.speed}× speed`;
      start.disabled = refused !== null;
    };
    for (const s of [size, fps, loops]) s.addEventListener('change', refresh);
    this.refreshExport = () => {
      if (bar.hidden) return;
      preselect();
      refresh();
    };
    start.addEventListener('click', () => {
      const controller = new AbortController();
      running = controller;
      start.disabled = true;
      cancel.hidden = false;
      progress.hidden = false;
      progress.value = 0;
      meter.hidden = false;
      meter.style.width = '0%';
      const preset = size.value as SizePreset;
      const name = `${
        (this.scene!.title ?? 'tycho')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 60) || 'tycho'
      }.mp4`;
      let video = '';
      this.exportVideo({
        size: preset,
        fps: Number(fps.value),
        loops: Number(loops.value),
        signal: controller.signal,
        onConfig: (c) => (video = `${c.width}×${c.height} H.264 ${c.codec}`),
        onProgress: (done, total) => {
          progress.max = total;
          progress.value = done;
          meter.style.width = `${total > 0 ? (100 * done) / total : 0}%`;
          info.textContent = `${video}, frame ${done} of ${total}`;
        },
      })
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          const a = el('a');
          a.href = url;
          a.download = name;
          this.shadowRoot!.appendChild(a);
          a.click();
          a.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 60000);
          info.textContent = `saved ${name}, ${video}, ${(blob.size / 1e6).toFixed(2)} MB`;
        })
        .catch((e: unknown) => {
          info.textContent = e instanceof DOMException && e.name === 'AbortError' ? 'canceled' : `export failed: ${(e as Error).message}`;
        })
        .finally(() => {
          running = null;
          start.disabled = false;
          cancel.hidden = true;
          progress.hidden = true;
          meter.hidden = true;
        });
    });
    cancel.addEventListener('click', () => running?.abort());
    bar.append(size, fps, loops, info, start, progress, cancel, close);
    this.footer.append(bar);
  }

  // the top bar

  private makeWidget(control: Exclude<Control, { kind: 'transport' }>, panel: string | undefined): Widget | null {
    const scene = this.scene!;
    const v = variableDef(scene, control.variable);
    if (v === undefined) return null;
    const write = (value: VariableValue) => this.store!.update((s) => withVariable(scene, s, control.variable, value, panel));
    const current = (scope: PanelScope): VariableValue => {
      const values = v.scope === 'panel' ? scope.panel.variables : scope.state.variables;
      return values !== undefined && Object.hasOwn(values, control.variable) ? values[control.variable]! : v.default;
    };
    const field = (): HTMLLabelElement => {
      const f = el('label', 'field');
      f.appendChild(el('span', 'k', control.label));
      f.addEventListener('pointerdown', stop);
      return f;
    };
    if (control.kind === 'tabs' && v.kind === 'choice' && panel !== undefined && v.values.length > 3) {
      // a compact select in a panel header, where a row of tabs would not fit
      const c = v as Choice;
      const select = el('select');
      c.values.forEach((value, i) => {
        const o = el('option', undefined, c.labels?.[i] ?? value);
        o.value = value;
        select.appendChild(o);
      });
      select.addEventListener('change', () => write(select.value));
      const f = field();
      f.appendChild(select);
      return { el: f, sync: (scope) => void (select.value = String(current(scope))) };
    }
    if (control.kind === 'tabs' && v.kind === 'choice') {
      const c = v as Choice;
      const s = seg(
        c.values.map((value, i) => ({ id: value, label: c.labels?.[i] ?? value })),
        (value) => write(value),
        control.label,
      );
      const wrapper = el('span', 'field');
      wrapper.append(el('span', 'k', control.label), s.el);
      wrapper.addEventListener('pointerdown', stop);
      return { el: wrapper, sync: (scope) => s.set(String(current(scope))) };
    }
    if (control.kind === 'toggle' && v.kind === 'toggle') {
      const box = el('input');
      box.type = 'checkbox';
      box.addEventListener('change', () => write(box.checked));
      const f = field();
      f.prepend(box);
      return { el: f, sync: (scope) => void (box.checked = current(scope) === true) };
    }
    if (control.kind === 'slider' && v.kind === 'selector') {
      const range = el('input');
      range.type = 'range';
      range.min = '0';
      range.step = '1';
      const out = el('output');
      let stops: number[] = [];
      range.addEventListener('input', () => {
        setRange(range, Number(range.value));
        const value = stops[Number(range.value)];
        if (value !== undefined) write(value);
      });
      const f = field();
      f.append(range, out);
      return {
        el: f,
        sync: (scope) => {
          stops = sliderStops(scope, this.geometry!.sets, control as Extract<Control, { kind: 'slider' }>);
          range.disabled = stops.length === 0;
          range.max = String(Math.max(0, stops.length - 1));
          const value = current(scope) as number;
          setRange(range, Math.max(0, nearestStop(stops, value)));
          out.textContent = formatNumber(value);
        },
      };
    }
    return null;
  }

  /** The panel-scoped choice that a header chip shows and, with one view, the Add panel group offers, i.e. the one a view's frame reads, or else the first. */
  private templateChoice(): { id: string; def: Choice; label: string } | null {
    const scene = this.scene!;
    const choices = Object.entries(scene.variables ?? {}).filter(([, v]) => v?.kind === 'choice' && v.scope === 'panel') as [string, Choice][];
    if (choices.length === 0) return null;
    const framed = new Set(Object.values(scene.views).map((v) => (typeof v!.frame === 'string' ? '' : v!.frame.var)));
    const [id, def] = choices.find(([c]) => framed.has(c)) ?? choices[0]!;
    const tabs = (scene.controls ?? []).find((c) => c.kind === 'tabs' && c.variable === id) as Extract<Control, { kind: 'tabs' | 'toggle' }> | undefined;
    return { id, def, label: tabs?.label ?? id };
  }

  /** What the Add panel group offers. It offers the views when there are several, and the values of the panel-scoped choice otherwise. */
  private templates(): Template[] {
    const scene = this.scene!;
    const views = Object.entries(scene.views).map(([id, v]) => ({ kind: 'view' as const, view: id, label: v!.label ?? id }));
    const c = this.choice;
    if (views.length > 1 || c === null) return views;
    return c.def.values.map((value, i) => ({ kind: 'value' as const, variable: c.id, value, label: c.def.labels?.[i] ?? value }));
  }

  private buildTopBar(): void {
    const scene = this.scene!;
    this.varsEl.replaceChildren();
    this.sceneWidgets = [];
    for (const c of scene.controls ?? []) {
      if (c.kind === 'transport') continue;
      if (variableDef(scene, c.variable)?.scope === 'panel') continue;
      const w = this.makeWidget(c, undefined);
      if (w) {
        this.sceneWidgets.push(w);
        this.varsEl.appendChild(w.el);
      }
    }
    this.buildAddGroup();
    this.statsEl.replaceChildren();
    this.captions = (scene.readouts ?? []).filter((r) => r.place === 'caption').map((r) => buildReadout(r.parts, 'wide'));
    this.statsEl.append(...this.captions.map((r) => r.root));
  }

  private buildAddGroup(): void {
    this.addEl.replaceChildren();
    const items = this.templates();
    const group = el('div', 'chips');
    group.appendChild(el('span', 'k', 'Add panel'));
    this.addChips = [];
    for (const t of items) {
      const c = buildChip(t.label, 'menu');
      c.body.setAttribute('role', 'button');
      c.body.tabIndex = 0;
      c.body.setAttribute('aria-roledescription', 'draggable');
      c.body.title = 'Drag onto a panel: an edge splits it, the center replaces it. Click to add a panel.';
      c.body.addEventListener('pointerdown', (ev) => this.startDrag(ev, t, c.body, c.root));
      c.body.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        ev.stopPropagation();
        this.addPanel(t);
      });
      const caret = c.button!;
      caret.addEventListener('click', () => this.openMenu(caret, this.chipEntries(t)));
      group.appendChild(c.root);
      this.addChips.push(c.root);
    }
    const fallback = el('button', 'btn');
    fallback.type = 'button';
    fallback.setAttribute('aria-haspopup', 'menu');
    fallback.setAttribute('aria-expanded', 'false');
    fallback.append(icon('plus'), el('span', undefined, 'Add panel'), icon('chevronDown', 'chev'));
    fallback.hidden = true;
    fallback.addEventListener('pointerdown', stop);
    fallback.addEventListener('click', () =>
      this.openMenu(
        fallback,
        items.map((t) => ({ label: t.label, run: () => this.addPanel(t) })),
      ),
    );
    this.addEl.append(group, fallback);
    this.addGroup = group;
    this.addButton = fallback;
    this.fitAddGroup();
  }

  /** Shows the Add panel chips on one line, or the single Add panel menu button when they would wrap. */
  private fitAddGroup(): void {
    const group = this.addGroup;
    const button = this.addButton;
    if (group === null || button === null || this.addChips.length < 2) return;
    const focused = this.shadowRoot?.activeElement ?? null;
    group.hidden = false;
    button.hidden = true;
    const first = this.addChips[0]!;
    const last = this.addChips[this.addChips.length - 1]!;
    const wraps = last.offsetTop > first.offsetTop + first.offsetHeight / 2;
    group.hidden = wraps;
    button.hidden = !wraps;
    if (wraps && focused !== null && group.contains(focused)) button.focus();
  }

  /** The menu of a chip in the top bar, with Add panel, then Split right, Split below, and Replace for every panel. */
  private chipEntries(t: Template): MenuEntry[] {
    const scene = this.scene!;
    return chipMenu(this.store!.state, (id) => this.panelName(id), MAX_PANELS).map((m) => ({
      label: m.label,
      disabled: m.disabled,
      group: m.group,
      run: () => this.store!.update((s) => withPlacement(scene, s, m.placement, t, MAX_PANELS, (id) => this.isTall(id))),
    }));
  }

  private addPanel(t: Template): void {
    this.store!.update((s) => withAdd(this.scene!, s, t, MAX_PANELS, (id) => this.isTall(id)));
  }

  private isTall(pid: string): boolean {
    const r = this.panelDom.get(pid)?.host.getBoundingClientRect();
    return r !== undefined && r.width < r.height;
  }

  /** A panel's name in the menus, which is its view when the scene has several, then what its header chip shows. */
  private panelName(pid: string): string {
    const dom = this.panelDom.get(pid);
    if (dom === undefined) return pid;
    const chip = dom.chipLabel.textContent ?? '';
    return dom.title.hidden ? chip || pid : `${dom.title.textContent ?? pid}, ${chip}`;
  }

  // menus

  /** Opens a menu under `anchor`, or closes it when it is the one open. */
  private openMenu(anchor: HTMLElement, entries: MenuEntry[]): void {
    const again = this.menu?.anchor === anchor;
    this.closeMenu(false);
    if (again) return;
    const menu = el('div', 'menu');
    menu.setAttribute('role', 'menu');
    const items: HTMLButtonElement[] = [];
    for (const e of entries) {
      if (e.group && items.length > 0) {
        const hr = el('hr');
        hr.setAttribute('role', 'separator');
        menu.appendChild(hr);
      }
      const b = el('button', undefined, e.label);
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.tabIndex = -1;
      b.disabled = e.disabled === true;
      b.addEventListener('click', () => {
        this.closeMenu(true);
        e.run();
      });
      menu.appendChild(b);
      items.push(b);
    }
    const live = items.filter((b) => !b.disabled);
    menu.addEventListener('pointerdown', stop);
    menu.addEventListener('keydown', (ev) => {
      const i = live.indexOf(this.shadowRoot!.activeElement as HTMLButtonElement);
      const n = live.length;
      const go = (k: number) => live[((k % n) + n) % n]?.focus();
      if (ev.key === 'ArrowDown') go(i + 1);
      else if (ev.key === 'ArrowUp') go(i - 1);
      else if (ev.key === 'Home') go(0);
      else if (ev.key === 'End') go(n - 1);
      else if (ev.key === 'Escape') this.closeMenu(true);
      else if (ev.key === 'Tab') this.closeMenu(false);
      else return;
      if (ev.key !== 'Tab') ev.preventDefault();
      ev.stopPropagation();
    });
    this.root.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    const below = r.bottom + 4 + menu.offsetHeight <= window.innerHeight;
    menu.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - menu.offsetWidth - 4))}px`;
    menu.style.top = `${below ? r.bottom + 4 : Math.max(4, r.top - menu.offsetHeight - 4)}px`;
    anchor.setAttribute('aria-expanded', 'true');
    const outside = (ev: Event) => {
      const path = ev.composedPath();
      if (!path.includes(menu) && !path.includes(anchor)) this.closeMenu(false);
    };
    window.addEventListener('pointerdown', outside, true);
    this.menu = {
      anchor,
      close: (focus) => {
        menu.remove();
        anchor.setAttribute('aria-expanded', 'false');
        window.removeEventListener('pointerdown', outside, true);
        if (focus) anchor.focus();
      },
    };
    live[0]?.focus();
  }

  private closeMenu(focus: boolean): void {
    const m = this.menu;
    this.menu = null;
    m?.close(focus);
  }

  private syncWidgets(): void {
    const store = this.store!;
    const scene = this.scene!;
    const st = store.state;
    const first = this.firstPanel();
    if (first !== null) {
      const scope: PanelScope = { scene, state: st, panel: st.panels[first]! };
      for (const w of this.sceneWidgets) w.sync(scope);
    }
    const views = Object.keys(scene.views).length;
    const choice = this.choice;
    for (const [pid, dom] of this.panelDom) {
      const panel = st.panels[pid];
      if (panel === undefined) continue;
      const scope: PanelScope = { scene, state: st, panel };
      for (const w of dom.widgets) w.sync(scope);
      const view = scene.views[panel.view]!;
      dom.title.textContent = view.label ?? panel.view;
      dom.title.hidden = views < 2;
      const frame = typeof view.frame === 'string' ? view.frame : String(this.panelValue(scope, view.frame.var));
      const f = Object.hasOwn(scene.frames, frame) ? scene.frames[frame] : undefined;
      const frameLabel = f?.label ?? frame;
      const vf = view.frame;
      const framedBy = typeof vf === 'string' ? null : vf.var;
      if (choice !== null && dom.select !== null) {
        const value = String(this.panelValue(scope, choice.id));
        dom.select.value = value;
        setText(dom.chipLabel, choice.def.labels?.[choice.def.values.indexOf(value)] ?? value);
        dom.meta.textContent = frameLabel;
        // a panel control over the frame already shows it
        dom.meta.hidden =
          framedBy === choice.id ||
          (framedBy !== null &&
            (scene.controls ?? []).some((c) => c.kind !== 'transport' && c.variable === framedBy && variableDef(scene, framedBy)?.scope === 'panel'));
      } else {
        setText(dom.chipLabel, frameLabel);
        dom.meta.hidden = true;
      }
      dom.close.hidden = Object.keys(st.panels).length < 2;
    }
    this.transport?.channel?.set(st.clock.channel);
  }

  private panelValue(scope: PanelScope, id: string): VariableValue {
    const v = variableDef(scope.scene, id);
    if (v === undefined) return '';
    const values = v.scope === 'panel' ? scope.panel.variables : scope.state.variables;
    return values !== undefined && Object.hasOwn(values, id) ? values[id]! : v.default;
  }

  // panels and layout

  private syncPanels(): void {
    const st = this.store!.state;
    for (const pid of [...this.panelDom.keys()]) if (!Object.hasOwn(st.panels, pid)) this.removePanelDom(pid);
    for (const pid of Object.keys(st.panels)) {
      const dom = this.panelDom.get(pid);
      if (dom !== undefined && dom.view === st.panels[pid]!.view) continue;
      if (dom !== undefined) this.removePanelDom(pid);
      this.createPanelDom(pid, st.panels[pid]!);
    }
  }

  private createPanelDom(pid: string, panel: PanelState): void {
    const scene = this.scene!;
    const host = el('div', 'panel');
    host.dataset.id = pid;
    const body = el('div', 'pbody');
    const readouts = (scene.readouts ?? []).filter((r) => r.place === 'panel').map((r) => buildReadout(r.parts, 'stack'));
    const preadout = el('div', 'preadout');
    preadout.append(...readouts.map((r) => r.root));
    const error = el('div', 'perror');
    const bars = el('div', 'cbars');
    const drop = el('div', 'drop');
    const dropLabel = el('span');
    drop.appendChild(dropLabel);
    drop.hidden = true;
    body.append(preadout, error, bars, drop);
    body.addEventListener('dblclick', () => this.fitPanel(pid));
    const head = el('div', 'phead');
    const title = el('span', 't');
    const choice = this.choice;
    const chip = buildChip('', choice === null ? 'none' : 'select');
    chip.body.title = 'Drag to move the panel: onto an edge of another to place it there, onto its center to swap';
    if (choice !== null && chip.select !== null) {
      const select = chip.select;
      select.setAttribute('aria-label', choice.label);
      choice.def.values.forEach((value, i) => {
        const o = el('option', undefined, choice.def.labels?.[i] ?? value);
        o.value = value;
        select.appendChild(o);
      });
      select.addEventListener('change', () => this.store!.update((s) => withVariable(scene, s, choice.id, select.value, pid)));
    }
    const meta = el('span', 'm');
    const pc = el('span', 'pc mini');
    const widgets: Widget[] = [];
    for (const c of scene.controls ?? []) {
      if (c.kind === 'transport' || variableDef(scene, c.variable)?.scope !== 'panel') continue;
      if (choice !== null && c.kind === 'tabs' && c.variable === choice.id) continue;
      const w = this.makeWidget(c, pid);
      if (w) {
        widgets.push(w);
        pc.appendChild(w.el);
      }
    }
    const home = iconButton('house', 'Reset view', 'Reset view: fit to what this panel draws (F resets every panel)');
    home.addEventListener('click', () => this.fitPanel(pid));
    const close = iconButton('x', 'Close panel', 'Close panel');
    close.addEventListener('click', () => this.store!.update((s) => withoutPanel(s, pid)));
    head.append(title, chip.root, meta, pc, el('span', 'sp'), home, close);
    head.addEventListener('pointerdown', (ev) => this.startDrag(ev, { kind: 'panel', id: pid }, head, chip.root));
    host.append(body, head);
    this.panelsEl.appendChild(host);
    this.panelDom.set(pid, {
      host,
      body,
      head,
      title,
      chip: chip.root,
      chipLabel: chip.label,
      select: chip.select,
      meta,
      close,
      readouts,
      error,
      drop,
      dropLabel,
      bars,
      barDom: [],
      barsFor: null,
      widgets,
      view: panel.view,
    });
    this.renderer?.bind(pid, body);
  }

  private removePanelDom(pid: string): void {
    const dom = this.panelDom.get(pid);
    if (!dom) return;
    this.renderer?.bind(pid, null);
    dom.host.remove();
    this.panelDom.delete(pid);
  }

  /** Places panels and gutters where the layout tiles the stage. */
  private layoutDom(): void {
    if (this.store === null) return;
    const { w, h } = this.stageSize;
    const tiles = tile(this.store.state.layout, { x: 0, y: 0, w, h }, GUTTER);
    for (const [pid, r] of tiles.panels) {
      const dom = this.panelDom.get(pid);
      if (!dom) continue;
      Object.assign(dom.host.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    }
    this.gutters = tiles.gutters;
    const seen = new Set<string>();
    for (const g of tiles.gutters) {
      seen.add(g.path);
      let d = this.gutterDom.get(g.path);
      if (!d) {
        d = el('div', 'gutter');
        const path = g.path;
        d.addEventListener('pointerdown', (ev) => this.startResize(ev, path, d!));
        this.gutterDom.set(g.path, d);
        this.panelsEl.appendChild(d);
      }
      d.className = `gutter ${g.dir}`;
      Object.assign(d.style, { left: `${g.rect.x}px`, top: `${g.rect.y}px`, width: `${g.rect.w}px`, height: `${g.rect.h}px` });
    }
    for (const [path, d] of [...this.gutterDom]) {
      if (seen.has(path)) continue;
      d.remove();
      this.gutterDom.delete(path);
    }
  }

  private startResize(ev: PointerEvent, path: string, handle: HTMLDivElement): void {
    const g = this.gutters.find((x) => x.path === path);
    if (!g || ev.button !== 0) return;
    ev.preventDefault();
    handle.classList.add('active');
    handle.setPointerCapture(ev.pointerId);
    const move = (e: PointerEvent) => {
      const r = this.stage.getBoundingClientRect();
      const ratio = ratioAt(g, e.clientX - r.left, e.clientY - r.top, GUTTER);
      this.store!.update((s) => withLayout(s, withRatio(s.layout, path, ratio)));
    };
    const up = () => {
      handle.classList.remove('active');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }

  // colorbars, one of which can set a selector

  /** Writes a panel's colorbars from the renderer's data, in place, so that a drag on one survives the redraw it causes. */
  private syncBars(pid: string, dom: PanelDom): void {
    const scene = this.scene!;
    const bars = this.renderer!.colorbars(pid);
    if (dom.barDom.length !== bars.length) {
      dom.barDom = bars.map(() => this.makeBar(pid));
      dom.bars.replaceChildren(...dom.barDom.map((d) => d.root));
    }
    const panel = this.store!.state.panels[pid];
    const view = panel === undefined ? undefined : scene.views[panel.view];
    bars.forEach((b, i) => {
      const d = dom.barDom[i]!;
      setText(d.title, b.label);
      if (d.gradient !== b.gradient) {
        d.gradient = b.gradient;
        d.grad.style.background = b.gradient;
      }
      setText(d.hi, formatNumber(b.hi, 3));
      setText(d.lo, formatNumber(b.lo, 3));
      d.range = [b.lo, b.hi];
      d.mark.hidden = b.marker === null;
      if (b.marker !== null) d.mark.style.bottom = `${(100 * b.marker).toFixed(2)}%`;
      d.band.hidden = b.band === null;
      if (b.band !== null) {
        d.band.style.bottom = `${(100 * b.band[0]).toFixed(2)}%`;
        d.band.style.height = `${(100 * (b.band[1] - b.band[0])).toFixed(2)}%`;
      }
      d.link = this.kiosk || view === undefined ? null : colorbarLink(scene, view, b.label);
      const g = d.grad;
      g.classList.toggle('live', d.link !== null);
      if (d.link === null) {
        for (const a of ['role', 'tabindex', 'aria-orientation', 'aria-label', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext', 'title'])
          g.removeAttribute(a);
        return;
      }
      const value = this.panelValue({ scene, state: this.store!.state, panel: panel! }, d.link.variable) as number;
      g.setAttribute('role', 'slider');
      g.setAttribute('tabindex', '0');
      g.setAttribute('aria-orientation', 'vertical');
      g.setAttribute('aria-label', d.link.label);
      g.setAttribute('aria-valuemin', String(b.lo));
      g.setAttribute('aria-valuemax', String(b.hi));
      g.setAttribute('aria-valuenow', String(value));
      g.setAttribute('aria-valuetext', formatNumber(value));
      g.title = `Drag or click to set ${d.link.label}`;
    });
  }

  private makeBar(pid: string): BarDom {
    const root = el('div', 'cbar');
    const title = el('div', 'cbar-t');
    const body = el('div', 'cbar-b');
    const grad = el('div', 'cbar-g');
    const band = el('span', 'cbar-k');
    const mark = el('i');
    grad.append(band, mark);
    const ticks = el('div', 'cbar-n');
    const hi = el('span');
    const lo = el('span');
    ticks.append(hi, lo);
    body.append(grad, ticks);
    root.append(title, body);
    const d: BarDom = { root, title, grad, band, mark, hi, lo, gradient: '', range: [0, 1], link: null };
    grad.addEventListener('pointerdown', (ev) => {
      if (d.link === null || ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      grad.focus();
      grad.setPointerCapture(ev.pointerId);
      const at = (e: PointerEvent) => {
        const r = grad.getBoundingClientRect();
        this.setFromBar(pid, d, r.height > 0 ? (r.bottom - e.clientY) / r.height : 0);
      };
      const up = () => {
        grad.removeEventListener('pointermove', at);
        grad.removeEventListener('pointerup', up);
        grad.removeEventListener('pointercancel', up);
      };
      at(ev);
      grad.addEventListener('pointermove', at);
      grad.addEventListener('pointerup', up);
      grad.addEventListener('pointercancel', up);
    });
    grad.addEventListener('dblclick', stop);
    grad.addEventListener('keydown', (ev) => {
      if (d.link === null) return;
      const by: Record<string, number> = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10, Home: -Infinity, End: Infinity };
      if (!(ev.key in by)) return;
      ev.preventDefault();
      ev.stopPropagation();
      this.stepBar(pid, d, by[ev.key]!);
    });
    return d;
  }

  private barStops(pid: string, link: ColorbarLink): number[] {
    const st = this.store!.state;
    const panel = st.panels[pid];
    if (panel === undefined) return [];
    const control = { kind: 'slider' as const, variable: link.variable, label: link.label, domain: link.domain };
    return sliderStops({ scene: this.scene!, state: st, panel }, this.geometry!.sets, control);
  }

  /** Sets the bar's selector to the stop nearest the value at `t` along the bar, as the top bar's slider does. */
  private setFromBar(pid: string, d: BarDom, t: number): void {
    if (d.link === null) return;
    const stops = this.barStops(pid, d.link);
    const i = stopAt(stops, d.range[0], d.range[1], t);
    const variable = d.link.variable;
    if (i >= 0) this.store!.update((s) => withVariable(this.scene!, s, variable, stops[i]!));
  }

  private stepBar(pid: string, d: BarDom, by: number): void {
    if (d.link === null) return;
    const stops = this.barStops(pid, d.link);
    const st = this.store!.state;
    if (stops.length === 0 || st.panels[pid] === undefined) return;
    const value = this.panelValue({ scene: this.scene!, state: st, panel: st.panels[pid]! }, d.link.variable) as number;
    const i = Math.min(stops.length - 1, Math.max(0, nearestStop(stops, value) + by));
    const variable = d.link.variable;
    this.store!.update((s) => withVariable(this.scene!, s, variable, stops[i]!));
  }

  // drag and drop, with pointer events so that it works on touch

  private startDrag(ev: PointerEvent, payload: DragPayload, handle: HTMLElement, chip: HTMLElement): void {
    if (ev.button !== 0 || this.store === null) return;
    ev.preventDefault();
    this.closeMenu(false);
    const sx = ev.clientX;
    const sy = ev.clientY;
    const shadow = this.shadowRoot!;
    let ghost: HTMLElement | null = null;
    let target: { id: string; zone: DropZone } | null = null;
    handle.setPointerCapture(ev.pointerId);
    const clear = () => {
      for (const d of this.panelDom.values()) d.drop.hidden = true;
    };
    const move = (e: PointerEvent) => {
      if (!ghost) {
        if (Math.hypot(e.clientX - sx, e.clientY - sy) < 4) return;
        ghost = chip.cloneNode(true) as HTMLElement;
        ghost.classList.add('ghost');
        this.root.appendChild(ghost);
        chip.classList.add('source');
        this.root.classList.add('dragging');
      }
      ghost.style.left = `${e.clientX}px`;
      ghost.style.top = `${e.clientY}px`;
      clear();
      target = null;
      const under = shadow.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const host = under?.closest('.panel') as HTMLElement | null;
      if (!host) return;
      const id = host.dataset.id!;
      if (payload.kind === 'panel' && payload.id === id) return;
      const dom = this.panelDom.get(id);
      if (!dom) return;
      const r = dom.host.getBoundingClientRect();
      const zone = zoneFor(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
      target = { id, zone };
      dom.drop.hidden = false;
      dom.drop.style.inset =
        zone === 'left' ? '0 50% 0 0' : zone === 'right' ? '0 0 0 50%' : zone === 'top' ? '0 0 50% 0' : zone === 'bottom' ? '50% 0 0 0' : '0';
      setText(dom.dropLabel, dropText(payload, zone));
    };
    const up = (e: PointerEvent) => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      clear();
      const dragged = ghost !== null;
      ghost?.remove();
      chip.classList.remove('source');
      this.root.classList.remove('dragging');
      if (!dragged) {
        if (payload.kind !== 'panel' && e.type === 'pointerup') this.addPanel(payload);
        return;
      }
      if (target) this.dropOn(target.id, target.zone, payload);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }

  private dropOn(targetId: string, zone: DropZone, payload: DragPayload): void {
    const scene = this.scene!;
    this.store!.update((st) => withDrop(scene, st, targetId, zone, payload, MAX_PANELS));
  }
}

/**
 * Registers TychoViewerElement as the custom element `tag`, which a page passes when the default name is taken. It does
 * not do anything when an element named `tag` is already defined or where the environment lacks custom elements (e.g. Node).
 */
export function define(tag = 'tycho-viewer'): void {
  if (typeof customElements !== 'undefined' && !customElements.get(tag)) customElements.define(tag, TychoViewerElement);
}
