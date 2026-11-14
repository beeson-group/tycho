/**
 * Readouts and the pure helpers behind the controls (section 2.9). The helpers cover number
 * formatting, the slider's stops, the text of a readout and its split into stat tiles, and the map
 * from wall time to the loop position that playback and a video export draw. They also cover the
 * frame rate shown during playback, the keyboard map, and the colorbar that sets a selector.
 */
import { fail } from '../errors.js';
import { driverMember, oneSet, querySets, variableDef, variableValue, type PanelScope } from '../evaluate/resolve.js';
import type { SetCache } from '../evaluate/sets.js';
import type { Control, Scene, SetQuery, State, TextPart, View } from '../scene.js';
import { clockValue, timeAt, tweenValue, type Key } from '../evaluate/timeline.js';
import { channelAtReading, type GeometryCache } from './geometry.js';

const MINUS = '−';

/**
 * A number for a readout. With `digits`, it is written to `digits` significant digits with trailing
 * zeros kept. Otherwise an integer is written as it is, and any other number to six significant
 * digits with trailing zeros dropped. An exponent is written as `e` and the exponent, and a minus sign as U+2212.
 */
export function formatNumber(x: number, digits?: number, decimals?: number, grouping = false): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? 'NaN' : x > 0 ? '∞' : `${MINUS}∞`;
  if (x === 0) x = 0; // turns negative zero into zero
  let s: string;
  if (decimals !== undefined) {
    s = x.toFixed(decimals);
    // a value that rounds to zero is written without a sign
    if (/^-0(\.0*)?$/.test(s)) s = s.slice(1);
  } else if (digits !== undefined) s = x.toPrecision(digits);
  else if (Number.isInteger(x) && Math.abs(x) < 1e21) s = String(x);
  else {
    s = x.toPrecision(6);
    const [mantissa, exponent] = s.split('e') as [string, string | undefined];
    const trimmed = mantissa.includes('.') ? mantissa.replace(/0+$/, '').replace(/\.$/, '') : mantissa;
    s = exponent === undefined ? trimmed : `${trimmed}e${exponent}`;
  }
  if (grouping && !s.includes('e')) s = s.replace(/^(-?)(\d+)/, (_, sign: string, whole: string) => sign + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
  return s.replace('e+', 'e').replace(/-/g, MINUS);
}

/** The options of a part that gives a number (rule K7). */
interface NumberFormat {
  width?: number;
  digits?: number;
  decimals?: number;
  grouping?: boolean;
  factor?: number;
  offset?: number;
}

/** A number of a part, scaled by its factor and offset and written by its format (rule K7). */
function formatPart(x: number, p: NumberFormat): string {
  return formatNumber((p.factor ?? 1) * x + (p.offset ?? 0), p.digits, p.decimals, p.grouping ?? false).padStart(p.width ?? 0, ' ');
}

/** The slider's stops, which are the distinct parameter values of the matched track sets in increasing order (section 2.9). */
export function sliderStops(scope: PanelScope, sets: SetCache, control: Extract<Control, { kind: 'slider' }>): number[] {
  const sel = variableDef(scope.scene, control.variable);
  if (sel?.kind !== 'selector' || sel.parameter === undefined) return [];
  const values: number[] = [];
  for (const id of querySets(scope, control.domain)) {
    const set = sets.get(id);
    if (!Object.hasOwn(set.def.parameters ?? {}, sel.parameter)) continue;
    const p = set.parameter(sel.parameter, '2.9');
    for (let t = 0; t < p.length; t++) values.push(p[t]!);
  }
  values.sort((a, b) => a - b);
  return values.filter((v, i) => i === 0 || v !== values[i - 1]);
}

/** The index of the stop nearest a value, the lowest index winning a tie, or -1 when `stops` is empty. */
export function nearestStop(stops: readonly number[], value: number): number {
  let best = -1;
  for (let i = 0; i < stops.length; i++) if (best < 0 || Math.abs(stops[i]! - value) < Math.abs(stops[best]! - value)) best = i;
  return best;
}

export { LAP_SECONDS, loopSeconds } from '../evaluate/timeline.js';

/**
 * The loop position, in frame indices and unwrapped, `time` after a playback showed frame index
 * `start`, with `perSecond` units of time to the second. A loop of `steps` lasts `seconds / speed`
 * seconds. Live playback counts milliseconds and a video export its frames, and one division of
 * exact products keeps a position that should be an integer exact.
 */
export function loopPosition(start: number, time: number, perSecond: number, steps: number, speed: number, seconds: number): number {
  return start + (Math.max(0, time) * steps * speed) / (perSecond * seconds);
}

/** The frame index at a loop position, i.e. its integer part wrapped into [0, steps). */
export function positionIndex(x: number, steps: number): number {
  const i = Math.floor(x);
  return ((i % steps) + steps) % steps;
}

