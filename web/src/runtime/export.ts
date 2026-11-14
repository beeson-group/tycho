/**
 * Video export. An export freezes a state snapshot and steps the frame index through whole loops at the rate live playback uses.
 * Each frame is a picture that the viewer lays out at the size of the video in CSS pixels and paints onto a canvas at the pixel
 * ratio of the video, i.e. what a viewer of that size shows on the page, with the cameras at the fit the panels start with. The
 * frames are encoded as H.264 through WebCodecs and muxed into an MP4 file with mp4-muxer. VP9 is not used as a fallback, because
 * QuickTime, and with it every Mac, does not open VP9 in an MP4. A size or a browser that H.264 cannot serve is therefore refused.
 *
 * Everything above the comment `// in the browser`, from the schedule to the muxing in Mp4Writer, is pure and runs under Node.
 */
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import type { Clock } from '../scene.js';
import { REVOLUTION_SECONDS, loopPosition, loopSeconds, positionIndex, positionProgress } from './readouts.js';

export interface ExportLimits {
  frames: number;
  seconds: number;
}

/** The longest export allowed by default, in frames and in seconds. A longer export is refused unless `limits` of ExportOptions raises them. */
export const EXPORT_LIMITS: Readonly<ExportLimits> = { frames: 2000, seconds: 90 };
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
 * Every output frame, as live playback would draw it at the time of the frame. A loop of `frameCount` frames lasts
 * `seconds / speed`, where `seconds` is the clock's loopSeconds. Output frame `k` is drawn at time
 * `k / fps`, at the progress reached then, with the integer part of the loop position as its index.
 */
export function frameSchedule(frameCount: number, fps: number, loops: number, speed = 1, start = 0, seconds = REVOLUTION_SECONDS): Schedule {
  const count = Math.round((loops * seconds * fps) / speed);
  // exact while k * frameCount * speed stays an integer below 2^53, which a ceiling of a few thousand
  // frames and the speeds of a binary fraction keep
  const at = (k: number) => loopPosition(start, k, fps, frameCount, speed, seconds);
  return {
    count,
    duration: count / fps,
    index: (k: number) => positionIndex(at(k), frameCount),
    progress: (k: number) => positionProgress(at(k), frameCount),
  };
}

/** Why an export of `count` frames at `fps` is refused under `limits`, or null when it is not. */
export function checkExport(count: number, fps: number, limits: ExportLimits = EXPORT_LIMITS): string | null {
  if (!(count >= 1)) return `the frame count of the export is ${count}, not a count of at least one`;
  if (count > limits.frames) {
    return `${count} frames is more than the ${limits.frames} an export may have: lower the frame rate or the loops, or raise the speed`;
  }
  if (count / fps > limits.seconds) {
    return `${(count / fps).toFixed(1)} s is longer than the ${limits.seconds} s an export may last: lower the loops or raise the speed`;
  }
  return null;
}

/**
 * The frame rate an export row starts at, i.e. the highest of EXPORT_FPS at which one loop at
 * `speed` stays within EXPORT_LIMITS, or null when every rate in EXPORT_FPS exceeds them.
 */
export function defaultExportFps(frameCount: number, speed: number, seconds = REVOLUTION_SECONDS): number | null {
  for (const fps of [...EXPORT_FPS].reverse()) if (checkExport(frameSchedule(frameCount, fps, 1, speed, 0, seconds).count, fps) === null) return fps;
  return null;
}

export type SizePreset = '720p' | '1080p' | 'panels';

export interface ExportSize {
  /** The size of the video in pixels, as `width` and `height`. */
  width: number;
  height: number;
  /** Video pixels per CSS pixel. The layout, the fit, the line widths, and the text are laid out at a width of width / pixelRatio CSS pixels. */
  pixelRatio: number;
}

/**
 * A preset's size at `fps`. The presets 720p and 1080p share one layout of 1280 by 720 CSS pixels,
 * at pixel ratios of 1 and 1.5. The preset `panels` is the size of the panel area rounded down to even pixels,
 * at the whole pixel ratio nearest the screen's, at most 2. Where H.264 cannot hold the size and the
 * rate there, the ratio is lowered in eighths to the largest at which it can. Both sides are kept even, as required by H.264.
 */
