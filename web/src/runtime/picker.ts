/**
 * Compact interactive 2D pole-zero picker pad and time-domain impulse response strip (rule `points-2d`).
 */
import { evalTimeResponse } from '../evaluate/complex.js';
import { inputDef, inputValue, type PanelScope } from '../evaluate/resolve.js';
import type { Control, InputValue, Points2DValue } from '../scene.js';
import { hexRgb, type Theme } from './colors.js';
import { formatNumber } from './readouts.js';

export type Points2dControl = Extract<Control, { kind: 'points_2d' }>;

const COLOR_STABLE = '#b06ef3';
const COLOR_UNSTABLE = '#f0a050';
const COLOR_MARGINAL = '#5b9bd5';
const COLOR_FT = '#38d0e8';

const PAD_W = 224;
const PAD_H = 172;
const TIME_W = 224;
const TIME_H = 68;
const SNAP_PX = 10;
const HIT_RADIUS = 22;

/** Converts canvas pixel coordinates to bounded world coordinates with magnetic snapping to both complex axes. */
export function snapPickerPoint(
  px: number,
  py: number,
  bounds: readonly [readonly [number, number], readonly [number, number]],
  allowSnap = true,
): { x: number; y: number; snappedX: boolean; snappedY: boolean } {
  const [x0, x1] = bounds[0];
  const [y0, y1] = bounds[1];
  const ox = ((0 - x0) / (x1 - x0)) * PAD_W;
  const oy = ((y1 - 0) / (y1 - y0)) * PAD_H;
  let x = Math.min(x1, Math.max(x0, x0 + (px / PAD_W) * (x1 - x0)));
  let y = Math.min(y1, Math.max(y0, y1 - (py / PAD_H) * (y1 - y0)));
  const snappedX = allowSnap && Math.abs(px - ox) <= SNAP_PX && x0 <= 0 && 0 <= x1;
  const snappedY = allowSnap && Math.abs(py - oy) <= SNAP_PX && y0 <= 0 && 0 <= y1;
  if (snappedX) x = 0;
  if (snappedY) y = 0;
  return { x, y, snappedX, snappedY };
}

function stabilityColor(sigma: number): string {
  if (sigma < -1e-4) return COLOR_STABLE;
  if (sigma > 1e-4) return COLOR_UNSTABLE;
  return COLOR_MARGINAL;
}

/** Whether the state gives input `id` a value, in place of the default of the input. */
function holdsInput(scope: PanelScope, id: string): boolean {
  const values = inputDef(scope.scene, id)?.scope === 'per_panel' ? scope.panel.inputs : scope.state.inputs;
  return values !== undefined && Object.hasOwn(values, id) && values[id] !== undefined;
}

function makeEl<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls !== undefined) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export type InputUpdater = (updates: [string, InputValue][]) => void;

interface DragState {
  pointerId: number;
  kind: 'pole' | 'zero';
  idx: number;
  partnerIdx: number;
  spawnedPartner: boolean;
  snappedX: boolean;
  snappedY: boolean;
}

/** Floating/collapsible 2D complex-plane pad that edits poles, zeros, and conjugate locking. */
export class PoleZeroPicker {
  readonly el: HTMLDivElement;
  readonly showRange: [number, number] | undefined;
  private readonly control: Points2dControl;
  private readonly onUpdate: InputUpdater;

  private readonly headerTitle: HTMLSpanElement;
  private readonly headerToggle: HTMLButtonElement;
  private readonly bodyEl: HTMLDivElement;
  private readonly padCanvas: HTMLCanvasElement;
  private readonly lockInput: HTMLInputElement;
  private readonly snapInput: HTMLInputElement;
  private readonly addPoleBtn: HTMLButtonElement;
  private readonly addZeroBtn: HTMLButtonElement | null;
  private readonly removeBtn: HTMLButtonElement;
  private readonly coordsEl: HTMLDivElement;
  private readonly timeCanvas: HTMLCanvasElement;

  private collapsed = false;
  private conjugateLock = true;
  private snapAxes = false;
  private inRange = true;
  private theme: Theme = { background: '#050505', foreground: '#f2f2ef', grid: '#232320' };