/** The progress q in [0, 1) at a loop position, which lies between two frame indices while playing. */
export function positionProgress(x: number, steps: number): number {
  const q = (((x % steps) + steps) % steps) / steps;
  return q < 1 ? q : 0;
}

/** The panel, the state, and the frame index through which a readout reads. A caption without a panel does not read anything. */
export interface ReadoutContext {
  scene: Scene;
  geometry: GeometryCache;
  state: State;
  /** The panel whose driver and values the readout reads. */
  panel: string;
  frameIndex: number;
  /** The progress at which the channel parts read, between two frame indices while playing. It defaults to frameIndex / steps. */
  progress?: number;
}

type Part = TextPart;

/** The text of a readout. A part that the driver cannot give, because its query does not match any set, reads as a dash. */
export function readoutText(ctx: ReadoutContext, parts: readonly Part[]): string {
  return readoutPieces(ctx, parts).join('');
}

/** The text of each part of a readout, one per part, or an empty list when the panel is missing. */
export function readoutPieces(ctx: ReadoutContext, parts: readonly Part[]): string[] {
  const { scene, geometry, state } = ctx;
  const panel = state.panels[ctx.panel];
  if (panel === undefined || !Object.hasOwn(state.panels, ctx.panel)) return [];
  const scope: PanelScope = { scene, state, panel };
  const view = scene.views[panel.view]!;
  const steps = scene.clock.steps;
  const i = ((ctx.frameIndex % steps) + steps) % steps;
  const q = ctx.progress ?? i / steps;
  let driver: { setId: string; track: number } | null | undefined;
  const getDriver = () => {
    if (driver === undefined) {
      const id = oneSet(scope, view.driver.sets);
      driver = id === null ? null : { setId: id, track: driverMember(scope, view.driver.member, geometry.sets.get(id)) };
    }
    return driver;
  };
  const out: string[] = [];
  const s = timeAt(scene.clock, q);
  for (const p of parts) {
    if (typeof p === 'string') out.push(p);
    else if ('sub' in p) out.push(p.sub);
    else if ('sup' in p) out.push(p.sup);
    else if ('steps' in p) {
      let text = '';
      for (const [t, v] of p.steps) if ((t as number) <= s) text = String(v);
      out.push(text);
    } else if ('keys' in p) out.push(formatPart(tweenValue(p.keys as Key[], s), p));
    else if ('clock' in p) {
      if (p.clock === 'index' || p.clock === 'steps') {
        const n = p.clock === 'index' ? i : steps;
        const format = p.factor !== undefined || p.offset !== undefined || p.decimals !== undefined || p.grouping;
        out.push(format ? formatPart(n, p) : String(n).padStart(p.width ?? 0, ' '));
      } else if (p.clock === 'time') out.push(formatPart(s, p));
      else out.push(formatPart(scene.clock.mode === 'fraction' ? q : clockValue(scene.clock, q), p));
    } else if ('var' in p) {
      const v = variableValue(scope, p.var);
      const def = variableDef(scene, p.var);
      if (typeof v === 'number') out.push(formatPart(v, p));
      else if (typeof v === 'boolean') out.push(v ? 'on' : 'off');
      else if (def?.kind === 'choice' && def.labels !== undefined) out.push(def.labels[def.values.indexOf(v)] ?? v);
      else out.push(v);
    } else {
      const d = getDriver();
      if (d === null) {
        out.push('—');
        continue;
      }
      const set = geometry.sets.get(d.setId);
      if ('member' in p) out.push(formatPart(set.parameter(p.member, '2.9')[d.track]!, p));
      else if ('attr' in p) out.push(formatPart(set.attr(p.attr), p));
      else if ('channel' in p) {
        const tc = geometry.readings(d.setId, state.clock.channel).clocks[d.track]!;
        if (!set.hasChannel(p.channel)) fail('2.9', `track set ${d.setId} lacks channel ${JSON.stringify(p.channel)}`);
        const hold = set.def.channels?.[p.channel]?.interp === 'hold';
        out.push(formatPart(channelAtReading(set, tc, d.track, p.channel, scene.clock, q, hold), p));
      }
    }
  }
  return out;
}

// stat tiles

/** One stat tile of a readout: its label, the index of its value part, and its unit. */
export interface ReadoutTile {
  label: string;
  part: number;
  unit: string;
  /** The least width of the value in ch, for a value that changes during playback (a channel or the clock), so that it does not move its neighbors. */
  width: number | null;
}

/**
 * A readout as stat tiles, or null when its text does not split. Parts are flat text, hence the
 * split is a heuristic. A value's label is the text after the last comma before it, less a
 * trailing "=" or ":", and its unit is the text after it up to the next comma. It fails when a
 * label is empty, when the text between two values does not have a comma to split at, or when any
 * text would be left over. Attribute parts, which are scene constants, go last.
 */
