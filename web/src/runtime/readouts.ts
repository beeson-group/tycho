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