export function sizePreset(preset: SizePreset, panelArea = { w: 1280, h: 720 }, devicePixelRatio = 1, fps = 30): ExportSize {
  if (preset === '720p') return { width: 1280, height: 720, pixelRatio: 1 };
  if (preset === '1080p') return { width: 1920, height: 1080, pixelRatio: 1.5 };
  const even = (x: number) => Math.max(2, 2 * Math.floor(x / 2));
  const w = even(panelArea.w);
  const h = even(panelArea.h);
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

// in the browser

export interface ExportOptions {
  /** A preset, or an explicit size. Defaults to 720p. */
  size?: SizePreset | ExportSize;
  fps?: number;
  loops?: number;
  /** The playback speed, at which a revolution of the clock lasts 8 s divided by the speed. Defaults to 1. */
  speed?: number;
  /** The frame index of the first frame. Defaults to 0. */
  start?: number;
  /**
   * Whether each frame is the picture of a kiosk viewer of the video's size in CSS pixels, i.e. the panel area alone. Otherwise a frame
   * holds the panel area over the caption readouts. Defaults to whether the viewer has the attribute `kiosk`.
   */
  kiosk?: boolean;
  /** The longest export allowed, by default EXPORT_LIMITS. */
  limits?: ExportLimits;
  bitrate?: number;
  /** The number of frames from one key frame to the next, by default twice the frame rate. Infinity makes the first frame the only key frame. */
  keyFrameInterval?: number;
  /** The hardware acceleration asked of the H.264 encoder, by default `no-preference`. */
  hardwareAcceleration?: HardwareAcceleration;
  /** Called with the encoder configuration the browser accepted, before the first frame. */
  onConfig?: (config: VideoEncoderConfig) => void;
  /** Called with each frame, as a canvas of the video's size, after it is drawn and before it is encoded. */
  onFrame?: (frame: HTMLCanvasElement, k: number) => void;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/** A picture laid out at a size, which an export draws at each frame. */
export interface Picture {
  /** Draws frame index `index` at progress `q` onto `g`, whose transform maps the picture's CSS pixels to the canvas. */
  draw(g: CanvasRenderingContext2D, index: number, q: number): void;
  close(): void;
}

/** What an export draws, as the viewer gives it. */
export interface ExportSource {
  clock: Clock;
  /** The size of the picture on the page in CSS pixels, which the `panels` preset starts from. */
  panelArea: { w: number; h: number };
  /** Lays out the picture at w by h CSS pixels, to be drawn at `ratio` video pixels per CSS pixel, and resolves once it can be drawn. */
  open(w: number, h: number, ratio: number): Promise<Picture>;
}

export function webCodecsMissing(): string | null {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return 'this browser does not have a WebCodecs video encoder';
  return null;
}

/**
 * The first H.264 configuration this browser's encoder accepts, at the lowest level that holds the
 * size and rate. The profiles high, main, and baseline are tried in turn, in the avc format used in an MP4.
 */
export async function chooseConfig(
  width: number,
  height: number,
  fps: number,
  bitrate: number,
  hardwareAcceleration: HardwareAcceleration = 'no-preference',
): Promise<VideoEncoderConfig> {
  if (!avcFits(width, height, fps)) {
    throw new Error(
      `${width} by ${height} at ${fps} fps is past H.264, which needs even sides, at most ${AVC_MAX_SIDE} pixels a side, and a frame size and rate within level 5.2`,
    );
  }
  for (const profile of ['high', 'main', 'baseline'] as const) {
    const codec = avcCodec(width, height, fps, profile)!;
    const config: VideoEncoderConfig = { codec, width, height, bitrate, framerate: fps, hardwareAcceleration, avc: { format: 'avc' } };
    if ((await VideoEncoder.isConfigSupported(config)).supported === true) return config;
  }
  throw new Error(`this browser does not have an H.264 encoder for ${width} by ${height} at ${fps} fps, and an MP4 that QuickTime opens needs H.264`);
}

/**
 * Exports a video of `source` and resolves to an MP4 blob of H.264. Rejects with an AbortError
 * when `options.signal` aborts, and with an Error that gives the reason when WebCodecs is missing, when
 * the browser does not have an H.264 encoder for the size, or when the export would exceed its limits.
 */
export async function exportVideo(source: ExportSource, options: ExportOptions = {}): Promise<Blob> {
  const missing = webCodecsMissing();
  if (missing !== null) throw new Error(missing);
  const fps = options.fps ?? 30;
  const size =
    typeof options.size === 'object'
      ? options.size
      : sizePreset(options.size ?? '720p', source.panelArea, typeof window === 'undefined' ? 1 : window.devicePixelRatio, fps);
  const clock = source.clock;
  const schedule = frameSchedule(clock.frame_count, fps, options.loops ?? 1, options.speed ?? 1, options.start ?? 0, loopSeconds(clock));
  const refused = checkExport(schedule.count, fps, options.limits);
  if (refused !== null) throw new Error(refused);
  const keyEvery = options.keyFrameInterval ?? 2 * fps;
  if (!(keyEvery >= 1)) throw new Error(`the key-frame interval is ${keyEvery}, not a count of at least one frame`);
  const { width, height, pixelRatio: ratio } = size;
  const signal = options.signal;
  const aborted = () => new DOMException('the export was canceled', 'AbortError');
  if (signal?.aborted) throw aborted();

  const config = await chooseConfig(width, height, fps, options.bitrate ?? exportBitrate(width, height, fps), options.hardwareAcceleration);
  options.onConfig?.(config);
  const writer = new Mp4Writer(width, height, fps);
  let failure: unknown = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      try {
        writer.add(data, chunk.type === 'key', chunk.timestamp, chunk.duration ?? Math.round(1e6 / fps), meta);
      } catch (e) {
        failure ??= e;
      }
    },
    error: (e) => (failure = e),
  });
  encoder.configure(config);
  let picture: Picture | null = null;
  try {
    picture = await source.open(width / ratio, height / ratio, ratio);
    const frame = document.createElement('canvas');
    frame.width = width;
    frame.height = height;
    const g = frame.getContext('2d', { alpha: false })!;
    for (let k = 0; k < schedule.count; k++) {
      if (signal?.aborted) throw aborted();
      if (failure !== null) throw failure;
      g.setTransform(ratio, 0, 0, ratio, 0, 0);
      picture.draw(g, schedule.index(k), schedule.progress(k));
      options.onFrame?.(frame, k);
      const video = new VideoFrame(frame, { timestamp: Math.round((k * 1e6) / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(video, { keyFrame: k % keyEvery === 0 });
      video.close();
      options.onProgress?.(k + 1, schedule.count);
      // keep a few frames in the encoder, and let the page breathe between frames
      while (encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 1));
      await new Promise((r) => setTimeout(r, 0));
    }
    await encoder.flush();
    if (failure !== null) throw failure;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
    picture?.close();
  }
  return new Blob([writer.finish() as Uint8Array<ArrayBuffer>], { type: 'video/mp4' });
}
