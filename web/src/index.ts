/**
 * The TyCHO browser runtime: the scene format reader, its pure evaluator, and the
 * `<tycho-viewer>` element, which is registered on load wherever custom elements exist.
 * It is bundled as an immediately invoked function expression (IIFE) that exposes `tycho`, and as an ES module.
 */
export { Container, DATA_VERSION, decodeEmbedded } from './container.js';
export type { ArrayInfo, DataArray, DataHeader, DataStore, Dtype, EncodedArrayInfo, RawArrayInfo, TypedArray } from './container.js';
export { TychoError } from './errors.js';
export { SCENE_MAJOR, SCENE_MINOR } from './scene.js';
export type * from './scene.js';
export { validate } from './validate.js';
export { evaluate } from './evaluate/index.js';
export type * from './evaluate/types.js';
export { TychoViewerElement, define } from './runtime/element.js';
export { EXPORT_LIMITS, sizePreset } from './runtime/export.js';
export type { ExportLimits, ExportOptions, ExportSize, SizePreset } from './runtime/export.js';
export { formatNumber } from './runtime/readouts.js';
export { colormap, colormapCss } from './runtime/colormaps.js';

import { define, type TychoViewerElement } from './runtime/element.js';
import type { ExportOptions } from './runtime/export.js';

/** Exports a video of a viewer's current state and resolves to an MP4 blob. */
export function exportVideo(element: TychoViewerElement, options?: ExportOptions): Promise<Blob> {
  return element.exportVideo(options);
}

define();
