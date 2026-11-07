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