  private poles: Points2DValue = [[-0.8, 0]];
  private zeros: Points2DValue = [];
  private gain = 1;
  private period = 1;
  private bounds: [[number, number], [number, number]] = [
    [-3, 2],
    [-3.5, 3.5],
  ];
  private minPoles = 1;
  private maxPoles = 6;
  private minZeros = 0;
  private maxZeros = 5;
  private hasCustomPreset = false;
  private showTime = false;
  private selected: { kind: 'pole' | 'zero'; idx: number } = { kind: 'pole', idx: 0 };
  private drag: DragState | null = null;
  private syncSeq = 0;
  private lastSyncedPreset: string | null = null;
  private lastTimeKey = '';
  private cachedTimeResp: { t: number[]; f: number[]; tk: number[]; fk: number[] } | null = null;

  constructor(control: Points2dControl, startCollapsed: boolean, onUpdate: InputUpdater) {
    this.control = control;
    this.showRange = control.show_range;
    this.onUpdate = onUpdate;
    this.collapsed = startCollapsed;
    this.conjugateLock = control.conjugate_lock ?? true;

    this.el = makeEl('div', 'picker');
    if (this.collapsed) this.el.classList.add('collapsed');
    this.el.addEventListener('pointerdown', (ev) => ev.stopPropagation());

    const head = makeEl('div', 'picker-head');
    this.headerTitle = makeEl('span', 'picker-title', control.label);
    this.headerToggle = makeEl('button', 'picker-toggle');
    this.headerToggle.type = 'button';
    this.headerToggle.addEventListener('click', () => this.setCollapsed(!this.collapsed));
    head.append(this.headerTitle, this.headerToggle);

    this.bodyEl = makeEl('div', 'picker-body');
    this.padCanvas = makeEl('canvas', 'pz-canvas');
    this.padCanvas.style.width = `${PAD_W}px`;
    this.padCanvas.style.height = `${PAD_H}px`;
    this.bindCanvasEvents();

    const togglesRow = makeEl('div', 'pz-toggles');
    const lockLbl = makeEl('label', 'pz-lock');
    this.lockInput = makeEl('input');
    this.lockInput.type = 'checkbox';
    this.lockInput.checked = this.conjugateLock;
    this.lockInput.addEventListener('change', () => {
      this.conjugateLock = this.lockInput.checked;
      this.draw();
    });
    lockLbl.append(this.lockInput, makeEl('span', undefined, 'Conjugate'));

    const snapLbl = makeEl('label', 'pz-snap');
    this.snapInput = makeEl('input');
    this.snapInput.type = 'checkbox';
    this.snapInput.checked = this.snapAxes;
    this.snapInput.addEventListener('change', () => {
      this.snapAxes = this.snapInput.checked;
      this.draw();
    });
    snapLbl.append(this.snapInput, makeEl('span', undefined, 'Snap'));
    togglesRow.append(lockLbl, snapLbl);

    const row = makeEl('div', 'pz-actions');
    this.addPoleBtn = makeEl('button', 'btn pz-btn', '+Pole');
    this.addPoleBtn.type = 'button';
    this.addPoleBtn.addEventListener('click', () => this.addPoint('pole'));

    if (control.secondary_input !== undefined) {
      this.addZeroBtn = makeEl('button', 'btn pz-btn', '+Zero');
      this.addZeroBtn.type = 'button';
      this.addZeroBtn.addEventListener('click', () => this.addPoint('zero'));
    } else {
      this.addZeroBtn = null;
    }

    this.removeBtn = makeEl('button', 'btn pz-btn', 'Del');
    this.removeBtn.type = 'button';
    this.removeBtn.addEventListener('click', () => this.removeSelected());

    row.append(this.addPoleBtn);
    if (this.addZeroBtn !== null) row.append(this.addZeroBtn);
    row.append(this.removeBtn);

    this.coordsEl = makeEl('div', 'pz-info');

    this.timeCanvas = makeEl('canvas', 'pz-time');
    this.timeCanvas.style.width = `${TIME_W}px`;
    this.timeCanvas.style.height = `${TIME_H}px`;
    this.timeCanvas.hidden = true;

    this.bodyEl.append(this.padCanvas, togglesRow, row, this.coordsEl, this.timeCanvas);
    this.el.append(head, this.bodyEl);
    this.syncHeader();
  }

