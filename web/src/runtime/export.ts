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
import { hexRgb, mixHex, sceneTheme, type Theme } from './colors.js';
import type { GeometryCache } from './geometry.js';
import type { Colorbar, PanelLabel } from './overlay.js';
import { formatNumber, LAP_SECONDS, loopPosition, loopSeconds, positionIndex, positionProgress, readoutText } from './readouts.js';
import { GUTTER, layoutAt, StageRenderer } from './renderer.js';
import { gutterColor, paintStage } from './paint.js';
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
 * `seconds / speed`, where `seconds` is the clock's loopSeconds. Output frame `k` is drawn at time
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

// in the browser

export interface ExportOptions {
  /** A preset, or an explicit size. Defaults to 720p. */
  size?: SizePreset | ExportSize;
  fps?: number;
  loops?: number;
  /** The playback speed, at which a lap of the clock lasts 8 s divided by the speed. Defaults to 1. */
  speed?: number;
  /** The frame index of the first frame. Defaults to 0. */
  start?: number;
  bitrate?: number;
  /** Called with the encoder configuration the browser accepted, before the first frame. */
  onConfig?: (config: VideoEncoderConfig) => void;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/** What an export draws: a scene, its data, and the snapshot to freeze. */
export interface ExportSource {
  scene: Scene;
  geometry: GeometryCache;
  state: State;
  /** The stage's size in CSS pixels, for the `stage` preset. */
  stage?: { w: number; h: number };
  /** The theme to draw with, by default the scene's. */
  theme?: Theme;
  /** The font family of the text on the canvas, by default FONT. */
  font?: string;
}

export function webCodecsMissing(): string | null {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return 'this browser does not have a WebCodecs video encoder';
  return null;
}

/**
 * The first H.264 configuration this browser's encoder accepts, at the lowest level that holds the
 * size and rate. The profiles high, main, and baseline are tried in turn, in the avc format used in an MP4.
 */
export async function chooseConfig(width: number, height: number, fps: number, bitrate: number): Promise<VideoEncoderConfig> {
  if (!avcFits(width, height, fps)) {
    throw new Error(
      `${width} by ${height} at ${fps} fps is past H.264, which needs even sides, at most ${AVC_MAX_SIDE} pixels a side, and a frame size and rate within level 5.2`,
    );
  }
  for (const profile of ['high', 'main', 'baseline'] as const) {
    const config: VideoEncoderConfig = { codec: avcCodec(width, height, fps, profile)!, width, height, bitrate, framerate: fps, avc: { format: 'avc' } };
    if ((await VideoEncoder.isConfigSupported(config)).supported === true) return config;
  }
  throw new Error(`this browser does not have an H.264 encoder for ${width} by ${height} at ${fps} fps, and an MP4 that QuickTime opens needs H.264`);
}

const FONT = '"Helvetica Neue", Arial, sans-serif';

/** The first panel in layout order, whose driver the caption reads. */
function firstLeaf(n: Layout): string {
  return n.kind === 'panel' ? n.id : firstLeaf(n.a);
}
const CAPTION_LINE = 18;

/** Text with a halo of the background, so that it reads over lines. */
function text(g: CanvasRenderingContext2D, s: string, x: number, y: number, fg: string, bg: string): void {
  g.lineJoin = 'round';
  g.lineWidth = 3;
  g.strokeStyle = bg;
  g.strokeText(s, x, y);
  g.fillStyle = fg;
  g.fillText(s, x, y);
}

/** Draws a panel label as the page places it, centered vertically on (x, y) and turned to read upward when rotated. Exported for the tests. */
export function drawLabel(g: CanvasRenderingContext2D, l: PanelLabel, x: number, y: number, fg: string, bg: string, font = FONT): void {
  g.font = `${l.kind === 'title' ? 13 : 12}px ${font}`;
  g.textAlign = l.align === 'center' ? 'center' : l.align === 'end' ? 'right' : 'left';
  if (l.rotate) {
    g.save();
    g.translate(x, y);
    g.rotate(-Math.PI / 2);
    text(g, l.text, 0, 0, fg, bg);
    g.restore();
  } else text(g, l.text, x, y, fg, bg);
  g.textAlign = 'left';
}

export function drawColorbars(
  g: CanvasRenderingContext2D,
  bars: Colorbar[],
  right: number,
  top: number,
  fg: string,
  dim: string,
  line: string,
  bg: string,
  font = FONT,
): void {
  let x = right;
  g.font = `11px ${font}`;
  for (const b of [...bars].reverse()) {
    const hi = formatNumber(b.hi, 3);
    const lo = formatNumber(b.lo, 3);
    const w = Math.max(g.measureText(b.label).width, 13 + Math.max(g.measureText(hi).width, g.measureText(lo).width));
    x -= w;
    g.textBaseline = 'top';
    text(g, b.label, x, top, dim, bg);
    const y0 = top + 16;
    const grad = g.createLinearGradient(0, y0 + 120, 0, y0);
    for (const [t, css] of b.stops) grad.addColorStop(t, css);
    g.fillStyle = grad;
    g.fillRect(x, y0, 8, 120);
    g.strokeStyle = line;
    g.lineWidth = 1;
    g.strokeRect(x + 0.5, y0 + 0.5, 7, 119);
    if (b.band !== null) {
      // the part a highlight's kernel lights, shaded over the bar
      const [r, gr, bl] = hexRgb(fg).map((c) => Math.round(255 * c));
      g.fillStyle = `rgba(${r}, ${gr}, ${bl}, 0.18)`;
      g.fillRect(x - 3, y0 + 120 * (1 - b.band[1]), 14, 120 * (b.band[1] - b.band[0]));
    }
    text(g, hi, x + 13, y0, dim, bg);
    g.textBaseline = 'bottom';
    text(g, lo, x + 13, y0 + 120, dim, bg);
    if (b.marker !== null) {
      const my = y0 + 120 * (1 - b.marker);
      g.fillStyle = fg;
      g.beginPath();
      g.moveTo(x - 1, my);
      g.lineTo(x - 7, my - 4);
      g.lineTo(x - 7, my + 4);
      g.closePath();
      g.fill();
    }
    x -= 12;
  }
}

/**
 * Exports a video of `source` and resolves to an MP4 blob of H.264. Rejects with an AbortError
 * when `options.signal` aborts, and with an Error that gives the reason when WebCodecs is missing, when
 * the browser does not have an H.264 encoder for the size, or when the export would exceed EXPORT_LIMITS.
 */
export async function exportVideo(source: ExportSource, options: ExportOptions = {}): Promise<Blob> {
  const missing = webCodecsMissing();
  if (missing !== null) throw new Error(missing);
  const { scene, geometry } = source;
  const state = structuredClone(source.state);
  const fps = options.fps ?? 30;
  const size =
    typeof options.size === 'object'
      ? options.size
      : sizePreset(options.size ?? '720p', source.stage, typeof window === 'undefined' ? 1 : window.devicePixelRatio, fps);
  const schedule = frameSchedule(scene.clock.steps, fps, options.loops ?? 1, options.speed ?? 1, options.start ?? 0, loopSeconds(scene.clock));
  const refused = checkExport(schedule.count, fps);
  if (refused !== null) throw new Error(refused);
  const { width, height, pixelRatio: ratio } = size;
  const signal = options.signal;
  const aborted = () => new DOMException('the export was canceled', 'AbortError');
  if (signal?.aborted) throw aborted();

  const config = await chooseConfig(width, height, fps, options.bitrate ?? exportBitrate(width, height, fps));
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

  // each frame holds the stage above a strip of caption lines, laid out in CSS pixels
  const font = source.font ?? source.theme?.font ?? sceneTheme(scene).font ?? FONT;
  const theme = { ...(source.theme ?? sceneTheme(scene)), font };
  const bg = mixHex(theme.background, theme.background, 0);
  const fg = mixHex(theme.foreground, theme.foreground, 0);
  const dim = mixHex(theme.foreground, theme.background, 0.4);
  const line = mixHex(theme.foreground, theme.background, 0.8);
  const gutter = gutterColor(theme);
  const captions = (scene.readouts ?? []).filter((r) => r.place === 'caption');
  const panelReadouts = (scene.readouts ?? []).filter((r) => r.place === 'panel');
  const logicalW = width / ratio;
  const logicalH = height / ratio;
  const stripH = captions.length > 0 ? 10 + CAPTION_LINE * captions.length : 0;
  const stageW = Math.floor(logicalW);
  const stageH = Math.floor(logicalH - stripH);
  const glCanvas = document.createElement('canvas');
  // the frames are read back from the canvas after each draw
  const renderer = new StageRenderer(glCanvas, scene, geometry, { preserveDrawingBuffer: true, coarseDrags: false, theme });
  const frame = document.createElement('canvas');
  frame.width = width;
  frame.height = height;
  const g = frame.getContext('2d', { alpha: false })!;
  const first = firstLeaf(state.layout);
  const seconds = loopSeconds(scene.clock);
  const read = (pid: string, parts: Readout['parts'], index: number, q: number) => {
    try {
      return readoutText({ scene, geometry, state, panel: pid, frameIndex: index, progress: q }, parts);
    } catch (e) {
      return (e as Error).message;
    }
  };

  try {
    // a first frame builds the panels' draws, whose body images are decoded before the video starts
    renderer.renderAt(state, schedule.progress(0), stageW, stageH, ratio);
    await renderer.ready();
    for (let k = 0; k < schedule.count; k++) {
      if (signal?.aborted) throw aborted();
      if (failure !== null) throw failure;
      const index = schedule.index(k);
      const q = schedule.progress(k);
      const errors = renderer.renderAt(state, q, stageW, stageH, ratio);
      const tiles = tile(layoutAt(state.layout, q * seconds), { x: 0, y: 0, w: stageW, h: stageH }, GUTTER);
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = bg;
      g.fillRect(0, 0, width, height);
      g.drawImage(glCanvas, 0, 0);
      g.setTransform(ratio, 0, 0, ratio, 0, 0);
      g.fillStyle = gutter;
      for (const gt of tiles.gutters) g.fillRect(gt.rect.x, gt.rect.y, gt.rect.w, gt.rect.h);
      g.save();
      paintStage(g, renderer, scene, state, theme, q, stageW, stageH, (pid, parts) => read(pid, parts, index, q));
      g.restore();
      for (const [pid, r] of tiles.panels) {
        g.save();
        g.beginPath();
        g.rect(r.x, r.y, r.w, r.h);
        g.clip();
        g.textBaseline = 'middle';
        for (const l of renderer.labels(pid)) drawLabel(g, l, r.x + l.x, r.y + l.y, fg, bg, font);
        drawColorbars(g, renderer.colorbars(pid), r.x + r.w - 10, r.y + 10, fg, dim, line, bg, font);
        g.font = `13px ${font}`;
        g.textBaseline = 'bottom';
        const lines = panelReadouts
          .map((ro) => read(pid, ro.parts, index, q))
          .join('\n')
          .split('\n');
        lines.reverse().forEach((s, i) => text(g, s, r.x + 8, r.y + r.h - 6 - 17 * i, fg, bg));
        const error = errors.get(pid);
        if (error !== undefined) {
          g.textBaseline = 'top';
          text(g, error, r.x + 12, r.y + 12, '#e0a24a', bg);
        }
        g.restore();
      }
      g.font = `13px ${font}`;
      g.textBaseline = 'alphabetic';
      captions.forEach((c, i) => text(g, read(first, c.parts, index, q), 14, stageH + 5 + CAPTION_LINE * (i + 1) - 4, fg, bg));

      const video = new VideoFrame(frame, { timestamp: Math.round((k * 1e6) / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(video, { keyFrame: k % (2 * fps) === 0 });
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
    renderer.dispose();
  }
  return new Blob([writer.finish() as Uint8Array<ArrayBuffer>], { type: 'video/mp4' });
}