export function readoutTiles(parts: readonly Part[]): ReadoutTile[] | null {
  const texts: string[] = [''];
  const values: number[] = [];
  parts.forEach((p, i) => {
    if (typeof p === 'string') texts[texts.length - 1] += p;
    else {
      values.push(i);
      texts.push('');
    }
  });
  if (values.length === 0) return null;
  const blank = (xs: string[]) => xs.every((x) => x.trim() === '');
  const tiles: ReadoutTile[] = [];
  for (let k = 0; k < values.length; k++) {
    const before = texts[k]!.split(',');
    const after = texts[k + 1]!.split(',');
    // the text between two values holds the first one's unit and the second one's label
    if (k > 0 ? before.length < 2 || !blank(before.slice(1, -1)) : !blank(before.slice(0, -1))) return null;
    if (k === values.length - 1 && !blank(after.slice(1))) return null;
    const label = before[before.length - 1]!.replace(/\s*[=:]\s*$/, '').trim();
    if (label === '') return null;
    const p = parts[values[k]!] as Exclude<Part, string>;
    const width = 'clock' in p || 'keys' in p ? 5 : 'channel' in p ? (p.digits ?? 6) + 5 : null;
    tiles.push({ label, part: values[k]!, unit: after[0]!.trim(), width });
  }
  const constant = (t: ReadoutTile) => 'attr' in (parts[t.part] as object);
  return [...tiles.filter((t) => !constant(t)), ...tiles.filter(constant)];
}

// playback

/** How a second of playback went: draws presented, late ones, and the display's refresh interval. */
export interface FrameReport {
  /** Draws presented in the last second. */
  drawn: number;
  /** Draws that came more than half a refresh interval after the one they should have followed. */
  late: number;
  /** The estimated refresh interval of the display in milliseconds. */
  refresh: number;
}

/**
 * Counts the draws presented in the last second, as the Playback group shows it. An average of
 * intervals hides a dropped refresh among smooth ones. The meter therefore keeps the presentation
 * times themselves. The refresh interval is estimated as the shortest interval that recurs, taken as the
 * 10th percentile of the window, and a draw is late when its interval exceeds the refresh interval by half.
 */
export class FrameMeter {
  private readonly times: number[] = [];

  reset(): void {
    this.times.length = 0;
  }

  /** Records a draw presented at `now`, in milliseconds, and forgets those over a second old. */
  note(now: number): void {
    this.times.push(now);
    let drop = 0;
    while (drop < this.times.length && this.times[drop]! < now - 1000) drop++;
    if (drop > 0) this.times.splice(0, drop);
  }

  /** The report of the last second, or null until a full second of draws has been seen since the last reset or after a stall. */
  report(now: number): FrameReport | null {
    const t = this.times;
    if (t.length < 2 || now - t[0]! < 900 || now - t[t.length - 1]! > 1000) return null;
    const intervals = [];
    for (let i = 1; i < t.length; i++) intervals.push(t[i]! - t[i - 1]!);
    const sorted = [...intervals].sort((a, b) => a - b);
    const refresh = sorted[Math.floor(sorted.length / 10)]!;
    const late = intervals.filter((d) => d > 1.5 * refresh).length;
    return { drawn: t.length, late, refresh };
  }
}

/** The Playback group's frame rate, which shows the draws in the last second, or dashes while paused or before a second has passed. */
export function fpsText(report: FrameReport | null): string {
  return report === null ? '–– fps' : `${report.drawn} fps`;
}

/** The tooltip behind the frame rate. */
export function fpsTitle(report: FrameReport | null): string {
  if (report === null) return 'Frames drawn per second during playback';
  const hz = Math.round(1000 / report.refresh);
  return `${report.drawn} frames drawn in the last second, ${report.late} late, on a display refreshing about ${hz} times a second`;
}

export type KeyAction =
  | { kind: 'toggle' }
  | { kind: 'step'; by: number }
  | { kind: 'seek'; frame: number }
  | { kind: 'fit' }
  | { kind: 'slider'; by: number }
  | { kind: 'view'; axis: 'x' | 'y' | 'z'; sign: 1 | -1 }
  | { kind: 'turn'; degrees: number };

/**
 * The action of a key, following common video players. Space or k plays and pauses. The left and right
 * arrows step one frame and pause, and ten with Shift. Home or 0 goes to frame 0, and a digit from 1 to 9
 * goes to as many tenths of the loop. The key f fits every panel. The up and down arrows step the first
 * scene-scoped slider by one stop, or by ten with Shift. In a panel with an orbit camera, x, y, and z show
 * the view from the positive side of that axis, and from the negative side with Shift, and "," and "." turn
 * it about the camera's up axis by 15 degrees, where "." turns it as a drag to the right does. Shift with
 * either turns it by 90 degrees. Shift with them gives "<" and ">" on a US keyboard and other characters
 * elsewhere, hence the two keys are then known by `code`, the `code` of the key event.
 */