  private setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    this.el.classList.toggle('collapsed', collapsed);
    this.syncHeader();
    if (!collapsed) this.draw();
  }

  /** Collapses a pad whose body the panel area is too short to show whole. */
  collapseIfCut(): void {
    if (!this.collapsed && this.bodyEl.scrollHeight > this.bodyEl.clientHeight + 1) this.setCollapsed(true);
  }

  private syncHeader(): void {
    if (this.collapsed) {
      const zTxt = this.control.secondary_input !== undefined ? `, ${this.zeros.length}Z` : '';
      this.headerTitle.textContent = `${this.control.label} (${this.poles.length}P${zTxt})`;
      this.headerToggle.textContent = '▲';
      this.headerToggle.setAttribute('aria-label', 'Expand pole-zero pad');
      this.headerToggle.setAttribute('aria-expanded', 'false');
    } else {
      this.headerTitle.textContent = this.control.label;
      this.headerToggle.textContent = '▾';
      this.headerToggle.setAttribute('aria-label', 'Collapse pole-zero pad');
      this.headerToggle.setAttribute('aria-expanded', 'true');
    }
    this.bodyEl.hidden = this.collapsed;
  }

  setTime(t: number): void {
    if (this.showRange === undefined) {
      this.inRange = true;
      this.el.hidden = false;
      return;
    }
    const [lo, hi] = this.showRange;
    const shown = t >= lo - 1e-6 && t <= hi + 1e-6;
    if (shown !== this.inRange) {
      this.inRange = shown;
      this.el.hidden = !shown;
      if (shown && !this.collapsed) this.draw();
    }
  }

  sync(scope: PanelScope, theme: Theme): void {
    const seq = ++this.syncSeq;
    this.theme = theme;
    const pDef = inputDef(scope.scene, this.control.input);
    if (pDef?.kind === 'points_2d') {
      if (pDef.bounds !== undefined) this.bounds = pDef.bounds;
      this.minPoles = Math.max(1, pDef.min_points ?? 1);
      this.maxPoles = Math.min(6, pDef.max_points ?? 6);
    }
    if (this.control.secondary_input !== undefined) {
      const zDef = inputDef(scope.scene, this.control.secondary_input);
      if (zDef?.kind === 'points_2d') {
        this.minZeros = Math.max(0, zDef.min_points ?? 0);
        this.maxZeros = Math.min(5, zDef.max_points ?? 5);
      }
    }
    let appliedMatch: NonNullable<Points2dControl['presets']>[number] | null = null;
    if (this.control.preset_input !== undefined && this.control.presets !== undefined) {
      const prDef = inputDef(scope.scene, this.control.preset_input);
      this.hasCustomPreset = prDef?.kind === 'choice' && prDef.values.includes('custom');
      const presetVal = String(inputValue(scope, this.control.preset_input));
      if (presetVal !== this.lastSyncedPreset) {
        // a new picker keeps the points that the state holds, as after a reload and in the twin of an export
        const keep = this.lastSyncedPreset === null && holdsInput(scope, this.control.input);
        this.lastSyncedPreset = presetVal;
        const match = keep ? undefined : this.control.presets.find((p) => p.id === presetVal);
        if (match !== undefined) {
          appliedMatch = match;
          const updates: [string, InputValue][] = [[this.control.input, match.poles.map(([x, y]) => [x, y])]];
          if (this.control.secondary_input !== undefined) {
            updates.push([this.control.secondary_input, (match.zeros ?? []).map(([x, y]) => [x, y])]);
          }
          if (this.control.gain_input !== undefined) {
            updates.push([this.control.gain_input, match.gain ?? 1]);
          }
          this.onUpdate(updates);
          if (this.syncSeq !== seq) return;
        }
      }
    }

    const rawPoles = appliedMatch !== null ? appliedMatch.poles : inputValue(scope, this.control.input);
    if (Array.isArray(rawPoles)) this.poles = rawPoles.map(([x, y]) => [x, y]);
    if (this.control.secondary_input !== undefined) {
      const rawZeros = appliedMatch !== null ? (appliedMatch.zeros ?? []) : inputValue(scope, this.control.secondary_input);
      if (Array.isArray(rawZeros)) this.zeros = rawZeros.map(([x, y]) => [x, y]);
    }
    this.gain =
      appliedMatch !== null ? (appliedMatch.gain ?? 1) : this.control.gain_input !== undefined ? Number(inputValue(scope, this.control.gain_input)) : 1;
    this.period = this.control.period_input !== undefined ? Number(inputValue(scope, this.control.period_input)) : 1;
    this.showTime = this.control.show_time_domain !== undefined && inputValue(scope, this.control.show_time_domain) === true;
    this.timeCanvas.hidden = !this.showTime;

    if (this.selected.kind === 'pole' && this.selected.idx >= this.poles.length) {
      this.selected = { kind: 'pole', idx: Math.max(0, this.poles.length - 1) };
    } else if (this.selected.kind === 'zero' && this.selected.idx >= this.zeros.length) {
      this.selected = this.poles.length > 0 ? { kind: 'pole', idx: 0 } : { kind: 'zero', idx: 0 };
    }

    this.syncButtons();
    this.syncHeader();
    if (!this.collapsed && this.inRange) this.draw();
  }

  private syncButtons(): void {
    this.addPoleBtn.disabled = this.poles.length >= this.maxPoles;
    if (this.addZeroBtn !== null) {
      this.addZeroBtn.disabled = this.zeros.length >= this.maxZeros || this.zeros.length >= this.poles.length;
    }
    const partnerIdx = this.selected.kind === 'pole' ? this.findPartner(this.poles, this.selected.idx) : this.findPartner(this.zeros, this.selected.idx);
    const rmCount = this.conjugateLock && partnerIdx >= 0 ? 2 : 1;
    if (this.selected.kind === 'pole') {
      const remaining = this.poles.length - rmCount;
      this.removeBtn.disabled = remaining < Math.max(this.minPoles, this.zeros.length);
    } else {
      this.removeBtn.disabled = this.zeros.length - rmCount < this.minZeros;
    }
  }

  private findPartner(pts: readonly [number, number][], idx: number): number {
    const p = pts[idx];
    if (p === undefined || Math.abs(p[1]) <= 1e-4) return -1;
    for (let j = 0; j < pts.length; j++) {
      if (j === idx) continue;
      if (Math.abs(pts[j]![0] - p[0]) < 1e-2 && Math.abs(pts[j]![1] + p[1]) < 1e-2) return j;
    }
    return -1;
  }

  private pushUpdates(nextPoles: Points2DValue, nextZeros?: Points2DValue): void {
    const updates: [string, InputValue][] = [[this.control.input, nextPoles]];
    if (nextZeros !== undefined && this.control.secondary_input !== undefined) {
      updates.push([this.control.secondary_input, nextZeros]);
    }
    if (this.control.preset_input !== undefined && this.hasCustomPreset && this.lastSyncedPreset !== 'custom') {
      this.lastSyncedPreset = 'custom';
      updates.push([this.control.preset_input, 'custom']);
    }
    this.onUpdate(updates);
  }

  private addPoint(kind: 'pole' | 'zero'): void {
    const [x0, x1] = this.bounds[0];
    const [y0, y1] = this.bounds[1];
    const clampPt = (x: number, y: number): [number, number] => [Math.min(x1, Math.max(x0, x)), Math.min(y1, Math.max(y0, y))];
    if (kind === 'pole') {
      if (this.poles.length >= this.maxPoles) return;
      const offset = -0.4 - 0.35 * (this.poles.length % 4);
      const pt = clampPt(offset, 0);
      const next = [...this.poles.map(([a, b]) => [a, b] as [number, number]), pt];
      this.selected = { kind: 'pole', idx: next.length - 1 };
      this.pushUpdates(next);
    } else {
      if (this.zeros.length >= this.maxZeros || this.zeros.length >= this.poles.length) return;
      const offset = -0.2 - 0.35 * (this.zeros.length % 4);
      const pt = clampPt(offset, 0);
      const next = [...this.zeros.map(([a, b]) => [a, b] as [number, number]), pt];
      this.selected = { kind: 'zero', idx: next.length - 1 };
      this.pushUpdates(
        this.poles.map(([a, b]) => [a, b]),
        next,
      );
    }
  }

  private removeSelected(): void {
    if (this.selected.kind === 'pole') {
      const idx = this.selected.idx;
      const partner = this.conjugateLock ? this.findPartner(this.poles, idx) : -1;
      const drop = new Set(partner >= 0 ? [idx, partner] : [idx]);
      const next = this.poles.filter((_, i) => !drop.has(i));
      if (next.length < Math.max(this.minPoles, this.zeros.length)) return;
      this.selected = { kind: 'pole', idx: Math.max(0, next.length - 1) };
      this.pushUpdates(next);
    } else {
      const idx = this.selected.idx;
      const partner = this.conjugateLock ? this.findPartner(this.zeros, idx) : -1;
      const drop = new Set(partner >= 0 ? [idx, partner] : [idx]);
      const next = this.zeros.filter((_, i) => !drop.has(i));
      if (next.length < this.minZeros) return;
      this.selected = next.length > 0 ? { kind: 'zero', idx: next.length - 1 } : { kind: 'pole', idx: 0 };
      this.pushUpdates(
        this.poles.map(([a, b]) => [a, b]),
        next,
      );
    }
  }

  private worldToPx(x: number, y: number): [number, number] {
    const [x0, x1] = this.bounds[0];
    const [y0, y1] = this.bounds[1];
    return [((x - x0) / (x1 - x0)) * PAD_W, ((y1 - y) / (y1 - y0)) * PAD_H];
  }

  private pxToWorld(px: number, py: number, allowSnap = true): { x: number; y: number; snappedX: boolean; snappedY: boolean } {
    return snapPickerPoint(px, py, this.bounds, allowSnap);
  }

  private canvasPx(ev: PointerEvent): [number, number] {
    const rect = this.padCanvas.getBoundingClientRect();
    const w = rect.width > 0 ? rect.width : PAD_W;
    const h = rect.height > 0 ? rect.height : PAD_H;
    return [((ev.clientX - rect.left) / w) * PAD_W, ((ev.clientY - rect.top) / h) * PAD_H];
  }

  private bindCanvasEvents(): void {
    this.padCanvas.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      const [px, py] = this.canvasPx(ev);
      let best: { kind: 'pole' | 'zero'; idx: number; dist: number } | null = null;
      this.poles.forEach(([x, y], idx) => {
        const [cx, cy] = this.worldToPx(x, y);
        const d = Math.hypot(px - cx, py - cy);
        if (d <= HIT_RADIUS && (best === null || d < best.dist)) best = { kind: 'pole', idx, dist: d };
      });
      this.zeros.forEach(([x, y], idx) => {
        const [cx, cy] = this.worldToPx(x, y);
        const d = Math.hypot(px - cx, py - cy);
        if (d <= HIT_RADIUS && (best === null || d < best.dist)) best = { kind: 'zero', idx, dist: d };
      });
      if (best === null) return;
      const hit = best as { kind: 'pole' | 'zero'; idx: number; dist: number };
      this.selected = { kind: hit.kind, idx: hit.idx };
      const pts = hit.kind === 'pole' ? this.poles : this.zeros;
      const partnerIdx = this.conjugateLock ? this.findPartner(pts, hit.idx) : -1;
      const [hx, hy] = pts[hit.idx] ?? [0, 0];
      this.drag = {
        pointerId: ev.pointerId,
        kind: hit.kind,
        idx: hit.idx,
        partnerIdx,
        spawnedPartner: false,
        snappedX: this.snapAxes && Math.abs(hx) < 1e-6,
        snappedY: this.snapAxes && Math.abs(hy) < 1e-6,
      };
      this.padCanvas.setPointerCapture?.(ev.pointerId);
      this.syncButtons();
      this.draw();
    });

    const endDrag = (ev: PointerEvent) => {
      if (this.drag === null || ev.pointerId !== this.drag.pointerId) return;
      this.drag = null;
      if (!this.collapsed && this.inRange) this.draw();
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) this.padCanvas.addEventListener(type, endDrag);

    this.padCanvas.addEventListener('pointermove', (ev) => {
      if (this.drag === null || ev.pointerId !== this.drag.pointerId) return;
      // the pad does not see the release of a pointer whose capture ended while the viewer was off the page
      if ((ev.buttons & 1) === 0) {
        endDrag(ev);
        return;
      }
      ev.stopPropagation();
      const [px, py] = this.canvasPx(ev);
      const { x, y, snappedX, snappedY } = this.pxToWorld(px, py, this.snapAxes && !ev.shiftKey);
      this.drag.snappedX = snappedX;
      this.drag.snappedY = snappedY;
      const isPole = this.drag.kind === 'pole';
      const maxPts = isPole ? this.maxPoles : Math.min(this.maxZeros, this.poles.length);
      const arr = (isPole ? this.poles : this.zeros).map(([a, b]) => [a, b] as [number, number]);
      if (this.drag.idx >= arr.length) return;

      arr[this.drag.idx] = [x, y];
      if (this.conjugateLock) {
        if (this.drag.partnerIdx >= 0 && this.drag.partnerIdx < arr.length) {
          if (this.drag.spawnedPartner && y === 0) {
            arr.splice(this.drag.partnerIdx, 1);
            if (this.drag.partnerIdx < this.drag.idx) this.drag.idx--;
            this.drag.partnerIdx = -1;
            this.drag.spawnedPartner = false;
          } else {
            arr[this.drag.partnerIdx] = [x, -y];
          }
        } else if (Math.abs(y) > 0 && arr.length < maxPts) {
          this.drag.partnerIdx = arr.length;
          this.drag.spawnedPartner = true;
          arr.push([x, -y]);
        } else if (this.drag.partnerIdx < 0 && Math.abs(y) > 0 && arr.length >= maxPts) {
          // Keep point real when no capacity remains for its mirror partner
          arr[this.drag.idx] = [x, 0];
        }
      }
      if (isPole) this.pushUpdates(arr);
      else
        this.pushUpdates(
          this.poles.map(([a, b]) => [a, b]),
          arr,
        );
      if (!this.collapsed && this.inRange) this.draw();
    });
  }

  private draw(): void {
    this.drawPad();
    this.drawInfo();
    if (this.showTime) this.drawTimeStrip();
  }

  private drawPad(): void {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(PAD_W * ratio);
    const h = Math.round(PAD_H * ratio);
    if (this.padCanvas.width !== w || this.padCanvas.height !== h) {
      this.padCanvas.width = w;
      this.padCanvas.height = h;
    }
    const g = this.padCanvas.getContext('2d');
    if (g === null) return;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, PAD_W, PAD_H);

    const dark = hexRgb(this.theme.background).reduce((a, b) => a + b, 0) < 1.5;
    const [x0, x1] = this.bounds[0];
    const [y0, y1] = this.bounds[1];
    const [ox, oy] = this.worldToPx(0, 0);

    // Subtle stability half-plane tints
    const lhpW = Math.max(0, Math.min(PAD_W, ox));
    g.fillStyle = dark ? 'rgba(176, 110, 243, 0.09)' : 'rgba(176, 110, 243, 0.08)';
    g.fillRect(0, 0, lhpW, PAD_H);
    g.fillStyle = dark ? 'rgba(240, 160, 80, 0.08)' : 'rgba(240, 160, 80, 0.08)';
    g.fillRect(lhpW, 0, Math.max(0, PAD_W - lhpW), PAD_H);

    // Integer grid
    g.strokeStyle = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
    g.lineWidth = 1;
    for (let x = Math.ceil(x0); x <= Math.floor(x1); x++) {
      const [px] = this.worldToPx(x, 0);
      g.beginPath();
      g.moveTo(px, 0);
      g.lineTo(px, PAD_H);
      g.stroke();
    }
    for (let y = Math.ceil(y0); y <= Math.floor(y1); y++) {
      const [, py] = this.worldToPx(0, y);
      g.beginPath();
      g.moveTo(0, py);
      g.lineTo(PAD_W, py);
      g.stroke();
    }

    // Real axis
    if (this.drag?.snappedY) {
      g.save();
      g.strokeStyle = this.theme.foreground;
      g.globalAlpha = 0.22;
      g.lineWidth = 5;
      g.beginPath();
      g.moveTo(0, oy);
      g.lineTo(PAD_W, oy);
      g.stroke();
      g.globalAlpha = 0.88;
      g.lineWidth = 2.4;
      g.beginPath();
      g.moveTo(0, oy);
      g.lineTo(PAD_W, oy);
      g.stroke();
      g.restore();
    } else {
      g.strokeStyle = dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.22)';
      g.beginPath();
      g.moveTo(0, oy);
      g.lineTo(PAD_W, oy);
      g.stroke();
    }

    // Marginal axis sigma = 0
    if (this.drag?.snappedX) {
      g.save();
      g.strokeStyle = COLOR_MARGINAL;
      g.globalAlpha = 0.3;
      g.lineWidth = 6;
      g.beginPath();
      g.moveTo(ox, 0);
      g.lineTo(ox, PAD_H);
      g.stroke();
      g.globalAlpha = 1;
      g.lineWidth = 2.6;
      g.beginPath();
      g.moveTo(ox, 0);
      g.lineTo(ox, PAD_H);
      g.stroke();
      g.restore();
    } else {
      g.strokeStyle = COLOR_MARGINAL;
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(ox, 0);
      g.lineTo(ox, PAD_H);
      g.stroke();
    }

    // Live Nyquist bounds +/- pi/T
    const nyq = Math.PI / Math.max(1e-6, this.period);
    g.save();
    g.strokeStyle = dark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.28)';
    g.lineWidth = 1;
    g.setLineDash([4, 3]);
    for (const sign of [1, -1]) {
      const y = sign * nyq;
      if (y < y0 || y > y1) continue;
      const [, py] = this.worldToPx(0, y);
      g.beginPath();
      g.moveTo(0, py);
      g.lineTo(PAD_W, py);
      g.stroke();
    }
    g.restore();

    g.fillStyle = dark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.5)';
    g.font = '10px system-ui, sans-serif';
    g.fillText('σ', PAD_W - 12, Math.max(11, Math.min(PAD_H - 4, oy - 4)));
    g.fillText('jω', Math.min(PAD_W - 18, Math.max(4, ox + 4)), 11);

    // Draw zeros (circles) then poles (crosses)
    const drawHalo = (px: number, py: number) => {
      g.save();
      g.strokeStyle = this.theme.foreground;
      g.globalAlpha = 0.55;
      g.lineWidth = 1.2;
      g.beginPath();
      g.arc(px, py, 9, 0, 2 * Math.PI);
      g.stroke();
      g.restore();
    };

    this.zeros.forEach(([zx, zy], idx) => {
      const [px, py] = this.worldToPx(zx, zy);
      if (this.selected.kind === 'zero' && this.selected.idx === idx) drawHalo(px, py);
      g.strokeStyle = this.theme.foreground;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(px, py, 5, 0, 2 * Math.PI);
      g.stroke();
    });

    this.poles.forEach(([sx, sy], idx) => {
      const [px, py] = this.worldToPx(sx, sy);
      if (this.selected.kind === 'pole' && this.selected.idx === idx) drawHalo(px, py);
      g.strokeStyle = stabilityColor(sx);
      g.lineWidth = 2.2;
      const r = 5;
      g.beginPath();
      g.moveTo(px - r, py - r);
      g.lineTo(px + r, py + r);
      g.moveTo(px - r, py + r);
      g.lineTo(px + r, py - r);
      g.stroke();
    });
  }

  private drawInfo(): void {
    const arr = this.selected.kind === 'zero' && this.zeros.length > 0 ? this.zeros : this.poles;
    const pt = arr[Math.min(this.selected.idx, Math.max(0, arr.length - 1))] ?? this.poles[0] ?? [0, 0];
    const [sigma, omega] = pt;
    const magZ = Math.exp(sigma * this.period);
    const angle = omega * this.period;
    const zr = magZ * Math.cos(angle);
    const zi = magZ * Math.sin(angle);
    const sStr =
      Math.abs(omega) < 1e-4
        ? `s = ${formatNumber(sigma, undefined, 2)}`
        : `s = ${formatNumber(sigma, undefined, 2)} ${omega >= 0 ? '+' : '−'} j${formatNumber(Math.abs(omega), undefined, 2)}`;
    const zStr =
      Math.abs(zi) < 1e-4
        ? `z = ${formatNumber(zr, undefined, 2)}`
        : `z = ${formatNumber(zr, undefined, 2)} ${zi >= 0 ? '+' : '−'} j${formatNumber(Math.abs(zi), undefined, 2)}`;
    const tag = this.selected.kind === 'zero' && this.zeros.length > 0 ? 'Zero' : 'Pole';
    this.coordsEl.textContent = `${tag}: ${sStr}  ·  ${zStr}`;
  }

  private drawTimeStrip(): void {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(TIME_W * ratio);
    const h = Math.round(TIME_H * ratio);
    if (this.timeCanvas.width !== w || this.timeCanvas.height !== h) {
      this.timeCanvas.width = w;
      this.timeCanvas.height = h;
    }
    const g = this.timeCanvas.getContext('2d');
    if (g === null) return;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, TIME_W, TIME_H);

    const timeKey = `${this.poles.map((p) => p.join(',')).join(';')}|${this.zeros.map((z) => z.join(',')).join(';')}|${this.gain}|${this.period}`;
    if (timeKey !== this.lastTimeKey || this.cachedTimeResp === null) {
      this.lastTimeKey = timeKey;
      try {
        this.cachedTimeResp = evalTimeResponse(this.poles, this.zeros, this.gain, this.period, 8, 200);
      } catch {
        this.cachedTimeResp = null;
      }
    }
    const resp = this.cachedTimeResp;
    if (resp === null || resp.f.length === 0) return;

    const MAX_ABS = 20;
    let lo = 0;
    let hi = 0;
    let clipped = false;
    for (const v of resp.f) {
      if (!Number.isFinite(v) || Math.abs(v) > MAX_ABS) {
        clipped = true;
        lo = Math.min(lo, -MAX_ABS);
        hi = Math.max(hi, MAX_ABS);
      } else {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    if (hi - lo < 0.5) {
      hi = lo + 1;
    }
    const pad = 0.12 * (hi - lo);
    lo -= pad;
    hi += pad;
    const toX = (tVal: number) => 6 + (tVal / 8) * (TIME_W - 12);
    const toY = (fVal: number) => {
      const clamped = Math.min(hi, Math.max(lo, fVal));
      return TIME_H - 6 - ((clamped - lo) / (hi - lo)) * (TIME_H - 16);
    };

    const dark = hexRgb(this.theme.background).reduce((a, b) => a + b, 0) < 1.5;
    const y0 = toY(0);
    g.strokeStyle = dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.18)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(6, y0);
    g.lineTo(TIME_W - 6, y0);
    g.stroke();

    // Continuous f(t) curve
    g.strokeStyle = COLOR_FT;
    g.lineWidth = 1.5;
    g.beginPath();
    for (let i = 0; i < resp.t.length; i++) {
      const px = toX(resp.t[i]!);
      const py = toY(resp.f[i]!);
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.stroke();

    // Discrete f(kT) stems and dots
    g.strokeStyle = COLOR_MARGINAL;
    g.fillStyle = COLOR_MARGINAL;
    g.lineWidth = 1.2;
    for (let k = 0; k < resp.tk.length; k++) {
      const px = toX(resp.tk[k]!);
      const py = toY(resp.fk[k]!);
      g.beginPath();
      g.moveTo(px, y0);
      g.lineTo(px, py);
      g.stroke();
      g.beginPath();
      g.arc(px, py, 2.2, 0, 2 * Math.PI);
      g.fill();
    }

    g.fillStyle = dark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.65)';
    g.font = '10px system-ui, sans-serif';
    g.fillText(clipped ? 'f(t), f(kT) · clipped' : 'f(t), f(kT)', 6, 11);
  }

  dispose(): void {
    this.el.remove();
  }
}
