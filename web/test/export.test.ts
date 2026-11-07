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

describe('export size and codec', () => {
  it('lays 720p and 1080p out alike, and keeps the stage even', () => {
    expect(sizePreset('720p')).toEqual({ width: 1280, height: 720, pixelRatio: 1 });
    expect(sizePreset('1080p')).toEqual({ width: 1920, height: 1080, pixelRatio: 1.5 });
    expect(sizePreset('stage', { w: 801, h: 451 }, 1)).toEqual({ width: 800, height: 450, pixelRatio: 1 });
    expect(sizePreset('stage', { w: 801, h: 451 }, 2)).toEqual({ width: 1600, height: 900, pixelRatio: 2 });
    expect(sizePreset('stage', { w: 1, h: 1 }, 3)).toEqual({ width: 4, height: 4, pixelRatio: 2 });
  });
  it('takes the lowest H.264 level that holds the size and the rate', () => {
    expect(avcCodec(1280, 720, 30)).toBe('avc1.64001f');
    expect(avcCodec(1280, 720, 60)).toBe('avc1.640020');
    expect(avcCodec(1920, 1080, 30)).toBe('avc1.640028');
    expect(avcCodec(1920, 1080, 60)).toBe('avc1.64002a');
    expect(avcCodec(3840, 2160, 30)).toBe('avc1.640033');
    expect(avcCodec(3840, 2160, 60)).toBe('avc1.640034');
    expect(avcCodec(640, 360, 30)).toBe('avc1.64001e');
    expect(avcCodec(1280, 720, 30, 'main')).toBe('avc1.4d401f');
    expect(avcCodec(1280, 720, 30, 'baseline')).toBe('avc1.42e01f');
    expect(avcCodec(7680, 4320, 30)).toBeNull();
  });
  it('fits H.264 with even sides, level 5.2 at most, and 4096 pixels a side', () => {
    for (const fps of [24, 30, 60]) {
      expect(avcFits(1280, 720, fps)).toBe(true);
      expect(avcFits(1920, 1080, fps)).toBe(true);
    }
    expect(avcFits(1281, 720, 30)).toBe(false);
    expect(avcFits(4352, 2160, 30)).toBe(false);
    expect(avcFits(5904, 2924, 60)).toBe(false);
    // level 5.2 holds 36864 macroblocks a frame and 2073600 a second, which at 60 fps is 34560 a frame
    expect(avcFits(4096, 2304, 30)).toBe(true);
    expect(avcFits(4096, 2304, 60)).toBe(false);
    expect(avcFits(4096, 2160, 60)).toBe(true);
  });
  it('keeps the stage within H.264 on a wide pane at a pixel ratio of 2', () => {
    // an export of a stage of 2952 by 1462 CSS pixels at a pixel ratio of 2 and 60 fps was refused by QuickTime
    const s = sizePreset('stage', { w: 2952, h: 1462 }, 2, 60);
    expect(avcCodec(s.width, s.height, 60)).not.toBeNull();
    expect(Math.max(s.width, s.height)).toBeLessThanOrEqual(4096);
    expect(s).toEqual({ width: 4058, height: 2010, pixelRatio: 1.375 });
    expect(sizePreset('stage', { w: 1500, h: 900 }, 2, 60)).toEqual({ width: 3000, height: 1800, pixelRatio: 2 });
    // past 4096 CSS pixels the ratio goes below 1, and the size still fits
    const huge = sizePreset('stage', { w: 9000, h: 3000 }, 1, 30);
    expect(huge.pixelRatio).toBe(0.375);
    expect(avcFits(huge.width, huge.height, 30)).toBe(true);
    for (const fps of [24, 30, 60])
      for (const dpr of [1, 1.5, 2, 3])
        // prettier-ignore
        for (const [w, h] of [[800, 600], [1500, 900], [2560, 1300], [2952, 1462], [3840, 2000], [1200, 2400]] as const) {
          const s = sizePreset('stage', { w, h }, dpr, fps);
          expect(avcFits(s.width, s.height, fps), `${w}x${h} at ${dpr} and ${fps} fps`).toBe(true);
        }
  });
  it('aims at 0.08 bits per pixel per frame, within 1 to 40 Mbit/s', () => {
    expect(exportBitrate(1280, 720, 30)).toBe(2211840);
    expect(exportBitrate(320, 240, 24)).toBe(1e6);
    expect(exportBitrate(3840, 2160, 60)).toBe(39813120);
    expect(exportBitrate(7680, 4320, 30)).toBe(40e6);
  });
});

describe('encoder choice', () => {
  afterEach(() => vi.unstubAllGlobals());
  // the answers of Chrome 154 on macOS: H.264 up to 4096 pixels a side, and VP9 at any size
  const chrome = (asked: string[]) => ({
    isConfigSupported: async (config: VideoEncoderConfig) => {
      asked.push(config.codec);
      const avc = config.codec.startsWith('avc1.') && Math.max(config.width, config.height) <= 4096 && config.width * config.height <= 4096 * 2304;
      return { supported: avc || config.codec.startsWith('vp09.'), config };
    },
  });

  it('never puts VP9 in an MP4, and refuses the size of the export that QuickTime refused', async () => {
    const asked: string[] = [];
    vi.stubGlobal('VideoEncoder', chrome(asked));
    await expect(chooseConfig(5904, 2924, 60, 40e6)).rejects.toThrow(/H\.264/);
    expect(asked.some((c) => c.startsWith('vp09'))).toBe(false);
  });

  it('takes H.264 high at the lowest level, in the avc format, at the size that the stage preset gives', async () => {
    const asked: string[] = [];
    vi.stubGlobal('VideoEncoder', chrome(asked));
    const config = await chooseConfig(4058, 2010, 60, 40e6);
    expect(config).toMatchObject({ codec: 'avc1.640034', width: 4058, height: 2010, framerate: 60, avc: { format: 'avc' } });
    expect(asked).toEqual(['avc1.640034']);
  });

  it('refuses with a reason when the browser does not have an H.264 encoder', async () => {
    const asked: string[] = [];
    vi.stubGlobal('VideoEncoder', {
      isConfigSupported: async (config: VideoEncoderConfig) => (asked.push(config.codec), { supported: config.codec.startsWith('vp09.'), config }),
    });
    await expect(chooseConfig(1280, 720, 30, 2e6)).rejects.toThrow(/does not have an H\.264 encoder for 1280 by 720 at 30 fps/);
    expect(asked).toEqual(['avc1.64001f', 'avc1.4d401f', 'avc1.42e01f']);
  });
});
