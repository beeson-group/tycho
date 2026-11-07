/**
 * Video export. An export freezes a state snapshot and steps the frame index through whole loops at the
 * rate live playback uses. The renderer of live playback draws each frame into a canvas of fixed size and pixel ratio
 * that is never on the page, and the readouts and the caption are written onto it as text. The frames are
 * encoded as H.264 through WebCodecs and muxed into an MP4 file with mp4-muxer. A frame thus depends only
 * on the snapshot, the frame index, the size, and the pixel ratio, and the cameras take the fit the panels
 * start with. VP9 is not used as a fallback, because QuickTime, and with it every Mac, does not open VP9 in an
 * MP4. A size or a browser that H.264 cannot serve is therefore refused.
 *
 * Everything above the comment `// in the browser`, from the schedule to the muxing in Mp4Writer, is pure and runs under Node.
 */
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import type { Layout, Readout, Scene, State } from '../scene.js';
import { hexRgb, mixHex, sceneTheme } from './colors.js';
import type { GeometryCache } from './geometry.js';
import type { Colorbar, PanelLabel } from './overlay.js';
import { formatNumber, LAP_SECONDS, loopPosition, loopSeconds, positionIndex, positionProgress, readoutText } from './readouts.js';
import { GUTTER, StageRenderer } from './renderer.js';
import { tile } from './tiles.js';

/** The longest export allowed, in frames and in seconds. A longer export is refused. */
export const EXPORT_LIMITS = { frames: 2000, seconds: 90 } as const;
export const EXPORT_FPS = [24, 30, 60] as const;
export const EXPORT_LOOPS = [1, 2, 3, 4] as const;

export interface Schedule {
  /** The number of output frames. */
  count: number;
  /** The length of the video in seconds. */
  duration: number;
  /** The frame index shown at output frame `k`, which its readouts' clock parts show. */
  index(k: number): number;
  /** The progress drawn at output frame `k`, between two frame indices as live playback draws it. */
  progress(k: number): number;
}

/**
 * Every output frame, as live playback would draw it at the time of the frame. A loop of `steps` lasts
 * `seconds / speed`, where `seconds` is LAP_SECONDS for each lap. Output frame `k` is drawn at time
 * `k / fps`, at the progress reached then, with the integer part of the loop position as its index.
 */
export function frameSchedule(steps: number, fps: number, loops: number, speed = 1, start = 0, seconds = LAP_SECONDS): Schedule {
  const count = Math.round((loops * seconds * fps) / speed);
  // exact while k * steps * speed stays an integer below 2^53, which a ceiling of a few thousand
  // frames and the speeds of a binary fraction keep
  const at = (k: number) => loopPosition(start, k, fps, steps, speed, seconds);
  return {
    count,
    duration: count / fps,
    index: (k: number) => positionIndex(at(k), steps),
    progress: (k: number) => positionProgress(at(k), steps),
  };
}

/** Why an export of `count` frames at `fps` is refused, or null when it is not. */
export function checkExport(count: number, fps: number): string | null {
  if (!(count >= 1)) return `the frame count of the export is ${count}, not a count of at least one`;
  if (count > EXPORT_LIMITS.frames) {
    return `${count} frames is more than the ${EXPORT_LIMITS.frames} an export may have: lower the frame rate or the loops, or raise the speed`;
  }
  if (count / fps > EXPORT_LIMITS.seconds) {
    return `${(count / fps).toFixed(1)} s is longer than the ${EXPORT_LIMITS.seconds} s an export may last: lower the loops or raise the speed`;
  }
  return null;
}

/**
 * The frame rate an export row starts at, i.e. the highest of EXPORT_FPS at which one loop at
 * `speed` stays within EXPORT_LIMITS, or null when every rate in EXPORT_FPS exceeds them.
 */
export function defaultExportFps(steps: number, speed: number, seconds = LAP_SECONDS): number | null {
  for (const fps of [...EXPORT_FPS].reverse()) if (checkExport(frameSchedule(steps, fps, 1, speed, 0, seconds).count, fps) === null) return fps;
  return null;
}

export type SizePreset = '720p' | '1080p' | 'stage';

export interface ExportSize {
  /** The size of the video in pixels, as `width` and `height`. */
  width: number;
  height: number;
  /** Video pixels per CSS pixel. The layout, the fit, the line widths, and the text are laid out at a width of width / pixelRatio CSS pixels. */
  pixelRatio: number;
}

/**
 * A preset's size at `fps`. The presets 720p and 1080p share one layout of 1280 by 720 CSS pixels,
 * at pixel ratios of 1 and 1.5. The preset `stage` is the stage's size rounded down to even pixels,
 * at the whole pixel ratio nearest the screen's, at most 2. Where H.264 cannot hold the size and the
 * rate there, the ratio is lowered in eighths to the largest at which it can. Both sides are kept even, as required by H.264.
 */
