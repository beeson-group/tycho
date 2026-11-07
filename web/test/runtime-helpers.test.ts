import { describe, expect, it } from 'vitest';
import { SetCache } from '../src/evaluate/sets';
import { colormapPosition, hexRgb, mixHex } from '../src/runtime/colors';
import { GeometryCache } from '../src/runtime/geometry';
import {
  formatNumber,
  LAP_SECONDS,
  loopPosition,
  loopSeconds,
  nearestStop,
  positionIndex,
  positionProgress,
  readoutText,
  sliderStops,
} from '../src/runtime/readouts';
import { withVariable } from '../src/runtime/state';
import { ratioAt, tile, withRatio } from '../src/runtime/tiles';
import type { Layout, Readout, Scene } from '../src/scene';
import { validate } from '../src/validate';
import { baseScene, MemoryStore, state } from './helpers';
import { loadCorpus } from './corpus';

describe('formatNumber', () => {
  it('gives digits as significant digits, keeping trailing zeros', () => {
    expect(formatNumber(0.123456, 3)).toBe('0.123');
    expect(formatNumber(0.2, 3)).toBe('0.200');
    expect(formatNumber(12.5, 2)).toBe('13');
    expect(formatNumber(1234.5, 2)).toBe('1.2e3');
    expect(formatNumber(-0.000012345, 2)).toBe('−0.000012');
    expect(formatNumber(-1.2345e-7, 2)).toBe('−1.2e−7');
    expect(formatNumber(-0.5, 2)).toBe('−0.50');
  });
  it('without digits, gives an integer as it is and any other number to six significant digits', () => {
    expect(formatNumber(42)).toBe('42');
    expect(formatNumber(-0)).toBe('0');
    expect(formatNumber(1 / 3)).toBe('0.333333');
    expect(formatNumber(0.1 + 0.2)).toBe('0.3');
    expect(formatNumber(2.5e-9)).toBe('2.5e−9');
    expect(formatNumber(Infinity)).toBe('∞');
  });
});
