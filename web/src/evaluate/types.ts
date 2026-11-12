/**
 * The value that `evaluate` returns, as section 3 of spec/tycho-scene.md defines it. Positions are
 * plain arrays of three float64 numbers, thus JSON.stringify writes the result as it is.
 */

export type Vec3 = [number, number, number];

export interface MemberResult {
  index: number;
  line: Vec3[];
  /** Present only when the layer has `head: true`. Null while the track is hidden. */
  head?: Vec3 | null;
}

export interface TrackLayerResult {
  kind: 'track';
  /** Null when the set query does not match any track set, and `members` is then empty. */
  set: string | null;
  members: MemberResult[];
}

export interface ArrowMemberResult {
  index: number;
  /** The point at the reading. Null while the track is hidden. */
  base: Vec3 | null;
  /** The base displaced by `scale` times the vector, blended in the same way. Null while the track is hidden. */
  tip: Vec3 | null;
}

export interface ArrowLayerResult {
  kind: 'arrow';
  /** Null when the set query does not match any track set, and `members` is then empty. */
  set: string | null;
  members: ArrowMemberResult[];
}

export interface OutlineLayerResult {
  kind: 'outline';
  view: string;
  /** The first panel in layout order that shows `view`, or null when the layout does not show it, and the four keys below are then null. */
  panel: string | null;
  /** The display frame of the target panel. */
  frame: string | null;
  /** The image of the origin of the target frame in the display frame, at the driver's reading. Null when the view's driver does not resolve to a track. */
  origin: Vec3 | null;
  /** The images of the three unit points of the target frame minus `origin`, i.e. the columns of the linear part of the map. Null as `origin` is. */
  axes: [Vec3, Vec3, Vec3] | null;
}

export interface BodyLayerResult {
  kind: 'body';
  body: string;
  /** Null when the view's driver does not resolve to a track. */
  position: Vec3 | null;
  /** Present only when the layer has a `trail`. */
  trail?: Vec3[];
}

export interface MarkLayerResult {
  kind: 'axes' | 'grid';
}

export interface LabelLayerResult {
  kind: 'label';
  /** The anchor in the display frame (rule K6), or null for an anchor on the screen or one that does not resolve. */
  position: Vec3 | null;
}

export interface PointsMemberResult {
  index: number;
  /** The drawn samples in storage order (rule K8). Empty while the member is hidden or before its first sample is reached. */
  points: Vec3[];
}

export interface PointsLayerResult {
  kind: 'points';
  /** Null when the set query does not match any track set, and `members` is then empty. */
  set: string | null;
  members: PointsMemberResult[];
}

export type LayerResult = TrackLayerResult | ArrowLayerResult | OutlineLayerResult | BodyLayerResult | MarkLayerResult | LabelLayerResult | PointsLayerResult;

/** The window of a camera with keys (rule K5). */
export interface CameraResult {
  center: [number, number];
  width: number;
  /** Null unless the keys give a height, under a camera of free aspect. */
  height: number | null;
}

export interface PanelResult {
  frame: string;
  layers: LayerResult[];
  /** Present only when the view's camera has keys, and null when the camera does not have a window at the frame (rule K5). */
  camera?: CameraResult | null;
}

export interface EvaluateResult {
  panels: Record<string, PanelResult>;
}
