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