export function keyAction(key: string, shift: boolean, steps: number, code = ''): KeyAction | null {
  const n = shift ? 10 : 1;
  switch (key) {
    case 'x':
    case 'y':
    case 'z':
    case 'X':
    case 'Y':
    case 'Z':
      return { kind: 'view', axis: key.toLowerCase() as 'x' | 'y' | 'z', sign: shift ? -1 : 1 };
    case '.':
      return { kind: 'turn', degrees: 15 };
    case ',':
      return { kind: 'turn', degrees: -15 };
    case '>':
      return { kind: 'turn', degrees: 90 };
    case '<':
      return { kind: 'turn', degrees: -90 };
    case ' ':
    case 'k':
    case 'K':
      return { kind: 'toggle' };
    case 'ArrowRight':
      return { kind: 'step', by: n };
    case 'ArrowLeft':
      return { kind: 'step', by: -n };
    case 'Home':
      return { kind: 'seek', frame: 0 };
    case 'f':
    case 'F':
      return { kind: 'fit' };
    case 'ArrowUp':
      return { kind: 'slider', by: n };
    case 'ArrowDown':
      return { kind: 'slider', by: -n };
  }
  if (shift && code === 'Period') return { kind: 'turn', degrees: 90 };
  if (shift && code === 'Comma') return { kind: 'turn', degrees: -90 };
  return /^[0-9]$/.test(key) ? { kind: 'seek', frame: Math.round((steps * Number(key)) / 10) % steps } : null;
}

/** Whether a focused form control takes `key` itself, given the tag name and the `type` of the control. */
export function controlUsesKey(tag: string, type: string, key: string): boolean {
  const moves = key.startsWith('Arrow') || key === 'Home' || key === 'End' || key === 'PageUp' || key === 'PageDown';
  if (tag === 'BUTTON' || (tag === 'INPUT' && type === 'checkbox')) return key === ' ' || key === 'Enter';
  if (tag === 'INPUT' && type === 'range') return moves;
  if (tag === 'SELECT') return moves || key === 'Enter' || key.length === 1;
  return tag === 'TEXTAREA' || tag === 'INPUT';
}

// a colorbar as a slider

/** The scene-scoped selector that dragging a colorbar sets, with the label of its control and the track sets that its stops come from. */
export interface ColorbarLink {
  variable: string;
  label: string;
  domain: SetQuery;
}

/** The labels a colorbar over a parameter can carry, written as the renderer writes them, with the label or the name, then the unit. */
function parameterLabels(scene: Scene, param: string): Set<string> {
  const out = new Set<string>([param]);
  for (const set of Object.values(scene.track_sets)) {
    const params = set?.parameters;
    if (params === undefined || !Object.hasOwn(params, param)) continue;
    const def = params[param]!;
    const label = def.label ?? param;
    out.add(def.unit ? `${label}, ${def.unit}` : label);
  }
  return out;
}

/**
 * The selector that a colorbar of `view` sets. It is found from the bar's label, through a track
 * layer colored by a parameter whose label the bar carries and a scene-scoped selector by nearest over the
 * same parameter. The stops come from the selector's slider domain, else from the layer's sets.
 * The result is null when a matching layer or a matching selector does not exist.
 */
export function colorbarLink(scene: Scene, view: View, barLabel: string): ColorbarLink | null {
  for (const layer of view.layers) {
    if (layer.kind !== 'track' || layer.color === undefined || typeof layer.color === 'string' || !('parameter' in layer.color)) continue;
    const param = layer.color.parameter;
    if (!parameterLabels(scene, param).has(barLabel)) continue;
    for (const [id, v] of Object.entries(scene.variables ?? {})) {
      if (v === undefined || v.kind !== 'selector' || v.scope === 'panel' || v.by === 'index' || v.parameter !== param) continue;
      const control = (scene.controls ?? []).find((c): c is Extract<Control, { kind: 'slider' }> => c.kind === 'slider' && c.variable === id);
      return { variable: id, label: control?.label ?? id, domain: control?.domain ?? layer.sets };
    }
  }
  return null;
}

/** The index of the stop nearest the value at `t` in [0, 1] along a bar from `lo` to `hi`, or -1 when `stops` is empty. */
export function stopAt(stops: readonly number[], lo: number, hi: number, t: number): number {
  return nearestStop(stops, lo + Math.min(1, Math.max(0, t)) * (hi - lo));
}