export function sizePreset(preset: SizePreset, stage = { w: 1280, h: 720 }, devicePixelRatio = 1, fps = 30): ExportSize {
  if (preset === '720p') return { width: 1280, height: 720, pixelRatio: 1 };
  if (preset === '1080p') return { width: 1920, height: 1080, pixelRatio: 1.5 };
  const even = (x: number) => Math.max(2, 2 * Math.floor(x / 2));
  const w = even(stage.w);
  const h = even(stage.h);
  let size: ExportSize = { width: w, height: h, pixelRatio: 1 };
  for (let eighths = 8 * Math.min(2, Math.max(1, Math.round(devicePixelRatio))); eighths >= 1; eighths--) {
    const ratio = eighths / 8;
    size = { width: even(w * ratio), height: even(h * ratio), pixelRatio: ratio };
    if (avcFits(size.width, size.height, fps)) break;
  }
  return size;
}

/** The H.264 levels, each as its number, maximum frame size, and maximum rate, in 16 by 16 macroblocks. */
const AVC_LEVELS: [number, number, number][] = [
  [30, 1620, 40500],
  [31, 3600, 108000],
  [32, 5120, 216000],
  [40, 8192, 245760],
  [42, 8704, 522240],
  [50, 22080, 589824],
  [51, 36864, 983040],
  [52, 36864, 2073600],
];

/**
 * The widest side an export takes. The H.264 hardware encoder of macOS does not accept a wider side (VideoToolbox
 * does not open a session at 4352 by 2160), and Chrome there falls back to software beyond it.
 */
export const AVC_MAX_SIDE = 4096;

/** Whether H.264 holds a size and rate, i.e. whether both sides are even, a level up to 5.2 holds them, and neither side exceeds AVC_MAX_SIDE. */
export function avcFits(width: number, height: number, fps: number): boolean {
  return width % 2 === 0 && height % 2 === 0 && Math.max(width, height) <= AVC_MAX_SIDE && avcCodec(width, height, fps) !== null;
}

/** The H.264 codec string for a size and rate, at the lowest level that holds them, or null past level 5.2. */
export function avcCodec(width: number, height: number, fps: number, profile: 'high' | 'main' | 'baseline' = 'high'): string | null {
  const wm = Math.ceil(width / 16);
  const hm = Math.ceil(height / 16);
  const fs = wm * hm;
  const level = AVC_LEVELS.find(([, maxFs, maxRate]) => fs <= maxFs && fs * fps <= maxRate && Math.max(wm, hm) <= Math.sqrt(8 * maxFs));
  if (level === undefined) return null;
  const p = { high: '6400', main: '4d40', baseline: '42e0' }[profile];
  return `avc1.${p}${level[0].toString(16).padStart(2, '0')}`;
}

/** A target bitrate of 0.08 bits per pixel per frame, ample for lines on a plain background, within 1 to 40 Mbit/s. */
export function exportBitrate(width: number, height: number, fps: number): number {
  return Math.round(Math.min(40e6, Math.max(1e6, 0.08 * width * height * fps)));
}

/**
 * MP4 muxing of encoded H.264 chunks, through mp4-muxer's raw path, so that it runs without
 * WebCodecs. The moov box goes before the media data.
 */
export class Mp4Writer {
  private readonly muxer: Muxer<ArrayBufferTarget>;

  constructor(width: number, height: number, fps: number) {
    if (width % 2 !== 0 || height % 2 !== 0) throw new Error(`an MP4 export needs even sides, not ${width} by ${height}`);
    this.muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width, height, frameRate: fps }, fastStart: 'in-memory' });
  }

  /** Adds one encoded frame. Times are in microseconds. */
  add(data: Uint8Array, key: boolean, timestamp: number, duration: number, meta?: EncodedVideoChunkMetadata): void {
    const config = meta?.decoderConfig;
    if (config !== undefined) {
      if (!config.codec.startsWith('avc1.')) throw new Error(`an MP4 export holds H.264 only, not ${config.codec}`);
      // an Annex B stream comes without the avcC record, and mp4-muxer would write it empty
      if (config.description === undefined) throw new Error('the H.264 encoder did not give an avcC record. Configure it with avc: { format: "avc" }');
    }
    this.muxer.addVideoChunkRaw(data, key ? 'key' : 'delta', timestamp, duration, meta);
  }

  finish(): Uint8Array {
    this.muxer.finalize();
    return new Uint8Array(this.muxer.target.buffer);
  }
}
