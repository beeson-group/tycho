/**
 * Readouts and the pure helpers behind the controls (section 2.9). The helpers cover number
 * formatting, the slider's stops, the text of a readout and its split into stat tiles, and the map
 * from wall time to the loop position that playback and a video export draw. They also cover the
 * frame rate shown during playback, the keyboard map, and the colorbar that sets a selector.
 */
import { fail } from '../errors.js';
import { driverMember, oneSet, querySets, variableDef, variableValue, type PanelScope } from '../evaluate/resolve.js';
import type { SetCache } from '../evaluate/sets.js';
import type { Clock, Control, Readout, Scene, SetQuery, State, View } from '../scene.js';
import { channelAtReading, type GeometryCache } from './geometry.js';

const MINUS = '−';

/**
 * A number for a readout. With `digits`, it is written to `digits` significant digits with trailing
 * zeros kept. Otherwise an integer is written as it is, and any other number to six significant
 * digits with trailing zeros dropped. An exponent is written as `e` and the exponent, and a minus sign as U+2212.
 */
export function formatNumber(x: number, digits?: number): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? 'NaN' : x > 0 ? '∞' : `${MINUS}∞`;
  if (x === 0) x = 0; // turns negative zero into zero
  let s: string;
  if (digits !== undefined) s = x.toPrecision(digits);
  else if (Number.isInteger(x) && Math.abs(x) < 1e21) s = String(x);
  else {
    s = x.toPrecision(6);
    const [mantissa, exponent] = s.split('e') as [string, string | undefined];
    const trimmed = mantissa.includes('.') ? mantissa.replace(/0+$/, '').replace(/\.$/, '') : mantissa;
    s = exponent === undefined ? trimmed : `${trimmed}e${exponent}`;
  }
  return s.replace('e+', 'e').replace(/-/g, MINUS);
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

/** Seconds one lap of the clock lasts at speed 1, whatever its steps. */
export const LAP_SECONDS = 8;

/** The seconds that one loop of the clock lasts at speed 1, which are LAP_SECONDS for each of its laps (rule C6). */
export function loopSeconds(clock: Clock): number {
  return LAP_SECONDS * (clock.laps ?? 1);
}

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

type Part = Readout['parts'][number];

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
  for (const p of parts) {
    if (typeof p === 'string') out.push(p);
    else if ('clock' in p) out.push(String(p.clock === 'index' ? i : steps));
    else if ('var' in p) {
      const v = variableValue(scope, p.var);
      const def = variableDef(scene, p.var);
      if (typeof v === 'number') out.push(formatNumber(v, p.digits));
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
      if ('member' in p) out.push(formatNumber(set.parameter(p.member, '2.9')[d.track]!, p.digits));
      else if ('attr' in p) out.push(formatNumber((p.factor ?? 1) * set.attr(p.attr) + (p.offset ?? 0), p.digits));
      else {
        const tc = geometry.readings(d.setId, state.clock.channel).clocks[d.track]!;
        if (!set.hasChannel(p.channel)) fail('2.9', `track set ${d.setId} lacks channel ${JSON.stringify(p.channel)}`);
        out.push(formatNumber(channelAtReading(set, tc, d.track, p.channel, scene.clock, q), p.digits));
      }
    }
  }
  return out;
}
