// Tests the pure parts of the video export, and an MP4 round trip of synthetic frames that does not need a codec.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  avcCodec,
  avcFits,
  checkExport,
  chooseConfig,
  defaultExportFps,
  drawColorbars,
  drawLabel,
  exportBitrate,
  frameSchedule,
  Mp4Writer,
  sizePreset,
} from '../src/runtime/export';

describe('frame schedule', () => {
  it('runs one loop in 8 s at speed 1, at the rate live playback steps', () => {
    const s30 = frameSchedule(480, 30, 1);
    expect([s30.count, s30.duration]).toEqual([240, 8]);
    expect(Array.from({ length: s30.count }, (_, k) => s30.index(k))).toEqual(Array.from({ length: 240 }, (_, k) => 2 * k));
    const s60 = frameSchedule(480, 60, 1);
    expect(Array.from({ length: s60.count }, (_, k) => s60.index(k))).toEqual(Array.from({ length: 480 }, (_, k) => k));
    const s24 = frameSchedule(480, 24, 1);
    expect(s24.count).toBe(192);
    expect([0, 1, 2, 3, 191].map(s24.index)).toEqual([0, 2, 5, 7, 477]);
  });
  it('repeats over loops, starts where asked, and stretches with a slower speed', () => {
    const s = frameSchedule(6, 30, 3, 1, 4);
    expect(s.count).toBe(720);
    const seen = Array.from({ length: s.count }, (_, k) => s.index(k));
    expect(seen.every((i) => Number.isInteger(i) && i >= 0 && i < 6)).toBe(true);
    expect(seen[0]).toBe(4);
    expect(seen.slice(0, 240)).toEqual(seen.slice(240, 480));
    expect(seen.filter((i, k) => k === 0 || i !== seen[k - 1]!).length).toBe(18);
    const slow = frameSchedule(480, 30, 1, 0.25);
    expect([slow.count, slow.duration]).toEqual([960, 32]);
    expect([slow.index(0), slow.index(1), slow.index(2), slow.index(959)]).toEqual([0, 0, 1, 479]);
    const fast = frameSchedule(480, 60, 4, 4);
    expect([fast.count, fast.duration]).toEqual([480, 8]);
    expect(fast.index(1)).toBe(4);
  });
  it('draws the exact progress at each frame, between frame indices at a slow speed', () => {
    const slow = frameSchedule(480, 30, 1, 0.25);
    expect([0, 1, 2, 3].map(slow.progress)).toEqual([0, 0.5 / 480, 1 / 480, 1.5 / 480]);
    expect([0, 1, 2, 3].map(slow.index)).toEqual([0, 0, 1, 1]);
    const s30 = frameSchedule(480, 30, 1);
    expect(Array.from({ length: s30.count }, (_, k) => s30.progress(k))).toEqual(Array.from({ length: 240 }, (_, k) => (2 * k) / 480));
    // the progress wraps with the index from a start near the end
    const late = frameSchedule(6, 30, 1, 1, 5);
    expect([late.index(30), late.progress(30), late.index(50), late.progress(50)]).toEqual([5, 5.75 / 6, 0, 0.25 / 6]);
  });
  it('lasts 8 s a lap, so that nine laps take 72 s at speed 1', () => {
    const nine = frameSchedule(4320, 30, 1, 1, 0, 72);
    expect([nine.count, nine.duration, nine.index(1), nine.progress(1)]).toEqual([2160, 72, 2, 2 / 4320]);
    expect(checkExport(nine.count, 30)).toMatch(/2160 frames is more than the 2000 an export may have: lower the frame rate or the loops, or raise the speed/);
    expect(checkExport(frameSchedule(4320, 24, 1, 1, 0, 72).count, 24)).toBeNull();
    expect(checkExport(frameSchedule(4320, 24, 2, 1, 0, 72).count, 24)).toMatch(/3456 frames/);
    expect(checkExport(frameSchedule(4320, 30, 1, 2, 0, 72).count, 30)).toBeNull();
  });
  it('starts the export row at the highest rate whose one loop fits the ceiling', () => {
    // nine laps of 480 steps, 72 s a loop at speed 1
    expect([1, 2, 4].map((speed) => defaultExportFps(4320, speed, 72))).toEqual([24, 30, 60]);
    expect([0.25, 0.5].map((speed) => defaultExportFps(4320, speed, 72))).toEqual([null, null]);
    // the Broucke example has one lap of 480 steps, 8 s a loop
    expect([0.25, 0.5, 1, 2, 4].map((speed) => defaultExportFps(480, speed, 8))).toEqual([60, 60, 60, 60, 60]);
  });
  it('is refused past 2000 frames or 90 s', () => {
    expect(checkExport(frameSchedule(480, 60, 4, 1).count, 60)).toBeNull();
    expect(checkExport(2000, 30)).toBeNull();
    expect(checkExport(2001, 30)).toMatch(/2001 frames/);
    expect(checkExport(frameSchedule(480, 24, 4, 0.5).count, 24)).toBeNull();
    expect(checkExport(frameSchedule(480, 24, 3, 0.25).count, 24)).toMatch(/2304 frames is more than the 2000/);
    // at 24 fps and above, the frame ceiling binds first, hence the time ceiling shows at a lower rate
    expect(checkExport(1000, 10)).toMatch(/100\.0 s is longer than the 90 s an export may last: lower the loops or raise the speed/);
    expect(checkExport(0, 30)).toMatch(/is 0, not a count of at least one/);
  });
});
